import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/http";
import { directoryName } from "../src/directory";
import { adminSecret, createMemory, fetchWorker } from "./mcp-helpers";

const admin = (path: string, method = "GET", body?: unknown, secret = adminSecret) => fetchWorker(path, {
  method, headers: { authorization: `Bearer ${secret}` }, body: body === undefined ? undefined : JSON.stringify(body),
});
const register = (name: string, requestId?: string) => admin("/admin/harnesses", "POST", { name, ...(requestId === undefined ? {} : { requestId }) });
const auth = (token: string) => fetchWorker("/harness/v1/binding?threadId=synthetic", { headers: { authorization: `Bearer ${token}` } });
const metadata = (value: Record<string, unknown>) => {
  expect(Object.keys(value).sort()).toEqual(["bindingCount", "createdAt", "id", "name", "requestId", "revoked"].sort());
};

describe("host registry", () => {
  it("serializes concurrent registration, persists receipts, and never reissues credentials", async () => {
    const requestId = `request:${crypto.randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 8 }, () => register("  concurrent host  ", requestId)));
    expect(results.map(r => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    for (const r of results) expect(r.headers.get("cache-control")).toContain("no-store");
    const bodies = await Promise.all(results.map(r => r.json() as Promise<Record<string, any>>));
    const first = bodies[results.findIndex(r => r.status === 201)]!;
    expect(first.name).toBe("concurrent host"); expect(first.token).toBeTruthy();
    for (const b of bodies.filter(b => b !== first)) {
      expect(b).toMatchObject({ id: first.id, name: first.name, createdAt: first.createdAt, requestId, replayed: true, tokenAvailable: false });
      expect(b).not.toHaveProperty("token");
    }
    expect((await register("different host", requestId)).status).toBe(409);
    await evictDurableObject(env.DIRECTORY.getByName(directoryName));
    expect((await register("concurrent host", requestId)).status).toBe(200);
    const rotation = await admin(`/admin/harnesses/${first.id}/token`, "POST"); expect(rotation.status).toBe(200);
    const replacement = await rotation.json() as { token: string };
    expect((await auth(first.token)).status).toBe(401); expect((await auth(replacement.token)).status).toBe(200);
    expect((await register("concurrent host", requestId)).status).toBe(200);
    expect((await auth(replacement.token)).status).toBe(200);
    expect((await admin(`/admin/harnesses/${first.id}`, "DELETE")).status).toBe(200);
    expect((await register("concurrent host", requestId)).status).toBe(200);
    expect((await auth(replacement.token)).status).toBe(401);
    const detail = await admin(`/admin/harnesses/${first.id}`); expect(detail.status).toBe(200);
    const data = await detail.json() as Record<string, unknown>; metadata(data); expect(data.revoked).toBe(true);
  });

  it("supports legacy registration, exact filters, and complete ordered pagination without secrets", async () => {
    const prefix = `listing-${crypto.randomUUID()}`;
    const made = await Promise.all(Array.from({ length: 5 }, (_, i) => register(`${prefix}-${i}`, `${prefix}:${i}`)));
    const rows = await Promise.all(made.map(r => r.json() as Promise<Record<string, any>>));
    const legacy = await register(`${prefix}-legacy`); expect(legacy.status).toBe(201);
    const old = await legacy.json() as Record<string, any>; expect(old.token).toBeTruthy();
    const got: Record<string, any>[] = []; let after: string | null = null;
    do {
      const r = await admin(`/admin/harnesses?limit=2${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toContain("no-store");
      const page = await r.json() as { harnesses: Record<string, any>[]; nextAfter: string | null };
      page.harnesses.forEach(metadata); got.push(...page.harnesses); after = page.nextAfter;
    } while (after);
    expect(got.map(x => x.id)).toEqual([...got.map(x => x.id)].sort());
    expect(new Set(got.map(x => x.id)).size).toBe(got.length);
    for (const row of [...rows, old]) expect(got.some(x => x.id === row.id)).toBe(true);
    expect(got.find(x => x.id === old.id)?.requestId).toBeNull();
    for (const [key, value] of [["name", rows[0]!.name], ["requestId", rows[0]!.requestId]]) {
      const response = await admin(`/admin/harnesses?${key}=${encodeURIComponent(value)}`);
      const page = await response.json() as { harnesses: Record<string, any>[] };
      expect(page.harnesses.map(x => x.id)).toEqual([rows[0]!.id]);
    }
    const detail = await admin(`/admin/harnesses/${rows[0]!.id}`); metadata(await detail.json() as Record<string, unknown>);
    expect((await admin(`/admin/harnesses/h_${crypto.randomUUID()}`)).status).toBe(404);
  });

  it("does not write on replay and stores only the token digest", async () => {
    const requestId = `audit:${crypto.randomUUID()}`;
    const created = await register("audit host", requestId);
    const first = await created.json() as { id: string; token: string };
    const stub = env.DIRECTORY.getByName(directoryName);
    const inspect = () => runInDurableObject(stub, (_object, state) => ({
      changes: state.storage.sql.exec<{ n: number }>("SELECT total_changes() AS n").toArray()[0]!.n,
      rows: state.storage.sql.exec<{ token_hash: string }>("SELECT token_hash FROM harnesses WHERE id = ?", first.id).toArray(),
    }));
    const before = await inspect();
    expect(before.rows).toEqual([{ token_hash: await sha256Hex(first.token) }]);
    expect(JSON.stringify(before.rows)).not.toContain(first.token);
    expect((await register("audit host", requestId)).status).toBe(200);
    expect(await inspect()).toEqual(before);
  });

  it("counts retained bindings even after the host is revoked", async () => {
    const memory = await createMemory();
    const identityResponse = await admin(`/admin/memories/${memory.name}/identity`);
    const identity = await identityResponse.json() as { instance: string; identity: { id: string } };
    const created = await register(`binding host ${crypto.randomUUID()}`, `binding:${crypto.randomUUID()}`);
    const host = await created.json() as { id: string; token: string };
    const binding = await fetchWorker("/harness/v1/bind", {
      method: "POST", headers: { authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ threadId: `thread_${crypto.randomUUID()}`, memory: memory.name, instance: identity.instance, identityId: identity.identity.id, activationId: "activation", source: "conversation" }),
    });
    expect(binding.status).toBe(200);
    expect((await admin(`/admin/harnesses/${host.id}`, "DELETE")).status).toBe(200);
    const result = await admin(`/admin/harnesses/${host.id}`);
    const detail = await result.json() as Record<string, unknown>;
    metadata(detail); expect(detail.bindingCount).toBe(1); expect(detail.revoked).toBe(true);
  });

  it("rejects invalid requests and protects every route", async () => {
    for (const requestId of ["", "bad space", "x".repeat(201)]) expect((await register("host", requestId)).status).toBe(400);
    for (const query of ["unknown=x", "name=a&name=b", "requestId=a&requestId=b", "after=a&after=b", "limit=0", "limit=101", "limit=abc", "limit=1&limit=2"]) {
      expect((await admin(`/admin/harnesses?${query}`)).status).toBe(400);
    }
    const id = `h_${crypto.randomUUID()}`;
    for (const [path, method] of [["/admin/harnesses", "GET"], ["/admin/harnesses", "POST"], [`/admin/harnesses/${id}`, "GET"], [`/admin/harnesses/${id}/token`, "POST"], [`/admin/harnesses/${id}`, "DELETE"]]) {
      const r = await admin(path!, method!, method === "POST" ? { name: "host" } : undefined, "wrong");
      expect(r.status).toBe(401); expect(r.headers.get("cache-control")).toContain("no-store");
    }
  });
});
