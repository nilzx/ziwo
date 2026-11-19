import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { adminSecret, createMemory, fetchWorker, freshName } from './mcp-helpers';
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
type Snapshot = { snapshotId: string; from: number; upper: number; persona: { version: number; digest: string }; acknowledged: boolean };
type Page = { after: number; next: number; upper: number; digest: string; changes: Array<{ seq: number; kind: string; id?: string }> };
async function ready(f: Fixture) {
  expect((await begin(f, { boundaryId: f.boundaryId, cutoff: null, coverage: 'complete', gaps: [] })).status).toBe(200);
  expect((await act(f, 'manifest', { requestId: uid(), beforeBoundaryId: f.boundaryId, offset: 0, items: [], final: true })).status).toBe(200);
  expect((await act(f, 'complete', { requestId: uid() })).status).toBe(200);
}
async function start(f: Fixture, requestId = uid(), reload = false): Promise<Snapshot> {
  const res = await host(f.token, 'sync/begin', { threadId: f.threadId, turnId: uid(), requestId, reload });
  expect(res.status).toBe(200); return await res.json() as Snapshot;
}
async function pages(f: Fixture, s: Snapshot): Promise<Page[]> {
  const out: Page[] = []; let after = s.from;
  do {
    const res = await host(f.token, `sync/page?threadId=${f.threadId}&snapshotId=${s.snapshotId}&after=${after}`);
    expect(res.status).toBe(200); const page = await res.json() as Page;
    expect(page.after).toBe(after); expect(page.upper).toBe(s.upper); expect(page.next).toBeGreaterThanOrEqual(after);
    expect(page.next).toBeLessThanOrEqual(s.upper); out.push(page); after = page.next;
  } while (after < s.upper && out.length < 100);
  expect(after).toBe(s.upper); return out;
}
const receipt = (s: Snapshot, ps: Page[]) => ({ snapshotId: s.snapshotId, personaVersion: s.persona.version, personaDigest: s.persona.digest, pages: ps.map(({ after, next, digest }) => ({ after, next, digest })) });
const ack = (f: Fixture, s: Snapshot, ps: Page[]) => host(f.token, 'sync/ack', { threadId: f.threadId, ...receipt(s, ps) });
const tool = (f: Fixture, s: Snapshot, name: string, args: object, requestId = uid()) => host(f.token, 'tools', { threadId: f.threadId, snapshotId: s.snapshotId, requestId, tool: name, arguments: args });
async function second(f: Fixture): Promise<Fixture> {
  const threadId = uid(), boundaryId = uid();
  expect((await host(f.token, 'bind', { ...f.target, threadId, activationId: boundaryId, source: 'conversation' })).status).toBe(200);
  const other = { ...f, threadId, boundaryId }; await ready(other); return other;
}
describe('N4 synthetic turn synchronization', () => {
  it('requires exact page and persona acknowledgments before tools and persists retry across eviction', async () => {
    const f = await setup(); await ready(f); const before = await counts(f);
    const s = await start(f), ps = await pages(f, s);
    expect((await tool(f, s, 'recall', {})).status).toBeGreaterThanOrEqual(400);
    expect((await host(f.token, 'sync/ack', { threadId: f.threadId, ...receipt(s, []), personaDigest: '0'.repeat(64) })).status).toBeGreaterThanOrEqual(400);
    expect((await host(f.token, 'sync/ack', { threadId: uid(), ...receipt(s, ps) })).status).toBeGreaterThanOrEqual(400);
    expect((await ack(f, s, [])).status).toBeGreaterThanOrEqual(400);
    expect((await ack(f, s, ps)).status).toBe(200);
    await evictDurableObject(env.MEMORY.getByName(f.m.name));
    expect((await ack(f, s, ps)).status).toBe(200);
    expect(await counts(f)).toEqual(before);
    expect((await tool(f, s, 'remember', { session_id: 'foreign', gist: 'Bad', body: 'Bad' })).status).toBeGreaterThanOrEqual(400);
    expect((await host(f.token, 'sync/end', { threadId: f.threadId, snapshotId: s.snapshotId })).status).toBe(200);
    expect((await tool(f, s, 'recall', {})).status).toBeGreaterThanOrEqual(400);
  });
  it('delivers alternating writes to the other bound conversation without skipping concurrent changes', async () => {
    const a = await setup(); await ready(a); const b = await second(a);
    const sa = await start(a), pa = await pages(a, sa); expect((await ack(a, sa, pa)).status).toBe(200);
    const sb = await start(b), pb = await pages(b, sb); expect((await ack(b, sb, pb)).status).toBe(200);
    const requestId = uid();
    expect((await tool(a, sa, 'remember', { gist: 'A synthetic change', body: 'A body' }, requestId)).status).toBe(200);
    expect((await tool(a, sa, 'remember', { gist: 'A synthetic change', body: 'A body' }, requestId)).status).toBe(200);
    expect((await tool(b, sb, 'remember', { gist: 'B synthetic change', body: 'B body' })).status).toBe(200);
    expect((await counts(a)).memories).toBe(2);
    const nextA = await start(a), nextB = await start(b);
    const aPages = await pages(a, nextA), bPages = await pages(b, nextB);
    expect(JSON.stringify(aPages)).toContain('B synthetic change'); expect(JSON.stringify(bPages)).toContain('A synthetic change');
    expect((await ack(a, nextA, aPages)).status).toBe(200); expect((await ack(b, nextB, bPages)).status).toBe(200);
    expect((await tool(a, sa, 'recall', {})).status).toBeGreaterThanOrEqual(400);
  });
  it('fixes the upper bound during concurrent writes and keeps other identities isolated', async () => {
    const a = await setup(); await ready(a); const b = await second(a), foreign = await setup(); await ready(foreign);
    const active = await start(a); expect((await ack(a, active, await pages(a, active))).status).toBe(200);
    const bounded = await start(b);
    expect((await tool(a, active, 'remember', { gist: 'After boundary synthetic', body: 'Body' })).status).toBe(200);
    const boundedPages = await pages(b, bounded); expect(JSON.stringify(boundedPages)).not.toContain('After boundary synthetic');
    expect((await ack(b, bounded, boundedPages)).status).toBe(200);
    const next = await start(b); expect(JSON.stringify(await pages(b, next))).toContain('After boundary synthetic');
    const fs = await start(foreign); expect(JSON.stringify(await pages(foreign, fs))).not.toContain('After boundary synthetic');
    expect((await host(a.token, 'bind', { ...foreign.target, threadId: a.threadId, activationId: uid(), source: 'conversation' })).status).toBe(409);
  });
  it('paginates a fixed range and invalidates a pending snapshot after erasure', async () => {
    const a = await setup(); await ready(a); const b = await second(a);
    const active = await start(a); expect((await ack(a, active, await pages(a, active))).status).toBe(200);
    for (let n = 0; n < 51; n++) expect((await tool(a, active, 'remember', { gist: `Paged synthetic ${n}`, body: 'Body' })).status).toBe(200);
    const pending = await start(b), all = await pages(b, pending);
    expect(all.length).toBeGreaterThan(1);
    expect(all.flatMap(p => p.changes).filter(c => c.kind === 'remember').length).toBe(51);
    const firstId = all.flatMap(p => p.changes).find(c => c.kind === 'remember')!.id!;
    expect((await tool(a, active, 'erase', { id: firstId, reason: 'Synthetic deletion' })).status).toBe(200);
    expect((await ack(b, pending, all)).status).toBe(409);
    const retry = await start(b), retried = await pages(b, retry);
    expect(JSON.stringify(retried)).not.toContain('Paged synthetic 0');
    expect((await ack(b, retry, retried)).status).toBe(200);
  });

  it('does not repeat a completed write when its response is lost and the next snapshot retries the request', async () => {
    const f = await setup(); await ready(f);
    const first = await start(f); expect((await ack(f, first, await pages(f, first))).status).toBe(200);
    const requestId = uid(), args = { gist: 'Lost response synthetic', body: 'Body' };
    expect((await tool(f, first, 'remember', args, requestId)).status).toBe(200);
    const next = await start(f); expect((await ack(f, next, await pages(f, next))).status).toBe(200);
    expect((await tool(f, next, 'remember', args, requestId)).status).toBe(200);
    expect((await counts(f)).memories).toBe(1);
  });

  it('restores a bound instance with a fresh cursor and no imported snapshot', async () => {
    const f = await setup(); await ready(f);
    const old = await start(f); expect((await ack(f, old, await pages(f, old))).status).toBe(200);
    expect((await tool(f, old, 'remember', { gist: 'Restored synthetic', body: 'Body' })).status).toBe(200);
    const delivered = await start(f); expect((await ack(f, delivered, await pages(f, delivered))).status).toBe(200);
    const backup = await (await admin(`/admin/memories/${f.m.name}/export`)).text();
    const name = freshName();
    expect((await fetchWorker(`/admin/memories/${name}/import`, { method: 'POST', headers: { authorization: `Bearer ${adminSecret}` }, body: backup })).status).toBe(201);
    const info = await (await admin(`/admin/memories/${name}/identity`)).json() as { instance: string; identity: { id: string } };
    expect((await host(f.token, 'restore', { memory: name, identityId: info.identity.id, instance: info.instance, threadId: f.threadId, previousInstance: f.target.instance, requestId: uid() })).status).toBe(200);
    expect((await tool(f, delivered, 'recall', {})).status).toBeGreaterThanOrEqual(400);
    const resumed = await start(f); expect(resumed.from).toBe(0);
    expect(JSON.stringify(await pages(f, resumed))).toContain('Restored synthetic');
  });

});
