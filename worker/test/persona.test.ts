import { env } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import { chain, goCompact } from '../src/store/export';
import { encodeContent } from '../src/store/content';
import { encodeRemember } from '../src/store/events';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { adminSecret, Client, createMemory, fetchWorker, freshName, idIn } from './mcp-helpers';

const req = (path: string, token: string, body?: unknown) => fetchWorker(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const admin = (path: string, body?: unknown) => req(path, adminSecret, body);
const host = (token: string, path: string, body?: unknown) => req(`/harness/v1/${path}`, token, body);
type Target = { memory: string; identityId: string; instance: string };
type Eval = { evaluationId: string; token: string; upperSeq: number; total: number };
type Proposal = { proposalId: string; digest: string };
const uid = () => crypto.randomUUID();
async function target(memory: string): Promise<Target> { const r = await admin(`/admin/memories/${memory}/identity`); const x = await r.json() as { instance: string; identity: { id: string } }; return { memory, identityId: x.identity.id, instance: x.instance }; }
async function harness() { const r = await admin('/admin/harnesses', { name: 'synthetic' }); return (await r.json() as { token: string }).token; }
const spec = (t: Target, threadId = uid()) => ({ ...t, threadId, requestId: uid(), source: 'fresh' });
async function start(h: string, body: ReturnType<typeof spec>): Promise<Eval> { const r = await host(h, 'evaluations', body); expect(r.status).toBe(201); return await r.json() as Eval; }
const ep = (t: Target, e: Eval) => `/evaluation/v1/${t.memory}/${e.evaluationId}`;
const document = (summary: string, evidenceIds: string[] = []) => ({ document: { summary, principles: ['Clear'], style: ['Concise'], boundaries: ['Limits'], examples: [{ situation: 'Question', response: 'Answer', limits: 'No guessing', evidenceIds }] }, rationale: 'Reason', changeSummary: 'Change', counterexamples: [], uncertainty: [], evidenceIds });
async function propose(t: Target, e: Eval, summary: string, ids: string[] = []): Promise<Proposal> { const r = await req(`${ep(t,e)}/proposals`, e.token, document(summary, ids)); expect(r.status).toBe(201); return await r.json() as Proposal; }
const pp = (t: Target, p: Proposal) => `/admin/persona/${t.memory}/proposals/${p.proposalId}`;
const exact = (t: Target, p: Proposal) => ({ identityId: t.identityId, instance: t.instance, digest: p.digest });
const confirm = (t: Target, p: Proposal) => admin(`${pp(t,p)}/confirm`, { ...exact(t,p), confirmationId: uid(), decision: 'approve' });
const adopt = (t: Target, p: Proposal) => admin(`${pp(t,p)}/adopt`, exact(t,p));
const bind = (h: string, threadId: string, t: Target) => host(h, 'bind', { threadId, ...t, activationId: uid(), source: 'conversation' });
async function snapshot(name: string) { return runInDurableObject(env.MEMORY.getByName(name), (_o,s) => JSON.stringify(['events','sessions','memories','contents','meta'].map(table => s.storage.sql.exec(`SELECT * FROM ${table}`).toArray()))); }

describe('N2 synthetic persona isolation', () => {
  it('reads a fixed snapshot without memory side effects and rejects crossed capabilities', async () => {
    const a = await createMemory(), b = await createMemory(), ta = await target(a.name), tb = await target(b.name), h = await harness();
    const c = new Client('new', a), cb = new Client('new', b); const s = idIn(await c.ok('get_context', {}), 's_'), sb = idIn(await cb.ok('get_context', {}), 's_');
    const first = idIn(await c.ok('remember', { session_id: s, gist: 'first synthetic', body: 'body' }));
    const foreign = idIn(await cb.ok('remember', { session_id: sb, gist: 'foreign synthetic', body: 'body' }));
    const input = spec(ta), e = await start(h, input), before = await snapshot(a.name);
    const read = await req(ep(ta,e), e.token); expect(read.status).toBe(200); const page = await read.json() as { items: { id: string }[]; total: number }; expect(page.items.map(i => i.id)).toContain(first); expect(await snapshot(a.name)).toBe(before);
    expect((await req(ep(tb,e), e.token)).status).toBe(401);
    expect((await req(`${ep(ta,e)}/proposals`, e.token, document('foreign', [foreign]))).status).toBe(403);
    expect((await req(`${ep(ta,e)}/proposals`, e.token, { ...document('fake'), approved: true })).status).toBe(400);
    await c.ok('remember', { session_id: s, gist: 'later synthetic', body: 'body' });
    const retry = await start(h, input); expect(retry.evaluationId).toBe(e.evaluationId); expect(retry.upperSeq).toBe(e.upperSeq); expect(retry.total).toBe(e.total); expect((await req(ep(ta,e), e.token)).status).toBe(401);
    const again = await (await req(ep(ta,retry), retry.token)).json() as { items: unknown[]; total: number }; expect(again.items).toEqual(page.items); expect(again.total).toBe(page.total);
    expect((await bind(h,input.threadId,ta)).status).toBe(409);
    expect((await host(h,'fork',{ threadId: uid(), parentThreadId: input.threadId, source: 'conversation' })).status).toBe(409);
    expect((await c.list()).map(x => String(x.name)).some(name => /persona|proposal|evaluation/i.test(name))).toBe(false);
    const afterAppend = await propose(ta,retry,'After append',[first]); expect((await confirm(ta,afterAppend)).status).toBe(200); expect((await adopt(ta,afterAppend)).status).toBe(200);
    expect((await host(h,'evaluations',{ ...input, ...tb })).status).toBe(409);
    expect((await host(h,'evaluations',{ ...spec(ta), source: 'conversation' })).status).toBe(400);
    const bound = uid(); expect((await bind(h,bound,ta)).status).toBe(200); expect((await host(h,'evaluations',spec(ta,bound))).status).toBe(409);
  });
  it('requires exact confirmation, rolls back failure and applies one competing proposal', async () => {
    const m = await createMemory(), other = await createMemory(), t = await target(m.name), t2 = await target(other.name), h = await harness();
    const a = uid(), b = uid(); expect((await bind(h,a,t)).status).toBe(200); expect((await bind(h,b,t)).status).toBe(200);
    const e = await start(h,spec(t)), p = await propose(t,e,'Version one'), rival = await propose(t,e,'Rival');
    expect((await adopt(t,p)).status).toBe(403);
    expect((await admin(`${pp(t,p)}/confirm`, { ...exact(t,p), digest: '0'.repeat(64), confirmationId: uid(), decision: 'approve' })).status).toBe(409);
    expect((await confirm(t,p)).status).toBe(200); expect((await confirm(t,rival)).status).toBe(200);
    const stub = env.MEMORY.getByName(m.name); await runInDurableObject(stub, (_o,s) => s.storage.sql.exec("CREATE TRIGGER test_persona_fail BEFORE INSERT ON persona_current BEGIN SELECT RAISE(ABORT, 'test failure'); END"));
    try { expect((await adopt(t,p)).status).toBeGreaterThanOrEqual(500); } finally { await runInDurableObject(stub, (_o,s) => s.storage.sql.exec('DROP TRIGGER test_persona_fail')); }
    expect(await runInDurableObject(stub, (_o,s) => s.storage.sql.exec<{n:number}>('SELECT count(*) n FROM persona_versions').toArray()[0]!.n)).toBe(0);
    const results = await Promise.all([adopt(t,p),adopt(t,rival)]); expect(results.map(r => r.status).sort()).toEqual([200,409]); const winner = results[0]!.status === 200 ? p : rival;
    const load = async (thread: string) => (await (await host(h,`persona?threadId=${thread}`)).json()) as { version: number; loadText: string; canRun: boolean };
    expect(await load(a)).toEqual(await load(b)); expect((await load(a)).canRun).toBe(false);
    const e2 = await start(h,spec(t)), p2 = await propose(t,e2,'Version two'); expect((await confirm(t,p2)).status).toBe(200); expect((await adopt(t,p2)).status).toBe(200); expect((await adopt(t,winner)).status).toBe(200);
    for (const thread of [a,b]) { const x = await load(thread); expect(x.version).toBe(2); expect(x.loadText).toContain('Version two'); } expect((await bind(h,a,t2)).status).toBe(409);
  });
  it('restores stable persona and removes derived text when its source is erased', async () => {
    const m = await createMemory(), t = await target(m.name), h = await harness(), c = new Client('new',m), s = idIn(await c.ok('get_context', {}), 's_'), marker = `private_${uid()}`;
    const id = idIn(await c.ok('remember', { session_id: s, gist: marker, body: marker })); const e = await start(h,spec(t)), p = await propose(t,e,marker,[id]); expect((await confirm(t,p)).status).toBe(200); expect((await adopt(t,p)).status).toBe(200);
    const thread = uid(); expect((await bind(h,thread,t)).status).toBe(200); const original = await (await host(h,`persona?threadId=${thread}`)).json() as { loadText: string };
    const backup = await (await admin(`/admin/memories/${m.name}/export`)).text(); expect(JSON.parse(backup.split('\n')[0]!).ziwo_export).toBe(3);
    const restored = freshName(); expect((await admin(`/admin/memories/${restored}/import`,backup)).status).toBe(201); const rt = await target(restored); expect(rt.identityId).toBe(t.identityId); expect(rt.instance).not.toBe(t.instance);
    const rtThread = uid(); expect((await bind(h,rtThread,rt)).status).toBe(200); const loaded = await (await host(h,`persona?threadId=${rtThread}`)).json() as { loadText: string }; expect(loaded.loadText).toBe(original.loadText);
    expect((await admin(`/admin/memories/${freshName()}/import`,backup.replace(marker,'tampered'))).status).toBe(400);
    const altered = backup.trimEnd().split('\n'); let head = createHash('sha256').update('ziwo-export-v3\n' + goCompact(altered[0]!)).digest('hex');
    let changed = false;
    for (let i = 1; i < altered.length - 1; i++) { const ev = JSON.parse(altered[i]!); if (typeof ev.content === 'string' && ev.content.includes(marker)) { ev.content = ev.content.replaceAll(marker,'replaced'); changed = true; } head = chain(head,ev.seq,ev.at,ev.kind,JSON.stringify(ev.payload),ev.content); ev.chain = head; altered[i] = JSON.stringify(ev); }
    expect(changed).toBe(true); const foot = JSON.parse(altered[altered.length-1]!); foot.head = head; altered[altered.length-1] = JSON.stringify(foot);
    const rejected = freshName(); expect((await admin(`/admin/memories/${rejected}/import`,altered.join('\n') + '\n')).status).toBe(400); expect((await admin(`/admin/memories/${rejected}/identity`)).status).toBe(404);

    const inherited = await start(h,spec(t)); const inheritedProposal = await propose(t,inherited,'Derived successor'); expect((await confirm(t,inheritedProposal)).status).toBe(200); expect((await adopt(t,inheritedProposal)).status).toBe(200);
    await c.ok('erase',{ session_id: s, id, reason: 'synthetic deletion' }); expect((await req(ep(t,e),e.token)).status).toBe(401); expect((await adopt(t,p)).status).toBe(409); expect((await host(h,`persona?threadId=${thread}`)).status).toBe(409);
    const derived = await runInDurableObject(env.MEMORY.getByName(m.name), (_o,st) => JSON.stringify(['persona_evaluations','persona_proposals','persona_versions'].map(table => st.storage.sql.exec(`SELECT * FROM ${table}`).toArray()))); expect(derived).not.toContain(marker);
  });
  it('revokes evaluation access and fails closed on damaged persona', async () => {
    const m = await createMemory(), t = await target(m.name);
    const hr = await admin('/admin/harnesses', { name: 'revocation test' }); const h = await hr.json() as { id: string; token: string };
    const e = await start(h.token,spec(t)), p = await propose(t,e,'Protected'); expect((await confirm(t,p)).status).toBe(200); expect((await adopt(t,p)).status).toBe(200);
    const thread = uid(); expect((await bind(h.token,thread,t)).status).toBe(200);
    await runInDurableObject(env.MEMORY.getByName(m.name), (_o,s) => s.storage.sql.exec("UPDATE persona_versions SET record = json_set(record, '$.loadText', 'corrupted') WHERE version = 1"));
    expect((await host(h.token,`persona?threadId=${thread}`)).status).toBe(409);
    const del = await fetchWorker(`/admin/harnesses/${h.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${adminSecret}` } }); expect(del.status).toBe(200);
    expect((await req(ep(t,e),e.token)).status).toBe(403);
  });
  it('rejects a mixed-owner backup even with a recomputed chain', async () => {
    const a = await createMemory(), b = await createMemory(), ta = await target(a.name), tb = await target(b.name), h = await harness();
    const ea = await start(h,spec(ta)), pa = await propose(ta,ea,'Owner A'); expect((await confirm(ta,pa)).status).toBe(200); expect((await adopt(ta,pa)).status).toBe(200);
    const eb = await start(h,spec(tb)), pb = await propose(tb,eb,'Owner B'); expect((await confirm(tb,pb)).status).toBe(200); expect((await adopt(tb,pb)).status).toBe(200);
    const ba = await (await admin(`/admin/memories/${a.name}/export`)).text(), bb = await (await admin(`/admin/memories/${b.name}/export`)).text();
    const lines = ba.trimEnd().split('\n'); const header = JSON.parse(lines[0]!); header.persona = JSON.parse(bb.split('\n')[0]!).persona; lines[0] = JSON.stringify(header);
    let head = createHash('sha256').update('ziwo-export-v3\n' + goCompact(lines[0]!)).digest('hex');
    for (let i = 1; i < lines.length - 1; i++) { const ev = JSON.parse(lines[i]!); head = chain(head,ev.seq,ev.at,ev.kind,JSON.stringify(ev.payload),ev.content); ev.chain = head; lines[i] = JSON.stringify(ev); }
    const footer = JSON.parse(lines[lines.length-1]!); footer.head = head; lines[lines.length-1] = JSON.stringify(footer);
    expect((await admin(`/admin/memories/${freshName()}/import`, lines.join('\n') + '\n')).status).toBe(400);
  });

  it('treats legacy self records as evidence rather than an adopted persona', async () => {
    const m = await createMemory(), t = await target(m.name), h = await harness(), c = new Client('new',m), session = idIn(await c.ok('get_context', {}), 's_');
    await runInDurableObject(env.MEMORY.getByName(m.name), (o, st) => {
      const id = 'm_syntheticself'; const content = encodeContent({ gist: 'Synthetic self statement', context: 'Synthetic context' });
      st.storage.sql.exec('INSERT INTO contents(id,data) VALUES(?,?)',id,content.data);
      const ev = { id, session, kind: 'self', moment: 'other', source: 'lived', importance: 0.5, intensity: 0, hash: content.hash, corrects: '', happened: 0, from: [], ref: '', milestone: false };
      st.storage.sql.exec("INSERT INTO events(at,kind,payload) VALUES(?, 'remember', ?)",Date.now(),encodeRemember(ev)); o.store.rebuild();
    });
    const thread = uid(); expect((await bind(h,thread,t)).status).toBe(200); expect((await host(h,`persona?threadId=${thread}`)).status).toBe(409);
    const e = await start(h,spec(t)); const page = await (await req(ep(t,e),e.token)).json() as { persona: unknown; items: { id: string }[] };
    expect(page.persona).toBeNull(); expect(page.items.map(x => x.id)).toContain('m_syntheticself');
    const backup = await (await admin(`/admin/memories/${m.name}/export`)).text(); expect(JSON.parse(backup.split('\n')[0]!).ziwo_export).toBe(2);
    const restored = freshName(); expect((await admin(`/admin/memories/${restored}/import`,backup)).status).toBe(201); const rt = await target(restored); expect(rt.identityId).toBe(t.identityId);
    const restoredThread = uid(); expect((await bind(h,restoredThread,rt)).status).toBe(200); expect((await host(h,`persona?threadId=${restoredThread}`)).status).toBe(409);
    const re = await start(h,spec(rt)); const restoredPage = await (await req(ep(rt,re),re.token)).json() as { persona: unknown; items: { id: string }[] }; expect(restoredPage.persona).toBeNull(); expect(restoredPage.items.map(x => x.id)).toContain('m_syntheticself');

  });

  it('enforces trusted confirmation credentials and rejects declined or reused confirmations', async () => {
    const m = await createMemory(), t = await target(m.name), h = await harness(), e = await start(h,spec(t));
    const p = await propose(t,e,'Approval guarded'), other = await propose(t,e,'Declined'); const receipt = uid();
    const approval = { ...exact(t,p), confirmationId: receipt, decision: 'approve' };
    for (const token of [e.token,h,m.token]) {
      expect((await req(`${pp(t,p)}/confirm`,token,approval)).status).toBe(401);
      expect((await req(`${pp(t,p)}/adopt`,token,exact(t,p))).status).toBe(401);
    }
    const before = await snapshot(m.name);
    const badMcp = await fetchWorker(`/${m.name}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28' }, body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'tools/call', params:{ name:'remember', arguments:{ gist:'unauthorized', body:'unauthorized' } } }) });
    expect(badMcp.status).toBe(401); expect(await snapshot(m.name)).toBe(before);
    expect((await admin(`${pp(t,p)}/confirm`,approval)).status).toBe(200);
    expect((await admin(`${pp(t,p)}/confirm`,{ ...approval, digest:'0'.repeat(64) })).status).toBe(409);
    expect((await admin(`${pp(t,p)}/confirm`,{ ...approval, identityId:'zi_' + 'a'.repeat(32) })).status).toBe(409);
    expect((await admin(`${pp(t,other)}/confirm`,{ ...exact(t,other), confirmationId:receipt, decision:'approve' })).status).toBe(409);
    expect((await admin(`${pp(t,other)}/confirm`,{ ...exact(t,other), confirmationId:uid(), decision:'reject' })).status).toBe(200);
    expect((await adopt(t,other)).status).toBe(403);
  });

});

it('keeps independent consumer cursors coherent across persona revisions and concurrent pages', async () => {
  const m=await createMemory(), t=await target(m.name), h=await harness(), writer=new Client('new',m), online=new Client('new',m), offline=new Client('new',m);
  await writer.connect(); await online.connect(); await offline.connect();
  const adoptVersion=async (label:string) => {const e=await start(h,spec(t)),p=await propose(t,e,label);expect((await confirm(t,p)).status).toBe(200);expect((await adopt(t,p)).status).toBe(200);};
  await adoptVersion('Revision one');
  const read=async (client:Client,args:Record<string,unknown>={}) => JSON.parse(await client.ok('sync_context',args)) as {cursor:string;complete:boolean;persona?:{version:number;loadText:string};changes:unknown[]};
  const firstOnline=await read(online), firstOffline=await read(offline);expect(firstOnline.persona?.version).toBe(1);expect(firstOffline.persona?.version).toBe(1);
  const sid=idIn(await writer.ok('get_context',{}),'s_');for(let i=0;i<3;i++)await writer.ok('remember',{session_id:sid,gist:`concurrent ${i}`,body:`synthetic ${i}`});
  const pending=await read(online,{cursor:firstOnline.cursor,page_size:1});expect(pending.complete).toBe(false);expect(pending.persona).toBeUndefined();
  await adoptVersion('Revision two');
  expect((await online.tool('sync_context',{cursor:pending.cursor,page_size:1})).isError).toBe(true);
  const reloaded=await read(online,{cursor:pending.cursor,reload:true,page_size:100});expect(reloaded.complete).toBe(true);expect(reloaded.persona?.version).toBe(2);
  await adoptVersion('Revision three');
  const delayed=await read(offline,{cursor:firstOffline.cursor,page_size:100});expect(delayed.persona?.version).toBe(3);expect(JSON.stringify(delayed.persona)).toContain('Revision three');expect(delayed.changes.length).toBe(3);
  const unchanged=await read(online,{cursor:reloaded.cursor,page_size:100});expect(unchanged.persona?.version).toBe(3);
  await writer.ok('remember',{session_id:sid,gist:'ordinary after revision',body:'does not change persona'});
  const ordinary=await read(online,{cursor:unchanged.cursor});expect(ordinary.persona).toBeUndefined();expect(ordinary.changes.length).toBe(1);
});
