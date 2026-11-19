import { z } from 'zod';
import { directoryName } from './directory';
import { readObject } from './harness';
import { json } from './http';
import type { Env } from './index';
const thread = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
export function syncRoute(path: string, method: string): boolean {
  return method === 'GET' && ['/harness/v1/sync', '/harness/v1/sync/page', '/harness/v1/tools'].includes(path) ||
    method === 'POST' && ['/harness/v1/sync/begin', '/harness/v1/sync/ack', '/harness/v1/sync/end', '/harness/v1/tools'].includes(path);
}
export async function serveSync(request: Request, env: Env, path: string, hash: string): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const body = request.method === 'GET' ? undefined : await readObject(request, 1048576);
  const parsed = thread.safeParse(request.method === 'GET' ? query.get('threadId') : (body as { threadId?: unknown })?.threadId);
  const reply = (status: number, value: unknown) => { const r = json(status, value as Record<string, unknown>); r.headers.set('cache-control', 'no-store'); return r; };
  if (!parsed.success) return reply(400, { error: 'a valid persistent threadId is required' });
  const binding = await env.DIRECTORY.getByName(directoryName).threadBinding(hash, parsed.data);
  if ('error' in binding) return reply(binding.status, { error: binding.error });
  if (binding.value === null) return reply(409, { error: 'conversation is not bound' });
  if (path === '/harness/v1/tools' && request.method === 'GET') {
    const { tools, listed } = await import('./mcp/tools');
    return reply(200, { tools: tools.filter(t => t.name !== 'get_context').map(t => {
      const def = { ...t, fields: t.fields.filter(f => f.name !== 'session_id') };
      return { name: t.name, description: t.description, inputSchema: listed(def)['~standard'].jsonSchema!.input({ target: 'draft-07' }) };
    }) });
  }
  const operation = path === '/harness/v1/tools' ? 'tool' : path.split('/')[4] ?? 'status';
  const input = operation === 'page' ? { snapshotId: query.get('snapshotId'), after: Number(query.get('after')) } : body;
  const result = JSON.parse(await env.MEMORY.getByName(binding.value.memory).syncRequest(binding.value, operation, input));
  return 'error' in result ? reply(result.status, { error: result.error }) : reply(200, result.value);
}
