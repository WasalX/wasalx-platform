import assert from 'node:assert/strict';
import test from 'node:test';
import {portalTestId,legacyTestId,selectPortalChecks,portalRulesContextMap,portalCommandContextMap,privateBackendPath,observePortalRuleTicket,closePortalWorkflowTicket} from '../scripts/release/simulation-portal-rule-command-boundary.mjs';
import {portalFreshGroupTestIds,portalFreshGroupObservationStage} from '../scripts/release/simulation-fresh-group.mjs';
import {ruleInputTestIds,portalRuleInputIds} from '../scripts/release/simulation-rule-input-stage.mjs';
import {senderPolicyTestIds,portalSenderPolicyTestIds} from '../scripts/release/simulation-sender-stage.mjs';
import {testIds,portalCommandIds} from '../scripts/release/command-stage.mjs';
import {observeTicketWorkflowResult,withTicketCommandActorFixture} from '../scripts/release/command-ticket-workflows.mjs';

test('current identities are separate exact successors and reject unknown/context expansion',async()=>{
 assert.deepEqual(portalRuleInputIds,ruleInputTestIds.map(portalTestId));assert.equal(portalRuleInputIds.length,4);
 assert.deepEqual(portalSenderPolicyTestIds,senderPolicyTestIds.map(portalTestId));assert.equal(portalSenderPolicyTestIds.length,9);
 assert.deepEqual(portalCommandIds,testIds.map(portalTestId));assert.equal(portalCommandIds.length,4);assert.equal(portalFreshGroupTestIds.length,1);
 const id=portalCommandIds[0],contexts=portalCommandContextMap(portalCommandIds);
 assert.deepEqual([...selectPortalChecks([{testId:id,contextId:'agent-en-mobile'}],portalCommandIds,contexts)],[testIds[0]]);
 for(const checks of [undefined,[],[{testId:testIds[0],contextId:'agent-en-desktop'}],[{testId:id,contextId:'zammad_agent-en-desktop'}],[{testId:portalCommandIds[1],contextId:'agent-en-mobile'}],[{testId:id,contextId:'agent-en-mobile'},{testId:id,contextId:'agent-en-mobile'}]])assert.throws(()=>selectPortalChecks(checks,portalCommandIds,contexts));
 assert.throws(()=>legacyTestId(testIds[0]));
 await assert.rejects(portalFreshGroupObservationStage({}, {checks:[{testId:portalFreshGroupTestIds[0],contextId:'tenant_owner-en-desktop'}],inputs:{group:{preparationOnly:false}}}));
 assert.deepEqual(portalRulesContextMap(portalRuleInputIds)[portalRuleInputIds[0]],['tenant_owner-en-desktop']);
});

test('private readback uses explicit nonbrowser kinds and rejects write/query/cross-origin paths',async()=>{
 const calls=[],read=async(s,kind,input)=>{calls.push({s,kind,input});return{kind};},s={tenantId:'tenant'};
 for(const path of ['/api/v1/tickets/42','/api/v1/ticket_articles/by_ticket/42','/api/v1/ticket_states'])await privateBackendPath(s,path,read);
 assert.deepEqual(calls.map(row=>[row.kind,row.input]),[['ticket',{ticketId:'42'}],['articles',{ticketId:'42'}],['states',{}]]);
 for(const path of ['https://native.invalid/api/v1/tickets/42','/api/v1/tickets/42?write=1','/api/v1/users/me','/api/v1/tickets/0'])await assert.rejects(privateBackendPath(s,path,read));
 assert.equal(calls.length,3);
});

test('ticket UI proof requires exact visible title, article marker and actual operator binding',async()=>{
 const actions=[],binding={actorRef:'sha256:'+'a'.repeat(64),tenantRef:'sha256:'+'b'.repeat(64),verifiedContext:{role:'agent'}};
 const visible=label=>({first(){return this;},getByText(text){return visible(label+':'+text);},async waitFor(options){assert.equal(options.state,'visible');actions.push(label);}});
 const operator={page:{getByText:title=>visible(title),locator:selector=>visible(selector)}};
 const helpers={openPortalTicket:async(o,input)=>{assert.equal(o,operator);actions.push(input);},capturePortalOperatorEvidence:async()=>binding};
 const proof=await observePortalRuleTicket(operator,{ticket:{id:42,number:'1042',title:'Friendly title'},articleId:7,marker:'Status ready'},helpers);
 assert.equal(proof.visible,true);assert.equal(proof.surface,'portal');assert.equal(proof.actorRef,binding.actorRef);assert.equal(actions.length,3);assert.equal(actions[0].ticketNumber,'1042');
 operator.page.locator=()=>({getByText:()=>({waitFor:async()=>{throw Error('No article');}})});
 await assert.rejects(observePortalRuleTicket(operator,{ticket:{number:'1042',title:'Friendly title'},articleId:7,marker:'Status ready'},helpers),/No article/);
});

function closeFixture(outcome){
 let clicks=0,reads=0;
 const ticket={id:42,number:'1042',title:'Case',state_id:1},closed={id:4},lifecycle={unsettled:false};
 const operator={session:{portalOrigin:'https://portal.invalid'},page:{locator:()=>({selectOption:async value=>assert.equal(value,'4')}),getByRole:()=>({click:async()=>{clicks++;}}),getByText:()=>({waitFor:async()=>{}})},verify:async()=>({role:'agent'})};
 const helpers={openPortalTicket:async()=>{},privateNativeRead:async()=>{reads++;return{...ticket,state_id:4};}};
 const intent={ticket_id:'42',state_id:'4',operation_id:'10000000-0000-4000-8000-000000000001'};
 const observeAction=async({action,beforeDispatch})=>{beforeDispatch(intent);await action();if(outcome instanceof Error)throw outcome;return outcome??{status:200,intent,value:{state:'APPLIED',operation_id:intent.operation_id,ticket_id:intent.ticket_id}};};
 return{operator,ticket,closed,lifecycle,options:{checkpoint:async()=>{},lifecycle,helpers,observeAction},counts:()=>({clicks,reads})};
}
test('actual close control acknowledges one original request and unknowns never retry or cancel',async()=>{
 const success=closeFixture();assert.equal((await closePortalWorkflowTicket(success.operator,success.ticket,success.closed,success.options)).state_id,4);assert.equal(success.lifecycle.unsettled,false);assert.deepEqual(success.counts(),{clicks:1,reads:1});
 for(const outcome of [Error('Lost response'),{status:503,value:{code:'WORKSPACE_OUTCOME_UNKNOWN'}},{status:200,value:{state:'UNKNOWN'}},{status:200,value:{state:'APPLIED',operation_id:'20000000-0000-4000-8000-000000000002',ticket_id:'42'}},{status:200,value:{state:'APPLIED',operation_id:'10000000-0000-4000-8000-000000000001',ticket_id:'99'}},{status:200,value:{state:'APPLIED'}}]){
  const f=closeFixture(outcome);await assert.rejects(closePortalWorkflowTicket(f.operator,f.ticket,f.closed,f.options),error=>error.qualificationOutcomeUnknown===true&&error.intent.operation_id===f.lifecycle.intent.operation_id);assert.equal(f.lifecycle.unsettled,true);assert.deepEqual(f.counts(),{clicks:1,reads:0});
 }
});

test('unknown native-update outcome escapes workflow observers so finalizers can retain configuration',async()=>{
 const error=Error('Lost original update');error.qualificationOutcomeUnknown=true;let captures=0,checkpoints=0;
 await assert.rejects(observeTicketWorkflowResult({testId:'current',run:async()=>{throw error;},captureBinding:async()=>{captures++;},checkpoint:async()=>{checkpoints++;}}),value=>value===error);
 assert.equal(captures,0);assert.equal(checkpoints,0);
});

test('current workflow rows satisfy the actual shared contract2 binding without legacy relabeling',async()=>{
 const {bindPortalOperatorResult}=await import('../scripts/release/simulation-portal-operator.mjs');
 const binding={contractVersion:2,surface:'portal',role:'agent',locale:'en',actorRef:'sha256:'+'a'.repeat(64),tenantRef:'sha256:'+'b'.repeat(64),viewport:{width:1440,height:1000},verifiedAt:new Date().toISOString()};
 const row=await observeTicketWorkflowResult({testId:portalCommandIds[1],contextId:'agent-en-desktop',run:async()=>({rendered:true}),captureBinding:async()=>binding,bindResult:bindPortalOperatorResult,checkpoint:async()=>{}});
 assert.equal(row.result,'passed');assert.equal(row.testId,portalCommandIds[1]);assert.equal(row.verifiedContext.contractVersion,2);
 const stale=await observeTicketWorkflowResult({testId:testIds[1],contextId:'agent-en-desktop',run:async()=>({rendered:true}),captureBinding:async()=>binding,bindResult:bindPortalOperatorResult,checkpoint:async()=>{}});
 assert.equal(stale.result,'failed');assert(stale.proof.bindingFailure);
});

test('projected command actor must match the exact selected portal membership email',async()=>{
 let nativeSetup=0;
 const actor={id:7,active:true,email:'agent@example.test'},member={id:'member',user_id:'agent-user',role:'agent',state:'ACTIVE',email:'different@example.test',whatsapp_numbers:[]};
 await assert.rejects(withTicketCommandActorFixture({s:{ownerId:'owner'},agent:{verify:async()=>{throw Error('Native browser forbidden');}},request:async()=>({members:[member]}),verifiedNativeActor:actor,memberUserId:'agent-user',withNativeIdentity:async()=>{nativeSetup++;}}),/Exact projected command email/);
 assert.equal(nativeSetup,0);
});

test('sender aggregation accepts four actual portal observations and rejects relabeled native evidence',async()=>{
 const {bindPortalSenderRows}=await import('../scripts/release/simulation-portal-rule-command-boundary.mjs');
 const binding=role=>({contractVersion:2,surface:'portal',role,locale:'en',actorRef:'sha256:'+(role==='agent'?'a':'c').repeat(64),tenantRef:'sha256:'+'b'.repeat(64),viewport:{width:1440,height:1000},verifiedAt:new Date().toISOString()});
 const owner=binding('tenant_owner'),agent=binding('agent'),contexts={ownerOperator:{verify:async()=>owner},agentOperator:{verify:async()=>agent}},at=new Date().toISOString();
 const history=senderPolicyTestIds.find(id=>id.endsWith('::exclude-retains-history'));
 const raw=senderPolicyTestIds.flatMap(testId=>testId!==history?[{testId,result:'passed',at,proof:{businessChecked:true}}]:['exclude','rollback'].flatMap(policy=>['a','b'].map(participant=>({testId,result:'passed',at,actorRef:agent.actorRef,tenantRef:agent.tenantRef,actualViewport:agent.viewport,verifiedContext:agent,proof:{authorizedPortalRead:true,portalHistoryId:'message',messageId:'source',policy,participantSha256:participant.repeat(64)}}))));
 const rows=await bindPortalSenderRows(raw,contexts,portalSenderPolicyTestIds);assert.equal(rows.length,9);assert.equal(rows.find(row=>row.testId===portalTestId(history)).contextId,'agent-en-desktop');assert(rows.every(row=>row.verifiedContext.contractVersion===2));
 const fake=structuredClone(raw);fake.find(row=>row.testId===history).verifiedContext.role='zammad_agent';await assert.rejects(bindPortalSenderRows(fake,contexts,portalSenderPolicyTestIds));
});

test('current command fixture maps only the actual projected agent and restores its owned phone',async()=>{
 const phone="+12025550106",participant='12025550106@c.us';let member={id:'agent-member',user_id:'agent-user',role:'agent',state:'ACTIVE',email:'agent@example.test',version:1,whatsapp_numbers:[]},nativeSetups=0;const writes=[];
 const request=async(path,method,body)=>{if(path==='/api/team')return{members:[{id:'owner-member',user_id:'owner',email:'owner@example.test'},structuredClone(member)]};if(method==='PATCH'){assert.equal(path,'/api/team/members/agent-member');assert.equal(body.expectedVersion,member.version);writes.push(body);member={...member,version:member.version+1,whatsapp_numbers:body.whatsappNumbers};return{};}return{version:1};};
 const s={ownerId:'owner',tenantId:'tenant',scoped:async sql=>sql.includes('group_workspace_participants')?[{external_participant_id:participant,normalized_phone:phone}]:sql.includes('ticket_command_actor')?[{source_authorized:true,member_id:member.whatsapp_numbers.includes(phone)?member.id:null,member_role:member.role,member_email:member.email}]:[],directCallbacks:{drainEffects:async()=>{}},checkpoint:async()=>{}};
 const result=await withTicketCommandActorFixture({s,agent:{verify:async()=>{throw Error('Native GUI forbidden');}},verifiedNativeActor:{id:7,active:true,email:member.email},memberUserId:'agent-user',request,group:{groupId:'group',groupRef:'123@g.us',connectionId:'connection'},customerParticipant:'12025550104@c.us',nativeGroupId:1,runId:'current',withNativeIdentity:async({run})=>{nativeSetups++;return run();},enableRoster:async()=>{},restoreRoster:async()=>{},run:async actor=>{assert.equal(actor.member.user_id,'agent-user');assert.equal(actor.nativeActorId,7);await actor.setMembership(false);return'current-agent';}});
 assert.equal(result,'current-agent');assert.equal(nativeSetups,1);assert.deepEqual(member.whatsapp_numbers,[]);assert(writes.length>=2);assert(writes.every(row=>row.role==='agent'&&row.state==='ACTIVE'));
});

test('supporting first-group observation keeps actual UI binding without emitting qualification rows',async()=>{
 const {portalFreshGroupObservationRecord}=await import('../scripts/release/simulation-fresh-group.mjs');
 const row={testId:portalFreshGroupTestIds[0],result:'passed',contextId:'tenant_owner-en-desktop',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),proof:{portalObservation:{visible:true,articleId:'7'}},verifiedContext:{contractVersion:2,surface:'portal',actorRef:'actual'}};
 const output=portalFreshGroupObservationRecord(row,{assertionDisposition:'supporting'});
 assert.deepEqual(Object.keys(output),['observations']);assert.equal(output.observations.length,1);
 const observed=output.observations[0];for(const key of ['testId','result','proof'])assert.equal(Object.hasOwn(observed,key),false);
 assert.equal(observed.observation.portalObservation.visible,true);assert.deepEqual(observed.verifiedContext,row.verifiedContext);assert.equal(observed.assertionDisposition,'supporting');
 assert.deepEqual(portalFreshGroupObservationRecord(row),{results:[row]});assert.throws(()=>portalFreshGroupObservationRecord(row,{assertionDisposition:'pass-anyway'}));
 await assert.rejects(portalFreshGroupObservationStage({}, {config:{assertionDisposition:'supporting'},checks:[{testId:portalFreshGroupTestIds[0],contextId:'tenant_owner-en-desktop'}],inputs:{}}),/no qualification checks/);
});
