
import {withLifecycleWorkerGuard} from '../scripts/release/simulation-lifecycle-worker-guard.mjs';
test('lifecycle diagnostic records actual HTTP failure rather than expected assertion text',async()=>{const receipts=[];const worker={workerKey:'spare',engine:'GOWS',lifecycleState:'ACTIVE',healthState:'HEALTHY',assignedSessions:0,capacity:1};await assert.rejects(withLifecycleWorkerGuard({workerKey:'spare',runId:'fixture-run',operatorSubject:'synthetic',request:async()=>[worker],census:async()=>({activeLeases:0,pendingEffects:0,pendingConnectionOperations:0,lanesPaused:true,originalAssignments:[]}),audit:async()=>{},checkpoint:async p=>receipts.push(p),scenario:async()=>{assert.match('operation: HTTP 500; redacted',/HTTP 409/);}}),AggregateError);assert.equal(receipts.find(p=>p.phase==='lifecycle-guard-failure').diagnostic.httpStatus,500);assert.equal(receipts.at(-1).phase,'worker-guard-finished')});
const ref='sha256:'+'a'.repeat(64),ownerBinding={role:'tenant_owner',locale:'en',actorRef:ref,tenantRef:ref,viewport:{width:1440,height:1000},verifiedAt:'2026-09-12T00:00:00.000Z'};
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';


import { lifecycleChecks, lifecycleResults, platformQualityForLifecycle } from '../scripts/release/simulation-lifecycle-stage.mjs';
import {platformIsolationQualityIds} from '../scripts/release/simulation-platform-isolation-quality.mjs';
import {assertReconnectCensus} from '../scripts/release/simulation-reconnect-census.mjs';



test('nine exact lifecycle checks require each phase on the same connection',()=>{const packet={evidenceMode:'simulated',startedAt:'2026-09-12T00:00:00.000Z',connectionId:'current',proofs:[...new Set(lifecycleChecks.map(x=>x[1]))].map(phase=>({phase,connectionId:'current',observedAt:'2026-09-12T00:00:01.000Z',...(phase==='qr'?{qrNotice:{actualApiGet:true}}:{}),...(phase==='start'?{failedStartRecovery:{terminalProviderState:'WORKING'}}:{})}))};assert.equal(lifecycleResults(packet,ownerBinding).length,9);packet.proofs[0].connectionId='old';assert.throws(()=>lifecycleResults(packet,ownerBinding));packet.proofs=[];assert.throws(()=>lifecycleResults(packet,ownerBinding));});
test('q095 skips only hash-bound q094 platform quality while ordinary lifecycle retains all eight',()=>{const r={namespace:'fresh399-8117-v5-q094',outcomes:{passed:10,failed:1,blocked:0,unexecuted:69},terminalPlatformQualityIds:platformIsolationQualityIds,monitorSha256:'5798c1d90ce516b99f14197cbbce3de292a82baa4721200e276bd498594b7f85',resultSha256:'4a8d3c04dc2807a7098e33aa0723d7d53e9b0593ab6f4089257d612e4e399883',intentsSha256:'990cb5cd4b733a413bd37a38bbb71e667db4e5207e95742a00e9380a8beda44c',settledCommand:{outboxId:'53df22e9-ae06-4d45-b191-9546a166a03d',state:'SENT',attempts:1,receiptNumber:29}};assert.deepEqual(platformQualityForLifecycle({},'ordinary'),platformIsolationQualityIds);assert.deepEqual(platformQualityForLifecycle({retainedQ094:r},'fresh399-8117-v5-q095'),[]);assert.throws(()=>platformQualityForLifecycle({retainedQ094:{...r,monitorSha256:'0'.repeat(64)}},'fresh399-8117-v5-q095'));assert.deepEqual(platformQualityForLifecycle({retainedQ094:r},'fresh399-8117-v5-q096'),[]);assert.deepEqual(platformQualityForLifecycle({retainedQ094:r},'fresh399-8117-v5-q097'),[]);assert.deepEqual(platformQualityForLifecycle({retainedQ094:r},'fresh399-8117-v5-q098'),[]);assert.throws(()=>platformQualityForLifecycle({retainedQ094:r},'fresh399-8117-v5-q094'));assert.throws(()=>platformQualityForLifecycle({retainedQ094:{...r,settledCommand:{...r.settledCommand,receiptNumber:30}}},'fresh399-8117-v5-q096'));});
test('restart census rejects duplicate consumer and changed active session',()=>{const before={sessions:[{id:'s'}],worker:{assignedSessions:1,healthState:'HEALTHY'},consumerIds:['one'],pendingOperations:0,originalAssignments:[{id:'other'}]};assertReconnectCensus(before,structuredClone(before));const duplicate=structuredClone(before);duplicate.consumerIds.push('two');assert.throws(()=>assertReconnectCensus(before,duplicate));const wrong=structuredClone(before);wrong.sessions[0].id='new';assert.throws(()=>assertReconnectCensus(before,wrong));});
test('no historical connection prerequisite and terminal stage retains uncertain fixture guard',()=>{const s=readFileSync('scripts/release/simulation-lifecycle.mjs','utf8');assert(!s.includes('7efc66e3'));assert(!s.includes('oldId'));assert(s.includes("'wx',0o600"));assert(s.includes('assertReconnectCensus(beforeRestart,afterRestart)'));const stage=readFileSync('scripts/release/simulation-lifecycle-stage.mjs','utf8');assert(stage.includes('finally{if(session.capabilities.reviewFixture)await session.capabilities.reviewFixture.verifyReadOnly();}'));});
import {assertSpareCleanup,assertLifecycleQrNotice,observeLifecycleQrExpiry,assertFailedStartRecovery,observeFailedLifecycleStart,readLifecycleProviderSummary} from '../scripts/release/simulation-lifecycle.mjs';
import {runInNewContext} from 'node:vm';
test('lifecycle provider readback binds the owned dynamic session, not its startup placeholder',async()=>{
 const expected='created-session',scoped=async(sql,params)=>{assert.match(sql,/ownership_state='ACTIVE'/);assert.deepEqual(params,['owned']);return[{opaque_session_id:expected}];};
 for(const rows of [[{name:expected,status:'STARTING'}],[{name:'lifecycle-unprovisioned',status:'STARTING'}],[],[{name:expected,status:'STARTING'},{name:'foreign',status:'WORKING'}]]){
  const run=async(command,args)=>{assert.equal(command,'docker');assert.deepEqual(args.slice(0,-2),['compose','exec','-T','waha-lifecycle','node','-e']);assert.equal(args.at(-1),expected);let output='';await runInNewContext(args.at(-2),{AbortSignal,fetch:async(url,options)=>{assert.equal(url,'http://127.0.0.1:3000/api/sessions');assert.equal(options.headers['x-api-key'],'private-key');return{ok:true,json:async()=>rows};},process:{argv:['node',args.at(-1)],env:{WAHA_API_KEY:'private-key',WAHA_SIM_SESSION:'lifecycle-unprovisioned'},stdout:{write:value=>{output+=value;}}}});return output;};
  const result=await readLifecycleProviderSummary({connectionId:'owned',scoped,run,dc:['compose']});assert.equal(result.count,rows.length);assert.equal(result.identityMatched,rows.length===1&&rows[0].name===expected);assert(!JSON.stringify(result).includes(expected));assert(!JSON.stringify(result).includes('private-key'));
 }
 for(const sessions of [[],[{opaque_session_id:''}],[{opaque_session_id:expected},{opaque_session_id:'foreign'}]])await assert.rejects(readLifecycleProviderSummary({connectionId:'owned',scoped:async()=>sessions,run:async()=>assert.fail('Ambiguous identity must stop before provider read'),dc:[]}));
});
test('QR notice preserves PostgreSQL Date milliseconds and rejects unequal timestamps',()=>{
 const issuedAt='2026-10-03T06:00:00.123Z',expiresAt='2026-10-03T06:00:20.123Z';
 const api={sequence:2,issuedAt,expiresAt,expired:false,hasImage:true},ui={expiresAt,title:'6:00:20 AM',notice:'QR code refreshed. It expires at 6:00:20 AM.',expiredVisible:false};
 for(const timestamp of [issuedAt,new Date(issuedAt)]){
  const session={provider_state:'SCAN_QR_CODE',provider_state_data:{qrSequence:2},last_provider_status_at:timestamp};
  assert.equal(assertLifecycleQrNotice(api,session,ui,{sequence:2}).noticeMatches,true);
  assert.throws(()=>assertLifecycleQrNotice(api,{...session,last_provider_status_at:new Date(Date.parse(issuedAt)+1)},ui,{sequence:2}));
 }
});
test('QR notice proof binds the provider sequence/time, API expiry and current UI without retaining QR data',()=>{
 const session={provider_state:'SCAN_QR_CODE',provider_state_data:{qrSequence:2},last_provider_status_at:'2026-10-03T06:00:00.000Z'},api={sequence:2,issuedAt:session.last_provider_status_at,expiresAt:'2026-10-03T06:00:20.000Z',expired:false,hasImage:true},ui={expiresAt:api.expiresAt,title:'6:00:20 AM',notice:'QR code refreshed. It expires at 6:00:20 AM.',expiredVisible:false},options={sequence:2,previousIssuedAt:'2026-10-03T05:59:59.000Z'};
 assert.equal(assertLifecycleQrNotice(api,session,ui,options).noticeMatches,true);
 assert.throws(()=>assertLifecycleQrNotice(api,session,{...ui,notice:'QR code refreshed. It expires at 5:59:00 AM.'},options));
 assert.throws(()=>assertLifecycleQrNotice(api,session,{...ui,expiresAt:'2026-10-03T05:59:00.000Z'},options));
 assert.throws(()=>assertLifecycleQrNotice(api,session,ui,{...options,previousIssuedAt:api.issuedAt}));
 assert.throws(()=>assertLifecycleQrNotice(api,{...session,provider_state_data:{qrSequence:1}},ui,options));
 assert.throws(()=>assertLifecycleQrNotice({...api,expiresAt:'2026-10-03T06:01:00.000Z'},session,ui,options));
 const expired={...api,expired:true,hasImage:false},expiredUi={expiresAt:null,title:null,notice:'A fresh QR code is not ready yet. WasalX will keep checking automatically.',expiredVisible:true};
 assert.equal(assertLifecycleQrNotice(expired,session,expiredUi,{sequence:2,expired:true}).expired,true);
 assert.throws(()=>assertLifecycleQrNotice(expired,session,{...expiredUi,notice:ui.notice},{sequence:2,expired:true}));
 const thirdSession={...session,provider_state_data:{qrSequence:3},last_provider_status_at:'2026-10-03T06:00:21.000Z'},third={...api,sequence:3,issuedAt:thirdSession.last_provider_status_at,expiresAt:'2026-10-03T06:00:41.000Z'},thirdUi={...ui,expiresAt:third.expiresAt,title:'6:00:41 AM',notice:'QR code refreshed. It expires at 6:00:41 AM.'};
 assert.equal(assertLifecycleQrNotice(third,thirdSession,thirdUi,{sequence:3,previousIssuedAt:api.issuedAt}).noticeMatches,true);
});
test('QR observer follows real-response method boundaries, catches expiry during checkpoint work and rejects final actor drift',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');
 try{for(const drift of [false,true,'late']){
  const listeners=new Set(),records=[];let sequence=1,expired=false,verifications=0,session={provider_state:'SCAN_QR_CODE',provider_state_data:{qrSequence:1},last_provider_status_at:new Date(Date.now()-(drift==='late'?40000:0)).toISOString()};
  const api=()=>({sequence,issuedAt:session.last_provider_status_at,expiresAt:new Date(Date.parse(session.last_provider_status_at)+(sequence===1?60000:20000)).toISOString(),expired,imageDataUrl:expired?null:'private-qr-image'});
  const ui=()=>{const a=api();return{expiresAt:expired?null:a.expiresAt,title:expired?null:'expiry-'+sequence,notice:expired?'A fresh QR code is not ready yet. WasalX will keep checking automatically.':'QR code refreshed. It expires at expiry-'+sequence+'.',expiredVisible:expired};};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:selector=>{const view=ui();if(selector==='.connection-detail-qr-expiry time')return view.expiresAt?{dateTime:view.expiresAt,title:view.title}:null;if(selector==='.connection-detail-qr-expired')return expired?{}:null;return{textContent:view.notice};}}});
  const emit=method=>{const value=api(),response={url:()=> 'http://127.0.0.1/api/connections/owned/auth/qr',request:()=>({method:()=>method}),status:()=>200,finished:async()=>null,json:async()=>value};for(const listener of listeners)listener(response);};
  const page={on:(_event,listener)=>listeners.add(listener),off:(_event,listener)=>listeners.delete(listener),getByRole:(_role,{name})=>({click:async()=>{assert.equal(name,sequence===3?'Check for a new QR code':'Refresh QR code');emit('POST');emit('GET');}}),waitForFunction:async(fn,arg)=>assert(fn(arg)),evaluate:async fn=>fn()};
  const run=()=>observeLifecycleQrExpiry({page,connectionId:'owned',portalOrigin:'http://127.0.0.1',readSession:async()=>session,poll:async fn=>{const value=await fn();assert(value);return value;},eventId:n=>'event-'+n,control:async({input})=>{sequence++;expired=false;session={...session,provider_state_data:{qrSequence:sequence,eventId:input.eventId},last_provider_status_at:new Date(Date.parse(session.last_provider_status_at)+25000).toISOString()};return{eventId:input.eventId,bodySha256:'a'.repeat(64),results:[{status:202,outcome:'http-response'}]};},checkpoint:async row=>{records.push(row);if(row.phase==='qr-notice-replaced'&&row.sequence===2){expired=true;emit('GET');}},verifyOwner:async()=>({...ownerBinding,viewport:drift&&++verifications===2?{width:820,height:1180}:ownerBinding.viewport})});
  if(drift==='late'){await assert.rejects(run(),/Infrastructure timing/);assert.equal(sequence,2);assert.equal(records.filter(row=>row.phase==='qr-replacement-intent').length,1);}else if(drift)await assert.rejects(run(),/actor or viewport changed/);else{const result=await run();assert.equal(result.observations.length,4);assert.equal(result.freshNoticeMatches,true);assert.equal(JSON.stringify(result).includes('private-qr-image'),false);assert(records.some(row=>row.phase==='qr-notice-expired'));}
  assert.equal(listeners.size,0);
 }}finally{if(original)Object.defineProperty(globalThis,'document',original);else delete globalThis.document;}
});
test('FAILED Start proof rejects a completed no-op, mismatched operation or still-failed provider',()=>{
 const operation={id:'operation',connection_id:'owned',operation_type:'START',idempotency_key:'key',payload:{requestedFromState:'FAILED'},state:'SUCCEEDED',lease_id:null,lease_expires_at:null},detail={latest_operation_id:'operation',latest_operation_type:'START',latest_operation_state:'SUCCEEDED',state:'CONNECTING',provider_state:'STARTING',webhook_state:'ACTIVE'},provider={count:1,identityMatched:true,status:'STARTING'},expected={operationId:'operation',connectionId:'owned',idempotencyKey:'key'};
 assert.equal(assertFailedStartRecovery(operation,detail,provider,expected).singleOperation,true);
 for(const change of [{id:'other'},{payload:{requestedFromState:'PAUSED'}},{lease_id:'held'},{state:'FAILED_TERMINAL'}])assert.throws(()=>assertFailedStartRecovery({...operation,...change},detail,provider,expected));
 assert.throws(()=>assertFailedStartRecovery(operation,{...detail,provider_state:'FAILED'},provider,expected));assert.throws(()=>assertFailedStartRecovery(operation,detail,{...provider,status:'FAILED'},expected));
});
test('FAILED Start observer uses one real UI intent and reconciled operation; ambiguous acceptance never clicks again',async()=>{
 for(const outcome of ['recovered','still-failed','unknown']){
  const id='11111111-1111-4111-8111-111111111111',listeners=new Set(),records=[],titles=[];let handler,clicked=0;
  const page={route:async(_url,fn)=>{handler=fn;},unroute:async()=>{handler=null;},on:(_event,fn)=>listeners.add(fn),off:(_event,fn)=>listeners.delete(fn),getByRole:(_role,{name})=>{assert.equal(name,'Start');return{isEnabled:async()=>true,click:async()=>{clicked++;await handler({request:()=>({method:()=> 'POST',headers:()=>({'idempotency-key':'key'})}),continue:async()=>{if(outcome==='unknown')throw Error('Unknown acceptance; reconcile');for(const fn of listeners)fn({url:()=> 'http://127.0.0.1/api/connections/owned/start',request:()=>({method:()=> 'POST'}),status:()=>202,finished:async()=>null,json:async()=>({operation:{id,type:'START'},duplicate:false})});},abort:async()=>{throw Error('Unknown acceptance; reconcile');}});}};}};
  const operation={id,connection_id:'owned',operation_type:'START',idempotency_key:'key',payload:{requestedFromState:'FAILED'},state:'SUCCEEDED',lease_id:null,lease_expires_at:null},detail={latest_operation_id:id,latest_operation_type:'START',latest_operation_state:'SUCCEEDED',state:'CONNECTING',provider_state:'STARTING',webhook_state:'ACTIVE'};
  const run=()=>observeFailedLifecycleStart({page,connectionId:'owned',portalOrigin:'http://127.0.0.1',eventId:'event',control:async()=>({eventId:'event',results:[{status:202,outcome:'http-response'}]}),read:async()=>clicked?detail:{state:'FAILED',provider_state:'FAILED'},poll:async fn=>{const value=await fn();assert(value);return value;},scoped:async sql=>sql.includes('provider_sessions')?[{provider_state_data:{eventId:'event'}}]:sql.includes('AS count')?[{count:0}]:[operation],checkpoint:async row=>records.push(row),providerRead:async()=>({count:1,identityMatched:true,status:outcome==='still-failed'?'FAILED':'STARTING'}),ui:async title=>titles.push(title),verifyOwner:async()=>ownerBinding});
  if(outcome==='recovered'){const proof=await run();assert.equal(proof.providerState,'STARTING');assert.deepEqual(titles,['Connection failed','Connecting to WhatsApp']);assert(records.some(row=>row.phase==='failed-start-recovered'));}else await assert.rejects(run());
  assert.equal(clicked,1);assert.equal(handler,null);assert.equal(listeners.size,0);assert.equal(records.filter(row=>row.phase==='failed-start-dispatch-intent').length,1);
 }
});








test('spare disable requires confirmed activation, idle census and unchanged mode/config audit',()=>{const ownedActivation={workerKey:'spare',rolloutMode:'STABLE',configurationDigest:'same'},spare={workerKey:'spare',rolloutMode:'STABLE',lifecycleState:'ACTIVE',assignedSessions:0},census={activeLeases:0,pendingEffects:0,pendingConnectionOperations:0},audit={configurationDigest:'same',modeEvents:[]};assertSpareCleanup({ownedActivation,spare,census,audit});for(const key of Object.keys(census))assert.throws(()=>assertSpareCleanup({ownedActivation,spare,census:{...census,[key]:1},audit}));assert.throws(()=>assertSpareCleanup({spare,census,audit}));assert.throws(()=>assertSpareCleanup({ownedActivation,spare,census,audit:{...audit,modeEvents:[{}]}}));});

test('mapped lifecycle executions reject missing actual observation timestamps',()=>{assert.throws(()=>lifecycleResults({evidenceMode:'simulated',connectionId:'x',proofs:[{phase:'qr',connectionId:'x'}]},ownerBinding));});







test('spare nickname observer completes and checkpoints before restart and retirement',()=>{const s=readFileSync('scripts/release/simulation-lifecycle.mjs','utf8');assert(s.indexOf('await crossConnectionNickname(')<s.indexOf('const beforeRestart='));assert(s.indexOf("phase:'spare-cross-connection-complete'")<s.indexOf("for(const action of ['pause','start'])"));assert(s.includes('lifecycleInputs'));});








test('cross-connection Ruby fixture grants and restores the exact service token user',()=>{const ruby=readFileSync('scripts/release/simulation-email/channel-fixture.rb','utf8');assert.match(ruby,/Token\.lock\.find_by!\(action: 'api', persistent: true, name: 'WasalX Service', token: service_token_value\)/u);assert.match(ruby,/service_actor\.group_ids_access_map = service_original\.merge\(group\.id => 'full'\)/u);assert.match(ruby,/service_actor\.group_ids_access_map = service_original\.transform_values/u);assert.match(ruby,/where\.not\(id: \[agent\.id, service_actor\.id\]\)/u);});

test('cross-connection nickname reuses the current agent and authorized queue without changing native grants',()=>{
 const source=readFileSync('scripts/release/simulation-native-cross-connection.mjs','utf8');
 assert.match(source,/target\?\.active&&target\.serviceIdentityCanCreate/u);
 assert.match(source,/nativeGroupName:target\.name/u);
 assert.match(source,/const agent=await ensureNativeAgent\(s\);await agent\.verify\(\)/u);
 assert.doesNotMatch(source,/serviceToken|ZAMMAD_SERVICE_TOKEN|cross-connection-(?:setup|restore)/u);
});

test('lifecycle bind/start leaves require their actual QR notice and FAILED Start observations',()=>{const phases=[...new Set(lifecycleChecks.map(x=>x[1]))],packet=omit=>({evidenceMode:'simulated',startedAt:'2026-09-12T00:00:00.000Z',connectionId:'current',proofs:phases.map(phase=>({phase,connectionId:'current',observedAt:'2026-09-12T00:00:01.000Z',...(phase==='qr'&&omit!=='qr'?{qrNotice:{actualApiGet:true}}:{}),...(phase==='start'&&omit!=='start'?{failedStartRecovery:{terminalProviderState:'WORKING'}}:{})}))});const rows=lifecycleResults(packet(),ownerBinding);assert(rows.every(row=>row.contextId==='tenant_owner-en-desktop'&&row.actorRef===ref&&row.proof.actorVerified===true));assert.throws(()=>lifecycleResults(packet('qr'),ownerBinding),/QR notice/);assert.throws(()=>lifecycleResults(packet('start'),ownerBinding),/FAILED Start/);assert.throws(()=>lifecycleResults(packet(),{...ownerBinding,viewport:{width:820,height:1180}}));});

import {lifecycleRoleObserver,lifecycleRoleRows,lifecycleSelectedRoles} from '../scripts/release/simulation-lifecycle-stage.mjs';
test('lifecycle role projection keeps observer failures but rejects a failed security wave',()=>{const failedObservation={testId:'lifecycle',contextId:'tenant_admin-en-desktop',result:'failed'},wave={restored:true,audit:{matched:true},proofs:[{passed:true,actorVerified:true,observation:[failedObservation]}],agentAdditional:{observation:[]}};assert.deepEqual(lifecycleRoleRows(wave),[failedObservation]);wave.proofs[0].passed=false;assert.throws(()=>lifecycleRoleRows(wave),/security or identity proof failed/);});
test('lifecycle role observers follow exact selected role contexts at any remote viewport and never mutate roles when none are selected',async()=>{const health='connections/create-bind-test-and-health::connection-health-renders-from-live-operation::01',roles=['tenant_admin','supervisor','auditor','agent'],checks=[{testId:health,contextId:'auditor-en-desktop'},{testId:health,contextId:'agent-en-desktop'},{testId:health,contextId:'supervisor-en-mobile'},{testId:'other::x',contextId:'tenant_admin-en-desktop'}];assert.deepEqual(lifecycleSelectedRoles(checks,[health],roles),['supervisor','auditor','agent']);assert.deepEqual(lifecycleSelectedRoles(undefined,[health],roles),[]);const session={capabilities:{secondActor:{memberId:'m',userId:'u',subject:'s',login:async()=>assert.fail('No role sign-in without selection'),page:{}}},scoped:async()=>assert.fail('No membership mutation without selection')};assert.deepEqual(await lifecycleRoleObserver(session,'run',[{testId:'other::x',contextId:'supervisor-en-mobile'}])({phase:'paired',connectionId:'c',testIds:[health],roles}),[]);});
