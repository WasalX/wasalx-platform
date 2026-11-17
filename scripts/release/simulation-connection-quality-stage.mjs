import assert from 'node:assert/strict';
import {verifyOwnerEvidence,bindOwnerEvidenceRows} from './simulation-owner-evidence.mjs';
import {projectSelectedContextRows,selectedStageChecks,selectedViewports} from './simulation-team-observation-selection.mjs';
import {connectionQuality} from './simulation-connection-quality.mjs';
import {definitions} from './simulation-connection-quality-definitions.mjs';
import {assertMetaFixtureProvenance} from './simulation-meta-producer.mjs';
export function admitConnectionQuality(session,{namespace,inputs,config}){
 assert(session.actorBinding?.userMatched&&session.actorBinding?.workspaceMatched);assert.equal(config.contextId,'tenant_owner-en-desktop');
 assert.equal(inputs.group?.evidenceMode,'simulated');assert.equal(inputs.group.namespace,namespace);assert.equal(inputs.group.tenantId,session.tenantId);
 assert.equal(inputs.metaDeliveries?.evidenceMode,'simulated');assert.equal(inputs.metaDeliveries.tenantId,session.tenantId);assertMetaFixtureProvenance(inputs.metaDeliveries,namespace);
 return [{id:inputs.group.connectionId,provider:'WAHA',prefixes:['connections/create-bind-test-and-health','connections/disconnect-reconnect-and-secret-retirement','provider-live-contracts/gows-group-direct-pairing-reconnect-and-delivery']},{id:inputs.metaDeliveries.connectionId,provider:'META',prefixes:['provider-live-contracts/meta-direct-webhook-template-window-and-delivery']}];
}
export function mapConnectionResults(rows,prefixes){return prefixes.flatMap(prefix=>definitions.filter(t=>t.id.startsWith(prefix+'::')).map(t=>{const suffix=t.id.split('::').at(-1);const observerSuffix=suffix==='keyboard-focus'&&prefix==='connections/disconnect-reconnect-and-secret-retirement'?'disconnect-keyboard-focus':suffix==='safe-error-recovery'?'degraded':suffix;const row=rows.find(r=>r.suffix===observerSuffix);assert(row,'Missing exact connection observer result');return{...row,testId:t.id};}));}
export function mergeConnectionContextResults(ownerRows,roleRows,checks){return projectSelectedContextRows([...ownerRows,...roleRows],checks);}
export async function connectionQualityStage(session,args){
 const fixtures=admitConnectionQuality(session,args),{inputs,namespace,config,checks}=args;assert.equal(inputs.teamAccess?.namespace,namespace);assert.equal(inputs.teamAccess.tenantId,session.tenantId);const roleRows=inputs.teamAccess.connectionQualityContextResults??[];assert(Array.isArray(roleRows));
 const selected=selectedStageChecks(checks,definitions.map(row=>row.id),config.contextId),ownerRows=[],original=session.ownerPage.viewportSize();
 try{for(const viewport of selectedViewports(selected,'tenant_owner')){const wanted=selected.filter(check=>check.contextId===viewport.contextId);await session.ownerPage.setViewportSize({width:viewport.width,height:viewport.height});for(const fixture of fixtures){const prefixes=fixture.prefixes.filter(prefix=>wanted.some(check=>check.testId.startsWith(prefix+'::')));if(!prefixes.length)continue;await session.verifyOwner(session.ownerPage);const observed=await connectionQuality({...session,runId:namespace+'-owner-'+viewport.name,connectionId:fixture.id,expectedProvider:fixture.provider}),binding=await verifyOwnerEvidence(session);for(const row of mapConnectionResults(observed.results,prefixes)){const record=bindOwnerEvidenceRows([{...row,actualViewport:session.ownerPage.viewportSize(),actorBinding:session.actorBinding,tenantId:session.tenantId,contextId:viewport.contextId,connectionId:fixture.id,provider:fixture.provider}],binding)[0];ownerRows.push(record);await session.checkpoint({phase:'connection-quality-mapped',...record});}}}}
 finally{if(original)await session.ownerPage.setViewportSize(original);}
 const {results,notExecuted}=mergeConnectionContextResults(ownerRows,roleRows,selected);
 return{evidenceMode:'simulated',namespace,tenantId:session.tenantId,results,notExecutedChecks:notExecuted,limitations:['Owner contexts are observed only where selected; restricted-role rows come from the shared authenticated role wave.','No pairing, reconnect, retirement, authorization business action, or provider replay is performed.']};
}
