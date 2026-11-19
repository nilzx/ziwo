import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../../adapters/codex/continuity/corpus.mjs';
import { formationFormat, reviewFormat, pilotPolicy, minimalPersona, validateFormationMaterial, assessFormation, validateFormationReview, reviewReceipt, prepareFormationReview } from '../../../adapters/persona/formation.mjs';

const day = 86400000, now = 1800000000000;
const material = () => ({ format: formationFormat, identityId: 'subject-a', identitySummary: 'A new subject', synthetic: true,
  scope: { id: 'scope', description: 'Synthetic material', coverage: 'complete', gaps: [] }, asOf: now,
  baseline: null, policy: { ...pilotPolicy }, sources: [], previousReview: null, diagnostics: [] });
const source = (i, overrides = {}) => ({ id: `s${i}`, identityId: 'subject-a', kind: 'current_sample', groupId: `g${i}`, contextId: `c${i % 3}`, origin: 'synthetic', collectedAt: now - day, occurredAt: now - (30 - i * 3) * day,
  prompt: `Situation ${i}: ${['weather', 'coding', 'music', 'travel', 'books', 'food', 'games', 'art', 'sport'][i]}`, response: `Distinct response ${i}: ${['rainy afternoon', 'debugging carefully', 'melody and rhythm', 'train station', 'fictional library', 'spicy noodles', 'board game', 'painting colors', 'running track'][i]}`, ...overrides });
const populated = () => { const m = material(); m.sources = Array.from({ length: 6 }, (_, i) => source(i)); return m; };
const review = (m, changeKind, document = null, claims = []) => ({ format: reviewFormat, identityId: m.identityId, inputDigest: digest(m), baseVersion: m.baseline?.version ?? null, changeKind, rationale: 'Synthetic rationale', document, claims, counterexamples: [], uncertainty: [] });
const claim = (section, text, extras = {}) => ({ section, text, evidenceIds: ['s0', 's1'], counterEvidenceIds: [], recognitionIds: [], scope: 'These situations', ...extras });
const baseline = () => { const document = minimalPersona('Existing subject'); return { version: 1, document, documentDigest: digest(document) }; };

test('empty material retains only minimal initialization and never authorizes adoption', () => {
  const m = material(), a = assessFormation(m);
  assert.equal(a.status, 'insufficient_evidence');
  assert.deepEqual(a.minimalInitialization, minimalPersona(m.identitySummary));
  assert.equal(a.automaticEvaluation, false); assert.equal(a.automaticAdoption, false);
  const result = prepareFormationReview(m, review(m, 'initialize', a.minimalInitialization));
  assert.equal(result.requiresConcreteUserConfirmation, true); assert.equal(result.adoptionAuthorized, false); assert.equal(result.liveProposal, false);
  assert.throws(() => validateFormationReview(review(m, 'initialize', { ...a.minimalInitialization, style: ['invented'] }), m));
});

test('only independent behavioral groups with known span count toward pilot suggestion', () => {
  const m = material(); m.sources = [source(0), source(1, { groupId: 'g0', contextId: 'c0', occurredAt: source(0).occurredAt })];
  assert.equal(assessFormation(m).evidence.events, 1); assert.equal(assessFormation(m).status, 'insufficient_evidence');
  const reports = material(); reports.sources = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, identityId: 'subject-a', kind: 'self_report', groupId: `g${i}`, contextId: `c${i % 3}`, origin: 'synthetic', collectedAt: now - day, occurredAt: null, text: `Report ${i}` }));
  assert.equal(assessFormation(reports).evidence.events, 0);
  const unknown = populated(); unknown.sources.forEach(s => { s.occurredAt = null; });
  assert.equal(assessFormation(unknown).evidence.knownTimeSpanDays, null); assert.equal(assessFormation(unknown).status, 'insufficient_evidence');
  const enough = populated(); assert.equal(assessFormation(enough).status, 'review_suggested');
  assert.equal(assessFormation(enough).automaticAdoption, false);
});

test('no new events, cooldown boundary, and changed baseline are distinct', () => {
  const old = populated(), receipt = reviewReceipt(old), m = populated(); m.previousReview = receipt;
  assert.equal(assessFormation(m).status, 'no_new_evidence');
  m.sources.push(source(6), source(7), source(8));
  assert.equal(assessFormation(m).status, 'cooldown');
  m.asOf += pilotPolicy.cooldownDays * day;
  assert.equal(assessFormation(m).status, 'review_suggested');
  m.baseline = baseline(); assert.equal(assessFormation(m).status, 'baseline_changed');
});

test('loading diagnostics take priority and cannot smuggle a persona replacement', () => {
  const m = populated(); m.diagnostics = [{ kind: 'wrong_version', detail: 'Synthetic mismatch' }];
  assert.equal(assessFormation(m).status, 'diagnose_loading');
  assert.equal(prepareFormationReview(m, review(m, 'loading_repair')).requiresConcreteUserConfirmation, false);
  assert.throws(() => validateFormationReview(review(m, 'loading_repair', minimalPersona('replacement')), m));
  assert.throws(() => validateFormationReview(review(m, 'initialize', minimalPersona(m.identitySummary)), m));
  m.diagnostics = []; assert.throws(() => validateFormationReview(review(m, 'loading_repair'), m));
});

test('review kinds enforce baseline, grounded statements and substantive recognition', () => {
  const m = populated(); m.baseline = baseline();
  const doc = { ...minimalPersona('Revised subject'), style: ['Careful'] };
  const claims = [claim('summary', doc.summary), claim('style', 'Careful')];
  assert.doesNotThrow(() => validateFormationReview(review(m, 'representation', doc, claims), m));
  assert.throws(() => validateFormationReview(review(m, 'initialize', doc, claims), m));
  assert.throws(() => validateFormationReview(review(m, 'substantive', doc, claims), m));
  m.sources.push({ id: 'recognition', identityId: m.identityId, kind: 'self_report', groupId: 'self', contextId: 'self', origin: 'synthetic', collectedAt: now - day, occurredAt: null, text: 'I recognize this change.' });
  const recognized = claims.map(c => ({ ...c, recognitionIds: ['recognition'] }));
  assert.doesNotThrow(() => validateFormationReview(review(m, 'substantive', doc, recognized), m));
  assert.throws(() => validateFormationReview(review(m, 'representation', m.baseline.document, []), m));
  assert.doesNotThrow(() => validateFormationReview(review(m, 'no_change'), m));
  assert.throws(() => validateFormationReview(review(m, 'no_change', doc), m));
});

test('frozen material and concrete review bind their contents and source references', () => {
  const m = populated(), doc = minimalPersona('Grounded identity'), claims = [claim('summary', doc.summary)];
  const r = review(m, 'initialize', doc, claims), prepared = prepareFormationReview(m, r);
  assert.equal(prepared.reviewDigest, digest(r)); assert.equal(prepared.receipt.inputDigest, digest(m));
  const edited = structuredClone(m); edited.sources[0].response += ' changed';
  assert.throws(() => validateFormationReview(r, edited));
  const editedReview = structuredClone(r); editedReview.rationale += ' changed';
  assert.notEqual(prepareFormationReview(m, editedReview).reviewDigest, prepared.reviewDigest);
  const bad = structuredClone(r); bad.claims[0].evidenceIds = ['s0', 'missing'];
  assert.throws(() => validateFormationReview(bad, m));
  const example = structuredClone(r); example.document.examples = [{ sourceId: 's0', situation: m.sources[0].prompt, response: 'fabricated', limits: 'limited' }];
  assert.throws(() => validateFormationReview(example, m));
});

test('invalid ownership, duplicates, chronology and policy fail closed', () => {
  const cases = [
    m => { m.sources[0].identityId = 'subject-b'; },
    m => { m.sources[1].id = m.sources[0].id; },
    m => { m.sources[1] = { ...m.sources[0], id: 'other', groupId: 'other' }; },
    m => { m.sources[0].kind = 'generated_test_output'; },
    m => { m.sources[0].collectedAt = m.asOf + 1; },
    m => { m.sources[0].occurredAt = m.sources[0].collectedAt + 1; },
    m => { m.policy.minimumEvents = 0; },
    m => { m.extra = true; },
    m => { m.baseline = { ...baseline(), documentDigest: '0'.repeat(64) }; },
  ];
  for (const mutate of cases) { const m = populated(); mutate(m); assert.throws(() => validateFormationMaterial(m)); }
});
