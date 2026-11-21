import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Client, createMemory, idIn, type Generation } from './mcp-helpers';
import { grant } from './oauth-helpers';

type Feed = { cursor: string; complete: boolean; changes: Record<string, unknown>[]; persona?: { status: string } };
async function sync(c: Client, args: Record<string, unknown> = {}): Promise<Feed> {
  const r = await c.send('tools/call', { name: 'sync_context', arguments: args });
  const result = r.msg?.result as { isError?: boolean; structuredContent?: Feed };
  expect(result?.isError, JSON.stringify(result)).not.toBe(true); expect(result?.structuredContent).toBeDefined(); return result.structuredContent!;
}
async function snapshot(name: string) { return runInDurableObject(env.MEMORY.getByName(name), (_o, s) => JSON.stringify(['events','sessions','contents','meta','persona_current','persona_versions'].map(t => s.storage.sql.exec(`SELECT * FROM ${t}`).toArray()))); }
async function totalWrites(name: string) { return runInDurableObject(env.MEMORY.getByName(name), (_o, s) => s.storage.sql.exec<{ n: number }>('SELECT total_changes() AS n').one().n); }

describe.each<Generation>(['old','new'])('ordinary MCP incremental feed (%s)', gen => {
  it('supports token and OAuth, unchanged checks write nothing, and later memory still writes', async () => {
    const m = await createMemory(), c = new Client(gen,m); await c.connect();
    const session = idIn(await c.ok('get_context', {}), 's_'); await c.ok('remember', { session_id: session, gist: 'synthetic', body: 'unique-body' });
    const first = await sync(c); expect(JSON.stringify(first.changes)).toContain('unique-body'); expect(first.persona?.status).toBe('uninitialized');
    const before = await snapshot(m.name), writes = await totalWrites(m.name); let cursor = first.cursor;
    for (let i=0;i<100;i++) { const page = await sync(c,{cursor}); expect(page.changes).toEqual([]); expect(page.persona).toBeUndefined(); cursor = page.cursor; }
    expect(await snapshot(m.name)).toBe(before);
    expect(await totalWrites(m.name)).toBe(writes);
    await c.ok('remember', { session_id: session, gist: 'after empty', body: 'new-body' });
    const next = await sync(c,{cursor}); expect(JSON.stringify(next.changes)).toContain('new-body');
    const g = await grant(m.name,m.token); const oauth = new Client(gen,{name:m.name,token:g.tokens.access_token}); await oauth.connect();
    const page = await sync(oauth,{cursor:next.cursor}); expect(page.changes).toEqual([]); expect(page.persona).toBeUndefined();
  });
  it('fixes pagination upper bound and rejects tampering, cross-subject and erase during paging', async () => {
    const a = await createMemory(), b = await createMemory(); const c = new Client(gen,a), other = new Client(gen,b); await c.connect(); await other.connect();
    const sid = idIn(await c.ok('get_context', {}),'s_'); const one = idIn(await c.ok('remember',{session_id:sid,gist:'one',body:'one-body'})); await c.ok('remember',{session_id:sid,gist:'two',body:'two-body'});
    const first = await sync(c,{page_size:1}); expect(first.complete).toBe(false);
    await c.ok('remember',{session_id:sid,gist:'later',body:'later-body'});
    const second = await sync(c,{cursor:first.cursor,page_size:1}); expect(JSON.stringify(second.changes)).not.toContain('later-body');
    expect((await c.tool('sync_context',{cursor:first.cursor+'x'})).isError).toBe(true);
    expect((await other.tool('sync_context',{cursor:first.cursor})).isError).toBe(true);
    await c.ok('erase',{session_id:sid,id:one,reason:'test'});
    expect((await c.tool('sync_context',{cursor:first.cursor,page_size:1})).isError).toBe(true);
  });
});

it('never exposes an unconfirmed proposal and invalidates cached persona on adoption', async () => {
  const { adminSecret, fetchWorker } = await import('./mcp-helpers');
  const request = (path: string, token: string, body?: unknown) => fetchWorker(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const m = await createMemory(), c = new Client('new',m); await c.connect(); let cursor = (await sync(c)).cursor;
  const identity = await (await request(`/admin/memories/${m.name}/identity`,adminSecret)).json() as { instance:string; identity:{id:string} };
  const target = {memory:m.name,identityId:identity.identity.id,instance:identity.instance};
  const h = await (await request('/admin/harnesses',adminSecret,{name:'sync-persona'})).json() as {token:string};
  async function make(summary:string, evidenceIds: string[] = []) {
    const e = await (await request('/harness/v1/evaluations',h.token,{...target,threadId:crypto.randomUUID(),requestId:crypto.randomUUID(),source:'fresh'})).json() as {evaluationId:string;token:string};
    const r = await request(`/evaluation/v1/${m.name}/${e.evaluationId}/proposals`,e.token,{document:{summary,principles:[],style:[],boundaries:[],examples:[]},rationale:'test',changeSummary:'test',counterexamples:[],uncertainty:[],evidenceIds}); expect(r.status).toBe(201);
    const p = await r.json() as {proposalId:string;digest:string}, path = `/admin/persona/${m.name}/proposals/${p.proposalId}`, exact = {identityId:target.identityId,instance:target.instance,digest:p.digest};
    return { confirm: () => request(`${path}/confirm`,adminSecret,{...exact,confirmationId:crypto.randomUUID(),decision:'approve'}), adopt: () => request(`${path}/adopt`,adminSecret,exact) };
  }
  const p = await make('First persona'); expect((await p.adopt()).status).not.toBe(200); expect((await sync(c,{cursor})).persona).toBeUndefined();
  expect((await p.confirm()).status).toBe(200); expect((await p.adopt()).status).toBe(200);
  const first = await sync(c,{cursor}); expect(JSON.stringify(first.persona)).toContain('First persona'); cursor=first.cursor;
  expect((await sync(c,{cursor})).persona).toBeUndefined();
  const p2 = await make('Second persona'); expect((await p2.confirm()).status).toBe(200); expect((await p2.adopt()).status).toBe(200);
  const second = await sync(c,{cursor}); expect(JSON.stringify(second.persona)).toContain('Second persona'); expect(JSON.stringify(second.persona)).not.toContain('First persona');
  const sid = idIn(await c.ok('get_context', {}),'s_');
  const sources: string[] = []; for (let i=0;i<12;i++) sources.push(idIn(await c.ok('remember',{session_id:sid,gist:`evidence ${i}`,body:'source body'})));
  const source = sources[0]!;
  const p3 = await make('Evidence persona',sources); expect((await p3.confirm()).status).toBe(200); expect((await p3.adopt()).status).toBe(200);
  const loaded = await sync(c,{cursor:second.cursor}); expect(JSON.stringify(loaded.persona)).toContain('Evidence persona');
  const usage = await runInDurableObject(env.MEMORY.getByName(m.name), async (_o, state) => {
    const { Db } = await import('../src/store/db'); const { Personas } = await import('../src/store/persona');
    const db = new Db(state.storage.sql), cache = {}, personas = new Personas(db,state.storage,cache);
    personas.load(target.identityId,target.instance); const cold = db.usage(); db.resetUsage();
    personas.load(target.identityId,target.instance); return { cold, warm: db.usage() };
  });
  expect(usage.warm.rowsRead).toBeLessThan(usage.cold.rowsRead / 2); expect(usage.warm.rowsWritten).toBe(0);
  await c.ok('amend',{session_id:sid,id:source,action:'retract',reason:'test'});
  expect((await c.tool('sync_context',{cursor:loaded.cursor})).isError).toBe(true);
  await c.ok('amend',{session_id:sid,id:source,action:'restore',reason:'test'});
  expect((await sync(c,{cursor:loaded.cursor})).persona).toBeUndefined();
  await c.ok('amend',{session_id:sid,id:source,action:'correct',gist:'corrected',body:'corrected body',reason:'test'});
  expect((await c.tool('sync_context',{cursor:loaded.cursor})).isError).toBe(true);
});

it('invalidates the old cursor after token rotation', async () => {
  const { adminSecret, fetchWorker } = await import('./mcp-helpers');
  const m = await createMemory(), c = new Client('new',m); await c.connect(); const first = await sync(c);
  const r = await fetchWorker(`/admin/memories/${m.name}/token`,{method:'POST',headers:{authorization:`Bearer ${adminSecret}`}}); expect(r.status).toBe(200);
  const { token } = await r.json() as {token:string}; const rotated = new Client('new',{name:m.name,token}); await rotated.connect();
  expect((await rotated.tool('sync_context',{cursor:first.cursor})).isError).toBe(true);
  const fresh = await sync(rotated); expect(fresh.complete).toBe(true);
});

it('keeps multi-record pages within their byte budget', async () => {
  const m = await createMemory(), c = new Client('new',m); await c.connect(); const sid = idIn(await c.ok('get_context',{}),'s_');
  for (let i=0;i<14;i++) await c.ok('remember',{session_id:sid,gist:`item ${i}`,body:'x'.repeat(6000)});
  let page = await sync(c,{page_size:100}); let seen=0;
  do { const size = new TextEncoder().encode(JSON.stringify(page.changes)).byteLength; expect(size).toBeLessThan(66000); seen += page.changes.length; if (page.complete) break; page = await sync(c,{cursor:page.cursor,page_size:100}); } while (true);
  expect(seen).toBe(14);
});

it('rejects a cursor from the same identity after backup import creates a new instance', async () => {
  const { adminSecret, fetchWorker, freshName } = await import('./mcp-helpers');
  const m = await createMemory(), c = new Client('new',m); await c.connect(); const old = await sync(c);
  const backup = await (await fetchWorker(`/admin/memories/${m.name}/export`,{headers:{authorization:`Bearer ${adminSecret}`}})).text();
  const name = freshName(); const imported = await fetchWorker(`/admin/memories/${name}/import`,{method:'POST',headers:{authorization:`Bearer ${adminSecret}`},body:backup}); expect(imported.status).toBe(201);
  const rotated = await fetchWorker(`/admin/memories/${name}/token`,{method:'POST',headers:{authorization:`Bearer ${adminSecret}`}}); const token = (await rotated.json() as {token:string}).token; const restored = new Client('new',{name,token}); await restored.connect();
  expect((await restored.tool('sync_context',{cursor:old.cursor})).isError).toBe(true); expect((await sync(restored)).complete).toBe(true);
});
