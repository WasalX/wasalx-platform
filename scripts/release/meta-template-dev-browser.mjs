// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// Actual installed portal/BFF/API/worker requests. No route.fulfill, fake API or SDK.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {need,sha,uuid,validateTemplateManifest,assertTemplateSetup,assertOriginalTemplateCopy,assertTemplateHistory,assertTemplateIntent} from './meta-template-dev-contract.mjs';
export async function verifyTemplateActor(page,m){
 need(new URL(page.url()).origin===m.origin,'BROWSER_ORIGIN');const p=m.p05b;
 const result=await page.evaluate(async({actorId,tenantId,role})=>{
  const r=await fetch('/api/workspaces',{cache:'no-store',signal:AbortSignal.timeout(15000)});if(!r.ok)return false;
  const rows=(await r.json()).data,h=await fetch('/app',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});if(!h.ok||new URL(h.url).pathname!=='/app')return false;
  const doc=new DOMParser().parseFromString(await h.text(),'text/html');
  const prefix='((self[Symbol.for("vinext.navigationRuntime")]??={bootstrap:{routeManifest:null},functions:{}}).bootstrap.rsc??={rsc:[]}).rsc.push(';
  const chunks=[...doc.scripts].map(s=>s.textContent).filter(s=>s.startsWith(prefix)).map(s=>JSON.parse(s.slice(prefix.length,-1)));
  const parts=chunks.map(c=>typeof c==='string'?new TextEncoder().encode(c):Array.isArray(c)&&c[0]===3?Uint8Array.from(atob(c[1]),x=>x.charCodeAt(0)):(()=>{throw Error('Actor proof unavailable');})());
  const b=new Uint8Array(parts.reduce((n,v)=>n+v.length,0));let offset=0;for(const part of parts){b.set(part,offset);offset+=part.length;}
  return new TextDecoder('utf8',{fatal:true}).decode(b).includes(`"userId":"${actorId}"`)&&rows.some(v=>v.id===tenantId&&v.current&&v.role===role);
 },{actorId:p.actorId,tenantId:m.tenantId,role:p.role});need(result===true,'ACTOR_WORKSPACE_ROLE');
}
async function readView(page,m,planId){
 return page.evaluate(async({base,actor,tenant,planId})=>{
  const r=await fetch(base+(planId?'/'+planId:''),{cache:'no-store',headers:{'x-wasalx-template-actor':encodeURIComponent(actor),'x-wasalx-template-workspace':encodeURIComponent(tenant)},signal:AbortSignal.timeout(15000)});
  if(r.status!==200)throw Error('Template read unavailable');return r.json();
 },{base:'/api/connections/'+m.p05b.sourceConnectionId+'/meta/template-preparations',actor:m.p05b.actorId,tenant:m.tenantId,planId});
}
// One intercepted original request; response is obtained from the actual BFF before loss.
// The handler is exact-path, request-time actor/lease bound, finite and removed in finally.
export async function withTemplateResponseLoss({page,m,suffix,guard,beforeDispatch,click,settled}){
 const url=m.origin+'/api/connections/'+m.p05b.sourceConnectionId+'/meta/template-preparations'+suffix;
 let captured=null,used=false,task=null,signal;const fired=new Promise(r=>{signal=r;});
 const handler=route=>{task=(async()=>{
  const req=route.request();need(!used&&req.method()==='POST'&&req.url()===url,'LOSS_ROUTE');used=true;
  const key=req.headers()['idempotency-key'],body=req.postDataJSON();need(uuid(key)&&body&&typeof body==='object','ORIGINAL_INTENT');
  captured={key,body,action:suffix.split('/').at(-1)?.toUpperCase()||'CREATE'};
  await guard();if(beforeDispatch)await beforeDispatch(captured);
  await guard();const response=await route.fetch({maxRedirects:0,maxRetries:0,timeout:15000});
  need(response.status()>=200&&response.status()<300,'ACTUAL_BFF_COMMIT_RESPONSE');
  await settled(captured);await route.abort('failed');
 })().catch(async error=>{await route.abort('failed').catch(()=>{});throw error;});void task.catch(()=>{});signal();return task;};
 await page.route(url,handler);
 try{await click();let timer;try{await Promise.race([fired,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('P05B request capture deadline')),15000);})]);}finally{clearTimeout(timer);}need(task!==null,'ORIGINAL_REQUEST_CAPTURE');await task;need(used,'ONE_RESPONSE_LOSS');return captured;}
 finally{await page.unroute(url,handler);if(task)await task.catch(()=>{});}
}
