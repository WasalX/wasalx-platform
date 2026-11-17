import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {readBoundedBody,BoundedBodyError} from '../lib/bounded-json.ts';
import {platformBinaryRequest} from '../lib/platform-client.ts';
import {allowedPlatformProxyRoute} from '../lib/platform-proxy-routes.ts';

// Unit-only session-store substitute: exercise the actual shared auth boundary
// without a Redis connection or claiming installed-session qualification.
const hook=registerHooks({resolve(specifier,context,nextResolve){
 if(specifier==='./platform-portal-session-store.ts'&&context.parentURL?.includes('/lib/platform-request-auth.ts'))
  return{url:'data:text/javascript,export async function loadStoredPlatformSession(){return {csrfToken:"synthetic-platform-csrf",accessToken:"synthetic-access"}}',shortCircuit:true};
 return nextResolve(specifier,context);
}});
const auth=await import('../lib/platform-request-auth.ts').finally(()=>hook.deregister());
const tenant='31000000-0000-4000-8000-000000000001',id='31000000-0000-4000-8000-000000000003';
const path=`meta-costs/tenants/${tenant}/statements/${id}/source`;

test('binary admission extends only source MIME while preserving session, origin, CSRF and tenant-context checks',async()=>{
 const names=['PORTAL_DATA_BACKEND','PORTAL_COOKIE_SECURE','PORTAL_PUBLIC_ORIGIN'] as const;
 const before=new Map(names.map(name=>[name,process.env[name]]));
 process.env.PORTAL_DATA_BACKEND='control-plane';process.env.PORTAL_COOKIE_SECURE='false';process.env.PORTAL_PUBLIC_ORIGIN='https://portal.example';
 const headers={cookie:'wasalx_platform_session='+'s'.repeat(43),origin:'https://portal.example','content-type':'application/pdf','x-wasalx-platform-csrf':'synthetic-platform-csrf'};
 const request=(changes:Record<string,string>={})=>new Request(`https://portal.example/api/platform-console/${path}`,{method:'PUT',headers:{...headers,...changes}});
 try{
  for(const mime of ['application/pdf','text/csv','application/json'])assert.equal((await auth.authenticatePlatformCostSourceRequest(request({'content-type':mime}))).accessToken,'synthetic-access');
  await assert.rejects(()=>auth.authenticatePlatformPortalRequest(request()),error=>error instanceof Error&&'status' in error&&error.status===403);
  const deniedHeaders:Record<string,string>[]=[{origin:'https://other.example'},{'x-wasalx-platform-csrf':'bad'},{'content-type':'text/html'}];
  for(const changes of deniedHeaders)
   await assert.rejects(()=>auth.authenticatePlatformCostSourceRequest(request(changes)),error=>error instanceof Error&&'status' in error&&error.status===403);
  const missingSessionHeaders:Record<string,string>[]=[{cookie:''},{'x-wasalx-tenant-id':tenant}];
  for(const changes of missingSessionHeaders)await assert.rejects(()=>auth.authenticatePlatformCostSourceRequest(request(changes)),error=>error instanceof Error&&'status' in error&&error.status===401);
 }finally{for(const name of names){const value=before.get(name);if(value===undefined)delete process.env[name];else process.env[name]=value;}}
});

test('source binary client uses its finite path and shared safe 401 continuation',async()=>{
 const previousFetch=globalThis.fetch,previousWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),redirects:string[]=[],calls:RequestInit[]=[];
 let expired=false;
 globalThis.fetch=async(_url,init)=>{calls.push(init!);return new Response(expired?'PRIVATE_DETAIL':'original',{status:expired?401:200});};
 Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{pathname:'/platform',search:'?tenant=selected',hash:'#costs',assign:(url:string)=>redirects.push(url)}}});
 try{
  await platformBinaryRequest({csrfToken:'synthetic-platform-csrf'},path,{method:'PUT',mimeType:'application/pdf',body:new Uint8Array([1]).buffer});
  assert.equal(new Headers(calls[0]!.headers).get('x-wasalx-platform-csrf'),'synthetic-platform-csrf');assert.equal(calls[0]!.redirect,'error');assert.equal(calls[0]!.cache,'no-store');
  await assert.rejects(()=>platformBinaryRequest({csrfToken:'x'},'tenants/other/source'));assert.equal(calls.length,1);
  expired=true;await assert.rejects(()=>platformBinaryRequest({csrfToken:'x'},path),error=>error instanceof Error&&error.message==='platform_request_failed'&&'status' in error&&error.status===401);
  assert.deepEqual(redirects,['/platform/auth/login?return_to=%2Fplatform%3Ftenant%3Dselected%23costs']);
 }finally{globalThis.fetch=previousFetch;if(previousWindow)Object.defineProperty(globalThis,'window',previousWindow);else Reflect.deleteProperty(globalThis,'window');}
});

test('generic platform proxy cannot mint source authority or expose arbitrary statement actions',()=>{
 for(const action of ['review','preview','publish','reconcile-source','privacy-review'])assert.equal(allowedPlatformProxyRoute('POST',`meta-costs/tenants/${tenant}/statements/${id}/${action}`),true);
 for(const action of ['source-access','source','charge','delete','settle'])for(const method of ['GET','POST','PUT','DELETE'])
  assert.equal(allowedPlatformProxyRoute(method,`meta-costs/tenants/${tenant}/statements/${id}/${action}`),false);
});

test('shared binary body reader enforces complete size and total deadline while releasing cancelled streams',async()=>{
 const stream=(chunks:Uint8Array<ArrayBuffer>[],stall=false,onCancel=()=>{})=>new ReadableStream<Uint8Array<ArrayBuffer>>({start(controller){for(const chunk of chunks)controller.enqueue(chunk);if(!stall)controller.close();},cancel:onCancel});
 const exact=stream([new Uint8Array([1,2]),new Uint8Array([3])]);assert.deepEqual(await readBoundedBody({body:exact},3,100,3),new Uint8Array([1,2,3]));assert.equal(exact.locked,false);
 for(const [chunks,expected,status] of [[[new Uint8Array([1])],2,400],[[new Uint8Array([1,2,3])],2,413]] as const){
  const body=stream([...chunks]);await assert.rejects(()=>readBoundedBody({body},3,100,expected),error=>error instanceof BoundedBodyError&&error.status===status);assert.equal(body.locked,false);
 }
 let cancelled=false;const stalled=stream([new Uint8Array([1])],true,()=>{cancelled=true;});
 await assert.rejects(()=>readBoundedBody({body:stalled},3,25,2),error=>error instanceof BoundedBodyError&&error.status===408);assert.equal(cancelled,true);assert.equal(stalled.locked,false);
});

// Import the actual BFF route. Only Node's extension resolution and the existing
// session-store substitute above differ from the portal runtime.
const routeHook=registerHooks({resolve(specifier,context,nextResolve){
 if(context.parentURL&&decodeURIComponent(context.parentURL).endsWith('/app/api/platform-console/[...path]/route.ts')&&specifier.startsWith('../../../../lib/')&&!specifier.endsWith('.ts'))
  return nextResolve(new URL(`${specifier}.ts`,context.parentURL).href,context);
 return nextResolve(specifier,context);
}});
const platformRoute=await import('../app/api/platform-console/[...path]/route.ts').finally(()=>routeHook.deregister());

test('actual BFF keeps post-forward uncertainty distinct from rejected inbound bodies',async()=>{
 const names=['PORTAL_DATA_BACKEND','PORTAL_COOKIE_SECURE','PORTAL_PUBLIC_ORIGIN','CONTROL_API_URL'] as const;
 const saved=new Map(names.map(name=>[name,process.env[name]])),previousFetch=globalThis.fetch;
 Object.assign(process.env,{PORTAL_DATA_BACKEND:'control-plane',PORTAL_COOKIE_SECURE:'false',PORTAL_PUBLIC_ORIGIN:'https://portal.example',CONTROL_API_URL:'https://control.example'});
 const mutationPath=`meta-costs/tenants/${tenant}/statements/${id}/publish`,key='31000000-0000-4000-8000-000000000009';
 const headers={cookie:'wasalx_platform_session='+'s'.repeat(43),origin:'https://portal.example','content-type':'application/json','x-wasalx-platform-csrf':'synthetic-platform-csrf','idempotency-key':key};
 const body=JSON.stringify({expectedVersion:3,expectedPreviewSha256:'a'.repeat(64)});
 const calls:Array<{url:string;body:unknown;key:string|null}>=[];
 let respond:()=>Response=()=>Response.json({duplicate:false});
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),body:init?.body,key:new Headers(init?.headers).get('idempotency-key')});return respond();};
 const invoke=(bytes:BodyInit|null)=>platformRoute.POST(new Request(`https://portal.example/api/platform-console/${mutationPath}`,{method:'POST',headers,body:bytes}),{params:Promise.resolve({path:mutationPath.split('/')})});
 try{
  for(const [bytes,status] of [[null,400],[new Uint8Array([0xff]),400],['x'.repeat(524_289),413]] as const){
   const response=await invoke(bytes);assert.equal(response.status,status);assert.equal(calls.length,0);
  }
  // An upstream may have committed before its body becomes unreadable. These
  // are transport doubles, not proof of a database commit or installed BFF.
  const privateMarker='PRIVATE_UPSTREAM_BODY_MUST_NOT_ESCAPE';
  for(const responseFactory of [
   ()=>new Response(new Uint8Array(10_485_761)),
   ()=>new Response(new ReadableStream({start(controller){controller.error(new Error(privateMarker));}})),
   ()=>new Response(new Uint8Array([0xff])),
  ]){
   respond=responseFactory;const before=calls.length,response=await invoke(body);
   assert.equal(response.status,502);assert.equal(response.headers.get('cache-control'),'no-store');
   assert.equal(calls.length,before+1);assert.deepEqual(calls.at(-1),{url:`https://control.example/platform/v1/${mutationPath}`,body,key});
   assert.doesNotMatch(await response.text(),new RegExp(privateMarker));
  }
  respond=()=>Response.json({id,duplicate:true,state:'PUBLISHED'});
  const result=await invoke(body);assert.equal(result.status,200);const payload:unknown=await result.json();
  assert.ok(payload!==null&&typeof payload==='object'&&'duplicate' in payload);assert.equal(payload.duplicate,true);
  assert.equal(calls.at(-1)?.body,body);assert.equal(calls.at(-1)?.key,key);
  respond=()=>Response.json({error:'known validation rejection'},{status:409});
  assert.equal((await invoke(body)).status,409,'complete authoritative rejection retains its status');
 }finally{globalThis.fetch=previousFetch;for(const name of names){const value=saved.get(name);if(value===undefined)delete process.env[name];else process.env[name]=value;}}
});
