// The Worker: routes, the admin API, tokens, memories that were never
// created, where the client's name comes from, the listen stream, and the
// access log.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { clientFromSessionId, type Env, sessionIdFor } from "../src/index";
import type { Memory as MemoryObject } from "../src/memory-object";
import { internalError } from "../src/mcp/server";
import { adminSecret, Client, createMemory, fetchWorker, freshName, idIn, modern, origin, readReply, testEnv } from "./mcp-helpers";

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// tablesOf lists the tables of a memory's database, apart from the
// platform's own.
function tablesOf(name: string): Promise<string[]> {
  return runInDurableObject(env.MEMORY.getByName(name), (_obj: MemoryObject, state) =>
    state.storage.sql
      .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`)
      .toArray()
      .map((r) => r.name),
  );
}

const admin = (path: string, secret: string | null = adminSecret, e?: Env, method = "POST") =>
  fetchWorker(path, { method, headers: secret === null ? {} : { authorization: `Bearer ${secret}` } }, e);

function mcpPost(name: string, auth: string | null, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  };
  if (auth !== null) headers.authorization = auth;
  return fetchWorker(`/${name}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("routes", () => {
  it("answers 404 to everything but a memory's endpoint and the admin API", async () => {
    const m = await createMemory();
    for (const path of ["/", "/foo", `/${m.name}`, `/${m.name}/mcp/`, `/${m.name}/other`, "/Bad/mcp", "/healthz/mcp",
      `/${"a".repeat(33)}/mcp`, "/-x/mcp", "/admin", "/admin/memories", "/admin/memories/", `/admin/memories/${m.name}/other`]) {
      const res = await fetchWorker(path, { method: "POST", headers: { authorization: `Bearer ${m.token}` } });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe("404 page not found\n");
    }
    // The longest name the rule allows is routed.
    expect((await mcpPost("a".repeat(32), "Bearer x")).status).toBe(401);
  });
});

describe("admin API", () => {
  it("is not there without ADMIN_SECRET", async () => {
    const name = freshName();
    for (const path of [`/admin/memories/${name}`, `/admin/memories/${name}/token`]) {
      expect((await admin(path, adminSecret, testEnv(null))).status, path).toBe(404);
      expect((await admin(path, adminSecret, testEnv(""))).status, path).toBe(404);
    }
    expect(await tablesOf(name)).toEqual([]);
  });

  it("needs the secret", async () => {
    const name = freshName();
    for (const secret of [null, "wrong", `${adminSecret}x`]) {
      for (const path of [`/admin/memories/${name}`, `/admin/memories/${name}/token`]) {
        const res = await admin(path, secret);
        expect(res.status, `${path} ${secret}`).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe('Bearer realm="ziwo"');
      }
    }
    expect((await admin(`/admin/memories/${name}`, adminSecret, undefined, "GET")).status).toBe(404);
    expect(await tablesOf(name)).toEqual([]);
  });

  it("creates a memory once and shows its token once; only the hash is stored", async () => {
    const name = freshName();
    const res = await admin(`/admin/memories/${name}`);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(["endpoint", "memory", "note", "token"]);
    expect(body.memory).toBe(name);
    expect(body.endpoint).toBe(`/${name}/mcp`);
    expect(body.token).toMatch(/^ziwo_[A-Za-z0-9_-]{43}$/);
    const token = body.token!;
    await runInDurableObject(env.MEMORY.getByName(name), (_obj: MemoryObject, state) => {
      const sql = state.storage.sql;
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'token_sha256'`).one().value).toBeTypeOf("string");
      // The token itself is nowhere in the database.
      for (const t of sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'memories_fts%'`).toArray()) {
        for (const row of sql.exec(`SELECT * FROM "${t.name}"`)) expect(JSON.stringify(row)).not.toContain(token);
      }
    });
    const stored = await runInDurableObject(env.MEMORY.getByName(name), (obj: MemoryObject) => obj.store.tokenHash());
    expect(stored).toBe(await sha256Hex(token));

    const again = await admin(`/admin/memories/${name}`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: `memory "${name}" already exists` });
    // The first token still works.
    expect((await mcpPost(name, `Bearer ${token}`)).status).toBe(200);
  });

  it("refuses a name the Go host would refuse", async () => {
    for (const bad of ["Upper", "healthz", "-dash", "a".repeat(33)]) {
      const res = await admin(`/admin/memories/${bad}`);
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toEqual({
        error: `invalid memory name "${bad}": use 1 to 32 lower-case letters, digits, - or _, starting with a letter or digit`,
      });
    }
  });

  it("issues a new token, after which the old one no longer works", async () => {
    const m = await createMemory();
    const res = await admin(`/admin/memories/${m.name}/token`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.token).toMatch(/^ziwo_[A-Za-z0-9_-]{43}$/);
    expect(body.token).not.toBe(m.token);
    expect((await mcpPost(m.name, `Bearer ${m.token}`)).status).toBe(401);
    expect((await mcpPost(m.name, `Bearer ${body.token}`)).status).toBe(200);
  });

  it("issues no token for a memory never created, and stores nothing for it", async () => {
    const name = freshName();
    const res = await admin(`/admin/memories/${name}/token`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `no such memory: "${name}"` });
    expect(await tablesOf(name)).toEqual([]);
  });
});

describe("tokens", () => {
  it("answers a missing, a wrong and a malformed token as the Go host does, and lets the right one in", async () => {
    const m = await createMemory();
    // As Go's host, with the pointer to the memory's OAuth metadata added, and
    // invalid_token when a bearer token was presented (RFC 6750, section 3).
    const metadata = `resource_metadata="${origin}/.well-known/oauth-protected-resource/${m.name}/mcp"`;
    for (const auth of [null, "Bearer wrong", `Bearer ${m.token}x`, `Basic ${m.token}`, `Bearer`, ""]) {
      const res = await mcpPost(m.name, auth);
      expect(res.status, String(auth)).toBe(401);
      const presented = auth !== null && auth.toLowerCase().startsWith("bearer");
      expect(res.headers.get("www-authenticate"), String(auth)).toBe(`Bearer realm="ziwo", ${metadata}${presented ? ', error="invalid_token"' : ""}`);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await res.text()).toBe("unauthorized\n");
    }
    // The scheme in any case and the token trimmed, as Go reads them.
    for (const auth of [`Bearer ${m.token}`, `bearer ${m.token}`, `BEARER  ${m.token} `]) {
      const res = await mcpPost(m.name, auth);
      expect(res.status, auth).toBe(200);
    }
  });

  it("are compared by their hash, whole", async () => {
    const m = await createMemory();
    const stub = env.MEMORY.getByName(m.name);
    const hash = await sha256Hex(m.token);
    expect(await stub.authorize(hash)).toBe("ok");
    for (const other of ["", hash.slice(0, 32), hash + "0", hash.toUpperCase(), await sha256Hex(m.token + "x")]) {
      expect(await stub.authorize(other), other).toBe("rejected");
    }
    expect(await env.MEMORY.getByName(freshName()).authorize(hash)).toBe("unknown");
  });

  it("answers a name never created exactly as a wrong token, and its database stays empty", async () => {
    const m = await createMemory();
    const name = freshName();
    // The answer at the name never created, with the memory's own name put
    // back where the metadata address holds it, is the answer at the memory.
    const same = (headers: Headers) => [...headers.entries()].map(([k, v]) => [k, v.replaceAll(`/${name}/mcp`, `/${m.name}/mcp`)]);
    for (const [auth, there] of [[null, null], ["Bearer ziwo_wrong", "Bearer ziwo_wrong"], [`Bearer ${m.token}`, "Bearer ziwo_wrong"]] as const) {
      const wrong = await mcpPost(m.name, there);
      const res = await mcpPost(name, auth);
      expect(res.status).toBe(wrong.status);
      expect(same(res.headers)).toEqual([...wrong.headers.entries()]);
      expect(await res.text()).toBe("unauthorized\n");
    }
    expect(await tablesOf(name)).toEqual([]);
  });
});

describe("the client's name", () => {
  async function clientOf(name: string, session: string): Promise<string> {
    return runInDurableObject(env.MEMORY.getByName(name), (obj: MemoryObject) => obj.store.session(session)!.client);
  }

  it("comes from initialize in the old generation, carried in the session id", async () => {
    const m = await createMemory();
    const c = new Client("old", m, "名前 old-client", "agent-old/1");
    await c.connect();
    expect(c.sessionId).toMatch(/^zw\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(clientFromSessionId(c.sessionId)).toBe("名前 old-client");
    const s = idIn(await c.ok("get_context", {}), "s_");
    expect(await clientOf(m.name, s)).toBe("名前 old-client");
  });

  it("comes from each request's _meta in the new generation", async () => {
    const m = await createMemory();
    const c = new Client("new", m, "new-client", "agent-new/1");
    const s = idIn(await c.ok("get_context", {}), "s_");
    expect(await clientOf(m.name, s)).toBe("new-client");
  });

  it("is the User-Agent when neither gives it", async () => {
    const m = await createMemory();
    const c = new Client("old", m, "unused", "agent-plain/2");
    // No initialize, so no session id.
    const s = idIn(await c.ok("get_context", {}), "s_");
    expect(await clientOf(m.name, s)).toBe("agent-plain/2");
    // A session id that is not ours names nobody.
    c.sessionId = "something-else";
    const s2 = idIn(await c.ok("get_context", {}), "s_");
    expect(await clientOf(m.name, s2)).toBe("agent-plain/2");
  });

  it("survives the round trip through a session id, clipped to 120 characters", () => {
    expect(clientFromSessionId(sessionIdFor("x".repeat(200)))).toBe("x".repeat(120));
    expect(clientFromSessionId(sessionIdFor(""))).toBe("");
    expect(clientFromSessionId("zw.a.%%%")).toBe("");
    expect(clientFromSessionId(null)).toBe("");
  });
});

// recordingEnv counts the calls each memory's object receives.
function recordingEnv(calls: string[]): Env {
  const ns = {
    getByName(name: string) {
      const stub = env.MEMORY.getByName(name);
      return new Proxy(stub, {
        get(target, prop) {
          if (typeof prop !== "string") return Reflect.get(target, prop);
          const methods = target as unknown as Record<string, (...a: unknown[]) => unknown>;
          return (...args: unknown[]) => {
            calls.push(prop);
            return methods[prop]!(...args);
          };
        },
      });
    },
  };
  return { ...testEnv(), MEMORY: ns as unknown as Env["MEMORY"] };
}

describe("subscriptions/listen", () => {
  it("is answered by the Worker: the object only checks the token", async () => {
    const m = await createMemory();
    const calls: string[] = [];
    const c = new Client("new", m, "listener");
    const res = await worker.fetch(
      new Request(`${origin}/${m.name}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${m.token}`,
          "mcp-protocol-version": modern,
          "mcp-method": "subscriptions/listen",
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "subscriptions/listen",
          params: { notifications: { toolsListChanged: true }, _meta: c.meta() },
        }),
      }),
      recordingEnv(calls),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("notifications/subscriptions/acknowledged");
    await reader.cancel();
    expect(calls).toEqual(["authorize"]);

    // A tool call reaches the object once more, and once only.
    calls.length = 0;
    const r = await readReply(
      await worker.fetch(
        new Request(`${origin}/${m.name}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json", accept: "application/json, text/event-stream",
            authorization: `Bearer ${m.token}`, "mcp-protocol-version": modern, "mcp-method": "tools/call", "mcp-name": "check",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check", arguments: {}, _meta: c.meta() } }),
        }),
        recordingEnv(calls),
      ),
    );
    expect(r.status).toBe(200);
    expect(calls).toEqual(["authorize", "answer"]);
  });
});

describe("the access log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("has one line per request and per tool call, and holds no argument, result or token", async () => {
    const m = await createMemory();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    const marker = "logmarker";
    const results: string[] = [];
    for (const gen of ["old", "new"] as const) {
      const c = new Client(gen, m, `${marker}-client`, "agent/1");
      await c.connect();
      const ctx = await c.ok("get_context", { model: `${marker}-model`, timezone: "Asia/Shanghai" });
      const s = idIn(ctx, "s_");
      results.push(ctx, s);
      const id = idIn(await c.ok("remember", { session_id: s, gist: `${marker} gist ${gen}`, body: `${marker} body` }));
      results.push(id);
      results.push(await c.ok("recall", { query: marker, session_id: s }));
      results.push(await c.ok("expand", { ids: [id] }));
      expect((await c.tool("remember", { session_id: s, gist: `${marker} bad`, body: 7 })).isError).toBe(true);
      expect((await c.tool("amend", { session_id: s, action: "pin", id: `m_${marker}` })).isError).toBe(true);
    }
    await mcpPost(m.name, null);
    await mcpPost(m.name, "Bearer wrong");
    await fetchWorker(`/nothing?token=${marker}`);

    expect(lines.length).toBeGreaterThan(0);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const [i, l] of lines.entries()) {
      // Nothing the calls carried, nor what they got back.
      expect(l, l).not.toContain(marker);
      expect(l).not.toContain(m.token);
      for (const r of results) expect(l).not.toContain(r.trim().split("\n")[0]);
      const p = parsed[i]!;
      if (p.msg === "tool" && p.tool === "recall") {
        // A recall adds what kind it was, in fixed words and a figure.
        expect(Object.keys(p).sort()).toEqual(["dur_ms", "memory", "msg", "outcome", "recall_by", "recall_parts", "recall_span", "tool"]);
        expect([p.recall_by, p.recall_parts, p.recall_span]).toEqual(["subject", 1, "none"]);
      } else if (p.msg === "tool" && p.outcome === "invalid") {
        // A refused call adds what it was refused for, in fixed words: the
        // body that was a number, and the memory that is not there.
        expect(Object.keys(p).sort()).toEqual(["dur_ms", "invalid_field", "invalid_kind", "memory", "msg", "outcome", "tool"]);
        expect([p.invalid_field, p.invalid_kind]).toEqual(p.tool === "remember" ? ["body", "type"] : ["id", "no_such"]);
      } else if (p.msg === "tool") {
        expect(Object.keys(p).sort()).toEqual(["dur_ms", "memory", "msg", "outcome", "tool"]);
      } else {
        expect(p.msg).toBe("request");
        for (const k of Object.keys(p)) expect(["msg", "method", "path", "status", "dur_ms", "auth", "cred", "agent", "mcp_version", "rpc"]).toContain(k);
      }
    }
    const tools = parsed.filter((p) => p.msg === "tool");
    expect(tools.map((p) => `${p.tool}:${p.outcome}`)).toEqual([
      "get_context:ok", "remember:ok", "recall:ok", "expand:ok", "remember:invalid", "amend:invalid",
      "get_context:ok", "remember:ok", "recall:ok", "expand:ok", "remember:invalid", "amend:invalid",
    ]);
    expect(tools.every((p) => p.memory === m.name)).toBe(true);
    const requests = parsed.filter((p) => p.msg === "request");
    expect(requests.map((p) => p.auth).filter((a) => a !== "ok")).toEqual(["missing", "rejected", undefined]);
    expect(requests.at(-1)).toMatchObject({ method: "GET", path: "/nothing", status: 404 });
    expect(requests.filter((p) => p.auth === "ok").every((p) => p.agent === "agent/1")).toBe(true);
    expect(requests.some((p) => p.mcp_version === modern)).toBe(true);
    expect(requests.some((p) => p.mcp_version === "2025-06-18")).toBe(true);
    // What each request asked for is one of a fixed list of words.
    const asked = new Set(requests.map((p) => p.rpc).filter((r) => r !== undefined));
    expect(asked.has("tools/call")).toBe(true);
    for (const r of asked) expect(["initialize", "notifications/initialized", "server/discover", "tools/list", "tools/call", "other"]).toContain(r);
  });

  it("logs an internal failure as an error, and tells the model nothing of it", async () => {
    const m = await createMemory();
    const c = new Client("new", m);
    const s = idIn(await c.ok("get_context", {}), "s_");
    await runInDurableObject(env.MEMORY.getByName(m.name), (_obj: MemoryObject, state) => {
      state.storage.sql.exec(`DROP TABLE memories`);
    });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    expect(await c.tool("recall", { query: "anything", session_id: s })).toEqual({ text: internalError, isError: true });
    const tool = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((p) => p.msg === "tool");
    expect(tool).toMatchObject({ tool: "recall", outcome: "error" });
  });
});

describe("request bodies", () => {
  it("leaves a body too large for the SDK to the SDK to refuse", async () => {
    const m = await createMemory();
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(4 * 1024 * 1024) } });
    const res = await fetchWorker(`/${m.name}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        authorization: `Bearer ${m.token}`, "mcp-protocol-version": "2025-06-18",
      },
      body: big,
    });
    expect(res.status).toBe(413);
  });
});
