#!/usr/bin/env node
// Minimal host-registry smoke check. State contains no credentials.
import { randomUUID } from 'node:crypto';
import { chmod, link, open, readFile, rename, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const allowed = new Set(['--remote', '--resume', '--rotate-lost-token']);
let manifestPath;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--manifest' && args[i + 1] && !manifestPath) manifestPath = resolve(args[++i]);
  else if (!allowed.has(args[i])) throw new Error(`Unknown or incomplete argument: ${args[i]}`);
}
if (!manifestPath || !process.env.ZIWO_URL || !process.env.ZIWO_ADMIN_SECRET) throw new Error('Set ZIWO_URL and ZIWO_ADMIN_SECRET and pass --manifest <path>.');
const base = new URL(process.env.ZIWO_URL);
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || (base.pathname !== '/' && base.pathname !== '')) throw new Error('ZIWO_URL must be an HTTP(S) origin.');
const hostname = base.hostname.replace(/^\[|\]$/g, '').toLowerCase();
const loopback = hostname === 'localhost' || hostname === '::1' || (isIP(hostname) === 4 && hostname.startsWith('127.'));
if (!loopback && base.protocol !== 'https:') throw new Error('Remote targets require HTTPS.');
if (!loopback && !args.includes('--remote')) throw new Error('Remote targets require --remote.');
const origin = base.origin;
const adminSecret = process.env.ZIWO_ADMIN_SECRET;
try { new Headers({ authorization: `Bearer ${adminSecret}` }); } catch { throw new Error('Admin secret cannot be used in an HTTP header.'); }
let state;
async function persist(initial = false) {
  const data = JSON.stringify(state, null, 2) + '\n';
  if (initial) {
    const temporary = `${manifestPath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      await link(temporary, manifestPath);
    } finally { await unlink(temporary).catch(() => {}); }
  } else {
    const temporary = `${manifestPath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      await rename(temporary, manifestPath); await chmod(manifestPath, 0o600);
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
}
if (args.includes('--resume')) {
  state = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (state.version !== 1 || state.base !== origin || !/^smoke:[a-f0-9-]{36}$/.test(state.operationId) || state.name !== `smoke-${state.operationId.slice(6)}` || (state.id && !/^h_[a-f0-9-]{36}$/.test(state.id))) throw new Error('Manifest does not match the target or expected operation identity.');
  if (state.complete) throw new Error('Manifest already completed.');
} else {
  const id = randomUUID();
  state = { version: 1, base: origin, operationId: `smoke:${id}`, name: `smoke-${id}`, stage: 'prepared' };
  await persist(true);
}
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function request(path, method = 'GET', body, token = adminSecret) {
  const response = await fetch(`${origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data; try { data = await response.json(); } catch { throw new Error(`Invalid JSON response from ${method} ${path}; state retained.`); }
  return { status: response.status, data, cache: response.headers.get('cache-control') };
}
const registration = () => request('/admin/harnesses', 'POST', { name: state.name, requestId: state.operationId });
const auth = token => request('/harness/v1/binding?threadId=smoke', 'GET', undefined, token);
function matchHost(host) { return host && host.id === state.id && host.name === state.name && host.requestId === state.operationId; }
try {
  // Inspect a known host before any mutation, especially after an uncertain DELETE.
  if (state.id) {
    const existing = await request(`/admin/harnesses/${state.id}`);
    check(existing.status === 200 && matchHost(existing.data), 'Host detail mismatch; state retained.');
    if (existing.data.revoked === true) {
      state.stage = 'cleanup-confirmed'; await persist();
      console.log(`Host already revoked; cleanup confirmed. Original token authentication could not be rechecked. Manifest: ${manifestPath}`);
      process.exit(0);
    }
    check(existing.data.revoked === false, 'Unknown host state; state retained.');
  }
  // A repeated POST recovers a lost registration response without issuing a token.
  const made = await registration();
  check([200, 201].includes(made.status) && made.data.name === state.name && made.data.requestId === state.operationId && /^h_[a-f0-9-]{36}$/.test(made.data.id), 'Unexpected registration response; state retained.');
  if (state.id) check(state.id === made.data.id, 'Registration does not match manifest; state retained.');
  state.id = made.data.id; state.stage = 'registered'; await persist();
  let token = made.status === 201 ? made.data.token : undefined;
  check(made.status !== 201 || typeof token === 'string', 'Registration did not provide a token; state retained.');
  const detail = await request(`/admin/harnesses/${state.id}`);
  check(detail.status === 200 && matchHost(detail.data) && detail.data.revoked === false, 'Host detail mismatch; state retained.');
  const list = await request(`/admin/harnesses?requestId=${encodeURIComponent(state.operationId)}`);
  check(list.status === 200 && list.data.harnesses?.length === 1 && matchHost(list.data.harnesses[0]), 'Host lookup mismatch; state retained.');
  const retry = await registration();
  check(retry.status === 200 && matchHost(retry.data) && retry.data.replayed === true && retry.data.tokenAvailable === false && !('token' in retry.data), 'Registration replay mismatch; state retained.');
  if (!token) {
    check(args.includes('--rotate-lost-token'), 'Token unavailable; resume with --rotate-lost-token to explicitly rotate it.');
    state.stage = 'recovering-token'; await persist();
    const recovered = await request(`/admin/harnesses/${state.id}/token`, 'POST');
    check(recovered.status === 200 && recovered.data.id === state.id && typeof recovered.data.token === 'string', 'Token recovery failed; state retained.');
    token = recovered.data.token;
  }
  check((await auth(token)).status === 200, 'Host authentication failed; state retained.');
  state.stage = 'rotating-token'; await persist();
  const rotated = await request(`/admin/harnesses/${state.id}/token`, 'POST');
  check(rotated.status === 200 && rotated.data.id === state.id && typeof rotated.data.token === 'string' && rotated.data.token !== token, 'Token rotation failed; state retained.');
  check((await auth(token)).status === 401 && (await auth(rotated.data.token)).status === 200, 'Rotation authentication check failed; state retained.');
  const replay = await registration();
  check(replay.status === 200 && matchHost(replay.data) && replay.data.replayed === true && !('token' in replay.data), 'Post-rotation replay mismatch; state retained.');
  check((await auth(rotated.data.token)).status === 200, 'Replay changed authentication; state retained.');
  state.stage = 'verified'; await persist();
  const beforeDelete = await request(`/admin/harnesses/${state.id}`);
  check(beforeDelete.status === 200 && matchHost(beforeDelete.data) && beforeDelete.data.revoked === false, 'Host changed before cleanup; state retained.');
  state.stage = 'revoking'; await persist();
  const revoked = await request(`/admin/harnesses/${state.id}`, 'DELETE');
  check(revoked.status === 200 && revoked.data.revoked === state.id, 'Revocation result unknown; state retained.');
  state.stage = 'revoked'; await persist();
  const afterDelete = await request(`/admin/harnesses/${state.id}`);
  check(afterDelete.status === 200 && matchHost(afterDelete.data) && afterDelete.data.revoked === true && (await auth(rotated.data.token)).status === 401, 'Revocation verification failed; state retained.');
  state.stage = 'complete'; state.complete = true; await persist();
  console.log(`Host registry smoke passed; manifest: ${manifestPath}`);
} catch (error) {
  console.error(`Host registry smoke failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  console.error(`State retained at ${manifestPath}`);
  process.exitCode = 1;
}
