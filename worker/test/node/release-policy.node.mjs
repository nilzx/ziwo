import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseChannel, releasePlan } from "../../scripts/release-policy.mjs";

test("only matching version tag pushes publish, on the intended channel", () => {
  assert.deepEqual(releasePlan({ version: "0.3.0-rc.1", eventName: "push", refType: "tag", refName: "v0.3.0-rc.1" }),
    { version: "0.3.0-rc.1", channel: "next", prerelease: true, publish: true });
  assert.equal(releasePlan({ version: "0.3.0", eventName: "push", refType: "tag", refName: "v0.3.0" }).channel, "latest");
  for (const eventName of ["workflow_dispatch", "pull_request", undefined]) {
    assert.equal(releasePlan({ version: "0.3.0-rc.1", eventName, refType: "tag", refName: "v0.3.0-rc.1" }).publish, false);
  }
  assert.equal(releasePlan({ version: "0.3.0", eventName: "push", refType: "branch", refName: "main" }).publish, false);
  assert.throws(() => releasePlan({ version: "0.3.0-rc.1", eventName: "push", refType: "tag", refName: "v0.3.0" }), /exactly match/);
});

test("invalid versions cannot become a release channel or inject CI output", () => {
  for (const version of ["v0.3.0", "01.3.0", "0.3", "0.3.0-rc.01", "0.3.0-", "0.3.0+build", "0.3.0\n", "0.3.0\npublish=true", "$(echo test)", null]) {
    assert.throws(() => releaseChannel(version), /canonical SemVer/);
  }
  for (const version of ["0.3.0-rc.0", "0.3.0-alpha.2", "0.3.0-preview-x"]) assert.equal(releaseChannel(version), "next");
});
