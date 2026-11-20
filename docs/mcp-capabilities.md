# MCP lifecycle capabilities

Ziwo supports ordinary MCP clients and clients with a generic lifecycle controller. A server receives tool calls, not user-turn events: standard MCP alone cannot guarantee that a client refreshes context before every answer.

| Capability | Ordinary MCP | Generic turn controller | Existing trusted host integration |
| --- | --- | --- | --- |
| Memory tools | Yes | Yes | Yes |
| Refresh after the conversation first loads memory | Model instruction | Enforced before generation | Enforced before generation |
| Bounded current memory summary | Yes | Yes | Yes |
| Complete paged memory changes with acknowledgement | No | Not implemented in this MCP path | Yes |
| Adopted persona loading and initialization gates | No | Not implemented in this MCP path | Yes |
| Authoritative persistent identity binding | No | Local endpoint/identity pins only | Yes |

The generic controller is reusable connector functionality, not a Ziwo-specific harness adapter. The first implementation is in `dsh-mcp-connector`. It does not make the ordinary memory MCP surface equivalent to the full [activation](activation.md) and [turn synchronization](turn-sync.md) contract. Full acceptance still requires both persona and complete memory synchronization, persistent ownership, and isolation evidence.

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
