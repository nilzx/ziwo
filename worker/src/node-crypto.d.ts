// The part of node:crypto the store uses, as the Workers runtime provides it
// under nodejs_compat. Declared here so that the project needs no @types/node.
declare module "node:crypto" {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
  export function randomBytes(size: number): Uint8Array;
}
