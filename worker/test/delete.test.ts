// Deleting a memory through the admin API: the name repeated, every grant
// revoked, the object emptied, the name off the directory; afterwards the
// name is as one never used and can be made again, empty; a failure in the
// middle is finished by a repeat; another memory is untouched.

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { embedSettings, WorkersAI } from "../src/embed";
import type { Env } from "../src/index";
import { Embedding } from "../src/memory/embedding";
import type { Memory as MemoryObject } from "../src/memory-object";
import { FakeAI, farFuture } from "./embed-helpers";
import { dump } from "./helpers";
import { adminSecret, Client, type Created, createMemory, fetchWorker, freshName, idIn, testEnv } from "./mcp-helpers";
import { approve, authorizePath, grant, type Granted, openPage, pkce, register, resourceOf, tokenRequest } from "./oauth-helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

function admin(path: string, method = "GET", e?: Env, secret: string | null = adminSecret): Promise<Response> {
  return fetchWorker(path, { method, headers: secret === null ? {} : { authorization: `Bearer ${secret}` } }, e);
}

const del = (name: string, confirm: string | null = name, e?: Env, secret: string | null = adminSecret) =>
  admin(`/admin/memories/${name}${confirm === null ? "" : `?confirm=${encodeURIComponent(confirm)}`}`, "DELETE", e, secret);

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const mcpHeaders = (auth: string) => ({
  "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: auth,
});

function toolsList(name: string, token: string, e?: Env): Promise<Response> {
  return fetchWorker(`/${name}/mcp`, {
    method: "POST", headers: mcpHeaders(`Bearer ${token}`), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  }, e);
}

// What a memory's address answers to a token: status, headers that matter
// and body, with the name taken out.
async function refusal(name: string, token: string): Promise<string> {
  const res = await toolsList(name, token);
  return JSON.stringify([res.status, res.headers.get("www-authenticate"), res.headers.get("content-type"), await res.text()]).replaceAll(name, "NAME");
}

async function metadata(name: string): Promise<string> {
  const res = await fetchWorker(`/.well-known/oauth-protected-resource/${name}/mcp`);
  return JSON.stringify([res.status, await res.text()]).replaceAll(name, "NAME");
}

function tablesOf(name: string): Promise<{ tables: string[]; alarm: number | null; keys: number }> {
  return runInDurableObject(env.MEMORY.getByName(name), async (_obj: MemoryObject, state) => ({
    tables: state.storage.sql
      .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`)
      .toArray()
      .map((r) => r.name),
    alarm: await state.storage.getAlarm(),
    keys: [...state.storage.kv.list()].length,
  }));
}

async function listed(): Promise<string[]> {
  return ((await json(await admin("/admin/memories"))).memories as { name: string }[]).map((r) => r.name);
}

async function grantIds(name: string): Promise<string[]> {
  const res = await admin(`/admin/memories/${name}/grants`);
  if (res.status !== 200) return [];
  return ((await json(res)).grants as { id: string }[]).map((g) => g.id);
}

// A memory with three moments in it, an alarm set and two grants.
async function lived(): Promise<{ m: Created; grants: Granted[]; c: Client }> {
  const m = await createMemory();
  const c = new Client("new", m);
  const s = idIn(await c.ok("get_context", {}), "s_");
  for (const n of [1, 2, 3]) await c.ok("remember", { session_id: s, gist: `delete test moment ${n}`, body: "kept" });
  await runInDurableObject(env.MEMORY.getByName(m.name), (_o: MemoryObject, state) => state.storage.setAlarm(farFuture));
  const grants = [await grant(m.name, adminSecret, "One"), await grant(m.name, m.token, "Two")];
  return { m, grants, c };
}

const callTool = (name: string, token: string, e?: Env) => {
  const c = new Client("new", { name, token });
  if (e !== undefined) c.env = e;
  return c.tool("check", {});
};

describe("deleting a memory", () => {
  it("needs the admin secret, and is not there without one", async () => {
    const m = await createMemory();
    for (const secret of [null, "wrong", m.token]) {
      const res = await del(m.name, m.name, undefined, secret);
      expect(res.status, String(secret)).toBe(401);
    }
    for (const e of [testEnv(null), testEnv("")]) expect((await del(m.name, m.name, e)).status).toBe(404);
    expect((await toolsList(m.name, m.token)).status).toBe(200);
  });

  it("needs the name repeated, and changes nothing without it", async () => {
    const { m, grants } = await lived();
    const other = await createMemory();
    for (const confirm of [null, "", other.name, `${m.name}x`, m.name.toUpperCase(), ` ${m.name}`]) {
      const res = await del(m.name, confirm);
      expect(res.status, String(confirm)).toBe(400);
      expect(await res.json()).toEqual({
        error: `to delete memory "${m.name}" for good, repeat its name: DELETE /admin/memories/${m.name}?confirm=${m.name}`,
      });
    }
    // Another name's confirmation does not delete that one either.
    expect((await del(other.name, m.name)).status).toBe(400);
    expect((await callTool(m.name, m.token)).isError).toBe(false);
    expect((await callTool(m.name, grants[0]!.tokens.access_token)).isError).toBe(false);
    expect(await grantIds(m.name)).toHaveLength(2);
    expect((await toolsList(other.name, other.token)).status).toBe(200);
    // An invalid name is refused as every route refuses it.
    expect((await del("Bad", "Bad")).status).toBe(400);
  });

  it("revokes every grant, empties the object, unlists the name; the name is then one never used", async () => {
    const { m, grants } = await lived();
    // Another memory, with a grant of its own, is not touched.
    const kept = await lived();
    const keptBefore = await runInDurableObject(env.MEMORY.getByName(kept.m.name), (o: MemoryObject, state) => dump(o.store, state.storage));
    const keptGrants = await grantIds(kept.m.name);
    const never = freshName();
    const before = { refusal: await refusal(never, "ziwo_x"), metadata: await metadata(never) };

    const res = await del(m.name);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ memory: m.name, deleted: true, revokedGrants: 2, emptied: true, unlisted: true });

    // The object holds nothing: no table, no key, no alarm.
    expect(await tablesOf(m.name)).toEqual({ tables: [], alarm: null, keys: 0 });
    // The fixed token and the OAuth tokens are refused, as at a name never used.
    expect(await refusal(m.name, m.token)).toBe(before.refusal);
    expect(await metadata(m.name)).toBe(before.metadata);
    for (const g of grants) {
      const r = await toolsList(m.name, g.tokens.access_token);
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
      const refresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: g.tokens.refresh_token, client_id: g.clientId });
      expect(refresh.status).toBe(400);
      expect(((await refresh.json()) as { error: string }).error).toBe("invalid_grant");
    }
    // The admin API knows it no more.
    for (const path of ["", "/grants", "/check", "/export"]) {
      const r = await admin(`/admin/memories/${m.name}${path}`);
      expect(r.status, path).toBe(404);
      expect(await r.json()).toEqual({ error: `no such memory: "${m.name}"` });
    }
    expect(await listed()).not.toContain(m.name);
    // The consent page does not approve the admin secret for it.
    const clientId = await register();
    const page = await openPage(authorizePath({ clientId, challenge: (await pkce()).challenge, resource: resourceOf(m.name) }));
    expect((await approve(page, adminSecret)).status).toBe(403);
    // Nothing of that made the object hold anything.
    expect(await tablesOf(m.name)).toEqual({ tables: [], alarm: null, keys: 0 });
    // A repeat finds nothing to do.
    const again = await del(m.name);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: `no such memory: "${m.name}"` });

    // The other memory is as it was.
    expect(await runInDurableObject(env.MEMORY.getByName(kept.m.name), (o: MemoryObject, state) => dump(o.store, state.storage))).toBe(keptBefore);
    expect(await grantIds(kept.m.name)).toEqual(keptGrants);
    expect((await callTool(kept.m.name, kept.m.token)).isError).toBe(false);
    expect((await callTool(kept.m.name, kept.grants[1]!.tokens.access_token)).isError).toBe(false);
    expect(await listed()).toContain(kept.m.name);
  });

  it("frees the name: it can be created again, empty, and nothing old reaches it", async () => {
    const { m, grants } = await lived();
    expect((await del(m.name)).status).toBe(200);
    const res = await admin(`/admin/memories/${m.name}`, "POST");
    expect(res.status).toBe(201);
    const fresh = (await json(res)).token as string;
    expect(await json(await admin(`/admin/memories/${m.name}`))).toMatchObject({ memories: 0, events: 0, hasToken: true });
    expect(await grantIds(m.name)).toEqual([]);
    expect(await listed()).toContain(m.name);
    expect((await toolsList(m.name, m.token)).status).toBe(401);
    for (const g of grants) expect((await toolsList(m.name, g.tokens.access_token)).status).toBe(401);
    expect((await callTool(m.name, fresh)).isError).toBe(false);
  });

  it("refuses a grant that the listing missed, by the instance it was made for, and builds nothing", async () => {
    const m = await createMemory();
    const g = await grant(m.name);
    // KV lists lag: here the listing finds no grant at all.
    const kv = new Proxy(env.OAUTH_KV, {
      get(target, prop) {
        if (prop === "list") return async () => ({ keys: [], list_complete: true, cacheStatus: null });
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const res = await del(m.name, m.name, { ...testEnv(), OAUTH_KV: kv });
    expect(await res.json()).toMatchObject({ revokedGrants: 0, emptied: true });
    // The grant survives in KV; its token passes the library, but every tool
    // call is refused by the object, which stays empty.
    const log = vi.spyOn(console, "log");
    const r = await callTool(m.name, g.tokens.access_token);
    expect(r).toEqual({ isError: true, text: "the memory server hit an internal error; nothing was changed" });
    const tool = log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).find((l) => l.msg === "tool");
    expect(tool).toMatchObject({ outcome: "error", error: "NoSuchMemory" });
    expect(await tablesOf(m.name)).toEqual({ tables: [], alarm: null, keys: 0 });
    // Made again under the same name, the memory is not reached by it either.
    const made = await admin(`/admin/memories/${m.name}`, "POST");
    expect(made.status).toBe(201);
    expect((await callTool(m.name, g.tokens.access_token)).isError).toBe(true);
    expect(await json(await admin(`/admin/memories/${m.name}`))).toMatchObject({ memories: 0, events: 0 });
    expect((await callTool(m.name, (await json(made)).token as string)).isError).toBe(false);
    // A grant made for the new memory does reach it.
    const g2 = await grant(m.name);
    expect((await callTool(m.name, g2.tokens.access_token)).isError).toBe(false);
    // The list of grants shows the new memory's alone, and revokes the one
    // left over: its token is then refused before it reaches anything.
    expect((await toolsList(m.name, g.tokens.access_token)).status).toBe(200);
    expect(await grantIds(m.name)).toHaveLength(1);
    expect((await toolsList(m.name, g.tokens.access_token)).status).toBe(401);
    expect((await callTool(m.name, g2.tokens.access_token)).isError).toBe(false);
    expect(await grantIds(m.name)).toHaveLength(1);
  });

  it("refuses a call let in just before the deletion, without building anything", async () => {
    const m = await createMemory();
    await runInDurableObject(env.MEMORY.getByName(m.name), async (obj: MemoryObject) => {
      expect(obj.authorize("0".repeat(64))).toBe("rejected");
      expect(await obj.remove()).toBe("removed");
      // As if authorize had said ok a moment before.
      expect(obj.answer({ tool: "check" })).toEqual({ gone: true });
      expect(obj.instance()).toBe("unknown");
      expect(await obj.remove()).toBe("unknown");
    });
    expect(await tablesOf(m.name)).toEqual({ tables: [], alarm: null, keys: 0 });
  });

  it("waits for an embedding batch under way before it empties the object", async () => {
    const m = await createMemory();
    const ai = new FakeAI();
    const settings = embedSettings({ ...testEnv(), AI: ai.asAi() })!;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const slow = new WorkersAI(ai.asAi(), settings.model);
    const held = { documents: async (t: string[]) => { await gate; return slow.documents(t); }, queries: () => Promise.reject(new Error("no")) };
    const stub = env.MEMORY.getByName(m.name);
    await runInDurableObject(stub, (obj: MemoryObject) => {
      obj.embedding = new Embedding(settings, held);
      obj.alarmNow = () => farFuture;
    });
    const c = new Client("new", m);
    const s = idIn(await c.ok("get_context", {}), "s_");
    await c.ok("remember", { session_id: s, gist: "a moment to embed", body: "kept" });
    const alarm = runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 50));
    let done = false;
    const deleting = del(m.name).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(done, "the deletion did not wait for the batch").toBe(false);
    open();
    expect(await alarm).toBe(true);
    expect((await deleting).status).toBe(200);
    expect(await tablesOf(m.name)).toEqual({ tables: [], alarm: null, keys: 0 });
  });
});

describe("a deletion that fails in the middle", () => {
  // failing replaces one call of one binding by a failure.
  function failing<K extends "OAUTH_KV" | "MEMORY" | "DIRECTORY">(key: K, method: string): Env {
    const base = testEnv();
    if (key === "OAUTH_KV") {
      const kv = new Proxy(env.OAUTH_KV, {
        get(target, prop) {
          if (prop === method) return () => Promise.reject(new Error("KV is down"));
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      return { ...base, OAUTH_KV: kv };
    }
    const ns = base[key] as unknown as { getByName(n: string): Record<string, unknown> };
    const wrapped = {
      getByName(n: string) {
        const stub = ns.getByName(n);
        return new Proxy(stub, {
          get(target, prop) {
            if (prop === method) return () => Promise.reject(new Error("unreachable"));
            return Reflect.get(target, prop);
          },
        });
      },
    };
    return { ...base, [key]: wrapped };
  }

  async function failsAt(name: string, e: Env, stepName: string): Promise<void> {
    const log = vi.spyOn(console, "log");
    const res = await del(name, name, e);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: `the memory was not fully deleted (the ${stepName} step failed); repeat the request to finish` });
    const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(lines.find((l) => l.msg === "admin failed")).toEqual({ msg: "admin failed", memory: name, action: "delete", step: stepName, error: "Error" });
    vi.restoreAllMocks();
  }

  it("at the grants: the memory is as it was, and a repeat finishes", async () => {
    const { m, grants } = await lived();
    await failsAt(m.name, failing("OAUTH_KV", "delete"), "grants");
    expect((await callTool(m.name, m.token)).isError).toBe(false);
    expect(await listed()).toContain(m.name);
    const res = await del(m.name);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ memory: m.name, deleted: true, revokedGrants: 2, emptied: true, unlisted: true });
    for (const g of grants) expect((await toolsList(m.name, g.tokens.access_token)).status).toBe(401);
    expect(await tablesOf(m.name)).toEqual({ tables: [], alarm: null, keys: 0 });
  });

  it("at the object: the grants are gone, the memory is still there, and a repeat finishes", async () => {
    const { m, grants } = await lived();
    await failsAt(m.name, failing("MEMORY", "remove"), "object");
    expect(await grantIds(m.name)).toEqual([]);
    for (const g of grants) expect((await toolsList(m.name, g.tokens.access_token)).status).toBe(401);
    expect((await callTool(m.name, m.token)).isError).toBe(false);
    expect(await listed()).toContain(m.name);
    const res = await del(m.name);
    expect(await res.json()).toEqual({ memory: m.name, deleted: true, revokedGrants: 0, emptied: true, unlisted: true });
    expect(await tablesOf(m.name)).toEqual({ tables: [], alarm: null, keys: 0 });
    expect((await toolsList(m.name, m.token)).status).toBe(401);
  });

  it("at the directory: the memory is gone but listed as missing, and a repeat finishes", async () => {
    const { m } = await lived();
    await failsAt(m.name, failing("DIRECTORY", "unregister"), "directory");
    expect((await toolsList(m.name, m.token)).status).toBe(401);
    const row = ((await json(await admin("/admin/memories"))).memories as Record<string, unknown>[]).find((r) => r.name === m.name);
    expect(row).toMatchObject({ name: m.name, error: "no such memory" });
    const res = await del(m.name);
    expect(await res.json()).toEqual({ memory: m.name, deleted: true, revokedGrants: 0, emptied: false, unlisted: true });
    expect(await listed()).not.toContain(m.name);
    expect((await del(m.name)).status).toBe(404);
  });

  it("deletes what is left of a name only listed, or only granted", async () => {
    const ghost = freshName();
    await env.DIRECTORY.getByName("directory").register(ghost, Date.now());
    expect(await json(await del(ghost))).toEqual({ memory: ghost, deleted: true, revokedGrants: 0, emptied: false, unlisted: true });
    expect(await tablesOf(ghost)).toEqual({ tables: [], alarm: null, keys: 0 });
    expect((await del(freshName())).status).toBe(404);
  });
});

describe("the access log of a deletion", () => {
  it("holds the route and figures only", async () => {
    const { m } = await lived();
    const log = vi.spyOn(console, "log");
    await del(m.name);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    const p = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(p).toMatchObject({ msg: "request", method: "DELETE", path: `/admin/memories/${m.name}`, status: 200, auth: "ok" });
    expect(lines[0]).not.toContain(adminSecret);
    expect(lines[0]).not.toContain(m.token);
  });
});
