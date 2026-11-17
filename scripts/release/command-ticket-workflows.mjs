import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {simulationEventId,assertIngressReceipts} from './synthetic-first-group-driver.mjs';
import {findRuleSet} from './seed-simulation-group.mjs';
import {assertNativeAgent,captureNativeAgentEvidence,bindNativeAgentResult} from './simulation-native-agent.mjs';
import {admitNativeMailUi} from './simulation-native-mail-browser.mjs';
import {updateNativeTicketState} from './simulation-native-business-ticket.mjs';
import {assertIncludedReceipt} from './simulation-sender-policy.mjs';
import {enableSenderRoster,restoreSenderRoster} from './simulation-sender-stage.mjs';
import {parseRailsJson} from './simulation-rails-json.mjs';

const prefix='group-rules/commands-triggers-and-friendly-ticket-naming::';
export const ticketWorkflowTestIds=['closed-ticket-workflow-feedback-renders-once','quoted-command-workflow-enforces-configured-sender-permissions','reference-workflow-open-reopen-feedback-renders-once'].map(name=>prefix+name+'::01');
const sha=value=>createHash('sha256').update(String(value)).digest('hex');
const feedbackOperations=new Set(['ticket-workflow-feedback-navigation','ticket-workflow-feedback-admission','ticket-workflow-feedback-bubble','ticket-workflow-feedback-text']);
export async function publishTicketCommandMode({mode,actor,publish,definition}){
 if(mode==='SPECIFIC')await actor.setMembership(true);
 return publish(definition);
}
export function ticketWorkflowDefinition(event,name,permission){
 const send={id:'feedback',type:'send_text',text:event==='reference_received'?'Reference {{case.transition}}':'Workflow '+event,quote:event==='reference_received'?'CURRENT':'ORIGINAL',missingVariable:'ERROR',next:'done'},done={id:'done',type:'end'};
 if(event==='reference_received')return{schemaVersion:1,kind:'TICKET_EVENT',name,event,start:'matched',maxSteps:5,nodes:[{id:'matched',type:'condition',variable:'message.matches_reference',operator:'eq',value:true,onTrue:'created',onFalse:'done'},{id:'created',type:'condition',variable:'case.transition',operator:'eq',value:'CREATED',onTrue:'feedback',onFalse:'reopened'},{id:'reopened',type:'condition',variable:'case.transition',operator:'eq',value:'REOPENED',onTrue:'feedback',onFalse:'done'},send,done]};
 if(event==='quoted_command')return{schemaVersion:1,kind:'TICKET_EVENT',name,event,command:'/close',permission,start:'close',maxSteps:3,nodes:[{id:'close',type:'close_ticket',next:'feedback'}, {...send,quote:'LATEST'},done]};
 assert.equal(event,'ticket_closed');return{schemaVersion:1,kind:'TICKET_EVENT',name,event,start:'feedback',maxSteps:2,nodes:[send,done]};
}
export function assertWorkflowFeedback({execution,deliveries,articles,expectedText,quoteId}){
 assert.equal(execution.state,'APPLIED');assert.equal(execution.mode,'CUSTOM');assert.equal(deliveries.length,1);
 const delivery=deliveries[0];assert.equal(delivery.ticket_event_execution_id,execution.id);assert.equal(delivery.state,'SENT');assert.equal(Number(delivery.attempts),1);assert.equal(delivery.message_body,expectedText);assert.equal(delivery.reply_to_message_id,quoteId);
 const native=articles.filter(article=>article.preferences?.wasalx_ticket_event_execution_id===execution.id);assert.equal(native.length,1);assert.equal(native[0].preferences.wasalx_bot_delivery_key,delivery.idempotency_key);assert.equal(native[0].body,expectedText);assert.equal(String(delivery.zammad_article_id),String(native[0].id));return native[0];
}
export function assertDeniedWorkflow({inbox,before,after,beforeTicket,afterTicket,beforeArticles,afterArticles,messageId,quotedMessageId}){
 assert.equal(inbox.status,'PROCESSED');assert.equal(inbox.safe_error,null);assert(inbox.processed_at);assert.equal(inbox.lease_id,null);assert.equal(inbox.lease_expires_at,null);
 assert.deepEqual(after.deliveries,before.deliveries,'Denied command created provider delivery');
 const fresh=after.executions.filter(row=>!before.executions.some(old=>old.id===row.id));assert.equal(fresh.length,1);assert.equal(fresh[0].state,'APPLIED');assert.equal(fresh[0].native_action_state,'SUCCEEDED');
 const links=after.links.filter(row=>!before.links.some(old=>old.id===row.id));assert.equal(links.length,1);assert.deepEqual(after.executions.filter(row=>before.executions.some(old=>old.id===row.id)),before.executions);assert.deepEqual(after.links.filter(row=>before.links.some(old=>old.id===row.id)),before.links);
 const articles=afterArticles.filter(row=>!beforeArticles.some(old=>String(old.id)===String(row.id)));assert.equal(articles.length,1);const note=articles[0];
 assert.equal(note.internal,true);assert.equal(String(links[0].zammad_article_id),String(note.id));assert.equal(note.preferences?.wasalx_command_execution_id,fresh[0].id);assert.equal(note.preferences?.wasalx_command_disposition,'TRANSCRIPT_ONLY_DENIED');assert.equal(note.preferences?.wasalx_external_message_id,messageId);assert.equal(note.preferences?.wasalx_quoted_external_message_id,quotedMessageId);assert.equal(note.preferences?.wasalx_origin,'provider');
 for(const field of ['state_id','owner_id','group_id','wasalx_correlation_status'])assert.equal(afterTicket[field],beforeTicket[field],`Denied command changed ticket ${field}`);
 return{executionId:fresh[0].id,articleId:note.id,transcriptOnly:true};
}
// Feedback is not a receipt for the asynchronous native close callback.
// Wait for that exact causal projection before freezing a duplicate baseline.
export async function waitQuotedCommandClosure({scoped,poll,tenantId,correlationId,ticketId,executionId}){
 const commands=await scoped("SELECT id,correlation_id,state,native_action_state,native_action_snapshot,native_result FROM ticket_event_executions WHERE tenant_id=$1 AND id=$2 AND event='quoted_command'",[tenantId,executionId]);
 assert.equal(commands.length,1,'Exact quoted command receipt required');const command=commands[0],snapshot=command.native_action_snapshot,result=command.native_result;
 assert.equal(command.id,executionId);assert.equal(command.correlation_id,correlationId);assert.equal(command.state,'APPLIED');assert.equal(command.native_action_state,'SUCCEEDED');
 assert(snapshot&&result,'Native close receipt required');assert.equal(snapshot.tenant_id,tenantId);assert.equal(snapshot.correlation_id,correlationId);assert.equal(snapshot.ticket_id,String(ticketId));
 assert.match(snapshot.instance_id,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu);assert.match(snapshot.request_sha256,/^[a-f0-9]{64}$/u);
 assert.equal(result.state,'SUCCEEDED');assert.equal(result.execution_id,executionId);assert.equal(result.ticket_id,String(ticketId));assert.equal(result.request_sha256,snapshot.request_sha256);assert.match(result.closed_at,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
 return poll(async()=>{
  const events=await scoped("SELECT id,processing_state,lifecycle_state,processed_at FROM zammad_ticket_state_events WHERE tenant_id=$1 AND zammad_instance_id=$2 AND zammad_ticket_id=$3 AND transitioned_at=$4::timestamptz AND lifecycle_state='RESOLVED'",[tenantId,snapshot.instance_id,String(ticketId),result.closed_at]);
  assert(events.length<=1,'Ambiguous native close projection');const event=events[0];if(!event)return null;
  if(['ACCEPTED','BLOCKED_EFFECTS'].includes(event.processing_state))return null;
  assert.equal(event.processing_state,'APPLIED');assert.equal(event.lifecycle_state,'RESOLVED');assert(event.processed_at,'Native close projection is not complete');
  const sourceSha256=sha(JSON.stringify(['NATIVE_STATE',snapshot.instance_id,event.id]));
  const executions=await scoped("SELECT id,correlation_id,event,source_sha256,mode,state,completed_at FROM ticket_event_executions WHERE tenant_id=$1 AND correlation_id=$2 AND event='ticket_closed' AND source_sha256=$3",[tenantId,correlationId,sourceSha256]);
  assert(executions.length<=1,'Ambiguous ticket close execution');const execution=executions[0];if(!execution||execution.state==='PENDING')return null;
  assert.equal(execution.correlation_id,correlationId);assert.equal(execution.event,'ticket_closed');assert.equal(execution.source_sha256,sourceSha256);assert.equal(execution.mode,'OFF');assert.equal(execution.state,'SKIPPED');assert(execution.completed_at,'Ticket close execution is not complete');
  return{nativeStateEventId:event.id,ticketClosedExecutionId:execution.id,sourceSha256,settled:true};
 });
}

export function closeReplayPayload(event,tenantId){
 assert.equal(event.processing_state,'APPLIED');assert.equal(event.lifecycle_state,'RESOLVED');assert.match(event.transitioned_at,/\.\d{6}Z$/u);
 const payload={tenant_id:tenantId,ticket_id:event.zammad_ticket_id,ticket_number:event.zammad_ticket_number,state_id:Number(event.zammad_state_id),state_name:event.zammad_state_name,state_type_name:event.zammad_state_type_name,transitioned_at:event.transitioned_at,idempotency_key:event.idempotency_key};
 const normalized={ticketId:String(payload.ticket_id),ticketNumber:payload.ticket_number,stateId:payload.state_id,stateName:payload.state_name,stateTypeName:payload.state_type_name.toLowerCase(),lifecycleState:'RESOLVED',transitionedAt:payload.transitioned_at,idempotencyKey:payload.idempotency_key};
 assert.equal(sha(JSON.stringify(normalized)),event.request_sha256,'Replay must preserve exact original native source fingerprint');return payload;
}

export async function observeTicketWorkflowResult({testId,run,captureBinding,checkpoint,contextId='zammad_agent-en-desktop',bindResult=bindNativeAgentResult}){
 const startedAt=new Date().toISOString();let row;
 try{row={testId,contextId,result:'passed',startedAt,proof:await run()};}
 catch(error){if(error.qualificationOutcomeUnknown)throw error;row={testId,contextId,result:'failed',startedAt,proof:{errorClass:error.name,messageSha256:sha(error.message),phase:'ticket-workflow',...(feedbackOperations.has(error.qualificationOperation)?{operation:error.qualificationOperation}:{})}};}
 row.finishedAt=new Date().toISOString();
 try{row=bindResult(row,await captureBinding());}
 catch(error){row.result='failed';row.proof.bindingFailure={errorClass:error.name,messageSha256:sha(error.message)};}
 row.finishedAt=new Date().toISOString();await checkpoint({phase:'ticket-workflow-result',...row});return row;
}

export async function withTemporaryNativeAgentEmail({s,agent,member,nativeGroupId,runId,run,nativeRunner}){
 assert(Number.isSafeInteger(nativeGroupId)&&nativeGroupId>0);assert.equal(typeof member?.email,'string');assert(member.email);
 const original=s.model.services['zammad-runtime-bootstrap'].environment.WASALX_ZAMMAD_AGENT_EMAIL;assert(original&&original!==member.email);
 const observed=await agent.page.evaluate(async()=>{const r=await fetch('/api/v1/users/me',{cache:'no-store'});if(!r.ok)throw Error('Native Agent readback unavailable');const u=await r.json();return{id:u.id,email:u.email}});
 assert.equal(observed.id,agent.actorId);assert.equal(observed.email,original);
 const factory=nativeRunner??(await import('./simulation-email-stages.mjs')).nativeFixtureRunner,ruby=await factory(s,runId),input={agentId:agent.actorId,originalEmail:original,targetEmail:member.email,targetGroupId:nativeGroupId};
 await s.checkpoint({phase:'ticket-workflow-native-email-intent',agentId:agent.actorId,groupId:nativeGroupId,originalSha256:sha(original),targetSha256:sha(member.email)});
 let value,primary;try{const setup=await ruby('channel-fixture.rb',{action:'command-agent-email-setup',...input});assert.equal(setup.adjusted,true);assert.equal(setup.agentId,agent.actorId);assert.equal(setup.groupId,nativeGroupId);assert.equal(setup.originalSha256,sha(original));assert.equal(setup.targetSha256,sha(member.email));const changed=await agent.page.evaluate(async()=>{const r=await fetch('/api/v1/users/me',{cache:'no-store'});if(!r.ok)throw Error('Adjusted Agent readback unavailable');const u=await r.json();return{id:u.id,email:u.email}});assert.equal(changed.id,agent.actorId);assert.equal(changed.email,member.email);value=await run();}catch(error){primary=error;}
 if(primary?.qualificationEffectsUnsettled){let holdFailure;try{await s.checkpoint({phase:'ticket-workflow-native-email-held-for-reconciliation',agentId:agent.actorId,groupId:nativeGroupId,originalSha256:sha(original),targetSha256:sha(member.email),effectSettlement:false});}catch(error){holdFailure=error;}if(holdFailure)throw new AggregateError([primary,holdFailure],'Effect settlement and held-state checkpoint both failed');throw primary;}
 let restoration;try{const restored=await ruby('channel-fixture.rb',{action:'command-agent-email-restore',...input});assert.equal(restored.restored,true);assert.equal(restored.agentId,agent.actorId);assert.equal(restored.groupId,nativeGroupId);assert.equal(restored.originalSha256,sha(original));const current=await agent.page.evaluate(async()=>{const r=await fetch('/api/v1/users/me',{cache:'no-store'});if(!r.ok)throw Error('Restored Agent readback unavailable');const u=await r.json();return{id:u.id,email:u.email}});assert.equal(current.id,agent.actorId);assert.equal(current.email,original);await s.checkpoint({phase:'ticket-workflow-native-email-restored',agentId:agent.actorId,groupId:nativeGroupId,originalSha256:sha(original)});}catch(error){restoration=error;}
 if(primary&&restoration)throw new AggregateError([primary,restoration],'Ticket workflow and native Agent restoration both failed');if(primary)throw primary;if(restoration)throw restoration;return value;
}

export async function withTicketCommandActorFixture({s,agent,request,group,customerParticipant,nativeGroupId,runId,run,verifiedNativeActor,memberUserId=s.ownerId,withNativeIdentity=withTemporaryNativeAgentEmail,enableRoster=enableSenderRoster,restoreRoster=restoreSenderRoster}){
 const native=verifiedNativeActor??assertNativeAgent(await agent.verify(),agent.actorId);
 const member=(await request('/api/team')).members.find(row=>row.user_id===memberUserId);assert(member&&member.state==='ACTIVE'&&['tenant_owner','tenant_admin','supervisor','agent'].includes(member.role));assert(Array.isArray(member.whatsapp_numbers));
 if(verifiedNativeActor){assert(Number.isSafeInteger(native.id)&&native.id>0&&native.active===true);assert.equal(native.email,member.email,'Exact projected command email required');}
 return withNativeIdentity({s,agent,member,nativeGroupId,runId,run:async()=>{
  const capturePath='/api/group-workspace/groups/'+group.groupId,settingsPath='/api/group-workspace/settings',oldCapture=await request(capturePath),oldSettings=await request(settingsPath);let numbersChanged=false,unsettledError,value,primary;
 try{
  await enableRoster({request,connectionId:group.connectionId,capturePath,settingsPath,oldCapture,oldSettings,prefix:'ticket-workflow'});
  const roster=await s.scoped('SELECT external_participant_id,normalized_phone FROM group_workspace_participants WHERE whatsapp_group_id=$1 ORDER BY external_participant_id',[group.groupId]);
  let selected;for(const row of roster){if(row.external_participant_id===customerParticipant||!/^\+[1-9][0-9]{5,14}$/u.test(row.normalized_phone??'')||row.external_participant_id!==row.normalized_phone.slice(1)+'@c.us')continue;const conflicts=await s.scoped('SELECT id FROM tenant_memberships WHERE id<>$1 AND $2=ANY(whatsapp_numbers)',[member.id,row.normalized_phone]);if(!conflicts.length){selected=row;break;}}
  assert(selected,'No actual isolated noncustomer roster participant');
  const setMembership=async mapped=>{
   try{await s.directCallbacks.drainEffects();}catch(error){error.qualificationEffectsUnsettled=true;unsettledError=error;throw error;}
   const current=(await request('/api/team')).members.find(row=>row.id===member.id);assert(current&&current.user_id===member.user_id&&current.email===member.email&&current.role===member.role&&current.state===member.state&&Array.isArray(current.whatsapp_numbers));
   const numbers=mapped?[...new Set([...member.whatsapp_numbers,selected.normalized_phone])]:member.whatsapp_numbers.filter(number=>number!==selected.normalized_phone);
   if(JSON.stringify(current.whatsapp_numbers)!==JSON.stringify(numbers)){numbersChanged=true;await request('/api/team/members/'+member.id,'PATCH',{role:member.role,state:member.state,expectedVersion:Number(current.version),whatsappNumbers:numbers},'ticket-workflow-actor-number');}
   assert.deepEqual((await request('/api/team')).members.find(row=>row.id===member.id)?.whatsapp_numbers,numbers);
   const actual=(await s.scoped('SELECT * FROM app.ticket_command_actor($1,$2,$3,$4)',[s.tenantId,group.connectionId,group.groupRef,selected.external_participant_id]))[0];assert(actual?.source_authorized);assert.equal(actual.member_id,mapped?member.id:null);if(mapped){assert.equal(actual.member_role,member.role);assert.equal(actual.member_email,member.email);}
   return actual;
  };
  await setMembership(true);
   value=await run({member,participant:selected.external_participant_id,nativeActorId:native.id,setMembership});
  }catch(error){primary=error;}
  if(unsettledError)throw unsettledError;
  await s.directCallbacks.drainEffects().catch(error=>{error.qualificationEffectsUnsettled=true;throw error;});
  if(numbersChanged){const current=(await request('/api/team')).members.find(row=>row.id===member.id);assert(current&&current.role===member.role&&current.state===member.state);await request('/api/team/members/'+member.id,'PATCH',{role:member.role,state:member.state,expectedVersion:Number(current.version),whatsappNumbers:member.whatsapp_numbers},'ticket-workflow-actor-restore');assert.deepEqual((await request('/api/team')).members.find(row=>row.id===member.id)?.whatsapp_numbers,member.whatsapp_numbers);}
  await restoreRoster({request,capturePath,settingsPath,oldCapture,oldSettings,prefix:'ticket-workflow'});await s.checkpoint({phase:'ticket-workflow-actor-restored',memberSha256:sha(member.id),numbersRestored:true});
  if(primary)throw primary;return value;
 }});
}

// Called only by the admitted group-command stage; every effect remains actual
// worker/native/API activity, while control simulates the provider boundary.
export async function runTicketWorkflowChecks(s,{group,agent,request,registry,runId,bindingPath,bindingBody,selectedTestIds=ticketWorkflowTestIds,customerParticipant,presentation}){
 const selected=new Set(selectedTestIds);assert([...selected].every(id=>ticketWorkflowTestIds.includes(id)));if(!selected.size)return[];
 const h=s.directCallbacks;for(const name of ['control','drainEffects','providerRead','assertIsolatedRuntime'])assert.equal(typeof h[name],'function');await h.assertIsolatedRuntime({evidenceMode:'simulated',tenantId:s.tenantId,connectionId:group.connectionId});await h.drainEffects();
 await agent.page.setViewportSize({width:1440,height:1000});const nativeRead=presentation?.nativeRead??(path=>agent.page.evaluate(async path=>{const r=await fetch(path,{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Native workflow readback unavailable '+r.status);return r.json();},path));
 const states=await nativeRead('/api/v1/ticket_states'),closed=states.find(row=>row.name==='closed');assert(closed);
 const rows=[],saved=new Map();let counter=0;
 const poll=async read=>{const end=Date.now()+120000;while(Date.now()<end){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,300));}throw Error('Ticket workflow unsettled; preserve original intent and do not replay');};
 const assignment=async event=>(await request('/api/bot-flows/ticket-events')).bindings.find(row=>row.event===event&&row.whatsapp_group_id===group.groupId);
 const set=async(event,mode,flowVersionId)=>{const current=await assignment(event);await request('/api/bot-flows/ticket-events','POST',{event,groupId:group.groupId,mode,flowVersionId:flowVersionId??null,expectedRevision:Number(current?.revision??0)},'workflow-bind-'+event+'-'+(++counter));};
 const publish=async definition=>{const created=await request('/api/bot-flows','POST',definition,'workflow-create-'+(++counter));assert(created.id);await request('/api/bot-flows/'+created.id+'/activate','POST',{expectedRevision:Number(created.revision),expectedActiveFlowVersionId:null},'workflow-activate-'+counter);await set(definition.event,'CUSTOM',created.id);return created.id;};
 const snapshot=async()=>({executions:await s.scoped('SELECT id,state,native_action_state FROM ticket_event_executions WHERE correlation_id IN (SELECT id FROM case_correlations WHERE group_binding_id=$1) ORDER BY id',[(await request(bindingPath)).binding_id]),deliveries:await s.scoped('SELECT id,state,attempts,external_message_id FROM delivery_outbox WHERE connection_id=$1 ORDER BY id',[group.connectionId]),links:await s.scoped('SELECT id,zammad_ticket_id,zammad_article_id FROM message_links WHERE connection_id=$1 ORDER BY id',[group.connectionId])});
 const inboxFor=input=>s.scoped("SELECT id,status,processed_at,lease_id,lease_expires_at,safe_error FROM event_inbox WHERE connection_id=$1 AND provider_event_id_sha256=app.webhook_event_id_sha256($2,$1,'WAHA',$3)",[group.connectionId,s.tenantId,input.eventId]);
 const emit=async(label,text,participant=customerParticipant,quotedMessageId)=>{
  const input={eventId:simulationEventId(runId+'-workflow-'+label),messageId:'false_'+group.groupRef+'_'+runId+'-workflow-'+label,chatId:group.groupRef,participant,text,...(quotedMessageId?{quotedMessageId}:{})};assert.equal((await inboxFor(input)).length,0,'Prior input requires reconciliation');await registry.register({kind:'inbound',eventId:input.eventId});await s.checkpoint({phase:'intent',step:'ticket-workflow-'+label,input});const receipt=await h.control({action:'inbound',input});await s.checkpoint({phase:'accepted',step:'ticket-workflow-'+label,receipt});
  const inbox=await poll(async()=>{const row=(await inboxFor(input))[0];return row?.processed_at&&row.lease_id===null&&row.lease_expires_at===null?row:null;});assertIngressReceipts(receipt,false,inbox.id);await h.drainEffects();return{input,inbox};
 };
 const correlate=async input=>{const links=await s.scoped('SELECT zammad_ticket_id FROM message_links WHERE connection_id=$1 AND external_message_id=$2',[group.connectionId,input.messageId]);assert.equal(links.length,1);const cases=await s.scoped('SELECT id,state,generation,zammad_ticket_id FROM case_correlations WHERE group_binding_id=$1 AND zammad_ticket_id=$2 AND replaced_by_correlation_id IS NULL',[(await request(bindingPath)).binding_id,links[0].zammad_ticket_id]);assert.equal(cases.length,1);return{...cases[0],ticketId:String(links[0].zammad_ticket_id),input};};
 const create=async label=>{const reference=(BigInt('0x'+sha(runId+'-'+label).slice(0,12))%9000000000n+1000000000n).toString();assert.equal((await s.scoped('SELECT id FROM case_correlations WHERE group_binding_id=$1 AND normalized_reference=$2',[(await request(bindingPath)).binding_id,reference])).length,0);const emitted=await emit(label,'ID '+reference);assert.equal(emitted.inbox.status,'PROCESSED');return{...await correlate(emitted.input),reference};};
 const executionFor=async(target,event,source)=>{// Same tuple/serialization as packages/core ticketEventSourceHash; no generated-code import in frozen driver closure.
 const sourceHash=sha(JSON.stringify(['INBOUND',group.connectionId,source.messageId]));const executions=await s.scoped('SELECT id,state,mode,flow_version_id,native_action_state FROM ticket_event_executions WHERE correlation_id=$1 AND event=$2 AND source_sha256=$3',[target.id,event,sourceHash]);assert.equal(executions.length,1);return executions[0];};
 const feedback=async(target,execution,expectedText,quoteId,providerBefore)=>{
  const deliveries=await poll(async()=>{const values=await s.scoped('SELECT id,state,attempts,external_message_id,message_body,reply_to_message_id,idempotency_key,zammad_article_id,ticket_event_execution_id FROM delivery_outbox WHERE ticket_event_execution_id=$1 ORDER BY id',[execution.id]);return values.length===1&&values[0].state==='SENT'?values:null;});const articles=await nativeRead('/api/v1/ticket_articles/by_ticket/'+target.ticketId),article=assertWorkflowFeedback({execution,deliveries,articles,expectedText,quoteId}),providerReceipt=assertIncludedReceipt(providerBefore,await h.providerRead(),deliveries[0],group.groupRef);
  let operation='ticket-workflow-feedback-navigation';try{
   if(presentation){const ticket=await nativeRead('/api/v1/tickets/'+target.ticketId);await presentation.observeFeedback(ticket,article,expectedText);}else {
   await agent.page.goto(s.nativeOrigin+'/desktop/tickets/'+target.ticketId);
   operation='ticket-workflow-feedback-admission';await admitNativeMailUi(agent.page);
   const bubble=agent.page.locator('[data-test-id="article-bubble-container-'+article.id+'"]');operation='ticket-workflow-feedback-bubble';await bubble.waitFor({state:'visible',timeout:20000});
   operation='ticket-workflow-feedback-text';await bubble.getByText(expectedText,{exact:true}).waitFor({state:'visible'});}
  }catch(error){error.qualificationOperation=operation;throw error;}
  const proof={executionId:execution.id,flowVersionId:execution.flow_version_id,ticketId:target.ticketId,articleId:article.id,deliveryId:deliveries[0].id,providerReceipt,feedbackSha256:sha(expectedText),quoteSha256:sha(quoteId),rendered:true};await s.checkpoint({phase:'ticket-workflow-feedback-proof',proof});return proof;
 };
 const duplicate=async(input,inbox)=>{const before=await snapshot(),providerBefore=await h.providerRead();await s.checkpoint({phase:'intent',step:'ticket-workflow-duplicate',eventId:input.eventId});const receipt=await h.control({action:'inbound',input});assertIngressReceipts(receipt,true,inbox.id);await h.drainEffects();assert.deepEqual(await snapshot(),before);assert.deepEqual(await h.providerRead(),providerBefore);return{inboxId:inbox.id,eventId:input.eventId,unchanged:true};};
 const close=async target=>{const original=await nativeRead('/api/v1/tickets/'+target.ticketId);assert.notEqual(Number(original.state_id),Number(closed.id));const before=await s.scoped('SELECT id FROM zammad_ticket_state_events WHERE zammad_ticket_id=$1',[target.ticketId]);await s.checkpoint({phase:'intent',step:'ticket-workflow-close',ticketId:target.ticketId,stateId:closed.id});const result=presentation?await presentation.close(original,closed):await updateNativeTicketState(agent.page,Number(target.ticketId),Number(closed.id));assert.equal(Number(result.state_id),Number(closed.id));await s.checkpoint({phase:'accepted',step:'ticket-workflow-close',ticketId:target.ticketId});return poll(async()=>{const events=await s.scoped(`SELECT id,idempotency_key,request_sha256,processing_state,lifecycle_state,zammad_ticket_id,zammad_ticket_number,zammad_state_id,zammad_state_name,zammad_state_type_name,to_char(transitioned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS transitioned_at FROM zammad_ticket_state_events WHERE zammad_ticket_id=$1 AND lifecycle_state='RESOLVED' ORDER BY created_at,id`,[target.ticketId]);const fresh=events.filter(row=>!before.some(old=>old.id===row.id));return fresh.length===1&&fresh[0].processing_state==='APPLIED'?fresh[0]:null;});};
 const record=async(index,run)=>{if(!selected.has(ticketWorkflowTestIds[index]))return;const row=await observeTicketWorkflowResult({testId:presentation?presentation.currentId(ticketWorkflowTestIds[index]):ticketWorkflowTestIds[index],run,captureBinding:presentation?.captureBinding??(()=>captureNativeAgentEvidence(agent.page,agent.actorId,s.tenantId)),contextId:presentation?.contextId??'zammad_agent-en-desktop',bindResult:presentation?.bindResult??bindNativeAgentResult,checkpoint:s.checkpoint});rows.push(row);if(row.result==='failed'){await h.drainEffects();for(const event of saved.keys())await set(event,'OFF');}};
 try{
  for(const event of ['reference_received','ticket_closed','quoted_command']){saved.set(event,await assignment(event)??null);await set(event,'OFF');}
  const created=await request('/api/rules','POST',{name:'Ticket workflows '+runId,matcherType:'exact_length',pattern:'[0-9]{10}',digitLength:10,teamSenderPolicy:'include',priority:1,enabled:true,savedExamples:[{name:'Reference',message:'1234567890',sender:'customer',expectedMatches:['1234567890']}]},'workflow-reference-rule');const draft=await findRuleSet(request,created.id);await request('/api/rule-sets/'+draft.id+'/activate','POST',{expectedRevision:Number(draft.revision),expectedActiveRuleSetId:null,expectedActiveRevision:null},'workflow-reference-rule-activate');await request(bindingPath,'PUT',bindingBody(await request(bindingPath),draft.id),'workflow-reference-bind');
  // The one-time channel disclosure is settled before per-event feedback counts.
  const warmUp=await create('warm-up'),nativeGroupId=Number((await nativeRead('/api/v1/tickets/'+warmUp.ticketId)).group_id);assert(Number.isSafeInteger(nativeGroupId)&&nativeGroupId>0);
  await record(0,async()=>{
   await publish(ticketWorkflowDefinition('ticket_closed','Close '+runId));const target=await create('close'),providerBefore=await h.providerRead(),event=await close(target);await h.drainEffects();const executions=await s.scoped('SELECT id,state,mode,flow_version_id FROM ticket_event_executions WHERE correlation_id=$1 AND event=$2',[target.id,'ticket_closed']);assert.equal(executions.length,1);const proof=await feedback(target,executions[0],'Workflow ticket_closed',target.input.messageId,providerBefore),before=await snapshot(),providerStable=await h.providerRead(),articles=await nativeRead('/api/v1/ticket_articles/by_ticket/'+target.ticketId),payload=closeReplayPayload(event,s.tenantId);
   await s.checkpoint({phase:'intent',step:'ticket-workflow-close-replay',eventId:event.id,requestSha256:event.request_sha256});const code="require 'json';puts JSON.generate(WasalxTicketStateJob.perform_now(JSON.parse(ENV.fetch('WASALX_REPLAY_PAYLOAD'))))",replay=parseRailsJson(await s.run('docker',['exec','-e','WASALX_REPLAY_PAYLOAD='+JSON.stringify(payload),s.containers['zammad-railsserver'].Id,'bundle','exec','rails','runner',code]));assert.equal(replay.id,event.id);assert.equal(replay.duplicate,true);await h.drainEffects();assert.deepEqual(await snapshot(),before);assert.deepEqual(await h.providerRead(),providerStable);assert.deepEqual(await nativeRead('/api/v1/ticket_articles/by_ticket/'+target.ticketId),articles);await set('ticket_closed','OFF');return{...proof,nativeEventId:event.id,replaySameSource:true,noExtraEffects:true};
  });
  await record(1,async()=>{
   const nativeActor=presentation?await presentation.nativeActor():undefined;
   if(presentation){const member=(await request('/api/team')).members.find(row=>row.user_id===presentation.operator.userId);assert(member&&member.email===nativeActor.email,'Exact projected command email required');}
   return withTicketCommandActorFixture({s,agent,request,group,customerParticipant,nativeGroupId,runId,...(presentation?{verifiedNativeActor:nativeActor,memberUserId:presentation.operator.userId,withNativeIdentity:async({run})=>run()}:{}),run:async actor=>{const proofs=[];
   for(const mode of ['AGENTS','ANYONE','SPECIFIC']){
    const permission=mode==='SPECIFIC'?{mode,memberIds:[actor.member.id]}:{mode};await publishTicketCommandMode({mode,actor,publish,definition:ticketWorkflowDefinition('quoted_command',mode+' '+runId,permission)});
    for(const allowed of mode==='ANYONE'?[true]:[false,true]){const mapped=allowed&&mode!=='ANYONE';await actor.setMembership(mapped);const target=await create('command-'+mode+'-'+allowed),participant=actor.participant,before=await snapshot(),beforeTicket=await nativeRead('/api/v1/tickets/'+target.ticketId),beforeArticles=await nativeRead('/api/v1/ticket_articles/by_ticket/'+target.ticketId),providerBefore=await h.providerRead();const sourceActor=(await s.scoped('SELECT * FROM app.ticket_command_actor($1,$2,$3,$4)',[s.tenantId,group.connectionId,group.groupRef,participant]))[0];assert(sourceActor?.source_authorized);assert.equal(sourceActor.member_id,mapped?actor.member.id:null);const emitted=await emit('command-'+mode+'-'+allowed+'-input','/close',participant,target.input.messageId);
     if(!allowed){const denied=assertDeniedWorkflow({inbox:emitted.inbox,before,after:await snapshot(),beforeTicket,afterTicket:await nativeRead('/api/v1/tickets/'+target.ticketId),beforeArticles,afterArticles:await nativeRead('/api/v1/ticket_articles/by_ticket/'+target.ticketId),messageId:emitted.input.messageId,quotedMessageId:target.input.messageId});assert.deepEqual(await h.providerRead(),providerBefore);const deniedArticles=await nativeRead('/api/v1/ticket_articles/by_ticket/'+target.ticketId),replay=await duplicate(emitted.input,emitted.inbox);assert.deepEqual(await nativeRead('/api/v1/ticket_articles/by_ticket/'+target.ticketId),deniedArticles,'Denied command replay created another native article');proofs.push({mode,allowed:false,inboxId:emitted.inbox.id,...denied,duplicate:replay,noProviderDelivery:true});}
     else{assert.equal(emitted.inbox.status,'PROCESSED');const execution=await executionFor(target,'quoted_command',emitted.input);assert.equal(execution.native_action_state,'SUCCEEDED');const ticket=await nativeRead('/api/v1/tickets/'+target.ticketId);assert.equal(Number(ticket.state_id),Number(closed.id));const proof=await feedback(target,execution,'Workflow quoted_command',target.input.messageId,providerBefore),nativeCloseProjection=await waitQuotedCommandClosure({scoped:s.scoped,poll,tenantId:s.tenantId,correlationId:target.id,ticketId:target.ticketId,executionId:execution.id});await h.drainEffects();proofs.push({mode,allowed:true,...proof,nativeCloseProjection,duplicate:await duplicate(emitted.input,emitted.inbox)});}
     await s.checkpoint({phase:'ticket-workflow-policy-proof',proof:proofs.at(-1)});
    }
   }await set('quoted_command','OFF');return{policies:proofs,actorMembershipSha256:sha(actor.member.id),actorParticipantSha256:sha(actor.participant),actualNativeAgentId:actor.nativeActorId};}});
  });
  await record(2,async()=>{
   await publish(ticketWorkflowDefinition('reference_received','Reference '+runId));const before=await h.providerRead(),target=await create('reference'),created=await executionFor(target,'reference_received',target.input),proofs=[await feedback(target,created,'Reference CREATED',target.input.messageId,before)];await close(target);await h.drainEffects();const stable=await h.providerRead(),reopened=await emit('reference-reopen','ID '+target.reference),same=await correlate(reopened.input);assert.equal(same.id,target.id);assert.equal(Number(same.generation),Number(target.generation));assert.equal(same.ticketId,target.ticketId);assert.equal(same.state,'OPEN');const execution=await executionFor(target,'reference_received',reopened.input);proofs.push(await feedback(target,execution,'Reference REOPENED',reopened.input.messageId,stable));const noExtra=await h.providerRead(),append=await emit('reference-append','ID '+target.reference),appended=await executionFor(target,'reference_received',append.input);assert.equal(appended.state,'SKIPPED');assert.equal((await s.scoped('SELECT id FROM delivery_outbox WHERE ticket_event_execution_id=$1',[appended.id])).length,0);assert.deepEqual(await h.providerRead(),noExtra);const replay=await duplicate(reopened.input,reopened.inbox);await set('reference_received','OFF');return{transitions:proofs,sameTicketAndGeneration:true,appendSkipped:true,duplicate:replay};
  });
 }finally{
  if(presentation?.unsettled){await s.checkpoint({phase:'portal-workflow-configuration-held',intent:presentation.intent,outcome:'UNKNOWN'});}else {
  await h.drainEffects();for(const[event,original]of [...saved].reverse()){const current=await assignment(event);assert(current,'Owned assignment disappeared');await set(event,original?.mode??'INHERIT',original?.flow_version_id);const restored=await assignment(event);assert.equal(restored.mode,original?.mode??'INHERIT');assert.equal(restored.flow_version_id,original?.flow_version_id??null);}await s.checkpoint({phase:'ticket-workflow-bindings-restored',events:[...saved.keys()]});}
 }
 return rows;
}
