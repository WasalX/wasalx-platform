import assert from 'node:assert/strict';
import {seedSyntheticGroup} from './seed-simulation-group.mjs';
import {simulationEventId} from "./synthetic-first-group-driver.mjs";
import {callSimulationControl} from '../contracts/waha-simulation-control.mjs';
export const freshGroupCustomerParticipant='12025550106@c.us';

export function normalizeGroupFixture({namespace,tenantId,groupRef,packet,binding}){const f=packet.configured;assert.equal(f.evidenceMode,'simulated');assert(f.connectionId&&f.groupId&&f.ruleSetId);assert.equal(binding.binding_id,f.bindingId);assert.equal(binding.binding_state,'ACTIVE');assert.equal(binding.rule_set_id,f.ruleSetId);assert.match(String(binding.zammad_group_id),/^\d+$/);assert.match(groupRef,/^[0-9-]+@g\.us$/);return{evidenceMode:'simulated',namespace,tenantId,connectionId:f.connectionId,groupId:f.groupId,groupRef,zammadGroupId:String(binding.zammad_group_id),ruleSetId:f.ruleSetId,bindingId:f.bindingId,bindingRevision:binding.binding_revision,configured:f,eventId:packet.eventId,messageId:packet.messageId,ticketId:packet.nativeAfter.ticketId};}

export const portalFreshGroupTestIds=['group-rules/commands-triggers-and-friendly-ticket-naming::configured-team-sender-policy-controls-group-trigger-effects::customer-match::portal'];
export async function portalFreshGroupFixtureStage(session,{namespace,config}) {
 const startedAt=new Date().toISOString(),{ownerPage,scoped,checkpoint,model,tenantId,portalOrigin}=session;
 assert.equal(session.operatorSurface,'portal');assert(model.name.startsWith('wasalx-simulation-'));assert(session.actorBinding?.userMatched&&session.actorBinding?.workspaceMatched);assert.equal(config.fixtureDisposition,'retain-run-owned');
 const owner=await session.verifyOwner(ownerPage,session.ownerId,'tenant_owner',tenantId);assert(owner.userMatched&&owner.workspaceMatched);await session.ensurePrivilegedOwner();
 const groupRef=model.services['waha-gows'].environment.WAHA_SIM_GROUP_ID;assert(groupRef);
 assert.equal((await scoped('SELECT id FROM connections')).length,0,'Fresh preparation cannot replay a retained connection');assert.equal((await scoped('SELECT id FROM rule_sets')).length,0,'Fresh preparation cannot replay retained rules');
 let connectionId;
 const wait=async(read,accept)=>{const end=Date.now()+120000;while(Date.now()<end){const rows=await read();if(accept(rows))return rows;await new Promise(r=>setTimeout(r,500));}throw Error('Preparation receipt pending; preserve intent');};
 const record=async row=>{
  await checkpoint(row);
  if(row.phase==='accepted'&&row.step==='connection'){
   connectionId=row.id;assert.match(connectionId,/^[a-f0-9-]{36}$/iu);
   await wait(()=>scoped('SELECT state FROM connection_operations WHERE connection_id=$1 AND operation_type=$2 AND idempotency_key=$3',[connectionId,'PROVISION',row.key]),rows=>rows.length===1&&rows[0].state==='SUCCEEDED');
   for(const status of ['SCAN_QR_CODE','WORKING']){
    const eventId=simulationEventId(`${namespace}-connection-${status}`);await checkpoint({phase:'intent',step:'session-status',eventId,status});
    const receipt=await callSimulationControl(session.socketPath,{action:'session-status',input:{eventId,status}});await checkpoint({phase:'accepted',step:'session-status',eventId,status,receipt});assert(receipt.results.length&&receipt.results.every(r=>r.status>=200&&r.status<300));
    await wait(()=>scoped("SELECT provider_state FROM provider_sessions WHERE connection_id=$1 AND ownership_state='ACTIVE'",[connectionId]),rows=>rows.length===1&&rows[0].provider_state===status);
   }
  }
 };
 const prepared=await seedSyntheticGroup({page:ownerPage,origin:portalOrigin,runId:namespace,externalGroupId:groupRef,nativeGroupName:'Operations',evidenceMode:'simulated',prepareOnly:true,checkpoint:record,assertIsolatedRuntime:async()=>{assert.equal(session.operatorSurface,'portal');assert(model.name.startsWith('wasalx-simulation-'));}});
 assert(prepared.preparationOnly===true);assert.equal(prepared.connectionId,connectionId);
 const result={evidenceMode:'simulated',namespace,tenantId,connectionId:prepared.connectionId,groupId:prepared.groupId,groupRef,nativeGroupName:prepared.nativeGroupName,ruleSetId:prepared.ruleSetId,prepared,fixtureDisposition:config.fixtureDisposition,preparationOnly:true,startedAt,finishedAt:new Date().toISOString(),results:[],proofs:[]};
 await checkpoint({phase:'group-preparation-complete',namespace,connectionId:result.connectionId,groupId:result.groupId,noNativeBinding:true,noIngress:true});return result;
}

export async function portalFreshGroupObservationStage(s,args){
 const {selectPortalChecks,portalRulesContextMap,preparePortalRuleOperator,observePortalRuleTicket}=await import('./simulation-portal-rule-command-boundary.mjs');
 const supporting=args.config?.assertionDisposition==='supporting';
 assert(args.config?.assertionDisposition===undefined||supporting,'Unknown first-group assertion disposition');
 if(supporting)assert.deepEqual(args.checks??[],[],'Supporting first-group observation has no qualification checks');else selectPortalChecks(args.checks,portalFreshGroupTestIds,portalRulesContextMap(portalFreshGroupTestIds));
 const g=args.inputs.group;assert(g?.ingressSettled===true&&g.evidenceMode==='simulated');assert.equal(g.namespace,args.namespace);assert.equal(g.tenantId,s.tenantId);
 assert(g.observation&&g.observation.articleIds.length===1);
 const startedAt=new Date().toISOString(),operator=await preparePortalRuleOperator(s,g),h=await import('./simulation-portal-operator.mjs');
 const ticket=await h.privateNativeRead(s,'ticket',{ticketId:String(g.ticketId)});assert.equal(String(ticket.number),g.observation.ticketNumber);
 const before=await s.directCallbacks.providerRead();
 const proof=await observePortalRuleTicket(operator,{ticket,articleId:g.observation.articleIds[0],marker:g.observation.marker});
 assert.deepEqual(await s.directCallbacks.providerRead(),before,'Read-only first-group observation changed provider effects');
 const row=h.bindPortalOperatorResult({testId:portalFreshGroupTestIds[0],contextId:'tenant_owner-en-desktop',result:'passed',startedAt,finishedAt:new Date().toISOString(),proof:{eventId:g.eventId,ticketId:String(g.ticketId),classification:'customer',duplicateEffectsUnchanged:true,portalObservation:proof,fixtureEvidencePath:g.evidencePath}},await h.capturePortalOperatorEvidence(operator));
 const output=portalFreshGroupObservationRecord(row,{assertionDisposition:args.config?.assertionDisposition});
 await s.checkpoint({phase:supporting?'portal-first-group-supporting-observation':'portal-first-group-observation',...output});
 return{evidenceMode:'simulated',namespace:args.namespace,tenantId:s.tenantId,...output,fixtureReplayed:false};
}

export function portalFreshGroupObservationRecord(row,{assertionDisposition}={}){
 assert(assertionDisposition===undefined||assertionDisposition==='supporting','Unknown first-group assertion disposition');
 if(assertionDisposition===undefined)return{results:[row]};
 assert.equal(row.result,'passed');assert.equal(row.verifiedContext?.contractVersion,2);assert.equal(row.verifiedContext.surface,'portal');
 const binding={...row};delete binding.testId;delete binding.result;delete binding.proof;
 return{observations:[{...binding,observation:row.proof,surface:'portal',assertionDisposition:'supporting'}]};
}
