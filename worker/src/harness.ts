import { z } from "zod";
import type { Note } from "./admin";
import type { BindingTarget, ThreadBinding } from "./bindings";
import { directoryName } from "./directory";
import { bearer, json as publicJson, newToken, notFound, sha256Hex, validName } from "./http";
import type { Env } from "./index";

function json(status: number, body: Record<string, unknown>): Response {
  const response = publicJson(status, body);
  response.headers.set("cache-control", "no-store");
  return response;
}

// Only a registered, trusted host process holds this credential. It is not
// an MCP tool credential and must never be placed in model context.
const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const target = z.object({ memory: z.string().refine(validName), identityId: identifier, instance: identifier });
const bindInput = target.extend({ threadId: identifier, activationId: identifier, source: z.enum(["conversation", "temporary"]) }).strict();
const restoreInput = target.extend({ threadId: identifier, previousInstance: identifier, requestId: identifier }).strict();
const forkInput = z.object({ threadId: identifier, parentThreadId: identifier, source: z.enum(["conversation", "temporary"]) }).strict();

export async function readObject(request: Request): Promise<unknown> {
  if (request.body === null) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); return undefined; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { return undefined; }
}

export function harnessAdminRoute(parts: string[], method: string): boolean {
  return parts[2] === "harnesses" && (
    (parts.length === 3 && method === "POST") ||
    (parts.length === 4 && /^h_[a-f0-9-]{36}$/.test(parts[3]!) && method === "DELETE") ||
    (parts.length === 5 && /^h_[a-f0-9-]{36}$/.test(parts[3]!) && parts[4] === "token" && method === "POST")
  );
}

// Called only after the existing admin authentication and guessing limit.
export async function serveHarnessAdmin(request: Request, env: Env, parts: string[]): Promise<Response> {
  const registry = env.DIRECTORY.getByName(directoryName);
  if (request.method === "DELETE") {
    return await registry.revokeHarness(parts[3]!) ? json(200, { revoked: parts[3] }) : notFound();
  }
  const token = newToken().replace("ziwo_", "zwh_");
  const hash = await sha256Hex(token);
  if (parts.length === 5) {
    return await registry.rotateHarness(parts[3]!, hash) ? json(200, { id: parts[3], token }) : notFound();
  }
  const parsed = z.object({ name: z.string().trim().min(1).max(80) }).strict().safeParse(await readObject(request));
  if (!parsed.success) return json(400, { error: "a harness name is required" });
  const host = await registry.registerHarness(parsed.data.name, hash, Date.now());
  return json(201, { ...host, token });
}

async function targetAvailable(env: Env, t: BindingTarget): Promise<boolean> {
  const current = await env.MEMORY.getByName(t.memory).identityInfo();
  return current !== "unknown" && current.instance === t.instance && current.identity?.id === t.identityId;
}

async function reply(env: Env, b: ThreadBinding | null, status = 200): Promise<Response> {
  if (b === null) return json(status, { binding: null, state: "unbound" });
  // Recheck the object on every use. A deleted or replaced route must not
  // silently revive a binding, even if it raced the original registration.
  return json(status, { binding: b, targetAvailable: await targetAvailable(env, b), canRun: false });
}

export async function serveHarness(request: Request, env: Env, path: string, note: Note): Promise<Response> {
  const read = path === "/harness/v1/binding" && request.method === "GET";
  const mutate = ["/harness/v1/bind", "/harness/v1/fork", "/harness/v1/restore"].includes(path) && request.method === "POST";
  if (!read && !mutate) return notFound();
  const token = bearer(request);
  note.cred = "harness";
  if (typeof token !== "string" || !/^zwh_[A-Za-z0-9_-]{43}$/.test(token)) {
    note.auth = token == null ? "missing" : "rejected";
    return json(401, { error: "a registered harness credential is required" });
  }
  const hash = await sha256Hex(token);
  const registry = env.DIRECTORY.getByName(directoryName);
  // Authenticate before revealing whether a memory or binding exists.
  const auth = await registry.threadBinding(hash, "");
  if ("error" in auth) { note.auth = "rejected"; return json(auth.status, { error: auth.error }); }
  note.auth = "ok";
  if (read) {
    const parsed = identifier.safeParse(new URL(request.url).searchParams.get("threadId"));
    if (!parsed.success) return json(400, { error: "a valid threadId is required" });
    const result = await registry.threadBinding(hash, parsed.data);
    return "error" in result ? json(result.status, { error: result.error }) : reply(env, result.value);
  }
  const body = await readObject(request);
  if (path === "/harness/v1/fork") {
    const parsed = forkInput.safeParse(body);
    if (!parsed.success) return json(400, { error: "invalid fork request" });
    const p = parsed.data;
    const result = await registry.forkThread(hash, p.parentThreadId, p.threadId, p.source, Date.now());
    return "error" in result ? json(result.status, { error: result.error }) : reply(env, result.value);
  }
  if (path === "/harness/v1/bind") {
    const parsed = bindInput.safeParse(body);
    if (!parsed.success) return json(400, { error: "invalid binding request" });
    const p = parsed.data;
    if (!await targetAvailable(env, p)) return json(409, { error: "subject or instance is unavailable; migration may be required" });
    const result = await registry.bindThread(hash, p.threadId, p, p.activationId, p.source, Date.now());
    return "error" in result ? json(result.status, { error: result.error }) : reply(env, result.value);
  }
  const parsed = restoreInput.safeParse(body);
  if (!parsed.success) return json(400, { error: "invalid restore association" });
  const p = parsed.data;
  if (!await targetAvailable(env, p)) return json(409, { error: "restored subject or instance is unavailable" });
  const result = await registry.restoreThread(hash, p.threadId, p, p.previousInstance, p.requestId, Date.now());
  return "error" in result ? json(result.status, { error: result.error }) : reply(env, result.value);
}
