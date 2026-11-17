import {withOwnerEvidence} from './simulation-owner-evidence.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {admitRuleVersions} from './simulation-rule-stages.mjs';
import {runFreshRuleVersions} from './simulation-rule-versions.mjs';
import {runRuleInputs} from './simulation-rule-inputs.mjs';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
const prefix='group-rules/commands-triggers-and-friendly-ticket-naming::configured-team-sender-policy-controls-group-trigger-effects::';
export const ruleInputTestIds=['customer-match','customer-nonmatch','unknown','duplicate'].map(x=>prefix+x);
export function admitRuleInputs(session,args,{portal=false}={}){
 const group=admitRuleVersions(session,args),f=args.inputs.directConnection,h=session.directCallbacks;
 assert.equal(f?.provider,'WAHA');assert.equal(f.evidenceMode,'simulated');assert.equal(f.tenantId,session.tenantId);assert.equal(f.connectionId,group.connectionId);
 for(const key of ['control','drainEffects','providerRead','assertIsolatedRuntime'])assert.equal(typeof h?.[key],'function');
 for(const key of ['project','connectionId','providerSessionId','containerId','imageId','socketPath']){assert.equal(typeof f.runtimeBinding?.[key],'string');assert.equal(f.runtimeBinding[key],h.binding?.[key]);}
 assert.match(group.groupRef,/^[0-9-]+@g\.us$/);if(!portal)assert(session.nativePage);return group;
}
const bindingBody=(b,ruleSetId)=>({displayName:b.wasalx_name??undefined,ruleSetId,zammadGroupId:b.zammad_group_id,defaultPriority:b.default_priority,assignmentMode:b.assignment_mode,fixedOwnerId:b.fixed_owner_id,slaPolicyId:b.sla_policy_id,businessHoursMode:b.business_hours_mode,businessHoursCalendarId:b.business_hours_calendar_id,acknowledgementTemplate:b.acknowledgement_template,agentPrefix:b.agent_prefix,agentIdentityPlacement:b.agent_identity_placement,maxIdentifiers:b.max_identifiers,mediaEnabled:b.media_enabled,retentionDays:b.retention_days,state:b.binding_state,expectedRevision:Number(b.binding_revision)});
export async function ruleInputsStage(...args){return withOwnerEvidence(args[0],()=>ruleInputsStageOperation(...args));}
async function ruleInputsStageOperation(session,args){
 const group=admitRuleInputs(session,args),h=session.directCallbacks;
 await h.assertIsolatedRuntime({evidenceMode:'simulated',tenantId:session.tenantId,connectionId:group.connectionId});
 await h.drainEffects();
 await session.verifyOwner(session.ownerPage);await session.ownerPage.setViewportSize({width:1440,height:1000});
 const request=createSyntheticRequest({page:session.ownerPage,origin:session.portalOrigin,runId:args.namespace,checkpoint:session.checkpoint});
 const fixture=await runFreshRuleVersions({ownerPage:session.ownerPage,portalOrigin:session.portalOrigin,runId:args.namespace,checkpoint:session.checkpoint,scoped:session.scoped,tenantId:session.tenantId});
 const path=`/api/groups/${group.groupId}/binding`,original=await request(path);
 const effects=async()=>({outbox:await session.scoped('SELECT id,state,attempts FROM delivery_outbox WHERE connection_id=$1 ORDER BY id',[group.connectionId]),links:await session.scoped('SELECT id,zammad_ticket_id FROM message_links WHERE connection_id=$1 ORDER BY id',[group.connectionId]),actions:await session.scoped('SELECT id FROM group_action_executions WHERE tenant_id=$1 ORDER BY id',[session.tenantId])});
 let result;
 try{
  await request(path,'PUT',bindingBody(original,fixture.excludedRuleSetId),'rule-input-bind');
  result=await runRuleInputs({request,ruleSetId:fixture.excludedRuleSetId,nativePage:session.nativePage,tenantId:session.tenantId,connectionId:group.connectionId,groupId:group.groupId,externalGroupId:group.groupRef,runId:args.namespace,control:h.control,drainEffects:h.drainEffects,scoped:session.scoped,effects,providerRead:h.providerRead,checkpoint:session.checkpoint});
 }finally{
  // Never restore configuration while an uncertain registered effect is active.
  await h.drainEffects();const current=await request(path);
  await request(path,'PUT',{...bindingBody(original,original.rule_set_id),expectedRevision:Number(current.binding_revision)},'rule-input-restore');
  const restored=await request(path);assert.equal(restored.rule_set_id,original.rule_set_id);
 }
 assert.equal(result.proofs.length,3);assert(result.duplicateEvidence);
 return{evidenceMode:'simulated',namespace:args.namespace,tenantId:session.tenantId,ruleVersions:fixture,
  proofs:bindRuleInputProofs(result,session.ownerPage.viewportSize()),
  duplicateEvidence:result.duplicateEvidence};
}

export function bindRuleInputProofs(result,actualViewport){const source=[...result.proofs.map(p=>({name:p.name,...p})),{name:'duplicate',...result.duplicateEvidence}];return source.map(p=>{assert(Number.isFinite(Date.parse(p.startedAt))&&Number.isFinite(Date.parse(p.finishedAt))&&Date.parse(p.startedAt)<=Date.parse(p.finishedAt),'Rule input requires its producer action/check window');const native=p.native;if(native){assert.equal(typeof native.title,'string');assert(native.title.length>0,'Native title proof required');}const safeNative=native?{...native,title:`[redacted sha256:${createHash('sha256').update(native.title).digest('hex')} length:${native.title.length}]`,titleVisible:true}:undefined;return{testId:prefix+p.name,result:'passed',at:p.finishedAt,startedAt:p.startedAt,finishedAt:p.finishedAt,contextId:'tenant_owner-en-desktop',actualViewport,proof:{...p,...(safeNative?{native:safeNative}:{}),scope:'Owner-authenticated API and provider behavior'}};});}

export const portalRuleInputIds=ruleInputTestIds.map(id=>id+'::portal');
export async function portalRuleInputsStage(session,args){
 const profile=await import('./simulation-portal-rule-command-boundary.mjs');const selected=profile.selectPortalChecks(args.checks,portalRuleInputIds,profile.portalRulesContextMap(portalRuleInputIds));
 const group=admitRuleInputs(session,args,{portal:true}),h=session.directCallbacks,helper=await import('./simulation-portal-operator.mjs'),operator=await profile.preparePortalRuleOperator(session,group);
 await h.assertIsolatedRuntime({evidenceMode:'simulated',tenantId:session.tenantId,connectionId:group.connectionId});
 await h.drainEffects();
 await session.verifyOwner(session.ownerPage);await session.ownerPage.setViewportSize({width:1440,height:1000});
 const request=createSyntheticRequest({page:session.ownerPage,origin:session.portalOrigin,runId:args.namespace,checkpoint:session.checkpoint});
 const fixture=await runFreshRuleVersions({ownerPage:session.ownerPage,portalOrigin:session.portalOrigin,runId:args.namespace,checkpoint:session.checkpoint,scoped:session.scoped,tenantId:session.tenantId});
 const path=`/api/groups/${group.groupId}/binding`,original=await request(path);
 const effects=async()=>({outbox:await session.scoped('SELECT id,state,attempts FROM delivery_outbox WHERE connection_id=$1 ORDER BY id',[group.connectionId]),links:await session.scoped('SELECT id,zammad_ticket_id FROM message_links WHERE connection_id=$1 ORDER BY id',[group.connectionId]),actions:await session.scoped('SELECT id FROM group_action_executions WHERE tenant_id=$1 ORDER BY id',[session.tenantId])});
 let result;
 try{
  await request(path,'PUT',bindingBody(original,fixture.excludedRuleSetId),'rule-input-bind');
  result=await runRuleInputs({request,ruleSetId:fixture.excludedRuleSetId,nativeRead:async({ticketId,messageId})=>{const ticket=await helper.privateNativeRead(session,'ticket',{ticketId}),articles=await helper.privateNativeRead(session,'articles',{ticketId});return{id:ticket.id,title:ticket.title,number:ticket.number,matchingArticleIds:articles.filter(row=>row.preferences?.wasalx_external_message_id===messageId).map(row=>row.id)};},observeTicket:(native,marker)=>profile.observePortalRuleTicket(operator,{ticket:native,articleId:native.matchingArticleIds[0],marker}),tenantId:session.tenantId,connectionId:group.connectionId,groupId:group.groupId,externalGroupId:group.groupRef,runId:args.namespace,control:h.control,drainEffects:h.drainEffects,scoped:session.scoped,effects,providerRead:h.providerRead,checkpoint:session.checkpoint});
 }finally{
  // Never restore configuration while an uncertain registered effect is active.
  await h.drainEffects();const current=await request(path);
  await request(path,'PUT',{...bindingBody(original,original.rule_set_id),expectedRevision:Number(current.binding_revision)},'rule-input-restore');
  const restored=await request(path);assert.equal(restored.rule_set_id,original.rule_set_id);
 }
 assert.equal(result.proofs.length,3);assert(result.duplicateEvidence);
 return{evidenceMode:'simulated',namespace:args.namespace,tenantId:session.tenantId,ruleVersions:fixture,
  proofs:(await profile.bindPortalRuleRows(bindRuleInputProofs(result,operator.page.viewportSize()),operator,portalRuleInputIds)).filter(row=>selected.has(profile.legacyTestId(row.testId))),
  duplicateEvidence:result.duplicateEvidence};
}
