import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sha,assertCommittedTarget,assertNoReplay,assertStageAttempts,assertCompletedSource,assertSourceReadback,originalIntent,assertIntentReadback,transitionProbeMode} from '../scripts/release/meta-transition-dev-contract.mjs';
import {verifyTransitionDriverClosure} from '../scripts/release/meta-transition-dev-entry.mjs';
const id=n=>'30000000-0000-4000-8000-'+String(n).padStart(12,'0'),digest='a'.repeat(64),plan=id(1),connection=id(2);
const m={tenantId:id(3),ownerId:id(4),candidate:{sha:'b'.repeat(40),tree:'c'.repeat(40)},fixture:{signup:{phoneId:'10001',wabaId:'20001',appId:'30001'}},p09:{requestedMode:'CUSTOMER',targetCurrency:'EUR',sourceSignup:{runId:'original',manifestSha256:digest}}};
const source=()=>({evidenceMode:'simulated',mode:'happy',runId:'original',manifestSha256:digest,candidate:m.candidate,proof:{status:'COMPLETED',attemptId:id(5),operationId:id(6),connectionId:connection,operationState:'SUCCEEDED',codeConsumptions:1}});
const current=()=>({tenantId:m.tenantId,phoneId:'10001',appId:'30001',connection:{id:connection,provider:'META',state:'WORKING'},plan:{id:plan,executionState:'RECONCILED_PAUSED',providerStatus:'COMPLETED',identityClaim:'SAME_GRAPH_PHONE_ACCOUNT_SUCCESSOR',targetCurrency:'EUR',requestedMode:'CUSTOMER',targetAccountId:id(7),targetProviderAccountId:'40001'},checkpoints:[],bindings:[{id:id(8),state:'RETIRED',providerAccountId:'20001',phoneId:'10001',appId:'30001'},{id:id(9),accountId:id(7),state:'ACTIVE',providerAccountId:'40001',phoneId:'10001',appId:'30001',transitionId:plan,predecessorId:id(8),sessionOwnership:'ACTIVE',sessionState:'WORKING',sessionWaba:'40001',proofWaba:'40001',proofPhone:'10001'}]});
test('signed target callback only follows actual committed target binding',()=>{
 assert.equal(assertCommittedTarget(current(),m,connection,plan).providerAccountId,'40001');
 for(const mutate of [r=>r.connection.state='PAUSED',r=>r.plan.providerStatus='READY_TO_COMPLETE',r=>r.plan.identityClaim=null,r=>r.bindings[1].state='RETIRED',r=>r.bindings[1].sessionWaba='20001',r=>r.bindings[1].proofPhone='99999',r=>r.bindings[0].state='ACTIVE',r=>r.bindings[1].transitionId=id(20)]){const row=current();mutate(row);assert.throws(()=>assertCommittedTarget(row,m,connection,plan));}
});
test('retained completed producer never grants authority from artifact alone',()=>{
 const p=assertCompletedSource(source(),m);const row={connection:{state:'WORKING'},signup:{id:p.attemptId,status:'COMPLETED',requestedBy:m.ownerId,connectionId:connection,operationId:p.operationId,exchangeClaimed:true,credentialStored:true,registrationClaimed:true,operationState:'SUCCEEDED',operationType:'PROVISION',operationLease:null,signupReady:true},bindings:[{state:'ACTIVE',providerAccountId:'20001',phoneId:'10001',appId:'30001',sessionOwnership:'ACTIVE',sessionState:'WORKING',proofPhone:'10001',proofWaba:'20001',signupAttemptId:p.attemptId,routeState:'ACTIVE'}]};assertSourceReadback(row,m,p);
 for(const [key,value] of [['status','OUTCOME_UNKNOWN'],['requestedBy',id(20)],['operationLease',id(20)],['registrationClaimed',false],['signupReady',false]]){const bad=structuredClone(row);bad.signup[key]=value;assert.throws(()=>assertSourceReadback(bad,m,p));}
 const paused=structuredClone(row);paused.bindings[0].routeState='PAUSED';assert.throws(()=>assertSourceReadback(paused,m,p));
 for(const mutate of [r=>r.candidate={...m.candidate,tree:'d'.repeat(40)},r=>r.proof.status='OUTCOME_UNKNOWN',r=>r.proof.codeConsumptions=2,r=>r.manifestSha256='d'.repeat(64)]){const r=source();mutate(r);assert.throws(()=>assertCompletedSource(r,m));}
});
test('unknown source checkpoint and acceptance count cannot be upgraded by GET',()=>{
 const before={checkpoints:[{id:id(10),stage:'INITIATE',outcome:'UNKNOWN',operationId:id(11),requestSha256:digest}],provider:{attempts:[{sequence:1,stage:'INITIATE',accepted:true,bodySha256:digest,acceptedAt:Date.now()}],reads:[]}};assertNoReplay(before,structuredClone(before));
 for(const mutate of [r=>r.checkpoints[0].outcome='SUCCEEDED',r=>r.checkpoints[0].operationId=id(21),r=>r.provider.attempts.push({accepted:true}),r=>r.provider.attempts.push({accepted:false,stage:'INITIATE'}),r=>r.provider.attempts[0].bodySha256='f'.repeat(64),r=>r.provider.attempts[0].acceptedAt++]){const after=structuredClone(before);mutate(after);assert.throws(()=>assertNoReplay(before,after));}
});
test('original UI command correlation rejects changed key/revision/action',()=>{
 const intent=originalIntent({key:id(12),planId:plan,action:'initiate',body:{expectedRevision:2,expectedPreviewSha256:digest}}),view={execution:{pendingAction:{requestKey:intent.key,action:'INITIATE',requestRevision:2,operationId:id(13)}}};assertIntentReadback(intent,view);
 for(const [key,value] of [['requestKey',id(22)],['requestRevision',3],['action','COMPLETE'],['operationId','fake']]){const bad=structuredClone(view);bad.execution.pendingAction[key]=value;assert.throws(()=>assertIntentReadback(intent,bad));}
 assert.throws(()=>originalIntent({...intent,body:{...intent.body,replay:true}}));
});
test('P09 inert health probe uses only installed admitted renewable fixture',()=>{
 assert.equal(transitionProbeMode({}, {},null),'ORIGINAL');const installed={renewalToken:'synthetic-renewal-credential'},bound={p09:{fixtureSha256:sha(JSON.stringify(installed))}};
 assert.equal(transitionProbeMode(bound,{transitionFixture:installed,token:'synthetic-original'},installed),'TRANSITION_RENEWED');
 for(const [cfg,value] of [[{transitionFixture:installed,token:installed.renewalToken},installed],[{transitionFixture:{...installed,foreign:true},token:'original'},installed],[{transitionFixture:installed,token:'original'},null]])assert.throws(()=>transitionProbeMode(bound,cfg,value));
});
test('entry denies missing/rebound source closure before remote guest import',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'p09-inert-'));try{const path=join(dir,'manifest.json'),bytes=JSON.stringify({p09:{driverFiles:[]}});await writeFile(path,bytes);await assert.rejects(verifyTransitionDriverClosure(path,sha(bytes)),/DRIVER_CLOSURE/);}finally{await rm(dir,{recursive:true,force:true});}
});

test('happy and partial stages preserve every original POST attempt while GET reads may grow',()=>{
 const initiation={sequence:1,stage:'INITIATE',accepted:true,bodySha256:digest,acceptedAt:Date.now(),path:'/v24.0/20001/initiate_credit_currency_migration',responseMode:'SUCCESS'};
 const completion={...initiation,sequence:2,stage:'COMPLETE',path:'/v24.0/sim_currency_clone_01/complete_credit_currency_migration'};
 const first=assertStageAttempts({attempts:[initiation]},['INITIATE']);
 const both=assertStageAttempts({attempts:[initiation,completion]},['INITIATE','COMPLETE'],first);
 assert.equal(both.length,2);
 for(const attempts of [[initiation,{...initiation,sequence:2,accepted:false}],[initiation,completion,{...completion,sequence:3,accepted:false}],[{...initiation,bodySha256:'e'.repeat(64)},completion]])assert.throws(()=>assertStageAttempts({attempts},['INITIATE','COMPLETE'],first));
 for(const attempts of [[initiation,{...completion,stage:'INITIATE'}],[{...initiation,accepted:false}]])assert.throws(()=>assertStageAttempts({attempts},attempts.length===1?['INITIATE']:['INITIATE','COMPLETE']));
 for(const stage of ['INITIATE','COMPLETE']){
  const before={checkpoints:[{stage,outcome:'UNKNOWN',requestSha256:digest}],provider:{attempts:stage==='INITIATE'?[initiation]:[initiation,completion],reads:[]}};
  const after=structuredClone(before);after.provider.reads.push({path:'/v24.0/sim_currency_clone_01'});assertNoReplay(before,after);
  after.provider.attempts.push({...completion,sequence:after.provider.attempts.length+1,accepted:false});assert.throws(()=>assertNoReplay(before,after));
 }
});

import {dispatchWithinLease} from '../scripts/release/meta-transition-dev-dispatch.mjs';
import {originalResponse} from '../scripts/release/meta-transition-dev-browser.mjs';
function dispatchFixture(){
 let handler,commandNumber=0;const calls=[],origin='http://127.0.0.1:3000';
 const page={url:()=>origin+'/app',route:async(match,h)=>{handler=h;assert(match(new URL(origin+'/api/connections/action')));assert(!match(new URL(origin+'/api/foreign')));},unroute:async()=>{handler=undefined;}};
 const route=()=>{const sequence=commandNumber,request={method:()=> 'POST',headers:()=>({'idempotency-key':id(12+sequence)}),postDataJSON:()=>({expectedRevision:2+sequence,expectedPreviewSha256:digest})};return{request:()=>request,continue:async()=>{calls.push('POST');},abort:async()=>{calls.push('ABORT');}};};
 const lease=async()=>({validUntil:new Date(Date.now()+30000).toISOString()});
 const input={page,origin,path:'/api/connections/action',lease,ready:async()=>{},dispatch:async()=>{const r=route();commandNumber++;void handler(r);},confirm:async request=>{
  const response=await originalResponse(Promise.resolve({ok:()=>true,request:()=>request,json:async()=>({id:plan,operationId:id(13+2*(request.postDataJSON().expectedRevision-2))})}),request,'ORIGINAL_RESPONSE');
  const admitted=await response.json(),intent=originalIntent({key:request.headers()['idempotency-key'],planId:plan,action:'observe',body:request.postDataJSON()}),readback={execution:{pendingAction:{requestKey:intent.key,action:'OBSERVE',requestRevision:intent.body.expectedRevision,operationId:admitted.operationId,state:'SUCCEEDED'}}};
  assert.equal(admitted.id,plan);assert.equal(readback.execution.pendingAction.operationId,admitted.operationId);assertIntentReadback(intent,readback);return{confirmed:true,reusable:true,value:{dispatched:true,intent}};
 }};
 return{input,calls,page,route,post:()=>handler(route())};
}
test('fresh request-time lease admits exactly one original UI POST and rejects an extra POST',async()=>{
 const f=dispatchFixture();assert.equal((await dispatchWithinLease(f.input)).dispatched,true);assert.deepEqual(f.calls,['POST']);
 await f.post();assert.deepEqual(f.calls,['POST','ABORT']);await assert.rejects(dispatchWithinLease(f.input));assert.equal(f.calls.filter(c=>c==='POST').length,1);
});
test('late actionability or expiry immediately before request causes zero dispatch and no retry',async()=>{
 const f=dispatchFixture();let checks=0,release,waiting,expired=false;const observed=new Promise(r=>waiting=r);
 f.input.ready=async()=>{waiting();await new Promise(r=>release=r);};
 f.input.lease=async()=>({validUntil:new Date(Date.now()+(expired?-1:30000)).toISOString()});
 const pending=dispatchWithinLease(f.input);pending.catch(()=>{});await observed;expired=true;release();
 await assert.rejects(pending);assert.equal(f.calls.filter(c=>c==='POST').length,0);await f.post();assert.equal(f.calls.filter(c=>c==='POST').length,0);
 const g=dispatchFixture();checks=0;g.input.lease=async()=>({validUntil:new Date(Date.now()+(++checks<3?30000:-1)).toISOString()});
 await assert.rejects(dispatchWithinLease(g.input));assert.equal(g.calls.filter(c=>c==='POST').length,0);
});
test('cancelled command cannot dispatch when an awaited request-time lease later resolves',async()=>{
 const f=dispatchFixture();let release,waiting,checks=0;const observed=new Promise(r=>waiting=r);
 f.input.lease=async()=>{if(++checks===3){waiting();return new Promise(r=>release=r);}return{validUntil:new Date(Date.now()+30000).toISOString()};};
 const run=dispatchWithinLease(f.input);run.catch(()=>{});await observed;await f.post();release({validUntil:new Date(Date.now()+30000).toISOString()});
 await assert.rejects(run);assert.equal(f.calls.filter(c=>c==='POST').length,0);await f.post();assert.equal(f.calls.filter(c=>c==='POST').length,0);
});
test('lost dispatch completion is preserved without a second HTTP attempt',async()=>{
 const f=dispatchFixture();f.input.dispatch=async()=>{await f.post();throw Error('Synthetic original response lost');};
 await assert.rejects(dispatchWithinLease(f.input));assert.equal(f.calls.filter(c=>c==='POST').length,1);
 await assert.rejects(dispatchWithinLease(f.input));assert.equal(f.calls.filter(c=>c==='POST').length,1);
});

test('one stable handler remains closed throughout admitted successor preparation',async()=>{
 const f=dispatchFixture();let installs=0,removals=0;const register=f.page.route;
 f.page.route=async(...args)=>{installs++;return register(...args);};f.page.unroute=async()=>{removals++;throw Error('Unroute must not be used for handover');};
 await dispatchWithinLease(f.input);let release,waiting;const prepared=new Promise(r=>waiting=r);
 f.input.ready=async()=>{waiting();await new Promise(r=>release=r);};const successor=dispatchWithinLease(f.input);successor.catch(()=>{});
 await prepared;await f.post();release();await assert.rejects(successor);
 assert.equal(installs,1);assert.equal(removals,0);assert.equal(f.calls.filter(c=>c==='POST').length,1);await f.post();assert.equal(f.calls.filter(c=>c==='POST').length,1);
});
test('request dispatch followed by actual response loss, failure, malformed JSON or mismatch cannot reopen a path',async()=>{
 for(const outcome of ['LOST','FAILED','MALFORMED','MISMATCH','READBACK_MISMATCH']){
  const f=dispatchFixture();f.input.confirm=async request=>{
   const response=outcome==='LOST'?null:{ok:()=>outcome!=='FAILED',request:()=>outcome==='MISMATCH'?f.route().request():request,json:async()=>{if(outcome==='MALFORMED')throw Error('Malformed actual response');return{id:plan,operationId:id(13)};}};
   const actual=await originalResponse(Promise.resolve(response),request,'POST_RESPONSE');const admitted=await actual.json();
   const readback={execution:{pendingAction:{requestKey:id(12),action:'OBSERVE',requestRevision:2,operationId:outcome==='READBACK_MISMATCH'?id(22):id(13)}}};
   assert.equal(readback.execution.pendingAction.operationId,admitted.operationId);return{confirmed:true,reusable:true};
  };
  await assert.rejects(dispatchWithinLease(f.input));assert.equal(f.calls.filter(c=>c==='POST').length,1,outcome);
  await assert.rejects(dispatchWithinLease(f.input));await f.post();assert.equal(f.calls.filter(c=>c==='POST').length,1,outcome);
 }
});
test('only actual correlated response plus original readback permits a repeated observation through the same handler',async()=>{
 const f=dispatchFixture();let installs=0;const register=f.page.route;f.page.route=async(...args)=>{installs++;return register(...args);};
 let finish,waiting;const observed=new Promise(r=>waiting=r),confirm=f.input.confirm;
 f.input.confirm=async request=>{waiting();await new Promise(r=>finish=r);return confirm(request);};
 const original=dispatchWithinLease(f.input);original.catch(()=>{});await observed;
 await assert.rejects(dispatchWithinLease(f.input));assert.equal(f.calls.filter(c=>c==='POST').length,1);
 finish();const result=await original;assert.equal(result.intent.key,id(12));assert.equal(result.intent.body.expectedRevision,2);
 f.input.confirm=confirm;const repeated=await dispatchWithinLease(f.input);assert.equal(repeated.dispatched,true);assert.notEqual(repeated.intent.key,result.intent.key);assert.equal(repeated.intent.body.expectedRevision,3);
 assert.equal(installs,1);assert.equal(f.calls.filter(c=>c==='POST').length,2);
});
test('lease expiry during successor preparation leaves continuous protection and zero new writes',async()=>{
 const f=dispatchFixture();await dispatchWithinLease(f.input);let release,waiting,expired=false;const prepared=new Promise(r=>waiting=r);
 f.input.lease=async()=>({validUntil:new Date(Date.now()+(expired?-1:30000)).toISOString()});f.input.ready=async()=>{waiting();await new Promise(r=>release=r);};
 const successor=dispatchWithinLease(f.input);successor.catch(()=>{});await prepared;expired=true;release();await assert.rejects(successor);
 await f.post();assert.equal(f.calls.filter(c=>c==='POST').length,1);
});
test('durable provider UNKNOWN readback is returned truthfully but original mutation path stays sealed',async()=>{
 const f=dispatchFixture();f.input.confirm=async request=>{await originalResponse(Promise.resolve({ok:()=>true,request:()=>request}),request,'ORIGINAL');return{confirmed:true,reusable:false,value:{outcome:'UNKNOWN'}};};
 assert.deepEqual(await dispatchWithinLease(f.input),{outcome:'UNKNOWN'});await assert.rejects(dispatchWithinLease(f.input));await f.post();assert.equal(f.calls.filter(c=>c==='POST').length,1);
});


test('composed P09 and P11 closures bind all current shared files without widening either inventory', async () => {
 const names=['access-ui.mjs','journeys.mjs','meta-deletion-dev-browser.mjs','meta-deletion-dev-entry.mjs','meta-deletion-dev-fixture.mjs','meta-deletion-dev-guest.mjs','meta-deletion-journey.mjs','meta-transition-dev-browser.mjs','meta-transition-dev-contract.mjs','meta-transition-dev-dispatch.mjs','meta-transition-dev-entry.mjs','meta-transition-dev-guest.mjs','meta-transition-dev-owner.mjs'];
 const files=await Promise.all(names.map(async path=>({path,sha256:sha(await readFile(new URL('../scripts/release/'+path,import.meta.url)))})));
 const hash=path=>files.find(f=>f.path===path).sha256;
 const manifest={guestDriverSha256:hash('meta-transition-dev-entry.mjs'),p09:{driverFiles:files,guestSha256:hash('meta-transition-dev-guest.mjs'),browserSha256:hash('meta-transition-dev-browser.mjs'),contractSha256:hash('meta-transition-dev-contract.mjs'),platformVerifierSha256:hash('meta-deletion-dev-browser.mjs')}};
 const dir=await mkdtemp(join(tmpdir(),'p09-composed-'));
 try {
  const file=join(dir,'manifest.json');const save=async value=>{const bytes=JSON.stringify(value);await writeFile(file,bytes);return sha(bytes);};
  assert.equal((await verifyTransitionDriverClosure(file,await save(manifest))).p09.driverFiles.length,13);
  for(const name of ['meta-transition-dev-contract.mjs','journeys.mjs']){
   const missing=structuredClone(manifest);missing.p09.driverFiles=files.filter(f=>f.path!==name);
   await assert.rejects(verifyTransitionDriverClosure(file,await save(missing)),/DRIVER_CLOSURE/);
  }
  const rebound=structuredClone(manifest);rebound.p09.driverFiles.find(f=>f.path==='meta-transition-dev-guest.mjs').sha256='0'.repeat(64);
  await assert.rejects(verifyTransitionDriverClosure(file,await save(rebound)),/DRIVER_CLOSURE/);
  const {verifyDeletionDriverClosure}=await import('../scripts/release/meta-deletion-dev-entry.mjs');
  const p11Files=files.filter(f=>!f.path.startsWith('meta-transition-dev-')||f.path==='meta-transition-dev-contract.mjs');
  assert.equal(p11Files.length,8);
  const p11={guestDriverSha256:hash('meta-deletion-dev-entry.mjs'),p11:{driverFiles:p11Files,guestModuleSha256:hash('meta-deletion-dev-guest.mjs')}};
  assert.equal((await verifyDeletionDriverClosure(file,await save(p11))).p11.driverFiles.length,8);
  p11.p11.driverFiles=p11Files.filter(f=>f.path!=='meta-deletion-dev-fixture.mjs');
  await assert.rejects(verifyDeletionDriverClosure(file,await save(p11)),/DRIVER_CLOSURE/);
 } finally {await rm(dir,{recursive:true,force:true});}
});
