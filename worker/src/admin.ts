// The admin API: what the owner of a deployment uses to run it. Every route
// needs the bearer ADMIN_SECRET and is not there without one that counts
// (adminSecretOf). No route but
// export returns what a memory says: figures, ids, names, settings, the check
// report and the clients granted access only.

import { directoryName, type Listed } from "./directory";
import { waitFor } from "./guard";
import { bearer, encoder, invalidNameMessage, json, type JSONRecord, newToken, notFound, sha256Hex, unauthorized, validName } from "./http";
import type { Env } from "./index";
import { logLine } from "./log";
import { maxBytesInOneGo, tooManyBytes } from "./memory-object";
import { type GrantMetadata, helpersFor } from "./oauth";
import { readParams, type SettingsChange } from "./settings";
import { reportText } from "./store/check";
import type { LogStats } from "./store/types";

// What the access log learns about one request while it is served.
export interface Note {
  auth?: "ok" | "missing" | "rejected";
  // Which credential was weighed: a memory's fixed token, an OAuth access
  // token, or, on the consent page, the token or the admin secret.
  cred?: "token" | "oauth" | "admin";
  protocol?: string;
  // What an MCP request asked for, as one of a fixed list of words.
  rpc?: string;
  // An OAuth step: the endpoint, what it came to in fixed words, the check
  // that refused it, and the memory a consent page was for.
  oauth?: string;
  outcome?: string;
  reason?: string;
  memory?: string;
}

type Action =
  | "create" | "describe" | "delete" | "token" | "settings" | "check" | "rebuild" | "export" | "import" | "grants" | "revoke";

// The routes under /admin/memories/<name>, by last segment and method.
const memoryRoutes: Record<string, Record<string, Action>> = {
  "": { POST: "create", GET: "describe", DELETE: "delete" },
  token: { POST: "token" },
  settings: { PUT: "settings" },
  check: { GET: "check" },
  rebuild: { POST: "rebuild" },
  export: { GET: "export" },
  import: { POST: "import" },
  grants: { GET: "grants" },
};

// A grant's id, as the library draws it.
const grantIdRE = /^[A-Za-z0-9_-]{16}$/;

// The shortest admin secret that counts, and the value the example file
// carries. Someone who deploys with one click types the secret into a form:
// one left at the example's value, or a few characters long, would open
// every memory to whoever guessed it, so it counts as no secret at all.
export const minAdminSecret = 16;
export const exampleAdminSecret = "change-me";

// adminSecretOf is the deployment's admin secret, or undefined when there is
// none that counts.
export function adminSecretOf(env: { ADMIN_SECRET?: string }): string | undefined {
  const secret = env.ADMIN_SECRET;
  if (secret === undefined || secret === exampleAdminSecret || [...secret].length < minAdminSecret) return undefined;
  return secret;
}

// adminAllowed compares the presented secret with ADMIN_SECRET in constant
// time, by hashing both to the same length.
async function adminAllowed(request: Request, secret: string): Promise<"ok" | "missing" | "rejected"> {
  const got = bearer(request);
  if (got === null) return "missing";
  if (got === undefined) return "rejected";
  const [a, b] = await Promise.all([sha256Hex(got), sha256Hex(secret)]);
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b)) ? "ok" : "rejected";
}

const noSuchMemory = (name: string): Response => json(404, { error: `no such memory: ${JSON.stringify(name)}` });

// tooMany answers an address that guessed too often (guard.ts).
function tooMany(seconds: number): Response {
  return new Response(JSON.stringify({ error: `too many wrong attempts from this address; try again in ${seconds} seconds` }) + "\n", {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": String(seconds) },
  });
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

// serveAdmin answers a request whose path starts with /admin/. Unknown paths
// and methods are answered 404 before the secret is weighed, as before.
export async function serveAdmin(request: Request, env: Env, parts: string[], note: Note): Promise<Response> {
  let action: Action | "list" | undefined;
  let name = "";
  let grant = "";
  if (parts[2] === "memories") {
    if (parts.length === 3) {
      if (request.method === "GET") action = "list";
    } else if (parts[3] !== undefined && parts[3] !== "" && parts.length <= 5) {
      name = parts[3];
      action = memoryRoutes[parts[4] ?? ""]?.[request.method];
    } else if (parts.length === 6 && parts[3] !== "" && parts[4] === "grants" && parts[5] !== "" && request.method === "DELETE") {
      // /admin/memories/<name>/grants/<id>
      name = parts[3]!;
      grant = parts[5]!;
      action = "revoke";
    }
  }
  if (action === undefined) return notFound();
  const secret = adminSecretOf(env);
  if (secret === undefined) return notFound();
  note.auth = await adminAllowed(request, secret);
  // A secret presented, right or wrong, is weighed against the limit on
  // guessing; a request without one guesses nothing.
  if (note.auth !== "missing") {
    const wait = await waitFor(env, request, note.auth === "ok");
    if (wait > 0) {
      note.outcome = "too_many";
      return tooMany(wait);
    }
  }
  if (note.auth !== "ok") return unauthorized();
  if (action !== "list" && !validName(name)) return json(400, { error: invalidNameMessage(name) });
  try {
    if (action === "list") return await list(env);
    if (action === "grants" || action === "revoke") return await serveGrants(request, env, name, grant);
    if (action === "delete") return await serveDelete(request, env, name);
    return await serveMemoryAdmin(request, env, name, action);
  } catch (err) {
    logLine({ msg: "admin failed", memory: name, action, error: errorName(err) });
    return json(500, { error: "the request could not be served; see the server log" });
  }
}

// register lists a memory just created. A failure is logged and does not
// undo the creation: the directory is a list, not an authority.
async function register(env: Env, name: string): Promise<void> {
  try {
    await env.DIRECTORY.getByName(directoryName).register(name, Date.now());
  } catch (err) {
    logLine({ msg: "directory unavailable", memory: name, error: errorName(err) });
  }
}

function figures(s: LogStats): JSONRecord {
  return { memories: s.memories, events: s.events, lastEventAt: s.lastEventAt, hasToken: s.hasToken };
}

async function list(env: Env): Promise<Response> {
  const listed: Listed[] = await env.DIRECTORY.getByName(directoryName).list();
  const rows = await Promise.all(
    listed.map(async (l): Promise<JSONRecord> => {
      const row = { name: l.name, createdAt: l.createdAt };
      try {
        const s = await env.MEMORY.getByName(l.name).stats();
        return s === "unknown" ? { ...row, error: "no such memory" } : { ...row, ...figures(s) };
      } catch (err) {
        logLine({ msg: "memory unavailable", memory: l.name, error: errorName(err) });
        return { ...row, error: "cannot be opened right now; see the server log" };
      }
    }),
  );
  return json(200, { memories: rows });
}

async function serveMemoryAdmin(
  request: Request, env: Env, name: string, action: Exclude<Action, "grants" | "revoke" | "delete">,
): Promise<Response> {
  const stub = env.MEMORY.getByName(name);
  const endpoint = `/${name}/mcp`;
  switch (action) {
    case "create": {
      // Each answer that carries a token is the only place it is ever shown:
      // the object keeps its SHA-256 alone.
      const token = newToken();
      if ((await stub.create(await sha256Hex(token))) === "exists") {
        return json(409, { error: `memory ${JSON.stringify(name)} already exists` });
      }
      await register(env, name);
      return json(201, { memory: name, endpoint, token, note: "The token is shown this once. Only its hash is stored." });
    }
    case "token": {
      const token = newToken();
      if ((await stub.replaceToken(await sha256Hex(token))) === "unknown") return noSuchMemory(name);
      return json(200, {
        memory: name, endpoint, token,
        note: "The old token no longer works. The new one is shown this once.",
      });
    }
    case "describe": {
      const d = await stub.describe();
      if (d === "unknown") return noSuchMemory(name);
      // The directory mends itself: a memory whose registration failed, or
      // made before the directory existed, is listed from now on. A name
      // already listed keeps its time.
      await register(env, name);
      return json(200, { memory: name, endpoint, ...figures(d.stats), params: d.params, timeZone: d.timeZone, vectors: d.vectors });
    }
    case "settings": {
      const change = await readSettings(request);
      if (typeof change === "string") return json(400, { error: change });
      const r = await stub.changeSettings(change);
      if (r === "unknown") return noSuchMemory(name);
      if ("invalid" in r) return json(400, { error: r.invalid });
      if ("tooLarge" in r) return json(413, { error: r.tooLarge });
      return json(200, { memory: name, params: r.params, timeZone: r.timeZone });
    }
    case "check": {
      const report = await stub.report();
      if (report === "unknown") return noSuchMemory(name);
      if (wantsText(request)) {
        return new Response(reportText(report), { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      return json(200, { memory: name, figures: report.figures, findings: report.findings });
    }
    case "rebuild": {
      const r = await stub.rebuildAll();
      if (r === "unknown") return noSuchMemory(name);
      if ("tooLarge" in r) return json(413, { error: r.tooLarge });
      return json(200, { memory: name, memories: r.memories, events: r.events });
    }
    case "export": {
      const r = await stub.exportAll();
      if (r === "unknown") return noSuchMemory(name);
      if ("tooLarge" in r) return json(413, { error: r.tooLarge });
      return new Response(r.body, {
        headers: {
          "content-type": "application/x-ndjson",
          "content-disposition": `attachment; filename="${name}-${stamp(r.exportedAt)}.ndjson"`,
          "cache-control": "no-store",
        },
      });
    }
    case "import": {
      // The token is drawn before the object is called; it is shown only if
      // the export held none, and then only its hash is stored.
      // A body that says it is too large is refused unread. The header may be
      // absent or wrong, so the object counts again as it reads.
      const length = request.headers.get("content-length");
      if (length !== null && /^\d+$/.test(length.trim()) && Number(length.trim()) > maxBytesInOneGo) {
        return json(413, { error: tooManyBytes(maxBytesInOneGo) });
      }
      const token = newToken();
      const body = request.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
      const r = await stub.importFrom(body, await sha256Hex(token));
      if ("exists" in r) return json(409, { error: `memory ${JSON.stringify(name)} already exists` });
      if ("tooLarge" in r) return json(413, { error: r.tooLarge });
      if ("invalid" in r) return json(400, { error: r.invalid });
      await register(env, name);
      const st = r.imported;
      const out: JSONRecord = { memory: name, endpoint, memories: st.memories, events: st.events, exportedAt: st.exportedAt };
      if (st.keptToken) {
        out.note = "It answers to the token it had when it was exported.";
      } else {
        out.token = token;
        out.note = "The export held no token. This one is shown this once. Only its hash is stored.";
      }
      return json(201, out);
    }
  }
}

interface GrantRow {
  id: string;
  client: string;
  createdAt: number;
  // null until the client exchanges its code; the grant then lapses in 10 minutes.
  expiresAt: number | null;
}

// serveGrants lists the clients granted access to a memory through OAuth, or
// revokes one grant (grant is its id). Revoking deletes the grant and its
// tokens from KV; see the page's words for when a client feels it.
//
// A grant made for an earlier memory of the same name, one that a deletion's
// listing came too soon to see, is not this memory's: it is left out and
// revoked here. The object refuses its calls in any case.
async function serveGrants(request: Request, env: Env, name: string, grant: string): Promise<Response> {
  const instance = await env.MEMORY.getByName(name).instance();
  if (instance === "unknown") return noSuchMemory(name);
  const oauth = helpersFor(env, new URL(request.url), name);
  const rows: GrantRow[] = [];
  const stale: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(name, cursor === undefined ? {} : { cursor });
    for (const g of page.items) {
      const meta = (g.metadata ?? {}) as Partial<GrantMetadata>;
      if (typeof meta.instance === "string" && meta.instance !== instance) {
        stale.push(g.id);
        continue;
      }
      rows.push({
        id: g.id,
        client: typeof meta.client === "string" ? meta.client : g.clientId,
        createdAt: g.createdAt * 1000,
        expiresAt: g.expiresAt === undefined ? null : g.expiresAt * 1000,
      });
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  for (const id of stale) await oauth.revokeGrant(id, name);
  if (grant === "") {
    rows.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return json(200, { memory: name, grants: rows });
  }
  if (!grantIdRE.test(grant) || !rows.some((r) => r.id === grant)) {
    return json(404, { error: `no such grant: ${JSON.stringify(grant)}` });
  }
  await oauth.revokeGrant(grant, name);
  return json(200, { memory: name, revoked: grant });
}

// The step of a deletion that failed, for the log.
class DeleteStep extends Error {
  constructor(
    readonly step: "grants" | "object" | "directory",
    readonly failure: unknown,
  ) {
    super(step);
  }
}

async function step<T>(name: DeleteStep["step"], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new DeleteStep(name, err);
  }
}

// serveDelete deletes a memory for good. The name must be repeated in the
// request as ?confirm=<name>, so that a slip cannot delete one.
//
// Three steps, in this order, each of which a repeat does again:
//  1. every grant of the memory is revoked, with its tokens (KV);
//  2. the memory's object is emptied: tables, keys and alarm;
//  3. the name is taken off the directory.
// A failure in 1 leaves the memory as it was, less the grants revoked so
// far; in 2, the memory as it was with no grant; in 3, no memory, listed as
// one that does not exist. Grants go first so that nothing is destroyed
// while a client can still be let in by one; a grant listed too late to be
// revoked (KV lists lag by seconds) is refused by the object, which knows it
// was made for an instance that is gone (memory-object.ts, instance).
// Answers 404 when there was nothing to delete: no grant, nothing held and
// not listed, which is also what a repeat after a complete deletion gets.
async function serveDelete(request: Request, env: Env, name: string): Promise<Response> {
  const confirm = new URL(request.url).searchParams.get("confirm");
  if (confirm !== name) {
    return json(400, {
      error: `to delete memory ${JSON.stringify(name)} for good, repeat its name: DELETE /admin/memories/${name}?confirm=${name}`,
    });
  }
  try {
    const revoked = await step("grants", async () => {
      const oauth = helpersFor(env, new URL(request.url), name);
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await oauth.listUserGrants(name, cursor === undefined ? {} : { cursor });
        for (const g of page.items) ids.push(g.id);
        cursor = page.cursor;
      } while (cursor !== undefined);
      for (const id of ids) await oauth.revokeGrant(id, name);
      return ids.length;
    });
    const emptied = (await step("object", () => env.MEMORY.getByName(name).remove())) === "removed";
    const unlisted = await step("directory", () => env.DIRECTORY.getByName(directoryName).unregister(name));
    if (revoked === 0 && !emptied && !unlisted) return noSuchMemory(name);
    return json(200, { memory: name, deleted: true, revokedGrants: revoked, emptied, unlisted });
  } catch (err) {
    if (!(err instanceof DeleteStep)) throw err;
    logLine({ msg: "admin failed", memory: name, action: "delete", step: err.step, error: errorName(err.failure) });
    return json(500, { error: `the memory was not fully deleted (the ${err.step} step failed); repeat the request to finish` });
  }
}

// stamp writes a time as Go's export file names do, in UTC: 20261111-080000.
function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "").replace("T", "-");
}

// wantsText reports whether the request asks for plain text ahead of JSON.
function wantsText(request: Request): boolean {
  const types = (request.headers.get("accept") ?? "").split(",").map((t) => t.split(";")[0]!.trim().toLowerCase());
  const text = types.indexOf("text/plain");
  const asJSON = types.indexOf("application/json");
  return text >= 0 && (asJSON < 0 || text < asJSON);
}

// readSettings reads the body of a settings change, or says what is wrong
// with it. Values are checked by the store, not here.
async function readSettings(request: Request): Promise<SettingsChange | string> {
  const shape = "the body must be a JSON object with params, timeZone or both";
  let v: unknown;
  try {
    v = JSON.parse(await request.text());
  } catch {
    return shape;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return shape;
  const body = v as JSONRecord;
  const change: SettingsChange = {};
  for (const [k, x] of Object.entries(body)) {
    if (k === "timeZone") {
      if (typeof x !== "string") return "timeZone must be a string, an IANA name such as Asia/Shanghai";
      change.timeZone = x;
    } else if (k === "params") {
      const params = readParams(x);
      if (typeof params === "string") return params;
      change.params = params;
    } else {
      return `unknown setting ${JSON.stringify(k)}: give params, timeZone or both`;
    }
  }
  if (change.params === undefined && change.timeZone === undefined) return shape;
  return change;
}
