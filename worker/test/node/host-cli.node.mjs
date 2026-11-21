import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
const run = promisify(execFile);
const script = fileURLToPath(new URL('../../bin/ziwo-admin.mjs', import.meta.url));

test('host CLI sends explicit requests and exposes a new token only when issued', async () => {
  const calls = [], secret = 'synthetic-admin-secret', token = 'zwh_synthetic-new-token';
  let registered = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
    res.setHeader('content-type', 'application/json');
    let result = { id: 'host-1', name: 'test host', createdAt: '2026-01-01', requestId: 'request-1', revoked: false, bindingCount: 0 };
    if (req.url === '/admin/harnesses' && req.method === 'POST') {
      if (!registered) { registered = true; res.statusCode = 201; result = { ...result, token }; }
      else result = { ...result, replayed: true, tokenAvailable: false };
    } else if (req.url === '/admin/harnesses/host-1/token') result = { token };
    else if (req.url.startsWith('/admin/harnesses?')) result = { harnesses: [result], nextAfter: null };
    else if (req.method === 'DELETE') result = { ok: true };
    res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const invoke = args => run(process.execPath, [script, ...args], { env: { ...process.env, ZIWO_URL: `http://127.0.0.1:${server.address().port}`, ZIWO_ADMIN_SECRET: secret } });
    const first = await invoke(['host-register', 'test host', 'request-1']);
    assert.equal(JSON.parse(first.stdout).token, token);
    assert.deepEqual(calls.at(-1).body, { name: 'test host', requestId: 'request-1' });
    const retry = await invoke(['host-register', 'test host', 'request-1']);
    assert(!retry.stdout.includes(token)); assert(!retry.stderr.includes(token));
    assert.match(`${retry.stdout}\n${retry.stderr}`, /host-token/);
    await invoke(['hosts', '--name', 'test host', '--request', 'request-1', '--after', 'host-0', '--limit', '10']);
    const url = new URL(calls.at(-1).url, 'http://localhost');
    assert.equal(url.pathname, '/admin/harnesses');
    assert.deepEqual(Object.fromEntries(url.searchParams), { name: 'test host', requestId: 'request-1', after: 'host-0', limit: '10' });
    await invoke(['host-show', 'host-1']); assert.equal(calls.at(-1).url, '/admin/harnesses/host-1');
    const rotated = await invoke(['host-token', 'host-1']); assert.equal(JSON.parse(rotated.stdout).token, token);
    assert.equal(calls.at(-1).method, 'POST');
    await invoke(['host-revoke', 'host-1']); assert.equal(calls.at(-1).method, 'DELETE');
    const before = calls.length;
    await assert.rejects(invoke(['host-register', 'test host']));
    assert.equal(calls.length, before);
    for (const output of [first, retry, rotated]) { assert(!output.stdout.includes(secret)); assert(!output.stderr.includes(secret)); }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
