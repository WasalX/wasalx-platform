// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// Finite privacy-only stable route fences. Existing relay owns durable claims.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const owned=new WeakMap(),sha=b=>createHash('sha256').update(b).digest('hex');
const fail=()=>Error('P11 original mutation unsettled; retain claim/fence; no replay');
async function bounded(task,ms){let timer;try{return await Promise.race([Promise.resolve().then(task),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail()),ms);})]);}finally{clearTimeout(timer);}}
export async function dispatchPrivacyOnce({page,origin,path,action,scopeSha256,caseId,authorize,claim,checkpoint,ready,dispatch,validateRequest,confirm}){
 assert([authorize,claim,checkpoint,ready,dispatch,validateRequest,confirm].every(f=>typeof f==='function'));
 assert(new URL(page.url()).origin===origin&&new URL(origin).origin===origin&&/^\/api\/(privacy\/requests(?:\/[0-9a-f-]{36}\/retry)?|connections\/[0-9a-f-]{36}\/disconnect)$/iu.test(path));
 assert(/^[a-f0-9]{64}$/u.test(scopeSha256)&&['EXPORT','DELETE','DELETE_RETRY','DISCONNECT'].includes(action)&&typeof caseId==='string'&&/^[A-Za-z0-9_-]{1,80}$/u.test(caseId));
 let slots=owned.get(page);if(!slots){slots=new Map();owned.set(page,slots);}assert(slots.size<8||slots.has(path));let slot=slots.get(path);
 assert(!slot||slot.origin===origin&&slot.active.state==='CONFIRMED','Unconfirmed path cannot be replaced');
 const record={state:'PREPARING',armed:false,claimed:false,cancelled:false,request:null};let resolve,reject;record.handled=new Promise((a,b)=>{resolve=a;reject=b;});record.handled.catch(()=>{});
 if(!slot){slot={origin,active:record,registered:false};slot.match=url=>url.origin===origin&&url.pathname===path&&url.search==='';
  slot.handler=async route=>{if(route.request().method()!=='POST')return route.continue();const r=slot.active;try{
   assert(r===slot.active&&!r.cancelled&&r.state==='PREPARING'&&r.armed&&!r.claimed);r.claimed=true;
   await r.authorize();assert(r===slot.active&&!r.cancelled&&r.state==='PREPARING'&&new URL(page.url()).origin===origin);
   const request=route.request(),key=request.headers()['idempotency-key'];assert(typeof key==='string'&&key.length>=1&&key.length<=255);r.validateRequest(request.postDataJSON());
   await r.checkpoint({phase:'privacy-original-intent',case:r.caseId,action:r.action,idempotencyKey:key,bodySha256:sha(request.postData()),scopeSha256:r.scopeSha256});
   assert(r===slot.active&&!r.cancelled&&r.state==='PREPARING');r.request=request;r.state='DISPATCHED';await route.continue();r.resolve();
  }catch{r.cancelled=true;r.state='UNKNOWN';r.reject(fail());await route.abort('failed').catch(()=>{});}};slots.set(path,slot);
 }else slot.active=record;
 // Handler callbacks use only the current record, never a successor's closures.
 Object.assign(record,{authorize,checkpoint,validateRequest,caseId,action,scopeSha256,resolve,reject});
 // Resolve/reject are record-specific even when the same stable handler is reused.
 if(!slot.registered){await page.route(slot.match,slot.handler);slot.registered=true;}
 try{
  await bounded(async()=>{await authorize();const receipt=await claim({action,caseId,scopeSha256});assert(receipt?.claimed===true&&receipt.action===action&&receipt.caseId===caseId&&receipt.scopeSha256===scopeSha256);assert(!record.cancelled&&slot.active===record);await ready();await authorize();assert(!record.cancelled&&slot.active===record);record.armed=true;await dispatch();await record.handled;},15000);
  assert(slot.active===record&&!record.cancelled&&record.state==='DISPATCHED');const result=await bounded(()=>confirm(record.request),120000);assert(result?.confirmed===true);assert(slot.active===record&&!record.cancelled);record.state='CONFIRMED';record.request=null;return result.value;
 }catch{record.cancelled=true;record.state='UNKNOWN';record.request=null;throw fail();}
 // Deliberately no unroute: malformed/lost response and manual second clicks stay fenced.
}
export async function releasePrivacyOutcomeFences(page,quiescent){assert(typeof quiescent==='function'&&await quiescent()===true);const slots=owned.get(page);if(!slots)return;for(const slot of slots.values())slot.active.cancelled=true;for(const slot of slots.values())await page.unroute(slot.match,slot.handler);owned.delete(page);}
