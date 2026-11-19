import { z } from 'zod';
import { directoryName } from './directory';
import { readObject } from './harness';
import { json as publicJson, notFound } from './http';
import type { Env } from './index';
const thread = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
export function activationRoute(path: string, method: string): boolean {
  return (['/harness/v1/activation', '/harness/v1/activation/context', '/harness/v1/activation/history'].includes(path) && method === 'GET') ||
    /^\/harness\/v1\/activation\/(begin|persona|manifest|batch|complete|supplement|notice|anchor)$/.test(path) && method === 'POST';
}
export async function serveActivation(request: Request, env: Env, path: string, hash: string): Promise<Response> {
  if (!activationRoute(path, request.method)) return notFound();
  const json = (status: number, body: Record<string, unknown>) => { const r = publicJson(status, body); r.headers.set('cache-control', 'no-store'); return r; };
  const body = request.method === 'GET' ? undefined : await readObject(request, 262144);
  const parsed = thread.safeParse(request.method === 'GET' ? new URL(request.url).searchParams.get('threadId') : (body as { threadId?: unknown } | undefined)?.threadId);
  if (!parsed.success) return json(400, { error: 'a valid persistent threadId is required' });
  const result = await env.DIRECTORY.getByName(directoryName).threadBinding(hash, parsed.data);
  if ('error' in result) return json(result.status, { error: result.error });
  if (result.value === null) return json(409, { error: 'conversation is not bound' });
  const b = result.value;
  const operation = path.split('/')[4] ?? 'status';
  const q = new URL(request.url).searchParams;
  const input = operation === 'history' ? { offset: Number(q.get('offset') ?? 0), limit: Number(q.get('limit') ?? 50) } : body;
  const response = await env.MEMORY.getByName(b.memory).activationRequest(b, operation, input);
  return 'error' in response ? json(response.status, { error: response.error }) : json(200, response.value);
}
