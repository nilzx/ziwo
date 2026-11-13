// The sealing module: files sealed by the earlier Go implementation
// (fixtures/) open here, and the failures say what that implementation said.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { minPassphrase, open, seal, SealError } from "../../page/seal.mjs";
import { fixtures } from "./fixtures.mjs";
import { workerDir } from "./go.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();
const magic = "ZIWO-EXPORT-1\n";
const pass = "correct horse battery";
const plain = enc.encode("用户给我看了他的猫 plainmark7q\n".repeat(200));
const wrong = "wrong passphrase, or the file was changed";

/** @param {Uint8Array} hay @param {string} needle */
const holds = (hay, needle) => Buffer.from(hay).includes(Buffer.from(needle));

/** @param {() => Promise<unknown>} fn @param {string} code @param {string} message */
async function refused(fn, code, message) {
  await assert.rejects(fn, (/** @type {unknown} */ err) => {
    assert.ok(err instanceof SealError, `a SealError, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.message, message);
    return true;
  });
}

const fixture = (/** @type {string} */ file) => readFile(path.join(workerDir, "test/node/fixtures", file));

describe("files the Go build sealed (fixtures)", () => {
  for (const f of fixtures) {
    it(`opens ${f.file}`, async () => {
      const got = await open(await fixture(f.file), f.pass);
      assert.equal(dec.decode(got), f.plain);
    });
  }

  it("refuses a wrong passphrase with Go's message", async () => {
    const box = await fixture(fixtures[0].file);
    await refused(() => open(box, `${fixtures[0].pass}x`), "wrong-key", wrong);
    await refused(() => open(box, ""), "wrong-key", wrong);
  });

  it("refuses a changed byte anywhere after the first line, and a file cut short, with Go's message", async () => {
    const box = await fixture(fixtures[0].file);
    // In the salt, the nonce, the sealed text and the tag.
    for (const at of [magic.length, magic.length + 15, magic.length + 16, magic.length + 27, magic.length + 28, Math.floor(box.length / 2), box.length - 1]) {
      const bad = Buffer.from(box);
      bad[at] ^= 1;
      await refused(() => open(bad, fixtures[0].pass), "wrong-key", wrong);
    }
    for (const keep of [box.length - 1, box.length - 16, magic.length + 28, magic.length + 27, magic.length + 16, magic.length + 15, magic.length]) {
      await refused(() => open(box.subarray(0, keep), fixtures[0].pass), "wrong-key", wrong);
    }
  });

  it("refuses what is not an export, as Go does", async () => {
    const box = await fixture(fixtures[0].file);
    const changedFirstLine = Buffer.from(box);
    changedFirstLine[3] ^= 1;
    for (const notOne of [enc.encode("SQLite format 3\x00 something else"), new Uint8Array(0), enc.encode("ZIWO-EXPORT-1"), changedFirstLine]) {
      await refused(() => open(notOne, fixtures[0].pass), "not-export", "not a ziwo export");
    }
  });
});

describe("sealing here", () => {
  it("round-trips, holds nothing in the clear, and differs every time", async () => {
    const box = await seal(plain, pass);
    assert.equal(dec.decode(box.subarray(0, magic.length)), magic);
    assert.equal(holds(box, "plainmark7q"), false);
    assert.equal(holds(box, "猫"), false);
    assert.deepEqual(await open(box, pass), plain);
    const again = await seal(plain, pass);
    assert.notDeepEqual(again, box);
    // magic, salt 16, nonce 12, then the gzip under GCM with its 16-byte tag
    assert.ok(box.length < plain.length / 10, `compressed: ${box.length} of ${plain.length}`);
  });

  it("takes an ArrayBuffer as well as bytes, and leaves its input as it was", async () => {
    const copy = plain.slice();
    const box = await seal(copy.buffer, pass);
    assert.deepEqual(copy, plain);
    assert.deepEqual(await open(box.buffer, pass), plain);
  });

  it("refuses a passphrase shorter than 12 bytes, as Go counts it", async () => {
    assert.equal(minPassphrase, 12);
    for (const short of ["", "short", "elevenchars", "记忆口"]) {
      await refused(() => seal(plain, short), "short-passphrase", "the passphrase must be at least 12 characters");
    }
    for (const enough of ["twelve chars", "记忆口令"]) {
      assert.deepEqual(await open(await seal(plain, enough), enough), plain);
    }
  });

  it("seals an empty export", async () => {
    const box = await seal(new Uint8Array(0), pass);
    assert.equal((await open(box, pass)).length, 0);
  });

  it("refuses a wrong passphrase and a changed byte of its own files", async () => {
    const box = await seal(plain, pass);
    await refused(() => open(box, "correct horse batterx"), "wrong-key", wrong);
    const bad = box.slice();
    bad[bad.length >> 1] ^= 0x80;
    await refused(() => open(bad, pass), "wrong-key", wrong);
  });
});
