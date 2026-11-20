# DeepSeek Harness MCP validation

On 2026-11-20, a live DeepSeek Harness Web test established basic MCP interoperability, but failed the per-turn synchronization and temporary-agent memory-isolation requirements. This integration is not ready for the identity/persona workflow. No test-server deployment followed.

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

## What needs to change

The connector's workspace filter is useful for limiting where tools appear. It cannot distinguish a principal conversation from a temporary agent in the same workspace. Likewise, letting the model choose a memory tool does not enforce a check before every response.

The inspected connector source forwards tool definitions and results, but no forwarding of the server-wide MCP `instructions` was found. Tool descriptions and `get_context` guidance were sufficient for initial loading in this sample. Missing instructions alone have not been established as the cause of either failure; adding a prompt would not create an execution-level guarantee.

A dsh adapter should implement the existing [binding](identity-bindings.md) and [turn synchronization](turn-sync.md) contracts: derive the persistent conversation identity in trusted host code, reject rebinding, load and acknowledge the current persona and memory changes before generation, and fail closed when loading fails. Temporary agents must have no parent Ziwo tool channel; persona evaluators need a separately scoped read-only channel. Ordinary memories must not change persona versions.

The [Codex adapter](../adapters/codex/README.md) implements a separate host path. Its validation does not transfer to dsh merely because both clients can call the same MCP tools.
