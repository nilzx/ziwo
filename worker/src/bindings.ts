import type { Row } from "./store/db";

export interface ThreadBinding {
  harnessId: string;
  threadId: string;
  identityId: string;
  memory: string;
  instance: string;
  state: "bound_initializing" | "ready";
  parentThreadId: string | null;
  activationId: string;
  createdAt: number;
  updatedAt: number;
}
export interface BindingTarget { identityId: string; memory: string; instance: string }
export type BindingResult<T> = { value: T } | { error: string; status: 401 | 403 | 409 };

export const bindingSchema = `
CREATE TABLE IF NOT EXISTS harnesses (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS thread_bindings (
  harness_id TEXT NOT NULL, thread_id TEXT NOT NULL, identity_id TEXT NOT NULL,
  memory TEXT NOT NULL, instance TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('bound_initializing', 'ready')),
  parent_thread_id TEXT, activation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  restore_request TEXT, previous_instance TEXT,
  PRIMARY KEY(harness_id, thread_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS binding_owner_immutable BEFORE UPDATE ON thread_bindings
WHEN NEW.harness_id <> OLD.harness_id OR NEW.thread_id <> OLD.thread_id OR NEW.identity_id <> OLD.identity_id
  OR NEW.parent_thread_id IS NOT OLD.parent_thread_id OR NEW.activation_id <> OLD.activation_id
BEGIN SELECT RAISE(ABORT, 'thread ownership is immutable'); END;
CREATE TRIGGER IF NOT EXISTS binding_no_delete BEFORE DELETE ON thread_bindings
BEGIN SELECT RAISE(ABORT, 'thread binding cannot be released'); END;
CREATE TABLE IF NOT EXISTS binding_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, harness_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  at INTEGER NOT NULL, kind TEXT NOT NULL, record TEXT NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS binding_events_no_update BEFORE UPDATE ON binding_events
BEGIN SELECT RAISE(ABORT, 'binding events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS binding_events_no_delete BEFORE DELETE ON binding_events
BEGIN SELECT RAISE(ABORT, 'binding events are immutable'); END;
CREATE TABLE IF NOT EXISTS restore_requests (
  harness_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  PRIMARY KEY(harness_id, request_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS restore_requests_no_update BEFORE UPDATE ON restore_requests
BEGIN SELECT RAISE(ABORT, 'restore receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS restore_requests_no_delete BEFORE DELETE ON restore_requests
BEGIN SELECT RAISE(ABORT, 'restore receipts are immutable'); END;
`;

function binding(r: Row): ThreadBinding {
  return {
    harnessId: String(r.harness_id), threadId: String(r.thread_id), identityId: String(r.identity_id),
    memory: String(r.memory), instance: String(r.instance), state: r.state as ThreadBinding["state"],
    parentThreadId: r.parent_thread_id === null ? null : String(r.parent_thread_id), activationId: String(r.activation_id),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}
const conflict = (error: string): BindingResult<never> => ({ error, status: 409 });
const unauthorized = (): BindingResult<never> => ({ error: "invalid or revoked harness credential", status: 401 });

// This registry is the authority across memory objects. All authorization
// and writes happen in the same synchronous transaction, including retries.
export class Bindings {
  constructor(private readonly storage: DurableObjectStorage) {}
  private get sql(): SqlStorage { return this.storage.sql; }
  private harness(hash: string): string | undefined {
    return this.sql.exec<{ id: string }>(`SELECT id FROM harnesses WHERE token_hash = ? AND revoked = 0`, hash).toArray()[0]?.id;
  }
  private row(host: string, thread: string): Row | undefined {
    return this.sql.exec<Row>(`SELECT * FROM thread_bindings WHERE harness_id = ? AND thread_id = ?`, host, thread).toArray()[0];
  }
  private event(b: ThreadBinding, kind: string, at: number): void {
    this.sql.exec(`INSERT INTO binding_events(harness_id, thread_id, at, kind, record) VALUES(?, ?, ?, ?, ?)`,
      b.harnessId, b.threadId, at, kind, JSON.stringify(b));
  }
  register(name: string, hash: string, at: number): { id: string; name: string; createdAt: number } {
    const id = "h_" + crypto.randomUUID();
    this.sql.exec(`INSERT INTO harnesses(id, name, token_hash, created_at) VALUES(?, ?, ?, ?)`, id, name, hash, at);
    return { id, name, createdAt: at };
  }
  revoke(id: string): boolean {
    return this.sql.exec(`UPDATE harnesses SET revoked = 1 WHERE id = ? RETURNING id`, id).toArray().length > 0;
  }
  rotate(id: string, hash: string): boolean {
    return this.sql.exec(`UPDATE harnesses SET token_hash = ? WHERE id = ? AND revoked = 0 RETURNING id`, hash, id).toArray().length > 0;
  }
  read(hash: string, thread: string): BindingResult<ThreadBinding | null> {
    const host = this.harness(hash);
    if (host === undefined) return unauthorized();
    const row = this.row(host, thread);
    return { value: row === undefined ? null : binding(row) };
  }
  bind(hash: string, thread: string, target: BindingTarget, activation: string, source: string, at: number): BindingResult<ThreadBinding> {
    return this.storage.transactionSync(() => {
      const host = this.harness(hash);
      if (host === undefined) return unauthorized();
      if (source !== "conversation") return { error: "temporary agents cannot bind a subject", status: 403 };
      const existing = this.row(host, thread);
      if (existing !== undefined) {
        const b = binding(existing);
        if (b.identityId !== target.identityId) return conflict("this thread is already bound to another subject");
        if (b.instance !== target.instance || b.memory !== target.memory) return conflict("explicit restore association is required");
        return { value: b };
      }
      this.sql.exec(`INSERT INTO thread_bindings(harness_id, thread_id, identity_id, memory, instance, state,
        parent_thread_id, activation_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 'bound_initializing', NULL, ?, ?, ?)`,
      host, thread, target.identityId, target.memory, target.instance, activation, at, at);
      const b = binding(this.row(host, thread)!);
      this.event(b, "bound", at);
      return { value: b };
    });
  }
  fork(hash: string, parent: string, child: string, source: string, at: number): BindingResult<ThreadBinding | null> {
    return this.storage.transactionSync(() => {
      const host = this.harness(hash);
      if (host === undefined) return unauthorized();
      if (source !== "conversation") return { error: "temporary agents cannot inherit a subject", status: 403 };
      if (parent === child) return conflict("a fork needs a distinct thread");
      const prior = this.row(host, child);
      const from = this.row(host, parent);
      if (prior !== undefined) {
        const b = binding(prior);
        return b.parentThreadId === parent ? { value: b } : conflict("child thread is already bound");
      }
      if (from === undefined) return { value: null };
      const p = binding(from);
      this.sql.exec(`INSERT INTO thread_bindings(harness_id, thread_id, identity_id, memory, instance, state,
        parent_thread_id, activation_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 'bound_initializing', ?, ?, ?, ?)`,
      host, child, p.identityId, p.memory, p.instance, parent, "fork:" + parent, at, at);
      const b = binding(this.row(host, child)!);
      this.event(b, "forked", at);
      return { value: b };
    });
  }
  restore(hash: string, thread: string, target: BindingTarget, previous: string, request: string, at: number): BindingResult<ThreadBinding> {
    return this.storage.transactionSync(() => {
      const host = this.harness(hash);
      if (host === undefined) return unauthorized();
      const row = this.row(host, thread);
      if (row === undefined) return conflict("thread is not bound");
      const b = binding(row);
      if (b.identityId !== target.identityId) return conflict("restore cannot change the bound subject");
      const fingerprint = JSON.stringify([thread, target.identityId, target.memory, target.instance, previous]);
      const receipt = this.sql.exec<{ fingerprint: string }>(
        `SELECT fingerprint FROM restore_requests WHERE harness_id = ? AND request_id = ?`, host, request,
      ).toArray()[0];
      // An old successful request never rolls a later restore back. Return
      // the current binding, and reject reuse for a different operation.
      if (receipt !== undefined) return receipt.fingerprint === fingerprint
        ? { value: b } : conflict("restore request was reused with different arguments");
      if (b.instance !== previous || b.instance === target.instance) return conflict("the previous instance does not match");
      this.sql.exec(`UPDATE thread_bindings SET memory = ?, instance = ?, state = 'bound_initializing',
        updated_at = ?, restore_request = ?, previous_instance = ? WHERE harness_id = ? AND thread_id = ?`,
      target.memory, target.instance, at, request, previous, host, thread);
      const updated = binding(this.row(host, thread)!);
      this.sql.exec(`INSERT INTO restore_requests(harness_id, request_id, fingerprint) VALUES(?, ?, ?)`, host, request, fingerprint);
      this.event(updated, "restore_associated", at);
      return { value: updated };
    });
  }
}
