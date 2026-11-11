// The admin API: what the owner of a deployment uses to run it. Every route
// needs the bearer ADMIN_SECRET and is not there without one. No route but
// export returns what a memory says: figures, ids, names, settings, the check
// report and the clients granted access only.

import { directoryName, type Listed } from "./directory";
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
  // An OAuth step: the endpoint, what it came to in fixed words, the check
  // that refused it, and the memory a consent page was for.
  oauth?: string;
  outcome?: string;
  reason?: string;
  memory?: string;
}

type Action = "create" | "describe" | "token" | "settings" | "check" | "rebuild" | "export" | "import" | "grants" | "revoke";

// The routes under /admin/memories/<name>, by last segment and method.
const memoryRoutes: Record<string, Record<string, Action>> = {
  "": { POST: "create", GET: "describe" },
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
  const secret = env.ADMIN_SECRET;
  if (secret === undefined || secret === "") return notFound();
  note.auth = await adminAllowed(request, secret);
  if (note.auth !== "ok") return unauthorized();
  if (action !== "list" && !validName(name)) return json(400, { error: invalidNameMessage(name) });
  try {
    if (action === "list") return await list(env);
    if (action === "grants" || action === "revoke") return await serveGrants(request, env, name, grant);
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

async function serveMemoryAdmin(request: Request, env: Env, name: string, action: Exclude<Action, "grants" | "revoke">): Promise<Response> {
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
async function serveGrants(request: Request, env: Env, name: string, grant: string): Promise<Response> {
  if ((await env.MEMORY.getByName(name).stats()) === "unknown") return noSuchMemory(name);
  const oauth = helpersFor(env, new URL(request.url), name);
  const rows: GrantRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(name, cursor === undefined ? {} : { cursor });
    for (const g of page.items) {
      const meta = (g.metadata ?? {}) as Partial<GrantMetadata>;
      rows.push({
        id: g.id,
        client: typeof meta.client === "string" ? meta.client : g.clientId,
        createdAt: g.createdAt * 1000,
        expiresAt: g.expiresAt === undefined ? null : g.expiresAt * 1000,
      });
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
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
