import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { ThreadBinding } from '../src/bindings';
import { describe, expect, it } from 'vitest';
import { adminSecret, Client, createMemory, fetchWorker, legacy, modern, readReply } from './mcp-helpers';
const admin = (path:string, body?:unknown, method='POST') => fetchWorker(path,{method,headers:{authorization:`Bearer ${adminSecret}`},...(body === undefined ? {} : {body:JSON.stringify(body)})});
async function fixture() {
 const m=await createMemory(); const info=await (await admin(`/admin/memories/${m.name}/identity`,undefined,'GET')).json() as {identity:{id:string};instance:string};
 const target={identityId:info.identity.id,instance:info.instance}; const e=await (await admin(`/admin/persona/${m.name}/evaluations`,{...target,requestId:crypto.randomUUID(),source:'fresh'})).json() as {evaluationId:string;token:string};
 const pr=await fetchWorker(`/evaluation/v1/${m.name}/${e.evaluationId}/proposals`,{method:'POST',headers:{authorization:`Bearer ${e.token}`},body:JSON.stringify({document:{summary:'Synthetic persona',principles:[],style:[],boundaries:[],examples:[]},rationale:'test',changeSummary:'test',counterexamples:[],uncertainty:[],evidenceIds:[]})}); expect(pr.status).toBe(201);
 const p=await pr.json() as {proposalId:string;digest:string}, path=`/admin/persona/${m.name}/proposals/${p.proposalId}`, exact={...target,digest:p.digest};
 expect((await admin(`${path}/confirm`,{...exact,confirmationId:crypto.randomUUID(),decision:'approve'})).status).toBe(200); expect((await admin(`${path}/adopt`,exact)).status).toBe(200);
 const h=await (await admin('/admin/harnesses',{name:'lifecycle-test'})).json() as {id:string;token:string}; return {m,h};
}
type Meta={id:string;createdAt:number;parentId:string|null;temporary:boolean;seeded:boolean;turn:string;history?:{cutoff:null|{turnId:string;itemId:string;sequence:number};coverage:'complete'|'partial';gaps:{id:string;from:number|null;to:number|null;reason:'unavailable'}[];items:Record<string,unknown>[]}};
const meta=(id:string):Meta=>({id,createdAt:123,parentId:null,temporary:false,seeded:false,turn:'turn-1',history:{cutoff:null,coverage:'complete',gaps:[],items:[]}});
async function rpc(f:Awaited<ReturnType<typeof fixture>>, protocol:string, name:string, args:Record<string,unknown>, claim?:Meta, token=f.h.token) {
 const params:Record<string,unknown>={name,arguments:args}; if(claim) params._meta={'io.ziwo/conversation':claim,...(protocol===modern?{'io.modelcontextprotocol/protocolVersion':modern,'io.modelcontextprotocol/clientInfo':{name:'test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}:{})};
 const r=await fetchWorker(`/${f.m.name}/agent/mcp`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':protocol,...(protocol===modern?{'mcp-method':'tools/call','mcp-name':name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params})}); return readReply(r);
}
function value(r:Awaited<ReturnType<typeof rpc>>) { const x=r.msg?.result as {isError?:boolean;structuredContent?:Record<string,any>}; expect(x?.isError,JSON.stringify(r.msg)).not.toBe(true); expect(x?.structuredContent, JSON.stringify(r.msg)).toBeDefined(); return x.structuredContent!; }
function failed(r:Awaited<ReturnType<typeof rpc>>) { expect(r.msg?.error ?? (r.msg?.result as {isError?:boolean})?.isError,JSON.stringify(r.msg)).toBeTruthy(); }

async function initialize(f:Awaited<ReturnType<typeof fixture>>, protocol:string, claim:Meta) {
 const p=value(await rpc(f,protocol,'activate_context',{},claim)).persona;
 value(await rpc(f,protocol,'initialize_context',{personaVersion:p.version,personaDigest:p.digest},claim));
 value(await rpc(f,protocol,'complete_context',{requestId:'complete'},claim));
 return value(await rpc(f,protocol,'refresh_context',{},claim));
}
describe.each([legacy,modern])('trusted lifecycle %s', protocol=>{
 it('releases only a definitely unbound failed activation',async()=>{
  const f=await fixture(), uninitialized=await createMemory(), claim=meta('no-persona');
  const rejected=await rpc({...f,m:uninitialized},protocol,'activate_context',{},claim);
  failed(rejected); expect((rejected.msg?.result as {structuredContent:unknown}).structuredContent).toEqual({activationEstablished:false});
  // A failed persona load left the conversation neutral; it can choose A.
  value(await rpc(f,protocol,'activate_context',{},claim));
  const conflict=await rpc({...f,m:uninitialized},protocol,'activate_context',{},claim);
  failed(conflict); expect((conflict.msg?.result as {structuredContent:unknown}).structuredContent).toEqual({});
 });
 it('processes fixed history exactly once and gates incomplete initialization',async()=>{
  const f=await fixture(), a=meta('history-a'); a.history={cutoff:{turnId:'past',itemId:'item-1',sequence:0},coverage:'complete',gaps:[],items:[{itemId:'item-1',turnId:'past',sequence:0,contentDigest:'a'.repeat(64),material:'original',status:'completed',occurrence:{precision:'unknown'}}]};
  const p=value(await rpc(f,protocol,'activate_context',{},a)).persona; value(await rpc(f,protocol,'initialize_context',{personaVersion:p.version,personaDigest:p.digest},a));
  failed(await rpc(f,protocol,'complete_context',{requestId:'early'},a)); failed(await rpc(f,protocol,'refresh_context',{},a));
  const batch={requestId:'history-batch',decisions:[{itemId:'item-1',action:'remember',memory:{gist:'past',body:'synthetic past'}}]};
  const first=value(await rpc(f,protocol,'process_initial_history',batch,a)); const retry=value(await rpc(f,protocol,'process_initial_history',batch,a)); expect(retry).toEqual(first);
  value(await rpc(f,protocol,'complete_context',{requestId:'done'},a)); const page=value(await rpc(f,protocol,'refresh_context',{},a)); expect(JSON.stringify(page.changes)).toContain('synthetic past');
 });
 it('isolates endpoints, hosts, cursors and verified fork lineage',async()=>{
  const f=await fixture(), b=await fixture(), a=meta('shared-id'); const first=await initialize(f,protocol,a);
  const otherRoute={...f,m:b.m}; failed(await rpc(otherRoute,protocol,'activate_context',{},a));
  const second=meta('other-conversation'); const secondPage=await initialize(f,protocol,second);
  failed(await rpc(f,protocol,'remember',{cursor:first.cursor,requestId:'wrong',gist:'g',body:'b'},second));
  const otherHost={...f,h:b.h}; const otherPage=await initialize(otherHost,protocol,a); expect(otherPage.cursor).not.toBe(first.cursor);
  const child:Meta={...meta('fork-child'),parentId:a.id,seeded:true}; const cp=value(await rpc(f,protocol,'activate_context',{},child)).persona;
  value(await rpc(f,protocol,'initialize_context',{personaVersion:cp.version,personaDigest:cp.digest},child)); value(await rpc(f,protocol,'complete_context',{requestId:'child-done'},child));
  const childPage=value(await rpc(f,protocol,'refresh_context',{},child)); failed(await rpc(f,protocol,'remember',{cursor:secondPage.cursor,requestId:'cross',gist:'g',body:'b'},child)); expect(childPage.cursor).toBeTypeOf('string');
 });
 it('requires a complete trusted page and rejects ordinary MCP cursors',async()=>{
  const f=await fixture(), a=meta('pages'); const initial=await initialize(f,protocol,a);
  for(let i=0;i<3;i++) value(await rpc(f,protocol,'remember',{cursor:initial.cursor,requestId:`w${i}`,gist:`item${i}`,body:`body${i}`},a));
  const page=value(await rpc(f,protocol,'refresh_context',{cursor:initial.cursor,page_size:1}, {...a,turn:'turn-2'})); expect(page.complete).toBe(false);
  failed(await rpc(f,protocol,'remember',{cursor:page.cursor,requestId:'too-early',gist:'g',body:'b'}, {...a,turn:'turn-2'}));
  const ordinary=new Client(protocol===legacy?'old':'new',f.m); await ordinary.connect(); const plain=JSON.parse(await ordinary.ok('sync_context',{})) as {cursor:string};
  failed(await rpc(f,protocol,'remember',{cursor:plain.cursor,requestId:'plain',gist:'g',body:'b'}, {...a,turn:'turn-2'}));
  expect((await ordinary.tool('sync_context',{cursor:page.cursor})).isError).toBe(true);
 });
 it('loads an adopted persona revision without changing the bound identity',async()=>{
  const f=await fixture(), a=meta('revision'); const first=await initialize(f,protocol,a); const original=first.identity;
  const info=await (await admin(`/admin/memories/${f.m.name}/identity`,undefined,'GET')).json() as {identity:{id:string};instance:string}; const target={identityId:info.identity.id,instance:info.instance};
  const e=await (await admin(`/admin/persona/${f.m.name}/evaluations`,{...target,requestId:'rev2',source:'fresh'})).json() as {evaluationId:string;token:string};
  const pr=await fetchWorker(`/evaluation/v1/${f.m.name}/${e.evaluationId}/proposals`,{method:'POST',headers:{authorization:`Bearer ${e.token}`},body:JSON.stringify({document:{summary:'Revised persona',principles:[],style:[],boundaries:[],examples:[]},rationale:'test',changeSummary:'test',counterexamples:[],uncertainty:[],evidenceIds:[]})}); expect(pr.status).toBe(201);
  const p=await pr.json() as {proposalId:string;digest:string}, path=`/admin/persona/${f.m.name}/proposals/${p.proposalId}`, exact={...target,digest:p.digest};
  expect((await admin(`${path}/confirm`,{...exact,confirmationId:'confirm2',decision:'approve'})).status).toBe(200); expect((await admin(`${path}/adopt`,exact)).status).toBe(200);
  const revised=value(await rpc(f,protocol,'refresh_context',{cursor:first.cursor}, {...a,turn:'turn-2'})); expect(revised.identity).toEqual(original); expect(JSON.stringify(revised.persona)).toContain('Revised persona');
 });
 it('resumes only an existing root or verified child without switching subjects',async()=>{
  const f=await fixture(), other=await fixture(), a=meta('resume-root');
  const neutral=value(await rpc(f,protocol,'resume_context',{},a)); expect(neutral.activationEstablished).toBe(false);
  await initialize(f,protocol,a); const resumed=value(await rpc(f,protocol,'resume_context',{},a)); expect(resumed.identity).toBeDefined();
  failed(await rpc({...f,m:other.m},protocol,'resume_context',{},a));
  const child:Meta={...meta('resume-child'),parentId:a.id,seeded:true}; const inherited=value(await rpc(f,protocol,'resume_context',{},child)); expect(inherited.identity).toBeDefined(); expect(inherited.identity).toEqual(resumed.identity);
  failed(await rpc(f,protocol,'resume_context',{}, {...meta('bad-child'),parentId:'missing',seeded:true}));
  failed(await rpc(f,protocol,'resume_context',{}, {...meta('temporary'),temporary:true}));
 });
 it('acknowledges notice without erasing unresolved history gaps',async()=>{
  const f=await fixture(), a=meta('gap-root'); a.history={cutoff:null,coverage:'partial',gaps:[{id:'gap',from:null,to:null,reason:'unavailable'}],items:[]};
  const p=value(await rpc(f,protocol,'activate_context',{},a)).persona; value(await rpc(f,protocol,'initialize_context',{personaVersion:p.version,personaDigest:p.digest},a));
  const done=value(await rpc(f,protocol,'complete_context',{requestId:'complete-gap'},a)); expect(done.historyIncomplete).toBe(true); expect(done.noticePending).toBe(true);
  const acknowledged=value(await rpc(f,protocol,'acknowledge_history_notice',{},a)); expect(acknowledged.noticePending).toBe(false); expect(acknowledged.historyIncomplete).toBe(true);
  const resumed=value(await rpc(f,protocol,'resume_context',{},a)); expect(resumed.activation.historyIncomplete).toBe(true); expect(resumed.activation.noticePending).toBe(false);
 });
 it('enforces metadata, activation gates, turn cursor and immutable identity',async()=>{
  const f=await fixture(), a=meta('conversation-a'); expect((await rpc(f,protocol,'activate_context',{},a,f.m.token)).status).toBe(401);
  failed(await rpc(f,protocol,'activate_context',{})); failed(await rpc(f,protocol,'activate_context',{conversation:a},a));
  failed(await rpc(f,protocol,'activate_context',{}, {...a,temporary:true})); failed(await rpc(f,protocol,'activate_context',{}, {...a,seeded:true}));
  const activated=value(await rpc(f,protocol,'activate_context',{},a)), persona=activated.persona;
  failed(await rpc(f,protocol,'refresh_context',{},a)); failed(await rpc(f,protocol,'remember',{cursor:'bad',requestId:'r',gist:'g',body:'b'},a));
  value(await rpc(f,protocol,'initialize_context',{personaVersion:persona.version,personaDigest:persona.digest},a)); value(await rpc(f,protocol,'complete_context',{requestId:'complete'},a));
  const refresh=value(await rpc(f,protocol,'refresh_context',{},a)); value(await rpc(f,protocol,'remember',{cursor:refresh.cursor,requestId:'write',gist:'g',body:'b'},a));
  failed(await rpc(f,protocol,'remember',{cursor:refresh.cursor,requestId:'next',gist:'g',body:'b'}, {...a,turn:'turn-2'}));
  failed(await rpc(f,protocol,'remember',{cursor:refresh.cursor,requestId:'cross',gist:'g',body:'b'}, {...a,id:'other'}));
  failed(await rpc(f,protocol,'activate_context',{}, {...a,createdAt:124}));
  expect((await admin(`/admin/harnesses/${f.h.id}`,undefined,'DELETE')).status).toBe(200); expect((await rpc(f,protocol,'refresh_context',{},a)).status).not.toBe(200);
 });
});

it('caches ready history without writes and invalidates the cache on changed activation',async()=>{
 const f=await fixture(), claim=meta('readiness-cache');
 claim.history={cutoff:{turnId:'past',itemId:'item-9',sequence:9},coverage:'complete',gaps:[],items:Array.from({length:10},(_,i)=>({itemId:`item-${i}`,turnId:'past',sequence:i,contentDigest:'a'.repeat(64),material:'original',status:'completed',occurrence:{precision:'unknown'}}))};
 const p=value(await rpc(f,modern,'activate_context',{},claim)).persona;
 value(await rpc(f,modern,'initialize_context',{personaVersion:p.version,personaDigest:p.digest},claim));
 value(await rpc(f,modern,'process_initial_history',{requestId:'skip',decisions:Array.from({length:10},(_,i)=>({itemId:`item-${i}`,action:'skip',reason:'not_memorable'}))},claim));
 value(await rpc(f,modern,'complete_context',{requestId:'done'},claim));
 const response=await fetchWorker(`/harness/v1/binding?threadId=${claim.id}`,{headers:{authorization:`Bearer ${f.h.token}`}});
 const {binding}=await response.json() as {binding:ThreadBinding};
 const measured=await runInDurableObject(env.MEMORY.getByName(f.m.name),async(obj,state)=>{
  const {Db}=await import('../src/store/db'); const {Activations}=await import('../src/store/activation');
  const db=new Db(state.storage.sql), activations=new Activations(db,state.storage,obj.store,obj.service,new Map());
  activations.readySession(binding); const cold=db.usage(); db.resetUsage();
  activations.readySession(binding); const warm=db.usage();
  db.run("UPDATE activations SET record=json_set(record,'$.completed',json('false'))");
  let rejected=false; try {activations.readySession(binding)} catch {rejected=true}
  return {cold,warm,rejected};
 });
 expect(measured.warm.rowsRead).toBeLessThan(measured.cold.rowsRead/2); expect(measured.warm.rowsWritten).toBe(0); expect(measured.rejected).toBe(true);
});
