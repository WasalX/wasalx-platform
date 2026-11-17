import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DeliveryProcessor} from '../services/connector-worker/dist/services/connector-worker/src/processor.js';
import {OutboxRepository} from '../services/connector-worker/dist/services/connector-worker/src/repository.js';
import {SecretResolutionError} from '../services/connector-worker/dist/services/connector-worker/src/secrets.js';
import {assertHandoffFixtureSnapshot,handoffQueueScript,handoffRefusalScript,handoffSetupScript,assertHandoffSetupReceipts,assertHandoffAssignment,handoffAssignmentSql,handoffRetryTestId,handoffFixtureSql,prepareHandoffRetryFixture} from '../scripts/release/simulation-handoff-fixture.mjs';
import {createHash} from 'node:crypto';

const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const expected={tenantId:id(1),connectionId:id(2),jobId:id(3),conversationId:id(4)};
const snapshot=(state='FAILED_RETRYABLE')=>({job:{id:id(3),tenant_id:id(1),connection_id:id(2),conversation_id:id(4),source_event_id:id(5),assignment_id:id(6),flow_version_id:id(7),state,attempts:1,fencing_token:1,lease_id:null,lease_expires_at:null,conversation_state:'HANDOFF_PENDING',conversation_fencing_token:7,zammad_ticket_id:'42',flow_name:'Synthetic handoff'},native:{ticketId:'42',ticketNumber:'1042',ticketCount:1,noteIds:[]}});

test('settled retryable refusal and its one same-job retry preserve ticket, fences and one note',()=>{
 const failed=snapshot();assertHandoffFixtureSnapshot(failed,{...expected,state:'FAILED_RETRYABLE'});
 const queued=structuredClone(failed);queued.job.state='QUEUED';queued.job.conversation_fencing_token++;
 assertHandoffFixtureSnapshot(queued,{...expected,state:'QUEUED',original:failed});
 const settled=structuredClone(failed);Object.assign(settled.job,{state:'SUCCEEDED',attempts:2,fencing_token:2,conversation_state:'HUMAN',conversation_fencing_token:9});settled.native.noteIds=['81'];
 assertHandoffFixtureSnapshot(settled,{...expected,state:'SUCCEEDED',original:failed});
});
for(const[name,change]of Object.entries({foreignTenant:s=>s.job.tenant_id=id(9),foreignConnection:s=>s.job.connection_id=id(9),terminal:s=>s.job.state='FAILED_TERMINAL',activeLease:s=>s.job.lease_id=id(9),activeLeaseTime:s=>s.job.lease_expires_at='2026-10-29T00:00:00Z',wrongAttempt:s=>s.job.attempts=2,wrongFence:s=>s.job.fencing_token=2,noTicket:s=>s.job.zammad_ticket_id=null,duplicateTicket:s=>s.native.ticketCount=2,priorNote:s=>s.native.noteIds=['81'],wrongConversation:s=>s.job.conversation_state='HUMAN'}))test('handoff refusal receipt rejects '+name,()=>{const value=snapshot();change(value);assert.throws(()=>assertHandoffFixtureSnapshot(value,{...expected,state:'FAILED_RETRYABLE'}));});
test('same-job retry rejects successor, replayed fence and duplicate notes',()=>{
 const failed=snapshot(),settled=structuredClone(failed);Object.assign(settled.job,{state:'SUCCEEDED',attempts:2,fencing_token:2,conversation_state:'HUMAN',conversation_fencing_token:9});settled.native.noteIds=['81'];
 for(const alter of [s=>s.job.id=id(9),s=>s.job.source_event_id=id(9),s=>s.job.conversation_fencing_token=8,s=>s.native.noteIds=['81','82']]){const value=structuredClone(settled);alter(value);assert.throws(()=>assertHandoffFixtureSnapshot(value,{...expected,state:'SUCCEEDED',original:failed}));}
});

function workerHarness({paused=true,foreign=false,attempts=0}={}){
 let claimed=false,lease,closed=0;const updates=[],logs=[];
 const row={id:foreign?id(9):id(3),tenant_id:id(1),conversation_id:id(4),connection_id:id(2),state:'QUEUED',attempts,fencing_token:0,handoff_node_id:'handoff',zammad_group_id:'7',priority:'2 normal',zammad_ticket_id:'42',zammad_base_url:'http://native.invalid',zammad_secret_reference:'secret://tenants/'+id(1)+'/zammad/service'};
 const client={query:async(sql,args)=>{
  if(sql.includes('WITH claimed AS')){claimed=true;assert.equal(args[1],1);lease=args[0];return{rows:[{...row,attempts:1,fencing_token:1}]};}
  if(sql.startsWith('SELECT job.id'))return{rows:[row]};
  if(sql.startsWith('UPDATE bot_handoff_jobs')){updates.push({sql,args});assert.equal(args[0],'FAILED_RETRYABLE');assert.equal(args[3],id(1));assert.equal(args[4],id(3));assert.equal(args[5],lease);assert.equal(args[6],1);return{rowCount:1};}
  return{rows:[],rowCount:0};
 },release(){}};
 class Pool{async connect(){return client;}async end(){closed++;}}
 class Queue{async waitUntilReady(){}async isPaused(){return paused;}async getActiveCount(){return 0;}async close(){closed++;}}
 const source=handoffRefusalScript(expected).replace(/import [^;]+;/gu,'');
 const execute=new Function('assert','Pool','Queue','DeliveryProcessor','OutboxRepository','SecretResolutionError','setMetaTestPhoneTransaction','process','console','crypto','return (async()=>{'+source+'})()');
 return{run:()=>execute(assert,Pool,Queue,DeliveryProcessor,OutboxRepository,SecretResolutionError,async(_client,tenant)=>assert.equal(tenant,id(1)),{env:{DATABASE_URL:'not-a-real-connection',REDIS_URL:'redis://fixture.invalid'}},{log:text=>logs.push(JSON.parse(text))},globalThis.crypto),updates,logs,claimed:()=>claimed,closed:()=>closed};
}
test('refusal executes the actual processor and repository before any native request without injecting a status',async()=>{
 const h=workerHarness(),before=globalThis.fetch;await h.run();assert.equal(globalThis.fetch,before);assert(h.claimed());assert.equal(h.updates.length,1);assert.equal(h.closed(),2);
 assert.deepEqual(h.logs,[{jobId:id(3),conversationId:id(4),refusals:1,nativeRequests:0,fault:'test-only-transient-dependency-refusal'}]);
});
for(const options of [{paused:false},{foreign:true},{attempts:1}])test('worker refusal rejects changed custody before claiming '+JSON.stringify(options),async()=>{const h=workerHarness(options);await assert.rejects(h.run);assert.equal(h.claimed(),false);assert.equal(h.updates.length,0);assert.equal(h.closed(),2);});

test('generated commands parse without executing them and reject unbounded actions/identifiers',()=>{
 for(const source of [handoffRefusalScript(expected),handoffSetupScript({...expected,sourceEventId:id(5),chatId:'12025550106@c.us',textSha256:'a'.repeat(64)}),...['pause','read','resume'].map(handoffQueueScript)]){const result=spawnSync(process.execPath,['--input-type=module','--check'],{input:source,encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
 assert.throws(()=>handoffQueueScript('dispatch'));assert.throws(()=>handoffRefusalScript({...expected,jobId:'../foreign'}));
});

function assignmentFixture(){
 const namespace='fixture-run',definition={name:'Synthetic direct '+namespace,start:'hello',nodes:[{id:'hello',type:'send_text',text:'Synthetic '+namespace+' V2',next:'handoff'},{id:'handoff',type:'handoff',target:'CLIENT_PRIMARY',priority:'2 normal'}]};
 const assignment={id:id(6),state:'PAUSED',revision:3,flow_version_id:id(7),definition};
 const direct={fixtures:{tenantId:id(1),connectionId:id(2),assignmentId:id(6),chatIds:['12025550104@c.us','12025550105@c.us']},secondVersion:id(7),assignmentDisposition:{id:id(6),state:'PAUSED',revision:3}};
 return{assignment,direct,namespace,chatId:'12025550106@c.us'};
}

test('handoff requires the exact current owned paused assignment and no post-handoff provider control policy',()=>{
 const f=assignmentFixture(),args={namespace:f.namespace,tenantId:id(1),connectionId:id(2),chatId:f.chatId};
 assert.equal(assertHandoffAssignment(f.assignment,f.direct,args),createHash('sha256').update('Synthetic fixture-run V2').digest('hex'));
 for(const alter of [x=>x.assignment.state='ACTIVE',x=>x.assignment.revision++,x=>x.assignment.flow_version_id=id(8),x=>x.assignment.definition.keepOpenPolicy={mainMenu:true},x=>x.assignment.definition.nodes[0].text='another reply',x=>x.direct.sourceRunId='old-run',x=>x.direct.fixtures.chatIds.push(f.chatId),x=>x.direct.fixtures.tenantId=id(8)]){const copy=structuredClone(f);alter(copy);assert.throws(()=>assertHandoffAssignment(copy.assignment,copy.direct,args));}
});

function capabilityHarness(root,{pendingError,providerDrift=false}={}){
 const {assignment,direct,namespace,chatId}=assignmentFixture(),project='wasalx-simulation-fixture',worker={Id:'a'.repeat(64),Image:'sha256:'+'b'.repeat(64),State:{Status:'running'},Config:{Labels:{'com.docker.compose.project':project,'com.docker.compose.service':'connector-worker'}}};
 const provider={Id:'c'.repeat(64),Image:'sha256:'+'d'.repeat(64)},native={Id:'e'.repeat(64),Image:'sha256:'+'f'.repeat(64),State:{Status:'running'},Config:{Labels:{'com.docker.compose.project':project,'com.docker.compose.service':'zammad-railsserver'}}};
 const binding={project,connectionId:id(2),providerSessionId:'provider-session',containerId:provider.Id,imageId:provider.Image,socketPath:'/private/control.sock'};
 let state,paused=false,resumes=0,pendingCalls=0,setupSettled=false;const emissions=[],mutations=[],textSha256=createHash('sha256').update('Synthetic fixture-run V2').digest('hex');
 const setup={delivery:{id:id(8),state:'SENT',attempts:1,external_message_id:'true_'+chatId+'_SETUP',lease_id:null,lease_expires_at:null},textSha256,handoffUnclaimed:true};
 const providerSnapshot=()=>({evidenceClass:'simulated-provider',receivedSends:setupSettled?1+(state==='SUCCEEDED'&&providerDrift?1:0):0,receipts:setupSettled?[{id:setup.delivery.external_message_id,textSha256}]:[]});
 const receipt=()=>{const value=snapshot(state);if(state==='QUEUED'){value.job.attempts=0;value.job.fencing_token=0;}if(state==='RETRIED'){value.job.state='QUEUED';value.job.conversation_fencing_token=8;}if(state==='SUCCEEDED'){Object.assign(value.job,{attempts:2,fencing_token:2,conversation_state:'HUMAN',conversation_fencing_token:9});value.native.noteIds=['81'];}return value;};
 const s={ownerPage:{evaluate:async(_fn,{path,method,body})=>{assert(paused);assert.equal(method,'POST');assert.equal(path,'/api/bot-flows/assignments/'+assignment.id+'/state');assert.equal(body.expectedRevision,assignment.revision);assignment.state=body.state;assignment.revision++;mutations.push(body.state);return{assignmentId:assignment.id,state:assignment.state,revision:assignment.revision};}},portalOrigin:'https://portal.invalid',verifyOwner:async()=>({userMatched:true,workspaceMatched:true}),operatorSurface:'portal',actorBinding:{userMatched:true,workspaceMatched:true},tenantId:id(1),privateDir:root,socketPath:binding.socketPath,model:{name:project},candidate:{sha:'a'.repeat(40),tree:'b'.repeat(40)},containers:{'connector-worker':worker,'waha-gows':provider,'zammad-railsserver':native},capabilities:{},checkpoint:async row=>emissions.push(row.phase),directCallbacks:{binding,assertIsolatedRuntime:async()=>{},drainEffects:async()=>{assert(!state);}},scoped:async(sql)=>{if(sql===handoffAssignmentSql)return[structuredClone(assignment)];if(sql.startsWith('SELECT id FROM bot_conversations'))return[];if(sql.startsWith('SELECT id FROM event_inbox'))return[{id:id(5)}];assert.equal(sql,handoffFixtureSql);return state?[receipt().job]:[];},run:async(_command,args)=>{
  if(args[0]==='ps')return worker.Id;if(args[0]==='inspect')return JSON.stringify([args[1]===worker.Id?worker:native]);
  if(args[1]===provider.Id)return JSON.stringify(providerSnapshot());
  if(args[1]==='-e'){const payload=JSON.parse(Buffer.from(args[2].split('=')[1],'base64url').toString('utf8'));if(payload.kind==='handoff-evidence')return JSON.stringify({readback:receipt().native});assert.equal(payload.kind,'articles');return JSON.stringify({readback:[]});}
  const script=args.at(-1);if(script.includes('await queue.pause()')){assert.equal(paused,false);paused=true;return JSON.stringify({paused:true,active:0});}if(script.includes('await queue.resume()')){assert(paused);paused=false;resumes++;state='SUCCEEDED';return JSON.stringify({paused:false,active:0});}
  assert(paused);if(script.includes('SidecarSecretResolver')){assert.equal(assignment.state,'PAUSED');assert.equal(state,'QUEUED');setupSettled=true;emissions.push('setup-drain');return JSON.stringify(setup);}
  assert(setupSettled,'0157 disallows claiming the handoff while the text delivery is pending');assert(script.includes('new DeliveryProcessor'));state='FAILED_RETRYABLE';return JSON.stringify({jobId:id(3),refusals:1,nativeRequests:0});
 }};
 const args={namespace,inputs:{directConnection:{evidenceMode:'simulated',provider:'WAHA',namespace,tenantId:id(1),connectionId:id(2),runtimeBinding:binding},directFlow:direct},config:{chatId,testId:handoffRetryTestId,sourceNamespace:namespace},testIds:[handoffRetryTestId],createPending:async()=>{assert(paused);assert.equal(assignment.state,'ACTIVE');pendingCalls++;if(pendingError)throw pendingError;state='QUEUED';}};
 return{s,args,emissions,mutations,setup,providerSnapshot,setState:value=>{state=value;},counts:()=>({resumes,pendingCalls,paused})};
}

test('failed setup retains its durable pause and activation claim without retrying uncertain ingress',async()=>{
 const root=await mkdtemp(join(tmpdir(),'wasalx-handoff-error-')),h=capabilityHarness(root,{pendingError:Error('unknown pending operation')});
 try{await assert.rejects(prepareHandoffRetryFixture(h.s,h.args),/unknown pending operation/);assert.deepEqual(h.counts(),{resumes:0,pendingCalls:1,paused:true});assert.deepEqual(h.mutations,['ACTIVE']);const claim=JSON.parse(await readFile(join(root,'handoff-fixture-fixture-run.claim.json'),'utf8'));assert.equal(claim.assignment.state,'PAUSED');assert.equal(claim.disposition,'reconcile-original-queue-pause-and-job-before-resume');await assert.rejects(prepareHandoffRetryFixture(h.s,h.args));assert.equal(h.counts().pendingCalls,1);}finally{await rm(root,{recursive:true,force:true});}
});

test('setup delivery settles before refusal and immutable no-resend baseline; retry resumes only once',async()=>{
 const root=await mkdtemp(join(tmpdir(),'wasalx-handoff-ready-')),h=capabilityHarness(root);
 try{const cap=await prepareHandoffRetryFixture(h.s,h.args);assert.equal(cap.fixture.jobState,'FAILED_RETRYABLE');assert.deepEqual(h.mutations,['ACTIVE','PAUSED']);assert(h.emissions.indexOf('setup-drain')<h.emissions.indexOf('handoff-pre-effect-refusal-intent'));assert.deepEqual(h.counts(),{resumes:0,pendingCalls:1,paused:true});await assert.rejects(cap.resumeAfterRetry);await assert.rejects(()=>cap.readNotes('99'),/Only the original/);assert.deepEqual(await cap.readNotes('42'),[]);h.setState('RETRIED');await cap.resumeAfterRetry();assert.equal((await cap.verifySettled()).native.noteIds[0],'81');await assert.rejects(cap.resumeAfterRetry,/twice/);assert.equal(h.counts().resumes,1);}finally{await rm(root,{recursive:true,force:true});}
});

test('post-retry provider drift is rejected without refreshing the setup baseline',async()=>{
 const root=await mkdtemp(join(tmpdir(),'wasalx-handoff-drift-')),h=capabilityHarness(root,{providerDrift:true});try{const cap=await prepareHandoffRetryFixture(h.s,h.args);h.setState('RETRIED');await cap.resumeAfterRetry();await assert.rejects(cap.verifySettled,/another provider message/);assert.equal(h.counts().resumes,1);}finally{await rm(root,{recursive:true,force:true});}
});

test('setup proof rejects replay, changed history, extra sends, wrong recipient and unclaimed-state drift',()=>{
 const f=assignmentFixture(),textSha256='a'.repeat(64),before={evidenceClass:'simulated-provider',receivedSends:1,receipts:[{id:'old'}]},after={evidenceClass:'simulated-provider',receivedSends:2,receipts:[{id:'old'},{id:'true_'+f.chatId+'_SETUP',textSha256}]},setup={delivery:{state:'SENT',attempts:1,external_message_id:after.receipts[1].id,lease_id:null,lease_expires_at:null},textSha256,handoffUnclaimed:true};
 assertHandoffSetupReceipts(before,after,setup,{chatId:f.chatId,textSha256});
 for(const mutate of [x=>x.after.receivedSends++,x=>x.after.receipts[0].id='changed',x=>x.after.receipts.push(x.after.receipts[1]),x=>x.after.receipts[1].textSha256='b'.repeat(64),x=>x.setup.delivery.attempts=2,x=>x.setup.delivery.lease_id=id(9),x=>x.setup.handoffUnclaimed=false]){const copy=structuredClone({before,after,setup});mutate(copy);assert.throws(()=>assertHandoffSetupReceipts(copy.before,copy.after,copy.setup,{chatId:f.chatId,textSha256}));}
 assert.throws(()=>assertHandoffSetupReceipts(before,after,setup,{chatId:'12025550162@c.us',textSha256}));
});

function setupWorkerHarness({foreign=false,pendingStatus=false,failedSend=false}={}){
 const chatId='12025550106@c.us',text='Synthetic fixture-run V2',textSha256=createHash('sha256').update(text).digest('hex'),deliveryId=id(8),externalId='true_'+chatId+'_SETUP';
 const calls=[],logs=[];let settled=false,statusSettled=false;
 const initial={id:deliveryId,connection_id:id(2),bot_conversation_id:id(4),external_chat_id:chatId,idempotency_key:'bot:'+id(4)+':'+id(5)+':0',state:'QUEUED',attempts:0,lease_id:null,lease_expires_at:null,text_sha256:textSha256};
 const client={query:async sql=>{
  if(sql.startsWith('SELECT id,connection_id'))return{rows:foreign?[initial,{...initial,id:id(9),bot_conversation_id:id(9)}]:[initial]};
  if(sql.startsWith('SELECT delivery_id'))return{rows:[]};
  if(sql.startsWith('SELECT id,state,attempts,external_message_id'))return{rows:[{id:deliveryId,state:settled?'SENT':'FAILED_RETRYABLE',attempts:1,external_message_id:settled?externalId:null,lease_id:null,lease_expires_at:null}]};
  if(sql.startsWith('SELECT id,completed_at'))return{rows:[{id:id(9),completed_at:statusSettled&&!pendingStatus?'2026-10-29T00:00:00Z':null,lease_id:null,lease_expires_at:null,safe_error:null,delivery_state:'SENT',attempts:1}]};
  if(sql.startsWith('SELECT id,state,attempts,fencing_token'))return{rows:[{id:id(3),state:'QUEUED',attempts:0,fencing_token:0,lease_id:null,lease_expires_at:null}]};
  return{rows:[]};
 },release(){}};
 class Pool{async connect(){return client;}async end(){calls.push('close');}}
 class Queue{async waitUntilReady(){}async isPaused(){return true;}async getActiveCount(){return 0;}async close(){calls.push('queue-close');}}
 class Repository{
  async claimDeliveries(tenant,_lease,limit){calls.push('claim-delivery');assert.equal(tenant,id(1));assert.equal(limit,1);return[{id:deliveryId,tenantId:tenant,connectionId:id(2),botConversationId:id(4),directOrigin:'BOT',recipientType:'DIRECT',groupId:chatId,ticketId:'42',articleId:'9',text,contentType:'text/plain',idempotencyKey:initial.idempotency_key,attempts:1,provider:'waha',sessionId:'fixture',providerBaseUrl:'http://waha.invalid/',wahaWorkerId:id(9),wahaAssignmentFencingToken:1,connectionSecretReference:'secret://connection',zammadBaseUrl:'https://native.invalid',zammadSecretReference:'secret://zammad'}];}
  async claimBotHandoffs(){throw Error('Setup may not claim the handoff');}
  async beginSend(){calls.push('begin');}
  async complete(_job,_lease,state,externalMessageId){assert.equal(state,'SENT');assert.equal(externalMessageId,externalId);settled=true;calls.push('complete');}
  async fail(){calls.push('failed');}
  async outcomeUnknown(){calls.push('unknown');}
  async claimStatuses(){calls.push('claim-status');return settled?[{id:id(9),deliveryId,tenantId:id(1),ticketId:'42',state:'SENT',externalMessageId:externalId,attempts:1,zammadBaseUrl:'https://native.invalid',zammadSecretReference:'secret://zammad'}]:[];}
  async completeStatus(){statusSettled=true;calls.push('status-complete');}
  async retryStatus(){calls.push('status-retry');}
  async failStatus(){calls.push('status-failed');}
  async close(){calls.push('close');}
 }
 class Resolver{async resolve(reference){return reference==='secret://connection'?{apiKey:'test-only'}:{token:'test-only'};}}
 const script=handoffSetupScript({...expected,sourceEventId:id(5),chatId,textSha256}).replace(/import [^;]+;/gu,'');
 const execute=new Function('assert','Pool','Queue','DeliveryProcessor','OutboxRepository','SidecarSecretResolver','parseWahaWorkerConfigs','setMetaTestPhoneTransaction','process','console','crypto','return (async()=>{'+script+'})()');
 const run=async()=>{const original=globalThis.fetch;globalThis.fetch=async input=>{const url=String(input);calls.push(url.includes('sendText')?'provider-send':'native-status');if(failedSend)throw Error('synthetic unavailable');return new Response(JSON.stringify({id:url.includes('sendText')?externalId:42}),{status:200,headers:{'content-type':'application/json'}});};try{return await execute(assert,Pool,Queue,DeliveryProcessor,Repository,Resolver,()=>[{secretReference:'secret://connection'}],async(_client,tenant)=>assert.equal(tenant,id(1)),{env:{REDIS_URL:'redis://fixture.invalid'}},{log:value=>logs.push(JSON.parse(value))},globalThis.crypto);}finally{globalThis.fetch=original;}};
 return{run,calls,logs};
}

test('preparatory phase uses the actual delivery processor, completes native status, and never claims handoff',async()=>{
 const h=setupWorkerHarness();await h.run();assert.deepEqual(h.calls,['claim-delivery','begin','provider-send','complete','claim-status','native-status','status-complete','close','queue-close']);assert.equal(h.logs[0].delivery.state,'SENT');assert.equal(h.logs[0].handoffUnclaimed,true);
});
for(const [name,options,expectedError] of [['foreign',{foreign:true},/Only the exact/],['unsettled native status',{pendingStatus:true},/native status must settle/],['unknown send',{failedSend:true},/SENT/]])test('setup settlement rejects '+name+' before handoff refusal',async()=>{
 const h=setupWorkerHarness(options);await assert.rejects(h.run,expectedError);assert.deepEqual(h.logs,[]);if(options.foreign)assert(!h.calls.includes('claim-delivery'));
});
