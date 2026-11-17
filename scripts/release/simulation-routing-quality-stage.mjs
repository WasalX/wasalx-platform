import assert from 'node:assert/strict';
import {definitions} from './simulation-routing-quality-definitions.mjs';
export function admitRoutingQuality(session,{namespace,inputs,config}) {
 assert(session.actorBinding?.userMatched&&session.actorBinding?.workspaceMatched);
 assert.equal(config.contextId,'tenant_owner-en-desktop');
 for(const name of ['group','routingFive']){const f=inputs[name];assert.equal(f?.evidenceMode,'simulated');assert.equal(f.namespace,namespace);assert.equal(f.tenantId,session.tenantId);}
 const fixture=inputs.routingFive;assert.equal(fixture.runId,fixture.retainedFrom??namespace);if(fixture.retainedFrom)assert.notEqual(fixture.retainedFrom,namespace);assert.match(fixture.draftId,/^[a-f0-9-]{36}$/);assert(Number.isInteger(fixture.version)&&fixture.version>0);
 assert.equal(session.directCallbacks?.binding?.connectionId,inputs.group.connectionId);assert.equal(typeof session.directCallbacks?.providerRead,'function');
 return{draftId:fixture.draftId,version:fixture.version,runId:fixture.runId};
}
export async function routingQualityStage(session,args){
 const routingDraft=admitRoutingQuality(session,args);
 await session.verifyOwner(session.ownerPage);
 const draft=await session.ownerPage.evaluate(async id=>{const r=await fetch('/api/client-routing/'+id,{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Owned routing draft read failed');return r.json();},routingDraft.draftId);
 assert.equal(draft.id,routingDraft.draftId);assert.equal(draft.version,routingDraft.version);assert.equal(draft.state,'DRAFT');assert.equal(draft.definition.name,'Alpha routing '+routingDraft.runId);
 const {runRoutingQuality}=await import('./simulation-routing-quality.mjs');
 const result=await runRoutingQuality({page:session.ownerPage,origin:session.portalOrigin,checkpoint:session.checkpoint,providerRead:()=>session.directCallbacks.providerRead(),testDefinitions:definitions,routingDraft});
 return{...result,evidenceMode:'simulated',namespace:args.namespace,tenantId:session.tenantId,contextId:args.config.contextId,routingDraft};
}
