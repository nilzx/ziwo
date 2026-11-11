import { DurableObject } from "cloudflare:workers";
import { Store } from "./store/store";
import type { Env } from "./index";

// Memory is one memory: a Durable Object that owns the SQLite database its
// store lives in. Stage P1b gives it the methods the Worker calls.
export class Memory extends DurableObject<Env> {
  readonly store: Store;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Synchronous, so it finishes before any request reaches the object.
    this.store = new Store(ctx.storage);
  }
}
