// Capabilities are deliberately separate: a host creates a scoped evaluation,
// the evaluator reads/proposes, and the private user-facing admin channel
// confirms and adopts an exact proposal. None is an ordinary memory tool.
import { z } from 'zod';
import { directoryName } from './directory';
import { bearer, json as responseJson, newToken, notFound, sha256Hex, validName } from './http';
import { readObject } from './harness';
import type { Env } from './index';
import type { Note } from './admin';
import type { PersonaResult } from './store/persona';
import { createMcpHandler } from 'agents/mcp/server';
import { evaluationServer } from './mcp/evaluation';

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const evaluationInput = z.object({ threadId: id, requestId: id, memory: z.string().refine(validName), identityId: id, instance: id, source: z.literal('fresh') }).strict();
function json(status: number, body: unknown): Response {
  const r = responseJson(status, body as Record<string, unknown>);
  r.headers.set('cache-control', 'no-store');
  return r;
}
function reply<T>(r: PersonaResult<T>, status = 200): Response {
  return 'error' in r ? json(r.status, { error: r.error }) : json(status, r.value);
}
export async function startEvaluation(request: Request, env: Env, hostHash: string): Promise<Response> {
  const parsed = evaluationInput.safeParse(await readObject(request));
  if (!parsed.success) return json(400, { error: 'evaluation requires a fresh conversation and a specific subject, instance and request' });
  const p = parsed.data;
  const stub = env.MEMORY.getByName(p.memory);
  const info = await stub.identityInfo();
  if (info === 'unknown' || info.identity?.id !== p.identityId || info.instance !== p.instance) return json(409, { error: 'subject or instance is unavailable' });
  const role = await env.DIRECTORY.getByName(directoryName).reserveEvaluation(hostHash, p.threadId, p, p.source, Date.now());
  if ('error' in role) return json(role.status, { error: role.error });
  const evaluationId = 'ev_' + await sha256Hex(JSON.stringify([role.value, p.threadId, p.requestId]));
  const token = newToken().replace('ziwo_', 'zev_');
  const result = await stub.startEvaluation({ id: evaluationId, harnessId: role.value, threadId: p.threadId, requestId: p.requestId, identityId: p.identityId, instance: p.instance }, await sha256Hex(token));
  if ('error' in result) return reply(result);
  // A lost-response retry keeps the snapshot and rotates its capability.
  return json(201, { evaluationId, token, identityId: p.identityId, instance: p.instance, baseVersion: result.value.baseVersion, upperSeq: result.value.upperSeq, total: result.value.sources.length });
}
export async function loadBoundPersona(request: Request, env: Env, hostHash: string): Promise<Response> {
  const parsed = id.safeParse(new URL(request.url).searchParams.get('threadId'));
  if (!parsed.success) return json(400, { error: 'a valid threadId is required' });
  const bound = await env.DIRECTORY.getByName(directoryName).threadBinding(hostHash, parsed.data);
  if ('error' in bound) return json(bound.status, { error: bound.error });
  if (bound.value === null) return json(409, { error: 'conversation is not bound' });
  const b = bound.value;
  const result = await env.MEMORY.getByName(b.memory).loadPersona(b.identityId, b.instance);
  if ('error' in result) return reply(result);
  const init = await env.MEMORY.getByName(b.memory).activationRequest(b, 'status', undefined);
  const canRun = 'value' in init && init.value.canRun === true;
  return json(200, { ...result.value, canRun, bindingState: canRun ? 'ready' : 'bound_initializing' });
}
export async function serveEvaluation(request: Request, env: Env, path: string, note: Note): Promise<Response> {
  const parts = path.split('/');
  const memory = parts[3] ?? ''; const evaluationId = parts[4] ?? '';
  const read = parts.length === 5 && request.method === 'GET';
  const propose = parts.length === 6 && parts[5] === 'proposals' && request.method === 'POST';
  const mcp = parts.length === 6 && parts[5] === 'mcp';
  if (!validName(memory) || !/^ev_[a-f0-9]{64}$/.test(evaluationId) || (!read && !propose && !mcp)) return notFound();
  const token = bearer(request); note.cred = 'evaluation';
  if (typeof token !== 'string' || !/^zev_[A-Za-z0-9_-]{43}$/.test(token)) { note.auth = 'rejected'; return json(401, { error: 'a scoped evaluation credential is required' }); }
  const hash = await sha256Hex(token); const stub = env.MEMORY.getByName(memory);
  const auth = await stub.evaluationAuth(evaluationId, hash);
  if ('error' in auth) { note.auth = 'rejected'; return json(401, { error: 'invalid evaluation credential' }); }
  const job = auth.value;
  if (job.harnessId !== 'admin_mcp' && !await env.DIRECTORY.getByName(directoryName).evaluationAccess(job.harnessId, job.threadId, { memory, identityId: job.identityId, instance: job.instance })) {
    note.auth = 'rejected'; return json(403, { error: 'evaluation host or conversation is unavailable' });
  }
  note.auth = 'ok';
  if (mcp) return createMcpHandler(() => evaluationServer(stub, evaluationId, hash), { route: path }).fetch(request);
  if (read) {
    const q = new URL(request.url).searchParams;
    return reply(await stub.readEvaluation(evaluationId, hash, Number(q.get('offset') ?? 0), Number(q.get('limit') ?? 50)));
  }
  const result = await stub.proposePersona(evaluationId, hash, await readObject(request, 65536));
  if ('error' in result) return reply(result);
  const p = result.value;
  return json(201, { proposalId: p.id, digest: p.digest, identityId: p.identityId, instance: p.instance, baseVersion: p.baseVersion, state: p.state });
}
export function personaAdminRoute(parts: string[], method: string): boolean {
  if (parts[2] !== 'persona' || !validName(parts[3] ?? '')) return false;
  if (parts[4] === 'evaluations') return (parts.length === 5 && method === 'POST') || (parts.length === 6 && /^ev_[a-f0-9]{64}$/.test(parts[5] ?? '') && method === 'DELETE');
  return parts[4] === 'proposals' && /^pp_[a-f0-9]{64}$/.test(parts[5] ?? '') &&
    ((parts.length === 6 && method === 'GET') || (parts.length === 7 && ['confirm', 'adopt'].includes(parts[6]!) && method === 'POST'));
}
// The caller has already applied admin authentication and rate limits.
export async function servePersonaAdmin(request: Request, env: Env, parts: string[]): Promise<Response> {
  const stub = env.MEMORY.getByName(parts[3]!); const proposalId = parts[5]!;
  if (parts[4] === 'evaluations') {
    if (request.method === 'DELETE') return reply(await stub.revokeEvaluation(parts[5]!));
    const parsed = z.object({ identityId: id, instance: id, requestId: id, source: z.literal('fresh') }).strict().safeParse(await readObject(request));
    if (!parsed.success) return json(400, { error: 'select a subject and instance, and use a fresh independent evaluation conversation' });
    const p = parsed.data;
    const evaluationId = 'ev_' + await sha256Hex(JSON.stringify(['admin_mcp', p.identityId, p.instance, p.requestId]));
    const token = newToken().replace('ziwo_', 'zev_');
    const result = await stub.startEvaluation({ id: evaluationId, harnessId: 'admin_mcp', threadId: evaluationId, requestId: p.requestId, identityId: p.identityId, instance: p.instance }, await sha256Hex(token));
    if ('error' in result) return reply(result);
    return json(201, { evaluationId, token, identityId: p.identityId, instance: p.instance,
      mcpUrl: new URL(`/evaluation/v1/${parts[3]}/${evaluationId}/mcp`, request.url).href,
      baseVersion: result.value.baseVersion, upperSeq: result.value.upperSeq, total: result.value.sources.length });
  }
  if (request.method === 'GET') return reply(await stub.reviewPersona(proposalId));
  const body = await readObject(request);
  return parts[6] === 'confirm' ? reply(await stub.confirmPersona(proposalId, body)) : reply(await stub.adoptPersona(proposalId, body));
}
