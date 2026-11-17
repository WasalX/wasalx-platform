import {withOwnerEvidence} from './simulation-owner-evidence.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {senderIdentityProof,testIds as identityIds} from './simulation-sender-identity.mjs';
import {senderConflictProof,conflictRoster,testIds as conflictIds} from './simulation-sender-conflict.mjs';
import {admitCustomerReprocess,assertCustomerReprocessSettled,runSenderReprocessEcho} from './simulation-reprocess-business.mjs';
import {admitRuleInputs} from './simulation-rule-input-stage.mjs';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
import {runSenderPolicyGaps} from './simulation-sender-policy.mjs';
import {syncNativeRoster} from './simulation-native-pn-lid.mjs';
import {ensureNativeAgent,captureNativeAgentEvidence} from './simulation-native-agent.mjs';
export const senderPolicyTestIds=['exclude-team','exclude-retains-history','include-team','activate','rollback'].map(s=>'group-rules/commands-triggers-and-friendly-ticket-naming::configured-team-sender-policy-controls-group-trigger-effects::'+s).concat(identityIds,conflictIds,['group-rules/commands-triggers-and-friendly-ticket-naming::configured-team-sender-policy-controls-group-trigger-effects::reprocess']);
export const remainingSenderPolicyTestIds=[...identityIds,...conflictIds,'group-rules/commands-triggers-and-friendly-ticket-naming::configured-team-sender-policy-controls-group-trigger-effects::reprocess'];
export const postQ05zSenderPolicyTestIds=[...conflictIds,'group-rules/commands-triggers-and-friendly-ticket-naming::configured-team-sender-policy-controls-group-trigger-effects::reprocess'];
const prefix='group-rules/commands-triggers-and-friendly-ticket-naming::configured-team-sender-policy-controls-group-trigger-effects::',historyId=prefix+'exclude-retains-history',rollbackId=prefix+'rollback',desktop={width:1440,height:1000};
const digest=value=>'sha256:'+createHash('sha256').update(String(value)).digest('hex');
export async function assertSenderEffectsSettled(scoped,tenantId,connectionId){
 const [row]=await scoped("SELECT (SELECT count(*) FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND (status IN ('ACCEPTED','PROCESSING','FAILED_RETRYABLE') OR lease_id IS NOT NULL OR lease_expires_at IS NOT NULL)) pending_inbox,(SELECT count(*) FROM delivery_outbox WHERE tenant_id=$1 AND connection_id=$2 AND (state IN ('QUEUED','CLAIMED','SENDING','FAILED_RETRYABLE') OR lease_id IS NOT NULL OR lease_expires_at IS NOT NULL)) pending_outbox",[tenantId,connectionId]);
 assert(row&&Number(row.pending_inbox)===0&&Number(row.pending_outbox)===0,'Owned sender effects remain in flight; retain configuration for exact reconciliation');
}
const assertBinding=(binding,contextId)=>{assert.equal(binding?.contextId,contextId);assert.match(binding.actorRef,/^sha256:[a-f0-9]{64}$/u);assert.match(binding.tenantRef,/^sha256:[a-f0-9]{64}$/u);assert.deepEqual(binding.actualViewport,desktop);return binding};
const bindRow=(row,binding)=>{if(row.contextId!==undefined)assert.equal(row.contextId,binding.contextId);const at=row.at??row.finishedAt??row.startedAt;assert(Number.isFinite(Date.parse(at)));return{...row,...binding,startedAt:row.startedAt??at,finishedAt:row.finishedAt??at}};
export function bindSenderPolicyContexts(raw,{owner,native},testIds=senderPolicyTestIds){
 assert(Array.isArray(raw));assert.equal(new Set(testIds).size,testIds.length);assertBinding(owner,'tenant_owner-en-desktop');if(testIds.includes(historyId))assertBinding(native,'zammad_agent-en-desktop');
 const results=testIds.map(testId=>{const rows=raw.filter(row=>row.testId===testId);if(testId!==historyId){assert.equal(rows.length,1,`Expected one sender proof for ${testId}`);return bindRow(rows[0],owner)}
  assert.equal(rows.length,4,'Expected both excluded policies for both team senders');assert(rows.every(row=>['passed','failed','blocked'].includes(row.result)));const observations=rows.map(row=>({at:row.at,result:row.result,proof:row.proof})),policies=[...new Set(rows.map(row=>row.proof?.policy))].sort(),participants=[...new Set(rows.map(row=>row.proof?.participantSha256))].sort(),pairs=new Set(rows.map(row=>row.proof?.policy+'|'+row.proof?.participantSha256));assert.deepEqual(policies,['exclude','rollback'],'Incomplete native history policy coverage');assert.equal(participants.length,2,'Expected two distinct sender hashes');assert(participants.every(value=>/^[a-f0-9]{64}$/u.test(value)),'Invalid sender hash');assert.equal(pairs.size,4,'Duplicate native history sender/policy coverage');const observedBinding=rows.at(-1);for(const row of rows){assert(row.verifiedContext,'Native history requires observed context');assert.equal(row.actorRef,observedBinding.actorRef);assert.equal(row.tenantRef,observedBinding.tenantRef);assert.deepEqual(row.actualViewport,desktop);assert.deepEqual(row.verifiedContext,observedBinding.verifiedContext);}const result=rows.every(row=>row.result==='passed')?'passed':rows.some(row=>row.result==='failed')?'failed':'blocked';if(result==='passed')assert(rows.every(row=>row.proof.authorizedNativeRead===true&&row.proof.messageId&&row.proof.nativeHistoryId),'Passed native history proof incomplete');const startedAt=rows.map(row=>row.at).sort()[0],finishedAt=rows.map(row=>row.at).sort().at(-1),proof={observations,observationCount:4,actorVerified:true,...(result==='passed'?{twoDistinctTeamNumbers:true,policies,authorizedNativeRead:true}:{})};return{testId,result,at:finishedAt,startedAt,finishedAt,...native,actorRef:observedBinding.actorRef,tenantRef:observedBinding.tenantRef,actualViewport:observedBinding.actualViewport,verifiedContext:observedBinding.verifiedContext,proof};
 });
 assert.equal(results.length,testIds.length);assert.equal(new Set(results.map(row=>row.testId+'|'+row.contextId)).size,testIds.length);return results;
}
async function senderPolicyContexts(session,{native=false}={}){await session.ownerPage.setViewportSize(desktop);const ownerActor=await session.verifyOwner(session.ownerPage);assert(ownerActor.userMatched&&ownerActor.workspaceMatched);assert.deepEqual(session.ownerPage.viewportSize(),desktop);const owner={contextId:'tenant_owner-en-desktop',context:{role:'tenant_owner',locale:'en',viewport:'desktop',surface:'portal'},actualViewport:desktop,actorRef:digest(session.ownerId),tenantRef:digest(session.tenantId)};if(!native)return{owner};const agent=await ensureNativeAgent(session),actor=await agent.verify();await agent.page.setViewportSize(desktop);assert.deepEqual(agent.page.viewportSize(),desktop);assert.equal((await agent.verify()).id,actor.id);return{owner,native:{contextId:'zammad_agent-en-desktop',context:{role:'zammad_agent',locale:'en',viewport:'desktop',surface:'zammad'},actualViewport:desktop,actorRef:digest('zammad:'+actor.id),tenantRef:digest(session.tenantId)},nativePage:agent.page,expectedNativeActorId:agent.actorId,captureNativeEvidence:()=>captureNativeAgentEvidence(agent.page,agent.actorId,session.tenantId)};}
export function portalPolicyAuthoringProof(versions){
 const rows=versions?.supportingEvidence?.filter(row=>row.testId===rollbackId)??[];assert.equal(rows.length,1,'Expected one supporting rollback proof');const row=rows[0];
 assert.equal(row.result,'supporting');assert.equal(row.proof?.sourceId,versions.sourceRuleSetId);assert.equal(row.proof?.includedId,versions.includedRuleSetId);assert.equal(row.proof?.restoredId,versions.excludedRuleSetId);
 const proof=row.proof?.portalPolicyAuthoring;assert.equal(proof?.selected,'include');assert.equal(proof?.requestCount,1);assert.match(proof?.operationKeySha256,/^[a-f0-9]{64}$/u);const supportingAt=row.finishedAt??row.at;assert(Number.isFinite(Date.parse(supportingAt)));return{...proof,supportingAt};
}
export function bindPortalPolicyAuthoring(raw,portalPolicyAuthoring){
 const rows=raw?.proofs?.filter(row=>row.testId===rollbackId)??[];assert.equal(rows.length,1,'Expected one owned rollback result');const rollback=rows[0];assert(['passed','failed','blocked'].includes(rollback.result));return{...raw,proofs:raw.proofs.map(row=>row===rollback?{...row,proof:{...row.proof,portalPolicyAuthoring}}:row)};
}
export function admitSenderPolicy(session,args,{requirePortalPolicyAuthoring=false,portal=false}={}){
 const group=admitRuleInputs(session,args,{portal}),sender={...args.inputs.secondActor,participants:args.config?.participants},versions=args.inputs.ruleInputs?.ruleVersions;
 assert.equal(sender?.evidenceMode,'simulated');assert(sender.memberId);assert.equal(sender.namespace,args.namespace);assert.equal(sender.tenantId,session.tenantId);
 assert(Array.isArray(sender.participants)&&sender.participants.length===2&&new Set(sender.participants).size===2);
 for(const p of sender.participants)assert.match(p,/^\d{6,20}@c\.us$/);
 assert.equal(versions?.evidenceMode,'simulated');assert.equal(versions.namespace,args.namespace);assert.equal(versions.tenantId,session.tenantId);assert(versions.excludedRuleSetId);
 const isolation=args.inputs.securityBusiness?.isolationActor;assert.equal(isolation?.evidenceMode,'simulated');assert.equal(isolation.namespace,args.namespace);assert.equal(isolation.project,session.model.name);assert.equal(isolation.onlyIsolationMembership,true);assert(isolation.tenantId&&isolation.tenantId!==session.tenantId);
 conflictRoster({participant:args.config.conflictParticipant,teamParticipant:sender.participants[0]});assert(!sender.participants.includes(args.config.conflictParticipant));
 const customerParticipant=admitCustomerReprocess(args.inputs.ruleInputs.proofs,sender.participants);
 return{group,sender,versions,customerParticipant,...(requirePortalPolicyAuthoring?{portalPolicyAuthoring:portalPolicyAuthoringProof(versions)}:{})};
}
const bindingBody=(b,ruleSetId)=>({displayName:b.wasalx_name??undefined,ruleSetId,zammadGroupId:b.zammad_group_id,defaultPriority:b.default_priority,assignmentMode:b.assignment_mode,fixedOwnerId:b.fixed_owner_id,slaPolicyId:b.sla_policy_id,businessHoursMode:b.business_hours_mode,businessHoursCalendarId:b.business_hours_calendar_id,acknowledgementTemplate:b.acknowledgement_template,agentPrefix:b.agent_prefix,agentIdentityPlacement:b.agent_identity_placement,maxIdentifiers:b.max_identifiers,mediaEnabled:b.media_enabled,retentionDays:b.retention_days,state:b.binding_state,expectedRevision:Number(b.binding_revision)});
const settingsBody=(s,enabled)=>({enabled,retentionDays:s.group_history_default_retention_days,visibility:s.group_history_default_visibility,expectedVersion:Number(s.version)});
const captureBody=(s,enabled)=>({captureEnabled:enabled,retentionDays:s.retention_days??30,visibility:s.visibility??'ALL_AGENTS',agentPrefix:s.agent_prefix??'Agent',agentIdentityPlacement:s.agent_identity_placement??'HEADER',expectedVersion:Number(s.version)});
export async function enableSenderRoster({request,connectionId,capturePath,settingsPath,oldCapture,oldSettings,prefix='sender'}){
 await request(settingsPath,'PUT',settingsBody(oldSettings,true),prefix+'-history');
 await request(capturePath,'PUT',captureBody({...oldCapture,visibility:'ALL_AGENTS'},true),prefix+'-capture');
 const settings=await request(settingsPath),capture=await request(capturePath);assert(settings.group_workspace_enabled);assert(capture.capture_enabled&&capture.enabled_at);
 const readyAt=Math.ceil(Date.parse(capture.enabled_at)/1000)*1000;assert(Number.isFinite(readyAt));if(readyAt>Date.now())await new Promise(r=>setTimeout(r,readyAt-Date.now()));
 return syncNativeRoster({request,connectionId});
}
export async function restoreSenderRoster({request,capturePath,settingsPath,oldCapture,oldSettings,prefix='sender'}){
 await request(capturePath,'PUT',captureBody({...oldCapture,version:(await request(capturePath)).version},Boolean(oldCapture.capture_enabled)),prefix+'-restore-capture');
 await request(settingsPath,'PUT',settingsBody({...oldSettings,version:(await request(settingsPath)).version},Boolean(oldSettings.group_workspace_enabled)),prefix+'-restore-settings');
 assert.equal((await request(capturePath)).capture_enabled,oldCapture.capture_enabled);assert.equal((await request(settingsPath)).group_workspace_enabled,oldSettings.group_workspace_enabled);
}
export async function senderPolicyStage(...args){return withOwnerEvidence(args[0],()=>senderPolicyStageOperation(...args));}
async function senderPolicyStageOperation(session,args){
 const {group,sender,versions,customerParticipant,portalPolicyAuthoring}=admitSenderPolicy(session,args,{requirePortalPolicyAuthoring:true}),h=session.directCallbacks;
 await h.assertIsolatedRuntime({evidenceMode:'simulated',tenantId:session.tenantId,connectionId:group.connectionId});await h.drainEffects();
 const contexts=await senderPolicyContexts(session,{native:true});
 const request=createSyntheticRequest({page:session.ownerPage,origin:session.portalOrigin,runId:args.namespace,checkpoint:session.checkpoint});
 const bindingPath=`/api/groups/${group.groupId}/binding`,capturePath=`/api/group-workspace/groups/${group.groupId}`,settingsPath='/api/group-workspace/settings';
 const member=(await request('/api/team')).members.find(m=>m.id===sender.memberId);assert(member&&member.state==='ACTIVE');
 const oldBinding=await request(bindingPath),oldCapture=await request(capturePath),oldSettings=await request(settingsPath);
 const effects=async()=>({outbox:await session.scoped('SELECT id,state,attempts FROM delivery_outbox WHERE connection_id=$1 ORDER BY id',[group.connectionId]),links:await session.scoped('SELECT id FROM message_links WHERE connection_id=$1 ORDER BY id',[group.connectionId]),actions:await session.scoped('SELECT id FROM group_action_executions WHERE tenant_id=$1 ORDER BY id',[session.tenantId])});
 const reprocessState={submitted:false,settled:false};let result;
 try{
  await request('/api/team/members/'+member.id,'PATCH',{role:member.role,state:member.state,expectedVersion:Number(member.version),whatsappNumbers:sender.participants.map(p=>'+'+p.split('@')[0])},'sender-test-numbers');
  for(const participant of sender.participants){const rows=await session.scoped('SELECT app.group_rule_sender($1,$2,$3,$4) sender',[session.tenantId,group.connectionId,group.groupRef,participant]);assert.equal(rows[0]?.sender,'team');}
  await enableSenderRoster({request,connectionId:group.connectionId,capturePath,settingsPath,oldCapture,oldSettings});
  await request(bindingPath,'PUT',bindingBody(await request(bindingPath),versions.excludedRuleSetId),'sender-exclude-bind');
  result=bindPortalPolicyAuthoring(await runSenderPolicyGaps({request,nativePage:contexts.nativePage,captureNativeEvidence:contexts.captureNativeEvidence,tenantId:session.tenantId,connectionId:group.connectionId,groupId:group.groupId,externalGroupId:group.groupRef,runId:args.namespace,ruleSetId:versions.excludedRuleSetId,participants:sender.participants,scoped:session.scoped,effects,providerRead:h.providerRead,control:h.control,drainEffects:h.drainEffects,checkpoint:session.checkpoint,bindingPath,bindingBody}),portalPolicyAuthoring);
  result.proofs.push(...await senderIdentityProof({session,otherTenantId:args.inputs.securityBusiness.isolationActor.tenantId,participant:sender.participants[0],connectionId:group.connectionId,namespace:args.namespace}));
  result.proofs.push(await senderConflictProof({session,namespace:args.namespace,group,request,bindingPath,participant:args.config.conflictParticipant,teamParticipant:sender.participants[0]}));
  const reprocess=await runSenderReprocessEcho({request,runId:args.namespace,tenantId:session.tenantId,connectionId:group.connectionId,groupId:group.groupId,externalGroupId:group.groupRef,participant:sender.participants[0],customerParticipant,reprocessState,nativePage:contexts.nativePage,expectedActorId:contexts.expectedNativeActorId,drainEffects:h.drainEffects,scoped:session.scoped,providerRead:h.providerRead,control:h.control,checkpoint:session.checkpoint,bindingPath,bindingBody});result.proofs.push(...reprocess.proofs);result.proofs=bindSenderPolicyContexts(result.proofs,contexts);for(const row of result.proofs)await session.checkpoint({phase:'sender-policy-context-result',...row});
 }finally{
  assertCustomerReprocessSettled(reprocessState);await h.drainEffects();await assertSenderEffectsSettled(session.scoped,session.tenantId,group.connectionId);
  const currentMember=(await request('/api/team')).members.find(m=>m.id===member.id);assert(currentMember);
  await request('/api/team/members/'+member.id,'PATCH',{role:member.role,state:member.state,expectedVersion:Number(currentMember.version),whatsappNumbers:member.whatsapp_numbers},'sender-restore-numbers');
  assert.deepEqual((await request('/api/team')).members.find(m=>m.id===member.id)?.whatsapp_numbers,member.whatsapp_numbers);
  await request(bindingPath,'PUT',{...bindingBody(oldBinding,oldBinding.rule_set_id),expectedRevision:Number((await request(bindingPath)).binding_revision)},'sender-restore-binding');
  await restoreSenderRoster({request,capturePath,settingsPath,oldCapture,oldSettings});
  assert.equal((await request(bindingPath)).rule_set_id,oldBinding.rule_set_id);
 }
 return{evidenceMode:'simulated',namespace:args.namespace,tenantId:session.tenantId,...result};
}

async function runRemainingSenderPolicy(session,args,testIds){
 const {group,sender,versions,customerParticipant}=admitSenderPolicy(session,args),h=session.directCallbacks;
 await h.assertIsolatedRuntime({evidenceMode:'simulated',tenantId:session.tenantId,connectionId:group.connectionId});await h.drainEffects();
 const contexts=await senderPolicyContexts(session,{native:true}),reprocessState={submitted:false,settled:false};
 const request=createSyntheticRequest({page:session.ownerPage,origin:session.portalOrigin,runId:args.namespace,checkpoint:session.checkpoint}),bindingPath=`/api/groups/${group.groupId}/binding`,capturePath=`/api/group-workspace/groups/${group.groupId}`,settingsPath='/api/group-workspace/settings';
 const member=(await request('/api/team')).members.find(m=>m.id===sender.memberId);assert(member&&member.state==='ACTIVE');const oldBinding=await request(bindingPath),oldCapture=await request(capturePath),oldSettings=await request(settingsPath),proofs=[];
 try{
  await request('/api/team/members/'+member.id,'PATCH',{role:member.role,state:member.state,expectedVersion:Number(member.version),whatsappNumbers:sender.participants.map(p=>'+'+p.split('@')[0])},'sender-remaining-numbers');
  await enableSenderRoster({request,connectionId:group.connectionId,capturePath,settingsPath,oldCapture,oldSettings,prefix:'sender-remaining'});
  if(testIds===remainingSenderPolicyTestIds)proofs.push(...await senderIdentityProof({session,otherTenantId:args.inputs.securityBusiness.isolationActor.tenantId,participant:sender.participants[0],connectionId:group.connectionId}));
  await request(bindingPath,'PUT',bindingBody(await request(bindingPath),versions.excludedRuleSetId),'conflict-exclude-bind');
  proofs.push(await senderConflictProof({session,namespace:args.namespace,group,request,bindingPath,participant:args.config.conflictParticipant,teamParticipant:sender.participants[0]}));
  const reprocess=await runSenderReprocessEcho({request,runId:args.namespace,tenantId:session.tenantId,connectionId:group.connectionId,groupId:group.groupId,externalGroupId:group.groupRef,participant:sender.participants[0],customerParticipant,reprocessState,nativePage:contexts.nativePage,expectedActorId:contexts.expectedNativeActorId,drainEffects:h.drainEffects,scoped:session.scoped,providerRead:h.providerRead,control:h.control,checkpoint:session.checkpoint,bindingPath,bindingBody});proofs.push(...reprocess.proofs);proofs.splice(0,proofs.length,...bindSenderPolicyContexts(proofs,contexts,testIds));for(const row of proofs)await session.checkpoint({phase:'sender-policy-context-result',...row});
 }finally{
  assertCustomerReprocessSettled(reprocessState);await h.drainEffects();await assertSenderEffectsSettled(session.scoped,session.tenantId,group.connectionId);const currentMember=(await request('/api/team')).members.find(m=>m.id===member.id);assert(currentMember);
  await request('/api/team/members/'+member.id,'PATCH',{role:member.role,state:member.state,expectedVersion:Number(currentMember.version),whatsappNumbers:member.whatsapp_numbers},'sender-remaining-restore-numbers');
  await request(bindingPath,'PUT',{...bindingBody(oldBinding,oldBinding.rule_set_id),expectedRevision:Number((await request(bindingPath)).binding_revision)},'sender-remaining-restore-binding');
  await restoreSenderRoster({request,capturePath,settingsPath,oldCapture,oldSettings,prefix:'sender-remaining'});
  assert.deepEqual((await request('/api/team')).members.find(m=>m.id===member.id)?.whatsapp_numbers,member.whatsapp_numbers);assert.equal((await request(bindingPath)).rule_set_id,oldBinding.rule_set_id);
 }
 assert.deepEqual(proofs.map(x=>x.testId),testIds);return{evidenceMode:'simulated',namespace:args.namespace,tenantId:session.tenantId,proofs};
}
export const senderPolicyRemainingStage=(session,args)=>runRemainingSenderPolicy(session,args,remainingSenderPolicyTestIds);
export const senderPolicyPostQ05zStage=(session,args)=>runRemainingSenderPolicy(session,args,postQ05zSenderPolicyTestIds);

export const senderReprocessTestId=prefix+'reprocess';
// Read one original passed row; never adopt the forbidden ruleInputs fixture.
export async function readSenderReprocessCustomer(session,args){
 const c=args.config.customerMatch,g=args.inputs.group;
 assert.equal(c.sourceNamespace,args.inputs.reviewFixture.sourceNamespace);assert.notEqual(c.sourceNamespace,args.namespace);
 assert.equal(c.path,`scenario-${c.sourceNamespace}/fixture-rule-inputs.json`);for(const key of ['sha256','rowSha256'])assert.match(c[key]??'',/^[a-f0-9]{64}$/u);
 const root=resolve(session.privateDir),path=resolve(root,c.path),rel=relative(root,path);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));assert.equal(await realpath(path),path);
 const bytes=await readFile(path);assert.equal(createHash('sha256').update(bytes).digest('hex'),c.sha256,'Customer source hash drift');
 const source=JSON.parse(bytes);assert.equal(source.evidenceMode,'simulated');assert.equal(source.namespace,c.sourceNamespace);assert.equal(source.scenario,'rule-inputs');assert.equal(source.fixture,'ruleInputs');assert.equal(source.result.tenantId,session.tenantId);assert.equal(source.result.namespace,c.sourceNamespace);
 const rows=source.result.proofs.filter(row=>row.testId===prefix+'customer-match');assert.equal(rows.length,1);const row=rows[0];assert.equal(createHash('sha256').update(JSON.stringify(row)).digest('hex'),c.rowSha256,'Customer row hash drift');
 assert.equal(row.contextId,'tenant_owner-en-desktop');assert(Number.isFinite(Date.parse(row.startedAt))&&Number.isFinite(Date.parse(row.finishedAt))&&Date.parse(row.startedAt)<=Date.parse(row.finishedAt));assert.equal(row.proof.input.chatId,g.groupRef);
 const customer=admitCustomerReprocess(rows,[]);const [classification]=await session.scoped('SELECT app.group_rule_sender($1,$2,$3,$4) sender',[session.tenantId,g.connectionId,g.groupRef,customer]);assert.equal(classification?.sender,'customer','Passed source customer is now a team/unknown sender');
 await session.checkpoint({phase:'reprocess-customer-source-admitted',sourceNamespace:c.sourceNamespace,sourceSha256:c.sha256,rowSha256:c.rowSha256,originalStartedAt:row.startedAt,originalFinishedAt:row.finishedAt,noReplay:true});return customer;
}
export async function senderReprocessOnlyStage(session,args){return withOwnerEvidence(session,()=>senderReprocessOnlyOperation(session,args));}
async function senderReprocessOnlyOperation(session,args){
 const group=admitRuleInputs(session,args),actor=args.inputs.secondActor,h=session.directCallbacks;
 assert.equal(actor?.evidenceMode,'simulated');assert.equal(actor.namespace,args.namespace);assert.equal(actor.tenantId,session.tenantId);assert.equal(actor.role,'agent');assert.equal(session.capabilities.secondActor?.memberId,actor.memberId);assert.equal(session.capabilities.secondActor.userId,actor.userId);
 const customerParticipant=await readSenderReprocessCustomer(session,args),participant=args.config.participants.find(value=>value!==customerParticipant);assert.match(participant??'',/^[1-9][0-9]{5,14}@c\.us$/);assert.notEqual(participant,customerParticipant);
 await h.assertIsolatedRuntime({evidenceMode:'simulated',tenantId:session.tenantId,connectionId:group.connectionId});await h.drainEffects();
 const contexts=await senderPolicyContexts(session,{native:true}),request=createSyntheticRequest({page:session.ownerPage,origin:session.portalOrigin,runId:args.namespace,checkpoint:session.checkpoint}),bindingPath=`/api/groups/${group.groupId}/binding`,capturePath=`/api/group-workspace/groups/${group.groupId}`,settingsPath='/api/group-workspace/settings';
 const member=(await request('/api/team')).members.find(row=>row.id===actor.memberId);assert(member&&member.state==='ACTIVE'&&member.role==='agent');assert.equal(member.user_id,actor.userId);
 const oldBinding=await request(bindingPath),oldCapture=await request(capturePath),oldSettings=await request(settingsPath),reprocessState={submitted:false,settled:false};let result;
 try{
  await request('/api/team/members/'+member.id,'PATCH',{role:member.role,state:member.state,expectedVersion:Number(member.version),whatsappNumbers:['+'+participant.split('@')[0]]},'reprocess-team-number');
  assert.equal((await session.scoped('SELECT app.group_rule_sender($1,$2,$3,$4) sender',[session.tenantId,group.connectionId,group.groupRef,participant]))[0]?.sender,'team');
  assert.equal((await session.scoped('SELECT app.group_rule_sender($1,$2,$3,$4) sender',[session.tenantId,group.connectionId,group.groupRef,customerParticipant]))[0]?.sender,'customer');
  await enableSenderRoster({request,connectionId:group.connectionId,capturePath,settingsPath,oldCapture,oldSettings,prefix:'reprocess'});
  result=await runSenderReprocessEcho({request,runId:args.namespace,tenantId:session.tenantId,connectionId:group.connectionId,groupId:group.groupId,externalGroupId:group.groupRef,participant,customerParticipant,reprocessState,nativePage:contexts.nativePage,expectedActorId:contexts.expectedNativeActorId,drainEffects:h.drainEffects,scoped:session.scoped,providerRead:h.providerRead,control:h.control,checkpoint:session.checkpoint,bindingPath,bindingBody});
 }finally{
  assertCustomerReprocessSettled(reprocessState);await h.drainEffects();await assertSenderEffectsSettled(session.scoped,session.tenantId,group.connectionId);
  const current=(await request('/api/team')).members.find(row=>row.id===member.id);assert(current);await request('/api/team/members/'+member.id,'PATCH',{role:member.role,state:member.state,expectedVersion:Number(current.version),whatsappNumbers:member.whatsapp_numbers},'reprocess-restore-number');assert.deepEqual((await request('/api/team')).members.find(row=>row.id===member.id)?.whatsapp_numbers,member.whatsapp_numbers);
  await request(bindingPath,'PUT',{...bindingBody(oldBinding,oldBinding.rule_set_id),expectedRevision:Number((await request(bindingPath)).binding_revision)},'reprocess-restore-binding');await restoreSenderRoster({request,capturePath,settingsPath,oldCapture,oldSettings,prefix:'reprocess'});assert.equal((await request(bindingPath)).rule_set_id,oldBinding.rule_set_id);
 }
 const proofs=bindSenderPolicyContexts(result.proofs,contexts,[senderReprocessTestId]);for(const row of proofs)await session.checkpoint({phase:'sender-policy-context-result',...row});return{evidenceMode:'simulated',namespace:args.namespace,tenantId:session.tenantId,proofs};
}

export const portalSenderPolicyTestIds=senderPolicyTestIds.map(id=>id+'::portal');
export async function portalSenderPolicyStage(session,args){
 const profile=await import('./simulation-portal-rule-command-boundary.mjs');const selected=profile.selectPortalChecks(args.checks,portalSenderPolicyTestIds,Object.fromEntries(portalSenderPolicyTestIds.map(id=>[id,[id.endsWith('::exclude-retains-history::portal')?'agent-en-desktop':'tenant_owner-en-desktop']])));
 const {group,sender,versions,customerParticipant,portalPolicyAuthoring}=admitSenderPolicy(session,args,{requirePortalPolicyAuthoring:true,portal:true}),h=session.directCallbacks;
 await h.assertIsolatedRuntime({evidenceMode:'simulated',tenantId:session.tenantId,connectionId:group.connectionId});await h.drainEffects();
 const contexts=await profile.portalSenderContexts(session,group);
 const request=createSyntheticRequest({page:session.ownerPage,origin:session.portalOrigin,runId:args.namespace,checkpoint:session.checkpoint});
 const bindingPath=`/api/groups/${group.groupId}/binding`,capturePath=`/api/group-workspace/groups/${group.groupId}`,settingsPath='/api/group-workspace/settings';
 const member=(await request('/api/team')).members.find(m=>m.id===sender.memberId);assert(member&&member.state==='ACTIVE');
 const oldBinding=await request(bindingPath),oldCapture=await request(capturePath),oldSettings=await request(settingsPath);
 const effects=async()=>({outbox:await session.scoped('SELECT id,state,attempts FROM delivery_outbox WHERE connection_id=$1 ORDER BY id',[group.connectionId]),links:await session.scoped('SELECT id FROM message_links WHERE connection_id=$1 ORDER BY id',[group.connectionId]),actions:await session.scoped('SELECT id FROM group_action_executions WHERE tenant_id=$1 ORDER BY id',[session.tenantId])});
 const reprocessState={submitted:false,settled:false};let result;
 try{
  await request('/api/team/members/'+member.id,'PATCH',{role:member.role,state:member.state,expectedVersion:Number(member.version),whatsappNumbers:sender.participants.map(p=>'+'+p.split('@')[0])},'sender-test-numbers');
  for(const participant of sender.participants){const rows=await session.scoped('SELECT app.group_rule_sender($1,$2,$3,$4) sender',[session.tenantId,group.connectionId,group.groupRef,participant]);assert.equal(rows[0]?.sender,'team');}
  await enableSenderRoster({request,connectionId:group.connectionId,capturePath,settingsPath,oldCapture,oldSettings});
  await request(bindingPath,'PUT',bindingBody(await request(bindingPath),versions.excludedRuleSetId),'sender-exclude-bind');
  result=bindPortalPolicyAuthoring(await runSenderPolicyGaps({request,observeHistory:contexts.observeHistory,readNativeTicket:contexts.readNativeTicket,observeTicket:contexts.observeTicket,captureNativeEvidence:contexts.captureNativeEvidence,tenantId:session.tenantId,connectionId:group.connectionId,groupId:group.groupId,externalGroupId:group.groupRef,runId:args.namespace,ruleSetId:versions.excludedRuleSetId,participants:sender.participants,scoped:session.scoped,effects,providerRead:h.providerRead,control:h.control,drainEffects:h.drainEffects,checkpoint:session.checkpoint,bindingPath,bindingBody}),portalPolicyAuthoring);
  result.proofs.push(...await senderIdentityProof({session,otherTenantId:args.inputs.securityBusiness.isolationActor.tenantId,participant:sender.participants[0],connectionId:group.connectionId,namespace:args.namespace}));
  result.proofs.push(await senderConflictProof({session,namespace:args.namespace,group,request,bindingPath,participant:args.config.conflictParticipant,teamParticipant:sender.participants[0]}));
  const reprocess=await runSenderReprocessEcho({request,runId:args.namespace,tenantId:session.tenantId,connectionId:group.connectionId,groupId:group.groupId,externalGroupId:group.groupRef,participant:sender.participants[0],customerParticipant,reprocessState,operatorSurface:session.operatorSurface,observeAttribution:contexts.observeAttribution,drainEffects:h.drainEffects,scoped:session.scoped,providerRead:h.providerRead,control:h.control,checkpoint:session.checkpoint,bindingPath,bindingBody});result.proofs.push(...reprocess.proofs);result.proofs=(await profile.bindPortalSenderRows(result.proofs,contexts,portalSenderPolicyTestIds)).filter(row=>selected.has(profile.legacyTestId(row.testId)));for(const row of result.proofs)await session.checkpoint({phase:'sender-policy-context-result',...row});
 }finally{
  assertCustomerReprocessSettled(reprocessState);await h.drainEffects();await assertSenderEffectsSettled(session.scoped,session.tenantId,group.connectionId);
  const currentMember=(await request('/api/team')).members.find(m=>m.id===member.id);assert(currentMember);
  await request('/api/team/members/'+member.id,'PATCH',{role:member.role,state:member.state,expectedVersion:Number(currentMember.version),whatsappNumbers:member.whatsapp_numbers},'sender-restore-numbers');
  assert.deepEqual((await request('/api/team')).members.find(m=>m.id===member.id)?.whatsapp_numbers,member.whatsapp_numbers);
  await request(bindingPath,'PUT',{...bindingBody(oldBinding,oldBinding.rule_set_id),expectedRevision:Number((await request(bindingPath)).binding_revision)},'sender-restore-binding');
  await restoreSenderRoster({request,capturePath,settingsPath,oldCapture,oldSettings});
  assert.equal((await request(bindingPath)).rule_set_id,oldBinding.rule_set_id);
 }
 return{evidenceMode:'simulated',namespace:args.namespace,tenantId:session.tenantId,...result};
}
