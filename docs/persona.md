# Persona initialization and revision

This describes the persona service in the 0.3.0 preview source; see the [preview guide](preview-release.md). It separates adopted persona data from autobiographical memory and provides scoped evaluation, exact-proposal confirmation, atomic adoption, and current-version loading. The [activation service](activation.md) supplies gated history backfill and initialization readiness. [Per-turn synchronization](turn-sync.md), the optional [conversation reference client](../adapters/codex/README.md), and a [native Codex CLI workspace gateway](../adapters/codex/native/README.md) are implemented. Desktop integration remains separate work. [Offline formation reviews](persona-evolution.md) complement this service without granting adoption authority.

## Ownership and capabilities

An adopted persona belongs to the same stable identity as its memory partition. It is not a `self` memory. Existing `self` entries remain evidence; reading or importing them never creates an adopted persona. A new identity can be initialized with a minimal identity summary and empty trait/example lists, using the same explicit proposal and confirmation process.

| Credential | Operations |
| --- | --- |
| Registered host (`zwh_…`) | Reserve a fresh evaluation conversation, create a scoped evaluation, load the current persona of an existing binding |
| Evaluation (`zev_…`) | Read one fixed evaluation snapshot and submit proposals for that snapshot |
| Private user-facing admin channel | Review a specific proposal, record a concrete approve/reject decision, adopt an approved proposal |
| Existing fixed-token/OAuth memory connection | Memory operations and read-only confirmed persona/memory deltas; no persona confirmation or adoption |

## Portable evaluation with any MCP client

The user-facing administration tool can prepare a scoped evaluation without a harness-specific adapter:

```sh
node worker/bin/ziwo-admin.mjs persona-evaluate MEMORY REQUEST_ID --fresh
```

It uses the existing `ZIWO_URL` and `ZIWO_ADMIN_SECRET` environment settings, and prints a newly issued `mcpUrl` and `token` once. Reuse the request ID after a lost response to keep the original snapshot and rotate the token. Keep the token in client connection settings, never in a prompt. Open a fresh conversation without Ziwo persona, autobiographical memory, or inherited parent context, and connect only this scoped evaluation endpoint. The server can restrict its tools and credentials; ordinary MCP cannot independently prove that a client's conversation is fresh.

The endpoint `POST /evaluation/v1/MEMORY/EVALUATION_ID/mcp` supports both MCP generations and exposes:

- `read_evaluation`: page the fixed subject/evidence snapshot as third-party material, with no memory writes or reinforcement.
- `propose_persona`: submit a bounded proposal, evidence references, rationale, counterexamples, and uncertainty. Repeating the same proposal is idempotent.

After the evaluator supplies a proposal ID, the user reviews and decides on its exact digest:

```sh
node worker/bin/ziwo-admin.mjs persona-review MEMORY PROPOSAL_ID
node worker/bin/ziwo-admin.mjs persona-approve MEMORY PROPOSAL_ID REVIEWED_DIGEST
# Or reject the reviewed proposal:
node worker/bin/ziwo-admin.mjs persona-reject MEMORY PROPOSAL_ID REVIEWED_DIGEST
node worker/bin/ziwo-admin.mjs persona-revoke MEMORY EVALUATION_ID
```

`persona-approve` refuses a changed or stale digest, records the specific user decision, and adopts that exact revision. A retry uses the same confirmation receipt. Evaluators and ordinary memory/OAuth credentials cannot call these private operations. Creating or revoking an evaluation also requires the private user channel. Administrative creation is `POST /admin/persona/MEMORY/evaluations` with `identityId`, `instance`, `requestId`, and `source:"fresh"`; revocation is `DELETE /admin/persona/MEMORY/evaluations/EVALUATION_ID`. Host-created evaluations can use the same MCP endpoint and continue to require a live host reservation.

Confirmed persona updates are available to ordinary MCP through [`sync_context`](mcp-capabilities.md#incremental-persona-and-memory-feed). This read-only interface does not itself establish persistent chat ownership or complete initial history processing.

## Registered host evaluation

A registered host must obtain the user's target selection and attest that the evaluator is a fresh, independent conversation without injected Ziwo persona or memory. The server rejects already-bound conversations, temporary/inherited sources, target changes, and subject binding/forking involving a registered evaluator. The role reservation is permanent within that host namespace and thread. A failed start can leave this conservative reservation in place; retry the same target or create a new clean conversation.

**Trust boundary:** the server authenticates the host, not the truth of an arbitrary client's context claims. `source: "fresh"` is meaningful only from a trusted adapter. Host and admin credentials must remain outside model context. The private confirmation channel must represent a real user decision on the displayed proposal; a model's `approved: true` or quoted approval is never accepted as authorization. The N4 reference client implements these user controls and isolation checks; each additional adapter must verify its own guarantees.

## Start and read an evaluation

A registered host calls `POST /harness/v1/evaluations`:

```json
{
  "threadId": "clean-evaluator-1",
  "requestId": "user-request-1",
  "memory": "example",
  "identityId": "zi_…",
  "instance": "i_…",
  "source": "fresh"
}
```

The response supplies `evaluationId`, a one-task `token`, `baseVersion` (null before initialization), `upperSeq`, and `total`. Store the token in the tool adapter, not in prompts or reports. Retrying the same host/thread/request keeps the original snapshot and rotates its token; the old token stops working. A different target cannot reuse that request or conversation. Revoking the host also disables its evaluation access.

Use the evaluation token for:

- `GET /evaluation/v1/<memory>/<evaluationId>?offset=0&limit=50` (limit 1–100).
- `POST /evaluation/v1/<memory>/<evaluationId>/proposals`.

The snapshot fixes the current persona base and ordered memory IDs/material fingerprints at one event upper bound. New memories do not enlarge it. Every read checks the material fingerprint, including content and standing, before returning data. A changed/deleted source requires a fresh evaluation. Recall counts, decay strength and ordinary session activity do not change material fingerprints.

The response separates the base persona from memory items, with their IDs, kind, source, recorded times, standing and content. It returns `nextOffset: null` at completion. Legacy recorded occurrence dates are returned as stored. N3 records explicit precision; unknown occurrence time returns null and day-only records retain their civil date. Snapshots exceeding 5,000 memories are rejected explicitly, never silently truncated. The snapshot holds references and fingerprints, not duplicate memory bodies. These reads do not create autobiographical sessions, append experiences, or reinforce recalled memories.

## Propose, review, confirm, adopt

A proposal contains the full intended document and review context:

```json
{
  "document": {
    "summary": "A minimal identity description",
    "principles": [],
    "style": [],
    "boundaries": [],
    "examples": []
  },
  "rationale": "Why this definition is appropriate",
  "changeSummary": "Initialize the identity without inferred traits",
  "counterexamples": [],
  "uncertainty": [],
  "evidenceIds": []
}
```

Each example, if present, has `situation`, `response`, `limits`, and `evidenceIds`. Evidence IDs must belong to this snapshot. Examples should express representative behavior with context and limits; do not copy entire source transcripts. The request limit is 64 KiB. The service returns an immutable `proposalId` and `digest`. The digest binds the evaluation, identity, instance, base version, complete proposed content, explanations, and source fingerprints. Editing anything creates a different proposal and needs a new confirmation.

The user-facing channel retrieves `GET /admin/persona/<memory>/proposals/<proposalId>` using admin authentication. It returns `before`, the proposed `document`, explanations, evidence IDs/count, state, base/current versions, and staleness. Compare the full `document` with `before`; the evaluator's change summary can omit or misdescribe edits. Confirm the exact reviewed document and digest, not the summary alone. It does not automatically return raw memory content. Model-written proposal text can itself contain quotations; the adapter must constrain/review those before display. This API is not a raw-memory browsing UI.

After the user reviews the exact proposal, the private channel calls `POST …/confirm`:

```json
{
  "identityId": "zi_…",
  "instance": "i_…",
  "digest": "<exact proposal digest>",
  "confirmationId": "user-decision-1",
  "decision": "approve"
}
```

`decision` can also be `reject`. Confirmation IDs are persistent receipts; reuse with different arguments fails. Unknown properties, including `approved`, are rejected. An evaluation or host token cannot use this endpoint.

`POST …/adopt` accepts only `identityId`, `instance`, and `digest`. It checks the specific approval, material validity and unchanged base version, then atomically writes the next adopted version, current pointer and proposal receipt. Competing proposals based on the same version cannot both apply. Failure leaves the prior current version intact. A successful retry returns its original `adoptedVersion` and the latest `currentVersion`, without rolling back later work. Rollback of persona content is a new reviewed proposal based on the current version, never a pointer rewind.

## Loading and invalidation

`GET /harness/v1/persona?threadId=<bound-thread>` uses the registered host credential and the original binding. It returns the current `identityId`, data `instance`, `version`, `digest`, `document` and stored `loadText`. The same adopted version yields the same loading text, including after a verified restore. Missing, damaged, wrong-owner or invalid-evidence personas fail explicitly; there is no default persona fallback.

Two conversations bound to identity A receive A's newly adopted version on their next load. They remain bound to A, and A→B attempts still fail. The [synchronization service](turn-sync.md) and reference client check persona **and memory** before each user turn, load persona first, then memory, and only then respond. This endpoint remains available for initialization and explicit current-version loading.

Every snapshot input is conservatively treated as a dependency, even if the model cites only a subset. A valid base persona's source dependencies also propagate to revisions. Erasing a source, including cascaded erasure, atomically invalidates affected evaluations and proposals, revokes their tokens, and removes derived proposal documents and adopted loading text from all affected versions. Minimal IDs, fingerprints, digests and decision receipts remain for audit. Current loading then requires a newly confirmed repair; it does not fall back to an older version. Ordinary material changes also fail validity checks. Previously downloaded backups and already-delivered client context cannot be remotely erased.

## Backup version 3

A store with adopted persona history and no activation records exports v3. Stores with initialization records use [v4](activation.md#backup-and-limits), which also preserves backfill progress. Its header includes the stable identity and a `persona` bundle: owner, current version and sequential adopted versions, fixed loading text, digests and source references. Invalidated versions retain no document or loading text. Draft proposals, evaluation tokens, and executable confirmations are omitted. The chain begins with:

```text
SHA256("ziwo-export-v3\n" + goCompact(header))
```

Restore preserves the stable identity and persona history while creating a new data instance. It checks ownership, sequence/base versions, document/load-text integrity and source fingerprints against the restored memory partition, in the same transaction. Mixing persona A with memory B fails even if the outer chain was recomputed. This is integrity/consistency checking, not a cryptographic signature proving backup authorship.

Without adopted persona history, the existing v1/v2 export behavior remains. Both formats remain readable and import as persona-uninitialized. Older builds cannot read v3; never strip the persona or change the format number to make a downgrade appear compatible. The encrypted backup envelope is unchanged. Explicitly associate bound conversations with the restored instance before loading it.
