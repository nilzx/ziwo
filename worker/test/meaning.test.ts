// Search by meaning through the Worker: the Worker embeds a recall's query
// within its limit and hands the vector over; the object searches. Two fake
// AI bindings, one for the Worker and one for the object, tell apart who
// called the model.

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { embedSettings, type EmbedSettings, queryInstruction, WorkersAI } from "../src/embed";
import type { Env } from "../src/index";
import { Embedding } from "../src/memory/embedding";
import type { Memory as MemoryObject } from "../src/memory-object";
import { FakeAI, farFuture } from "./embed-helpers";
import { adminSecret, Client, type Created, createMemory, fetchWorker, idIn, testEnv } from "./mcp-helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

interface Setup {
  m: Created;
  c: Client;
  session: string;
  workerAI: FakeAI;
  objectAI: FakeAI;
  settings: EmbedSettings;
  cat: string;
  deploy: string;
}

// setup creates a memory that searches by meaning, writes two memories over
// MCP and lets the alarm embed them.
async function setup(vars: Partial<Env> = {}): Promise<Setup> {
  const workerAI = new FakeAI();
  const objectAI = new FakeAI();
  const e: Env = { ...testEnv(), AI: workerAI.asAi(), ...vars };
  const settings = embedSettings(e)!;
  const m = await createMemory();
  const stub = env.MEMORY.getByName(m.name);
  await runInDurableObject(stub, (obj: MemoryObject) => {
    obj.embedding = new Embedding(settings, new WorkersAI(objectAI.asAi(), settings.model));
    obj.alarmNow = () => farFuture;
  });
  const c = new Client("new", m);
  c.env = e;
  const session = idIn(await c.ok("get_context", { model: "model-a" }), "s_");
  const cat = idIn(await c.ok("remember", { session_id: session, gist: "用户给我看了他的猫", body: "一只橘猫。" }));
  const deploy = idIn(await c.ok("remember", { session_id: session, gist: "第一次部署出了问题", body: "反向代理拒绝了所有请求。" }));
  expect(objectAI.calls, "a write called the model").toEqual([]);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(objectAI.calls.map((x) => [x.form, x.texts.length])).toEqual([["documents", 2]]);
  return { m, c, session, workerAI, objectAI, settings, cat, deploy };
}

function logLines(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
}

describe("the query", () => {
  it("is embedded by the Worker, as a query, and searched by the object", async () => {
    const s = await setup();
    const text = await s.c.ok("recall", { query: "feline", session_id: s.session });
    expect(idIn(text)).toBe(s.cat);
    expect(text).not.toContain(s.deploy);
    expect(s.workerAI.calls.map((x) => [x.model, x.form, x.texts.length, x.instruction, x.signal])).toEqual([
      ["@cf/qwen/qwen3-embedding-0.6b", "queries", 1, queryInstruction, true],
    ]);
    // What was sent is the query as recall reads it: trimmed, at most 500
    // characters.
    await s.c.ok("recall", { query: `  ${"猫".repeat(600)}  `, session_id: s.session });
    expect([...s.workerAI.calls[1]!.texts[0]!]).toHaveLength(500);
    // The object called the model for documents only.
    expect(s.objectAI.calls.every((x) => x.form === "documents")).toBe(true);
    // A tool other than recall embeds nothing.
    await s.c.ok("expand", { ids: [s.cat], session_id: s.session });
    expect(s.workerAI.calls).toHaveLength(2);
  });

  it("from a slow model gives a keyword answer within the limit", async () => {
    const s = await setup({ EMBED_QUERY_TIMEOUT_MS: "200" });
    s.workerAI.delay = 5000;
    const log = vi.spyOn(console, "log");
    const start = Date.now();
    const text = await s.c.ok("recall", { query: "部署", session_id: s.session });
    const took = Date.now() - start;
    expect(idIn(text)).toBe(s.deploy);
    expect(took, "the answer waited for the model").toBeLessThan(2000);
    expect(took).toBeGreaterThanOrEqual(150);
    const lines = logLines(log);
    expect(lines.filter((l) => l.msg === "query embedding failed")).toEqual([
      { msg: "query embedding failed", reason: "timeout", limit_ms: 200 },
    ]);
    // Nothing the query said reached the log.
    expect(lines.some((l) => JSON.stringify(l).includes("部署"))).toBe(false);
  });

  it("from a failing model gives a keyword answer", async () => {
    const s = await setup();
    s.workerAI.fail = true;
    const log = vi.spyOn(console, "log");
    const text = await s.c.ok("recall", { query: "部署", session_id: s.session });
    expect(idIn(text)).toBe(s.deploy);
    expect(await s.c.ok("recall", { query: "feline", session_id: s.session })).not.toContain(s.cat);
    expect(logLines(log).filter((l) => l.msg === "query embedding failed")).toEqual([
      { msg: "query embedding failed", reason: "error", error: "Error" },
      { msg: "query embedding failed", reason: "error", error: "Error" },
    ]);
  });

  it("puts its figures on the recall's line in the access log, in fixed words, and nothing of the query", async () => {
    const s = await setup({ EMBED_QUERY_HEDGE_MS: "50" });
    const log = vi.spyOn(console, "log");
    await s.c.ok("recall", { query: "feline", session_id: s.session });
    await s.c.ok("expand", { ids: [s.cat], session_id: s.session });
    s.workerAI.fail = true;
    await s.c.ok("recall", { query: "部署", session_id: s.session });
    s.workerAI.fail = false;
    s.workerAI.delay = 5000; // both calls slow: the limit ends it
    s.c.env = { ...s.c.env, EMBED_QUERY_TIMEOUT_MS: "200" };
    await s.c.ok("recall", { query: "部署", session_id: s.session });
    const lines = logLines(log);
    const tools = lines.filter((l) => l.msg === "tool");
    expect(tools.map((l) => [l.tool, l.embed_second, l.embed_answer])).toEqual([
      ["recall", "not_needed", "first"],
      ["expand", undefined, undefined],
      ["recall", "after_failure", "none"],
      ["recall", "after_delay", "none"],
    ]);
    for (const l of tools.filter((t) => t.tool === "recall")) {
      expect(typeof l.embed_ms).toBe("number");
      expect(Object.keys(l).sort()).toEqual([
        "dur_ms", "embed_answer", "embed_ms", "embed_second", "memory", "msg", "outcome", "recall_by", "recall_parts", "recall_span", "tool",
      ]);
    }
    expect(tools[3]!.embed_ms as number).toBeGreaterThanOrEqual(150);
    // Two calls for each of the last two recalls.
    expect(s.workerAI.calls.filter((x) => x.form === "queries")).toHaveLength(5);
    expect(lines.filter((l) => l.msg === "query embedding failed")).toEqual([
      { msg: "query embedding failed", reason: "error", error: "Error" },
      { msg: "query embedding failed", reason: "timeout", limit_ms: 200 },
    ]);
    for (const l of lines) for (const w of ["feline", "部署"]) expect(JSON.stringify(l)).not.toContain(w);
  });

  it("names several things: embedded with its parts in one call, and searched part by part", async () => {
    const s = await setup();
    const log = vi.spyOn(console, "log");
    const text = await s.c.ok("recall", { query: " feline、 release ", session_id: s.session });
    expect(text).toContain(s.cat);
    expect(text).toContain(s.deploy);
    expect(s.workerAI.calls.map((x) => [x.form, x.texts, x.instruction])).toEqual([
      ["queries", ["feline、 release", "feline", "release"], queryInstruction],
    ]);
    // The model failing, each part is searched by keyword.
    s.workerAI.fail = true;
    const kw = await s.c.ok("recall", { query: "猫, 部署", session_id: s.session });
    expect([kw.includes(s.cat), kw.includes(s.deploy)]).toEqual([true, true]);
    // Two calls for that one, the second try beside the first.
    expect(s.workerAI.calls.map((x) => x.texts.length)).toEqual([3, 3, 3]);
    const tools = logLines(log).filter((l) => l.msg === "tool");
    expect(tools.map((l) => [l.recall_by, l.recall_parts, l.recall_span, l.embed_answer])).toEqual([
      ["subject", 2, "none", "first"],
      ["subject", 2, "none", "none"],
    ]);
    // A listing by time embeds nothing.
    s.workerAI.fail = false;
    await s.c.ok("recall", { since: "2026-01-01", session_id: s.session });
    expect(s.workerAI.calls).toHaveLength(3);
    for (const l of logLines(log)) for (const w of ["feline", "release", "部署"]) expect(JSON.stringify(l)).not.toContain(w);
  });

  it("is not embedded when search by meaning is off", async () => {
    const s = await setup();
    s.c.env = { ...s.c.env, EMBED_MODEL: "" };
    expect(await s.c.ok("recall", { query: "部署", session_id: s.session })).toContain(s.deploy);
    s.c.env = testEnv(); // no AI binding
    expect(await s.c.ok("recall", { query: "部署", session_id: s.session })).toContain(s.deploy);
    expect(s.workerAI.calls).toEqual([]);
  });

  it("is not embedded when a setting cannot be read, which is logged once", async () => {
    const s = await setup();
    s.c.env = { ...s.c.env, EMBED_MIN_SIMILARITY: "high" };
    const log = vi.spyOn(console, "log");
    for (let i = 0; i < 3; i++) expect(await s.c.ok("recall", { query: "部署", session_id: s.session })).toContain(s.deploy);
    expect(s.workerAI.calls).toEqual([]);
    expect(logLines(log).filter((l) => l.msg === "embedding off")).toEqual([
      { msg: "embedding off", setting: "EMBED_MIN_SIMILARITY", reason: "unreadable" },
    ]);
  });
});

describe("export and import", () => {
  it("carry no vectors: an imported memory embeds itself afresh", async () => {
    const s = await setup();
    const auth = { authorization: `Bearer ${adminSecret}` };
    const exported = await (await fetchWorker(`/admin/memories/${s.m.name}/export`, { headers: auth }, s.c.env)).text();
    // The export is the log: no line of it is a vector.
    expect(exported.trim().split("\n").filter((l) => /"(vecs|vector_rows|ns)"/.test(l))).toEqual([]);
    const copy = `${s.m.name}-copy`;
    const copyAI = new FakeAI();
    const stub = env.MEMORY.getByName(copy);
    await runInDurableObject(stub, (obj: MemoryObject) => {
      obj.embedding = new Embedding(s.settings, new WorkersAI(copyAI.asAi(), s.settings.model));
      obj.alarmNow = () => farFuture;
    });
    const res = await fetchWorker(`/admin/memories/${copy}/import`, { method: "POST", headers: auth, body: exported }, s.c.env);
    expect(res.status).toBe(201);
    expect(await runInDurableObject(stub, (obj: MemoryObject) => obj.store.vectorRuns().fullAsked), "the import asks for a full run").toBe(true);
    expect(await runInDurableObject(stub, (obj: MemoryObject, state) => [
      obj.store.storedVectorNs().length,
      state.storage.sql.exec(`SELECT count(*) AS c FROM vector_rows`).one().c,
    ])).toEqual([0, 0]);
    expect(await runDurableObjectAlarm(stub), "the import set the alarm").toBe(true);
    expect(copyAI.calls.map((x) => [x.form, x.texts.length])).toEqual([["documents", 2]]);
    expect(await runInDurableObject(stub, (obj: MemoryObject) => obj.store.storedVectorNs().length)).toBe(2);
  });
});

describe("the admin API", () => {
  it("shows the vectors a memory holds and how many memories wait", async () => {
    const s = await setup();
    // A third memory, not embedded yet.
    await s.c.ok("remember", { session_id: s.session, gist: "第三件事", body: "正文" });
    const res = await fetchWorker(`/admin/memories/${s.m.name}`, { headers: { authorization: `Bearer ${adminSecret}` } }, s.c.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vectors: unknown };
    expect(body.vectors).toEqual({
      embedding: { model: s.settings.model, dims: s.settings.dims },
      held: [{ model: s.settings.model, dims: s.settings.dims, count: 2 }],
      waiting: 1,
    });
  });
});
