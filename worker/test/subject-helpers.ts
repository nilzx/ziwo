// Helpers for the tests of subjects. The names and descriptions are made up;
// assertions look at ids, figures and fixed words.

import { expect } from "vitest";
import type { Store } from "../src/store/store";
import type { Memory } from "../src/store/types";
import { get, t0 } from "./helpers";

// rem writes a fragment through the store, under subject when one is given,
// and returns what the store answered.
export function rem(
  s: Store, sess: string, gist: string, subject?: string, at = t0,
): { id: string; dup: boolean; subject?: { id: string; started: boolean } } {
  return s.remember(at, {
    sessionId: sess, moment: "other", source: "lived", importance: 0.5, gist, body: "正文 " + gist,
    ...(subject === undefined ? {} : { subject }),
  });
}

// fragment writes a fragment under subject and returns its id.
export function fragment(s: Store, sess: string, gist: string, subject?: string, at = t0): string {
  const r = rem(s, sess, gist, subject, at);
  expect(r.dup, "unexpectedly a duplicate").toBe(false);
  return r.id;
}

// subjectOf is the head an item is filed under, "" for none.
export function subjectOf(s: Store, id: string): string {
  return get(s, id).subject;
}

// subjectItems counts the subject items, in any standing.
export function subjectItems(storage: DurableObjectStorage): number {
  return storage.sql.exec<{ c: number }>(`SELECT count(*) AS c FROM memories WHERE kind = 'subject'`).one().c;
}

// subjectRows reads the subjects table, by head.
export function subjectRows(storage: DurableObjectStorage): { id: string; n: number; active_at: number }[] {
  return storage.sql.exec<{ id: string; n: number; active_at: number }>(`SELECT id, n, active_at FROM subjects ORDER BY n`).toArray();
}

// eventOf reads the payload of the remember event of a memory.
export function eventOf(storage: DurableObjectStorage, id: string): Record<string, unknown> {
  const row = storage.sql
    .exec<{ payload: string }>(`SELECT payload FROM events WHERE kind = 'remember' AND json_extract(payload, '$.id') = ?`, id)
    .one();
  return JSON.parse(row.payload) as Record<string, unknown>;
}

// members returns the ids of the items filed under a head, in row order.
export function members(storage: DurableObjectStorage, head: string): string[] {
  return storage.sql
    .exec<{ id: string }>(`SELECT id FROM memories WHERE subject = ? AND kind <> 'subject' ORDER BY n`, head)
    .toArray()
    .map((r) => r.id);
}

export function ids(ms: Memory[]): string[] {
  return ms.map((m) => m.id);
}
