import { z } from 'zod';
import type { ThreadBinding } from '../bindings';
import { clean, InvalidInput, Moments, parseWhen } from '../memory/clean';
import type { Service } from '../memory/service';
import { knownZone, UTC } from '../zone';
import { Db, text } from './db';
import { readIdentity } from './identity';
import { metaInstance } from './schema';
import type { Store } from './store';
import { digest, PersonaError, Personas } from './persona';

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const index = z.number().int().safe().nonnegative();
const anchor = z.object({ turnId: id, itemId: id, sequence: index }).strict();
const gap = z.object({ id, from: index.nullable(), to: index.nullable(), reason: z.enum(['unavailable', 'truncated', 'summary_only', 'cursor_invalid', 'unreadable']) }).strict().refine(g => (g.from === null && g.to === null) || (g.from !== null && g.to !== null && g.from <= g.to));
export const scopeSchema = z.object({ boundaryId: id, cutoff: anchor.nullable(), coverage: z.enum(['complete', 'partial']), gaps: z.array(gap).max(100) }).strict();
const occurrence = z.discriminatedUnion('precision', [
  z.object({ precision: z.literal('unknown') }).strict(),
  z.object({ precision: z.literal('day'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  z.object({ precision: z.literal('instant'), at: index.refine(n => n > 0) }).strict(),
]);
export const historyItem = z.object({ itemId: id, turnId: id, sequence: index, contentDigest: hash,
  material: z.enum(['original', 'summary']), status: z.literal('completed'), occurrence }).strict();
type HistoryItem = z.infer<typeof historyItem>;
const loadedSchema = z.object({ version: index, digest: hash, instance: id }).strict();
const recordSchema = z.object({ id: hash, identityId: id, harnessId: id, threadId: id, activationId: id,
  sourceThreadId: id, sourceActivationId: id, sessionId: id, model: z.string().max(120), client: z.string().max(120), timezone: z.string().max(100),
  scope: scopeSchema, items: z.array(historyItem).max(5000), sealed: z.boolean(), completed: z.boolean(),
  loaded: loadedSchema, startFingerprint: hash, createdAt: index, noticeAcknowledged: z.boolean(), resolvedGaps: z.array(id).max(100),
}).strict();
export type Activation = z.infer<typeof recordSchema>;
export type ActivationReadinessCache = Map<string, { revision: number; owner: string; instance: string; activation: string; sessionId: string }>;
const receiptSchema = z.object({ id: hash, sourceFingerprint: hash, decisionFingerprint: hash, memoryId: id.nullable(), material: z.enum(['original', 'summary']), at: index }).strict();
type Receipt = z.infer<typeof receiptSchema>;
const requestSchema = z.object({ id: hash, fingerprint: hash }).strict();
const backupSchema = z.object({ identityId: id, activations: z.array(recordSchema), receipts: z.array(receiptSchema), requests: z.array(requestSchema) }).strict();
export type ActivationBackup = z.infer<typeof backupSchema>;
const common = z.object({ threadId: id });
const beginInput = common.extend({ personaVersion: index, personaDigest: hash, model: z.string().max(120), client: z.string().max(120), timezone: z.string().max(100).default('UTC'), scope: scopeSchema.optional() }).strict();
const ackInput = common.extend({ personaVersion: index, personaDigest: hash }).strict();
const pageInput = common.extend({ requestId: id, beforeBoundaryId: id, offset: index, items: z.array(historyItem).max(100), final: z.boolean() }).strict();
const memoryInput = z.object({
  gist: z.string().min(1).describe('Brief factual account supported by this original history item; preserve hypothetical or fictional status.'),
  body: z.string().min(1).describe('Only what the original item records, including the subject\'s actual part. Do not invent missing actions, motives, outcomes, feelings, or lessons.'),
  moment: z.enum([...Moments, '']).optional().describe('The kind of recorded occasion; omit for other. An empty string is accepted as a legacy alias for other.'),
  importance: z.number().min(0).max(1).optional().describe('Retention importance from 0 to 1; default 0.5.'),
  intensity: z.number().min(0).max(1).optional().describe('Only an intensity from 0 to 1 explicitly supported by a recorded feeling; otherwise omit.'),
  outcome: z.string().optional().describe('Only an outcome recorded in the source; otherwise omit.'),
  feeling: z.string().optional().describe('Only a feeling explicitly recorded in the original source. If none is recorded, omit this field; do not default to neutral or infer an emotion.'),
  lesson: z.string().optional().describe('Only a lesson actually expressed in the source, not a new retrospective interpretation.'),
  people: z.array(z.string()).optional(), pointer: z.string().optional(),
}).strict();
const decision = z.discriminatedUnion('action', [
  z.object({ itemId: id, action: z.literal('remember'), memory: memoryInput }).strict(),
  z.object({ itemId: id, action: z.literal('skip'), reason: z.enum(['not_memorable', 'duplicate', 'summary_only', 'irrelevant']) }).strict(),
]);
export const batchInput = common.extend({ requestId: id, decisions: z.array(decision).min(1).max(20) }).strict();
export const finishInput = common.extend({ requestId: id, resolveGaps: z.array(id).max(100).default([]) }).strict();
const anchorInput = common.extend({ requestId: id, beforeBoundaryId: id, cutoff: anchor, status: z.literal('completed'), readable: z.literal(true) }).strict();
const reopenInput = common.extend({ requestId: id, beforeBoundaryId: id }).strict();
function fail(message: string, status: 400 | 403 | 404 | 409 | 413 = 409): never { throw new PersonaError(status, message); }
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const p = schema.safeParse(raw); if (!p.success) fail('invalid activation request or record', 400); return p.data;
}
function key(b: Pick<ThreadBinding, 'harnessId' | 'threadId'>): string { return digest([b.harnessId, b.threadId]); }
function sourceKey(a: Activation, item: HistoryItem): string { return digest([a.harnessId, a.sourceThreadId, item.itemId]); }
function sourceFingerprint(a: Activation, item: HistoryItem): string { return digest([a.identityId, a.harnessId, a.sourceThreadId, a.sourceActivationId, a.scope.boundaryId, item]); }
function validateScope(scope: Activation['scope']): void {
  if (new Set(scope.gaps.map(g => g.id)).size !== scope.gaps.length) fail('duplicate history gaps', 400);
  if (scope.coverage === 'complete' && scope.gaps.length !== 0) fail('complete coverage cannot contain gaps', 400);
  if (scope.coverage === 'partial' && scope.gaps.length === 0) fail('partial coverage needs explicit gaps', 400);
  for (const g of scope.gaps) {
    if (scope.cutoff === null ? g.from !== null : g.from === null || g.to! > scope.cutoff.sequence) fail('gap is outside the fixed history boundary', 400);
  }
}
function validateItems(a: Activation): void {
  validateScope(a.scope);
  const ids = new Set<string>(), seqs = new Set<string>();
  for (const i of a.items) {
    if (ids.has(i.itemId) || seqs.has(`${i.sequence}:${i.material}`)) fail('duplicate history item or position');
    ids.add(i.itemId); seqs.add(`${i.sequence}:${i.material}`);
    if (a.scope.cutoff !== null && i.sequence > a.scope.cutoff.sequence) fail('history item is past the first activation cutoff');
    if (a.scope.cutoff === null) fail('history requires a verified cutoff anchor before items can be registered');
    if (i.material === 'summary' && a.scope.coverage === 'complete') fail('a summary is not complete original history');
  }
  if (!a.sealed || a.scope.cutoff === null) return;
  const end = a.scope.cutoff;
  const last = a.items.find(i => i.sequence === end.sequence);
  if (last === undefined || last.itemId !== end.itemId || last.turnId !== end.turnId) fail('the completed cutoff anchor is missing or changed');
  // Intervals avoid walking potentially large missing ranges.
  const intervals = [...a.items.map(i => [i.sequence, i.sequence]), ...a.scope.gaps.filter(g => g.from !== null).map(g => [g.from!, g.to!])].sort((a,b) => a[0]! - b[0]!);
  let next = 0;
  for (const [from, to] of intervals) { if (from! > next) fail('history page coverage has an undeclared gap'); next = Math.max(next, to! + 1); }
  if (next !== end.sequence + 1) fail('history coverage does not reach the fixed cutoff');
}
export function parseActivationBackup(raw: unknown, owner: string): ActivationBackup {
  const b = parse(backupSchema, raw);
  if (b.identityId !== owner) fail('activation owner does not match memory owner', 400);
  if (new Set(b.activations.map(a => a.id)).size !== b.activations.length || new Set(b.receipts.map(r => r.id)).size !== b.receipts.length || new Set(b.requests.map(r => r.id)).size !== b.requests.length) fail('duplicate initialization records', 400);
  for (const a of b.activations) {
    if (a.identityId !== owner || a.id !== key(a) || a.scope.boundaryId !== a.sourceActivationId || (a.completed && !a.sealed)) fail('invalid activation ownership or state', 400);
    validateItems(a);
  }
  return b;
}
export function exportActivations(db: Db): ActivationBackup | undefined {
  if (db.first("SELECT 1 AS ok FROM sqlite_master WHERE name = 'activations' AND type = 'table'") === undefined) return undefined;
  const rows = db.all('SELECT record FROM activations ORDER BY id'); if (rows.length === 0) return undefined;
  const owner = readIdentity(db)?.id; if (owner === undefined) fail('initialization has no owner');
  return parseActivationBackup({ identityId: owner, activations: rows.map(r => JSON.parse(text(r.record))),
    receipts: db.all('SELECT record FROM history_receipts ORDER BY id').map(r => JSON.parse(text(r.record))),
    requests: db.all('SELECT id, fingerprint FROM activation_requests ORDER BY id') }, owner);
}
export class Activations {
  constructor(private readonly db: Db, private readonly storage: DurableObjectStorage, private readonly store: Store, private readonly service: Service, private readonly readiness?: ActivationReadinessCache) {}
  private target(b: ThreadBinding): void {
    if (readIdentity(this.db)?.id !== b.identityId || this.db.getMeta(metaInstance) !== b.instance) fail('bound subject or instance is unavailable');
  }
  private get(b: ThreadBinding): Activation | undefined {
    this.target(b); const r = this.db.first('SELECT record FROM activations WHERE id = ?', key(b));
    if (r === undefined) return undefined;
    const a = parse(recordSchema, JSON.parse(text(r.record)));
    if (a.identityId !== b.identityId || a.activationId !== b.activationId || a.harnessId !== b.harnessId || a.threadId !== b.threadId) fail('activation does not match the original binding');
    validateItems(a);
    return a;
  }
  private need(b: ThreadBinding): Activation { return this.get(b) ?? fail('activation has not started'); }
  private save(a: Activation): void {
    const record = JSON.stringify(a);
    if (new TextEncoder().encode(record).byteLength > 1500000) fail('initialization metadata exceeds its storage limit', 413);
    this.db.run('INSERT INTO activations(id, record) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record', a.id, record);
  }
  private persona(b: ThreadBinding) { return new Personas(this.db, this.storage).load(b.identityId, b.instance); }
  private loaded(b: ThreadBinding, a: Activation): void {
    const p = this.persona(b);
    if (a.loaded.instance !== b.instance || a.loaded.version !== p.version || a.loaded.digest !== p.digest) fail('load and acknowledge the current persona before continuing');
  }
  private receipt(a: Activation, item: HistoryItem): Receipt | undefined {
    const r = this.db.first('SELECT record FROM history_receipts WHERE id = ?', sourceKey(a, item));
    if (r === undefined) return undefined;
    const receipt = parse(receiptSchema, JSON.parse(text(r.record)));
    if (receipt.sourceFingerprint !== sourceFingerprint(a, item)) fail('history source identifier was reused with changed material');
    return receipt;
  }
  readySession(b: ThreadBinding): string {
    this.target(b);
    const revision = Number(this.db.first('SELECT revision FROM activation_revision WHERE singleton = 1')?.revision ?? -1);
    const cached = this.readiness?.get(key(b));
    if (cached && cached.revision === revision && cached.owner === b.identityId && cached.instance === b.instance && cached.activation === b.activationId) return cached.sessionId;
    const a = this.need(b);
    if (!a.completed || !a.sealed || a.items.some(i => this.receipt(a, i) === undefined)) fail('initial conversation history is incomplete');
    if (this.readiness) {
      if (this.readiness.size >= 256) this.readiness.clear();
      this.readiness.set(key(b), { revision, owner: b.identityId, instance: b.instance, activation: b.activationId, sessionId: a.sessionId });
    }
    return a.sessionId;
  }
  status(b: ThreadBinding) {
    const a = this.get(b);
    if (a === undefined) return { phase: 'not_started', canRun: false, historyIncomplete: false, noticePending: false };
    let personaReady = true;
    try { this.loaded(b, a); } catch (e) { if (e instanceof PersonaError) personaReady = false; else throw e; }
    const processed = a.items.filter(i => this.receipt(a, i) !== undefined).length;
    const gaps = a.scope.gaps.filter(g => !a.resolvedGaps.includes(g.id));
    const initializationComplete = a.completed && a.sealed && processed === a.items.length;
    const ready = personaReady && initializationComplete;
    return { phase: !personaReady ? 'persona_required' : !a.sealed ? 'collecting_history' : (!a.completed || processed !== a.items.length) ? 'processing_history' : 'ready',
      canRun: ready, initializationComplete, sessionId: a.sessionId, loadedPersona: a.loaded, total: a.items.length, processed,
      scope: a.scope, gaps, historyIncomplete: gaps.length > 0, noticePending: ready && gaps.length > 0 && !a.noticeAcknowledged };
  }
  begin(b: ThreadBinding, raw: unknown, at: number) {
    return this.storage.transactionSync(() => {
      const p = parse(beginInput, raw); if (p.threadId !== b.threadId) fail('thread mismatch'); this.target(b);
      const existing = this.get(b);
      if (existing !== undefined) { if (existing.startFingerprint !== digest(p)) fail('initial activation parameters are immutable'); this.loaded(b, existing); return this.status(b); }
      const persona = this.persona(b);
      if (persona.version !== p.personaVersion || persona.digest !== p.personaDigest) fail('persona loading acknowledgment is stale');
      if (!knownZone(p.timezone)) fail('unknown time zone', 400);
      let inherited: Activation | undefined;
      if (b.parentThreadId !== null) {
        const r = this.db.first('SELECT record FROM activations WHERE id = ?', key({ harnessId: b.harnessId, threadId: b.parentThreadId }));
        if (r === undefined) fail('initialize the bound parent before resuming its fork');
        inherited = parse(recordSchema, JSON.parse(text(r.record)));
        if (inherited.identityId !== b.identityId || p.scope !== undefined) fail('a fork must inherit the original subject and history scope');
      } else if (p.scope === undefined || p.scope.boundaryId !== b.activationId) fail('the history scope must use the original activation boundary');
      const scope = inherited?.scope ?? p.scope!; validateScope(scope);
      const { session } = this.service.beginSession(p.model, p.client, p.timezone);
      const a: Activation = { id: key(b), identityId: b.identityId, harnessId: b.harnessId, threadId: b.threadId, activationId: b.activationId,
        sourceThreadId: inherited?.sourceThreadId ?? b.threadId, sourceActivationId: inherited?.sourceActivationId ?? b.activationId,
        sessionId: session.id, model: p.model, client: p.client, timezone: p.timezone, scope, items: inherited?.items ?? [],
        sealed: inherited?.sealed ?? false, completed: inherited?.completed ?? false,
        loaded: { version: persona.version, digest: persona.digest, instance: b.instance }, startFingerprint: digest(p), createdAt: at,
        noticeAcknowledged: false, resolvedGaps: inherited?.resolvedGaps ?? [] };
      this.save(a); return this.status(b);
    });
  }
  private request(a: Activation, requestId: string, operation: string, raw: unknown, run: () => void): void {
    const rid = digest([a.id, requestId]); const fingerprint = digest([operation, raw]);
    const prior = this.db.first('SELECT fingerprint FROM activation_requests WHERE id = ?', rid);
    if (prior !== undefined) { if (prior.fingerprint !== fingerprint) fail('request identifier was reused with different arguments'); return; }
    run(); this.save(a); this.db.run('INSERT INTO activation_requests(id, fingerprint) VALUES(?, ?)', rid, fingerprint);
  }
  operate(b: ThreadBinding, operation: string, raw: unknown, at: number) {
    return this.storage.transactionSync(() => {
      const a = this.need(b);
      if (operation === 'persona') {
        const p = parse(ackInput, raw); if (p.threadId !== b.threadId) fail('thread mismatch'); const current = this.persona(b);
        if (p.personaVersion !== current.version || p.personaDigest !== current.digest) fail('persona loading acknowledgment is stale');
        a.loaded = { version: current.version, digest: current.digest, instance: b.instance }; this.save(a); return this.status(b);
      }
      this.loaded(b, a);
      if (operation === 'notice') { const p = parse(common.strict(), raw); if (p.threadId !== b.threadId) fail('thread mismatch'); if (!a.completed) fail('initialization is incomplete'); a.noticeAcknowledged = true; this.save(a); return this.status(b); }
      if (operation === 'manifest') {
        const p = parse(pageInput, raw); if (p.threadId !== b.threadId) fail('thread mismatch');
        this.request(a, p.requestId, operation, p, () => {
          if (a.sealed || a.completed) fail('history manifest is already sealed');
          if (p.beforeBoundaryId !== a.scope.boundaryId || p.offset > a.items.length) fail('history page boundary or offset does not match');
          for (let n = 0; n < p.items.length; n++) {
            const item = p.items[n]!; const prior = a.items[p.offset + n];
            if (prior !== undefined) { if (digest(prior) !== digest(item)) fail('overlapping history page changed'); }
            else a.items.push(item);
          }
          if (a.items.length > 5000) fail('history manifest exceeds 5000 items', 400);
          a.sealed = p.final; validateItems(a);
          for (const i of a.items) this.receipt(a, i);
        });
      } else if (operation === 'anchor') {
        const p = parse(anchorInput, raw); if (p.threadId !== b.threadId) fail('thread mismatch');
        this.request(a, p.requestId, operation, p, () => {
          if (a.scope.cutoff !== null || a.scope.coverage !== 'partial' || a.items.length !== 0 || p.beforeBoundaryId !== a.scope.boundaryId) fail('a verified cutoff can only fill an unanchored original history boundary');
          if (a.sourceThreadId !== a.threadId) {
            const root = this.db.first('SELECT record FROM activations WHERE id = ?', key({ harnessId: a.harnessId, threadId: a.sourceThreadId }));
            const inherited = root === undefined ? undefined : parse(recordSchema, JSON.parse(text(root.record)));
            if (inherited?.scope.cutoff == null || digest(inherited.scope.cutoff) !== digest(p.cutoff)) fail('a fork must inherit the verified cutoff of its source conversation');
          }
          a.scope.cutoff = p.cutoff;
          a.scope.gaps = a.scope.gaps.map(g => ({ ...g, from: 0, to: p.cutoff.sequence }));
          a.completed = false; a.sealed = false;
        });
      } else if (operation === 'batch') {
        const p = parse(batchInput, raw); if (p.threadId !== b.threadId) fail('thread mismatch');
        this.request(a, p.requestId, operation, p, () => {
          if (!a.sealed || a.completed) fail('history is not awaiting processing');
          if (new Set(p.decisions.map(d => d.itemId)).size !== p.decisions.length) fail('duplicate decisions', 400);
          for (const d of p.decisions) {
            const item = a.items.find(i => i.itemId === d.itemId); if (item === undefined) fail('decision is outside the fixed manifest', 403);
            const prior = this.receipt(a, item); const df = digest(d);
            if (prior !== undefined) { if (prior.decisionFingerprint !== df) fail('history item already has a different processing decision'); continue; }
            let memoryId: string | null = null;
            const fingerprint = sourceFingerprint(a, item);
            if (d.action === 'remember') {
              if (item.material === 'summary') fail('summary-only material must be recorded as a gap, not an original experience', 403);
              const when = item.occurrence;
              try {
                const happened = when.precision === 'unknown' ? undefined : when.precision === 'instant' ? when.at : parseWhen(when.date, a.timezone || UTC);
                const input = clean({ ...d.memory, sessionId: a.sessionId, source: 'reconstructed', happened,
                  timePrecision: when.precision, ...(when.precision === 'day' ? { happenedOn: when.date } : {}) }, at);
                memoryId = this.store.rememberHistory(at, input, { key: sourceKey(a, item), fingerprint, material: item.material });
              } catch (e) { if (e instanceof InvalidInput) fail(e.message, 400); throw e; }
            }
            const receipt: Receipt = { id: sourceKey(a, item), sourceFingerprint: fingerprint, decisionFingerprint: df, memoryId, material: item.material, at };
            this.db.run('INSERT INTO history_receipts(id, record) VALUES(?, ?)', receipt.id, JSON.stringify(receipt));
          }
        });
      } else if (operation === 'complete') {
        const p = parse(finishInput, raw); if (p.threadId !== b.threadId) fail('thread mismatch');
        this.request(a, p.requestId, operation, p, () => {
          if (!a.sealed || a.items.some(i => this.receipt(a, i) === undefined)) fail('available history is not fully processed');
          for (const gid of p.resolveGaps) {
            const g = a.scope.gaps.find(g => g.id === gid);
            if (g === undefined || g.from === null) fail('gap cannot be verified as resolved');
            const covered = a.items.filter(i => i.material === 'original' && i.sequence >= g.from! && i.sequence <= g.to!);
            if (covered.length !== g.to! - g.from + 1) fail('gap still lacks original material');
            if (!a.resolvedGaps.includes(gid)) a.resolvedGaps.push(gid);
          }
          a.completed = true;
        });
      } else if (operation === 'supplement') {
        const p = parse(reopenInput, raw); if (p.threadId !== b.threadId) fail('thread mismatch');
        this.request(a, p.requestId, operation, p, () => {
          if (!a.completed || a.scope.coverage !== 'partial' || p.beforeBoundaryId !== a.scope.boundaryId) fail('supplement must stay inside the original incomplete history boundary');
          a.completed = false; a.sealed = false;
        });
      } else fail('unknown activation operation', 404);
      return this.status(b);
    });
  }
  history(b: ThreadBinding, raw: unknown) {
    const p = parse(z.object({ offset: index, limit: index.min(1).max(100) }).strict(), raw);
    const a = this.need(b);
    if (p.offset > a.items.length) fail('invalid history offset', 400);
    const items = a.items.slice(p.offset, p.offset + p.limit).map(item => {
      const receipt = this.receipt(a, item);
      return { item, state: receipt === undefined ? 'pending' : receipt.memoryId === null ? 'skipped' : 'remembered', memoryId: receipt?.memoryId ?? null };
    });
    return { canRun: false, total: a.items.length, offset: p.offset, nextOffset: p.offset + items.length < a.items.length ? p.offset + items.length : null, items };
  }
  context(b: ThreadBinding) {
    const a = this.need(b); this.loaded(b, a);
    if (!a.completed || !a.sealed || a.items.some(i => this.receipt(a, i) === undefined)) fail('finish available history before reading autobiographical memory');
    return { ...this.status(b), context: this.service.contextFor(a.sessionId) };
  }
  restore(raw: ActivationBackup): void {
    const owner = readIdentity(this.db)?.id; if (owner === undefined) fail('initialization has no owner');
    const b = parseActivationBackup(raw, owner);
    const allSources = new Map<string, string>();
    for (const a of b.activations) {
      if (this.store.session(a.sessionId) === undefined) fail('restored activation session is missing');
      for (const item of a.items) { const k = sourceKey(a, item), f = sourceFingerprint(a, item); if (allSources.has(k) && allSources.get(k) !== f) fail('conflicting restored history source'); allSources.set(k, f); }
    }
    for (const r of b.receipts) {
      if (allSources.get(r.id) !== r.sourceFingerprint) fail('restored receipt has no matching history source');
      if (r.memoryId !== null) {
        const e = this.db.first("SELECT payload FROM events WHERE kind = 'remember' AND json_extract(payload, '$.id') = ?", r.memoryId);
        const source = e === undefined ? undefined : (JSON.parse(text(e.payload)) as { history_source?: { key: string; fingerprint: string } }).history_source;
        if (source?.key !== r.id || source.fingerprint !== r.sourceFingerprint) fail('restored history receipt does not match its memory');
      }
      this.db.run('INSERT INTO history_receipts(id, record) VALUES(?, ?)', r.id, JSON.stringify(r));
    }
    for (const a of b.activations) { if (a.completed && a.items.some(i => this.receipt(a, i) === undefined)) fail('restored activation is missing processing receipts'); this.save(a); }
    for (const r of b.requests) this.db.run('INSERT INTO activation_requests(id, fingerprint) VALUES(?, ?)', r.id, r.fingerprint);
  }
}
