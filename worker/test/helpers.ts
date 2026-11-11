// Shared helpers for the ports of store_test.go and decay_test.go. Every test
// runs on a fresh Durable Object of its own.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import type { Memory as MemoryObject } from "../src/memory-object";
import { defaultParams, type Params } from "../src/store/decay";
import { Store } from "../src/store/store";
import type { Memory, RememberInput } from "../src/store/types";

export const minute = 60 * 1000;
export const hour = 60 * minute;
export const t0 = Date.UTC(2026, 10, 11, 8, 0, 0); // 2026-11-11 08:00 UTC, as in Go

// testParams make forgetting quick to reach: with a strength of 10, an
// ordinary memory fades once 13 newer memories have been written without it
// coming to mind, and is archived after 30.
export function testParams(): Params {
  return { ...defaultParams(), baseStrength: 10 };
}

export type Stub = DurableObjectStub<MemoryObject>;

// freshObject names a Durable Object no other test uses.
export function freshObject(): Stub {
  return env.MEMORY.getByName("test-" + crypto.randomUUID());
}

// inObject runs fn inside the object, with its store and its storage.
export function inObject<R>(stub: Stub, fn: (s: Store, storage: DurableObjectStorage) => R): Promise<R> {
  return runInDurableObject(stub, (m: MemoryObject, state) => fn(m.store, state.storage));
}

// withStore runs fn on the store of a fresh object set to testParams.
export function withStore<R>(fn: (s: Store, storage: DurableObjectStorage) => R): Promise<R> {
  return inObject(freshObject(), (s, storage) => {
    s.setParams(testParams());
    return fn(s, storage);
  });
}

export function session(s: Store, at: number, model: string, client: string): string {
  return s.startSession(at, model, client).session.id;
}

export function remember(s: Store, at: number, sess: string, gist: string, body: string): string {
  const { id, dup } = s.remember(at, { sessionId: sess, moment: "other", source: "lived", importance: 0.5, gist, body });
  expect(dup, "unexpectedly a duplicate").toBe(false);
  return id;
}

// rememberWith fills in what the decay tests leave out.
export function rememberWith(s: Store, input: Partial<RememberInput> & { sessionId: string; gist: string; body: string }): string {
  const { id, dup } = s.remember(t0, {
    ...input,
    moment: input.moment || "other",
    source: input.source || "lived",
    importance: input.importance || 0.5,
  });
  expect(dup).toBe(false);
  return id;
}

let fillers = 0;

// fill writes n memories that match none of the tests' searches. Each one
// advances the experience clock by one.
export function fill(s: Store, sess: string, n: number): void {
  for (let i = 0; i < n; i++) {
    fillers++;
    remember(s, t0, sess, `filler ${fillers}`, "padding");
  }
}

export function get(s: Store, id: string): Memory {
  const ms = s.get([id]);
  expect(ms.length, `get ${id}`).toBe(1);
  return ms[0]!;
}

export function listed(s: Store, ...ids: string[]): void {
  s.logRecalls([{ at: t0, query: "q", ids }]);
}

export function read(s: Store, ...ids: string[]): void {
  s.logRecalls([{ at: t0, read: true, ids }]);
}

// search runs a search at the current clock and returns the ids it found,
// checking that scores are positive and descending.
export function search(s: Store, query: string, deep = false): string[] {
  const hits = s.searchText(query, s.clock(), deep, 10);
  hits.forEach((h, i) => {
    expect(h.score, `search ${query}: hit ${i}`).toBeGreaterThan(0);
    if (i > 0) expect(h.score).toBeLessThanOrEqual(hits[i - 1]!.score);
  });
  const byN = s.byN(hits.map((h) => h.n));
  return hits.map((h) => byN.get(h.n)!.id);
}

export function near(got: number, want: number, tolerance: number): void {
  expect(Math.abs(got - want), `${got} vs ${want}`).toBeLessThanOrEqual(tolerance);
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// dump returns every row of the derived tables, and the derived values in
// meta, as text. The searches stand in for the contentless keyword index.
export function dump(s: Store, storage: DurableObjectStorage): string {
  const lines: string[] = [];
  for (const q of [
    `SELECT * FROM sessions ORDER BY id`,
    `SELECT * FROM carriers ORDER BY model`,
    `SELECT * FROM memories ORDER BY n`,
    `SELECT * FROM links ORDER BY src, dst`,
    `SELECT * FROM policies ORDER BY id`,
    `SELECT * FROM restores ORDER BY at`,
    `SELECT pack, model, dims, count, ns, vecs FROM vector_rows ORDER BY pack`,
    `SELECT key, value FROM meta WHERE key IN ('derived', 'clock') ORDER BY key`,
  ]) {
    for (const row of storage.sql.exec(q)) {
      lines.push(JSON.stringify(Object.values(row).map((v) => (v instanceof ArrayBuffer ? hex(v) : v))));
    }
    lines.push("--");
  }
  for (const q of ["纠正", "proxy", "猫"]) lines.push(`${q}: ${JSON.stringify(search(s, q))}`);
  return lines.join("\n");
}

// populate writes a little of everything: two carriers, plain and rich
// memories, a listing, a reading and a vector.
export function populate(s: Store): void {
  const a = session(s, t0, "model-a", "desktop");
  const b = session(s, t0 + hour, "model-b", "cli");
  const m1 = remember(s, t0, a, "用户纠正了我", "我理解偏了，用户直接指出来并解释了原因。");
  const m2 = remember(s, t0 + hour, b, "Proxy trouble", "The proxy dropped the connection twice.");
  s.remember(t0 + 2 * hour, {
    sessionId: b, moment: "emotion", source: "told", importance: 0.9, intensity: 0.4,
    gist: "用户说他养了一只猫", body: "他说猫叫年糕。", outcome: "聊得很开心", feeling: "轻松",
    lesson: "闲聊也值得认真听", people: ["年糕"], pointer: "https://example.com/repo",
  });
  fill(s, b, 4);
  s.logRecalls([
    { at: t0 + 3 * hour, session: b, query: "纠正", ids: [m1, m2] },
    { at: t0 + 4 * hour, session: b, read: true, ids: [m1] },
  ]);
  s.saveVectors({ model: "embed-x", dims: 3 }, [{ n: get(s, m1).n, vec: unit([0.25, -1.5, 3]) }]);
}

// unit scales v to unit length.
export function unit(v: number[]): number[] {
  const len = Math.hypot(...v);
  return v.map((x) => x / len);
}
