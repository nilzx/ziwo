import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, runSuite } from '../../../conformance/run.mjs';
import { probe, parseProbeArgs } from '../../../conformance/probe.mjs';

test('groups are validated and unselected cases are not passed', () => {
  assert.throws(() => parseArgs(['--groups', 'ordinary,nope']));
  assert.throws(() => parseArgs(['--report']));
  assert.throws(() => parseArgs(['--unknown']));
  const report = runSuite(parseArgs(['--groups', 'ordinary']), () => ({ status: 0 }));
  assert.ok(report.results.filter(r => r.group !== 'ordinary').every(r => r.status === 'not-run'));
  const failed = runSuite(parseArgs(['--groups', 'ordinary']), () => ({ status: 1 }));
  assert.ok(failed.results.filter(r => r.group === 'ordinary').every(r => r.status === 'fail'));
});

test('probe requires explicit safe endpoint and does not return secrets or body', async () => {
  await assert.rejects(probe({ endpoint: 'http://example.com/mcp', token: 'secret' }));
  await assert.rejects(probe({ endpoint: 'https://example.com/mcp', token: 'secret' }));
  await assert.rejects(probe({ endpoint: 'http://localhost/mcp', token: '' }));
  let calls = 0;
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body); calls++;
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } } : {};
    if (body.method === 'tools/list') result = { tools: [{ name: 'check' }, { name: 'sync_context' }] };
    if (body.params.name === 'check') result = { content: [{ type: 'text', text: 'private body' }] };
    if (body.params.name === 'sync_context') result = { structuredContent: { complete: true, cursor: 'private cursor', changes: [] } };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
  const report = await probe({ endpoint: 'http://localhost/mcp', token: 'secret', fetchImpl });
  assert.equal(calls, 6); assert.equal(report.status, 'pass');
  assert.doesNotMatch(JSON.stringify(report), /secret|private/);
  await assert.rejects(probe({ endpoint: 'http://localhost/mcp', token: 'bad', fetchImpl: async () => new Response('secret', { status: 401 }) }), /MCP request failed/);
});


test('probe rejects malformed options, initialization, RPC errors and timeouts', async () => {
  assert.throws(() => parseProbeArgs(['--endpoint', 'http://localhost', '--token-env', 'TOKEN', '--bogus']));
  assert.throws(() => parseProbeArgs(['--endpoint', 'http://localhost']));
  const opts = { endpoint: 'http://localhost/mcp', token: 'secret' };
  await assert.rejects(probe({ ...opts, fetchImpl: async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} }) }), /initialization/);
  await assert.rejects(probe({ ...opts, fetchImpl: async () => Response.json({ jsonrpc: '2.0', id: 1, error: { message: 'secret' } }) }), /MCP request failed/);
  await assert.rejects(probe({ ...opts, fetchImpl: async () => new Response('data: broken\n\n', { headers: { 'content-type': 'text/event-stream' } }) }), /Invalid MCP response/);
  await assert.rejects(probe({ ...opts, timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('secret')))) }), /MCP request failed/);
});

test('probe CLI fails safely without writing a report', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ziwo-probe-'));
  try {
    const path = join(dir, 'report.json');
    const child = spawnSync(process.execPath, ['conformance/probe.mjs', '--endpoint', 'http://example.com/mcp', '--token-env', 'TEST_TOKEN', '--report', path], { cwd: new URL('../../../', import.meta.url), env: { ...process.env, TEST_TOKEN: 'sensitive-token' }, encoding: 'utf8' });
    assert.notEqual(child.status, 0);
    assert.equal(existsSync(path), false);
    assert.doesNotMatch(child.stderr + child.stdout, /sensitive-token/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
