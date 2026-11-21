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
async function rpc(f:Awaited<ReturnType<typeof fixture>>, protocol:string, name:string, args:Record<string,unknown>, claim?:Meta, token=f.h.token, recovery: string | null = name === 'restore_context' ? String(args.requestId) : null) {
 const params:Record<string,unknown>={name,arguments:args}; if(claim) params._meta={'io.ziwo/conversation':claim,...(recovery === null ? {} : {'io.ziwo/recovery':{requestId:recovery}}),...(protocol===modern?{'io.modelcontextprotocol/protocolVersion':modern,'io.modelcontextprotocol/clientInfo':{name:'test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}:{})};
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
async function restored(f:Awaited<ReturnType<typeof fixture>>) {
 const backup=await (await admin(`/admin/memories/${f.m.name}/export`,undefined,'GET')).text();
 const {freshName}=await import('./mcp-helpers');const name=freshName();expect((await fetchWorker(`/admin/memories/${name}/import`,{method:'POST',headers:{authorization:`Bearer ${adminSecret}`},body:backup})).status).toBe(201);
 const info=await (await admin(`/admin/memories/${name}/identity`,undefined,'GET')).json() as {identity:{id:string};instance:string};return {...f,m:{name,token:''},target:{identityId:info.identity.id,instance:info.instance,memory:name}};
}
describe.each([legacy,modern])('trusted MCP recovery %s',protocol=>{
 it('requires precise private authorization, preserves gaps, and rejects stale replay',async()=>{
  const f=await fixture(),a=meta('recover');a.history={cutoff:null,coverage:'partial',gaps:[{id:'gap',from:null,to:null,reason:'unavailable'}],items:[]};
  const p=value(await rpc(f,protocol,'activate_context',{},a)).persona;value(await rpc(f,protocol,'initialize_context',{personaVersion:p.version,personaDigest:p.digest},a));value(await rpc(f,protocol,'complete_context',{requestId:'done'},a));const old=value(await rpc(f,protocol,'refresh_context',{},a));
  const dest=await restored(f),previousInstance=old.identity.instance;const grant={requestId:'restore-1',threadId:a.id,createdAt:a.createdAt,parentThreadId:null,identityId:dest.target.identityId,memory:dest.m.name,instance:dest.target.instance,previousInstance};
  failed(await rpc(dest,protocol,'restore_context',{requestId:grant.requestId},a));
  const path=`/admin/harnesses/${f.h.id}/restores`;expect((await admin(path,grant)).status).toBe(200);
  expect((await admin(path,{...grant,memory:'different'})).status).toBe(409);
  failed(await rpc(dest,protocol,'restore_context',{requestId:grant.requestId},a,f.h.token,null));
  failed(await rpc(dest,protocol,'restore_context',{requestId:grant.requestId},a,f.h.token,'mismatch'));
  failed(await rpc(dest,protocol,'restore_context',{requestId:grant.requestId,_meta:{'io.ziwo/recovery':{requestId:grant.requestId}}},a,f.h.token,null));
  expect(value(await rpc(f,protocol,'resume_context',{},a)).identity.instance).toBe(previousInstance);

  const other=await fixture();failed(await rpc({...dest,h:other.h},protocol,'restore_context',{requestId:grant.requestId},a));
  failed(await rpc(dest,protocol,'restore_context',{requestId:grant.requestId},{...a,id:'other'}));failed(await rpc(dest,protocol,'restore_context',{requestId:grant.requestId},{...a,temporary:true}));failed(await rpc(dest,protocol,'restore_context',{requestId:grant.requestId},{...a,parentId:'forged'}));
  const result=value(await rpc(dest,protocol,'restore_context',{requestId:grant.requestId},a));expect(result.reassociation).toMatchObject({requestId:grant.requestId,from:{instance:previousInstance},to:dest.target});
  expect(value(await rpc(dest,protocol,'restore_context',{requestId:grant.requestId},a)).reassociation).toEqual(result.reassociation);
  failed(await rpc(dest,protocol,'refresh_context',{cursor:old.cursor},a));
  const loaded=result.persona;value(await rpc(dest,protocol,'acknowledge_persona',{personaVersion:loaded.version,personaDigest:loaded.digest},a));
  const resumed=value(await rpc(dest,protocol,'resume_context',{},a));expect(resumed.activation.historyIncomplete).toBe(true);
  const fresh=value(await rpc(dest,protocol,'refresh_context',{reload:true}, {...a,turn:'turn-2'}));expect(fresh.identity.instance).toBe(dest.target.instance);
  const again=await restored(dest),grant2={...grant,requestId:'restore-2',memory:again.m.name,instance:again.target.instance,previousInstance:dest.target.instance};expect((await admin(path,grant2)).status).toBe(200);value(await rpc(again,protocol,'restore_context',{requestId:grant2.requestId},a));
  failed(await rpc(dest,protocol,'restore_context',{requestId:grant.requestId},a));
 });
 it('revokes an unused authorization without allowing another subject',async()=>{
  const f=await fixture(),a=meta('revoke');await initialize(f,protocol,a);const dest=await restored(f);const prior=await (await admin(`/admin/memories/${f.m.name}/identity`,undefined,'GET')).json() as {instance:string};
  const grant={requestId:'revoke-1',threadId:a.id,createdAt:a.createdAt,parentThreadId:null,...dest.target,previousInstance:prior.instance},path=`/admin/harnesses/${f.h.id}/restores`;
  expect((await admin(path,grant)).status).toBe(200);expect((await admin(`${path}/${grant.requestId}`,undefined,'DELETE')).status).toBe(200);failed(await rpc(dest,protocol,'restore_context',{requestId:grant.requestId},a));
  const alien=await fixture();expect((await admin(path,{...grant,requestId:'alien',identityId:(await (await admin(`/admin/memories/${alien.m.name}/identity`,undefined,'GET')).json() as {identity:{id:string}}).identity.id})).status).toBe(409);
 });
});
it('revocation after consumption blocks replay without undoing the binding',async()=>{
 const f=await fixture(),a=meta('revoked-consumed');await initialize(f,modern,a);const old=await (await admin(`/admin/memories/${f.m.name}/identity`,undefined,'GET')).json() as {instance:string};const dest=await restored(f);
 const grant={requestId:'after-consume',threadId:a.id,createdAt:a.createdAt,parentThreadId:null,...dest.target,previousInstance:old.instance},path=`/admin/harnesses/${f.h.id}/restores`;
 expect((await admin(path,grant)).status).toBe(200);const applied=value(await rpc(dest,modern,'restore_context',{requestId:grant.requestId},a));expect(applied.reassociation.to.instance).toBe(dest.target.instance);
 expect((await admin(`${path}/${grant.requestId}`,undefined,'DELETE')).status).toBe(200);failed(await rpc(dest,modern,'restore_context',{requestId:grant.requestId},a));
 const current=value(await rpc(dest,modern,'resume_context',{},a));expect(current.identity.instance).toBe(dest.target.instance);failed(await rpc(f,modern,'resume_context',{},a));
});
