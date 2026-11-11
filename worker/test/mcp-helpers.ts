// Helpers for the tests of the MCP surface and the Worker: requests go
// through the Worker's own fetch, as JSON-RPC, under either protocol
// generation.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import worker, { type Env } from "../src/index";
import type { Memory as MemoryObject } from "../src/memory-object";

export const adminSecret = "test-admin-secret";
export const origin = "https://ziwo.example";
export const modern = "2026-07-28";
export const legacy = "2025-06-18";

// testEnv is the Worker's environment; null leaves ADMIN_SECRET unset.
export function testEnv(secret: string | null = adminSecret): Env {
  const bindings = { MEMORY: env.MEMORY, DIRECTORY: env.DIRECTORY, GUARD: env.GUARD, OAUTH_KV: env.OAUTH_KV };
  return secret === null ? bindings : { ...bindings, ADMIN_SECRET: secret };
}

export function fetchWorker(path: string, init: RequestInit = {}, e: Env = testEnv()): Promise<Response> {
  return worker.fetch(new Request(origin + path, init), e);
}

let created = 0;

// freshName is a memory name no other test uses.
export function freshName(): string {
  return `t${Date.now().toString(36)}-${(++created).toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
}

export interface Created {
  name: string;
  token: string;
}

// createMemory creates a memory through the admin API.
export async function createMemory(name = freshName()): Promise<Created> {
  const res = await fetchWorker(`/admin/memories/${name}`, { method: "POST", headers: { authorization: `Bearer ${adminSecret}` } });
  expect(res.status, "create").toBe(201);
  const body = (await res.json()) as { token: string };
  return { name, token: body.token };
}

// setClock fixes the wall clock of a memory's object.
export function setClock(name: string, at: number): Promise<void> {
  return runInDurableObject(env.MEMORY.getByName(name), (obj: MemoryObject) => {
    obj.now = () => at;
  });
}

export type Generation = "old" | "new";

export interface RPCReply {
  status: number;
  headers: Headers;
  // The JSON-RPC message, from a JSON body or the first event of a stream.
  msg: Record<string, unknown> | undefined;
  raw: string;
}

export async function readReply(res: Response): Promise<RPCReply> {
  const raw = await res.text();
  let msg: Record<string, unknown> | undefined;
  const type = res.headers.get("content-type") ?? "";
  try {
    if (type.includes("text/event-stream")) {
      const line = raw.split("\n").find((l) => l.startsWith("data: "));
      if (line !== undefined) msg = JSON.parse(line.slice(6)) as Record<string, unknown>;
    } else if (type.includes("json")) {
      msg = JSON.parse(raw) as Record<string, unknown>;
    }
  } catch {
    msg = undefined;
  }
  return { status: res.status, headers: res.headers, msg, raw };
}

export interface ToolReply {
  text: string;
  isError: boolean;
}

// Client speaks to one memory as an MCP client of one protocol generation.
export class Client {
  sessionId: string | null = null;
  private id = 0;
  // The Worker's environment the requests are served with.
  env: Env = testEnv();

  constructor(
    readonly gen: Generation,
    readonly memory: Created,
    readonly clientName = "test-client",
    readonly agent = "test-agent/1",
  ) {}

  private headers(method: string, name?: string): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.memory.token}`,
      "user-agent": this.agent,
    };
    if (this.gen === "new") {
      h["mcp-protocol-version"] = modern;
      h["mcp-method"] = method;
      if (name !== undefined) h["mcp-name"] = name;
    } else if (method !== "initialize") {
      h["mcp-protocol-version"] = legacy;
    }
    if (this.sessionId !== null) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  meta(): Record<string, unknown> {
    return {
      "io.modelcontextprotocol/protocolVersion": modern,
      "io.modelcontextprotocol/clientInfo": { name: this.clientName, version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
  }

  // send posts one JSON-RPC message; a notification has no id.
  async send(method: string, params: Record<string, unknown> = {}, notification = false, rawBody?: string): Promise<RPCReply> {
    const p = this.gen === "new" ? { ...params, _meta: { ...this.meta(), ...(params._meta as object | undefined) } } : params;
    const body = notification ? { jsonrpc: "2.0", method, params: p } : { jsonrpc: "2.0", id: ++this.id, method, params: p };
    const name = typeof params.name === "string" ? params.name : undefined;
    const res = await fetchWorker(`/${this.memory.name}/mcp`, {
      method: "POST",
      headers: this.headers(method, name),
      body: rawBody ?? JSON.stringify(body),
    }, this.env);
    return readReply(res);
  }

  // connect opens the conversation as each generation does: initialize
  // first in the old one, a discovery request in the new one.
  async connect(): Promise<RPCReply> {
    if (this.gen === "new") return this.send("server/discover");
    const r = await this.send("initialize", {
      protocolVersion: legacy,
      capabilities: {},
      clientInfo: { name: this.clientName, version: "1" },
    });
    this.sessionId = r.headers.get("mcp-session-id");
    await this.send("notifications/initialized", {}, true);
    return r;
  }

  async list(): Promise<Record<string, unknown>[]> {
    const r = await this.send("tools/list");
    expect(r.status, r.raw).toBe(200);
    return ((r.msg?.result as Record<string, unknown>).tools as Record<string, unknown>[]);
  }

  async tool(name: string, args: Record<string, unknown>, rawBody?: string): Promise<ToolReply> {
    const r = await this.send("tools/call", { name, arguments: args }, false, rawBody);
    expect(r.status, r.raw).toBe(200);
    const result = r.msg?.result as { content: { type: string; text: string }[]; isError?: boolean } | undefined;
    if (result === undefined) expect.fail(`no result: ${r.raw}`);
    return { text: result.content.map((c) => c.text).join(""), isError: result.isError ?? false };
  }

  // ok calls a tool that must succeed and returns its text.
  async ok(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.tool(name, args);
    expect(r.isError, `${name}: ${r.text}`).toBe(false);
    return r.text;
  }
}

// idIn returns the first id with the prefix in text.
export function idIn(text: string, prefix = "m_"): string {
  const m = new RegExp(`\\b${prefix}[a-z0-9]+`).exec(text);
  if (m === null) expect.fail(`no ${prefix} id in the answer`);
  return m[0];
}

// template replaces each id in text by a name in order of first appearance,
// so that answers can be compared with Go's whatever ids were drawn.
export function template(text: string, ids: Record<string, string>): string {
  let out = text;
  // Longest first, so that no id is replaced inside another.
  for (const [name, id] of Object.entries(ids).sort((a, b) => b[1].length - a[1].length)) {
    out = out.replaceAll(id, `{${name}}`);
  }
  return out;
}
