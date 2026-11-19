# Stable identities and host conversation bindings

This describes the N1 foundation in the development branch. It has not been deployed or released. The [N2 persona service](persona.md) adds independent initialization and version loading. History backfill and a Codex adapter remain separate stages. The new binding API always returns `canRun: false`; it does not grant access to autobiographical memory.

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

Restoring a v2 backup preserves its identity assignment and generates a new data instance. A v1 restore retains its original source through subsequent v2 exports, even before migration. Settings retain their existing behavior. Stores with adopted persona history use [v3](persona.md#backup-version-3); v2 remains the format for assigned stores without adopted persona history. The encrypted `.ziwo-export` envelope is unchanged. Older releases that only accept v1 cannot import v2 backups; do not downgrade them by deleting identity fields.

Memory backups do not contain host credentials or conversation-binding authority. Those live in the deployment's Directory storage. Restoring data requires an explicit association for each affected binding; it never follows a reused name automatically. Recovering a lost registry is a separate administrative problem: registering a new host is not proof that an old conversation is unbound.

## Trusted host credentials

The binding API is for an owner-registered, trusted adapter process. A host credential is a service credential, not a user-facing MCP token. Keep it outside model context, tool arguments, child-agent environments, and logs. Registration authorizes that host to manage bindings in its namespace; it must verify the actual user action and conversation source before making a request. This API does not itself prove human intent.

Admin-authenticated operations:

| Request | Body / result |
| --- | --- |
| `POST /admin/harnesses` | `{name}` → `{id, name, createdAt, token}`. The server creates the namespace; the token is shown once. |
| `POST /admin/harnesses/<id>/token` | Rotates the token while preserving the namespace and all bindings. The old token stops working. |
| `DELETE /admin/harnesses/<id>` | Revokes the namespace's credential; preserves binding history. A revoked host cannot be reactivated by token rotation. |

Only the token's SHA-256 is stored. Tokens use the `zwh_` prefix and are not accepted as existing MCP credentials. A newly registered host with the same display name gets a different namespace.

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

The target object is checked before binding/association and on every returned binding. Cross-object deletion is not one atomic transaction with Directory registration: a race can leave a binding whose `targetAvailable` is false. It remains bound and cannot run; it is not reassigned by name. Future memory calls must recheck the captured identity and instance at their point of use.

## Initialization and compatibility limits

N1 records `bound_initializing`. The schema reserves `ready`, but no public endpoint can set it; persona initialization and required backfill must complete before that transition is available. N2 now provides [current persona loading](persona.md#loading-and-invalidation), while backfill and ready transition remain pending. A binding response always has `canRun: false` in this stage. The binding endpoints do not read memory contents or create memory sessions. N2 has separate scoped evaluation endpoints that read a fixed snapshot without autobiographical side effects.

Existing fixed-token/OAuth MCP connections keep their previous per-memory behavior and are not automatically migrated to host bindings. They do not provide the new conversation-level isolation or persona sequencing. Fixed-token authentication now captures the data instance in the same object call, and tool execution rechecks it, closing a deletion/recreation race.

A Codex integration still needs trusted activation, per-turn persona/memory synchronization, clean temporary-agent context, and independent tool permissions. Full context inheritance or a prompt telling a child not to use tools is insufficient. These integration requirements are not claimed as implemented by N1.
