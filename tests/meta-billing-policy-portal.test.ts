import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {registerHooks} from 'node:module';
// The route/auth/CSRF/parser under test are imported, never route-intercepted.
// Only the session store and downstream transport are doubled.
const fixture=globalThis as typeof globalThis&{billingSession?:{userId:string;tenantId:string;role:string;csrfToken:string};billingCalls?:unknown[][];billingFailure?:number;billingMalformed?:boolean};
const hooks=registerHooks({resolve(specifier,context,nextResolve){
 if(specifier==='./portal-session-store.ts'&&context.parentURL?.endsWith('/lib/portal-session.ts'))return{url:'data:text/javascript,export async function loadStoredPortalSession(){return globalThis.billingSession}',shortCircuit:true};
 if(context.parentURL&&decodeURIComponent(context.parentURL).endsWith('/meta/billing-policy/route.ts')){
  if(specifier.endsWith('/control-plane-data'))return{url:'data:text/javascript,async function invoke(...args){globalThis.billingCalls.push(args);if(globalThis.billingFailure)throw Object.assign(new Error("Private upstream detail"),{status:globalThis.billingFailure});if(globalThis.billingMalformed)return {};const body=args[2];return body?.mode==="CUSTOMER"&&!body.tariffVersionId?{operation:{id:"78000000-0000-4000-8000-000000000009",type:"VERIFY_META_BILLING",state:"QUEUED"},duplicate:false}:{requestedMode:body?.mode,state:"HELD",sendReady:false,replay:false};} export const getMetaCustomerPolicy=invoke;export const requestMetaCustomerPolicy=invoke;',shortCircuit:true};
  if(specifier.startsWith('.')&&!specifier.endsWith('.ts'))return nextResolve(new URL(`${specifier}.ts`,context.parentURL).href,context);
 }return nextResolve(specifier,context);
}});
const route=await import('../app/api/connections/[id]/meta/billing-policy/route.ts');after(()=>hooks.deregister());
const id=(n:number)=>`78000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('actual payment BFF admits all four exact intents and fences role, session, CSRF and authority input',async()=>{
 const env={PORTAL_DATA_BACKEND:'control-plane',PORTAL_COOKIE_SECURE:'false',PORTAL_PUBLIC_ORIGIN:'https://portal.example'};
 const previous=new Map(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 fixture.billingSession={userId:'billing-owner',tenantId:id(1),role:'tenant_owner',csrfToken:'synthetic-csrf'};fixture.billingCalls=[];
 const headers={cookie:'wasalx_session=synthetic-cookie',origin:env.PORTAL_PUBLIC_ORIGIN,'content-type':'application/json','x-wasalx-csrf':'synthetic-csrf','idempotency-key':id(2)};
 const invoke=(method:'GET'|'POST',body?:unknown,suffix='',changed:Record<string,string>={})=>route[method](new Request(`${env.PORTAL_PUBLIC_ORIGIN}/api/connections/${id(3)}/meta/billing-policy${suffix}`,{method,headers:{...headers,...changed},...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})}),{params:Promise.resolve({id:id(3)})});
 const customer={mode:'CUSTOMER',expectedRevision:1},managed={mode:'MANAGED',expectedRevision:1,choiceId:id(4),documentSha256:'a'.repeat(64),acceptedTerms:true};
 const tariff={tariffVersionId:id(5),tariffDefinitionSha256:'b'.repeat(64)},terms={documentSha256:'a'.repeat(64),acceptedTerms:true};
 try{
  for(const body of [customer,managed,{...customer,...terms,...tariff},{...managed,...tariff}]){
   const count:number=fixture.billingCalls.length,response=await invoke('POST',body);assert.equal(response.status,202);assert.equal(fixture.billingCalls.length,count+1);
   assert.deepEqual(fixture.billingCalls.at(-1),[id(3),id(2),body]);assert.match(response.headers.get('cache-control')??'',/no-store/u);
  }
  assert.equal((await invoke('GET',undefined,`?tariffMode=MANAGED&choiceId=${id(4)}&tariffAfter=${id(5)}`)).status,200);
  assert.deepEqual(fixture.billingCalls.at(-1),[id(3),{tariffMode:'MANAGED',choiceId:id(4),tariffAfter:id(5)}]);
  for(const [body,changed,status] of [[managed,{origin:'https://foreign.example'},403],[managed,{'x-wasalx-csrf':'wrong'},403],[managed,{cookie:''},401],
   [{...managed,...tariff,evidenceMode:'LIVE'},{},400],[{...managed,...tariff,acceptedTerms:false},{},400],[{...managed,tariffVersionId:id(5)},{},400],
   ['{',{},400],[' '.repeat(5000),{},400],[managed,{'idempotency-key':'invalid key'},400]] as Array<[unknown,Record<string,string>,number]>){
   const count:number=fixture.billingCalls.length;assert.equal((await invoke('POST',body,'',changed)).status,status);assert.equal(fixture.billingCalls.length,count);
  }
  for(const suffix of ['?tariffMode=CUSTOMER&tariffMode=MANAGED','?tenantId=foreign','?tariffMode=MANAGED']){const count:number=fixture.billingCalls.length;assert.equal((await invoke('GET',undefined,suffix)).status,400);assert.equal(fixture.billingCalls.length,count);}
  for(const mode of [['CUSTOMER'],['MANAGED'],{},null,1,true]){const count:number=fixture.billingCalls.length;
   assert.equal((await invoke('POST',{mode,expectedRevision:1})).status,400);assert.equal(fixture.billingCalls.length,count);}
  const scoped={'x-wasalx-billing-actor':encodeURIComponent('billing-owner'),'x-wasalx-billing-workspace':encodeURIComponent(id(1))};
  assert.equal((await invoke('POST',{...managed,...tariff},'',scoped)).status,202);
  for(const changed of [{...scoped,'x-wasalx-billing-actor':'other-owner'},{...scoped,'x-wasalx-billing-workspace':id(99)},{'x-wasalx-billing-actor':'billing-owner'}]){
   const count:number=fixture.billingCalls.length;assert.equal((await invoke('POST',{...managed,...tariff},'',changed)).status,403);
   assert.equal((await invoke('GET',undefined,'?tariffMode=CUSTOMER',changed)).status,403);assert.equal(fixture.billingCalls.length,count);}
  fixture.billingSession.role='agent';assert.equal((await invoke('GET')).status,200);const count:number=fixture.billingCalls.length;
  assert.equal((await invoke('GET',undefined,'?tariffMode=CUSTOMER')).status,403);assert.equal((await invoke('POST',managed)).status,403);assert.equal(fixture.billingCalls.length,count);
  fixture.billingSession.role='tenant_admin';fixture.billingFailure=503;
  const response=await invoke('POST',{...managed,...tariff});assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/Private upstream detail/u);
  fixture.billingFailure=undefined;await invoke('POST',{...managed,...tariff});assert.deepEqual(fixture.billingCalls.at(-1),fixture.billingCalls.at(-2));
  fixture.billingMalformed=true;assert.equal((await invoke('POST',{...managed,...tariff})).status,502);fixture.billingMalformed=false;
 }finally{for(const [k,v]of previous)if(v===undefined)delete process.env[k];else process.env[k]=v;delete fixture.billingSession;delete fixture.billingCalls;delete fixture.billingFailure;delete fixture.billingMalformed;}
});


test('fixture payment BFF uses each shell persona while preserving actor, workspace and write fences',async()=>{
 const previousBackend=process.env.PORTAL_DATA_BACKEND,previousRole=process.env.PORTAL_FIXTURE_ROLE;
 const {portalFixturePersona,TENANT_ROLES}=await import('../lib/fixture-role.ts');
 fixture.billingCalls=[];
 try{
  process.env.PORTAL_DATA_BACKEND='fixture';
  for(const role of TENANT_ROLES){
   process.env.PORTAL_FIXTURE_ROLE=role;const persona=portalFixturePersona()!;
   const scoped={'x-wasalx-billing-actor':encodeURIComponent(persona.userId),'x-wasalx-billing-workspace':'tenant_northstar'};
   const invoke=(method:'GET'|'POST',query='',changed:Record<string,string>={})=>route[method](new Request(`http://localhost/api/connections/${id(3)}/meta/billing-policy${query}`,{
    method,headers:{...scoped,...changed,...(method==='POST'?{'content-type':'application/json','idempotency-key':id(2)}:{})},
    ...(method==='POST'?{body:JSON.stringify({mode:'CUSTOMER',expectedRevision:0})}:{}),
   }),{params:Promise.resolve({id:id(3)})});
   const response=await invoke('GET');assert.equal(response.status,200,role);assert.match(response.headers.get('cache-control')??'',/no-store/u);
   assert.deepEqual(await response.json(),{enrolled:false,mode:null,revision:0,sendReady:false,paymentMethod:'UNAVAILABLE',checkedAt:null,actualPayer:'UNVERIFIED',customerOwnership:'UNVERIFIED',managedAvailable:false,state:null});
   assert.equal((await invoke('GET','',{'x-wasalx-billing-actor':'different-persona'})).status,403);
   assert.equal((await invoke('GET','',{'x-wasalx-billing-workspace':'different-workspace'})).status,403);
   const canConfigure=role==='tenant_owner'||role==='tenant_admin';
   assert.equal((await invoke('GET','?tariffMode=CUSTOMER')).status,canConfigure?200:403);
   assert.equal((await invoke('POST')).status,canConfigure?501:403);
  }
  assert.deepEqual(fixture.billingCalls,[],'Fixture requests must not reach the control-plane transport');
 }finally{
  if(previousBackend===undefined)delete process.env.PORTAL_DATA_BACKEND;else process.env.PORTAL_DATA_BACKEND=previousBackend;
  if(previousRole===undefined)delete process.env.PORTAL_FIXTURE_ROLE;else process.env.PORTAL_FIXTURE_ROLE=previousRole;
  delete fixture.billingCalls;
 }
});
