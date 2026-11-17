import {ensureNativeAgent} from './simulation-native-agent.mjs';
import assert from 'node:assert/strict';
import {runNativeNeutralScenario} from './simulation-native-neutral.mjs';
import {runNativeGroupQuality} from './simulation-native-group-quality.mjs';
import {definitions} from './simulation-native-group-definitions.mjs';
export function nativeGroupContexts(){return[{surface:'desktop',viewport:{width:1440,height:1000},contextId:'zammad_agent-en-desktop'},{surface:'desktop',viewport:{width:820,height:1180},contextId:'zammad_agent-en-tablet'},{surface:'mobile',viewport:{width:390,height:844},contextId:'zammad_agent-en-mobile'}];}
export function admitNativeGroup(session,{namespace,inputs}){const g=inputs.group;assert(session.actorBinding?.userMatched&&session.actorBinding?.workspaceMatched);assert.equal(g?.evidenceMode,'simulated');assert.equal(g.namespace,namespace);assert.equal(g.tenantId,session.tenantId);assert.equal(inputs.directConnection?.connectionId,g.connectionId);assert.equal(typeof session.directCallbacks?.providerRead,'function');return g;}
export async function nativeGroupQualityStage(session,args){
 const g=admitNativeGroup(session,args),agent=await ensureNativeAgent(session);return runNativeNeutralScenario({...session,nativePage:agent.page,origin:session.portalOrigin,runId:args.namespace,connectionId:g.connectionId,groupId:g.groupId,externalGroupId:g.groupRef,
 nativeQuality:async({messageId})=>{const results=[];for(const context of nativeGroupContexts()){const packet=await runNativeGroupQuality({page:agent.page,expectedActorId:agent.actorId,origin:session.nativeOrigin,groupId:g.groupId,messageId,checkpoint:session.checkpoint,providerRead:session.directCallbacks.providerRead,testDefinitions:definitions,...context});for(const row of packet.results){results.push({...row,contextId:context.contextId});}}return{evidenceMode:'simulated',namespace:args.namespace,tenantId:session.tenantId,groupId:g.groupId,messageId,results,limitations:['One owned neutral inbound reused across three native views.','Native actor role/locale measured by leaf; no portal role or authorization equivalence inferred.']};}});
}
