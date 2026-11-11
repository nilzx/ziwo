// Embedding in the background: the alarm, its retries, memories the model
// refuses, the feature switched off, and how memories leave and come back to
// search by meaning. Memories hold made-up text; the tests look at ids and
// figures alone.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { embedSettings, prepare, WorkersAI } from "../src/embed";
import { KindEpisode, StateSuperseded } from "../src/store/content";
import { defaultParams } from "../src/store/decay";
import { embedBatchSize, Embedding, firstRetry, fullEvery, lastRetry, textOf } from "../src/memory/embedding";
import type { Memory as MemoryObject } from "../src/memory-object";
import { FakeAI, farFuture, queryVectorOf, TopicEmbedder, topicSettings } from "./embed-helpers";
import { freshObject, type Stub, unit } from "./helpers";
import { type Fixture, ids, ok, start, startEmbedded } from "./service-helpers";

function inObj<R>(stub: Stub, fn: (obj: MemoryObject, storage: DurableObjectStorage) => R | Promise<R>): Promise<R> {
  return runInDurableObject(stub, (obj: MemoryObject, state) => fn(obj, state.storage));
}

function amend(f: Fixture, action: string, id: string): void {
  ok(f.obj.amend({ sessionId: f.sess(), action, id }), `amend ${action}`);
}

// stored reports the row numbers of the stored vectors.
function stored(f: Fixture): number[] {
  return f.st.storedVectorNs().sort((a, b) => a - b);
}

describe("the alarm", () => {
  it("embeds a batch, and sets itself again while more wait", async () => {
    const stub = freshObject();
    const emb = new TopicEmbedder();
    const written = await startEmbedded((f) => {
      f.obj.store.setParams(defaultParams()); // nothing is archived among 40
      const out: string[] = [];
      for (let i = 0; i < 40; i++) out.push(f.remember(`cat ${i}`, "a body"));
      return out;
    }, emb, stub);
    // The writes set the alarm and called no model.
    expect(emb.documentCalls).toBe(0);
    expect(await inObj(stub, (_o, s) => s.getAlarm())).toBe(farFuture);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect([emb.documentCalls, emb.documentTexts]).toEqual([1, embedBatchSize]);
    // Oldest first.
    await inObj(stub, (obj) => {
      const want = obj.store.get(written.slice(0, embedBatchSize)).map((m) => m.n);
      expect(obj.store.storedVectorNs().sort((a, b) => a - b)).toEqual(want);
    });
    expect(await inObj(stub, (_o, s) => s.getAlarm()), "more wait: the alarm is set again").toBe(farFuture);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect([emb.documentCalls, emb.documentTexts]).toEqual([2, 40]);
    expect(await inObj(stub, (_o, s) => s.getAlarm()), "nothing waits: no alarm").toBe(null);
    expect(await runDurableObjectAlarm(stub)).toBe(false);

    // What was sent for a memory: its gist and body, as Go cuts them.
    await inObj(stub, (obj) => {
      const ms = obj.store.get(written);
      expect(ms.map(textOf)).toEqual(ms.map((m) => `${m.gist}\n${m.body}`));
      obj.create("0".repeat(64)); // describe answers for a memory with a token
      expect(obj.describe()).toMatchObject({
        vectors: { embedding: { model: topicSettings.model, dims: topicSettings.dims }, held: [{ model: "topic-test", dims: topicSettings.dims, count: 40 }], waiting: 0 },
      });
    });
    // The text is cut at 1,500 characters.
    expect([...textOf({ gist: "猫".repeat(1000), body: "x".repeat(1000) })]).toHaveLength(1500);
  });

  it("tries a failing model again with a growing delay; the write was answered at once", async () => {
    const stub = freshObject();
    const emb = new TopicEmbedder();
    emb.down = true;
    const id = await startEmbedded((f) => f.remember("用户给我看了他的猫", "一只橘猫。"), emb, stub);
    expect(id).toMatch(/^m_/);
    expect(emb.documentCalls, "the write waited for the model").toBe(0);

    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      delays.push((await inObj(stub, (_o, s) => s.getAlarm()))! - farFuture);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect([firstRetry, lastRetry]).toEqual([1000, 60000]);
    expect(emb.documentCalls).toBe(9); // a batch of one is not tried again alone

    // A write while a retry waits does not cut the delay short.
    await runInDurableObject(stub, (obj: MemoryObject) => {
      ok(obj.remember({ sessionId: obj.store.activeSessions(0, "", 1)[0]!.id, gist: "第二件事", body: "正文" }));
    });
    expect((await inObj(stub, (_o, s) => s.getAlarm()))! - farFuture).toBe(60000);

    emb.down = false;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await inObj(stub, (obj) => obj.store.storedVectorNs().length)).toBe(2);
    expect(await inObj(stub, (_o, s) => s.getAlarm())).toBe(null);

    // After a success the delay starts over.
    emb.down = true;
    await runInDurableObject(stub, (obj: MemoryObject) => {
      ok(obj.remember({ sessionId: obj.store.activeSessions(0, "", 1)[0]!.id, gist: "第三件事", body: "正文" }));
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await inObj(stub, (_o, s) => s.getAlarm()))! - farFuture).toBe(1000);
  });

  it("sets aside a memory the model refuses, and embeds the others", () => {
    const emb = new TopicEmbedder();
    emb.refuse = "毒丸";
    return startEmbedded(async (f) => {
      const a = f.remember("用户给我看了他的猫", "一只橘猫。");
      const poison = f.remember("毒丸", "这一条不被接受。");
      const b = f.remember("第一次部署", "上线了。");
      const r = await f.obj.embedOnce();
      expect([r.embedded, r.refused, r.failed, r.more]).toEqual([2, 1, false, false]);
      // The batch, then each text alone.
      expect(emb.documentCalls).toBe(4);
      const n = (id: string) => f.get(id).n;
      expect(stored(f)).toEqual([n(a), n(b)]);
      // Set aside, it is not tried again by this instance, and still waits.
      expect((await f.obj.embedOnce()).embedded).toBe(0);
      expect(emb.documentCalls).toBe(4);
      expect(f.st.vectorFigures(topicSettings).waiting).toBe(1);
      expect(ids(f.recall("毒丸"))).toEqual([poison]);
    }, emb);
  });

  it("a model that fails for every text alone is down, not refusing", () => {
    const emb = new TopicEmbedder();
    return startEmbedded(async (f) => {
      f.remember("用户给我看了他的猫", "一只橘猫。");
      f.remember("第一次部署", "上线了。");
      emb.down = true;
      const r = await f.obj.embedOnce();
      expect([r.failed, r.refused, r.embedded, emb.documentCalls]).toEqual([true, 0, 0, 3]);
      emb.down = false;
      expect((await f.obj.embedOnce()).embedded, "nothing was set aside").toBe(2);
    }, emb);
  });

  it("stores no vector for a memory that left while its vector was being made", () => {
    // The model answers only when the test lets it.
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const emb = new TopicEmbedder();
    const documents = emb.documents.bind(emb);
    emb.documents = async (texts) => {
      await gate;
      return documents(texts);
    };
    return startEmbedded(async (f) => {
      const a = f.remember("用户给我看了他的猫", "一只橘猫。");
      const b = f.remember("The kitten knocked over my notes", "Nothing else happened.");
      const c = f.remember("第一次部署", "上线了。");
      const run = f.obj.embedOnce();
      ok(f.obj.erase({ sessionId: f.sess(), id: a, reason: "asked" }));
      amend(f, "retract", b);
      release();
      expect((await run).embedded).toBe(1);
      expect(stored(f)).toEqual([f.get(c).n]);
    }, emb);
  });

  it("a write that fails after changing the loaded vectors leaves them as stored", () =>
    startEmbedded((f) => {
      const a = f.get(f.remember("用户给我看了他的猫", "一只橘猫。")).n;
      const b = f.get(f.remember("第一次部署", "上线了。")).n;
      const label = { model: "m", dims: 2 };
      expect(() => f.st.saveVectors(label, [{ n: a, vec: [0.6, 0.8] }, { n: b, vec: [1] }])).toThrow();
      expect(f.st.vectorCount(label)).toBe(0);
      expect(f.st.searchVectors(label, Float32Array.from([0.6, 0.8]), 5, 0)).toEqual([]);
    }));

  it("is set by the calls that leave or come back to search by meaning", () =>
    startEmbedded(async (f) => {
      const cat = f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。");
      const kitten = f.remember("The kitten knocked over my notes", "Nothing else happened.");
      await f.sync();
      // Each check starts with no alarm set and none known to the object.
      const fresh = async () => {
        await f.obj.alarm();
        await f.storage.deleteAlarm();
        expect(await f.storage.getAlarm()).toBe(null);
      };
      // full: whether the call asks the next run to be a full one.
      const sets = async (what: string, full: boolean, fn: () => unknown) => {
        await fresh();
        expect(f.st.vectorRuns().fullAsked).toBe(false);
        fn();
        expect(await f.storage.getAlarm(), what).toBe(farFuture);
        expect(f.st.vectorRuns().fullAsked, `${what} asks for a full run`).toBe(full);
      };
      await sets("retract", true, () => amend(f, "retract", cat));
      await sets("restore", true, () => amend(f, "restore", cat));
      await sets("pin", true, () => amend(f, "pin", cat));
      await sets("unpin", true, () => amend(f, "unpin", cat));
      await sets("reweigh", true, () => ok(f.obj.amend({ sessionId: f.sess(), action: "reweigh", id: cat, importance: 0.6 })));
      await sets("remember", false, () => f.remember("第一次部署", "上线了。"));
      await sets("reflect", true, () => {
        const view = ok(f.obj.beginReflect({ sessionId: f.sess() }));
        ok(f.obj.finishReflect({ sessionId: f.sess(), batch: view.batch, pass: view.fragments.map((m) => m.id) }));
      });
      // A preference is not a memory: no full run, and no alarm.
      await fresh();
      ok(f.obj.amend({ sessionId: f.sess(), action: "prefer", text: "rule" }));
      expect([await f.storage.getAlarm(), f.st.vectorRuns().fullAsked]).toEqual([null, false]);
      await f.sync();
      f.fill(35);
      expect(f.tier(kitten)).toBe("archived");
      await f.sync();
      await sets("deep recall out of the archive", true, () => expect(ids(f.deepRecall("kitten"))).toEqual([kitten]));
      // An ordinary recall of what is not archived sets nothing.
      await fresh();
      f.recall("年糕");
      expect(await f.storage.getAlarm()).toBe(null);
      // The owner's calls: settings that change the parameters, a rebuild.
      f.obj.create("0".repeat(64));
      await sets("settings", true, () => f.obj.changeSettings({ params: { ...f.st.params(), baseStrength: 12 } }));
      await sets("rebuild", true, () => f.obj.rebuildAll());
    }));

  it("runs full when asked, when the label changed, when no mark is kept, and hourly", () =>
    startEmbedded(async (f) => {
      const run = async () => (await f.obj.embedOnce()).full;
      f.remember("用户给我看了他的猫", "一只橘猫。");
      expect(await run(), "no run kept a mark yet").toBe(true);
      f.remember("第一次部署", "上线了。");
      expect(await run()).toBe(false);
      // Hourly by the wall clock: not at 59 minutes, at 60.
      expect(fullEvery).toBe(60 * 60 * 1000);
      const at = f.st.vectorRuns().fullAt!;
      f.clock = at + 59 * 60 * 1000;
      expect(await run()).toBe(false);
      f.clock = at + 60 * 60 * 1000;
      expect(await run()).toBe(true);
      // A mark lost from meta makes the next run full.
      f.storage.sql.exec(`DELETE FROM meta WHERE key = 'vectors_seen'`);
      expect(await run()).toBe(true);
      expect(await run()).toBe(false);
      // Another label: the first run is full, and drops the old vectors.
      const before = f.st.vectorFigures().held;
      expect(before.map((h) => h.dims)).toEqual([topicSettings.dims]);
      f.obj.embedding = new Embedding({ ...topicSettings, dims: 64 }, f.emb!);
      const r = await f.obj.embedOnce();
      expect([r.full, r.embedded]).toEqual([true, 2]);
      expect(f.st.vectorFigures().held).toEqual([{ model: topicSettings.model, dims: 64, count: 2 }]);
      expect(await run()).toBe(false);
    }));

  it("an ordinary run reads past many memories with vectors, and keeps its mark", () =>
    startEmbedded(async (f) => {
      f.obj.store.setParams(defaultParams());
      for (let i = 0; i < 300; i++) f.remember(`cat ${i}`, "a body");
      await f.sync();
      const last = f.get(f.remember("第一次部署", "上线了。")).n;
      // The mark set back, as a full run sets it before an old memory that
      // waits: the run reads more than one chunk to find the new one.
      f.st.setVectorsSeen(0);
      const r = await f.obj.embedOnce();
      expect([r.full, r.embedded]).toEqual([false, 1]);
      expect(f.st.vectorRuns().seen).toBe(last);
      // Nothing waits: the mark still moves to the newest memory.
      f.st.setVectorsSeen(0);
      expect((await f.obj.embedOnce()).embedded).toBe(0);
      expect(f.st.vectorRuns().seen).toBe(last);
    }));

  it("does nothing when search by meaning is off", async () => {
    // The test runtime has no AI binding: the object is off.
    const stub = freshObject();
    await start(async (f) => {
      f.remember("用户给我看了他的猫", "一只橘猫。");
      expect(await f.storage.getAlarm()).toBe(null);
      const r = await f.obj.embedOnce();
      expect([r.embedded, r.dropped, r.more]).toEqual([0, 0, false]);
      f.obj.create("0".repeat(64));
      expect(f.obj.describe()).toMatchObject({ vectors: { embedding: null, held: [], waiting: null } });
    }, stub);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    await inObj(stub, async (obj, storage) => {
      await obj.alarm(); // run anyway: nothing happens
      expect(obj.store.storedVectorNs()).toEqual([]);
      expect(storage.sql.exec(`SELECT count(*) AS c FROM vector_rows`).one().c).toBe(0);
    });

    const ai = new FakeAI().asAi();
    expect(embedSettings({})).toBeUndefined();
    expect(embedSettings({ AI: ai, EMBED_MODEL: "" })).toBeUndefined();
    expect(embedSettings({ AI: ai, EMBED_MODEL: "  " })).toBeUndefined();
    expect(embedSettings({ AI: ai })).toEqual({
      model: "@cf/qwen/qwen3-embedding-0.6b", dims: 512, minSimilarity: 0.45, queryTimeoutMs: 6000, queryHedgeMs: 1000,
    });
    expect(embedSettings({
      AI: ai, EMBED_MODEL: "@cf/baai/bge-m3", EMBED_DIMS: "1024", EMBED_MIN_SIMILARITY: "0.6", EMBED_QUERY_TIMEOUT_MS: "500", EMBED_QUERY_HEDGE_MS: "0",
    })).toEqual({ model: "@cf/baai/bge-m3", dims: 1024, minSimilarity: 0.6, queryTimeoutMs: 500, queryHedgeMs: 0 });
    for (const bad of [{ EMBED_DIMS: "0" }, { EMBED_DIMS: "4097" }, { EMBED_DIMS: "12.5" }, { EMBED_MIN_SIMILARITY: "2" }, { EMBED_QUERY_TIMEOUT_MS: "x" },
      { EMBED_QUERY_HEDGE_MS: "-1" }, { EMBED_QUERY_HEDGE_MS: "1.5" }, { EMBED_QUERY_HEDGE_MS: "60001" }, { EMBED_QUERY_HEDGE_MS: "soon" }]) {
      expect(embedSettings({ AI: ai, ...bad }), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("drops the vectors of another model or size when it next embeds", () =>
    startEmbedded(async (f) => {
      const a = f.remember("用户给我看了他的猫", "一只橘猫。");
      f.st.saveVectors({ model: "old-model", dims: 3 }, [{ n: f.get(a).n, vec: unit([1, 0, 0]) }]);
      f.st.saveVectors({ model: topicSettings.model, dims: 8 }, [{ n: f.get(a).n, vec: unit([1, 0, 0, 0, 0, 0, 0, 0]) }]);
      // Not searched: the memory is found by keyword alone until embedded.
      expect(f.recall("猫").map((r) => r.byMeaning)).toEqual([false]);
      await f.sync();
      expect(f.st.vectorFigures().held).toEqual([{ model: topicSettings.model, dims: topicSettings.dims, count: 1 }]);
      expect(f.recall("feline").map((r) => r.id)).toEqual([a]);
    }));
});

describe("leaving search by meaning", () => {
  // Each way out: found by meaning before, not from the call on, the sweep
  // empties storage, and coming back embeds again.
  it("erase drops the vector in the same call, from storage and from memory", () =>
    startEmbedded(async (f) => {
      const cat = f.remember("用户给我看了他的猫", "一只橘猫。");
      const kitten = f.remember("The kitten knocked over my notes", "Nothing else happened.");
      await f.sync();
      expect(ids(f.recall("feline")).sort()).toEqual([cat, kitten].sort());
      const n = f.get(cat).n;
      ok(f.obj.erase({ sessionId: f.sess(), id: cat, reason: "asked" }));
      expect(stored(f)).toEqual([f.get(kitten).n]);
      expect(f.indexed()).toBe(1);
      expect(f.st.searchVectors(topicSettings, new Float32Array(topicSettings.dims).fill(0).map((_, i) => (i === 0 ? 1 : 0)), 10, 0).map((h) => h.n)).not.toContain(n);
      expect(ids(f.recall("feline"))).toEqual([kitten]);
    }));

  it("retract leaves at once, the sweep drops it, restore embeds it again", () =>
    startEmbedded(async (f) => {
      const cat = f.remember("用户给我看了他的猫", "一只橘猫。");
      const kitten = f.remember("The kitten knocked over my notes", "Nothing else happened.");
      await f.sync();
      amend(f, "retract", cat);
      expect(ids(f.recall("feline"))).toEqual([kitten]);
      expect(stored(f)).toContain(f.get(cat).n); // until the sweep
      await f.sync();
      expect(stored(f)).toEqual([f.get(kitten).n]);
      amend(f, "restore", cat);
      expect(ids(f.recall("feline"))).toEqual([kitten]); // no vector yet
      await f.sync();
      expect(ids(f.recall("feline")).sort()).toEqual([cat, kitten].sort());
      expect(stored(f)).toEqual([f.get(cat).n, f.get(kitten).n]);
    }));

  it("a retracted memory restored before the sweep keeps its vector", () =>
    startEmbedded(async (f) => {
      const emb = f.emb!;
      const cat = f.remember("用户给我看了他的猫", "一只橘猫。");
      await f.sync();
      const calls = emb.documentCalls;
      amend(f, "retract", cat);
      amend(f, "restore", cat);
      await f.sync();
      expect(emb.documentCalls).toBe(calls);
      expect(ids(f.recall("feline"))).toEqual([cat]);
    }));

  it("correct: the old memory leaves at once and is swept, the new one is embedded", () =>
    startEmbedded(async (f) => {
      const cat = f.remember("用户给我看了他的猫", "一只橘猫。");
      await f.sync();
      const msg = ok(f.obj.amend({ sessionId: f.sess(), action: "correct", id: cat, gist: "用户给我看了他的小猫" }));
      const fixed = /m_[a-z0-9]+/.exec(msg)![0];
      expect(f.get(cat).state).toBe(StateSuperseded);
      expect(ids(f.recall("feline")), "the replaced one is not found, the new one has no vector yet").toEqual([]);
      await f.sync();
      expect(stored(f)).toEqual([f.get(fixed).n]);
      expect(ids(f.recall("feline"))).toEqual([fixed]);
    }));

  it("absorb: fragments leave at once and are swept, the episode is embedded", () =>
    startEmbedded(async (f) => {
      const a = f.remember("用户给我看了他的猫", "一只橘猫。");
      const b = f.remember("The kitten knocked over my notes", "Nothing else happened.");
      await f.sync();
      const view = ok(f.obj.beginReflect({ sessionId: f.sess() }));
      const made = ok(f.obj.finishReflect({
        sessionId: f.sess(), batch: view.batch,
        entries: [{ kind: KindEpisode, gist: "和猫的一个下午", body: "看了照片。", from: [a, b] }],
      }));
      expect(ids(f.recall("feline"))).toEqual([]);
      await f.sync();
      expect(stored(f)).toEqual([f.get(made[0]!).n]);
      expect(ids(f.recall("feline"))).toEqual([made[0]]);
    }));

  it("archive: leaves at once, is swept, and a reading brings it back to be embedded", () =>
    startEmbedded(async (f) => {
      const cat = f.remember("用户给我看了他的猫", "一只橘猫。");
      await f.sync();
      f.fill(35);
      expect(f.tier(cat)).toBe("archived");
      expect(ids(f.recall("feline"))).toEqual([]);
      await f.sync();
      expect(stored(f)).not.toContain(f.get(cat).n);
      // Read in full, it comes back from the archive; the call sets the alarm.
      await f.obj.alarm(); // runs what the writes woke; nothing waits after it
      await f.storage.deleteAlarm();
      expect(f.expand(cat).tier).toBe("archived");
      expect(await f.storage.getAlarm()).toBe(farFuture);
      await f.sync();
      expect(stored(f)).toContain(f.get(cat).n);
      expect(ids(f.recall("feline"))).toEqual([cat]);
    }));
});

describe("the object and the model", () => {
  it("never calls the model for a query", () => {
    const emb = new TopicEmbedder();
    return startEmbedded(async (f) => {
      const cat = f.remember("用户给我看了他的猫", "一只橘猫。");
      await f.sync();
      // With a query vector, without one, deep, through answer: no call.
      f.recall("feline");
      f.deepRecall("feline");
      ok(f.obj.recall({ query: "feline", sessionId: f.sess() }));
      expect(ok(f.obj.answer({ tool: "recall", query: "feline", sessionId: f.sess() }))).toBeDefined();
      expect(emb.queryCalls).toBe(0);
      // A vector of another label is not searched, even one that would match.
      const good = queryVectorOf("feline");
      for (const other of [{ ...good, model: "other" }, { ...good, dims: good.dims - 1 }]) {
        expect(ok(f.obj.recall({ query: "feline", sessionId: f.sess(), meaning: other }))).toEqual([]);
      }
      expect(ids(f.recall("feline"))).toEqual([cat]);
      expect(emb.queryCalls).toBe(0);
    }, emb);
  });

  it("cuts what the model returns to the size set, at unit length", () => {
    expect([...prepare([3, 4, 12], 2)]).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect([...prepare([0, 2], 2)]).toEqual([0, 1]);
    expect(() => prepare([1], 2)).toThrow("the model returned 1 dimensions, the setting asks for 2");
    expect(() => prepare([0, 0, 1], 2)).toThrow("no direction");
    expect(() => prepare([NaN, 1], 2)).toThrow("no direction");
  });

  it("an Embedding made from the binding sends documents, 32 at most a call", async () => {
    const fake = new FakeAI();
    const settings = embedSettings({ AI: fake.asAi(), EMBED_DIMS: String(topicSettings.dims) })!;
    const e = new Embedding(settings, new WorkersAI(fake.asAi(), settings.model));
    const vecs = await e.embedder.documents(Array.from({ length: 40 }, (_, i) => `text ${i}`));
    expect(vecs).toHaveLength(40);
    expect(fake.calls.map((c) => [c.model, c.form, c.texts.length, c.instruction ?? null])).toEqual([
      ["@cf/qwen/qwen3-embedding-0.6b", "documents", 32, null],
      ["@cf/qwen/qwen3-embedding-0.6b", "documents", 8, null],
    ]);
  });
});
