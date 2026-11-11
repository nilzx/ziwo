// A thin, typed layer over the Durable Object's synchronous SQLite API.

import { metaClock } from "./schema";

export type Binding = string | number | null | ArrayBuffer;
export type Row = Record<string, SqlStorageValue>;

export class Db {
  constructor(readonly sql: SqlStorage) {}

  // run executes a statement and consumes its cursor, so a statement with a
  // RETURNING clause or several statements in one string run to the end.
  run(query: string, ...args: Binding[]): void {
    this.sql.exec(query, ...args).toArray();
  }

  all(query: string, ...args: Binding[]): Row[] {
    return this.sql.exec(query, ...args).toArray();
  }

  // first returns the first row, or undefined when there is none.
  first(query: string, ...args: Binding[]): Row | undefined {
    const r = this.sql.exec(query, ...args).next();
    return r.done ? undefined : r.value;
  }

  getMeta(key: string): string | undefined {
    const r = this.first(`SELECT value FROM meta WHERE key = ?`, key);
    return r === undefined ? undefined : text(r.value);
  }

  setMeta(key: string, value: string): void {
    this.run(
      `INSERT INTO meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  // clock reads the experience clock: the number of moments written as they
  // happened. It is one row of meta, kept by apply, so no read or write has
  // to scan memories for MAX(ord).
  clock(): number {
    const v = this.getMeta(metaClock);
    if (v === undefined) return 0;
    const c = Number(v);
    if (!Number.isSafeInteger(c) || c < 0) throw new Error(`meta: unreadable clock ${JSON.stringify(v)}`);
    return c;
  }

  setClock(c: number): void {
    this.setMeta(metaClock, String(c));
  }

  // sessionActive marks a session as active at the given time.
  sessionActive(session: string, at: number): void {
    if (session === "") return;
    this.run(`UPDATE sessions SET last_active_at = MAX(last_active_at, ?) WHERE id = ?`, at, session);
  }
}

// Column readers. They throw when a column holds something the schema rules
// out, rather than letting a wrong type travel on.

export function num(v: SqlStorageValue | undefined): number {
  if (typeof v !== "number") throw new Error(`sql: expected a number, got ${typeof v}`);
  return v;
}

// realOrZero reads a nullable REAL; NULL reads as 0, as sql.NullFloat64 does.
export function realOrZero(v: SqlStorageValue | undefined): number {
  return v === null ? 0 : num(v);
}

export function text(v: SqlStorageValue | undefined): string {
  if (typeof v !== "string") throw new Error(`sql: expected text, got ${typeof v}`);
  return v;
}

export function flag(v: SqlStorageValue | undefined): boolean {
  return num(v) !== 0;
}

export function blob(v: SqlStorageValue | undefined): ArrayBuffer {
  if (!(v instanceof ArrayBuffer)) throw new Error(`sql: expected a blob`);
  return v;
}

// bit binds a boolean the way Go's SQLite driver does: as 1 or 0.
export function bit(b: boolean): number {
  return b ? 1 : 0;
}

// isConstraint reports whether err is SQLite refusing a write on a constraint,
// such as a duplicate id. The platform surfaces it only in the message.
export function isConstraint(err: unknown): boolean {
  return err instanceof Error && err.message.includes("SQLITE_CONSTRAINT");
}
