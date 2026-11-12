// The budget on client registrations: at most registerPerHour an hour from
// one address and at most REGISTER_PER_DAY in any 24 hours in all, counted
// in the Guard objects before the library sees the request; the 429 and its
// Retry-After, the recovery, REGISTER_PER_DAY of 0, and that the count is on
// no other request's path. Requests carry CF-Connecting-IP as Cloudflare's
// edge sets it. Every test moves the clock days ahead (freshDay), so that
// registrations made before it have left the window.

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addressOf, allAddresses, dayMs, dayStepMs, type Guard, hourMs, registerPerHour } from "../src/guard";
import type { Env } from "../src/index";
import { fetchWorker, origin, testEnv } from "./mcp-helpers";
import { authorizePath, countingEnv, pkce, redirectUri, register, tokenRequest } from "./oauth-helpers";

afterEach(() => vi.restoreAllMocks());

let addresses = 0;

// freshAddress is an address no other test uses.
function freshAddress(): string {
  addresses++;
  return `192.0.${Math.floor(addresses / 250) + 2}.${(addresses % 250) + 1}`;
}

// The Worker's clock for the tests of this file, which share their storage:
// it only moves forward, so that what one test counted has left every window
// by the next.
let cursor = Date.now();

// Moves the Worker's clock to at.
function clockAt(at: number): void {
  cursor = Math.max(cursor, at);
  vi.restoreAllMocks();
  vi.spyOn(Date, "now").mockImplementation(() => at);
}

// Moves the Worker's clock to a day no other test has used.
function freshDay(): number {
  cursor += 3 * dayMs;
  clockAt(cursor);
  return cursor;
}

const metadata = { client_name: "Budget client", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" };

function registerFrom(address: string | null, e?: Env, body: string = JSON.stringify(metadata)): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (address !== null) headers["cf-connecting-ip"] = address;
  return fetchWorker("/oauth/register", { method: "POST", headers, body }, e);
}

const withBudget = (perDay: string, base: Env = testEnv()): Env => ({ ...base, REGISTER_PER_DAY: perDay });

const countedAt = (address: string, now: number): Promise<number> =>
  env.GUARD.getByName(addressOf(new Request(origin, { headers: { "cf-connecting-ip": address } }))!).registrations(now);

async function refusal(res: Response): Promise<{ wait: number; description: string }> {
  expect(res.status).toBe(429);
  const wait = Number(res.headers.get("retry-after"));
  const body = (await res.json()) as { error: string; error_description: string };
  expect(Object.keys(body).sort()).toEqual(["error", "error_description"]);
  expect(body.error).toBe("temporarily_unavailable");
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(res.headers.get("cache-control")).toBe("no-store");
  return { wait, description: body.error_description };
}

describe("the budget on registrations", () => {
  it(`admits ${registerPerHour} an hour from one address, then 429 with Retry-After, and again after the hour`, async () => {
    expect(registerPerHour).toBe(10);
    const t0 = freshDay();
    const a = freshAddress();
    for (let i = 0; i < registerPerHour; i++) expect((await registerFrom(a)).status, `registration ${i + 1}`).toBe(201);
    expect(await countedAt(a, t0)).toBe(registerPerHour);
    const { wait, description } = await refusal(await registerFrom(a));
    expect(wait).toBe(hourMs / 1000);
    expect(description).toBe(`Too many client registrations from this address in the last hour; try again in ${wait} seconds`);
    // Half an hour on, still held, for as long as is left; refusals are not counted.
    clockAt(t0 + hourMs / 2);
    for (let i = 0; i < 5; i++) expect((await refusal(await registerFrom(a))).wait).toBe(hourMs / 2000);
    expect(await countedAt(a, t0 + hourMs / 2)).toBe(registerPerHour);
    // Another address, and a request that came by no address, are not held.
    expect((await registerFrom(freshAddress())).status).toBe(201);
    expect((await registerFrom(null)).status).toBe(201);
    // An IPv6 address is counted by its /64.
    const v6 = `2001:db8:${(addresses + 1).toString(16)}::`;
    addresses++;
    for (let i = 0; i < registerPerHour; i++) expect((await registerFrom(`${v6}${i + 1}`)).status).toBe(201);
    expect((await registerFrom(`${v6}ff`)).status).toBe(429);
    // The hour after the first, one more fits.
    clockAt(t0 + hourMs + 1);
    expect((await registerFrom(a)).status).toBe(201);
    expect(await countedAt(a, t0 + hourMs + 1)).toBe(1);
  });

  it("admits REGISTER_PER_DAY in any 24 hours from all addresses, then 429 to every address until the oldest is 24 hours old", async () => {
    const t0 = freshDay();
    const e = withBudget("3");
    expect((await registerFrom(freshAddress(), e)).status).toBe(201);
    clockAt(t0 + 3_600_000);
    expect((await registerFrom(freshAddress(), e)).status).toBe(201);
    expect((await registerFrom(null, e)).status).toBe(201);
    const late = freshAddress();
    const { wait, description } = await refusal(await registerFrom(late, e));
    // The oldest is counted to the end of its minute.
    const until = Math.ceil((t0 + dayMs) / dayStepMs) * dayStepMs;
    expect(wait).toBe(Math.ceil((until - (t0 + 3_600_000)) / 1000));
    expect(description).toBe(`Too many client registrations on this server in the last 24 hours; try again in ${wait} seconds`);
    // The address the count in all refused is not held for it.
    expect(await countedAt(late, t0 + 3_600_000)).toBe(0);
    expect((await registerFrom(null, e)).status).toBe(429);
    // Once the oldest has left the window, one more fits, and only one.
    clockAt(until + 1);
    expect((await registerFrom(late, e)).status).toBe(201);
    expect((await registerFrom(freshAddress(), e)).status).toBe(429);
    // The default is 100.
    const t1 = freshDay();
    for (let i = 0; i < 100; i++) expect((await registerFrom(null)).status, `registration ${i + 1}`).toBe(201);
    expect((await registerFrom(null)).status).toBe(429);
    expect(await env.GUARD.getByName(allAddresses).registrations(t1)).toBe(100);
  });

  it("counts a registration the library then refuses", async () => {
    const t0 = freshDay();
    const e = withBudget("2");
    const a = freshAddress();
    expect((await registerFrom(a, e, "not json")).status).toBe(400);
    expect((await registerFrom(a, e, JSON.stringify({ ...metadata, redirect_uris: ["not a uri"] }))).status).toBe(400);
    expect(await countedAt(a, t0)).toBe(2);
    expect((await registerFrom(a, e)).status).toBe(429);
  });

  it("writes nothing to KV for a registration it refuses, nor when the guard cannot be reached", async () => {
    freshDay();
    const { env: e, writes } = countingEnv(withBudget("1"));
    expect((await registerFrom(freshAddress(), e)).status).toBe(201);
    expect(writes).toEqual(["put client"]);
    writes.length = 0;
    for (let i = 0; i < 5; i++) expect((await registerFrom(freshAddress(), e)).status).toBe(429);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const down = { getByName: () => ({ admit: () => Promise.reject(new Error("down")) }) } as unknown as Env["GUARD"];
    const res = await registerFrom(freshAddress(), { ...e, GUARD: down, REGISTER_PER_DAY: "100" });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({ error: "temporarily_unavailable", error_description: "Client registration is unavailable right now; try again later" });
    expect(writes).toEqual([]);
    const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(lines.filter((l) => l.msg === "guard unavailable")).toEqual([{ msg: "guard unavailable", error: "Error" }]);
    expect(lines.find((l) => l.msg === "request")).toMatchObject({ oauth: "register", outcome: "budget_unavailable", status: 503 });
  });

  it("logs a refusal by its outcome, without the address", async () => {
    freshDay();
    const a = freshAddress();
    for (let i = 0; i < registerPerHour; i++) await registerFrom(a);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await registerFrom(a);
    const line = JSON.parse(String(log.mock.calls[0]![0])) as Record<string, unknown>;
    expect(line).toMatchObject({ msg: "request", method: "POST", path: "/oauth/register", status: 429, oauth: "register", outcome: "over_budget" });
    expect(JSON.stringify(line)).not.toContain(a);
  });

  it("is off at 0: the endpoint is not there, not in the metadata, and nothing is counted or written", async () => {
    freshDay();
    const reached: string[] = [];
    const guard = new Proxy({}, {
      get(_t, prop) {
        reached.push(String(prop));
        throw new Error("GUARD was reached");
      },
    }) as Env["GUARD"];
    const { env: base, writes } = countingEnv();
    const e: Env = { ...base, GUARD: guard, REGISTER_PER_DAY: "0" };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const method of ["POST", "GET", "OPTIONS"]) {
      const res = await fetchWorker("/oauth/register", { method, headers: { "content-type": "application/json", "cf-connecting-ip": freshAddress() }, body: method === "POST" ? JSON.stringify(metadata) : null }, e);
      expect(res.status, method).toBe(404);
      expect(await res.text()).toBe("404 page not found\n");
    }
    const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(lines.every((l) => l.oauth === undefined)).toBe(true);
    const m = (await (await fetchWorker("/.well-known/oauth-authorization-server", {}, e)).json()) as Record<string, unknown>;
    expect("registration_endpoint" in m).toBe(false);
    expect(m.token_endpoint).toBe(`${origin}/oauth/token`);
    const on = (await (await fetchWorker("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(on.registration_endpoint).toBe(`${origin}/oauth/register`);
    expect(reached).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("is on the path of no other request", async () => {
    freshDay();
    const clientId = await register();
    const reached: string[] = [];
    const guard = new Proxy({}, {
      get(_t, prop) {
        reached.push(String(prop));
        throw new Error("GUARD was reached");
      },
    }) as Env["GUARD"];
    const e: Env = { ...testEnv(), GUARD: guard };
    const at = { "cf-connecting-ip": freshAddress() };
    expect((await fetchWorker("/.well-known/oauth-authorization-server", { headers: at }, e)).status).toBe(200);
    expect((await fetchWorker("/oauth/register", { method: "OPTIONS", headers: at }, e)).status).toBe(204);
    expect((await fetchWorker("/oauth/register", { method: "GET", headers: at }, e)).status).toBe(405);
    expect((await fetchWorker(authorizePath({ clientId, challenge: (await pkce()).challenge, resource: null }), { headers: at }, e)).status).toBe(200);
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: "a:b:c", client_id: clientId }, e)).status).toBe(400);
    expect(reached).toEqual([]);
  });
});

describe("the guard's count of registrations", () => {
  it("keeps the count in all by the minute, and refuses without counting", async () => {
    const g = env.GUARD.getByName("192.0.200.1");
    const t0 = 1_800_000_000_000 + 12_345;
    expect(await g.admit(t0, 2, dayMs, dayStepMs)).toBe(0);
    expect(await g.admit(t0 + 1000, 2, dayMs, dayStepMs)).toBe(0);
    const until = Math.ceil((t0 + dayMs) / dayStepMs) * dayStepMs;
    expect(await g.admit(t0 + 2000, 2, dayMs, dayStepMs)).toBe(Math.ceil((until - t0 - 2000) / 1000));
    expect(await runInDurableObject(g, (_g: Guard, state) => state.storage.kv.get("registrations"))).toEqual([[until, 2]]);
    expect(await g.registrations(until - 1)).toBe(2);
    expect(await g.registrations(until)).toBe(0);
    expect(await g.admit(until, 2, dayMs, dayStepMs)).toBe(0);
    // withdraw takes one back, and drops an entry it empties.
    await g.withdraw(until, dayMs, dayStepMs);
    expect(await g.registrations(until)).toBe(0);
  });

  it("empties itself once its registrations and misses are old, and keeps what is still counted", async () => {
    const g = env.GUARD.getByName("192.0.200.2");
    expect(await g.admit(Date.now() - 2 * hourMs, registerPerHour, hourMs, 1)).toBe(0);
    expect(await runDurableObjectAlarm(g)).toBe(true);
    expect(await runInDurableObject(g, async (_g: Guard, state) => [[...state.storage.kv.list()].length, await state.storage.getAlarm()])).toEqual([0, null]);
    // A registration still in its hour keeps it, and the alarm is set again.
    expect(await g.admit(Date.now(), registerPerHour, hourMs, 1)).toBe(0);
    expect(await g.settle(Date.now() - 2 * 60_000, false)).toBe(0);
    expect(await runDurableObjectAlarm(g)).toBe(true);
    expect(await runInDurableObject(g, async (obj: Guard, state) => [(await state.storage.getAlarm()) !== null, obj.registrations(Date.now())]))
      .toEqual([true, 1]);
  });
});
