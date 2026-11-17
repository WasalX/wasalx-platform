// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
import assert from 'node:assert/strict';
export async function verifyTransitionOwnerPage(page,m){
 assert(new URL(page.url()).origin===m.origin,'Owned browser origin changed');
 const result=await page.evaluate(async({ownerId,tenantId})=>{
  const r=await fetch('/api/workspaces',{cache:'no-store',signal:AbortSignal.timeout(20000)});
  if(r.status!==200)return{userMatched:false,workspaceMatched:false};const rows=(await r.json()).data;
  const h=await fetch('/app',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000)});
  if(!h.ok||new URL(h.url).pathname!=='/app')throw Error('Actor page unavailable');
  const doc=new DOMParser().parseFromString(await h.text(),'text/html');
  const prefix='((self[Symbol.for("vinext.navigationRuntime")]??={bootstrap:{routeManifest:null},functions:{}}).bootstrap.rsc??={rsc:[]}).rsc.push(';
  const chunks=[...doc.scripts].map(s=>s.textContent).filter(s=>s.startsWith(prefix)).map(s=>JSON.parse(s.slice(prefix.length,-1)));
  const bytes=chunks.map(c=>typeof c==='string'?new TextEncoder().encode(c):Array.isArray(c)&&c[0]===3?Uint8Array.from(atob(c[1]),x=>x.charCodeAt(0)):(()=>{throw Error('Actor page chunk unavailable');})());
  const joined=new Uint8Array(bytes.reduce((n,b)=>n+b.length,0));let offset=0;for(const b of bytes){joined.set(b,offset);offset+=b.length;}
  const text=new TextDecoder('utf-8',{fatal:true}).decode(joined);
  return{userMatched:text.includes(`"userId":"${ownerId}"`),workspaceMatched:rows.some(v=>v.id===tenantId&&v.current&&v.role==='tenant_owner')};
 },{ownerId:m.ownerId,tenantId:m.tenantId});
 assert(result.userMatched===true&&result.workspaceMatched===true,'Current owner/workspace mismatch');
}
