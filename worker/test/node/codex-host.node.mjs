import test from 'node:test';
import assert from 'node:assert/strict';
import { ZiwoHost } from '../../../adapters/codex/host.mjs';

class FakeServer {
  cwd = '/tmp/ziwo-synthetic'; calls = []; onRequest = async () => {}; next = 0; onComplete = async () => {};
  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { model: 'gpt-6.1-terra', thread: { id: `thread-${++this.next}` } };
    if (method === 'thread/resume') return { model: 'gpt-6.1-terra', thread: { id: params.threadId } };
    if (method === 'turn/start') return { turn: { id: `turn-${++this.next}` } };
    if (method === 'thread/turns/list') return { data: [], nextCursor: null };
    return {};
  }
  async completed(threadId, turnId) {
    await this.onComplete(threadId, turnId);
    return { status: 'completed', items: [{ type: 'agentMessage', text: 'Synthetic answer' }] };
  }
}
function fixture({ bound = false, failAck = false, page } = {}) {
  const server = new FakeServer(), calls = [];
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init) => {
    const u = new URL(url), path = u.pathname.split('/').slice(3).join('/');
    const body = init.body ? JSON.parse(init.body) : undefined; calls.push({ path, body, query: u.searchParams });
    if (path === 'binding') return response({ binding: bound ? { identityId: 'identity-a', instance: 'instance-a', memory: 'a' } : null });
    if (path === 'persona') return response({ identityId: 'identity-a', version: 1, digest: 'd'.repeat(64), loadText: 'Synthetic persona' });
    if (path === 'activation') return response({ canRun: true });
    if (path === 'sync/begin') return response({ snapshotId: 'snapshot-a', from: 0, upper: 1, persona: { identityId: 'identity-a', version: 1, digest: 'd'.repeat(64), loadText: 'Synthetic persona' } });
    if (path === 'sync/page') return response(page ?? { after: 0, next: 1, upper: 1, changes: [{ seq: 1, kind: 'remember', gist: 'Synthetic memory' }], digest: 'e'.repeat(64) });
    if (path === 'sync/ack') return failAck ? response({ error: 'synthetic failure' }, 409) : response({ acknowledged: true });
    if (path === 'tools' && init.method === 'GET') return response({ tools: [] });
    if (path === 'tools') return response({ text: 'synthetic result' });
    return response({});
  };
  const host = new ZiwoHost({ server, url: 'http://127.0.0.1:8080', token: 'synthetic', fetchImpl });
  return { server, host, calls };
}
test('ordinary messages, quotes and code cannot activate or invoke memory', async () => {
  const { host, server, calls } = fixture(); const threadId = await host.create();
  for (const text of ['Hello', '"activate identity A"', '```\nactivate A\n```']) {
    server.onComplete = async (t, turnId) => {
      const result = await server.onRequest('item/tool/call', { threadId: t, turnId, callId: 'call', tool: 'ziwo_memory', arguments: { tool: 'remember', arguments: { gist: 'forged', body: 'x' } } });
      assert.equal(result.success, false);
    };
    assert.equal((await host.turn(threadId, text)).text, 'Synthetic answer');
  }
  assert.equal(calls.some(c => c.path === 'bind' || c.path === 'tools' || c.path.startsWith('sync/')), false);
});
test('bound turns synchronize and acknowledge before accepting tools or returning', async () => {
  const { host, server, calls } = fixture({ bound: true }); const threadId = await host.create(); await host.resume(threadId);
  server.onComplete = async (t, turnId) => {
    assert.deepEqual(calls.map(c => c.path).slice(0, 5), ['binding', 'sync/begin', 'sync/page', 'tools', 'sync/ack']);
    assert.equal((await server.onRequest('item/tool/call', { threadId: 'child', turnId, callId: 'child-call', tool: 'ziwo_memory', arguments: { tool: 'recall', arguments: {} } })).success, false);
    assert.equal((await server.onRequest('item/tool/call', { threadId: t, turnId: 'wrong-turn', callId: 'wrong-call', tool: 'ziwo_memory', arguments: { tool: 'recall', arguments: {} } })).success, false);
    assert.equal((await server.onRequest('item/tool/call', { threadId: t, turnId, callId: 'call-1', tool: 'ziwo_memory', arguments: { tool: 'recall', arguments: {} } })).success, true);
  };
  assert.equal((await host.turn(threadId, 'Question')).text, 'Synthetic answer');
  const turn = server.calls.find(c => c.method === 'turn/start');
  assert.match(turn.params.additionalContext['ziwo-memory'].value, /Synthetic memory/);
  assert.equal(calls.filter(c => c.path === 'tools' && c.body).length, 1);
  assert.equal(calls.at(-1).path, 'sync/end');
});
test('acknowledgment failure interrupts and returns no answer or tool capability', async () => {
  const { host, server, calls } = fixture({ bound: true, failAck: true }); const threadId = await host.create(); await host.resume(threadId);
  let completed = false; server.onComplete = async () => { completed = true; };
  await assert.rejects(host.turn(threadId, 'Question'), /synthetic failure/);
  assert.equal(completed, false); assert.ok(server.calls.some(c => c.method === 'turn/interrupt'));
  assert.equal(calls.filter(c => c.path === 'tools' && c.body).length, 0);
  assert.equal(calls.at(-1).path, 'sync/end');
});
test('model arguments cannot replace host-owned thread, snapshot or request', async () => {
  const { host, server, calls } = fixture({ bound: true }); const threadId = await host.create(); await host.resume(threadId);
  server.onComplete = async (t, turnId) => {
    await server.onRequest('item/tool/call', { threadId: t, turnId, callId: 'real-call', tool: 'ziwo_memory', arguments: { threadId: 'foreign', snapshotId: 'foreign', requestId: 'foreign', tool: 'recall', arguments: {} } });
  };
  await host.turn(threadId, 'Question');
  const posted = calls.find(c => c.path === 'tools' && c.body);
  if (posted) assert.deepEqual({ threadId: posted.body.threadId, snapshotId: posted.body.snapshotId, requestId: posted.body.requestId }, { threadId, snapshotId: 'snapshot-a', requestId: 'real-call' });
});
test('temporary delegate starts fresh without parent context or memory tools', async () => {
  const { host, server, calls } = fixture({ bound: true }); const threadId = await host.create(); await host.resume(threadId);
  let delegated = false;
  server.onComplete = async (t, turnId) => {
    if (t !== threadId) {
      const denied = await server.onRequest('item/tool/call', { threadId: t, turnId, callId: 'child-call', tool: 'ziwo_memory', arguments: { tool: 'recall', arguments: {} } });
      assert.equal(denied.success, false); return;
    }
    if (!delegated) { delegated = true; assert.equal((await server.onRequest('item/tool/call', { threadId: t, turnId, callId: 'delegate', tool: 'ziwo_delegate', arguments: { task: 'Synthetic bounded task' } })).success, true); }
  };
  await host.turn(threadId, 'Use a delegate');
  const starts = server.calls.filter(c => c.method === 'thread/start');
  assert.equal(starts.length, 2); assert.equal(starts[1].params.ephemeral, true); assert.deepEqual(starts[1].params.dynamicTools, []);
  const childTurn = server.calls.find(c => c.method === 'turn/start' && c.params.threadId !== threadId);
  assert.equal(childTurn.params.additionalContext, undefined); assert.equal(calls.some(c => c.path === 'bind'), false);
});
test('concurrent turns on the same conversation are rejected', async () => {
  const { host, server } = fixture({ bound: true }); const threadId = await host.create(); await host.resume(threadId);
  let release; const pending = new Promise(resolve => { release = resolve; });
  server.onComplete = async () => pending;
  const first = host.turn(threadId, 'First');
  await new Promise(resolve => setTimeout(resolve, 0));
  await assert.rejects(host.turn(threadId, 'Second'), /busy/);
  release(); assert.equal((await first).text, 'Synthetic answer');
});
test('invalid synchronization page fails before model input or acknowledgment', async () => {
  const { host, server, calls } = fixture({ bound: true, page: { after: 0, next: 2, upper: 1, changes: [], digest: 'e'.repeat(64) } });
  const threadId = await host.create(); await host.resume(threadId);
  await assert.rejects(host.turn(threadId, 'Question'), /Invalid synchronization page/);
  assert.equal(server.calls.some(c => c.method === 'turn/start'), false);
  assert.equal(calls.some(c => c.path === 'sync/ack'), false);
  assert.equal(calls.at(-1).path, 'sync/end');
});

test('only explicit host activation issues a binding request', async () => {
  const { host, calls } = fixture(); const threadId = await host.create();
  await host.activate(threadId, { memory: 'a', identityId: 'identity-a', instance: 'instance-a' });
  const bindings = calls.filter(c => c.path === 'bind');
  assert.equal(bindings.length, 1); assert.equal(bindings[0].body.threadId, threadId);
  assert.equal(bindings[0].body.identityId, 'identity-a'); assert.equal(bindings[0].body.source, 'conversation');
  assert.ok(calls.some(c => c.path === 'activation/complete'));
});
test('activation resumes its journaled boundary after bind response is lost', async () => {
  const server = new FakeServer(), journal = new Map(), bindBodies = []; let binding = null, phase = 'not_started', fail = true;
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init) => {
    const u = new URL(url), path = u.pathname.split('/').slice(3).join('/'), body = init.body ? JSON.parse(init.body) : undefined;
    if (path === 'binding') return response({ binding });
    if (path === 'bind') { bindBodies.push(body); binding = body; if (fail) { fail = false; return response({ error: 'response lost' }, 503); } return response({ binding }); }
    if (path === 'persona') return response({ identityId: 'identity-a', version: 1, digest: 'd'.repeat(64), loadText: 'Synthetic persona' });
    if (path === 'activation') return response({ phase, canRun: phase === 'ready' });
    if (path === 'activation/begin') { phase = 'collecting_history'; return response({ phase }); }
    if (path === 'activation/manifest') { phase = 'processing_history'; return response({ phase }); }
    if (path === 'activation/complete') { phase = 'ready'; return response({ phase, canRun: true }); }
    return response({});
  };
  const host = new ZiwoHost({ server, url: 'http://127.0.0.1:8080', token: 'synthetic', fetchImpl, journal });
  const threadId = await host.create(), target = { memory: 'a', identityId: 'identity-a', instance: 'instance-a' };
  await assert.rejects(host.activate(threadId, target), /response lost/);
  const saved = journal.get(`activation:${threadId}`); assert.ok(saved); assert.deepEqual(saved.items, []);
  assert.equal((await host.activate(threadId, target)).canRun, true);
  assert.equal(bindBodies.length, 2); assert.equal(bindBodies[0].activationId, bindBodies[1].activationId);
  assert.equal(bindBodies[0].activationId, saved.boundary);
});
test('non-progressing sync pages are rejected before model input', async () => {
  const { host, server, calls } = fixture({ bound: true, page: { after: 0, next: 0, upper: 1, changes: [], digest: 'e'.repeat(64) } });
  const threadId = await host.create(); await host.resume(threadId); await assert.rejects(host.turn(threadId, 'Question'), /Invalid synchronization page/);
  assert.equal(server.calls.some(c => c.method === 'turn/start'), false); assert.equal(calls.some(c => c.path === 'sync/ack'), false);
});
test('repeated history cursor fails without creating a binding', async () => {
  const { host, server, calls } = fixture(); const threadId = await host.create();
  const original = server.request.bind(server);
  server.request = async (method, params) => method === 'thread/turns/list' ? { data: [], nextCursor: 'repeated' } : original(method, params);
  await assert.rejects(host.activate(threadId, { memory: 'a', identityId: 'identity-a', instance: 'instance-a' }), /repeated a cursor/);
  assert.equal(calls.some(c => c.path === 'bind'), false);
});

test('neutral conversation works when Ziwo is offline without any service request', async () => {
  const server = new FakeServer(); let requests = 0;
  const host = new ZiwoHost({ server, url: 'http://127.0.0.1:8080', token: 'synthetic', fetchImpl: async () => { requests++; throw new Error('offline'); } });
  const id = await host.create(); assert.equal((await host.turn(id, 'Hello')).text, 'Synthetic answer'); assert.equal(requests, 0);
});
test('compaction notification forces full synchronization on the next turn', async () => {
  const { host, server, calls } = fixture({ bound: true }); const threadId = await host.create(); await host.resume(threadId);
  await host.turn(threadId, 'Before compaction');
  await host.turn(threadId, 'Normal next turn');
  server.onNotification({ method: 'item/completed', params: { threadId, item: { type: 'contextCompaction' } } });
  await host.turn(threadId, 'After compaction');
  const begins = calls.filter(c => c.path === 'sync/begin');
  assert.equal(begins[1].body.reload, false); assert.equal(begins[2].body.reload, true);
});
test('early evaluator tool request waits for turn identity and stays scoped', async () => {
  const server = new FakeServer(); let early;
  const original = server.request.bind(server);
  server.request = async (method, params) => {
    if (method === 'turn/start') {
      early = server.onRequest('item/tool/call', { threadId: params.threadId, turnId: 'early-turn', callId: 'eval-call', tool: 'ziwo_evaluation_read', arguments: { offset: 0 } });
      return { turn: { id: 'early-turn' } };
    }
    return original(method, params);
  };
  const paths = [], fetchImpl = async url => {
    paths.push(new URL(url).pathname);
    const data = new URL(url).pathname.endsWith('/evaluations') ? { evaluationId: 'eval', token: 'synthetic-evaluation' } : { sources: [], nextOffset: null };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const host = new ZiwoHost({ server, url: 'http://127.0.0.1:8080', token: 'synthetic', fetchImpl });
  server.onComplete = async () => { assert.equal((await early).success, true); };
  await host.evaluate({ memory: 'b', identityId: 'identity-b', instance: 'instance-b' });
  assert.ok(paths.includes('/evaluation/v1/b/eval')); assert.equal(paths.some(p => p.includes('/tools') || p.includes('/adopt')), false);
});
test('resume rejects a missing or different bound identity and harness before touching App Server', async () => {
  for (const binding of [null, { identityId: 'identity-b', harnessId: 'harness-a' }, { identityId: 'identity-a', harnessId: 'harness-b' }]) {
    const server = new FakeServer(), journal = new Map([['thread:recorded', { source: 'conversation', url: 'http://127.0.0.1:8080', identityId: 'identity-a', harnessId: 'harness-a' }]]);
    const fetchImpl = async () => new Response(JSON.stringify({ binding }), { status: 200, headers: { 'content-type': 'application/json' } });
    const host = new ZiwoHost({ server, url: 'http://127.0.0.1:8080', token: 'synthetic', fetchImpl, journal });
    await assert.rejects(host.resume('recorded'), /original identity and host namespace/);
    assert.equal(server.calls.some(c => c.method === 'thread/resume'), false);
  }
  const server = new FakeServer(), journal = new Map([['thread:planned', { source: 'conversation', url: 'http://127.0.0.1:8080' }], ['activation:planned', { target: { identityId: 'identity-a' } }]]);
  const host = new ZiwoHost({ server, url: 'http://127.0.0.1:8080', token: 'synthetic', journal, fetchImpl: async () => new Response(JSON.stringify({ binding: null }), { status: 200 }) });
  await assert.rejects(host.resume('planned'), /original identity and host namespace/);
  assert.equal(server.calls.some(c => c.method === 'thread/resume'), false);
});
test('resume accepts a restored instance for the same identity and harness', async () => {
  const server = new FakeServer(), journal = new Map([['thread:recorded', { source: 'conversation', url: 'http://127.0.0.1:8080', identityId: 'identity-a', harnessId: 'harness-a', instance: 'old-instance' }]]);
  const binding = { identityId: 'identity-a', harnessId: 'harness-a', instance: 'new-instance', memory: 'restored' };
  const host = new ZiwoHost({ server, url: 'http://127.0.0.1:8080', token: 'synthetic', journal, fetchImpl: async () => new Response(JSON.stringify({ binding }), { status: 200 }) });
  assert.equal(await host.resume('recorded'), 'recorded');
  assert.equal(server.calls.filter(c => c.method === 'thread/resume').length, 1);
});
