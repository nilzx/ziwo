// The sealing module against Go's internal/sealed: files the Go build sealed
// (fixtures/, and fresh ones when a go command is there) open here, files
// sealed here open in the Go build, and the failures say what Go says.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { minPassphrase, open, seal, SealError } from "../../page/seal.mjs";
import { fixtures } from "./fixtures.mjs";
import { buildSealHelper, goSeal, haveGo, removeScratch, scratch, workerDir } from "./go.mjs";

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

describe("against the Go build, both ways", { skip: haveGo() ? false : "no go command" }, () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let bin;
  before(async () => {
    dir = await scratch("ziwo-seal-");
    bin = await buildSealHelper(dir);
  });
  after(() => removeScratch(dir));

  it("Go opens what is sealed here, an empty export too, and a 12-byte passphrase of four characters", async () => {
    for (const [p, k] of [[plain, pass], [new Uint8Array(0), pass], [enc.encode("{}\n"), "记忆口令"]]) {
      const r = goSeal(bin, "open", await seal(/** @type {Uint8Array} */ (p), /** @type {string} */ (k)), /** @type {string} */ (k));
      assert.ok(r.ok, r.ok ? "" : r.error);
      assert.deepEqual(new Uint8Array(r.out), p);
    }
  });

  it("opens here what Go seals now", async () => {
    for (const p of [plain, new Uint8Array(0)]) {
      const r = goSeal(bin, "seal", p, pass);
      assert.ok(r.ok);
      assert.deepEqual(await open(r.out, pass), p);
    }
  });

  it("fails as Go fails: wrong passphrase, changed byte, not an export, short passphrase", async () => {
    const box = await seal(plain, pass);
    const ours = async (/** @type {Uint8Array} */ b, /** @type {string} */ k) => open(b, k).then(() => "", (e) => e.message);
    const go = (/** @type {Uint8Array} */ b, /** @type {string} */ k) => {
      const r = goSeal(bin, "open", b, k);
      return r.ok ? "" : r.error;
    };
    const bad = box.slice();
    bad[magic.length + 40] ^= 1;
    const notExport = enc.encode("not an export at all");
    for (const [b, k] of [[box, "correct horse batterx"], [bad, pass], [box.subarray(0, box.length - 10), pass], [notExport, pass]]) {
      const want = go(/** @type {Uint8Array} */ (b), /** @type {string} */ (k));
      assert.notEqual(want, "");
      assert.equal(await ours(/** @type {Uint8Array} */ (b), /** @type {string} */ (k)), want);
    }
    const short = goSeal(bin, "seal", plain, "elevenchars");
    assert.equal(short.ok, false);
    await refused(() => seal(plain, "elevenchars"), "short-passphrase", short.ok ? "" : short.error);
  });

  it("the fixtures are what the Go build makes of the fixed strings", async () => {
    for (const f of fixtures) {
      const r = goSeal(bin, "open", await fixture(f.file), f.pass);
      assert.ok(r.ok);
      assert.equal(r.out.toString(), f.plain);
    }
  });
});
