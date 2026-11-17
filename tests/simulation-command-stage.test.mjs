import test from'node:test';import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import{testIds}from'../scripts/release/command-stage.mjs';import{assertOneOffStopped}from'../scripts/release/command-guards.mjs';
test('legacy command plus three exact ticket workflow tests and no historic private paths or setup replay',async()=>{assert.equal(testIds.length,4);assert.equal(new Set(testIds).size,4);for(const f of ['command-stage.mjs','command-once.mjs','command-business.mjs']){const s=await readFile(new URL('../scripts/release/'+f,import.meta.url),'utf8');assert(!s.includes('/srv/wasalx-fast'));assert(!s.includes('scenario-first19'));} });
test('command refreshes privileged auth and reuses the fresh-group customer',async()=>{const [stage,business]=await Promise.all(['command-stage.mjs','command-business.mjs'].map(f=>readFile(new URL('../scripts/release/'+f,import.meta.url),'utf8')));assert.match(stage,/await s\.ensurePrivilegedOwner\(\)/);assert.match(stage,/customerParticipant:args\.config\.customerParticipant/);assert.match(business,/participant:s\.customerParticipant/);});
test('active oneoff forbids ordinary consumer restoration',()=>{assert.throws(()=>assertOneOffStopped({State:{Running:true,Restarting:false,Status:'running'}}));assertOneOffStopped(null);});
import{assertCommandCompleted}from'../scripts/release/command-guards.mjs';
test('completed command requires durable timestamp and fully cleared leases',()=>{const x={status:'PROCESSED',processed_at:'2026-09-12T00:00:00Z',lease_id:null,lease_expires_at:null};assertCommandCompleted(x);for(const patch of [{status:'PROCESSING'},{processed_at:null},{lease_id:'expired'},{lease_expires_at:'2020-01-01'}])assert.throws(()=>assertCommandCompleted({...x,...patch}));});

test('command result records durable execution bounds and exact restricted native identity',async()=>{const [stage,business]=await Promise.all(['command-stage.mjs','command-business.mjs'].map(f=>readFile(new URL('../scripts/release/'+f,import.meta.url),'utf8')));assert(business.includes("const startedAt=new Date().toISOString()"));assert(business.includes("contextId:'zammad_agent-en-desktop'"));assert(business.includes("startedAt,finishedAt:new Date().toISOString()"));for(const proof of ["await agent.verify()","actorRef:digest('zammad:'+agent.actorId)","tenantRef:digest(s.tenantId)","actorVerified:true"])assert(stage.includes(proof));});

import{createHash}from'node:crypto';
import{ticketWorkflowTestIds,ticketWorkflowDefinition,assertWorkflowFeedback,assertDeniedWorkflow,closeReplayPayload,observeTicketWorkflowResult,publishTicketCommandMode,runTicketWorkflowChecks}from'../scripts/release/command-ticket-workflows.mjs';
import{nativeAgentBinding}from'../scripts/release/simulation-native-agent.mjs';
const nativeBinding=()=>nativeAgentBinding({id:17,roles:[2],locale:'en'},{width:1440,height:1000},'tenant-fixture');
test('unselected ticket workflows return before accessing sessions or provider callbacks',async()=>{
 const forbidden=new Proxy({},{get(){throw Error('Unselected effect');}});
 assert.deepEqual(await runTicketWorkflowChecks(forbidden,{selectedTestIds:[]}),[]);
 await assert.rejects(runTicketWorkflowChecks(forbidden,{selectedTestIds:['unknown']}));
});
test('workflow definitions expose exactly the bounded close, quote policies and created/reopened branches',()=>{
 const close=ticketWorkflowDefinition('ticket_closed','Closed');assert.equal(close.nodes[0].text,'Workflow ticket_closed');assert.equal(close.nodes[0].quote,'ORIGINAL');assert.equal(close.nodes.filter(n=>n.type==='send_text').length,1);
 for(const permission of [{mode:'AGENTS'},{mode:'ANYONE'},{mode:'SPECIFIC',memberIds:['member-fixture']}]){const quoted=ticketWorkflowDefinition('quoted_command','Quoted',permission);assert.deepEqual(quoted.permission,permission);assert.equal(quoted.command,'/close');assert.equal(quoted.nodes[0].type,'close_ticket');assert.equal(quoted.nodes.filter(n=>n.type==='send_text').length,1);}
 const reference=ticketWorkflowDefinition('reference_received','Reference');assert.deepEqual(reference.nodes.filter(n=>n.type==='condition').map(n=>n.value),[true,'CREATED','REOPENED']);assert.equal(reference.nodes[0].variable,'message.matches_reference');assert.equal(reference.nodes[0].onFalse,'done');assert.equal(reference.nodes[2].onFalse,'done');assert.equal(reference.nodes.find(n=>n.type==='send_text').quote,'CURRENT');assert.equal(reference.maxSteps,5);assert.equal(reference.nodes.filter(n=>n.type==='send_text').length,1);
});
const feedbackFixture=()=>({execution:{id:'execution',state:'APPLIED',mode:'CUSTOM'},deliveries:[{id:'delivery',ticket_event_execution_id:'execution',state:'SENT',attempts:1,message_body:'Visible feedback',reply_to_message_id:'original',idempotency_key:'effect-key',zammad_article_id:31}],articles:[{id:31,body:'Visible feedback',preferences:{wasalx_ticket_event_execution_id:'execution',wasalx_bot_delivery_key:'effect-key'}}],expectedText:'Visible feedback',quoteId:'original'});
test('feedback joins exact native article, durable execution and once-only provider delivery',()=>{
 assert.equal(assertWorkflowFeedback(feedbackFixture()).id,31);
 for(const corrupt of [f=>f.deliveries.push({...f.deliveries[0]}),f=>f.articles.push({...f.articles[0]}),f=>f.deliveries[0].attempts=2,f=>f.deliveries[0].reply_to_message_id='other',f=>f.articles[0].preferences.wasalx_bot_delivery_key='other',f=>f.deliveries[0].state='OUTCOME_UNKNOWN',f=>f.articles[0].body='Other feedback']){const f=feedbackFixture();corrupt(f);assert.throws(()=>assertWorkflowFeedback(f));}
});
test('denied quoted command records one internal transcript with no send or business-state change',()=>{
 const note={id:31,internal:true,preferences:{wasalx_command_execution_id:'execution',wasalx_command_disposition:'TRANSCRIPT_ONLY_DENIED',wasalx_external_message_id:'command',wasalx_quoted_external_message_id:'target',wasalx_origin:'provider'}};
 const f={inbox:{status:'PROCESSED',safe_error:null,processed_at:'2026-10-07T00:00:00Z',lease_id:null,lease_expires_at:null},before:{executions:[],deliveries:[],links:[]},after:{executions:[{id:'execution',state:'APPLIED',native_action_state:'SUCCEEDED'}],deliveries:[],links:[{id:'link',zammad_article_id:31}]},beforeTicket:{state_id:1,owner_id:2,group_id:3,wasalx_correlation_status:'OPEN',updated_at:'before'},afterTicket:{state_id:1,owner_id:2,group_id:3,wasalx_correlation_status:'OPEN',updated_at:'after'},beforeArticles:[],afterArticles:[note],messageId:'command',quotedMessageId:'target'};
 assert.equal(assertDeniedWorkflow(f).articleId,31);
 for(const patch of [{inbox:{...f.inbox,status:'QUARANTINED'}},{after:{...f.after,deliveries:[{id:'unexpected'}]}},{after:{...f.after,executions:[{...f.after.executions[0],state:'SKIPPED'}]}},{afterArticles:[{...note,internal:false}]},{afterTicket:{...f.afterTicket,state_id:4}}])assert.throws(()=>assertDeniedWorkflow({...f,...patch}));
});
test('native close replay keeps the acknowledged microsecond timestamp and exact source fingerprint',()=>{
 const normalized={ticketId:'42',ticketNumber:'10042',stateId:4,stateName:'closed',stateTypeName:'closed',lifecycleState:'RESOLVED',transitionedAt:'2026-10-06T00:00:00.123456Z',idempotencyKey:'original-source'};
 const event={processing_state:'APPLIED',lifecycle_state:'RESOLVED',zammad_ticket_id:'42',zammad_ticket_number:'10042',zammad_state_id:4,zammad_state_name:'closed',zammad_state_type_name:'closed',transitioned_at:normalized.transitionedAt,idempotency_key:normalized.idempotencyKey,request_sha256:createHash('sha256').update(JSON.stringify(normalized)).digest('hex')};
 const payload=closeReplayPayload(event,'tenant');assert.equal(payload.transitioned_at,event.transitioned_at);assert.equal(payload.idempotency_key,event.idempotency_key);
 for(const patch of [{transitioned_at:'2026-10-06T00:00:00.123Z'},{idempotency_key:'new-source'},{processing_state:'PENDING'},{request_sha256:'0'.repeat(64)}])assert.throws(()=>closeReplayPayload({...event,...patch},'tenant'));
});
test('a later workflow assertion failure preserves the previous bound result and records its own failure',async()=>{
 const checkpoints=[];const captureBinding=async()=>nativeBinding(),checkpoint=async row=>checkpoints.push(row);
 const first=await observeTicketWorkflowResult({testId:ticketWorkflowTestIds[0],run:async()=>({rendered:true,original:'first'}),captureBinding,checkpoint});
 const second=await observeTicketWorkflowResult({testId:ticketWorkflowTestIds[1],run:async()=>{throw Error('Later UI assertion');},captureBinding,checkpoint});
 assert.equal(first.result,'passed');assert.equal(second.result,'failed');assert.equal(checkpoints.length,2);assert.deepEqual(checkpoints[0].proof,first.proof);assert.equal(first.verifiedContext.nativeActor.id,17);assert.equal(second.verifiedContext.nativeActor.id,17);assert(second.proof.messageSha256);assert(Date.parse(second.finishedAt)>=Date.parse(second.startedAt));
});
test('failed actual identity capture can never leave a workflow observation passed',async()=>{
 const row=await observeTicketWorkflowResult({testId:ticketWorkflowTestIds[0],run:async()=>({rendered:true}),captureBinding:async()=>{throw Error('Actor unavailable');},checkpoint:async()=>{}});
 assert.equal(row.result,'failed');assert(row.proof.bindingFailure.messageSha256);assert.equal(row.verifiedContext,undefined);assert.equal(row.proof.actorVerified,undefined);
});
test('SPECIFIC publication remaps the same roster number before activation',async()=>{
 let mapped=false;const actor={setMembership:async value=>{mapped=value;}},published=[];
 const publish=async definition=>{published.push({mode:definition.permission.mode,mapped});assert(mapped || definition.permission.mode!=='SPECIFIC');};
 await publishTicketCommandMode({mode:'ANYONE',actor,publish,definition:ticketWorkflowDefinition('quoted_command','Anyone',{mode:'ANYONE'})});
 await publishTicketCommandMode({mode:'SPECIFIC',actor,publish,definition:ticketWorkflowDefinition('quoted_command','Specific',{mode:'SPECIFIC',memberIds:['member']})});
 assert.deepEqual(published,[{mode:'ANYONE',mapped:false},{mode:'SPECIFIC',mapped:true}]);
 mapped=false;await assert.rejects(publishTicketCommandMode({mode:'SPECIFIC',actor:{setMembership:async()=>{throw Error('Roster unavailable');}},publish,definition:ticketWorkflowDefinition('quoted_command','Specific',{mode:'SPECIFIC',memberIds:['member']})}),/Roster unavailable/);assert.equal(published.length,2);
});
test('workflow UI failure records only an allowlisted phase and error hash',async()=>{
 const secret='private article text';const error=Error(secret);error.qualificationOperation='ticket-workflow-feedback-text';
 const row=await observeTicketWorkflowResult({testId:ticketWorkflowTestIds[2],run:async()=>{throw error;},captureBinding:async()=>nativeBinding(),checkpoint:async()=>{}});
 assert.equal(row.proof.operation,'ticket-workflow-feedback-text');assert.equal(row.proof.messageSha256,createHash('sha256').update(secret).digest('hex'));assert(!JSON.stringify(row).includes(secret));
 error.qualificationOperation='private article text';const rejected=await observeTicketWorkflowResult({testId:ticketWorkflowTestIds[2],run:async()=>{throw error;},captureBinding:async()=>nativeBinding(),checkpoint:async()=>{}});assert.equal(rejected.proof.operation,undefined);
});

import{withTicketCommandActorFixture,withTemporaryNativeAgentEmail}from'../scripts/release/command-ticket-workflows.mjs';
test('one canonical roster PN serves denied nonmember and allowed member when fixed customer is absent',async()=>{
 const phone="+12025550106",participant='12025550106@c.us',customer='12025550104@c.us';
 const other="+12025550191",original={id:'member',user_id:'owner',email:'seeded@example.invalid',state:'ACTIVE',role:'tenant_owner',version:2,whatsapp_numbers:[other,phone]};let member=structuredClone(original),restored=false,drains=0;const patches=[];
 const request=async(path,method,body)=>{if(path==='/api/team')return{members:[structuredClone(member)]};if(method==='PATCH'){assert.equal(body.expectedVersion,member.version);patches.push(structuredClone(body));member={...member,version:member.version+1,whatsapp_numbers:body.whatsappNumbers};return{};}return{version:1};};
 const s={ownerId:'owner',tenantId:'tenant',scoped:async sql=>sql.includes('group_workspace_participants')?[{external_participant_id:participant,normalized_phone:phone}]:sql.includes('ticket_command_actor')?[{source_authorized:true,member_id:member.whatsapp_numbers.includes(phone)?member.id:null,member_role:member.role,member_email:member.email}]:[],directCallbacks:{drainEffects:async()=>{drains++;}},checkpoint:async()=>{}};
 const result=await withTicketCommandActorFixture({s,agent:{actorId:7,verify:async()=>({id:7,roles:[2],locale:'en'})},request,group:{groupId:'group',groupRef:'123@g.us',connectionId:'connection'},customerParticipant:customer,nativeGroupId:1,runId:'test',withNativeIdentity:async({run})=>run(),enableRoster:async()=>{},restoreRoster:async()=>{restored=true;},run:async actor=>{
  assert.equal(actor.participant,participant);assert.notEqual(actor.participant,customer);assert.equal(actor.nativeActorId,7);assert.deepEqual(member.whatsapp_numbers,[other,phone]);
  await actor.setMembership(false);assert.deepEqual(member.whatsapp_numbers,[other]);
  await actor.setMembership(true);assert.deepEqual(member.whatsapp_numbers,[other,phone]);
  return'actual fixture';}});
 assert.equal(result,'actual fixture');assert.deepEqual(patches.map(row=>row.whatsappNumbers),[[other],[other,phone],[other,phone]]);assert.equal(patches[2].expectedVersion,4);assert.deepEqual(member.whatsapp_numbers,original.whatsapp_numbers);assert(restored);assert(drains>=4);
});
test('unsettled actor effects hold membership and roster configuration for reconciliation',async()=>{
 let patched=false,restoreCalled=false;const member={id:'member',user_id:'owner',email:'seeded@example.invalid',state:'ACTIVE',role:'tenant_owner',version:2,whatsapp_numbers:[]};
 const request=async(path,method)=>{if(path==='/api/team')return{members:[member]};if(method==='PATCH')patched=true;return{};};
 const s={ownerId:'owner',tenantId:'tenant',nativePage:{evaluate:async()=>{throw Error('Bootstrap actor must not determine portal membership')}},scoped:async sql=>sql.includes('group_workspace_participants')?[{external_participant_id:'12025550106@c.us',normalized_phone:"+12025550106"}]:sql.includes('ticket_command_actor')?[{source_authorized:true,member_id:member.id,member_role:member.role,member_email:member.email}]:[],directCallbacks:{drainEffects:async()=>{throw Error('Unsettled owned effect');}},checkpoint:async()=>{}};
 await assert.rejects(withTicketCommandActorFixture({s,agent:{actorId:7,verify:async()=>({id:7,roles:[2],locale:'en'})},request,group:{groupId:'group',groupRef:'123@g.us',connectionId:'connection'},customerParticipant:'12025550104@c.us',nativeGroupId:1,runId:'test',withNativeIdentity:async({run})=>run(),enableRoster:async()=>{},restoreRoster:async()=>{restoreCalled=true;},run:async()=>{throw Error('UI failure');}}),/Unsettled owned effect/);assert.equal(patched,false);assert.equal(restoreCalled,false);
});

for(const scenario of ['workflow-error','caught-unsettled'])test('actor cleanup preserves '+scenario,async()=>{
 const phone="+12025550106",original={id:'member',user_id:'owner',email:'seeded@example.invalid',state:'ACTIVE',role:'tenant_owner',version:2,whatsapp_numbers:[]};let member=structuredClone(original),drains=0,restored=false;
 const failure=Error(scenario),request=async(path,method,body)=>{if(path==='/api/team')return{members:[structuredClone(member)]};if(method==='PATCH')member={...member,version:member.version+1,whatsapp_numbers:body.whatsappNumbers};return{};};
 const s={ownerId:'owner',tenantId:'tenant',scoped:async sql=>sql.includes('group_workspace_participants')?[{external_participant_id:'12025550106@c.us',normalized_phone:phone}]:sql.includes('ticket_command_actor')?[{source_authorized:true,member_id:member.id,member_role:member.role,member_email:member.email}]:[],directCallbacks:{drainEffects:async()=>{if(++drains===2&&scenario==='caught-unsettled')throw failure;}},checkpoint:async()=>{}};
 await assert.rejects(withTicketCommandActorFixture({s,agent:{actorId:7,verify:async()=>({id:7,roles:[2],locale:'en'})},request,group:{groupId:'group',groupRef:'123@g.us',connectionId:'connection'},customerParticipant:'12025550104@c.us',nativeGroupId:1,runId:'test',withNativeIdentity:async({run})=>run(),enableRoster:async()=>{},restoreRoster:async()=>{restored=true;},run:async actor=>{
  if(scenario==='workflow-error')throw failure;
  try{await actor.setMembership(false);}catch(error){assert.equal(error,failure);}return'caught';
 }}),error=>error===failure);
 assert.equal(restored,scenario==='workflow-error');assert.deepEqual(member.whatsapp_numbers,scenario==='workflow-error'?[]:[phone]);
 if(scenario==='caught-unsettled')assert.equal(failure.qualificationEffectsUnsettled,true);
});

import{commandSelection,commandTestId}from'../scripts/release/command-stage.mjs';
test('old-only and new-only selections execute only their declared business families',()=>{assert.deepEqual(commandSelection([{testId:commandTestId}]),{legacy:true,workflows:[]});for(const testId of ticketWorkflowTestIds)assert.deepEqual(commandSelection([{testId}]),{legacy:false,workflows:[testId]});assert.deepEqual(commandSelection([]),{legacy:false,workflows:[]});assert.deepEqual(commandSelection(undefined),{legacy:true,workflows:ticketWorkflowTestIds});assert.deepEqual(commandSelection([{testId:commandTestId},{testId:ticketWorkflowTestIds[1]},{testId:ticketWorkflowTestIds[1]}]),{legacy:true,workflows:[ticketWorkflowTestIds[1]]});});

// Existing native Agent ID/permission and portal member email must agree through an owned reversible fixture.
test('temporary native Agent email uses immutable preimage and restores after a failed workflow',async()=>{
 const calls=[],original='agent@native.invalid',target='owner@portal.invalid',s={model:{services:{'zammad-runtime-bootstrap':{environment:{WASALX_ZAMMAD_AGENT_EMAIL:original}}}},checkpoint:async row=>calls.push(row.phase)};let email=original;
 const agent={actorId:7,page:{evaluate:async()=>({id:7,email})}},member={email:target},nativeRunner=async()=>async(_file,input)=>{calls.push(input.action);if(input.action==='command-agent-email-setup'){assert.equal(email,original);email=target;return{adjusted:true,agentId:7,groupId:4,originalSha256:createHash('sha256').update(original).digest('hex'),targetSha256:createHash('sha256').update(target).digest('hex')}}assert.equal(input.action,'command-agent-email-restore');email=original;return{restored:true,agentId:7,groupId:4,originalSha256:createHash('sha256').update(original).digest('hex')}};
 await assert.rejects(withTemporaryNativeAgentEmail({s,agent,member,nativeGroupId:4,runId:'test',nativeRunner,run:async()=>{throw Error('workflow failed')}}),/workflow failed/);assert.equal(email,original);assert.deepEqual(calls,['ticket-workflow-native-email-intent','command-agent-email-setup','command-agent-email-restore','ticket-workflow-native-email-restored']);
});

test('native command identity mismatch fails before fixture mutation; collision still attempts exact restore',async()=>{
 const source='agent@native.invalid',target='owner@portal.invalid',s={model:{services:{'zammad-runtime-bootstrap':{environment:{WASALX_ZAMMAD_AGENT_EMAIL:source}}}},checkpoint:async()=>{}},member={email:target};let calls=0;
 const wrong={actorId:7,page:{evaluate:async()=>({id:8,email:source})}};await assert.rejects(withTemporaryNativeAgentEmail({s,agent:wrong,member,nativeGroupId:4,runId:'test',nativeRunner:async()=>{calls++;throw Error('must not reach fixture')},run:async()=>{calls++;}}));assert.equal(calls,0);
 const agent={actorId:7,page:{evaluate:async()=>({id:7,email:source})}},actions=[],nativeRunner=async()=>async(_file,input)=>{actions.push(input.action);if(input.action==='command-agent-email-setup')throw Error('command identity email collision');return{restored:true,agentId:7,groupId:4,originalSha256:createHash('sha256').update(source).digest('hex')}};
 await assert.rejects(withTemporaryNativeAgentEmail({s,agent,member,nativeGroupId:4,runId:'test',nativeRunner,run:async()=>{throw Error('must not run')}}),/collision/);assert.deepEqual(actions,['command-agent-email-setup','command-agent-email-restore']);
});

test('unsettled command effects retain native email and membership for reconciliation',async()=>{
 const original='agent@native.invalid',target='owner@portal.invalid',actions=[],phases=[];let email=original,rosterRestored=false;const member={id:'member',user_id:'owner',email:target,state:'ACTIVE',role:'tenant_owner',version:2,whatsapp_numbers:[]};
 const request=async(path,method,body)=>{if(path==='/api/team')return{members:[member]};if(method==='PATCH'){member.version++;member.whatsapp_numbers=body.whatsappNumbers;return{};}return{version:1}};
 const s={ownerId:'owner',tenantId:'tenant',model:{services:{'zammad-runtime-bootstrap':{environment:{WASALX_ZAMMAD_AGENT_EMAIL:original}}}},checkpoint:async row=>phases.push(row.phase),scoped:async sql=>sql.includes('group_workspace_participants')?[{external_participant_id:'12025550106@c.us',normalized_phone:"+12025550106"}]:sql.includes('ticket_command_actor')?[{source_authorized:true,member_id:member.id,member_role:member.role,member_email:member.email}]:[],directCallbacks:{drainEffects:async()=>{throw Error('Unsettled owned effect')}}};
 const agent={actorId:7,verify:async()=>({id:7,roles:[2],locale:'en'}),page:{evaluate:async()=>({id:7,email})}},nativeRunner=async()=>async(_file,input)=>{actions.push(input.action);if(input.action==='command-agent-email-setup'){email=target;return{adjusted:true,agentId:7,groupId:4,originalSha256:createHash('sha256').update(original).digest('hex'),targetSha256:createHash('sha256').update(target).digest('hex')}}throw Error('Native email restoration must wait for effect settlement')};
 await assert.rejects(withTicketCommandActorFixture({s,agent,request,group:{groupId:'group',groupRef:'123@g.us',connectionId:'connection'},customerParticipant:'12025550104@c.us',nativeGroupId:4,runId:'test',withNativeIdentity:args=>withTemporaryNativeAgentEmail({...args,nativeRunner}),enableRoster:async()=>{},restoreRoster:async()=>{rosterRestored=true},run:async()=>true}),/Unsettled owned effect/);
 assert.deepEqual(actions,['command-agent-email-setup']);assert.equal(email,target);assert.equal(rosterRestored,false);assert(phases.includes('ticket-workflow-native-email-held-for-reconciliation'));
});
test('accepted native email setup with failed readback and failed restoration retains both errors',async()=>{
 const original='agent@native.invalid',target='owner@portal.invalid',actions=[];let email=original,reads=0;const s={model:{services:{'zammad-runtime-bootstrap':{environment:{WASALX_ZAMMAD_AGENT_EMAIL:original}}}},checkpoint:async()=>{}},agent={actorId:7,page:{evaluate:async()=>{if(++reads===2)throw Error('Adjusted readback failed');return{id:7,email}}}},nativeRunner=async()=>async(_file,input)=>{actions.push(input.action);if(input.action==='command-agent-email-setup'){email=target;return{adjusted:true,agentId:7,groupId:4,originalSha256:createHash('sha256').update(original).digest('hex'),targetSha256:createHash('sha256').update(target).digest('hex')}}throw Error('Native restore failed')};
 await assert.rejects(withTemporaryNativeAgentEmail({s,agent,member:{email:target},nativeGroupId:4,runId:'test',nativeRunner,run:async()=>{throw Error('must not run')}}),error=>error instanceof AggregateError&&error.errors.length===2&&error.errors[0].message==='Adjusted readback failed'&&error.errors[1].message==='Native restore failed');assert.deepEqual(actions,['command-agent-email-setup','command-agent-email-restore']);assert.equal(email,target);
});

import{waitQuotedCommandClosure}from'../scripts/release/command-ticket-workflows.mjs';
const closureFixture=()=>{
 const instance='00000000-0000-4000-8000-000000000003',tenantId='tenant',correlationId='case',ticketId='20',executionId='command',eventId='native-event',request='a'.repeat(64),source=createHash('sha256').update(JSON.stringify(['NATIVE_STATE',instance,eventId])).digest('hex');
 return{tenantId,correlationId,ticketId,executionId,command:{id:executionId,correlation_id:correlationId,state:'APPLIED',native_action_state:'SUCCEEDED',native_action_snapshot:{tenant_id:tenantId,correlation_id:correlationId,ticket_id:ticketId,instance_id:instance,request_sha256:request},native_result:{state:'SUCCEEDED',execution_id:executionId,ticket_id:ticketId,request_sha256:request,closed_at:'2026-10-08T20:38:03.827000Z'}},event:{id:eventId,processing_state:'APPLIED',lifecycle_state:'RESOLVED',processed_at:'complete'},execution:{id:'close',correlation_id:correlationId,event:'ticket_closed',source_sha256:source,mode:'OFF',state:'SKIPPED',completed_at:'complete'}};
};
function closureReader(f,{events=()=>[f.event],executions=()=>[f.execution]}={}){
 return async(sql,values)=>{
  if(sql.includes("event='quoted_command'")){assert.deepEqual(values,[f.tenantId,f.executionId]);return[f.command];}
  if(sql.includes('FROM zammad_ticket_state_events')){assert.deepEqual(values,[f.tenantId,f.command.native_action_snapshot.instance_id,f.ticketId,f.command.native_result.closed_at]);assert(sql.includes('tenant_id=$1'));assert(sql.includes('transitioned_at=$4::timestamptz'));return events();}
  assert(sql.includes("event='ticket_closed'"));assert.deepEqual(values,[f.tenantId,f.correlationId,f.execution.source_sha256]);return executions();
 };
}
test('allowed quoted command waits for delayed native closure before replay baseline',async()=>{
 const f=closureFixture();let phase=0,admitted=false;const scoped=closureReader(f,{events:()=>phase===0?[]:[f.event],executions:()=>phase===1?[]:phase===2?[{...f.execution,state:'PENDING',completed_at:null}]:[f.execution]});
 const poll=async read=>{for(phase=0;phase<3;phase++){assert.equal(await read(),null);assert.equal(admitted,false);}const result=await read();admitted=true;return result;};
 const result=await waitQuotedCommandClosure({...f,scoped,poll});assert.equal(admitted,true);assert.equal(result.nativeStateEventId,f.event.id);assert.equal(result.ticketClosedExecutionId,f.execution.id);assert.equal(result.settled,true);assert.equal(phase,3);
});
test('closure admission rejects mismatched command authority before polling',async()=>{
 for(const corrupt of [f=>f.command.native_action_state='OUTCOME_UNKNOWN',f=>f.command.correlation_id='other',f=>f.command.native_action_snapshot.tenant_id='other',f=>f.command.native_action_snapshot.ticket_id='21',f=>f.command.native_result.execution_id='other',f=>f.command.native_result.request_sha256='b'.repeat(64),f=>f.command.native_result.closed_at='2026-10-08T20:38:03.827Z']){
  const f=closureFixture();corrupt(f);let polls=0;await assert.rejects(waitQuotedCommandClosure({...f,scoped:closureReader(f),poll:async()=>{polls++;throw Error('Forbidden baseline');}}));assert.equal(polls,0);
 }
});
test('closure admission keeps missing history pending and rejects ambiguity or wrong terminal source',async()=>{
 const f=closureFixture();assert.equal(await waitQuotedCommandClosure({...f,scoped:closureReader(f,{events:()=>[]}),poll:read=>read()}),null);
 for(const changes of [{events:()=>[f.event,f.event]},{events:()=>[{...f.event,processing_state:'IGNORED_STALE'}]},{executions:()=>[f.execution,f.execution]},{executions:()=>[{...f.execution,correlation_id:'other'}]},{executions:()=>[{...f.execution,source_sha256:'b'.repeat(64)}]},{executions:()=>[{...f.execution,mode:'CUSTOM',state:'APPLIED'}]},{executions:()=>[{...f.execution,completed_at:null}]}])await assert.rejects(waitQuotedCommandClosure({...f,scoped:closureReader(f,changes),poll:read=>read()}));
 const held=await waitQuotedCommandClosure({...f,scoped:closureReader(f,{events:()=>[{...f.event,processing_state:'BLOCKED_EFFECTS'}]}),poll:read=>read()});assert.equal(held,null);
});
