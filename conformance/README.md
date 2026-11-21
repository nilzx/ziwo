# MCP conformance checks

This source-checkout suite groups Ziwo's synthetic service tests by the
[version 1 capability contract](../docs/mcp-client-contract-v1.md). It uses no
model, personal memory, API key or remote instance by default. Install the
Worker's dependencies first (`npm ci` in `worker/`).

```sh
node conformance/run.mjs --list
node conformance/run.mjs --groups ordinary,sync --report /tmp/ziwo-conformance.json
node conformance/run.mjs --report /tmp/ziwo-all-groups.json
# Equivalent, from worker/:
npm run test:conformance -- --groups trust,isolation
```

Groups are `ordinary`, `sync`, `trust` and `isolation`; the default selects all.
Unknown or duplicate groups and unknown arguments fail. Reports contain the
contract version, timestamp, selected groups, evidence category, result and
underlying test files. Dependencies run once per invocation; any failing file
fails every case mapped to it. This is file-level aggregation, not separate
execution of each capability assertion. Unselected cases are `not-run`.
Failures or blocked subprocesses produce a nonzero exit code. Run the listed
test files directly for detailed diagnostics.

`server-observed` checks exercise the local service; `simulated-host` checks
exercise test doubles, including the existing Codex gateway host fixture.
Neither is proof of actual native-client interoperability or universal host
enforcement. Real-client and connector evidence is recorded separately in the
[validation matrix](../docs/mcp-client-validation.md).

## Read-only synthetic endpoint probe

Use a designated empty or small **synthetic** fixture whose initial feed fits
one page. Supply its fixed token in an environment variable, never an argument
or committed file. The probe does not create, remember, adopt or delete data.

```sh
node conformance/probe.mjs \
  --endpoint http://127.0.0.1:8787/synthetic-fixture/mcp \
  --token-env ZIWO_CONFORMANCE_TOKEN \
  --report /tmp/ziwo-probe.json
```

Loopback is the default restriction. A remote fixture requires explicit
`--remote` and HTTPS. Redirects and URL credentials are rejected. Calls have a
10-second timeout. A failed probe exits nonzero and does not create a success
report. Keep reports from separate runs at distinct paths to avoid mistaking an
older artifact for the latest result.

The probe checks legacy MCP initialization, discovery, text compatibility and
initial/empty `sync_context` reads. It does not certify paging, native OAuth
login, host gates or model behavior. Reports exclude tokens, cursors and memory
contents. Programmatic callers may import `probe` or `probeFromEnv` from
`probe.mjs`; the latter takes an environment-variable name instead of a token.

## Other services and hosts

The generic dsh connector has its own source-checkout tests. Its inventory MCP
fixture uses apples, pears and warehouse cursors, without Ziwo tools or persona
formats. Those tests cover pagination, empty deltas, independent chats, context
loss and explicit errors over real stdio with a simulated host. Real dsh module
tests and optional preparation-admission build checks provide separate host
evidence. A configured capability profile records requirements, not certification.

For another client, first inventory all tool connections without a model call.
Ignoring user configuration alone may still inherit desktop application tools.
Disable unrelated apps/plugins, remove inherited desktop connection variables,
and verify the final connection list before using synthetic data. Stop if the
designated tool is unavailable; never fall back to a similarly named personal
connection. Budget model calls explicitly and retain raw logs privately.

The H01–H09 requirements concern physical host behavior. Their `case_ids` are
empty: related service and simulation cases provide partial evidence only and
cannot independently pass a host requirement. Each requires external evidence
from the intended host and integration. In particular, TRUST-02 covers a
simulated gateway's refresh, blocking and context-loss behavior; it does not
exercise steering, a scoped permission executor or the exact actual model input.
ISOL-02 exercises a simulated helper boundary, not actual host isolation.
