import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matrixPlan, summarizeMatrix, runMatrix } from '../../../adapters/continuity/matrix.mjs';
import { Artifacts } from '../../../adapters/codex/continuity/experiment.mjs';
import { digest, dimensions } from '../../../adapters/codex/continuity/corpus.mjs';
const read = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const corpus = await read('../../../adapters/codex/continuity/fixtures/synthetic.json');
const candidate = await read('../../../adapters/continuity/synthetic-candidate.json');
const config = await read('../../../adapters/continuity/synthetic-matrix.json');
const clone = structuredClone;
function report(plan, e) {
  return { format: 'ziwo-continuity-report-v1', corpusDigest: plan.corpusDigest, candidateDigest: plan.candidateDigest, planDigest: digest(plan.commonTrialPlan),
    metadata: { model: e.model, judgeModel: plan.config.judgeModel, harnessId: e.harness, effort: e.effort }, modelOperations: plan.perEnvironmentOperations,
    groups: Object.fromEntries(['A', 'B', 'C'].map(c => [c, { samples: plan.commonTrialPlan.trials.filter(t => t.condition === c).length, ordinalMeans: Object.fromEntries(dimensions.map(d => [d, 3])) }])) };
}
async function artifacts() { const root = await mkdtemp(join(tmpdir(), 'ziwo-matrix-test-')); return { root, output: await Artifacts.create(join(root, 'output')) }; }

test('plan freezes shared input, trials and total budget', () => {
  const p = matrixPlan(config, corpus, candidate);
  assert.equal(p.plannedModelOperations, 92); assert.equal(p.perEnvironmentOperations, 46);
  assert.deepEqual(matrixPlan(clone(config), clone(corpus), clone(candidate)), p);
  const tooSmall = clone(config); tooSmall.maxModelOperations = 91;
  assert.throws(() => matrixPlan(tooSmall, corpus, candidate), /above its total limit/);
  const duplicate = clone(config); duplicate.environments[1].model = duplicate.environments[0].model;
  assert.throws(() => matrixPlan(duplicate, corpus, candidate), /duplicate environment profile/);
});

test('summary rejects missing, wrong input, plan, model, judge, harness and operation count', () => {
  const p = matrixPlan(config, corpus, candidate);
  const results = p.config.environments.map(e => ({ environmentId: e.id, report: report(p, e) }));
  assert.equal(summarizeMatrix(p, results).crossHarness, 'not tested: one harness');
  assert.throws(() => summarizeMatrix(p, results.slice(0, 1)));
  for (const mutate of [
    r => { r.corpusDigest = 'wrong'; }, r => { r.candidateDigest = 'wrong'; }, r => { r.planDigest = 'wrong'; },
    r => { r.metadata.model = 'wrong'; }, r => { r.metadata.judgeModel = 'wrong'; }, r => { r.metadata.harnessId = 'other'; },
    r => { r.modelOperations--; }, r => { r.groups.A.samples--; },
  ]) { const changed = clone(results); mutate(changed[1].report); assert.throws(() => summarizeMatrix(p, changed)); }
});

test('unsupported second harness is rejected before starting or creating results', async () => {
  const f = await artifacts(); try {
    const bad = clone(config); bad.environments[1].harness = 'imaginary';
    await assert.rejects(runMatrix(bad, corpus, candidate, f.output), /unsupported harness/);
    await assert.rejects(readFile(join(f.output.directory, 'matrix-summary.json')));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('failure in second environment preserves failure, closes runners and emits no summary', async () => {
  const f = await artifacts(), p = matrixPlan(config, corpus, candidate), closed = [];
  try {
    await assert.rejects(runMatrix(config, corpus, candidate, f.output, { createExperiment: e => ({ operations: 0,
      async open() {}, async run() { if (e.id === 'sol') { this.operations = 2; throw Error('synthetic failure'); } this.operations = p.perEnvironmentOperations; return report(p, e); }, async close() { closed.push(e.id); } }) }), /synthetic failure/);
    assert.deepEqual(closed, ['terra', 'sol']);
    const failure = JSON.parse(await readFile(join(f.output.directory, 'failure.json'), 'utf8'));
    assert.equal(failure.completedOperations, 46); assert.equal(failure.failedEnvironmentOperations, 2);
    await assert.rejects(readFile(join(f.output.directory, 'matrix-summary.json')));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
