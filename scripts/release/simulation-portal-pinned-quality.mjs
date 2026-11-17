import assert from 'node:assert/strict';
import {ensurePortalOperator,portalOperatorContexts,openPortalTicket} from './simulation-portal-operator.mjs';
import {readPinnedNative,assertPinnedNative,readPortalPinnedAttachment} from './simulation-pinned-contexts.mjs';
import {runPortalTicketQuality} from './simulation-portal-email-quality.mjs';
import {portalPinnedQualityIds,portalPinnedQualityChecks,portalPinnedQualityDefinitions} from './simulation-portal-pinned-quality-definitions.mjs';
export {portalPinnedQualityIds,portalPinnedQualityChecks,portalPinnedQualityDefinitions};
export function pinnedQualityFixtures(packet,{tenantId,namespace}){
 assert.equal(packet?.evidenceMode,'simulated');assert.equal(packet.tenantId,tenantId);assert.equal(packet.namespace,namespace);
 const wrapper=packet.proofs?.[0];assert(wrapper&&wrapper.testId.endsWith('::portal')&&wrapper.verifiedContext?.surface==='portal');
 const fixture=wrapper.proof;assert.equal(fixture?.evidenceMode,'simulated');assert.equal(fixture.proofs?.length,2);
 assert.equal(fixture.paused.state,'PAUSED','Pinned producer must settle before read-only quality');
 const proofs=fixture.proofs;assert.notEqual(proofs[0].delivery.flow_version_id,proofs[1].delivery.flow_version_id);assert.notEqual(proofs[0].asset.sha256,proofs[1].asset.sha256);
 for(const proof of proofs){assert(/^[1-9][0-9]{0,15}$/u.test(String(proof.ticketNumber)));assert(/^[1-9][0-9]{0,15}$/u.test(String(proof.delivery.zammad_ticket_id)));assert(proof.native.inboundArticleId);assert.equal(proof.delivery.state,'SENT');assert.equal(Number(proof.delivery.attempts),1);assert(proof.delivery.external_message_id);}
 return proofs;
}
export async function portalPinnedQualityStage(session,{namespace,inputs,config}){
 assert.equal(session.operatorSurface,'portal');assert.deepEqual(config.checks,portalPinnedQualityChecks,'Exact retained native obligation successors required');
 for(const key of ['nativeAccountAccess','portalTeamAccess','secondActor']){assert.equal(inputs[key]?.tenantId,session.tenantId);assert.equal(inputs[key].namespace,namespace);}
 assert(inputs.nativeAccountAccess.results.some(row=>row.testId==='team-access/roles-invitations-revocation-and-last-owner-protection::native-account-linking-requires-owner-review-and-current-membership::01'&&row.result==='passed'));
 assert.equal(session.capabilities.secondActor.userId,inputs.secondActor.userId);assert.equal(session.capabilities.secondActor.subject,inputs.secondActor.subject);
 const proofs=pinnedQualityFixtures(inputs.pinnedMedia,{tenantId:session.tenantId,namespace}),operator=await ensurePortalOperator(session,{role:'agent'});
 const providerRead=async()=>({waha:await session.directCallbacks.providerRead(),meta:await session.metaCallbacks.providerRead()});
 const beforeProvider=await providerRead(),nativeBefore=[];
 for(const proof of proofs){const actual=await readPinnedNative(session,proof);assertPinnedNative(actual,proof);nativeBefore.push(actual);}
 const results=[];
 for(const context of portalOperatorContexts('agent','en')){
  const definitions=portalPinnedQualityDefinitions.filter(row=>row.requiredContextIds.includes(context.contextId));let initialMediaVerified=false;const rendered=[];
  const verifyRetainedRender=async({phase})=>{
   if(phase==='open'&&initialMediaVerified)return {ui:rendered,privateNative:nativeBefore};
   const actual=[];for(const proof of proofs)actual.push({ticketNumber:proof.ticketNumber,articleId:String(proof.delivery.zammad_article_id),portal:await readPortalPinnedAttachment(operator,proof)});
   rendered.push({phase,actual});initialMediaVerified=true;
   await openPortalTicket(operator,{ticketNumber:proofs[0].ticketNumber,articleId:String(proofs[0].delivery.zammad_article_id),reload:false});
   return {ui:rendered,privateNative:nativeBefore,classification:'Private native corroboration is separate from actual portal render/download proof'};
  };
  const primary=proofs[0],packet=await runPortalTicketQuality({operator,ticketId:String(primary.delivery.zammad_ticket_id),ticketNumber:primary.ticketNumber,articleId:String(primary.delivery.zammad_article_id),expectedArticleIds:[primary.native.inboundArticleId,primary.delivery.zammad_article_id],namespace,checkpoint:session.checkpoint,providerRead,testDefinitions:definitions,context,verifyRetainedRender});
  results.push(...packet.results);
 }
 const nativeAfter=[];for(const proof of proofs)nativeAfter.push(await readPinnedNative(session,proof));assert.deepEqual(nativeAfter,nativeBefore);assert.deepEqual(await providerRead(),beforeProvider);
 const key=row=>row.testId+'|'+row.contextId;assert.equal(new Set(results.map(key)).size,20);assert.deepEqual(results.map(key).sort(),portalPinnedQualityChecks.map(key).sort());
 await session.checkpoint({phase:'portal-pinned-quality-safety',nativeUnchanged:true,providerUnchanged:true,rows:results.length});
 return{evidenceMode:'simulated',namespace,tenantId:session.tenantId,operatorSurface:'portal',results,noNewProviderEffects:true};
}
