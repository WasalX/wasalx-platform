// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// Finite installed synthetic migration observations; this does not grant eligibility.
import {isDeepStrictEqual} from 'node:util';
import {need,sha,hex,uuid,validateTemplateManifest} from './meta-template-dev-contract.mjs';
export {need,sha,hex,uuid};
export const legacyCases=['full','create-loss','register-loss','select-loss','cancel-loss','disconnect','malformed','rejected','signed-template','signed-identity','read-only','activation-ready','activation-held','continuation','privacy-known','privacy-unknown','sidecar-loss'];
export const legacyHasSuccessor=name=>name.startsWith('activation-')||name==='continuation';
export const legacyMode=name=>({disconnect:'DISCONNECT','privacy-unknown':'DISCONNECT',malformed:'MALFORMED',rejected:'REJECT'}[name]??'ACCEPT');
export function validateLegacyManifest(m){
 validateTemplateManifest(m);const p=m.p05b,l=m.p05bLegacy;
 need(m.mode==='happy'&&l?.namespace==='p05b2-'+m.runId&&legacyCases.includes(l.case),'LEGACY_CASE');
 need(p.case===(l.case==='read-only'?'read-only':'full')&&p.role===(l.case==='read-only'?'auditor':'tenant_owner'),'LEGACY_ROLE');
 need(l.case==='full'||p.locale==='en'&&p.width===1440,'LEGACY_FINITE_CONTEXT');
 need(uuid(l.templatePlanId)&&uuid(l.templateObservationOperationId)&&uuid(l.sourceBindingId)&&uuid(l.sourceSessionId)&&uuid(l.sourceAccountId)&&uuid(l.targetAccountId)&&l.sourceAccountId!==l.targetAccountId,'LEGACY_LOCAL_SCOPE');
 need([l.fixtureSha256,l.backendSourceSha256,l.backendReviewSha256,l.uiSourceSha256,l.uiReviewSha256,l.interfaceSha256,l.authorizationInterfaceSha256,l.setupReceiptSha256,l.catalogSha256,l.guestSha256,l.browserSha256,l.contractSha256].every(hex),'LEGACY_INPUTS');
 need(l.interfaceSha256==='db07332e1854ab1d0b38ad2da4a9041c96f0bf757c5f1de5be68b3c58611d6df','LEGACY_INTERFACE');
 need(l.authorizationInterfaceSha256==='76650cf0269d559b6772b562effe13ac15d413a73534e6e20dcd501936edae9b','LEGACY_AUTHORIZATION_INTERFACE');
 need(l.targetAccountId===p.runtime.accountId,'LEGACY_RUNTIME_ACCOUNT');
 need(uuid(l.foreignScope?.planId)&&uuid(l.foreignScope.tenantId)&&l.foreignScope.tenantId!==m.tenantId&&hex(l.foreignScope.setupReceiptSha256),'LEGACY_FOREIGN_SCOPE');
 if(legacyHasSuccessor(l.case))need(uuid(l.planId)&&uuid(l.successorBindingId)&&uuid(l.successorSessionId)&&hex(l.completionReceiptSha256)&&hex(l.activationPrerequisiteReceiptSha256),'LEGACY_ACTIVATION_SCOPE');
 else need(l.planId===undefined&&l.successorBindingId===undefined&&l.successorSessionId===undefined,'LEGACY_FRESH_SCOPE');
 if(l.case==='activation-held')need(['PRIVACY_HOLD','LIFECYCLE_HOLD','ROUTING_REVIEW_REQUIRED','CONTROL_UNRESOLVED','FUNDING_REQUIRED','CREDENTIAL_REQUIRED'].includes(l.expectedActivationReason),'LEGACY_ACTIVATION_HOLD');
 if(l.case==='sidecar-loss'){
  const s=l.sidecar;need(s&&uuid(s.claimId)&&hex(s.container?.id)&&/^sha256:[a-f0-9]{64}$/u.test(s.container.image)&&hex(s.runtimeSha256)&&s.sourceSha256==='656ee01b7ecf3bbb31ed8306d2e6f6772c871d045cb4820903ac585a9521831c'&&s.protocolSha256==="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",'LEGACY_SIDECAR_BINDING');
  need(typeof s.directory==='string'&&s.directory.startsWith('/run/wasalx-')&&typeof s.hostDirectory==='string'&&s.hostDirectory.startsWith(m.fixture.privateDir+'/')&&!s.directory.includes('..')&&!s.hostDirectory.includes('..'),'LEGACY_SIDECAR_PRIVATE_MOUNT');
 }
 if(l.case.startsWith('privacy-'))need(hex(l.deletionManifestSha256)&&hex(l.disposableTenantReceiptSha256),'LEGACY_PRIVACY_CONTEXT');
 if(l.case==='continuation'){
  const c=l.continuation;
  need(c&&hex(c.routingReviewReceiptSha256)&&hex(c.assignmentReceiptSha256)&&c.messageId==='wamid.synthetic.'+l.namespace+'.new','LEGACY_CONTINUATION_BINDING');
  need(typeof c.recipient==='string'&&/^[0-9]{7,15}$/u.test(c.recipient)&&typeof c.text==='string'&&c.text==='Synthetic legacy continuation '+m.runId,'LEGACY_CONTINUATION_PEER');
  need(typeof c.templateName==='string'&&/^[a-z][a-z0-9_]{0,511}$/u.test(c.templateName)&&typeof c.languageCode==='string'&&/^[a-z]{2,3}(?:_[A-Z]{2})?$/u.test(c.languageCode)&&Array.isArray(c.bodyParameters)&&c.bodyParameters.length>=1&&c.bodyParameters.length<=10&&c.bodyParameters.every(v=>typeof v==='string'&&v===v.trim()&&v.length>0&&v.length<500&&!/[{}]/u.test(v)),'LEGACY_CONTINUATION_TEMPLATE');
  need(c.runtime?.mode==='SIMULATED'&&c.runtime.graphOrigin==='https://graph.facebook.com'&&c.runtime.graphVersion==='v24.0'&&hex(c.runtime.simulationBindingSha256)&&Number.isSafeInteger(c.configurationVersion)&&c.configurationVersion>0&&Number.isSafeInteger(c.reviewVersion)&&c.reviewVersion>0,'LEGACY_CONTINUATION_ROUTING');
 }
 return m;
}
export function assertLegacyOriginal(row,{count=1,outcome}={}){
 need(row.provider?.evidenceClass==='simulated-provider-legacy-migration'&&row.provider.claim==='SYNTHETIC_LEGACY_SAME_PHONE'&&row.provider.attempts.length===count,'LEGACY_PROVIDER_COUNT');
 need(row.checkpoints.length===count&&row.checkpoints.every(c=>c.stage==='LEGACY_REGISTER'&&uuid(c.original_operation_id)&&hex(c.request_sha256)),'LEGACY_ORIGINAL_SLOT');
 if(outcome)need(row.checkpoints[0]?.outcome===outcome,'LEGACY_ORIGINAL_OUTCOME');return row;
}
export function assertLegacyPreserved(before,after){
 need(before.effects&&after.effects&&isDeepStrictEqual(before.effects,after.effects),'LEGACY_UNEXPECTED_SEND_UPLOAD_EFFECT');
 need(isDeepStrictEqual(before.history,after.history),'LEGACY_HISTORY_CHANGED');
 need(isDeepStrictEqual(before.template.flows.map(({id,definitionSha256})=>({id,definitionSha256})),after.template.flows.map(({id,definitionSha256})=>({id,definitionSha256}))),'LEGACY_FLOW_BYTES_CHANGED');
 for(const old of before.template.operations.filter(o=>o.observationOperationId))need(after.template.operations.some(o=>isDeepStrictEqual(o,old)),'LEGACY_TEMPLATE_RECEIPT_CHANGED');
 need(isDeepStrictEqual(before.template.checkpoints,after.template.checkpoints),'LEGACY_COPY_SLOT_CHANGED');
}
export function assertLegacySuccessor(row,m){
 const l=m.p05bLegacy,p=m.p05b;assertLegacyOriginal(row,{outcome:'SUCCEEDED'});
 need(row.plan?.transition_kind==='LEGACY_PHONE'&&row.plan.legacy_state==='RECONCILED_PAUSED'&&row.plan.execution_state==='RECONCILED_PAUSED'&&row.plan.identity_claim==='SAME_GRAPH_PHONE_LEGACY_SUCCESSOR','LEGACY_TYPED_SUCCESSOR');
 const old=row.bindings.find(b=>b.id===l.sourceBindingId),current=row.bindings.filter(b=>b.state!=='RETIRED'&&b.connection_id===p.sourceConnectionId);
 need(old?.state==='RETIRED'&&old.provider_session_id===l.sourceSessionId&&current.length===1,'LEGACY_BINDING_LINEAGE');
 const next=current[0];need(next.state==='HELD'&&next.account_id===l.targetAccountId&&next.predecessor_binding_id===old.id&&next.account_transition_id===row.plan.id&&next.template_mapping_operation_id===row.plan.legacy_readback_operation_id&&next.phone_number_id===old.phone_number_id&&next.provider_session_id!==old.provider_session_id,'LEGACY_EXACT_SUCCESSOR');
 need(row.sessions.some(s=>s.id===old.provider_session_id&&s.ownership_state==='RETIRED')&&row.sessions.some(s=>s.id===next.provider_session_id&&s.ownership_state==='ACTIVE'&&s.state==='PAUSED'),'LEGACY_PAUSED_SESSION');
 need(row.connection.state==='PAUSED'&&row.reservations.length===2&&row.reservations.every(r=>r.released_at!==null&&r.release_reason==='VERIFIED_SUCCESSOR'),'LEGACY_PAUSED_RELEASE');
 const result=row.operations.find(o=>o.id===row.plan.legacy_readback_operation_id);need(result?.state==='SUCCEEDED'&&result.identityStatus==='SETTLED'&&result.targetAssetCount===1&&result.authorizationOperationId===row.plan.legacy_authorization_operation_id,'LEGACY_COMMITTED_RESULT');
 return next;
}
export function assertLegacyIntent(original,view){
 const a=view?.pendingAction;need(a&&uuid(a.operationId)&&a.requestKey===original.key&&a.action===original.action&&a.requestRevision===original.body.expectedRevision,'LEGACY_INTENT_CORRELATION');return a;
}

// Privacy reads retain exact original operation IDs before any redaction. A later
// payload predicate alone would silently lose the rows this oracle must inspect.
export function assertLegacyPrivacy(before,after,{unknown=false}={}){
 need(isDeepStrictEqual(before.checkpoints,after.checkpoints)&&isDeepStrictEqual(before.provider.attempts,after.provider.attempts)&&isDeepStrictEqual(before.effects,after.effects),'LEGACY_PRIVACY_EFFECT_BARRIER');
 need(before.privacyEvidence.operations.length>0&&before.privacyEvidence.operations.some(o=>o.kind==='authorization')&&before.privacyEvidence.operations.some(o=>o.kind==='legacy'),'LEGACY_PRIVACY_ORIGINALS');
 const jobs=after.template.privacy;need(jobs.length===before.template.privacy.length+1,'LEGACY_ONE_PRIVACY_JOB');
 if(unknown){
  need(jobs.some(j=>['FAILED_TERMINAL','FAILED_RETRYABLE','BLOCKED_LEGAL_HOLD'].includes(j.state)&&j.errorCode)&&!jobs.some(j=>j.state==='SUCCEEDED'),'LEGACY_PRIVACY_UNKNOWN_BLOCKED');
  need(isDeepStrictEqual(before.privacyEvidence,after.privacyEvidence),'LEGACY_PRIVACY_UNKNOWN_RETAINED');return;
 }
 need(jobs.some(j=>j.stage==='LOCAL'||j.stage==='COMPLETE'||j.state==='SUCCEEDED'),'LEGACY_PRIVACY_LOCAL_REACHED');
 for(const old of before.privacyEvidence.operations){
  const next=after.privacyEvidence.operations.find(o=>o.id===old.id);
  need(next&&['state','key','actorType','actorId'].every(k=>next[k]===old[k]),'LEGACY_PRIVACY_AUDIT_IDENTITY');
  if(old.kind==='legacy')need(next.payloadRedacted===true&&next.payloadRetainedSha256===old.payloadSha256&&
   (old.resultWasNull?next.resultWasNull:next.resultRedacted===true&&next.resultRetainedSha256===old.resultSha256),'LEGACY_PRIVACY_ALL_LEGACY_CONTENT');
  else need(next.payloadSha256===old.payloadSha256&&next.authRedacted===true&&next.authRetainedSha256===old.authSha256,'LEGACY_PRIVACY_AUTHORIZATION_PROOF');
 }
 need(after.privacyEvidence.scopeRedacted===true&&after.privacyEvidence.scopeRetainedSha256===before.privacyEvidence.scopeSha256,'LEGACY_PRIVACY_EXECUTION_SCOPE');
}
export function legacyExpectedBody(m){const c=m.p05bLegacy.continuation;return{messaging_product:'whatsapp',recipient_type:'individual',to:c.recipient,type:'template',template:{name:c.templateName,language:{code:c.languageCode},components:[{type:'body',parameters:c.bodyParameters.map(text=>({type:'text',text}))}]}};}
export function assertLegacyContinuation(before,after,m,inbound){
 const l=m.p05bLegacy,d=after.continuation.delivery;
 need(d&&d.state==='SENT'&&Number(d.attempts)===1&&d.lease_id===null&&uuid(d.id)&&d.external_message_id,'LEGACY_CONTINUATION_DELIVERY');
 const a=d.meta_template_admission;
 need(a?.claim==='CURRENT_INHERITED_TEMPLATE'&&a.bindingId===l.successorBindingId&&a.transitionId===l.planId&&a.mappingOperationId===before.plan.legacy_readback_operation_id&&a.deliveryId===d.id&&a.attemptId===d.attempt_id&&a.attemptNumber===1&&hex(a.inventoryResponseSha256)&&hex(a.contextSha256)&&hex(a.semanticSha256)&&a.requestSha256===sha(JSON.stringify(legacyExpectedBody(m))),'LEGACY_FRESH_TEMPLATE_ADMISSION');
 need(Date.parse(a.observedAt)>=inbound.timestamp*1000&&after.continuation.templateReads.some(r=>r.account===after.provider.targetAccountId&&r.at>=inbound.timestamp*1000),'LEGACY_FRESH_TARGET_INVENTORY');
 need(after.continuation.receipts.length===1&&after.continuation.receipts[0].id===d.external_message_id&&after.continuation.receipts[0].bodySha256===a.requestSha256&&after.effects.receiptCount===before.effects.receiptCount+1&&after.effects.mediaCount===before.effects.mediaCount,'LEGACY_REAL_TEMPLATE_RECEIPT');
 need(after.continuation.handoff?.state==='SUCCEEDED'&&after.continuation.handoff.flow_version_id===m.p05b.flows[0].id,'LEGACY_INHERITED_HANDOFF');
 need(isDeepStrictEqual(before.checkpoints,after.checkpoints)&&isDeepStrictEqual(before.provider.attempts,after.provider.attempts)&&isDeepStrictEqual(before.template.checkpoints,after.template.checkpoints),'LEGACY_CONTINUATION_NO_COPY_REGISTER_REPLAY');
 need(isDeepStrictEqual(before.template.flows,after.template.flows),'LEGACY_CONTINUATION_IMMUTABLE_FLOWS');
 for(const [table,rows] of Object.entries(before.historyMembers))for(const old of rows)need(after.historyMembers[table].some(row=>row.id===old.id&&row.sha256===old.sha256),'LEGACY_CONTINUATION_PRIOR_HISTORY');
 need(after.connection.state==='WORKING'&&after.bindings.some(b=>b.id===l.successorBindingId&&b.state==='ACTIVE'),'LEGACY_CONTINUATION_CURRENT_TARGET');
 return {deliveryId:d.id,attemptId:d.attempt_id,templateReadSha256:a.inventoryResponseSha256,templateAdmissionSha256:sha(JSON.stringify(a)),providerMessageId:d.external_message_id};
}
