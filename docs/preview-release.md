# 0.3.0 preview: installation, compatibility and recovery

[简体中文](preview-release.zh-CN.md)

The published preview is `@ziwo/memory@0.3.0-rc.1`, paired with
`@nilzx/dsh-mcp-connector@0.3.0-rc.2`. Both were released on November 21, 2026
through the `next` npm channel. `latest` remains Ziwo 0.2.0 and connector 0.2.2.
Publication and deployment are separate actions; see the
[release record](releases/0.3.0-preview.md) for exact tags and verification.

## Install deliberately

Use the exact version in a separate test deployment first:

```sh
npx @ziwo/memory@0.3.0-rc.1 --version
npx @ziwo/memory@0.3.0-rc.1 deploy --dry-run --name ziwo-preview
npx @ziwo/memory@0.3.0-rc.1 deploy --name ziwo-preview
```

`@next` follows the preview channel; the exact version reproduces this
candidate. Preview help and update instructions pin the current version instead
of sending you to `@latest`. Keep the Worker name when updating an existing
preview deployment. The package deploys the prebuilt Worker; source-only
administration, evaluation, conformance and Codex reference tools remain in the
repository. The GitHub source deployment button follows its selected branch,
not npm's `latest` channel.

## Compatibility

| Component | Preview scope |
| --- | --- |
| Ziwo 0.3.0-rc.1 | Ordinary token/OAuth MCP and text tools remain; adds stable identity, persona evaluation/approval, activation, incremental feed, trusted lifecycle and recoverable host registration |
| Connector 0.3.0-rc.2 | Ordinary configuration remains; explicit version 1 `turn-sync` / `trusted-lifecycle` profiles validate required capabilities |
| dsh 0.2.2-rc.5 | Tested generic controller with native executor; strongest profile requires the optional reviewed preparation-admission build, which is not in stock dsh |
| Node | Ziwo uses its packaged Wrangler's declared minimum; connector declares >=20; dsh 0.2.2-rc.5 declares >=24.9.0. Node 22.23.5 evidence covers the optional build and selected host modules, not support for the full dsh runtime |
| Native Codex CLI 0.171.0 | Ordinary MCP synthetic read/write passed; this does not enable forced per-turn synchronization in arbitrary CLI or desktop chats |

See the [capability contract](mcp-client-contract-v1.md),
[client evidence](mcp-client-validation.md), and connector's
`docs/PREVIEW.md`. A configured profile is not certification. Missing host
facilities and failed refreshes must block protected work. PTC is not supported
for enforced refresh. Do not remove sidecars or disable gates to bypass failures.

## Upgrade and backup

Before updating a deployment containing real data, identify its actual code
version, stop affected writers, and create an encrypted backup for each memory.
Keep the passphrase separately. Verify recovery in an isolated instance before
relying on the backup. Record the Worker/account, package version, connector and
host versions, and the backup's time and scope.

Deployment alone does not assign an identity to an old memory. Legacy identity
migration is an explicit, separately approved operation using verified source
provenance and the expected instance. Never guess provenance from a memory name.
Ordinary reads do not perform this migration. Existing conversations require
explicit ownership/recovery handling before adopting the stronger lifecycle.

Memory exports use v1 for unmigrated legacy data, v2 for identity data, v3 when
adopted persona history exists, and v4 when initialization state exists. The
encrypted file envelope is unchanged. Current code imports v1–v4; v0.2.0's
importer accepts only v1. Never strip identity/persona fields or rewrite a format
number to force a downgrade.

A memory backup does **not** back up Directory host credentials, bindings,
recovery grants, or the host's session logs and connector sidecars. Preserve the
host profile, sessions and sidecars consistently. Loss of Directory authority
is a separate recovery problem; a newly registered host cannot prove an old
chat was unbound. Restoring memory preserves its stable identity but changes
its data instance. Reassociate each affected binding explicitly; old cursors
and credentials are not permission to follow a reused route.

## Rollback

There is no demonstrated general in-place downgrade from the new storage and
backup formats to v0.2.0. Returning to an older Worker version only changes
code; it does not reverse stored data, persona adoption or identity assignment.

For a real rollback, stop writers and return to the verified **pre-upgrade**
backup/instance and matching host package, configuration, session logs and
sidecars. Verify that complete combination separately before resuming. Writes
made after the backup are not automatically merged; preserve them for explicit
review. Do not run two writable copies as if they were synchronized consumers.

The R3 test-server drill uses only disposable synthetic memory: export/import,
identity preservation, new instance, corruption refusal and exact cleanup.
Persona v3/v4 and host-binding recovery have separate local regression evidence.
This is not a production downgrade exercise or a Directory backup solution.

## Release procedure

Both repositories verify their package version against the exact `v<version>`
tag. PR and manual workflows only build and check, including a manual run on a
tag. Only a pushed version tag publishes. Prereleases go to `next`, stable
versions to `latest`; the GitHub release is marked as a prerelease accordingly.
The publishing job consumes the checked tarball and its digest, without running
the build again. Authentication uses the existing npm trusted publisher.

Before a public release, run tests and actual package installation, verify the
candidate on the designated test deployment, and record package/tag/commit and
deployment version separately. After publication, query registry metadata,
download the exact tarball, compare integrity with the CI artifact, and install
that downloaded package. Preserve `v0.2.0` and stable dist-tags.

If npm succeeds but GitHub release creation fails, first verify the registry
version, channel and artifact integrity. Complete only the missing GitHub
release step once the published artifact is confirmed. Do not blindly rerun
publication, overwrite a released tag or reuse an npm version for different
bytes. A mismatched artifact needs investigation and a new version.

Channel behavior follows [npm dist-tags](https://docs.npmjs.com/adding-dist-tags-to-packages/)
and [trusted publishing](https://docs.npmjs.com/trusted-publishers/).
