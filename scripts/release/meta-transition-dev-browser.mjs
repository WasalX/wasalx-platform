// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// Actual tenant controls + protected operator requests. Synthetic SDK/provider only.
import {requireTransition as need} from "./meta-transition-dev-contract.mjs";
export async function fixedPageRequest(page,origin,path){
 need(/^\/api\/platform-console\/operations\/tenants\/[0-9a-f-]{36}\/meta\/account-transitions\/[0-9a-f-]{36}\/review$/iu.test(path)&&new URL(page.url()).origin===origin,'PLATFORM_REQUEST_SCOPE');
 return page.evaluate(async({origin,path})=>{const r=await fetch(path,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000),headers:{accept:'application/json'}});if(r.url!==origin+path||!r.ok)throw Error('P09 operator read unavailable');const text=await r.text();if(text.length>65536)throw Error('P09 operator response too large');return JSON.parse(text);},{origin,path});
}

export async function originalResponse(wait,request,reason){const response=await wait;need(response?.ok()&&response.request()===request,reason);return response;}
