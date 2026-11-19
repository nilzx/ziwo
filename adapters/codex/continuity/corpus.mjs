import { createHash } from 'node:crypto';

export const corpusFormat = 'ziwo-continuity-corpus-v1';
export const candidateFormat = 'ziwo-continuity-candidate-v1';
export const representationVersion = 'ziwo-continuity-context-v1';
const kinds = new Set(['historical_original', 'current_sample', 'summary', 'self_report', 'observer_report']);
const behavior = new Set(['historical_original', 'current_sample']);
export const dimensions = ['continuity', 'task', 'calibration', 'relationship', 'overImitation', 'bias'];
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
export const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const fail = message => { throw new Error(message); };
const object = (v, name) => v && typeof v === 'object' && !Array.isArray(v) ? v : fail(`${name} must be an object`);
const text = (v, name, max = 12000) => typeof v === 'string' && v.trim() && v.length <= max ? v : fail(`invalid ${name}`);
const id = (v, name) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(v) ? v : fail(`invalid ${name}`);
const list = (v, name, max = 1000) => Array.isArray(v) && v.length <= max ? v : fail(`invalid ${name}`);
const timestamp = (v, name) => Number.isSafeInteger(v) && v > 0 ? v : fail(`invalid ${name}`);
const fields = (v, allowed, name) => { for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(`unknown ${name} field: ${k}`); };
const normalize = value => value.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
const shingles = value => {
  const s = [...normalize(value)], result = new Set();
  for (let i = 0; i + 4 <= s.length; i++) result.add(s.slice(i, i + 4).join(''));
  return result;
};
function resembles(a, b) {
  if (normalize(a) === normalize(b)) return true;
  const x = shingles(a), y = shingles(b);
  if (x.size < 12 || y.size < 12) return false;
  const overlap = [...x].filter(v => y.has(v)).length;
  return overlap / Math.max(x.size, y.size) >= 0.85;
}
function sourceText(s) { return behavior.has(s.kind) ? `${s.prompt}\n${s.response}` : s.text; }

export function validateCorpus(raw) {
  const c = structuredClone(object(raw, 'corpus'));
  fields(c, ['format', 'identityId', 'synthetic', 'scope', 'behaviorFrozenAt', 'sources', 'memories', 'cases'], 'corpus');
  if (c.format !== corpusFormat || typeof c.synthetic !== 'boolean') fail('unsupported corpus format');
  id(c.identityId, 'identityId'); timestamp(c.behaviorFrozenAt, 'behaviorFrozenAt');
  object(c.scope, 'scope'); fields(c.scope, ['id', 'description', 'coverage', 'gaps'], 'scope');
  id(c.scope.id, 'scope.id'); text(c.scope.description, 'scope.description');
  if (!['complete', 'partial'].includes(c.scope.coverage)) fail('invalid coverage');
  list(c.scope.gaps, 'scope.gaps', 100).forEach(v => text(v, 'gap'));
  if ((c.scope.coverage === 'complete') !== (c.scope.gaps.length === 0)) fail('coverage and gaps disagree');
  const ids = new Set(), groups = new Map();
  for (const s of list(c.sources, 'sources', 500)) {
    object(s, 'source'); fields(s, ['id', 'identityId', 'kind', 'groupId', 'split', 'origin', 'collectedAt', 'occurredAt', 'context', 'prompt', 'response', 'text', 'observer'], 'source');
    id(s.id, 'source.id'); if (ids.has(s.id)) fail('duplicate source id'); ids.add(s.id);
    if (s.identityId !== c.identityId) fail('source belongs to a different identity');
    if (!kinds.has(s.kind)) fail('unsupported source kind; generated test output cannot become extraction evidence');
    id(s.groupId, 'source.groupId'); text(s.origin, 'source.origin', 2000); text(s.context, 'source.context', 2000);
    if (!['extraction', 'holdout'].includes(s.split)) fail('invalid source split');
    if (groups.has(s.groupId) && groups.get(s.groupId) !== s.split) fail('an original event group crosses extraction and holdout');
    groups.set(s.groupId, s.split); timestamp(s.collectedAt, 'collectedAt');
    if (s.occurredAt !== null) timestamp(s.occurredAt, 'occurredAt');
    if (behavior.has(s.kind)) {
      text(s.prompt, 'source.prompt'); text(s.response, 'source.response');
      if (s.text !== undefined || s.observer !== undefined) fail('behavior must preserve its actual prompt and response');
      if (s.collectedAt > c.behaviorFrozenAt) fail('behavior must be frozen before self-description or extraction');
    } else {
      text(s.text, 'source.text');
      if (s.prompt !== undefined || s.response !== undefined) fail('summaries and reports are not original dialogue quotes');
      if (s.kind === 'self_report' && s.collectedAt < c.behaviorFrozenAt) fail('freeze natural behavior before collecting self-description');
      if (s.kind === 'observer_report') text(s.observer, 'observer');
    }
  }
  const training = c.sources.filter(s => s.split === 'extraction'), held = c.sources.filter(s => s.split === 'holdout');
  if (training.filter(s => behavior.has(s.kind)).length < 2 || held.length < 1) fail('behavior evidence and held-out sources are required');
  for (let i = 0; i < training.length; i++) for (const b of training.slice(i + 1)) {
    const a = training[i];
    if (a.groupId !== b.groupId && resembles(sourceText(a), sourceText(b))) fail('duplicate evidence cannot count as independent event groups');
  }
  for (const a of training) for (const b of held) {
    if (resembles(sourceText(a), sourceText(b)) || behavior.has(a.kind) && behavior.has(b.kind) && resembles(a.prompt, b.prompt)) fail('duplicate or near-duplicate material crosses the held-out boundary');
  }
  const memoryIds = new Set();
  for (const m of list(c.memories, 'memories', 100)) {
    object(m, 'memory'); fields(m, ['id', 'text', 'sourceIds'], 'memory'); id(m.id, 'memory.id'); text(m.text, 'memory.text', 4000);
    if (!list(m.sourceIds, 'memory.sourceIds', 50).length || m.sourceIds.some(x => !training.some(s => s.id === x))) fail('common memory context must cite extraction sources only');
    if (held.some(s => behavior.has(s.kind) && resembles(m.text, s.response))) fail('common memory context leaks held-out responses');
    if (memoryIds.has(m.id)) fail('duplicate memory id'); memoryIds.add(m.id);
  }
  const cases = new Set();
  for (const test of list(c.cases, 'cases', 20)) {
    object(test, 'case'); fields(test, ['id', 'referenceSourceIds', 'prompts', 'rubric', 'compactBeforeLast', 'checks'], 'case');
    id(test.id, 'case.id'); if (cases.has(test.id)) fail('duplicate case id'); cases.add(test.id);
    if (!list(test.referenceSourceIds, 'referenceSourceIds', 20).length || test.referenceSourceIds.some(x => !held.some(s => s.id === x))) fail('case references must use only held-out sources');
    if (typeof test.compactBeforeLast !== 'boolean') fail('invalid compaction choice');
    if (list(test.prompts, 'prompts', 10).length < 2) fail('cases require multiple turns');
    test.prompts.forEach(v => text(v, 'prompt', 4000));
    if (test.prompts.some(p => training.some(s => behavior.has(s.kind) && resembles(s.prompt, p)))) fail('test prompts repeat extraction situations');
    list(test.rubric, 'rubric', 20).forEach(v => text(v, 'rubric', 2000));
    for (const check of list(test.checks, 'checks', 20)) {
      object(check, 'check'); fields(check, ['turn', 'contains'], 'check');
      if (!Number.isInteger(check.turn) || check.turn < 0 || check.turn >= test.prompts.length) fail('invalid check turn');
      text(check.contains, 'check.contains', 200);
    }
  }
  if (!cases.size) fail('held-out test cases are required');
  if (JSON.stringify(c).length > 500000) fail('corpus exceeds the reference experiment limit');
  return c;
}

export function extractionInput(corpus) {
  const c = validateCorpus(corpus);
  // Cases, holdout examples, memory-only context and scoring criteria are not
  // available to extraction, so they cannot be selected as persona evidence.
  return { identityId: c.identityId, scope: c.scope, behaviorFrozenAt: c.behaviorFrozenAt,
    sources: c.sources.filter(s => s.split === 'extraction') };
}

export function validateCandidate(raw, corpus) {
  const c = validateCorpus(corpus), p = structuredClone(object(raw, 'candidate'));
  fields(p, ['format', 'identityId', 'corpusDigest', 'document', 'claims', 'rationale', 'counterexamples', 'uncertainty'], 'candidate');
  if (p.format !== candidateFormat || p.identityId !== c.identityId || p.corpusDigest !== digest(c)) fail('candidate does not match this frozen identity corpus');
  const d = object(p.document, 'document'); fields(d, ['summary', 'principles', 'style', 'boundaries', 'examples'], 'document');
  text(d.summary, 'summary', 2000);
  const statements = [{ section: 'summary', text: d.summary }];
  for (const section of ['principles', 'style', 'boundaries']) for (const v of list(d[section], section, 20)) { text(v, section, 2000); statements.push({ section, text: v }); }
  const sources = new Map(c.sources.filter(s => s.split === 'extraction').map(s => [s.id, s]));
  for (const claim of list(p.claims, 'claims', 100)) {
    object(claim, 'claim'); fields(claim, ['section', 'text', 'evidenceIds', 'counterEvidenceIds', 'scope', 'confidence'], 'claim');
    if (!statements.some(s => s.section === claim.section && s.text === claim.text)) fail('claim does not map to a persona statement');
    text(claim.scope, 'claim.scope', 2000);
    if (!['supported', 'tentative'].includes(claim.confidence)) fail('invalid claim confidence');
    if (!list(claim.evidenceIds, 'evidenceIds', 50).length) fail('every claim needs evidence');
    list(claim.counterEvidenceIds, 'counterEvidenceIds', 50);
    for (const sourceId of [...claim.evidenceIds, ...claim.counterEvidenceIds]) if (!sources.has(sourceId)) fail('claim evidence is outside the extraction set');
    const distinctBehavior = new Set(claim.evidenceIds.map(x => sources.get(x)).filter(s => behavior.has(s.kind)).map(s => s.groupId));
    if (claim.confidence === 'supported' && distinctBehavior.size < 2) fail('supported traits require independent behavior in at least two event groups');
  }
  for (const statement of statements) if (p.claims.filter(s => s.section === statement.section && s.text === statement.text).length !== 1) fail('every persona statement needs one traceable claim');
  for (const example of list(d.examples, 'examples', 10)) {
    object(example, 'example'); fields(example, ['sourceId', 'situation', 'response', 'limits'], 'example');
    const source = sources.get(example.sourceId);
    if (!source || !behavior.has(source.kind) || example.situation !== source.prompt || example.response !== source.response) fail('examples must quote exact original behavior from extraction sources');
    text(example.limits, 'example.limits', 2000);
  }
  text(p.rationale, 'rationale', 4000);
  list(p.counterexamples, 'counterexamples', 30).forEach(x => text(x, 'counterexample', 2000));
  list(p.uncertainty, 'uncertainty', 30).forEach(x => text(x, 'uncertainty', 2000));
  return p;
}

export function renderCondition(corpus, candidate, condition) {
  const c = validateCorpus(corpus), p = validateCandidate(candidate, c);
  if (!['A', 'B', 'C'].includes(condition)) fail('invalid condition');
  const result = { representationVersion, memory: c.memories.map(m => ({ ...m })) };
  if (condition !== 'A') {
    const { examples, ...persona } = p.document; result.persona = persona;
    if (condition === 'C') result.examples = examples.map(e => ({ situation: e.situation, response: e.response, limits: e.limits }));
  }
  return result;
}

export function makePlan(corpus, candidate, { repeats = 2, seed = 'ziwo-n5-v1', maxModelTurns = 60 } = {}) {
  const c = validateCorpus(corpus), p = validateCandidate(candidate, c);
  if (p.document.examples.length === 0) fail('A/B/C comparison requires at least one original example');
  if (!Number.isInteger(repeats) || repeats < 2 || repeats > 5) fail('repeats must be between 2 and 5');
  text(seed, 'seed', 200);
  const trials = [];
  for (let repeat = 0; repeat < repeats; repeat++) for (const test of c.cases) for (const condition of ['A', 'B', 'C']) {
    const label = 'sample_' + digest([seed, test.id, repeat, condition]).slice(0, 16);
    trials.push({ label, caseId: test.id, repeat, condition, turnCount: test.prompts.length, compactBeforeLast: test.compactBeforeLast, contextDigest: digest(renderCondition(c, p, condition)) });
  }
  trials.sort((a, b) => digest([seed, a.label]).localeCompare(digest([seed, b.label])));
  const generationTurns = trials.reduce((n, t) => n + c.cases.find(x => x.id === t.caseId).prompts.length, 0);
  const compactions = trials.filter(t => c.cases.find(x => x.id === t.caseId).compactBeforeLast).length;
  const judgments = c.cases.length * repeats;
  const needed = generationTurns + compactions + judgments;
  if (!Number.isInteger(maxModelTurns) || needed > maxModelTurns) fail(`experiment requires ${needed} model operations, above its limit`);
  return { format: 'ziwo-continuity-plan-v1', corpusDigest: digest(c), candidateDigest: digest(p), representationVersion,
    seed, modelSeed: null, repeats, maxModelTurns, plannedModelOperations: needed, generationTurns, compactions, judgments, trials };
}

export function blindPacket(corpus, trials) {
  const c = validateCorpus(corpus);
  if (trials.length !== 3 || new Set(trials.map(t => t.condition)).size !== 3 || trials.some(t => !['A', 'B', 'C'].includes(t.condition)) || new Set(trials.map(t => t.label)).size !== 3 || new Set(trials.map(t => t.caseId)).size !== 1 || new Set(trials.map(t => t.repeat)).size !== 1) fail('a blind block requires A/B/C for one case and repeat');
  const test = c.cases.find(t => t.id === trials[0].caseId); if (!test) fail('unknown case');
  for (const t of trials) if (!Array.isArray(t.responses) || t.responses.length !== test.prompts.length || t.responses.some(x => typeof x !== 'string' || !x.trim())) fail('blind samples must contain every completed response');
  return { rubric: test.rubric, referenceBehavior: c.sources.filter(s => test.referenceSourceIds.includes(s.id)),
    prompts: test.prompts, samples: [...trials].sort((a, b) => a.label.localeCompare(b.label)).map(t => ({ label: t.label, responses: t.responses })) };
}

export function validateJudgment(raw, packet) {
  const j = structuredClone(object(raw, 'judgment')); fields(j, ['scores', 'limitations'], 'judgment');
  if (list(j.scores, 'scores', 3).length !== 3 || new Set(j.scores.map(s => s.label)).size !== 3) fail('judge must score each blinded sample exactly once');
  for (const score of j.scores) {
    object(score, 'score'); fields(score, ['label', 'ratings', 'reason', 'observedRisks'], 'score');
    if (!packet.samples.some(s => s.label === score.label)) fail('unknown blind label');
    object(score.ratings, 'ratings'); fields(score.ratings, dimensions, 'ratings');
    for (const d of dimensions) if (!Number.isInteger(score.ratings[d]) || score.ratings[d] < 1 || score.ratings[d] > 5) fail('ratings must be ordinal integers 1 to 5');
    text(score.reason, 'score.reason', 4000); list(score.observedRisks, 'observedRisks', 20).forEach(x => text(x, 'risk', 2000));
  }
  list(j.limitations, 'limitations', 20).forEach(x => text(x, 'limitation', 2000)); return j;
}

export function summarize(plan, trials, judgments) {
  if (trials.length !== plan.trials.length || new Set(trials.map(t => t.label)).size !== plan.trials.length) fail('incomplete or duplicate trial results');
  const byLabel = new Map(trials.map(t => [t.label, t]));
  for (const expected of plan.trials) {
    const t = byLabel.get(expected.label);
    if (!t || ['caseId', 'repeat', 'condition', 'contextDigest'].some(k => t[k] !== expected[k]) || !Array.isArray(t.responses) || t.responses.length !== expected.turnCount || t.responses.some(x => typeof x !== 'string' || !x.trim())) fail('trial result does not match the frozen plan');
  }
  if (judgments.length !== plan.judgments) fail('incomplete blind judgment blocks');
  for (const j of judgments) {
    const first = byLabel.get(j.scores?.[0]?.label); if (!first) fail('unknown judgment label');
    validateJudgment(j, { samples: trials.filter(t => t.caseId === first.caseId && t.repeat === first.repeat) });
  }
  const scores = judgments.flatMap(j => j.scores);
  if (scores.length !== trials.length || new Set(scores.map(s => s.label)).size !== trials.length) fail('incomplete or duplicate blind judgments');
  const groups = Object.fromEntries(['A', 'B', 'C'].map(condition => {
    const selected = scores.filter(s => byLabel.get(s.label)?.condition === condition);
    if (!selected.length) fail('missing condition');
    const means = Object.fromEntries(dimensions.map(d => [d, selected.reduce((n, s) => n + s.ratings[d], 0) / selected.length]));
    const checks = trials.filter(t => t.condition === condition).flatMap(t => t.checks ?? []);
    return [condition, { samples: selected.length, ordinalMeans: means, literalChecks: { passed: checks.filter(x => x.passed).length, total: checks.length } }];
  }));
  const paired = [];
  for (const a of trials.filter(t => t.condition === 'A')) {
    const ratings = Object.fromEntries(trials.filter(t => t.caseId === a.caseId && t.repeat === a.repeat).map(t => [t.condition, scores.find(s => s.label === t.label).ratings]));
    paired.push({ caseId: a.caseId, repeat: a.repeat, BminusA: Object.fromEntries(dimensions.map(d => [d, ratings.B[d] - ratings.A[d]])), CminusB: Object.fromEntries(dimensions.map(d => [d, ratings.C[d] - ratings.B[d]])) });
  }
  return { groups, paired, conclusion: 'Descriptive pilot evidence only; no universal pass threshold or real-persona continuity claim.',
    limitations: ['Small sample, ordinal model judgments, no human familiarity rating, and response style may reveal a condition.', 'Literal checks are narrow task checks, not a complete capability score.', 'A/B/C are isolated offline conditions; they never change a live identity binding.'] };
}
