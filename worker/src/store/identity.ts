import type { Db } from "./db";
import { sha256Hex } from "./ids";

// Immutable assignment of a stable owner. It is not a memory or a session.
export interface Identity {
  id: string;
  origin: "created" | "legacy";
  sourceInstance: string;
  establishedAt: number;
}

export const metaLegacySource = "identity_legacy_source";

export function validSource(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

export function parseIdentity(value: unknown): Identity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid identity assignment");
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || !/^zi_[a-f0-9]{32}(?:[a-f0-9]{32})?$/.test(r.id) ||
      (r.origin !== "created" && r.origin !== "legacy") || !validSource(r.sourceInstance) ||
      typeof r.establishedAt !== "number" || !Number.isSafeInteger(r.establishedAt) || r.establishedAt < 0) {
    throw new Error("invalid identity assignment");
  }
  if (r.origin === "created" && !/^zi_[a-f0-9]{32}$/.test(r.id)) throw new Error("invalid created identity");
  if (r.origin === "legacy" && r.id !== legacyID(r.sourceInstance)) throw new Error("identity does not match its legacy source");
  return { id: r.id, origin: r.origin, sourceInstance: r.sourceInstance, establishedAt: r.establishedAt };
}

export function legacyID(source: string): string {
  return "zi_" + sha256Hex("ziwo-legacy-identity-v1\0" + source);
}

export function readIdentity(db: Db): Identity | undefined {
  if (db.first(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'identity_assignment'`) === undefined) return undefined;
  const row = db.first(`SELECT record FROM identity_assignment WHERE singleton = 1`);
  return row === undefined ? undefined : parseIdentity(JSON.parse(String(row.record)));
}

export function insertIdentity(db: Db, identity: Identity): void {
  const checked = parseIdentity(identity);
  db.run(`INSERT INTO identity_assignment(singleton, record) VALUES(1, ?)`, JSON.stringify(checked));
}
