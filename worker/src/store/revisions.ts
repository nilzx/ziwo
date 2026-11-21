import type { Db } from './db';

// Session bookkeeping and reads do not change the material delivered by sync.
export const materialKinds = "kind IN ('remember', 'amend', 'erase', 'reflect', 'restore')";
export const revisionSchema = `CREATE INDEX IF NOT EXISTS events_material_revision ON events(seq) WHERE ${materialKinds};`;
export function materialRevision(db: Db): number {
  return Number(db.first(`SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE ${materialKinds}`)!.n);
}
