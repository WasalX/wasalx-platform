import test from 'node:test';import assert from 'node:assert/strict';
import {admitFailedHandoffFixture,assertFailedBeforeRetry,assertHandoffRetrySettled,handoffNotes,handoffRetryStage,observeFailedHandoffRetry,pendingHandoffCreator} from '../scripts/release/simulation-handoff-retry.mjs';

const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const fixture=()=>({evidenceMode:'simulated',tenantId:id(1),conversationId:id(2),jobId:id(3),jobState:'FAILED_RETRYABLE',attempts:1,ticketId:'42',ticketNumber:'1042',fencingToken:5,testId:'direct-automation/failed-human-handoff::retry::01',noReplay:true});
const note=jobId=>({id:77,internal:true,type:'note',preferences:{wasalx_handoff_key:'bot-handoff:'+jobId}});
const failedJob=()=>({id:id(3),state:'FAILED_RETRYABLE',attempts:1,lease_id:null,lease_expires_at:null,completed_at:null});
const conversation={id:id(2),state:'HANDOFF_PENDING',fencing_token:'5',zammad_ticket_id:42};

test('admission qualifies only a retryable, below-ceiling handoff with an existing ticket',()=>{
 assert.equal(admitFailedHandoffFixture(fixture(),{tenantId:id(1)}).jobId,id(3));
 for(const change of [{jobState:'FAILED_TERMINAL'},{attempts:8},{attempts:0},{ticketId:null},{ticketId:'0'},{evidenceMode:'live'},{tenantId:id(9)},{fencingToken:-1},{testId:undefined},{noReplay:false}])assert.throws(()=>admitFailedHandoffFixture({...fixture(),...change},{tenantId:id(1)}));
});

test('before the click: the exact unleased retryable job, the existing ticket and no handoff note',()=>{
 const ok={fixture:fixture(),jobs:[failedJob()],conversation,notes:[],ticketIds:[42]};
 assert.deepEqual(assertFailedBeforeRetry(ok),{jobIds:[id(3)],attempts:1,ticketIds:['42']});
 for(const change of [o=>o.conversation={...conversation,fencing_token:'6'},o=>o.conversation={...conversation,zammad_ticket_id:null},o=>o.jobs=[{...failedJob(),lease_id:id(8)}],o=>o.jobs=[{...failedJob(),attempts:2}],o=>o.jobs=[{...failedJob(),state:'FAILED_TERMINAL'}],o=>o.jobs=[{id:id(4),state:'QUEUED'},failedJob()],o=>o.notes=[note(id(3))],o=>o.ticketIds=[]])assert.throws(()=>{const o=structuredClone(ok);change(o);assertFailedBeforeRetry(o);});
});

test('settled retry: same job succeeded, no new job or ticket, exactly one note keyed to that job',()=>{
 const before={jobIds:[id(3)],attempts:1,ticketIds:['42']},human={state:'HUMAN',fencing_token:'7',zammad_ticket_id:42},done=[{...failedJob(),state:'SUCCEEDED',attempts:2,completed_at:'t'}];
 assert.deepEqual(assertHandoffRetrySettled({fixture:fixture(),before,jobs:done,conversation:human,notes:[note(id(3))],ticketIds:[42]}),{jobId:id(3),attemptsBefore:1,attemptsAfter:2,noteId:'77'});
 for(const change of [o=>o.jobs.push({id:id(4),state:'SUCCEEDED'}),o=>o.ticketIds=[42,43],o=>o.notes=[],o=>o.notes=[note(id(3)),note(id(3))],o=>o.notes=[note(id(4))],o=>o.notes=[{...note(id(3)),internal:false}],o=>o.jobs[0].attempts=1,o=>o.conversation.state='HANDOFF_PENDING'])assert.throws(()=>{const o=structuredClone({fixture:fixture(),before,jobs:done,conversation:human,notes:[note(id(3))],ticketIds:[42]});change(o);assertHandoffRetrySettled(o);});
 assert.equal(handoffNotes([{preferences:{}},note(id(3)),{preferences:{wasalx_handoff_key:'other'}}]).length,1);
});

function harness({uncertain=false,token=5,settle=true}={}){
 const f=fixture(),state={jobs:[failedJob()],conversation:{...conversation},notes:[],tickets:[42],paused:true},checkpoints=[],listeners=[];let clicks=0,resumes=0;
 const button={click:async()=>{clicks++;const request={method:()=>'POST',url:()=>'https://portal.test/api/bot-flows/conversations/'+id(2)+'/command',postDataJSON:()=>({action:'RETRY_HANDOFF',expectedFencingToken:token})};listeners.forEach(fn=>fn(request));state.conversation={...state.conversation,fencing_token:'6'};state.jobs=[{...failedJob(),state:'QUEUED'}];},count:async()=>state.conversation.state==='HUMAN'?0:1};
 const row={count:async()=>1,getByText:()=>({waitFor:async()=>{}}),getByRole:()=>button};
 const page={setViewportSize:async()=>{},viewportSize:()=>({width:1440,height:1000}),evaluate:async()=>'en',goto:async()=>{},reload:async()=>{},getByRole:()=>({click:async()=>{}}),locator:selector=>selector==='.bot-conversations'?{waitFor:async()=>{}}:{filter:()=>row},on:(_e,fn)=>listeners.push(fn),off:(_e,fn)=>listeners.splice(listeners.indexOf(fn),1),
  waitForResponse:async()=>{while(!clicks)await new Promise(done=>setTimeout(done,1));if(uncertain)throw Error('response lost');return{status:()=>201,json:async()=>({command:'RETRY_HANDOFF',fencingToken:6})};}};
 const s={tenantId:id(1),ownerId:'owner',ownerPage:page,portalOrigin:'https://portal.test',checkpoint:async row=>checkpoints.push(row),verifyOwner:async()=>({userMatched:true,workspaceMatched:true}),scoped:async sql=>sql.includes('bot_handoff_jobs')?structuredClone(state.jobs):[structuredClone(state.conversation)]};
 const resumeQueue=async()=>{resumes++;assert.equal(state.jobs[0].state,'QUEUED');if(settle){state.jobs=[{...failedJob(),state:'SUCCEEDED',attempts:2,completed_at:'t'}];state.conversation={...state.conversation,state:'HUMAN'};state.notes=[note(id(3))];}};
 return{s,f,checkpoints,clicks:()=>clicks,resumes:()=>resumes,readNotes:async ticket=>{assert.equal(ticket,'42');return structuredClone(state.notes);},readTicketIds:async()=>[...state.tickets],resumeQueue};
}
const run=(h,settleTimeoutMs=200)=>observeFailedHandoffRetry(h.s,{fixture:h.f,readNotes:h.readNotes,readTicketIds:h.readTicketIds,resumeQueue:h.resumeQueue,settleTimeoutMs});

test('one owner UI retry with the current fence requeues the same job, resumes once and binds one effect',async()=>{
 const h=harness(),proof=await run(h);
 assert.equal(h.clicks(),1);assert.equal(h.resumes(),1);assert.equal(proof.result,'passed');assert.equal(proof.contextId,'tenant_owner-en-desktop');assert.equal(proof.proof.sameJob,true);assert.equal(proof.proof.newTickets,0);assert.equal(proof.verifiedContext.role,'tenant_owner');
 assert.deepEqual(h.checkpoints.map(row=>row.phase),['handoff-retry-intent','handoff-retry-accepted','handoff-retry-queue-resume-intent','handoff-retry-proof']);
});

test('a lost response reconciled as the same queued job resumes once and settles without a second click',async()=>{
 const h=harness({uncertain:true}),proof=await run(h);
 assert.equal(h.clicks(),1);assert.equal(h.resumes(),1);assert.equal(proof.result,'passed');assert.equal(h.checkpoints.find(row=>row.phase==='handoff-retry-accepted').reconciled,true);
});
test('a lost response whose durable read did not advance the fence never resumes or clicks again',async()=>{
 const h=harness({uncertain:true});const original=h.s.scoped;h.s.scoped=async(sql,params)=>{const rows=await original(sql,params);return sql.includes('bot_conversations')?rows.map(row=>({...row,fencing_token:'5'})):rows;};await assert.rejects(run(h));
 assert.equal(h.clicks(),1);assert.equal(h.resumes(),0);
});

test('a stale fence or an unsettled job never passes and is never retried',async()=>{
 const stale=harness({token:4});await assert.rejects(run(stale),/current fencing token/);assert.equal(stale.clicks(),1);assert.equal(stale.resumes(),0);
 const pending=harness({settle:false});await assert.rejects(run(pending,30),/never click again/);assert.equal(pending.clicks(),1);assert.equal(pending.resumes(),1);
});

test('observer refuses to start without every consumer readback and the queue release',async()=>{
 const h=harness();for(const missing of ['readNotes','readTicketIds','resumeQueue'])await assert.rejects(observeFailedHandoffRetry(h.s,{fixture:h.f,readNotes:h.readNotes,readTicketIds:h.readTicketIds,resumeQueue:h.resumeQueue,[missing]:undefined}));assert.equal(h.clicks(),0);
});

const governed={testId:'direct-automation/failed-human-handoff::retry::01',chatId:'12025550120@c.us'};
function pendingSession({active=1,settle=true}={}){const calls=[],checkpoints=[];let processed=false;const s={tenantId:id(1),checkpoint:async row=>checkpoints.push(row.phase),directCallbacks:{control:async command=>{calls.push(command);processed=settle;return{bodySha256:'a'.repeat(64)};}},scoped:async sql=>sql.includes('bot_assignments')?Array.from({length:active},(_,i)=>({id:id(10+i)})):sql.includes('event_inbox')?(calls.length?[{id:id(20),status:processed?'PROCESSED':'ACCEPTED',lease_id:null,processed_at:processed?'t':null}]:[]):processed?[{id:id(2),state:'HANDOFF_PENDING'}]:[]};return{s,calls,checkpoints};}
test('pending handoff inbound is sent once on the admitted chat through the active current flow',async()=>{
 const h=pendingSession(),create=pendingHandoffCreator(h.s,{namespace:'run',connectionId:id(5),chatId:governed.chatId});
 assert.deepEqual(await create(),{eventId:h.calls[0].input.eventId,conversationId:id(2)});assert.equal(h.calls.length,1);assert.equal(h.calls[0].action,'inbound');assert.equal(h.calls[0].input.chatId,governed.chatId);
 await assert.rejects(create(),/sent once/);assert.equal(h.calls.length,1);
});
test('pending handoff fails closed without exactly one active flow or settlement and never reposts',async()=>{
 for(const active of [0,2]){const h=pendingSession({active});await assert.rejects(pendingHandoffCreator(h.s,{namespace:'run',connectionId:id(5),chatId:governed.chatId})(),/active current flow/);assert.equal(h.calls.length,0);}
 const h=pendingSession({settle:false});await assert.rejects(pendingHandoffCreator(h.s,{namespace:'run',connectionId:id(5),chatId:governed.chatId,settleTimeoutMs:20})(),/never repost/);assert.equal(h.calls.length,1);
 assert.throws(()=>pendingHandoffCreator(h.s,{namespace:'run',connectionId:id(5),chatId:'not-a-chat'}));
});
test('stage adapter requires the governed allocation, resumes through the capability and verifies settlement once',async()=>{
 const h=harness(),settledCalls=[],prepare=async(s,args)=>{assert.equal(typeof args.createPending,'function');assert.equal(args.config,governed);return{fixture:{...h.f,testId:governed.testId},failed:{job:{attempts:1}},read:async()=>({native:{ticketId:'42',ticketCount:1}}),readNotes:h.readNotes,resumeAfterRetry:h.resumeQueue,verifySettled:async()=>{settledCalls.push(1);return{job:{id:id(3),attempts:2,conversation_fencing_token:7},native:{noteIds:['77']}};}};};
 h.s.directCallbacks={control:async()=>assert.fail('stage must not send inbound outside the fixture')};
 await assert.rejects(handoffRetryStage(h.s,{namespace:'run',inputs:{directConnection:{connectionId:id(5)}},config:governed,testIds:['other::id']},{prepare}),/governed catalog/);
 const result=await handoffRetryStage(h.s,{namespace:'run',inputs:{directConnection:{connectionId:id(5)}},config:governed,testIds:[governed.testId]},{prepare});
 assert.deepEqual(result.testIds,[governed.testId]);assert.equal(result.results[0].proof.attemptsAfter,2);assert.equal(settledCalls.length,1);assert.equal(h.clicks(),1);assert.equal(h.resumes(),1);
});
