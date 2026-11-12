// The behaviour of one memory: what a session is shown, what may be written,
// how memories are found again. Port of service.go (amending and reflecting
// are in amend.ts) without embeddings and
// background work: a listing or a reading is logged in the call that made
// it, and matches by meaning, when there are any, are handed in by the
// caller (the object searches its vectors; see embedding.ts).

import { type Report } from "../store/check";
import { StateErased } from "../store/content";
import { retentionOf, type Tier, type TierCounts, tierOf } from "../store/decay";
import { covered, searchTerms } from "../store/segment";
import { NoSessionError, type Store } from "../store/store";
import { type CarrierNote, isLive, type Memory, type Preference, type RestoreNote, type Session, type Span } from "../store/types";
import {
  amend,
  type AmendRequest,
  beginReflect,
  type EntryRequest,
  erase,
  type EraseRequest,
  finishReflect,
  type ReflectView,
} from "./amend";
import {
  clean,
  clip,
  DefaultRecall,
  goQuote,
  InvalidInput,
  MaxExpand,
  MaxRecall,
  queryParts,
  type RememberRequest,
  trimSpace,
} from "./clean";

const minute = 60 * 1000;

// The Go defaults of Config. Not settable yet.
const recentLimit = 8; // recent memories a new session is shown
const coreLimit = 12; // core memories a new session is shown
const parallelWindow = 15 * minute; // how recently another session must have been active to be mentioned
// restoreNotice is how long after a restore new sessions are told of it.
const restoreNotice = 7 * 24 * 60 * minute;

// relevanceFloor drops results whose relevance is below this share of the
// best result's. Being listed restarts a memory's decay, so a memory that
// only brushes the query must not be listed.
const relevanceFloor = 0.3;

// ContextView is what a session is shown when it starts.
export interface ContextView {
  session: Session;
  carrier: CarrierNote;
  selves: Memory[]; // statements about oneself, oldest first
  prefs: Preference[]; // standing rules about what to remember
  pending: number; // fragments waiting for reflect
  // Set for a while after the memory was brought back from an export.
  restored: RestoreNote | null;
  core: Memory[]; // memories that never fade, most important first
  recent: Memory[]; // newest memories not archived and not listed under core
  others: Session[]; // other sessions active within the parallel window
  counts: TierCounts;
  clock: number; // the experience clock when the session started
  now: number; // the wall clock when the session started
}

// Result is one memory found by recall or returned by expand.
export interface Result extends Memory {
  tier: Tier; // at the time of the call, before it counted as coming to mind
  score: number;
  byKeyword: boolean;
  byMeaning: boolean;
  // Filled in by expand alone.
  sources: string[]; // ids of the memories it is built on
  readings: Memory[]; // later understandings of it
}

// MeaningHit is a memory found by meaning: its row number and the cosine
// similarity of its embedding to the query's, already above the threshold.
export interface MeaningHit {
  n: number;
  score: number;
}

// within says whether an instant falls within span, both ends included.
export function within(at: number, span: Span): boolean {
  return (span.since === undefined || at >= span.since) && (span.until === undefined || at <= span.until);
}

// recallDepth is how many matches recall weighs from each way of searching
// for a given limit.
export function recallDepth(limit: number): number {
  if (limit <= 0) limit = DefaultRecall;
  else if (limit > MaxRecall) limit = MaxRecall;
  return Math.max(4 * limit, 20);
}

export class Service {
  constructor(
    private readonly st: Store,
    private readonly now: () => number,
  ) {}

  // context starts a session for the given carrier and returns what it
  // should know before the conversation begins. Being shown here does not
  // count as coming to mind. tz is the time zone the model reported, already
  // checked, or "".
  context(model: string, client: string, tz = ""): ContextView {
    model = clip(model, 120);
    client = clip(client, 120);
    const now = this.now();
    const { session, note } = this.st.startSession(now, model, client, tz);
    const clock = this.st.clock();
    const selves = this.st.selves();
    const prefs = this.st.preferences();
    const pending = this.st.pendingCount();
    const last = this.st.lastRestore();
    const restored = last !== undefined && now - last.at < restoreNotice ? last : null;
    const core = this.st.core(coreLimit);
    const shown = new Set(core.map((m) => m.id));
    const recent: Memory[] = [];
    for (const m of this.st.recent(clock, recentLimit + core.length)) {
      if (!shown.has(m.id) && recent.length < recentLimit) recent.push(m);
    }
    const counts = this.st.tierCounts(clock);
    const others = this.st.activeSessions(now - parallelWindow, session.id, 3);
    return { session, carrier: note, selves, prefs, pending, restored, core, recent, others, counts, clock, now };
  }

  // check looks the memory over and reports what it finds, without quoting
  // what any memory says.
  check(): Report {
    return this.st.check();
  }

  // remember validates and stores one memory and returns its id. dup is
  // true when the same memory had just been written and nothing new was
  // stored.
  remember(req: RememberRequest): { id: string; dup: boolean } {
    const now = this.now();
    const input = clean(req, now);
    try {
      return this.st.remember(now, input);
    } catch (err) {
      if (err instanceof NoSessionError) {
        throw new InvalidInput(`unknown session_id ${goQuote(input.sessionId)}: call get_context and pass the session id it returns`);
      }
      throw err;
    }
  }

  // recall searches by keyword, takes the matches by meaning it is given,
  // and returns the best of them. Without a query it lists instead: see list.
  //
  // An ordinary search finds active and core memories by anything they say
  // and faded ones by their gist or their meaning. A deep search also reads
  // the details of faded memories and reaches archived ones. With a span,
  // only memories that took place within it are searched.
  //
  // A query that names several things (queryParts) is searched whole and
  // part by part; byMeaning holds the matches by meaning of the whole query,
  // and partsByMeaning, when given, those of each part in order.
  //
  // Being listed by a search restarts a memory's decay; it is logged before
  // this returns. The results describe the memories as they were before.
  // session is the caller's session id and may be empty.
  recall(
    query: string, limit: number, deep: boolean, session: string, byMeaning?: MeaningHit[],
    more: { span?: Span; partsByMeaning?: (MeaningHit[] | undefined)[] } = {},
  ): Result[] {
    query = trimSpace(query);
    if (limit <= 0) limit = DefaultRecall;
    else if (limit > MaxRecall) limit = MaxRecall;
    if (query === "") return this.list(more.span, limit, deep);
    query = clip(query, 500);
    const depth = recallDepth(limit);
    const clock = this.st.clock();

    // The searches made: the whole query, then each part when it has two or
    // more. Each scores a memory between 0 and 1 as a recall of its text
    // alone would: keyword matches relative to its best keyword match and by
    // how much of its terms they hold, matches by meaning by their cosine
    // similarity. A search's relevance is the average over the ways that
    // found anything in it, so a memory found both ways outranks one found by
    // a single way.
    interface Search {
      terms: string[];
      keyword: Map<number, number>;
      meaning: Map<number, number>;
      ways: number;
    }
    const parts = queryParts(query);
    const texts = parts.length >= 2 ? [query, ...parts] : [query];
    const searches: Search[] = texts.map((text, i) => {
      const s: Search = { terms: searchTerms(text), keyword: new Map(), meaning: new Map(), ways: 0 };
      const byKeyword = this.st.searchText(text, clock, deep, depth, more.span);
      if (byKeyword.length > 0) {
        s.ways++;
        const best = byKeyword[0]!.score;
        for (const h of byKeyword) s.keyword.set(h.n, best > 0 ? h.score / best : 1);
      }
      const meaning = i === 0 ? byMeaning : more.partsByMeaning?.[i - 1];
      if (meaning !== undefined) {
        if (meaning.length > 0) s.ways++;
        for (const h of meaning) s.meaning.set(h.n, h.score);
      }
      return s;
    });
    const ns = new Set<number>();
    for (const s of searches) for (const n of [...s.keyword.keys(), ...s.meaning.keys()]) ns.add(n);
    if (ns.size === 0) return [];

    const found = this.st.byN([...ns]);
    // What each search gives each memory it may return, and its best.
    interface Scored {
      m: Memory;
      tier: Tier;
      by: ({ relevance: number; byKeyword: boolean; byMeaning: boolean } | undefined)[];
    }
    const scored: Scored[] = [];
    const tops = searches.map(() => 0);
    for (const [n, m] of found) {
      const tier = tierOf(m, clock);
      if (tier === "archived" && !deep) continue; // its vector may not have been dropped yet
      // The same goes for a memory that no longer stands. One that was
      // replaced or put into an episode is still reached by a deep search.
      if (m.retracted || m.state === StateErased || (!isLive(m) && !deep)) continue;
      if (more.span !== undefined && !within(m.createdAt, more.span)) continue;
      const by = searches.map((s, i) => {
        const k = s.keyword.get(n);
        const mean = s.meaning.get(n);
        if (k === undefined && mean === undefined) return undefined;
        const keyword = k === undefined ? 0 : k * this.share(s.terms, m, tier === "faded" && !deep);
        const relevance = (keyword + (mean ?? 0)) / s.ways;
        tops[i] = Math.max(tops[i]!, relevance);
        return { relevance, byKeyword: k !== undefined, byMeaning: mean !== undefined };
      });
      scored.push({ m, tier, by });
    }
    // A search keeps what reaches the floor under its own best match, as a
    // recall of its text alone would. A memory takes the best relevance of
    // the searches that keep it, and is marked as that search found it; the
    // whole query wins a tie.
    let results: Result[] = [];
    for (const { m, tier, by } of scored) {
      let best: { relevance: number; byKeyword: boolean; byMeaning: boolean } | undefined;
      by.forEach((r, i) => {
        if (r === undefined || r.relevance < relevanceFloor * tops[i]!) return;
        if (best === undefined || r.relevance > best.relevance) best = r;
      });
      if (best === undefined) continue;
      results.push({
        ...m,
        tier,
        // Relevance leads. Importance and how well the memory has been
        // retained scale it by at most a factor of three between them.
        score: best.relevance * (0.7 + 0.3 * m.importance) * (0.5 + 0.5 * retentionOf(m, clock)),
        byKeyword: best.byKeyword,
        byMeaning: best.byMeaning,
        sources: [],
        readings: [],
      });
    }
    results.sort((a, b) => (a.score !== b.score ? b.score - a.score : b.n - a.n));
    if (results.length > limit) results = results.slice(0, limit);
    if (results.length === 0) return [];

    this.st.logRecalls([
      { at: this.now(), session: this.knownSession(session), query, ids: results.map((r) => r.id), clock },
    ]);
    return results;
  }

  // list returns the newest memories that took place within span, or the
  // newest of all without one, newest first: those the recent list of a new
  // session may show, and with deep the archived ones too. Like that list, it
  // counts as nothing coming to mind: nothing is logged and no decay
  // restarts. limit is already within bounds.
  private list(span: Span | undefined, limit: number, deep: boolean): Result[] {
    const clock = this.st.clock();
    return this.st.inSpanList(clock, span ?? {}, deep, limit).map((m) => ({
      ...m, tier: tierOf(m, clock), score: 0, byKeyword: false, byMeaning: false, sources: [], readings: [],
    }));
  }

  // share is the part of a search's terms that a memory found by keyword
  // holds, in what was searched of it: the gist alone for a faded memory in
  // an ordinary search. Terms are joined with OR, and the best keyword match
  // of a search scores 1 however little of the search it holds; without this
  // a memory that shares one passing word with the query outranks the memory
  // the query means (measured on the platform, 2026-11-11). Go has no such
  // factor. A match the index made and this reading misses (it folds accents,
  // this does not) counts as one term.
  private share(terms: string[], m: Memory, gistOnly: boolean): number {
    if (terms.length === 0) return 1;
    const text = gistOnly
      ? m.gist
      : [m.gist, m.body, m.outcome, m.feeling, m.lesson, m.pointer, m.about, m.context, ...m.people].join("\n");
    return Math.max(covered(terms, text), 1) / terms.length;
  }

  // expand returns memories in full, whatever tier they are in. Reading a
  // memory in full is what strengthens it; that is logged before this
  // returns. session is the caller's session id and may be empty.
  expand(ids: string[], session: string): Result[] {
    const want: string[] = [];
    for (let id of ids) {
      id = trimSpace(id);
      if (id !== "" && !want.includes(id)) want.push(id);
    }
    if (want.length === 0) throw new InvalidInput("ids is required");
    if (want.length > MaxExpand) throw new InvalidInput(`at most ${MaxExpand} ids per call`);
    const ms = this.st.get(want);
    if (ms.length === 0) return [];
    const clock = this.st.clock();
    const out: Result[] = [];
    const read: string[] = [];
    for (const m of ms) {
      const r: Result = { ...m, tier: tierOf(m, clock), score: 0, byKeyword: false, byMeaning: false, sources: [], readings: [] };
      out.push(r);
      if (m.state === StateErased) continue; // there is nothing left to read
      r.sources = this.st.sources(m.id);
      r.readings = this.st.readings(m.id);
      if (!m.retracted) read.push(m.id);
    }
    if (read.length > 0) {
      this.st.logRecalls([{ at: this.now(), session: this.knownSession(session), read: true, ids: read, clock }]);
    }
    return out;
  }

  // amend carries out one amendment and returns a sentence saying what was
  // done.
  amend(req: AmendRequest): string {
    return amend(this.st, this.now(), req);
  }

  // erase deletes what a memory says, for good, and returns a sentence
  // saying so.
  erase(req: EraseRequest): string {
    return erase(this.st, this.now(), req);
  }

  // beginReflect opens a round of reflection for the session and hands it a
  // batch of fragments.
  beginReflect(session: string, limit: number): ReflectView {
    return beginReflect(this.st, this.now(), session, limit);
  }

  // finishReflect writes a round of reflection back and returns the ids of
  // the memories it made, in the order of the entries.
  finishReflect(session: string, batch: string, entries: EntryRequest[], pass: string[]): string[] {
    return finishReflect(this.st, this.now(), session, batch, entries, pass);
  }

  // knownSession returns id if it names a session and "" otherwise. A read
  // is never refused over who is asking; an id that names nothing is just
  // not recorded.
  private knownSession(id: string): string {
    id = trimSpace(id);
    if (id === "") return "";
    return this.st.session(id) === undefined ? "" : id;
  }
}
