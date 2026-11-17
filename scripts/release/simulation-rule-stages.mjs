import {withOwnerEvidence} from './simulation-owner-evidence.mjs';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
import {runIndependentEcho} from './simulation-rule-echo.mjs';
import assert from 'node:assert/strict';
import {runFreshRuleVersions} from './simulation-rule-versions.mjs';
export const ruleRollbackTestId='group-rules/commands-triggers-and-friendly-ticket-naming::configured-team-sender-policy-controls-group-trigger-effects::rollback';
export function admitRuleVersions(session,{namespace,inputs}){
 assert.match(namespace,/^[A-Za-z0-9-]{1,40}$/);
 assert(session.actorBinding?.userMatched&&session.actorBinding?.workspaceMatched);
 assert(session.model?.name?.startsWith('wasalx-simulation-'));
 const g=inputs?.group;assert.equal(g?.evidenceMode,'simulated');
 assert.equal(g.namespace,namespace);assert.equal(g.tenantId,session.tenantId);
 for(const key of ['connectionId','groupId','ruleSetId'])assert(g[key]);
 for(const key of ['scoped','checkpoint'])assert.equal(typeof session[key],'function');
 assert(session.ownerPage&&session.portalOrigin);return g;
}
export async function ruleVersionsStage(session,args){
 admitRuleVersions(session,args);
 return runFreshRuleVersions({ownerPage:session.ownerPage,portalOrigin:session.portalOrigin,
  runId:args.namespace,checkpoint:session.checkpoint,scoped:session.scoped,tenantId:session.tenantId});
}

export async function ruleEchoStage(...args){return withOwnerEvidence(args[0],()=>ruleEchoStageOperation(...args));}
async function ruleEchoStageOperation(session,args){
 const group=admitRuleVersions(session,args),fixture=args.inputs.directConnection,h=session.directCallbacks;
 assert.equal(fixture?.provider,'WAHA');assert.equal(fixture.evidenceMode,'simulated');
 assert.equal(fixture.tenantId,session.tenantId);assert.equal(fixture.connectionId,group.connectionId);
 for(const key of ['control','drainEffects','providerRead','assertIsolatedRuntime'])assert.equal(typeof h?.[key],'function');
 for(const key of ['project','connectionId','providerSessionId','containerId','imageId','socketPath']){
  assert.equal(typeof fixture.runtimeBinding?.[key],'string');assert.equal(fixture.runtimeBinding[key],h.binding?.[key]);
 }
 assert.match(group.groupRef,/^[0-9-]+@g\.us$/);
 await h.assertIsolatedRuntime({evidenceMode:'simulated',tenantId:session.tenantId,connectionId:group.connectionId});
 await session.verifyOwner(session.ownerPage);await session.ownerPage.setViewportSize({width:1440,height:1000});
 const request=createSyntheticRequest({page:session.ownerPage,origin:session.portalOrigin,runId:args.namespace,checkpoint:session.checkpoint}),path='/api/groups/'+group.groupId+'/binding',beforeBinding=await request(path);
 const proof=await runIndependentEcho({runId:args.namespace,tenantId:session.tenantId,connectionId:group.connectionId,
  externalGroupId:group.groupRef,scoped:session.scoped,providerRead:h.providerRead,control:h.control,drainEffects:h.drainEffects,checkpoint:session.checkpoint});
 assert.deepEqual(await request(path),beforeBinding);
 return{evidenceMode:'simulated',namespace:args.namespace,tenantId:session.tenantId,proofs:[bindRuleEchoProof(proof,session.ownerPage.viewportSize())]};
}

export function bindRuleEchoProof(proof,actualViewport){assert(Number.isFinite(Date.parse(proof.startedAt))&&Number.isFinite(Date.parse(proof.finishedAt))&&Date.parse(proof.startedAt)<=Date.parse(proof.finishedAt),'Rule echo requires its producer action/check window');return{...proof,contextId:'tenant_owner-en-desktop',actualViewport,proof:{...proof.proof,scope:'Owner-authenticated binding readback plus provider echo; no UI render claim',bindingUnchanged:true}};}
