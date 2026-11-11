// Changing a memory's standing or weight, correcting it, erasing what it
// says, and the preferences. Port of amend.go. The store methods in store.ts
// hold the transaction; these functions run inside it.

import { type Append, KindSelf, StateErased, StateSuperseded, writeMemory } from "./content";
import { bit, type Db, flag, num, text } from "./db";
import { clampStrength, crossings, isCore, type Params } from "./decay";
import { ErasedError, NoMemoryError, NoPreferenceError, NoSessionError, SupersededError, TooManyPreferencesError } from "./errors";
import { type AmendEvent, encodeAmend, encodeErase, type EraseEvent, kindAmend, kindErase } from "./events";
import type { RememberInput } from "./types";

// What amend can do to a memory.
export const AmendRetract = "retract"; // set aside: kept in the record, no longer recalled
export const AmendRestore = "restore"; // undo a retraction
export const AmendPin = "pin"; // keep as core, whatever its importance
export const AmendUnpin = "unpin";
export const AmendReweigh = "reweigh"; // change its importance

export const amendPrefer = "prefer"; // set a standing rule about what to remember
export const amendUnprefer = "unprefer"; // retire one

// needSession throws NoSessionError unless the session exists.
export function needSession(db: Db, id: string): void {
  if (db.first(`SELECT 1 AS k FROM sessions WHERE id = ?`, id) === undefined) throw new NoSessionError(id);
}

// Standing is where a memory stands.
export interface Standing {
  n: number;
  kind: string;
  state: string;
  stateBy: string;
}

// standing reads where a memory stands, or throws why it cannot be acted on.
export function standing(db: Db, id: string): Standing {
  const r = db.first(`SELECT n, kind, state, state_by FROM memories WHERE id = ?`, id);
  if (r === undefined) throw new NoMemoryError(id);
  const s = { n: num(r.n), kind: text(r.kind), state: text(r.state), stateBy: text(r.state_by) };
  if (s.state === StateErased) throw new ErasedError();
  return s;
}

// amendMemory changes a memory's standing or weight: action is one of the
// Amend constants, and importance is used by AmendReweigh alone. The memory
// itself is not rewritten; the change is one more event. Being amended counts
// as coming to mind, so the memory's decay starts over.
export function amendMemory(
  db: Db, append: Append, at: number, session: string, action: string, id: string, importance: number, reason: string,
): void {
  needSession(db, session);
  const { state, stateBy } = standing(db, id);
  switch (action) {
    case AmendRetract:
    case AmendRestore:
      break;
    case AmendPin:
    case AmendUnpin:
    case AmendReweigh:
      if (state === StateSuperseded) throw new SupersededError(stateBy);
      break;
    default:
      throw new Error(`unknown amend action ${JSON.stringify(action)}`);
  }
  append(at, kindAmend, encodeAmend({ session, action, id, importance, text: "", reason }));
}

// correctMemory writes a memory with the given id that replaces the one with
// id old. The old one stays in the record, marked as replaced, and leaves
// ordinary recall. The new one is of the same kind.
export function correctMemory(db: Db, append: Append, at: number, old: string, id: string, input: RememberInput): void {
  needSession(db, input.sessionId);
  const { kind, state, stateBy } = standing(db, old);
  if (state === StateSuperseded) throw new SupersededError(stateBy);
  writeMemory(
    db, append, at,
    {
      id, session: input.sessionId, kind, moment: input.moment, source: input.source,
      importance: input.importance, intensity: input.intensity ?? 0, hash: "", corrects: old,
      happened: input.happened ?? 0, from: [], ref: "", milestone: false,
    },
    {
      gist: input.gist, body: input.body, outcome: input.outcome, feeling: input.feeling,
      lesson: input.lesson, people: input.people, pointer: input.pointer,
    },
  );
}

// eraseMemory deletes what a memory says, for good. The log keeps the fact
// that the memory existed and that it was erased, and the memory keeps its
// place in the count of what was lived through. It returns the memory's row
// number.
export function eraseMemory(db: Db, append: Append, at: number, session: string, id: string, reason: string): number {
  needSession(db, session);
  const { n } = standing(db, id);
  db.run(`DELETE FROM contents WHERE id = ?`, id);
  append(at, kindErase, encodeErase({ session, id, reason }));
  // The keyword index keeps the words of a deleted row until its segments
  // are merged. Merge them now. There is no file to checkpoint here: the
  // platform keeps its own history (see the handbook).
  db.run(`INSERT INTO memories_fts(memories_fts) VALUES('optimize')`);
  return n;
}

// addPreference records a standing rule about what to remember, under the
// given id. At most max preferences can be in force.
export function addPreference(db: Db, append: Append, at: number, session: string, id: string, text: string, max: number): void {
  needSession(db, session);
  const inForce = num(db.first(`SELECT count(*) AS c FROM policies WHERE retired_at IS NULL`)?.c);
  if (inForce >= max) throw new TooManyPreferencesError();
  append(at, kindAmend, encodeAmend({ session, action: amendPrefer, id, importance: 0, text, reason: "" }));
}

// retirePreference takes a preference out of force. It stays in the log.
export function retirePreference(db: Db, append: Append, at: number, session: string, id: string, reason: string): void {
  needSession(db, session);
  if (db.first(`SELECT 1 AS k FROM policies WHERE id = ? AND retired_at IS NULL`, id) === undefined) {
    throw new NoPreferenceError(id);
  }
  append(at, kindAmend, encodeAmend({ session, action: amendUnprefer, id, importance: 0, text: "", reason }));
}

export function applyAmend(db: Db, p: Params, at: number, e: AmendEvent): void {
  switch (e.action) {
    case amendPrefer:
      db.run(
        `INSERT INTO policies(id, created_at, session_id, text, retired_at) VALUES(?, ?, ?, ?, NULL)`,
        e.id, at, e.session, e.text,
      );
      break;
    case amendUnprefer:
      db.run(`UPDATE policies SET retired_at = ? WHERE id = ? AND retired_at IS NULL`, at, e.id);
      break;
    default:
      applyStanding(db, p, e);
  }
  db.sessionActive(e.session, at);
}

// applyStanding applies an amendment to one memory. An id that names no
// memory is ignored.
function applyStanding(db: Db, p: Params, e: AmendEvent): void {
  const r = db.first(
    `SELECT importance, intensity, strength, pinned, retracted, kind, milestone FROM memories WHERE id = ?`, e.id,
  );
  if (r === undefined) return;
  let importance = num(r.importance);
  const intensity = num(r.intensity);
  let strength = num(r.strength);
  let pinned = flag(r.pinned);
  let retracted = flag(r.retracted);
  switch (e.action) {
    case AmendRetract:
      retracted = true;
      break;
    case AmendRestore:
      retracted = false;
      break;
    case AmendPin:
      pinned = true;
      break;
    case AmendUnpin:
      pinned = false;
      break;
    case AmendReweigh:
      // The same rule as at writing: each step of importance is a factor.
      strength = clampStrength(strength * Math.pow(4, 2 * (e.importance - importance)));
      importance = e.importance;
      break;
    default:
      throw new Error(`unknown amend action ${JSON.stringify(e.action)}`);
  }
  const clock = db.clock();
  // What made the memory core when it was written still does: Go asks only
  // about the pin and the weights here, so that amending a milestone or a
  // statement about oneself in any way, even retracting and restoring it,
  // set it fading.
  const core = pinned || isCore(p, importance, intensity) || text(r.kind) === KindSelf || flag(r.milestone);
  let fadeAt: number | null = null;
  let archiveAt: number | null = null;
  if (!core) ({ fadeAt, archiveAt } = crossings(p, clock, strength));
  db.run(
    `UPDATE memories SET importance = ?, strength = ?, pinned = ?, retracted = ?, core = ?,
       touched_ord = ?, fade_at = ?, archive_at = ? WHERE id = ?`,
    importance, strength, bit(pinned), bit(retracted), bit(core), clock, fadeAt, archiveAt, e.id,
  );
}

// applyErase empties what a memory says in the derived tables and drops its
// keyword entry. An id that names no memory is ignored. Its vector is not
// derived: Store.erase deletes it.
//
// Unlike Go it also empties about and context: they are part of what the
// memory said, and applyRemember never fills them in on a replay once the
// content is gone.
export function applyErase(db: Db, at: number, e: EraseEvent): void {
  const r = db.first(`SELECT n FROM memories WHERE id = ?`, e.id);
  if (r === undefined) return;
  const n = num(r.n);
  db.run(
    `UPDATE memories SET state = '${StateErased}', gist = '', body = '', outcome = '', feeling = '',
       lesson = '', people = '[]', pointer = '', about = '', context = '', hash = '' WHERE n = ?`,
    n,
  );
  db.run(`DELETE FROM memories_fts WHERE rowid = ?`, n);
  db.sessionActive(e.session, at);
}
