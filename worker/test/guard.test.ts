// The limit on guessing at the consent page and the admin API: what is
// counted, by what key, the 429, the recovery, and that a right credential
// is never counted. Requests carry CF-Connecting-IP as Cloudflare's edge
// sets it; a request without it is not counted (the other test files).

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addressOf, type Guard, maxMisses, windowMs } from "../src/guard";
import type { Env } from "../src/index";
import { adminSecret, createMemory, fetchWorker, origin, testEnv } from "./mcp-helpers";
import { authorizePath, openPage, pkce, register, resourceOf } from "./oauth-helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

let addresses = 0;

// freshAddress is an address no other test uses.
function freshAddress(): string {
  addresses++;
  return `203.0.${Math.floor(addresses / 250) + 100}.${(addresses % 250) + 1}`;
}

function admin(address: string | null, secret: string | null, e?: Env, path = "/admin/memories"): Promise<Response> {
  const headers: Record<string, string> = {};
  if (address !== null) headers["cf-connecting-ip"] = address;
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  return fetchWorker(path, { headers }, e);
}

function missesOf(address: string, now = Date.now()): Promise<number> {
  return env.GUARD.getByName(addressOf(new Request(origin, { headers: { "cf-connecting-ip": address } }))!).misses(now);
}

// Moves the Worker's clock by ms from now on.
function later(ms: number): void {
  const now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now + ms);
}

async function spend(address: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const res = await admin(address, `wrong-${i}`);
    expect(res.status, `miss ${i + 1}`).toBe(401);
  }
}

// A consent page opened for a new memory, to post to from an address.
async function consentFor(address: string) {
  const m = await createMemory();
  const clientId = await register();
  const p = await pkce();
  const page = await openPage(authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(m.name) }));
  // As submit posts it, from the address.
  const postFrom = (credential: string, e?: Env) =>
    fetchWorker("/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: page.cookie, "cf-connecting-ip": address },
      body: new URLSearchParams({ ...page.fields, decision: "approve", credential }).toString(),
      redirect: "manual",
    }, e);
  return { m, postFrom };
}

describe("the limit on guessing", () => {
  it(`refuses an address after ${maxMisses} wrong admin secrets in a minute, with 429 and Retry-After, right or wrong`, async () => {
    const a = freshAddress();
    await spend(a, maxMisses);
    expect(await missesOf(a)).toBe(maxMisses);
    for (const secret of ["wrong-again", adminSecret]) {
      const res = await admin(a, secret);
      expect(res.status, secret).toBe(429);
      const wait = Number(res.headers.get("retry-after"));
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
      expect(await res.json()).toEqual({ error: `too many wrong attempts from this address; try again in ${wait} seconds` });
    }
    // Refused attempts are not counted.
    expect(await missesOf(a)).toBe(maxMisses);
    // Another address, and a request that came by no address, are not held.
    expect((await admin(freshAddress(), adminSecret)).status).toBe(200);
    expect((await admin(null, adminSecret)).status).toBe(200);
    // Every route is held, also one the memory does not exist for.
    expect((await admin(a, adminSecret, undefined, "/admin/memories/nobody")).status).toBe(429);
    // A route that does not exist is still 404, as before the secret is weighed.
    expect((await admin(a, adminSecret, undefined, "/admin/other")).status).toBe(404);
  });

  it("lets the owner in again within a minute of the miss that set the lock, however long the guessing goes on", async () => {
    const a = freshAddress();
    await spend(a, maxMisses);
    // Half a minute on, still held, for as long as is left.
    later(30_000);
    let res = await admin(a, "wrong");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(29);
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(31);
    for (let i = 0; i < 20; i++) expect((await admin(a, `still-${i}`)).status).toBe(429);
    vi.restoreAllMocks();
    later(windowMs + 1000);
    res = await admin(a, adminSecret);
    expect(res.status).toBe(200);
    // The count starts again.
    expect((await admin(a, "wrong")).status).toBe(401);
    expect(await missesOf(a, Date.now())).toBe(1);
  });

  it("counts misses in a sliding window: an old miss falls out", async () => {
    const a = freshAddress();
    await spend(a, maxMisses - 1);
    later(40_000);
    await spend(a, 1); // the 10th, 40 s after the first nine
    expect((await admin(a, adminSecret)).status).toBe(429);
    vi.restoreAllMocks();
    later(windowMs + 1);
    // The first nine are old: one miss is counted, and the right secret goes in.
    expect((await admin(a, adminSecret)).status).toBe(200);
    expect(await missesOf(a, Date.now())).toBe(1);
  });

  it("never counts a right secret, nor a request that presents none", async () => {
    const a = freshAddress();
    await spend(a, maxMisses - 1);
    for (let i = 0; i < 25; i++) expect((await admin(a, adminSecret)).status).toBe(200);
    for (let i = 0; i < 25; i++) expect((await admin(a, null)).status).toBe(401);
    expect(await missesOf(a)).toBe(maxMisses - 1);
    // A scheme other than Bearer is presented, and counts.
    const res = await fetchWorker("/admin/memories", { headers: { authorization: "Basic x", "cf-connecting-ip": a } });
    expect(res.status).toBe(401);
    expect((await admin(a, adminSecret)).status).toBe(429);
  });

  it("counts the consent page and the admin API together, and refuses a locked post without touching KV", async () => {
    const a = freshAddress();
    const { m, postFrom } = await consentFor(a);
    for (let i = 0; i < maxMisses / 2; i++) expect((await postFrom(`wrong-${i}`)).status).toBe(403);
    await spend(a, maxMisses / 2);
    // Locked now, on both: the memory's own token is refused too.
    const touched: string[] = [];
    const kv = new Proxy(env.OAUTH_KV, {
      get(target, prop) {
        touched.push(String(prop));
        return Reflect.get(target, prop);
      },
    });
    const e: Env = { ...testEnv(), OAUTH_KV: kv };
    const res = await postFrom(m.token, e);
    expect(res.status).toBe(429);
    expect(res.headers.get("location")).toBeNull();
    const wait = Number(res.headers.get("retry-after"));
    expect(wait).toBeGreaterThanOrEqual(1);
    const html = await res.text();
    expect(html).toContain(`Too many attempts from here were not accepted. Wait ${wait} seconds, then go back to the form and try again.`);
    expect(touched).toEqual([]);
    expect((await admin(a, adminSecret)).status).toBe(429);
    // Within a minute the same form is approved.
    later(windowMs + 1000);
    expect((await postFrom(m.token)).status).toBe(302);
  });

  it("does not count an approval, nor a denial", async () => {
    const a = freshAddress();
    const { m, postFrom } = await consentFor(a);
    await spend(a, maxMisses - 1);
    expect((await postFrom(m.token)).status).toBe(302);
    const again = await consentFor(a);
    const deny = await fetchWorker("/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin, "cf-connecting-ip": a },
      body: "decision=deny&memory=" + again.m.name,
      redirect: "manual",
    });
    expect(deny.status).not.toBe(429);
    expect(await missesOf(a)).toBe(maxMisses - 1);
  });

  it("is not on the path of a request to a memory, right or wrong", async () => {
    const a = freshAddress();
    const m = await createMemory();
    await spend(a, maxMisses);
    const reached: string[] = [];
    const guard = new Proxy({}, {
      get(_t, prop) {
        reached.push(String(prop));
        throw new Error("GUARD was reached");
      },
    }) as Env["GUARD"];
    const e: Env = { ...testEnv(), GUARD: guard };
    const mcp = (token: string) =>
      fetchWorker(`/${m.name}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18",
          authorization: `Bearer ${token}`, "cf-connecting-ip": a,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }, e);
    for (let i = 0; i < 15; i++) expect((await mcp(`ziwo_wrong${i}`)).status).toBe(401);
    expect((await mcp(m.token)).status).toBe(200);
    expect(reached).toEqual([]);
  });

  it("lets everything through, and logs it, when the guard cannot be reached", async () => {
    const guard = { getByName: () => ({ settle: () => Promise.reject(new Error("down")) }) } as unknown as Env["GUARD"];
    const e: Env = { ...testEnv(), GUARD: guard };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect((await admin(freshAddress(), adminSecret, e)).status).toBe(200);
    expect((await admin(freshAddress(), "wrong", e)).status).toBe(401);
    const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(lines.filter((l) => l.msg === "guard unavailable")).toEqual([
      { msg: "guard unavailable", error: "Error" },
      { msg: "guard unavailable", error: "Error" },
    ]);
  });

  it("logs a refusal by its outcome, without the secret", async () => {
    const a = freshAddress();
    await spend(a, maxMisses);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await admin(a, "secret-marker");
    const line = JSON.parse(String(log.mock.calls[0]![0])) as Record<string, unknown>;
    expect(line).toMatchObject({ msg: "request", status: 429, auth: "rejected", outcome: "too_many" });
    expect(JSON.stringify(line)).not.toContain("secret-marker");
    expect(JSON.stringify(line)).not.toContain(a);
  });
});

describe("the key", () => {
  it("is the address, an IPv6 one cut to its /64, and none without the header", () => {
    const of = (ip: string | null) => addressOf(new Request(origin, { headers: ip === null ? {} : { "cf-connecting-ip": ip } }));
    expect(of(null)).toBeUndefined();
    expect(of("  ")).toBeUndefined();
    expect(of("198.51.100.7")).toBe("198.51.100.7");
    expect(of("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(of("2001:0db8:0001:0002:ffff::1")).toBe("2001:db8:1:2::/64");
    expect(of("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(of("::1")).toBe("0:0:0:0::/64");
    expect(of("::ffff:192.0.2.1")).toBe("0:0:0:0::/64");
    expect(of("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    // Not an address: kept as it came, cut short.
    expect(of("1:2:3")).toBe("1:2:3");
    expect(of("x".repeat(100))).toBe("x".repeat(64));
  });

  it("puts two addresses of one /64 under one count", async () => {
    await spend("2001:db8:aa:1::10", maxMisses);
    expect((await admin("2001:db8:aa:1:ffff::20", adminSecret)).status).toBe(429);
    expect((await admin("2001:db8:aa:2::10", adminSecret)).status).toBe(200);
  });
});

describe("the guard's storage", () => {
  it("ends a lock when its oldest miss is a minute old, not its newest", async () => {
    const g = env.GUARD.getByName("198.51.100.210");
    const t0 = Date.now();
    // One miss a second.
    for (let i = 0; i < maxMisses; i++) expect(await g.settle(t0 + i * 1000, false)).toBe(0);
    const locked = t0 + maxMisses * 1000;
    expect(await g.settle(locked, true)).toBe((t0 + windowMs - locked) / 1000);
    expect(await g.settle(t0 + windowMs - 1, true)).toBe(1);
    // The oldest is old: one more fits, and a wrong one locks again until the next is old.
    expect(await g.settle(t0 + windowMs, false)).toBe(0);
    expect(await g.settle(t0 + windowMs, true)).toBe(1);
    expect(await g.settle(t0 + windowMs + 1000, true)).toBe(0);
  });

  it("holds nothing for an address that never missed, and empties itself once its misses are old", async () => {
    const right = env.GUARD.getByName("198.51.100.200");
    expect(await right.settle(Date.now(), true)).toBe(0);
    expect(await runInDurableObject(right, (_g: Guard, state) => [...state.storage.kv.list()].length)).toBe(0);
    const wrong = env.GUARD.getByName("198.51.100.201");
    expect(await wrong.settle(Date.now() - 2 * windowMs, false)).toBe(0);
    expect(await runInDurableObject(wrong, (_g: Guard, state) => [...state.storage.kv.list()].length)).toBe(1);
    expect(await runDurableObjectAlarm(wrong)).toBe(true);
    expect(await runInDurableObject(wrong, async (_g: Guard, state) => [[...state.storage.kv.list()].length, await state.storage.getAlarm()])).toEqual([0, null]);
    // A miss still in the window keeps it, and the alarm is set again.
    expect(await wrong.settle(Date.now(), false)).toBe(0);
    expect(await runDurableObjectAlarm(wrong)).toBe(true);
    expect(await runInDurableObject(wrong, async (_g: Guard, state) => [[...state.storage.kv.list()].length, (await state.storage.getAlarm()) !== null]))
      .toEqual([1, true]);
  });
});
