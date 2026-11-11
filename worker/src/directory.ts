import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

// The one object of the directory: its name within its namespace.
export const directoryName = "directory";

export interface Listed {
  name: string;
  createdAt: number; // unix milliseconds
}

// Directory lists the memories of a deployment: each one's name and when it
// was created or brought back. It is a list, not an authority: whether a
// memory exists is decided by the memory's own object, and a memory missing
// from the list (one created before the list existed, or whose registration
// failed) is served all the same. Only the admin API reaches it, never a
// request to a memory.
export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS memories (
         name       TEXT PRIMARY KEY,
         created_at INTEGER NOT NULL
       ) STRICT, WITHOUT ROWID`,
    );
  }

  // register records a memory. A name already listed keeps its first time.
  register(name: string, at: number): void {
    this.ctx.storage.sql.exec(`INSERT INTO memories(name, created_at) VALUES(?, ?) ON CONFLICT(name) DO NOTHING`, name, at);
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
}
