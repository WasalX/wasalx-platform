import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MetaSignupService} from '../services/control-api/dist/meta-signup.service.js';
import {ConnectionsController} from '../services/control-api/dist/connections.controller.js';

/** Actual app-role P05 one-use authorization and original durable stage. Only
 * the documented Graph boundary and secret sidecar are synthetic. No observer
 * row, success result, proof, checkpoint or transition selection is seeded. */
export function createMetaTransitionObserverHarness(f,planId){
 const token='synthetic-renewed-observer-'+randomUUID(),businessId='123456789001';
 const database={withTenant:(tenant,fn)=>f.tx(f.app,tenant,fn),rows:(tenant,sql,values)=>f.tx(f.app,tenant,async c=>(await c.query(sql,values)).rows)};
 const writes=[],reads=[],calls=[];let lostWrite=false,valid=true;
 const secrets={ready:async()=>true,storeMetaCredential:async(reference,value)=>{
  writes.push(reference);f.readbackSecrets.set(reference,{...value});
  if(lostWrite&&reference.includes('/connections/'))throw new Error('Synthetic lost one-shot observer PUT response');
 }};
 const credentials={resolveSignupToken:async reference=>{const value=f.readbackSecrets.get(reference);assert.ok(value);return value.accessToken;},
  inspectSignupConnection:async reference=>{reads.push(reference);return f.readbackSecrets.get(reference)??null;}};
 const webhookSecrets={resolveHmac:async()=> 'synthetic-observer-app-secret'};
 const service=new MetaSignupService(database,secrets,credentials,webhookSecrets);
 const controller=new ConnectionsController(database,secrets,{wakeConnection:async()=>{}},undefined,webhookSecrets,credentials,service);
 const env={META_SIGNUP_ENABLED:'true',META_SIGNUP_CUSTOMER_CONFIG_ID:'12025550160',META_APP_ID:f.appId,META_GRAPH_VERSION:'v24.0',
  META_APP_SECRET_REFERENCE:'secret://platform/meta-webhook',PORTAL_PUBLIC_ORIGIN:'https://portal.example.invalid'};
 const request={...f.request,headers:{origin:env.PORTAL_PUBLIC_ORIGIN}};
 const invoke=async callback=>{
  const originalFetch=globalThis.fetch,previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
  globalThis.fetch=async(input,init={})=>{
   const url=new URL(String(input));assert.equal(url.origin,'https://graph.facebook.com');assert.equal(init.method,'GET');
   const path=url.pathname.replace(/^\/v[0-9]+\.[0-9]+/u,'');calls.push(path);
   const current=await f.plan(planId),account=current.provider_status==='COMPLETED'?f.targetProviderAccountId:f.providerAccountId;
   if(path==='/oauth/access_token')return Response.json({access_token:token});
   if(path==='/debug_token')return Response.json({data:{app_id:f.appId,is_valid:valid,expires_at:0,user_id:'444444449',
    scopes:['whatsapp_business_management','whatsapp_business_messaging'],granular_scopes:[{scope:'whatsapp_business_management',target_ids:[account]}]}});
   assert.equal(init.headers.authorization,`Bearer ${token}`);
   if(path===`/${account}`)return Response.json({id:account,name:'Synthetic accessible account',owner_business:{id:businessId,name:'Synthetic portfolio'}});
   if(path===`/${businessId}/owned_whatsapp_business_accounts`)return Response.json({data:[{id:account}]});
   if(path===`/${account}/phone_numbers`)return Response.json({data:[{id:f.phoneNumberId,display_phone_number:'12025550161',status:'CONNECTED',
    account_mode:'LIVE',host_platform:'CLOUD_API',code_verification_status:'VERIFIED'}]});
   if(path===`/${f.phoneNumberId}`)return Response.json({id:f.phoneNumberId,is_on_biz_app:false,platform_type:'CLOUD_API'});
   assert.fail(`Unexpected observer authorization request ${path}`);
  };
  try{return await callback();}finally{globalThis.fetch=originalFetch;for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
 };
 const start=()=>invoke(()=>service.start(request,{name:'Renew transition access',payerMode:'CUSTOMER',idempotencyKey:randomUUID(),targetConnectionId:f.connectionId,targetTransitionId:planId}));
 const exchange=attempt=>invoke(()=>service.exchange(request,attempt.attemptId,{challenge:attempt.challenge,code:randomUUID(),expectedRevision:attempt.revision}));
 const select=view=>invoke(()=>controller.signupSelect(request,view.attemptId,{choiceId:view.choices[0].choiceId,expectedRevision:view.revision,selectionRevision:view.selectionRevision}));
 return{service,controller,request,invoke,start,exchange,select,get:id=>invoke(()=>service.get(request,id)),
  cancel:view=>invoke(()=>service.cancel(request,view.attemptId,{expectedRevision:view.revision})),writes,reads,calls,
  loseWrite:()=>{lostWrite=true;},restoreWrite:()=>{lostWrite=false;},revokeNewCredential:()=>{valid=false;},
  renew:async()=>{const begun=await start(),choices=await exchange(begun);assert.equal(choices.purpose,'TRANSITION_READBACK');
   assert.equal(choices.choices.length,1);assert.equal(choices.choices[0].selectable,true);return select(choices);}};
}
