# Bound turn synchronization

Development API, not part of the released v0.2.0 service. It builds on [identity bindings](identity-bindings.md), [persona approval](persona.md), and [activation](activation.md).

Each user turn checks the bound identity's current adopted persona and committed memory changes together. The host loads the persona first, then the changes, before presenting a response. A persona revision never changes the identity binding. A revision adopted during a running turn is picked up next turn; it does not interrupt that turn's normal memory writes.

## Trust and lifecycle

All routes require the registered `zwh_` host credential. Keep it outside model context, tool arguments, child process environments, and diagnostic logs. The host supplies the authoritative persistent thread; model-supplied `_meta`, session IDs, and activation claims are not authority. A host credential is a trusted integration boundary, not proof of a human action on its own.

1. `GET /harness/v1/sync?threadId=...` returns the committed cursor, current event upper bound, and persona version/digest. It creates no session, event, recall reinforcement, or cursor advance.
2. `POST /harness/v1/sync/begin` with `{threadId, turnId, requestId, reload?}` captures a fixed upper bound and current persona. It returns `{snapshotId, from, upper, cursor, persona, acknowledged}`. The server owns the cursor. A new request makes any previous turn snapshot inactive. An exact retry reuses its active snapshot. Reusing an old, superseded request fails.
3. `GET /harness/v1/sync/page?threadId=...&snapshotId=...&after=...` scans at most 50 committed events. Start at `from`; follow `next` until `upper`. Even an empty range has one page. Each page contains `{after, next, upper, changes, digest}`. Sequential pages and exact retries are accepted; skips and out-of-range cursors fail.
4. Load `persona.loadText`, then the ordered changes into the actual host turn. Only after the host accepts the context, send `POST /harness/v1/sync/ack` with `{threadId, snapshotId, personaVersion, personaDigest, pages:[{after,next,digest}]}`. The exact complete receipt advances the cursor atomically and opens the bound tool channel. The host must suppress output and interrupt its own failed load if acknowledgment fails.
5. Route model memory requests through `POST /harness/v1/tools`. Close the turn with `POST /harness/v1/sync/end` `{threadId,snapshotId}`.

`canRun` in older activation/binding responses describes initialization readiness only. It is not a per-turn grant. Only the active, acknowledged synchronization snapshot permits the new tool channel.

## Change semantics

Event sequence, not occurrence date, defines the cursor. The stream includes remember/correction/backfill, amend/preferences/retraction, erase, reflect, and restore. Session and recall/expand bookkeeping can move the scanned sequence without creating a memory change. An empty `changes` array is therefore valid.

Remember changes include the immutable memory gist and source/time precision, never the body. Erased content is omitted. Corrections have new IDs and refer to what they correct; reflection reports its written/passed IDs. Use bound `expand` or `recall` for relevant details; those ordinary reads retain their existing reinforcement behavior. Change inspection itself does not reinforce anything. Do not re-remember synchronized records as new experiences.

New events after `upper` remain for the next turn. A successful write never advances the reader's cursor, so another session's concurrent write cannot be skipped. Persona changes or erasure before acknowledgment invalidate the pending snapshot; start a fresh request. Already loaded turns can finish. Remote erasure cannot remove text already delivered to an external model or downloaded backup.

Snapshot state stores sequence numbers, version references, and digests, not copies of memory or persona text. It survives ordinary Durable Object eviction. Runtime snapshots and cursors are deliberately excluded from backups: a restored instance starts at zero after explicit same-identity reassociation. Persistent forks also reload from zero. Set `reload:true` after host restart, context compaction, or uncertain delivery so the current persona and memory summaries can be reconstructed without re-creating experiences.

## Bound tools

`GET /harness/v1/tools?threadId=...` returns schemas for `remember`, `recall`, `expand`, `amend`, `erase`, `reflect`, and `check`. There is no activation, confirmation, adoption, target-selection, or `get_context` tool.

The call body is `{threadId,snapshotId,requestId,tool,arguments}`. Arguments use the existing MCP field names with `session_id` removed. The service injects the activation's existing session and rejects unknown fields and caller-selected sessions or targets. Unbound/evaluator/temporary threads have no capability. A new snapshot or end closes the old grant.

Tool request IDs are scoped to the binding and instance, across snapshots. A completed retry does not execute again; it returns a replay notice. Responses are not stored because they could contain subsequently erased text. If a lost read response is needed, explicitly issue a new read request. Reusing an ID for different arguments is rejected. Keep tool call IDs stable across network retries.

## Codex reference integration

See [the reference client](../adapters/codex/README.md). It is an explicit host implementation with a separate user control path. It does not install a desktop plugin or claim that a Skill/hook can enforce every turn in an arbitrary native Codex chat.

The optional [native CLI workspace gateway](../adapters/codex/native/README.md) uses the original terminal UI. Because built-in code tools can run as soon as generation starts, it persists the complete synchronization context and acknowledges it before `turn/start`. It fixes the workspace permission profile, rejects alternate generation/input paths, and creates clean assistance on a separate service. Its desktop integration and broader network/permission modes are outside the current scope.
