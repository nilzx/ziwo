import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, link, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeGateway } from '../../../adapters/codex/native/gateway.mjs';
import { workspacePolicy } from '../../../adapters/codex/workspace.mjs';
import { ZiwoHost } from '../../../adapters/codex/host.mjs';
import { listenNative } from '../../../adapters/codex/native/transport.mjs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../adapters/codex/native/transport.mjs', import.meta.url));
const WebSocket = require('ws');

test('workspace policy rejects pre-existing hard links and private runtime roots', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ziwo-test-'));
  try {
    const ws = join(base, 'ws'), priv = join(base, 'private'); await mkdir(ws); await mkdir(priv);
    await writeFile(join(priv, 'canary'), 'synthetic'); await link(join(priv, 'canary'), join(ws, 'alias'));
    await assert.rejects(workspacePolicy(ws, [priv]), /hard link/);
    await rm(join(ws, 'alias'));
    await assert.rejects(workspacePolicy(ws, [priv], { runtimeRoots: [priv] }), /overlap private/);
    await assert.rejects(workspacePolicy(ws, [priv], { runtimeRoots: [base] }), /overlap private/);
    const policy = await workspacePolicy(ws, [priv]);
    assert.equal(policy.thread.permissions, 'ziwo-workspace'); assert.equal(policy.profile.filesystem[policy.denied[0]], 'deny');
    const ui = join(base, 'ui'); await mkdir(ui); await symlink('/bin/sh', join(ui, 'runtime-link'));
    const withUi = await workspacePolicy(ws, [priv, ui], { runtimeStatePaths: [ui] });
    assert.equal(withUi.profile.filesystem[withUi.denied[1]], 'deny');
    await link(join(priv, 'canary'), join(ws, 'alias'));
    await assert.rejects(workspacePolicy(ws, [priv, ui], { runtimeStatePaths: [ui] }), /hard link/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

function gatewayFixture() {
  const calls = [], journal = new Map([['thread:known', { source: 'conversation', url: 'http://localhost', workspace: '/workspace' }]]);
  const server = { initialized: {}, onRequest: async () => ({}), request: async (method, params) => { calls.push({ method, params }); return {}; } };
  let finish;
  const host = { url: 'http://localhost', model: 'synthetic', owns: id => id === 'known', busy: () => false,
    turn: async (id, message, options) => { options.beforeStart(); options.onStarted({ turn: { id: 'turn-1' } }); await new Promise(r => { finish = r; }); }, reload() {} };
  const gateway = new NativeGateway({ host, server, journal, workspace: '/workspace' }); gateway.attach(() => {});
  return { gateway, server, calls, finish: () => finish?.() };
}
test('gateway denies protocol bypasses, unknown conversations and runtime overrides', async () => {
  const { gateway, calls } = gatewayFixture(); await gateway.handle('initialize');
  for (const method of ['turn/steer', 'thread/queue/start', 'review/start', 'thread/inject_items', 'command/exec', 'process/spawn', 'fs/readFile']) await assert.rejects(gateway.handle(method, { threadId: 'known' }), /Unsupported/);
  await assert.rejects(gateway.handle('turn/start', { threadId: 'unknown', input: [{ type: 'text', text: 'x' }] }), /Only conversations/);
  for (const override of [{ path: '/other' }, { history: [] }, { additionalContext: {} }, { cwd: '/other' }, { runtimeWorkspaceRoots: ['/other'] }]) await assert.rejects(gateway.handle('thread/resume', { threadId: 'known', ...override }));
  assert.equal(calls.length, 0);
});
test('gateway blocks concurrent input and interrupts the active turn on disconnect', async () => {
  const { gateway, calls, finish } = gatewayFixture(); await gateway.handle('initialize');
  assert.equal((await gateway.handle('turn/start', { threadId: 'known', input: [{ type: 'text', text: 'one' }] })).turn.id, 'turn-1');
  await assert.rejects(gateway.handle('turn/start', { threadId: 'known', input: [{ type: 'text', text: 'two' }] }), /Finish or interrupt/);
  await gateway.detach(); assert.deepEqual(calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'known', turnId: 'turn-1' } }); finish();
});
test('a new connection cannot release an older pending synchronized turn', async () => {
  const { gateway } = gatewayFixture(); await gateway.handle('initialize');
  let release, entered; const waiting = new Promise(r => { release = r; }); const ready = new Promise(r => { entered = r; });
  gateway.host.turn = async (_id, _message, options) => { entered(); await waiting; options.beforeStart(); throw Error('generation should not start'); };
  const pending = gateway.handle('turn/start', { threadId: 'known', input: [{ type: 'text', text: 'synthetic' }] });
  await ready; await gateway.detach(); gateway.attach(() => {}); await gateway.handle('initialize'); release();
  await assert.rejects(pending, /disconnected before generation/);
});

test('gateway checks retained execution settings and rejects client model overrides', async () => {
  const { gateway } = gatewayFixture(); await gateway.handle('initialize');
  assert.throws(() => gateway.verifyExecution({ cwd: '/workspace', activePermissionProfile: { id: 'other' }, approvalPolicy: 'never' }), /protection/);
  gateway.verifyExecution({ cwd: '/workspace', activePermissionProfile: { id: 'ziwo-workspace' }, approvalPolicy: 'never' });
  await assert.rejects(gateway.handle('turn/start', { threadId: 'known', model: 'other', input: [{ type: 'text', text: 'x' }] }), /select another model/);
  await assert.rejects(gateway.handle('turn/start', { threadId: 'known', config: { shell_environment_policy: { inherit: 'all' } }, input: [{ type: 'text', text: 'x' }] }), /overrides/);
});
test('native tool catalog is discarded on new conversation, including malicious tools', async () => {
  const { gateway } = gatewayFixture(); let createArgs;
  gateway.host.create = async args => { createArgs = args; gateway.host.lastThreadResponse = { thread: { id: 'new' }, cwd: '/workspace', activePermissionProfile: { id: 'ziwo-workspace' }, approvalPolicy: 'never' }; await gateway.journal.set('thread:new', { source: 'conversation', url: gateway.host.url }); return 'new'; };
  await gateway.handle('initialize');
  await gateway.handle('thread/start', { dynamicTools: [{ name: 'malicious', inputSchema: {} }] });
  assert.deepEqual(createArgs, { persistNeutral: true });
  await assert.rejects(gateway.handle('thread/start', { ephemeral: true, dynamicTools: [] }), /separate clean/);
});

test('workspace provenance survives journal update and is required on resume', async () => {
  const { gateway } = gatewayFixture(); await gateway.handle('initialize');
  await gateway.rememberWorkspace('known'); assert.equal((await gateway.known('known')).workspace, '/workspace');
  gateway.workspace = '/different'; await assert.rejects(gateway.known('known'), /workspace/);
});

test('transport accepts one origin-free client, rejects browser origin, and detaches', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ziwo-socket-')); const socket = join(base, 's');
  let attached = false, detaches = 0;
  const gateway = { connected: false, attach() { this.connected = true; attached = true; }, async detach() { this.connected = false; detaches++; }, async handle() { return {}; } };
  const transport = await listenNative(gateway, socket);
  const connect = headers => new Promise(resolve => { const ws = new WebSocket('ws+unix://' + socket + ':/', { headers }); ws.once('open', () => resolve({ ws, ok: true })); ws.once('error', () => resolve({ ws, ok: false })); });
  try {
    assert.equal((await connect({ Origin: 'https://example.test' })).ok, false);
    const first = await connect({}); assert.equal(first.ok, true); assert.equal(attached, true);
    assert.equal((await connect({})).ok, false);
    first.ws.close(); await new Promise(resolve => first.ws.once('close', resolve));
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(gateway.connected, false); assert.ok(detaches >= 1);
  } finally { await transport.close(); await rm(base, { recursive: true, force: true }); }
});

test('preloaded context is injected and acknowledged before generation; failures stop generation', async () => {
  for (const failure of [null, 'inject', 'ack']) {
    const events = [], journal = new Map();
    const server = { cwd: '/workspace', onRequest: async () => {}, request: async (method, params) => {
      events.push(method); if (method === 'thread/start') return { model: 'gpt-6.1-terra', thread: { id: 'known' } };
      if (method === 'thread/resume') return { model: 'gpt-6.1-terra', thread: { id: 'known' } };
      if (method === 'thread/inject_items') { assert.match(params.items[0].content[0].text, /synthetic/); if (failure === 'inject') throw Error('inject failed'); }
      if (method === 'turn/start') { assert.equal(params.permissions, 'ziwo-workspace'); assert.equal(params.approvalPolicy, 'never'); return { turn: { id: 'turn' } }; }
      return {};
    }, completed: async () => ({ status: 'completed', items: [] }) };
    const fetchImpl = async (url) => { const path = new URL(url).pathname.split('/').slice(3).join('/'); events.push(path);
      const data = path === 'binding' ? { binding: { identityId: 'a' } } : path === 'sync/begin' ? { snapshotId: 's', from: 0, upper: 0, persona: { identityId: 'a', version: 1, digest: 'd', loadText: 'synthetic' } } : path === 'sync/page' ? { after: 0, next: 0, upper: 0, changes: [], digest: 'd' } : {};
      return new Response(JSON.stringify(failure === 'ack' && path === 'sync/ack' ? { error: 'ack failed' } : data), { status: failure === 'ack' && path === 'sync/ack' ? 409 : 200 }); };
    const host = new ZiwoHost({ server, url: 'http://localhost', token: 'synthetic', journal, fetchImpl, preloadContext: true, execution: { cwd: '/workspace', permissions: 'ziwo-workspace', approvalPolicy: 'never' } });
    await host.create(); await host.resume('known');
    if (failure) await assert.rejects(host.turn('known', 'synthetic'), /failed/); else await host.turn('known', 'synthetic');
    const injected = events.indexOf('thread/inject_items'), ack = events.indexOf('sync/ack'), start = events.indexOf('turn/start');
    assert.ok(injected >= 0); if (failure === 'inject') assert.equal(ack, -1); else assert.ok(ack > injected);
    if (failure) assert.equal(start, -1); else assert.ok(start > ack);
  }
});

test('workspace thread start retains fixed permissions and roots without explicit cwd', async () => {
  let start;
  const server = { cwd: '/workspace', workspacePolicy: {}, request: async (method, params) => {
    if (method === 'thread/start') { start = params; return { model: 'gpt-6.1-terra', thread: { id: 'synthetic' } }; }
    return {};
  } };
  const host = new ZiwoHost({ server, url: 'http://localhost', token: 'synthetic', preloadContext: true,
    cleanHostFactory: async () => ({}), execution: { cwd: '/workspace', runtimeWorkspaceRoots: ['/workspace'], permissions: 'ziwo-workspace', approvalPolicy: 'never' } });
  await host.create(); assert.equal('cwd' in start, false); assert.equal(start.permissions, 'ziwo-workspace');
  assert.deepEqual(start.runtimeWorkspaceRoots, ['/workspace']); assert.equal(start.approvalPolicy, 'never');
});
