// The part of node:crypto the store uses, as the Workers runtime provides it
// under nodejs_compat. Declared here so that the project needs no @types/node.
declare module "node:crypto" {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
  interface Hmac {
    update(data: string): Hmac;
    digest(encoding: 'base64url'): string;
  }
  export function createHmac(algorithm: 'sha256', key: string): Hmac;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function randomBytes(size: number): Uint8Array;
}
