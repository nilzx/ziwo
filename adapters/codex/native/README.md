# Native Codex CLI workspace

This optional development adapter runs the original Codex terminal UI through a local Ziwo gateway. It supports editing code, running local commands and tests, and local Git operations in one fixed workspace. It requires the unreleased N1–N4 Ziwo service APIs and is not bundled in the published npm package.

The integration targets **Codex CLI 0.170.0 on macOS** and **Node.js 22 or newer**. Revalidate the experimental App Server protocol and filesystem protection before using another Codex version or platform. Codex desktop integration remains separate work.

## Start

Install the adapter's locked dependency from the repository root:

```sh
npm ci --prefix adapters/codex/native --ignore-scripts
```

Use an existing Codex login and a registered Ziwo host. Prepare the configuration described in the [reference host guide](../README.md#run), in a dedicated directory **outside the code workspace**. The directory must be owned by your user and mode `0700`; the JSON file must be mode `0600`. A short path is needed for the private Unix socket. Do not place unrelated files or link aliases in this directory. A coding configuration only needs `url`, `token`, `model`, and `subjects`; persona adoption uses the separate review controls.

```sh
node adapters/codex/native/cli.mjs \
  --config /private/path/ziwo/config.json \
  --workspace /absolute/path/to/code \
  --subject 1
```

`--subject 1` explicitly selects the first configured identity before opening the native UI. Omit it for a neutral conversation. A selected subject must already have an adopted persona. Chat text, code and tool output cannot activate or change a subject. This release activates new conversations only; it does not import arbitrary existing native chats or activate an already used neutral native conversation.

The launcher prints a conversation ID. Resume through the same gateway and workspace:

```sh
node adapters/codex/native/cli.mjs \
  --config /private/path/ziwo/config.json \
  --workspace /absolute/path/to/code \
  --resume CONVERSATION_ID
```

Keep the adjacent `.native.journal` file. It stores conversation provenance, workspace and activation source fingerprints, without persona or memory text. Each live launcher needs a separate configuration/journal; multiple launchers may share the same registered host token and identity. A stale `.lock` after a crash must only be removed after verifying that the old launcher has stopped.

Native `/new` creates a neutral chat. Persistent forks preserve their original identity. A chat bound to A cannot switch to B, including after a restart. Same-identity persona revisions and committed memory changes load on the next user turn. Continue these chats through this launcher: opening them in an unrelated Codex client bypasses Ziwo's controller and is unsupported.

## Synchronization and tools

For each bound turn, the gateway reads a fixed persona/memory snapshot and every page, persists its context with `thread/inject_items`, acknowledges the exact versions/pages, and only then starts model generation. Failed loading or acknowledgment prevents the code turn from starting. Resume and compaction force a complete memory summary reload. The native UI receives streaming responses and code-tool progress after the turn is admitted.

The model's `ziwo_memory` calls remain scoped to that conversation and synchronized turn. `ziwo_delegate` runs on a separate fresh App Server with no parent history, persona or workspace tools. It is suitable for bounded reasoning tasks, not parallel repository edits. Persona evaluation also uses a separate clean service; proposal adoption remains an explicit user review outside the coding chat.

The gateway accepts a narrow set of native RPCs. Finish or interrupt a turn before submitting the next message. Steering, queued input, realtime, review mode, goal/background execution, client context injection and arbitrary configuration changes are rejected. The TUI's tool catalog on `/new` is discarded; only host-owned tools are installed. Model selection comes from the private configuration, and this release uses low reasoning effort. Native subagents, inherited MCP servers, apps, plugins, hooks, host skill discovery and automatic project-instruction loading are disabled. The coding assistant can read relevant repository instructions as workspace files when asked.

## Workspace protection

Commands run under the fixed `ziwo-workspace` profile, with code and `.git` writable. Private host state, its socket, and Codex's authentication/state directory are denied. The shell starts without inherited environment variables; only a fixed tool path and private scratch location are supplied. Commands have no network access or permission escalation. Install dependencies outside this session before running offline tests; builds needing network or broader system access are outside this version's scope.

On macOS, installed Homebrew and Xcode/Command Line Tools runtime directories are allowed read access. An optional `runtimeRoots` array in the private configuration replaces those defaults; select only necessary runtime paths outside private state. Do not select a broad home or root directory. Commands may read the explicitly allowed runtime directories, so they must not contain private host data.

Filesystem path denial alone does not protect a pre-existing hard link to a private file. Startup and each user turn reject symbolic/hard links in the dedicated host directory and hard-linked Codex authentication/configuration files. The protection assumes the trusted user and other same-user processes do not create secret aliases during execution. It is not a boundary against a privileged process on the same machine.

The launcher uses a separate temporary Codex home for the terminal UI. The backend retains the existing login and starts in the fixed workspace; new-thread requests inherit that directory without asking Codex to persist another project trust decision. The gateway verifies the returned directory and permission profile. UI settings and caches are removed on exit. The credential-free UI cache remains denied to workspace tools; its executable symlinks are kept separate from the strictly audited host credential directory. The private socket permits one origin-free local client. Disconnect interrupts the active turn, and reconnection cannot release an earlier pending turn.

## Development checks

Synthetic verification on macOS covered native TUI code repair, Node tests, a local Git commit, neutral `/new`, persona revisions, cross-conversation memory, restoration, identity refusal/isolation, clean assistance, and compaction. Persistent forks were checked through the real gateway protocol. The final suite passed 160 Node checks; the Terra experiment used at most 14 model operations. These results establish the tested integration behavior, not real-subject continuity or desktop support.

After installing both `worker/` and this adapter's dependencies, run:

```sh
cd worker
npm run test:node
npm run typecheck
```

The protocol decisions follow OpenAI's [App Server documentation](https://developers.openai.com/codex/app-server), [configuration reference](https://developers.openai.com/codex/config-reference), [permissions guide](https://developers.openai.com/codex/permissions), and [hook semantics](https://developers.openai.com/codex/hooks). Hooks alone are not the synchronization enforcement boundary.
