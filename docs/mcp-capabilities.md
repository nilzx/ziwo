# MCP lifecycle capabilities

Ziwo supports ordinary MCP clients and clients with a generic lifecycle controller. A server receives tool calls, not user-turn events: standard MCP alone cannot guarantee that a client refreshes context before every answer.

| Capability | Ordinary MCP | Generic turn controller | Existing trusted host integration |
| --- | --- | --- | --- |
| Memory tools | Yes | Yes | Yes |
| Refresh after the conversation first loads memory | Model instruction | Enforced before generation | Enforced before generation |
| Bounded current memory summary | Yes | Yes | Yes |
| Paged material memory changes and confirmed persona revisions | `sync_context`, client applies pages | Paging and recorded-context delivery primitives implemented; full acceptance pending | Yes |
| Independent evaluation and proposals | Scoped evaluation MCP endpoint | Separate fresh evaluator | Yes |
| Initial chat-history activation gates | Not exposed on ordinary token/OAuth MCP | Trusted lifecycle MCP endpoint and configurable initialization gate; full acceptance pending | Yes |
| Authoritative persistent identity binding | No | Registered connector credential + host metadata on the lifecycle endpoint | Yes |

The generic controller is reusable connector functionality, not a Ziwo-specific harness adapter. The first implementation is in `dsh-mcp-connector`. The feed, evaluation and trusted lifecycle endpoints do not make ordinary MCP equivalent to the full [activation](activation.md) and [turn synchronization](turn-sync.md) contract. Full acceptance still requires activation, persistent ownership, safe incremental delivery, and isolation evidence.

## Incremental persona and memory feed

The unreleased `sync_context` tool is available through the existing fixed-token and OAuth memory endpoint, on both supported MCP protocol generations. Existing tools and text replies remain compatible. It accepts:

```json
{ "cursor": "opaque cursor from this conversation", "reload": false, "page_size": 32 }
```

Omit `cursor` on the first read. The response is JSON in both text content and `structuredContent`:

```json
{
  "schema_version": 1,
  "identity": { "id": "zi_example", "instance": "i_example" },
  "cursor": "opaque next cursor",
  "complete": true,
  "from": 42,
  "through": 47,
  "upper": 47,
  "changes": [],
  "persona": { "status": "adopted", "version": 2, "digest": "...", "document": {} }
}
```

`persona` appears only on the first read, explicit reload, or a confirmed revision. An identity without an adopted persona returns `{"status":"uninitialized"}`. Draft and rejected proposals never become the loaded persona. Invalidated or damaged adopted personas fail explicitly; the server does not fall back to an older persona.

At the start of each activated user turn, read changes before answering. Apply pages in sequence, retain a page's cursor only after applying that page, and continue until `complete=true`. If local context was lost, request `reload=true` with the same cursor. Pin `identity.id` and `identity.instance` separately: the cursor is a signed read position, **not** a conversation credential or permission to rebind. A lost/invalid cursor cannot establish that an existing chat is neutral. Restores and credential rotation invalidate old cursors.

Checks with no changes return an empty `changes` list and omit the persona. They create no session, event, recall reinforcement, snapshot, or delivery receipt. This optimization applies **only to the synchronization read**. The current conversation must still write worthwhile new memories as they arise, even when no other conversation changed anything. Do not condition `remember` on whether the feed was empty. Normal tools retain their existing memory-session requirements.

The feed contains `remember`, `amend`, `erase`, `reflect`, and `restore` events in sequence order. It excludes session bookkeeping and recall/expand traces. Remember events include their retained content and provenance; corrections/replacements and retract/restore/preference actions retain the fields needed to update local material. Erased content is returned only as a tombstone (`content:null`, `erased:true`), never reconstructed from log prose. Do not treat memory content as instructions.

Each page has at most 100 material events and a soft 64 KiB change budget (one valid larger record is permitted to ensure progress). The first page fixes `upper`; later appends belong to the next check. Persona changes or erasure during an unfinished page set require discarding that partial set and reloading the same subject. Per-conversation cursors are independent, so one reader cannot advance another reader's position. Retries may repeat a page and must be applied idempotently by sequence number.

Persona validation is cached inside the Durable Object using the identity, instance, persona revision, and material-event revision. Unchanged loads do not reread every evidence item or the full persona record. Material writes, adoption, invalidation, and restore force validation again. This cache is not persisted or exported.

Real Web evidence includes the bounded summary and a subset of the trusted lifecycle workflow described below. Paging, recorded-context delivery and context-loss recovery also have local connector tests; the complete acceptance matrix is still pending. Do not treat changing a configured tool name as full persona acceptance.

## Trusted conversation lifecycle over MCP

The unreleased `/<memory>/agent/mcp` endpoint uses the same MCP tool protocol, but
requires a registered `zwh_` connector credential. Ordinary memory tokens and
OAuth grants remain on `/<memory>/mcp` and cannot call this endpoint. Register
and rotate the private credential through the existing [host administration
API](identity-bindings.md#trusted-host-credentials), outside model context.

The connector attaches this namespace to `tools/call.params._meta`:

```json
{
  "io.ziwo/conversation": {
    "id": "persistent-conversation-id",
    "createdAt": 1795161600000,
    "parentId": null,
    "temporary": false,
    "seeded": false,
    "turn": "host-derived-current-user-turn"
  }
}
```

The credential establishes a host namespace; metadata is an attestation by that
host, not independently authenticated evidence of a physical conversation.
Callers holding the credential can falsify host facts, so it must remain private
to a trusted connector. Tool arguments cannot replace these fields. Conversation
creation time and parent lineage are immutable. Temporary helpers are rejected;
seeded context without a verified parent cannot acquire a subject. Different
hosts may use the same local conversation ID without sharing authority.

| Tool | Contract |
| --- | --- |
| `resume_context` | Reload the existing subject and initialization progress. An unbound root stays neutral; a verified persistent child inherits its parent. |
| `activate_context` | Load the confirmed persona and establish/reuse this conversation's binding. A different subject or instance is rejected before its persona is returned. |
| `initialize_context` | Acknowledge the exact loaded persona and register the connector's fixed history manifest, supplied only in metadata. |
| `read_initial_history` | Inspect pending IDs and decisions; use the connector's scoped history reader for originals. |
| `process_initial_history` | Remember or explicitly skip verified items, with stable request IDs and immutable source receipts. |
| `complete_context` | Complete only when the entire fixed manifest has decisions; gaps remain explicit. |
| `acknowledge_persona` | Acknowledge a newly loaded version if initialization was interrupted by revision. |
| `acknowledge_history_notice` | Mark a communicated notice acknowledged without resolving or erasing its gaps. |
| `refresh_context` | Read all material changes and persona revisions, gated on completed initial history. |
| Existing memory tools except `get_context` | Require this conversation's complete current-turn `cursor` and a stable `requestId`; the server supplies the bound memory session. |

History metadata adds `history: {cutoff, coverage, gaps, items}` using the
[activation manifest](activation.md) schema, at most 5,000 items and 100 gaps.
The connector freezes this before explicit activation, retains uncertain
requests, and presents it only to configured initialization tools. A verified
fork inherits its parent's subject and initialization provenance. The connector
validates the parent's durable ownership and retains original history references,
but starts the child from an independent context cursor. Unattributed seeded
transcripts remain blocked. dsh's ordinary UI fork does not currently persist
`parentSession`; it cannot claim this verified inheritance capability.

A complete cursor is signed for the host conversation and current user turn.
Incomplete, ordinary-MCP, other-chat, and old-turn cursors cannot authorize bound
memory tools. A complete cursor can refresh into the next turn; unfinished pages
must finish in their original turn or reload. Stable request IDs deduplicate
successful memory operations without retaining a cached response body. They
must not be reused for different arguments. No-change refreshes remain read-only,
and do not prevent the current turn from saving new memories.

A failed activation reports `structuredContent.activationEstablished=false`
only when the server knows no binding RPC was attempted and no binding existed.
A successful `resume_context` also reports that field when the root is still
unbound. This releases only a pending, never successfully established history
boundary. Other errors, including ambiguous binding failures, do not authorize
releasing it. Bound resume responses report `activationEstablished=true`.

Minimal experimental connector configuration:

```yaml
delegation: deny
runtimeMetadata:
  namespace: io.ziwo/conversation
  captureTools: [activate_context, resume_context]
  historyTools: [initialize_context]
  captureRollback: { pointer: /activationEstablished, value: false }
turnContext:
  tool: refresh_context
  state: { cursor: /cursor }
  pins: [/identity/id, /identity/instance]
  pagination: { complete: /complete, maxPages: 128 }
  delivery:
    reloadArguments: { reload: true }
  maxBytes: 1048576
lifecycle:
  group: autobiographical-subject
  startTools: [activate_context]
  probe: resume_context
  allowedTools: [initialize_context, read_initial_history, process_initial_history, complete_context, acknowledge_persona, acknowledge_history_notice]
  localTools: [mcp_connector_history]
  ready:
    activate_context: /activation/canRun
    resume_context: /activation/canRun
    initialize_context: /canRun
    process_initial_history: /canRun
    complete_context: /canRun
    acknowledge_persona: /canRun
    acknowledge_history_notice: /canRun
```

Use the trusted endpoint and private bearer credential, and deny temporary-agent
access. The configured initialization workflow records ownership before its first
call. Until server readiness, it rejects unrelated tools and buffers model
streams, releasing only complete permitted initialization calls. After readiness,
it forces the first full refresh in the same turn before ordinary work. Recovery
uses an allowed probe through the normal scoped executor. This requires public
model-stream middleware and the shared tool pipeline; bypassing custom executors
and other in-process plugins are outside its enforcement boundary. No service
names or pointers are hardcoded in the connector.

A retained workflow sidecar can recover a missing context sidecar by reloading
the same owner. Missing workflow ownership, changed endpoints, old host bindings
without authenticated MCP conversation records, and restore reassociation are
not silently migrated. Full acceptance across the remaining scenarios is pending.

The generic delivery controller keeps the last admitted cursor and a pending
receipt containing only IDs, hashes and next-state scalars. It confirms exact
content against the actual current model surface before advancing. A failed
admission is re-read from the old position; surface replacement/compaction causes
a full same-subject reload. This establishes recorded input, not proof that a
model understood it. All pages must fit configured total limits before the model
continues. Local real dsh tests now cover activation, history processing, empty
changes followed by new writes, cross-chat correction and same-subject persona
revision. Full acceptance remains pending, including multi-page/deletion/failure
scenarios and temporary-helper transcript isolation. Hiding tools and server
instructions does not prevent a host from copying an already loaded parent
transcript into a fork; that needs a gate before the copy is created.

## Independent evaluation over MCP

A user can create a scoped evaluation connection with `ziwo-admin persona-evaluate`, use it in a fresh AI conversation, then review and approve the exact proposal through the private administration channel. The evaluation MCP exposes only `read_evaluation` and `propose_persona`; it cannot remember, activate the subject, approve, or adopt. See the [portable evaluation workflow](persona.md#portable-evaluation-with-any-mcp-client).

## Structured context result

`get_context` retains its text response and adds standard MCP `structuredContent`:

```json
{
  "schema_version": 1,
  "session_id": "s_example",
  "identity": { "id": "zi_example", "instance": "i_example" },
  "capabilities": {
    "memory": "bounded_summary",
    "persona": "requires_host_activation",
    "turn_enforcement": "client"
  }
}
```

Legacy stores that have not established an identity can return a null identity field. Reading context does not migrate an identity, adopt a persona, approve a proposal, or attest conversation ownership. Failed calls have no successful structured state. The session ID identifies a memory session; it is not an authentication credential or proof of ownership by a particular host conversation.

Clients should use structured state rather than parse session IDs from prose. Refresh using the previously returned `session_id`; use `recall` for relevant remembered subjects, since the context is a bounded summary, not an exhaustive change feed. Pin the stable identity and instance when the host supports it. Reject changed targets and treat a restored instance as requiring explicit reassociation.

## Generic connector configuration

The unreleased connector branch supports an opt-in `turnContext` setting on any configured server:

```yaml
servers:
  ziwo:
    transport: streamable-http
    url: https://your-instance.example/your-memory/mcp
    delegation: deny
    turnContext:
      tool: get_context
      state:
        session_id: /session_id
      pins:
        - /identity/id
        - /identity/instance
```

Use the connector's normal authentication configuration. `state` maps next-call argument names to JSON pointers in `structuredContent`; `pins` select immutable response values. This same mechanism works with other context services and does not interpret Ziwo-specific field names.

Start a new, unseeded conversation after enabling this capability. Neutral conversations do not automatically load a service. A successful explicit/model-requested context call activates subsequent automatic refreshes. Each later turn, and a new user message steered into a running turn, refreshes before generation. Intermediate tool steps do not create extra refreshes. Automatic execution uses dsh's scoped tool executor and requires the context tool's policy to be `allow`; other tool policy and scope checks still apply.

State is stored durably in dsh's `mcp_connector_context` domain under the real session ID and creation time. It contains endpoint fingerprints, mapped scalar arguments and pinned scalar values, not returned memory text. Context supplied to the model is recorded as connector-authored context in the conversation. A timeout, cancellation, tool error, changed identity, restricted server, invalid result, or persistence failure blocks the step. Missing state for an old, seeded or inherited transcript also blocks; silently creating a new binding would hide a continuity failure.

The summary-only configuration does not migrate existing conversations or infer fork ownership. The optional trusted lifecycle workflow supports verified parent lineage as described above; session backup/restore/delete still needs explicit ownership handling. Keep the durable sidecar with its owning dsh profile. Disabling/uninstalling the controller removes enforcement; a server cannot prevent a host from responding using old context. Configuring multiple memory servers is not a substitute for the trusted host's single-identity binding contract.
