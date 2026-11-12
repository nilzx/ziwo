// An OAuth client, as an MCP client makes the flow, through the Worker's own
// fetch: registration, the authorization request, the consent page in a
// browser (its cookie and its form), and the token endpoint.

import { expect, vi } from "vitest";
import type { Env } from "../src/index";
import { adminSecret, fetchWorker, origin, testEnv } from "./mcp-helpers";

export const redirectUri = "https://client.example/callback";
export const resourceOf = (name: string): string => `${origin}/${name}/mcp`;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export async function pkce(): Promise<Pkce> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

// register registers a public client by Dynamic Client Registration.
export async function register(name = "Test client", redirect = redirectUri, e?: Env): Promise<string> {
  const res = await fetchWorker("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    }),
  }, e);
  expect(res.status, "register").toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

export interface AuthParams {
  clientId: string;
  challenge?: string;
  resource?: string | null;
  redirect?: string;
  state?: string;
  extra?: Record<string, string>;
}

export function authorizePath(p: AuthParams): string {
  const q = new URLSearchParams({ response_type: "code", client_id: p.clientId, redirect_uri: p.redirect ?? redirectUri, state: p.state ?? "st-1" });
  if (p.challenge !== undefined) {
    q.set("code_challenge", p.challenge);
    q.set("code_challenge_method", "S256");
  }
  if (p.resource !== null && p.resource !== undefined) q.set("resource", p.resource);
  for (const [k, v] of Object.entries(p.extra ?? {})) q.set(k, v);
  return `/oauth/authorize?${q}`;
}

// A consent page as a browser holds it: its form and the cookie it was set.
export interface Page {
  res: Response;
  html: string;
  cookie: string;
  fields: Record<string, string>;
}

function formFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    out[m[1]!] = m[2]!.replace(/&#(\d+);/g, (_w, c: string) => String.fromCharCode(Number(c)));
  }
  return out;
}

export async function openPage(path: string, headers: Record<string, string> = {}, e?: Env): Promise<Page> {
  const res = await fetchWorker(path, { headers }, e);
  const html = await res.text();
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
  return { res, html, cookie, fields: formFields(html) };
}

// submit posts the consent form as the browser that opened it.
export function submit(
  page: Page,
  values: Record<string, string>,
  opts: { origin?: string | null; cookie?: string | null; fetchSite?: string; env?: Env } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const o = opts.origin === undefined ? origin : opts.origin;
  if (o !== null) headers.origin = o;
  const c = opts.cookie === undefined ? page.cookie : opts.cookie;
  if (c !== null && c !== "") headers.cookie = c;
  if (opts.fetchSite !== undefined) headers["sec-fetch-site"] = opts.fetchSite;
  return fetchWorker("/oauth/authorize", { method: "POST", headers, body: new URLSearchParams({ ...page.fields, ...values }).toString(), redirect: "manual" }, opts.env);
}

export function approve(page: Page, credential: string, e?: Env): Promise<Response> {
  return submit(page, { decision: "approve", credential }, { env: e });
}

// codeFrom reads the authorization response a redirect to back carries.
export function codeFrom(res: Response, back = redirectUri): URLSearchParams {
  expect(res.status, "redirect").toBe(302);
  const location = res.headers.get("location") ?? "";
  expect(location.startsWith(`${back}?`), location).toBe(true);
  return new URL(location).searchParams;
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  resource: string;
}

export function tokenRequest(form: Record<string, string>, e?: Env): Promise<Response> {
  return fetchWorker("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  }, e);
}

export async function exchange(
  code: string, clientId: string, verifier: string | undefined, resource?: string, e?: Env, redirect = redirectUri,
): Promise<Response> {
  const form: Record<string, string> = { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirect };
  if (verifier !== undefined) form.code_verifier = verifier;
  if (resource !== undefined) form.resource = resource;
  return tokenRequest(form, e);
}

export interface Granted {
  clientId: string;
  tokens: Tokens;
}

// grant runs the whole flow for a memory and returns the tokens.
export async function grant(name: string, credential = adminSecret, clientName = "Test client"): Promise<Granted> {
  const clientId = await register(clientName);
  const p = await pkce();
  const page = await openPage(authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(name) }));
  expect(page.res.status, page.html).toBe(200);
  const code = codeFrom(await approve(page, credential)).get("code")!;
  const res = await exchange(code, clientId, p.verifier, resourceOf(name));
  expect(res.status, "exchange").toBe(200);
  return { clientId, tokens: (await res.json()) as Tokens };
}

// kvThatThrows is an OAUTH_KV that fails any use, and counts it.
export function envWithoutKV(touched: string[]): Env {
  const kv = new Proxy({}, {
    get(_t, prop) {
      touched.push(String(prop));
      throw new Error("OAUTH_KV was reached");
    },
  }) as KVNamespace;
  return { ...testEnv(), OAUTH_KV: kv };
}

// countingEnv is the test environment with OAUTH_KV wrapped: every put and
// delete is recorded, as the kind of key it is (the part before the first
// colon: client, grant, token, transaction, client-assertion-jti), and done.
export function countingEnv(base: Env = testEnv()): { env: Env; writes: string[] } {
  const writes: string[] = [];
  const target = base.OAUTH_KV;
  const kv = new Proxy(target, {
    get(t, prop) {
      const v = Reflect.get(t, prop) as unknown;
      if (typeof v !== "function") return v;
      const f = v as (...a: unknown[]) => unknown;
      if (prop === "put" || prop === "delete") {
        return (key: string, ...rest: unknown[]) => {
          writes.push(`${prop} ${key.split(":")[0]}`);
          return f.call(t, key, ...rest);
        };
      }
      return f.bind(t);
    },
  });
  return { env: { ...base, OAUTH_KV: kv }, writes };
}

// serveDocuments answers the Worker's fetch of each URL given with its
// Client ID Metadata Document, not cached; any other fetch goes out.
export function serveDocuments(docs: Record<string, object>): void {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const doc = docs[url];
    if (doc === undefined) return real(input, init);
    return new Response(JSON.stringify(doc), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  });
}

// A metadata document client: its id, where it is sent back, its document.
export function cimdClient(path: string, methods: string[], jwk?: JsonWebKey): { id: string; redirect: string; doc: Record<string, unknown> } {
  const id = `https://app.example/${path}.json`;
  const redirect = "https://app.example/cb";
  const doc: Record<string, unknown> = {
    client_id: id, client_name: `App ${path}`, redirect_uris: [redirect],
    token_endpoint_auth_method: methods[0], token_endpoint_auth_methods_supported: methods,
  };
  if (jwk !== undefined) {
    doc.jwks = { keys: [{ ...jwk, kid: "k1", alg: "ES256", use: "sig" }] };
    doc.token_endpoint_auth_signing_alg = "ES256";
  }
  return { id, redirect, doc };
}

export const assertionType = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

// assertionSigner makes an ES256 key and signs client assertions with it, as
// a private_key_jwt client does: valid ones, whose signature verifies.
export async function assertionSigner(): Promise<{ jwk: JsonWebKey; sign: (clientId: string) => Promise<string> }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const full = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const jwk: JsonWebKey = { kty: full.kty, crv: full.crv, x: full.x, y: full.y };
  const part = (v: object) => b64url(new TextEncoder().encode(JSON.stringify(v)));
  const sign = async (clientId: string): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const input = `${part({ alg: "ES256", typ: "JWT", kid: "k1" })}.${part({
      iss: clientId, sub: clientId, aud: `${origin}/oauth/token`, jti: crypto.randomUUID(), iat: now, exp: now + 120,
    })}`;
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${b64url(new Uint8Array(sig))}`;
  };
  return { jwk, sign };
}
