// Current portal failed-handoff retry observer. The failed job comes from main's isolated simulated
// seam; this module never injects faults, replays native writes or touches live providers.
// Qualified case only: a settled FAILED_RETRYABLE job (attempts<8, unleased) for a conversation whose
// ticket already exists. RETRY_HANDOFF requeues that same job; FAILED_TERMINAL (successor insert)
// and ticketless input are different product behaviour and are rejected here.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyOwnerEvidence,bindOwnerEvidenceRows} from './simulation-owner-evidence.mjs';
import {boundedUiMutation} from './simulation-workflow-lifecycle.mjs';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const handoffKey=jobId=>'bot-handoff:'+jobId;
export const handoffRetrySql={
 jobs:'SELECT id,state,attempts,lease_id,lease_expires_at,completed_at,created_at FROM bot_handoff_jobs WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY created_at,id',
 conversation:'SELECT id,state,fencing_token,human_ownership_epoch,zammad_ticket_id FROM bot_conversations WHERE tenant_id=$1 AND id=$2'
};

export function admitFailedHandoffFixture(fixture,{tenantId}){
 assert.equal(fixture?.evidenceMode,'simulated');assert.equal(fixture.tenantId,tenantId);
 for(const key of ['conversationId','jobId'])assert.match(fixture[key]??'',UUID);
 assert.equal(fixture.jobState,'FAILED_RETRYABLE','Only a settled retryable handoff qualifies the same-job retry');
 assert(Number.isSafeInteger(fixture.attempts)&&fixture.attempts>=1&&fixture.attempts<8,'Retryable handoff needs attempts below the retry ceiling');
 assert.match(String(fixture.ticketId??''),/^[1-9]\d{0,15}$/u,'The original ticket must already exist');assert.match(String(fixture.ticketNumber??''),/^\d{1,20}$/u);
 assert(Number.isSafeInteger(fixture.fencingToken)&&fixture.fencingToken>=0);
 assert.match(fixture.testId??'',/^[a-z0-9-]+\/[a-z0-9-]+::[A-Za-z0-9:_-]+$/u,'Consumer must supply the allocated test ID');assert.equal(fixture.noReplay,true);return fixture;
}

export function handoffNotes(articles){
 return articles.filter(article=>String(article.preferences?.wasalx_handoff_key??'').startsWith('bot-handoff:'));
}

// Durable state before the click: exactly the receipt's unleased retryable job, the existing ticket, no handoff note.
export function assertFailedBeforeRetry({fixture,jobs,conversation,notes,ticketIds}){
 assert.equal(conversation.id,fixture.conversationId);assert.equal(conversation.state,'HANDOFF_PENDING');assert.equal(Number(conversation.fencing_token),fixture.fencingToken);assert.equal(String(conversation.zammad_ticket_id),String(fixture.ticketId));
 const latest=jobs.at(-1);assert(latest,'Failed handoff job missing');assert.equal(latest.id,fixture.jobId);assert.equal(latest.state,'FAILED_RETRYABLE');
 assert.equal(Number(latest.attempts),fixture.attempts);assert.equal(latest.lease_id,null);assert.equal(latest.lease_expires_at,null);assert.equal(latest.completed_at,null);
 assert(jobs.slice(0,-1).every(job=>['SUCCEEDED','FAILED_TERMINAL'].includes(job.state)),'Another handoff is already active');
 assert.equal(notes.length,0,'A handoff note already exists before the retry');
 assert(Array.isArray(ticketIds)&&ticketIds.map(String).includes(String(fixture.ticketId)),'Existing ticket readback missing');
 return{jobIds:jobs.map(job=>job.id),attempts:Number(latest.attempts),ticketIds:ticketIds.map(String).sort()};
}

// One UI retry settles one effect: the same job succeeds, no job or ticket is added, exactly one keyed internal note exists.
export function assertHandoffRetrySettled({fixture,before,jobs,conversation,notes,ticketIds}){
 assert.deepEqual(jobs.map(row=>row.id),before.jobIds,'Same-job retry must not create a job');
 const job=jobs.find(row=>row.id===fixture.jobId);assert.equal(job?.state,'SUCCEEDED');assert(Number(job.attempts)>before.attempts);assert.equal(job.lease_id,null);assert(job.completed_at);
 assert.equal(conversation.state,'HUMAN');assert.equal(String(conversation.zammad_ticket_id),String(fixture.ticketId));
 assert.deepEqual(ticketIds.map(String).sort(),before.ticketIds,'Retry must not create a ticket');
 assert.equal(notes.length,1,'Exactly one native handoff note');const [note]=notes;assert.equal(note.preferences.wasalx_handoff_key,handoffKey(fixture.jobId));assert.equal(note.internal,true);assert.equal(note.type,'note');
 return{jobId:job.id,attemptsBefore:before.attempts,attemptsAfter:Number(job.attempts),noteId:String(note.id)};
}

// Consumer (A wiring, main seam) supplies: readNotes(ticketId) native articles; readTicketIds() native tickets in scope;
// resumeQueue() releasing the paused isolated drain exactly once after the accepted retry.
export async function observeFailedHandoffRetry(s,{fixture,readNotes,readTicketIds,resumeQueue,settleTimeoutMs=120000}){
 admitFailedHandoffFixture(fixture,{tenantId:s.tenantId});for(const fn of [readNotes,readTicketIds,resumeQueue])assert.equal(typeof fn,'function');
 const page=s.ownerPage,origin=s.portalOrigin,startedAt=new Date().toISOString();await page.setViewportSize({width:1440,height:1000});
 const read=async()=>{const [jobs,[conversation],articles,ticketIds]=await Promise.all([s.scoped(handoffRetrySql.jobs,[s.tenantId,fixture.conversationId]),s.scoped(handoffRetrySql.conversation,[s.tenantId,fixture.conversationId]),readNotes(String(fixture.ticketId)),readTicketIds()]);assert(conversation);return{jobs,conversation,notes:handoffNotes(articles),ticketIds};};
 const before=assertFailedBeforeRetry({fixture,...await read()});
 const path=`/api/bot-flows/conversations/${fixture.conversationId}/command`,commands=[],onRequest=request=>{if(request.method()==='POST'&&new URL(request.url()).pathname===path)commands.push(request.postDataJSON());};
 await page.goto(origin+'/app?view=automation');await page.getByRole('tab',{name:'Conversations',exact:true}).click();await page.locator('.bot-conversations').waitFor();
 const row=page.locator('.bot-conversation-list article').filter({hasText:new RegExp('#'+fixture.ticketNumber+'(?:\\D|$)')});assert.equal(await row.count(),1);
 await row.getByText('Human handoff could not complete. Check the support workspace connection before retrying.',{exact:true}).waitFor();
 await s.checkpoint({phase:'handoff-retry-intent',conversationId:fixture.conversationId,jobId:fixture.jobId,expectedFencingToken:fixture.fencingToken});
 page.on('request',onRequest);let outcome;
 try{outcome=await boundedUiMutation({page,path,expectedStatus:201,readBody:true,trigger:()=>row.getByRole('button',{name:'Retry handoff',exact:true}).click({timeout:20000}),reconcile:async()=>{const now=await read();return Number(now.conversation.fencing_token)>fixture.fencingToken?now:null;}});}
 finally{page.off('request',onRequest);}
 await s.checkpoint({phase:'handoff-retry-accepted',conversationId:fixture.conversationId,reconciled:outcome.reconciled});
 assert.deepEqual(commands,[{action:'RETRY_HANDOFF',expectedFencingToken:fixture.fencingToken}],'Exactly one retry with the current fencing token');
 // A lost browser response is accepted only through the durable readback of this same queued job; never a second click.
 if(!outcome.reconciled){assert.equal(outcome.value.command,'RETRY_HANDOFF');assert.equal(Number(outcome.value.fencingToken),fixture.fencingToken+1,'Accepted retry must advance the conversation fence once');}
 const queued=await read();assert.equal(Number(queued.conversation.fencing_token),fixture.fencingToken+1,'Accepted retry must advance the conversation fence once');assert.equal(queued.jobs.find(job=>job.id===fixture.jobId)?.state,'QUEUED','Accepted retry must requeue the same job');assert.deepEqual(queued.jobs.map(job=>job.id),before.jobIds);assert.equal(queued.notes.length,0);
 await s.checkpoint({phase:'handoff-retry-queue-resume-intent',jobId:fixture.jobId});await resumeQueue();
 let settled;const deadline=Date.now()+settleTimeoutMs;
 for(;;){const now=await read(),job=now.jobs.find(row=>row.id===fixture.jobId);if(job?.state==='SUCCEEDED'&&now.conversation.state==='HUMAN'){settled=now;break;}
  assert(job&&job.state!=='FAILED_TERMINAL','Retried handoff failed terminally; inspect before any repeat');
  assert(Date.now()<deadline,'Retried handoff unsettled; reconcile the original job, never click again');await new Promise(done=>setTimeout(done,500));}
 const effect=assertHandoffRetrySettled({fixture,before,...settled});
 await page.reload();await page.getByRole('tab',{name:'Conversations',exact:true}).click();await page.locator('.bot-conversations').waitFor();
 assert.equal(await row.getByRole('button',{name:'Retry handoff',exact:true}).count(),0,'Retry remains offered after a settled handoff');
 const [proof]=bindOwnerEvidenceRows([{testId:fixture.testId,result:'passed',contextId:'tenant_owner-en-desktop',startedAt,finishedAt:new Date().toISOString(),proof:{conversationId:fixture.conversationId,...effect,sameJob:true,commandsSent:1,newTickets:0,noReplay:true,noteKeySha256:createHash('sha256').update(handoffKey(fixture.jobId)).digest('hex')}}],await verifyOwnerEvidence(s));
 await s.checkpoint({phase:'handoff-retry-proof',...proof});return proof;
}

// Creates the one pending current-portal conversation for main's paused-queue fixture: a single simulated inbound
// on the admitted chat through the active current flow. Any uncertainty is held for reconciliation, never reposted.
export function pendingHandoffCreator(s,{namespace,connectionId,chatId,settleTimeoutMs=120000}){
 assert.match(namespace,/^[A-Za-z0-9-]{1,40}$/u);assert.match(connectionId,UUID);assert.match(chatId,/^[0-9]{6,20}@c\.us$/u);assert.equal(typeof s.directCallbacks?.control,'function');
 let sent=false;
 return async()=>{
  assert(!sent,'Pending handoff inbound is sent once; reconcile instead of reposting');sent=true;
  const active=await s.scoped("SELECT id FROM bot_assignments WHERE tenant_id=$1 AND connection_id=$2 AND state='ACTIVE'",[s.tenantId,connectionId]);assert.equal(active.length,1,'One active current flow assignment required');
  const {simulationEventId}=await import('./synthetic-first-group-driver.mjs'),eventId=simulationEventId(namespace+'-handoff-pending'),messageId='false_'+chatId+'_SYNTH'+namespace+'-handoff';
  const inbox=()=>s.scoped("SELECT id,status,lease_id,processed_at FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND provider_event_id_sha256=app.webhook_event_id_sha256($1,$2,'WAHA',$3)",[s.tenantId,connectionId,eventId]);
  assert.equal((await inbox()).length,0,'Pending handoff inbound already exists; reconcile it');
  await s.checkpoint({phase:'handoff-pending-inbound-intent',eventId,messageId});
  const receipt=await s.directCallbacks.control({action:'inbound',input:{eventId,messageId,chatId,participant:chatId,text:'Synthetic '+namespace+' handoff'}});
  await s.checkpoint({phase:'handoff-pending-inbound-accepted',eventId,bodySha256:receipt?.bodySha256});
  const deadline=Date.now()+settleTimeoutMs;
  for(;;){const [row]=await inbox(),[conversation]=await s.scoped('SELECT id,state FROM bot_conversations WHERE tenant_id=$1 AND connection_id=$2 AND external_chat_id=$3 ORDER BY created_at DESC,id LIMIT 1',[s.tenantId,connectionId,chatId]);
   if(row?.status==='PROCESSED'&&row.lease_id===null&&row.processed_at&&conversation?.state==='HANDOFF_PENDING')return{eventId,conversationId:conversation.id};
   assert(Date.now()<deadline,'Pending handoff unsettled; reconcile the original inbound, never repost');await new Promise(done=>setTimeout(done,500));}
 };
}
// Current stage adapter over main's fixture capability; config/testIds come only from the selected governed allocation.
export async function handoffRetryStage(s,{namespace,inputs,config,testIds},{prepare}={}){
 assert(Array.isArray(testIds)&&testIds.includes(config?.testId),'Handoff retry property must be allocated by the selected governed catalog');
 prepare??=(await import('./simulation-handoff-fixture.mjs')).prepareHandoffRetryFixture;
 const cap=await prepare(s,{namespace,inputs,config,testIds,createPending:pendingHandoffCreator(s,{namespace,connectionId:inputs.directConnection.connectionId,chatId:config.chatId})});
 const fixture={...cap.fixture,attempts:Number(cap.failed.job.attempts)};
 const readTicketIds=async()=>{const {native}=await cap.read();assert.equal(native.ticketCount,1,'Exactly one correlated ticket');return[native.ticketId];};
 const proof=await observeFailedHandoffRetry(s,{fixture,readNotes:cap.readNotes,readTicketIds,resumeQueue:cap.resumeAfterRetry});
 const settled=await cap.verifySettled();assert.equal(settled.job.id,fixture.jobId);
 const result={...proof,proof:{...proof.proof,attemptsAfter:Number(settled.job.attempts),conversationFence:Number(settled.job.conversation_fencing_token),noteIds:settled.native.noteIds,providerReceiptsUnchanged:true}};
 await s.checkpoint({phase:'handoff-retry-stage-settled',...result});
 return{evidenceMode:'simulated',namespace,tenantId:s.tenantId,results:[result],testIds:[config.testId]};
}
