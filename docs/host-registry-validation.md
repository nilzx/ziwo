# Host registry validation

Run the synthetic management check from a source checkout against a local Worker:

```sh
export ZIWO_URL=http://127.0.0.1:8787
# Supply ZIWO_ADMIN_SECRET privately; do not place it in committed files.
node worker/scripts/check-host-registry.mjs --manifest /path/to/new-run.json
```

The check creates a unique test host, verifies lookup and idempotent registration,
explicitly rotates its credential, and revokes that exact host. It verifies that
the old credential stops working. It creates no memories, adopts no persona and
calls no model. A private manifest is written before registration and contains
operation identifiers and progress, never credentials. Existing files are not
overwritten by a new run.

Remote targets require HTTPS and the explicit `--remote` flag. Use a designated
test deployment. The script preserves a failed run's manifest instead of guessing
whether a request committed. Resume it using the same origin and file:

```sh
node worker/scripts/check-host-registry.mjs --manifest /path/to/new-run.json --resume
```

If registration committed but the token was lost, inspect the saved host metadata
and explicitly allow credential recovery with `--rotate-lost-token` on resume.
The operation ID must remain unchanged. Metadata mismatch stops before cleanup.
Revocation preserves host and binding history; it does not delete unknown objects.
Completed cleanup and a completely observed smoke run are reported separately if
a previous process lost its credential before the final authentication check.

API/CLI regression coverage is in `worker/test/host-registry.test.ts` and
`worker/test/node/host-cli.node.mjs`. Recovery and target-safety checks for the
script are in `worker/test/node/host-smoke.node.mjs`. Connector package validation lives in that
repository's `npm run test:package` command. Real model tests are separate,
explicitly scoped experiments with their own subjects, approvals and budgets.
