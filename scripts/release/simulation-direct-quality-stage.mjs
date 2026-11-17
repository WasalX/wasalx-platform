import assert from 'node:assert/strict';
import {runDirectConversationQuality,qualityIds} from './simulation-direct-quality.mjs';
import {assertMetaFixtureProvenance} from './simulation-meta-producer.mjs';
export function admitDirectQuality(session,{namespace,inputs,config}) {
  assert(session.actorBinding?.userMatched&&session.actorBinding?.workspaceMatched);
  const group=inputs.group,direct=inputs.directFlow,meta=inputs.metaDeliveries;
  assert.equal(group?.evidenceMode,'simulated');assert.equal(group.namespace,namespace);assert.equal(group.tenantId,session.tenantId);
  assert.equal(direct?.evidenceMode,'simulated');assert.equal(direct.fixtures?.tenantId,session.tenantId);assert.equal(direct.fixtures.connectionId,group.connectionId);
  assert.equal(meta?.evidenceMode,'simulated');assert.equal(meta.tenantId,session.tenantId);assertMetaFixtureProvenance(meta,namespace);
  assert.equal(session.directCallbacks?.binding?.connectionId,group.connectionId);assert.equal(session.metaCallbacks?.binding?.connectionId,meta.connectionId);
  assert.equal(typeof session.directCallbacks.providerRead,'function');assert.equal(typeof session.metaCallbacks.providerRead,'function');
  assert.equal(typeof session.verifyOwner,'function');assert.equal(typeof session.output,'string');
  assert.deepEqual(config.contextIds,['tenant_owner-en-desktop','tenant_owner-en-tablet']);
  assert.match(direct.fixtures.newConversationId,/^[a-f0-9-]{36}$/);
  return direct.fixtures.newConversationId;
}
export async function directConversationQualityStage(session,args) {
  const conversationId=admitDirectQuality(session,args);
  const result=await runDirectConversationQuality({page:session.ownerPage,origin:session.portalOrigin,checkpoint:session.checkpoint,output:session.output,conversationId,
    verifyOwner:async page=>{const actual=await session.verifyOwner(page);assert(actual.userMatched&&actual.workspaceMatched);return true;},
    readEffects:async()=>({waha:await session.directCallbacks.providerRead(),meta:await session.metaCallbacks.providerRead()})});
  assert.equal(result.results.length,qualityIds().length*2);
  return {...result,namespace:args.namespace,tenantId:session.tenantId,conversationId,contextIds:args.config.contextIds};
}
