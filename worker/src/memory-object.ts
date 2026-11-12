import { DurableObject } from "cloudflare:workers";
import { clip, InvalidInput, parseSpan, parseWhen, queryParts, type RememberRequest, trimSpace } from "./memory/clean";
import type { AmendRequest, EntryRequest, EraseRequest, ReflectView } from "./memory/amend";
import { type ContextView, type MeaningHit, recallDepth, type Result, Service } from "./memory/service";
import { embedSettings, prepare, type QueryVector, queryMaxRunes, WorkersAI } from "./embed";
import { type EmbedRun, Embedding } from "./memory/embedding";
import { logLine } from "./log";
import type { HeldFigure, Label } from "./store/vectors";
import { formatBatch, formatContext, formatExpand, formatRecall, formatWritten } from "./mcp/format";
import { reportText, type Report } from "./store/check";
import {
  isDefault, paramsDiffer, readParams, resolveSettings, type Settings, type SettingsChange, unknownZoneMessage,
} from "./settings";
import { Db, type Usage } from "./store/db";
import { defaultParams, InvalidParamsError, type Params } from "./store/decay";
import { ExportError, FormatRefusal, type ParsedExport, parseExport, TooLargeError, writeExport } from "./store/export";
import { logFormat, metaInstance, metaParams, metaTokenHash, metaZone } from "./store/schema";
import { LogFormatError, parseParams, readLogStats, ReplayError, Store } from "./store/store";
import type { LogStats } from "./store/types";
import { knownZone, UTC } from "./zone";
import type { Env } from "./index";

// Invalid is an input the caller can fix, with the message for the model.
// Error classes do not survive RPC, so it is returned, not thrown.
export interface Invalid {
  invalid: string;
}

// RememberArgs is a memory as a tool call sends it: the date it took place,
// if any, is text, read as Go's server reads happened_at, in the zone of the
// session that writes it.
export type RememberArgs = Omit<RememberRequest, "happened"> & { happenedAt?: string };

// RecallArgs is a recall as a tool call sends it. query may be empty, to
// list by time; since and until are text, read in the zone of the session
// that asks, as happened_at is. meaning is the query's embedding, made by the
// Worker, if it made one.
export interface RecallArgs {
  query: string;
  limit?: number;
  deep?: boolean;
  sessionId?: string;
  since?: string;
  until?: string;
  meaning?: QueryVector;
}

// ToolCall is one tool call, its arguments already checked against the
// tool's schema, as the Worker hands it to answer.
export type ToolCall =
  | { tool: "get_context"; model?: string; timezone?: string; client?: string }
  | { tool: "remember"; args: RememberArgs }
  | ({ tool: "recall" } & RecallArgs)
  | { tool: "expand"; ids: string[]; sessionId?: string }
  | {
      tool: "reflect";
      sessionId: string;
      batch?: string;
      limit?: number;
      // As the call wrote them: the confirmation repeats each kind untrimmed
      // and counts pass as given, as Go's does.
      entries?: EntryRequest[];
      pass?: string[];
    }
  | { tool: "amend"; args: AmendRequest }
  | { tool: "erase"; args: EraseRequest }
  | { tool: "check" };

// Gone is a call to a memory that no longer exists, or that was deleted and
// made again since the grant the call came with was given.
export interface Gone {
  gone: true;
}

// Answer is the text of a tool's answer, what was wrong with the call, or
// that the memory is gone.
export type Answer = { text: string } | Invalid | Gone;

// Access is what a token presented for this memory comes to: the memory's
// own, another, or a memory that was never created.
export type Access = "ok" | "rejected" | "unknown";

// outcome runs fn and hands back an InvalidInput as data. Anything else is
// thrown.
function outcome<T>(fn: () => T): T | Invalid {
  try {
    return fn();
  } catch (err) {
    if (err instanceof InvalidInput || err instanceof InvalidParamsError) return { invalid: err.message };
    throw err;
  }
}

const encoder = new TextEncoder();

// Memory is one memory: a Durable Object that owns the SQLite database its
// store lives in. Every method is synchronous inside: nothing else runs on
// the object between its reads and its writes.
//
// The store is built on first use, not in the constructor: an object that
// is asked about a memory that was never created must leave its database
// empty. authorize, create and replaceToken are what the Worker calls before
// anything else; they build nothing for a name that was never created.
export class Memory extends DurableObject<Env> {
  private built?: { store: Store; service: Service };
  // The wall clock in unix milliseconds. Tests replace it; an instance
  // field is not reachable over RPC.
  now: () => number = () => Date.now();
  // The limit in bytes of an import or an export; tests lower it.
  byteLimit = maxBytesInOneGo;
  // Search by meaning: undefined until first needed, null when it is off.
  // Tests set an Embedding with a stand-in embedder.
  embedding?: Embedding | null;
  // The clock alarms are set by. Tests move it far ahead, so that an alarm
  // runs only when they run it.
  alarmNow: () => number = () => Date.now();
  // Whether this instance set an alarm that has not run yet.
  private wakeSet = false;
  // The alarm's run under way, if any: a deletion waits for it.
  private alarmRun?: Promise<void>;
  // The memory's instance id, once read: see instance.
  private instanceId?: string;

  private get parts(): { store: Store; service: Service } {
    if (this.built === undefined) {
      const store = new Store(this.ctx.storage);
      this.built = { store, service: new Service(store, () => this.now()) };
    }
    return this.built;
  }

  get store(): Store {
    return this.parts.store;
  }

  get service(): Service {
    return this.parts.service;
  }

  private get emb(): Embedding | null {
    if (this.embedding === undefined) {
      const s = embedSettings(this.env);
      this.embedding = s === undefined ? null : new Embedding(s, new WorkersAI(this.env.AI!, s.model));
    }
    return this.embedding;
  }

  // wake sets the alarm that embeds what waits, unless this instance set
  // one already: a delay after a failure is not cut short. The call that
  // wakes it neither waits for it nor fails because of it.
  private wake(): void {
    if (this.emb === null || this.wakeSet) return;
    this.schedule(0);
  }

  // askFull asks the next run of the alarm to be a full one, and sets the
  // alarm: called when something other than a new write may have changed
  // which memories need a vector.
  private askFull(): void {
    if (this.emb === null) return;
    this.store.askFullVectorRun();
    this.wake();
  }

  private schedule(delay: number): void {
    this.wakeSet = true;
    this.ctx.storage.setAlarm(this.alarmNow() + delay).catch((err: unknown) => {
      this.wakeSet = false;
      logLine({ msg: "alarm not set", error: err instanceof Error ? err.name : "unknown" });
    });
  }

  // alarm embeds one batch of what waits and sets itself again while more
  // waits, or after a growing delay when the model cannot be used.
  override async alarm(): Promise<void> {
    const run = this.alarmOnce();
    this.alarmRun = run;
    try {
      await run;
    } finally {
      if (this.alarmRun === run) this.alarmRun = undefined;
    }
  }

  private async alarmOnce(): Promise<void> {
    this.wakeSet = false;
    const emb = this.emb;
    // An object that holds no memory is left without tables.
    if (emb === null || (this.built === undefined && !this.hasLog())) return;
    let r: EmbedRun;
    try {
      r = await this.embedOnce();
    } catch (err) {
      const retryIn = emb.failure();
      logLine({ msg: "embedding failed", error: err instanceof Error ? err.name : "unknown", retry_ms: retryIn });
      this.schedule(retryIn);
      return;
    }
    if (r.failed) this.schedule(r.retryIn);
    else if (r.more) this.schedule(0);
  }

  // embedOnce embeds one batch, after a full run's sweep when one is due or
  // full is set; the alarm runs it, and tests do.
  async embedOnce(full = false): Promise<EmbedRun> {
    const emb = this.emb;
    if (emb === null) return { dropped: 0, embedded: 0, refused: 0, failed: false, retryIn: 0, more: false, full: false };
    return emb.run(this.store, this.now(), full);
  }

  // meaningFor searches the vectors with the query's embedding, which the
  // Worker made, and with those of the query's parts when it names several
  // things: the whole query's hits, then each part's in order. Without a
  // vector, or with one of another label, recall reads keywords alone; parts
  // whose vectors do not fit the parts of the query are read by keyword. The
  // object never calls the model for a query. among keeps the search to the
  // memories of a span.
  private meaningFor(
    query: string, v: QueryVector | undefined, limit: number, among?: ReadonlySet<number>,
  ): { whole?: MeaningHit[]; parts?: (MeaningHit[] | undefined)[] } {
    const emb = this.emb;
    if (emb === null || v === undefined || trimSpace(query) === "") return {};
    const s = emb.settings;
    if (v.model !== s.model || v.dims !== s.dims) return {};
    const search = (values: Float32Array): MeaningHit[] | undefined => {
      if (values.length !== s.dims) return undefined;
      let q: Float32Array;
      try {
        q = prepare(values, s.dims);
      } catch {
        return undefined;
      }
      return this.store.searchVectors(emb.label, q, recallDepth(limit), s.minSimilarity, among);
    };
    const whole = search(v.values);
    if (whole === undefined) return {};
    // The Worker split the query as recall splits it, from the same text.
    const parts = queryParts(clip(trimSpace(query), queryMaxRunes));
    if (parts.length < 2 || v.parts === undefined || v.parts.length !== parts.length) return { whole };
    return { whole, parts: v.parts.map(search) };
  }

  private recallWith(args: RecallArgs): Result[] {
    const query = args.query ?? "";
    const limit = args.limit ?? 0;
    const deep = args.deep ?? false;
    const span = parseSpan(args.since, args.until, this.zoneFor(args.sessionId));
    const among = span !== undefined && trimSpace(query) !== "" && args.meaning !== undefined && this.emb !== null
      ? this.store.inSpanNs(span) : undefined;
    const meaning = this.meaningFor(query, args.meaning, limit, among);
    const results = this.service.recall(query, limit, deep, args.sessionId ?? "", meaning.whole, {
      ...(span === undefined ? {} : { span }),
      ...(meaning.parts === undefined ? {} : { partsByMeaning: meaning.parts }),
    });
    // Listed by a search, an archived memory comes back, and needs its vector
    // again. A listing by time brings nothing back.
    if (trimSpace(query) !== "" && results.some((r) => r.tier === "archived")) this.askFull();
    return results;
  }

  private expandWith(ids: string[], sessionId: string): Result[] {
    const results = this.service.expand(ids, sessionId);
    if (results.some((r) => r.tier === "archived")) this.askFull();
    return results;
  }

  // Amending a memory can set it aside, bring it back, replace it, or move
  // it into or out of the archive; reflecting writes memories and absorbs
  // others. The alarm's next run is then a full one. A preference is not a
  // memory: setting or dropping one asks for nothing.
  private amendWith(args: AmendRequest): string {
    const msg = this.service.amend(args);
    const action = trimSpace(args.action ?? "");
    if (action !== "prefer" && action !== "unprefer") this.askFull();
    return msg;
  }

  private finishReflectWith(sessionId: string, batch: string, entries: EntryRequest[], pass: string[]): string[] {
    const ids = this.service.finishReflect(sessionId, batch, entries, pass);
    this.askFull();
    return ids;
  }

  // storedTokenHash reads the token's hash without building the store: a
  // database without the meta table holds no memory.
  private storedTokenHash(): string | undefined {
    const sql = this.ctx.storage.sql;
    const tables = sql.exec(`SELECT 1 AS k FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).toArray();
    if (tables.length === 0) return undefined;
    const row = sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, metaTokenHash).toArray()[0];
    return row?.value;
  }

  // authorize says whether hash, the SHA-256 in hex of the token a request
  // presented, is this memory's. A memory exists once it has a token.
  authorize(hash: string): Access {
    const want = this.storedTokenHash();
    if (want === undefined) return "unknown";
    const a = encoder.encode(want);
    const b = encoder.encode(hash);
    // Compare equal lengths only, and always compare.
    const same = crypto.subtle.timingSafeEqual(a, a.byteLength === b.byteLength ? b : a) && a.byteLength === b.byteLength;
    return same ? "ok" : "rejected";
  }

  // instance names this memory as it was made: drawn when it was created or
  // brought back, never carried by an export, and new when a name is used
  // again after a deletion. A grant records it (consent.ts), so that what
  // was granted for one memory is refused by the next under the same name.
  instance(): string | "unknown" {
    if (!this.exists()) return "unknown";
    if (this.instanceId === undefined) {
      // The store draws it when it is first built, which a memory that was
      // created or brought back always was; building it again draws it if not.
      if (this.logDb().getMeta(metaInstance) === undefined) void this.store;
      this.instanceId = this.logDb().getMeta(metaInstance) ?? "";
    }
    return this.instanceId;
  }

  // holdsMemory says whether this object holds a memory, cheaply once the
  // store is built: only a memory that exists builds it, and a deletion
  // drops it.
  private holdsMemory(): boolean {
    return this.built !== undefined || this.storedTokenHash() !== undefined;
  }

  // remove empties this object: every table, every key and the alarm, so
  // that its name answers as one never used, and a memory made under it
  // later starts empty. An embedding batch under way is let finish first;
  // it would otherwise write into what is made next. Repeated, it does the
  // same and says "unknown".
  async remove(): Promise<"removed" | "unknown"> {
    while (this.alarmRun !== undefined) await this.alarmRun.catch(() => undefined);
    // From here to the calls below nothing awaits, so no other call sees a
    // part of it.
    const held = this.hasLog();
    this.built = undefined;
    this.instanceId = undefined;
    this.wakeSet = false;
    // What the model refused is known by row numbers, which start again.
    if (this.embedding) this.embedding = new Embedding(this.embedding.settings, this.embedding.embedder);
    // On SQLite storage both take effect at once; the promises only report
    // that the writes were confirmed. deleteAll drops the alarm too from
    // compatibility date 2026-02-24 on; deleteAlarm says so here.
    await Promise.all([this.ctx.storage.deleteAlarm(), this.ctx.storage.deleteAll()]);
    return held ? "removed" : "unknown";
  }

  // create makes this memory with the given token hash, unless it exists.
  create(hash: string): "created" | "exists" {
    if (this.storedTokenHash() !== undefined) return "exists";
    this.store.setTokenHash(hash);
    return "created";
  }

  // replaceToken gives an existing memory a new token hash; the old token
  // stops working at once.
  replaceToken(hash: string): "replaced" | "unknown" {
    if (this.storedTokenHash() === undefined) return "unknown";
    this.store.setTokenHash(hash);
    return "replaced";
  }

  // timeZone returns the zone shown to calls whose session reported none.
  timeZone(): string {
    return this.store.defaultZone();
  }

  // setTimeZone sets the zone timeZone returns and returns it as the runtime
  // names it.
  setTimeZone(zone: string): string | Invalid {
    const known = knownZone(trimSpace(zone));
    if (known === undefined) return { invalid: unknownZoneMessage(zone) };
    this.store.setDefaultZone(known);
    return known;
  }

  // zoneFor returns the zone to show a call in: that of its session when the
  // session reported one, else the memory's default.
  private zoneFor(sessionId: string | undefined): string {
    const id = trimSpace(sessionId ?? "");
    const tz = id === "" ? "" : (this.store.session(id)?.tz ?? "");
    // A zone stored by an earlier runtime may be unknown to this one.
    const zone = (tz !== "" ? knownZone(tz) : undefined) ?? knownZone(this.store.defaultZone());
    return zone ?? UTC;
  }

  // getContext starts a session and returns what it is shown. A time zone
  // the runtime does not know is not kept.
  getContext(args: { model?: string; client?: string; timezone?: string }): ContextView | Invalid {
    return outcome(() => this.startContext(args).view);
  }

  private startContext(args: { model?: string; client?: string; timezone?: string }): {
    view: ContextView;
    zone: string;
    unknownZone?: string;
  } {
    const asked = trimSpace(args.timezone ?? "");
    const known = asked === "" ? undefined : knownZone(asked);
    const view = this.service.context(args.model ?? "", args.client ?? "", known ?? "");
    const zone = known ?? this.zoneFor(undefined);
    return asked !== "" && known === undefined ? { view, zone, unknownZone: asked } : { view, zone };
  }

  remember(args: RememberArgs): { id: string; dup: boolean } | Invalid {
    return outcome(() => {
      const { happenedAt, ...req } = args;
      let happened: number | undefined;
      if (happenedAt !== undefined && trimSpace(happenedAt) !== "") happened = parseWhen(happenedAt, this.zoneFor(req.sessionId));
      const r = this.service.remember({ ...req, happened });
      if (!r.dup) this.wake();
      return r;
    });
  }

  recall(args: RecallArgs): Result[] | Invalid {
    return outcome(() => this.recallWith(args));
  }

  expand(args: { ids: string[]; sessionId?: string }): Result[] | Invalid {
    return outcome(() => this.expandWith(args.ids ?? [], args.sessionId ?? ""));
  }

  // amend changes how a memory is remembered, or sets or drops a preference,
  // and returns a sentence saying what was done.
  amend(args: AmendRequest): string | Invalid {
    return outcome(() => this.amendWith(args));
  }

  // erase deletes what a memory says, for good.
  erase(args: EraseRequest): string | Invalid {
    return outcome(() => this.service.erase(args));
  }

  // beginReflect opens a round of reflection and hands it a batch of
  // fragments; the batch is empty when nothing waits.
  beginReflect(args: { sessionId?: string; limit?: number }): ReflectView | Invalid {
    return outcome(() => this.service.beginReflect(args.sessionId ?? "", args.limit ?? 0));
  }

  // finishReflect writes a round back and returns the ids of the memories it
  // made, in the order of the entries.
  finishReflect(args: { sessionId?: string; batch?: string; entries?: EntryRequest[]; pass?: string[] }): string[] | Invalid {
    return outcome(() =>
      this.finishReflectWith(args.sessionId ?? "", args.batch ?? "", args.entries ?? [], args.pass ?? []),
    );
  }

  check(): Report {
    return this.service.check();
  }

  // answer carries out one tool call and lays its answer out as text, as
  // Go's server does, with times in the zone of the session that asked.
  // instance, when given, is the one the call's grant was made for.
  answer(call: ToolCall, instance?: string): Answer {
    // Never build a store for a name that holds nothing: a call let in just
    // before a deletion, or by a grant that outlived it, would make one.
    if (!this.holdsMemory()) return { gone: true };
    if (instance !== undefined && instance !== this.instance()) return { gone: true };
    return outcome((): Answer => {
      switch (call.tool) {
        case "get_context": {
          const { view, zone, unknownZone } = this.startContext(call);
          return { text: formatContext(view, zone, unknownZone) };
        }
        case "remember": {
          const r = this.remember(call.args);
          if ("invalid" in r) return r;
          return { text: (r.dup ? "already remembered as " : "remembered as ") + r.id };
        }
        case "recall": {
          const results = this.recallWith(call);
          const listed = trimSpace(call.query ?? "") === "";
          const span = trimSpace(call.since ?? "") !== "" || trimSpace(call.until ?? "") !== "";
          return { text: formatRecall(results, call.deep ?? false, this.zoneFor(call.sessionId), listed ? { span } : undefined) };
        }
        case "expand": {
          const results = this.expandWith(call.ids, call.sessionId ?? "");
          return { text: formatExpand(results, this.zoneFor(call.sessionId)) };
        }
        case "reflect": {
          const entries = call.entries ?? [];
          const pass = call.pass ?? [];
          if (trimSpace(call.batch ?? "") === "") {
            if (entries.length > 0 || pass.length > 0) {
              throw new InvalidInput(
                "batch is required to write back: call reflect with your session id alone first, and pass the batch id it returns",
              );
            }
            const view = this.service.beginReflect(call.sessionId, call.limit ?? 0);
            return { text: formatBatch(view, this.zoneFor(call.sessionId)) };
          }
          const ids = this.finishReflectWith(call.sessionId, call.batch ?? "", entries, pass);
          return { text: formatWritten(ids, entries.map((e) => e.kind ?? ""), pass.length) };
        }
        case "amend":
          return { text: this.amendWith(call.args) };
        case "erase":
          return { text: this.service.erase(call.args) };
        case "check":
          return { text: reportText(this.service.check()) };
      }
    });
  }

  params(): Params {
    return this.store.params();
  }

  // setParams stores new forgetting parameters and rebuilds the derived
  // tables with them; it returns the parameters now in force.
  setParams(p: Params): Params | Invalid {
    return outcome(() => {
      this.store.setParams(p);
      return this.store.params();
    });
  }

  // usage reports the rows read and written since the last reset; reset
  // starts the count again.
  usage(reset = false): Usage {
    const u = this.store.usage();
    if (reset) this.store.resetUsage();
    return u;
  }

  // ---- The owner's methods, behind the admin API. Each answers "unknown"
  // for a memory that was never created, without building anything.

  private exists(): boolean {
    return this.storedTokenHash() !== undefined;
  }

  // eventCount counts the log without building the store, so that a memory
  // too large to replay is refused before anything replays it.
  private eventCount(): number {
    return this.ctx.storage.sql.exec<{ c: number }>(`SELECT count(*) AS c FROM events`).one().c;
  }

  private tooLarge(what: string): TooLarge | undefined {
    const n = this.eventCount();
    if (n <= maxEventsInOneGo) return undefined;
    return {
      tooLarge: `this memory holds ${n} events, more than this build can ${what} in one go (at most ${maxEventsInOneGo})`,
    };
  }

  // logDb reads the log tables without building the store, as Go's LogOnly
  // store does: listing or exporting a memory never replays its log.
  private logDb(): Db {
    return new Db(this.ctx.storage.sql);
  }

  // stats reports what the log says about the memory.
  stats(): LogStats | "unknown" {
    return this.exists() ? readLogStats(this.logDb()) : "unknown";
  }

  // describe reports the figures of stats, the forgetting parameters, the
  // default time zone and the vectors.
  describe(): MemorySettings & { stats: LogStats; vectors: VectorReport } | "unknown" {
    if (!this.exists()) return "unknown";
    const label = this.emb?.label;
    return {
      stats: this.store.logStats(), params: this.store.params(), timeZone: this.store.defaultZone(),
      vectors: { embedding: label ?? null, ...this.store.vectorFigures(label) },
    };
  }

  // changeSettings sets the forgetting parameters given (the others stay as
  // they are), the default time zone, or both. Both are checked before
  // either is stored, so an invalid value changes nothing.
  changeSettings(change: SettingsChange): MemorySettings | Invalid | TooLarge | "unknown" {
    if (!this.exists()) return "unknown";
    const now = this.store.params();
    const next = resolveSettings(change, now);
    if (typeof next === "string") return { invalid: next };
    if (paramsDiffer(now, next.params)) {
      // New parameters replay the log, as a rebuild does.
      const big = this.tooLarge("replay");
      if (big !== undefined) return big;
      this.store.setParams(next.params);
      this.askFull(); // what is archived may have changed
    }
    if (next.timeZone !== undefined) this.store.setDefaultZone(next.timeZone);
    return { params: this.store.params(), timeZone: this.store.defaultZone() };
  }

  // report looks the memory over, as the check tool does.
  report(): Report | "unknown" {
    return this.exists() ? this.service.check() : "unknown";
  }

  // rebuildAll replays the whole log into fresh derived tables and reports
  // how many memories they hold and how many events were replayed.
  rebuildAll(): { memories: number; events: number } | TooLarge | "unknown" {
    if (!this.exists()) return "unknown";
    const big = this.tooLarge("rebuild");
    if (big !== undefined) return big;
    this.store.rebuild();
    this.askFull();
    return this.store.counts();
  }

  // exportAll writes the memory as Go's plain export. The whole file is made
  // in this one call, which has no await in it, so no other call runs on the
  // object between its first read and its last: it describes one state of
  // the memory. Only then is it handed back, as a stream, which also keeps a
  // large file clear of the 32 MiB limit on an RPC message.
  exportAll(): ExportFile | TooLarge | "unknown" {
    if (!this.exists()) return "unknown";
    const big = this.tooLarge("export");
    if (big !== undefined) return big;
    // The file is built in memory: what it is mostly made of is weighed first.
    const bytes = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT (SELECT COALESCE(sum(octet_length(payload)), 0) FROM events)
              + (SELECT COALESCE(sum(octet_length(data)), 0) FROM contents) AS n`,
      )
      .one().n;
    if (bytes > this.byteLimit) {
      return {
        tooLarge: `this memory holds ${bytes} bytes of payloads and contents, more than this build can export in one go (at most ${this.byteLimit})`,
      };
    }
    const db = this.logDb();
    const stored = db.getMeta(metaParams);
    const settings = { params: stored === undefined ? defaultParams() : parseParams(stored), timeZone: db.getMeta(metaZone) ?? UTC };
    const exportedAt = this.now();
    const { text, events } = writeExport(
      db,
      exportedAt,
      isDefault(settings) ? undefined : { params: settings.params, timezone: settings.timeZone },
    );
    return { events, exportedAt, body: new Response(text).body! };
  }

  // importFrom creates this memory from an export. tokenHash is used when
  // the export holds none. Reading the body is the only await: everything
  // after it, from the check that the memory does not exist to the last
  // write, runs in one synchronous stretch, so no other call sees a part of
  // it. Every check Go makes is made before the database is touched; if the
  // log then cannot be replayed, the transaction that wrote it rolls back and
  // the tables the store created are deleted, so the object stores nothing.
  async importFrom(body: ReadableStream<Uint8Array>, tokenHash: string): Promise<ImportOutcome> {
    // The body is counted as it is read, and reading stops at the limit:
    // the Worker's look at content-length can be fooled.
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > this.byteLimit) {
        await reader.cancel();
        return { tooLarge: tooManyBytes(this.byteLimit) };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.byteLength;
    }
    chunks.length = 0;
    // A byte order mark is kept, so that it is refused as Go refuses it; a
    // byte that is not UTF-8 reads as U+FFFD, as Go reads it in a string.
    const file = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
    if (this.hasLog()) return { exists: true };
    let parsed: ParsedExport;
    try {
      parsed = parseExport(file, maxEventsInOneGo, (f) => new LogFormatError(f, f > logFormat).message);
    } catch (err) {
      if (err instanceof TooLargeError) return { tooLarge: err.message };
      if (err instanceof ExportError || err instanceof FormatRefusal) return { invalid: err.message };
      throw err;
    }
    // The settings the export carries are checked as the settings route
    // checks them, before anything is written.
    let settings: { params: Params; timeZone?: string } | undefined;
    if (parsed.settings !== undefined) {
      const s = exportSettings(parsed.settings);
      if (typeof s === "string") return { invalid: `not a usable export: its settings are invalid: ${s}` };
      settings = s;
    }
    try {
      this.store.restore(parsed, this.now(), tokenHash, settings);
    } catch (err) {
      this.built = undefined;
      this.instanceId = undefined;
      // On SQLite storage this empties the database at once and atomically;
      // the promise only reports that the write was confirmed.
      void this.ctx.storage.deleteAll();
      if (err instanceof ReplayError) return { invalid: `not a usable export: ${err.message}` };
      throw err;
    }
    this.askFull(); // vectors are not imported: it embeds itself afresh
    return {
      imported: {
        events: parsed.events.length,
        memories: parsed.memories,
        exportedAt: parsed.exportedAt,
        keptToken: parsed.tokenHash !== "",
      },
    };
  }

  // hasLog reports whether the database holds a log, even one without a
  // token: the store creates these tables before anything else. Tables the
  // runtime keeps for itself (such as wrangler dev's __miniflare_do_name)
  // do not count.
  private hasLog(): boolean {
    return (
      this.ctx.storage.sql
        .exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN ('events', 'meta', 'contents', 'vector_rows') LIMIT 1`)
        .toArray().length > 0
    );
  }
}

// maxEventsInOneGo is the most events a rebuild, an export or an import
// handles; each runs in one call to the object for now.
export const maxEventsInOneGo = 50_000;

// maxBytesInOneGo is the largest export an import reads, and the most bytes
// of payloads and contents an export is built from. An object has 128 MB,
// and an import holds the body, its text and its parsed lines at once.
export const maxBytesInOneGo = 24 * 1024 * 1024;

export function tooManyBytes(limit: number): string {
  return `the export holds more than ${limit} bytes, more than this build can bring back in one go`;
}

// exportSettings checks the settings an export's header carries, in the
// form {"params": {...}, "timezone": "..."}, either part optional, and
// returns them resolved against the defaults, or says what is wrong.
function exportSettings(v: unknown): { params: Params; timeZone?: string } | string {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "settings must be an object";
  const change: SettingsChange = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === "params") {
      const p = readParams(x);
      if (typeof p === "string") return p;
      change.params = p;
    } else if (k === "timezone") {
      if (typeof x !== "string") return "timezone must be a string, an IANA name such as Asia/Shanghai";
      change.timeZone = x;
    } else {
      return `unknown setting ${JSON.stringify(k)}: give params, timezone or both`;
    }
  }
  return resolveSettings(change, defaultParams());
}

// TooLarge is a memory or an export with more events than one call handles.
export interface TooLarge {
  tooLarge: string;
}

export type MemorySettings = Settings;

// VectorReport is what describe says of the vectors: the label in use (null
// when search by meaning is off), how many are held under each label, and
// how many memories wait for one of the label in use.
export interface VectorReport {
  embedding: Label | null;
  held: HeldFigure[];
  waiting: number | null;
}

export interface ExportFile {
  events: number;
  exportedAt: number;
  body: ReadableStream<Uint8Array>;
}

export type ImportOutcome =
  | { imported: { events: number; memories: number; exportedAt: number; keptToken: boolean } }
  | { exists: true }
  | TooLarge
  | Invalid;

