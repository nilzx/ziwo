// Helpers for the ports of amend_test.go and reflect_test.go.

import { expect } from "vitest";
import { EntryError } from "../src/store/errors";
import type { Entry } from "../src/store/reflect";
import type { Store } from "../src/store/store";
import { dump, minute, t0 } from "./helpers";

// replays checks that the derived tables are what replaying the log gives.
export function replays(s: Store, storage: DurableObjectStorage): void {
  const before = dump(s, storage);
  s.rebuild();
  expect(dump(s, storage), "replaying the log gives a different memory").toBe(before);
}

export function amend(s: Store, sess: string, action: string, id: string, importance = 0): void {
  s.amend(t0, sess, action, id, importance, "the user asked");
}

export function recentIDs(s: Store): string[] {
  return s.recent(s.clock(), 100).map((m) => m.id);
}

export const hold = 15 * minute;

export function begin(s: Store, sess: string): string {
  return s.beginReflect(t0, sess, hold);
}

// entry fills in what an entry leaves out, as Go's zero values.
export function entry(e: Partial<Entry> & { kind: string; gist: string }): Entry {
  return {
    body: "", outcome: "", feeling: "", intensity: 0, lesson: "", people: [], pointer: "", importance: 0,
    about: "", context: "", from: [], ref: "", milestone: false, ...e,
  };
}

// ent is Go's ent: an entry with a body and importance 0.5.
export function ent(kind: string, gist: string, ...from: string[]): Entry {
  return entry({ kind, gist, body: "正文：" + gist, importance: 0.5, from });
}

// reflectOn runs one whole round and returns the ids it wrote.
export function reflectOn(s: Store, sess: string, entries: Entry[], ...passed: string[]): string[] {
  return s.finishReflect(t0, sess, begin(s, sess), entries, passed);
}

// refused runs a round that must be turned down over an entry, and returns
// why.
export function refused(s: Store, sess: string, ...entries: Entry[]): string {
  const before = s.counts().memories;
  let caught: unknown;
  try {
    s.finishReflect(t0, sess, begin(s, sess), entries, []);
  } catch (err) {
    caught = err;
  }
  expect(caught, `round with ${entries.length} entries: want it refused over an entry`).toBeInstanceOf(EntryError);
  expect(s.counts().memories, "a refused round wrote memories").toBe(before);
  return (caught as EntryError).message;
}

// thrown returns what fn throws, or fails.
export function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  expect.fail("it did not throw");
}

// latin1 spells bytes one character each, so that a string's UTF-8 can be
// looked for in a blob.
function latin1(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return s;
}

// tablesHolding returns the names of the tables, the keyword index's own
// among them, that hold any of the given strings in any column, as text or
// as UTF-8 in a blob.
export function tablesHolding(storage: DurableObjectStorage, marks: string[]): string[] {
  const tables = storage.sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'memories_fts'
         AND substr(name, 1, 4) <> '_cf_' AND substr(name, 1, 7) <> 'sqlite_'`,
    )
    .toArray()
    .map((r) => r.name);
  const found = new Set<string>();
  for (const t of tables) {
    for (const row of storage.sql.exec(`SELECT * FROM "${t}"`)) {
      for (const v of Object.values(row)) {
        for (const m of marks) {
          if (typeof v === "string" ? v.includes(m) : v instanceof ArrayBuffer && latin1(new Uint8Array(v)).includes(latin1(new TextEncoder().encode(m)))) {
            found.add(t);
          }
        }
      }
    }
  }
  return [...found].sort();
}
