// Reflection: a round that turns fragments into accounts, lessons,
// impressions, statements about oneself and readings. Port of reflect.go.
// The store methods in store.ts hold the transaction; these functions run
// inside it.

import { needSession } from "./amend";
import {
  type Append,
  KindEpisode,
  KindFragment,
  KindReading,
  KindSelf,
  SourceReconstructed,
  StateErased,
  StateSuperseded,
  writeMemory,
} from "./content";
import { type Db, flag, inList, num, text } from "./db";
import type { Params } from "./decay";
import { EntryError, NoBatchError, ReflectBusyError } from "./errors";
import { encodeReflect, kindReflect, type ReflectEvent } from "./events";
import { goJSON, int, parseObject, str } from "./json";
import { metaReflect } from "./schema";

// Entry is one memory that a round of reflection writes back.
export interface Entry {
  kind: string; // KindEpisode, KindLesson, KindImpression, KindSelf or KindReading
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
}

// Rules for a statement about oneself. They are starting values.
export const selfMinSources = 3; // experiences a new statement must rest on
export const selfMinOrigins = 2; // separate occasions those must come from
export const selfMinNew = 2; // experiences a revision must add to those the revised statement rests on

// Lease is the open round of reflection. It is working state, not memory, so
// it lives in meta and not in the log.
interface Lease {
  batch: string;
  session: string;
  until: number; // unix milliseconds
}

function readLease(db: Db): Lease | undefined {
  const v = db.getMeta(metaReflect);
  if (v === undefined) return undefined;
  const o = parseObject(v, "reflect lease");
  return { batch: str(o, "batch"), session: str(o, "session"), until: int(o, "until") };
}

// beginReflect opens a round of reflection for the session under the given
// batch id. Only one round is open at a time: while another session's round
// has not run out, it throws ReflectBusyError, which says when that round ends.
export function beginReflect(db: Db, at: number, session: string, hold: number, batch: string): void {
  needSession(db, session);
  const cur = readLease(db);
  if (cur !== undefined && cur.session !== session && cur.until > at) throw new ReflectBusyError(cur.until);
  db.setMeta(metaReflect, goJSON({ batch, session, until: at + hold }));
}

// finishReflect writes a round of reflection back: the entries become
// memories with the given ids, the passed fragments are marked as looked at,
// and the round is closed. It throws before writing anything if any of it
// cannot be written; the caller's transaction makes that all or nothing.
export function finishReflect(
  db: Db, append: Append, at: number, session: string, batch: string, entries: Entry[], passed: string[], ids: string[],
): void {
  needSession(db, session);
  const cur = readLease(db);
  if (cur === undefined || cur.batch !== batch || cur.session !== session) throw new NoBatchError();
  // Check everything against the memory as it stands before any of it is
  // written.
  const sources = entries.map((e, i) => {
    try {
      return checkEntry(db, e);
    } catch (err) {
      if (err instanceof EntryError) throw new EntryError(err.msg, i);
      throw err;
    }
  });
  entries.forEach((e, i) => {
    writeMemory(
      db, append, at,
      {
        id: ids[i]!, session, kind: e.kind, moment: "", source: sources[i]!, importance: e.importance,
        intensity: e.intensity, hash: "", corrects: "", happened: 0, from: e.from, ref: e.ref, milestone: e.milestone,
      },
      {
        gist: e.gist, body: e.body, outcome: e.outcome, feeling: e.feeling, lesson: e.lesson,
        people: e.people, pointer: e.pointer, about: e.about, context: e.context,
      },
    );
  });
  append(at, kindReflect, encodeReflect({ session, batch, passed, wrote: ids.slice(0, entries.length) }));
  db.run(`DELETE FROM meta WHERE key = ?`, metaReflect);
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

// checkEntry checks an entry against the memory as it stands and returns the
// source the new memory is to carry. It throws EntryError with index 0.
export function checkEntry(db: Db, e: Entry): string {
  if (e.kind === KindReading) {
    loadBasis(db, e.ref);
    // Go does not look at what a reading says it is built on, and so links
    // it to ids that name nothing; check then reports a broken link.
    for (const id of new Set(e.from)) loadBasis(db, id);
    return "inferred"; // an understanding of an experience, not the experience
  }

  const from: Basis[] = [];
  const seen = new Set<string>();
  for (const id of e.from) {
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
  if (e.kind !== KindSelf) return source;

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
    return "lived";
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
  return "lived";
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
