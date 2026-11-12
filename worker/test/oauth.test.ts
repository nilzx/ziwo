// OAuth through the Worker's fetch, as a client makes it: the 401 and the
// metadata it points to, registration, the authorization request, the
// consent page, approval with the admin secret or the memory's token, the
// code exchanged with PKCE, tool calls with the access token, refresh, a
// token refused at another memory, and revocation. The fixed token is
// tested to keep working without KV.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import type { Memory as MemoryObject } from "../src/memory-object";
import { accessTokenTTL, grantIdleTTL } from "../src/oauth";
import { adminSecret, Client, createMemory, fetchWorker, freshName, idIn, origin, testEnv } from "./mcp-helpers";
import {
  approve, authorizePath, codeFrom, envWithoutKV, exchange, grant, openPage, pkce, redirectUri, register, resourceOf, submit,
  tokenRequest, type Tokens,
} from "./oauth-helpers";

const mcp = (name: string, auth: string | null, e?: Env) => {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
  if (auth !== null) headers.authorization = auth;
  return fetchWorker(`/${name}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }, e);
};

const admin = (path: string, method = "GET", secret: string | null = adminSecret) =>
  fetchWorker(path, { method, headers: secret === null ? {} : { authorization: `Bearer ${secret}` } });

function clientOf(name: string, session: string): Promise<string> {
  return runInDurableObject(env.MEMORY.getByName(name), (obj: MemoryObject) => obj.store.session(session)!.client);
}

describe("discovery", () => {
  it("answers an unauthenticated request with a 401 that points at the memory's metadata", async () => {
    for (const name of [(await createMemory()).name, freshName()]) {
      const res = await mcp(name, null);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(
        `Bearer realm="ziwo", resource_metadata="${origin}/.well-known/oauth-protected-resource/${name}/mcp"`,
      );
    }
  });

  it("serves each memory's protected resource metadata, for any name, reaching nothing", async () => {
    const touched: string[] = [];
    const e = { ...envWithoutKV(touched), MEMORY: undefined as unknown as Env["MEMORY"] };
    for (const name of [(await createMemory()).name, freshName()]) {
      const res = await fetchWorker(`/.well-known/oauth-protected-resource/${name}/mcp`, {}, e);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toEqual({
        resource: `${origin}/${name}/mcp`,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        resource_name: `ziwo memory ${name}`,
      });
    }
    expect(touched).toEqual([]);
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/Bad/mcp",
      "/.well-known/oauth-protected-resource/a/other", "/.well-known/openid-configuration", "/oauth/nothing"]) {
      expect((await fetchWorker(path)).status, path).toBe(404);
    }
    expect((await fetchWorker("/.well-known/oauth-protected-resource/a/mcp", { method: "POST" })).status).toBe(405);
  });

  it("serves authorization server metadata: PKCE S256, registration, CIMD, iss, and no list of memories", async () => {
    const res = await fetchWorker("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const m = (await res.json()) as Record<string, unknown>;
    expect(m).toMatchObject({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/token`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
    expect(m.grant_types_supported).toEqual(expect.arrayContaining(["authorization_code", "refresh_token"]));
    // Claude uses a metadata document only when the token endpoint takes "none".
    expect(m.token_endpoint_auth_methods_supported).toEqual(expect.arrayContaining(["none"]));
    // Client assertions are refused, so not offered.
    expect(m.token_endpoint_auth_methods_supported).not.toContain("private_key_jwt");
    expect("token_endpoint_auth_signing_alg_values_supported" in m).toBe(false);
    expect("protected_resources" in m).toBe(false);
    expect(m.scopes_supported).toBeUndefined();
  });

  it("offers no OAuth over plain http but on a loopback host", async () => {
    const at = (base: string, path: string) => worker.fetch(new Request(base + path), testEnv());
    expect((await at("http://ziwo.example", "/.well-known/oauth-authorization-server")).status).toBe(404);
    const local = await at("http://127.0.0.1:8787", "/.well-known/oauth-authorization-server");
    expect(((await local.json()) as { issuer: string }).issuer).toBe("http://127.0.0.1:8787");
    const plainHttp = await worker.fetch(new Request("http://ziwo.example/a/mcp", { method: "POST" }), testEnv());
    expect(plainHttp.headers.get("www-authenticate")).toBe('Bearer realm="ziwo"');
  });
});

describe("the flow", () => {
  it("registers, asks, is approved with the admin secret, exchanges the code with PKCE, calls a tool and refreshes", async () => {
    const m = await createMemory();
    const clientId = await register("Flow client");
    const p = await pkce();
    const page = await openPage(authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(m.name), state: "s-42" }));
    expect(page.res.status).toBe(200);
    expect(page.html).toContain("Flow client");
    expect(page.html).toContain("<strong>client.example</strong>");
    expect(page.html).toContain(`<strong>${m.name}</strong>`);
    // The page stores nothing: no cookie.
    expect(page.cookie).toBe("");

    const answer = codeFrom(await approve(page, adminSecret));
    expect(answer.get("state")).toBe("s-42");
    expect(answer.get("iss")).toBe(origin);
    const code = answer.get("code")!;
    expect(code.startsWith(`${m.name}:`)).toBe(true);

    // PKCE: refused without the verifier and with a wrong one; the code
    // survives both and is exchanged with the right one, once.
    const without = await exchange(code, clientId, undefined, resourceOf(m.name));
    expect(without.status).toBe(400);
    expect(((await without.json()) as { error: string }).error).toBe("invalid_request");
    const wrong = await exchange(code, clientId, (await pkce()).verifier, resourceOf(m.name));
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe("invalid_grant");
    const ok = await exchange(code, clientId, p.verifier, resourceOf(m.name));
    expect(ok.status).toBe(200);
    const t = (await ok.json()) as Tokens;
    expect(t).toMatchObject({ token_type: "bearer", expires_in: accessTokenTTL, scope: "", resource: resourceOf(m.name) });
    expect(accessTokenTTL).toBe(3600);
    expect(t.refresh_token.startsWith(`${m.name}:`)).toBe(true);

    // The access token reaches the same tools; the client is named as before.
    const c = new Client("new", { name: m.name, token: t.access_token }, "named-in-meta");
    const s = idIn(await c.ok("get_context", {}), "s_");
    expect(await clientOf(m.name, s)).toBe("named-in-meta");
    expect((await c.list()).length).toBeGreaterThan(0);
    // An old-generation call that names no client: the name it registered.
    const old = new Client("old", { name: m.name, token: t.access_token }, "unused", "agent/9");
    expect(await clientOf(m.name, idIn(await old.ok("get_context", {}), "s_"))).toBe("Flow client");

    // Refresh: a new pair, the new access token works, the refresh token rotates.
    const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId, resource: resourceOf(m.name) });
    expect(r.status).toBe(200);
    const t2 = (await r.json()) as Tokens;
    expect(t2.access_token).not.toBe(t.access_token);
    expect(t2.refresh_token).not.toBe(t.refresh_token);
    expect((await mcp(m.name, `Bearer ${t2.access_token}`)).status).toBe(200);
    // Refresh without a resource indicator inherits the grant's.
    const r2 = await tokenRequest({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: clientId });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as Tokens).resource).toBe(resourceOf(m.name));

    // The code works once; a replay is refused and revokes the grant.
    expect((await exchange(code, clientId, p.verifier, resourceOf(m.name))).status).toBe(400);
  });

  it("is approved with the memory's own token", async () => {
    const m = await createMemory();
    const g = await grant(m.name, m.token);
    expect((await mcp(m.name, `Bearer ${g.tokens.access_token}`)).status).toBe(200);
    const grants = (await (await admin(`/admin/memories/${m.name}/grants`)).json()) as { grants: { client: string }[] };
    expect(grants.grants.map((x) => x.client)).toEqual(["Test client"]);
  });

  it("refuses anything but the token or the admin secret with one message, which says nothing about the memory", async () => {
    const m = await createMemory();
    const other = await createMemory();
    const nobody = freshName();
    const clientId = await register();
    const p = await pkce();
    const messages: string[] = [];
    const cases: [name: string, credential: string][] = [
      [m.name, "wrong"], [m.name, ""], [m.name, `${m.token}x`], [m.name, other.token], [m.name, `${adminSecret}x`],
      [nobody, adminSecret], [nobody, m.token], [nobody, "wrong"],
    ];
    for (const [name, credential] of cases) {
      const page = await openPage(authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(name) }));
      expect(page.res.status).toBe(200);
      const res = await approve(page, credential);
      expect(res.status, `${name} ${credential}`).toBe(403);
      expect(res.headers.get("location")).toBeNull();
      const html = await res.text();
      // A fresh form comes back, with the one message.
      expect(html).toContain('name="q"');
      messages.push(/<p class="out error" role="alert">([^<]*)<\/p>/.exec(html)?.[1] ?? "none");
    }
    expect(new Set(messages)).toEqual(new Set(["Not accepted. Check what you typed and try again."]));
    // Nothing was granted, and the memory never created stays empty.
    for (const name of [m.name, nobody]) {
      expect(((await (await admin(`/admin/memories/${m.name}/grants`)).json()) as { grants: unknown[] }).grants, name).toEqual([]);
    }
    expect(await runInDurableObject(env.MEMORY.getByName(nobody), (_o: MemoryObject, state) =>
      state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`).toArray().length)).toBe(0);
  });

  it("refuses the admin secret where the deployment has none", async () => {
    const m = await createMemory();
    const e = testEnv(null);
    const clientId = await register("c", redirectUri, e);
    const p = await pkce();
    const page = await openPage(authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(m.name) }), {}, e);
    expect((await submit(page, { decision: "approve", credential: "" }, { env: e })).status).toBe(403);
    expect(codeFrom(await submit(page, { decision: "approve", credential: m.token }, { env: e })).get("code")).not.toBeNull();
  });

  it("sends a denial back to the client with access_denied, state and iss", async () => {
    const m = await createMemory();
    const clientId = await register();
    const page = await openPage(authorizePath({ clientId, challenge: (await pkce()).challenge, resource: resourceOf(m.name), state: "deny-1" }));
    const back = codeFrom(await submit(page, { decision: "deny" }));
    expect(back.get("error")).toBe("access_denied");
    expect(back.get("state")).toBe("deny-1");
    expect(back.get("iss")).toBe(origin);
    expect(back.get("code")).toBeNull();
  });

  it("asks for the memory's name when the request names none, and grants that memory", async () => {
    const m = await createMemory();
    const clientId = await register("Nameless");
    const p = await pkce();
    const ask = await openPage(authorizePath({ clientId, challenge: p.challenge, resource: null }));
    expect(ask.res.status).toBe(200);
    expect(ask.html).toContain('<form method="get" action="/oauth/authorize">');
    expect(ask.html).toContain('name="memory"');
    expect(ask.cookie).toBe("");
    // The form asks the same request again, with the name.
    const again = new URLSearchParams({ ...ask.fields, memory: "Not A Name" });
    const bad = await openPage(`/oauth/authorize?${again}`);
    expect(bad.res.status).toBe(400);
    expect(bad.html).toContain("That is not a memory name.");
    again.set("memory", m.name);
    const page = await openPage(`/oauth/authorize?${again}`);
    expect(page.res.status).toBe(200);
    expect(page.html).toContain(`<strong>${m.name}</strong>`);
    const code = codeFrom(await approve(page, m.token)).get("code")!;
    const res = await exchange(code, clientId, p.verifier);
    expect(res.status).toBe(200);
    const t = (await res.json()) as Tokens;
    expect(t.resource).toBe(resourceOf(m.name));
    expect((await mcp(m.name, `Bearer ${t.access_token}`)).status).toBe(200);
  });

  it("asks a confidential client for PKCE too", async () => {
    const m = await createMemory();
    const res = await fetchWorker("/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Confidential", redirect_uris: [redirectUri], token_endpoint_auth_method: "client_secret_post" }),
    });
    const reg = (await res.json()) as { client_id: string; client_secret: string };
    expect(reg.client_secret).toBeTypeOf("string");
    const back = codeFrom(await fetchWorker(authorizePath({ clientId: reg.client_id, resource: resourceOf(m.name) })));
    expect(back.get("error")).toBe("invalid_request");
    expect(back.get("error_description")).toBe("PKCE with S256 is required");
  });

  it("sends a request without PKCE, or for a resource that is no memory, back to the client", async () => {
    const clientId = await register();
    const m = await createMemory();
    const noPkce = await fetchWorker(authorizePath({ clientId, resource: resourceOf(m.name), state: "x" }));
    const back = codeFrom(noPkce);
    expect(back.get("error")).toBe("invalid_request");
    expect(back.get("iss")).toBe(origin);
    const challenge = (await pkce()).challenge;
    for (const resource of [`${origin}/`, `${origin}/${m.name}`, `https://elsewhere.example/${m.name}/mcp`, `${origin}/Bad/mcp`]) {
      const r = codeFrom(await fetchWorker(authorizePath({ clientId, challenge, resource })));
      expect(r.get("error"), resource).toBe("invalid_target");
    }
    // A client or redirect it cannot trust is answered here, never redirected.
    for (const path of [authorizePath({ clientId: "nobody", challenge, resource: resourceOf(m.name) }),
      authorizePath({ clientId, challenge, resource: resourceOf(m.name), redirect: "https://evil.example/cb" })]) {
      const res = await fetchWorker(path);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toContain("This request cannot go on.");
    }
  });
});

describe("tokens and memories", () => {
  it("refuses a token at another memory, and a code exchanged for another memory", async () => {
    const a = await createMemory();
    const b = await createMemory();
    const g = await grant(a.name);
    const res = await mcp(b.name, `Bearer ${g.tokens.access_token}`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(res.headers.get("www-authenticate")).toContain(`/oauth-protected-resource/${b.name}/mcp"`);
    // The same token, its memory's name changed in front, is refused too.
    const forged = g.tokens.access_token.replace(`${a.name}:`, `${b.name}:`);
    expect((await mcp(b.name, `Bearer ${forged}`)).status).toBe(401);
    // A refresh cannot move a grant to another memory.
    const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: g.tokens.refresh_token, client_id: g.clientId, resource: resourceOf(b.name) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("invalid_target");
    // Nor can a code.
    const clientId = await register();
    const p = await pkce();
    const page = await openPage(authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(a.name) }));
    const code = codeFrom(await approve(page, a.token)).get("code")!;
    const x = await exchange(code, clientId, p.verifier, resourceOf(b.name));
    expect(x.status).toBe(400);
    expect(((await x.json()) as { error: string }).error).toBe("invalid_target");
    // It still works at its own memory.
    expect((await mcp(a.name, `Bearer ${g.tokens.access_token}`)).status).toBe(200);
  });

  it("are refused once the grant is revoked, and refresh no more", async () => {
    const m = await createMemory();
    const g = await grant(m.name);
    expect((await mcp(m.name, `Bearer ${g.tokens.access_token}`)).status).toBe(200);
    const listed = (await (await admin(`/admin/memories/${m.name}/grants`)).json()) as { grants: { id: string }[] };
    expect(listed.grants).toHaveLength(1);
    const revoke = await admin(`/admin/memories/${m.name}/grants/${listed.grants[0]!.id}`, "DELETE");
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toEqual({ memory: m.name, revoked: listed.grants[0]!.id });
    expect((await mcp(m.name, `Bearer ${g.tokens.access_token}`)).status).toBe(401);
    const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: g.tokens.refresh_token, client_id: g.clientId });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("outlive a new fixed token: replacing it revokes no grant", async () => {
    const m = await createMemory();
    const g = await grant(m.name);
    expect((await admin(`/admin/memories/${m.name}/token`, "POST")).status).toBe(200);
    expect((await mcp(m.name, `Bearer ${m.token}`)).status).toBe(401);
    expect((await mcp(m.name, `Bearer ${g.tokens.access_token}`)).status).toBe(200);
  });

  it("are revoked by the client itself (RFC 7009)", async () => {
    const m = await createMemory();
    const g = await grant(m.name);
    const res = await tokenRequest({ token: g.tokens.refresh_token, token_type_hint: "refresh_token", client_id: g.clientId });
    expect(res.status).toBe(200);
    expect((await mcp(m.name, `Bearer ${g.tokens.access_token}`)).status).toBe(401);
  });

  it("leave the fixed token working exactly as before, without reaching KV", async () => {
    const m = await createMemory();
    const touched: string[] = [];
    const e = envWithoutKV(touched);
    const c = new Client("new", m);
    c.env = e;
    const s = idIn(await c.ok("get_context", {}), "s_");
    await c.ok("remember", { session_id: s, gist: "a fixed-token moment", body: "kept" });
    const old = new Client("old", m);
    old.env = e;
    await old.connect();
    await old.ok("recall", { query: "moment", session_id: s });
    for (const auth of [null, "Bearer ziwo_wrong", `Bearer ${m.token}x`, "Basic x"]) {
      expect((await mcp(m.name, auth, e)).status).toBe(401);
    }
    expect(touched).toEqual([]);
    // The same environment does fail where KV is needed.
    const g = await grant(m.name);
    expect((await mcp(m.name, `Bearer ${g.tokens.access_token}`, e)).status).toBe(503);
    expect(touched.length).toBeGreaterThan(0);
  });
});

describe("grants in the admin API", () => {
  it("need the secret, name a memory that exists, and revoke only what is there", async () => {
    const m = await createMemory();
    for (const secret of [null, "wrong"]) {
      expect((await admin(`/admin/memories/${m.name}/grants`, "GET", secret)).status).toBe(401);
      expect((await admin(`/admin/memories/${m.name}/grants/AAAAAAAAAAAAAAAA`, "DELETE", secret)).status).toBe(401);
    }
    const none = await admin(`/admin/memories/${freshName()}/grants`);
    expect(none.status).toBe(404);
    expect(((await none.json()) as { error: string }).error).toMatch(/^no such memory/);
    expect(await (await admin(`/admin/memories/${m.name}/grants`)).json()).toEqual({ memory: m.name, grants: [] });
    for (const id of ["AAAAAAAAAAAAAAAA", "short", "../../x"]) {
      const res = await admin(`/admin/memories/${m.name}/grants/${encodeURIComponent(id)}`, "DELETE");
      expect(res.status, id).toBe(404);
    }
    for (const [method, path] of [["POST", "grants"], ["GET", "grants/AAAAAAAAAAAAAAAA"], ["DELETE", "grants"], ["DELETE", "grants/"]] as const) {
      expect((await admin(`/admin/memories/${m.name}/${path}`, method)).status, `${method} ${path}`).toBe(404);
    }
  });

  it("list the client's name, when and an id, newest first, for that memory alone", async () => {
    const before = Date.now();
    const m = await createMemory();
    const other = await createMemory();
    await grant(m.name, adminSecret, "First");
    // Later by a minute, so that the order shows.
    const now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now + 60_000);
    await grant(m.name, m.token, "Second");
    vi.restoreAllMocks();
    await grant(other.name, other.token, "Elsewhere");
    const body = (await (await admin(`/admin/memories/${m.name}/grants`)).json()) as {
      grants: { id: string; client: string; createdAt: number; expiresAt: number }[];
    };
    expect(body.grants.map((g) => g.client).sort()).toEqual(["First", "Second"]);
    for (const g of body.grants) {
      expect(Object.keys(g).sort()).toEqual(["client", "createdAt", "expiresAt", "id"]);
      expect(g.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(g.createdAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
      expect(g.expiresAt - g.createdAt).toBe(grantIdleTTL * 1000);
    }
    expect(body.grants.map((g) => g.client)).toEqual(["Second", "First"]);
  });

  it("lapse 30 days after the grant was last used, not after it was made", async () => {
    const m = await createMemory();
    const g = await grant(m.name);
    const now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now + 86_400_000);
    const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: g.tokens.refresh_token, client_id: g.clientId });
    vi.restoreAllMocks();
    expect(r.status).toBe(200);
    const body = (await (await admin(`/admin/memories/${m.name}/grants`)).json()) as { grants: { createdAt: number; expiresAt: number }[] };
    expect(body.grants[0]!.expiresAt - body.grants[0]!.createdAt).toBeGreaterThanOrEqual((grantIdleTTL + 86_399) * 1000);
  });

  it("show a grant approved but not yet exchanged without an expiry", async () => {
    const m = await createMemory();
    const clientId = await register("Pending");
    const page = await openPage(authorizePath({ clientId, challenge: (await pkce()).challenge, resource: resourceOf(m.name) }));
    codeFrom(await approve(page, m.token));
    const body = (await (await admin(`/admin/memories/${m.name}/grants`)).json()) as { grants: { client: string; expiresAt: number | null }[] };
    expect(body.grants).toEqual([expect.objectContaining({ client: "Pending", expiresAt: null })]);
  });
});

describe("the access log of a flow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names each endpoint and its outcome, and holds no code, token, secret, state or verifier", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    const warn = vi.spyOn(console, "warn");
    const m = await createMemory();
    const clientId = await register("Logged client");
    const p = await pkce();
    const path = authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(m.name), state: "state-marker" });
    const page = await openPage(path, { "user-agent": "browser-marker/1" });
    await approve(page, "credential-marker");
    const again = await openPage(path);
    const answer = codeFrom(await approve(again, m.token));
    const code = answer.get("code")!;
    await exchange(code, clientId, `${p.verifier}x`, resourceOf(m.name));
    const t = (await (await exchange(code, clientId, p.verifier, resourceOf(m.name))).json()) as Tokens;
    await mcp(m.name, `Bearer ${t.access_token}`);
    await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId });

    const secrets = [code, t.access_token, t.refresh_token, m.token, adminSecret, p.verifier, p.challenge, "state-marker",
      "credential-marker", "browser-marker", clientId, "Logged client"];
    for (const l of lines) for (const x of secrets) expect(l, l).not.toContain(x);
    const steps = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.oauth !== undefined || l.cred !== undefined)
      .map((l) => [l.oauth ?? "mcp", l.outcome ?? l.auth, l.reason ?? l.cred ?? "", l.status].join(" "));
    expect(steps).toEqual([
      "register registered  201",
      "authorize shown  200",
      "authorize refused  403",
      "authorize shown  200",
      "authorize approved token 302",
      "token invalid_grant code_verifier_mismatch 400",
      "token issued  200",
      "mcp ok oauth 200",
      "token refreshed  200",
    ]);
    // The library's own warnings, which hold its descriptions, are not used.
    expect(warn).not.toHaveBeenCalled();
  });
});
