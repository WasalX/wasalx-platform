import assert from 'node:assert/strict';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
export async function createOwnedWorkflowDraft({request,checkpoint,sourceId,namespace,tenantId}) {
  assert.match(namespace,/^[A-Za-z0-9-]{1,40}$/);assert.match(sourceId,/^[a-f0-9-]{36}$/);
  const original=await request(`/api/bot-flows/${sourceId}`);assert(original.definition&&original.state==='ACTIVE');
  const definition={...original.definition,name:`Synthetic quality ${namespace}`};
  await checkpoint({phase:'workflow-draft-producer-intent',sourceId,namespace,tenantId});
  const created=await request(`/api/bot-flows/${sourceId}/clone`,'POST',definition,'quality-owned-draft');
  assert(created.id!==sourceId&&created.state==='DRAFT');
  const draft=await request(`/api/bot-flows/${created.id}`);assert.equal(draft.state,'DRAFT');assert.deepEqual(draft.definition,definition);
  assert.deepEqual(await request(`/api/bot-flows/${sourceId}`),original);
  const result={evidenceMode:'simulated',namespace,tenantId,sourceId,draftVersionId:created.id,version:draft.version,name:definition.name,disposition:'retain-run-owned-draft'};
  await checkpoint({phase:'workflow-draft-produced',...result});return result;
}
export async function workflowDraftStage(session,{namespace,inputs}) {
  assert(session.actorBinding?.userMatched&&session.actorBinding?.workspaceMatched);
  assert.equal(inputs.group?.namespace,namespace);assert.equal(inputs.group.tenantId,session.tenantId);assert.equal(inputs.group.evidenceMode,'simulated');
  const direct=inputs.directFlow;assert.equal(direct?.evidenceMode,'simulated');assert.equal(direct.fixtures?.tenantId,session.tenantId);assert.equal(direct.fixtures.connectionId,inputs.group.connectionId);
  const request=createSyntheticRequest({page:session.ownerPage,origin:session.portalOrigin,runId:namespace,checkpoint:session.checkpoint});
  // The retained second version may have been superseded; clone the family's one current ACTIVE version.
  const sourceId=await resolveActiveWorkflowSource({scoped:session.scoped,tenantId:session.tenantId,retainedId:direct.fixtures.secondVersionId});
  return createOwnedWorkflowDraft({request,checkpoint:session.checkpoint,sourceId,namespace,tenantId:session.tenantId});
}

export async function resolveActiveWorkflowSource({scoped,tenantId,retainedId}){assert.match(tenantId,/^[a-f0-9-]{36}$/);assert.match(retainedId,/^[a-f0-9-]{36}$/);const rows=await scoped("SELECT active.id FROM bot_flow_versions retained JOIN bot_flow_versions active ON active.tenant_id=retained.tenant_id AND active.family_id=retained.family_id AND active.state='ACTIVE' WHERE retained.tenant_id=$1 AND retained.id=$2 ORDER BY active.id",[tenantId,retainedId]);assert.equal(rows.length,1,'Retained workflow family must have exactly one current ACTIVE source');assert.match(rows[0].id,/^[a-f0-9-]{36}$/);return rows[0].id;}
