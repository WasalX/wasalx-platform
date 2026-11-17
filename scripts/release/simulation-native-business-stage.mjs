import{runNativeRemainingWithinCapture,nativeRemainingTestIds}from'./simulation-native-remaining.mjs';
import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';
import{ensureNativeAgent}from'./simulation-native-agent.mjs';import{runNativeNeutralScenario}from'./simulation-native-neutral.mjs';import{admitGrantMedia}from'./simulation-native-grants-stage.mjs';import{runNativeBusinessBatch}from'./simulation-native-business-batch.mjs';import{runCapturedMutations}from'./simulation-native-captured-mutations.mjs';import{admitNativeMailUi}from'./simulation-native-mail-browser.mjs';
const mutations='group-workspace/live-inbound-outbound-edits-revokes-reactions-and-attribution::',tickets='group-workspace/open-closed-tickets-link-create-and-exact-message-jump::ticket-link-create-and-message-jump-open-exact-records::';
export const nativeBusinessTestIds=[...[1,2,3,4,5].map(n=>mutations+'message-mutations-and-attribution-render-safely::0'+n),mutations+'participant-nickname-consistency::fallback',tickets+'01',tickets+'02'];
export async function nativeBusinessStage(s,{namespace,inputs,config}){
 const g=inputs.group;assert.equal(g.namespace,namespace);assert.equal(g.tenantId,s.tenantId);assert.equal(g.evidenceMode,'simulated');assert.equal(inputs.directConnection.connectionId,g.connectionId);assert(s.model.name.startsWith('wasalx-simulation-'));assert(s.actorBinding.userMatched&&s.actorBinding.workspaceMatched);assert.equal(typeof s.directCallbacks.providerRead,'function');
 const fixture=config.mediaFixture,bytes=await readFile(admitGrantMedia(s.model,fixture,s.driverRoot));assert.equal(bytes.length,fixture.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),fixture.sha256);
 assert(Array.isArray(config.participants)&&config.participants.length===3&&new Set(config.participants).size===3);assert(config.participants.slice(0,2).every(x=>/^[1-9][0-9]+@c\.us$/.test(x)));assert(/^[1-9][0-9]+@lid$/.test(config.participants[2]));
 const agent=await ensureNativeAgent(s);await agent.verify();await agent.page.setViewportSize({width:1440,height:1000});let nativeUncertain=false;
 const nativeCheckpoint=async row=>{if(row.phase==='intent')nativeUncertain=true;await s.checkpoint(row)};
 return runNativeNeutralScenario({...s,namespace,nativePage:agent.page,origin:s.portalOrigin,nativeOrigin:s.nativeOrigin,runId:namespace+'-business',connectionId:g.connectionId,groupId:g.groupId,externalGroupId:g.groupRef,mediaFixture:fixture,
 beforeRestore:async()=>assert(!nativeUncertain,'Native operation outcome uncertain; preserve capture and exact action intents'),
 nativeQuality:async current=>{
  await agent.page.goto(s.nativeOrigin+'/desktop/wasalx/groups?group='+g.groupId+'&message='+current.messageId);await admitNativeMailUi(agent.page);const image=agent.page.locator('[data-message-id="'+current.messageId+'"] img');await image.waitFor({state:'visible'});assert(await image.evaluate(async e=>{await e.decode();return e.complete&&e.naturalWidth>0}),'Real captured image must load before revoke proof');
  const result=await runNativeBusinessBatch({...current,participants:config.participants,providerRead:s.directCallbacks.providerRead,nativeCheckpoint,nativeSettled:()=>{nativeUncertain=false}});
  assert(!nativeUncertain,'Resolve native ticket outcome before dependent sends');const remaining=await runNativeRemainingWithinCapture({...current,mediaSimulation:s.mediaSimulation,providerRead:s.directCallbacks.providerRead,providerMessage:s.directCallbacks.providerMessage,markNativeUncertain:()=>{nativeUncertain=true},markNativeSettled:()=>{nativeUncertain=false}},{business:result,config:config.remaining});
  const effects=async()=>({links:await s.scoped('SELECT id FROM message_links WHERE connection_id=$1 ORDER BY id',[g.connectionId]),deliveries:await s.scoped('SELECT id,state,attempts,external_message_id FROM delivery_outbox WHERE connection_id=$1 ORDER BY id',[g.connectionId])});
  const mutation=await runCapturedMutations({...current,providerRead:s.directCallbacks.providerRead,target:{id:current.messageId,external_message_id:current.externalMessageId},participant:current.participant,effects});
  const results=[...joinNativeBusinessResults(result,mutation),...remaining];return{evidenceMode:'simulated',namespace,tenantId:s.tenantId,results,supportingFindings:mutation.findings.filter(x=>x.step==='reaction-native-ui'),status:mutation.findings.length?'findings-collected':'scoped-results-collected',fixture:{groupId:g.groupId,messageId:current.messageId},nativeActorId:agent.actorId,contextId:'zammad_agent-en-desktop',actualViewport:agent.page.viewportSize(),limitations:['Twenty-four exact native business tests; the other-connection nickname callback belongs the lifecycle stage.']};}});
}

export function joinNativeBusinessResults(result,mutation){
 const results=[...result.observed.results,...[result.ticket.created,result.ticket.filtered].filter(Boolean)];
 for(const id of mutation.testIds){const isEdit=id.endsWith('::02'),findings=mutation.findings.filter(x=>isEdit?x.step==='edited-native-ui':x.step==='revoked-native-ui');results.push({testId:id,result:findings.length?'failed':'passed',proof:{targetId:mutation.targetId,findings,mediaBeforeRevoke:true},finishedAt:new Date().toISOString()})}
 if(result.ticket.result==='failed')for(const id of [tickets+'01',tickets+'02'])results.push({testId:id,result:'failed',proof:result.ticket,finishedAt:new Date().toISOString()});
 assert.equal(new Set(results.map(x=>x.testId)).size,nativeBusinessTestIds.length);return results;
}

export const completeNativeBusinessTestIds=[...nativeBusinessTestIds,...nativeRemainingTestIds];
