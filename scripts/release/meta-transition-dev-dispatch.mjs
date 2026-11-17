// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// One stable P09 handler per finite path. No transport or automatic retry.
import assert from 'node:assert/strict';
const owned=new WeakMap();
const fail=()=>Error('P09 command uncertain or not dispatched; preserve original intent; no replay');
async function bounded(work,ms){let timer;try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail()),ms);})]);}finally{clearTimeout(timer);}}
export async function dispatchWithinLease({page,origin,path,lease,ready,dispatch,confirm}){
 assert(page&&[lease,ready,dispatch,confirm].every(f=>typeof f==='function'));
 assert(new URL(origin).origin===origin&&/^\/api\//u.test(path)&&!/[?#]/u.test(path)&&new URL(page.url()).origin===origin);
 let paths=owned.get(page);if(!paths){paths=new Map();owned.set(page,paths);}assert(paths.size<16||paths.has(path),'P09 route inventory bound');
 let slot=paths.get(path);
 assert(!slot||slot.origin===origin,'Protected path origin cannot change');
 assert(!slot||slot.active?.state==='CONFIRMED','Unconfirmed original command cannot be replaced');
 const record={state:'PREPARING',cancelled:false,armed:false,claimed:false,sent:false,request:null};
 let complete,rejectComplete;record.handled=new Promise((resolve,reject)=>{complete=resolve;rejectComplete=reject;});record.handled.catch(()=>{});
 const current=()=>assert(!record.cancelled&&slot.active===record&&['PREPARING','DISPATCHED'].includes(record.state)&&new URL(page.url()).origin===origin);
 const admission=async minimum=>{current();const a=await lease();current();assert(Number.isFinite(Date.parse(a?.validUntil))&&Date.parse(a.validUntil)-Date.now()>=minimum,'P09 mutation lease expired');};
 if(!slot){
  slot={origin,active:record,paused:new Set(),tasks:new Set(),registered:false};
  slot.match=url=>url.origin===origin&&url.pathname===path&&url.search==='';
  slot.handler=route=>{const observed=slot.active;const task=(async()=>{
   if(route.request().method()!=='POST'){await route.continue();return;}
   slot.paused.add(route);
   try{
    // PREPARING remains closed during all successor readiness and lease waits.
    assert(observed===slot.active&&!observed.cancelled&&observed.state==='PREPARING'&&observed.armed&&!observed.claimed);
    observed.claimed=true;const a=await observed.lease();
    assert(observed===slot.active&&!observed.cancelled&&observed.state==='PREPARING'&&new URL(page.url()).origin===origin&&Date.parse(a?.validUntil)-Date.now()>=10000);
    observed.request=route.request();observed.sent=true;
    // No deferred callback or handler replacement between guard and continue.
    await route.continue();assert(observed===slot.active&&!observed.cancelled);observed.state='DISPATCHED';observed.complete();
   }catch{observed.cancelled=true;observed.state='UNCERTAIN';observed.rejectComplete(fail());await bounded(()=>route.abort('aborted'),500).catch(()=>{});
   }finally{slot.paused.delete(route);}
  })();slot.tasks.add(task);task.finally(()=>slot.tasks.delete(task)).catch(()=>{});return task;};
  paths.set(path,slot);
 }else slot.active=record;
 record.lease=lease;record.complete=complete;record.rejectComplete=rejectComplete;
 try{
  await bounded(async()=>{
   if(!slot.registered){await page.route(slot.match,slot.handler);slot.registered=true;}
   await admission(15000);await ready();await admission(15000);
   await bounded(()=>{current();record.armed=true;return dispatch();},1500);await record.handled;
  },6000);
  current();assert(record.sent&&record.state==='DISPATCHED');
  // Caller validates the real original response AND required correlated
  // readback here, before the same path can ever be used again.
  const result=await bounded(()=>{current();return confirm(record.request);},90000);
  current();assert(result?.confirmed===true&&typeof result.reusable==='boolean');
  record.state=result.reusable?'CONFIRMED':'SEALED';record.request=null;return result.value;
 }catch{record.cancelled=true;record.state='UNCERTAIN';record.request=null;await bounded(async()=>{await Promise.allSettled([...slot.paused].map(r=>r.abort('aborted')));await Promise.allSettled([...slot.tasks]);},500).catch(()=>{});throw fail();}
 // No unroute/register handover: this same handler protects the path throughout
 // CONFIRMED -> PREPARING -> DISPATCHED -> CONFIRMED/SEALED/UNCERTAIN.
}
// Root only, after Page UI actions are proven quiescent. Never called as an
// uncertain-command recovery. Only this finite route inventory is removed.
export async function releaseTransitionDispatchFences(page){
 const paths=owned.get(page);if(!paths)return;
 for(const slot of paths.values())slot.active.cancelled=true;
 await bounded(async()=>{await Promise.allSettled([...paths.values()].flatMap(s=>[...s.paused].map(r=>r.abort('aborted'))));await Promise.all([...paths.values()].map(s=>page.unroute(s.match,s.handler)));},500);
 owned.delete(page);
}
