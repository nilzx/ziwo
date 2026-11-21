import { isIP } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Caller must supply an explicitly designated synthetic fixture and a private token.
export async function probe({ endpoint, token, remote = false, fetchImpl = fetch, timeoutMs = 10000, signal }) {
  const url = new URL(endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || (!loopback && (!remote || url.protocol !== 'https:'))) throw new Error('Endpoint must be loopback, or explicitly enabled remote HTTPS');
  if (typeof token !== 'string' || !token.trim()) throw new Error('A fixture token is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid timeout');
  let id = 0, session;
  async function call(method, params = {}, notification = false) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-06-18' };
    if (session) headers['mcp-session-id'] = session;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try { response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: combined, headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++id }), method, params }) }); } catch { throw new Error('MCP request failed'); }
    if (!response.ok) throw new Error('MCP request failed');
    session = response.headers.get('mcp-session-id') || session;
    if (notification) return;
    const raw = await response.text();
    let message;
    try { message = JSON.parse(response.headers.get('content-type')?.includes('text/event-stream') ? raw.split('\n').find(line => line.startsWith('data: '))?.slice(6) : raw); } catch { throw new Error('Invalid MCP response'); }
    if (!message || message.jsonrpc !== '2.0' || message.id !== id || message.error || !message.result) throw new Error('MCP request failed');
    return message.result;
  }
  const steps = [];
  const initialized = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ziwo-conformance', version: '1' } });
  if (initialized.protocolVersion !== '2025-06-18' || !initialized.capabilities || typeof initialized.capabilities !== 'object' || !initialized.capabilities.tools || typeof initialized.capabilities.tools !== 'object') throw new Error('Invalid MCP initialization');
  await call('notifications/initialized', {}, true);
  steps.push('initialize');
  const listing = await call('tools/list');
  if (!Array.isArray(listing.tools) || !['check', 'sync_context'].every(name => listing.tools.some(t => t.name === name))) throw new Error('Required tools unavailable');
  steps.push('tools/list');
  const check = await call('tools/call', { name: 'check', arguments: {} });
  if (check.isError || !Array.isArray(check.content) || !check.content.some(c => c.type === 'text' && typeof c.text === 'string')) throw new Error('Text check failed');
  steps.push('check-text');
  let page = await call('tools/call', { name: 'sync_context', arguments: {} });
  if (page.isError || !page.structuredContent || page.structuredContent.complete !== true || typeof page.structuredContent.cursor !== 'string') throw new Error('Initial sync must complete in one page for this probe');
  page = await call('tools/call', { name: 'sync_context', arguments: { cursor: page.structuredContent.cursor } });
  if (page.isError || page.structuredContent?.complete !== true || !Array.isArray(page.structuredContent.changes) || page.structuredContent.changes.length || page.structuredContent.persona !== undefined) throw new Error('Empty sync failed');
  steps.push('sync-initial-and-empty');
  return { schema_version: 1, contract_version: 1, generated_at: new Date().toISOString(), scope: 'synthetic-fixture-probe', evidence: 'server-observed', status: 'pass', steps };
}

export async function probeFromEnv({ tokenEnv, ...options }) {
  if (typeof tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error('A token environment variable name is required');
  return probe({ ...options, token: process.env[tokenEnv] });
}

export function parseProbeArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--remote') { if (options.remote) throw new Error('Duplicate option'); options.remote = true; continue; }
    if (!['--endpoint', '--token-env', '--report'].includes(arg)) throw new Error('Unknown option');
    const key = { '--endpoint': 'endpoint', '--token-env': 'tokenEnv', '--report': 'report' }[arg];
    const value = args[++i];
    if (!value || value.startsWith('--') || options[key] !== undefined) throw new Error('Invalid option');
    options[key] = value;
  }
  if (!options.endpoint || !options.tokenEnv) throw new Error('Missing option');
  return options;
}
export async function main(args = process.argv.slice(2)) {
  const { report: path, ...options } = parseProbeArgs(args);
  const report = await probeFromEnv(options);
  const json = JSON.stringify(report, null, 2) + '\n';
  if (path) await writeFile(path, json, { mode: 0o600 }); else process.stdout.write(json);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write('Probe failed. Check fixture configuration and availability.\n'); process.exitCode = 1; });
