import {verifyOwnerEvidence,bindOwnerEvidenceRows} from './simulation-owner-evidence.mjs';
import assert from 'node:assert/strict';
import {shellQuality} from './simulation-navigation-quality.mjs';
import {definitions} from './simulation-navigation-quality-definitions.mjs';
import {projectSelectedContextRows,selectedStageChecks,selectedViewports} from './simulation-team-observation-selection.mjs';
export function mapNavigationQuality(rows){return definitions.map(t=>{const suffix=t.id.split('::').at(-1),row=rows.find(r=>r.suffix===(suffix==='safe-error-recovery'?'degraded':suffix));assert(row,'Missing shell assertion');return{...row,testId:t.id};});}
export function mergeNavigationContextResults(ownerRows,roleRows,checks){return projectSelectedContextRows([...ownerRows,...roleRows],checks);}
export async function navigationQualityStage(session,{namespace,inputs,config,checks}){
 assert(session.actorBinding?.userMatched&&session.actorBinding?.workspaceMatched);assert.equal(config.contextId,'tenant_owner-en-desktop');assert.equal(inputs.group?.evidenceMode,'simulated');assert.equal(inputs.group.namespace,namespace);assert.equal(inputs.group.tenantId,session.tenantId);assert.equal(inputs.teamAccess?.namespace,namespace);assert.equal(inputs.teamAccess.tenantId,session.tenantId);
 const roleRows=inputs.teamAccess.navigationQualityContextResults??[],roleSessionObservations=inputs.teamAccess.sessionQualityContextObservations??[];assert(Array.isArray(roleRows)&&Array.isArray(roleSessionObservations));
 const selected=selectedStageChecks(checks,definitions.map(row=>row.id),config.contextId),ownerRows=[],ownerSessionObservations=[],original=session.ownerPage.viewportSize();
 try{for(const viewport of selectedViewports(selected,'tenant_owner')){await session.ownerPage.setViewportSize({width:viewport.width,height:viewport.height});await session.verifyOwner(session.ownerPage);const observed=await shellQuality({...session,runId:namespace+'-owner-'+viewport.name,role:'tenant_owner'}),binding=await verifyOwnerEvidence(session),bind=row=>bindOwnerEvidenceRows([{...row,actualViewport:session.ownerPage.viewportSize(),contextId:viewport.contextId,actorBinding:session.actorBinding,tenantId:session.tenantId}],binding)[0];ownerSessionObservations.push(...observed.results.map(bind));for(const row of mapNavigationQuality(observed.results)){const record=bind(row);ownerRows.push(record);await session.checkpoint({phase:'navigation-quality-mapped',...record});}}}
 finally{if(original)await session.ownerPage.setViewportSize(original);}
 const {results,notExecuted}=mergeNavigationContextResults(ownerRows,roleRows,selected);
 return{evidenceMode:'simulated',namespace,tenantId:session.tenantId,results,notExecutedChecks:notExecuted,observations:results,sessionObservations:[...ownerSessionObservations,...roleSessionObservations]};
}
