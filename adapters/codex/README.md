# Codex reference host

This development client demonstrates Ziwo's bound activation and per-user-turn synchronization using Codex App Server. It is an optional terminal reference implementation, not a change to the existing Codex desktop UI, and is not included in the released npm package. The server must include the N1–N4 development changes.

The current reference scope is conversation, scoped memory tools, clean temporary assistance, and persona evaluation/review. Shell execution, inherited MCP servers, apps, plugins, native subagents, image tools, browser/computer tools, and host skill discovery are disabled. It uses an empty temporary working directory and a read-only filesystem policy. Codex's code-mode transport remains enabled because this Codex build uses it to deliver dynamic tools; it receives no Ziwo credential. This reference does not yet provide general coding workspace access.

## Run

Use Node.js 22 or newer and an existing Codex login. The integration was developed against Codex CLI 0.170.0; the experimental protocol must be revalidated when upgrading. The local protocol schema is the immediate compatibility check; see OpenAI's [App Server documentation](https://developers.openai.com/codex/app-server) and [configuration reference](https://developers.openai.com/codex/config-reference).

Register a host using the existing admin `/admin/harnesses` API. Prepare a private JSON configuration outside the repository:

```json
{
  "url": "https://your-ziwo.example",
  "token": "YOUR_REGISTERED_HOST_TOKEN",
  "model": "gpt-6.1-terra",
  "subjects": [
    { "label": "My subject", "memory": "route-name", "identityId": "STABLE_ID", "instance": "CURRENT_INSTANCE" }
  ]
}
```

Protect this file with owner-only permissions. An optional, separate `adminToken` enables explicit persona review and confirmation controls. It is never a dynamic tool credential. Start:

```sh
node adapters/codex/cli.mjs /absolute/path/to/private-config.json
```

The client requires an interactive terminal. Piped text cannot drive user controls. `/subjects` lists configured choices; `/activate 1` is an explicit selection for the current conversation. Normal messages, code, tool results, and quoted commands do not activate anything. Once bound, selecting a different identity is rejected. The subject needs an adopted persona before initialization can finish.

`/new` starts an unbound conversation. `/resume ID` accepts only persistent conversations created by this host and recorded in its journal. `/fork` creates a persistent continuation of the same identity; temporary assistance instead starts a clean ephemeral thread with no parent history or Ziwo tools. Opening these threads in an unrelated native client bypasses this reference host's per-turn controller and is not a supported way to continue them.

The adjacent `.journal` file keeps host-created thread provenance and immutable activation source IDs/digests, not raw history, persona text, memories, or credentials. Keep it across restarts. It has an exclusive `.lock`; after a crash, verify the old client has stopped before removing a stale lock. Do not share a journal between simultaneous client processes. Separate clients can use separate journals and the same registered host credential.

## Activation and recovery

Before binding, the host captures completed original history and saves its fixed boundary. After binding it loads the adopted persona, records the manifest, asks the activated Codex conversation to classify worthwhile history, and submits the resulting bounded decisions. Summaries are explicitly marked and cannot become original experiences; unknown times remain unknown.

An interrupted activation reuses its journaled boundary and persisted processing receipts. It cannot silently choose a later cutoff. Missing/changed originals stop recovery with an explicit error; the reference client does not invent replacements or currently expose the service's manual gap supplementation controls. The service APIs still support those controls. Only a brand-new thread created by the current process, with no submitted turn, can treat the specific not-yet-materialized response as empty history.

Every ordinary bound user turn captures a persona/memory snapshot, reads all fixed pages, submits context, acknowledges exact loading, then exposes bound tools. Failed synchronization does not produce an ordinary answer. Output is buffered until the turn and acknowledgment succeed. Restart/resume triggers a complete summary reload. Writes use the model's stable call ID for deduplication. All credentials and target/session selection remain in the host.

## Persona maintenance

`/evaluate 1` starts a fresh third-party evaluator with only snapshot-read and proposal tools for that target. It is never activated as the subject and cannot write memories, confirm, or adopt. Its output includes proposal IDs.

`/review 1 PROPOSAL_ID` displays the concrete before/after persona, rationale, counterexamples, uncertainties, and evidence count. `/approve` confirms and adopts exactly the displayed digest; `/reject` rejects it. These are terminal controls, not phrases recognized in chat or model tools. An approved revision is loaded by all bound conversations on their next user turn.

## Legacy migration

The original fixed-token/OAuth MCP endpoint remains a legacy single-memory connection. Its global autobiographical instructions and automatic `get_context` behavior do not provide the new per-conversation identity boundary. Do not enable it alongside this host or distribute its credential to temporary agents.

For an experimental migration, preserve existing backups and native chats, disable the legacy Ziwo connection in the client used for the experiment, and create a new host-owned conversation. Establish the stable identity and explicitly approve its persona using the N1/N2 flows. Never relabel an already injected A conversation as B. This client automatically disables inherited MCP entries for its own process; it does not edit the user's global configuration or migrate production data.

Native Codex desktop/CLI per-turn interception, a full coding workspace adapter, recovery from arbitrary missing host history, and interoperability with other hosts remain separate integration work. A successful reference-client experiment does not establish those capabilities.

For separate offline extraction and held-out A/B/C comparisons, see [continuity evaluation](../../docs/continuity-evaluation.md). Those experiments do not bind a live identity or adopt their candidates.
