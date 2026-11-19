# Activation and history backfill

The unreleased N3 service implements the initialization sequence: bind one identity, load and acknowledge its current persona, establish a write session without reading autobiographical memory, process the available pre-activation history, then retrieve relevant memory. It builds on [identity bindings](identity-bindings.md) and [persona adoption](persona.md). A real Codex adapter and reliable per-turn persona/memory synchronization remain N4 work.

## Authority and readiness

Every endpoint below requires a registered host credential. The request names its persistent `threadId`; the server resolves identity, memory route and data instance from the immutable binding. Model-supplied targets, ordinary memory tokens and evaluation credentials do not authorize initialization. Temporary agents remain unable to bind or inherit a subject.

Initialization records live beside the memory log so that a backfill write, source receipt and processing progress commit in one transaction. Directory retains the immutable conversation association. Binding responses derive `ready` and `canRun` from the initialization record and current persona validity, rather than trusting a cached Directory flag. Here `canRun` means the initialization gates pass; it does not prove that a client implements the future per-turn synchronization protocol.

A trusted host must establish real user activation, authenticate the source conversation, retrieve completed history, and actually load the supplied persona text before acknowledging it. The server checks credentials, versions, digests, instances, boundaries and persistent receipts. It cannot inspect a client's full context or prove that its history attestation is true. Never expose host credentials to the model; N4 must verify these adapter guarantees.

The existing fixed-token/OAuth MCP interface retains its legacy behavior and is not automatically routed through these new conversation gates.

## Begin without reading memory

First retrieve `GET /harness/v1/persona?threadId=…`. After loading that version, call `POST /harness/v1/activation/begin`:

```json
{
  "threadId": "conversation-1",
  "personaVersion": 1,
  "personaDigest": "<digest returned by persona loading>",
  "model": "model-name",
  "client": "client-name",
  "timezone": "UTC",
  "scope": {
    "boundaryId": "<original binding activationId>",
    "cutoff": { "turnId": "turn-2", "itemId": "item-2", "sequence": 1 },
    "coverage": "complete",
    "gaps": []
  }
}
```

`sequence` is the host's stable zero-based position within the fixed pre-activation history, not an occurrence timestamp or a transient page cursor. The cutoff identifies a completed, readable item. The host must not include an in-progress response or treat a failed/empty transient read as verified empty history.

A verified empty conversation uses `cutoff: null`, `coverage: "complete"`, and no gaps. Incomplete history uses `coverage: "partial"` and explicit gaps: `{id, from, to, reason}`. For a known cutoff, gaps are inclusive sequence ranges within it. Allowed reasons are `unavailable`, `truncated`, `summary_only`, `cursor_invalid`, and `unreadable`.

When all history is unavailable, use a null cutoff and null gap bounds. This is distinct from verified empty history. It permits an empty manifest and an incomplete-history notice, but **no history items can be accepted without a verified cutoff**.

A successful begin returns a persistent `sessionId` and state. It appends the session association without returning selves, preferences, core/recent memories or reflection prompts. Retrying the same initial configuration reuses that session; changing the original configuration fails. A stale persona acknowledgment blocks continuation without releasing the identity binding.

## Register and process the fixed manifest

`POST /harness/v1/activation/manifest` accepts:

```json
{
  "threadId": "conversation-1",
  "requestId": "page-1",
  "beforeBoundaryId": "<original activationId>",
  "offset": 0,
  "items": [{
    "itemId": "item-1",
    "turnId": "turn-1",
    "sequence": 0,
    "contentDigest": "<SHA-256 of the source material>",
    "material": "original",
    "status": "completed",
    "occurrence": { "precision": "unknown" }
  }],
  "final": false
}
```

Only references, material digests, ordering and occurrence metadata are stored, not copies of source transcripts. `material` is `original` or `summary`. `occurrence` is one of `{precision: "unknown"}`, `{precision: "day", date: "2026-03-14"}`, or `{precision: "instant", at: <Unix milliseconds>}`.

Pages may overlap if every overlapping entry is identical. Gaps in page offsets, changed source IDs/digests, duplicated positions of the same material type, or items after the cutoff fail. A final page must include the exact cutoff anchor and cover every position from zero through the cutoff with a source or declared gap. Summaries require partial coverage and cannot substitute for original experience.

Once sealed, `POST /harness/v1/activation/batch` accepts `{threadId, requestId, decisions}`. Each decision is either:

- `{itemId, action: "remember", memory: {gist, body, …}}`, using the existing memory text/importance fields. The service fixes the session, `source: "reconstructed"`, occurrence metadata and provenance; callers cannot override them or choose another subject.
- `{itemId, action: "skip", reason}`, where reason is `not_memorable`, `duplicate`, `summary_only`, or `irrelevant`.

A summary item must be skipped. Original material may also be skipped when it contains no worthwhile experience. A record is not required for every turn. An original recovered later may have its own item ID at the same sequence position as a summary, preserving their distinct provenance.

The immutable source receipt is keyed by host namespace, original source conversation and item ID. It binds material and processing decision. The write and receipt are atomic; a lost response, process/object reopen, or a new request ID cannot create the same experience twice. Changed decisions for an already-processed item conflict. Different source items do not collapse just because their memory text is identical. Erasing a resulting memory retains the receipt and cannot cause a retry to recreate its content.

## Finish, resume and fill gaps

`POST /harness/v1/activation/complete` takes `{threadId, requestId, resolveGaps?: [...]}`. It requires a sealed manifest, every available item processed, and a valid current persona acknowledgment. It does not require inventing unavailable history. A bounded gap can be resolved only when original material covers every position in that gap and has been processed.

Use `GET /harness/v1/activation?threadId=…` for phase, session, counts, current loading acknowledgment, fixed scope, remaining gaps, `historyIncomplete`, `noticePending` and `canRun`. No autobiographical content is returned. After displaying the incomplete-history notice, `POST …/notice` with `{threadId}` acknowledges it persistently, so a reconnect does not repeat the same warning.

`GET …/history?threadId=…&offset=0&limit=50` returns paginated source references and `pending`, `remembered` or `skipped` status, plus the resulting memory ID when applicable. A reconnect can reconstruct the pending work without fetching raw memory. Its response is metadata, not a new run authorization; use activation status for readiness.

`GET …/context?threadId=…` returns relevant memory only after initialization gates pass, using the existing session. It never starts another session. A persona revision or invalidation blocks this endpoint until the current valid persona is loaded and acknowledged with `POST …/persona` and `{threadId, personaVersion, personaDigest}`. Progress and session remain intact.

To process newly obtained material inside an already-known incomplete boundary, call `POST …/supplement` with `{threadId, requestId, beforeBoundaryId}`. This reopens the manifest while retaining existing items and receipts. Append references at the prior manifest length, seal, process and complete again. Its logical boundary and cutoff cannot be extended.

If the original partial scope had no cutoff, use the explicit `POST …/anchor` operation first. It takes `{threadId, requestId, beforeBoundaryId, cutoff, status: "completed", readable: true}` and can fill the missing cutoff only once. Existing unknown gaps become unresolved ranges from zero through that cutoff. It reopens processing without changing the original activation boundary. A fork can only adopt the cutoff already established by its root source conversation. Changed requests, retries after later progress, or a new request cannot move an existing cutoff. The trusted host must prove that the newly available anchor is before the original activation boundary; this truth cannot be inferred from an item ID by the service.

A reliable persistent fork omits `scope` in begin and inherits its parent's source scope and material references. It loads the current persona and gets its own write session, while source receipts are shared. Already-processed history is not written again; unfinished work remains resumable. An uninitialized parent must establish its scope first.

## Occurrence time and compatibility

Unknown occurrence time is distinct from the time the record was written. The projection stores `time_precision: "unknown"` and a zero occurrence sentinel; user-facing text says `unknown occurrence time`, never 1970 or the import day. Day-only records retain their civil date and display `(date only)` across client time zones. Instant records retain the known timestamp. Corrections, rebuilds and backups preserve this distinction. Existing historical records without precision fields keep their prior interpretation.

The legacy MCP `remember` tool now accepts `happened_at: "unknown"` with `source: "reconstructed"`; a date-only input records day precision. Date-filtered recall excludes unknown times by default, including an until-only search. `include_unknown_time: true` explicitly includes them alongside matching dated memories. The source snapshot used for persona evaluation exposes unknown `occurredAt` as null. Reflection cannot count unknown dates as invented distinct calendar days.

New stores start with log format 3 for legacy compatibility. The first precision/provenance write atomically upgrades the log to format 4. This build reads both; older builds refuse format 4 instead of silently dating an unknown event at write time. The derived schema is 13. A format-3 export containing these new event fields is rejected as an invalid downgrade.

## Backup and limits

Stores with initialization state export version 4. The protected header contains stable identity, adopted persona history and the initialization partition, including source receipts and request fingerprints. The chain seed is `SHA256("ziwo-export-v4\n" + goCompact(header))`. Earlier v1/v2/v3 backups remain readable with their existing semantics.

Restore validates ownership, source/receipt consistency, sessions, manifest boundaries and completion state in the same transaction as memory/persona restore. It preserves sessions and processing progress but creates a new data instance. Explicitly associate the bound conversation with that restored instance, then load and acknowledge its current persona; the old instance acknowledgment cannot authorize memory access. Host credentials themselves are not backed up. Integrity checks are not a signature proving the authenticity of a maliciously fabricated backup.

Limits are explicit: 256 KiB per request, 100 manifest items per page, 20 decisions per batch, 5,000 manifest items, and 1.5 MB of encoded initialization metadata per conversation. Requests exceeding limits fail rather than truncating history. Scale beyond these bounds and actual host history retention/fetch behavior remain separate validation work.
