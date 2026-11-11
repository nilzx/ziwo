import { createHash, randomBytes } from "node:crypto";

// idAlphabet leaves out l, o, 0 and 1 so ids survive being read back by a
// model. It is the alphabet of Go's base32 encoding in store.go.
const idAlphabet = "abcdefghijkmnpqrstuvwxyz23456789";

// newID returns prefix followed by five random bytes in base32: eight
// characters, the same as the Go build's ids.
export function newID(prefix: string): string {
  return prefix + encodeID(randomBytes(5));
}

// encodeID is five bytes in base32 with the id alphabet: 40 bits, read five
// at a time from the most significant end.
export function encodeID(b: Uint8Array): string {
  if (b.length !== 5) throw new Error("an id is made of five bytes");
  let bits = 0n;
  for (const x of b) bits = (bits << 8n) | BigInt(x);
  let out = "";
  for (let shift = 35n; shift >= 0n; shift -= 5n) out += idAlphabet[Number((bits >> shift) & 31n)];
  return out;
}

// contentHash identifies what a memory says for finding retried writes: the
// first 16 bytes of SHA-256 over gist, NUL, body, in hex.
export function contentHash(gist: string, body: string): string {
  return createHash("sha256").update(gist + "\x00" + body).digest("hex").slice(0, 32);
}

// sha256Hex is the hex SHA-256 of s, encoded as UTF-8.
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
