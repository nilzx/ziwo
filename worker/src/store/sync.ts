import { z } from 'zod';
import type { ThreadBinding } from '../bindings';
import { Db, text } from './db';
import { readIdentity } from './identity';
import { digest, PersonaError, Personas } from './persona';
import { metaInstance } from './schema';

// Runtime delivery state is not autobiography. Restores deliberately start a
// new cursor at zero; no capability or in-flight turn is imported from backups.
export const syncSchema = `
CREATE TABLE IF NOT EXISTS sync_threads (id TEXT PRIMARY KEY, instance TEXT NOT NULL, cursor INTEGER NOT NULL, active TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS sync_snapshots (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS sync_calls (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL) STRICT;
`;
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const index = z.number().int().safe().nonnegative();
const pageReceipt = z.object({ after: index, next: index, digest: hash }).strict();
const beginInput = z.object({ threadId: id, turnId: id, requestId: id, reload: z.boolean().default(false) }).strict();
const ackInput = z.object({ threadId: id, snapshotId: hash, personaVersion: index, personaDigest: hash, pages: z.array(pageReceipt).min(1).max(10000) }).strict();
interface Snapshot {
  id: string; owner: string; instance: string; thread: string; turnId: string;
  fingerprint: string; from: number; upper: number; version: number; personaDigest: string;
  pages: z.infer<typeof pageReceipt>[]; acknowledged: boolean; ended: boolean;
}
const key = (b: ThreadBinding) => digest([b.harnessId, b.threadId]);
function fail(message: string, status: 400 | 403 | 409 = 409): never { throw new PersonaError(status, message); }
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const p = schema.safeParse(raw); if (!p.success) fail('invalid synchronization request', 400); return p.data;
}
export class Sync {
  constructor(private readonly db: Db, private readonly storage: DurableObjectStorage) {}
  private target(b: ThreadBinding) {
    if (readIdentity(this.db)?.id !== b.identityId || this.db.getMeta(metaInstance) !== b.instance) fail('bound subject or instance is unavailable');
  }
  private activation(b: ThreadBinding): { sessionId: string } {
    this.target(b);
    const row = this.db.first('SELECT record FROM activations WHERE id = ?', key(b));
    if (row === undefined) fail('initialize the bound conversation first');
    const a = JSON.parse(text(row.record));
    if (a.identityId !== b.identityId || a.activationId !== b.activationId || !a.completed || !a.sealed) fail('initial history processing is incomplete');
    return a;
  }
  private upper(): number { return Number(this.db.first('SELECT COALESCE(MAX(seq), 0) AS n FROM events')!.n); }
  private state(b: ThreadBinding) {
    this.target(b);
    const row = this.db.first('SELECT * FROM sync_threads WHERE id = ? AND instance = ?', key(b), b.instance);
    return { cursor: Number(row?.cursor ?? 0), active: String(row?.active ?? '') };
  }
  private persona(b: ThreadBinding) { return new Personas(this.db, this.storage).load(b.identityId, b.instance); }
  status(b: ThreadBinding) {
    this.activation(b); const p = this.persona(b), s = this.state(b);
    return { cursor: s.cursor, upper: this.upper(), personaVersion: p.version, personaDigest: p.digest };
  }
  private save(s: Snapshot) { this.db.run('INSERT INTO sync_snapshots(id, record) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record', s.id, JSON.stringify(s)); }
  private get(b: ThreadBinding, snapshotId: string): Snapshot {
    this.activation(b);
    const row = this.db.first('SELECT record FROM sync_snapshots WHERE id = ?', snapshotId);
    if (row === undefined) fail('synchronization snapshot is unavailable; begin again');
    const s = JSON.parse(text(row.record)) as Snapshot;
    if (s.owner !== b.identityId || s.instance !== b.instance || s.thread !== key(b) || this.state(b).active !== s.id || s.ended) fail('synchronization snapshot is not active for this conversation');
    return s;
  }
  private validBeforeLoad(b: ThreadBinding, s: Snapshot) {
    const p = this.persona(b);
    if (p.version !== s.version || p.digest !== s.personaDigest) fail('persona changed before loading; begin a new synchronization');
    if (this.db.first("SELECT 1 AS changed FROM events WHERE seq > ? AND kind = 'erase' LIMIT 1", s.upper)) fail('content was erased before loading; begin a new synchronization');
    return p;
  }
  begin(b: ThreadBinding, raw: unknown) {
    return this.storage.transactionSync(() => {
      const p = parse(beginInput, raw); if (p.threadId !== b.threadId) fail('thread mismatch');
      this.activation(b); const state = this.state(b), persona = this.persona(b);
      const sid = digest([key(b), b.instance, p.requestId]);
      const prior = this.db.first('SELECT record FROM sync_snapshots WHERE id = ?', sid);
      let s: Snapshot;
      if (prior) {
        s = this.get(b, sid); if (s.fingerprint !== digest(p)) fail('request identifier was reused with different arguments');
        this.validBeforeLoad(b, s);
      } else {
        s = { id: sid, owner: b.identityId, instance: b.instance, thread: key(b), turnId: p.turnId, fingerprint: digest(p),
          from: p.reload ? 0 : state.cursor, upper: this.upper(), version: persona.version, personaDigest: persona.digest,
          pages: [], acknowledged: false, ended: false };
        if (s.from > s.upper) fail('synchronization cursor is outside the log; reload is required');
        this.save(s);
        this.db.run('INSERT INTO sync_threads(id, instance, cursor, active) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET instance = excluded.instance, cursor = excluded.cursor, active = excluded.active', key(b), b.instance, state.cursor, sid);
      }
      return { snapshotId: s.id, from: s.from, upper: s.upper, cursor: state.cursor, persona, acknowledged: s.acknowledged };
    });
  }
  page(b: ThreadBinding, raw: unknown) {
    return this.storage.transactionSync(() => {
      const p = parse(z.object({ snapshotId: hash, after: index }).strict(), raw), s = this.get(b, p.snapshotId);
      if (s.acknowledged) fail('snapshot was already loaded');
      this.validBeforeLoad(b, s);
      const prior = s.pages.find(r => r.after === p.after);
      const expected = s.pages.at(-1)?.next ?? s.from;
      if (!prior && (p.after !== expected || (s.pages.length > 0 && expected === s.upper))) fail('page cursor is not the next expected position');
      const rows = this.db.all('SELECT seq, at, kind, payload FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT 50', p.after, s.upper);
      const next = rows.length === 50 ? Number(rows.at(-1)!.seq) : s.upper;
      const changes: Record<string, unknown>[] = [];
      for (const row of rows) {
        const kind = text(row.kind); if (!['remember', 'amend', 'erase', 'reflect', 'restore'].includes(kind)) continue;
        const e = JSON.parse(text(row.payload));
        const change: Record<string, unknown> = { seq: Number(row.seq), writtenAt: Number(row.at), kind };
        // Never replay free-form log reasons, queries, or deleted content.
        if (typeof e.id === 'string') change.id = e.id;
        if (kind === 'remember') {
          const content = this.db.first('SELECT data FROM contents WHERE id = ?', e.id);
          change.gist = content ? JSON.parse(text(content.data)).gist : null;
          change.erased = content === undefined;
          change.memoryKind = e.kind || 'fragment'; change.corrects = e.corrects ?? null;
          change.source = e.source; change.timePrecision = e.time_precision ?? 'instant';
          change.occurredAt = e.time_precision === 'unknown' ? null : e.happened || Number(row.at);
          if (e.happened_on) change.occurredOn = e.happened_on;
          if (e.replaces) change.replaces = e.replaces;
        } else if (kind === 'amend') {
          change.action = e.action;
          if (e.action === 'prefer') change.text = e.text;
        } else if (kind === 'reflect') { change.wrote = e.wrote ?? []; change.passed = e.passed ?? []; }
        changes.push(change);
      }
      const result = { after: p.after, next, upper: s.upper, changes };
      const receipt = { after: p.after, next, digest: digest(result) };
      if (prior && prior.digest !== receipt.digest) fail('page contents changed before loading; begin again');
      if (!prior) { s.pages.push(receipt); this.save(s); }
      return { ...result, digest: receipt.digest };
    });
  }
  ack(b: ThreadBinding, raw: unknown) {
    return this.storage.transactionSync(() => {
      const p = parse(ackInput, raw); if (p.threadId !== b.threadId) fail('thread mismatch');
      const s = this.get(b, p.snapshotId);
      if (p.personaVersion !== s.version || p.personaDigest !== s.personaDigest || digest(p.pages) !== digest(s.pages) || s.pages.at(-1)?.next !== s.upper) fail('loading receipt does not cover the complete snapshot');
      if (!s.acknowledged) {
        this.validBeforeLoad(b, s); s.acknowledged = true; this.save(s);
        this.db.run("UPDATE activations SET record = json_set(record, '$.loaded', json(?)) WHERE id = ?", JSON.stringify({ version: s.version, digest: s.personaDigest, instance: b.instance }), key(b));
        this.db.run('UPDATE sync_threads SET cursor = MAX(cursor, ?) WHERE id = ? AND instance = ?', s.upper, key(b), b.instance);
      }
      return { acknowledged: true, cursor: this.state(b).cursor, snapshotId: s.id };
    });
  }
  end(b: ThreadBinding, raw: unknown) {
    const p = parse(z.object({ threadId: id, snapshotId: hash }).strict(), raw);
    if (p.threadId !== b.threadId) fail('thread mismatch');
    const s = this.get(b, p.snapshotId); s.ended = true; this.save(s); return { ended: true };
  }
  run<T>(b: ThreadBinding, snapshotId: string, requestId: string, fingerprint: unknown, invoke: (session: string) => T): T | { text: string; replayed: true } {
    return this.storage.transactionSync(() => {
      const s = this.get(b, snapshotId); if (!s.acknowledged) fail('load and acknowledge this turn before using memory tools', 403);
      const rid = digest([key(b), b.instance, requestId]), fp = digest(fingerprint);
      const prior = this.db.first('SELECT fingerprint FROM sync_calls WHERE id = ?', rid);
      if (prior) {
        if (prior.fingerprint !== fp) fail('tool request identifier was reused');
        return { replayed: true, text: 'This tool call already completed. It was not repeated. Use a new read request if its result is needed.' };
      }
      const result = invoke(this.activation(b).sessionId);
      this.db.run('INSERT INTO sync_calls(id, fingerprint) VALUES(?, ?)', rid, fp);
      return result;
    });
  }
}
