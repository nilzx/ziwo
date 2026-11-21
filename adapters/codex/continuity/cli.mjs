#!/usr/bin/env node
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Artifacts, ContinuityExperiment } from './experiment.mjs';
import { digest, validateCandidate, validateCorpus } from './corpus.mjs';

const [command, corpusPath, outputPath, candidatePath] = process.argv.slice(2);
if (!['validate', 'extract', 'run'].includes(command) || !corpusPath || command !== 'validate' && !outputPath || command === 'run' && !candidatePath) {
  console.error('Usage: node adapters/codex/continuity/cli.mjs validate CORPUS | extract CORPUS NEW_OUTPUT_DIR | run CORPUS NEW_OUTPUT_DIR CANDIDATE');
  process.exit(1);
}
let experiment;
try {
  const corpus = validateCorpus(JSON.parse(await readFile(resolve(corpusPath), 'utf8')));
  if (command === 'validate') {
    console.log(JSON.stringify({ valid: true, identityId: corpus.identityId, synthetic: corpus.synthetic, digest: digest(corpus), sources: corpus.sources.length, cases: corpus.cases.length }));
  } else {
    // Only an explicit local operator can authorize a real corpus. No model
    // tool or supplied "approved" property can bypass this terminal control.
    if (!corpus.synthetic) {
      if (!process.stdin.isTTY) throw new Error('Real material requires interactive confirmation of its exact identity, scope and digest');
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log(JSON.stringify({ identityId: corpus.identityId, scope: corpus.scope, corpusDigest: digest(corpus), model: 'gpt-6.1-terra', maxModelOperations: command === 'extract' ? 2 : 60 }, null, 2));
        const answer = await terminal.question('Confirm you may use exactly this corpus for offline extraction/evaluation with Codex. Type its identity ID: ');
        if (answer !== corpus.identityId) throw new Error('Corpus use was not confirmed');
      } finally { terminal.close(); }
    }
    const candidate = command === 'run' ? validateCandidate(JSON.parse(await readFile(resolve(candidatePath), 'utf8')), corpus) : null;
    await mkdir(dirname(resolve(outputPath)), { recursive: true, mode: 0o700 });
    const artifacts = await Artifacts.create(resolve(outputPath));
    await artifacts.save('authorization.json', { identityId: corpus.identityId, corpusDigest: digest(corpus), scopeId: corpus.scope.id,
      purpose: 'offline-persona-extraction-and-continuity-evaluation', synthetic: corpus.synthetic, confirmedAt: new Date().toISOString(), source: corpus.synthetic ? 'explicit-synthetic-run' : 'interactive-operator-selection' });
    experiment = new ContinuityExperiment({ maxModelTurns: command === 'extract' ? 2 : 60,
      onProgress: e => console.error(`${e.stage}: ${e.operations}/${e.maxModelTurns}`) });
    try {
      await experiment.open();
      if (command === 'extract') {
        const result = await experiment.extract(corpus, artifacts);
        console.log(JSON.stringify({ candidateDigest: digest(result), claims: result.claims.length, examples: result.document.examples.length, adopted: false, directory: resolve(outputPath) }));
      } else {
        const result = await experiment.run(corpus, candidate, artifacts);
        console.log(JSON.stringify({ directory: resolve(outputPath), modelOperations: result.modelOperations, groups: result.groups, conclusion: result.conclusion }, null, 2));
      }
    } catch (error) { await artifacts.save('failure.json', { message: error.message, modelOperations: experiment.operations }); throw error; }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await experiment?.close(); }
