# MCP lifecycle capabilities

Ziwo supports ordinary MCP clients and clients with a generic lifecycle controller. A server receives tool calls, not user-turn events: standard MCP alone cannot guarantee that a client refreshes context before every answer.

| Capability | Ordinary MCP | Generic turn controller | Existing trusted host integration |
| --- | --- | --- | --- |
| Memory tools | Yes | Yes | Yes |
| Refresh after the conversation first loads memory | Model instruction | Enforced before generation | Enforced before generation |
| Bounded current memory summary | Yes | Yes | Yes |
| Paged material memory changes and confirmed persona revisions | `sync_context`, client applies pages | Paging/delivery integration pending | Yes |
| Independent evaluation and proposals | Scoped evaluation MCP endpoint | Separate fresh evaluator | Yes |
| Initial chat-history activation gates | Not yet exposed on ordinary MCP | Pending | Yes |
| Authoritative persistent identity binding | No | Local endpoint/identity pins only | Yes |

The generic controller is reusable connector functionality, not a Ziwo-specific harness adapter. The first implementation is in `dsh-mcp-connector`. The new read-only feed and evaluation endpoint do not yet make ordinary MCP equivalent to the full [activation](activation.md) and [turn synchronization](turn-sync.md) contract. Full acceptance still requires activation, persistent ownership, safe incremental delivery, and isolation evidence.

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

The current generic connector example below still uses the bounded summary. **Do not replace its tool with `sync_context` yet**: safe paging, retained deltas after a failed generation, context-loss recovery and activation integration are still pending. The feed itself is covered by local protocol tests, not by the earlier real dsh summary test.

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

The current implementation does not migrate existing conversations, inherit bindings into forks, or follow session backup/restore/delete automatically. Keep the durable sidecar with its owning dsh profile. Disabling/uninstalling the controller removes enforcement; a server cannot prevent a host from responding using old context. Configuring multiple memory servers is not a substitute for the trusted host's single-identity binding contract.
