// The Worker in front of the memories. It holds no state: it routes a request
// to the memory its path names, checks the memory's fixed token with the
// memory's Durable Object or an OAuth access token with KV (oauth.ts), and
// serves MCP itself, so that a long-lived stream such as subscriptions/listen
// is held here and never by the object. Port of the routing, the token check
// and the access log of Go's host.go; OAuth is new.

import { CLIENT_INFO_META_KEY, DEFAULT_MAX_REQUEST_BODY_SIZE, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { type Note, serveAdmin } from "./admin";
import { serveAuthorize } from "./consent";
import { Directory } from "./directory";
import { Guard } from "./guard";
import { type EmbedEnv, queryEmbedding } from "./embed";
import { base64url, bearer, encoder, notFound, plain, sha256Hex, validName } from "./http";
import { Memory } from "./memory-object";
import { challenge, isOAuthPath, isOAuthToken, issuerOf, oauthAccess, serveOAuth } from "./oauth";
import { isPagePath, servePage } from "./page";
import { buildServer } from "./mcp/server";
import { clipText, type LogFields, logLine } from "./log";

export { Directory, Guard, Memory };
export { newToken, validName } from "./http";

export interface Env extends EmbedEnv {
  MEMORY: DurableObjectNamespace<Memory>;
  // The list of memories the admin API keeps; never reached by MCP.
  DIRECTORY: DurableObjectNamespace<Directory>;
  // The limit on guessing at the consent page and the admin API, and the
  // budget on client registrations, one object per address and one for all
  // addresses (guard.ts); never reached by MCP.
  GUARD: DurableObjectNamespace<Guard>;
  // The secret of the admin API; without it the admin API is not there.
  ADMIN_SECRET?: string;
  // OAuth's clients, grants and tokens (workers-oauth-provider). Never read
  // for a request that carries a memory's fixed token.
  OAUTH_KV: KVNamespace;
  // How many clients may register themselves in any 24 hours, from all
  // addresses together (oauth.ts, registerPerDay): a whole number, 100 when
  // unset, 0 to switch registration off. A number when written as one in
  // the wrangler file's vars.
  REGISTER_PER_DAY?: string | number;
  // Search by meaning, off without AI: see embed.ts. AI is the Workers AI
  // binding; EMBED_MODEL (set empty to switch it off), EMBED_DIMS,
  // EMBED_MIN_SIMILARITY, EMBED_QUERY_TIMEOUT_MS and EMBED_QUERY_HEDGE_MS are
  // vars.
}

function fromBase64url(s: string): Uint8Array | undefined {
  try {
    const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

// The session id handed out at initialize to clients of the old protocol
// generation carries the client's name, so that a later tool call, served by
// a server that keeps nothing, knows it again. It names a client, not a
// right: it is not checked, and the token is still needed.
const sessionPrefix = "zw";

export function sessionIdFor(client: string): string {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(9)));
  return `${sessionPrefix}.${nonce}.${base64url(encoder.encode(clipText(client, 120)))}`;
}

export function clientFromSessionId(id: string | null): string {
  if (id === null) return "";
  const parts = id.split(".");
  if (parts.length !== 3 || parts[0] !== sessionPrefix) return "";
  const bytes = fromBase64url(parts[2]!);
  if (bytes === undefined) return "";
  try {
    return clipText(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes), 120);
  } catch {
    return "";
  }
}

type JSONRecord = Record<string, unknown>;

function record(v: unknown): JSONRecord | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JSONRecord) : undefined;
}

// What the Worker reads from a request body before MCP serves it.
interface Peek {
  initializeClient?: string; // the client's name in an initialize request
  metaClient?: string; // the client's name in a request's _meta (new generation)
  protocol?: string;
  rpc?: string; // what the first message asks for: one of rpcWords, or "other"
}

// The requests the access log names. A method is the client's text: only
// these words reach the log.
const rpcWords: ReadonlySet<string> = new Set([
  "initialize", "notifications/initialized", "server/discover", "ping",
  "tools/list", "tools/call", "resources/list", "resources/templates/list", "prompts/list",
]);

function peek(body: unknown): Peek {
  const out: Peek = {};
  for (const m of Array.isArray(body) ? body : [body]) {
    const msg = record(m);
    if (out.rpc === undefined && typeof msg?.method === "string") out.rpc = rpcWords.has(msg.method) ? msg.method : "other";
    const params = record(msg?.params);
    const meta = record(params?._meta);
    const metaName = record(meta?.[CLIENT_INFO_META_KEY])?.name;
    if (out.metaClient === undefined && typeof metaName === "string" && metaName !== "") out.metaClient = metaName;
    const metaProtocol = meta?.[PROTOCOL_VERSION_META_KEY];
    if (out.protocol === undefined && typeof metaProtocol === "string") out.protocol = metaProtocol;
    if (msg?.method === "initialize") {
      const name = record(params?.clientInfo)?.name;
      if (typeof name === "string") out.initializeClient = name;
      if (out.protocol === undefined && typeof params?.protocolVersion === "string") out.protocol = params.protocolVersion;
    }
  }
  return out;
}

async function serveMemory(request: Request, env: Env, name: string, note: Note): Promise<Response> {
  const url = new URL(request.url);
  const token = bearer(request);
  if (token === null) {
    note.auth = "missing";
    return challenge(url, name, false);
  }
  if (token === undefined) {
    note.auth = "rejected";
    return challenge(url, name, false);
  }
  const stub = env.MEMORY.getByName(name);
  // The client a grant was made for, and the memory's instance it was made
  // for, when the token is an OAuth one.
  let granted: string | undefined;
  let instance: string | undefined;
  if (isOAuthToken(token)) {
    note.cred = "oauth";
    const issuer = issuerOf(url);
    let props;
    try {
      props = issuer === undefined ? null : await oauthAccess(env, issuer, name, token);
    } catch (err) {
      logLine({ msg: "grants unavailable", memory: name, error: err instanceof Error ? err.name : "unknown" });
      return plain(503, "this memory cannot be opened right now; see the server log");
    }
    if (props === null) {
      note.auth = "rejected";
      return challenge(url, name, true);
    }
    granted = props.client;
    instance = props.instance;
  } else {
    // A fixed token: as before, the memory's object alone decides.
    note.cred = "token";
    let access;
    try {
      access = await stub.authorize(await sha256Hex(token));
    } catch (err) {
      logLine({ msg: "memory unavailable", memory: name, error: err instanceof Error ? err.name : "unknown" });
      return plain(503, "this memory cannot be opened right now; see the server log");
    }
    // The same answer for a wrong token and for a name that names nothing, so
    // the names of memories do not leak.
    if (access !== "ok") {
      note.auth = "rejected";
      return challenge(url, name, true);
    }
  }
  note.auth = "ok";

  let served = request;
  let parsed: unknown;
  if (request.method === "POST") {
    const text = await request.text();
    served = new Request(request, { body: text });
    // A body the SDK would refuse as too large is left for it to refuse.
    if (encoder.encode(text).byteLength <= DEFAULT_MAX_REQUEST_BODY_SIZE) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined; // the SDK answers it
      }
    }
  }
  const p = peek(parsed);
  note.protocol = request.headers.get("mcp-protocol-version") ?? p.protocol;
  note.rpc = p.rpc;
  // New generation: every request names its client. Old generation: the
  // name given at initialize comes back in the session id. Else the name the
  // client registered for its grant, else the agent.
  const client =
    p.metaClient ??
    p.initializeClient ??
    (clientFromSessionId(request.headers.get("mcp-session-id")) ||
      (granted ?? "") ||
      clipText(request.headers.get("user-agent") ?? "", 120));

  const embedQuery = queryEmbedding(env);
  const handler = createMcpHandler(() => buildServer({ memory: name, client, stub, embedQuery, ...(instance === undefined ? {} : { instance }) }), {
    route: `/${name}/mcp`,
  });
  const res = await handler.fetch(served, parsed === undefined ? undefined : { parsedBody: parsed });
  if (p.initializeClient === undefined || !res.ok) return res;
  const headers = new Headers(res.headers);
  headers.set("mcp-session-id", sessionIdFor(p.initializeClient));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// healthz answers the probe as Go's host does: GET (and so HEAD) only.
function healthz(request: Request): Response {
  if (request.method === "GET" || request.method === "HEAD") return plain(200, "ok");
  return plain(405, "Method Not Allowed", { allow: "GET, HEAD" });
}

async function route(request: Request, env: Env, ctx: ExecutionContext | undefined, path: string, note: Note): Promise<Response> {
  const parts = path.split("/");
  if (path === "/healthz") return healthz(request);
  // The admin page: static files, never a Durable Object.
  if (isPagePath(path)) return servePage(request, path);
  // /<name>/mcp
  if (parts.length === 3 && parts[0] === "" && parts[2] === "mcp" && validName(parts[1]!)) {
    return serveMemory(request, env, parts[1]!, note);
  }
  // /admin/...
  if (parts[0] === "" && parts[1] === "admin") return serveAdmin(request, env, parts, note);
  // /oauth/... and /.well-known/...: the authorization server and metadata.
  if (isOAuthPath(path)) return serveOAuth(request, env, ctx, path, note, (issuer) => serveAuthorize(request, env, issuer, note));
  return notFound();
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const start = Date.now();
    const path = new URL(request.url).pathname;
    const note: Note = {};
    const res = await route(request, env, ctx, path, note);
    // A stream is logged when its answer starts, not when it ends.
    const fields: LogFields = {
      msg: "request",
      method: clipText(request.method, 16),
      path: clipText(path, 200),
      status: res.status,
      dur_ms: Date.now() - start,
    };
    if (note.auth !== undefined) fields.auth = note.auth;
    if (note.cred !== undefined) fields.cred = note.cred;
    // The consent page is a person's browser: its agent is not logged.
    if (note.oauth !== "authorize") fields.agent = clipText(request.headers.get("user-agent") ?? "", 120);
    if (note.protocol !== undefined) fields.mcp_version = clipText(note.protocol, 32);
    if (note.rpc !== undefined) fields.rpc = note.rpc;
    // An OAuth step: which endpoint, the outcome, the check that refused it
    // and the memory a consent was for. Never a code, a token or a secret.
    if (note.oauth !== undefined) fields.oauth = note.oauth;
    if (note.outcome !== undefined) fields.outcome = note.outcome;
    if (note.reason !== undefined) fields.reason = note.reason;
    if (note.memory !== undefined) fields.memory = note.memory;
    logLine(fields);
    return res;
  },
} satisfies ExportedHandler<Env>;
