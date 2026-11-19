import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { directoryName } from "../src/directory";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/http";
import { adminSecret, Client, createMemory, fetchWorker, freshName } from "./mcp-helpers";

const admin = (path: string, method = "GET", body?: unknown) => fetchWorker(path, {
  method, headers: { authorization: `Bearer ${adminSecret}` },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
});
const host = (token: string | null, path: string, body?: unknown) => fetchWorker(`/harness/v1/${path}`, {
  method: body === undefined ? "GET" : "POST", headers: token === null ? {} : { authorization: `Bearer ${token}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});
async function info(name: string) {
  const r = await admin(`/admin/memories/${name}/identity`); expect(r.status).toBe(200);
  return await r.json() as { instance: string; identity: { id: string; sourceInstance: string; origin: string } | null };
}
async function target(name: string) {
  const i = await info(name); expect(i.identity).not.toBeNull();
  return { memory: name, instance: i.instance, identityId: i.identity!.id };
}
async function harness() {
  const r = await admin("/admin/harnesses", "POST", { name: "synthetic host" }); expect(r.status).toBe(201);
  return await r.json() as { id: string; token: string };
}
const bind = (token: string, threadId: string, t: Awaited<ReturnType<typeof target>>, activationId = "activation") =>
  host(token, "bind", { threadId, ...t, activationId, source: "conversation" });
async function exported(name: string) { const r = await admin(`/admin/memories/${name}/export`); expect(r.status).toBe(200); return r.text(); }
const imported = (name: string, data: string) => admin(`/admin/memories/${name}/import`, "POST", data);
function legacyEmpty(v2: string, instance: string): string {
  const lines = v2.trimEnd().split("\n"); const header = JSON.parse(lines[0]!); const footer = JSON.parse(lines.at(-1)!);
  delete header.identity; header.ziwo_export = 1; header.instance = instance; footer.head = "";
  return JSON.stringify(header) + "\n" + JSON.stringify(footer) + "\n";
}

describe("N1 synthetic identities and bindings", () => {
  it("keeps the existing MCP route for a memory named harness", async () => {
    const memory = await createMemory("harness");
    expect((await new Client("new", memory).connect()).status).toBe(200);
  });
  it("creates distinct identities and protects an empty backup header without sessions", async () => {
    const a = await createMemory(); const b = await createMemory(); const ai = await info(a.name); const bi = await info(b.name);
    expect(ai.identity?.id).not.toBe(bi.identity?.id); expect(ai.identity?.sourceInstance).toBe(ai.instance);
    const counts = () => runInDurableObject(env.MEMORY.getByName(a.name), (_o, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM sessions").toArray()[0]!.n);
    expect(await counts()).toBe(0);
    const data = await exported(a.name); expect(JSON.parse(data.split("\n")[0]!).ziwo_export).toBe(2);
    const restored = freshName(); expect((await imported(restored, data)).status).toBe(201);
    const ri = await info(restored); expect(ri.identity).toEqual(ai.identity); expect(ri.instance).not.toBe(ai.instance);
    const bad = freshName(); expect((await imported(bad, data.replace(ai.identity!.id, bi.identity!.id))).status).toBe(400);
    expect((await admin(`/admin/memories/${bad}/identity`)).status).toBe(404);
    const duplicate = data.replace('"identity":', '"identity":null,"identity":');
    expect((await imported(freshName(), duplicate)).status).toBe(400);
    const downgrade = data.replace('"ziwo_export":2', '"ziwo_export":1');
    expect((await imported(freshName(), downgrade)).status).toBe(400);
    expect(await counts()).toBe(0);
  });

  it("migrates legacy sources explicitly and consistently, including unknown sources", async () => {
    const seed = await createMemory(); const empty = await exported(seed.name); const source = `legacy_${crypto.randomUUID()}`;
    const a = freshName(); const b = freshName(); const v1 = legacyEmpty(empty, source);
    expect((await imported(a, v1)).status).toBe(201); expect((await imported(b, v1)).status).toBe(201);
    const ai = await info(a); const bi = await info(b); expect(ai.identity).toBeNull();
    const migrate = (name: string, instance: string, sourceInstance?: string) => admin(`/admin/memories/${name}/identity`, "POST", { expectedInstance: instance, ...(sourceInstance === undefined ? {} : { sourceInstance }) });
    expect((await migrate(a, "wrong")).status).toBe(409); expect((await migrate(a, ai.instance, "different")).status).toBe(409);
    expect((await migrate(a, ai.instance)).status).toBe(200); expect((await migrate(a, ai.instance)).status).toBe(200);
    expect((await migrate(b, bi.instance)).status).toBe(200); expect((await info(a)).identity?.id).toBe((await info(b)).identity?.id);
    const unknown = freshName(); expect((await imported(unknown, legacyEmpty(empty, ""))).status).toBe(201);
    const ui = await info(unknown); expect((await migrate(unknown, ui.instance)).status).toBe(409);
    expect((await migrate(unknown, ui.instance, "verified_source")).status).toBe(200);
  });

  it("serializes competing bindings and requires explicit matching restore after recreation", async () => {
    const a = await createMemory(); const b = await createMemory(); const ta = await target(a.name); const tb = await target(b.name);
    const h = await harness(); const other = await harness(); const thread = `thread_${crypto.randomUUID()}`;
    const results = await Promise.all([bind(h.token, thread, ta), bind(h.token, thread, tb)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const current = await (await host(h.token, `binding?threadId=${thread}`)).json() as { binding: { identityId: string; state: string }; canRun: boolean };
    expect(current.binding.state).toBe("bound_initializing"); expect(current.canRun).toBe(false);
    const winner = current.binding.identityId === ta.identityId ? ta : tb; const loser = winner === ta ? tb : ta;
    await evictDurableObject(env.DIRECTORY.getByName(directoryName));
    expect((await bind(h.token, thread, winner, "retry")).status).toBe(200);
    expect((await bind(h.token, `${thread}_other`, loser)).status).toBe(200); expect((await bind(other.token, thread, loser)).status).toBe(200);
    const restored = freshName(); expect((await imported(restored, await exported(winner.memory))).status).toBe(201); const tr = await target(restored);
    expect((await bind(h.token, thread, tr)).status).toBe(409);
    const request = { threadId: thread, ...tr, previousInstance: winner.instance, requestId: "restore_1" };
    expect((await host(h.token, "restore", { ...request, previousInstance: "wrong" })).status).toBe(409);
    expect((await host(h.token, "restore", { ...request, ...loser })).status).toBe(409);
    expect((await host(h.token, "restore", request)).status).toBe(200); expect((await host(h.token, "restore", request)).status).toBe(200);
    expect((await host(h.token, "restore", { ...request, requestId: "restore_2" })).status).toBe(409);
    expect((await admin(`/admin/memories/${restored}?confirm=${restored}`, "DELETE")).status).toBe(200); await createMemory(restored);
    const after = await (await host(h.token, `binding?threadId=${thread}`)).json() as { targetAvailable: boolean; canRun: boolean };
    expect(after.targetAvailable).toBe(false); expect(after.canRun).toBe(false); expect((await bind(h.token, thread, await target(restored))).status).toBe(409);
  });

  it("rejects missing, wrong and revoked credentials and temporary forks", async () => {
    const m = await createMemory(); const t = await target(m.name); const h = await harness(); const thread = `thread_${crypto.randomUUID()}`;
    expect((await host(null, `binding?threadId=${thread}`)).status).toBe(401);
    expect((await host("zwh_" + "a".repeat(43), `binding?threadId=${thread}`)).status).toBe(401);
    expect((await host(h.token, "bind", { ...t, threadId: thread, activationId: "x", source: "temporary" })).status).toBe(403);
    expect((await bind(h.token, thread, t)).status).toBe(200);
    expect((await host(h.token, "fork", { threadId: `${thread}_tmp`, parentThreadId: thread, source: "temporary" })).status).toBe(403);
    const fork = await host(h.token, "fork", { threadId: `${thread}_child`, parentThreadId: thread, source: "conversation" }); expect(fork.status).toBe(200);
    const f = await fork.json() as { binding: { identityId: string; parentThreadId: string }; canRun: boolean };
    expect(f.binding.identityId).toBe(t.identityId); expect(f.binding.parentThreadId).toBe(thread); expect(f.canRun).toBe(false);
    const rotation = await admin(`/admin/harnesses/${h.id}/token`, "POST"); expect(rotation.status).toBe(200);
    const replacement = await rotation.json() as { token: string };
    expect((await host(h.token, `binding?threadId=${thread}`)).status).toBe(401);
    const mcp = await fetchWorker(`/${m.name}/mcp`, { method: "POST", headers: { authorization: `Bearer ${replacement.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    expect(mcp.status).toBe(401);
    await evictDurableObject(env.DIRECTORY.getByName(directoryName));
    expect((await host(replacement.token, `binding?threadId=${thread}`)).status).toBe(200);
    expect((await admin(`/admin/harnesses/${h.id}`, "DELETE")).status).toBe(200);
    expect((await host(replacement.token, `binding?threadId=${thread}`)).status).toBe(401);
  });
  it("rejects a captured fixed-token authorization after same-name replacement", async () => {
    const m = await createMemory(); const stub = env.MEMORY.getByName(m.name);
    const captured = await stub.authorizeInstance(await sha256Hex(m.token));
    expect(captured.access).toBe("ok"); expect(captured.instance).toBeTruthy();
    expect((await admin(`/admin/memories/${m.name}?confirm=${m.name}`, "DELETE")).status).toBe(200);
    await createMemory(m.name);
    expect(await stub.answer({ tool: "get_context", model: "synthetic" }, captured.instance)).toEqual({ gone: true });
  });

  it("reads a legacy object missing its instance without initializing it", async () => {
    const seed = await createMemory(); const name = freshName();
    expect((await imported(name, legacyEmpty(await exported(seed.name), "legacy_origin"))).status).toBe(201);
    const stub = env.MEMORY.getByName(name);
    await runInDurableObject(stub, (_o, state) => { state.storage.sql.exec("DELETE FROM meta WHERE key = 'instance'"); });
    await evictDurableObject(stub);
    const snapshot = () => runInDurableObject(stub, (_o, state) => JSON.stringify(state.storage.sql.exec("SELECT * FROM meta ORDER BY key").toArray()));
    const before = await snapshot(); const read = await info(name);
    expect(read.instance).toBeNull(); expect(read.identity).toBeNull(); expect(await snapshot()).toBe(before);
    expect((await admin(`/admin/memories/${name}/identity`, "POST", { expectedInstance: null })).status).toBe(409);
    expect(await snapshot()).toBe(before);
    expect((await admin(`/admin/memories/${name}/identity`, "POST", { expectedInstance: null, sourceInstance: "verified_origin" })).status).toBe(200);
    const migrated = await info(name); expect(migrated.instance).toBeTruthy(); expect(migrated.identity?.sourceInstance).toBe("verified_origin");
  });

  it("keeps old restore requests idempotent across later restores and a directory restart", async () => {
    const a = await createMemory(); const ta = await target(a.name); const h = await harness();
    const thread = `thread_${crypto.randomUUID()}`; expect((await bind(h.token, thread, ta)).status).toBe(200);
    const backup = await exported(a.name);
    const b = freshName(); const c = freshName();
    expect((await imported(b, backup)).status).toBe(201); expect((await imported(c, backup)).status).toBe(201);
    const tb = await target(b); const tc = await target(c);
    const r1 = { threadId: thread, ...tb, previousInstance: ta.instance, requestId: "r1" };
    const r2 = { threadId: thread, ...tc, previousInstance: tb.instance, requestId: "r2" };
    expect((await host(h.token, "restore", r1)).status).toBe(200);
    expect((await host(h.token, "restore", r2)).status).toBe(200);
    await evictDurableObject(env.DIRECTORY.getByName(directoryName));
    const retry = await host(h.token, "restore", r1); expect(retry.status).toBe(200);
    expect((await retry.json() as { binding: { instance: string } }).binding.instance).toBe(tc.instance);
    expect((await host(h.token, "restore", { ...r1, ...tc })).status).toBe(409);
    const current = await (await host(h.token, `binding?threadId=${thread}`)).json() as { binding: { instance: string } };
    expect(current.binding.instance).toBe(tc.instance);
  });

  it("rolls back a binding when its event write fails", async () => {
    const m = await createMemory(); const t = await target(m.name); const h = await harness();
    const thread = `thread_${crypto.randomUUID()}`; const directory = env.DIRECTORY.getByName(directoryName);
    await runInDurableObject(directory, (_o, state) => {
      state.storage.sql.exec("CREATE TRIGGER test_reject_binding_event BEFORE INSERT ON binding_events BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    });
    try {
      expect((await bind(h.token, thread, t)).status).toBe(503);
      const after = await (await host(h.token, `binding?threadId=${thread}`)).json() as { binding: unknown; state: string };
      expect(after.binding).toBeNull(); expect(after.state).toBe("unbound");
    } finally {
      await runInDurableObject(directory, (_o, state) => { state.storage.sql.exec("DROP TRIGGER test_reject_binding_event"); });
    }
    expect((await bind(h.token, thread, t)).status).toBe(200);
  });

});
