import { describe, expect, it } from 'vitest';
import { adminSecret, Client, createMemory, fetchWorker, idIn, legacy, modern, readReply } from './mcp-helpers';

const admin = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', token = adminSecret) => fetchWorker(path, {
  method, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body),
});
async function fixture() {
  const memory = await createMemory();
  const info = await (await admin(`/admin/memories/${memory.name}/identity`)).json() as { identity: { id: string }; instance: string };
  return { memory, input: { identityId: info.identity.id, instance: info.instance, requestId: crypto.randomUUID(), source: 'fresh' } };
}
type Evaluation = { evaluationId: string; token: string; mcpUrl: string; upperSeq: number };
async function start(f: Awaited<ReturnType<typeof fixture>>) {
  const r = await admin(`/admin/persona/${f.memory.name}/evaluations`, f.input);
  expect(r.status).toBe(201); return await r.json() as Evaluation;
}
async function rpc(e: Evaluation, method: string, params: unknown = {}, protocol = modern) {
  if (protocol === modern) params = { ...(params as object), _meta: {
    'io.modelcontextprotocol/protocolVersion': modern,
    'io.modelcontextprotocol/clientInfo': { name: 'independent-test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {},
  } };
  const res = await fetchWorker(new URL(e.mcpUrl).pathname, { method: 'POST', headers: {
    authorization: `Bearer ${e.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol,
    ...(protocol === modern ? { 'mcp-method': method, ...((params as { name?: string }).name ? { 'mcp-name': (params as { name: string }).name } : {}) } : {}),
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return readReply(res);
}
const proposal = { document: { summary: 'Synthetic independent persona', principles: ['Be clear'], style: [], boundaries: [], examples: [] },
  rationale: 'Synthetic evidence supports this bounded statement', changeSummary: 'Initialize', counterexamples: [], uncertainty: ['Limited synthetic evidence'], evidenceIds: [] };

describe('portable persona evaluation MCP', () => {
  it.each([legacy, modern])('exposes only evidence and proposals in %s; user confirmation is separate', async protocol => {
    const f = await fixture(), c = new Client('new', f.memory);
    const sid = idIn(await c.ok('get_context', {}), 's_');
    const memoryId = idIn(await c.ok('remember', { session_id: sid, gist: 'Synthetic evaluation evidence', body: 'A bounded example' }));
    const e = await start(f);
    const discovery = await rpc(e, protocol === legacy ? 'initialize' : 'server/discover', protocol === legacy ? { protocolVersion: legacy, capabilities: {}, clientInfo: { name: 'independent-test', version: '1' } } : {}, protocol);
    expect(discovery.status, discovery.raw).toBe(200);
    expect(discovery.msg?.result).toMatchObject({ instructions: expect.stringContaining('third-party subject') });
    const listing = await rpc(e, 'tools/list', {}, protocol);
    expect((listing.msg?.result as { tools: { name: string }[] }).tools.map(t => t.name).sort()).toEqual(['propose_persona', 'read_evaluation']);
    const read = await rpc(e, 'tools/call', { name: 'read_evaluation', arguments: {} }, protocol);
    const evidence = read.msg?.result as { structuredContent: { items: { id: string }[] }; isError?: boolean };
    expect(evidence.isError).not.toBe(true); expect(evidence.structuredContent.items.map(i => i.id)).toContain(memoryId);
    const made = await rpc(e, 'tools/call', { name: 'propose_persona', arguments: { ...proposal, evidenceIds: [memoryId] } }, protocol);
    const p = (made.msg?.result as { structuredContent: { proposalId: string; digest: string } }).structuredContent;
    const path = `/admin/persona/${f.memory.name}/proposals/${p.proposalId}`;
    const exact = { identityId: f.input.identityId, instance: f.input.instance, digest: p.digest };
    expect((await admin(`${path}/adopt`, exact)).status).toBe(403);
    expect(JSON.parse(await c.ok('sync_context', {})).persona.status).toBe('uninitialized');
    for (const token of [f.memory.token, e.token]) expect((await admin(`${path}/confirm`, { ...exact, confirmationId: crypto.randomUUID(), decision: 'approve' }, 'POST', token)).status).toBe(401);
    expect((await admin(`${path}/confirm`, { ...exact, confirmationId: crypto.randomUUID(), decision: 'approve' })).status).toBe(200);
    expect((await admin(`${path}/adopt`, exact)).status).toBe(200);
    expect(JSON.parse(await c.ok('sync_context', {})).persona.document.summary).toBe(proposal.document.summary);
    const denied = await rpc(e, 'tools/call', { name: 'remember', arguments: { session_id: sid, gist: 'Must not write', body: 'Must not write' } }, protocol);
    expect(denied.msg?.error ?? (denied.msg?.result as { isError?: boolean })?.isError).toBeTruthy();
  });

  it('requires the private user channel and revokes old capabilities on retry and explicit revocation', async () => {
    const f = await fixture(), path = `/admin/persona/${f.memory.name}/evaluations`;
    expect((await admin(path, f.input, 'POST', f.memory.token)).status).toBe(401);
    expect((await admin(path, { ...f.input, source: 'conversation' })).status).toBe(400);
    const first = await start(f), second = await start(f);
    expect(second.evaluationId).toBe(first.evaluationId); expect(second.upperSeq).toBe(first.upperSeq);
    expect((await rpc(first, 'tools/list')).status).toBe(401);
    const active = await rpc(second, 'tools/list'); expect(active.status, active.raw).toBe(200);
    expect((await admin(`${path}/${second.evaluationId}`, undefined, 'DELETE')).status).toBe(200);
    expect((await rpc(second, 'tools/list')).status).toBe(401);
  });
});
