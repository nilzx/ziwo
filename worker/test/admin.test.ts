// The admin routes the owner runs a deployment with: the directory of
// memories, one memory's figures and settings, check, rebuild, export and
// import as routes (their formats are in export.test.ts), and /healthz.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import type { Memory as MemoryObject } from "../src/memory-object";
import { reportText } from "../src/store/check";
import { defaultParams } from "../src/store/decay";
import { dump } from "./helpers";
import { exampleAdminSecret, minAdminSecret } from "../src/admin";
import { adminSecret, Client, createMemory, fetchWorker, freshName, idIn, modern, origin, testEnv } from "./mcp-helpers";

interface Init {
  method?: string;
  body?: string;
  secret?: string | null;
  accept?: string;
  env?: Env;
}

function admin(path: string, init: Init = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  const secret = init.secret === undefined ? adminSecret : init.secret;
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  if (init.accept !== undefined) headers.accept = init.accept;
  return fetchWorker(path, { method: init.method ?? "GET", headers, body: init.body }, init.env);
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function tablesOf(name: string): Promise<string[]> {
  return runInDurableObject(env.MEMORY.getByName(name), (_obj: MemoryObject, state) =>
    state.storage.sql
      .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`)
      .toArray()
      .map((r) => r.name),
  );
}

function inMemory<R>(name: string, fn: (obj: MemoryObject, storage: DurableObjectStorage) => R): Promise<R> {
  return runInDurableObject(env.MEMORY.getByName(name), (obj: MemoryObject, state) => fn(obj, state.storage));
}

// A memory with a little in it, written over MCP.
async function livedIn(): Promise<{ name: string; token: string }> {
  const m = await createMemory();
  const c = new Client("new", m);
  const s = idIn(await c.ok("get_context", { model: "model-a" }), "s_");
  for (const gist of ["first admin moment", "second admin moment", "third admin moment"]) {
    await c.ok("remember", { session_id: s, gist, body: "a body" });
  }
  await c.ok("recall", { query: "admin", session_id: s });
  return m;
}

// Every route under a memory, with a method it answers to.
const memoryRoutes: [method: string, suffix: string][] = [
  ["GET", ""], ["PUT", "/settings"], ["GET", "/check"], ["POST", "/rebuild"], ["GET", "/export"], ["POST", "/import"],
  ["POST", ""], ["POST", "/token"],
];

describe("/healthz", () => {
  it("answers ok without auth, as the Go host does", async () => {
    for (const e of [testEnv(), testEnv(null)]) {
      const res = await fetchWorker("/healthz", {}, e);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await res.text()).toBe("ok\n");
    }
    expect((await fetchWorker("/healthz", { method: "HEAD" })).status).toBe(200);
    const post = await fetchWorker("/healthz", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("the admin routes", () => {
  it("are not there without ADMIN_SECRET, or with one that does not count", async () => {
    const m = await createMemory();
    const short = "x".repeat(minAdminSecret - 1);
    for (const secret of [null, "", exampleAdminSecret, short]) {
      const e = testEnv(secret);
      // Presenting the very value that is set opens nothing either.
      if (secret !== null && secret !== "") expect((await admin("/admin/memories", { env: e, secret })).status).toBe(404);
      expect((await admin("/admin/memories", { env: e })).status).toBe(404);
      for (const [method, suffix] of memoryRoutes) {
        const res = await admin(`/admin/memories/${m.name}${suffix}`, { method, env: e, body: method === "GET" ? undefined : "{}" });
        expect(res.status, `${method} ${suffix}`).toBe(404);
      }
    }
  });

  it("are there with a secret of 16 characters, counted as characters", async () => {
    for (const secret of ["x".repeat(minAdminSecret), "密".repeat(minAdminSecret)]) {
      const e = testEnv(secret);
      const headers = { authorization: `Bearer ${encodeURIComponent(secret) === secret ? secret : "wrong"}` };
      // A secret outside ASCII cannot be sent in a header: the API is there, and refuses.
      const res = await fetchWorker("/admin/memories", { headers }, e);
      expect(res.status).toBe(secret.startsWith("x") ? 200 : 401);
    }
  });

  it("need the secret", async () => {
    const m = await createMemory();
    for (const secret of [null, "wrong", `${adminSecret}x`, m.token]) {
      const list = await admin("/admin/memories", { secret });
      expect(list.status).toBe(401);
      expect(list.headers.get("www-authenticate")).toBe('Bearer realm="ziwo"');
      for (const [method, suffix] of memoryRoutes) {
        const res = await admin(`/admin/memories/${m.name}${suffix}`, { method, secret, body: method === "GET" ? undefined : "{}" });
        expect(res.status, `${method} ${suffix} ${secret}`).toBe(401);
      }
    }
    // Nothing was changed by a refused request.
    expect((await admin(`/admin/memories/${m.name}`).then(body)).events).toBe(0);
  });

  it("answer 404 to a memory that does not exist, and store nothing for it", async () => {
    const name = freshName();
    for (const [method, suffix] of memoryRoutes) {
      if (suffix === "/import" || (method === "POST" && suffix === "")) continue;
      const res = await admin(`/admin/memories/${name}${suffix}`, { method, body: method === "PUT" ? `{"timeZone":"UTC"}` : undefined });
      expect(res.status, `${method} ${suffix}`).toBe(404);
      expect(await res.json()).toEqual({ error: `no such memory: "${name}"` });
    }
    expect(await tablesOf(name)).toEqual([]);
  });

  it("refuse a name the Go host would refuse", async () => {
    for (const [method, suffix] of memoryRoutes) {
      const res = await admin(`/admin/memories/Bad${suffix}`, { method, body: method === "GET" ? undefined : "{}" });
      expect(res.status, `${method} ${suffix}`).toBe(400);
      expect(await res.json()).toEqual({
        error: `invalid memory name "Bad": use 1 to 32 lower-case letters, digits, - or _, starting with a letter or digit`,
      });
    }
  });

  it("answer 404 to other paths and methods, before the secret is weighed", async () => {
    const m = await createMemory();
    for (const [method, path] of [
      ["POST", "/admin/memories"], ["PUT", "/admin/memories"], ["GET", "/admin/memories/"], ["GET", "/admin"], ["GET", "/admin/other"],
      // DELETE on a memory is a route now (delete.test.ts).
      ["PATCH", `/admin/memories/${m.name}`], ["DELETE", `/admin/memories/${m.name}/check`],
      ["GET", `/admin/memories/${m.name}/settings`], ["POST", `/admin/memories/${m.name}/settings`],
      ["POST", `/admin/memories/${m.name}/check`], ["GET", `/admin/memories/${m.name}/rebuild`], ["POST", `/admin/memories/${m.name}/export`],
      ["GET", `/admin/memories/${m.name}/import`], ["GET", `/admin/memories/${m.name}/token`], ["GET", `/admin/memories/${m.name}/check/x`],
      ["GET", `/admin/memories/${m.name}/other`],
    ]) {
      for (const secret of [adminSecret, null]) {
        const res = await admin(path!, { method, secret });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.text()).toBe("404 page not found\n");
      }
    }
  });
});

describe("the directory", () => {
  it("lists every memory created or brought back, with its figures", async () => {
    const start = Date.now();
    const a = await livedIn();
    const b = await createMemory();
    const exported = await (await admin(`/admin/memories/${a.name}/export`)).text();
    const c = freshName();
    expect((await admin(`/admin/memories/${c}/import`, { method: "POST", body: exported })).status).toBe(201);
    // A name listed whose memory does not exist is shown as such.
    const ghost = freshName();
    await env.DIRECTORY.getByName("directory").register(ghost, start);
    // A name registered again keeps its first time.
    await env.DIRECTORY.getByName("directory").register(ghost, start + 1000);

    const res = await admin("/admin/memories");
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { memories: Record<string, unknown>[] }).memories;
    const names = rows.map((r) => r.name as string);
    expect(names).toEqual([...names].sort());
    const row = (n: string) => rows.find((r) => r.name === n)!;
    for (const n of [a.name, b.name, c]) {
      expect(row(n).createdAt).toBeGreaterThanOrEqual(start);
      expect(Object.keys(row(n)).sort()).toEqual(["createdAt", "events", "hasToken", "lastEventAt", "memories", "name"]);
    }
    const stats = await inMemory(a.name, (obj) => obj.store.logStats());
    expect(row(a.name)).toMatchObject({ memories: 3, events: stats.events, lastEventAt: stats.lastEventAt, hasToken: true });
    expect(row(b.name)).toMatchObject({ memories: 0, events: 0, lastEventAt: null, hasToken: true });
    expect(row(c)).toMatchObject({ memories: 3, events: stats.events + 1, hasToken: true });
    expect(row(ghost)).toEqual({ name: ghost, createdAt: start, error: "no such memory" });
    expect(await tablesOf(ghost)).toEqual([]);
  });

  it("mends itself: a memory asked for by name is listed from then on, and keeps its first time", async () => {
    const listed = async () =>
      ((await (await admin("/admin/memories")).json()) as { memories: { name: string; createdAt: number }[] }).memories;
    // Made through the object, as before the directory existed.
    const name = freshName();
    expect(await env.MEMORY.getByName(name).create("0".repeat(64))).toBe("created");
    expect((await listed()).some((r) => r.name === name)).toBe(false);
    const before = Date.now();
    expect((await admin(`/admin/memories/${name}`)).status).toBe(200);
    const first = (await listed()).find((r) => r.name === name);
    expect(first?.createdAt).toBeGreaterThanOrEqual(before);
    expect((await admin(`/admin/memories/${name}`)).status).toBe(200);
    expect((await listed()).find((r) => r.name === name)).toEqual(first);
    // A name that names nothing is not listed by asking for it.
    const none = freshName();
    expect((await admin(`/admin/memories/${none}`)).status).toBe(404);
    expect((await listed()).some((r) => r.name === none)).toBe(false);
  });

  it("lists, and exports, without building a memory's tables, as Go's LogOnly store does", async () => {
    const m = await livedIn();
    // Mark the tables stale and drop the built store, as a new build would.
    const stale = () => inMemory(m.name, (obj, storage) => {
      storage.sql.exec(`UPDATE meta SET value = 'stale' WHERE key = 'derived'`);
      (obj as unknown as { built?: unknown }).built = undefined;
    });
    const derived = () => inMemory(m.name, (_obj, storage) =>
      storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'derived'`).one().value);
    await stale();
    expect((await admin("/admin/memories")).status).toBe(200);
    expect((await admin(`/admin/memories/${m.name}/export`)).status).toBe(200);
    expect(await derived()).toBe("stale");
    // Anything that reads the tables builds them.
    expect((await admin(`/admin/memories/${m.name}`)).status).toBe(200);
    expect(await derived()).not.toBe("stale");
  });

  it("is never reached on the path of an MCP request", async () => {
    const calls: string[] = [];
    const ns = {
      getByName(name: string) {
        const stub = env.DIRECTORY.getByName(name);
        return new Proxy(stub, {
          get(target, prop) {
            if (typeof prop !== "string") return Reflect.get(target, prop);
            const methods = target as unknown as Record<string, (...a: unknown[]) => unknown>;
            return (...args: unknown[]) => {
              calls.push(prop);
              return methods[prop]!(...args);
            };
          },
        });
      },
    };
    const e: Env = { ...testEnv(), DIRECTORY: ns as unknown as Env["DIRECTORY"] };
    const name = freshName();
    const made = await body(await admin(`/admin/memories/${name}`, { method: "POST", env: e }));
    expect(calls).toEqual(["register"]);
    calls.length = 0;
    const post = (method: string, params: Record<string, unknown>, id = 1) =>
      worker.fetch(
        new Request(`${origin}/${name}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json", accept: "application/json, text/event-stream",
            authorization: `Bearer ${made.token as string}`, "mcp-protocol-version": modern, "mcp-method": method,
            ...("name" in params ? { "mcp-name": String(params.name) } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: new Client("new", { name, token: "" }).meta() } }),
        }),
        e,
      );
    for (const [method, params] of [
      ["server/discover", {}], ["tools/list", {}], ["tools/call", { name: "get_context", arguments: {} }],
      ["tools/call", { name: "check", arguments: {} }],
    ] as const) {
      const res = await post(method, params);
      expect(res.status, method).toBe(200);
      await res.text();
    }
    expect(calls).toEqual([]);
    await admin("/admin/memories", { env: e });
    expect(calls).toEqual(["list"]);
  });
});

describe("one memory", () => {
  it("shows its figures, its forgetting parameters and its time zone", async () => {
    const m = await livedIn();
    const res = await admin(`/admin/memories/${m.name}`);
    expect(res.status).toBe(200);
    const stats = await inMemory(m.name, (obj) => obj.store.logStats());
    expect(await res.json()).toEqual({
      memory: m.name, endpoint: `/${m.name}/mcp`, memories: 3, events: stats.events, lastEventAt: stats.lastEventAt, hasToken: true,
      params: defaultParams(), timeZone: "UTC",
      // Search by meaning is off without an AI binding.
      vectors: { embedding: null, held: [], waiting: null },
    });
  });

  it("changes its parameters, its time zone, or both", async () => {
    const m = await livedIn();
    const before = await inMemory(m.name, (obj, storage) => dump(obj.store, storage));
    const put = (b: unknown) => admin(`/admin/memories/${m.name}/settings`, { method: "PUT", body: JSON.stringify(b) });
    let res = await put({ params: { baseStrength: 10, recallBoost: 1 } });
    expect(res.status).toBe(200);
    const params = { ...defaultParams(), baseStrength: 10, recallBoost: 1 };
    expect(await res.json()).toEqual({ memory: m.name, params, timeZone: "UTC" });
    // The derived tables were rebuilt with them.
    const after = await inMemory(m.name, (obj, storage) => ({ dump: dump(obj.store, storage), params: obj.store.params() }));
    expect(after.params).toEqual(params);
    expect(after.dump).not.toBe(before);
    res = await put({ timeZone: "Asia/Shanghai" });
    expect(await res.json()).toEqual({ memory: m.name, params, timeZone: "Asia/Shanghai" });
    res = await put({ params: { coreImportance: 0.8 }, timeZone: "Europe/Paris" });
    expect(await res.json()).toEqual({ memory: m.name, params: { ...params, coreImportance: 0.8 }, timeZone: "Europe/Paris" });
    expect(await body(await admin(`/admin/memories/${m.name}`))).toMatchObject({ params: { ...params, coreImportance: 0.8 }, timeZone: "Europe/Paris" });
  });

  it("refuses an invalid setting with the store's message and changes nothing", async () => {
    const m = await livedIn();
    const put = (b: string) => admin(`/admin/memories/${m.name}/settings`, { method: "PUT", body: b });
    const cases: [string, string][] = [
      [`{"params":{"fadeBelow":0.01},"timeZone":"Asia/Tokyo"}`, "need 0 < archive threshold < fade threshold < 1, got archive 0.05, fade 0.01"],
      [`{"params":{"baseStrength":-1}}`, "base strength must be positive and at most 1000000000, got -1"],
      [`{"params":{"baseStrength":20},"timeZone":"Mars/Base"}`, `unknown time zone "Mars/Base": give an IANA name such as Asia/Shanghai`],
      [`{"timeZone":""}`, `unknown time zone "": give an IANA name such as Asia/Shanghai`],
      [`not json`, "the body must be a JSON object with params, timeZone or both"],
      [`[1]`, "the body must be a JSON object with params, timeZone or both"],
      [`{}`, "the body must be a JSON object with params, timeZone or both"],
      [`{"zone":"UTC"}`, `unknown setting "zone": give params, timeZone or both`],
      [`{"params":{"strength":3}}`, `unknown parameter "strength": the parameters are baseStrength, recallBoost, fadeBelow, archiveBelow, coreImportance, coreFeeling`],
      [`{"params":{"baseStrength":"3"}}`, "parameter baseStrength must be a number"],
      [`{"params":[1]}`, "params must be an object"],
      [`{"timeZone":3}`, "timeZone must be a string, an IANA name such as Asia/Shanghai"],
    ];
    const before = await inMemory(m.name, (obj, storage) => ({ dump: dump(obj.store, storage), zone: obj.timeZone(), params: obj.params() }));
    for (const [b, message] of cases) {
      const res = await put(b);
      expect(res.status, b).toBe(400);
      expect(await res.json(), b).toEqual({ error: message });
    }
    const after = await inMemory(m.name, (obj, storage) => ({ dump: dump(obj.store, storage), zone: obj.timeZone(), params: obj.params() }));
    expect(after).toEqual(before);
  });

  it("is checked, as JSON or as the text the tool gives", async () => {
    const m = await livedIn();
    const report = await inMemory(m.name, (obj) => obj.check());
    const asJSON = await admin(`/admin/memories/${m.name}/check`);
    expect(asJSON.status).toBe(200);
    expect(asJSON.headers.get("content-type")).toBe("application/json");
    expect(await asJSON.json()).toEqual({ memory: m.name, figures: report.figures, findings: report.findings });
    for (const [accept, text] of [["text/plain", true], ["text/plain; charset=utf-8, */*", true], ["application/json, text/plain", false],
      ["text/plain;q=0.9, application/json", true], ["*/*", false]] as const) {
      const res = await admin(`/admin/memories/${m.name}/check`, { accept });
      if (text) {
        expect(res.headers.get("content-type"), accept).toBe("text/plain; charset=utf-8");
        expect(await res.text()).toBe(reportText(report));
      } else {
        expect(res.headers.get("content-type"), accept).toBe("application/json");
      }
    }
    // The text is the check tool's, word for word.
    const c = new Client("new", m);
    expect(await c.ok("check", {})).toBe(reportText(report));
  });

  it("is rebuilt from its log, which gives the same tables", async () => {
    const m = await livedIn();
    const before = await inMemory(m.name, (obj, storage) => ({ dump: dump(obj.store, storage), counts: obj.store.counts() }));
    // Damage a derived table, as only a rebuild repairs it.
    await inMemory(m.name, (_obj, storage) => storage.sql.exec(`DELETE FROM carriers`));
    const res = await admin(`/admin/memories/${m.name}/rebuild`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ memory: m.name, memories: 3, events: before.counts.events });
    expect(await inMemory(m.name, (obj, storage) => dump(obj.store, storage))).toBe(before.dump);
  });
});

describe("the access log of the admin routes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs a failure by the names of the error and the action, and answers 500", async () => {
    const m = await livedIn();
    await inMemory(m.name, (_obj, storage) => storage.sql.exec(`DROP TABLE contents`));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    const res = await admin(`/admin/memories/${m.name}/export`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "the request could not be served; see the server log" });
    const failed = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((p) => p.msg === "admin failed");
    expect(failed).toEqual({ msg: "admin failed", memory: m.name, action: "export", error: "Error" });
  });

  it("holds no body, no argument and no token", async () => {
    const m = await createMemory();
    const marker = "adminlogmarker";
    const c = new Client("new", m);
    const s = idIn(await c.ok("get_context", {}), "s_");
    await c.ok("remember", { session_id: s, gist: `${marker} gist`, body: `${marker} body` });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    const file = await (await admin(`/admin/memories/${m.name}/export`)).text();
    expect(file).toContain(marker);
    const copy = freshName();
    await admin(`/admin/memories/${copy}/import`, { method: "POST", body: file });
    await admin(`/admin/memories/${copy}/import`, { method: "POST", body: file.replace(marker, "x") });
    await admin(`/admin/memories/${m.name}/settings`, { method: "PUT", body: `{"timeZone":"${marker}"}` });
    await admin(`/admin/memories/${m.name}/check`, { accept: "text/plain" });
    await admin(`/admin/memories/${m.name}`);
    await admin("/admin/memories");
    await admin(`/admin/memories/${m.name}/rebuild`, { method: "POST" });
    const fresh = await body(await admin(`/admin/memories/${freshName()}/import`, {
      method: "POST",
      body: file.replace(/,"token_sha256":"[0-9a-f]+"/, ""),
    }));
    expect(fresh.token).toMatch(/^ziwo_/);
    expect(lines.length).toBeGreaterThanOrEqual(9);
    for (const l of lines) {
      expect(l).not.toContain(marker);
      expect(l).not.toContain(m.token);
      expect(l).not.toContain(fresh.token as string);
      expect(l).not.toContain(adminSecret);
      const p = JSON.parse(l) as Record<string, unknown>;
      expect(p.msg).toBe("request");
      for (const k of Object.keys(p)) expect(["msg", "method", "path", "status", "dur_ms", "auth", "agent"]).toContain(k);
    }
  });
});
