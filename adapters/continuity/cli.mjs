#!/usr/bin/env node
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Artifacts } from '../codex/continuity/experiment.mjs';
import { digest, validateCorpus, validateCandidate } from '../codex/continuity/corpus.mjs';
import { matrixPlan, runMatrix } from './matrix.mjs';

const [command, configPath, corpusPath, candidatePath, outputPath] = process.argv.slice(2);
const read = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
try {
  if (!['plan', 'run'].includes(command) || !configPath || !corpusPath || !candidatePath || command === 'run' && !outputPath) throw new Error('Usage: node adapters/continuity/cli.mjs plan|run CONFIG CORPUS CANDIDATE [NEW_OUTPUT_DIR]');
  const config = await read(configPath), corpus = validateCorpus(await read(corpusPath)), candidate = validateCandidate(await read(candidatePath), corpus);
  const plan = matrixPlan(config, corpus, candidate);
  if (command === 'plan') console.log(JSON.stringify(plan, null, 2));
  else {
    if (!corpus.synthetic) {
      if (!process.stdin.isTTY) throw new Error('Real material requires interactive confirmation of identity, scope, models and input digests');
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log(JSON.stringify({ identityId: corpus.identityId, scope: corpus.scope, corpusDigest: digest(corpus), candidateDigest: digest(candidate), config: plan.config }, null, 2));
        if (await terminal.question('Confirm this exact offline material and environment plan by typing its identity ID: ') !== corpus.identityId) throw new Error('Material use was not confirmed');
      } finally { terminal.close(); }
    }
    await mkdir(dirname(resolve(outputPath)), { recursive: true, mode: 0o700 });
    const artifacts = await Artifacts.create(resolve(outputPath));
    await artifacts.save('authorization.json', { identityId: corpus.identityId, synthetic: corpus.synthetic, scope: corpus.scope,
      corpusDigest: digest(corpus), candidateDigest: digest(candidate), configDigest: plan.configDigest, confirmedAt: new Date().toISOString(),
      purpose: 'offline-synthetic-or-operator-selected-environment-comparison', source: corpus.synthetic ? 'explicit-synthetic-run' : 'interactive-operator-selection' });
    const summary = await runMatrix(config, corpus, candidate, artifacts, { onProgress: e => console.error(`${e.environmentId} ${e.stage}: ${e.totalOperations}/${e.totalLimit}`) });
    console.log(JSON.stringify({ directory: resolve(outputPath), modelOperations: summary.modelOperations,
      groups: summary.results.map(r => ({ environmentId: r.environmentId, groups: r.report.groups })), conclusion: summary.conclusion }, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
