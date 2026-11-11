// The append-only event log and the tables derived from it. Port of store.go.
//
// Every change to a memory is written as an event and then applied to the
// derived tables in the same transaction. Rebuild replays the log through the
// same apply function, so the derived tables are always a function of the
// events and the forgetting parameters. Every method is synchronous, and every
// method that writes is one ctx.storage.transactionSync.

import { applyRemember, KindFragment, KindReading, KindSelf, StateAbsorbed, StateSuperseded, writeMemory } from "./content";
import { blob, type Binding, Db, flag, isConstraint, num, realOrZero, type Row, text } from "./db";
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
  decodeExpand,
  decodeRecall,
  decodeRemember,
  decodeRestore,
  decodeSession,
  encodeExpand,
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
import { contentHash, newID } from "./ids";
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
} from "./schema";
import type { CarrierNote, LogStats, Memory, RecallNote, RememberInput, Session, TextHit } from "./types";

// dedupWindow is how far back remember looks for an identical memory before
// writing a new one. It absorbs retried tool calls.
export const dedupWindow = 10 * 60 * 1000;

// NoSessionError is thrown when a write names a session that does not exist.
export class NoSessionError extends Error {
  override name = "NoSessionError";
  constructor(readonly sessionId: string) {
    super(`no such session: ${JSON.stringify(sessionId)}`);
  }
}

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

// EventNotPortedError is thrown when the log holds an event whose projection
// is not ported yet: amend, erase and reflect, until stage P2.
export class EventNotPortedError extends Error {
  override name = "EventNotPortedError";
  constructor(readonly kind: string) {
    super(`event kind ${JSON.stringify(kind)} is not ported yet (stage P2)`);
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
FROM memories m LEFT JOIN sessions s ON s.id = m.session_id `;

// isLive holds for a memory that stands: not replaced, not absorbed, not
// erased, not set aside.
const isLive = `(m.state = '' AND m.retracted = 0)`;

// isListed holds for the kinds of memory that searches and lists show.
// Statements about oneself are loaded whole at the start of a session, and a
// reading is shown with the memory it reads.
const isListed = `(m.kind NOT IN ('${KindSelf}', '${KindReading}'))`;

// Conditions on memories m, each taking the clock as its parameter.
const isArchived = `(m.core = 0 AND m.archive_at <= ?)`;
const notArchived = `(m.core = 1 OR m.archive_at > ?)`;
const notYetFaded = `(m.core = 1 OR m.fade_at > ?)`;
const isFadedBand = `(m.core = 0 AND m.fade_at <= ? AND m.archive_at > ?)`;
const isActiveBand = `(m.core = 0 AND m.fade_at > ?)`;

// A list bound as one JSON parameter: the platform allows at most 100 bound
// parameters in a query, so a list of ids is never spread over placeholders.
const inList = `(SELECT value FROM json_each(?))`;

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

function parseParams(v: string): Params {
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
  private p: Params = defaultParams();

  // The constructor creates the log tables if needed, checks the log format,
  // and brings the derived tables up to date with the log and the parameters.
  // It does so in two transactions, so that the keyword index exists before
  // the one that replays the log into it: see indexSchema.
  constructor(private readonly storage: DurableObjectStorage) {
    this.db = new Db(storage.sql);
    this.tx(() => this.init());
    this.tx(() => {
      if (this.db.getMeta(metaDerived) !== this.derivedMark()) this.rebuildInTx();
    });
  }

  private tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
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
    this.db.run(`DELETE FROM vectors WHERE n NOT IN (SELECT n FROM memories)`);
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
          `INSERT INTO sessions(id, started_at, last_active_at, model, client) VALUES(?, ?, ?, ?, ?)`,
          e.id, at, at, e.model, e.client,
        );
        if (e.model === "") return;
        this.db.run(
          `INSERT INTO carriers(model, first_seen, last_seen, sessions) VALUES(?, ?, ?, 1)
           ON CONFLICT(model) DO UPDATE SET last_seen = excluded.last_seen, sessions = sessions + 1`,
          e.model, at, at,
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
      case kindErase:
      case kindReflect:
        throw new EventNotPortedError(kind);
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
  // is new to this memory.
  startSession(at: number, model: string, client: string): { session: Session; note: CarrierNote } {
    return this.retry(() => {
      const session: Session = { id: newID("s_"), startedAt: at, lastActiveAt: at, model, client };
      const note = model === "" ? { first: false, earlier: [] } : this.carrierNote(model);
      this.appendEvent(at, kindSession, encodeSession({ id: session.id, model, client }));
      return { session, note };
    });
  }

  private carrierNote(model: string): CarrierNote {
    const known = this.db.first(`SELECT 1 AS k FROM carriers WHERE model = ?`, model) !== undefined;
    const earlier = this.db
      .all(`SELECT model FROM carriers WHERE model <> ? ORDER BY last_seen DESC, model LIMIT 3`, model)
      .map((r) => text(r.model));
    return { first: !known && earlier.length > 0, earlier };
  }

  private sessions(tail: string, ...args: Binding[]): Session[] {
    return this.db
      .all(`SELECT id, started_at, last_active_at, model, client FROM sessions ` + tail, ...args)
      .map((r) => ({
        id: text(r.id),
        startedAt: num(r.started_at),
        lastActiveAt: num(r.last_active_at),
        model: text(r.model),
        client: text(r.client),
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
        (a, kind, payload) => this.appendEvent(a, kind, payload),
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
    return this.db.all(memorySelect + tail, ...args).map(toMemory);
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
    return this.memories(
      `WHERE ${isLive} AND ${isListed} AND ${notArchived} ORDER BY m.created_at DESC, m.n DESC LIMIT ?`,
      clock, limit,
    );
  }

  // core returns the memories that never fade, most important first.
  core(limit: number): Memory[] {
    return this.memories(
      `WHERE ${isLive} AND ${isListed} AND m.core = 1
       ORDER BY m.pinned DESC, m.importance DESC, m.intensity DESC, m.n DESC LIMIT ?`,
      limit,
    );
  }

  // searchText returns the memories that best match query by keyword when the
  // clock reads clock, best first.
  //
  // An ordinary search matches active and core memories on anything they say,
  // and faded memories on their gist alone. Archived memories are left out. A
  // deep search matches every memory on anything it says.
  searchText(query: string, clock: number, deep: boolean, limit: number): TextHit[] {
    const match = matchQuery(query);
    if (match === "") return [];
    const rows = deep
      ? this.db.all(
          `SELECT memories_fts.rowid AS n, bm25(memories_fts) AS score
             FROM memories_fts JOIN memories m ON m.n = memories_fts.rowid
            WHERE memories_fts MATCH ? AND ${isListed} AND m.retracted = 0
              AND m.state IN ('', '${StateSuperseded}', '${StateAbsorbed}')
            ORDER BY score LIMIT ?`,
          match, limit,
        )
      : this.db.all(
          `SELECT n, score FROM (
             SELECT memories_fts.rowid AS n, bm25(memories_fts) AS score
               FROM memories_fts JOIN memories m ON m.n = memories_fts.rowid
              WHERE memories_fts MATCH ? AND ${isLive} AND ${isListed} AND ${notYetFaded}
             UNION ALL
             SELECT memories_fts.rowid, bm25(memories_fts)
               FROM memories_fts JOIN memories m ON m.n = memories_fts.rowid
              WHERE memories_fts MATCH ? AND ${isLive} AND ${isListed} AND ${isFadedBand}
           ) ORDER BY score LIMIT ?`,
          match, clock, "gist : (" + match + ")", clock, clock, limit,
        );
    // bm25 is negative, more so for a better match.
    return rows.map((r) => ({ n: num(r.n), score: -num(r.score) }));
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
         FROM memories m WHERE ${isLive} AND ${isListed}`,
      clock, clock, clock, clock,
    );
    return { core: num(r?.core), active: num(r?.active), faded: num(r?.faded), archived: num(r?.archived) };
  }

  // logStats reads what the event log and the memory's settings say about it.
  logStats(): LogStats {
    const r = this.db.first(
      `SELECT count(*) FILTER (WHERE kind = ?) AS memories, count(*) AS events, COALESCE(MAX(at), 0) AS last FROM events`,
      kindRemember,
    );
    const last = num(r?.last);
    return {
      memories: num(r?.memories),
      events: num(r?.events),
      lastEventAt: last > 0 ? last : null,
      hasToken: this.db.getMeta(metaTokenHash) !== undefined,
    };
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

  // saveVector stores the embedding of memory n produced by model, as
  // little-endian float32.
  saveVector(n: number, model: string, vec: ArrayLike<number>): void {
    const buf = new ArrayBuffer(4 * vec.length);
    const view = new DataView(buf);
    for (let i = 0; i < vec.length; i++) view.setFloat32(4 * i, vec[i]!, true);
    this.tx(() =>
      this.db.run(
        `INSERT INTO vectors(n, model, vec) VALUES(?, ?, ?)
         ON CONFLICT(n, model) DO UPDATE SET vec = excluded.vec`,
        n, model, buf,
      ),
    );
  }

  // vectors calls fn with every stored embedding produced by model, in order
  // of n. It reads one row at a time.
  vectors(model: string, fn: (n: number, vec: Float32Array) => void): void {
    for (const r of this.db.sql.exec(`SELECT n, vec FROM vectors WHERE model = ? ORDER BY n`, model)) {
      const buf = blob(r.vec);
      const view = new DataView(buf);
      const vec = new Float32Array(buf.byteLength >> 2);
      for (let i = 0; i < vec.length; i++) vec[i] = view.getFloat32(4 * i, true);
      fn(num(r.n), vec);
    }
  }

  // unembedded returns up to limit memories that are not archived when the
  // clock reads clock and have no embedding from model yet, oldest first.
  unembedded(model: string, clock: number, limit: number): Memory[] {
    return this.memories(
      `WHERE ${isLive} AND ${isListed} AND ${notArchived}
         AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.n = m.n AND v.model = ?)
       ORDER BY m.n LIMIT ?`,
      clock, model, limit,
    );
  }

  // dropArchivedVectors deletes the embeddings of every memory archived when
  // the clock reads clock, or no longer live or listed, and returns the row
  // numbers of those memories, each once. If one comes to mind again it is
  // embedded again.
  dropArchivedVectors(clock: number): number[] {
    const rows = this.tx(() =>
      this.db.all(
        `DELETE FROM vectors WHERE n IN (SELECT m.n FROM memories m WHERE ${isArchived} OR NOT ${isLive} OR NOT ${isListed})
         RETURNING n`,
        clock,
      ),
    );
    return [...new Set(rows.map((r) => num(r.n)))];
  }
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
