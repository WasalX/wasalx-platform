// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// Finite installed DEV contract. This module never grants product/provider authority.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
export const need=(x,reason)=>assert(Boolean(x),'P05B '+reason);
export const sha=x=>createHash('sha256').update(x).digest('hex');
export const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(x);
export const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/u.test(x);
export const templateCases=['full','mixed','failed','incompatible','disconnect','malformed','rejected','signed-first','signed-last','privacy-settled','privacy-unknown','read-only'];
export const templateResponseMode=name=>({mixed:'MIXED',failed:'FAILED',disconnect:'DISCONNECT',malformed:'MALFORMED',rejected:'REJECT','privacy-unknown':'DISCONNECT'}[name]??'FULL');
export function validateTemplateManifest(m){
 const p=m.p05b;need(m.mode==='happy'&&p?.namespace==='p05b-'+m.runId&&templateCases.includes(p.case),'CASE');
 need(['en','ar'].includes(p.locale)&&[390,1440].includes(p.width)&&['tenant_owner','auditor'].includes(p.role)&&uuid(p.actorId),'CONTEXT');
 need((p.case==='read-only')===(p.role==='auditor')&&(p.role==='auditor'||p.actorId===m.ownerId),'ROLE');
 need(p.case==='full'||p.locale==='en'&&p.width===1440,'FINITE_CONTEXT');
 need(uuid(p.sourceConnectionId)&&uuid(p.targetConnectionId)&&p.sourceConnectionId!==p.targetConnectionId,'CONNECTIONS');
 need([p.fixtureSha256,p.guestSha256,p.browserSha256,p.contractSha256,p.fixturePreparationReceiptSha256,p.disposableTenantReceiptSha256,p.sourceReviewSha256,p.uiReviewSha256,p.catalogSha256].every(hex),'BOUND_INPUTS');
 need(Array.isArray(p.flows)&&p.flows.length===2&&p.flows.every(f=>uuid(f.id)&&hex(f.definitionSha256))&&p.flows[0].id!==p.flows[1].id&&uuid(p.assignmentId)&&uuid(p.conversationId),'NONEMPTY_FLOW_PROOF');
 need(Array.isArray(p.selectedNames)&&p.selectedNames.length===2&&new Set(p.selectedNames).size===2&&p.selectedNames.every(v=>/^[a-z][a-z0-9_]{0,100}$/u.test(v)),'TEMPLATE_SELECTION');
 need(typeof p.targetName==='string'&&p.targetName.length>0&&p.targetName.length<=100,'TARGET_LABEL');
 need(hex(p.database?.id)&&/^sha256:[a-f0-9]{64}$/u.test(p.database?.image)&&p.database.service==='postgres'&&p.database.database==='wasalx'&&/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(p.database.user),'READ_DATABASE');
 need(p.dependencies?.length===5&&['B1','TEMPLATE_UI','ROOT_DRIVER','P07_DRIVER','P08_FINANCIAL'].every(name=>p.dependencies.some(d=>d.name===name&&hex(d.sourceSha256)&&hex(d.reviewSha256))),'DEPENDENCIES');
 need(uuid(p.runtime?.accountId)&&uuid(p.runtime.receiptId)&&hex(p.runtime.descriptorSha256)&&hex(p.runtime.transportBindingSha256)&&hex(p.runtime.releaseEvidenceSha256)&&/^sha256:[a-f0-9]{64}$/u.test(p.runtime.workerImageDigest),'CURRENT_TARGET_RUNTIME');
 return m;
}
export function assertTemplateSetup(row,m){
 const p=m.p05b;need(row?.tenantId===m.tenantId&&row.source?.id===p.sourceConnectionId&&row.target?.id===p.targetConnectionId,'READ_SCOPE');
 need([row.source,row.target].every(c=>c.provider==='META'&&c.state==='PAUSED'&&c.bindings.length===1&&c.bindings[0].state==='ACTIVE'&&c.bindings[0].sessionOwnership==='ACTIVE'),'CURRENT_PAUSED_BINDINGS');
 need(row.source.bindings[0].wabaId===m.fixture.signup.wabaId&&row.source.bindings[0].wabaId!==row.target.bindings[0].wabaId&&row.source.bindings[0].phoneId!==row.target.bindings[0].phoneId,'DISTINCT_ASSETS');
 need(row.flows.length===2&&p.flows.every(f=>row.flows.some(r=>r.id===f.id&&r.definitionSha256===f.definitionSha256&&r.version>0&&r.published&&['ACTIVE','RETIRED'].includes(r.state))),'IMMUTABLE_FLOW_BYTES');
 const currentFlow=row.flows.find(f=>f.id===p.flows[0].id),olderFlow=row.flows.find(f=>f.id===p.flows[1].id);need(currentFlow.familyId===olderFlow.familyId&&currentFlow.version>olderFlow.version&&currentFlow.state==='ACTIVE','OLDER_PUBLISHED_PIN');
 need(row.assignment?.state==='ACTIVE'&&row.assignment?.id===p.assignmentId&&row.assignment.connectionId===p.sourceConnectionId&&row.assignment.flowVersionId===p.flows[0].id&&row.conversation?.id===p.conversationId&&row.conversation.assignmentId===p.assignmentId&&row.conversation.ingressCount>=1&&row.conversation.connectionId===p.sourceConnectionId&&row.conversation.flowVersionId===p.flows[1].id,'ASSIGNED_AND_OLDER_PIN');
 need(row.source.bindings[0].businessId===row.target.bindings[0].businessId&&row.source.bindings[0].businessId===m.fixture.signup.businessId,'OBSERVED_SAME_BUSINESS');
 return row;
}
export function assertOriginalTemplateCopy(row,{count=1,outcome}={}){
 need(row.provider?.attempts?.length===count,'EXACT_PROVIDER_POST_COUNT');
 need(row.checkpoints.length===count&&row.checkpoints.every(c=>c.stage==='TEMPLATE_COPY'&&uuid(c.operationId)&&hex(c.requestSha256)),'ONE_DURABLE_SLOT');
 if(outcome)need(row.checkpoints[0]?.outcome===outcome,'ORIGINAL_OUTCOME');
 need(row.plan?.transitionKind==='TEMPLATE_PREPARATION'&&row.plan.executionState==='UNPREPARED'&&row.plan.providerMigrationId===null&&row.plan.identitySuccessor===false,'NO_CUTOVER');return row;
}
export function assertTemplateHistory(original,current){
 for(const o of original.operations.filter(o=>o.observationOperationId)){
  const n=current.operations.find(n=>n.id===o.id);need(n&&isDeepStrictEqual(n,o),'IMMUTABLE_OBSERVATION_HISTORY');
 }
 need(isDeepStrictEqual(original.checkpoints,current.checkpoints)&&isDeepStrictEqual(original.provider.attempts,current.provider.attempts),'NO_PROVIDER_REPLAY');
}
export function assertTemplateIntent(request,view){
 const a=view?.pendingAction;need(a&&a.requestKey===request.key&&a.action===request.action&&a.requestRevision===request.body.expectedRevision&&uuid(a.operationId),'EXACT_OPERATION_CORRELATION');return a;
}
