// The sealed form of an export, byte for byte as Go's internal/sealed writes
// it: a fixed first line, a 16-byte salt, a 12-byte nonce, then the gzip of
// the export under AES-256-GCM with the first line as associated data, keyed
// by PBKDF2-SHA256 over 600,000 iterations.
//
// It runs unchanged in a browser (the admin page) and in Node (the admin
// script), on Web Crypto and CompressionStream, with no dependency. It never
// runs in the Worker: the platform refuses that many iterations, and the
// Worker is not meant to see an export it could open.

const encoder = new TextEncoder();

const magic = encoder.encode("ZIWO-EXPORT-1\n");
const saltLen = 16;
const nonceLen = 12;
const iterations = 600_000;

// The shortest passphrase seal accepts, counted as Go counts it: in bytes of
// UTF-8.
export const minPassphrase = 12;

// SealError carries Go's message, and a code the page translates.
export class SealError extends Error {
  /** @param {"short-passphrase" | "not-export" | "wrong-key" | "gzip"} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "SealError";
    this.code = code;
  }
}

const wrongKey = () => new SealError("wrong-key", "wrong passphrase, or the file was changed");

/** @param {Uint8Array | ArrayBuffer} b */
function bytes(b) {
  return b instanceof Uint8Array ? b : new Uint8Array(b);
}

/** @param {Uint8Array} data @param {CompressionStream | DecompressionStream} stream */
async function through(data, stream) {
  const out = new Blob([data]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** @param {string} passphrase @param {Uint8Array} salt */
async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * seal compresses plain and encrypts it under the passphrase.
 * @param {Uint8Array | ArrayBuffer} plain
 * @param {string} passphrase
 * @returns {Promise<Uint8Array>}
 */
export async function seal(plain, passphrase) {
  if (encoder.encode(passphrase).length < minPassphrase) {
    throw new SealError("short-passphrase", `the passphrase must be at least ${minPassphrase} characters`);
  }
  const packed = await through(bytes(plain), new CompressionStream("gzip"));
  const salt = crypto.getRandomValues(new Uint8Array(saltLen));
  const nonce = crypto.getRandomValues(new Uint8Array(nonceLen));
  const key = await deriveKey(passphrase, salt);
  const box = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: magic }, key, packed));
  const out = new Uint8Array(magic.length + saltLen + nonceLen + box.length);
  out.set(magic, 0);
  out.set(salt, magic.length);
  out.set(nonce, magic.length + saltLen);
  out.set(box, magic.length + saltLen + nonceLen);
  return out;
}

/**
 * open reverses seal. Its failures are Go's: "not a ziwo export" when the
 * first line is not there, and one message for a wrong passphrase and for a
 * changed or shortened file.
 * @param {Uint8Array | ArrayBuffer} sealed
 * @param {string} passphrase
 * @returns {Promise<Uint8Array>}
 */
export async function open(sealed, passphrase) {
  const all = bytes(sealed);
  if (all.length < magic.length || magic.some((b, i) => all[i] !== b)) {
    throw new SealError("not-export", "not a ziwo export");
  }
  const rest = all.subarray(magic.length);
  if (rest.length < saltLen) throw wrongKey();
  const key = await deriveKey(passphrase, rest.subarray(0, saltLen));
  const body = rest.subarray(saltLen);
  if (body.length < nonceLen) throw wrongKey();
  let packed;
  try {
    packed = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: body.subarray(0, nonceLen), additionalData: magic },
      key,
      body.subarray(nonceLen),
    );
  } catch {
    throw wrongKey();
  }
  const zipped = new Uint8Array(packed);
  // Only a sealer that knew the passphrase can get here with something else.
  if (zipped.length < 2 || zipped[0] !== 0x1f || zipped[1] !== 0x8b) throw new SealError("gzip", "gzip: invalid header");
  try {
    return await through(zipped, new DecompressionStream("gzip"));
  } catch (err) {
    throw new SealError("gzip", `gzip: ${err instanceof Error ? err.message : String(err)}`);
  }
}
