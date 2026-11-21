# MCP client validation

Results as of 2026-11-21. These are bounded observations against the
[version 1 project contract](mcp-client-contract-v1.md), not official MCP
certifications. Connector changes are on the unreleased
`codex/r2-mcp-contract` branch, based on connector 0.2.2.

| Client or fixture | Ordinary MCP | Turn synchronization | Trusted lifecycle | Evidence limit |
| --- | --- | --- | --- | --- |
| dsh 0.2.2-rc.5, generic connector, optional isolated admission build | Passed in prior local/remote model runs; current connector core also read and wrote the shared local fixture | Confirmed B12 scope passed | Confirmed B12 scope passed with required host facilities | Stock dsh lacks the proposed preparation-admission capability; PTC rejects enforced refresh; not every browser/host entry point was tested |
| Native Codex CLI 0.171.0, ordinary Streamable HTTP MCP | Passed with fixed bearer and text tools in one isolated synthetic model session | Not implemented or validated by this ordinary MCP setup | Not implemented or validated by this ordinary MCP setup | No Ziwo-specific gateway; native OAuth, persistent resume and complete tool coverage were not tested in this run |
| Service-neutral inventory MCP fixture | Real stdio transport and connector controller passed | Pagination, empty delta, independent state, reload and failures passed with a simulated host | Not tested by this fixture | No Ziwo tool names or data structures; no model or real host enforcement claim |

See [the dsh evidence](dsh-mcp-validation.md) for the full scope and limitations
of the earlier real host/model runs. Existing Ziwo-specific Codex gateway tests
remain separate and are not counted as the second ordinary MCP client.

## Shared endpoint experiment

The current connector core read the synthetic observatory record and wrote a
second synthetic handoff record. Native Codex then retrieved both without being
given their answers in the prompt, wrote an explicitly fictional marker, and
expanded it to verify the write. The connector read that marker from the same
endpoint afterward. All five successful native MCP calls targeted only the
designated local test server. The connector core used simulated tool
registration; this exchange does not claim another real dsh model run.

The native test requested `gpt-6.1-terra` using the existing Codex login. Its
JSONL records did not independently report the effective model identifier.
Authentication used a synthetic fixed bearer. A separate read-only endpoint
probe passed legacy initialization, tool discovery, text compatibility and
initial/empty synchronization; a wrong bearer was rejected. OAuth and both
supported protocol generations passed existing local service tests. Those
service checks are not evidence that native Codex's OAuth login was exercised.

The successful native configuration disabled apps/plugins, removed inherited
desktop connection variables, ignored user configuration/rules for the model
run, and used an ephemeral isolated workspace. Before the model ran, a native
app-server status check showed no tools from disabled existing connections and
only the synthetic server with available tools. A failed earlier isolation
attempt is excluded: ignoring user configuration alone did not remove desktop
application tools. The validation procedure now requires a no-model connection
inventory before any model run, with no fallback to another similarly named
service. This is a tested invocation, not a guarantee for every Codex launch.

The exact synthetic memory was deleted after verification, and the management
endpoint returned 404. No remote object, persona proposal or adoption was
created. The existing test-server deployment was unchanged because R2 changes
the contract, validation tools and connector configuration, not Worker runtime
behavior.

## Regression and distribution checks

- Ziwo: 556 Worker tests and 168 Node tests passed, with zero skips; type checking
  passed. Ten grouped conformance cases passed with their declared evidence
  categories. Host requirements still need external observed evidence.
- Connector: 165 tests passed with zero skips on Node 22.23.5, including actual
  installed host modules and the isolated admission Session module.
- Connector package: actual pack and isolated install passed. This run omitted
  the optional host rebuild; the unchanged builder's Node 22/26 evidence remains
  in the R1 record.
- No package publication, upstream PR or deployment is implied by these checks.
