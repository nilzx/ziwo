// Checks at scale: a rebuild after a few thousand generated events through
// the object's methods, and what one call costs in rows at 2,000 memories.
// The generated run amends with every action, erases, corrects and reflects;
// refusals the model could have caused (a target already erased or replaced,
// an entry resting on what no longer stands) are allowed and counted.

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryRequest, ReflectView } from "../src/memory/amend";
import { Embedding, fullEvery } from "../src/memory/embedding";
import type { Memory as MemoryObject } from "../src/memory-object";
import { packSize } from "../src/store/vectors";
import { farFuture, queryVectorOf, TopicEmbedder, topicSettings } from "./embed-helpers";
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
  it("a rebuild after thousands of generated events reproduces the derived tables", async (ctx) => {
    const stub = freshObject();
    const result = await runInDurableObject(stub, (obj: MemoryObject, state) => {
      obj.store.setParams(testParams());
      const r = rng(20261111);
      const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
      let now = t0;
      obj.now = () => now;
      const sessions: string[] = [];
      const written: string[] = [];
      const prefs: string[] = [];
      const people = ["年糕", "阿明", "小红"];
      const phrase = () => `${pick(words)} ${pick(words)}`;
      let invalid = 0;
      const done: Record<string, number> = {};
      const refused: Record<string, number> = {};
      const tally = <T>(what: string, x: T): T => {
        const into = isInvalid(x) ? refused : done;
        into[what] = (into[what] ?? 0) + 1;
        return x;
      };
      for (let step = 0; obj.store.counts().events < 3000; step++) {
        now += Math.floor(r() * 20 * minute);
        const roll = r();
        if (sessions.length === 0 || roll < 0.04) {
          sessions.push(ok(obj.getContext({ model: pick(["model-a", "model-b", ""]), client: pick(["cli", "web"]) })).session.id);
        } else if (roll < 0.45) {
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
            people: r() < 0.3 ? [pick(people)] : undefined,
          });
          if (isInvalid(res)) invalid++;
          else if (!res.dup) written.push(res.id);
        } else if (roll < 0.65) {
          ok(obj.recall({ query: phrase(), deep: r() < 0.2, limit: pick([0, 3, 10]), sessionId: pick([...sessions, "", "s_nope"]) }));
        } else if (roll < 0.75) {
          const n = 1 + Math.floor(r() * 4);
          const ids = Array.from({ length: n }, () => (r() < 0.9 && written.length > 0 ? pick(written) : "m_unknown"));
          ok(obj.expand({ ids, sessionId: pick([...sessions, ""]) }));
        } else if (roll < 0.87 && written.length > 0) {
          const action = pick(["retract", "restore", "pin", "unpin", "reweigh", "correct", "prefer", "unprefer"]);
          const res = tally(action, obj.amend({
            sessionId: pick(sessions), action, id: action === "unprefer" ? pick([...prefs, "p_gone"]) : pick(written),
            importance: pick([0.1, 0.5, 0.9, 1]), text: `规则 ${phrase()}`, reason: r() < 0.5 ? "the user asked" : undefined,
            gist: r() < 0.7 ? `${phrase()} 更正 ${step}` : undefined, body: r() < 0.5 ? phrase() : undefined,
          }));
          if (typeof res === "string") {
            const made = /^(?:preference saved as|corrected:) (\S+?);? /.exec(res);
            if (made !== null) (action === "prefer" ? prefs : written).push(made[1]!);
            if (action === "unprefer") prefs.splice(prefs.indexOf(res.split(" ")[1]!), 1);
          }
        } else if (roll < 0.9 && written.length > 0) {
          tally("erase", obj.erase({ sessionId: pick(sessions), id: pick(written), reason: r() < 0.5 ? "the user asked" : undefined }));
        } else {
          const sess = pick(sessions);
          const view = tally("begin", obj.beginReflect({ sessionId: sess, limit: pick([0, 3, 8]) }));
          if (isInvalid(view) || view.batch === "") continue;
          const frags = view.fragments.map((m) => m.id).sort(() => r() - 0.5);
          const entries: EntryRequest[] = [];
          if (frags.length >= 2 && r() < 0.5) {
            entries.push({ kind: "episode", gist: `${phrase()} 经历`, body: phrase(), from: frags.slice(0, 2 + Math.floor(r() * 2)), milestone: r() < 0.1 });
          }
          if (r() < 0.3) entries.push({ kind: "lesson", gist: `${phrase()} 经验`, body: phrase(), from: [pick(frags), pick(frags)] });
          if (r() < 0.4) entries.push({ kind: "impression", gist: `${phrase()} 印象`, about: pick(people), from: [pick(frags)] });
          if (r() < 0.15 && frags.length >= 3) {
            const ref = r() < 0.5 && view.selves.length > 0 ? pick(view.selves).id : undefined;
            entries.push({ kind: "self", gist: `${phrase()} 自述`, context: "c", from: frags.slice(-3), ref });
          }
          if (r() < 0.15) entries.push({ kind: "reading", gist: `${phrase()} 理解`, ref: pick(written) });
          const pass = frags.filter(() => r() < 0.5);
          if (entries.length === 0 && pass.length === 0) continue;
          let made = tally("finish", obj.finishReflect({ sessionId: sess, batch: view.batch, entries, pass }));
          // Refused over an entry: the round is still open; write back the passes alone.
          if (isInvalid(made) && pass.length > 0) made = tally("finish", obj.finishReflect({ sessionId: sess, batch: view.batch, pass }));
          if (!isInvalid(made)) written.push(...made);
        }
      }
      const kinds = Object.fromEntries(
        state.storage.sql.exec<{ kind: string; c: number }>(`SELECT kind, count(*) AS c FROM events GROUP BY kind`).toArray().map((x) => [x.kind, x.c]),
      );
      const tiers = obj.store.tierCounts(obj.store.clock());
      const before = dump(obj.store, state.storage);
      obj.store.rebuild();
      const after = dump(obj.store, state.storage);
      const written2 = Object.fromEntries(
        state.storage.sql.exec<{ k: string; c: number }>(`SELECT kind || ' ' || state AS k, count(*) AS c FROM memories GROUP BY 1`).toArray().map((x) => [x.k, x.c]),
      );
      const replacing = state.storage.sql.exec<{ c: number }>(`SELECT count(*) AS c FROM events WHERE payload LIKE '%"replaces":%'`).one().c;
      return { same: before === after, kinds, tiers, invalid, done, refused, written: written2, replacing, check: obj.check() };
    });
    ctx.annotate(`events by kind ${JSON.stringify(result.kinds)}; done ${JSON.stringify(result.done)}; refused ${JSON.stringify(result.refused)}; tiers ${JSON.stringify(result.tiers)}`);
    expect(result.same).toBe(true);
    // Every kind of call happened, and every tier was reached.
    expect(result.invalid).toBe(0);
    for (const kind of ["session", "remember", "recall", "expand", "amend", "reflect"]) expect(result.kinds[kind], kind).toBeGreaterThan(100);
    expect(result.kinds.erase).toBeGreaterThan(30);
    // Every kind of memory was written back, and was replaced or erased.
    for (const k of ["episode ", "lesson ", "impression ", "impression superseded", "self ", "reading ", "fragment absorbed",
      "fragment superseded", "fragment erased", "episode erased", "impression erased"]) {
      expect(result.written[k], `memories ${k}: ${JSON.stringify(result.written)}`).toBeGreaterThan(0);
    }
    expect(result.replacing).toBeGreaterThan(0);
    for (const what of ["retract", "restore", "pin", "unpin", "reweigh", "correct", "prefer", "unprefer", "erase", "finish"]) {
      expect(result.done[what], `${what} done: ${JSON.stringify(result)}`).toBeGreaterThan(5);
    }
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
      let view: ReflectView | undefined;
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
        amendPin: measure(() => ok(obj.amend({ sessionId: sess, action: "pin", id: ids[1500]! }))),
        amendCorrect: measure(() => ok(obj.amend({ sessionId: sess, action: "correct", id: ids[1501]!, gist: "w5x corrected" }))),
        erase: measure(() => ok(obj.erase({ sessionId: sess, id: ids[1502]! }))),
        beginReflect: measure(() => (view = ok(obj.beginReflect({ sessionId: sess })))),
        finishReflect: measure(() => {
          const f = view!.fragments.map((m) => m.id);
          expect(ok(obj.finishReflect({
            sessionId: sess, batch: view!.batch, pass: f.slice(6),
            entries: [
              { kind: "episode", gist: "w6x episode", body: "b", from: f.slice(0, 3) },
              { kind: "impression", gist: "w7x impression", about: "someone", from: [f[3]!] },
              { kind: "lesson", gist: "w8x lesson", body: "b", from: f.slice(4, 6) },
            ],
          }))).toHaveLength(3);
        }),
        check: measure(() => obj.check()),
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
    // The check walks the log and the tables a fixed number of times; it
    // must never read the log once per memory.
    expect(figures.check.rowsRead).toBeLessThan(40 * 2001);
    // Amending reads and writes the memory it is about, and little else.
    expect(figures.amendPin.rowsRead).toBeLessThan(40);
    expect(figures.amendCorrect.rowsRead).toBeLessThan(60);
    // Starting a round counts the fragments that wait, from their index, as a
    // new session does.
    expect(figures.beginReflect.rowsRead).toBeLessThan(2001 + 200);
    expect(figures.finishReflect.rowsRead).toBeLessThan(200);
  }, 120_000);

  // At 2,000 memories with vectors of 512 dimensions: what a write, the
  // alarm for a batch, and a recall cost in rows. The first recall after the
  // object wakes loads the vectors, one row per 256; the next reads none for
  // them.
  it("search by meaning at 2,000 memories loads one row per 256 vectors, once", async (ctx) => {
    const stub = freshObject();
    const emb = new TopicEmbedder();
    const settings = { ...topicSettings, dims: 512 };
    const label = { model: settings.model, dims: settings.dims };
    const embedded = (obj: MemoryObject) => {
      obj.embedding = new Embedding(settings, emb);
      obj.alarmNow = () => farFuture;
    };
    const first = await runInDurableObject(stub, async (obj: MemoryObject) => {
      embedded(obj);
      let now = t0;
      obj.now = () => now;
      const sess = ok(obj.getContext({ model: "model-a", client: "cli" })).session.id;
      const write = (i: number) => {
        now += minute;
        // Core memories: none is archived, so every one keeps a vector.
        ok(obj.remember({ sessionId: sess, gist: `cat ${i}`, body: `padding ${i}`, importance: 0.95 }));
      };
      for (let i = 0; i < 2000; i++) write(i);
      while ((await obj.embedOnce()).more);
      obj.usage(true);
      write(2000);
      const oneWrite = obj.usage(true);
      for (let i = 2001; i < 2032; i++) write(i);
      obj.usage(true);
      const run = await obj.embedOnce();
      const batch = obj.usage(true);
      expect([run.embedded, run.more]).toEqual([32, false]);
      return { sess, now, oneWrite, batch, vectors: obj.store.vectorCount(label) };
    });
    expect(first.vectors).toBe(2032);
    await evictDurableObject(stub);
    const second = await runInDurableObject(stub, (obj: MemoryObject) => {
      embedded(obj);
      obj.now = () => first.now;
      obj.store.clock(); // opens the store, which reads a few rows of its own
      const meaning = queryVectorOf("feline", settings);
      const recall = () => ok(obj.recall({ query: "feline", sessionId: first.sess, meaning })).length;
      obj.usage(true);
      const found = [recall()];
      const cold = obj.usage(true);
      found.push(recall());
      const warm = obj.usage(true);
      return { found, cold, warm };
    });
    const rows = Math.ceil(first.vectors / packSize);
    ctx.annotate(`vectors ${first.vectors}, rows ${rows}: ${JSON.stringify({ write: first.oneWrite, batch: first.batch, ...second })}`);
    expect(second.found).toEqual([5, 5]);
    expect(rows).toBe(8);
    // The same recall twice: the first read the vectors' rows, the second none.
    expect(second.cold.rowsRead - second.warm.rowsRead).toBe(rows);
    expect(second.cold.rowsWritten).toBe(second.warm.rowsWritten);
    // A write reads and writes as before: no model, no vector.
    expect(first.oneWrite.rowsRead).toBeLessThan(40);
    expect(first.oneWrite.rowsWritten).toBeLessThan(20);
  }, 120_000);

  // The alarm after an ordinary write reads the memories written since its
  // last run, not the whole memory; a full run, asked for or hourly, still
  // finds what came back and drops what left.
  it("the alarm after one write at 2,000 memories reads few rows; full runs find what came back", async (ctx) => {
    const stub = freshObject();
    const emb = new TopicEmbedder();
    const settings = { ...topicSettings, dims: 512 };
    const figures = await runInDurableObject(stub, async (obj: MemoryObject) => {
      obj.embedding = new Embedding(settings, emb);
      obj.alarmNow = () => farFuture;
      obj.store.setParams(testParams()); // archived after 30 newer memories
      let now = t0;
      obj.now = () => now;
      const sess = ok(obj.getContext({ model: "model-a", client: "cli" })).session.id;
      const write = (gist: string, importance: number) => {
        now += minute;
        return ok(obj.remember({ sessionId: sess, gist, body: "padding", importance })).id;
      };
      for (let i = 0; i < 1997; i++) write(`cat ${i}`, 0.95);
      const restored = write("kitten one", 0.5);
      const back = write("kitten two", 0.5);
      const gone = write("kitten three", 0.5);
      while ((await obj.embedOnce()).more);
      const has = (id: string) => obj.store.storedVectorNs().includes(obj.store.get([id])[0]!.n);
      expect([has(restored), has(back), has(gone)]).toEqual([true, true, true]);

      // One more write, and the alarm after it.
      const more = write("one more", 0.95);
      obj.usage(true);
      await obj.alarm();
      const ordinary = obj.usage(true);
      expect(has(more)).toBe(true);

      // A memory set aside loses its vector at the next run, which is full;
      // restored, it is found by the next full run and embedded again.
      ok(obj.amend({ sessionId: sess, action: "retract", id: restored }));
      expect((await obj.embedOnce()).full).toBe(true);
      expect(has(restored)).toBe(false);
      ok(obj.amend({ sessionId: sess, action: "restore", id: restored }));
      obj.usage(true);
      const found = await obj.embedOnce();
      const full = obj.usage(true);
      expect([found.full, found.embedded, has(restored)]).toEqual([true, 1, true]);

      // Archived by newer writes: ordinary runs leave their vectors alone.
      for (let i = 0; i < 35; i++) write(`dog ${i}`, 0.95);
      while ((await obj.embedOnce()).more);
      const tier = (id: string) => obj.store.get([id])[0]!;
      expect([back, gone, restored].map((id) => tier(id).archiveAt <= obj.store.clock())).toEqual([true, true, true]);
      expect([has(back), has(gone), has(restored)]).toEqual([true, true, true]);
      // An hour on, the next run is full and drops them.
      now += fullEvery;
      const hourly = await obj.embedOnce();
      expect([hourly.full, hourly.dropped]).toEqual([true, 3]);
      expect([has(back), has(gone), has(restored)]).toEqual([false, false, false]);
      // Read in full, one comes back from the archive; the next run is full
      // and embeds it again, and only it.
      ok(obj.expand({ ids: [back], sessionId: sess }));
      const again = await obj.embedOnce();
      expect([again.full, again.embedded, has(back), has(gone)]).toEqual([true, 1, true, false]);
      // Nothing asked, within the hour: ordinary again.
      write("last", 0.95);
      expect((await obj.embedOnce()).full).toBe(false);
      return { ordinary, full, vectors: obj.store.vectorCount(settings) };
    });
    ctx.annotate(`alarm at ${figures.vectors} vectors: ${JSON.stringify(figures)}`);
    expect(figures.ordinary.rowsRead).toBeLessThan(100);
    expect(figures.ordinary.rowsWritten).toBeLessThan(10);
  }, 120_000);
});
