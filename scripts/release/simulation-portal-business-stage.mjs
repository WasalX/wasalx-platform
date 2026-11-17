import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runNativeNeutralScenario} from './simulation-native-neutral.mjs';
import {createNativeBusinessEmitter} from './simulation-native-business-batch.mjs';
import {admitGrantMedia} from './simulation-native-grants-stage.mjs';
import {runCapturedMutations} from './simulation-native-captured-mutations.mjs';
import {gowsReceiptStage,groupTextReceiptTestId} from './simulation-gows-receipt-stage.mjs';
import {ensurePortalOperator,readPortalOperation} from './simulation-portal-operator.mjs';
import {portalGroupResult,loadPortalGroupMedia,sha} from './simulation-portal-groups.mjs';
import {observePortalGroupBusiness,portalMutationView} from './simulation-portal-group-observers.mjs';
import {createPortalGroupTicket,runPortalGroupLinkJump} from './simulation-portal-group-ticket.mjs';
import {runPortalGroupNicknames,runPortalPnLid} from './simulation-portal-group-identity.mjs';
import {runPortalGroupMedia} from './simulation-portal-group-media.mjs';
import {completePortalBusinessTestIds,originalBusinessIds,originalLinkIds,groupTicketPrefix} from './simulation-portal-group-definitions.mjs';
export {completePortalBusinessTestIds} from './simulation-portal-group-definitions.mjs';
export async function portalGowsReceiptStage(s,args){return gowsReceiptStage(s,{...args,sourceGroupTextId:groupTextReceiptTestId+'::portal'});}

export async function portalBusinessStage(s,{namespace,inputs,config}){
 const group=inputs.group;assert.equal(group.namespace,namespace);assert.equal(group.tenantId,s.tenantId);assert.equal(group.evidenceMode,'simulated');assert.equal(inputs.directConnection.connectionId,group.connectionId);assert(s.model.name.startsWith('wasalx-simulation-'));assert(s.actorBinding.userMatched&&s.actorBinding.workspaceMatched);
 assert.equal(inputs.portalTeamAccess?.namespace,namespace);assert.equal(inputs.portalTeamAccess.tenantId,s.tenantId);assert.equal(String(inputs.portalTeamAccess.nativeGroupId),String(group.zammadGroupId));
 const fixture=config.mediaFixture,bytes=await readFile(admitGrantMedia(s.model,fixture,s.driverRoot));assert.equal(bytes.length,fixture.bytes);assert.equal(sha(bytes),fixture.sha256);
 assert(Array.isArray(config.participants)&&config.participants.length===3&&new Set(config.participants).size===3);assert(config.participants.slice(0,2).every(value=>/^[1-9][0-9]+@c\.us$/u.test(value)));assert(/^[1-9][0-9]+@lid$/u.test(config.participants[2]));
 const operator=await ensurePortalOperator(s,{role:'agent',viewport:{width:1440,height:1000}});let uncertain=false;
 const markUncertain=()=>{uncertain=true;},markSettled=()=>{uncertain=false;},checkpoint=async row=>{if(row.phase==='intent')markUncertain();await s.checkpoint(row);};
 return runNativeNeutralScenario({...s,namespace,operator,origin:s.portalOrigin,runId:namespace+'-business',connectionId:group.connectionId,groupId:group.groupId,externalGroupId:group.groupRef,mediaFixture:fixture,
 catalogRead:async groupId=>({status:200,value:await readPortalOperation(operator,'GROUP_LIST',{scope:'ALL',selected:groupId})}),
 beforeRestore:async()=>assert(!uncertain,'Portal operation outcome uncertain; preserve exact configuration and intents'),
 nativeQuality:async current=>{
  const image=await loadPortalGroupMedia(operator,{groupId:group.groupId,messageId:current.messageId});assert.equal(image.sha256,fixture.sha256);assert(await operator.page.locator(`[data-message-id="${current.messageId}"] img`).evaluate(async value=>{await value.decode();return value.complete&&value.naturalWidth>0;}));
  const context={...current,operator,portalOrigin:s.portalOrigin,targetTeamId:String(group.zammadGroupId),providerRead:s.directCallbacks.providerRead,providerMessage:s.directCallbacks.providerMessage,participants:config.participants,markUncertain,markSettled,actionCheckpoint:checkpoint};
  const result=await runPortalBusinessBatch(context);assert(!uncertain,'Resolve the ticket outcome before dependent sends');
  const remaining=await runPortalGroupRemaining(context,{business:result,config:config.remaining});
  const effects=async()=>({links:await s.scoped('SELECT id FROM message_links WHERE connection_id=$1 ORDER BY id',[group.connectionId]),deliveries:await s.scoped('SELECT id,state,attempts,external_message_id FROM delivery_outbox WHERE connection_id=$1 ORDER BY id',[group.connectionId])});
  const mutation=await runCapturedMutations({...current,nativePage:operator.page,providerRead:s.directCallbacks.providerRead,target:{id:current.messageId,external_message_id:current.externalMessageId},participant:current.participant,effects,view:portalMutationView(operator,group.groupId)});
  const results=await joinPortalBusinessResults(operator,result,mutation,remaining);assert.deepEqual(results.map(row=>row.testId).sort(),[...completePortalBusinessTestIds].sort());
  return{evidenceMode:'simulated',surface:'portal',namespace,tenantId:s.tenantId,results,supportingFindings:mutation.findings.filter(row=>row.step==='reaction-portal-ui'),status:mutation.findings.length?'findings-collected':'scoped-results-collected',fixture:{groupId:group.groupId,messageId:current.messageId},limitations:['Twenty-four exact portal business successors; cross-connection nickname stays in the lifecycle stage.']};
 }});
}

export async function runPortalBusinessBatch(s){
 const emit=createNativeBusinessEmitter(s),incoming=await emit('name',s.participants[0],'1234567890','<img src=x onerror=alert(1)>'),phoneFallback=await emit('phone',s.participants[1],'Alpha known phone fallback'),lidFallback=await emit('lid',s.participants[2],'Alpha unknown participant');
 let delivery;const until=Date.now()+90000;
 for(;;){delivery=(await s.scoped('SELECT id,state,external_message_id FROM delivery_outbox WHERE connection_id=$1 AND reply_to_message_id=$2 ORDER BY created_at DESC',[s.connectionId,incoming.externalMessageId]))[0];if(delivery?.state==='SENT')break;assert(Date.now()<until,'Acknowledgement unsettled');await new Promise(resolve=>setTimeout(resolve,300));}
 const fixtures={incoming,unsafeName:incoming,phoneFallback,lidFallback,outgoing:{id:delivery.id,externalMessageId:delivery.external_message_id},reaction:{id:delivery.id}};
 const observed=await observePortalGroupBusiness({...s,fixtures});let ticket;
 try{ticket=await createPortalGroupTicket({...s,checkpoint:s.actionCheckpoint});}
 catch(error){await s.checkpoint({phase:'portal-ticket-create-failure',errorClass:error.name,errorSha256:sha(String(error.message))});throw error;}
 return{observed,ticket,fixtures};
}

export async function runPortalGroupRemaining(s,{business,config}){
 const results=[];results.push(await runPortalPnLid(s,config.mapping));results.push(...await runPortalGroupNicknames(s,{participants:config.nicknameParticipants}));results.push(...await runPortalGroupMedia(s,{files:config.mediaFiles,mentionParticipant:config.mapping.pn}));
 if(business.ticket?.created?.proof.ticketId)results.push(...await runPortalGroupLinkJump({...s,checkpoint:s.actionCheckpoint},{target:business.fixtures.phoneFallback,ticketId:business.ticket.created.proof.ticketId}));
 else{assert(business.ticket?.result==='failed'&&business.ticket.settled&&business.ticket.notApplied);for(const testId of originalLinkIds){const row=await portalGroupResult(s.operator,{testId,result:'blocked',proof:{blocker:'PORTAL_TICKET_CREATE_NOT_APPLIED',sourceTestIds:[groupTicketPrefix+'01::portal',groupTicketPrefix+'02::portal'],httpStatus:business.ticket.httpStatus,noReplay:true}});results.push(row);await s.checkpoint({phase:'portal-link-result',...row});}}
 return results;
}

export async function joinPortalBusinessResults(operator,business,mutation,remaining){
 const results=[...business.observed.results,...[business.ticket.created,business.ticket.filtered].filter(Boolean),...remaining];
 for(const testId of mutation.testIds){const edit=testId.endsWith('::02'),findings=mutation.findings.filter(row=>row.step===(edit?'edited-portal-ui':'revoked-portal-ui'));results.push(await portalGroupResult(operator,{testId,result:findings.length?'failed':'passed',proof:{targetId:mutation.targetId,findings,mediaBeforeRevoke:true}}));}
 if(business.ticket.result==='failed')for(const testId of originalBusinessIds.filter(id=>id.startsWith(groupTicketPrefix)))results.push(await portalGroupResult(operator,{testId,result:'failed',proof:business.ticket}));
 assert.equal(new Set(results.map(row=>row.testId)).size,results.length);return results;
}
