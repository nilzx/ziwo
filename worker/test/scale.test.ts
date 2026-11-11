// Checks at scale: a rebuild after a few thousand generated events through
// the object's methods, and what one call costs in rows at 2,000 memories.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Memory as MemoryObject } from "../src/memory-object";
import { dump, freshObject, minute, t0, testParams } from "./helpers";
import { isInvalid, ok } from "./service-helpers";

// mulberry32: a small seeded generator, so that a failure can be replayed.
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const words = ["猫", "部署", "纠正", "proxy", "天气", "项目", "alpha", "beta", "gamma", "delta", "年糕", "上线", "误解", "release", "kitten", "记忆"];

describe("scale", () => {
  it("a rebuild after thousands of generated events reproduces the derived tables", async () => {
    const stub = freshObject();
    const result = await runInDurableObject(stub, (obj: MemoryObject, state) => {
      obj.store.setParams(testParams());
      const r = rng(20261111);
      const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
      let now = t0;
      obj.now = () => now;
      const sessions: string[] = [];
      const written: string[] = [];
      const phrase = () => `${pick(words)} ${pick(words)}`;
      let invalid = 0;
      for (let step = 0; obj.store.counts().events < 3000; step++) {
        now += Math.floor(r() * 20 * minute);
        const roll = r();
        if (sessions.length === 0 || roll < 0.04) {
          sessions.push(ok(obj.getContext({ model: pick(["model-a", "model-b", ""]), client: pick(["cli", "web"]) })).session.id);
        } else if (roll < 0.55) {
          const source = pick(["lived", "lived", "told", "inferred", "reconstructed"]);
          const felt = r() < 0.2;
          const res = obj.remember({
            sessionId: pick(sessions),
            // Some repeat an earlier write, as a retried call would.
            gist: r() < 0.05 && written.length > 0 ? "重复的一件事" : `${phrase()} ${step}`,
            body: r() < 0.05 ? "重复的正文" : `${phrase()} ${phrase()}`,
            source,
            happenedAt: source === "reconstructed" ? new Date(now - Math.floor(r() * 1e9)).toISOString() : undefined,
            importance: pick([0, 0.2, 0.5, 0.7, 0.85, 0.95]),
            feeling: felt ? "某种感觉" : undefined,
            intensity: felt ? pick([0.3, 0.6, 0.95]) : undefined,
            people: r() < 0.1 ? ["年糕"] : undefined,
          });
          if (isInvalid(res)) invalid++;
          else if (!res.dup) written.push(res.id);
        } else if (roll < 0.85) {
          ok(obj.recall({ query: phrase(), deep: r() < 0.2, limit: pick([0, 3, 10]), sessionId: pick([...sessions, "", "s_nope"]) }));
        } else {
          const n = 1 + Math.floor(r() * 4);
          const ids = Array.from({ length: n }, () => (r() < 0.9 && written.length > 0 ? pick(written) : "m_unknown"));
          ok(obj.expand({ ids, sessionId: pick([...sessions, ""]) }));
        }
      }
      const kinds = Object.fromEntries(
        state.storage.sql.exec<{ kind: string; c: number }>(`SELECT kind, count(*) AS c FROM events GROUP BY kind`).toArray().map((x) => [x.kind, x.c]),
      );
      const tiers = obj.store.tierCounts(obj.store.clock());
      const before = dump(obj.store, state.storage);
      obj.store.rebuild();
      const after = dump(obj.store, state.storage);
      return { same: before === after, kinds, tiers, invalid, check: obj.check() };
    });
    expect(result.same).toBe(true);
    // Every kind of call happened, and every tier was reached.
    expect(result.invalid).toBe(0);
    for (const kind of ["session", "remember", "recall", "expand"]) expect(result.kinds[kind], kind).toBeGreaterThan(100);
    expect(Math.min(result.tiers.core, result.tiers.active, result.tiers.faded, result.tiers.archived)).toBeGreaterThan(0);
    expect(result.check.findings.filter((f) => f.level === "problem")).toEqual([]);
  }, 120_000);

  it("one call at 2,000 memories reads and writes few rows", async (ctx) => {
    const stub = freshObject();
    const figures = await runInDurableObject(stub, (obj: MemoryObject) => {
      const r = rng(7);
      const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
      let now = t0;
      obj.now = () => now;
      const sess = ok(obj.getContext({ model: "model-a", client: "cli" })).session.id;
      // Forty words: each memory has three of them in its gist and body, so
      // a word matches about one memory in seven.
      const vocab = Array.from({ length: 40 }, (_, i) => `w${i}x`);
      const ids: string[] = [];
      for (let i = 0; i < 2000; i++) {
        now += minute;
        ids.push(ok(obj.remember({
          sessionId: sess, gist: `${pick(vocab)} ${pick(vocab)} ${i}`, body: `${pick(vocab)} padding`,
          importance: pick([0.3, 0.5, 0.5, 0.7, 0.95]),
        })).id);
      }
      const measure = (fn: () => unknown) => {
        obj.usage(true);
        fn();
        return obj.usage(true);
      };
      return {
        remember: measure(() => ok(obj.remember({ sessionId: sess, gist: "w1x w2x one more", body: "padding" }))),
        getContext: measure(() => ok(obj.getContext({ model: "model-a", client: "cli" }))),
        recall: measure(() => expect(ok(obj.recall({ query: "w3x", sessionId: sess })).length).toBeGreaterThan(0)),
        recallDeep: measure(() => expect(ok(obj.recall({ query: "w3x", deep: true, sessionId: sess })).length).toBeGreaterThan(0)),
        expand: measure(() => expect(ok(obj.expand({ ids: [ids[1990]!], sessionId: sess }))).toHaveLength(1)),
        expandArchived: measure(() => expect(ok(obj.expand({ ids: [ids[10]!], sessionId: sess }))).toHaveLength(1)),
        tiers: obj.store.tierCounts(obj.store.clock()),
      };
    });
    const line = JSON.stringify(figures);
    ctx.annotate(`rows at 2,000 memories: ${line}`);
    expect(figures.remember.rowsRead).toBeLessThan(40);
    expect(figures.remember.rowsWritten).toBeLessThan(20);
    // A new session counts the tiers and the fragments that wait, each from
    // an index of its own: one entry per standing memory and one per waiting
    // fragment (here every memory is both), and little else.
    expect(figures.getContext.rowsRead).toBeLessThan(2 * 2001 + 200);
    // A search reads its matches and looks each one up, not the whole table.
    expect(figures.recall.rowsRead).toBeLessThan(1000);
    expect(figures.expand.rowsRead).toBeLessThan(40);
  }, 120_000);
});
