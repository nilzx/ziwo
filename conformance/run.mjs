import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const cases = [
  { id: 'MCP-01', description: 'Synthetic service discovery and text tool compatibility.', group: 'ordinary', evidence: 'server-observed', files: ['mcp.test.ts'] },
  { id: 'MCP-02', description: 'Synthetic service authentication and endpoint isolation.', group: 'ordinary', evidence: 'server-observed', files: ['context-sync.test.ts', 'identity-bindings.test.ts', 'lifecycle-mcp.test.ts'] },
  { id: 'SYNC-01', description: 'Synthetic service pagination, cursor isolation and fixed upper bound.', group: 'sync', evidence: 'server-observed', files: ['context-sync.test.ts', 'sync.test.ts'] },
  { id: 'SYNC-02', description: 'Synthetic empty checks and subsequent memory writes.', group: 'sync', evidence: 'server-observed', files: ['context-sync.test.ts'] },
  { id: 'SYNC-03', description: 'Synthetic invalidation and cursor rejection.', group: 'sync', evidence: 'server-observed', files: ['context-sync.test.ts'] },
  { id: 'TRUST-01', description: 'Synthetic service metadata, binding and initialization gates; not host verification.', group: 'trust', evidence: 'server-observed', files: ['lifecycle-mcp.test.ts'] },
  { id: 'TRUST-02', description: 'Simulated gateway refresh, blocking and context-loss behavior; excludes steering, scoped executor and exact actual model input.', group: 'trust', evidence: 'simulated-host', node: ['codex-host.node.mjs'] },
  { id: 'TRUST-03', description: 'Synthetic service recovery authorization and idempotency.', group: 'trust', evidence: 'server-observed', files: ['mcp-recovery.test.ts', 'identity-bindings.test.ts'] },
  { id: 'ISOL-01', description: 'Synthetic service lineage and binding isolation; not actual host provenance.', group: 'isolation', evidence: 'server-observed', files: ['lifecycle-mcp.test.ts'] },
  { id: 'ISOL-02', description: 'Simulated temporary-helper boundary and service rejection; not actual host isolation.', group: 'isolation', evidence: 'simulated-host', files: ['identity-bindings.test.ts'], node: ['codex-host.node.mjs'] },
];
const groups = ['ordinary', 'sync', 'trust', 'isolation'];
export function parseArgs(args) {
  const options = { groups: [...groups] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--list') options.list = true;
    else if (arg === '--groups' || arg === '--report') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--report') options.report = value;
      else {
        options.groups = value.split(',');
        if (new Set(options.groups).size !== options.groups.length || options.groups.some(g => !groups.includes(g))) throw new Error('Unknown or duplicate group');
      }
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}
export function runSuite(options, run = spawnSync) {
  const selected = cases.filter(c => options.groups.includes(c.group));
  const files = [...new Set(selected.flatMap(c => c.files ?? []))];
  const nodes = [...new Set(selected.flatMap(c => c.node ?? []))];
  const outcomes = new Map();
  // Run each file independently so one failure cannot be attributed to another file.
  for (const file of files) {
    const result = run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', `test/${file}`], { cwd: resolve(root, 'worker'), stdio: 'ignore' });
    outcomes.set(file, result.status === 0 ? 'pass' : result.status === null ? 'blocked' : 'fail');
  }
  for (const file of nodes) {
    const result = run(process.execPath, ['--test', `test/node/${file}`], { cwd: resolve(root, 'worker'), stdio: 'ignore' });
    outcomes.set(file, result.status === 0 ? 'pass' : result.status === null ? 'blocked' : 'fail');
  }
  const results = cases.map(c => {
    if (!options.groups.includes(c.group)) return { id: c.id, description: c.description, group: c.group, evidence: c.evidence, test_files: [...(c.files ?? []).map(f => `worker/test/${f}`), ...(c.node ?? []).map(f => `worker/test/node/${f}`)], status: 'not-run' };
    const states = [...(c.files ?? []), ...(c.node ?? [])].map(f => outcomes.get(f));
    return { id: c.id, description: c.description, group: c.group, evidence: c.evidence, test_files: [...(c.files ?? []).map(f => `worker/test/${f}`), ...(c.node ?? []).map(f => `worker/test/node/${f}`)], status: states.includes('fail') ? 'fail' : states.includes('blocked') ? 'blocked' : 'pass' };
  });
  return { schema_version: 1, contract_version: 1, generated_at: new Date().toISOString(), selected_groups: options.groups, scope: 'local-synthetic', aggregation: 'Each case passes only when every listed test file passes; file-level results are not independent case executions.', results };
}
export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.list) { process.stdout.write(JSON.stringify(cases, null, 2) + '\n'); return 0; }
  const report = runSuite(options);
  const json = JSON.stringify(report, null, 2) + '\n';
  if (options.report) await writeFile(options.report, json, { mode: 0o600 });
  else process.stdout.write(json);
  return report.results.some(r => ['fail', 'blocked'].includes(r.status)) ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(() => { process.stderr.write('Invalid arguments or report could not be written.\n'); process.exitCode = 1; });
