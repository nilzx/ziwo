// The admin secret set on the admin page: what /admin/setup says for every
// combination of the rules, what a post to it answers, that of two posts at
// once exactly one sets it, that the secret set opens the admin API and the
// consent page under the limit on guessing, that a memory registered closes
// setting for good, and that the secret is kept and logged nowhere in the
// clear. The dashboard secret that replaces it is in setup-dashboard.test.ts.
//
// Storage and modules are this file's own: the directory starts empty, and
// no request here has told the directory of a dashboard secret before the
// first test.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exampleAdminSecret, maxAdminSecret, minAdminSecret, setupUntil, setupWindowMs } from "../src/admin";
import type { Directory } from "../src/directory";
import { addressOf, maxMisses } from "../src/guard";
import { sha256Hex } from "../src/http";
import type { Env } from "../src/index";
import { adminSecret, fetchWorker, freshName, origin, testEnv } from "./mcp-helpers";
import { approve, authorizePath, openPage, pkce, register, resourceOf } from "./oauth-helpers";

const minute = 60_000;

const versionAt = (at: number | string): WorkerVersionMetadata => ({
  id: "00000000-0000-4000-8000-000000000000",
  tag: "",
  timestamp: typeof at === "string" ? at : new Date(at).toISOString(),
});

// A deployment: the dashboard secret (null for none) and the version binding
// (null for none).
function deployment(secret: string | null, version: WorkerVersionMetadata | null = versionAt(Date.now() - 5 * minute)): Env {
  const e = testEnv(secret);
  return version === null ? e : { ...e, VERSION: version };
}

const fresh = (): Env => deployment(null);

const directory = () => env.DIRECTORY.getByName("directory");

function inDirectory<R>(fn: (sql: SqlStorage, obj: Directory) => R): Promise<R> {
  return runInDurableObject(directory(), (obj: Directory, state) => fn(state.storage.sql, obj));
}

// emptyDirectory puts the directory back as a new deployment has it.
async function emptyDirectory(): Promise<void> {
  await inDirectory((sql) => {
    sql.exec(`DELETE FROM memories`);
    sql.exec(`DELETE FROM admin_secret`);
    sql.exec(`DELETE FROM setup_closed`);
  });
}

async function setupState(e: Env): Promise<Record<string, unknown>> {
  const res = await fetchWorker("/admin/setup", {}, e);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function postSetup(e: Env, body: unknown, headers: Record<string, string> = { "content-type": "application/json", origin }): Promise<Response> {
  return fetchWorker("/admin/setup", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }, e);
}

function adminCall(e: Env, secret: string | null, path = "/admin/memories", method = "GET", address?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  if (address !== undefined) headers["cf-connecting-ip"] = address;
  return fetchWorker(path, { method, headers }, e);
}

// newSecret is a secret that may be set on the page.
const newSecret = (): string => `pg-${crypto.randomUUID()}`;

// The access log lines of what fn does.
async function logged(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a dashboard secret seen first", () => {
  // First in this file: no request here has told the directory yet.
  it("closes setting from the page for good, before any secret is set there", async () => {
    await emptyDirectory();
    expect(await setupState(fresh())).toEqual({ state: "open", min: minAdminSecret, until: expect.any(Number) });
    expect(await setupState(testEnv())).toEqual({ state: "set", min: minAdminSecret });
    expect(await inDirectory((sql) => sql.exec(`SELECT closed_by FROM setup_closed`).toArray())).toEqual([{ closed_by: "dashboard" }]);
    // Taken away again: no admin secret, and nothing can be set here.
    expect(await setupState(fresh())).toEqual({ state: "closed", min: minAdminSecret });
    expect((await postSetup(fresh(), { secret: newSecret() })).status).toBe(403);
    expect((await adminCall(fresh(), null)).status).toBe(404);
  });
});

describe("the state of the admin secret", () => {
  beforeEach(emptyDirectory);

  it("follows every combination of the rules", async () => {
    const now = Date.now();
    const versions: Record<string, [WorkerVersionMetadata | null, number | undefined]> = {
      "within the hour": [versionAt(now - 59 * minute), now - 59 * minute + setupWindowMs],
      "just made": [versionAt(now), now + setupWindowMs],
      "older": [versionAt(now - 61 * minute), undefined],
      "missing": [null, undefined],
      "unreadable": [versionAt("not a time"), undefined],
      "empty": [versionAt(""), undefined],
      "in the future": [versionAt(now + 5 * minute), undefined],
    };
    const dashboards: [string, string | null, boolean][] = [
      ["counts", adminSecret, true], ["none", null, false], ["empty", "", false], ["the example", exampleAdminSecret, false],
      ["too short", "x".repeat(minAdminSecret - 1), false],
    ];
    let cases = 0;
    for (const [dName, dashboard, counts] of dashboards) {
      for (const pageSet of [false, true]) {
        for (const closedRecord of [false, true]) {
          for (const memoryListed of [false, true]) {
            for (const [vName, [version, until]] of Object.entries(versions)) {
              await emptyDirectory();
              await inDirectory((sql) => {
                if (pageSet) sql.exec(`INSERT INTO admin_secret(id, salt, hash, set_at) VALUES(1, 'aa', 'bb', 1)`);
                if (closedRecord) sql.exec(`INSERT INTO setup_closed(id, closed_at, closed_by) VALUES(1, 1, 'page')`);
                if (memoryListed) sql.exec(`INSERT INTO memories(name, created_at) VALUES('m', 1)`);
              });
              const label = `dashboard ${dName}, page ${pageSet}, closed ${closedRecord}, memory ${memoryListed}, version ${vName}`;
              let want: Record<string, unknown>;
              if (counts || pageSet) want = { state: "set", min: minAdminSecret };
              else if (closedRecord || memoryListed || until === undefined) want = { state: "closed", min: minAdminSecret };
              else want = { state: "open", min: minAdminSecret, until };
              expect(await setupState(deployment(dashboard, version)), label).toEqual(want);
              // The rest of the admin API: there with a secret of either kind, else not.
              expect((await adminCall(deployment(dashboard, version), null)).status, label).toBe(want.state === "set" ? 401 : 404);
              cases++;
            }
          }
        }
      }
    }
    expect(cases).toBe(5 * 2 * 2 * 2 * 7);
  });

  it("is open for an hour from the version's time, and not for a time a minute or more ahead", () => {
    const now = 1_800_000_000_000;
    const at = (ms: number) => setupUntil(versionAt(ms), now);
    expect(at(now)).toBe(now + setupWindowMs);
    expect(at(now - setupWindowMs)).toBe(now);
    expect(at(now - setupWindowMs - 1)).toBeUndefined();
    expect(at(now + minute)).toBe(now + minute + setupWindowMs);
    expect(at(now + minute + 1)).toBeUndefined();
    expect(setupUntil(undefined, now)).toBeUndefined();
    for (const junk of ["", " ", "yesterday", "2026-13-45T99:99:99Z", "NaN"]) expect(setupUntil(versionAt(junk), now), junk).toBeUndefined();
    expect(setupUntil({ id: "", tag: "" } as unknown as WorkerVersionMetadata, now)).toBeUndefined();
    expect(setupUntil({ id: "", tag: "", timestamp: 1 } as unknown as WorkerVersionMetadata, now)).toBeUndefined();
  });

  it("answers GET and POST only, and needs no credential", async () => {
    for (const method of ["PUT", "DELETE", "PATCH"]) expect((await fetchWorker("/admin/setup", { method }, fresh())).status, method).toBe(404);
    expect((await fetchWorker("/admin/setup/x", {}, fresh())).status).toBe(404);
    // A credential, right or wrong, changes nothing.
    expect(await (await fetchWorker("/admin/setup", { headers: { authorization: "Bearer wrong" } }, fresh())).json()).toMatchObject({ state: "open" });
  });

  it("answers 503 when the directory cannot be reached, and the admin API too", async () => {
    const down = { getByName: () => ({ adminSecret: () => Promise.reject(new Error("down")) }) } as unknown as Env["DIRECTORY"];
    const e = { ...fresh(), DIRECTORY: down };
    const lines = await logged(async () => {
      expect((await fetchWorker("/admin/setup", {}, e)).status).toBe(503);
      expect((await postSetup(e, { secret: newSecret() })).status).toBe(503);
      expect((await adminCall(e, "anything")).status).toBe(503);
    });
    expect(lines.filter((l) => l.msg === "directory unavailable")).toHaveLength(3);
  });
});

describe("setting the admin secret on the page", () => {
  beforeEach(emptyDirectory);

  it("takes a secret once, and then it is set", async () => {
    const secret = newSecret();
    const res = await postSetup(fresh(), { secret });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ state: "set" });
    expect(await setupState(fresh())).toEqual({ state: "set", min: minAdminSecret });
    const again = await postSetup(fresh(), { secret: newSecret() });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "an admin secret is set already", state: "set" });
    expect(await inDirectory((sql) => sql.exec(`SELECT closed_by FROM setup_closed`).toArray())).toEqual([{ closed_by: "page" }]);
    // Long after the hour it is still the admin secret.
    expect((await adminCall(deployment(null, versionAt(Date.now() - 400 * 24 * 60 * minute)), secret)).status).toBe(200);
    expect((await adminCall(deployment(null, null), secret)).status).toBe(200);
  });

  it("takes a secret of 16 to 200 printable ASCII characters other than space, and nothing else", async () => {
    for (const secret of ["!".repeat(minAdminSecret), "~".repeat(maxAdminSecret), `A1!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~z`]) {
      await emptyDirectory();
      expect((await postSetup(fresh(), { secret })).status, secret).toBe(201);
      expect((await adminCall(fresh(), secret)).status, secret).toBe(200);
    }
    const refused: [string, unknown, Record<string, string>?][] = [
      ["too short", { secret: "x".repeat(minAdminSecret - 1) }],
      ["too long", { secret: "x".repeat(maxAdminSecret + 1) }],
      ["a space inside", { secret: `${"x".repeat(minAdminSecret)} y` }],
      ["a space around", { secret: ` ${"x".repeat(minAdminSecret)}` }],
      ["a tab", { secret: `${"x".repeat(minAdminSecret)}\t` }],
      ["a line break", { secret: `${"x".repeat(minAdminSecret)}\n` }],
      ["DEL", { secret: `${"x".repeat(minAdminSecret)}\x7f` }],
      ["outside ASCII", { secret: "密".repeat(minAdminSecret) }],
      ["a number", { secret: 12345678901234567890 }],
      ["null", { secret: null }],
      ["no secret", {}],
      ["another field too", { secret: newSecret(), admin: true }],
      ["an array", [newSecret()]],
      ["a string", JSON.stringify(newSecret())],
      ["not JSON", "secret=abcdefghijklmnopqrstuvwxyz"],
      ["empty", ""],
      ["too large", JSON.stringify({ secret: newSecret(), pad: "x".repeat(5000) })],
      ["not JSON by its type", { secret: newSecret() }, { "content-type": "text/plain", origin }],
      ["no type", { secret: newSecret() }, { origin }],
      ["a form", { secret: newSecret() }, { "content-type": "application/x-www-form-urlencoded", origin }],
    ];
    await emptyDirectory();
    for (const [label, body, headers] of refused) {
      let res: Response | undefined;
      const lines = await logged(async () => {
        res = await postSetup(fresh(), body, headers);
      });
      expect(res!.status, label).toBe(400);
      const answer = (await res!.json()) as { error: string };
      expect(Object.keys(answer), label).toEqual(["error"]);
      expect(answer.error, label).not.toContain("\n");
      expect(lines.find((l) => l.msg === "request")?.outcome, label).toBe("setup_invalid");
    }
    // A type with parameters is still JSON.
    expect(await setupState(fresh())).toMatchObject({ state: "open" });
    expect((await postSetup(fresh(), { secret: newSecret() }, { "content-type": "application/json; charset=utf-8" })).status).toBe(201);
  });

  it("refuses a post from another site, and takes one from this origin or from a script", async () => {
    const forged: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: `${origin}.evil.example` },
      { origin: "null" },
      { origin: "null", "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ];
    for (const h of forged) {
      let res: Response | undefined;
      const lines = await logged(async () => {
        res = await postSetup(fresh(), { secret: newSecret() }, { "content-type": "application/json", ...h });
      });
      expect(res!.status, JSON.stringify(h)).toBe(403);
      expect(await res!.json()).toEqual({ error: "this request was not sent from this deployment's admin page" });
      expect(lines.find((l) => l.msg === "request")?.outcome).toBe("setup_forged");
    }
    expect(await setupState(fresh())).toMatchObject({ state: "open" });
    const allowed: Record<string, string>[] = [{ origin }, { origin: "null", "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "same-origin" }, {}];
    for (const h of allowed) {
      await emptyDirectory();
      expect((await postSetup(fresh(), { secret: newSecret() }, { "content-type": "application/json", ...h })).status, JSON.stringify(h)).toBe(201);
    }
  });

  it("is refused once setting is closed, and when a dashboard secret counts", async () => {
    const closedBy: [string, Env, () => Promise<void>][] = [
      ["an old version", deployment(null, versionAt(Date.now() - 2 * setupWindowMs)), async () => {}],
      ["no version", deployment(null, null), async () => {}],
      ["a memory listed", fresh(), () => inDirectory((sql) => void sql.exec(`INSERT INTO memories(name, created_at) VALUES('m', 1)`))],
      ["the record", fresh(), () => inDirectory((sql) => void sql.exec(`INSERT INTO setup_closed(id, closed_at, closed_by) VALUES(1, 1, 'memory')`))],
    ];
    for (const [label, e, arrange] of closedBy) {
      await emptyDirectory();
      await arrange();
      let res: Response | undefined;
      const lines = await logged(async () => {
        res = await postSetup(e, { secret: newSecret() });
      });
      expect(res!.status, label).toBe(403);
      expect(await res!.json(), label).toMatchObject({ state: "closed" });
      expect(lines.find((l) => l.msg === "request")?.outcome, label).toBe("setup_closed");
      expect(await inDirectory((sql) => sql.exec(`SELECT 1 FROM admin_secret`).toArray()), label).toEqual([]);
    }
    await emptyDirectory();
    let res: Response | undefined;
    const lines = await logged(async () => {
      res = await postSetup(deployment(adminSecret), { secret: newSecret() });
    });
    expect(res!.status).toBe(409);
    expect(lines.find((l) => l.msg === "request")?.outcome).toBe("setup_taken");
    expect(await inDirectory((sql) => sql.exec(`SELECT 1 FROM admin_secret`).toArray())).toEqual([]);
  });

  it("is taken by exactly one of several posts at once", async () => {
    for (const n of [2, 5]) {
      await emptyDirectory();
      const secrets = Array.from({ length: n }, newSecret);
      const answers = await Promise.all(secrets.map((secret) => postSetup(fresh(), { secret })));
      const statuses = answers.map((r) => r.status);
      expect([...statuses].sort(), String(n)).toEqual([201, ...Array<number>(n - 1).fill(409)]);
      const winner = secrets[statuses.indexOf(201)]!;
      for (const secret of secrets) expect((await adminCall(fresh(), secret)).status).toBe(secret === winner ? 200 : 401);
    }
  });

  it("closes once a memory is registered, for good", async () => {
    expect(await setupState(fresh())).toMatchObject({ state: "open" });
    await directory().register("m-registered", Date.now());
    expect(await setupState(fresh())).toMatchObject({ state: "closed" });
    // Taken off the list again, the directory still remembers.
    expect(await directory().unregister("m-registered")).toBe(true);
    expect(await setupState(fresh())).toMatchObject({ state: "closed" });
    expect(await inDirectory((sql) => sql.exec(`SELECT closed_by FROM setup_closed`).toArray())).toEqual([{ closed_by: "memory" }]);
    expect((await postSetup(fresh(), { secret: newSecret() })).status).toBe(403);
  });

  it("is refused by the directory itself once closed, whatever the Worker read a moment before", async () => {
    // The Worker reads the state and then asks the directory to set. A
    // memory registered, or a dashboard secret seen, between the two wins.
    const stored = { salt: "00".repeat(16), hash: "11".repeat(32) };
    await directory().register("m-between", Date.now());
    expect(await directory().setIfOpen(stored, Date.now())).toBe("closed");
    await emptyDirectory();
    await directory().dashboardRules(Date.now());
    expect(await directory().setIfOpen(stored, Date.now())).toBe("closed");
    expect(await inDirectory((sql) => sql.exec(`SELECT 1 FROM admin_secret`).toArray())).toEqual([]);
    await emptyDirectory();
    expect(await directory().setIfOpen(stored, Date.now())).toBe("set");
    expect(await directory().setIfOpen(stored, Date.now())).toBe("taken");
    expect(await inDirectory((sql) => sql.exec(`SELECT 1 FROM admin_secret`).toArray())).toHaveLength(1);
  });
});

describe("a secret set on the page", () => {
  beforeEach(emptyDirectory);

  async function setOne(): Promise<string> {
    const secret = newSecret();
    expect((await postSetup(fresh(), { secret })).status).toBe(201);
    return secret;
  }

  it("opens the admin API, and nothing else does", async () => {
    const secret = await setOne();
    const e = fresh();
    const name = freshName();
    const made = await adminCall(e, secret, `/admin/memories/${name}`, "POST");
    expect(made.status).toBe(201);
    const token = ((await made.json()) as { token: string }).token;
    const list = await adminCall(e, secret);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { memories: { name: string }[] }).memories.map((m) => m.name)).toEqual([name]);
    for (const wrong of [null, "wrong", `${secret}x`, secret.slice(1), secret.toUpperCase(), token, adminSecret, "aa", "bb"]) {
      const res = await adminCall(e, wrong);
      expect(res.status, String(wrong)).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="ziwo"');
      expect((await adminCall(e, wrong, `/admin/memories/${name}`)).status, String(wrong)).toBe(401);
    }
  });

  it("is weighed against the limit on guessing", async () => {
    const secret = await setOne();
    const e = fresh();
    const address = "203.0.113.77";
    for (let i = 0; i < maxMisses; i++) expect((await adminCall(e, `wrong-${i}`, "/admin/memories", "GET", address)).status).toBe(401);
    // Right or wrong, the address waits.
    const res = await adminCall(e, secret, "/admin/memories", "GET", address);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await adminCall(e, secret, "/admin/memories", "GET", "203.0.113.78")).status).toBe(200);
    // A right one is not counted.
    const key = addressOf(new Request(origin, { headers: { "cf-connecting-ip": "203.0.113.79" } }))!;
    for (let i = 0; i < 3; i++) expect((await adminCall(e, secret, "/admin/memories", "GET", "203.0.113.79")).status).toBe(200);
    expect(await env.GUARD.getByName(key).misses(Date.now())).toBe(0);
  });

  it("approves a client on the consent page, and another secret does not", async () => {
    const secret = await setOne();
    const e = fresh();
    const name = freshName();
    expect((await adminCall(e, secret, `/admin/memories/${name}`, "POST")).status).toBe(201);
    const clientId = await register("Test client", undefined, e);
    const p = await pkce();
    const page = await openPage(authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(name) }), {}, e);
    expect(page.res.status, page.html).toBe(200);
    for (const wrong of ["wrong", `${secret}x`, adminSecret, "aa"]) expect((await approve(page, wrong, e)).status, wrong).toBe(403);
    // The page trims what is typed, as for a token.
    const ok = await approve(page, ` ${secret} `, e);
    expect(ok.status).toBe(302);
    expect(new URL(ok.headers.get("location")!).searchParams.get("code")).not.toBeNull();
  });

  it("is kept and logged nowhere in the clear", async () => {
    const secret = newSecret();
    const e = fresh();
    const name = freshName();
    const lines = await logged(async () => {
      expect((await postSetup(e, { secret })).status).toBe(201);
      expect((await postSetup(e, { secret })).status).toBe(409);
      expect((await adminCall(e, secret, `/admin/memories/${name}`, "POST")).status).toBe(201);
      expect((await adminCall(e, `${secret}-wrong`)).status).toBe(401);
      const clientId = await register("Test client", undefined, e);
      const page = await openPage(authorizePath({ clientId, challenge: (await pkce()).challenge, resource: resourceOf(name) }), {}, e);
      expect((await approve(page, secret, e)).status).toBe(302);
    });
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) expect(JSON.stringify(l)).not.toContain(secret);
    const outcomes = lines.filter((l) => l.path === "/admin/setup").map((l) => [l.status, l.outcome]);
    expect(outcomes).toEqual([[201, "setup_set"], [409, "setup_taken"]]);
    for (const l of lines.filter((x) => x.path === "/admin/setup")) {
      for (const k of Object.keys(l)) expect(["msg", "method", "path", "status", "dur_ms", "agent", "outcome"]).toContain(k);
    }
    // Every row of every table of the directory.
    const rows = await inDirectory((sql) => {
      const tables = sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`).toArray();
      return tables.map((t) => ({ table: t.name, rows: sql.exec(`SELECT * FROM "${t.name}"`).toArray() }));
    });
    expect(JSON.stringify(rows)).not.toContain(secret);
    const stored = rows.find((r) => r.table === "admin_secret")!.rows;
    expect(stored).toHaveLength(1);
    const row = stored[0] as { salt: string; hash: string };
    expect(row.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(row.hash).toBe(await sha256Hex(row.salt + secret));
    expect(row.hash).not.toBe(await sha256Hex(secret));
  });

  it("is salted afresh each time", async () => {
    const secret = newSecret();
    expect((await postSetup(fresh(), { secret })).status).toBe(201);
    const first = await inDirectory((sql) => sql.exec<{ salt: string; hash: string }>(`SELECT salt, hash FROM admin_secret`).one());
    await emptyDirectory();
    expect((await postSetup(fresh(), { secret })).status).toBe(201);
    const second = await inDirectory((sql) => sql.exec<{ salt: string; hash: string }>(`SELECT salt, hash FROM admin_secret`).one());
    expect(second.salt).not.toBe(first.salt);
    expect(second.hash).not.toBe(first.hash);
  });
});
