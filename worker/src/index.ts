// The Worker in front of the memories. It holds no state: it routes a request
// to the memory its path names, checks the memory's token with the memory's
// Durable Object, and serves MCP itself, so that a long-lived stream such as
// subscriptions/listen is held here and never by the object. Port of the
// routing, the token check and the access log of Go's host.go.

import { CLIENT_INFO_META_KEY, DEFAULT_MAX_REQUEST_BODY_SIZE, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { type Note, serveAdmin } from "./admin";
import { Directory } from "./directory";
import { base64url, bearer, encoder, notFound, plain, sha256Hex, unauthorized, validName } from "./http";
import { Memory } from "./memory-object";
import { buildServer } from "./mcp/server";
import { clipText, type LogFields, logLine } from "./log";

export { Directory, Memory };
export { newToken, validName } from "./http";

export interface Env {
  MEMORY: DurableObjectNamespace<Memory>;
  // The list of memories the admin API keeps; never reached by MCP.
  DIRECTORY: DurableObjectNamespace<Directory>;
  // The secret of the admin API; without it the admin API is not there.
  ADMIN_SECRET?: string;
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
}

function peek(body: unknown): Peek {
  const out: Peek = {};
  for (const m of Array.isArray(body) ? body : [body]) {
    const msg = record(m);
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
  const token = bearer(request);
  if (token === null) {
    note.auth = "missing";
    return unauthorized();
  }
  if (token === undefined) {
    note.auth = "rejected";
    return unauthorized();
  }
  const stub = env.MEMORY.getByName(name);
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
    return unauthorized();
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
  // New generation: every request names its client. Old generation: the
  // name given at initialize comes back in the session id. Else the agent.
  const client =
    p.metaClient ??
    p.initializeClient ??
    (clientFromSessionId(request.headers.get("mcp-session-id")) ||
      clipText(request.headers.get("user-agent") ?? "", 120));

  const handler = createMcpHandler(() => buildServer({ memory: name, client, stub }), { route: `/${name}/mcp` });
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

async function route(request: Request, env: Env, path: string, note: Note): Promise<Response> {
  const parts = path.split("/");
  if (path === "/healthz") return healthz(request);
  // /<name>/mcp
  if (parts.length === 3 && parts[0] === "" && parts[2] === "mcp" && validName(parts[1]!)) {
    return serveMemory(request, env, parts[1]!, note);
  }
  // /admin/...
  if (parts[0] === "" && parts[1] === "admin") return serveAdmin(request, env, parts, note);
  return notFound();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const start = Date.now();
    const path = new URL(request.url).pathname;
    const note: Note = {};
    const res = await route(request, env, path, note);
    // A stream is logged when its answer starts, not when it ends.
    const fields: LogFields = {
      msg: "request",
      method: clipText(request.method, 16),
      path: clipText(path, 200),
      status: res.status,
      dur_ms: Date.now() - start,
    };
    if (note.auth !== undefined) fields.auth = note.auth;
    fields.agent = clipText(request.headers.get("user-agent") ?? "", 120);
    if (note.protocol !== undefined) fields.mcp_version = clipText(note.protocol, 32);
    logLine(fields);
    return res;
  },
} satisfies ExportedHandler<Env>;
