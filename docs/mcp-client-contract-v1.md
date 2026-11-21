# MCP client capability contract, version 1

This is a proposed project contract between a context service, a generic MCP
connector and its host. It is **not an MCP standard or a certification**. All
clients use the same service endpoints and tool formats; a successful MCP
connection does not establish control over the host's user turns or history.

The [machine-readable inventory](../conformance/contract-v1.json) lists required
capabilities and failure behavior. The [conformance runner](../conformance/README.md)
and [client evidence table](mcp-client-validation.md) distinguish service tests,
simulated hosts and observed client runs. Breaking requirement changes need a new
contract version. Version 1 does not negotiate a new MCP wire protocol.

## Capability profiles

| Profile | Required behavior | Unsupported behavior |
| --- | --- | --- |
| Ordinary MCP | Standard discovery, authentication and text tool results; structured results are additive | No claim of enforced refresh, authoritative chat binding or history isolation |
| `turn-sync` | Ordinary MCP plus persistent per-chat state, each-user-turn admission, paged delivery, exact input verification and reload after context loss | Missing configured or startup capabilities refuse enablement; dynamic failures block generation |
| `trusted-lifecycle` | Turn sync plus authenticated host metadata, initialization gates, scoped history, persistent parent provenance, temporary-helper exclusion and destination admission before construction/persistence | Missing admission version refuses startup; missing/ambiguous ownership refuses protected work |

The connector's opt-in configuration is:

```yaml
capabilityProfile:
  version: 1
  tier: turn-sync # or trusted-lifecycle
```

This is a **local requirement declaration**, not remote attestation. Ordinary
servers omit it. Unknown versions, tiers and keys are errors. `turn-sync`
requires `turnContext.pagination`, `turnContext.delivery`, nonempty managed
`state` and immutable `pins`. `trusted-lifecycle` additionally requires
`runtimeMetadata.captureTools`, `runtimeMetadata.historyTools`,
`lifecycle.requireCreationAdmission: true`, and `delegation: deny`.
See [configuration semantics](mcp-capabilities.md#generic-connector-configuration).

Status reports requested and configured features only. Startup checks validate
available host services; the current session, scoped executor and actual model
surface can only be checked when used. No status field certifies end-to-end
compliance or that a model understood supplied context.

## Ownership and host responsibilities

| ID | Required host fact or mechanism | Failure boundary |
| --- | --- | --- |
| H01 | Stable persistent conversation ID **and** creation identity; durable state scoped to that conversation | Never infer a neutral chat from missing state in an existing transcript |
| H02 | A pre-generation event for every new user turn, including steering during a running turn | Refresh failure blocks generation; intermediate tool steps do not invent user turns |
| H03 | Context calls use the normal scoped permission executor | A rejected/unsupported executor blocks; direct client calls cannot bypass permissions |
| H04 | The actual model input, its revision, and exact delivered content can be inspected | Advance a cursor only after complete admission; missing/replaced context triggers a same-subject reload |
| H05 | Authoritative session metadata and actual parent provenance, unavailable for model override | Unverified inherited history is rejected; transcript similarity is not lineage |
| H06 | Frozen initial-history scope and readiness gate over tools and model streams | Ordinary work waits for ownership, persona and required history processing |
| H07 | Durable ownership/checkpoints, exact recovery approval and idempotent transition receipts | Restore requires explicit reassociation; a retry cannot rewind or silently switch subjects |
| H08 | Temporary helpers cannot inherit protected context, tools or scoped history access | Protected copy paths are denied; fresh task-only helpers have no parent identity |
| H09 | Synchronous destination preparation admission, version 1, before construction/persistence | Unsupported hosts refuse the strongest profile; veto cannot be overridden or deferred |

The connector implements these mechanisms generically using configured tool
names, pointers and workflow gates. The service authenticates callers, validates
identity/instance and provenance, serves bounded pages, and performs approved
state transitions. The service cannot observe physical user turns or prove that
a host really delivered context. Host-supplied metadata remains a trusted claim
until separately tested against that host's actual behavior.

For dsh, the facilities include durable `storageDomain`, `sessionQuery`,
pre-step and model-stream middleware, monotonic tool guards, an inspectable model
surface, and `sessions.preparationAdmissionVersion === 1`. The optional host
source proposal is distributed under the connector's
`contrib/dsh-session-admission/` directory; it is not part of stock dsh.

## Proposed generic preparation event

The synchronous, scoped `session/preparing` event runs before a destination
consumes its captured seed or becomes available to persistence. It supplies a
frozen header, seed presence/count, inherited count, restoration flag and actual
parent identity, without disclosing seed contents. Throwing vetoes preparation;
returning a promise is an error; another listener cannot override refusal.
Construction and restore must use the same captured metadata after admission.
With no listener, normal host behavior is unchanged.

This boundary does not prohibit reading source history or creating an
intermediate seed. Privileged plugins that bypass the host session store, and
tampered local ownership storage, remain outside the trusted-host contract.
Browser actions, every host entry point and upstream adoption require their own
evidence. The proposal is ready for review; submitting an upstream PR is separate.

## Service invariants and delivery

A persistent conversation binds one stable subject. Loading a new revision of
that subject is synchronization; changing to another subject is rejected. Keep
stable identity and data-instance identity separate. A signed cursor is a read
position, not proof of conversation ownership or authorization to rebind.

Neutral chats do not auto-load a service. After activation, check before each
new user turn and drain all pages through their fixed upper bound. Admit the
complete result before advancing the durable cursor. Errors, cancellations,
changed pins, invalidated pages and incomplete delivery stop the step. Retry
from the previous admitted position; context loss requires full same-subject
reload. Each persistent consumer owns an independent cursor.

An empty external delta performs no synchronization writes. It does not suppress
worthwhile new memories from the current conversation. Persona proposals remain
separate from memory writes and require approval of the exact proposal before
adoption. See [the feed](mcp-capabilities.md#incremental-persona-and-memory-feed),
[activation](activation.md) and [turn synchronization](turn-sync.md).

## Evidence and acceptance

Reports use `server-observed` for exercised service behavior, `simulated-host`
for mock host controls, `host-observed` for actual runtime boundaries, and
`client-observed` for actual client interoperability. `host-attested` identifies
claims supplied by a host and is not equivalent to physical observation.
Unrun, unsupported and blocked checks never count as passed.

The local runner aggregates existing test files under stable case IDs; a passed
file is not a new independent experiment for every mapped requirement. Its
simulated Codex host tests are not evidence for native Codex ordinary MCP or
universal host enforcement. A separate service-neutral inventory fixture tests
the connector's paging, empty delta, independent state, reload and error paths
over real MCP stdio with a simulated host. Acceptance of a stronger tier still
requires actual host evidence for its complete intended scope.

The inventory leaves `case_ids` empty for H01–H09. Related service and
simulation cases are partial evidence, not a machine-computable pass for those
host requirements. Each requires observation of the intended host and
integration across the full requirement. In particular, the local TRUST-02
case does not test steering, the scoped executor or exact actual model input;
ISOL-02 does not establish isolation in an actual host.
