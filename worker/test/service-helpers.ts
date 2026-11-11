// Helpers for the ports of service_test.go and forgetting_test.go: the Go
// fixture, run inside a fresh Memory object, and a stand-in for matches by
// meaning.

import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import { clip } from "../src/memory/clean";
import type { ContextView, MeaningHit, Result } from "../src/memory/service";
import type { Invalid, Memory as MemoryObject, RememberArgs } from "../src/memory-object";
import { type Tier, type TierCounts, tierOf } from "../src/store/decay";
import type { Store } from "../src/store/store";
import type { Memory } from "../src/store/types";
import { freshObject, minute, type Stub, t0, testParams } from "./helpers";

export function isInvalid(x: unknown): x is Invalid {
  return typeof x === "object" && x !== null && !Array.isArray(x) && "invalid" in x;
}

// ok fails the test when a method of the object refused its input.
export function ok<T>(x: T | Invalid, what = "call"): T {
  if (isInvalid(x)) expect.fail(`${what}: invalid: ${x.invalid}`);
  return x as T;
}

// Fixture is Go's fixture: one memory with forgetting set to testParams and
// a wall clock moved by hand.
export class Fixture {
  clock = t0;
  session = ""; // the conversation the fixture writes in; started on first use
  private fillers = 0;

  constructor(
    readonly obj: MemoryObject,
    readonly storage: DurableObjectStorage,
  ) {
    obj.now = () => this.clock;
  }

  get st(): Store {
    return this.obj.store;
  }

  advance(ms: number): void {
    this.clock += ms;
  }

  begin(model: string, client: string): ContextView {
    return ok(this.obj.getContext({ model, client }), "get context");
  }

  sess(): string {
    if (this.session === "") this.session = this.begin("model-a", "test").session.id;
    return this.session;
  }

  rememberWith(args: RememberArgs): string {
    if (args.sessionId === undefined || args.sessionId === "") args = { ...args, sessionId: this.sess() };
    const r = ok(this.obj.remember(args), "remember");
    expect(r.dup, "unexpectedly a duplicate").toBe(false);
    this.advance(minute);
    return r.id;
  }

  remember(gist: string, body: string): string {
    return this.rememberWith({ gist, body });
  }

  // fill lives through n more ordinary moments. Their text shares nothing
  // with what the tests search for.
  fill(n: number): void {
    for (let i = 0; i < n; i++) {
      this.fillers++;
      this.remember(`filler ${this.fillers}`, "padding");
    }
  }

  recall(query: string, byMeaning?: MeaningHit[]): Result[] {
    if (byMeaning === undefined) return ok(this.obj.recall({ query, sessionId: this.sess() }), `recall ${query}`);
    return this.obj.service.recall(query, 0, false, this.sess(), byMeaning);
  }

  deepRecall(query: string, byMeaning?: MeaningHit[]): Result[] {
    if (byMeaning === undefined) return ok(this.obj.recall({ query, deep: true, sessionId: this.sess() }), `deep recall ${query}`);
    return this.obj.service.recall(query, 0, true, this.sess(), byMeaning);
  }

  expand(id: string): Result {
    const rs = ok(this.obj.expand({ ids: [id], sessionId: this.sess() }), `expand ${id}`);
    expect(rs.length, `expand ${id}`).toBe(1);
    return rs[0]!;
  }

  // get reads a memory without it counting as coming to mind.
  get(id: string): Memory {
    const ms = this.st.get([id]);
    expect(ms.length, `get ${id}`).toBe(1);
    return ms[0]!;
  }

  // lived is the experience clock: how many moments have been lived through.
  lived(): number {
    return this.st.clock();
  }

  tier(id: string): Tier {
    return tierOf(this.get(id), this.lived());
  }

  counts(): TierCounts {
    return this.st.tierCounts(this.lived());
  }
}

// start runs fn on a fresh memory, as Go's start(t, tempDB(t), nil) does.
export function start<R>(fn: (f: Fixture) => R, stub: Stub = freshObject()): Promise<R> {
  return runInDurableObject(stub, (obj: MemoryObject, state) => {
    obj.store.setParams(testParams());
    return fn(new Fixture(obj, state.storage));
  });
}

export function ids(rs: Result[]): string[] {
  return rs.map((r) => r.id);
}

export function tiers(rs: Result[]): Record<string, Tier> {
  return Object.fromEntries(rs.map((r) => [r.id, r.tier]));
}

// distinct returns n different short strings.
export function distinct(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `x${i}`);
}

// A stand-in for an embedding model and its index, as Go's topicEmbedder and
// vector.Index: each text is placed on the axes of the topics it mentions,
// plus a small component on an axis of its own, so texts about the same topic
// are close even when they share no words.
const topics = [
  ["猫", "cat", "feline", "kitten"],
  ["部署", "上线", "deploy", "release"],
  ["纠正", "误解", "corrected", "misunderstood"],
];
const ownAxes = 1024;
const minSimilarity = 0.35; // Go's default

function fnv32a(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

// embed returns a sparse vector: axis to value.
function embed(text: string): Map<number, number> {
  const v = new Map<number, number>();
  v.set(topics.length + (fnv32a(text) % ownAxes), 0.05);
  const lower = text.toLowerCase();
  topics.forEach((words, axis) => {
    if (words.some((w) => lower.includes(w))) v.set(axis, 1);
  });
  return v;
}

function cosine(a: Map<number, number>, b: Map<number, number>): number {
  let dot = 0;
  for (const [k, x] of a) dot += x * (b.get(k) ?? 0);
  const norm = (v: Map<number, number>) => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));
  return dot / (norm(a) * norm(b));
}

// byMeaning searches the given memories, standing in for the vector index,
// for the 20 closest to the query above the threshold: what Go's Recall gets
// from the index with the default limit.
export function byMeaning(query: string, indexed: Memory[], k = 20): MeaningHit[] {
  const q = embed(query);
  return indexed
    .map((m) => ({ n: m.n, score: cosine(q, embed(clip(m.gist + "\n" + m.body, 1500))) }))
    .filter((h) => h.score >= minSimilarity)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
