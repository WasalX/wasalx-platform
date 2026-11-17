// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// Fixed finite P09 installed producer. No application/provider work on import.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
export const sha=x=>createHash('sha256').update(x).digest('hex');
export const requireTransition=(condition,name)=>assert(Boolean(condition),'P09 '+name);
export const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(x);
export const hex=x=>typeof x==='string'&&/^[0-9a-f]{64}$/u.test(x);
export const transitionModes=['happy','initiate-malformed','initiate-lost','complete-malformed','complete-lost'];
export function assertOriginalTransition(row,m,{connectionId,planId}={}){
 requireTransition(row&&row.tenantId===m.tenantId&&row.connection?.provider==='META'&&row.connection.id===connectionId&&row.phoneId===m.fixture.signup.phoneId&&row.appId===m.fixture.signup.appId,'SOURCE_SCOPE');
 requireTransition(row.bindings?.length>=1&&row.bindings.length<=32,'BINDINGS');
 if(planId)requireTransition(row.plan?.id===planId&&row.plan.targetCurrency===m.p09.targetCurrency&&row.plan.requestedMode===m.p09.requestedMode,'PLAN');
 for(const stage of ['INITIATE','COMPLETE'])requireTransition(row.checkpoints.filter(x=>x.stage===stage).length<=1,'ORIGINAL_SLOT');
 return row;
}
export function assertCommittedTarget(row,m,connectionId,planId){
 assertOriginalTransition(row,m,{connectionId,planId});const current=row.bindings.filter(x=>x.state==='ACTIVE');
 requireTransition(row.plan.executionState==='RECONCILED_PAUSED'&&row.plan.providerStatus==='COMPLETED'&&row.plan.identityClaim==='SAME_GRAPH_PHONE_ACCOUNT_SUCCESSOR'&&current.length===1,'SUCCESSOR');
 const b=current[0];requireTransition(b.transitionId===planId&&b.predecessorId&&b.accountId===row.plan.targetAccountId&&b.providerAccountId===row.plan.targetProviderAccountId&&b.providerAccountId!==m.fixture.signup.wabaId&&b.phoneId===m.fixture.signup.phoneId&&b.appId===m.fixture.signup.appId&&b.sessionOwnership==='ACTIVE'&&b.sessionWaba===b.providerAccountId&&b.proofWaba===b.providerAccountId&&b.proofPhone===b.phoneId&&row.connection.state==='WORKING'&&b.sessionState==='WORKING','CURRENT_TARGET');
 requireTransition(row.bindings.some(x=>x.id===b.predecessorId&&x.state==='RETIRED'&&x.providerAccountId===m.fixture.signup.wabaId&&x.phoneId===b.phoneId&&x.appId===b.appId),'PREDECESSOR');return b;
}
export function assertNoReplay(before,after){
 for(const stage of ['INITIATE','COMPLETE']){
  const a=before.checkpoints.filter(x=>x.stage===stage),b=after.checkpoints.filter(x=>x.stage===stage);
  if(a.some(x=>['ATTEMPTED','UNKNOWN'].includes(x.outcome)))requireTransition(JSON.stringify(a)===JSON.stringify(b),'UNKNOWN_HISTORY');
 }
 requireTransition(isDeepStrictEqual(after.provider.attempts,before.provider.attempts),'NO_PROVIDER_POST_REPLAY');
 requireTransition(after.provider.attempts.filter(x=>x.accepted).length===before.provider.attempts.filter(x=>x.accepted).length,'NO_PROVIDER_EFFECT_REPLAY');
}
export function originalIntent(request){requireTransition(uuid(request.key)&&uuid(request.planId)&&Number.isSafeInteger(request.body?.expectedRevision)&&request.body.expectedRevision>0&&hex(request.body.expectedPreviewSha256)&&Object.keys(request.body).length===2,'INTENT');return structuredClone(request);}
export function assertIntentReadback(intent,view){const p=view.execution?.pendingAction;requireTransition(p?.requestKey===intent.key&&p.action===intent.action.toUpperCase()&&p.requestRevision===intent.body.expectedRevision&&uuid(p.operationId),'ORIGINAL_READBACK');return p;}

export function assertCompletedSource(result,m){
 const s=m.p09.sourceSignup;
 requireTransition(result?.evidenceMode==='simulated'&&result.mode==='happy'&&result.runId===s.runId&&result.manifestSha256===s.manifestSha256&&result.candidate?.sha===m.candidate.sha&&result.candidate?.tree===m.candidate.tree,'SOURCE_ARTIFACT_BINDING');
 const p=result.proof;requireTransition(p?.status==='COMPLETED'&&uuid(p.attemptId)&&uuid(p.connectionId)&&uuid(p.operationId)&&p.operationState==='SUCCEEDED'&&p.codeConsumptions===1,'SOURCE_ARTIFACT_OUTCOME');return p;
}
export function assertSourceReadback(row,m,proof){
 const s=row?.signup;requireTransition(s&&s.id===proof.attemptId&&s.status==='COMPLETED'&&s.connectionId===proof.connectionId&&s.operationId===proof.operationId&&s.requestedBy===m.ownerId&&s.exchangeClaimed===true&&s.credentialStored===true&&s.registrationClaimed===true&&s.operationState==='SUCCEEDED'&&s.operationType==='PROVISION'&&s.operationLease===null&&s.signupReady===true,'SOURCE_ACTUAL_ONBOARDING');
 requireTransition(row.bindings.filter(b=>b.state==='ACTIVE'&&b.providerAccountId===m.fixture.signup.wabaId&&b.phoneId===m.fixture.signup.phoneId&&b.appId===m.fixture.signup.appId&&b.sessionOwnership==='ACTIVE'&&b.sessionState==='WORKING'&&b.proofPhone===b.phoneId&&b.proofWaba===b.providerAccountId&&b.signupAttemptId===proof.attemptId&&b.routeState==='ACTIVE').length===1&&row.connection.state==='WORKING','SOURCE_CURRENT_BINDING');return s;
}

export function transitionProbeMode(m,cfg,installed){
 if(!m.p09)return 'ORIGINAL';
 requireTransition(installed&&cfg.transitionFixture&&sha(JSON.stringify(installed))===m.p09.fixtureSha256&&JSON.stringify(installed)===JSON.stringify(cfg.transitionFixture)&&typeof installed.renewalToken==='string'&&installed.renewalToken.length>=16&&installed.renewalToken!==cfg.token,'PINNED_TRANSITION_PROBE');return 'TRANSITION_RENEWED';
}

export function assertStageAttempts(provider,stages,original=[]){
 requireTransition(Array.isArray(provider?.attempts)&&provider.attempts.length===stages.length&&provider.attempts.every((a,i)=>a.stage===stages[i]&&a.sequence===i+1&&a.accepted===true&&hex(a.bodySha256)&&Number.isFinite(a.acceptedAt)&&a.acceptedAt>0),'EXACT_ORIGINAL_POSTS');
 requireTransition(original.length<=stages.length&&isDeepStrictEqual(provider.attempts.slice(0,original.length),original),'ORIGINAL_POST_HISTORY');return structuredClone(provider.attempts);
}
