import { env } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import { chain, goCompact } from '../src/store/export';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { directoryName } from '../src/directory';
import { adminSecret, Client, createMemory, fetchWorker, freshName, idIn } from './mcp-helpers';
const uid = () => crypto.randomUUID();
const req = (path: string, token: string, body?: unknown) => fetchWorker(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const admin = (path: string, body?: unknown) => req(path, adminSecret, body);
const host = (token: string, path: string, body?: unknown) => req(`/harness/v1/${path}`, token, body);
async function setup() {
  const m = await createMemory();
  const identity = await (await admin(`/admin/memories/${m.name}/identity`)).json() as { instance: string; identity: { id: string } };
  const target = { memory: m.name, identityId: identity.identity.id, instance: identity.instance };
  const h = await (await admin('/admin/harnesses', { name: 'synthetic activation host' })).json() as { token: string };
  const e = await (await host(h.token, 'evaluations', { ...target, threadId: uid(), requestId: uid(), source: 'fresh' })).json() as { evaluationId: string; token: string };
  const p = await (await req(`/evaluation/v1/${m.name}/${e.evaluationId}/proposals`, e.token, { document: { summary: 'Synthetic persona', principles: ['Clear'], style: ['Concise'], boundaries: ['Limits'], examples: [{ situation: 'Question', response: 'Answer', limits: 'No guessing', evidenceIds: [] }] }, rationale: 'Reason', changeSummary: 'Change', counterexamples: [], uncertainty: [], evidenceIds: [] })).json() as { proposalId: string; digest: string };
  const pp = `/admin/persona/${m.name}/proposals/${p.proposalId}`, exact = { identityId: target.identityId, instance: target.instance, digest: p.digest };
  expect((await admin(`${pp}/confirm`, { ...exact, confirmationId: uid(), decision: 'approve' })).status).toBe(200);
  expect((await admin(`${pp}/adopt`, exact)).status).toBe(200);
  const threadId = uid(), boundaryId = uid();
  expect((await host(h.token, 'bind', { ...target, threadId, activationId: boundaryId, source: 'conversation' })).status).toBe(200);
  const persona = await (await host(h.token, `persona?threadId=${threadId}`)).json() as { version: number; digest: string };
  return { m, target, token: h.token, threadId, boundaryId, persona };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const begin = (f: Fixture, scope: unknown) => host(f.token, 'activation/begin', { threadId: f.threadId, personaVersion: f.persona.version, personaDigest: f.persona.digest, model: 'synthetic', client: 'test', timezone: 'UTC', scope });
const act = (f: Fixture, op: string, args: Record<string, unknown> = {}) => host(f.token, `activation/${op}`, { threadId: f.threadId, ...args });
const state = async (f: Fixture) => await (await host(f.token, `activation?threadId=${f.threadId}`)).json() as { sessionId: string; canRun: boolean; historyIncomplete: boolean; noticePending: boolean };
const counts = (f: Fixture) => runInDurableObject(env.MEMORY.getByName(f.m.name), (_o, s) => Object.fromEntries(['sessions', 'memories', 'history_receipts'].map(t => [t, s.storage.sql.exec<{ n: number }>(`SELECT count(*) n FROM ${t}`).toArray()[0]!.n])));
const item = (n: number, material: 'original' | 'summary' = 'original') => ({ itemId: `item_${n}`, turnId: `turn_${n}`, sequence: n, contentDigest: String(n + 1).repeat(64), material, status: 'completed', occurrence: { precision: 'unknown' } });
describe('N3 synthetic activation', () => {
  it('holds an empty boundary and gates context until completion', async () => {
    const f = await setup(), scope = { boundaryId: f.boundaryId, cutoff: null, coverage: 'complete', gaps: [] };
    expect((await host(f.token, `activation/context?threadId=${f.threadId}`)).status).toBe(409);
    expect((await begin(f, scope)).status).toBe(200); const first = await state(f);
    expect(first.canRun).toBe(false); expect(await counts(f)).toMatchObject({ sessions: 1, memories: 0 });
    expect((await begin(f, scope)).status).toBe(200); expect((await begin(f, { ...scope, boundaryId: 'different' })).status).toBe(409);
    expect((await host(f.token, `activation/context?threadId=${f.threadId}`)).status).toBe(409);
    expect((await act(f, 'manifest', { requestId: 'page', beforeBoundaryId: f.boundaryId, offset: 0, items: [], final: true })).status).toBe(200);
    expect((await act(f, 'complete', { requestId: 'finish' })).status).toBe(200);
    expect((await host(f.token, `activation/context?threadId=${f.threadId}`)).status).toBe(200);
    expect((await state(f)).sessionId).toBe(first.sessionId); expect(await counts(f)).toMatchObject({ sessions: 1, memories: 0 });
  });
  it('persists decisions and unknown time across response loss and eviction', async () => {
    const f = await setup(), i0 = item(0), i1 = item(1);
    expect((await begin(f, { boundaryId: f.boundaryId, cutoff: { turnId: i1.turnId, itemId: i1.itemId, sequence: 1 }, coverage: 'complete', gaps: [] })).status).toBe(200);
    expect((await act(f, 'manifest', { requestId: 'page', beforeBoundaryId: f.boundaryId, offset: 0, items: [i0, i1], final: true })).status).toBe(200);
    const decisions = [{ itemId: i0.itemId, action: 'remember', memory: { gist: 'Synthetic past', body: 'Synthetic body' } }, { itemId: i1.itemId, action: 'skip', reason: 'not_memorable' }];
    const batch = { requestId: 'batch', decisions }; expect((await act(f, 'batch', batch)).status).toBe(200);
    await evictDurableObject(env.MEMORY.getByName(f.m.name)); await evictDurableObject(env.DIRECTORY.getByName(directoryName));
    expect((await act(f, 'batch', batch)).status).toBe(200);
    expect((await act(f, 'batch', { ...batch, decisions: [{ ...decisions[0], memory: { gist: 'changed', body: 'changed' } }] })).status).toBe(409);
    expect(await counts(f)).toMatchObject({ sessions: 1, memories: 1, history_receipts: 2 });
    const memory = await runInDurableObject(env.MEMORY.getByName(f.m.name), (_o, s) => s.storage.sql.exec('SELECT * FROM memories').toArray()[0]);
    expect(memory?.created_at).toBe(0); expect(memory?.time_precision).toBe('unknown');
    expect((await act(f, 'complete', { requestId: 'complete' })).status).toBe(200); expect((await state(f)).canRun).toBe(true);
  });
  it('keeps explicit gaps and rejects summaries as experiences', async () => {
    const f = await setup(), i = item(0, 'summary');
    expect((await begin(f, { boundaryId: f.boundaryId, cutoff: { turnId: i.turnId, itemId: i.itemId, sequence: 0 }, coverage: 'partial', gaps: [{ id: 'gap', from: 0, to: 0, reason: 'summary_only' }] })).status).toBe(200);
    expect((await act(f, 'manifest', { requestId: 'page', beforeBoundaryId: f.boundaryId, offset: 0, items: [i], final: true })).status).toBe(200);
    expect((await act(f, 'batch', { requestId: 'bad', decisions: [{ itemId: i.itemId, action: 'remember', memory: { gist: 'invented', body: 'invented' } }] })).status).toBe(403);
    expect((await act(f, 'complete', { requestId: 'early' })).status).toBe(409);
    expect((await act(f, 'batch', { requestId: 'skip', decisions: [{ itemId: i.itemId, action: 'skip', reason: 'summary_only' }] })).status).toBe(200);
    expect((await act(f, 'complete', { requestId: 'finish', resolveGaps: ['gap'] })).status).toBe(409);
    expect((await act(f, 'complete', { requestId: 'finish' })).status).toBe(200);
    expect(await state(f)).toMatchObject({ canRun: true, historyIncomplete: true, noticePending: true });
    expect((await act(f, 'notice')).status).toBe(200); expect((await state(f)).noticePending).toBe(false);
    expect(await counts(f)).toMatchObject({ memories: 0, history_receipts: 1 });
  });
  it('validates overlapping pages and rolls back a failed batch', async () => {
    const f = await setup(), i0 = item(0), i1 = item(1);
    expect((await begin(f, { boundaryId: f.boundaryId, cutoff: { turnId: i1.turnId, itemId: i1.itemId, sequence: 1 }, coverage: 'complete', gaps: [] })).status).toBe(200);
    expect((await act(f, 'manifest', { requestId: 'p1', beforeBoundaryId: f.boundaryId, offset: 0, items: [i0], final: false })).status).toBe(200);
    expect((await act(f, 'manifest', { requestId: 'bad', beforeBoundaryId: f.boundaryId, offset: 0, items: [{ ...i0, contentDigest: 'f'.repeat(64) }], final: false })).status).toBe(409);
    expect((await act(f, 'manifest', { requestId: 'past', beforeBoundaryId: f.boundaryId, offset: 1, items: [item(2)], final: true })).status).toBe(409);
    expect((await act(f, 'manifest', { requestId: 'p2', beforeBoundaryId: f.boundaryId, offset: 0, items: [i0, i1], final: true })).status).toBe(200);
    const stub = env.MEMORY.getByName(f.m.name);
    await runInDurableObject(stub, (_o, s) => s.storage.sql.exec("CREATE TRIGGER test_activation_failure BEFORE INSERT ON history_receipts BEGIN SELECT RAISE(ABORT, 'injected failure'); END"));
    const batch = { requestId: 'atomic', decisions: [{ itemId: i0.itemId, action: 'remember', memory: { gist: 'Atomic synthetic', body: 'Body' } }] };
    try { expect((await act(f, 'batch', batch)).status).toBeGreaterThanOrEqual(500); }
    finally { await runInDurableObject(stub, (_o, s) => s.storage.sql.exec('DROP TRIGGER test_activation_failure')); }
    expect(await counts(f)).toMatchObject({ memories: 0, history_receipts: 0 });
    expect((await act(f, 'batch', batch)).status).toBe(200);
    expect((await act(f, 'complete', { requestId: 'too_early' })).status).toBe(409);
    expect((await act(f, 'batch', { requestId: 'skip', decisions: [{ itemId: i1.itemId, action: 'skip', reason: 'irrelevant' }] })).status).toBe(200);
    expect((await act(f, 'complete', { requestId: 'done' })).status).toBe(200);
  });
  it('rejects missing or stale persona acknowledgment without creating a session', async () => {
    const f = await setup(), scope = { boundaryId: f.boundaryId, cutoff: null, coverage: 'complete', gaps: [] };
    expect((await host(f.token, 'activation/begin', { threadId: f.threadId, personaVersion: f.persona.version, personaDigest: '0'.repeat(64), model: 'synthetic', client: 'test', timezone: 'UTC', scope })).status).toBe(409);
    expect(await counts(f)).toMatchObject({ sessions: 0, memories: 0 });
    expect((await begin(f, scope)).status).toBe(200);
    const stub = env.MEMORY.getByName(f.m.name);
    await runInDurableObject(stub, (_o, s) => s.storage.sql.exec("UPDATE persona_versions SET record = json_set(record, '$.loadText', 'corrupted') WHERE version = 1"));
    expect((await act(f, 'manifest', { requestId: 'page', beforeBoundaryId: f.boundaryId, offset: 0, items: [], final: true })).status).toBe(409);
    expect((await host(f.token, `activation/context?threadId=${f.threadId}`)).status).toBe(409);
    expect(await counts(f)).toMatchObject({ sessions: 1, memories: 0 });
  });

  it('supplements a summary gap inside the original boundary', async () => {
    const f = await setup(), summary = item(0, 'summary');
    expect((await begin(f, { boundaryId: f.boundaryId, cutoff: { turnId: summary.turnId, itemId: summary.itemId, sequence: 0 }, coverage: 'partial', gaps: [{ id: 'gap', from: 0, to: 0, reason: 'summary_only' }] })).status).toBe(200);
    expect((await act(f, 'manifest', { requestId: 'p1', beforeBoundaryId: f.boundaryId, offset: 0, items: [summary], final: true })).status).toBe(200);
    expect((await act(f, 'batch', { requestId: 'skip', decisions: [{ itemId: summary.itemId, action: 'skip', reason: 'summary_only' }] })).status).toBe(200);
    expect((await act(f, 'complete', { requestId: 'c1' })).status).toBe(200);
    expect((await act(f, 'supplement', { requestId: 'wrong', beforeBoundaryId: 'wrong' })).status).toBe(409);
    expect((await act(f, 'supplement', { requestId: 'supplement', beforeBoundaryId: f.boundaryId })).status).toBe(200);
    const original = { ...summary, itemId: 'original_0', material: 'original' };
    expect((await act(f, 'manifest', { requestId: 'past', beforeBoundaryId: f.boundaryId, offset: 1, items: [item(1)], final: true })).status).toBe(409);
    expect((await act(f, 'manifest', { requestId: 'p2', beforeBoundaryId: f.boundaryId, offset: 1, items: [original], final: true })).status).toBe(200);
    expect((await act(f, 'batch', { requestId: 'remember', decisions: [{ itemId: original.itemId, action: 'remember', memory: { gist: 'Recovered original', body: 'Synthetic original' } }] })).status).toBe(200);
    expect((await act(f, 'complete', { requestId: 'c2', resolveGaps: ['gap'] })).status).toBe(200);
    expect(await state(f)).toMatchObject({ canRun: true, historyIncomplete: false });
  });
  it('forks with an independent session and shared source receipts', async () => {
    const f = await setup(), i = item(0);
    expect((await begin(f, { boundaryId: f.boundaryId, cutoff: { turnId: i.turnId, itemId: i.itemId, sequence: 0 }, coverage: 'complete', gaps: [] })).status).toBe(200);
    expect((await act(f, 'manifest', { requestId: 'page', beforeBoundaryId: f.boundaryId, offset: 0, items: [i], final: true })).status).toBe(200);
    const decisions = [{ itemId: i.itemId, action: 'remember', memory: { gist: 'Shared synthetic', body: 'Body' } }];
    expect((await act(f, 'batch', { requestId: 'batch', decisions })).status).toBe(200);
    const child = uid(); expect((await host(f.token, 'fork', { threadId: child, parentThreadId: f.threadId, source: 'conversation' })).status).toBe(200);
    expect((await host(f.token, 'activation/begin', { threadId: child, personaVersion: f.persona.version, personaDigest: f.persona.digest, model: 'synthetic', client: 'test', timezone: 'UTC' })).status).toBe(200);
    const cs = await (await host(f.token, `activation?threadId=${child}`)).json() as { sessionId: string; processed: number };
    expect(cs.sessionId).not.toBe((await state(f)).sessionId); expect(cs.processed).toBe(1);
    expect((await host(f.token, 'activation/batch', { threadId: child, requestId: 'retry', decisions })).status).toBe(200);
    expect(await counts(f)).toMatchObject({ sessions: 2, memories: 1, history_receipts: 1 });
  });
  it('restores activation and requires persona acknowledgment for the new instance', async () => {
    const f = await setup(), scope = { boundaryId: f.boundaryId, cutoff: null, coverage: 'complete', gaps: [] };
    expect((await begin(f, scope)).status).toBe(200); const session = (await state(f)).sessionId;
    const page = { requestId: 'page', beforeBoundaryId: f.boundaryId, offset: 0, items: [], final: true };
    expect((await act(f, 'manifest', page)).status).toBe(200);
    const backup = await (await admin(`/admin/memories/${f.m.name}/export`)).text();
    const name = freshName(); const imported = await fetchWorker(`/admin/memories/${name}/import`, { method: 'POST', headers: { authorization: `Bearer ${adminSecret}` }, body: backup }); expect(imported.status).toBe(201);
    const info = await (await admin(`/admin/memories/${name}/identity`)).json() as { instance: string; identity: { id: string } };
    const target = { memory: name, identityId: info.identity.id, instance: info.instance };
    expect((await host(f.token, 'restore', { ...target, threadId: f.threadId, previousInstance: f.target.instance, requestId: 'restore' })).status).toBe(200);
    expect((await state(f)).sessionId).toBe(session); expect((await state(f)).canRun).toBe(false);
    expect((await act(f, 'manifest', page)).status).toBe(409);
    const persona = await (await host(f.token, `persona?threadId=${f.threadId}`)).json() as { version: number; digest: string };
    expect((await act(f, 'persona', { personaVersion: persona.version, personaDigest: persona.digest })).status).toBe(200);
    expect((await act(f, 'manifest', page)).status).toBe(200);
    expect((await act(f, 'complete', { requestId: 'complete' })).status).toBe(200);
    expect((await state(f)).sessionId).toBe(session); expect((await state(f)).canRun).toBe(true);
  });

  it('exposes unknown time explicitly and excludes it from date filters by default', async () => {
    const m = await createMemory(), c = new Client('new', m), session = idIn(await c.ok('get_context', {}), 's_');
    await c.ok('remember', { session_id: session, gist: 'Unknown synthetic occurrence', body: 'Unknown body', source: 'reconstructed', happened_at: 'unknown' });
    await c.ok('remember', { session_id: session, gist: 'Dated synthetic occurrence', body: 'Dated body', source: 'reconstructed', happened_at: '2020-03-14' });
    const all = await c.ok('recall', {}); expect(all.toLowerCase()).toContain('unknown');
    const until = await c.ok('recall', { until: '2021-01-01' }); expect(until).toContain('Dated synthetic'); expect(until).not.toContain('Unknown synthetic');
    const included = await c.ok('recall', { until: '2021-01-01', include_unknown_time: true }); expect(included).toContain('Unknown synthetic');
  });

  it('rejects items when an unavailable history has no cutoff anchor', async () => {
    const f = await setup();
    expect((await begin(f, { boundaryId: f.boundaryId, cutoff: null, coverage: 'partial', gaps: [{ id: 'all', from: null, to: null, reason: 'unavailable' }] })).status).toBe(200);
    expect((await act(f, 'manifest', { requestId: 'unbounded', beforeBoundaryId: f.boundaryId, offset: 0, items: [item(0)], final: true })).status).toBe(409);
  });
  it('requires a current persona and continues existing progress after an adopted revision', async () => {
    const f = await setup(), i = item(0);
    expect((await begin(f, { boundaryId: f.boundaryId, cutoff: { turnId: i.turnId, itemId: i.itemId, sequence: 0 }, coverage: 'complete', gaps: [] })).status).toBe(200);
    const session = (await state(f)).sessionId;
    expect((await act(f, 'manifest', { requestId: 'page', beforeBoundaryId: f.boundaryId, offset: 0, items: [i], final: true })).status).toBe(200);
    const e = await (await host(f.token, 'evaluations', { ...f.target, threadId: uid(), requestId: uid(), source: 'fresh' })).json() as { evaluationId: string; token: string };
    const p = await (await req(`/evaluation/v1/${f.m.name}/${e.evaluationId}/proposals`, e.token, { document: { summary: 'Revised synthetic persona', principles: ['Clear'], style: ['Concise'], boundaries: ['Limits'], examples: [{ situation: 'Question', response: 'Answer', limits: 'No guessing', evidenceIds: [] }] }, rationale: 'Reason', changeSummary: 'Revision', counterexamples: [], uncertainty: [], evidenceIds: [] })).json() as { proposalId: string; digest: string };
    const pp = `/admin/persona/${f.m.name}/proposals/${p.proposalId}`, exact = { identityId: f.target.identityId, instance: f.target.instance, digest: p.digest };
    expect((await admin(`${pp}/confirm`, { ...exact, confirmationId: uid(), decision: 'approve' })).status).toBe(200); expect((await admin(`${pp}/adopt`, exact)).status).toBe(200);
    const batch = { requestId: 'batch', decisions: [{ itemId: i.itemId, action: 'skip', reason: 'irrelevant' }] };
    expect((await act(f, 'batch', batch)).status).toBe(409); expect((await host(f.token, `activation/context?threadId=${f.threadId}`)).status).toBe(409);
    expect((await act(f, 'persona', { personaVersion: f.persona.version, personaDigest: f.persona.digest })).status).toBe(409);
    const current = await (await host(f.token, `persona?threadId=${f.threadId}`)).json() as { version: number; digest: string };
    expect(current.version).toBeGreaterThan(f.persona.version); expect((await act(f, 'persona', { personaVersion: current.version, personaDigest: current.digest })).status).toBe(200);
    expect((await act(f, 'batch', batch)).status).toBe(200); expect((await act(f, 'complete', { requestId: 'done' })).status).toBe(200);
    expect((await state(f)).sessionId).toBe(session); expect((await state(f)).canRun).toBe(true);
  });
  it('preserves unknown occurrence through correction and rebuild', async () => {
    const m = await createMemory(), c = new Client('new', m), session = idIn(await c.ok('get_context', {}), 's_');
    const id = idIn(await c.ok('remember', { session_id: session, gist: 'Before correction', body: 'Synthetic body', source: 'reconstructed', happened_at: 'unknown' }));
    await c.ok('amend', { session_id: session, action: 'correct', id, gist: 'Corrected unknown synthetic' });
    await runInDurableObject(env.MEMORY.getByName(m.name), o => o.store.rebuild());
    expect(await c.ok('recall', { until: '2021-01-01' })).not.toContain('Corrected unknown synthetic');
    expect(await c.ok('recall', { until: '2021-01-01', include_unknown_time: true })).toContain('Corrected unknown synthetic');
  });

  it('does not create a session without an adopted persona', async () => {
    const m = await createMemory(), info = await (await admin(`/admin/memories/${m.name}/identity`)).json() as { instance: string; identity: { id: string } };
    const token = (await (await admin('/admin/harnesses', { name: 'no persona host' })).json() as { token: string }).token;
    const threadId = uid(), boundaryId = uid();
    expect((await host(token, 'bind', { memory: m.name, identityId: info.identity.id, instance: info.instance, threadId, activationId: boundaryId, source: 'conversation' })).status).toBe(200);
    expect((await host(token, 'activation/begin', { threadId, personaVersion: 0, personaDigest: '0'.repeat(64), model: 'synthetic', client: 'test', timezone: 'UTC', scope: { boundaryId, cutoff: null, coverage: 'complete', gaps: [] } })).status).toBe(409);
    expect(await runInDurableObject(env.MEMORY.getByName(m.name), (_o, s) => s.storage.sql.exec<{n:number}>('SELECT count(*) n FROM sessions').toArray()[0]!.n)).toBe(0);
  });

  it('anchors previously unavailable history once and resumes with paged receipts', async () => {
    const f = await setup(), i = item(0);
    expect((await begin(f, { boundaryId: f.boundaryId, cutoff: null, coverage: 'partial', gaps: [{ id: 'all', from: null, to: null, reason: 'unavailable' }] })).status).toBe(200);
    expect((await act(f, 'manifest', { requestId: 'empty', beforeBoundaryId: f.boundaryId, offset: 0, items: [], final: true })).status).toBe(200);
    expect((await act(f, 'complete', { requestId: 'initial' })).status).toBe(200);
    const anchor = { requestId: 'anchor', beforeBoundaryId: f.boundaryId, cutoff: { itemId: i.itemId, turnId: i.turnId, sequence: 0 }, status: 'completed', readable: true };
    expect((await act(f, 'anchor', anchor)).status).toBe(200);
    expect((await act(f, 'anchor', { ...anchor, requestId: 'later', cutoff: { ...anchor.cutoff, sequence: 1 } })).status).toBe(409);
    expect((await act(f, 'anchor', { ...anchor, cutoff: { ...anchor.cutoff, sequence: 1 } })).status).toBe(409);
    expect((await act(f, 'manifest', { requestId: 'page', beforeBoundaryId: f.boundaryId, offset: 0, items: [i], final: true })).status).toBe(200);
    let history = await (await host(f.token, `activation/history?threadId=${f.threadId}&offset=0&limit=1`)).json() as { items: { state: string }[] };
    expect(history.items[0]?.state).toBe('pending');
    expect((await act(f, 'batch', { requestId: 'skip', decisions: [{ itemId: i.itemId, action: 'skip', reason: 'irrelevant' }] })).status).toBe(200);
    expect((await act(f, 'complete', { requestId: 'done', resolveGaps: ['all'] })).status).toBe(200);
    await evictDurableObject(env.MEMORY.getByName(f.m.name));
    expect((await act(f, 'anchor', anchor)).status).toBe(200); expect((await state(f)).canRun).toBe(true);
    history = await (await host(f.token, `activation/history?threadId=${f.threadId}&offset=0&limit=1`)).json() as { items: { state: string }[] };
    expect(history.items[0]?.state).toBe('skipped');
  });

  it('rejects a mixed-owner activation backup even when its chain is recomputed', async () => {
    const f = await setup();
    expect((await begin(f, { boundaryId: f.boundaryId, cutoff: null, coverage: 'complete', gaps: [] })).status).toBe(200);
    const lines = (await (await admin(`/admin/memories/${f.m.name}/export`)).text()).trimEnd().split('\n');
    const header = JSON.parse(lines[0]!); header.activation.identityId = 'foreign_owner'; lines[0] = JSON.stringify(header);
    let head = createHash('sha256').update('ziwo-export-v4\n' + goCompact(lines[0]!)).digest('hex');
    for (let n = 1; n < lines.length - 1; n++) { const ev = JSON.parse(lines[n]!); head = chain(head, ev.seq, ev.at, ev.kind, JSON.stringify(ev.payload), ev.content); ev.chain = head; lines[n] = JSON.stringify(ev); }
    const footer = JSON.parse(lines.at(-1)!); footer.head = head; lines[lines.length - 1] = JSON.stringify(footer);
    const imported = await fetchWorker(`/admin/memories/${freshName()}/import`, { method: 'POST', headers: { authorization: `Bearer ${adminSecret}` }, body: lines.join('\n') + '\n' });
    expect(imported.status).toBe(400);
  });

});
