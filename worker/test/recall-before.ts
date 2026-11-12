// The ranking of recall as it stood at a8bec2d, before a query could name
// several things or be kept to a time, copied so that tests can compare a
// recall now with the same search then. Word for word, except: it writes
// nothing (the recall's event is left out, so that calling it changes no
// memory), and the matches by meaning are found here as the object found
// them, from the query's vector.

import { prepare, type QueryVector } from "../src/embed";
import { clip, DefaultRecall, MaxRecall, trimSpace } from "../src/memory/clean";
import { type MeaningHit, recallDepth, type Result } from "../src/memory/service";
import { StateErased } from "../src/store/content";
import { retentionOf, tierOf } from "../src/store/decay";
import { covered, searchTerms } from "../src/store/segment";
import type { Store } from "../src/store/store";
import { isLive, type Memory } from "../src/store/types";
import type { EmbedSettings } from "../src/embed";

const relevanceFloor = 0.3;

// meaningBefore is the object's meaningFor then: the vectors searched with
// the query's vector, or undefined without one.
export function meaningBefore(st: Store, s: EmbedSettings, v: QueryVector | undefined, limit: number): MeaningHit[] | undefined {
  if (v === undefined) return undefined;
  return st.searchVectors({ model: s.model, dims: s.dims }, prepare(v.values, s.dims), recallDepth(limit), s.minSimilarity);
}

export function recallBefore(st: Store, query: string, limit: number, deep: boolean, byMeaning?: MeaningHit[]): Result[] {
  query = trimSpace(query);
  if (query === "") throw new Error("query is required");
  query = clip(query, 500);
  if (limit <= 0) limit = DefaultRecall;
  else if (limit > MaxRecall) limit = MaxRecall;
  const depth = recallDepth(limit);
  const clock = st.clock();
  const byKeyword = st.searchText(query, clock, deep, depth);

  interface Cand {
    keyword: number;
    meaning: number;
    byKeyword: boolean;
    byMeaning: boolean;
  }
  const cands = new Map<number, Cand>();
  const get = (n: number): Cand => {
    let c = cands.get(n);
    if (c === undefined) {
      c = { keyword: 0, meaning: 0, byKeyword: false, byMeaning: false };
      cands.set(n, c);
    }
    return c;
  };
  let ways = 0;
  if (byKeyword.length > 0) {
    ways++;
    const best = byKeyword[0]!.score;
    for (const h of byKeyword) {
      const c = get(h.n);
      c.byKeyword = true;
      c.keyword = best > 0 ? h.score / best : 1;
    }
  }
  if (byMeaning !== undefined) {
    if (byMeaning.length > 0) ways++;
    for (const h of byMeaning) {
      const c = get(h.n);
      c.byMeaning = true;
      c.meaning = h.score;
    }
  }
  if (cands.size === 0) return [];

  const found = st.byN([...cands.keys()]);
  const terms = searchTerms(query);
  const kept: { r: Result; relevance: number }[] = [];
  let top = 0;
  for (const [n, m] of found) {
    const tier = tierOf(m, clock);
    if (tier === "archived" && !deep) continue;
    if (m.retracted || m.state === StateErased || (!isLive(m) && !deep)) continue;
    const c = cands.get(n)!;
    if (c.byKeyword) c.keyword *= share(terms, m, tier === "faded" && !deep);
    const relevance = (c.keyword + c.meaning) / ways;
    top = Math.max(top, relevance);
    kept.push({
      relevance,
      r: {
        ...m,
        tier,
        score: relevance * (0.7 + 0.3 * m.importance) * (0.5 + 0.5 * retentionOf(m, clock)),
        byKeyword: c.byKeyword,
        byMeaning: c.byMeaning,
        sources: [],
        readings: [],
      },
    });
  }
  let results = kept.filter((k) => k.relevance >= relevanceFloor * top).map((k) => k.r);
  results.sort((a, b) => (a.score !== b.score ? b.score - a.score : b.n - a.n));
  if (results.length > limit) results = results.slice(0, limit);
  return results;
}

function share(terms: string[], m: Memory, gistOnly: boolean): number {
  if (terms.length === 0) return 1;
  const text = gistOnly
    ? m.gist
    : [m.gist, m.body, m.outcome, m.feeling, m.lesson, m.pointer, m.about, m.context, ...m.people].join("\n");
  return Math.max(covered(terms, text), 1) / terms.length;
}

// shown is what a test compares of a recall's results: ids, scores, tiers
// and how each was found, never what a memory says.
export function shown(rs: Result[]): [string, number, string, boolean, boolean][] {
  return rs.map((r) => [r.id, r.score, r.tier, r.byKeyword, r.byMeaning]);
}
