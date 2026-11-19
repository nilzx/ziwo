import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCorpus, extractionInput, validateCandidate, renderCondition, makePlan, blindPacket, validateJudgment, summarize, digest, corpusFormat, candidateFormat, dimensions } from '../../../adapters/codex/continuity/corpus.mjs';

const clone = x => structuredClone(x);
function fixture() {
  const source = (id, groupId, split, prompt, response) => ({ id, identityId: 'synthetic', kind: 'historical_original', groupId, split, origin: 'synthetic fixture', collectedAt: 10, occurredAt: null, context: 'ordinary conversation', prompt, response });
  const corpus = { format: corpusFormat, identityId: 'synthetic', synthetic: true, scope: { id: 'scope', description: 'synthetic only', coverage: 'partial', gaps: ['earlier records unavailable'] }, behaviorFrozenAt: 20,
    sources: [source('s1', 'g1', 'extraction', 'How should we handle this mistake?', 'Let us first identify what happened.'), source('s2', 'g2', 'extraction', 'I disagree with the proposed schedule.', 'I see the concern; here is another option.'), source('h1', 'g3', 'holdout', 'Can you help me choose a birthday activity?', 'We can start with what your friend enjoys.'), { id: 'sum', identityId: 'synthetic', kind: 'summary', groupId: 'g4', split: 'extraction', origin: 'synthetic summary', collectedAt: 10, occurredAt: null, context: 'summary', text: 'A summary, not a quotation.' }, { id: 'self', identityId: 'synthetic', kind: 'self_report', groupId: 'g5', split: 'extraction', origin: 'synthetic report', collectedAt: 21, occurredAt: null, context: 'self description', text: 'I try to be attentive.' }],
    memories: [{ id: 'm1', text: 'A shared synthetic fact.', sourceIds: ['s1'] }], cases: [{ id: 'case1', referenceSourceIds: ['h1'], prompts: ['Suggest a low cost outing.', 'Now adapt it for rainy weather.'], rubric: ['Observe practical reasoning.'], compactBeforeLast: false, checks: [] }] };
  const candidate = { format: candidateFormat, identityId: 'synthetic', corpusDigest: digest(corpus), document: { summary: 'Attentive and practical.', principles: [], style: [], boundaries: [], examples: [{ sourceId: 's1', situation: corpus.sources[0].prompt, response: corpus.sources[0].response, limits: 'Only in similar contexts.' }] }, claims: [{ section: 'summary', text: 'Attentive and practical.', evidenceIds: ['s1', 's2'], counterEvidenceIds: [], scope: 'These synthetic situations.', confidence: 'supported' }], rationale: 'Synthetic evidence.', counterexamples: [], uncertainty: ['Limited sample.'] };
  return { corpus, candidate };
}
const invalidCorpus = (edit, pattern) => { const { corpus } = fixture(); edit(corpus); assert.throws(() => validateCorpus(corpus), pattern); };
const invalidCandidate = (edit, pattern) => { const { corpus, candidate } = fixture(); edit(candidate, corpus); candidate.corpusDigest = digest(corpus); assert.throws(() => validateCandidate(candidate, corpus), pattern); };

test('valid synthetic fixture preserves provenance and extraction excludes holdout', () => {
  const { corpus, candidate } = fixture(); assert.deepEqual(validateCorpus(corpus), corpus); validateCandidate(candidate, corpus);
  const input = extractionInput(corpus); assert.deepEqual(input.sources.map(x => x.id), ['s1', 's2', 'sum', 'self']); assert.equal(input.cases, undefined); assert.equal(input.memories, undefined);
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});

test('ownership, source types and frozen behavior are enforced', () => {
  invalidCorpus(c => { c.sources[0].identityId = 'other'; }, /different identity/);
  invalidCorpus(c => { c.sources[0].kind = 'generated_test_output'; }, /generated test output/);
  invalidCorpus(c => { c.sources[0].collectedAt = 21; }, /frozen/);
  invalidCorpus(c => { c.sources[4].collectedAt = 19; }, /freeze/);
  invalidCorpus(c => { c.sources[3].prompt = 'pretend quote'; }, /not original dialogue/);
  invalidCorpus(c => { c.sources[0].text = 'rewritten'; }, /actual prompt and response/);
  invalidCorpus(c => { c.scope.coverage = 'complete'; }, /coverage and gaps/);
});

test('held-out event and near-duplicate material cannot leak', () => {
  invalidCorpus(c => { c.sources[2].groupId = 'g1'; }, /crosses/);
  invalidCorpus(c => { c.sources[2].prompt = c.sources[0].prompt; }, /duplicate/);
  invalidCorpus(c => { c.sources[2].prompt = c.sources[0].prompt; c.sources[2].response = c.sources[0].response; }, /duplicate/);
  invalidCorpus(c => { c.cases[0].referenceSourceIds = ['s1']; }, /held-out/);
  invalidCorpus(c => { c.cases[0].prompts[0] = c.sources[0].prompt; }, /repeat extraction/);
});

test('candidate claims require independent behavioral evidence and exact examples', () => {
  invalidCandidate(p => { p.claims[0].evidenceIds = ['s1', 'sum', 'self']; }, /two event groups/);
  invalidCandidate(p => { p.claims[0].evidenceIds = ['s1', 'h1']; }, /outside the extraction/);
  invalidCandidate(p => { p.document.examples[0].response += ' Changed.'; }, /quote exact/);
  invalidCandidate(p => { p.document.examples[0].sourceId = 'sum'; }, /quote exact/);
  invalidCandidate(p => { p.document.summary = 'Untraced claim'; }, /claim does not map|traceable/);
  invalidCandidate(p => { p.identityId = 'other'; }, /does not match/);
});

test('A B C differ only by persona and verbatim examples', () => {
  const { corpus, candidate } = fixture(); const [a, b, c] = ['A', 'B', 'C'].map(x => renderCondition(corpus, candidate, x));
  assert.deepEqual(a.memory, b.memory); assert.deepEqual(b.memory, c.memory); assert.equal(a.persona, undefined); assert.equal(a.examples, undefined); assert.equal(b.examples, undefined); assert.deepEqual(b.persona, c.persona); assert.equal(c.examples[0].response, corpus.sources[0].response);
});

test('plan is deterministic, bounded and contains fixed context digests', () => {
  const { corpus, candidate } = fixture(); const a = makePlan(corpus, candidate, { seed: 'one' }); const b = makePlan(corpus, candidate, { seed: 'one' });
  assert.deepEqual(a, b); assert.notDeepEqual(a.trials.map(x => x.label), makePlan(corpus, candidate, { seed: 'two' }).trials.map(x => x.label));
  assert.equal(a.trials.length, 6); assert.equal(a.plannedModelOperations, 14); assert.throws(() => makePlan(corpus, candidate, { maxModelTurns: 13 }), /above its limit/);
  for (const trial of a.trials) assert.equal(trial.contextDigest, digest(renderCondition(corpus, candidate, trial.condition)));
});

test('blind packets hide conditions and judgments reject missing or duplicate scores', () => {
  const { corpus, candidate } = fixture(); const plan = makePlan(corpus, candidate); const trials = plan.trials.map(t => ({ ...t, responses: ['first', 'second'] }));
  const block = trials.filter(t => t.repeat === 0); const packet = blindPacket(corpus, block);
  assert.equal(packet.samples.length, 3); assert.ok(packet.samples.every(s => !('condition' in s) && !('contextDigest' in s))); assert.equal(JSON.stringify(packet).includes('"condition"'), false);
  const score = label => ({ label, ratings: Object.fromEntries(dimensions.map(d => [d, 3])), reason: 'Synthetic assessment.', observedRisks: [] });
  const judgment = { scores: packet.samples.map(s => score(s.label)), limitations: [] }; validateJudgment(judgment, packet);
  const missing = clone(judgment); missing.scores.pop(); assert.throws(() => validateJudgment(missing, packet), /exactly once/);
  const duplicate = clone(judgment); duplicate.scores[1].label = duplicate.scores[0].label; assert.throws(() => validateJudgment(duplicate, packet), /exactly once/);
  const unknown = clone(judgment); unknown.scores[0].label = 'unknown'; assert.throws(() => validateJudgment(unknown, packet), /unknown blind label/);
  const otherPacket = blindPacket(corpus, trials.filter(t => t.repeat === 1)); const judgments = [judgment, { scores: otherPacket.samples.map(s => score(s.label)), limitations: [] }];
  assert.equal(summarize(plan, trials, judgments).paired.length, 2);
  assert.throws(() => summarize(plan, trials.slice(1), judgments), /incomplete/);
  const dupResults = clone(trials); dupResults[0] = clone(dupResults[1]); assert.throws(() => summarize(plan, dupResults, judgments), /duplicate/);
  assert.throws(() => summarize(plan, trials, [judgment, judgment]), /duplicate/);
});

test('duplicate extraction events cannot inflate support and memories cite extraction', () => {
  invalidCorpus(c => { c.sources[1].prompt = c.sources[0].prompt; c.sources[1].response = c.sources[0].response; }, /duplicate evidence/);
  invalidCorpus(c => { delete c.memories[0].sourceIds; }, /sourceIds/);
  invalidCorpus(c => { c.memories[0].sourceIds = ['h1']; }, /extraction sources/);
  invalidCorpus(c => { c.memories[0].sourceIds = []; }, /extraction sources/);
  invalidCandidate((p, c) => { c.sources[1].groupId = c.sources[0].groupId; }, /two event groups/);
});

test('a plan requires a real extraction example for condition C', () => {
  const { corpus, candidate } = fixture(); candidate.document.examples = []; validateCandidate(candidate, corpus);
  assert.throws(() => makePlan(corpus, candidate), /at least one original example/);
});

test('blind boundary rejects wrong conditions, repeated labels and incomplete responses', () => {
  const { corpus, candidate } = fixture(); const plan = makePlan(corpus, candidate);
  const trials = plan.trials.filter(t => t.repeat === 0).map(t => ({ ...t, responses: ['one', 'two'] }));
  assert.ok(trials.every(t => t.turnCount === 2));
  const wrong = clone(trials); wrong[0].condition = 'D'; assert.throws(() => blindPacket(corpus, wrong), /A\/B\/C/);
  const repeated = clone(trials); repeated[0].label = repeated[1].label; assert.throws(() => blindPacket(corpus, repeated), /A\/B\/C/);
  const missing = clone(trials); missing[0].responses.pop(); assert.throws(() => blindPacket(corpus, missing), /every completed response/);
});

test('summary rejects incomplete responses and malformed judgment ratings', () => {
  const { corpus, candidate } = fixture(); const plan = makePlan(corpus, candidate);
  const trials = plan.trials.map(t => ({ ...t, responses: ['one', 'two'] }));
  const judgments = [0, 1].map(repeat => ({ scores: trials.filter(t => t.repeat === repeat).map(t => ({ label: t.label, ratings: Object.fromEntries(dimensions.map(d => [d, 3])), reason: 'Evidence.', observedRisks: [] })), limitations: [] }));
  const missing = clone(trials); missing[0].responses.pop(); assert.throws(() => summarize(plan, missing, judgments), /frozen plan/);
  const bad = clone(judgments); delete bad[0].scores[0].ratings.bias; assert.throws(() => summarize(plan, trials, bad), /ratings/);
});

import { ContinuityExperiment } from '../../../adapters/codex/continuity/experiment.mjs';
class MemoryArtifacts {
  files = new Map();
  async save(name, value) { if (this.files.has(name)) throw Error('duplicate artifact'); this.files.set(name, clone(value)); }
}
class FakeServer {
  cwd = '/isolated'; calls = []; threads = new Map(); turns = new Map(); next = 0; compactNotify = true; invalidJudge = false;
  async request(method, params = {}) {
    this.calls.push({ method, params: clone(params) });
    if (method === 'thread/start') { const id = `t${++this.next}`; this.threads.set(id, params.developerInstructions); return { model: params.model, thread: { id } }; }
    if (method === 'turn/start') { const id = `turn${++this.next}`; this.turns.set(id, { threadId: params.threadId, params }); return { turn: { id } }; }
    if (method === 'thread/compact/start') { if (this.compactNotify) this.onNotification?.({ method: 'item/completed', params: { threadId: params.threadId, item: { type: 'contextCompaction' } } }); return {}; }
    if (method === 'thread/resume') return { model: params.model, thread: { id: params.threadId } };
    return {};
  }
  async completed(threadId, id) {
    const turn = this.turns.get(id), prompt = turn.params.input[0].text, instructions = this.threads.get(threadId);
    let response = 'Synthetic response.';
    if (instructions.includes('independent persona evaluator')) response = JSON.stringify(this.candidate);
    if (instructions.includes('independent blinded evaluator')) {
      const packet = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
      response = this.invalidJudge ? '{}' : JSON.stringify({ scores: packet.samples.map(s => ({ label: s.label, ratings: Object.fromEntries(dimensions.map(d => [d, 3])), reason: 'Synthetic reason.', observedRisks: [] })), limitations: [] });
    }
    return { status: 'completed', items: [{ type: 'agentMessage', text: response }] };
  }
  wait() { return Promise.resolve({ params: { turn: { status: 'completed' } } }); }
  async dispose() { this.disposed = true; }
}

test('fake runner isolates extraction, fresh trials, fixed context and observed compaction', async () => {
  const { corpus, candidate } = fixture(); corpus.cases[0].compactBeforeLast = true; candidate.corpusDigest = digest(corpus);
  const fake = new FakeServer(); fake.candidate = candidate; const artifacts = new MemoryArtifacts();
  const experiment = await new ContinuityExperiment({ serverFactory: async () => fake, maxModelTurns: 30 }).open();
  await experiment.extract(corpus, artifacts); const result = await experiment.run(corpus, candidate, artifacts); await experiment.close();
  assert.equal(result.modelOperations, 21); assert.equal(result.personaAdopted, undefined);
  const starts = fake.calls.filter(x => x.method === 'thread/start'); assert.equal(starts.length, 9); assert.ok(starts.every(x => x.params.dynamicTools.length === 0 && x.params.environments.length === 0));
  const extraction = fake.calls.find(x => x.method === 'turn/start').params.input[0].text;
  assert.ok(!extraction.includes(corpus.sources[2].response)); assert.ok(!extraction.includes(corpus.cases[0].prompts[0]));
  const generation = fake.calls.filter(x => x.method === 'turn/start' && x.params.additionalContext); assert.equal(generation.length, 12);
  for (const t of new Set(generation.map(x => x.params.threadId))) assert.equal(new Set(generation.filter(x => x.params.threadId === t).map(x => JSON.stringify(x.params.additionalContext))).size, 1);
  assert.equal(fake.calls.filter(x => x.method === 'thread/compact/start').length, 6); assert.equal(fake.calls.filter(x => x.method === 'thread/resume').length, 6);
  assert.ok([...artifacts.files.values()].filter(x => x?.responses).every(x => x.compactionObserved && x.resumed));
  assert.equal(artifacts.files.get('environment.json').personaAdopted, false);
  assert.ok(fake.calls.every(x => !JSON.stringify(x).includes('Bearer ') && !JSON.stringify(x).includes('/evaluation/') && !JSON.stringify(x).includes('/persona/')));
});

test('fake runner stops at budget or unobserved compaction and never saves success', async () => {
  const { corpus, candidate } = fixture(); corpus.cases[0].compactBeforeLast = true; candidate.corpusDigest = digest(corpus);
  const low = new FakeServer(), lowArtifacts = new MemoryArtifacts(); const a = await new ContinuityExperiment({ serverFactory: async () => low, maxModelTurns: 19 }).open();
  await assert.rejects(a.run(corpus, candidate, lowArtifacts), /above its limit/); assert.equal(low.calls.filter(x => x.method === 'turn/start').length, 0); await a.close();
  const fake = new FakeServer(); fake.compactNotify = false; const artifacts = new MemoryArtifacts(); const b = await new ContinuityExperiment({ serverFactory: async () => fake }).open();
  await assert.rejects(b.run(corpus, candidate, artifacts), /compaction was not observed/); assert.equal(artifacts.files.has('summary.json'), false); assert.equal(fake.calls.filter(x => x.method === 'thread/resume').length, 0); await b.close();
});

test('invalid judge output is retained but cannot produce a success summary', async () => {
  const { corpus, candidate } = fixture(); const fake = new FakeServer(); fake.invalidJudge = true; const artifacts = new MemoryArtifacts();
  const experiment = await new ContinuityExperiment({ serverFactory: async () => fake }).open();
  await assert.rejects(experiment.run(corpus, candidate, artifacts));
  assert.ok([...artifacts.files.keys()].some(k => k.startsWith('judge-'))); assert.equal(artifacts.files.has('summary.json'), false); assert.equal(artifacts.files.get('environment.json').personaAdopted, false); await experiment.close();
});
