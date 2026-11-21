import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../bin/ziwo-admin.mjs', import.meta.url));
test('persona CLI keeps approval on the exact reviewed digest and retries the same receipt', async () => {
  const calls = [], digest = 'a'.repeat(64), secret = 'synthetic-private-admin';
  let stale = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
    res.setHeader('content-type', 'application/json');
    const result = req.url.endsWith('/identity') ? { identity: { id: 'zi_test' }, instance: 'i_test' }
      : req.url.endsWith('/evaluations') ? { evaluationId: 'ev_test', token: 'zev_new_synthetic', mcpUrl: 'https://example.test/evaluation/mcp' }
      : req.method === 'GET' ? { identityId: 'zi_test', instance: 'i_test', digest, stale, document: { summary: 'Review this exact proposal' } }
      : req.url.endsWith('/adopt') ? { adoptedVersion: 1, currentVersion: 1 } : { ok: true };
    res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const invoke = args => run(process.execPath, [script, ...args], { env: { ...process.env, ZIWO_URL: `http://127.0.0.1:${server.address().port}`, ZIWO_ADMIN_SECRET: secret } });
    await assert.rejects(invoke(['persona-evaluate', 'synthetic', 'request-1', '--inherited']));
    assert.equal(calls.length, 0);
    const made = await invoke(['persona-evaluate', 'synthetic', 'request-1', '--fresh']);
    assert.equal(JSON.parse(made.stdout).token, 'zev_new_synthetic');
    assert.equal(calls.at(-1).body.source, 'fresh');
    assert(!made.stdout.includes(secret)); assert(!made.stderr.includes(secret));
    const reviewed = await invoke(['persona-review', 'synthetic', 'pp_test']);
    assert.equal(JSON.parse(reviewed.stdout).digest, digest);
    const before = calls.length;
    await assert.rejects(invoke(['persona-approve', 'synthetic', 'pp_test', 'b'.repeat(64)]));
    assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).method, 'GET');
    for (let i = 0; i < 2; i++) {
      const result = await invoke(['persona-approve', 'synthetic', 'pp_test', digest]);
      assert.equal(JSON.parse(result.stdout).adoptedVersion, 1);
    }
    const confirmations = calls.filter(c => c.path.endsWith('/confirm'));
    assert.equal(confirmations.length, 2);
    assert.deepEqual(confirmations[0].body, confirmations[1].body);
    assert.equal(confirmations[0].body.digest, digest);
    stale = true;
    const last = calls.length;
    await assert.rejects(invoke(['persona-approve', 'synthetic', 'pp_test', digest]));
    assert.equal(calls.length, last + 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
