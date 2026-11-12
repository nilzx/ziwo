import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

// The one object of the directory: its name within its namespace.
export const directoryName = "directory";

export interface Listed {
  name: string;
  createdAt: number; // unix milliseconds
}

// An admin secret set on the admin page, as the directory keeps it: a random
// salt and the SHA-256 of the salt and the secret, both as hex. Never the
// secret itself.
export interface StoredSecret {
  salt: string;
  hash: string;
}

// What the directory knows of the admin secret set on the page: the one set,
// if any, and whether setting one from the page is closed for good.
export interface SecretRecord {
  stored?: StoredSecret;
  closed: boolean;
}

// Why setting from the page was closed: a secret was set there, a dashboard
// secret that counts was seen, or a memory was registered.
export type ClosedBy = "page" | "dashboard" | "memory";

// Directory lists the memories of a deployment: each one's name and when it
// was created or brought back. It is a list, not an authority: whether a
// memory exists is decided by the memory's own object, and a memory missing
// from the list (one created before the list existed, or whose registration
// failed) is served all the same.
//
// It also keeps the admin secret set on the admin page, while no dashboard
// secret counts (admin.ts, adminSecretState), and the record that setting
// one from the page is closed for good. Only the admin API and the consent
// page reach it, never a request to a memory.
export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS memories (
         name       TEXT PRIMARY KEY,
         created_at INTEGER NOT NULL
       ) STRICT, WITHOUT ROWID`,
    );
    // At most one row each.
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS admin_secret (
         id     INTEGER PRIMARY KEY CHECK (id = 1),
         salt   TEXT NOT NULL,
         hash   TEXT NOT NULL,
         set_at INTEGER NOT NULL
       ) STRICT`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS setup_closed (
         id        INTEGER PRIMARY KEY CHECK (id = 1),
         closed_at INTEGER NOT NULL,
         closed_by TEXT NOT NULL
       ) STRICT`,
    );
  }

  // register records a memory. A name already listed keeps its first time.
  // A memory registered closes setting the admin secret from the page.
  register(name: string, at: number): void {
    this.ctx.storage.sql.exec(`INSERT INTO memories(name, created_at) VALUES(?, ?) ON CONFLICT(name) DO NOTHING`, name, at);
    this.close(at, "memory");
  }

  // unregister takes a deleted memory off the list, and says whether it was
  // on it.
  unregister(name: string): boolean {
    return this.ctx.storage.sql.exec(`DELETE FROM memories WHERE name = ? RETURNING name`, name).toArray().length > 0;
  }

  // list returns every memory listed, by name.
  list(): Listed[] {
    return this.ctx.storage.sql
      .exec<{ name: string; created_at: number }>(`SELECT name, created_at FROM memories ORDER BY name`)
      .toArray()
      .map((r) => ({ name: r.name, createdAt: r.created_at }));
  }

  // adminSecret returns the admin secret set on the page, if any, and
  // whether setting one there is closed. A directory that lists a memory is
  // closed even without the record: it predates the record.
  adminSecret(): SecretRecord {
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ salt: string; hash: string }>(`SELECT salt, hash FROM admin_secret WHERE id = 1`).toArray()[0];
    const out: SecretRecord = { closed: this.isClosed() };
    if (row !== undefined) out.stored = { salt: row.salt, hash: row.hash };
    return out;
  }

  // setIfOpen keeps an admin secret set on the page, unless one is kept
  // already ("taken") or setting is closed ("closed"), and closes setting
  // for good. One method, run without interleaving, so that of two requests
  // at once exactly one sets it. The caller has checked the rest of the
  // rules (no dashboard secret counts; the version is new).
  setIfOpen(secret: StoredSecret, at: number): "set" | "taken" | "closed" {
    const sql = this.ctx.storage.sql;
    if (sql.exec(`SELECT 1 FROM admin_secret WHERE id = 1`).toArray().length > 0) return "taken";
    if (this.isClosed()) return "closed";
    sql.exec(`INSERT INTO admin_secret(id, salt, hash, set_at) VALUES(1, ?, ?, ?)`, secret.salt, secret.hash, at);
    this.close(at, "page");
    return "set";
  }

  // dashboardRules is told that a dashboard secret that counts was seen: it
  // takes the place of the one set on the page, which is erased, and setting
  // from the page is closed for good.
  dashboardRules(at: number): void {
    this.ctx.storage.sql.exec(`DELETE FROM admin_secret`);
    this.close(at, "dashboard");
  }

  // close records, once and for good, that setting from the page is closed.
  private close(at: number, by: ClosedBy): void {
    this.ctx.storage.sql.exec(`INSERT INTO setup_closed(id, closed_at, closed_by) VALUES(1, ?, ?) ON CONFLICT(id) DO NOTHING`, at, by);
  }

  private isClosed(): boolean {
    const sql = this.ctx.storage.sql;
    return (
      sql.exec(`SELECT 1 FROM setup_closed WHERE id = 1`).toArray().length > 0 ||
      sql.exec(`SELECT 1 FROM memories LIMIT 1`).toArray().length > 0
    );
  }
}
