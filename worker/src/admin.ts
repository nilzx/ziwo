// The admin API: what the owner of a deployment uses to run it. Every route
// needs the bearer admin secret and is not there without one
// (adminSecretState): ADMIN_SECRET when it counts (adminSecretOf), else one
// set on the admin page. /admin/setup alone needs no credential: it says
// which of the two there is, and sets the second while that is allowed. No
// route but export returns what a memory says: figures, ids, names,
// settings, the check report and the clients granted access only.

import { directoryName, type Listed, type StoredSecret } from "./directory";
import { waitFor } from "./guard";
import {
  bearer, encoder, invalidNameMessage, json, type JSONRecord, newToken, notFound, sameOrigin, sha256Hex, unauthorized, validName,
} from "./http";
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

// ---------------------------------------------------------------- the admin secret
//
// There are two kinds of admin secret. One from the dashboard: the Worker
// secret ADMIN_SECRET, when it counts; it is then the admin secret and
// nothing else is. One set on the admin page, kept by the directory as a
// salt and a hash: the admin secret only while no dashboard secret counts.
// It can be set only while the state is "open": no secret of either kind,
// none ever (the directory's record that setting is closed, or a memory
// listed), and a running version created at most setupWindowMs ago. The
// first dashboard secret the Worker sees erases the page's and closes
// setting for good, so that removing ADMIN_SECRET afterwards leaves no
// admin secret at all: the dashboard is the way back in, for a forgotten
// secret and for a deployment someone else reached first.

// How long after its version is created a deployment may have its admin
// secret set on the page; and how far in the future a version's time may be
// before it is not believed.
export const setupWindowMs = 3_600_000;
const futureSkewMs = 60_000;

// The longest admin secret the page may set.
export const maxAdminSecret = 200;

// What a deployment's admin secret is: from the dashboard, set on the page,
// or none, and then whether one may be set on the page now ("open", until
// when) or not ("closed").
export type AdminSecretState =
  | { kind: "dashboard"; secret: string }
  | { kind: "page"; stored: StoredSecret }
  | { kind: "open"; until: number }
  | { kind: "closed" };

// setupUntil is when setting the admin secret on the page closes for the
// running version, in unix milliseconds, or undefined when it is closed
// already: no version binding, a time that cannot be read, one more than
// futureSkewMs ahead of now, or one more than setupWindowMs ago.
export function setupUntil(version: WorkerVersionMetadata | undefined, now: number): number | undefined {
  const raw: unknown = version?.timestamp;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const created = Date.parse(raw);
  if (!Number.isFinite(created) || created > now + futureSkewMs) return undefined;
  const until = created + setupWindowMs;
  return now <= until ? until : undefined;
}

// Whether this isolate has told the directory that a dashboard secret
// counts. Set only once the directory answered.
let dashboardTold = false;

// dashboardRules tells the directory, once per isolate, that a dashboard
// secret counts: it erases the secret set on the page and closes setting
// for good. A failure is logged and tried again on a later request.
async function dashboardRules(env: Env): Promise<void> {
  if (dashboardTold) return;
  try {
    await env.DIRECTORY.getByName(directoryName).dashboardRules(Date.now());
    dashboardTold = true;
  } catch (err) {
    logLine({ msg: "directory unavailable", step: "dashboard secret", error: errorName(err) });
  }
}

// adminSecretState answers what this deployment's admin secret is. It
// throws when the directory cannot be reached and no dashboard secret
// counts. The admin API (serveAdmin) and the consent page (consent.ts,
// weigh) weigh the admin secret through this and adminSecretMatches alone.
export async function adminSecretState(env: Env, now = Date.now()): Promise<AdminSecretState> {
  const secret = adminSecretOf(env);
  if (secret !== undefined) {
    await dashboardRules(env);
    return { kind: "dashboard", secret };
  }
  const record = await env.DIRECTORY.getByName(directoryName).adminSecret();
  if (record.stored !== undefined) return { kind: "page", stored: record.stored };
  if (record.closed) return { kind: "closed" };
  const until = setupUntil(env.VERSION, now);
  return until === undefined ? { kind: "closed" } : { kind: "open", until };
}

// adminSecretMatches says whether presented is the admin secret, comparing
// in constant time two hashes of the same length.
export async function adminSecretMatches(state: AdminSecretState, presented: string): Promise<boolean> {
  let got: string;
  let want: string;
  if (state.kind === "dashboard") {
    [got, want] = await Promise.all([sha256Hex(presented), sha256Hex(state.secret)]);
  } else if (state.kind === "page") {
    got = await sha256Hex(state.stored.salt + presented);
    want = state.stored.hash;
  } else {
    return false;
  }
  const a = encoder.encode(got);
  const b = encoder.encode(want);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

// storedSecret is what the directory keeps of a secret set on the page: a
// random salt and the SHA-256 of the salt and the secret, as hex.
//
// A plain salted SHA-256, not a slow hash, on purpose. The only readers of
// the directory's storage are the account's owner and Cloudflare, who can
// reach every memory already; the secret is at least minAdminSecret
// characters; guessing it online is limited by the guard (guard.ts); and the
// free plan allows about 10 ms of CPU a request, which a slow hash would
// spend on every request to the admin API.
async function storedSecret(secret: string): Promise<StoredSecret> {
  const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { salt, hash: await sha256Hex(salt + secret) };
}

// newSecretProblem says what is wrong with a secret to be set on the page,
// or undefined: it must be minAdminSecret to maxAdminSecret characters, each
// a printable ASCII character other than space, so that it can be sent in an
// Authorization header as it is (the page checks the same: logic.mjs,
// newSecretProblem).
export function newSecretProblem(secret: unknown): string | undefined {
  if (typeof secret !== "string" || !/^[\x21-\x7e]*$/.test(secret) || secret.length < minAdminSecret || secret.length > maxAdminSecret) {
    return `the admin secret must be ${minAdminSecret} to ${maxAdminSecret} characters, each a letter, digit or punctuation mark of plain ASCII, with no spaces`;
  }
  return undefined;
}

// adminAllowed weighs the bearer credential of a request against the admin
// secret.
async function adminAllowed(request: Request, state: AdminSecretState): Promise<"ok" | "missing" | "rejected"> {
  const got = bearer(request);
  if (got === null) return "missing";
  if (got === undefined) return "rejected";
  return (await adminSecretMatches(state, got)) ? "ok" : "rejected";
}

const maxSetupBody = 4 * 1024;

// readSmall reads a body of at most max bytes, or undefined when it is
// larger; it stops reading once it is.
async function readSmall(request: Request, max: number): Promise<Uint8Array | undefined> {
  const length = request.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length.trim()) && Number(length.trim()) > max) return undefined;
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// readSetup reads the body of POST /admin/setup: the secret, or what is
// wrong with the request, in one line.
async function readSetup(request: Request): Promise<{ secret: string } | { problem: string }> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return { problem: "the body must be JSON, sent as content-type: application/json" };
  const bytes = await readSmall(request, maxSetupBody);
  if (bytes === undefined) return { problem: `the body must be at most ${maxSetupBody} bytes` };
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    v = undefined;
  }
  const shape = `the body must be a JSON object with one field, secret: {"secret":"..."}`;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { problem: shape };
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "secret") return { problem: shape };
  const secret = (v as JSONRecord).secret;
  const problem = newSecretProblem(secret);
  return problem === undefined ? { secret: secret as string } : { problem };
}

const directoryDown = (): Response => json(503, { error: "the admin secret cannot be read right now; see the server log" });

function publicState(state: AdminSecretState): JSONRecord {
  if (state.kind === "open") return { state: "open", min: minAdminSecret, until: state.until };
  return { state: state.kind === "closed" ? "closed" : "set", min: minAdminSecret };
}

// serveSetup answers /admin/setup, without a credential. GET says whether
// there is an admin secret ("set", of either kind), whether one may be set
// on the page ("open", until when) or not ("closed"). POST sets it, while
// open. The access log learns the outcome in fixed words, and nothing of
// the body.
async function serveSetup(request: Request, env: Env, note: Note): Promise<Response> {
  if (request.method === "GET") {
    try {
      return json(200, publicState(await adminSecretState(env)));
    } catch (err) {
      logLine({ msg: "directory unavailable", step: "setup", error: errorName(err) });
      return directoryDown();
    }
  }
  // A browser's post must come from this origin; a script sends no Origin
  // and no Sec-Fetch-Site, and may set it as well as the page.
  const script = request.headers.get("origin") === null && request.headers.get("sec-fetch-site") === null;
  if (!script && !sameOrigin(request, new URL(request.url).origin)) {
    note.outcome = "setup_forged";
    return json(403, { error: "this request was not sent from this deployment's admin page" });
  }
  const read = await readSetup(request);
  if ("problem" in read) {
    note.outcome = "setup_invalid";
    return json(400, { error: read.problem });
  }
  const taken = (): Response => {
    note.outcome = "setup_taken";
    return json(409, { error: "an admin secret is set already", state: "set" });
  };
  const closed = (): Response => {
    note.outcome = "setup_closed";
    return json(403, { error: "the admin secret can no longer be set from this page; set ADMIN_SECRET in the Cloudflare dashboard", state: "closed" });
  };
  try {
    const state = await adminSecretState(env);
    if (state.kind === "dashboard" || state.kind === "page") return taken();
    if (state.kind === "closed") return closed();
    const r = await env.DIRECTORY.getByName(directoryName).setIfOpen(await storedSecret(read.secret), Date.now());
    if (r === "taken") return taken();
    if (r === "closed") return closed();
  } catch (err) {
    logLine({ msg: "directory unavailable", step: "setup", error: errorName(err) });
    return directoryDown();
  }
  note.outcome = "setup_set";
  return json(201, { state: "set" });
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
  if (parts.length === 3 && parts[2] === "setup" && (request.method === "GET" || request.method === "POST")) {
    return serveSetup(request, env, note);
  }
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
  let state: AdminSecretState;
  try {
    state = await adminSecretState(env);
  } catch (err) {
    logLine({ msg: "directory unavailable", step: "admin secret", error: errorName(err) });
    return directoryDown();
  }
  // Without an admin secret the API is not there (404); with one, a request
  // without a credential is answered 401: keep these checks in this order.
  if (state.kind !== "dashboard" && state.kind !== "page") return notFound();
  note.auth = await adminAllowed(request, state);
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

// register lists a memory just created, which also closes setting the admin
// secret on the page for good. A failure is logged and does not undo the
// creation: the directory is a list, not an authority.
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
