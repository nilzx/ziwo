// A query that names several things: split at list punctuation, searched
// whole and part by part, merged. A stand-in embedder gives chosen vectors,
// so that the whole query's vector can lie apart from every memory while each
// part's lies on one. Results are compared with the ranking before this
// change (recall-before.ts). Memories hold made-up text; the tests look at
// ids, figures and the fixed strings written here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { type Embedder, embedQuery, type EmbedSettings, type QueryVector } from "../src/embed";
import { MaxQueryParts, queryParts } from "../src/memory/clean";
import { Embedding } from "../src/memory/embedding";
import { farFuture, TopicEmbedder, topicSettings } from "./embed-helpers";
import { meaningBefore, recallBefore, shown } from "./recall-before";
import { type Fixture, ids, ok, start, startEmbedded } from "./service-helpers";

afterEach(() => vi.restoreAllMocks());

const chosenSettings: EmbedSettings = { model: "chosen-test", dims: 16, minSimilarity: 0.45, queryTimeoutMs: 2000, queryHedgeMs: 1000 };

function fnv32a(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

// ChosenEmbedder puts a text on one axis: the one chosen for it exactly, else
// the one chosen for a marker it holds, else one of axes 8 to 15 by its hash,
// which no chosen axis shares.
class ChosenEmbedder implements Embedder {
  down = false;
  queryCalls = 0;
  sent: string[][] = [];

  constructor(
    private readonly exact: Record<string, number>,
    private readonly markers: Record<string, number> = {},
  ) {}

  private axis(text: string): number {
    const e = this.exact[text];
    if (e !== undefined) return e;
    for (const [mark, axis] of Object.entries(this.markers)) if (text.includes(mark)) return axis;
    return 8 + (fnv32a(text) % 8);
  }

  private vector(text: string): number[] {
    const v = new Array<number>(chosenSettings.dims).fill(0);
    v[this.axis(text)] = 1;
    return v;
  }

  async documents(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }

  async queries(texts: string[]): Promise<number[][]> {
    this.queryCalls++;
    this.sent.push(texts);
    if (this.down) throw new Error("connection refused");
    return texts.map((t) => this.vector(t));
  }
}

// withChosen gives the fixture's object the chosen embedder, and embeds what
// it holds.
async function withChosen(f: Fixture, emb: ChosenEmbedder): Promise<void> {
  f.obj.embedding = new Embedding(chosenSettings, emb);
  f.obj.alarmNow = () => farFuture;
  await f.sync();
}

async function vectorOf(emb: Embedder, s: EmbedSettings, query: string): Promise<QueryVector | undefined> {
  return (await embedQuery(emb, s, query)).vector;
}

// recallEvents reads the queries of the recall events, in order. The
// queries are the tests' own words.
function recallEvents(f: Fixture): string[] {
  return f.storage.sql
    .exec<{ payload: string }>(`SELECT payload FROM events WHERE kind = 'recall' ORDER BY seq`)
    .toArray()
    .map((r) => (JSON.parse(r.payload) as { query: string }).query);
}

describe("queryParts", () => {
  it("splits at list punctuation and line breaks, trims, and drops empty parts", () => {
    const ls = String.fromCharCode(0x2028);
    const cases: [string, string[]][] = [
      ["one thing", ["one thing"]],
      ["", []],
      [" ,,， ", []],
      ["a、b", ["a", "b"]],
      ["a,b", ["a", "b"]],
      ["a，b", ["a", "b"]],
      ["a;b", ["a", "b"]],
      ["a；b", ["a", "b"]],
      // A slash and a comma between digits are part of what is named.
      ["a/b", ["a/b"]],
      ["2026/03/14, c", ["2026/03/14", "c"]],
      ["1,000 steps", ["1,000 steps"]],
      ["1,000 steps, b", ["1,000 steps", "b"]],
      ["a1,b", ["a1", "b"]],
      ["a,2", ["a", "2"]],
      ["a|b", ["a", "b"]],
      ["a\nb", ["a", "b"]],
      ["a\r\nb", ["a", "b"]],
      [`a${ls}b`, ["a", "b"]],
      [" first thing , , second thing ,", ["first thing", "second thing"]],
      ["动物、音乐", ["动物", "音乐"]],
    ];
    for (const [q, want] of cases) expect(queryParts(q), JSON.stringify(q)).toEqual(want);
  });

  it("keeps at most four parts: the fourth holds the rest as written", () => {
    expect(MaxQueryParts).toBe(4);
    expect(queryParts("a, b, c, d")).toEqual(["a", "b", "c", "d"]);
    expect(queryParts("a, b; c ； d | e\nf")).toEqual(["a", "b", "c", "d | e\nf"]);
    // Empty parts do not count towards the four, and the rest is trimmed of
    // breaks at its edges.
    expect(queryParts("a,,b,,c,, d ,e,")).toEqual(["a", "b", "c", "d ,e"]);
    expect(queryParts("a,b,c, ,, d ,")).toEqual(["a", "b", "c", "d"]);
    expect(queryParts("a,b,c,,,")).toEqual(["a", "b", "c"]);
  });
});

describe("a query that names several things", () => {
  it("finds the memory of each part where the whole query's vector finds neither, as each part alone would", () =>
    start(async (f) => {
      const emb = new ChosenEmbedder({ "pets, instruments": 2, pets: 0, instruments: 1 }, { zqa: 0, zqb: 1 });
      const a = f.remember("zqa first", "a body");
      const b = f.remember("zqb second", "a body");
      f.remember("zqc third", "a body");
      await withChosen(f, emb);
      const query = "pets, instruments";

      const v = (await embedQuery(emb, chosenSettings, query)).vector!;
      // One call to the model, with the whole query and its parts.
      expect(emb.queryCalls).toBe(1);
      expect(emb.sent).toEqual([[query, "pets", "instruments"]]);
      expect(v.parts).toHaveLength(2);

      // Before, the whole query's vector alone: nothing.
      expect(recallBefore(f.st, query, 0, false, meaningBefore(f.st, chosenSettings, v, 0))).toEqual([]);
      // Now, without the parts' vectors, still nothing: they find nothing by keyword.
      expect(ok(f.obj.recall({ query, sessionId: f.sess(), meaning: { ...v, parts: undefined } }))).toEqual([]);

      // What each part alone gives, before this change, without writing.
      const alone = new Map<string, ReturnType<typeof shown>[number]>();
      for (const part of ["pets", "instruments"]) {
        const pv = await vectorOf(emb, chosenSettings, part);
        for (const s of shown(recallBefore(f.st, part, 0, false, meaningBefore(f.st, chosenSettings, pv, 0)))) alone.set(s[0], s);
      }
      expect([...alone.keys()].sort()).toEqual([a, b].sort());

      const events = recallEvents(f).length;
      const got = ok(f.obj.recall({ query, sessionId: f.sess(), meaning: v }));
      expect(ids(got).sort()).toEqual([a, b].sort());
      for (const s of shown(got)) expect(s).toEqual(alone.get(s[0]));
      // One event for the recall, with the whole query.
      expect(recallEvents(f).slice(events)).toEqual([query]);
      expect(got.map((r) => [r.byKeyword, r.byMeaning])).toEqual([[false, true], [false, true]]);
    }));

  it("finds by keyword the memory of each part as each part alone would", () =>
    start((f) => {
      const violin = f.remember("violin practice in the evening", "a body");
      const garden = f.remember("garden tomatoes and basil planted", "a body");
      f.remember("an unrelated morning", "a body");
      const query = "violin; garden tomatoes basil";
      const alone = [
        ...shown(recallBefore(f.st, "violin", 0, false)),
        ...shown(recallBefore(f.st, "garden tomatoes basil", 0, false)),
      ];
      expect(alone.map((s) => s[0])).toEqual([violin, garden]);
      const got = shown(ok(f.obj.recall({ query, sessionId: f.sess() })));
      expect(got.map((s) => s[0]).sort()).toEqual([violin, garden].sort());
      for (const s of got) expect(s).toEqual(alone.find((x) => x[0] === s[0]));
    }));

  it("keeps a part's weak match that a recall of the part alone keeps, beside a strong match of another part", () =>
    start((f) => {
      const violin = f.remember("violin", "a body");
      // Holds one of the second part's four terms: relevance 0.25 there,
      // under the floor of the first part's best (0.3) and at its own.
      const garden = f.remember("garden path in the rain", "a body");
      f.remember("an unrelated morning", "a body");
      const alone = shown(recallBefore(f.st, "garden tomatoes basil seedlings", 0, false));
      expect(alone.map((s) => s[0])).toEqual([garden]);
      const got = shown(ok(f.obj.recall({ query: "violin; garden tomatoes basil seedlings", sessionId: f.sess() })));
      expect(got.map((s) => s[0]).sort()).toEqual([violin, garden].sort());
      expect(got.find((s) => s[0] === garden)).toEqual(alone[0]);
    }));

  it("searches the parts past the fourth together, as the fourth part", () =>
    start(async (f) => {
      const emb = new ChosenEmbedder({});
      const ms = ["k1", "k2", "k3", "k4", "k5", "k6"].map((k) => f.remember(`${k} note`, "a body"));
      const query = "k1, k2, k3, k4, k5, k6";
      const v = (await embedQuery(emb, chosenSettings, query)).vector!;
      expect(emb.sent).toEqual([[query, "k1", "k2", "k3", "k4, k5, k6"]]);
      expect(v.parts).toHaveLength(4);
      // Searched by keyword alone: this object has no vectors.
      const before = shown(recallBefore(f.st, "k1", 0, false));
      const got = ok(f.obj.recall({ query, limit: 10, sessionId: f.sess() }));
      expect(ids(got).sort()).toEqual([...ms].sort());
      // The first three each come out as alone; the last three share a search.
      expect(shown(got).find((s) => s[0] === ms[0])).toEqual(before[0]);
      const k4 = got.find((r) => r.id === ms[3])!;
      expect(k4.score).toBeLessThan(got.find((r) => r.id === ms[0])!.score);
    }));

  it("is searched part by part by keyword when the embedding fails", () =>
    start(async (f) => {
      const emb = new ChosenEmbedder({ pets: 0 }, { zqa: 0 });
      const byMeaning = f.remember("zqa first", "a body");
      const violin = f.remember("violin practice in the evening", "a body");
      const garden = f.remember("garden tomatoes and basil planted", "a body");
      await withChosen(f, emb);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      emb.down = true;
      const query = "pets, violin, garden";
      const e = await embedQuery(emb, chosenSettings, query);
      expect(e.vector).toBeUndefined();
      expect(e.took).toMatchObject({ answer: "none" });
      const alone = [...shown(recallBefore(f.st, "violin", 0, false)), ...shown(recallBefore(f.st, "garden", 0, false))];
      const got = ok(f.obj.recall({ query, sessionId: f.sess(), ...(e.vector === undefined ? {} : { meaning: e.vector }) }));
      expect(ids(got).sort()).toEqual([violin, garden].sort());
      expect(ids(got)).not.toContain(byMeaning);
      expect(got.every((r) => r.byKeyword && !r.byMeaning)).toBe(true);
      // Each as alone.
      for (const s of shown(got)) expect(s).toEqual(alone.find((x) => x[0] === s[0]));
    }));

  it("marks a memory as the search that gave it its relevance found it, the first in order on a tie", () =>
    start(async (f) => {
      // "violin" finds it by keyword alone, "gardening" by meaning alone,
      // each with relevance 1; the whole query by keyword, with less.
      const emb = new ChosenEmbedder({ "violin, gardening": 2, violin: 3, gardening: 0 }, { zqa: 0 });
      const m = f.remember("violin zqa", "a body");
      await withChosen(f, emb);
      const v = (await embedQuery(emb, chosenSettings, "violin, gardening")).vector!;
      const got = ok(f.obj.recall({ query: "violin, gardening", sessionId: f.sess(), meaning: v }));
      expect(got.map((r) => [r.id, r.byKeyword, r.byMeaning])).toEqual([[m, true, false]]);
      // The other order: the part found by meaning comes first.
      const w = (await embedQuery(emb, chosenSettings, "gardening, violin")).vector!;
      const again = ok(f.obj.recall({ query: "gardening, violin", sessionId: f.sess(), meaning: w }));
      expect(again.map((r) => [r.id, r.byKeyword, r.byMeaning])).toEqual([[m, false, true]]);
    }));

  it("leaves parts read by keyword alone when their vectors do not fit the query's parts", () =>
    start(async (f) => {
      const emb = new ChosenEmbedder({ "pets, instruments": 2, pets: 0, instruments: 1 }, { zqa: 0, zqb: 1 });
      f.remember("zqa first", "a body");
      f.remember("zqb second", "a body");
      await withChosen(f, emb);
      const v = (await embedQuery(emb, chosenSettings, "pets, instruments")).vector!;
      // One vector too few, and a vector of the wrong size: neither is searched.
      expect(ok(f.obj.recall({ query: "pets, instruments", sessionId: f.sess(), meaning: { ...v, parts: v.parts!.slice(1) } }))).toEqual([]);
      const bad = { ...v, parts: [v.parts![0]!.slice(1), v.parts![1]!] };
      const got = ok(f.obj.recall({ query: "pets, instruments", sessionId: f.sess(), meaning: bad }));
      expect(got).toHaveLength(1);
    }));
});

describe("a query that names one thing", () => {
  // Made-up words, some of which the stand-in model places on a topic.
  const words = ["cat", "deploy", "river", "lamp", "violin", "garden", "猫咪", "部署", "上线", "纠正", "night", "letter", "kitten", "release"];
  const queries = [
    "cat", "deploy release", "猫", "部署 上线", "feline", "river lamp", "kitten night letter", "纠正了", "nothing-like-it",
    "cat,", " , deploy , ", "garden.", "violin and the lamp at night",
  ];

  it("ranks and lists exactly as before, deep or not, with or without a vector", () =>
    startEmbedded(async (f) => {
      const emb = f.emb!;
      let seed = 7;
      const rand = (): number => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      const pick = (): string => words[Math.floor(rand() * words.length)]!;
      for (let i = 0; i < 40; i++) {
        f.rememberWith({ gist: `${pick()} ${pick()} note ${i}`, body: `${pick()} and ${pick()}`, importance: [0.3, 0.5, 0.7][i % 3]! });
        if (i === 20) f.fill(12);
      }
      await f.sync();
      // Some memories came to mind earlier than others.
      ok(f.obj.recall({ query: "river", sessionId: f.sess() }));
      const counts = f.counts();
      expect([counts.faded > 0, counts.archived > 0], "some memories have faded and some are archived").toEqual([true, true]);

      let compared = 0;
      for (const q of queries) {
        expect(queryParts(q).length, q).toBeLessThanOrEqual(1);
        for (const deep of [false, true]) {
          for (const limit of [0, 3, 20]) {
            for (const withVector of [true, false]) {
              const v = withVector ? await vectorOf(emb, topicSettings, q) : undefined;
              const want = shown(recallBefore(f.st, q, limit, deep, meaningBefore(f.st, topicSettings, v, limit)));
              const got = shown(ok(f.obj.recall({ query: q, limit, deep, sessionId: f.sess(), ...(v === undefined ? {} : { meaning: v }) })));
              expect(got, `${q} deep=${deep} limit=${limit} vector=${withVector}`).toEqual(want);
              if (want.length > 0) compared++;
            }
          }
        }
      }
      // The comparisons were not all of empty results, and covered faded ones.
      expect(compared).toBeGreaterThan(60);
      // One call for each query embedded, with one text.
      expect(emb.queryTexts).toBe(emb.queryCalls);
    }));
});
