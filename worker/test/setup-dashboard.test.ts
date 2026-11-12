// A dashboard secret that appears after one was set on the page: it rules,
// the page's is erased, and once it is taken away again there is no admin
// secret and nothing can be set on the page: the dashboard is the only way
// back in. The directory is told once per isolate, and only once it
// answered; this file's tests run in order in an isolate of their own, so
// the first request here with a dashboard secret is the first the module
// has seen.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Directory } from "../src/directory";
import type { Env } from "../src/index";
import { adminSecret, fetchWorker, freshName, origin, testEnv } from "./mcp-helpers";
import { approve, authorizePath, openPage, pkce, register, resourceOf } from "./oauth-helpers";

const fresh = (): Env => ({ ...testEnv(null), VERSION: { id: "v", tag: "", timestamp: new Date(Date.now() - 60_000).toISOString() } });
const withDashboard = (): Env => ({ ...fresh(), ADMIN_SECRET: adminSecret });

const directory = () => env.DIRECTORY.getByName("directory");

function rows(table: string): Promise<Record<string, SqlStorageValue>[]> {
  return runInDurableObject(directory(), (_obj: Directory, state) => state.storage.sql.exec(`SELECT * FROM ${table}`).toArray());
}

function adminCall(e: Env, secret: string | null, path = "/admin/memories", method = "GET"): Promise<Response> {
  return fetchWorker(path, { method, headers: secret === null ? {} : { authorization: `Bearer ${secret}` } }, e);
}

async function stateOf(e: Env): Promise<unknown> {
  return (await (await fetchWorker("/admin/setup", {}, e)).json() as { state: string }).state;
}

// A DIRECTORY whose calls by the name given fail, and which counts every call.
function directoryWhere(fails: string | undefined, calls: string[]): Env["DIRECTORY"] {
  return {
    getByName(name: string) {
      const stub = env.DIRECTORY.getByName(name);
      return new Proxy(stub, {
        get(target, prop) {
          if (typeof prop !== "string") return Reflect.get(target, prop);
          const methods = target as unknown as Record<string, (...a: unknown[]) => unknown>;
          return (...args: unknown[]) => {
            calls.push(prop);
            if (prop === fails) return Promise.reject(new Error("directory down"));
            return methods[prop]!(...args);
          };
        },
      });
    },
  } as unknown as Env["DIRECTORY"];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a dashboard secret that appears after one was set on the page", () => {
  const pageSecret = `pg-${crypto.randomUUID()}`;
  const name = freshName();
  let token = "";

  it("is told to the directory only once it answers, and a failure fails no request", async () => {
    expect((await fetchWorker("/admin/setup", {
      method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ secret: pageSecret }),
    }, fresh())).status).toBe(201);
    const made = await adminCall(fresh(), pageSecret, `/admin/memories/${name}`, "POST");
    expect(made.status).toBe(201);
    token = ((await made.json()) as { token: string }).token;

    // The directory cannot be told: the request is served all the same, and
    // the failure is logged without a secret.
    const calls: string[] = [];
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    const down = { ...withDashboard(), DIRECTORY: directoryWhere("dashboardRules", calls) };
    expect((await adminCall(down, adminSecret)).status).toBe(200);
    expect((await adminCall(down, adminSecret)).status).toBe(200);
    expect(calls.filter((c) => c === "dashboardRules")).toHaveLength(2);
    const failed = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === "directory unavailable");
    expect(failed).toEqual([
      { msg: "directory unavailable", step: "dashboard secret", error: "Error" },
      { msg: "directory unavailable", step: "dashboard secret", error: "Error" },
    ]);
    for (const l of lines) {
      expect(l).not.toContain(adminSecret);
      expect(l).not.toContain(pageSecret);
    }
    expect(await rows("admin_secret")).toHaveLength(1);
    vi.restoreAllMocks();

    // Now it answers: told once, and not again in this isolate.
    calls.length = 0;
    const up = { ...withDashboard(), DIRECTORY: directoryWhere(undefined, calls) };
    expect((await adminCall(up, adminSecret)).status).toBe(200);
    expect((await adminCall(up, adminSecret)).status).toBe(200);
    expect(await stateOf(up)).toBe("set");
    expect(calls.filter((c) => c === "dashboardRules")).toHaveLength(1);
  });

  it("rules: the page's secret is erased, and refused while the dashboard's counts", async () => {
    expect(await rows("admin_secret")).toEqual([]);
    expect(await rows("setup_closed")).toEqual([expect.objectContaining({ id: 1, closed_by: "page" })]);
    expect((await adminCall(withDashboard(), pageSecret)).status).toBe(401);
    expect((await adminCall(withDashboard(), adminSecret, `/admin/memories/${name}`)).status).toBe(200);
  });

  it("taken away again leaves no admin secret, and nothing to set on the page", async () => {
    const e = fresh();
    expect(await stateOf(e)).toBe("closed");
    expect((await adminCall(e, null)).status).toBe(404);
    expect((await adminCall(e, pageSecret)).status).toBe(404);
    expect((await adminCall(e, pageSecret, `/admin/memories/${name}`)).status).toBe(404);
    const post = await fetchWorker("/admin/setup", {
      method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ secret: `pg-${crypto.randomUUID()}` }),
    }, e);
    expect(post.status).toBe(403);
    expect(await rows("admin_secret")).toEqual([]);
    // Nor does the consent page take the old secret; the memory's token still approves.
    const clientId = await register("Test client", undefined, e);
    const p = await pkce();
    const page = await openPage(authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(name) }), {}, e);
    expect(page.res.status, page.html).toBe(200);
    expect((await approve(page, pageSecret, e)).status).toBe(403);
    expect((await approve(page, adminSecret, e)).status).toBe(403);
    expect((await approve(page, token, e)).status).toBe(302);
  });

  it("and set again in the dashboard, it is the admin secret once more", async () => {
    expect((await adminCall(withDashboard(), adminSecret)).status).toBe(200);
    expect((await adminCall(withDashboard(), pageSecret)).status).toBe(401);
  });
});
