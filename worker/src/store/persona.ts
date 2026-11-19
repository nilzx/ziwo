import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Db, num, text, type Row } from './db';
import { readIdentity } from './identity';
import { metaInstance } from './schema';

const line = z.string().trim().min(1).max(2000);
const lines = z.array(line).max(40);
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ordinal = z.number().int().safe().nonnegative();
export const personaDocument = z.object({
  summary: line,
  principles: lines,
  style: lines,
  boundaries: lines,
  examples: z.array(z.object({ situation: line, response: line, limits: line, evidenceIds: z.array(id).max(30) }).strict()).max(20),
}).strict();
export const proposalInput = z.object({
  document: personaDocument, rationale: line, changeSummary: line,
  counterexamples: lines, uncertainty: lines, evidenceIds: z.array(id).max(5000),
}).strict();
export const confirmationInput = z.object({
  identityId: id, instance: id, digest: hash, confirmationId: id, decision: z.enum(['approve', 'reject']),
}).strict();
export const adoptionInput = z.object({ identityId: id, instance: id, digest: hash }).strict();
export type PersonaDocument = z.infer<typeof personaDocument>;
type ProposalInput = z.infer<typeof proposalInput>;
const sourceSchema = z.object({ id, fingerprint: hash }).strict();
export type SourceRef = z.infer<typeof sourceSchema>;
const versionSchema = z.object({
  version: ordinal.refine(v => v > 0), identityId: id, baseVersion: ordinal.nullable(),
  document: personaDocument.nullable(), loadText: z.string().max(100000).nullable(), digest: hash,
  sources: z.array(sourceSchema).max(10000), adoptedAt: ordinal, proposalDigest: hash,
  invalidated: z.boolean(),
}).strict();
export type PersonaVersion = z.infer<typeof versionSchema>;
const bundleSchema = z.object({ identityId: id, currentVersion: ordinal.refine(v => v > 0), versions: z.array(versionSchema).min(1) }).strict();
export type PersonaBundle = z.infer<typeof bundleSchema>;
export interface Evaluation {
  id: string; harnessId: string; threadId: string; requestId: string; identityId: string; instance: string;
  baseVersion: number | null; upperSeq: number; sources: SourceRef[]; inheritedSources: SourceRef[]; createdAt: number; invalidated: boolean;
}
export interface Proposal {
  id: string; evaluationId: string; identityId: string; instance: string; baseVersion: number | null;
  content: ProposalInput | null; sources: SourceRef[]; digest: string; createdAt: number;
  state: 'proposed' | 'approved' | 'rejected' | 'applied' | 'invalidated'; adoptedVersion: number | null;
}
export class PersonaError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 413, message: string) { super(message); }
}
export type PersonaResult<T> = { value: T } | { error: string; status: number };
export function personaOutcome<T>(fn: () => T): PersonaResult<T> {
  try { return { value: fn() }; }
  catch (e) { if (e instanceof PersonaError) return { error: e.message, status: e.status }; throw e; }
}
function fail(message: string, status: PersonaError['status'] = 409): never { throw new PersonaError(status, message); }
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function loadText(identityId: string, document: PersonaDocument): string {
  return `Ziwo persona for ${identityId}\n` + JSON.stringify(document, null, 2);
}
function versionDigest(v: Pick<PersonaVersion, 'identityId' | 'version' | 'baseVersion' | 'document' | 'loadText' | 'sources'>): string {
  return digest([v.identityId, v.version, v.baseVersion, v.document, v.loadText, v.sources]);
}
// Recall, decay and ordinary session activity are deliberately excluded.
const sourceSelect = `SELECT m.id, m.created_at, m.written_at, m.kind, m.source, m.state, m.state_by, m.retracted, c.data, json_extract(e.payload, '$.time_precision') AS time_precision, json_extract(e.payload, '$.happened_on') AS happened_on
 FROM memories m JOIN contents c ON c.id = m.id JOIN events e ON e.seq = m.n`;
function sourceRef(r: Row): SourceRef {
  return { id: text(r.id), fingerprint: digest([r.id, r.created_at, r.written_at, r.kind, r.source, r.state, r.state_by, r.retracted, r.data, ...(r.time_precision === null ? [] : [r.time_precision, r.happened_on])]) };
}
function sourcesValid(db: Db, refs: SourceRef[]): boolean {
  return refs.every(ref => {
    const r = db.first(sourceSelect + ' WHERE m.id = ?', ref.id);
    return r !== undefined && sourceRef(r).fingerprint === ref.fingerprint;
  });
}
function mergeSources(a: SourceRef[], b: SourceRef[]): SourceRef[] {
  const all = new Map(a.map(s => [s.id, s]));
  for (const s of b) {
    if (all.has(s.id) && all.get(s.id)!.fingerprint !== s.fingerprint) fail('evaluation sources changed');
    all.set(s.id, s);
  }
  return [...all.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function parsePersonaBundle(raw: unknown, identityId: string): PersonaBundle {
  const parsed = bundleSchema.safeParse(raw);
  if (!parsed.success) fail('invalid persona backup', 400);
  const b = parsed.data;
  if (b.identityId !== identityId) fail('persona owner does not match memory owner', 400);
  for (let i = 0; i < b.versions.length; i++) {
    const v = b.versions[i]!;
    if (v.identityId !== identityId || v.version !== i + 1 || v.baseVersion !== (i === 0 ? null : i) ||
        new Set(v.sources.map(s => s.id)).size !== v.sources.length) fail('invalid persona version history', 400);
    if (v.invalidated) {
      if (v.document !== null || v.loadText !== null) fail('invalidated persona retains content', 400);
    } else if (v.document === null || v.loadText !== loadText(identityId, v.document) || v.digest !== versionDigest(v)) {
      fail('persona content is damaged', 400);
    }
  }
  if (b.currentVersion !== b.versions.length) fail('invalid current persona version', 400);
  return b;
}
export function exportPersona(db: Db): PersonaBundle | undefined {
  if (db.first(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'persona_current'`) === undefined) return undefined;
  const row = db.first('SELECT version FROM persona_current WHERE singleton = 1');
  if (row === undefined) return undefined;
  const identity = readIdentity(db);
  if (identity === undefined) fail('persona has no owner');
  const versions = db.all('SELECT record FROM persona_versions ORDER BY version').map(r => JSON.parse(text(r.record)) as PersonaVersion);
  const bundle = parsePersonaBundle({ identityId: identity.id, currentVersion: num(row.version), versions }, identity.id);
  // A changed source cannot leave a restorable copy of stale derived text.
  for (const v of bundle.versions) if (!v.invalidated && !sourcesValid(db, v.sources)) {
    v.invalidated = true; v.document = null; v.loadText = null;
  }
  return bundle;
}
export class Personas {
  constructor(private readonly db: Db, private readonly storage: DurableObjectStorage) {}
  private target(identityId: string, instance: string): void {
    if (readIdentity(this.db)?.id !== identityId || this.db.getMeta(metaInstance) !== instance) fail('subject or instance is unavailable');
  }
  private currentNumber(): number | null { const r = this.db.first('SELECT version FROM persona_current WHERE singleton = 1'); return r === undefined ? null : num(r.version); }
  private version(n: number): PersonaVersion {
    const row = this.db.first('SELECT record FROM persona_versions WHERE version = ?', n);
    if (row === undefined) fail('persona version is missing');
    let raw: unknown;
    try { raw = JSON.parse(text(row.record)); } catch { fail('persona version is damaged'); }
    const p = versionSchema.safeParse(raw);
    if (!p.success) fail('persona version is damaged');
    const v = p.data;
    if (v.identityId !== readIdentity(this.db)?.id || v.version !== n ||
        (!v.invalidated && (v.document === null || v.loadText !== loadText(v.identityId, v.document) || v.digest !== versionDigest(v)))) fail('persona ownership or content is damaged');
    return v;
  }
  load(identityId: string, instance: string) {
    this.target(identityId, instance);
    const n = this.currentNumber();
    if (n === null) fail('persona initialization is required');
    const v = this.version(n);
    if (v.invalidated || !sourcesValid(this.db, v.sources)) fail('persona evidence is no longer valid; a confirmed repair is required');
    return { identityId, instance, version: n, digest: v.digest, loadText: v.loadText!, document: v.document! };
  }
  start(input: { id: string; harnessId: string; threadId: string; requestId: string; identityId: string; instance: string }, tokenHash: string, at: number): Evaluation {
    return this.storage.transactionSync(() => {
      this.target(input.identityId, input.instance);
      const prior = this.db.first('SELECT record FROM persona_evaluations WHERE id = ?', input.id);
      if (prior !== undefined) {
        const job = JSON.parse(text(prior.record)) as Evaluation;
        if (Object.entries(input).some(([k, v]) => job[k as keyof Evaluation] !== v)) fail('evaluation request was reused');
        if (job.invalidated) fail('evaluation was invalidated; start a new request');
        this.db.run('UPDATE persona_evaluations SET token_hash = ? WHERE id = ?', tokenHash, input.id);
        return job;
      }
      const rows = this.db.all(sourceSelect + ' ORDER BY m.n LIMIT 5001');
      if (rows.length > 5000) fail('evaluation exceeds the 5000-memory snapshot limit', 413);
      const baseVersion = this.currentNumber();
      const base = baseVersion === null ? undefined : this.version(baseVersion);
      const inheritedSources = base !== undefined && !base.invalidated && sourcesValid(this.db, base.sources) ? base.sources : [];
      const job: Evaluation = { ...input, baseVersion, sources: rows.map(sourceRef), inheritedSources,
        upperSeq: num(this.db.first('SELECT COALESCE(MAX(seq), 0) AS n FROM events')!.n), createdAt: at, invalidated: false };
      this.db.run('INSERT INTO persona_evaluations(id, token_hash, record) VALUES(?, ?, ?)', job.id, tokenHash, JSON.stringify(job));
      return job;
    });
  }
  authenticate(jobId: string, tokenHash: string): Evaluation {
    const r = this.db.first('SELECT record FROM persona_evaluations WHERE id = ? AND token_hash = ?', jobId, tokenHash);
    if (r === undefined) fail('invalid evaluation credential', 401);
    const job = JSON.parse(text(r.record)) as Evaluation;
    this.target(job.identityId, job.instance);
    return job;
  }
  private validJob(job: Evaluation): void {
    if (job.invalidated || !sourcesValid(this.db, mergeSources(job.sources, job.inheritedSources))) fail('evaluation sources changed; start a new evaluation');
  }
  read(jobId: string, tokenHash: string, offset: number, limit: number) {
    const job = this.authenticate(jobId, tokenHash); this.validJob(job);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > job.sources.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid evaluation page', 400);
    const items = job.sources.slice(offset, offset + limit).map(ref => {
      const r = this.db.first(sourceSelect + ' WHERE m.id = ?', ref.id)!;
      return { id: ref.id, kind: r.kind, source: r.source, occurredAt: r.time_precision === 'unknown' ? null : r.created_at, occurrencePrecision: r.time_precision ?? 'instant', occurredOn: r.happened_on, writtenAt: r.written_at,
        state: r.state, stateBy: r.state_by, retracted: r.retracted === 1, content: JSON.parse(text(r.data)) as unknown };
    });
    const base = job.baseVersion === null ? null : this.version(job.baseVersion);
    const persona = base === null ? null : base.invalidated || !sourcesValid(this.db, base.sources) ? { version: base.version, invalidated: true } : { version: base.version, document: base.document };
    return { evaluationId: job.id, identityId: job.identityId, baseVersion: job.baseVersion, upperSeq: job.upperSeq,
      persona, total: job.sources.length, offset, nextOffset: offset + items.length < job.sources.length ? offset + items.length : null, items };
  }
  propose(jobId: string, tokenHash: string, raw: unknown, at: number): Proposal {
    return this.storage.transactionSync(() => {
      const job = this.authenticate(jobId, tokenHash); this.validJob(job);
      if (this.currentNumber() !== job.baseVersion) fail('persona base version changed');
      const parsed = proposalInput.safeParse(raw); if (!parsed.success) fail('invalid persona proposal', 400);
      const content = parsed.data;
      const allowed = new Set(job.sources.map(s => s.id));
      if ([...content.evidenceIds, ...content.document.examples.flatMap(e => e.evidenceIds)].some(id => !allowed.has(id))) fail('evidence is outside this evaluation', 403);
      const sources = mergeSources(job.sources, job.inheritedSources);
      const d = digest([job.id, job.identityId, job.instance, job.baseVersion, content, sources]);
      const proposalId = 'pp_' + d;
      const prior = this.db.first('SELECT record FROM persona_proposals WHERE id = ?', proposalId);
      if (prior !== undefined) return JSON.parse(text(prior.record)) as Proposal;
      const p: Proposal = { id: proposalId, evaluationId: job.id, identityId: job.identityId, instance: job.instance,
        baseVersion: job.baseVersion, content, sources, digest: d, createdAt: at, state: 'proposed', adoptedVersion: null };
      this.db.run('INSERT INTO persona_proposals(id, record) VALUES(?, ?)', p.id, JSON.stringify(p));
      return p;
    });
  }
  private proposal(id: string): Proposal {
    const r = this.db.first('SELECT record FROM persona_proposals WHERE id = ?', id);
    if (r === undefined) fail('proposal not found', 404);
    return JSON.parse(text(r.record)) as Proposal;
  }
  private validProposal(p: Proposal): void {
    this.target(p.identityId, p.instance);
    if (p.state === 'invalidated' || p.content === null || !sourcesValid(this.db, p.sources)) fail('proposal evidence is no longer valid');
    if (p.digest !== digest([p.evaluationId, p.identityId, p.instance, p.baseVersion, p.content, p.sources])) fail('proposal content is damaged');
  }
  review(id: string) {
    const p = this.proposal(id);
    this.validProposal(p);
    const base = p.baseVersion === null ? null : this.version(p.baseVersion);
    const before = base === null || base.invalidated || !sourcesValid(this.db, base.sources) ? null : base.document;
    return { id: p.id, identityId: p.identityId, instance: p.instance, baseVersion: p.baseVersion, currentVersion: this.currentNumber(),
      digest: p.digest, state: p.state, stale: this.currentNumber() !== p.baseVersion && p.state !== 'applied',
      before, ...p.content!, evidenceCount: p.sources.length, adoptedVersion: p.adoptedVersion };
  }
  confirm(id: string, raw: unknown, at: number) {
    return this.storage.transactionSync(() => {
      const parsed = confirmationInput.safeParse(raw); if (!parsed.success) fail('invalid confirmation', 400);
      const c = parsed.data; const p = this.proposal(id); this.validProposal(p);
      if (c.identityId !== p.identityId || c.instance !== p.instance || c.digest !== p.digest) fail('confirmation does not match the exact proposal');
      const receipt = this.db.first('SELECT * FROM persona_confirmations WHERE id = ?', c.confirmationId);
      if (receipt !== undefined) {
        if (receipt.proposal_id !== id || receipt.digest !== c.digest || receipt.decision !== c.decision) fail('confirmation identifier was reused');
        return { proposalId: id, state: p.state };
      }
      if (p.state !== 'proposed' || this.currentNumber() !== p.baseVersion) fail('proposal is no longer awaiting confirmation at its base version');
      this.db.run('INSERT INTO persona_confirmations(id, proposal_id, digest, decision, at) VALUES(?, ?, ?, ?, ?)', c.confirmationId, id, c.digest, c.decision, at);
      p.state = c.decision === 'approve' ? 'approved' : 'rejected';
      this.db.run('UPDATE persona_proposals SET record = ? WHERE id = ?', JSON.stringify(p), id);
      return { proposalId: id, state: p.state };
    });
  }
  adopt(id: string, raw: unknown, at: number) {
    return this.storage.transactionSync(() => {
      const parsed = adoptionInput.safeParse(raw); if (!parsed.success) fail('invalid adoption request', 400);
      const c = parsed.data; const p = this.proposal(id); this.validProposal(p);
      if (c.identityId !== p.identityId || c.instance !== p.instance || c.digest !== p.digest) fail('adoption does not match the exact proposal');
      if (p.state === 'applied') return { adoptedVersion: p.adoptedVersion!, currentVersion: this.currentNumber()! };
      if (p.state !== 'approved' || this.db.first("SELECT 1 AS ok FROM persona_confirmations WHERE proposal_id = ? AND digest = ? AND decision = 'approve'", id, p.digest) === undefined) fail('specific user confirmation is required', 403);
      if (this.currentNumber() !== p.baseVersion) fail('persona base version changed');
      const n = (p.baseVersion ?? 0) + 1;
      const v: PersonaVersion = { version: n, identityId: p.identityId, baseVersion: p.baseVersion, document: p.content!.document,
        loadText: loadText(p.identityId, p.content!.document), digest: '', sources: p.sources, adoptedAt: at, proposalDigest: p.digest, invalidated: false };
      v.digest = versionDigest(v);
      this.db.run('INSERT INTO persona_versions(version, record) VALUES(?, ?)', n, JSON.stringify(v));
      this.db.run('INSERT INTO persona_current(singleton, version) VALUES(1, ?) ON CONFLICT(singleton) DO UPDATE SET version = excluded.version', n);
      p.state = 'applied'; p.adoptedVersion = n;
      this.db.run('UPDATE persona_proposals SET record = ? WHERE id = ?', JSON.stringify(p), id);
      return { adoptedVersion: n, currentVersion: n };
    });
  }
  // Runs inside the same transaction as erasure, including cascaded sources.
  eraseSources(ids: string[]): void {
    const gone = new Set(ids);
    for (const r of this.db.all('SELECT id, record FROM persona_evaluations')) {
      const j = JSON.parse(text(r.record)) as Evaluation;
      if ([...j.sources, ...j.inheritedSources].some(s => gone.has(s.id))) {
        j.invalidated = true; this.db.run("UPDATE persona_evaluations SET token_hash = '', record = ? WHERE id = ?", JSON.stringify(j), text(r.id));
      }
    }
    for (const r of this.db.all('SELECT id, record FROM persona_proposals')) {
      const p = JSON.parse(text(r.record)) as Proposal;
      if (p.sources.some(s => gone.has(s.id))) {
        p.state = 'invalidated'; p.content = null; this.db.run('UPDATE persona_proposals SET record = ? WHERE id = ?', JSON.stringify(p), p.id);
      }
    }
    for (const r of this.db.all('SELECT version, record FROM persona_versions')) {
      const v = JSON.parse(text(r.record)) as PersonaVersion;
      if (v.sources.some(s => gone.has(s.id))) {
        v.invalidated = true; v.document = null; v.loadText = null;
        this.db.run('UPDATE persona_versions SET record = ? WHERE version = ?', JSON.stringify(v), v.version);
      }
    }
  }
  restore(bundle: PersonaBundle): void {
    const owner = readIdentity(this.db)?.id;
    if (owner === undefined) fail('restored persona has no owner', 400);
    const b = parsePersonaBundle(bundle, owner);
    for (const v of b.versions) {
      if (!v.invalidated && !sourcesValid(this.db, v.sources)) fail('restored persona evidence does not match the memory partition', 400);
      this.db.run('INSERT INTO persona_versions(version, record) VALUES(?, ?)', v.version, JSON.stringify(v));
    }
    this.db.run('INSERT INTO persona_current(singleton, version) VALUES(1, ?)', b.currentVersion);
  }
}
