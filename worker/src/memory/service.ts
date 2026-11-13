// The behaviour of one memory: what a session is shown, what may be written,
// how memories are found again. Port of service.go (amending and reflecting
// are in amend.ts) without embeddings and
// background work: a listing or a reading is logged in the call that made
// it, and matches by meaning, when there are any, are handed in by the
// caller (the object searches its vectors; see embedding.ts).

import { type Report } from "../store/check";
import { KindImpression, KindLesson, KindSubject, StateErased } from "../store/content";
import { retentionOf, type Tier, type TierCounts, tierOf } from "../store/decay";
import { covered, searchTerms } from "../store/segment";
import { NoSessionError, type Store } from "../store/store";
import { SubjectError } from "../store/errors";
import {
  type CarrierNote,
  isLive,
  type Memory,
  type Preference,
  type RestoreNote,
  type Session,
  type Span,
  type SubjectFigures,
} from "../store/types";
import {
  amend,
  type AmendRequest,
  beginReflect,
  type EntryRequest,
  erase,
  type EraseRequest,
  finishReflect,
  type ReflectView,
  type SubjectLine,
} from "./amend";
import {
  clean,
  cleanSubject,
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

// peopleShown is how many names expand shows for a subject.
const peopleShown = 8;

// ripeAfter is how long a session must have written no fragment before its
// fragments are ripe: put together while the conversation is still going on,
// they would be put together by halves.
export const ripeAfter = 30 * minute;

// When a subject comes to mind (its items are in get_context's recent list,
// or listed by a recall) and this many of its fragments are ripe, the answer
// asks for a round on it; get_context asks for one on the unsorted at
// unsortedHint. Starting values.
export const subjectHint = 6;
export const unsortedHint = 12;
export const subjectsShown = 20; // subjects get_context lists
export const subjectsFound = 3; // subjects a recall with a query shows at most

// Prompt is a request, at the end of an answer, for a round of reflection on
// a subject ("" for the unsorted), and how many of its fragments are ripe.
export interface Prompt {
  subject: string;
  ripe: number;
}

// RecallView is what a recall shows: subjects first, then memories, then
// perhaps a request for a round of reflection. scoped is set when the recall
// was kept to one subject ("" for the unsorted).
export interface RecallView {
  results: Result[];
  subjects: SubjectLine[];
  scoped?: string;
  prompt?: Prompt;
}

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
  // The subjects most recently active, and any the prompt names besides;
  // how many subjects there are; the request for a round, if any.
  subjects: SubjectLine[];
  subjectCount: number;
  prompt?: Prompt;
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
  replaced: string[]; // ids of the earlier lessons, impressions or subjects it took the place of
  // Filled in by expand alone: the subject an item is filed under, by its
  // head and the head's name.
  subjectOf?: { id: string; name: string };
  // Filled in by expand alone, for a subject's head: its figures, when it
  // was last active, and who its memories name.
  held?: { figures: SubjectFigures; activeAt: number; people: string[] };
}

// subjectRefusal is what the model is told when a subject given to a write
// cannot be used.
export function subjectRefusal(err: SubjectError): InvalidInput {
  return new InvalidInput(
    err.reason === "no-letter"
      ? `subject ${goQuote(err.value)} has no letter or digit: give the subject a name`
      : `subject ${goQuote(err.value)} names no subject: give a subject's name, or an id that get_context or recall shows for one`,
  );
}

// MeaningHit is a memory found by meaning: its row number and the cosine
// similarity of its embedding to the query's, already above the threshold.
export interface MeaningHit {
  n: number;
  score: number;
}

// RecallMore is what a recall is kept to, and what the object found by
// meaning for it besides the whole query's matches.
export interface RecallMore {
  span?: Span;
  partsByMeaning?: (MeaningHit[] | undefined)[];
  subject?: string; // the head of the subject it is kept to, or "" for the unsorted
  subjectsByMeaning?: MeaningHit[]; // subject heads found by meaning
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
    // What waits, by subject, and how much of it is ripe: one read.
    const waiting = this.st.ripeness(this.st.hotSessions(now - ripeAfter, session.id));
    let pending = 0;
    for (const w of waiting.values()) pending += w.waiting;
    let prompt = this.promptFor(session.id, now, recent.map((m) => m.subject), waiting);
    const unsorted = waiting.get("")?.ripe ?? 0;
    if (prompt === undefined && unsorted >= unsortedHint && this.mayPrompt(session.id, now)) prompt = { subject: "", ripe: unsorted };
    if (prompt !== undefined) this.st.notePrompted(session.id);
    const active = this.st.subjectsRecent(subjectsShown);
    const subjectCount = active.length < subjectsShown ? active.length : this.st.subjectCount();
    const heads = active.map((s) => s.id);
    if (prompt !== undefined && prompt.subject !== "" && !heads.includes(prompt.subject)) heads.push(prompt.subject);
    const subjects = this.subjectLines(heads, waiting);
    return {
      session, carrier: note, selves, prefs, pending, restored, core, recent, others, counts, clock, now, subjects, subjectCount,
      ...(prompt === undefined ? {} : { prompt }),
    };
  }

  // mayPrompt says whether the session may be asked for a round: not when it
  // was asked already or opened one, and not while a round is held.
  private mayPrompt(session: string, now: number): boolean {
    if (session === "" || this.st.prompted().includes(session)) return false;
    const held = this.st.heldRound();
    return held === undefined || held.until <= now;
  }

  // promptFor picks the subject to ask a round on among those that came to
  // mind, in the order they did: the one with the most ripe fragments, at
  // least subjectHint, the first on a tie. It does not record the prompt.
  private promptFor(session: string, now: number, subjects: string[], waiting: Map<string, { ripe: number }>): Prompt | undefined {
    let best: Prompt | undefined;
    for (const s of subjects) {
      if (s === "") continue;
      const ripe = waiting.get(s)?.ripe ?? 0;
      if (ripe >= subjectHint && (best === undefined || ripe > best.ripe)) best = { subject: s, ripe };
    }
    return best !== undefined && this.mayPrompt(session, now) ? best : undefined;
  }

  // subjectLines reads the lines of the subjects with the given heads, in
  // that order, their waiting fragments from waiting when it has them.
  private subjectLines(heads: string[], waiting?: Map<string, { waiting: number }>): SubjectLine[] {
    const figures = this.st.subjectFigures(heads, waiting);
    return this.st.subjects(heads).map((subject) => ({ subject, figures: figures.get(subject.id)! }));
  }

  // recallSubject resolves the subject a recall is kept to: its head, or ""
  // for the unsorted.
  recallSubject(value: string): string {
    const v = cleanSubject(value);
    const r = this.st.resolveSubject(v);
    if ("none" in r) return "";
    if ("head" in r) return r.head;
    throw new InvalidInput(`subject ${goQuote(v)} names none of your subjects: recall with a query finds them by what they are about`);
  }

  // check looks the memory over and reports what it finds, without quoting
  // what any memory says.
  check(): Report {
    return this.st.check();
  }

  // remember validates and stores one memory and returns its id. dup is
  // true when the same memory had just been written and nothing new was
  // stored. subject says which subject it was filed under, by its head, and
  // whether its name started that subject.
  remember(req: RememberRequest): { id: string; dup: boolean; subject?: { id: string; started: boolean } } {
    const now = this.now();
    const input = clean(req, now);
    try {
      return this.st.remember(now, input);
    } catch (err) {
      if (err instanceof NoSessionError) {
        throw new InvalidInput(`unknown session_id ${goQuote(input.sessionId)}: call get_context and pass the session id it returns`);
      }
      if (err instanceof SubjectError) throw subjectRefusal(err);
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
    more: RecallMore = {},
  ): Result[] {
    return this.recallView(query, limit, deep, session, byMeaning, more).results;
  }

  // recallView recalls as recall does, and adds what a recall shows besides
  // the memories. With a query and no subject, subjects are searched too,
  // by keyword and by the matches by meaning of their heads handed in, and
  // the best few are shown first. Kept to a subject (more.subject: its head,
  // or "" for the unsorted), only its memories are searched or listed, and
  // its own line comes first. When a subject the memories listed belong to
  // has enough ripe fragments waiting, the answer asks for a round on it,
  // once per session; a session that names none is never asked.
  recallView(
    query: string, limit: number, deep: boolean, session: string, byMeaning?: MeaningHit[],
    more: RecallMore = {},
  ): RecallView {
    const results = this.items(query, limit, deep, session, byMeaning, more);
    const view: RecallView = { results, subjects: [] };
    if (more.subject !== undefined) view.scoped = more.subject;
    const heads: string[] = [];
    if (more.subject !== undefined) {
      if (more.subject !== "") heads.push(more.subject);
    } else if (trimSpace(query) !== "") {
      heads.push(...this.findSubjects(clip(trimSpace(query), 500), byMeaning === undefined ? undefined : (more.subjectsByMeaning ?? [])));
    }
    // What came to mind: the subjects of the memories listed, in order.
    const came: string[] = [];
    for (const r of results) if (r.subject !== "" && !came.includes(r.subject)) came.push(r.subject);
    const now = this.now();
    const asking = this.knownSession(session);
    let waiting = new Map<string, { waiting: number; ripe: number }>();
    if (came.length > 0 || heads.length > 0) {
      const hot = asking === "" ? [] : this.st.hotSessions(now - ripeAfter, asking);
      waiting = this.st.waitingBySubject([...new Set([...heads, ...came])], hot);
    }
    if (asking !== "" && came.length > 0) {
      view.prompt = this.promptFor(asking, now, came, waiting);
      if (view.prompt !== undefined) {
        this.st.notePrompted(asking);
        if (!heads.includes(view.prompt.subject)) heads.push(view.prompt.subject);
      }
    }
    view.subjects = this.subjectLines(heads, waiting);
    return view;
  }

  // findSubjects searches the subjects as a recall searches memories: by
  // keyword in their names and descriptions, and by the matches by meaning
  // given (undefined when there was no search by meaning), scored alike, and
  // returns the heads of the best few that reach the floor.
  private findSubjects(query: string, byMeaning?: MeaningHit[]): string[] {
    const terms = searchTerms(query);
    const keyword = new Map<string, number>();
    const byKeyword = this.st.searchSubjects(query, recallDepth(subjectsFound));
    const best = byKeyword[0]?.score ?? 0;
    for (const h of byKeyword) keyword.set(h.head, best > 0 ? h.score / best : 1);
    const meaning = new Map<string, number>();
    const found = this.st.byN((byMeaning ?? []).map((h) => h.n));
    for (const h of byMeaning ?? []) {
      const m = found.get(h.n);
      if (m !== undefined && m.kind === KindSubject && m.state === "" && !meaning.has(m.id)) meaning.set(m.id, h.score);
    }
    const ways = (byKeyword.length > 0 ? 1 : 0) + (meaning.size > 0 ? 1 : 0);
    if (ways === 0) return [];
    const subjects = new Map(this.st.subjects([...new Set([...keyword.keys(), ...meaning.keys()])]).map((s) => [s.id, s]));
    const scored: { head: string; relevance: number }[] = [];
    for (const [head, s] of subjects) {
      const k = keyword.get(head);
      const share = terms.length === 0 ? 1 : Math.max(covered(terms, s.name + "\n" + s.description), 1) / terms.length;
      scored.push({ head, relevance: ((k === undefined ? 0 : k * share) + (meaning.get(head) ?? 0)) / ways });
    }
    const top = Math.max(0, ...scored.map((x) => x.relevance));
    return scored
      .filter((x) => x.relevance >= relevanceFloor * top)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, subjectsFound)
      .map((x) => x.head);
  }

  // items finds or lists the memories of a recall: see recall.
  private items(
    query: string, limit: number, deep: boolean, session: string, byMeaning?: MeaningHit[],
    more: RecallMore = {},
  ): Result[] {
    query = trimSpace(query);
    if (limit <= 0) limit = DefaultRecall;
    else if (limit > MaxRecall) limit = MaxRecall;
    if (query === "") return this.list(more.span, limit, deep, more.subject);
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
      const byKeyword = this.st.searchText(text, clock, deep, depth, more.span, more.subject);
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
      // A subject is shown in a line of its own, never among memories.
      if (m.kind === KindSubject || (more.subject !== undefined && m.subject !== more.subject)) continue;
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
        replaced: [],
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
  // Kept to a subject (its head, or "" for the unsorted), it lists that
  // subject's memories alone.
  private list(span: Span | undefined, limit: number, deep: boolean, subject?: string): Result[] {
    const clock = this.st.clock();
    const ms = subject === undefined
      ? this.st.inSpanList(clock, span ?? {}, deep, limit)
      : this.st.inSubjectList(subject, clock, span ?? {}, deep, limit);
    return ms.map((m) => ({
      ...m, tier: tierOf(m, clock), score: 0, byKeyword: false, byMeaning: false, sources: [], readings: [], replaced: [],
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
    // The subjects the items are filed under, by their heads' names.
    const heads = new Map(
      this.st.subjects(ms.filter((m) => m.kind !== KindSubject && m.subject !== "").map((m) => m.subject)).map((s) => [s.id, s]),
    );
    for (const m of ms) {
      const r: Result = {
        ...m, tier: tierOf(m, clock), score: 0, byKeyword: false, byMeaning: false, sources: [], readings: [], replaced: [],
      };
      out.push(r);
      if (m.state === StateErased) continue; // there is nothing left to read
      if (m.kind === KindSubject) {
        // A subject is not a memory: reading it is not logged, and it does
        // not fade. Its head shows what it holds.
        r.replaced = this.st.replacedBy(m.id);
        const self = m.state === "" ? this.st.subjects([m.id])[0] : undefined;
        if (self !== undefined) {
          r.held = {
            figures: this.st.subjectFigures([m.id]).get(m.id)!,
            activeAt: self.activeAt,
            people: this.st.subjectPeople(m.id, peopleShown),
          };
        }
        continue;
      }
      const head = heads.get(m.subject);
      if (head !== undefined) r.subjectOf = { id: head.id, name: head.name };
      r.sources = this.st.sources(m.id);
      r.readings = this.st.readings(m.id);
      if (m.kind === KindLesson || m.kind === KindImpression) r.replaced = this.st.replacedBy(m.id);
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
  // batch of ripe fragments of one subject: see beginReflect in amend.ts.
  beginReflect(session: string, limit: number, subject?: string): ReflectView {
    return beginReflect(this.st, this.now(), session, limit, subject, ripeAfter);
  }

  // finishReflect writes a round of reflection back and returns the ids of
  // the memories it made, in the order of the entries. The subjects it
  // started for names that episodes and lessons gave are pushed onto
  // started.
  finishReflect(session: string, batch: string, entries: EntryRequest[], pass: string[], started: string[] = []): string[] {
    return finishReflect(this.st, this.now(), session, batch, entries, pass, started);
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
