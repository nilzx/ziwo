// What writes to OAuth's KV, and what it takes. KV's free plan takes 1,000
// writes a day, which every connected client's renewals need, so nothing a
// caller sends without a credential may write, however often: the consent
// page, a wrong credential, a denial, a forged post, a client assertion, a
// made-up code or token, a registration over the budget. What writes is a
// registration within the budget, an approval with a right credential, and
// the exchange and renewals that follow. Also the whole flow for a client
// that names itself with a metadata document, and the refusal of client
// assertions.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { authServer, registerPerDay } from "../src/oauth";
import { registerPerHour } from "../src/guard";
import { adminSecret, Client, createMemory, fetchWorker, origin } from "./mcp-helpers";
import {
  approve, assertionSigner, assertionType, authorizePath, cimdClient, codeFrom, countingEnv, exchange, openPage, pkce, redirectUri,
  register, resourceOf, serveDocuments, submit, tokenRequest, type Tokens,
} from "./oauth-helpers";

afterEach(() => vi.restoreAllMocks());

const mcp = (name: string, auth: string, e?: Env) =>
  fetchWorker(`/${name}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: auth },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  }, e);

const registerFrom = (address: string, e?: Env) =>
  fetchWorker("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": address },
    body: JSON.stringify({ client_name: "Budget client", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
  }, e);

const error = async (res: Response): Promise<string> => ((await res.json()) as { error: string }).error;

// A grant id and a secret in the library's form, made up.
const madeUp = (name: string) => `${name}:AAAAAAAAAAAAAAAA:${"x".repeat(43)}`;

describe("KV writes", () => {
  it("none for anything sent without a credential, however often", async () => {
    const m = await createMemory();
    const clientId = await register("Quiet client");
    const p = await pkce();
    const signer = await assertionSigner();
    const plain = cimdClient("plain", ["none"]);
    const keyed = cimdClient("keyed", ["none", "private_key_jwt"], signer.jwk);
    serveDocuments({ [plain.id]: plain.doc, [keyed.id]: keyed.doc });
    // An address that has used its hour of registrations.
    const address = "198.51.100.77";
    for (let i = 0; i < registerPerHour; i++) expect((await registerFrom(address)).status).toBe(201);

    const { env: e, writes } = countingEnv();
    const pages = [
      authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(m.name) }),
      authorizePath({ clientId, challenge: p.challenge, resource: null }),
      authorizePath({ clientId, challenge: p.challenge, resource: null, extra: { memory: m.name } }),
      authorizePath({ clientId: plain.id, challenge: p.challenge, resource: resourceOf(m.name), redirect: plain.redirect }),
      authorizePath({ clientId: plain.id, challenge: p.challenge, resource: null, redirect: plain.redirect }),
    ];
    for (let round = 0; round < 3; round++) {
      for (const path of pages) {
        const page = await openPage(path, {}, e);
        expect(page.res.status, path).toBe(200);
        expect(page.cookie).toBe("");
      }
      const page = await openPage(pages[0]!, {}, e);
      const cimdPage = await openPage(pages[3]!, {}, e);
      for (const pg of [page, cimdPage]) {
        expect((await submit(pg, { decision: "approve", credential: "wrong" }, { env: e })).status).toBe(403);
        expect((await submit(pg, { decision: "approve", credential: m.token }, { env: e, origin: "https://evil.example" })).status).toBe(403);
      }
      expect(codeFrom(await submit(page, { decision: "deny" }, { env: e })).get("error")).toBe("access_denied");
      expect(codeFrom(await submit(cimdPage, { decision: "deny" }, { env: e }), plain.redirect).get("error")).toBe("access_denied");
      // A client assertion whose signature verifies.
      const asserted = await tokenRequest({
        grant_type: "authorization_code", code: madeUp(m.name), client_id: keyed.id,
        client_assertion_type: assertionType, client_assertion: await signer.sign(keyed.id),
      }, e);
      expect(asserted.status).toBe(401);
      expect(await error(asserted)).toBe("invalid_client");
      // Made-up codes and tokens, for a registered client and a document's.
      for (const id of [clientId, plain.id]) {
        const code = await tokenRequest({ grant_type: "authorization_code", code: madeUp(m.name), client_id: id, code_verifier: p.verifier, redirect_uri: redirectUri }, e);
        expect(await error(code)).toBe("invalid_grant");
        const refresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: madeUp(m.name), client_id: id }, e);
        expect(await error(refresh)).toBe("invalid_grant");
        expect((await tokenRequest({ token: madeUp(m.name), client_id: id }, e)).status).toBe(200);
        expect((await tokenRequest({ token: madeUp(m.name), token_type_hint: "refresh_token", client_id: id }, e)).status).toBe(200);
      }
      expect((await mcp(m.name, `Bearer ${madeUp(m.name)}`, e)).status).toBe(401);
      expect((await registerFrom(address, e)).status).toBe(429);
    }
    expect(writes).toEqual([]);
  });

  it("one for a registration within the budget, and what an approval, the exchange and a renewal need", async () => {
    const m = await createMemory();
    const { env: e, writes } = countingEnv();
    const clientId = await register("Writer", redirectUri, e);
    expect(writes).toEqual(["put client"]);
    writes.length = 0;
    const p = await pkce();
    const page = await openPage(authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(m.name) }), {}, e);
    expect(writes).toEqual([]);
    const code = codeFrom(await approve(page, m.token, e)).get("code")!;
    expect(writes).toEqual(["put grant"]);
    writes.length = 0;
    const ex = await exchange(code, clientId, p.verifier, resourceOf(m.name), e);
    expect(ex.status).toBe(200);
    expect(writes).toEqual(["put grant", "put token"]);
    writes.length = 0;
    const t = (await ex.json()) as Tokens;
    // Using the token reads; it writes nothing.
    expect((await mcp(m.name, `Bearer ${t.access_token}`, e)).status).toBe(200);
    expect(writes).toEqual([]);
    const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId }, e);
    expect(r.status).toBe(200);
    expect(writes).toEqual(["put grant", "put token"]);
  });
});

describe("client assertions", () => {
  it("are refused before the library, which would write a replay marker for each", async () => {
    const m = await createMemory();
    const signer = await assertionSigner();
    const keyed = cimdClient("asserting", ["private_key_jwt", "none"], signer.jwk);
    serveDocuments({ [keyed.id]: keyed.doc });
    const { env: e, writes } = countingEnv();
    const form = (assertion: string) => ({ grant_type: "authorization_code", code: madeUp(m.name), client_id: keyed.id, client_assertion_type: assertionType, client_assertion: assertion });
    const ours = await tokenRequest(form(await signer.sign(keyed.id)), e);
    expect(ours.status).toBe(401);
    expect(ours.headers.get("cache-control")).toBe("no-store");
    expect(await ours.json()).toEqual({
      error: "invalid_client",
      error_description: "Client assertions are not accepted; use a method in token_endpoint_auth_methods_supported",
    });
    // Either parameter alone, or empty, and on a revocation too.
    const forms: Record<string, string>[] = [
      { grant_type: "refresh_token", refresh_token: madeUp(m.name), client_id: keyed.id, client_assertion_type: assertionType },
      { grant_type: "refresh_token", refresh_token: madeUp(m.name), client_id: keyed.id, client_assertion: "" },
      { token: madeUp(m.name), client_assertion_type: assertionType, client_assertion: await signer.sign(keyed.id) },
    ];
    for (const f of forms) {
      const res = await tokenRequest(f, e);
      expect(res.status).toBe(401);
      expect(await error(res)).toBe("invalid_client");
    }
    // A browser client can read the refusal, as the library's own.
    const fromPage = await fetchWorker("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://app.example" },
      body: new URLSearchParams(form(await signer.sign(keyed.id))).toString(),
    }, e);
    expect(fromPage.status).toBe(401);
    expect(fromPage.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(fromPage.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate, Retry-After");
    expect(writes).toEqual([]);
    // The library on its own verifies the same assertion and writes its marker.
    const lib = await authServer(origin, [m.name]).fetch(new Request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form(await signer.sign(keyed.id))).toString(),
    }), e, undefined as unknown as ExecutionContext);
    expect(await error(lib)).toBe("invalid_grant");
    expect(writes).toEqual(["put client-assertion-jti"]);
  });

  it("are refused unread in a token request too long to read, whether it says so or not", async () => {
    const { env: e, writes } = countingEnv();
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: "x", padding: "y".repeat(70 * 1024) }).toString();
    const said = await fetchWorker("/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(body.length) }, body,
    }, e);
    expect(said.status).toBe(413);
    expect(await error(said)).toBe("invalid_request");
    // A stream says no length; it is read up to the limit.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    });
    const unsaid = await fetchWorker("/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: stream, duplex: "half",
    } as RequestInit, e);
    expect(unsaid.status).toBe(413);
    // Within the limit, the library answers it, as before.
    const within = await tokenRequest({ grant_type: "refresh_token", refresh_token: "x", padding: "y".repeat(60 * 1024) }, e);
    expect(within.status).toBe(401);
    expect(((await within.json()) as { error_description: string }).error_description).toBe("Client ID is required");
    expect(writes).toEqual([]);
  });

  it("leave a client whose document offers none beside private_key_jwt working with none", async () => {
    const m = await createMemory();
    const signer = await assertionSigner();
    const both = cimdClient("both", ["private_key_jwt", "none"], signer.jwk);
    serveDocuments({ [both.id]: both.doc });
    const p = await pkce();
    const page = await openPage(authorizePath({ clientId: both.id, challenge: p.challenge, resource: resourceOf(m.name), redirect: both.redirect }));
    expect(page.res.status, page.html).toBe(200);
    const code = codeFrom(await approve(page, m.token), both.redirect).get("code")!;
    const res = await exchange(code, both.id, p.verifier, resourceOf(m.name), undefined, both.redirect);
    expect(res.status).toBe(200);
  });

  it("leave a client whose document offers private_key_jwt alone unable to exchange its code", async () => {
    const m = await createMemory();
    const signer = await assertionSigner();
    const only = cimdClient("only", ["private_key_jwt"], signer.jwk);
    serveDocuments({ [only.id]: only.doc });
    const p = await pkce();
    // The page is shown and an approval makes a grant ...
    const page = await openPage(authorizePath({ clientId: only.id, challenge: p.challenge, resource: resourceOf(m.name), redirect: only.redirect }));
    expect(page.res.status, page.html).toBe(200);
    const code = codeFrom(await approve(page, m.token), only.redirect).get("code")!;
    // ... but the code is exchanged neither with none (the library refuses
    // the method) nor with an assertion (refused here).
    const none = await exchange(code, only.id, p.verifier, resourceOf(m.name), undefined, only.redirect);
    expect(none.status).toBe(401);
    expect(await error(none)).toBe("invalid_client");
    const asserted = await tokenRequest({
      grant_type: "authorization_code", code, client_id: only.id, code_verifier: p.verifier, redirect_uri: only.redirect,
      client_assertion_type: assertionType, client_assertion: await signer.sign(only.id),
    });
    expect(asserted.status).toBe(401);
    expect(await error(asserted)).toBe("invalid_client");
  });
});

describe("the flow for a client that names itself with a metadata document", () => {
  it("is approved with the memory's token and with the admin secret, exchanges, calls a tool, renews and revokes", async () => {
    const m = await createMemory();
    const doc = cimdClient("flow", ["none"]);
    serveDocuments({ [doc.id]: doc.doc });
    for (const credential of [m.token, adminSecret]) {
      const p = await pkce();
      const page = await openPage(authorizePath({ clientId: doc.id, challenge: p.challenge, resource: resourceOf(m.name), redirect: doc.redirect, state: "doc-1" }));
      expect(page.res.status, page.html).toBe(200);
      const answer = codeFrom(await approve(page, credential), doc.redirect);
      expect(answer.get("state")).toBe("doc-1");
      expect(answer.get("iss")).toBe(origin);
      const ex = await exchange(answer.get("code")!, doc.id, p.verifier, resourceOf(m.name), undefined, doc.redirect);
      expect(ex.status).toBe(200);
      const t = (await ex.json()) as Tokens;
      const c = new Client("new", { name: m.name, token: t.access_token }, "doc-client");
      await c.ok("get_context", {});
      const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: doc.id });
      expect(r.status).toBe(200);
      const t2 = (await r.json()) as Tokens;
      expect((await mcp(m.name, `Bearer ${t2.access_token}`)).status).toBe(200);
      expect((await tokenRequest({ token: t2.refresh_token, token_type_hint: "refresh_token", client_id: doc.id })).status).toBe(200);
      expect((await mcp(m.name, `Bearer ${t2.access_token}`)).status).toBe(401);
    }
  });

  it("is sent back with access_denied and the request's state on a denial", async () => {
    const m = await createMemory();
    const doc = cimdClient("denied", ["none"]);
    serveDocuments({ [doc.id]: doc.doc });
    const page = await openPage(authorizePath({ clientId: doc.id, challenge: (await pkce()).challenge, resource: resourceOf(m.name), redirect: doc.redirect, state: "doc-deny" }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const back = codeFrom(await submit(page, { decision: "deny" }), doc.redirect);
    const line = JSON.parse(String(log.mock.calls.at(-1)![0])) as Record<string, unknown>;
    expect(line).toMatchObject({ msg: "request", method: "POST", oauth: "authorize", outcome: "denied", memory: m.name, status: 302 });
    expect(back.get("error")).toBe("access_denied");
    expect(back.get("state")).toBe("doc-deny");
    expect(back.get("iss")).toBe(origin);
    expect(back.get("code")).toBeNull();
  });
});

describe("REGISTER_PER_DAY", () => {
  it("is 100 unset, a whole number when set, and 100 for anything else", () => {
    const of = (v: string | number | undefined) => registerPerDay({ REGISTER_PER_DAY: v } as Env);
    expect(of(undefined)).toBe(100);
    expect(of("")).toBe(100);
    expect(of("0")).toBe(0);
    expect(of(" 25 ")).toBe(25);
    expect(of(7)).toBe(7);
    for (const v of ["-1", "1.5", "lots", "1e3"]) expect(of(v), v).toBe(100);
  });
});
