import {unknownNoResendStage,unknownNoResendId} from './simulation-unknown-no-resend.mjs';
import {caseLifecycleStage,testIds as caseIds} from './simulation-case-lifecycle-stage.mjs';
import {unknownReviewReadOnlyStage,testIds as reviewIds} from './simulation-unknown-review-readonly.mjs';
import {workflowViewsStage,workflowViewIds} from './simulation-workflow-views.mjs';
import {workflowLifecycleStage,workflowLifecycleIds} from './simulation-workflow-lifecycle.mjs';
import assert from 'node:assert/strict';
import {workflowDraftStage} from './simulation-workflow-draft-stage.mjs';
import {unknownReviewFixtureStage,portalUnknownReviewFixtureStage} from './simulation-review-fixture.mjs';
import {admitSharedReadonly} from './simulation-shared-readonly-stage.mjs';
import {definitions as existing} from './simulation-shared-readonly-definitions.mjs';
import {definitions as allDefinitions} from './simulation-remaining-quality-definitions.mjs';
const definitions=allDefinitions.filter(t=>!t.id.startsWith('cases-deliveries/exact-case-lookup-and-direct-agent-navigation::'));
import {runCasesWorkflowQuality} from './simulation-remaining-quality.mjs';
export function admitRemainingQuality(session,args){
 admitSharedReadonly(session,{...args,config:{contextId:'tenant_owner-en-desktop',testIds:existing.filter(t=>!t.id.startsWith('cases-deliveries/exact-case-lookup-and-direct-agent-navigation::')).map(t=>t.id)}});
 assert.equal(args.config.contextId,'tenant_owner-en-desktop');
 assert.equal(args.inputs.directConnection?.evidenceMode,'simulated');assert.equal(args.inputs.directConnection.connectionId,args.inputs.group.connectionId);assert.equal(args.inputs.directConnection.tenantId,session.tenantId);
}
export async function blockedWorkflowLifecycle(session,namespace,dependencyTestId){const startedAt=new Date().toISOString(),proofs=[];for(const testId of workflowLifecycleIds){const row={testId,result:'blocked',startedAt,finishedAt:new Date().toISOString(),proof:{classification:'dependency-blocked',dependencyTestId}};proofs.push(row);await session.checkpoint({phase:'workflow-lifecycle-proof',...row});}return{evidenceMode:'simulated',namespace,tenantId:session.tenantId,proofs};}
export async function remainingCasesWorkflowQualityStage(session,args){
 admitRemainingQuality(session,args);
 const workflowDraft=await workflowDraftStage(session,args);
 const workflowArgs={...args,inputs:{...args.inputs,workflowDraft}};
 const workflowViews=await workflowViewsStage(session,workflowArgs);
 const providerRead=async()=>({waha:await session.directCallbacks.providerRead(),meta:await session.metaCallbacks.providerRead()});
 const workflowQuality=await runCasesWorkflowQuality({page:session.ownerPage,origin:session.portalOrigin,checkpoint:session.checkpoint,providerRead,testDefinitions:definitions.filter(t=>t.id.startsWith('workflow-studio/')),workflowDraft});
 const workflowLifecycle=workflowViews.proofs.find(x=>x.testId===workflowViewIds[0])?.result==='passed'?await workflowLifecycleStage(session,{...workflowArgs,inputs:{...workflowArgs.inputs,workflowViews}}):await blockedWorkflowLifecycle(session,args.namespace,workflowViewIds[0]);
 const caseLifecycle=await caseLifecycleStage(session,args);const currentArgs={...args,inputs:{...args.inputs,group:caseLifecycle.group,caseLifecycle}};
 const cases=await session.ownerPage.evaluate(async()=>{const r=await fetch('/api/cases?limit=200',{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Owned cases unavailable');return r.json();});
 const matching=cases.filter(x=>String(x.zammad_ticket_id)===String(caseLifecycle.group.ticketId));assert.equal(matching.length,1);const ownedCase=matching[0];
 const reviewFixture=await (session.operatorSurface==='portal'?portalUnknownReviewFixtureStage:unknownReviewFixtureStage)(session,{...currentArgs,config:{fixtureDisposition:'retain-readonly-unknown'}});
 assert.equal(reviewFixture.namespace,args.namespace);assert.equal(reviewFixture.tenantId,session.tenantId);assert.equal(reviewFixture.connectionId,args.inputs.group.connectionId);
 const guard=session.capabilities.reviewFixture;assert.equal(guard.fixture.reviewId,reviewFixture.reviewId);await guard.verifyReadOnly();
 try {const result=await runCasesWorkflowQuality({page:session.ownerPage,origin:session.portalOrigin,checkpoint:session.checkpoint,providerRead:async()=>{await guard.verifyReadOnly();return{waha:await guard.readProviderReceipts(),meta:await session.metaCallbacks.providerRead()};},testDefinitions:definitions.filter(t=>!t.id.startsWith('workflow-studio/')),workflowDraft,caseId:ownedCase.id,reviewId:reviewFixture.reviewId});const unknownReview=await unknownReviewReadOnlyStage(session,{...currentArgs,inputs:{...currentArgs.inputs,reviewFixture}});const unknownNoResend=await unknownNoResendStage(session,{...currentArgs,inputs:{...currentArgs.inputs,reviewFixture}});return{...result,caseLifecycle,unknownReview,results:[...unknownNoResend.proofs,...caseLifecycle.proofs,...unknownReview.proofs,...workflowViews.proofs,...workflowQuality.results,...workflowLifecycle.proofs,...result.results],expectedTestIds:[...definitions.map(t=>t.id),...workflowViewIds,...workflowLifecycleIds,...caseIds,...reviewIds,unknownNoResendId],workflowDraft,workflowViews,workflowLifecycle,reviewFixture};}
 finally {await guard.verifyReadOnly();}
}
