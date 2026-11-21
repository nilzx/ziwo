import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
const run = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/check-host-registry.mjs', import.meta.url));

test('lost registration response resumes without implicit rotation and cleans only the matching host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-smoke-test-')), manifest = join(dir, 'state.json');
  const calls = []; let host, token = 'token-1', drop = true, mismatch = false, revoked = false, rotations = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined; calls.push({ method: req.method, url: req.url, body });
    res.setHeader('content-type', 'application/json');
    let result;
    if (req.url === '/admin/harnesses' && req.method === 'POST') {
      if (!host) { host = { id: 'h_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: body.name, requestId: body.requestId, createdAt: 1, revoked: false, bindingCount: 0 }; }
      if (drop) { drop = false; req.socket.destroy(); return; }
      result = { ...host, revoked, replayed: true, tokenAvailable: false };
    } else if (req.url.startsWith('/admin/harnesses?')) result = { harnesses: [{ ...host, revoked }], nextAfter: null };
    else if (req.url === `/admin/harnesses/${host.id}/token`) { rotations++; token = `token-${rotations + 1}`; result = { id: host.id, token }; }
    else if (req.url === `/admin/harnesses/${host.id}` && req.method === 'DELETE') { revoked = true; result = { revoked: host.id }; }
    else if (req.url === `/admin/harnesses/${host.id}`) result = { ...host, name: mismatch ? 'other' : host.name, revoked };
    else if (req.url.startsWith('/harness/v1/binding')) { res.statusCode = !revoked && req.headers.authorization === `Bearer ${token}` ? 200 : 401; result = {}; }
    else { res.statusCode = 404; result = {}; }
    res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, ZIWO_URL: `http://127.0.0.1:${server.address().port}`, ZIWO_ADMIN_SECRET: 'test-secret' };
  const invoke = extra => run(process.execPath, [script, '--manifest', manifest, ...extra], { env });
  try {
    await assert.rejects(invoke([]));
    const initial = JSON.parse(await readFile(manifest));
    await assert.rejects(invoke(['--resume']));
    assert.equal(rotations, 0);
    const registrations = calls.filter(c => c.method === 'POST' && c.url === '/admin/harnesses');
    assert.deepEqual(registrations[0].body, registrations[1].body);
    assert.equal(registrations[0].body.requestId, initial.operationId);
    mismatch = true;
    await assert.rejects(invoke(['--resume', '--rotate-lost-token']));
    assert.equal(calls.filter(c => c.method === 'DELETE').length, 0);
    assert.equal(rotations, 0);
    mismatch = false;
    const completed = await invoke(['--resume', '--rotate-lost-token']);
    assert.match(completed.stdout, /smoke passed/);
    assert.equal(rotations, 2);
    assert.deepEqual(calls.filter(c => c.method === 'DELETE').map(c => c.url), [`/admin/harnesses/${host.id}`]);
    const state = JSON.parse(await readFile(manifest)); assert.equal(state.complete, true);
    assert(!JSON.stringify(state).includes(token));
    delete state.complete; state.stage = 'revoking'; await writeFile(manifest, JSON.stringify(state));
    const before = calls.length;
    const resumed = await invoke(['--resume']);
    assert.match(resumed.stdout, /already revoked/);
    assert.match(resumed.stdout, /could not be rechecked/);
    assert(calls.slice(before).every(c => c.method === 'GET'));
    assert.equal(JSON.parse(await readFile(manifest)).stage, 'cleanup-confirmed');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('rejects non-loopback HTTP before sending any request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-smoke-remote-'));
  await assert.rejects(run(process.execPath, [script, '--manifest', join(dir, 'state'), '--remote'], { env: { ...process.env, ZIWO_URL: 'http://192.0.2.1', ZIWO_ADMIN_SECRET: 'test-secret' } }), /require HTTPS/);
});
