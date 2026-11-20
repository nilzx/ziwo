# DeepSeek Harness MCP validation

## Current local acceptance — 2026-11-20

The confirmed capability-tier scope now passes local validation: explicit
activation, immutable subject binding, approved same-subject persona revisions,
per-turn incremental delivery, crash-safe history initialization, independent
evaluation, restored-instance authorization, dual-subject isolation, and code
work after refresh. Tests use the qianwen `deepseek-v4.1-flash` route with
GPT-6.1 Terra organizing and independently reviewing synthetic evidence.

The Worker passed 549 tests, Node tooling 161, and the connector 158. A true
post-commit process kill resumed without duplicate history. A host-query fault
injection with only a summary retained explicit gaps and notices without
inventing a reconstructed memory. System-prompt replacement no longer rejects
an intact memory delta; actual context loss still requires reloading.

The strongest tier requires a trusted host's pre-construction admission hook.
Stock dsh 0.2.2-rc.5 lacks it. An optional generic host patch and reproducible
isolated builder are supplied in the connector repository. In a complete
isolated host, the ordinary fork business API persisted 219 inherited events
with the actual parent, and the child resumed the original subject/persona with
an independent refresh. This is not a browser-click test or an upstream/global
installation. See [capability levels](mcp-capabilities.md) for exact boundaries.

Test-server deployment remains pending Cloudflare reauthentication. No live
Worker was replaced. The earlier sections below are historical samples and
retain their original failures and narrower acceptance scopes.

## Earlier generic turn controller follow-up — 2026-11-20

The first controller test added an opt-in, server-neutral `turnContext` controller to
`dsh-mcp-connector`. Ziwo supplies structured session/identity metadata alongside
the existing `get_context` text. See [capability levels](mcp-capabilities.md) for
the exact contract and configuration.

Using the qianwen `deepseek-v4.1-flash` route in the real dsh Web service, the
controller refreshed an activated conversation before natural memory questions,
an unrelated arithmetic question, and a temporary-agent task. A correction in
conversation A was visible in B. The temporary child had no Ziwo tools or server
instructions, and its actual connector-status call returned `servers: []`.

A stopped local Worker caused a five-second refresh timeout with no model
generation. The final implementation displayed an explicit error asking the
user to restore the connection and resend; dsh does not retain the rejected user
batch as a normal conversation message. After recovery, browser reload and a
connector-module reload, the same memory session was reused and the current
answer was correct. This was **not** a restart of the user's dsh server.

The Worker suite passed 513 tests; the connector suite passed 89 tests, including
an installed-dsh storage-name contract check. GPT-6.1 Terra independently audited
the synthetic logs and added connector regression tests. Steering, concurrency,
state loss and several error paths have programmatic tests; the real Web sample
does not establish every executor mode, fork/restore path, or long-term behavior.

This closes the observed model-dependent refresh gap for this configured memory
summary path. It does not provide ordinary MCP persona activation, a complete
acknowledged memory change feed, or authoritative host conversation binding.
The complete Ziwo contract is still pending for this path, so no test-server
deployment was performed. The sections below retain historical evidence.


## Earlier experiments

On 2026-11-20, an initial DeepSeek Harness Web test exposed defects in both the MCP connector and Ziwo. A follow-up fixed generic MCP instruction forwarding, delegation scope, and memory refresh semantics. Natural cross-conversation refresh and temporary-agent tool isolation improved, but strict refresh on every user turn is still not reliable. No test-server deployment followed.

## Environment and scope

- DeepSeek Harness (dsh) `0.2.2-rc.5`, standard agent preset, Chrome Web interface.
- `@nilzx/dsh-mcp-connector` `0.1.4`, limited to a new test workspace.
- Model route: `qianwen-token-plan / deepseek-v4.1-flash`, low reasoning. Request metadata for both root conversations, the child agent, and automatic titles confirmed this route; the official DeepSeek route was not used.
- Current development branch of Ziwo under local Wrangler, without Workers AI embeddings. Only new synthetic memories were used.
- A temporary loopback bridge forwarded MCP requests to one fixed synthetic memory per route, supplied its token, and recorded tool outcomes. It did not inject context, change tool results, implement synchronization, or expose admin endpoints.

The run contained seven root user turns and one child task: 25 recorded model steps, plus two automatic title requests. There were 17 tool calls, including 14 MCP calls; all MCP calls returned successful tool results. A successful tool call does not imply the integration meets the behavioral requirements below.

## Observed results

| Check | Result | Evidence |
| --- | --- | --- |
| Write and read back | Passed | A1 called `get_context`, `remember`, and `expand`; the synthetic marker was stored and read back. |
| Natural recall in a fresh conversation | Passed in this sample | A2 received only a question, with neither the answer nor a request to use tools. It called `get_context` and `expand`, then returned the stored marker. |
| Memory correction | Passed | A1 called `amend` and verified the new record with `expand`. |
| Automatic update in an existing conversation | **Failed** | After A1 corrected the location and marker, A2's next natural question caused no tool call and returned the obsolete values. |
| Explicit retrieval after correction | Passed | When explicitly asked to check memory, A2 called `recall` and `expand`, then returned the revised values. |
| Temporary-agent memory isolation | **Failed** | A fresh child had no old or new marker in its task input, but inherited all eight Ziwo tools. Its actual `get_context` call succeeded and returned the synthetic memory. The child made no memory writes. |
| Browser reload and explicit retrieval | Passed | The same dsh conversation resumed after a full page reload. `get_context` and `recall` succeeded and returned the corrected record. This was not a service restart or backup restore. |

A separate protocol check rejected memory A's token at memory B with HTTP 401. This verifies server credential separation only. Cross-workspace model isolation, backup restoration, persona activation/revision, persistent identity binding, and long-term continuity were not validated by this run.

## Initial diagnosis (superseded by the follow-up below)

The connector's workspace filter is useful for limiting where tools appear. It cannot distinguish a principal conversation from a temporary agent in the same workspace. Likewise, letting the model choose a memory tool does not enforce a check before every response.

The inspected connector source forwards tool definitions and results, but no forwarding of the server-wide MCP `instructions` was found. Tool descriptions and `get_context` guidance were sufficient for initial loading in this sample. Missing instructions alone have not been established as the cause of either failure; adding a prompt would not create an execution-level guarantee.

The initial proposal to build a Ziwo-specific dsh adapter was premature. The user requires broad Agent/Harness interoperability. Standard MCP behavior and reusable connector capabilities must be fixed first; a separate Ziwo adapter for each Harness is not the default integration strategy.

## Follow-up: ownership and fixes

| Owner | Defect | Fix |
| --- | --- | --- |
| dsh MCP connector | Discarded server-wide `initialize.instructions` | Forward literal, attributed server instructions through the host's generic system-prompt API; filter by access scope and clear on disconnect. |
| Ziwo | `get_context` still said to load once per conversation | Align initialize instructions, tool description, and returned guidance on refreshing each subsequent user turn; accept `session_id` to retain the same memory session. Unknown IDs and IDs from another memory are rejected. IDs are not proof of ownership by a particular host conversation. |
| dsh MCP connector | Workspace scope alone let temporary children inherit personal-memory tools | Add generic per-server `delegation: deny`, enforced in tool visibility and dispatch. Apply the same access rules to status and management tools. No Ziwo tool names or lifecycle are hard-coded. |

The follow-up used the same qianwen model and a fresh local synthetic memory. A1 wrote a lantern at a pine tree with marker `M3Q6`; A2 recalled it naturally. After A1 corrected it to a clock tower with marker `T9N2`, A2's next natural question called `get_context` with its existing session and returned the new values. Browser reload retained the conversation and memory session, and a natural question refreshed successfully again.

A fresh child had no Ziwo memory tool definitions and no Ziwo server instructions. It did discover server metadata through the connector's global status tool, which prompted the additional management-scope fix. A second probe still used the old tool description after a hot reload and was not accepted as validation of that fix. A final fresh root/child pair used the new tool description: the child had no Ziwo tools and `mcp_connector_status` returned `{"servers":[]}`. This verifies the configured tool/metadata boundary in this sample, not complete historical-context isolation or arbitrary host enforcement.

**Still failed:** A2's two child-creation turns did not call `get_context`; the second made a `remember` call without refreshing first. Forwarding correct instructions improves behavior but does not enforce a pre-generation check. The current summary is bounded, not a complete change feed; related records still require recall/expansion. This run does not validate persona activation/revision, hard persistent-identity binding, or universal per-turn synchronization through ordinary MCP.

The ordinary eight-tool memory MCP surface and the newer identity/persona synchronization API remain distinct. Next work should expose a reusable MCP lifecycle and document required client capabilities, with ordinary MCP as the portability baseline and optional generic host enforcement where available. The [binding](identity-bindings.md) and [turn synchronization](turn-sync.md) rules remain the intended behavior; the existing [Codex implementation](../adapters/codex/README.md) is one validated client path, not a requirement to create a Ziwo-specific adapter for every client.

The follow-up contained eight root user turns and three child tasks: 31 recorded model steps plus three automatic title requests, with 20 tool calls. Six request headers, all 31 assistant-source records, and all three title routes matched the designated qianwen model. GPT-6.1 Terra independently audited the synthetic logs and connector regressions. The connector's 73 tests passed; Ziwo's 511 Worker tests passed, with 16 affected tests rerun after the final wording change, and type checking passed. The original dsh profile was restored byte-for-byte and both local fixture processes were stopped. Changes remain local and unreleased.
