// The query's embedding with a second try: one call; a second beside it when
// the first has not answered after the delay, or at once when the first
// fails before then; the first usable answer is used; the overall limit
// holds. A stand-in embedder plays each call as scripted.

import { afterEach, describe, expect, it, vi } from "vitest";
import { type Embedder, embedQuery, type EmbedSettings, type QueryEmbedding } from "../src/embed";

afterEach(() => {
  vi.restoreAllMocks();
});

// One call as scripted: it answers after delay ms with the vector, or fails
// then. heedsAbort makes an abort end it at once, as the binding does.
interface Play {
  delay: number;
  fail?: boolean;
  vector?: number[];
  heedsAbort?: boolean;
}

interface Seen {
  startedAt: number; // ms after the first call started
  aborted: boolean;
  settledAt?: number;
}

class Scripted implements Embedder {
  seen: Seen[] = [];
  texts: string[][] = []; // what each call was sent
  private t0 = 0;

  constructor(private readonly plays: Play[]) {}

  documents(): Promise<number[][]> {
    throw new Error("not used");
  }

  queries(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    this.texts.push(texts);
    if (this.seen.length === 0) this.t0 = Date.now();
    const play = this.plays[this.seen.length] ?? { delay: 0, fail: true };
    const seen: Seen = { startedAt: Date.now() - this.t0, aborted: false };
    this.seen.push(seen);
    signal?.addEventListener("abort", () => {
      seen.aborted = true;
    });
    return new Promise((resolve, reject) => {
      const end = () => {
        seen.settledAt = Date.now() - this.t0;
        if (play.fail) reject(new Error("model unavailable"));
        // One vector per text: the scripted one first, then other axes.
        else resolve(texts.map((_t, i) => (i === 0 ? (play.vector ?? [1, 0, 0]) : [0, 1, 2].map((j) => (j === i % 3 ? 1 : 0)))));
      };
      if (play.delay === 0 && play.fail) {
        // Fails before anything is awaited.
        end();
        return;
      }
      const t = setTimeout(end, play.delay);
      if (play.heedsAbort) {
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          seen.settledAt = Date.now() - this.t0;
          reject(new Error("aborted"));
        });
      }
    });
  }
}

const settings: EmbedSettings = { model: "m", dims: 3, minSimilarity: 0, queryTimeoutMs: 600, queryHedgeMs: 100 };

function logged(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls.map((a) => JSON.parse(String(a[0])) as Record<string, unknown>);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(plays: Play[], s: EmbedSettings = settings): Promise<{ got: QueryEmbedding; emb: Scripted; lines: Record<string, unknown>[] }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const emb = new Scripted(plays);
  const got = await embedQuery(emb, s, "what the query says");
  const lines = logged(log);
  return { got, emb, lines };
}

const first = [1, 0, 0];
const second = [0, 1, 0];

describe("the second try", () => {
  it("is not made when the first answers before the delay", async () => {
    const { got, emb, lines } = await run([{ delay: 10, vector: first }]);
    expect(Array.from(got.vector!.values)).toEqual(first);
    expect(got.vector).toMatchObject({ model: "m", dims: 3 });
    expect(got.took).toMatchObject({ second: "not_needed", answer: "first" });
    expect(got.took!.ms).toBeLessThan(100);
    expect(emb.seen).toHaveLength(1);
    expect(lines).toEqual([]);
  });

  it("answers for a first call slow once: the second is made after the delay and used, the first aborted", async () => {
    const { got, emb, lines } = await run([{ delay: 400, vector: first, heedsAbort: true }, { delay: 10, vector: second }]);
    expect(Array.from(got.vector!.values)).toEqual(second);
    expect(got.took).toMatchObject({ second: "after_delay", answer: "second" });
    expect(emb.seen).toHaveLength(2);
    expect(emb.seen[1]!.startedAt).toBeGreaterThanOrEqual(90);
    expect(emb.seen[1]!.startedAt).toBeLessThan(300);
    expect(got.took!.ms).toBeGreaterThanOrEqual(100);
    expect(got.took!.ms).toBeLessThan(400);
    expect(emb.seen[0]!.aborted).toBe(true);
    expect(lines).toEqual([]);
  });

  it("gives up at the limit when the model is slow always, and logs the failure as before", async () => {
    const { got, emb, lines } = await run([{ delay: 2000, heedsAbort: true }, { delay: 2000, heedsAbort: true }]);
    expect(got.vector).toBeUndefined();
    expect(got.took).toMatchObject({ second: "after_delay", answer: "none" });
    expect(got.took!.ms).toBeGreaterThanOrEqual(590);
    expect(got.took!.ms).toBeLessThan(1500);
    expect(emb.seen.map((s) => s.aborted)).toEqual([true, true]);
    expect(lines).toEqual([{ msg: "query embedding failed", reason: "timeout", limit_ms: 600 }]);
  });

  it("starts the second at once when the first fails at once", async () => {
    const { got, emb, lines } = await run([{ delay: 0, fail: true }, { delay: 10, vector: second }]);
    expect(Array.from(got.vector!.values)).toEqual(second);
    expect(got.took).toMatchObject({ second: "after_failure", answer: "second" });
    expect(emb.seen[1]!.startedAt).toBeLessThan(50);
    expect(got.took!.ms).toBeLessThan(90);
    expect(lines).toEqual([]);
  });

  it("logs one failure, in the old form, when both fail", async () => {
    const { got, emb, lines } = await run([{ delay: 0, fail: true }, { delay: 5, fail: true }]);
    expect(got.vector).toBeUndefined();
    expect(got.took).toMatchObject({ second: "after_failure", answer: "none" });
    expect(emb.seen).toHaveLength(2);
    expect(lines).toEqual([{ msg: "query embedding failed", reason: "error", error: "Error" }]);
  });

  it("waits for the second when the first fails after it was made", async () => {
    const { got, lines } = await run([{ delay: 150, fail: true }, { delay: 150, vector: second }]);
    expect(Array.from(got.vector!.values)).toEqual(second);
    expect(got.took).toMatchObject({ second: "after_delay", answer: "second" });
    expect(lines).toEqual([]);
  });

  it("drops an answer that comes after the second already answered, and nothing throws", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => unhandled.push(e.reason);
    addEventListener("unhandledrejection", onUnhandled);
    try {
      // The first ignores the abort and answers late; another first fails late.
      for (const late of [{ delay: 250, vector: first }, { delay: 250, fail: true }]) {
        const { got, emb, lines } = await run([late, { delay: 10, vector: second }]);
        expect(Array.from(got.vector!.values)).toEqual(second);
        expect(got.took).toMatchObject({ second: "after_delay", answer: "second" });
        const kept = Array.from(got.vector!.values);
        await sleep(300);
        expect(emb.seen[0]!.settledAt).toBeGreaterThanOrEqual(240);
        expect(Array.from(got.vector!.values)).toEqual(kept);
        expect(lines).toEqual([]);
      }
    } finally {
      removeEventListener("unhandledrejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("counts an answer the settings cannot use as that call's failure", async () => {
    const { got } = await run([{ delay: 0, vector: [1, 0] }, { delay: 10, vector: second }]);
    expect(Array.from(got.vector!.values)).toEqual(second);
    expect(got.took).toMatchObject({ second: "after_failure", answer: "second" });
  });

  it("is never made when the delay is 0, which is the old behaviour", async () => {
    const off = { ...settings, queryHedgeMs: 0 };
    let r = await run([{ delay: 300, vector: first }], off);
    expect(Array.from(r.got.vector!.values)).toEqual(first);
    expect(r.got.took).toMatchObject({ second: "off", answer: "first" });
    expect(r.emb.seen).toHaveLength(1);
    vi.restoreAllMocks();
    r = await run([{ delay: 0, fail: true }, { delay: 0, vector: second }], off);
    expect(r.got.vector).toBeUndefined();
    expect(r.got.took).toMatchObject({ second: "off", answer: "none" });
    expect(r.emb.seen).toHaveLength(1);
    expect(r.lines).toEqual([{ msg: "query embedding failed", reason: "error", error: "Error" }]);
  });

  it("is not made after the limit, when the delay is longer", async () => {
    const r = await run([{ delay: 2000, heedsAbort: true }], { ...settings, queryTimeoutMs: 150, queryHedgeMs: 1000 });
    expect(r.got.took).toMatchObject({ second: "not_needed", answer: "none" });
    expect(r.emb.seen).toHaveLength(1);
    expect(r.lines).toEqual([{ msg: "query embedding failed", reason: "timeout", limit_ms: 150 }]);
  });

  it("sends a query that names several things with its parts, on both calls, and hands back a vector for each", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const emb = new Scripted([{ delay: 400, vector: first, heedsAbort: true }, { delay: 10, vector: second }]);
    const got = await embedQuery(emb, settings, " music, animals ");
    expect(emb.texts).toEqual([["music, animals", "music", "animals"], ["music, animals", "music", "animals"]]);
    expect(Array.from(got.vector!.values)).toEqual(second);
    expect(got.vector!.parts!.map((p) => Array.from(p))).toEqual([[0, 1, 0], [0, 0, 1]]);
    expect(got.took).toMatchObject({ second: "after_delay", answer: "second" });
    // A query that names one thing has no parts.
    const one = await embedQuery(new Scripted([{ delay: 0, vector: first }]), settings, "music,");
    expect(one.vector!.parts).toBeUndefined();
  });

  it("counts an answer without a vector for each text as that call's failure", async () => {
    const short: Embedder = {
      documents: () => Promise.reject(new Error("not used")),
      queries: () => Promise.resolve([[1, 0, 0]]),
    };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const got = await embedQuery(short, { ...settings, queryHedgeMs: 0 }, "music, animals");
    expect(got.vector).toBeUndefined();
    expect(got.took).toMatchObject({ answer: "none" });
  });

  it("calls nothing for an empty query", async () => {
    const emb = new Scripted([]);
    expect(await embedQuery(emb, settings, "   ")).toEqual({});
    expect(emb.seen).toEqual([]);
  });
});
