// The limit on guessing, and the budget on registrations (below). The
// consent page's credential and the admin API's secret are counted per
// address: once an address has presented
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
//
// The same objects keep the budget on client registrations, which write to
// KV without any credential: at most registerPerHour an hour from one
// address, in that address's object, and at most REGISTER_PER_DAY in any 24
// hours in all, in one object of its own (allAddresses). The class is the
// same so that a deploy needs no migration; the counts are kept under a key
// of their own, apart from the misses. Reached only by POST /oauth/register.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { logLine } from "./log";

export const maxMisses = 10;
export const windowMs = 60_000;

export const registerPerHour = 10;
export const hourMs = 3_600_000;
export const dayMs = 86_400_000;
// The count in all is kept by the minute, so that a large REGISTER_PER_DAY
// takes at most 1,440 entries; an entry lasts to the end of its minute.
export const dayStepMs = 60_000;
// The name of the object that counts every address's registrations
// together. addressOf trims what it reads, so no address's key starts with
// a space.
export const allAddresses = " all addresses";

const missesKey = "misses";
const registrationsKey = "registrations";

// A count of registrations: the time it stops being counted, and how many.
type Counted = [until: number, n: number];

// Guard keeps the misses of one address: the times of the wrong credentials
// it presented within the window, oldest first. It stores nothing for an
// address that presented none, and empties itself once all are old. It also
// keeps the registrations it admitted, as admit says.
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

  private counted(now: number): Counted[] {
    return (this.ctx.storage.kv.get<Counted[]>(registrationsKey) ?? []).filter(([until]) => until > now).sort((a, b) => a[0] - b[0]);
  }

  // admit counts one registration at now, to be counted for spanMs (rounded
  // up to stepMs), unless limit are counted already: then it counts nothing
  // and returns the seconds until one more fits. 0 means admitted. A refused
  // registration is not counted, so a wait ends at most spanMs after the
  // last one admitted, however often it is asked.
  admit(now: number, limit: number, spanMs: number, stepMs: number): number {
    const live = this.counted(now);
    const total = live.reduce((n, [, k]) => n + k, 0);
    if (total >= limit) {
      // The wait ends when enough are old for one more to fit.
      let freed = 0;
      for (const [until, k] of live) {
        freed += k;
        if (total - freed < limit) return Math.max(1, Math.ceil((until - now) / 1000));
      }
      return Math.max(1, Math.ceil(spanMs / 1000));
    }
    const until = Math.ceil((now + spanMs) / stepMs) * stepMs;
    const same = live.find(([u]) => u === until);
    if (same !== undefined) same[1]++;
    else live.push([until, 1]);
    this.ctx.storage.kv.put(registrationsKey, live);
    this.tidyAt(until + 1000);
    return 0;
  }

  // withdraw takes back one registration admit counted at now, when the
  // other count refused it.
  withdraw(now: number, spanMs: number, stepMs: number): void {
    const until = Math.ceil((now + spanMs) / stepMs) * stepMs;
    const live = this.counted(now);
    const same = live.find(([u]) => u === until);
    if (same === undefined) return;
    same[1]--;
    this.ctx.storage.kv.put(registrationsKey, live.filter(([, k]) => k > 0));
  }

  // registrations reports how many registrations are counted at now; tests read it.
  registrations(now: number): number {
    return this.counted(now).reduce((n, [, k]) => n + k, 0);
  }

  private tidyAt(at: number): void {
    this.ctx.storage.setAlarm(at).catch((err: unknown) => {
      logLine({ msg: "alarm not set", error: err instanceof Error ? err.name : "unknown" });
    });
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const misses = (this.ctx.storage.kv.get<number[]>(missesKey) ?? []).filter((t) => t > now - windowMs);
    const counted = this.counted(now);
    if (misses.length === 0 && counted.length === 0) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const last = Math.max(...misses.map((t) => t + windowMs), ...counted.map(([until]) => until));
    await this.ctx.storage.setAlarm(last + 1000);
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

// What the budget says of a registration: admitted, refused with the seconds
// to wait and which count refused it, or not known.
export type Admission = "admitted" | "unavailable" | { wait: number; by: "address" | "all" };

// admitRegistration counts a registration against the budget: first its
// address's hour (none for a request that came by no address), then the 24
// hours of all addresses. An address over its hour is refused without
// reaching the count in all, so one address cannot spend it; a registration
// the count in all refuses is taken back from its address. When the guard
// cannot be reached the registration is refused: unlike the limit on
// guessing, nobody is locked out by it, and KV is what it protects.
export async function admitRegistration(env: Env, request: Request, perDay: number): Promise<Admission> {
  const now = Date.now();
  const key = addressOf(request);
  try {
    const one = key === undefined ? undefined : env.GUARD.getByName(key);
    if (one !== undefined) {
      const wait = await one.admit(now, registerPerHour, hourMs, 1);
      if (wait > 0) return { wait, by: "address" };
    }
    const wait = await env.GUARD.getByName(allAddresses).admit(now, perDay, dayMs, dayStepMs);
    if (wait > 0) {
      if (one !== undefined) await one.withdraw(now, hourMs, 1);
      return { wait, by: "all" };
    }
    return "admitted";
  } catch (err) {
    logLine({ msg: "guard unavailable", error: err instanceof Error ? err.name : "unknown" });
    return "unavailable";
  }
}
