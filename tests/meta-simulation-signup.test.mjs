import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {mkdtempSync,chmodSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMetaSimulation} from '../scripts/contracts/meta-simulation-server.mjs';

const posix={skip:process.platform==='win32'?'POSIX private control, persistence and trusted TLS required':false};
const tlsHelpers=process.platform==='win32'?null:await import('./helpers/meta-simulation-fixture.mjs');
const tls=tlsHelpers?await tlsHelpers.testTls():{};
const base={token:'synthetic-signup-subject-token',appId:'12025550130',appSecret:'synthetic-signup-application-secret',
 phoneId:'10001',phone:'12025550103',wabaId:'20001',version:'v24.0',recipients:['12025550106']};
const signupFixture={businessId:'30001',userId:'40001'};
const config={appId:base.appId,configId:'50001',graphVersion:base.version,secretReference:'synthetic-app',origin:'https://example.invalid'};
const pin='931742';
const control=(path,method,route,body)=>new Promise((resolve,reject)=>{
 const request=httpRequest({socketPath:path,agent:false,method,path:route,headers:{'content-type':'application/json'}},response=>{
  const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({
   status:response.statusCode,body:chunks.length?JSON.parse(Buffer.concat(chunks)):undefined}));
 });
 request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));
});

async function fixture(t,{signup=true,reauthorizationToken,coexistence,templates,legacy,transition,finance}={}){
 const dir=mkdtempSync(join(tmpdir(),'meta-signup-'));chmodSync(dir,0o700);
 const options={...base,...tls,...(transition?{transitionFixture:transition}:{}),...(finance?{financialFixture:finance}:{}),stateFile:join(dir,'state.json'),...(templates?{templatePreparationFixture:templates}:{}),...(legacy?{legacyMigrationFixture:legacy}:{}),...(signup?{signupFixture:{...signupFixture,...(reauthorizationToken?{reauthorizationToken}:{}),...(coexistence?{coexistence}:{})}}:{})};
 let now=Date.now();options.signupClock=()=>now;
 let server,unix;
 const socket=join(dir,'control.sock');
 const {Agent,setGlobalDispatcher,getGlobalDispatcher}=await import(tlsHelpers.undiciUrl);
 const previous=getGlobalDispatcher(),previousOrigin=process.env.META_GRAPH_BASE_URL,previousNodeEnv=process.env.NODE_ENV;
 process.env.NODE_ENV='production';
 const agent=new Agent({connect:{ca:tls.ca,lookup:(host,lookupOptions,callback)=>{
  assert.equal(host,'graph.facebook.com');callback(null,lookupOptions.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4);
 }}});
 setGlobalDispatcher(agent);
 const close=async()=>{if(unix){await new Promise(resolve=>unix.close(resolve));unix=undefined;}if(server?.listening)await new Promise(resolve=>server.close(resolve));};
 const start=async()=>{server=createMetaSimulation(options);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));unix=await server.startControl(socket);process.env.META_GRAPH_BASE_URL='https://graph.facebook.com:'+server.address().port;};
 t.after(async()=>{setGlobalDispatcher(previous);await agent.close();await close();if(previousOrigin===undefined)delete process.env.META_GRAPH_BASE_URL;else process.env.META_GRAPH_BASE_URL=previousOrigin;if(previousNodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousNodeEnv;rmSync(dir,{recursive:true,force:true});});
 await start();
 return {options,socket,get server(){return server;},advance:milliseconds=>{now+=milliseconds;},
  restart:async()=>{await close();await start();},close,
  raw:async(path,{method='GET',query,body,bearer=base.token,signal}={})=>{
   const url=new URL('/'+base.version+path,process.env.META_GRAPH_BASE_URL);if(query)url.search=new URLSearchParams(query).toString();
   return fetch(url,{method,signal,headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  },
  issue:async(renewal=false)=>{const result=await control(socket,'POST','/signup/code',renewal?{renewal:true}:{});assert.equal(result.status,200);return result.body.code;}
 };
}

test('signup simulation is opt-in and rejects incomplete or unbounded fixture configuration',()=>{
 const server=createMetaSimulation(base);
 assert.equal(server.signupState(),null);
 assert.throws(()=>server.issueSignupCode());assert.throws(()=>server.armSignupFault({id:'bad',phase:'exchange'}));
 for(const invalid of [
  {signupFixture},{signupFixture:{...signupFixture,enabled:true},stateFile:'unused'},
  ...[null,'short',base.token,'invalid token with spaces'].map(reauthorizationToken=>({signupFixture:{...signupFixture,reauthorizationToken},stateFile:'unused'})),
  {signupFixture:{...signupFixture,businessId:'foreign'},stateFile:'unused'},
  {signupFixture:{...signupFixture,businessId:base.phoneId},stateFile:'unused'},
  {signupFixture,stateFile:'unused',appId:undefined},{signupFixture,stateFile:'unused',appSecret:undefined}
 ])assert.throws(()=>createMetaSimulation({...base,...invalid}));
});

test('paused reauthorization fixture exchanges a distinct credential for the same registered account without provider mutations',posix,async t=>{
 const renewed='synthetic-renewed-account-credential';
 const f=await fixture(t,{reauthorizationToken:renewed});
 const {MetaSignupClient}=await import('../services/control-api/dist/meta-signup.client.js');
 const {metaSignupChoiceAdmission}=await import('../packages/core/dist/meta-signup.js');
 const {MetaGroupsAdapter}=await import(tlsHelpers.adapterUrl);
 const code=await f.issue();
 assert.equal(await new MetaSignupClient(config).exchange(code,base.appSecret),renewed);
 await assert.rejects(()=>new MetaSignupClient(config).exchange(code,base.appSecret));
 for(const credential of [base.token,renewed]){
  const discovered=await new MetaSignupClient(config,credential).discover(base.appSecret);
  assert.equal(discovered.choices.length,1);
  const choice=discovered.choices[0];assert.equal(choice.numberState,'REGISTERED');assert.equal(choice.selectable,false,'New-number path stays held');
  assert.equal(metaSignupChoiceAdmission(choice,{phoneNumberId:base.phoneId,wabaId:base.wabaId}).selectable,true);
  const adapter=new MetaGroupsAdapter({accessToken:credential,graphVersion:base.version,phoneNumberIdFor:()=>base.phoneId,wabaIdFor:()=>base.wabaId,baseUrl:process.env.META_GRAPH_BASE_URL});
  await adapter.verifySignupOwner('connection',signupFixture.businessId);
  assert.equal((await adapter.getIdentity('connection')).phone,base.phone);
 }
 await assert.rejects(()=>new MetaSignupClient(config,'foreign-synthetic-credential').discover(base.appSecret));
 const state=f.server.signupState();assert.equal(state.phoneStatus,'CONNECTED');assert.equal(state.registrationAttempts,0);
 assert.equal(state.exchangeReceipts.length,1);assert.equal(f.server.subscription().subscribed,false);assert.equal(f.server.receipts().length,0);
 const bytes=readFileSync(f.options.stateFile,'utf8');
 for(const secret of [code,renewed,base.token,base.appSecret])assert(!bytes.includes(secret),'Credential or code persisted in simulator state');
 await f.restart();assert.equal(f.server.signupState().phoneStatus,'CONNECTED');
 await assert.rejects(()=>new MetaSignupClient(config).exchange(code,base.appSecret));
 await f.close();
 assert.throws(()=>createMetaSimulation({...f.options,signupFixture:{...signupFixture,reauthorizationToken:'different-synthetic-renewed-token'}}));
 assert.throws(()=>createMetaSimulation({...f.options,signupFixture}));
});

test('production signup client and adapter use exact trusted Graph discovery, registration and readiness',posix,async t=>{
 const f=await fixture(t);
 const {MetaSignupClient}=await import('../services/control-api/dist/meta-signup.client.js');
 const {MetaGroupsAdapter}=await import(tlsHelpers.adapterUrl);
 const code=await f.issue();
 assert.equal(await new MetaSignupClient(config).exchange(code,base.appSecret),base.token);
 await assert.rejects(()=>new MetaSignupClient(config).exchange(code,base.appSecret));
 const client=new MetaSignupClient(config,base.token),before=await client.discover(base.appSecret);
 assert.equal(before.choices.length,1);
 assert.equal(before.choices[0].businessId,signupFixture.businessId);
 assert.equal(before.choices[0].phoneId,base.phoneId);assert.equal(before.choices[0].wabaId,base.wabaId);
 assert.equal(before.choices[0].mode,'STANDARD');assert.equal(before.choices[0].numberState,'REGISTRATION_REQUIRED');assert.equal(before.choices[0].selectable,true);
 const assigned=await f.raw('/'+signupFixture.userId+'/assigned_whatsapp_business_accounts',{query:{fields:'id,name',limit:'100'}});
 assert.equal((await assigned.json()).data[0].id,base.wabaId);
 assert.deepEqual(await (await f.raw('/'+base.phoneId,{query:{fields:'id'}})).json(),{id:base.phoneId});
 const adapter=new MetaGroupsAdapter({accessToken:base.token,graphVersion:base.version,phoneNumberIdFor:()=>base.phoneId,wabaIdFor:()=>base.wabaId,baseUrl:process.env.META_GRAPH_BASE_URL});
 await adapter.verifySignupOwner('connection',signupFixture.businessId);
 assert.equal((await adapter.signupPhone('connection')).numberState,'REGISTRATION_REQUIRED');
 assert.deepEqual(await adapter.signupReadiness('connection',base.appId),{subscribed:false,messaging:'BLOCKED'});
 await adapter.registerSignupPhone('connection',pin);
 assert.equal((await adapter.signupPhone('connection')).numberState,'REGISTERED');
 assert.deepEqual(await adapter.signupReadiness('connection',base.appId),{subscribed:false,messaging:'AVAILABLE'});
 await adapter.subscribeWaba('connection');await adapter.subscribeWaba('connection');
 assert.deepEqual(await adapter.signupReadiness('connection',base.appId),{subscribed:true,messaging:'AVAILABLE'});
 assert.equal((await adapter.getIdentity('connection')).phone,base.phone);
 const existing=(await client.discover(base.appSecret)).choices[0];
 assert.equal(existing.selectable,false);assert.equal(existing.reasonCode,'META_SIGNUP_EXISTING_NUMBER_REVIEW');
 await assert.rejects(()=>adapter.verifySignupOwner('connection','30002'));
 assert.deepEqual(await adapter.signupReadiness('connection','12025550160'),{subscribed:false,messaging:'UNKNOWN'});
 const bytes=readFileSync(f.options.stateFile,'utf8');
 for(const secret of [code,pin,base.token,base.appSecret])assert(!bytes.includes(secret),'Signup secret leaked into persisted state');
 assert.equal(f.server.signupState().registrationAttempts,1);assert.equal(f.server.receipts().length,0);
 await f.restart();
 assert.equal(f.server.signupState().phoneStatus,'CONNECTED');assert.equal(f.server.subscription().subscribed,true);
 assert.equal(f.server.signupState().exchangeReceipts.length,1);assert.equal(f.server.signupState().registrationAttempts,1);
});

test('synthetic codes enforce app authentication, exact scope, expiry, one use and restart continuity',posix,async t=>{
 const f=await fixture(t),code=await f.issue();
 const query={client_id:base.appId,client_secret:base.appSecret,code},appBearer=base.appId+'|'+base.appSecret;
 const exchange=overrides=>f.raw('/oauth/access_token',{query,bearer:appBearer,...overrides});
 assert.equal((await exchange({bearer:base.token})).status,401);
 assert.equal((await exchange({query:{...query,client_id:'12025550160'}})).status,400);
 assert.equal((await exchange({query:{...query,client_secret:'wrong-synthetic-secret'}})).status,400);
 assert.equal((await exchange({query:{...query,code:'wrong-code'}})).status,400);
 assert.equal((await exchange({query:{...query,extra:'unsupported'}})).status,400);
 assert.equal((await exchange({method:'POST'})).status,400);
 assert.equal((await control(f.socket,'POST','/signup/code',{})).status,400);
 assert.equal(f.server.signupState().code.consumedAt,null);
 await f.restart();
 const results=await Promise.all([exchange(),exchange()]);
 assert.deepEqual(results.map(result=>result.status).sort(),[200,400]);assert.equal(f.server.signupState().exchangeReceipts.length,1);
 const expiring=await f.issue();f.advance(30_000);
 assert.equal((await exchange({query:{...query,code:expiring}})).status,400);assert.equal(f.server.signupState().code.consumedAt,null);
 assert.equal((await f.raw('/30002/owned_whatsapp_business_accounts',{query:{fields:'id',limit:'100'}})).status,404);
 assert.equal((await f.raw('/'+base.phoneId,{query:{fields:'unknown'}})).status,400);
 assert.equal((await f.raw('/'+base.phoneId,{query:{fields:'id,is_on_biz_app,platform_type',extra:'unsupported'}})).status,400);
 assert.equal((await f.raw('/signup/code',{method:'POST',body:{}})).status,404);
 assert.equal((await f.raw('/'+base.wabaId+'/phone_numbers',{query:{fields:'id,status,code_verification_status,account_mode,host_platform',limit:'100',after:'foreign'}})).status,400);
 await f.close();
 assert.throws(()=>createMetaSimulation({...f.options,signupFixture:{...signupFixture,businessId:'30002'}}));
 assert.throws(()=>createMetaSimulation({...f.options,token:'changed-synthetic-subject-token'}));
 assert.throws(()=>createMetaSimulation({...f.options,phone:'12025550161'}));
 assert.throws(()=>createMetaSimulation({...f.options,signupFixture:undefined}));
 const original=readFileSync(f.options.stateFile,'utf8'),state=JSON.parse(original);
 state.signup.code.expiresAt+=1;writeFileSync(f.options.stateFile,JSON.stringify(state),{mode:0o600});
 assert.throws(()=>createMetaSimulation(f.options));
 writeFileSync(f.options.stateFile,original,{mode:0o600});
});

test('accepted signup disconnects are durable and production transports never replay them',posix,async t=>{
 const f=await fixture(t);
 const {MetaSignupClient}=await import('../services/control-api/dist/meta-signup.client.js');
 const {MetaGroupsAdapter}=await import(tlsHelpers.adapterUrl);
 const code=await f.issue();
 assert.equal((await control(f.socket,'POST','/signup/fault',{id:'exchange-lost',phase:'exchange'})).status,200);
 assert.equal((await control(f.socket,'POST','/signup/fault',{id:'duplicate',phase:'exchange'})).status,400);
 assert.equal((await f.raw('/oauth/access_token',{query:{client_id:base.appId,client_secret:base.appSecret,code:'wrong-code'},bearer:base.appId+'|'+base.appSecret})).status,400);
 assert.equal(f.server.signupState().armedFault.id,'exchange-lost');
 await assert.rejects(()=>new MetaSignupClient(config).exchange(code,base.appSecret),error=>error.outcomeKnown===false);
 assert.equal(f.server.signupState().exchangeReceipts.length,1);assert.equal(f.server.signupState().faultEvents.length,1);
 assert.equal(f.server.signupState().armedFault,null);
 await f.restart();
 await assert.rejects(()=>new MetaSignupClient(config).exchange(code,base.appSecret),error=>error.outcomeKnown===true);
 assert.equal(f.server.signupState().exchangeReceipts.length,1);
 assert.equal((await control(f.socket,'POST','/signup/fault',{id:'exchange-lost',phase:'exchange'})).status,400);
 assert.equal((await control(f.socket,'POST','/signup/fault',{id:'registration-lost',phase:'register'})).status,200);
 assert.equal((await f.raw('/10002/register',{method:'POST',body:{messaging_product:'whatsapp',pin}})).status,404);
 assert.equal((await f.raw('/'+base.phoneId+'/register',{method:'POST',body:{messaging_product:'whatsapp',pin:'invalid'}})).status,400);
 assert.equal(f.server.signupState().armedFault.id,'registration-lost');assert.equal(f.server.signupState().registrationAttempts,0);
 const adapter=new MetaGroupsAdapter({accessToken:base.token,graphVersion:base.version,phoneNumberIdFor:()=>base.phoneId,wabaIdFor:()=>base.wabaId,baseUrl:process.env.META_GRAPH_BASE_URL});
 await assert.rejects(()=>adapter.registerSignupPhone('connection',pin),error=>error.outcomeKnown===false);
 assert.equal(f.server.signupState().registrationAttempts,1);assert.equal(f.server.signupState().faultEvents.length,2);
 assert.equal((await adapter.signupPhone('connection')).numberState,'REGISTERED');
 assert.equal(f.server.signupState().registrationAttempts,1,'Readback must not register again');
 await f.restart();
 assert.equal(f.server.signupState().phoneStatus,'CONNECTED');assert.equal(f.server.signupState().registrationAttempts,1);
 assert.equal((await control(f.socket,'POST','/signup/fault',{id:'second-register',phase:'register'})).status,400);
 const register=pinValue=>f.raw('/'+base.phoneId+'/register',{method:'POST',body:{messaging_product:'whatsapp',pin:pinValue}});
 assert.equal((await register('931743')).status,400);
 assert.equal((await register(pin)).status,200);
 assert.equal(f.server.signupState().registrationAttempts,3,'Attempts remain observable even when the accepted effect is unchanged');
 assert.equal(f.server.signupState().faultEvents.filter(event=>event.phase==='register').length,1);
});

test('default Meta fixture retains old routes and has no signup control or saved signup state',posix,async t=>{
 const f=await fixture(t,{signup:false});
 assert.equal((await control(f.socket,'POST','/signup/code',{})).status,404);
 assert.equal((await control(f.socket,'GET','/signup')).status,404);
 assert.equal((await f.raw('/'+base.phoneId,{query:{fields:'legacy-fixture-query'}})).status,200);
 assert.equal((await f.raw('/oauth/access_token',{query:{code:'synthetic'}})).status,404);
 assert.equal((await f.raw('/'+base.wabaId+'/subscribed_apps',{method:'POST',body:{}})).status,200);
 assert.equal(JSON.parse(readFileSync(f.options.stateFile,'utf8')).signup,undefined);
 await f.restart();assert.equal(f.server.subscription().subscribed,true);assert.equal(f.server.signupState(),null);
});

test('coexistence simulator exposes registered facts and durable one-shot requests across renewal and restart',posix,async t=>{
 const renewed='synthetic-coex-renewed-credential',coexistence={onboardedAt:Math.floor(Date.now()/1000),contacts:'ACCEPT',history:'DISCONNECT'};
 const f=await fixture(t,{coexistence,reauthorizationToken:renewed});
 const {MetaSignupClient}=await import('../services/control-api/dist/meta-signup.client.js');
 const {MetaGroupsAdapter}=await import(tlsHelpers.adapterUrl);
 const code=await f.issue();assert.equal(await new MetaSignupClient(config).exchange(code,base.appSecret),base.token);
 const [choice]=(await new MetaSignupClient({...config,variant:'BUSINESS_APP'},base.token).discover(base.appSecret)).choices;
 assert.equal(choice.mode,'COEXISTENCE');assert.equal(choice.numberState,'REGISTERED');assert.equal(choice.selectable,true);
 const makeAdapter=()=>new MetaGroupsAdapter({accessToken:base.token,graphVersion:base.version,phoneNumberIdFor:()=>base.phoneId,wabaIdFor:()=>base.wabaId,baseUrl:process.env.META_GRAPH_BASE_URL});let adapter=makeAdapter();
 assert.equal(f.server.signupState().registrationAttempts,0);
 assert.equal(await adapter.syncBusinessAppData('connection','contacts',async()=>{}),'SIMSYNC-contacts');
 await assert.rejects(()=>adapter.syncBusinessAppData('connection','history',async()=>{}),error=>error.outcomeKnown===false);
 const accepted=f.server.signupState().sync;assert.equal(accepted.attempts.length,2);assert.equal(accepted.requests.history.outcome,'DISCONNECT');
 await f.restart();adapter=makeAdapter();assert.deepEqual(f.server.signupState().sync,accepted);
 await assert.rejects(()=>adapter.syncBusinessAppData('connection','contacts',async()=>{}),error=>error.outcomeKnown===true);
 assert.deepEqual(f.server.signupState().sync.requests,accepted.requests,'Duplicate request cannot create a new receipt');
 const renewal=await control(f.socket,'POST','/signup/code',{renewal:true});assert.equal(renewal.status,200);
 assert.equal(await new MetaSignupClient(config).exchange(renewal.body.code,base.appSecret),renewed);
 assert.deepEqual(f.server.signupState().sync.requests,accepted.requests);assert.equal(f.server.signupState().registrationAttempts,0);
 await assert.rejects(()=>adapter.registerSignupPhone('connection',pin));assert.equal(f.server.signupState().registrationAttempts,1);assert.equal(f.server.signupState().registration,null);
 const bytes=readFileSync(f.options.stateFile,'utf8');for(const secret of [code,renewal.body.code,base.token,renewed])assert(!bytes.includes(secret));
});

test('coexistence held response requires exact one-use private release and persists acceptance first',posix,async t=>{
 const f=await fixture(t,{coexistence:{onboardedAt:Math.floor(Date.now()/1000),contacts:'HOLD',history:'ACCEPT'}});
 const pending=f.raw('/'+base.phoneId+'/smb_app_data',{method:'POST',body:{messaging_product:'whatsapp',sync_type:'smb_app_state_sync'}});
 for(let i=0;i<100&&!f.server.signupState().sync.requests.contacts;i++)await new Promise(resolve=>setTimeout(resolve,5));
 const accepted=f.server.signupState().sync.requests.contacts;assert.equal(accepted.outcome,'HOLD');assert.equal(accepted.requestId,'SIMSYNC-contacts');
 assert.equal((await control(f.socket,'POST','/signup/sync-release',{kind:'history',requestId:accepted.requestId})).status,400);
 assert.equal((await control(f.socket,'POST','/signup/sync-release',{kind:'contacts',requestId:accepted.requestId})).status,200);
 assert.deepEqual(await (await pending).json(),{request_id:accepted.requestId});
 assert.equal((await control(f.socket,'POST','/signup/sync-release',{kind:'contacts',requestId:accepted.requestId})).status,400);
 assert.equal(f.server.signupState().sync.attempts.length,1);await f.restart();assert.equal(f.server.signupState().sync.requests.contacts.outcome,'RELEASED');
});

test('coexistence expiry and invalid wire shapes cannot allocate a request receipt',posix,async t=>{
 const f=await fixture(t,{coexistence:{onboardedAt:Math.floor(Date.now()/1000)-86401,contacts:'ACCEPT',history:'ACCEPT'}});
 for(const body of [{messaging_product:'whatsapp',sync_type:'history',extra:true},{messaging_product:'other',sync_type:'history'},
  {messaging_product:'whatsapp',sync_type:'contacts'}])assert.equal((await f.raw('/'+base.phoneId+'/smb_app_data',{method:'POST',body})).status,400);
 assert.equal(f.server.signupState().sync.attempts.length,0);
 assert.equal((await f.raw('/'+base.phoneId+'/smb_app_data',{method:'POST',body:{messaging_product:'whatsapp',sync_type:'history'}})).status,400);
 assert.equal(f.server.signupState().sync.attempts.length,1);assert.deepEqual(f.server.signupState().sync.requests,{contacts:null,history:null});
 await f.restart();assert.equal(f.server.signupState().sync.attempts.length,1);
});

test('lost coexistence release retains the consumed receipt through restart without another request',posix,async t=>{
 const f=await fixture(t,{coexistence:{onboardedAt:Math.floor(Date.now()/1000),contacts:'HOLD',history:'ACCEPT'}}),abort=new AbortController();
 const pending=f.raw('/'+base.phoneId+'/smb_app_data',{method:'POST',body:{messaging_product:'whatsapp',sync_type:'smb_app_state_sync'},signal:abort.signal});
 const rejected=assert.rejects(pending);
 for(let i=0;i<100&&!f.server.signupState().sync.requests.contacts;i++)await new Promise(resolve=>setTimeout(resolve,5));
 const consumed=structuredClone(f.server.signupState().sync);assert.equal(consumed.requests.contacts.outcome,'HOLD');
 abort.abort();await rejected;await f.restart();assert.deepEqual(f.server.signupState().sync,consumed);
 assert.equal((await control(f.socket,'POST','/signup/sync-release',{kind:'contacts',requestId:'SIMSYNC-contacts'})).status,400);
 assert.deepEqual(f.server.signupState().sync,consumed,'A lost response has no replay or invented provider completion');
});

// P05b reuses this POSIX trusted-TLS/UDS harness; no local test counts as installed proof.
const templateFields='id,name,language,status,category,parameter_format,components,quality_score,message_send_ttl_seconds,is_primary_device_delivery_only,is_sms_fallback_enabled,display_format,sub_category,cta_url_link_tracking_opted_out,degrees_of_freedom_spec';
const templatePreparation=(mode='FULL')=>({
 purpose:'TEMPLATE_PREPARATION',sourceAccountId:base.wabaId,targetAccountId:'60001',targetPhoneId:'70001',targetPhone:'15555550200',targetToken:'synthetic-template-target-token',businessId:signupFixture.businessId,
 source:[{id:'81001',name:'current_notice',language:'en',status:'APPROVED',category:'UTILITY',parameter_format:'POSITIONAL',components:[{type:'BODY',text:'Current {{1}}'}],quality_score:{score:'GREEN'}},
 {id:'81002',name:'pinned_notice',language:'ar',status:'APPROVED',category:'UTILITY',parameter_format:'POSITIONAL',components:[{type:'BODY',text:'Pinned {{1}}'}],quality_score:{score:'UNKNOWN'}}],
 target:[],mapping:[{sourceId:'81001',targetId:'82001'},{sourceId:'81002',targetId:'82002'}],responseMode:mode
});
for(const mode of ['FULL','MIXED','FAILED','DISCONNECT','MALFORMED','REJECT'])test('template copy durable original outcome '+mode,posix,async t=>{
 const spec=templatePreparation(mode),f=await fixture(t,{templates:spec}),body={source_waba_id:base.wabaId,template_ids:spec.source.map(r=>r.id)};
 const phone=await f.raw('/'+spec.targetPhoneId,{query:{fields:'display_phone_number,verified_name'},bearer:spec.targetToken});assert.equal((await phone.json()).display_phone_number,spec.targetPhone);
 const relation=await f.raw('/'+spec.targetAccountId+'/phone_numbers',{query:{fields:'id,display_phone_number',limit:'100'},bearer:spec.targetToken});assert.deepEqual((await relation.json()).data,[{id:spec.targetPhoneId,display_phone_number:spec.targetPhone}]);
 const subscription=()=>f.raw('/'+spec.targetAccountId+'/subscribed_apps',{query:{fields:'id,whatsapp_business_api_data',limit:'100'},bearer:spec.targetToken});
 assert.deepEqual((await (await subscription()).json()).data,[]);
 assert.equal((await f.raw('/'+spec.targetAccountId+'/subscribed_apps',{method:'POST',body:{},bearer:base.token})).status,400);
 assert.equal((await f.raw('/'+spec.targetAccountId+'/subscribed_apps',{method:'POST',body:{},bearer:spec.targetToken})).status,200);
 assert.equal((await (await subscription()).json()).data[0].whatsapp_business_api_data.id,base.appId);
 const setup=(await control(f.socket,'GET','/templates')).body.targetSubscriptions;assert.equal(setup.length,1);
 const inventory=()=>f.raw('/'+spec.targetAccountId+'/message_templates',{query:{fields:templateFields,limit:'100'},bearer:spec.targetToken});
 assert.equal((await (await inventory()).json()).data.length,0);
 const wrong=await f.raw('/'+spec.targetAccountId+'/migrate_message_templates',{method:'POST',body,bearer:base.token});assert.equal(wrong.status,400);
 assert.equal((await control(f.socket,'GET','/templates')).body.attempts.length,0);
 const call=()=>f.raw('/'+spec.targetAccountId+'/migrate_message_templates',{method:'POST',body,bearer:spec.targetToken});
 if(mode==='DISCONNECT')await assert.rejects(call);else{
  const r=await call();assert.equal(r.status,mode==='REJECT'?400:200);
  if(['FULL','MIXED','FAILED'].includes(mode)){const b=await r.json();assert.equal(b.migrated_templates.length,mode==='FULL'?2:mode==='MIXED'?1:0);assert.equal(Object.keys(b.failed_templates).length,mode==='FULL'?0:mode==='MIXED'?1:2);}
 }
 const original=(await control(f.socket,'GET','/templates')).body;
 assert.equal(original.evidenceClass,'simulated-provider-template-preparation');assert.equal(original.attempts.length,1);assert.equal(original.attempts[0].accepted,mode!=='REJECT');
 const before=(await (await inventory()).json()).data.length;assert.equal(before,['FULL','DISCONNECT','MALFORMED'].includes(mode)?2:mode==='MIXED'?1:0);
 await f.restart();assert.deepEqual((await control(f.socket,'GET','/templates')).body.attempts,original.attempts);assert.deepEqual((await control(f.socket,'GET','/templates')).body.targetSubscriptions,setup);
 if(['MIXED','FAILED','DISCONNECT','MALFORMED'].includes(mode)){
  assert.equal((await control(f.socket,'POST','/templates/complete-target',{})).status,200);
  assert.equal((await (await inventory()).json()).data.length,2);
  assert.equal((await control(f.socket,'POST','/templates/complete-target',{})).status,400);
  assert.deepEqual((await control(f.socket,'GET','/templates')).body.attempts,original.attempts);
 }
 assert.equal((await call()).status,400);
 const after=(await control(f.socket,'GET','/templates')).body;assert.equal(after.attempts.length,2);assert.equal(after.attempts[1].accepted,false);assert.deepEqual(after.attempts[0],original.attempts[0]);
 assert.equal((await f.raw('/'+base.phoneId+'/messages',{method:'POST',body:{messaging_product:'whatsapp',to:base.recipients[0],type:'text',text:{body:'must not send'}},bearer:spec.targetToken})).status,400);
 assert.equal(f.server.receipts().length,0);
});
test('template fixture is default-off and wrong account or body cannot allocate a copy slot',posix,async t=>{
 const f=await fixture(t);assert.equal((await control(f.socket,'GET','/templates')).status,404);
 assert.equal((await f.raw('/60001/migrate_message_templates',{method:'POST',body:{source_waba_id:base.wabaId,template_ids:['81001']}})).status,404);
});

const legacyFixture=()=>({schemaVersion:1,claim:'SYNTHETIC_LEGACY_SAME_PHONE',sourceProviderAccountId:base.wabaId,
 targetProviderAccountId:'60001',phoneId:base.phoneId,appId:base.appId,graphVersion:base.version});
for(const mode of ['ACCEPT','DISCONNECT','MALFORMED','REJECT'])test('legacy migration has one durable registration slot distinct from original signup: '+mode,posix,async t=>{
 const spec=templatePreparation(),f=await fixture(t,{templates:spec,legacy:legacyFixture()}),body={messaging_product:'whatsapp',pin:'246810'};
 assert.equal((await control(f.socket,'POST','/signup/code',{legacyMigration:true})).status,400,'No authorization before actual original setup');
 assert.equal((await f.raw('/'+base.phoneId+'/register',{method:'POST',body,bearer:spec.targetToken})).status,400);
 assert.equal(f.server.legacyMigrationState().attempts.length,0);
 const originalCode=await f.issue();
 const exchange=code=>f.raw('/oauth/access_token',{query:{client_id:base.appId,client_secret:base.appSecret,code},bearer:base.appId+'|'+base.appSecret});
 assert.equal((await (await exchange(originalCode)).json()).access_token,base.token);
 assert.equal((await f.raw('/'+base.phoneId+'/register',{method:'POST',body})).status,200);
 assert.equal((await f.raw('/'+base.wabaId+'/subscribed_apps',{method:'POST',body:{}})).status,200);
 assert.equal((await f.raw('/'+spec.targetAccountId+'/subscribed_apps',{method:'POST',body:{},bearer:spec.targetToken})).status,200);
 const sourceRegistration=structuredClone(f.server.signupState().registration);
 const issued=await control(f.socket,'POST','/signup/code',{legacyMigration:true});assert.equal(issued.status,200);
 assert.equal((await (await exchange(issued.body.code)).json()).access_token,spec.targetToken);
 assert.equal((await exchange(issued.body.code)).status,400,'One-use OAuth code cannot be exchanged twice');
 const {MetaGroupsAdapter}=await import(tlsHelpers.adapterUrl);
 const makeAdapter=()=>new MetaGroupsAdapter({accessToken:spec.targetToken,graphVersion:base.version,phoneNumberIdFor:()=>base.phoneId,wabaIdFor:()=>spec.targetAccountId,baseUrl:process.env.META_GRAPH_BASE_URL});let adapter=makeAdapter();
 await adapter.verifySignupOwner('synthetic-connection',signupFixture.businessId);
 assert.equal((await adapter.signupPhone('synthetic-connection')).numberState,'REGISTRATION_REQUIRED');
 assert.equal((await adapter.signupReadiness('synthetic-connection',base.appId)).subscribed,true);
 assert.equal((await control(f.socket,'POST','/legacy-migration/fault',{mode})).status,200);
 const register=()=>f.raw('/'+base.phoneId+'/register',{method:'POST',body,bearer:spec.targetToken});
 if(mode==='DISCONNECT')await assert.rejects(register);else{
  const response=await register();assert.equal(response.status,mode==='REJECT'?400:200);
  if(mode==='ACCEPT')assert.deepEqual(await response.json(),{success:true});
  if(mode==='MALFORMED')assert.equal((await response.json()).success,undefined);
 }
 const original=structuredClone(f.server.legacyMigrationState());assert.equal(original.attempts.length,1);
 assert.equal(original.attempts[0].accepted,mode!=='REJECT');assert.deepEqual(f.server.signupState().registration,sourceRegistration);
 await f.restart();adapter=makeAdapter();assert.deepEqual(f.server.legacyMigrationState(),original);
 assert.equal((await control(f.socket,'POST','/legacy-migration/fault',{mode:'ACCEPT'})).status,400,'Restart cannot open another stage slot');
 assert.equal((await adapter.signupPhone('synthetic-connection')).numberState,mode==='REJECT'?'REGISTRATION_REQUIRED':'REGISTERED');
 if(mode!=='REJECT'){
  const relation=await adapter.verifyPhoneAccountRelationship('synthetic-connection');
  assert.equal(relation.phoneNumberId,base.phoneId);assert.equal(relation.wabaId,spec.targetAccountId);
  assert.deepEqual((await (await f.raw('/'+base.wabaId+'/phone_numbers',{query:{fields:'id',limit:'100'}})).json()).data,[]);
  assert.equal((await f.raw('/'+base.phoneId+'/register',{method:'POST',body})).status,400,'Old provider credential cannot register after successor');
 }
 assert.equal((await register()).status,400);
 const retained=f.server.legacyMigrationState();assert.deepEqual(retained.attempts[0],original.attempts[0]);
 assert.equal(retained.attempts.filter(a=>a.accepted).length,mode==='REJECT'?0:1);
 assert.equal(f.server.signupState().registrationAttempts,1);assert.equal(f.server.receipts().length,0,'Registration never sends or copies routing ownership');
});
test('legacy migration is unavailable without the exact default-off transport tuple',posix,async t=>{
 const f=await fixture(t,{templates:templatePreparation()});assert.equal(f.server.legacyMigrationState(),null);
 assert.equal((await control(f.socket,'GET','/legacy-migration')).status,404);
 assert.equal((await control(f.socket,'POST','/signup/code',{legacyMigration:true})).status,400);
 for(const delta of [{claim:'LIVE_LEGACY_ELIGIBLE'},{phoneId:'99999'},{targetProviderAccountId:base.wabaId},{appId:'99999'},{graphVersion:'v25.0'},{enabled:true}])
  assert.throws(()=>createMetaSimulation({...f.options,legacyMigrationFixture:{...legacyFixture(),...delta}}));

});

const templateInventories={source:[{id:'91001',name:'support_update',language:'en_US',status:'APPROVED',category:'UTILITY',components:[{type:'BODY',text:'Your request is updated.'}]}],target:[{id:'92001',name:'support_update',language:'en_US',status:'PENDING',category:'UTILITY',components:[{type:'BODY',text:'Your request is updated.'}]}]};
const transitionFixture={templateInventories,migrationId:'sim_currency_clone_01',targetAccountId:'60001',sourceCurrency:'USD',targetCurrency:'EUR',sourceFundingId:'synthetic-source-funding',targetFundingId:'synthetic-target-funding',renewalToken:'synthetic-transition-renewed-token'};
const financeFixture={holderBusinessId:'70001',creditLineId:'80001',receivingBusinessId:signupFixture.businessId,allocationConfigId:'90001',currency:'USD',receivingCredential:transitionFixture.sourceFundingId};
const managedTransition={...transitionFixture,managed:{financialToken:'synthetic-separate-financial-token',holderBusinessId:financeFixture.holderBusinessId,creditLineId:financeFixture.creditLineId,receivingBusinessId:financeFixture.receivingBusinessId,allocationId:'90002'}};
async function transitionAdapter(f,{token=base.token,target=false,beforeFinancialMutation=async()=>{}}={}){
 const {MetaGroupsAdapter}=await import(tlsHelpers.adapterUrl);
 return new MetaGroupsAdapter({accessToken:token,graphVersion:base.version,phoneNumberIdFor:()=>base.phoneId,wabaIdFor:()=>target?transitionFixture.targetAccountId:base.wabaId,baseUrl:process.env.META_GRAPH_BASE_URL,beforeFinancialMutation});
}
async function onboardTransitionSource(f){
 const {MetaSignupClient}=await import('../services/control-api/dist/meta-signup.client.js');
 const code=await f.issue();assert.equal(await new MetaSignupClient(config).exchange(code,base.appSecret),base.token);
 const adapter=await transitionAdapter(f);await adapter.registerSignupPhone('connection',pin);await adapter.subscribeWaba('connection');
 assert.deepEqual(await adapter.signupReadiness('connection',base.appId),{subscribed:true,messaging:'AVAILABLE'});return adapter;
}
const transitionParsers=()=>import('../services/connector-worker/dist/packages/connectors/src/meta-account-transition-execute.js');
test('currency fixture is default-off and rejects foreign or unbound source/financial configuration',()=>{
 const server=createMetaSimulation(base);assert.equal(server.transitionState(),null);assert.throws(()=>server.armTransitionFault({id:'test',stage:'INITIATE',mode:'REJECT'}));
 for(const change of [{signupFixture:undefined},{stateFile:undefined},{transitionFixture:{...transitionFixture,targetAccountId:base.wabaId}},{transitionFixture:{...transitionFixture,renewalToken:base.token}},{transitionFixture:managedTransition},{templatePreparationFixture:templatePreparation()},{templatePreparationFixture:templatePreparation(),legacyMigrationFixture:legacyFixture()}]){
  assert.throws(()=>createMetaSimulation({...base,signupFixture,stateFile:'unused',transitionFixture,...change}));
 }
});
test('real trusted-TLS adapter proves source onboarding, one-shot clone phases, renewal and current target',posix,async t=>{
 const f=await fixture(t,{transition:transitionFixture}),parsers=await transitionParsers();
 assert.equal(f.server.signupState().phoneStatus,'PENDING');const before=await transitionAdapter(f);
 assert.deepEqual(await before.signupReadiness('connection',base.appId),{subscribed:false,messaging:'BLOCKED'});
 assert.throws(()=>f.server.issueSignupCode(true));
 await assert.rejects(before.accountTransitionCalls().initiate(base.wabaId,'EUR'));assert.equal(f.server.transitionState().attempts.filter(a=>a.accepted).length,0);
 const adapter=await onboardTransitionSource(f),calls=adapter.accountTransitionCalls();
 const initiated=parsers.parseMetaMigrationInitiation(await calls.initiate(base.wabaId,'EUR'));assert.equal(initiated.migrationId,transitionFixture.migrationId);
 assert.equal(initiated.status,'INITIATED');assert.equal(f.server.transitionState().attempts.filter(a=>a.accepted).length,1);
 const ready=parsers.parseMetaMigrationObservation(await calls.observe(initiated.migrationId),initiated.migrationId,'EUR',transitionFixture.targetAccountId);
 assert.equal(ready.status,'READY_TO_COMPLETE');assert.equal((await adapter.transitionCloneAccess(transitionFixture.targetAccountId,base.appId,'EUR')).claim,'CLONE_ACCOUNT_ACCESS_VERIFIED');
 assert.deepEqual((await (await f.raw('/'+transitionFixture.targetAccountId+'/phone_numbers',{query:{fields:'id',limit:'100'}})).json()).data,[]);
 await assert.rejects(calls.initiate(base.wabaId,'EUR'));assert.equal(f.server.transitionState().attempts.filter(a=>a.accepted).length,1);
 const {MetaSignupClient}=await import('../services/control-api/dist/meta-signup.client.js'),renewal=await f.issue(true);
 assert.equal(await new MetaSignupClient(config).exchange(renewal,base.appSecret),transitionFixture.renewalToken);
 await assert.rejects(new MetaSignupClient(config).exchange(renewal,base.appSecret));
 assert.equal((await new MetaSignupClient(config,transitionFixture.renewalToken).discover(base.appSecret)).choices[0].wabaId,base.wabaId,'pre-completion renewal proves original account');
 assert.equal((await control(f.socket,'POST','/transition/revoke-original',{})).status,200);
 assert.equal((await f.raw('/'+transitionFixture.migrationId)).status,401);
 const renewed=await transitionAdapter(f,{token:transitionFixture.renewalToken}),completed=parsers.parseMetaMigrationObservation(await renewed.accountTransitionCalls().complete(initiated.migrationId),initiated.migrationId,'EUR',transitionFixture.targetAccountId);
 assert.equal(completed.status,'COMPLETED');assert.equal(f.server.transitionState().attempts.filter(a=>a.accepted).length,2);
 const target=await transitionAdapter(f,{token:transitionFixture.renewalToken,target:true});
 assert.equal((await target.verifyPhoneAccountRelationship('connection')).phoneNumberId,base.phoneId);
 assert.deepEqual(await target.signupReadiness('connection',base.appId),{subscribed:true,messaging:'AVAILABLE'});
 assert.equal((await new MetaSignupClient(config,transitionFixture.renewalToken).discover(base.appSecret)).choices[0].wabaId,transitionFixture.targetAccountId);
 await assert.rejects(target.accountTransitionCalls().complete(initiated.migrationId));
 assert.equal(f.server.signupState().registrationAttempts,1);assert.equal(f.server.receipts().length,0);assert.equal(f.server.transitionState().attempts.filter(a=>a.accepted).length,2);
 await f.restart();assert.equal(f.server.transitionState().status,'COMPLETED');assert.equal(f.server.transitionState().attempts.filter(a=>a.accepted).length,2);
 const persisted=readFileSync(f.options.stateFile,'utf8');for(const value of [base.token,base.appSecret,transitionFixture.renewalToken,pin,renewal])assert(!persisted.includes(value));
});
test('accepted malformed clone response retains only captured provider locator for GET, never another POST',posix,async t=>{
 const f=await fixture(t,{transition:transitionFixture}),adapter=await onboardTransitionSource(f),parsers=await transitionParsers();
 assert.equal((await control(f.socket,'POST','/transition/fault',{id:'captured-once',stage:'INITIATE',mode:'MALFORMED_WITH_ID'})).status,200);
 const raw=await adapter.accountTransitionCalls().initiate(base.wabaId,'EUR');assert.throws(()=>parsers.parseMetaMigrationInitiation(raw));
 const locator=parsers.metaMigrationRecoveryId(raw,'INITIATE');assert.equal(locator,transitionFixture.migrationId);
 assert.equal(parsers.parseMetaMigrationObservation(await adapter.accountTransitionCalls().observe(locator),locator,'EUR').status,'READY_TO_COMPLETE');
 assert.equal(f.server.transitionState().attempts.filter(a=>a.accepted).length,1);assert.equal(f.server.transitionState().faultEvents.length,1);
 await f.restart();assert.equal(f.server.transitionState().attempts.filter(a=>a.accepted).length,1);assert.equal(f.server.transitionState().migrationId,locator);
});
test('lost accepted clone has no application locator and survives restart without automatic replay',posix,async t=>{
 const f=await fixture(t,{transition:transitionFixture}),adapter=await onboardTransitionSource(f),parsers=await transitionParsers();
 assert.equal((await control(f.socket,'POST','/transition/fault',{id:'lost-once',stage:'INITIATE',mode:'DISCONNECT_NO_LOCATOR'})).status,200);
 await assert.rejects(adapter.accountTransitionCalls().initiate(base.wabaId,'EUR'),error=>error.outcomeKnown===false);
 assert.equal(parsers.metaMigrationRecoveryId(undefined,'INITIATE'),null);assert.equal(f.server.transitionState().attempts.filter(a=>a.accepted).length,1);
 await f.restart();assert.equal(f.server.transitionState().attempts.filter(a=>a.accepted).length,1);assert.equal(f.server.transitionState().faultEvents.length,1);
 // Private provider state is diagnostic; this test never converts its ID into
 // an application locator or replays the original effect.
 assert.equal(f.server.receipts().length,0);assert.equal(f.server.signupState().registrationAttempts,1);
});
test('managed clone preserves actual source finance ledger and reads exact derived allocation with separate bearer',posix,async t=>{
 const f=await fixture(t,{transition:managedTransition,finance:financeFixture}),adapter=await onboardTransitionSource(f),parsers=await transitionParsers();
 const financial=await transitionAdapter(f,{token:managedTransition.managed.financialToken});
 assert.deepEqual(await financial.readExtendedCreditLines(financeFixture.holderBusinessId),[financeFixture.creditLineId]);
 await assert.rejects(adapter.readExtendedCreditLines(financeFixture.holderBusinessId));
 assert.equal((await financial.attachApprovedCreditLine(financeFixture.creditLineId,base.wabaId,'USD')).allocationConfigId,financeFixture.allocationConfigId);
 const sourceFinance=structuredClone(f.server.financialState());assert.equal(sourceFinance.financialEvents.length,1);assert.equal(sourceFinance.financialEvents[0].stage,'ATTACH');
 const send=(client,account,text)=>client.send({connectionId:'connection',groupId:base.recipients[0],recipientType:'DIRECT',metaDirectRecipient:{kind:'PHONE',value:base.recipients[0]},messagingAccountId:account,text,idempotencyKey:'synthetic-'+text});
 const sourceReceipt=await send(adapter,base.wabaId,'Managed source reply');assert.equal(sourceReceipt.externalMessageId,f.server.receipts()[0].id);assert.equal(f.server.receipts()[0].body.messaging_account_id,base.wabaId);assert.equal(f.server.receipts()[0].body.text.body,'Managed source reply');
 await assert.rejects(send(financial,base.wabaId,'Financial bearer denied'));assert.equal(f.server.receipts().length,1);
 const initiated=parsers.parseMetaMigrationInitiation(await adapter.accountTransitionCalls().initiate(base.wabaId,'EUR',financeFixture.creditLineId));
 const cloneFunding=(await adapter.billingAccountProof(transitionFixture.targetAccountId)).funding;assert.equal(cloneFunding.primaryFundingId,transitionFixture.targetFundingId);
 const derived=await financial.readDerivedCreditAllocation(financeFixture.creditLineId,financeFixture.receivingBusinessId,transitionFixture.targetFundingId);assert.equal(derived.allocationConfigId,managedTransition.managed.allocationId);
 assert.deepEqual(f.server.financialState(),sourceFinance,'P09 never attaches or revokes a P08 allocation');
 await assert.rejects(financial.accountTransitionCalls().complete(initiated.migrationId));
 assert.equal(f.server.transitionState().attempts.length,1);assert.equal(f.server.receipts().length,1);
 const {MetaSignupClient}=await import('../services/control-api/dist/meta-signup.client.js');const code=await f.issue(true);assert.equal(await new MetaSignupClient(config).exchange(code,base.appSecret),transitionFixture.renewalToken);
 assert.equal((await control(f.socket,'POST','/transition/revoke-original',{})).status,200);await assert.rejects(send(adapter,base.wabaId,'Revoked bearer denied'));assert.equal(f.server.receipts().length,1);
 const renewed=await transitionAdapter(f,{token:transitionFixture.renewalToken});await assert.rejects(renewed.readExtendedCreditLines(financeFixture.holderBusinessId));
 const completed=parsers.parseMetaMigrationObservation(await renewed.accountTransitionCalls().complete(initiated.migrationId),initiated.migrationId,'EUR',transitionFixture.targetAccountId);assert.equal(completed.status,'COMPLETED');
 const target=await transitionAdapter(f,{token:transitionFixture.renewalToken,target:true});const targetReceipt=await send(target,transitionFixture.targetAccountId,'Managed target reply');assert.equal(targetReceipt.externalMessageId,f.server.receipts()[1].id);
 assert.equal(f.server.receipts()[1].body.messaging_account_id,transitionFixture.targetAccountId);assert.equal(f.server.receipts()[1].body.text.body,'Managed target reply');await assert.rejects(send(financial,transitionFixture.targetAccountId,'Financial bearer still denied'));
 assert.equal(f.server.receipts().length,2);assert.deepEqual(f.server.financialState(),sourceFinance);assert.deepEqual(f.server.transitionState().attempts.map(a=>[a.stage,a.accepted]),[['INITIATE',true],['COMPLETE',true]]);
 const originals=structuredClone(f.server.transitionState().attempts),receipts=structuredClone(f.server.receipts());await f.restart();assert.deepEqual(f.server.financialState(),sourceFinance);assert.deepEqual(f.server.transitionState().attempts,originals);assert.deepEqual(f.server.receipts(),receipts);
});

test('documented template GET keeps source and clone inventories distinct without readiness inference',posix,async t=>{
 const f=await fixture(t,{transition:transitionFixture}),adapter=await onboardTransitionSource(f);
 const {readMetaTemplateInventory}=await import('../services/connector-worker/dist/packages/connectors/src/meta-template-read.js');
 const read=async(account,override)=>readMetaTemplateInventory(account,async(path,query)=>{const r=await f.raw(path,{query});assert.equal(r.status,200);const value=await r.json();return override?override(value):value;});
 assert.equal((await read(base.wabaId)).items[0].id,'91001');
 await assert.rejects(read(transitionFixture.targetAccountId));
 await adapter.accountTransitionCalls().initiate(base.wabaId,'EUR');
 const target=await read(transitionFixture.targetAccountId);assert.equal(target.complete,true);assert.equal(target.items[0].id,'92001');assert.equal(target.items[0].status,'PENDING');
 assert.equal((await read(base.wabaId)).items[0].id,'91001','clone never rewrites source templates');
 assert.equal((await read(base.wabaId,v=>({...v,data:[v.data[0],v.data[0]]}))).complete,false);
 assert.equal((await read(base.wabaId,v=>({...v,data:[{...v.data[0],components:undefined}]}))).complete,false);
 assert.equal((await f.raw('/'+base.wabaId+'/message_templates',{query:{fields:'id',limit:'100',status:'APPROVED'}})).status,400);
 assert.equal(f.server.transitionState().attempts.filter(a=>a.accepted).length,1);assert.equal(f.server.receipts().length,0);
});
