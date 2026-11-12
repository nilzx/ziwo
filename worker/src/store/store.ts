// The append-only event log and the tables derived from it. Port of store.go.
//
// Every change to a memory is written as an event and then applied to the
// derived tables in the same transaction. Rebuild replays the log through the
// same apply function, so the derived tables are always a function of the
// events and the forgetting parameters. Every method is synchronous, and every
// method that writes is one ctx.storage.transactionSync.

import {
  addPreference,
  amendMemory,
  applyAmend,
  applyErase,
  correctMemory,
  eraseMemory,
  retirePreference,
} from "./amend";
import {
  type Append,
  applyRemember,
  KindFragment,
  KindImpression,
  KindReading,
  KindSelf,
  StateAbsorbed,
  StateErased,
  StateSuperseded,
  writeMemory,
} from "./content";
import { checkStore, type Report } from "./check";
import { isActiveBand, isArchived, isFadedBand, isListed, isLive, isPending, notArchived, notYetFaded } from "./conditions";
import { type Binding, Db, flag, inList, isConstraint, num, realOrZero, type Row, text, type Usage } from "./db";
import {
  crossings,
  defaultParams,
  InvalidParamsError,
  type Params,
  reinforced,
  retention,
  type TierCounts,
  validateParams,
} from "./decay";
import {
  decodeAmend,
  decodeErase,
  decodeExpand,
  decodeRecall,
  decodeReflect,
  decodeRemember,
  decodeRestore,
  decodeSession,
  encodeExpand,
  encodeRestore,
  encodeRecall,
  encodeSession,
  kindAmend,
  kindErase,
  kindExpand,
  kindRecall,
  kindReflect,
  kindRemember,
  kindRestore,
  kindSession,
} from "./events";
import { NoSessionError } from "./errors";
import type { ParsedExport } from "./export";
import { contentHash, newID } from "./ids";
import { abandonReflect, applyReflect, beginReflect, type Entry, finishReflect } from "./reflect";
import { matchQuery } from "./segment";
import {
  clearIndex,
  derivedSchema,
  derivedVersion,
  dropDerived,
  dropIndex,
  indexSchema,
  indexVersion,
  logFormat,
  logSchema,
  metaDerived,
  metaIndex,
  metaInstance,
  metaLogFormat,
  metaParams,
  metaTokenHash,
  metaVectorsFull,
  metaVectorsFullAt,
  metaVectorsLabel,
  metaVectorsSeen,
  metaZone,
} from "./schema";
import { type HeldFigure, type Label, VectorRows, type VectorHit } from "./vectors";
import { UTC } from "../zone";
import type {
  CarrierNote,
  LogStats,
  Memory,
  Preference,
  RecallNote,
  RememberInput,
  RestoreNote,
  Session,
  Span,
  TextHit,
} from "./types";

// dedupWindow is how far back remember looks for an identical memory before
// writing a new one. It absorbs retried tool calls.
export const dedupWindow = 10 * 60 * 1000;

export {
  EntryError,
  ErasedError,
  NoBatchError,
  NoMemoryError,
  NoPreferenceError,
  NoSessionError,
  ReflectBusyError,
  SupersededError,
  TooManyPreferencesError,
} from "./errors";

// LogFormatError is thrown when the event log was written in a format this
// build does not read. newer tells a log from a later build (which Go refuses
// too) from one in a format before 3 (which Go would have migrated).
export class LogFormatError extends Error {
  override name = "LogFormatError";
  constructor(
    readonly format: number,
    readonly newer: boolean,
  ) {
    super(
      newer
        ? `written by a newer version of ziwo: its log format is ${format}, this build reads up to ${logFormat}`
        : `log format ${format} is older than ${logFormat} and is not migrated on this platform`,
    );
  }
}

// ReplayError wraps what went wrong applying one event during a rebuild.
export class ReplayError extends Error {
  override name = "ReplayError";
  constructor(
    readonly seq: number,
    cause: unknown,
  ) {
    super(`replay event ${seq}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

// How many times a write is retried when a freshly drawn id collides.
const idRetries = 3;

const memorySelect = `SELECT m.n, m.id, m.created_at, m.written_at, m.session_id, COALESCE(s.model, '') AS model,
  COALESCE(s.client, '') AS client, m.moment, m.source, m.importance, m.intensity, m.gist, m.body, m.outcome,
  m.feeling, m.lesson, m.people, m.pointer, m.last_recalled_at, m.recall_count, m.ord, m.touched_ord, m.read_ord,
  m.core, m.strength, m.fade_at, m.archive_at, m.kind, m.state, m.state_by, m.retracted, m.pinned, m.corrects,
  m.about, m.context, m.ref, m.milestone, m.reviewed IS NULL AS unreviewed
FROM memories m`;
const memoryJoin = ` LEFT JOIN sessions s ON s.id = m.session_id `;

// spanCond is the condition on memories m that keeps them to span, with its
// arguments. created_at is when a memory took place.
function spanCond(span: Span): { cond: string; args: number[] } {
  let cond = "";
  const args: number[] = [];
  if (span.since !== undefined) {
    cond += " AND m.created_at >= ?";
    args.push(span.since);
  }
  if (span.until !== undefined) {
    cond += " AND m.created_at <= ?";
    args.push(span.until);
  }
  return { cond, args };
}

function paramsJSON(p: Params): string {
  // Fixed key order, so that equal parameters give an equal derived mark.
  return JSON.stringify({
    baseStrength: p.baseStrength,
    recallBoost: p.recallBoost,
    fadeBelow: p.fadeBelow,
    archiveBelow: p.archiveBelow,
    coreImportance: p.coreImportance,
    coreFeeling: p.coreFeeling,
  });
}

// parseParams reads the parameters kept in meta.
export function parseParams(v: string): Params {
  const o: unknown = JSON.parse(v);
  if (typeof o !== "object" || o === null) throw new InvalidParamsError(`meta: unreadable params`);
  const p = defaultParams();
  for (const key of Object.keys(p) as (keyof Params)[]) {
    const x = (o as Record<string, unknown>)[key];
    if (x === undefined) continue;
    if (typeof x !== "number") throw new InvalidParamsError(`meta: params.${key} is not a number`);
    p[key] = x;
  }
  validateParams(p);
  return p;
}

// Store is one memory: its event log and projections, in the SQLite database
// of one Durable Object.
export class Store {
  private readonly db: Db;
  private readonly vec: VectorRows;
  private p: Params = defaultParams();
  private readonly append: Append = (at, kind, payload) => this.appendEvent(at, kind, payload);

  // The constructor creates the log tables if needed, checks the log format,
  // and brings the derived tables up to date with the log and the parameters.
  // It does so in two transactions, so that the keyword index exists before
  // the one that replays the log into it: see indexSchema.
  constructor(private readonly storage: DurableObjectStorage) {
    this.db = new Db(storage.sql);
    this.vec = new VectorRows(this.db);
    this.tx(() => this.init());
    this.tx(() => {
      if (this.db.getMeta(metaDerived) !== this.derivedMark()) this.rebuildInTx();
    });
  }

  // tx runs fn in one transaction. If it fails after changing the loaded
  // vectors, they are dropped, to be loaded again as stored.
  private tx<T>(fn: () => T): T {
    this.vec.touched = false;
    try {
      return this.storage.transactionSync(fn);
    } catch (err) {
      if (this.vec.touched) this.vec.forget();
      throw err;
    }
  }

  private init(): void {
    this.db.run(logSchema);
    this.checkLogFormat();
    if (this.db.getMeta(metaInstance) === undefined) this.db.setMeta(metaInstance, newID("i_"));
    const stored = this.db.getMeta(metaParams);
    this.p = stored === undefined ? defaultParams() : parseParams(stored);
    if (this.db.getMeta(metaIndex) !== indexVersion) {
      this.db.run(dropIndex + indexSchema);
      this.db.setMeta(metaIndex, indexVersion);
      // Whatever was indexed is gone, so the log has to be replayed.
      this.db.run(`DELETE FROM meta WHERE key = ?`, metaDerived);
    }
  }

  private checkLogFormat(): void {
    const have = this.db.getMeta(metaLogFormat);
    if (have === undefined) {
      const events = num(this.db.first(`SELECT count(*) AS c FROM events`)?.c);
      // A log with events and no recorded format predates versioning.
      if (events > 0) throw new LogFormatError(0, false);
      this.db.setMeta(metaLogFormat, String(logFormat));
      return;
    }
    if (!/^[+-]?\d+$/.test(have)) throw new Error(`unreadable log format ${JSON.stringify(have)}`);
    const format = Number(have);
    if (format !== logFormat) throw new LogFormatError(format, format > logFormat);
  }

  // derivedMark identifies what the derived tables were built from, apart
  // from the events themselves.
  private derivedMark(): string {
    return `${derivedVersion} ${paramsJSON(this.p)}`;
  }

  // params returns the forgetting parameters of this memory.
  params(): Params {
    return { ...this.p };
  }

  // setParams validates and stores new forgetting parameters and, if they
  // differ from the current ones, rebuilds the derived tables with them.
  setParams(p: Params): void {
    const next = { ...p };
    validateParams(next);
    const prev = this.p;
    try {
      this.tx(() => {
        this.p = next;
        this.db.setMeta(metaParams, paramsJSON(next));
        if (this.db.getMeta(metaDerived) !== this.derivedMark()) this.rebuildInTx();
      });
    } catch (err) {
      this.p = prev;
      throw err;
    }
  }

  // rebuild drops the derived tables and replays the whole event log into them.
  rebuild(): void {
    this.tx(() => this.rebuildInTx());
  }

  // rebuildInTx replays the log inside the caller's transaction. If an event
  // cannot be applied it throws, and the transaction leaves every table as it
  // was.
  private rebuildInTx(): void {
    this.db.run(dropDerived + derivedSchema);
    this.db.run(clearIndex);
    this.db.setClock(0);
    let after = 0;
    for (;;) {
      const batch = this.db.all(`SELECT seq, at, kind, payload FROM events WHERE seq > ? ORDER BY seq LIMIT 500`, after);
      if (batch.length === 0) break;
      for (const e of batch) {
        const seq = num(e.seq);
        try {
          this.apply(seq, num(e.at), text(e.kind), text(e.payload));
        } catch (err) {
          throw new ReplayError(seq, err);
        }
      }
      after = num(batch[batch.length - 1]!.seq);
    }
    // A memory whose content was gone when its event was applied, and that
    // no erase event marked since, lost its content: mark it erased, as Go
    // does when it applies the event. Only such a memory has an empty hash
    // and stands otherwise; the hash index finds it.
    this.db.run(`UPDATE memories SET state = '${StateErased}' WHERE hash = '' AND state <> '${StateErased}'`);
    this.vec.removeOrphans();
    this.db.setMeta(metaDerived, this.derivedMark());
  }

  // appendEvent writes one event and applies it to the derived tables. The
  // caller holds the transaction.
  private appendEvent(at: number, kind: string, payload: string): number {
    const seq = num(
      this.db.first(`INSERT INTO events(at, kind, payload) VALUES(?, ?, ?) RETURNING seq`, at, kind, payload)?.seq,
    );
    this.apply(seq, at, kind, payload);
    return seq;
  }

  // apply projects one event onto the derived tables. It depends only on its
  // arguments, on the forgetting parameters, and on what earlier events put in
  // those tables (the clock in meta among them). It never reads the wall clock.
  private apply(seq: number, at: number, kind: string, payload: string): void {
    switch (kind) {
      case kindSession: {
        const e = decodeSession(payload);
        this.db.run(
          `INSERT INTO sessions(id, started_at, last_active_at, model, client, tz) VALUES(?, ?, ?, ?, ?, ?)`,
          e.id, at, at, e.model, e.client, e.tz ?? "",
        );
        const carrier = carrierKey(e.model);
        if (carrier === "") return;
        this.db.run(
          `INSERT INTO carriers(model, first_seen, last_seen, sessions) VALUES(?, ?, ?, 1)
           ON CONFLICT(model) DO UPDATE SET last_seen = excluded.last_seen, sessions = sessions + 1`,
          carrier, at, at,
        );
        return;
      }
      case kindRemember:
        return applyRemember(this.db, this.p, seq, at, decodeRemember(payload));
      case kindRecall: {
        const e = decodeRecall(payload);
        return this.cameToMind(e.session, e.ids, at, e.clock, false);
      }
      case kindExpand: {
        const e = decodeExpand(payload);
        return this.cameToMind(e.session, e.ids, at, e.clock, true);
      }
      case kindAmend:
        return applyAmend(this.db, this.p, at, decodeAmend(payload));
      case kindErase:
        return applyErase(this.db, at, decodeErase(payload));
      case kindReflect:
        return applyReflect(this.db, this.p, at, decodeReflect(payload));
      case kindRestore: {
        const e = decodeRestore(payload);
        this.db.run(`INSERT OR REPLACE INTO restores(at, exported_at, events) VALUES(?, ?, ?)`, at, e.exportedAt, e.events);
        return;
      }
      default:
        throw new Error(`unknown event kind ${JSON.stringify(kind)}`);
    }
  }

  // cameToMind applies one listing or reading to the memories with the given
  // ids. Either restarts their decay from the clock at which it happened. Only
  // a reading strengthens them, by how far they had faded since they were last
  // read. Ids that name no memory are ignored.
  //
  // when is the experience clock at which they came to mind, or zero for now.
  // It is never later than now, and nothing moves a memory's clocks backwards.
  private cameToMind(session: string, ids: string[], at: number, when: number, read: boolean): void {
    const now = this.db.clock();
    if (when <= 0 || when > now) when = now;
    for (const id of ids) {
      const r = this.db.first(`SELECT core, strength, touched_ord, read_ord FROM memories WHERE id = ?`, id);
      if (r === undefined) continue;
      const core = flag(r.core);
      let strength = num(r.strength);
      const touchedOrd = Math.max(num(r.touched_ord), when);
      let readOrd = num(r.read_ord);
      if (read) {
        strength = reinforced(this.p, strength, retention(strength, when - readOrd));
        readOrd = Math.max(readOrd, when);
      }
      let fadeAt: number | null = null;
      let archiveAt: number | null = null;
      if (!core) ({ fadeAt, archiveAt } = crossings(this.p, touchedOrd, strength));
      this.db.run(
        `UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = MAX(last_recalled_at, ?),
           touched_ord = ?, read_ord = ?, strength = ?, fade_at = ?, archive_at = ? WHERE id = ?`,
        at, touchedOrd, readOrd, strength, fadeAt, archiveAt, id,
      );
    }
    this.db.sessionActive(session, at);
  }

  // clock returns the experience clock: the number of moments written as they
  // happened.
  clock(): number {
    return this.db.clock();
  }

  // retry runs a write again with a fresh id when the one drawn collided.
  private retry<T>(write: () => T): T {
    for (let attempt = 0; ; attempt++) {
      try {
        return this.tx(write);
      } catch (err) {
        if (!isConstraint(err) || attempt >= idRetries) throw err;
      }
    }
  }

  // startSession records the start of a session and reports whether its model
  // is new to this memory. tz is the time zone the model reported, already
  // checked, or "".
  startSession(at: number, model: string, client: string, tz = ""): { session: Session; note: CarrierNote } {
    return this.retry(() => {
      const session: Session = { id: newID("s_"), startedAt: at, lastActiveAt: at, model, client, tz };
      const carrier = carrierKey(model);
      const note = carrier === "" ? { first: false, earlier: [] } : this.carrierNote(carrier);
      this.appendEvent(at, kindSession, encodeSession({ id: session.id, model, client, tz }));
      return { session, note };
    });
  }

  // model is a carrier's key, as carrierKey gives it.
  private carrierNote(model: string): CarrierNote {
    const known = this.db.first(`SELECT 1 AS k FROM carriers WHERE model = ?`, model) !== undefined;
    const earlier = this.db
      .all(`SELECT model FROM carriers WHERE model <> ? ORDER BY last_seen DESC, model LIMIT 3`, model)
      .map((r) => text(r.model));
    return { first: !known && earlier.length > 0, earlier };
  }

  private sessions(tail: string, ...args: Binding[]): Session[] {
    return this.db
      .all(`SELECT id, started_at, last_active_at, model, client, tz FROM sessions ` + tail, ...args)
      .map((r) => ({
        id: text(r.id),
        startedAt: num(r.started_at),
        lastActiveAt: num(r.last_active_at),
        model: text(r.model),
        client: text(r.client),
        tz: text(r.tz),
      }));
  }

  // session looks up a session by id.
  session(id: string): Session | undefined {
    return this.sessions(`WHERE id = ?`, id)[0];
  }

  // activeSessions returns the sessions, other than except, that loaded, wrote
  // or recalled at or after since, most recently active first.
  activeSessions(since: number, except: string, limit: number): Session[] {
    return this.sessions(
      `WHERE last_active_at >= ? AND id <> ? ORDER BY last_active_at DESC, id LIMIT ?`,
      since, except, limit,
    );
  }

  // remember writes a new memory and returns its id. If an identical memory
  // was written within dedupWindow, it returns that memory's id and dup true.
  // It throws NoSessionError when the session does not exist.
  remember(at: number, input: RememberInput): { id: string; dup: boolean } {
    const hash = contentHash(input.gist, input.body);
    const since = at - dedupWindow;
    return this.retry(() => {
      // The session comes first: a write that names no known conversation is
      // refused even when it repeats a recent one.
      if (this.db.first(`SELECT 1 AS k FROM sessions WHERE id = ?`, input.sessionId) === undefined) {
        throw new NoSessionError(input.sessionId);
      }
      const existing = this.db.first(
        `SELECT id FROM memories WHERE hash = ? AND written_at >= ? ORDER BY n DESC LIMIT 1`,
        hash, since,
      );
      if (existing !== undefined) return { id: text(existing.id), dup: true };
      const id = newID("m_");
      writeMemory(
        this.db,
        this.append,
        at,
        {
          id, session: input.sessionId, kind: "", moment: input.moment, source: input.source,
          importance: input.importance, intensity: input.intensity ?? 0, hash: "", corrects: "",
          happened: input.happened ?? 0, from: [], ref: "", milestone: false,
        },
        {
          gist: input.gist, body: input.body, outcome: input.outcome, feeling: input.feeling,
          lesson: input.lesson, people: input.people, pointer: input.pointer,
        },
      );
      return { id, dup: false };
    });
  }

  // amend changes a memory's standing or weight: action is one of the Amend
  // constants in amend.ts, and importance is used by reweigh alone. Being
  // amended counts as coming to mind, so the memory's decay starts over.
  amend(at: number, session: string, action: string, id: string, importance: number, reason: string): void {
    this.tx(() => amendMemory(this.db, this.append, at, session, action, id, importance, reason));
  }

  // correct writes a memory that replaces the one with id old, and returns
  // the new memory's id. The old one stays in the record, marked as
  // replaced, and leaves ordinary recall. The new one is of the same kind.
  correct(at: number, old: string, input: RememberInput): string {
    return this.retry(() => {
      const id = newID("m_");
      correctMemory(this.db, this.append, at, old, id, input);
      return id;
    });
  }

  // erase deletes what a memory says, for good, and returns the memory's row
  // number. The log keeps the fact that the memory existed and that it was
  // erased.
  erase(at: number, session: string, id: string, reason: string): number {
    return this.tx(() => {
      const n = eraseMemory(this.db, this.append, at, session, id, reason);
      // Its vector goes in the same transaction, under every label.
      this.vec.remove([n]);
      return n;
    });
  }

  // addPreference records a standing rule about what to remember and returns
  // its id. At most max preferences can be in force.
  addPreference(at: number, session: string, text: string, max: number): string {
    return this.retry(() => {
      const id = newID("p_");
      addPreference(this.db, this.append, at, session, id, text, max);
      return id;
    });
  }

  // retirePreference takes a preference out of force. It stays in the log.
  retirePreference(at: number, session: string, id: string, reason: string): void {
    this.tx(() => retirePreference(this.db, this.append, at, session, id, reason));
  }

  // beginReflect opens a round of reflection for the session, held for hold
  // milliseconds, and returns its batch id. While another session's round has
  // not run out it throws ReflectBusyError.
  beginReflect(at: number, session: string, hold: number): string {
    const batch = newID("b_");
    this.tx(() => beginReflect(this.db, at, session, hold, batch));
    return batch;
  }

  // finishReflect writes a round of reflection back and returns the ids of
  // the new memories, in the order of the entries. Nothing is written unless
  // everything can be.
  finishReflect(at: number, session: string, batch: string, entries: Entry[], passed: string[]): string[] {
    return this.retry(() => {
      const ids = entries.map(() => newID("m_"));
      finishReflect(this.db, this.append, at, session, batch, entries, passed, ids);
      return ids;
    });
  }

  // abandonReflect closes a round without writing anything back, if it is
  // still the one that is open.
  abandonReflect(session: string, batch: string): void {
    this.tx(() => abandonReflect(this.db, session, batch));
  }

  // logRecalls appends one event per note, in one transaction: memories were
  // listed, or read. On this platform it is called in the same call that
  // listed or read them.
  logRecalls(notes: RecallNote[]): void {
    if (notes.length === 0) return;
    this.tx(() => {
      for (const n of notes) {
        const session = n.session ?? "";
        const clock = n.clock ?? 0;
        if (n.read === true) {
          this.appendEvent(n.at, kindExpand, encodeExpand({ session, ids: n.ids, clock }));
        } else {
          this.appendEvent(n.at, kindRecall, encodeRecall({ session, query: n.query ?? "", ids: n.ids, clock }));
        }
      }
    });
  }

  private memories(tail: string, ...args: Binding[]): Memory[] {
    return this.db.all(memorySelect + memoryJoin + tail, ...args).map(toMemory);
  }

  // memoriesBy reads through the named index. The planner has no statistics
  // here and picks among the partial indexes badly, so the reads a new
  // session makes say which one they are for. A query that stops falling
  // within its index fails outright instead of going back to a scan.
  private memoriesBy(index: string, tail: string, ...args: Binding[]): Memory[] {
    return this.db.all(`${memorySelect} INDEXED BY ${index}${memoryJoin}${tail}`, ...args).map(toMemory);
  }

  // get returns the memories with the given ids, in the order asked for.
  // Unknown ids are skipped, and so is a repeated id.
  get(ids: string[]): Memory[] {
    if (ids.length === 0) return [];
    const byID = new Map(this.memories(`WHERE m.id IN ${inList}`, JSON.stringify(ids)).map((m) => [m.id, m]));
    const out: Memory[] = [];
    for (const id of ids) {
      const m = byID.get(id);
      if (m !== undefined) {
        out.push(m);
        byID.delete(id);
      }
    }
    return out;
  }

  // byN returns the memories with the given row numbers, keyed by row number.
  byN(ns: number[]): Map<number, Memory> {
    if (ns.length === 0) return new Map();
    return new Map(this.memories(`WHERE m.n IN ${inList}`, JSON.stringify(ns)).map((m) => [m.n, m]));
  }

  // recent returns the newest memories that are not archived when the clock
  // reads clock, newest first.
  recent(clock: number, limit: number): Memory[] {
    return this.memoriesBy(
      "memories_standing_recent",
      `WHERE ${isLive} AND ${isListed} AND ${notArchived} ORDER BY m.created_at DESC, m.n DESC LIMIT ?`,
      clock, limit,
    );
  }

  // core returns the memories that never fade, most important first.
  core(limit: number): Memory[] {
    return this.memoriesBy(
      "memories_standing_core",
      `WHERE ${isLive} AND ${isListed} AND m.core = 1
       ORDER BY m.pinned DESC, m.importance DESC, m.intensity DESC, m.n DESC LIMIT ?`,
      limit,
    );
  }

  // inSpanList returns the newest memories that took place within span,
  // newest first: those the recent list may show, and with deep the
  // archived ones too. An end of span left out is open.
  inSpanList(clock: number, span: Span, deep: boolean, limit: number): Memory[] {
    const { cond, args } = spanCond(span);
    return this.memoriesBy(
      "memories_standing_recent",
      `WHERE ${isLive} AND ${isListed}${deep ? "" : ` AND ${notArchived}`}${cond} ORDER BY m.created_at DESC, m.n DESC LIMIT ?`,
      ...(deep ? [] : [clock]), ...args, limit,
    );
  }

  // inSpanNs returns the row numbers of the standing memories that took
  // place within span: what a search by meaning kept to it may find. Read
  // from the index alone.
  inSpanNs(span: Span): Set<number> {
    const { cond, args } = spanCond(span);
    return new Set(
      this.db
        .all(`SELECT m.n FROM memories m INDEXED BY memories_standing_recent WHERE ${isLive} AND ${isListed}${cond}`, ...args)
        .map((r) => num(r.n)),
    );
  }

  // searchText returns the memories that best match query by keyword when the
  // clock reads clock, best first, among those that took place within span
  // when one is given.
  //
  // An ordinary search matches active and core memories on anything they say,
  // and faded memories on their gist alone. Archived memories are left out. A
  // deep search matches every memory on anything it says.
  searchText(query: string, clock: number, deep: boolean, limit: number, span?: Span): TextHit[] {
    const match = matchQuery(query);
    if (match === "") return [];
    const { cond, args } = span === undefined ? { cond: "", args: [] } : spanCond(span);
    // CROSS JOIN fixes the order: the keyword index is read first and each
    // match looked up by row number. Left to choose, the planner may walk an
    // index of memories and probe the keyword index once per memory.
    const rows = deep
      ? this.db.all(
          `SELECT memories_fts.rowid AS n, bm25(memories_fts) AS score
             FROM memories_fts CROSS JOIN memories m ON m.n = memories_fts.rowid
            WHERE memories_fts MATCH ? AND ${isListed} AND m.retracted = 0
              AND m.state IN ('', '${StateSuperseded}', '${StateAbsorbed}')${cond}
            ORDER BY score LIMIT ?`,
          match, ...args, limit,
        )
      : this.db.all(
          `SELECT n, score FROM (
             SELECT memories_fts.rowid AS n, bm25(memories_fts) AS score
               FROM memories_fts CROSS JOIN memories m ON m.n = memories_fts.rowid
              WHERE memories_fts MATCH ? AND ${isLive} AND ${isListed} AND ${notYetFaded}${cond}
             UNION ALL
             SELECT memories_fts.rowid, bm25(memories_fts)
               FROM memories_fts CROSS JOIN memories m ON m.n = memories_fts.rowid
              WHERE memories_fts MATCH ? AND ${isLive} AND ${isListed} AND ${isFadedBand}${cond}
           ) ORDER BY score LIMIT ?`,
          match, clock, ...args, "gist : (" + match + ")", clock, clock, ...args, limit,
        );
    // bm25 is negative, more so for a better match.
    return rows.map((r) => ({ n: num(r.n), score: -num(r.score) }));
  }

  // pending returns up to limit fragments that reflect has not dealt with,
  // those nearest to fading first.
  pending(limit: number): Memory[] {
    return this.memoriesBy("memories_pending", `WHERE ${isPending} ORDER BY m.core, m.fade_at, m.n LIMIT ?`, limit);
  }

  // pendingCount reports how many fragments wait for reflect.
  pendingCount(): number {
    return num(
      this.db.first(`SELECT count(*) AS c FROM memories m INDEXED BY memories_pending WHERE ${isPending}`)?.c,
    );
  }

  // selves returns the statements about oneself that stand, oldest first.
  selves(): Memory[] {
    return this.memories(`WHERE m.kind = ? AND ${isLive} ORDER BY m.n`, KindSelf);
  }

  // impressions returns the current impression of each of the named people
  // or things that has one.
  impressions(names: string[]): Memory[] {
    if (names.length === 0) return [];
    return this.memories(
      `WHERE m.kind = ? AND ${isLive} AND m.about IN ${inList} ORDER BY m.about`,
      KindImpression, JSON.stringify(names),
    );
  }

  // readings returns the later understandings of the memory with the given
  // id, oldest first.
  readings(id: string): Memory[] {
    return this.memories(`WHERE m.kind = ? AND ${isLive} AND m.ref = ? ORDER BY m.n`, KindReading, id);
  }

  // sources returns the ids of the memories that the one with the given id
  // is built on.
  sources(id: string): string[] {
    return this.db
      .all(`SELECT l.dst FROM links l JOIN memories m ON m.id = l.dst WHERE l.src = ? ORDER BY m.n`, id)
      .map((r) => text(r.dst));
  }

  // preferences returns the preferences in force, oldest first.
  preferences(): Preference[] {
    return this.db
      .all(`SELECT id, created_at, text FROM policies WHERE retired_at IS NULL ORDER BY created_at, id`)
      .map((r) => ({ id: text(r.id), createdAt: num(r.created_at), text: text(r.text) }));
  }

  // lastRestore reports the most recent time this memory was brought back
  // from an export, or undefined if it never was.
  lastRestore(): RestoreNote | undefined {
    const r = this.db.first(`SELECT at, exported_at FROM restores ORDER BY at DESC LIMIT 1`);
    return r === undefined ? undefined : { at: num(r.at), exportedAt: num(r.exported_at) };
  }

  // check looks the memory over and reports what it finds, without quoting
  // what any memory says. It reads and changes nothing.
  check(): Report {
    return checkStore(this.db);
  }

  // usage returns the rows read and written since the last reset.
  usage(): Usage {
    return this.db.usage();
  }

  resetUsage(): void {
    this.db.resetUsage();
  }

  // counts reports how many memories and events the store holds.
  counts(): { memories: number; events: number } {
    const r = this.db.first(`SELECT (SELECT count(*) FROM memories) AS memories, (SELECT count(*) FROM events) AS events`);
    return { memories: num(r?.memories), events: num(r?.events) };
  }

  // tierCounts reports how many memories are in each tier when the clock
  // reads clock.
  tierCounts(clock: number): TierCounts {
    const r = this.db.first(
      `SELECT count(*) FILTER (WHERE m.core = 1) AS core,
              count(*) FILTER (WHERE ${isActiveBand}) AS active,
              count(*) FILTER (WHERE ${isFadedBand}) AS faded,
              count(*) FILTER (WHERE ${isArchived}) AS archived
         FROM memories m INDEXED BY memories_standing_tiers WHERE ${isLive} AND ${isListed}`,
      clock, clock, clock, clock,
    );
    return { core: num(r?.core), active: num(r?.active), faded: num(r?.faded), archived: num(r?.archived) };
  }

  // logStats reads what the event log and the memory's settings say about it.
  logStats(): LogStats {
    return readLogStats(this.db);
  }

  // restore fills a memory whose log is empty from a checked export, as Go's
  // Import does: the events keep their seq and at, what the memories say is
  // stored with them, the token hash is the export's or else tokenHash, and
  // a restore event is appended. The derived tables are built in the same
  // transaction, so a log that cannot be replayed leaves nothing written. The
  // keyword index existed before this transaction (see indexSchema), so its
  // rollback is an ordinary one.
  //
  // settings, already checked, are those the export carried: they are stored
  // first, so the tables are built once, with them.
  restore(x: ParsedExport, at: number, tokenHash: string, settings?: { params: Params; timeZone?: string }): void {
    this.tx(() => {
      if (num(this.db.first(`SELECT count(*) AS c FROM events`)?.c) !== 0) throw new Error("restore: the log is not empty");
      if (settings !== undefined) {
        this.p = { ...settings.params };
        this.db.setMeta(metaParams, paramsJSON(this.p));
        if (settings.timeZone !== undefined) this.db.setMeta(metaZone, settings.timeZone);
      }
      for (const e of x.events) {
        this.db.run(`INSERT INTO events(seq, at, kind, payload) VALUES(?, ?, ?, ?)`, e.seq, e.at, e.kind, e.payload);
        if (e.contentId !== undefined) this.db.run(`INSERT INTO contents(id, data) VALUES(?, ?)`, e.contentId, e.content ?? "");
      }
      this.db.setMeta(metaTokenHash, x.tokenHash !== "" ? x.tokenHash : tokenHash);
      this.appendEvent(at, kindRestore, encodeRestore({ from: x.instance, exportedAt: x.exportedAt, events: x.events.length }));
      this.rebuildInTx();
    });
  }

  // tokenHash returns the hash of the access token set for this memory, or
  // undefined when none is set.
  tokenHash(): string | undefined {
    return this.db.getMeta(metaTokenHash);
  }

  // setTokenHash replaces the hash of this memory's access token. Only the
  // hash is ever stored.
  setTokenHash(hash: string): void {
    this.tx(() => this.db.setMeta(metaTokenHash, hash));
  }

  // defaultZone returns the time zone shown to calls whose session reported
  // none: UTC unless set.
  defaultZone(): string {
    return this.db.getMeta(metaZone) ?? UTC;
  }

  // setDefaultZone stores the zone defaultZone returns. The caller checks it.
  setDefaultZone(zone: string): void {
    this.tx(() => this.db.setMeta(metaZone, zone));
  }

  // ---- Vectors. See vectors.ts. A memory needs a vector when it stands,
  // is listed and is not archived; only such memories keep one.

  // needingVectors returns the row numbers of the memories that need a
  // vector when the clock reads clock, in order. It reads the partial index
  // of standing memories alone, and sorts here: the platform would count the
  // rows of a sort in SQL again.
  private needingVectors(clock: number): number[] {
    return this.db
      .all(
        `SELECT m.n FROM memories m INDEXED BY memories_standing_tiers
          WHERE ${isLive} AND ${isListed} AND ${notArchived}`,
        clock,
      )
      .map((r) => num(r.n))
      .sort((a, b) => a - b);
  }

  // tendVectors does what comes before embedding, in one transaction: it
  // drops the vectors of other labels, and those of memories that no longer
  // need one (Go's sweep), and returns how many vectors it dropped and the
  // row numbers of the memories that wait for a vector of label, oldest
  // first. It loads the vectors of label.
  tendVectors(label: Label): { dropped: number; waiting: number[] } {
    return this.tx(() => this.tendInTx(label));
  }

  private tendInTx(label: Label): { dropped: number; waiting: number[] } {
    this.vec.dropOthers(label);
    this.vec.load(label);
    const need = new Set(this.needingVectors(this.db.clock()));
    const stored = this.vec.storedFor(label);
    const dropped = this.vec.remove([...stored].filter((n) => !need.has(n)));
    return { dropped, waiting: [...need].filter((n) => !stored.has(n)) };
  }

  // vectorRuns reads what the alarm keeps about its runs.
  vectorRuns(): { seen?: number; fullAsked: boolean; fullAt?: number; label?: string } {
    const int = (key: string): number | undefined => {
      const v = this.db.getMeta(key);
      return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
    };
    return {
      seen: int(metaVectorsSeen),
      fullAsked: this.db.getMeta(metaVectorsFull) !== undefined,
      fullAt: int(metaVectorsFullAt),
      label: this.db.getMeta(metaVectorsLabel),
    };
  }

  // askFullVectorRun records that the next run of the alarm must look at
  // every memory, not only those written since its last run.
  askFullVectorRun(): void {
    this.tx(() => this.db.setMeta(metaVectorsFull, "1"));
  }

  // fullVectorRun is the full run's first step, in one transaction: it
  // tends the vectors (see tendVectors), records the run at the wall clock
  // now, and moves the mark of the ordinary runs back to just before the
  // oldest memory that waits, so that they take it up. It returns how many
  // vectors it dropped and how many memories wait.
  fullVectorRun(label: Label, now: number): { dropped: number; waiting: number } {
    return this.tx(() => {
      const { dropped, waiting } = this.tendInTx(label);
      const seen = waiting.length > 0 ? waiting[0]! - 1 : this.maxN();
      this.db.setMeta(metaVectorsSeen, String(seen));
      this.db.setMeta(metaVectorsFullAt, String(now));
      this.db.setMeta(metaVectorsLabel, labelKey(label));
      this.db.run(`DELETE FROM meta WHERE key = ?`, metaVectorsFull);
      return { dropped, waiting: waiting.length };
    });
  }

  private maxN(): number {
    return num(this.db.first(`SELECT COALESCE(MAX(n), 0) AS n FROM memories`)?.n);
  }

  // nextForVectors returns up to take memories written after the mark of
  // the ordinary runs that need a vector of label and have none, oldest
  // first, leaving out those in skip. It reads the memories after the mark
  // by row number, a chunk at a time, and stops once it has one more than
  // it takes. seen is the mark to keep once the batch is done: the last
  // memory taken when more wait, else the newest memory there is.
  nextForVectors(label: Label, take: number, skip: ReadonlySet<number>): { batch: number[]; more: boolean; from: number; seen: number } {
    const from = this.vectorRuns().seen ?? 0;
    const stored = this.vec.storedFor(label);
    const clock = this.db.clock();
    const batch: number[] = [];
    let after = from;
    let more = false;
    for (;;) {
      const rows = this.db
        .all(
          `SELECT m.n FROM memories m WHERE m.n > ? AND ${isLive} AND ${isListed} AND ${notArchived} ORDER BY m.n LIMIT ?`,
          after, clock, vectorScanChunk,
        )
        .map((r) => num(r.n));
      for (const n of rows) {
        if (stored.has(n) || skip.has(n)) continue;
        if (batch.length === take) {
          more = true;
          break;
        }
        batch.push(n);
      }
      if (more || rows.length < vectorScanChunk) break;
      after = rows[rows.length - 1]!;
    }
    return { batch, more, from, seen: more ? batch[batch.length - 1]! : this.maxN() };
  }

  // setVectorsSeen keeps the mark of the ordinary runs.
  setVectorsSeen(n: number): void {
    this.tx(() => this.db.setMeta(metaVectorsSeen, String(n)));
  }

  // saveVectors stores the unit vectors of label given for memories that
  // still need one, and returns how many it stored. A memory that was
  // erased, set aside or archived while its vector was being made gets none.
  saveVectors(label: Label, entries: { n: number; vec: ArrayLike<number> }[]): number {
    if (entries.length === 0) return 0;
    return this.tx(() => {
      const clock = this.db.clock();
      const need = new Set(
        this.db
          .all(
            `SELECT m.n FROM memories m WHERE m.n IN ${inList} AND ${isLive} AND ${isListed} AND ${notArchived}`,
            JSON.stringify(entries.map((e) => e.n)), clock,
          )
          .map((r) => num(r.n)),
      );
      const keep = entries.filter((e) => need.has(e.n));
      this.vec.add(label, keep);
      return keep.length;
    });
  }

  // searchVectors returns up to k memories whose vectors of label are
  // closest to the unit vector q, best first, at or above min, and only
  // memories in among when it is given. The first search after the object
  // wakes loads the vectors.
  searchVectors(label: Label, q: Float32Array, k: number, min: number, among?: ReadonlySet<number>): VectorHit[] {
    return this.vec.search(label, q, k, min, among);
  }

  // vectorCount reports how many vectors of label are stored.
  vectorCount(label: Label): number {
    return this.vec.size(label);
  }

  // vectorFigures reports how many vectors are stored under each label and,
  // given a label, how many memories wait for a vector of it.
  vectorFigures(label?: Label): { held: HeldFigure[]; waiting: number | null } {
    const held = this.vec.held();
    if (label === undefined) return { held, waiting: null };
    const stored = this.vec.storedFor(label);
    return { held, waiting: this.needingVectors(this.db.clock()).filter((n) => !stored.has(n)).length };
  }

  // storedVectorNs returns the row number of every stored vector, of any
  // label.
  storedVectorNs(): number[] {
    return this.vec.storedNs();
  }
}

// vectorScanChunk is how many memories an ordinary run reads at a time.
const vectorScanChunk = 256;

// labelKey writes a label as it is kept in meta.
export function labelKey(l: Label): string {
  return `${l.dims} ${l.model}`;
}

// readLogStats reads what the event log and the memory's settings say about
// it. It needs the log tables alone, as Go's LogOnly store does, so that it
// can be read without building, or rebuilding, the derived tables.
export function readLogStats(db: Db): LogStats {
  const r = db.first(
    `SELECT count(*) FILTER (WHERE kind = ?) AS memories, count(*) AS events, COALESCE(MAX(at), 0) AS last FROM events`,
    kindRemember,
  );
  const last = num(r?.last);
  return {
    memories: num(r?.memories),
    events: num(r?.events),
    lastEventAt: last > 0 ? last : null,
    hasToken: db.getMeta(metaTokenHash) !== undefined,
  };
}

function toMemory(r: Row): Memory {
  const people: unknown = JSON.parse(text(r.people));
  if (!Array.isArray(people) || !people.every((x): x is string => typeof x === "string")) {
    throw new Error(`memory ${text(r.id)}: people is not a list of names`);
  }
  const m: Memory = {
    n: num(r.n),
    id: text(r.id),
    createdAt: num(r.created_at),
    writtenAt: num(r.written_at),
    sessionId: text(r.session_id),
    model: text(r.model),
    client: text(r.client),
    moment: text(r.moment),
    source: text(r.source),
    importance: num(r.importance),
    intensity: num(r.intensity),
    gist: text(r.gist),
    body: text(r.body),
    outcome: text(r.outcome),
    feeling: text(r.feeling),
    lesson: text(r.lesson),
    people,
    pointer: text(r.pointer),
    lastRecalledAt: num(r.last_recalled_at),
    recallCount: num(r.recall_count),
    kind: text(r.kind),
    about: text(r.about),
    context: text(r.context),
    ref: text(r.ref),
    milestone: flag(r.milestone),
    pending: false,
    state: text(r.state),
    stateBy: text(r.state_by),
    retracted: flag(r.retracted),
    pinned: flag(r.pinned),
    corrects: text(r.corrects),
    ord: num(r.ord),
    touchedOrd: num(r.touched_ord),
    readOrd: num(r.read_ord),
    core: flag(r.core),
    strength: num(r.strength),
    fadeAt: realOrZero(r.fade_at),
    archiveAt: realOrZero(r.archive_at),
  };
  m.pending = flag(r.unreviewed) && m.kind === KindFragment && m.state === "" && !m.retracted;
  return m;
}

// carrierKey brings the spellings a model gives its own name to one form, so
// that "Claude Sonnet 5.5" and "claude-sonnet-5-5" are one carrier. A session
// keeps the name as it was given.
export function carrierKey(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}
