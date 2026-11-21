import { digest } from '../codex/continuity/corpus.mjs';

export const formationFormat = 'ziwo-formation-material-v1';
export const reviewFormat = 'ziwo-formation-review-v1';
// Advisory pilot settings, not a validated measure of personality maturity.
export const pilotPolicy = Object.freeze({ minimumEvents: 6, minimumContexts: 3, minimumSpanDays: 14, minimumNewEvents: 3, cooldownDays: 7 });
const day = 86400000;
const behavior = new Set(['historical_original', 'current_sample']);
const kinds = new Set([...behavior, 'summary', 'self_report', 'observer_report']);
const faults = new Set(['missing_persona', 'wrong_version', 'missing_relationship', 'instruction_conflict', 'example_scope', 'history_loss']);
const fail = message => { throw new Error(message); };
const object = (v, name) => v && typeof v === 'object' && !Array.isArray(v) ? v : fail(`invalid ${name}`);
const text = (v, name, max = 12000) => typeof v === 'string' && v.trim() && v.length <= max ? v : fail(`invalid ${name}`);
const id = (v, name) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(v) ? v : fail(`invalid ${name}`);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : fail('invalid digest');
const array = (v, name, max = 500) => Array.isArray(v) && v.length <= max ? v : fail(`invalid ${name}`);
const fields = (v, keys, name) => { object(v, name); if (Object.keys(v).some(k => !keys.includes(k))) fail(`unknown ${name} field`); };
const time = (v, name) => Number.isSafeInteger(v) && v > 0 ? v : fail(`invalid ${name}`);
const integer = (v, name, min, max) => Number.isSafeInteger(v) && v >= min && v <= max ? v : fail(`invalid ${name}`);
const normalized = s => s.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
function similar(a, b) {
  a = normalized(a); b = normalized(b); if (a === b) return true;
  const parts = s => new Set(Array.from({ length: Math.max(0, s.length - 3) }, (_, i) => s.slice(i, i + 4)));
  const x = parts(a), y = parts(b);
  return x.size >= 12 && y.size >= 12 && [...x].filter(s => y.has(s)).length / Math.max(x.size, y.size) >= 0.85;
}
function document(raw) {
  fields(raw, ['summary', 'principles', 'style', 'boundaries', 'examples'], 'document');
  text(raw.summary, 'summary', 2000);
  for (const key of ['principles', 'style', 'boundaries']) array(raw[key], key, 20).forEach(v => text(v, key, 2000));
  for (const e of array(raw.examples, 'examples', 10)) {
    fields(e, ['sourceId', 'situation', 'response', 'limits'], 'example'); id(e.sourceId, 'example.sourceId');
    text(e.situation, 'situation'); text(e.response, 'response'); text(e.limits, 'limits', 2000);
  }
  return raw;
}
export function minimalPersona(identitySummary) {
  return { summary: text(identitySummary, 'identitySummary', 2000), principles: [], style: [], boundaries: [], examples: [] };
}

export function validateFormationMaterial(raw) {
  const m = structuredClone(object(raw, 'material'));
  fields(m, ['format', 'identityId', 'identitySummary', 'synthetic', 'scope', 'asOf', 'baseline', 'policy', 'sources', 'previousReview', 'diagnostics'], 'material');
  if (m.format !== formationFormat || typeof m.synthetic !== 'boolean') fail('unsupported formation format');
  id(m.identityId, 'identityId'); text(m.identitySummary, 'identitySummary', 2000); time(m.asOf, 'asOf');
  fields(m.scope, ['id', 'description', 'coverage', 'gaps'], 'scope'); id(m.scope.id, 'scope.id'); text(m.scope.description, 'scope.description');
  if (!['complete', 'partial'].includes(m.scope.coverage)) fail('invalid coverage');
  array(m.scope.gaps, 'gaps', 100).forEach(v => text(v, 'gap'));
  if ((m.scope.coverage === 'complete') !== (m.scope.gaps.length === 0)) fail('coverage and gaps disagree');
  fields(m.policy, Object.keys(pilotPolicy), 'policy');
  integer(m.policy.minimumEvents, 'minimumEvents', 2, 500); integer(m.policy.minimumContexts, 'minimumContexts', 2, 100);
  integer(m.policy.minimumSpanDays, 'minimumSpanDays', 1, 3650); integer(m.policy.minimumNewEvents, 'minimumNewEvents', 1, 500);
  integer(m.policy.cooldownDays, 'cooldownDays', 1, 3650);
  if (m.baseline !== null) {
    fields(m.baseline, ['version', 'document', 'documentDigest'], 'baseline'); integer(m.baseline.version, 'baseline.version', 1, Number.MAX_SAFE_INTEGER);
    document(m.baseline.document); hash(m.baseline.documentDigest);
    if (digest(m.baseline.document) !== m.baseline.documentDigest) fail('baseline document digest differs');
  }
  const ids = new Set(), events = new Map(), originals = [];
  for (const s of array(m.sources, 'sources')) {
    fields(s, ['id', 'identityId', 'kind', 'groupId', 'contextId', 'origin', 'collectedAt', 'occurredAt', 'prompt', 'response', 'text', 'observer'], 'source');
    id(s.id, 'source.id'); if (ids.has(s.id)) fail('duplicate source id'); ids.add(s.id);
    if (s.identityId !== m.identityId) fail('source identity differs');
    if (!kinds.has(s.kind)) fail('unsupported source kind; generated test output is not formation evidence');
    id(s.groupId, 'groupId'); id(s.contextId, 'contextId'); text(s.origin, 'origin', 2000); time(s.collectedAt, 'collectedAt');
    if (s.collectedAt > m.asOf) fail('collection is after the frozen review time');
    if (s.occurredAt !== null && time(s.occurredAt, 'occurredAt') > s.collectedAt) fail('occurrence is after collection');
    if (behavior.has(s.kind)) {
      text(s.prompt, 'prompt'); text(s.response, 'response');
      if (s.text !== undefined || s.observer !== undefined) fail('original behavior requires prompt and response only');
      const group = events.get(s.groupId);
      if (group && (group.contextId !== s.contextId || group.occurredAt !== s.occurredAt)) fail('one event cannot inflate contexts or dates');
      events.set(s.groupId, s);
      for (const prior of originals) if (prior.groupId !== s.groupId && similar(prior.prompt + '\n' + prior.response, s.prompt + '\n' + s.response)) fail('duplicate behavior cannot count as independent events');
      originals.push(s);
    } else {
      text(s.text, 'text'); if (s.prompt !== undefined || s.response !== undefined) fail('reports are not original quotations');
      if (s.kind === 'observer_report') text(s.observer, 'observer', 2000);
    }
  }
  if (m.previousReview !== null) {
    fields(m.previousReview, ['identityId', 'at', 'inputDigest', 'baseVersion', 'behaviorGroups'], 'previousReview');
    if (m.previousReview.identityId !== m.identityId) fail('review receipt belongs to another identity');
    if (time(m.previousReview.at, 'previousReview.at') > m.asOf) fail('review receipt is from the future');
    hash(m.previousReview.inputDigest);
    if (m.previousReview.baseVersion !== null) integer(m.previousReview.baseVersion, 'previousReview.baseVersion', 1, Number.MAX_SAFE_INTEGER);
    const groups = array(m.previousReview.behaviorGroups, 'previousReview.behaviorGroups'); groups.forEach(v => id(v, 'review group'));
    if (new Set(groups).size !== groups.length) fail('duplicate reviewed event group');
  }
  for (const d of array(m.diagnostics, 'diagnostics', 30)) {
    fields(d, ['kind', 'detail'], 'diagnostic'); if (!faults.has(d.kind)) fail('unknown diagnostic'); text(d.detail, 'diagnostic detail', 2000);
  }
  if (JSON.stringify(m).length > 500000) fail('formation input exceeds the reference limit');
  return m;
}

export function assessFormation(raw) {
  const m = validateFormationMaterial(raw), originals = m.sources.filter(s => behavior.has(s.kind));
  const groups = new Set(originals.map(s => s.groupId));
  const contexts = new Set(originals.map(s => s.contextId));
  const known = originals.filter(s => s.occurredAt !== null).map(s => s.occurredAt);
  const spanDays = known.length ? (Math.max(...known) - Math.min(...known)) / day : null;
  const fresh = [...groups].filter(g => !m.previousReview?.behaviorGroups.includes(g));
  const reasons = [];
  if (groups.size < m.policy.minimumEvents) reasons.push('too_few_independent_events');
  if (contexts.size < m.policy.minimumContexts) reasons.push('too_few_contexts');
  if (spanDays === null || spanDays < m.policy.minimumSpanDays) reasons.push('insufficient_known_time_span');
  let status;
  if (m.diagnostics.length) status = 'diagnose_loading';
  else if (reasons.length) status = 'insufficient_evidence';
  else if (m.previousReview && m.previousReview.baseVersion !== (m.baseline?.version ?? null)) status = 'baseline_changed';
  else if (m.previousReview && fresh.length < m.policy.minimumNewEvents) status = 'no_new_evidence';
  else if (m.previousReview && m.asOf - m.previousReview.at < m.policy.cooldownDays * day) status = 'cooldown';
  else status = 'review_suggested';
  return { format: 'ziwo-formation-assessment-v1', identityId: m.identityId, inputDigest: digest(m), baseVersion: m.baseline?.version ?? null,
    status, reasons, evidence: { events: groups.size, contexts: contexts.size, knownTimeSpanDays: spanDays, unknownTimeEvents: new Set(originals.filter(s => s.occurredAt === null).map(s => s.groupId)).size, newEvents: fresh.length },
    policy: m.policy, minimalInitialization: m.baseline === null ? minimalPersona(m.identitySummary) : null,
    automaticEvaluation: false, automaticAdoption: false,
    limitations: ['Advisory pilot thresholds do not establish stable personality or authorize a revision.', 'Event ownership, context labels and provenance require operator review; duplicate detection is approximate.', 'Unknown occurrence time never becomes elapsed experience; reports alone do not establish behavioral stability.'] };
}

export function validateFormationReview(raw, material) {
  const m = validateFormationMaterial(material), a = assessFormation(m), r = structuredClone(object(raw, 'review'));
  fields(r, ['format', 'identityId', 'inputDigest', 'baseVersion', 'changeKind', 'rationale', 'document', 'claims', 'counterexamples', 'uncertainty'], 'review');
  if (r.format !== reviewFormat || r.identityId !== m.identityId || r.inputDigest !== digest(m) || r.baseVersion !== (m.baseline?.version ?? null)) fail('review does not match the frozen identity and base');
  if (!['initialize', 'representation', 'substantive', 'no_change', 'loading_repair'].includes(r.changeKind)) fail('unknown change kind');
  text(r.rationale, 'rationale', 4000); array(r.counterexamples, 'counterexamples', 30).forEach(x => text(x, 'counterexample', 2000));
  array(r.uncertainty, 'uncertainty', 30).forEach(x => text(x, 'uncertainty', 2000)); array(r.claims, 'claims', 100);
  if (r.changeKind === 'no_change' || r.changeKind === 'loading_repair') {
    if (r.document !== null || r.claims.length) fail('diagnosis or no-change review cannot replace a persona');
    if (r.changeKind === 'loading_repair' && !m.diagnostics.length) fail('loading repair requires a recorded diagnostic');
    return r;
  }
  if (m.diagnostics.length) fail('diagnose loading before proposing personality changes');
  if ((r.changeKind === 'initialize') !== (m.baseline === null)) fail('initialization and revision have different base requirements');
  document(r.document);
  const minimal = r.changeKind === 'initialize' && digest(r.document) === digest(minimalPersona(m.identitySummary));
  if (minimal) {
    if (r.claims.length) fail('minimal initialization cannot invent traits');
    return r;
  }
  if (a.status !== 'review_suggested') fail('formation evidence is not ready for this optional review');
  if (m.baseline && digest(r.document) === m.baseline.documentDigest) fail('unchanged content must use no_change');
  const sources = new Map(m.sources.map(s => [s.id, s]));
  const statements = [{ section: 'summary', text: r.document.summary }, ...['principles', 'style', 'boundaries'].flatMap(section => r.document[section].map(text => ({ section, text })))];
  for (const claim of r.claims) {
    fields(claim, ['section', 'text', 'evidenceIds', 'counterEvidenceIds', 'recognitionIds', 'scope'], 'claim');
    if (!statements.some(s => s.section === claim.section && s.text === claim.text)) fail('claim does not map to the proposed document');
    text(claim.scope, 'claim.scope', 2000);
    for (const key of ['evidenceIds', 'counterEvidenceIds', 'recognitionIds']) {
      array(claim[key], key, 50);
      if (claim[key].some(id => !sources.has(id))) fail('claim cites unknown evidence');
    }
    const events = new Set(claim.evidenceIds.map(id => sources.get(id)).filter(s => behavior.has(s.kind)).map(s => s.groupId));
    if (events.size < 2) fail('each proposed trait needs behavior from two independent events');
    if (claim.recognitionIds.some(id => sources.get(id).kind !== 'self_report')) fail('subject recognition must cite a self-report');
    if (r.changeKind === 'substantive' && !claim.recognitionIds.length) fail('substantive change requires cited subject recognition');
    if (claim.counterEvidenceIds.length && !r.counterexamples.length) fail('counterevidence requires an explicit discussion');
  }
  for (const s of statements) if (r.claims.filter(c => c.section === s.section && c.text === s.text).length !== 1) fail('each statement requires exactly one grounded claim');
  for (const e of r.document.examples) {
    const s = sources.get(e.sourceId);
    if (!s || !behavior.has(s.kind) || e.situation !== s.prompt || e.response !== s.response) fail('examples must preserve exact original behavior');
  }
  return r;
}

export function reviewReceipt(material) {
  const m = validateFormationMaterial(material);
  return { identityId: m.identityId, at: m.asOf, inputDigest: digest(m), baseVersion: m.baseline?.version ?? null,
    behaviorGroups: [...new Set(m.sources.filter(s => behavior.has(s.kind)).map(s => s.groupId))].sort() };
}

export function prepareFormationReview(material, review) {
  const r = validateFormationReview(review, material);
  return { review: r, reviewDigest: digest(r), receipt: reviewReceipt(material), requiresConcreteUserConfirmation: r.document !== null,
    adoptionAuthorized: false, liveProposal: false,
    note: 'Offline review only. Source IDs need verified mapping to a fresh live evaluation; no network or adoption operation is performed.' };
}
