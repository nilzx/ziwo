// What a memory says, and how a remember event is projected. Port of
// content.go.

import { bit, type Db, inList, text } from "./db";
import { clampStrength, crossings, initialStrength, isCore, type Params } from "./decay";
import { encodeRemember, kindRemember, type RememberEvent } from "./events";
import { contentHash, sha256Hex } from "./ids";
import { goJSON, parseObject, str, strs } from "./json";
import { indexText } from "./segment";

// Kinds of memory.
export const KindFragment = "fragment"; // a moment, written as it happened; waits to be reflected on
export const KindEpisode = "episode"; // an account put together from fragments
export const KindLesson = "lesson"; // something to carry forward, drawn from experience
export const KindImpression = "impression"; // how a person or a thing has come across
export const KindSelf = "self"; // a statement about oneself, grown from experience
export const KindReading = "reading"; // a later understanding of an earlier memory

// SourceReconstructed marks a memory written afterwards from a record of what
// happened, rather than at the moment.
export const SourceReconstructed = "reconstructed";

// Standing of a memory that is no longer live.
export const StateSuperseded = "superseded"; // a correction or a newer version replaced it
export const StateAbsorbed = "absorbed"; // an episode was put together from it
export const StateErased = "erased"; // its content was deleted for good

// Content is what a memory says: everything in it that is prose. It is kept
// apart from the event that records the memory so that it can be erased.
export interface Content {
  gist: string;
  body?: string;
  outcome?: string;
  feeling?: string;
  lesson?: string;
  people?: string[];
  pointer?: string;
  about?: string; // impression: who or what it is about
  context?: string; // self: the situation the statement holds in
}

const omit = (s: string | undefined): string | undefined => (s === undefined || s === "" ? undefined : s);

// encodeContent returns the stored form of the content and the hash its event
// keeps. The stored form is what Go's json.Marshal makes of its content
// struct: the same fields in the same order, empty ones left out.
export function encodeContent(c: Content): { data: string; hash: string } {
  const data = goJSON({
    gist: c.gist,
    body: omit(c.body),
    outcome: omit(c.outcome),
    feeling: omit(c.feeling),
    lesson: omit(c.lesson),
    people: c.people !== undefined && c.people.length > 0 ? c.people : undefined,
    pointer: omit(c.pointer),
    about: omit(c.about),
    context: omit(c.context),
  });
  return { data, hash: sha256Hex(data) };
}

// A content read back, every field present.
type FullContent = Required<Content>;

// loadContent reads what the memory with the given id says, or undefined when
// the content has been erased.
export function loadContent(db: Db, id: string): FullContent | undefined {
  const row = db.first(`SELECT data FROM contents WHERE id = ?`, id);
  if (row === undefined) return undefined;
  const o = parseObject(text(row.data), "content " + id);
  return {
    gist: str(o, "gist"),
    body: str(o, "body"),
    outcome: str(o, "outcome"),
    feeling: str(o, "feeling"),
    lesson: str(o, "lesson"),
    people: strs(o, "people"),
    pointer: str(o, "pointer"),
    about: str(o, "about"),
    context: str(o, "context"),
  };
}

// Append writes one event and applies it to the derived tables.
export type Append = (at: number, kind: string, payload: string) => number;

// writeMemory stores what a new memory says and appends the event that records
// it. The event carries the content's hash, not the content.
export function writeMemory(db: Db, append: Append, at: number, e: RememberEvent, c: Content): void {
  const { data, hash } = encodeContent(c);
  const ev: RememberEvent = { ...e, hash, kind: e.kind === KindFragment ? "" : e.kind, replaces: undefined };
  if (ev.kind === KindImpression && ev.corrects === "") {
    // Name what it takes the place of now, while what they are about can
    // still be read: a replay must replace the same ones even if one of them,
    // or this one, is erased later. These are the rows the match on about in
    // applyRemember would reach.
    const ids = db
      .all(
        `SELECT id FROM memories WHERE kind = ? AND about = ? AND state = '' AND id <> ? ORDER BY n`,
        KindImpression, c.about ?? "", ev.id,
      )
      .map((r) => text(r.id));
    if (ids.length > 0) ev.replaces = ids;
  }
  db.run(`INSERT INTO contents(id, data) VALUES(?, ?)`, ev.id, data);
  append(at, kindRemember, encodeRemember(ev));
}

// ticks reports whether writing this memory advances the experience clock.
// Only a moment written as it happens does. An account put together later, a
// correction, and what is reconstructed from a record add nothing new to what
// was lived through, so they must not push other memories further away.
export function ticks(e: RememberEvent): boolean {
  return e.kind === "" && e.corrects === "" && e.source !== SourceReconstructed;
}

// kindFactor scales the starting strength of a memory by its kind: an account
// outlasts the moments it was made from, an impression outlasts that, and a
// lesson lasts longest.
export function kindFactor(kind: string): number {
  switch (kind) {
    case KindEpisode:
      return 2;
    case KindImpression:
      return 3;
    case KindLesson:
      return 4;
  }
  return 1;
}

// applyRemember projects a remember event. What the memory says is read from
// the contents table. If it is gone, the memory is still counted, because it
// was lived through, but it says nothing.
//
// Such a memory stands until its erase event marks it erased, unlike in Go,
// where it is marked erased here. That way the events between the two (a
// correction, a newer impression, an episode that absorbs it) do to it on a
// replay what they did when they were lived. A memory whose content is gone
// with no erase event in the log was lost; the rebuild marks it erased after
// the last event (see rebuildInTx). Its hash is empty until then: that is how
// the rebuild finds it.
export function applyRemember(db: Db, p: Params, seq: number, at: number, e: RememberEvent): void {
  const loaded = loadContent(db, e.id);
  const kept = loaded !== undefined;
  const c: FullContent = loaded ?? {
    gist: "", body: "", outcome: "", feeling: "", lesson: "", people: [], pointer: "", about: "", context: "",
  };
  const kind = e.kind === "" ? KindFragment : e.kind;
  const hash = kept ? contentHash(c.gist, c.body) : "";
  const people = c.people;

  const clock = db.clock();
  let ord = clock;
  if (ticks(e)) {
    ord = clock + 1;
    db.setClock(ord);
  }
  const core = isCore(p, e.importance, e.intensity) || kind === KindSelf || e.milestone;
  const strength = clampStrength(initialStrength(p, e.importance, e.intensity, e.source) * kindFactor(kind));
  let fadeAt: number | null = null; // NULL for a core memory
  let archiveAt: number | null = null;
  if (!core) ({ fadeAt, archiveAt } = crossings(p, ord, strength));
  const happened = e.happened > 0 ? e.happened : at;
  const reviewed = kind !== KindFragment ? ord : null; // a fragment waits for reflect

  db.run(
    `INSERT INTO memories(n, id, created_at, written_at, session_id, kind, moment, source, importance, intensity,
       gist, body, outcome, feeling, lesson, people, pointer, about, context, ref, milestone,
       hash, last_recalled_at, recall_count, ord, touched_ord, read_ord, core, strength, fade_at, archive_at,
       reviewed, state, state_by, retracted, pinned, corrects)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, ?)`,
    seq, e.id, happened, at, e.session, kind, e.moment, e.source, e.importance, e.intensity,
    c.gist, c.body, c.outcome, c.feeling, c.lesson, goJSON(people), c.pointer, c.about, c.context, e.ref, bit(e.milestone),
    hash, at, ord, ord, ord, bit(core), strength, fadeAt, archiveAt, reviewed, "", e.corrects,
  );
  if (kept) {
    const rest = [c.body, c.outcome, c.feeling, c.lesson, c.pointer, c.about, c.context, ...people].join("\n");
    db.run(`INSERT INTO memories_fts(rowid, gist, rest) VALUES(?, ?, ?)`, seq, indexText(c.gist), indexText(rest));
  }
  for (const src of e.from) {
    db.run(`INSERT OR IGNORE INTO links(src, dst) VALUES(?, ?)`, e.id, src);
  }

  // What the new memory takes the place of stays in the record and leaves
  // ordinary recall.
  const replace = (where: string, ...args: string[]): void => {
    db.run(
      `UPDATE memories SET state = ?, state_by = ? WHERE state = '' AND id <> ? AND ` + where,
      StateSuperseded, e.id, e.id, ...args,
    );
  };
  if (e.corrects !== "") {
    replace(`id = ?`, e.corrects);
  } else if (kind === KindSelf && e.ref !== "") {
    replace(`id = ? AND kind = ?`, e.ref, KindSelf);
  } else if (kind === KindImpression && e.replaces !== undefined) {
    // The + keeps the planner on the ids rather than every impression.
    replace(`+kind = ? AND id IN ${inList}`, KindImpression, JSON.stringify(e.replaces));
  } else if (kind === KindImpression && kept) {
    // A log the Go build wrote: what it replaces is found by what it is about.
    replace(`kind = ? AND about = ?`, KindImpression, c.about);
  } else if (kind === KindEpisode) {
    // The fragments it was put together from are now part of it.
    for (const src of e.from) {
      db.run(
        `UPDATE memories SET state = ?, state_by = ?, reviewed = ? WHERE id = ? AND kind = ? AND state = ''`,
        StateAbsorbed, e.id, ord, src, KindFragment,
      );
    }
  }
  db.sessionActive(e.session, at);
}
