# Persona extraction and continuity evaluation

This unreleased reference workflow uses Codex App Server to extract a traceable candidate from an explicitly selected corpus and compare it in isolated offline conversations. It does not connect to a Ziwo endpoint, write memories, bind an identity, confirm a proposal, or adopt a persona. The [normal activation contract](activation.md) remains unchanged.

The bundled fixture is entirely authored synthetic dialogue. It is useful for exercising provenance checks and measurement, but is not observed behavior of a real subject. Its scores cannot establish real-persona continuity.

For evidence-limited new subjects and a frozen cross-model comparison, see [formation and environment comparisons](persona-evolution.md). Those separate tools keep the evidence requirements of this A/B/C workflow intact.

## Workflow

1. Select one stable identity and an authorized material scope. Preserve existing natural behavior before collecting a long self-description. Do not scan unrelated chats or infer ownership from a name.
2. Prepare a corpus with explicit source kinds, original event groups, collection times, unknown occurrence times, coverage gaps, and an extraction/holdout split. Freeze the holdout situations and scoring criteria before extracting the candidate.
3. A fresh third-party evaluator sees only extraction sources. It returns a compact candidate whose statements cite evidence, contrary evidence, scope, and uncertainty. It never activates as the target.
4. Validate the candidate mechanically. Review its meaning separately: references existing in the file do not prove that they support a claim.
5. Run new conversations for the three fixed conditions below, using the same model, task inputs, and necessary facts. Repeat across fresh conversations, include task changes, and reload the same fixed context after observed compaction and resume.
6. New evaluators score anonymous outputs against held-out reference behavior. Preserve negative results, failures, paired differences, and limitations. Human familiarity judgments remain a separate signal.

| Condition | Input |
| --- | --- |
| A | Common relevant memory facts |
| B | The same facts plus persona description, without examples |
| C | The same facts and description plus exact original examples |

Condition A is an offline experimental control. It is not an exception allowing a real bound conversation to run without its persona.

## Commands

Use the existing Codex login and the prerequisites of the [reference host](../adapters/codex/README.md). No API key or Ziwo credential is passed to the experiment. The default model is `gpt-6.1-terra`.

```sh
node adapters/codex/continuity/cli.mjs validate adapters/codex/continuity/fixtures/synthetic.json
node adapters/codex/continuity/cli.mjs extract adapters/codex/continuity/fixtures/synthetic.json /private/path/extraction-01
node adapters/codex/continuity/cli.mjs run adapters/codex/continuity/fixtures/synthetic.json /private/path/run-01 /private/path/extraction-01/candidate.json
```

Output directories must be new. Existing artifacts are never overwritten. The default extraction permits at most two model turns; the bundled comparison plans 46 operations: 36 generation turns, six compactions, and four blind judgments. The runner caps operations at 60 and rejects a plan exceeding the remaining budget. An operation is a host turn or compaction request, not a measured token count, internal model-request count, or currency budget. There is no automatic whole-experiment retry.

For a corpus marked as real, the command requires an interactive operator to confirm the identity, scope, and exact corpus digest before sending material to Codex. This does not authorize persona adoption. The caller remains responsible for provenance and lawful access; a JSON flag is not independent proof of ownership. The workflow never fetches the paths or URLs named in source references.

## Corpus contract

See the complete [synthetic example](../adapters/codex/continuity/fixtures/synthetic.json) and [validator](../adapters/codex/continuity/corpus.mjs). The format is `ziwo-continuity-corpus-v1`.

- `identityId`, `synthetic`, `scope`, and `behaviorFrozenAt` describe the selected material. Partial coverage requires explicit gaps.
- Each source has an ID, the same identity, an original event group, an origin reference, a collection timestamp, an occurrence timestamp or `null`, context, and its split.
- `historical_original` and `current_sample` preserve the actual `prompt` and `response`. Their collection must precede the behavior freeze.
- `summary`, `self_report`, and `observer_report` contain `text`; they cannot masquerade as original dialogue. An outside report identifies its observer. Self-reports must be collected after behavior is frozen.
- Generated experimental output is not an accepted source kind. Keep it in run artifacts, never feed it back as independent original evidence.
- Common memory facts cite extraction sources only. Cases cite holdout sources only and define their prompts, rubric, optional pre-final-turn compaction, and narrow literal task checks.

One original event group cannot cross the split. Duplicate and near-duplicate checks reject obvious leakage and inflated independence. These checks use normalized character overlap; they do not prove that all semantic duplicates have been found or that an origin label is authentic. Dataset preparation still needs review.

The reference limits are 500 sources, 20 cases, 10 turns per case, and 500,000 serialized characters. It fails explicitly on larger input rather than silently truncating evidence.

## Candidate and loading contract

`ziwo-continuity-candidate-v1` fixes the identity and corpus digest. Every summary, principle, style statement, and boundary has exactly one claim with matching text, evidence IDs, counter-evidence IDs, scope, and a `supported` or `tentative` designation. A supported claim requires behavior from at least two distinct event groups. Repeated summaries or self-reports cannot supply that independence.

Examples must quote exact extraction prompt/response pairs and state their limits. Summaries cannot supply fabricated original quotations. A/B/C planning requires at least one example. The context representation is versioned and hashed; the same condition is reattached on every turn, including after compaction/resume.

This offline candidate is not a live N2 proposal or approval. Its source IDs may be local corpus IDs rather than server memory IDs. Do not post it blindly to an adoption endpoint or insert dialogue into autobiography merely to make its references pass validation. Once a real case is selected, its sources must be mapped through an authorized, verifiable evaluation path; concrete adoption still follows [persona review and confirmation](persona.md).

## Artifacts and interpretation

Artifacts use owner-only filesystem permissions. Extraction stores its input digest, candidate, and failed attempts. A run stores a private frozen plan/condition key, actual available model/Harness metadata, implementation hash, per-trial context hashes and responses, compaction observations, blind packets and judgments, and a content-free aggregate summary. The console prints progress and aggregate results, not raw source memories.

Blinded packets exclude condition labels, loading content, and the extracted candidate. The output style may still reveal a condition. The default generator and judge use the same model, so agreement is not independent human validation. The underlying model build and sampling seed are recorded as unknown when the interface does not provide them.

The six rating dimensions are continuity, task performance, calibration, relationship appropriateness, over-imitation, and bias. Higher is better for the first four; higher means more risk for the last two. Ratings are ordinal integers from 1 to 5. Means and B−A/C−B differences are descriptive pilot summaries, without a universal pass threshold or statistical significance claim. Literal string checks are deliberately narrow and do not measure complete task competence.

Tool attempts, model mismatches, missing compaction evidence, incomplete replies, malformed judgments, and exhausted budgets fail the run. Partial artifacts remain available for diagnosis, but no success summary is produced. Keep experiments that fail alongside later fixes rather than selecting only successful runs.

Downloaded material and external model contexts cannot be remotely erased by Ziwo. Keep real corpora and private experiment artifacts outside public repositories, track their digests and allowed scope, and invalidate/re-run derived assessments when authorized source material changes. There is no background synchronization of these offline files with a live subject.

## Synthetic pilot, 2026-11-19

The bundled fixture was exercised with `gpt-6.1-terra` through Codex Desktop 0.170.0, with `low` effort. Extraction used one operation and comparison used the planned 46. Each condition had four samples: two cases, each repeated twice. All six planned compactions were observed before resuming. The candidate was not adopted.

| Condition | Continuity mean | Task mean | Narrow literal checks |
| --- | ---: | ---: | ---: |
| A | 4.50 | 5.00 | 8/8 |
| B | 4.00 | 4.75 | 8/8 |
| C | 4.75 | 5.00 | 8/8 |

Paired continuity differences were −2, 0, −1, +1 for B−A and +1, +1, +1, 0 for C−B. Persona description alone did not consistently improve on the memory-only control. Examples scored better in this small batch, but the synthetic references, short sequences, same-model judging, and possible condition recognition prevent a stable-effect or real-persona claim. No human familiarity rating was collected. Low imitation/bias risk scores do not establish the absence of those risks.

One initial App Server startup failure consumed no model operations; its record was explicitly reconstructed from the process output. The successful run preserved the original fixture and scoring rules. Startup failure recording and failed-process cleanup were hardened afterward; the measured implementation hash remains separate from the final code hash. Real-subject evaluation is deferred until an identity, source material, and allowed scope are specified.
