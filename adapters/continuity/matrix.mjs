import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Artifacts, ContinuityExperiment } from '../codex/continuity/experiment.mjs';
import { digest, dimensions, makePlan, validateCorpus, validateCandidate } from '../codex/continuity/corpus.mjs';

export const matrixFormat = 'ziwo-environment-matrix-v1';
const fail = message => { throw new Error(message); };
const fields = (v, keys, name) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) fail(`invalid ${name}`);
};
const name = (s, field) => typeof s === 'string' && (field === 'model' || field === 'judgeModel' ? /^[A-Za-z0-9_.-]{1,100}$/ : /^[A-Za-z0-9_-]{1,100}$/).test(s) ? s : fail(`invalid ${field}`);

export function matrixPlan(raw, corpus, candidate) {
  const config = structuredClone(raw), c = validateCorpus(corpus), p = validateCandidate(candidate, c);
  fields(config, ['format', 'judgeModel', 'repeats', 'seed', 'maxModelOperations', 'environments'], 'matrix configuration');
  if (config.format !== matrixFormat) fail('unsupported matrix format'); name(config.judgeModel, 'judgeModel');
  if (!Number.isInteger(config.repeats) || config.repeats < 2 || config.repeats > 5 || typeof config.seed !== 'string' || !config.seed.trim() || config.seed.length > 200) fail('matrix requires explicit repeats and ordering seed');
  if (!Number.isSafeInteger(config.maxModelOperations) || config.maxModelOperations < 1 || config.maxModelOperations > 500) fail('invalid total operation limit');
  if (!Array.isArray(config.environments) || config.environments.length < 2 || config.environments.length > 4) fail('matrix requires two to four environments');
  const ids = new Set(), profiles = new Set();
  for (const e of config.environments) {
    fields(e, ['id', 'harness', 'model', 'effort'], 'environment');
    for (const key of ['id', 'harness', 'model']) name(e[key], key);
    if (e.effort !== 'low') fail('this pilot fixes effort to low');
    if (ids.has(e.id)) fail('duplicate environment id'); ids.add(e.id);
    const key = digest([e.harness, e.model, e.effort]); if (profiles.has(key)) fail('duplicate environment profile'); profiles.add(key);
  }
  const trialPlan = makePlan(c, p, { repeats: config.repeats, seed: config.seed, maxModelTurns: config.maxModelOperations });
  const plannedModelOperations = trialPlan.plannedModelOperations * config.environments.length;
  if (plannedModelOperations > config.maxModelOperations) fail(`matrix requires ${plannedModelOperations} operations, above its total limit`);
  return { format: 'ziwo-environment-plan-v1', config, configDigest: digest(config), corpusDigest: digest(c), candidateDigest: digest(p),
    contextRepresentation: trialPlan.representationVersion, plannedModelOperations, perEnvironmentOperations: trialPlan.plannedModelOperations,
    commonTrialPlan: makePlan(c, p, { repeats: config.repeats, seed: config.seed, maxModelTurns: trialPlan.plannedModelOperations }), realContinuityPrerequisite: 'not established by a synthetic matrix' };
}

function validateResult(plan, environment, result) {
  if (result.format !== 'ziwo-continuity-report-v1' || result.corpusDigest !== plan.corpusDigest || result.candidateDigest !== plan.candidateDigest) fail('matrix result belongs to another frozen input');
  if (result.planDigest !== digest(plan.commonTrialPlan)) fail('environment trial plan differs from the frozen comparison');
  if (result.metadata?.model !== environment.model || result.metadata?.judgeModel !== plan.config.judgeModel || result.metadata?.harnessId !== environment.harness || result.metadata?.effort !== environment.effort) fail('actual environment does not match the frozen target');
  if (result.modelOperations !== plan.perEnvironmentOperations) fail('environment operation accounting differs from the plan');
  for (const condition of ['A', 'B', 'C']) {
    const group = result.groups?.[condition];
    if (group?.samples !== plan.commonTrialPlan.trials.filter(t => t.condition === condition).length) fail('missing matrix samples');
    for (const dimension of dimensions) if (!Number.isFinite(group.ordinalMeans?.[dimension]) || group.ordinalMeans[dimension] < 1 || group.ordinalMeans[dimension] > 5) fail('invalid matrix ratings');
  }
}

export function summarizeMatrix(plan, results) {
  if (results.length !== plan.config.environments.length || new Set(results.map(r => r.environmentId)).size !== results.length) fail('incomplete or duplicate environment results');
  for (const r of results) {
    const e = plan.config.environments.find(e => e.id === r.environmentId); if (!e) fail('unknown environment result');
    validateResult(plan, e, r.report);
  }
  const reference = results.find(r => r.environmentId === plan.config.environments[0].id);
  const differences = results.filter(r => r !== reference).map(r => ({ environmentId: r.environmentId, referenceId: reference.environmentId,
    ordinalMeanDifferences: Object.fromEntries(['A', 'B', 'C'].map(c => [c, Object.fromEntries(dimensions.map(d => [d, r.report.groups[c].ordinalMeans[d] - reference.report.groups[c].ordinalMeans[d]]))])) }));
  const harnesses = new Set(plan.config.environments.map(e => e.harness));
  return { format: 'ziwo-environment-report-v1', corpusDigest: plan.corpusDigest, candidateDigest: plan.candidateDigest, planDigest: digest(plan),
    modelOperations: results.reduce((n, r) => n + r.report.modelOperations, 0), results, differences,
    crossHarness: harnesses.size > 1 ? 'multiple adapter-reported harnesses; inspect each adapter evidence' : 'not tested: one harness',
    longTermFormation: 'not tested by short synthetic sequences', personaAdopted: false,
    conclusion: 'Descriptive matched-condition pilot, not a claim of real-persona continuity or a model ranking.',
    limitations: ['The common judge can favor its own model family; no independent human familiarity rating was collected.', 'Model builds and sampling seeds may be unknown; matching settings cannot equalize model capability.', 'Adapter metadata is a trusted implementation assertion, not a cryptographic proof of runtime behavior.'] };
}

// Additional harnesses need an explicit trusted factory implementing open/run/
// close plus operation accounting and actual environment receipts. No endpoint,
// token or arbitrary executable is accepted through the JSON configuration.
export async function runMatrix(config, corpus, candidate, artifacts, { createExperiment, onProgress = () => {} } = {}) {
  const c = validateCorpus(corpus), p = validateCandidate(candidate, c), plan = matrixPlan(config, c, p);
  if (!createExperiment && plan.config.environments.some(e => e.harness !== 'codex-app-server')) fail('unsupported harness: no verified adapter is installed');
  const factory = createExperiment ?? ((e, options) => new ContinuityExperiment({ model: e.model, judgeModel: plan.config.judgeModel, effort: e.effort, ...options }));
  await artifacts.save('matrix-plan.private.json', plan);
  await artifacts.save('matrix-implementation.json', { digest: digest(await readFile(new URL('./matrix.mjs', import.meta.url), 'utf8')) });
  const results = []; let operations = 0;
  for (const environment of plan.config.environments) {
    const child = await Artifacts.create(join(artifacts.directory, environment.id));
    const experiment = factory(environment, { maxModelTurns: plan.perEnvironmentOperations,
      onProgress: event => onProgress({ environmentId: environment.id, ...event, totalOperations: operations + event.operations, totalLimit: plan.config.maxModelOperations }) });
    try {
      if (operations + plan.perEnvironmentOperations > plan.config.maxModelOperations) fail('matrix total budget exhausted');
      await experiment.open();
      const report = await experiment.run(c, p, child, { repeats: plan.config.repeats, seed: plan.config.seed });
      validateResult(plan, environment, report);
      if (experiment.operations !== report.modelOperations) fail('runner operation accounting differs from its report');
      operations += report.modelOperations; results.push({ environmentId: environment.id, report });
    } catch (error) {
      const attempted = experiment.operations;
      await child.save('failure.json', { message: error.message, modelOperations: Number.isSafeInteger(attempted) ? attempted : null });
      await artifacts.save('failure.json', { environmentId: environment.id, message: error.message, completedOperations: operations,
        failedEnvironmentOperations: Number.isSafeInteger(attempted) ? attempted : null, partialResultsAreNotSuccess: true });
      throw error;
    } finally { await experiment.close(); }
  }
  const summary = summarizeMatrix(plan, results);
  await artifacts.save('matrix-summary.json', summary); return summary;
}
