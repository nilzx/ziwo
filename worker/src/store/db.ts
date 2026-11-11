// A thin, typed layer over the Durable Object's synchronous SQLite API.

import { metaClock } from "./schema";

export type Binding = string | number | null | ArrayBuffer;

// A list bound as one JSON parameter: the platform allows at most 100 bound
// parameters in a query, so a list of ids is never spread over placeholders.
export const inList = `(SELECT value FROM json_each(?))`;
export type Row = Record<string, SqlStorageValue>;

// Usage is what the platform bills for: rows read and rows written, added up
// over every cursor the store consumed.
export interface Usage {
  rowsRead: number;
  rowsWritten: number;
}

export class Db {
  private used: Usage = { rowsRead: 0, rowsWritten: 0 };

  constructor(readonly sql: SqlStorage) {}

  // usage returns the totals since the last reset.
  usage(): Usage {
    return { ...this.used };
  }

  resetUsage(): void {
    this.used = { rowsRead: 0, rowsWritten: 0 };
  }

  // tally adds what a cursor has read and written so far. The platform has
  // no object-wide counter, so every cursor must pass through here.
  private tally(c: SqlStorageCursor<Row>): void {
    this.used.rowsRead += c.rowsRead;
    this.used.rowsWritten += c.rowsWritten;
  }

  // run executes a statement and consumes its cursor, so a statement with a
  // RETURNING clause or several statements in one string run to the end.
  run(query: string, ...args: Binding[]): void {
    this.all(query, ...args);
  }

  all(query: string, ...args: Binding[]): Row[] {
    const c = this.sql.exec<Row>(query, ...args);
    try {
      return c.toArray();
    } finally {
      this.tally(c);
    }
  }

  // first returns the first row, or undefined when there is none. It is for
  // statements that give at most one row.
  first(query: string, ...args: Binding[]): Row | undefined {
    const c = this.sql.exec<Row>(query, ...args);
    try {
      const r = c.next();
      if (r.done) return undefined;
      // Run the statement to its end, so that none is left open part-way.
      while (!c.next().done);
      return r.value;
    } finally {
      this.tally(c);
    }
  }

  // each calls fn with one row at a time, for reads too large to hold.
  each(query: string, args: Binding[], fn: (r: Row) => void): void {
    const c = this.sql.exec<Row>(query, ...args);
    try {
      for (const r of c) fn(r);
    } finally {
      this.tally(c);
    }
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
