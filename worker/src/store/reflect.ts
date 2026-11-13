// Reflection: a round that turns fragments into accounts, lessons,
// impressions, statements about oneself and readings. Port of reflect.go.
// The store methods in store.ts hold the transaction; these functions run
// inside it.

import { needSession } from "./amend";
import {
  type Append,
  KindEpisode,
  KindFragment,
  KindLesson,
  KindReading,
  KindSelf,
  KindSubject,
  SourceReconstructed,
  StateErased,
  StateSuperseded,
  writeMemory,
} from "./content";
import { type Db, flag, inList, num, text } from "./db";
import type { Params } from "./decay";
import { EntryError, NoBatchError, ReflectBusyError } from "./errors";
import { encodeReflect, kindReflect, type ReflectEvent } from "./events";
import { newID } from "./ids";
import { goJSON, int, parseObject, str } from "./json";
import { metaPrompted, metaReflect } from "./schema";
import { idForm, resolveSubject, subjectKey, writeSubjectItem } from "./subjects";

// Entry is one memory that a round of reflection writes back.
export interface Entry {
  kind: string; // KindEpisode, KindLesson, KindImpression, KindSelf, KindReading or KindSubject
  gist: string;
  body: string;
  outcome: string;
  feeling: string;
  intensity: number;
  lesson: string;
  people: string[];
  pointer: string;
  importance: number;
  about: string; // impression: who or what it is about
  context: string; // self: the situation the statement holds in
  from: string[]; // ids of the memories it is built on
  ref: string; // self: the statement it revises; reading: the memory it reads
  milestone: boolean; // episode: a milestone, kept for good
  // lesson, impression, subject: ids of earlier ones of the same kind this
  // takes the place of. Each is marked replaced by it, as a corrected memory
  // is.
  replaces: string[];
  // episode, lesson: its subject, by name or id, when not the round's;
  // subject: its name, or the id of the subject it revises. Already cleaned.
  subject?: string;
}

// maxFrom is how many ids an entry may rest on: the limit on from, which
// also caps what a lesson takes over from the lessons it replaces.
export const maxFrom = 20;

// Rules for a statement about oneself. They are starting values.
export const selfMinSources = 3; // experiences a new statement must rest on
export const selfMinOrigins = 2; // separate occasions those must come from
export const selfMinNew = 2; // experiences a revision must add to those the revised statement rests on

// Lease is the open round of reflection. It is working state, not memory, so
// it lives in meta and not in the log.
export interface Lease {
  batch: string;
  session: string;
  until: number; // unix milliseconds
  subject: string; // the head of the round's subject; "" for the unsorted
}

export function readLease(db: Db): Lease | undefined {
  const v = db.getMeta(metaReflect);
  if (v === undefined) return undefined;
  const o = parseObject(v, "reflect lease");
  return { batch: str(o, "batch"), session: str(o, "session"), until: int(o, "until"), subject: str(o, "subject") };
}

// promptedKept is how many sessions are remembered as asked to reflect.
export const promptedKept = 64;

// prompted reads the sessions already asked to reflect, oldest first.
export function prompted(db: Db): string[] {
  const v = db.getMeta(metaPrompted);
  if (v === undefined) return [];
  const o: unknown = JSON.parse(v);
  return Array.isArray(o) ? o.filter((x): x is string => typeof x === "string") : [];
}

// notePrompted records that the session was asked to reflect, or opened a
// round: it is not asked again. The newest promptedKept are kept.
export function notePrompted(db: Db, session: string): void {
  const was = prompted(db).filter((s) => s !== session);
  was.push(session);
  db.setMeta(metaPrompted, JSON.stringify(was.slice(-promptedKept)));
}

// beginReflect opens a round of reflection for the session under the given
// batch id, on the subject with the given head ("" for the unsorted). Only
// one round is open at a time: while another session's round has not run
// out, it throws ReflectBusyError, which says when that round ends. A
// session that opened a round is not asked to reflect again.
export function beginReflect(db: Db, at: number, session: string, hold: number, batch: string, subject = ""): void {
  needSession(db, session);
  const cur = readLease(db);
  if (cur !== undefined && cur.session !== session && cur.until > at) throw new ReflectBusyError(cur.until);
  db.setMeta(metaReflect, goJSON({ batch, session, until: at + hold, subject: subject === "" ? undefined : subject }));
  notePrompted(db, session);
}

// finishReflect writes a round of reflection back: the entries become
// memories with the given ids, the passed fragments are marked as looked at,
// and the round is closed. It throws before writing anything if any of it
// cannot be written; the caller's transaction makes that all or nothing.
//
// Subject items come first: one for each new name an episode or a lesson
// gives (implicit, not among the entries), then the subject entries; then
// the other entries, then the reflect event. The ids of the implicit subject
// items are pushed onto started.
export function finishReflect(
  db: Db, append: Append, at: number, session: string, batch: string, entries: Entry[], passed: string[], ids: string[],
  started: string[] = [],
): void {
  needSession(db, session);
  const cur = readLease(db);
  if (cur === undefined || cur.batch !== batch || cur.session !== session) throw new NoBatchError();
  // Check everything against the memory as it stands before any of it is
  // written.
  const at1 = (i: number, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      if (err instanceof EntryError && err.prefixed) throw new EntryError(err.msg, i);
      throw err;
    }
  };
  const named = new Set<string>();
  entries.forEach((e, i) =>
    at1(i, () => {
      // An item can take the place of another once: two entries of one
      // round may not both name it.
      for (const id of e.replaces) {
        if (named.has(id)) throw new EntryError(`${id} is named in replaces by an earlier entry of this round`);
        named.add(id);
      }
    }),
  );
  const plan = planSubjects(db, entries, ids, cur.subject, at1);
  const checked = entries.map((e, i) => {
    let c: Checked | undefined;
    at1(i, () => {
      c = e.kind === KindSubject ? checkSubjectEntry(db, e) : checkEntry(db, e);
    });
    return c!;
  });
  // The implicit subject items, then the subject entries, then the rest.
  for (const s of plan.implicit) {
    writeSubjectItem(db, append, at, session, s.id, { name: s.name, description: "", replaces: [], from: [] });
    started.push(s.id);
  }
  const order = [...entries.keys()].sort((a, b) => Number(entries[b]!.kind === KindSubject) - Number(entries[a]!.kind === KindSubject));
  for (const i of order) {
    const e = entries[i]!;
    if (e.kind === KindSubject) {
      const s = plan.subjects.get(i)!;
      writeSubjectItem(db, append, at, session, ids[i]!, { name: s.name, description: e.gist, replaces: s.replaces, from: checked[i]!.from });
      continue;
    }
    writeMemory(
      db, append, at,
      {
        id: ids[i]!, session, kind: e.kind, moment: "", source: checked[i]!.source, importance: e.importance,
        intensity: e.intensity, hash: "", corrects: "", happened: 0, from: checked[i]!.from, ref: e.ref, milestone: e.milestone,
        replaces: e.replaces, subject: plan.filed.get(i) ?? "",
      },
      {
        gist: e.gist, body: e.body, outcome: e.outcome, feeling: e.feeling, lesson: e.lesson,
        people: e.people, pointer: e.pointer, about: e.about, context: e.context,
      },
    );
  }
  append(at, kindReflect, encodeReflect({ session, batch, passed, wrote: ids.slice(0, entries.length) }));
  db.run(`DELETE FROM meta WHERE key = ?`, metaReflect);
}

// Plan is where a round's entries put things under subjects, worked out
// before anything is written.
interface Plan {
  // Subject entries, by index: the name the item is written with, and the
  // heads it takes the place of.
  subjects: Map<number, { name: string; replaces: string[] }>;
  // Episodes and lessons, by index: the subject item their event names.
  filed: Map<number, string>;
  // Subject items for new names that episodes and lessons give.
  implicit: { id: string; name: string }[];
}

// planSubjects resolves the subjects a round's entries name, and refuses
// what cannot be written. lease is the head of the round's subject, as it
// was when the round opened.
function planSubjects(
  db: Db, entries: Entry[], ids: string[], lease: string, at1: (i: number, fn: () => void) => void,
): Plan {
  const plan: Plan = { subjects: new Map(), filed: new Map(), implicit: [] };
  // What each subject entry is about: an existing head, or a new name's key.
  const about = new Map<string, number>(); // head or "key:" + key -> the first entry about it
  const fresh = new Map<string, number>(); // key of a new name -> the entry that introduces it
  const after = new Map<string, string>(); // head -> the subject entry that takes its place
  const same = (i: number, what: string): void => {
    const j = about.get(what);
    if (j !== undefined && j !== i) {
      throw new EntryError(`entry ${i + 1} is about the same subject as entry ${j + 1}: say it in one entry`, i, false);
    }
    about.set(what, i);
  };
  entries.forEach((e, i) => {
    if (e.kind !== KindSubject) return;
    at1(i, () => {
      const value = e.subject ?? "";
      const r = resolveSubject(db, value);
      if ("refused" in r) throw new EntryError(subjectWords(value, r.refused));
      if ("none" in r) throw new EntryError("unsorted is not a name for a subject: it means the moments that belong to none");
      const replaces: string[] = [];
      let name = value;
      if ("head" in r) {
        same(i, r.head);
        replaces.push(r.head);
        // Given by name, the subject takes the spelling given; by id, it
        // keeps its current name.
        if (idForm.test(value)) name = text(db.first(`SELECT about FROM memories WHERE id = ?`, r.head)?.about);
      } else {
        same(i, "key:" + r.key);
        fresh.set(r.key, i);
      }
      for (const id of e.replaces) {
        same(i, id);
        if (!replaces.includes(id)) replaces.push(id);
      }
      for (const h of replaces) after.set(h, ids[i]!);
      plan.subjects.set(i, { name, replaces });
    });
  });
  // Episodes and lessons: the subject given, else the round's.
  const implicit = new Map<string, string>(); // key -> id
  entries.forEach((e, i) => {
    if (e.kind !== KindEpisode && e.kind !== KindLesson) return;
    at1(i, () => {
      const value = e.subject ?? "";
      let head = "";
      if (value === "") {
        if (lease !== "") head = text(db.first(`SELECT subject FROM memories WHERE id = ? AND kind = ?`, lease, KindSubject)?.subject ?? "");
      } else {
        const key = subjectKey(value);
        const j = fresh.get(key);
        if (j !== undefined && !idForm.test(value)) {
          plan.filed.set(i, ids[j]!);
          return;
        }
        const r = resolveSubject(db, value);
        if ("refused" in r) throw new EntryError(subjectWords(value, r.refused));
        if ("head" in r) head = r.head;
        if ("fresh" in r) {
          let id = implicit.get(r.key);
          if (id === undefined) {
            id = newID("m_");
            implicit.set(r.key, id);
            plan.implicit.push({ id, name: value });
          }
          plan.filed.set(i, id);
          return;
        }
      }
      if (head !== "") plan.filed.set(i, after.get(head) ?? head);
    });
  });
  return plan;
}

// subjectWords says why a subject given by name or id cannot be used, in
// the words remember uses.
export function subjectWords(value: string, why: "no-letter" | "no-subject"): string {
  return why === "no-letter"
    ? `subject ${JSON.stringify(value)} has no letter or digit: give the subject a name`
    : `subject ${JSON.stringify(value)} names no subject: give a subject's name, or an id that get_context or recall shows for one`;
}

// checkSubjectEntry checks a subject entry's replaces and from against the
// memory as it stands: the subjects it takes the place of stand, and what it
// puts under itself are fragments, episodes and lessons that stand.
function checkSubjectEntry(db: Db, e: Entry): Checked {
  checkReplaces(db, e);
  for (const id of new Set(e.from)) {
    const b = loadBasis(db, id);
    if (b.state !== "" || (b.kind !== KindFragment && b.kind !== KindEpisode && b.kind !== KindLesson)) {
      throw new EntryError(`${id} cannot be put under a subject: only fragments, episodes and lessons that stand can`);
    }
  }
  return { source: "lived", from: [...new Set(e.from)] };
}

// abandonReflect closes a round without writing anything back, if it is
// still the one that is open.
export function abandonReflect(db: Db, session: string, batch: string): void {
  const cur = readLease(db);
  if (cur === undefined || cur.batch !== batch || cur.session !== session) return;
  db.run(`DELETE FROM meta WHERE key = ?`, metaReflect);
}

// Basis is a memory that an entry rests on, as far as the checks need it.
interface Basis {
  id: string;
  kind: string;
  state: string;
  source: string;
  session: string;
  retracted: boolean;
  happened: number;
}

function loadBasis(db: Db, id: string): Basis {
  const r = db.first(`SELECT kind, state, source, session_id, retracted, created_at FROM memories WHERE id = ?`, id);
  if (r === undefined) throw new EntryError(`${id} names no memory`);
  const b: Basis = {
    id, kind: text(r.kind), state: text(r.state), source: text(r.source), session: text(r.session_id),
    retracted: flag(r.retracted), happened: num(r.created_at),
  };
  if (b.state === StateErased) throw new EntryError(`${id} has been erased`);
  if (b.retracted) throw new EntryError(`${id} has been retracted`);
  return b;
}

// origin names the occasion a lived or reconstructed experience belongs to:
// the conversation it was written in, or the day it happened if it was
// reconstructed afterwards.
function origin(b: { source: string; session: string; happened: number }): string {
  if (b.source === SourceReconstructed) return "day " + new Date(b.happened).toISOString().slice(0, 10);
  return b.session;
}

// Checked is what the checks of an entry give the memory it becomes: its
// source, and the ids it rests on.
export interface Checked {
  source: string;
  from: string[];
}

// checkEntry checks an entry against the memory as it stands and returns the
// source the new memory is to carry and what it rests on. It throws
// EntryError with index 0.
export function checkEntry(db: Db, e: Entry): Checked {
  if (e.kind === KindReading) {
    loadBasis(db, e.ref);
    // Go does not look at what a reading says it is built on, and so links
    // it to ids that name nothing; check then reports a broken link.
    for (const id of new Set(e.from)) loadBasis(db, id);
    // An understanding of an experience, not the experience.
    return { source: "inferred", from: e.from };
  }

  checkReplaces(db, e);
  const ids = e.kind === KindLesson && e.replaces.length > 0 ? inherited(db, e) : e.from;
  const from: Basis[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const b = loadBasis(db, id);
    if (e.kind === KindEpisode && (b.kind !== KindFragment || b.state !== "")) {
      throw new EntryError(`${id} cannot go into an episode: an episode is put together from fragments that are not part of one yet`);
    }
    if (b.kind !== KindFragment && b.kind !== KindEpisode) {
      throw new EntryError(`${id} is a ${b.kind}: build on what was lived through, fragments and episodes`);
    }
    if (b.state === StateSuperseded) {
      throw new EntryError(`${id} has been replaced by a correction: build on the correction`);
    }
    from.push(b);
  }
  if (from.length === 0) throw new EntryError("from is required: the ids of the memories this rests on");
  let source = from[0]!.source;
  for (const b of from) if (b.source !== source) source = "lived";
  if (e.kind !== KindSelf) return { source, from: ids };

  // A statement about oneself rests on what was lived through, on several
  // separate occasions. What others said, and what was inferred, is no basis.
  const origins = new Set<string>();
  for (const b of from) {
    if (b.source !== "lived" && b.source !== SourceReconstructed) {
      throw new EntryError(`${b.id} is something you were told or inferred: a statement about yourself rests on what you lived through`);
    }
    if (b.kind === KindFragment) {
      origins.add(origin(b));
      continue;
    }
    for (const r of db.all(
      `SELECT m.source, m.session_id, m.created_at FROM links l JOIN memories m ON m.id = l.dst WHERE l.src = ?`, b.id,
    )) {
      origins.add(origin({ source: text(r.source), session: text(r.session_id), happened: num(r.created_at) }));
    }
  }
  if (e.ref === "") {
    if (from.length < selfMinSources || origins.size < selfMinOrigins) {
      throw new EntryError(
        `a statement about yourself needs at least ${selfMinSources} experiences from at least ${selfMinOrigins} separate occasions; ` +
          `this rests on ${from.length} from ${origins.size}. Leave it until it has shown up more often`,
      );
    }
    return { source: "lived", from: ids };
  }
  const revised = db.first(`SELECT kind, state FROM memories WHERE id = ? AND retracted = 0`, e.ref);
  if (revised === undefined || text(revised.kind) !== KindSelf || text(revised.state) !== "") {
    throw new EntryError(`${e.ref} is not a statement about yourself that stands: ref must name the one being revised`);
  }
  let fresh = 0;
  for (const b of from) {
    if (num(db.first(`SELECT count(*) AS c FROM links WHERE src = ? AND dst = ?`, e.ref, b.id)?.c) === 0) fresh++;
  }
  if (fresh < selfMinNew) {
    throw new EntryError(`a revision needs at least ${selfMinNew} experiences the statement does not already rest on; this adds ${fresh}`);
  }
  return { source: "lived", from: ids };
}

// checkReplaces checks that each item an entry names in replaces stands and
// is of the entry's kind. Which kinds may name any is checked before (see
// cleanEntry in memory/amend.ts).
function checkReplaces(db: Db, e: Entry): void {
  for (const id of e.replaces) {
    const r = db.first(`SELECT kind, state, state_by, retracted FROM memories WHERE id = ?`, id);
    if (r === undefined) throw new EntryError(`${id} in replaces names no memory`);
    const kind = text(r.kind);
    const state = text(r.state);
    if (state === StateErased) throw new EntryError(`${id} in replaces has been erased`);
    if (flag(r.retracted)) throw new EntryError(`${id} in replaces has been retracted: restore it first, or leave it out`);
    if (kind !== e.kind) throw new EntryError(`${id} in replaces is a ${kind}: a ${e.kind} takes the place of earlier ${e.kind}s only`);
    if (state !== "") throw new EntryError(`${id} in replaces has already been replaced, by ${text(r.state_by)}: name that one`);
  }
}

// inherited returns what a lesson with replaces rests on: the ids in its from,
// then what the lessons it replaces rest on, in the order they were written,
// without repeats, cut at maxFrom. What those lessons rest on and can no
// longer be built on (erased, retracted, replaced by a correction) is left
// out, since the entry did not name it.
function inherited(db: Db, e: Entry): string[] {
  const out = [...e.from];
  const rows = db.all(
    `SELECT l.dst AS id, m.kind, m.state, m.retracted FROM links l JOIN memories m ON m.id = l.dst
      WHERE l.src IN ${inList} ORDER BY m.n`,
    JSON.stringify(e.replaces),
  );
  for (const r of rows) {
    const id = text(r.id);
    const kind = text(r.kind);
    const state = text(r.state);
    if (out.includes(id) || flag(r.retracted) || state === StateErased || state === StateSuperseded) continue;
    if (kind !== KindFragment && kind !== KindEpisode) continue;
    out.push(id);
  }
  return out.slice(0, maxFrom);
}

// applyReflect marks the fragments a round passed over. Having been looked at
// and found not worth keeping together with anything, they leave ordinary
// recall sooner than they otherwise would, unless they come to mind again.
export function applyReflect(db: Db, p: Params, at: number, e: ReflectEvent): void {
  const clock = db.clock();
  const limit = clock + p.baseStrength / 2;
  if (e.passed.length > 0) {
    // One statement for the list; Go runs one per id, to the same effect.
    // The + keeps the planner off the index on kind, which would walk every
    // fragment, and on the ids it is given.
    db.run(
      `UPDATE memories SET reviewed = ?, fade_at = MIN(fade_at, ?), archive_at = MIN(archive_at, ?)
        WHERE id IN ${inList} AND +kind = ? AND state = '' AND reviewed IS NULL`,
      clock, limit, limit, JSON.stringify(e.passed), KindFragment,
    );
  }
  db.sessionActive(e.session, at);
}
