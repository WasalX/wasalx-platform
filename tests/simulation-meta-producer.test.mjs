import test from'node:test';import assert from'node:assert/strict';import{assertMetaRuntimeBinding}from'../scripts/release/simulation-meta-producer.mjs';import{createMetaCallbacks,privateConfigPath,assertMetaSignupFixtureBinding,metaCoexistenceFixtureModes,controlApiCoreAddress}from'../scripts/release/simulation-meta-runtime.mjs';import{runMetaTextVertical}from'../scripts/release/simulation-meta-text.mjs';
import{mkdtemp,writeFile,rm,realpath}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{inspect}from'node:util';
const binding={project:'wasalx-simulation-unit',tenantId:'t',connectionId:'c',phoneId:'10001',wabaId:'10002',graphContainerId:'container',graphImageDigest:'sha256:'+'a'.repeat(64),graphSourceSha256:'b'.repeat(64),controlSocket:'/private/graph.sock'},session={model:{name:binding.project},tenantId:'t'},callbacks={binding,cfg:{binding:{phoneId:'10001',wabaId:'10002'}}};
test('Meta fixture binds every admitted runtime identity',()=>{assertMetaRuntimeBinding({connectionId:'c',runtimeBinding:binding},callbacks,session);for(const key of Object.keys(binding))assert.throws(()=>assertMetaRuntimeBinding({connectionId:'c',runtimeBinding:{...binding,[key]:'wrong'}},callbacks,session),/mismatch/);});
test('private filename parameter cannot escape root',()=>{assert(privateConfigPath('/private','meta/driver.json').endsWith('driver.json'));assert.throws(()=>privateConfigPath('/private','../elsewhere'));});
test('durable ingress persistence failure prevents external dispatch',async()=>{let sends=0;await assert.rejects(runMetaTextVertical({runId:'fresh',binding:{phoneId:'10001',wabaId:'10002',customer:'12025550106'},token:'token',secret:'synthetic-secret',zammadGroupId:'2',admit:async()=>{},checkpoint:async()=>{},request:async path=>path==='/api/connections'?{id:'c'}:path==='/api/connections/c'?{latest_operation_state:'SUCCEEDED',state:'WORKING'}:path==='/api/bot-flows'?{id:'f',familyId:'family',revision:1}:{assignmentId:'a'},providerRead:async()=>[],postRaw:async()=>sends++,persistInbound:async()=>{throw Error('Persistence denied');}}),/Persistence denied/);assert.equal(sends,0);});

test('missing fields on both sides cannot manufacture runtime proof',()=>{for(const key of Object.keys(binding)){const incomplete={...binding};delete incomplete[key];assert.throws(()=>assertMetaRuntimeBinding({connectionId:'c',runtimeBinding:incomplete},{...callbacks,binding:incomplete},session),/Missing Meta runtime binding/);}});
test('producer settlement uses canonical META observer and revision-bound pause idempotency',async()=>{const fs=await import('node:fs');const s=fs.readFileSync('scripts/release/simulation-meta-runtime.mjs','utf8');assert(s.includes("provider:'META',registry,originalUnknowns,checkpoint"));assert(s.includes('const settlement=await fence.drain()'));assert(s.indexOf('const settlement=await fence.drain()')<s.indexOf('pause-meta-assignment'));assert(s.includes("'pause-meta-assignment-'+a.revision"));assert(!s.includes('DEAD_LETTER'));assert(s.includes('return fence.control({action:'));});

test('fresh Meta ingress selects the admitted core peer regardless of Docker network order',()=>{
 const containers={postgres:{NetworkSettings:{Networks:{core:{IPAddress:'192.0.2.1'}}}},'control-api':{NetworkSettings:{Networks:{connectors:{IPAddress:'192.0.2.1'},core:{IPAddress:'192.0.2.1'},edge:{IPAddress:'192.0.2.1'}}}}};
 assert.equal(controlApiCoreAddress(containers),'192.0.2.1');
 delete containers['control-api'].NetworkSettings.Networks.core;
 assert.throws(()=>controlApiCoreAddress(containers),/share the admitted/);
 containers.postgres.NetworkSettings.Networks.other={IPAddress:'192.0.2.1'};
 assert.throws(()=>controlApiCoreAddress(containers),/unambiguous/);
});
const privateMarkers=['SYNTHETIC_META_TOKEN_PRIVATE','SYNTHETIC_META_APP_SECRET_PRIVATE','SYNTHETIC_META_CODE_PRIVATE'];
function safeAdmissionError(error,phase,checkpoints){
 const serialized=error.message+'\n'+error.stack+'\n'+JSON.stringify(error,Object.getOwnPropertyNames(error))+'\n'+inspect(error)+'\n'+JSON.stringify(checkpoints);
 for(const marker of privateMarkers)assert(!serialized.includes(marker));
 assert.equal(error.cause,undefined);assert.equal(error.message,'Meta simulator admission failed ('+phase+'); inspect the owned private prerequisite without replay');return true;
}
test('shared Meta admission redacts an actual private file read failure before callers serialize it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wasalx-meta-admission-')),checkpoints=[];
 try{
  await assert.rejects(createMetaCallbacks({privateDir:dir,checkpoint:async row=>checkpoints.push(row)},
   {privateConfigPath:privateMarkers.join('-')+'.json',graphSourceSha256:'a'.repeat(64),graphImageDigest:'sha256:'+'b'.repeat(64)}),error=>safeAdmissionError(error,'private-config',checkpoints));
  assert.deepEqual(checkpoints,[]);
 }finally{assert.equal(await realpath(dir),dir);await rm(dir,{recursive:true});}
});

const signupNow=1_800_000_000_000;
function signupBindingFixture(mode){
 const signup={businessId:'10004',userId:'10005',configId:'10006',appId:'10003',phoneId:'10001',wabaId:'10002',displayPhoneNumber:'15555550300',origin:'http://127.0.0.1:3000',graphVersion:'v24.0'};
 if(Object.hasOwn(metaCoexistenceFixtureModes,mode)){
  const [contacts,history]=metaCoexistenceFixtureModes[mode];
  Object.assign(signup,{mode,businessAppConfigId:'10007',coexistence:{onboardedAt:signupNow/1000-(mode==='coex-expired'?86401:60),contacts,history}});
  if(mode==='coex-renewal')signup.reauthorizationToken=privateMarkers[2];
 }
 const cfg={signup,appId:signup.appId,binding:{phoneId:signup.phoneId,wabaId:signup.wabaId},token:privateMarkers[0],appSecret:privateMarkers[1]};
 const fixture={businessId:signup.businessId,userId:signup.userId,...(signup.coexistence?{coexistence:signup.coexistence}:{}),...(signup.reauthorizationToken?{reauthorizationToken:signup.reauthorizationToken}:{})};
 const graph={META_SIM_APP_ID:cfg.appId,META_SIM_APP_SECRET:cfg.appSecret,META_SIM_TOKEN:cfg.token,META_SIM_PHONE_ID:signup.phoneId,META_SIM_WABA_ID:signup.wabaId,META_SIM_PHONE:signup.displayPhoneNumber,META_SIM_VERSION:'v24.0',META_SIM_SIGNUP_FIXTURE:JSON.stringify(fixture)};
 const env={META_SIGNUP_ENABLED:'true',META_SIGNUP_CUSTOMER_CONFIG_ID:signup.configId,META_APP_ID:signup.appId,META_GRAPH_VERSION:'v24.0',PORTAL_PUBLIC_ORIGIN:signup.origin,META_APP_SECRET_REFERENCE:'secret://platform/meta-webhook',NODE_EXTRA_CA_CERTS:'/simulation-ca/ca.pem',...(signup.coexistence?{META_COEXISTENCE_ENABLED:'true',META_SIGNUP_BUSINESS_APP_CONFIG_ID:signup.businessAppConfigId}:{})};
 return{cfg,graph,consumers:[{...env},{...env}]};
}
test('signup admission binds standard or one exact finite coexistence fixture without changing the input',()=>{
 assert.equal(assertMetaSignupFixtureBinding({},undefined,{},[]),false);
 for(const mode of ['happy',...Object.keys(metaCoexistenceFixtureModes)]){
  const f=signupBindingFixture(mode),before=structuredClone(f);
  assert.equal(assertMetaSignupFixtureBinding(f.cfg,mode,f.graph,f.consumers,signupNow),mode!=='happy');
  assert.deepEqual(f,before);
 }
});
test('coexistence admission rejects altered modes, time, credentials, graph or either consumer with safe diagnostics',()=>{
 const changes=[
  f=>{delete f.cfg.signup.coexistence;},f=>{f.cfg.signup.mode='coex-success';},
  f=>{f.cfg.signup.businessAppConfigId=f.cfg.signup.configId;},
  f=>{f.cfg.signup.coexistence.onboardedAt=signupNow/1000+1;},
  f=>{f.cfg.signup.coexistence.onboardedAt=signupNow/1000-86400;},
  f=>{f.cfg.signup.coexistence.contacts='ACCEPT';},
  f=>{f.cfg.signup.coexistence.unreviewed=true;},
  f=>{delete f.cfg.signup.reauthorizationToken;},f=>{f.cfg.signup.reauthorizationToken=f.cfg.token;},
  f=>{f.graph.META_SIM_SIGNUP_FIXTURE='{'+privateMarkers.join('-');},
  f=>{const x=JSON.parse(f.graph.META_SIM_SIGNUP_FIXTURE);x.reauthorizationToken='foreign-synthetic-renewal-token';f.graph.META_SIM_SIGNUP_FIXTURE=JSON.stringify(x);},
  f=>{delete f.cfg.token;delete f.graph.META_SIM_TOKEN;},f=>{delete f.cfg.appSecret;delete f.graph.META_SIM_APP_SECRET;},
  f=>{f.graph.META_SIM_APP_SECRET='foreign-synthetic-secret';},
  f=>{f.graph.META_SIM_TOKEN='foreign-synthetic-token';},
  f=>{f.graph.META_SIM_PHONE_ID='99999';},f=>{f.graph.META_SIM_VERSION='v23.0';},
  f=>{f.consumers[0].META_SIGNUP_BUSINESS_APP_CONFIG_ID='99999';},
  f=>{f.consumers[1].META_COEXISTENCE_ENABLED='false';},
  f=>{f.consumers[1].META_SIGNUP_CUSTOMER_CONFIG_ID='99999';},
  f=>{f.consumers[1].META_APP_SECRET_REFERENCE='secret://foreign/meta';},
 ];
 for(const change of changes){
  const f=signupBindingFixture('coex-renewal');change(f);
  assert.throws(()=>assertMetaSignupFixtureBinding(f.cfg,'coex-renewal',f.graph,f.consumers,signupNow),error=>{
   const serialized=error.message+'\n'+error.stack+'\n'+JSON.stringify(error,Object.getOwnPropertyNames(error))+'\n'+inspect(error);
   for(const marker of privateMarkers)assert(!serialized.includes(marker));return true;
  });
 }
 const expired=signupBindingFixture('coex-expired');expired.cfg.signup.coexistence.onboardedAt=signupNow/1000-86399;
 assert.throws(()=>assertMetaSignupFixtureBinding(expired.cfg,'coex-expired',expired.graph,expired.consumers,signupNow));
 const standard=signupBindingFixture('happy');assert.throws(()=>assertMetaSignupFixtureBinding(standard.cfg,'coex-success',standard.graph,standard.consumers,signupNow));
 assert.throws(()=>assertMetaSignupFixtureBinding({},'coex-success',{},[],signupNow));
});
for(const fault of ['private-json','token-binding'])test(`shared Meta ${fault} admission failure has static diagnostics only`,{skip:process.platform==='win32'?'POSIX private-file ownership admission requires Linux':false},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wasalx-meta-admission-')),checkpoints=[];
 try{
  const cfg={project:'wasalx-simulation-redaction',evidenceMode:'simulated',tenantId:'owned',binding:{customer:'15555550990',phoneId:'10001',wabaId:'10002'},graphSourceSha256:'a'.repeat(64),graphImageDigest:'sha256:'+'b'.repeat(64),graphService:'meta-graph',controlSocket:dir+'/control.sock',appSecret:privateMarkers[1],token:privateMarkers[0]};
  await writeFile(join(dir,'config.json'),fault==='private-json'?JSON.stringify({token:privateMarkers[0],appSecret:privateMarkers[1],code:privateMarkers[2]}).slice(0,-1):JSON.stringify(cfg),{mode:0o600});
  const model={name:cfg.project,services:{'meta-graph':{ports:[],environment:{META_SIM_GROUPS_FIXTURE:'eligible-empty',META_SIM_PHONE_ID:cfg.binding.phoneId,META_SIM_WABA_ID:cfg.binding.wabaId,META_SIM_RECIPIENTS:JSON.stringify([cfg.binding.customer]),META_SIM_TOKEN:privateMarkers[2]}}}};
  await assert.rejects(createMetaCallbacks({privateDir:dir,tenantId:cfg.tenantId,model,checkpoint:async row=>checkpoints.push(row),run:async()=>assert.fail('No runtime action before admission')},
   {privateConfigPath:'config.json',customer:cfg.binding.customer,graphSourceSha256:cfg.graphSourceSha256,graphImageDigest:cfg.graphImageDigest}),error=>safeAdmissionError(error,fault==='private-json'?'private-config':'graph-binding',checkpoints));
  assert.deepEqual(checkpoints,[]);
 }finally{assert.equal(await realpath(dir),dir);await rm(dir,{recursive:true});}
});
