import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { retainCheckedTarball } from "../../scripts/checked-artifact.mjs";

test("retained release artifact preserves installed bytes and refuses replacement", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "ziwo-artifact-"));
  try {
    const tarball = path.join(scratch, "ziwo-memory-0.3.0-rc.1.tgz");
    const checked = Buffer.from("synthetic checked tarball bytes");
    await writeFile(tarball, checked);
    const destination = path.join(scratch, "retained");
    const metadata = await retainCheckedTarball(tarball, destination, "0.3.0-rc.1");
    assert.deepEqual(await readFile(path.join(destination, metadata.filename)), checked);
    assert.equal(metadata.integrity, `sha512-${createHash("sha512").update(checked).digest("base64")}`);
    assert.equal(await readFile(path.join(destination, "SHA256SUMS"), "utf8"), `${metadata.sha256}  ${metadata.filename}\n`);
    await writeFile(tarball, "different bytes");
    await assert.rejects(retainCheckedTarball(tarball, destination, "0.3.0-rc.1"), { code: "EEXIST" });
    assert.deepEqual(await readFile(path.join(destination, metadata.filename)), checked);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
