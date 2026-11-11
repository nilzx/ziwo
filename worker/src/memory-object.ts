import { DurableObject } from "cloudflare:workers";
import { InvalidInput, parseWhen, type RememberRequest, trimSpace } from "./memory/clean";
import type { AmendRequest, EntryRequest, EraseRequest, ReflectView } from "./memory/amend";
import { type ContextView, type Result, Service } from "./memory/service";
import type { Report } from "./store/check";
import type { Usage } from "./store/db";
import { InvalidParamsError, type Params } from "./store/decay";
import { Store } from "./store/store";
import type { Env } from "./index";

// Invalid is an input the caller can fix, with the message for the model.
// Error classes do not survive RPC, so it is returned, not thrown.
export interface Invalid {
  invalid: string;
}

// RememberArgs is a memory as a tool call sends it: the date it took place,
// if any, is text, read as Go's server reads happened_at.
export type RememberArgs = Omit<RememberRequest, "happened"> & { happenedAt?: string };

// outcome runs fn and hands back an InvalidInput as data. Anything else is
// thrown.
function outcome<T>(fn: () => T): T | Invalid {
  try {
    return fn();
  } catch (err) {
    if (err instanceof InvalidInput || err instanceof InvalidParamsError) return { invalid: err.message };
    throw err;
  }
}

// Memory is one memory: a Durable Object that owns the SQLite database its
// store lives in. Every method is synchronous inside: nothing else runs on
// the object between its reads and its writes.
export class Memory extends DurableObject<Env> {
  readonly store: Store;
  readonly service: Service;
  // The wall clock in unix milliseconds. Tests replace it; an instance
  // field is not reachable over RPC.
  now: () => number = () => Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Synchronous, so it finishes before any request reaches the object.
    this.store = new Store(ctx.storage);
    this.service = new Service(this.store, () => this.now());
  }

  // getContext starts a session and returns what it is shown.
  getContext(args: { model?: string; client?: string }): ContextView | Invalid {
    return outcome(() => this.service.context(args.model ?? "", args.client ?? ""));
  }

  remember(args: RememberArgs): { id: string; dup: boolean } | Invalid {
    return outcome(() => {
      const { happenedAt, ...req } = args;
      let happened: number | undefined;
      if (happenedAt !== undefined && trimSpace(happenedAt) !== "") happened = parseWhen(happenedAt);
      return this.service.remember({ ...req, happened });
    });
  }

  recall(args: { query: string; limit?: number; deep?: boolean; sessionId?: string }): Result[] | Invalid {
    return outcome(() => this.service.recall(args.query ?? "", args.limit ?? 0, args.deep ?? false, args.sessionId ?? ""));
  }

  expand(args: { ids: string[]; sessionId?: string }): Result[] | Invalid {
    return outcome(() => this.service.expand(args.ids ?? [], args.sessionId ?? ""));
  }

  // amend changes how a memory is remembered, or sets or drops a preference,
  // and returns a sentence saying what was done.
  amend(args: AmendRequest): string | Invalid {
    return outcome(() => this.service.amend(args));
  }

  // erase deletes what a memory says, for good.
  erase(args: EraseRequest): string | Invalid {
    return outcome(() => this.service.erase(args));
  }

  // beginReflect opens a round of reflection and hands it a batch of
  // fragments; the batch is empty when nothing waits.
  beginReflect(args: { sessionId?: string; limit?: number }): ReflectView | Invalid {
    return outcome(() => this.service.beginReflect(args.sessionId ?? "", args.limit ?? 0));
  }

  // finishReflect writes a round back and returns the ids of the memories it
  // made, in the order of the entries.
  finishReflect(args: { sessionId?: string; batch?: string; entries?: EntryRequest[]; pass?: string[] }): string[] | Invalid {
    return outcome(() =>
      this.service.finishReflect(args.sessionId ?? "", args.batch ?? "", args.entries ?? [], args.pass ?? []),
    );
  }

  check(): Report {
    return this.service.check();
  }

  params(): Params {
    return this.store.params();
  }

  // setParams stores new forgetting parameters and rebuilds the derived
  // tables with them; it returns the parameters now in force.
  setParams(p: Params): Params | Invalid {
    return outcome(() => {
      this.store.setParams(p);
      return this.store.params();
    });
  }

  // usage reports the rows read and written since the last reset; reset
  // starts the count again.
  usage(reset = false): Usage {
    const u = this.store.usage();
    if (reset) this.store.resetUsage();
    return u;
  }
}
