# Persona formation and environment comparisons

These source-only N6 reference tools extend the [offline continuity workflow](continuity-evaluation.md). They support a separate formation review for a new or changing subject and a frozen experiment across explicitly selected environments. They do not adopt a persona or prove real, long-term continuity. The [live confirmation and adoption contract](persona.md) remains authoritative.

## Formation without invented traits

A new subject can have a minimal identity definition and no established traits. The formation workflow accepts that state without weakening the N5 experiment's requirement for behavioral evidence and original examples.

```sh
node adapters/persona/cli.mjs assess adapters/persona/fixtures/empty.json /private/path/empty-assessment
node adapters/persona/cli.mjs assess adapters/persona/fixtures/longitudinal.json /private/path/timeline-assessment
node adapters/persona/cli.mjs prepare adapters/persona/fixtures/empty.json /private/path/minimal-review adapters/persona/fixtures/minimal-review.json
node adapters/persona/cli.mjs prepare adapters/persona/fixtures/longitudinal.json /private/path/change-review adapters/persona/fixtures/substantive-review.json
```

The material and review fixtures are authored synthetic examples. Their dates and dialogue are invented test inputs, not observed experiences or proof that a personality formed over time. Commands run locally, make no model or network request, and require new output directories. Private artifacts use owner-only permissions; console output contains status, counts, and digests rather than raw sources.

The `ziwo-formation-material-v1` format contains:

- Stable `identityId`, an operator-supplied minimal `identitySummary`, `synthetic`, and explicit scope/coverage/gaps.
- `asOf`, a fixed review time in Unix milliseconds. Occurrence time can be `null`; collection time never substitutes for elapsed experience.
- A `baseline` of `null` for initialization, or `{version, document, documentDigest}` for review of an existing version. This digest hashes the offline document, not the live service's version record.
- `sources` with explicit identity, kind, event group, context ID, origin, occurrence/collection times, and original prompt/response or report text. Supported kinds match N5: original history, current samples, summaries, self-reports, and outside observations. Generated experiment outputs are rejected as formation evidence.
- An explicit `policy`, optional `previousReview` receipt, and unresolved loading/context `diagnostics`.

The [validator](../adapters/persona/formation.mjs) rejects wrong ownership, unknown fields, duplicate IDs, impossible dates, obvious duplicated behavior counted as distinct events, and one event assigned multiple contexts or dates. Reports do not count as independent behavioral events. Provenance, context labels, semantic independence, and the truth of a self-report still require human review.

## Advisory review timing

The bundled pilot policy requires six independent behavioral events, three contexts, and a known occurrence-time span of fourteen days before suggesting a review. After a previous review it additionally requires three new event groups and a seven-day cooldown. These are configurable conservative test settings, **not validated maturity thresholds**. Changing them does not authorize evaluation or adoption.

| Status | Meaning |
| --- | --- |
| `diagnose_loading` | Resolve missing persona, wrong version, missing relationship context, conflicting instructions, unsuitable examples, or history loss first |
| `insufficient_evidence` | Preserve blanks and uncertainty; do not infer traits from praise, conflict, task instructions, or self-report alone |
| `baseline_changed` | Reconcile the last review receipt with the current persona version |
| `no_new_evidence` | Too few new original event groups since the last review |
| `cooldown` | New material exists, but the configured interval has not elapsed |
| `review_suggested` | An operator may start a separate, clean evaluation; this is not a finding of stable personality |

This is an explicitly invoked local check. It does not run each conversation turn, schedule background work, or generate a persona automatically. Normal memory can continue recording behavior that disagrees with the current persona. The current valid version remains unchanged.

Receipts record the reviewed event groups, time, base version, and frozen input digest. They are local cadence records supplied by the operator, not authenticated service receipts. Correcting an old event does not turn it into a new independent experience. A fresh live evaluation remains possible through the existing service; this optional workflow does not restrict that service.

## Review kinds and confirmation

A clean third-party evaluator can return `ziwo-formation-review-v1`, bound to the exact material digest, identity and baseline. `prepare` validates and packages that review with its own digest. It never calls an adoption endpoint.

| Kind | Required behavior |
| --- | --- |
| `initialize` | No baseline. The explicit minimal definition may retain empty traits/examples, even with no evidence |
| `representation` | Existing baseline, changed description, eligible evidence, and a reason for treating it as a correction of representation |
| `substantive` | Existing baseline, eligible evidence, and cited subject recognition for each proposed statement |
| `no_change` | No replacement document or trait claims |
| `loading_repair` | Recorded diagnostic, no replacement document or trait claims |

Non-minimal proposals require exactly one claim for every summary, principle, style, and boundary statement. Each claim records scope, behavioral evidence from at least two independent events, contrary evidence, and any recognition sources. Cited counterevidence requires an explicit discussion; examples must preserve exact original prompt/response pairs. An unresolved loading diagnostic prevents a persona-change proposal.

The checker cannot decide whether a phrase represents genuine growth, whether a citation semantically supports a claim, or whether a self-report recognizes that particular change. These remain review judgments. An evaluator must preserve contrary evidence and uncertainty rather than choose a label to bypass scrutiny.

Review output is an offline artifact, not a live N2 proposal. Source IDs need verified mapping to a fresh, authorized service evaluation. The user must then confirm the exact live proposal. Ordinary memory tools, local receipts, model assertions, or a successful assessment cannot approve it. The live service continues to reject stale bases and changed evidence and synchronize a confirmed same-subject revision on each conversation's next turn. A rollback is a newly confirmed version, never a rewrite of experiences or a binding from A to B.

## A frozen environment matrix

```sh
node adapters/continuity/cli.mjs plan adapters/continuity/synthetic-matrix.json adapters/codex/continuity/fixtures/synthetic.json adapters/continuity/synthetic-candidate.json
node adapters/continuity/cli.mjs run adapters/continuity/synthetic-matrix.json adapters/codex/continuity/fixtures/synthetic.json adapters/continuity/synthetic-candidate.json /private/path/matrix-01
```

The synthetic candidate is the fixed output from the N5 extraction pilot. It is retained as a candidate artifact and never promoted into the original evidence set. Both environments receive that identical candidate, corpus, A/B/C definitions, held-out situations, repeats, and order seed.

The bundled matrix selects `gpt-6.1-terra` and `gpt-6.2-sol` as generators on Codex App Server, with `low` effort. All judgments use fresh `gpt-6.1-terra` threads. There are 46 operations per environment: 36 generation turns, six compactions, and four blinded judgments. The plan uses 92 operations within a total cap of 96. It refuses an oversized plan before any model call and does not automatically retry an experiment. Operations are host requests, not token or monetary measurements.

Real corpora require interactive confirmation of their identity, scope, input digests, and environment plan. A caller-supplied synthetic flag is not proof of authorship. The CLI accepts no credential, endpoint, or executable in the environment JSON; it uses the existing Codex login and the reference host's isolation controls.

The frozen plan binds input and context hashes, trial order, generator, judge, effort and operation limits. Every environment result must match it. Threads verify model names at creation and, for compacted trials, resume. Individual backend builds are not exposed; this is not per-token or per-turn server-side model attestation. Known runtime metadata and unknown build/seed fields are recorded explicitly. They remain in adapter/test records rather than persona content.

The matrix preserves per-environment samples and judgments, paired B−A/C−B results, ordinal means, and matched-condition mean differences. These descriptive summaries do not establish statistical significance or a model ranking. The shared Terra judge, Terra-extracted candidate, short samples, fixed environment order and potentially recognizable output styles are confounders. Familiar-human ratings remain separate evidence.

## Harness extension boundary

Only `codex-app-server` has an installed runnable adapter here. An unsupported harness fails before model calls; changing a name in JSON cannot manufacture a second client.

The programmatic `runMatrix` factory is the extension point for a trusted future adapter. It must implement `open`, `run`, `close`, exact operation accounting, model/Harness receipts, identical frozen inputs, fresh isolated trials and evaluators, no inherited writable memory, observed compaction/resume, and private artifacts. Contract tests or mocked factories do not validate a real new harness. Adapter metadata is a trust boundary, not cryptographic attestation.

Real cross-Harness integration, real-subject continuity and long-term personality formation require their own scoped evidence. Short synthetic conversations and invented timelines leave those goals open. The separate [native Codex CLI workspace adapter](../adapters/codex/native/README.md) concerns live synchronization and code execution; it does not establish those continuity outcomes.

## Synthetic pilot, 2026-11-19

The matrix completed 92 operations: 72 generation turns, twelve observed compactions followed by resume, and eight fresh Terra judgments. An earlier initialization failure used zero model operations and was retained. The successful run kept the frozen input and scoring protocol unchanged; no persona was adopted.

| Generator | A continuity mean | B continuity mean | C continuity mean |
| --- | ---: | ---: | ---: |
| GPT-6.1 Terra | 4.25 | 4.75 | 4.75 |
| GPT-6.2 Sol | 4.50 | 4.50 | 5.00 |

Each cell has four samples. Terra's paired C−B differences included both −1 and +1; Sol's four B−A differences were all zero. Terra's task means were 4.75 throughout; Sol's were 5.00. Calibration means were 4.00/4.25/4.00 for Terra and 3.00/3.50/4.00 for Sol. Every narrow literal check passed (8/8 per group). These mixed dimensions do not support a model ranking or a stable continuity claim.

The earlier N5 pilot's negative B−A result remains part of the record. Different small-batch outcomes, synthetic references and the shared judge limit generalization. Formation commands separately verified empty-evidence handling and an authored 35-day timeline; that checks rules rather than actual personality development.
