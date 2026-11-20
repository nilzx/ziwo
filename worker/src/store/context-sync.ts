import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Db, text } from './db';
import { readIdentity } from './identity';
import { digest, PersonaError, type Personas } from './persona';
import { materialKinds, materialRevision } from './revisions';
import { metaInstance, metaTokenHash } from './schema';

export const contextSyncInput = z.object({
  cursor: z.string().min(1).max(2048).optional().describe('Opaque cursor from the last fully applied sync page in this conversation. Never borrow another conversation\'s cursor.'),
  reload: z.boolean().default(false).describe('Reload all material after losing local context. Keep the old cursor to verify the same subject and instance.'),
  page_size: z.number().int().min(1).max(100).default(32).describe('Maximum material events per page. Continue until complete is true before answering.'),
}).strict();
const ordinal = z.number().int().safe().nonnegative();
const cursorSchema = z.object({
  v: z.literal(1), owner: z.string(), instance: z.string(),
  from: ordinal, after: ordinal, upper: ordinal, complete: z.boolean(),
  persona: z.string(),
}).strict();
type Cursor = z.infer<typeof cursorSchema>;
function fail(message: string): never { throw new PersonaError(409, message); }

// A cursor is a tamper-evident read position, not a conversation identity,
// credential, persona approval, or proof that a model loaded a response.
export class ContextSync {
  constructor(private readonly db: Db, private readonly personas: Personas) {}
  private sign(payload: string, key: string): string {
    return createHmac('sha256', key).update('ziwo-context-v1\0' + payload).digest('base64url');
  }
  private encode(cursor: Cursor, key: string): string {
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return payload + '.' + this.sign(payload, key);
  }
  private decode(raw: string, key: string): Cursor {
    const parts = raw.split('.');
    if (parts.length !== 2 || !parts.every(s => /^[A-Za-z0-9_-]+$/.test(s))) fail('invalid sync cursor; reload the same subject explicitly');
    const [payload, signature] = parts as [string, string];
    const expected = this.sign(payload, key);
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) fail('invalid or expired sync cursor; reload the same subject explicitly');
    let rawCursor: unknown;
    try { rawCursor = JSON.parse(Buffer.from(payload, 'base64url').toString()); }
    catch { fail('invalid sync cursor'); }
    const parsed = cursorSchema.safeParse(rawCursor);
    if (!parsed.success) fail('invalid sync cursor');
    const c = parsed.data;
    if (c.from > c.after || c.after > c.upper || (c.complete && c.after !== c.upper)) fail('invalid sync cursor range');
    return c;
  }
  read(raw: unknown, expectedInstance?: string): Record<string, unknown> {
    const parsed = contextSyncInput.safeParse(raw);
    if (!parsed.success) throw new PersonaError(400, 'invalid context synchronization request');
    const p = parsed.data, owner = readIdentity(this.db)?.id, instance = this.db.getMeta(metaInstance);
    if (!owner || !instance || (expectedInstance !== undefined && instance !== expectedInstance)) fail('subject or instance is unavailable; do not rebind an active conversation');
    const key = this.db.getMeta(metaTokenHash);
    if (!key) fail('memory is unavailable');
    const prior = p.cursor === undefined ? undefined : this.decode(p.cursor, key);
    if (prior && (prior.owner !== owner || prior.instance !== instance)) fail('sync cursor belongs to a different subject or instance; rebinding is forbidden');
    const current = materialRevision(this.db);
    if (prior && prior.upper > current) fail('sync cursor is outside the current history; reload is required');
    const loaded = this.db.first('SELECT version FROM persona_current WHERE singleton = 1') === undefined ? undefined : this.personas.load(owner, instance);
    const persona = loaded === undefined ? { status: 'uninitialized' as const }
      : { status: 'adopted' as const, version: loaded.version, digest: loaded.digest, document: loaded.document };
    const personaMark = persona.status === 'adopted' ? digest([persona.version, persona.digest]) : 'uninitialized';
    const continuing = prior !== undefined && !prior.complete && !p.reload;
    const from = p.reload || prior === undefined ? 0 : continuing ? prior.from : prior.after;
    const after = p.reload || prior === undefined ? 0 : prior.after;
    const upper = continuing ? prior.upper : current;
    if (continuing && (prior.persona !== personaMark || this.db.first("SELECT 1 AS changed FROM events WHERE seq > ? AND kind = 'erase' LIMIT 1", upper))) {
      fail('sync page was invalidated by persona revision or erasure; discard the unfinished page set and reload the same subject');
    }
    const rows = this.db.all(`SELECT seq, at, kind, payload FROM events WHERE seq > ? AND seq <= ? AND ${materialKinds} ORDER BY seq LIMIT ?`, after, upper, p.page_size);
    const changes: Record<string, unknown>[] = [];
    let next = after, bytes = 0;
    for (const row of rows) {
      const kind = text(row.kind), event = JSON.parse(text(row.payload));
      const change: Record<string, unknown> = { seq: Number(row.seq), at: Number(row.at), kind };
      // Content lives outside the append-only log so erased text is never
      // replayed. Prose reasons and search/read traces are not synchronized.
      for (const field of ['id', 'session', 'action', 'importance', 'intensity', 'moment', 'source', 'corrects', 'happened', 'time_precision', 'happened_on', 'from', 'ref', 'milestone', 'replaces', 'subject', 'wrote', 'passed']) {
        if (event[field] !== undefined) change[field] = event[field];
      }
      if (kind === 'remember') {
        change.memory_kind = event.kind || 'fragment';
        const content = this.db.first('SELECT data FROM contents WHERE id = ?', event.id);
        change.content = content === undefined ? null : JSON.parse(text(content.data));
        change.erased = content === undefined;
      } else if (kind === 'amend' && event.action === 'prefer') change.text = event.text;
      else if (kind === 'restore') change.restored = true;
      const size = new TextEncoder().encode(JSON.stringify(change)).byteLength;
      // Always make progress for one valid large record, then keep pages
      // small. The existing memory input limits bound any single record.
      if (changes.length > 0 && bytes + size > 65536) break;
      changes.push(change); bytes += size; next = Number(row.seq);
    }
    const more = this.db.first(`SELECT 1 AS more FROM events WHERE seq > ? AND seq <= ? AND ${materialKinds} LIMIT 1`, next, upper) !== undefined;
    if (!more) next = upper;
    const cursor = this.encode({ v: 1, owner, instance, from, after: next, upper, complete: !more, persona: personaMark }, key);
    return {
      schema_version: 1, identity: { id: owner, instance }, cursor, complete: !more,
      from: after, through: next, upper, changes,
      ...((p.reload || prior === undefined || prior.persona !== personaMark) ? { persona } : {}),
    };
  }
}
