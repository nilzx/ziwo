// An OAuth client, as an MCP client makes the flow, through the Worker's own
// fetch: registration, the authorization request, the consent page in a
// browser (its cookie and its form), and the token endpoint.

import { expect } from "vitest";
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

// codeFrom reads the authorization response a redirect carries.
export function codeFrom(res: Response): URLSearchParams {
  expect(res.status, "redirect").toBe(302);
  const location = res.headers.get("location") ?? "";
  expect(location.startsWith(`${redirectUri}?`), location).toBe(true);
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

export async function exchange(code: string, clientId: string, verifier: string | undefined, resource?: string): Promise<Response> {
  const form: Record<string, string> = { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri };
  if (verifier !== undefined) form.code_verifier = verifier;
  if (resource !== undefined) form.resource = resource;
  return tokenRequest(form);
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
