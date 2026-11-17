import assert from "node:assert/strict";
import test from "node:test";
import { allowedPlatformProxyRoute } from "../lib/platform-proxy-routes.ts";
import { platformRequest } from "../lib/platform-client.ts";

const tenant="31000000-0000-4000-8000-000000000001",item="31000000-0000-4000-8000-000000000002";
test("platform cost routes expose only the reviewed read, export, draft, activate and bounded reassess actions",()=>{
  for(const suffix of ["", "/export"])assert.equal(allowedPlatformProxyRoute("GET",`meta-costs/tenants/${tenant}${suffix}`),true);
  for(const suffix of ["/tariffs",`/tariffs/${item}/activate`,`/accounts/${item}/reassess`])assert.equal(allowedPlatformProxyRoute("POST",`meta-costs/tenants/${tenant}${suffix}`),true);
  for(const path of [`meta-costs/tenants/${tenant}/settle`,`meta-costs/tenants/${tenant}/charge`,`meta-costs/tenants/${tenant}/tariffs/${item}/delete`,`meta-costs/tenants/${tenant}/../../other`])
    for(const method of ["GET","POST","PUT","DELETE"])assert.equal(allowedPlatformProxyRoute(method,path),false);
});

test("shared platform request retains platform CSRF, immutable replay body/key and bounded error status",async()=>{
  const original=globalThis.fetch;const calls:Array<{url:string;init:RequestInit}>=[];let rejected=false;
  globalThis.fetch=async(input,init)=>{calls.push({url:String(input),init:init!});return Response.json(rejected?{message:"private evidence"}:{ok:true},{status:rejected?409:200});};
  try{
    const options={method:"POST",body:{definition:{currency:"USD"}},idempotencyKey:"same-intent"};
    await platformRequest({csrfToken:"synthetic-platform-csrf"},`meta-costs/tenants/${tenant}/tariffs`,options);
    await platformRequest({csrfToken:"synthetic-platform-csrf"},`meta-costs/tenants/${tenant}/tariffs`,options);
    assert.equal(calls[0]!.init.body,calls[1]!.init.body);
    const headers=new Headers(calls[0]!.init.headers);assert.equal(headers.get("x-wasalx-platform-csrf"),"synthetic-platform-csrf");assert.equal(headers.get("idempotency-key"),"same-intent");assert.equal(headers.has("x-wasalx-tenant-id"),false);
    rejected=true;await assert.rejects(()=>platformRequest({csrfToken:"synthetic-platform-csrf"},"operations/overview"),(error:unknown)=>error instanceof Error&&"status" in error&&error.status===409&&!error.message.includes("private evidence"));
  }finally{globalThis.fetch=original;}
});

test("expired platform session preserves the encoded pathname, query and fragment without reflecting server detail",async()=>{
  const originalFetch=globalThis.fetch,originalWindow=Object.getOwnPropertyDescriptor(globalThis,"window"),redirects:string[]=[];
  Object.defineProperty(globalThis,"window",{configurable:true,value:{location:{pathname:"/platform",search:"?state=active&query=Riyadh",hash:"#tenants",assign:(url:string)=>redirects.push(url)}}});
  globalThis.fetch=async()=>Response.json({message:"private authentication detail"},{status:401});
  try{
    await assert.rejects(()=>platformRequest({csrfToken:"synthetic-platform-csrf"},"operations/overview"),(error:unknown)=>error instanceof Error&&"status" in error&&error.status===401&&!error.message.includes("private authentication detail"));
    assert.deepEqual(redirects,["/platform/auth/login?return_to=%2Fplatform%3Fstate%3Dactive%26query%3DRiyadh%23tenants"]);
  }finally{
    globalThis.fetch=originalFetch;
    if(originalWindow)Object.defineProperty(globalThis,"window",originalWindow);else Reflect.deleteProperty(globalThis,"window");
  }
});
