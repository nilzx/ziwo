# Stable identities and host conversation bindings

This describes the identity foundation included in the 0.3.0 preview source. See the [preview guide](preview-release.md) for publication, deployment and migration boundaries. The [N2 persona service](persona.md) adds independent initialization and version loading. The [N3 activation service](activation.md) adds gated history backfill and initialization readiness. Optional [Codex reference and native CLI hosts](../adapters/codex/README.md) are available; desktop integration remains separate work. Binding responses derive `canRun` from the current persona and persisted initialization state.

## Identity and instance

A new memory receives an immutable `identity_assignment` record:

```json
{
  "id": "zi_<32 lowercase hexadecimal characters>",
  "origin": "created",
  "sourceInstance": "i_<original instance>",
  "establishedAt": 1795075200000
}
```

The identity survives export and restore. The data `instance` changes on restore, and both identifiers change after deleting and creating a memory under the same name. The display/routing name is not identity. A memory session (`s_…`), a host conversation (`threadId`), and the stable identity are distinct.

The assignment is immutable, separate from autobiographical events, and preserved by derived-table rebuilds. Reading it creates no memory session and performs no recall. An old database without an instance reports `instance: null` without initializing storage on that read.

## Explicit legacy migration

Existing data is not assigned an identity merely by being read. Before migrating, the owner must save and verify a recoverable backup. These endpoints use the existing admin credential:

| Request | Behavior |
| --- | --- |
| `GET /admin/memories/<name>/identity` | Returns `{memory, identity, instance}`; `identity` is null before migration. A missing memory is 404. |
| `POST /admin/memories/<name>/identity` | Accepts `{expectedInstance, sourceInstance?}`. Assigns identity once; repeated matching requests return the same assignment. A changed instance or conflicting source is 409. |

Legacy IDs are `zi_` plus the SHA-256 of `ziwo-legacy-identity-v1\0` followed by the verified source instance. This makes migration and restoration of the same legacy source agree without using a memory's name. It does not increase the entropy of old identifiers or prove the source authentic.

A legacy import preserves its source instance but remains unassigned until explicit migration. If its source is missing, migration requires an owner-provided provenance identifier in `sourceInstance`; it must not be guessed from a name. For an old object also missing its current instance, use `expectedInstance: null` and supply that source. The explicit migration creates a current instance. An existing known source cannot be overridden.

The owner is responsible for verifying legacy provenance. Version 1 headers were not covered by the event hash chain; an arbitrary uploaded header is not proof of ownership. Two writable restores are not automatically merged or synchronized.

## Backup version 2

Unassigned, unrestored legacy stores retain the v1 export format. Assigned identities and restored legacy sources use `ziwo_export: 2`; the autobiographical `log_format` remains 3. Version 1 imports remain supported.

A v2 header includes `identity` (the assignment, or null) and, only when unassigned, `legacy_source_instance` (possibly empty when unknown). The chain starts with:

```text
SHA256("ziwo-export-v2\n" + goCompact(header))
```

Subsequent event links use the existing algorithm. The footer repeats the final link, including for an empty event log. Header fields therefore participate in the integrity check. Duplicate top-level header keys and noncanonical key casing are rejected. The hash chain detects corruption and modifications that do not recompute it; it is not a signature establishing who supplied a backup.

Restoring a v2 backup preserves its identity assignment and generates a new data instance. A v1 restore retains its original source through subsequent v2 exports, even before migration. Settings retain their existing behavior. Stores with adopted persona history use [v3](persona.md#backup-version-3), or [v4](activation.md#backup-and-limits) when initialization state exists; v2 remains the format for assigned stores without adopted persona history. The encrypted `.ziwo-export` envelope is unchanged. Older releases that only accept v1 cannot import v2 backups; do not downgrade them by deleting identity fields.

Memory backups do not contain host credentials or conversation-binding authority. Those live in the deployment's Directory storage. Restoring data requires an explicit association for each affected binding; it never follows a reused name automatically. Recovering a lost registry is a separate administrative problem: registering a new host is not proof that an old conversation is unbound.

## Trusted host credentials

The binding API is for an owner-registered, trusted adapter process. A host credential is a service credential, not a user-facing MCP token. Keep it outside model context, tool arguments, child-agent environments, and logs. Registration authorizes that host to manage bindings in its namespace; it must verify the actual user action and conversation source before making a request. This API does not itself prove human intent.

Admin-authenticated operations:

| Request | Body / result |
| --- | --- |
| `POST /admin/harnesses` | `{name, requestId?}`. First creation returns 201 with `{id, name, createdAt, token}`; save a unique request ID before sending to make retries recoverable. |
| `GET /admin/harnesses` | Lists metadata, including revoked hosts. Optional exact `name` and `requestId` filters, `limit` (1–100, default 50), and `after` host ID. Returns `{harnesses, nextAfter}` in ascending ID order. |
| `GET /admin/harnesses/<id>` | Returns `{id, name, createdAt, revoked, bindingCount, requestId}` or 404. The count includes retained historical bindings, not only currently available subjects. |
| `POST /admin/harnesses/<id>/token` | Rotates the token while preserving the namespace and all bindings. The old token stops working. |
| `DELETE /admin/harnesses/<id>` | Revokes the namespace's credential; preserves binding history. A revoked host cannot be reactivated by token rotation. |

Only the token's SHA-256 is stored. Tokens use the `zwh_` prefix and are not accepted as ordinary memory MCP credentials. The preview [trusted lifecycle MCP endpoint](mcp-capabilities.md#trusted-conversation-lifecycle-over-mcp) accepts them with connector-authenticated conversation metadata. Registration without a request ID retains the legacy behavior: the same display name can create another namespace.

A request ID uses 1–200 ASCII letters, digits, underscore, dot, colon or hyphen.
The same request ID and trimmed name return the same host with HTTP 200,
`replayed: true`, and `tokenAvailable: false`. No token is returned or rotated,
and the retry makes no registry writes. Reusing the request ID for another name
returns 409. Receipts survive restarts, rotation and revocation; retrying an old
registration cannot reactivate a revoked host. Metadata never includes token
hashes, credentials or conversation contents. Host administration responses,
including authentication errors, use `Cache-Control: no-store`.

After a lost response, query the saved request ID or repeat that exact registration.
If the token was lost, explicitly rotate the recovered host's credential rather
than creating a new namespace. Rotation preserves bindings and invalidates the
old token. A lost rotation response requires another explicit rotation; plaintext
credentials are not retained for retrieval. Paginated listings are live: a host
created before an already consumed ID position requires a fresh listing.

The repository's administration CLI supports these operations:

```sh
# Set ZIWO_URL and ZIWO_ADMIN_SECRET privately. Save the request ID first.
node worker/bin/ziwo-admin.mjs host-register "My trusted client" enrollment-001
node worker/bin/ziwo-admin.mjs hosts --request enrollment-001
node worker/bin/ziwo-admin.mjs host-show h_00000000-0000-0000-0000-000000000000
node worker/bin/ziwo-admin.mjs host-token h_00000000-0000-0000-0000-000000000000
node worker/bin/ziwo-admin.mjs host-revoke h_00000000-0000-0000-0000-000000000000
```

Use the actual returned host ID for show, rotation and revocation. Keep registration
and rotation output private: each newly issued token is shown once. These are
setup and recovery operations, not additional per-turn checks. A reusable synthetic
management check is described in [host registry validation](host-registry-validation.md).

## Conversation binding API

Requests use `Authorization: Bearer <host token>`. JSON bodies are limited to 8 KiB and reject unrecognized fields. Identifiers use 1–200 ASCII letters, digits, underscore, dot, colon or hyphen. Memory names follow the existing routing rule. Responses are not cacheable.

| Request | Fields |
| --- | --- |
| `GET /harness/v1/binding?threadId=…` | Returns the binding or `{binding: null, state: "unbound"}`. |
| `POST /harness/v1/bind` | `{threadId, memory, identityId, instance, activationId, source}` |
| `POST /harness/v1/fork` | `{threadId, parentThreadId, source}` |
| `POST /harness/v1/restore` | `{threadId, memory, identityId, instance, previousInstance, requestId}` |

`source` must be `conversation` for an authorized persistent conversation. `temporary` is refused with 403. The registered host must derive this classification from trusted host events; self-reported model text, MCP `_meta`, or a shared parent session ID are not authority. `activationId` records the host's user-action reference; it is not a standalone approval credential.

A binding contains `harnessId`, `threadId`, `identityId`, `memory`, `instance`, `state`, `parentThreadId`, `activationId`, `createdAt`, and `updatedAt`. Its key is `(harnessId, threadId)`. Binding and its audit event commit in one synchronous Directory transaction. Concurrent A/B requests cannot establish two owners. Rebinding to the same identity and instance is idempotent; a different identity is refused with 409. Deleting data does not release the binding.

A persistent fork inherits a registered parent's identity and pinned instance, records that parent, and starts in `bound_initializing`. It does not inherit permission to run. A fork of an unbound parent stays unbound. A child that is already independently bound cannot be claimed as a fork.

Restore association verifies the existing subject, expected previous instance, and new target's identity/instance. It resets initialization without changing the identity. Successful restore request IDs and their arguments persist. Replaying an older request after later restores returns the **current** binding without rolling it back; reusing the same request ID for different arguments is refused.

### Private approval for MCP recovery

The generic MCP controller uses an explicit private approval, rather than giving
model tool arguments authority to change an instance. After reviewing the exact
conversation and restored target, the user-facing admin channel calls
`POST /admin/harnesses/<harnessId>/restores` with:

```json
{
  "requestId": "restore-operation-1",
  "threadId": "persistent-conversation-id",
  "createdAt": 1795161600000,
  "parentThreadId": null,
  "identityId": "zi_original_subject",
  "memory": "restored-route",
  "instance": "i_restored",
  "previousInstance": "i_original"
}
```

The authenticated MCP conversation must already exist with the exact creation
time and parent. The target must preserve its identity and replace the expected
old instance. Approval records are immutable; request ID reuse with changed
arguments is rejected. `DELETE /admin/harnesses/<harnessId>/restores/<requestId>`
revokes future consumption/replay, without undoing an already committed binding.
Approval and revocation require admin authentication, not a connector or memory
credential. Each conversation needs its own explicit approval; this is not
automatic merging or migration of other writable copies.

On the restored `/<memory>/agent/mcp` endpoint, `restore_context({requestId})`
also requires connector-supplied `_meta["io.ziwo/recovery"] = {requestId}` in
addition to the actual conversation metadata. Only the private recovery
controller supplies that namespace. Ordinary model calls cannot supply it through
tool arguments. The server checks the approved old and new targets in the same
Directory transaction as the binding change, and returns a `reassociation`
receipt containing `requestId`, `from`, `to`, and the approved conversation.
An old MCP recovery request after a later restoration is rejected; it never
rolls the binding back or presents an obsolete transition as current.

The connector must independently journal and verify this transition before
updating its endpoint fingerprints and instance pins. It preserves the original
history references, clears old cursors and delivery/persona acknowledgments,
then resumes initialization and fully reloads the restored instance before
generation. A remote success with a lost response remains pending locally.
Neither the receipt nor the returned persona alone proves complete loading.

The target object is checked before binding/association and on every returned binding. Cross-object deletion is not one atomic transaction with Directory registration: a race can leave a binding whose `targetAvailable` is false. It remains bound and cannot run; it is not reassigned by name. Future memory calls must recheck the captured identity and instance at their point of use.

## Initialization and compatibility limits

N1 records the immutable binding initially as `bound_initializing`. N2 provides [current persona loading](persona.md#loading-and-invalidation), and [N3 initialization](activation.md) persists the loading acknowledgment, source scope, write session and history processing receipts in Memory. Binding responses derive `ready` only when those gates pass, rechecking the current instance and persona. There is no unrestricted ready toggle. The binding endpoints do not read memory contents or create memory sessions. N2 has separate scoped evaluation endpoints that read a fixed snapshot without autobiographical side effects.

Existing fixed-token/OAuth MCP connections keep their previous per-memory behavior and are not automatically migrated to host bindings. They do not provide the new conversation-level isolation or persona sequencing. Fixed-token authentication now captures the data instance in the same object call, and tool execution rechecks it, closing a deletion/recreation race.

A Codex integration still needs trusted activation, per-turn persona/memory synchronization, clean temporary-agent context, and independent tool permissions. Full context inheritance or a prompt telling a child not to use tools is insufficient. These integration requirements are not claimed as implemented by N1.
