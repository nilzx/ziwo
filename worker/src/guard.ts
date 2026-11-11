// The limit on guessing. The consent page's credential and the admin API's
// secret are counted per address: once an address has presented
// maxMisses wrong ones within windowMs, everything it presents to either is
// refused with 429 and Retry-After, right or wrong and without being
// weighed, until the oldest of those misses is windowMs old. A refused
// attempt is not counted, so a lock ends at most windowMs after the miss
// that set it, however long the guessing goes on, and an owner at another
// address is never locked out by it. A right credential is not counted.
//
// Why not the Workers rate limiting binding: its limit() counts every call,
// with no way to ask without counting, so a right credential would count
// or the lock could not stop it; its counts are kept per Cloudflare
// location and are approximate; and each binding needs a namespace id unique
// in the deployer's account. A Durable Object per address needs no setup
// beyond the migration a deploy applies, runs on the free plan, and is
// reached only on these two paths: never by a request to a memory.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { logLine } from "./log";

export const maxMisses = 10;
export const windowMs = 60_000;

const missesKey = "misses";

// Guard keeps the misses of one address: the times of the wrong credentials
// it presented within the window, oldest first. It stores nothing for an
// address that presented none, and empties itself once all are old.
export class Guard extends DurableObject<Env> {
  // settle is told, after a credential was weighed, whether it was right.
  // It returns 0 to go on, or the seconds to wait. now is the Worker's
  // clock, so that tests can move it.
  settle(now: number, right: boolean): number {
    const kv = this.ctx.storage.kv;
    const misses = (kv.get<number[]>(missesKey) ?? []).filter((t) => t > now - windowMs).sort((a, b) => a - b);
    if (misses.length >= maxMisses) {
      // The lock ends when enough misses are old for one more to fit.
      const until = misses[misses.length - maxMisses]! + windowMs;
      return Math.max(1, Math.ceil((until - now) / 1000));
    }
    if (!right) {
      misses.push(now);
      kv.put(missesKey, misses);
      // Tidy up once the window has passed after the last miss.
      this.ctx.storage.setAlarm(Date.now() + windowMs + 1000).catch((err: unknown) => {
        logLine({ msg: "alarm not set", error: err instanceof Error ? err.name : "unknown" });
      });
    }
    return 0;
  }

  // misses reports how many misses are counted at now; tests read it.
  misses(now: number): number {
    return (this.ctx.storage.kv.get<number[]>(missesKey) ?? []).filter((t) => t > now - windowMs).length;
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const misses = (this.ctx.storage.kv.get<number[]>(missesKey) ?? []).filter((t) => t > now - windowMs);
    if (misses.length === 0) await this.ctx.storage.deleteAll();
    else await this.ctx.storage.setAlarm(Math.max(...misses) + windowMs + 1000);
  }
}

// prefix64 gives the first four groups of an IPv6 address, the network of
// one subscriber, or undefined when it is not one.
function prefix64(ip: string): string | undefined {
  const halves = ip.toLowerCase().split("%")[0]!.split("::");
  if (halves.length > 2) return undefined;
  const parts = (s: string | undefined) => (s === undefined || s === "" ? [] : s.split(":"));
  const head = parts(halves[0]);
  const tail = parts(halves[1]);
  // An IPv4 tail fills two groups.
  const size = (g: string[]) => g.reduce((n, x) => n + (x.includes(".") ? 2 : 1), 0);
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - size(head) - size(tail);
    if (fill < 1) return undefined;
    groups = [...head, ...new Array<string>(fill).fill("0"), ...tail];
  } else {
    if (size(head) !== 8) return undefined;
    groups = head;
  }
  const first = groups.slice(0, 4);
  if (!first.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return first.map((g) => g.replace(/^0+(?=.)/, "")).join(":");
}

// addressOf is the key a request is counted under: the address Cloudflare
// saw it come from (CF-Connecting-IP, which a client cannot set there), an
// IPv6 one cut to its /64. undefined when there is none, as for a request
// that did not come through Cloudflare's edge: then nothing is counted.
export function addressOf(request: Request): string | undefined {
  const raw = (request.headers.get("cf-connecting-ip") ?? "").trim();
  if (raw === "") return undefined;
  if (raw.includes(":")) {
    const p = prefix64(raw);
    if (p !== undefined) return `${p}::/64`;
  }
  return raw.slice(0, 64);
}

// waitFor tells the guard of the request's address how a credential was
// weighed, and returns the seconds it must wait, or 0. When the guard cannot
// be reached the limit is not applied: an outage must not lock the owner out,
// and the credential is still checked.
export async function waitFor(env: Env, request: Request, right: boolean): Promise<number> {
  const key = addressOf(request);
  if (key === undefined) return 0;
  try {
    return await env.GUARD.getByName(key).settle(Date.now(), right);
  } catch (err) {
    logLine({ msg: "guard unavailable", error: err instanceof Error ? err.name : "unknown" });
    return 0;
  }
}
