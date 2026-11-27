import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {createMetaCostScenario,createMetaCostPrivacyJob,linkMetaCostReference} from './meta-cost-scenarios-postgres.mjs';
import {metaCostStatementCsv} from '../services/control-api/dist/meta-cost.controller.js';
import {MetaCostSourceRepository,MetaCostSourceService} from '../services/connector-worker/dist/services/connector-worker/src/meta-cost-source.js';
import {MediaRuntimeError} from '../services/connector-worker/dist/services/connector-worker/src/media-runtime.js';
import {PrivacyRepository,PrivacyLegalHoldError} from '../services/connector-worker/dist/services/connector-worker/src/privacy-repository.js';
import {PrivacyProcessor} from '../services/connector-worker/dist/services/connector-worker/src/privacy-processor.js';
import {PrivacyController} from '../services/control-api/dist/privacy.controller.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const decimal=value=>String(value).replace(/(\.\d*?)0+$/u,'$1').replace(/\.$/u,'');
const dbCode=(...codes)=>error=>codes.includes(error.code);

/** Real authenticated PostgreSQL roles/domain functions. Scanner and object
 * transport below are explicit deterministic doubles, so this helper cannot
 * qualify installed scanning/storage, original authenticity or live billing. */
export async function createMetaStatementScenario(options){
 const f=await createMetaCostScenario(options),objects=new Map(),puts=[],deletes=[];
 try{
  const action=async(name,id,body,key=randomUUID())=>f.tx(f.platform,f.tenantId,async client=>(await client.query(
   'SELECT app.operator_meta_statement($1,$2,$3,$4,$5,$6,$7) value',[name,f.tenantId,id,body,key,'synthetic-mfa-operator','statement-postgres'])).rows[0].value);
  const read=async id=>f.tx(f.platform,f.tenantId,async client=>(await client.query(
   'SELECT app.operator_meta_statement_read($1,NULL,$2,NULL,NULL,$3,$4) value',[f.tenantId,id,'synthetic-mfa-operator','statement-read'])).rows[0].value);
  const policy=(await f.tx(f.app,f.tenantId,client=>client.query('SELECT version FROM retention_policies WHERE tenant_id=$1',[f.tenantId]))).rows[0];
  await action('META_FINANCE_RETENTION',null,{expectedVersion:Number(policy.version),sourceDays:1,recordDays:2,basisSha256:sha('Synthetic approved retention software fixture'),
   policyVersionId:f.accepted.policyVersionId,commercialTermsVersionId:f.commercialTermsVersionId});
  const scope={schemaVersion:1,accountId:f.accountId,policyVersionId:f.accepted.policyVersionId,commercialTermsVersionId:f.commercialTermsVersionId,
   periodFrom:f.from,periodTo:f.to,timezone:'UTC',currency:'USD',minorUnits:2};
  const storage={put:async(key,bytes)=>{puts.push(key);objects.set(key,Uint8Array.from(bytes));},get:async key=>{assert(objects.has(key),'Original must exist');return Uint8Array.from(objects.get(key));},
   delete:async key=>{deletes.push(key);objects.delete(key);}};
  const scanner={scan:async()=>({state:'CLEAN',engine:'explicit-pg-test-double'})};
  const sourceRepository=new MetaCostSourceRepository(f.worker),sourceService=new MetaCostSourceService(sourceRepository,scanner,storage),privacy=new PrivacyRepository(f.worker);
  const reserve=async({source={},lines=[],scopeChanges={},body:originalBody}={})=>{
   const documentId=randomUUID(),bytes=Buffer.from(originalBody??JSON.stringify({synthetic:true,documentId,subject:'synthetic-subject-may-be-present'}));
   const input={...scope,...scopeChanges,basisKind:'UPSTREAM_SOURCE',source:{issuerKind:'META',issuerAuthorityVersionId:null,documentId,documentRevision:'1',
    sourceScopeLocator:'Supported messaging subtotal',originalSha256:sha(bytes),originalByteSize:bytes.byteLength,originalMime:'application/json',sourceIssuedAt:new Date().toISOString(),
    sourceKind:'FULL_REPLACEMENT',priorStatementVersionId:null,sourceAccountIdentifierKind:'MESSAGING_ACCOUNT_ID',sourceAccountIdentifier:f.providerAccountId,
    coverage:'ACCOUNT_PERIOD',sourceTotal:'1.01',sourceQuantity:null,grossOriginalTotal:null,excludedOriginalAmount:null,supportedSubtotalLocator:null,...source},lines};
   const result=await action('META_STATEMENT_RESERVE',null,input);return{...result,input,bytes};
  };
  const upload=source=>sourceService.upload(f.tenantId,source.id,source.bytes,source.input.source.originalMime);
  const review=async(id,{priorAdjustments=[],subjectCoverage='UNKNOWN',subjectRefs=[]}={})=>{
   const source=await read(id);return action('META_STATEMENT_REVIEW',id,{expectedVersion:Number(source.version),expectedInputSha256:source.inputSha256,
    expectedCurrentHeadId:source.currentHeadId,originalSha256:source.originalSha256,priorAdjustments,subjectCoverage,subjectRefs,reviewSha256:sha('Synthetic source review '+id)});
  };
  const preview=async id=>{const source=await read(id);return action('META_STATEMENT_PREVIEW',id,{expectedVersion:Number(source.version),expectedVerificationSha256:source.verificationSha256});};
  const publishBody=source=>({expectedVersion:Number(source.version),expectedInputSha256:source.inputSha256,expectedVerificationSha256:source.verificationSha256,
   expectedPreviewSha256:source.previewSha256,expectedCurrentHeadId:source.currentHeadId});
  const publish=async(id,key=randomUUID())=>action('META_STATEMENT_PUBLISH',id,publishBody(await read(id)),key);
  const finish=async(source,reviewOptions)=>{await upload(source);await review(source.id,reviewOptions);await preview(source.id);await publish(source.id);return read(source.id);};
  const derived=async(upstreamIds)=>action('META_STATEMENT_RESERVE',null,{...scope,basisKind:'CUSTOMER_TARIFF_DERIVATION',tariffVersionId:f.customerDraft.id,upstreamStatementVersionIds:upstreamIds});
  const createPrivacyJob=(scopeType,scopeValue,jobType='DELETE')=>createMetaCostPrivacyJob(f,scopeType,scopeValue,jobType);
  const privacyReview=async(id,job,outcome)=>{
   const source=await read(id),target=source.privacyReviews.find(value=>value.jobState==='RUNNING'&&value.scopeType===job.scopeType&&value.state==='PENDING');assert(target);
   return action('META_SOURCE_PRIVACY_REVIEW',id,{expectedVersion:Number(source.version),expectedBindingSha256:target.bindingSha256,
    expectedPolicyVersion:Number(target.policyVersion),targetId:target.targetId,outcome,reviewSha256:sha('Synthetic exact privacy review '+job.id)});
  };
  return{...f,action,read,scope,objects,puts,deletes,storage,scanner,sourceRepository,sourceService,privacy,reserve,upload,review,preview,publish,publishBody,finish,derived,createPrivacyJob,privacyReview};
 }catch(error){await f.close();throw error;}
}

export async function verifyMetaStatementLineage(options){
 const f=await createMetaStatementScenario(options);
 try{
  await f.deliver();const original=await f.reserve(),first=await f.finish(original);
  assert.equal(first.evidenceMode,'SIMULATED');assert.equal(decimal(first.publication.amount),'1.01');assert.equal(first.publication.quantity,null);
  assert.equal(first.publication.coverage,'ACCOUNT_PERIOD_SOURCE_CONFIRMED');assert.equal(decimal(first.publication.estimatedAmount),'0.01');assert.equal(decimal(first.publication.difference),'1');
  const credits=await Promise.all(['-0.01','-0.02'].map(sourceTotal=>f.reserve({source:{sourceKind:'CREDIT_DEBIT_ADJUSTMENT',priorStatementVersionId:first.id,sourceTotal}})));
  for(const credit of credits){await f.upload(credit);await f.review(credit.id);await f.preview(credit.id);}
  const frozen=await Promise.all(credits.map(credit=>f.read(credit.id))),raced=await Promise.allSettled(frozen.map(source=>f.action('META_STATEMENT_PUBLISH',source.id,f.publishBody(source))));
  assert.equal(raced.filter(value=>value.status==='fulfilled').length,1);assert.equal(raced.filter(value=>value.status==='rejected'&&value.reason.code==='40001').length,1);
  const loser=credits[raced.findIndex(value=>value.status==='rejected')];await f.review(loser.id);await f.preview(loser.id);await f.publish(loser.id);
  const second=await f.read(loser.id);assert.equal(decimal(second.publication.amount),'0.98');assert.equal(second.publication.adjustments.length,2);assert.equal(second.publication.quantity,null);
  const replacement=await f.reserve({source:{sourceTotal:'1.00'}});await f.upload(replacement);
  await assert.rejects(()=>f.review(replacement.id),dbCode('55000'));
  await f.review(replacement.id,{priorAdjustments:credits.map((credit,index)=>({statementVersionId:credit.id,treatment:index===0?'INCLUDED_IN_REPLACEMENT':'EXCLUDED_FROM_REPLACEMENT'}))});
  await f.preview(replacement.id);const replayKey=randomUUID(),intent=f.publishBody(await f.read(replacement.id));
  await f.action('META_STATEMENT_PUBLISH',replacement.id,intent,replayKey);
  assert.equal((await f.action('META_STATEMENT_PUBLISH',replacement.id,intent,replayKey)).duplicate,true);
  await assert.rejects(()=>f.action('META_STATEMENT_PUBLISH',replacement.id,{...intent,expectedVersion:intent.expectedVersion+1},replayKey),dbCode('23505'));
  const current=await f.read(replacement.id);assert.equal(decimal(current.publication.amount),'0.98');assert.equal(current.currentHeadId,replacement.id);
  const tenantDetail=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT app.meta_cost_statement_publication($1,$2) value',[f.tenantId,replacement.id]))).rows[0].value;
  assert.deepEqual(tenantDetail.statement.adjustments,current.publication.adjustments);assert.equal(tenantDetail.statement.estimatedAmount,current.publication.estimatedAmount);
  const summaries=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT app.meta_cost_statement_summaries($1,$2,$3,$4) value',[f.tenantId,f.accountId,f.from,f.to]))).rows[0].value;
  const csv=metaCostStatementCsv(summaries);assert(csv.includes('ADJUSTMENT'));assert(csv.includes('INCLUDED_IN_REPLACEMENT'));assert(csv.includes('EXCLUDED_FROM_REPLACEMENT'));
  for(const item of current.publication.adjustments){assert(csv.includes(item.statementVersionId));assert(csv.includes(item.amount));}
  assert(!csv.includes('selectedRows'));assert(!csv.includes('payerAuthorityVersionId'));
  const originalAgain=await f.read(original.id);assert.deepEqual(originalAgain.publication,first.publication);assert.equal(originalAgain.publicationSha256,first.publicationSha256);
  const derived=await f.derived([replacement.id]);await f.review(derived.id,{subjectCoverage:'VERIFIED_NO_SUBJECT_DATA'});await f.preview(derived.id);await f.publish(derived.id);
  const customer=await f.read(derived.id);assert.equal(customer.purpose,'CUSTOMER_CHARGE');assert.equal(decimal(customer.publication.amount),'0.01');assert.equal(customer.publication.quantity,1);
  assert.equal(customer.publication.upstreamPublications[0].statementVersionId,replacement.id);assert.equal(customer.publication.claim,'DOCUMENTARY_RECONCILIATION_NOT_PAYMENT');
  const differentCurrency=await f.reserve({scopeChanges:{currency:'SAR'},source:{sourceTotal:'12.34'}}),sar=await f.finish(differentCurrency);
  assert.equal(sar.publication.currency,'SAR');assert.equal(decimal(sar.publication.amount),'12.34');assert.equal(sar.publication.estimatedAmount,null);assert.equal(sar.publication.difference,null);
  const usd=await f.derived([sar.id]);await f.review(usd.id,{subjectCoverage:'VERIFIED_NO_SUBJECT_DATA'});await f.preview(usd.id);await f.publish(usd.id);
  const usdResult=await f.read(usd.id);assert.equal(usdResult.publication.currency,'USD');assert.equal(decimal(usdResult.publication.amount),'0.01');assert.equal(usdResult.publication.upstreamPublications[0].currency,'SAR');
  const visible=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT app.meta_cost_statement_publication($1,$2) value',[f.tenantId,derived.id]))).rows[0].value;
  for(const privateField of ['publishedBy','payerAuthorityVersionId','allocationLineVersionId','selectedRows','policyVersionId','commercialTermsVersionId','objectKey','description'])assert.equal(Object.hasOwn(visible.statement,privateField),false);
  const overlap=await f.reserve({scopeChanges:{periodTo:new Date(Date.parse(f.to)-1).toISOString()}});await f.upload(overlap);await f.review(overlap.id);await assert.rejects(()=>f.preview(overlap.id),dbCode('40001'));
  const liveOverride={...original.input,evidenceMode:'LIVE'};await assert.rejects(()=>f.action('META_STATEMENT_RESERVE',null,liveOverride),dbCode('22023'));
  return{mode:'SIMULATED',twoConcurrentDeltasOneLineage:true,replacementDecisionsPreserved:true,customerTariffDistinctFromUpstream:true,originalHistoryImmutable:true,storage:'DETERMINISTIC_TEST_DOUBLE'};
 }finally{await f.close();}
}

export async function verifyMetaStatementCorrectionFence(options){
 const f=await createMetaStatementScenario(options);
 try{
  const effect=await f.deliver(),source=await f.reserve();await f.upload(source);await f.review(source.id);await f.preview(source.id);
  const stale=await f.read(source.id);await f.reassess(effect.job.id,{...f.selector,tier:'UNAVAILABLE'});
  await assert.rejects(()=>f.action('META_STATEMENT_PUBLISH',source.id,f.publishBody(stale)),dbCode('40001'));
  await f.preview(source.id);await f.publish(source.id);const before=await f.read(source.id);
  assert.equal(before.publication.estimatedAmount,null);assert.equal(before.publication.difference,null);assert.equal(before.publication.unresolvedAssessments,1);
  await f.reassess(effect.job.id);assert.deepEqual((await f.read(source.id)).publication,before.publication);
  const next=await f.reserve();await f.upload(next);await f.review(next.id);await f.preview(next.id);const ready=await f.read(next.id);
  const writer=await f.platform.connect();let correction;
  try{
   await writer.query('BEGIN');await writer.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenantId]);
   await writer.query('SELECT app.operator_meta_statement($1,$2,$3,$4,$5,$6,$7)',[
    'META_STATEMENT_PUBLISH',f.tenantId,next.id,f.publishBody(ready),randomUUID(),'synthetic-mfa-operator','statement-lock-race']);
   const upstream=(await f.heads(effect.job.id)).find(row=>row.purpose==='UPSTREAM_REFERENCE');
   correction=f.operator('META_COST_REASSESS',f.accountId,{purpose:'UPSTREAM_REFERENCE',items:[{deliveryId:effect.job.id,expectedHeadId:upstream.id,selectorEvidence:{...f.selector,tier:'UNAVAILABLE'}}]});
   void correction.catch(()=>undefined); // Preserve rejection for await below without an unhandled-rejection race.
   // The exact incumbent cost lock must be unavailable while publication is
   // uncommitted; no timing-based assertion that a pending promise proves it.
   const blocked=await f.tx(f.platform,f.tenantId,async client=>{
    const key=[f.tenantId,f.accountId,'UPSTREAM_REFERENCE','SIMULATED'].join(':');
    return(await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('meta-cost:'||$1,0)) acquired",[key])).rows[0].acquired;
   });
   assert.equal(blocked,false);await writer.query('COMMIT');await correction;
  }catch(error){await writer.query('ROLLBACK');await correction?.catch(()=>undefined);throw error;}finally{writer.release();}
  assert.deepEqual((await f.read(next.id)).publication.selectedRows,ready.preview.selectedRows);
  return{stalePreviewRejected:true,committedPublicationFrozen:true,correctionSerializesWithPublication:true};
 }finally{await f.close();}
}

export async function verifyMetaStatementSourcePrivacy(options){
 const f=await createMetaStatementScenario(options);
 try{
  const source=await f.reserve(),uncertain=new MetaCostSourceService(f.sourceRepository,f.scanner,{...f.storage,put:async()=>{throw new Error('Synthetic lost PUT outcome');}});
  await assert.rejects(()=>uncertain.upload(f.tenantId,source.id,source.bytes,'application/json'),error=>error.code==='SOURCE_WRITE_OUTCOME_UNKNOWN');
  let observed=await f.read(source.id);assert.equal(observed.writeDisposition,'UNKNOWN');assert.equal(observed.subjectCoverage,'UNKNOWN');
  const subject='synthetic-unmapped-participant',job=await f.createPrivacyJob('PARTICIPANT',subject);
  await f.privacy.discover(job,job.lease);assert.equal(await f.privacy.hasPendingFinanceReview(job),true);
  await assert.rejects(()=>f.privacy.complete(job,job.lease,{}),dbCode('55000'));
  await assert.rejects(()=>f.privacyReview(source.id,job,'POLICY_RETAINED'),dbCode('55000'));
  assert.equal((await f.privacy.targets(job)).some(target=>target.type==='META_COST_SOURCE'),false);
  // Positive terminal PUT evidence arrives after deletion intent. Readiness
  // must stay fenced, and no DELETE may run before that exact attempt settles.
  f.objects.set(`tenants/${f.tenantId}/meta-cost-sources/${source.id}/${source.input.source.originalSha256}.bin`,source.bytes);
  const terminal={expectedVersion:Number(observed.version),originalSha256:source.input.source.originalSha256,
   writeAttemptId:observed.writeAttemptId,outcome:'WRITTEN',scanSha256:observed.scanSha256,
   terminalDispositionEvidenceSha256:sha('Synthetic positive terminal outcome for the sole admitted write '+observed.writeAttemptId)};
  await assert.rejects(()=>f.action('META_SOURCE_RECONCILE',source.id,{...terminal,writeAttemptId:randomUUID()}),dbCode('40001'));
  const terminalKey=randomUUID();await f.action('META_SOURCE_RECONCILE',source.id,terminal,terminalKey);
  assert.equal((await f.action('META_SOURCE_RECONCILE',source.id,terminal,terminalKey)).duplicate,true);
  observed=await f.read(source.id);assert.equal(observed.sourceState,'PURGE_PENDING');assert.equal(observed.writeDisposition,'WRITTEN');
  await assert.rejects(()=>f.sourceService.original(f.tenantId,source.id));
  await f.privacyReview(source.id,job,'PURGE_REQUIRED');const targets=await f.privacy.targets(job),target=targets.find(value=>value.type==='META_COST_SOURCE');assert(target);
  await assert.rejects(()=>f.tx(f.worker,f.tenantId,c=>c.query('SELECT * FROM public.meta_cost_statement_versions WHERE tenant_id=$1',[f.tenantId])),dbCode('42501'),'Leased source cleanup grants no direct finance-table read');
  for(const pool of [f.app,f.worker]){
   const immutable=pool===f.worker?dbCode('23514'):dbCode('23514','42501'),unfinished=pool===f.worker?dbCode('55000'):dbCode('55000','42501');
   await assert.rejects(()=>f.tx(pool,f.tenantId,c=>c.query("UPDATE privacy_job_targets SET target_type='DELIVERY' WHERE tenant_id=$1 AND id=$2",[f.tenantId,target.id])),immutable);
   await assert.rejects(()=>f.tx(pool,f.tenantId,c=>c.query('DELETE FROM privacy_job_targets WHERE tenant_id=$1 AND id=$2',[f.tenantId,target.id])),immutable);
   await assert.rejects(()=>f.tx(pool,f.tenantId,c=>c.query("UPDATE privacy_job_targets SET state='COMPLETE',completed_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[f.tenantId,target.id])),unfinished);
  }
  await f.privacy.beginTargetExternal(job,job.lease,target);await f.storage.delete(target.objectKey);await f.privacy.markTargetExternal(job,job.lease,target);
  const summary=await f.privacy.finalize(job,job.lease);assert.equal(summary.metaCostSourcesPurged,1);assert.equal(summary.metaCostRecordsRetained,1);assert.equal(f.deletes.length,1);
  assert.equal((await f.read(source.id)).sourceState,'PURGED');assert.equal(await f.privacy.complete(job,job.lease,summary),true);
  await assert.rejects(()=>f.sourceRepository.settle(f.tenantId,source.id,observed.writeAttemptId,'NOT_WRITTEN',observed.scanSha256),dbCode('40001'));
  return{unmappedOriginalBlocksSubjectCompletion:true,unknownPutBlocksDelete:true,terminalPutDoesNotRestoreReady:true,exactDeleteThenRetainedRecord:true};
 }finally{await f.close();}
}

export async function verifyMetaStatementScopedArtifact(options){
 const f=await createMetaStatementScenario(options);
 try{
  const source=await f.reserve();await f.finish(source);
  for(const scopeType of ['PARTICIPANT','TENANT']){
   const job=await f.createPrivacyJob(scopeType,scopeType==='TENANT'?f.tenantId:'synthetic-unmapped-subject','EXPORT');
   const selected=await f.privacy.exportData(job,job.lease);assert.equal(selected.metaCostStatements.length,scopeType==='TENANT'?1:0);
   assert.equal(selected.metaCostSourceReviewStatus[0].unknownSubjectCoverage,1);
   let artifact;const processor=new PrivacyProcessor(f.privacy,{resolve:async()=>({token:'synthetic-unused-no-ticket-token'})},
    {put:async(key,bytes)=>{artifact={key,bytes:Uint8Array.from(bytes)};},delete:async()=>assert.fail('Export cannot delete objects')});
   const summary=await processor.process(job,job.lease);assert.notEqual(summary,'deferred');assert(artifact);
   const document=JSON.parse(new TextDecoder().decode(artifact.bytes));assert.deepEqual(document.local.metaCostStatements,JSON.parse(JSON.stringify(selected.metaCostStatements)));
   assert.deepEqual(document.local.metaCostSourceReviewStatus,selected.metaCostSourceReviewStatus);assert.equal(summary.metaCostStatements,selected.metaCostStatements.length);
   assert.equal(summary.metaCostSourceReviewStatus,1);assert(!JSON.stringify(summary).includes(source.id));
   const serialized=JSON.stringify(document.local.metaCostStatements);assert(!serialized.includes('objectKey'));assert(!serialized.includes('synthetic-subject-may-be-present'));
   if(scopeType!=='TENANT')assert(!serialized.includes(f.accountId));assert.equal(await f.privacy.complete(job,job.lease,summary),true);
  }
  return{actualScopedRepositoryToProcessorArtifact:true,unknownOriginalCountOnly:true,tenantAggregateOnly:true};
 }finally{await f.close();}
}

export async function verifyMetaStatementSelectedSubjects(options){
 const f=await createMetaStatementScenario(options);let foreign;const previousFetch=globalThis.fetch;
 try{
  const participant='12025550166@c.us',reference='P10-STATEMENT-730041',ticket='730041';
  const effect=await f.deliver({mentions:[participant]});await linkMetaCostReference(f,effect,ticket,reference);
  assert.deepEqual((await f.tx(f.app,f.tenantId,c=>c.query('SELECT zammad_ticket_id FROM public.delivery_ticket_links WHERE tenant_id=$1 AND delivery_id=$2',[f.tenantId,effect.job.id]))).rows,[{zammad_ticket_id:ticket}]);
  const original=await f.reserve();const published=await f.finish(original,{subjectCoverage:'VERIFIED_NO_SUBJECT_DATA'});
  const derived=await f.derived([original.id]);await f.review(derived.id,{subjectCoverage:'VERIFIED_NO_SUBJECT_DATA'});await f.preview(derived.id);await f.publish(derived.id);
  const previewOnly=await f.reserve();await f.upload(previewOnly);await f.review(previewOnly.id,{subjectCoverage:'VERIFIED_NO_SUBJECT_DATA'});await f.preview(previewOnly.id);
  const unrelated=await f.reserve({scopeChanges:{periodFrom:f.to,periodTo:new Date(Date.parse(f.to)+86400_000).toISOString()}});
  await f.upload(unrelated);await f.review(unrelated.id,{subjectCoverage:'VERIFIED_NO_SUBJECT_DATA'});await f.preview(unrelated.id);
  foreign=await createMetaStatementScenario(options);const foreignSource=await foreign.reserve();await foreign.finish(foreignSource,{subjectCoverage:'VERIFIED_NO_SUBJECT_DATA'});
  const subjects=[['PARTICIPANT',participant],['ZAMMAD_TICKET',ticket],['REFERENCE',reference]];
  const subjectRefs=subjects.map(([scopeType,value])=>({scopeType,scopeSha256:sha(Buffer.concat([Buffer.from(scopeType),Buffer.from([0]),Buffer.from(value)]))}));
  const sourceOnly=await f.reserve({scopeChanges:{periodFrom:f.to,periodTo:new Date(Date.parse(f.to)+86400_000).toISOString()}});
  await f.upload(sourceOnly);await f.review(sourceOnly.id,{subjectCoverage:'VERIFIED_COMPLETE_SUBJECT_MAPPING',subjectRefs});await f.preview(sourceOnly.id);
  assert.equal((await f.read(sourceOnly.id)).preview.selectedRows.length,0);
  const combined=await f.reserve();await f.upload(combined);await f.review(combined.id,{subjectCoverage:'VERIFIED_COMPLETE_SUBJECT_MAPPING',subjectRefs});await f.preview(combined.id);
  assert((await f.read(combined.id)).preview.selectedRows.length>0);
  const recordIds=[original.id,derived.id,previewOnly.id,combined.id].sort();
  const expectedIds=[...recordIds,sourceOnly.id].sort();
  let activePrivacyJob;
  globalThis.fetch=async(raw,init)=>{
   assert(activePrivacyJob);assert.equal(String(raw),'https://privacy.invalid/api/v1/wasalx/privacy');assert.equal(init.method,'POST');
   const body=JSON.parse(init.body),job=activePrivacyJob;assert.equal(body.native_id,ticket);
   if(body.operation==='DELETE_TICKET'){
    const target=(await f.privacy.targets(job)).find(row=>row.type==='ZAMMAD_TICKET'&&row.targetId===ticket);assert(target);
    assert.deepEqual(body,{job_id:job.id,lease_id:job.lease,fencing_token:job.fencingToken,target_id:target.id,attempt:target.attempts,operation:'DELETE_TICKET',native_id:ticket});
    assert.equal(target.attempts,1);return new Response(null,{status:204});
   }
   assert(['READ_TICKET','READ_ARTICLES'].includes(body.operation));
   assert.deepEqual(body,{job_id:job.id,lease_id:job.lease,fencing_token:job.fencingToken,attempt:0,operation:body.operation,native_id:ticket});
   return body.operation==='READ_TICKET'?Response.json({id:Number(ticket),title:'Synthetic scoped statement ticket'}):Response.json([]);
  };
  const exportScope=async(scopeType,scopeValue,postRedaction=false)=>{
   const job=await f.createPrivacyJob(scopeType,scopeValue,'EXPORT');const selected=await f.privacy.exportData(job,job.lease);
   assert.deepEqual(selected.metaCostStatements.map(row=>row.id).sort(),expectedIds);
   let bytes;const processor=new PrivacyProcessor(f.privacy,{resolve:async()=>({token:'synthetic-statement-privacy-token'})},{put:async(_key,value)=>{bytes=Uint8Array.from(value);},delete:async()=>assert.fail('Export cannot delete')});
   activePrivacyJob=job;const summary=await processor.process(job,job.lease);assert.notEqual(summary,'deferred');assert(bytes);
   const local=JSON.parse(new TextDecoder().decode(bytes)).local;assert.deepEqual(local.metaCostStatements,JSON.parse(JSON.stringify(selected.metaCostStatements)));
   const text=JSON.stringify(local.metaCostStatements);for(const forbidden of [f.accountId,effect.job.id,foreignSource.id,unrelated.id,'selectedRows','objectKey','synthetic-subject-may-be-present'])assert(!text.includes(forbidden));
   assert(local.metaCostStatements.every(row=>row.amount===null&&row.currency===null&&row.accountId===null));
   if(postRedaction)assert.equal(local.metaCostAssessments.length,0,'Only retained financial record metadata survives; no subject effect projection is restored');
   assert.equal(await f.privacy.complete(job,job.lease,summary),true);
  };
  for(const [scopeType,scopeValue] of subjects)await exportScope(scopeType,scopeValue);
  const discoverDeletion=async job=>{
   await f.privacy.discover(job,job.lease);
   const row=(await f.tx(f.worker,f.tenantId,client=>client.query(
    'SELECT stage FROM public.privacy_jobs WHERE tenant_id=$1 AND id=$2',[f.tenantId,job.id]))).rows[0];
   assert.equal(row?.stage,'EXTERNAL');job.stage=row.stage;
  };
  const deletion=await f.createPrivacyJob('PARTICIPANT',participant);await discoverDeletion(deletion);
  for(const id of expectedIds)assert.equal((await f.read(id)).privacyReviews.filter(row=>row.scopeType==='PARTICIPANT'&&row.jobState==='RUNNING').length,1);
  for(const id of expectedIds){
   if(recordIds.includes(id))await assert.rejects(()=>f.privacyReview(id,deletion,'NO_SUBJECT_MATCH'),dbCode('22023'));
   await f.privacyReview(id,deletion,'POLICY_RETAINED');
  }
  const processor=new PrivacyProcessor(f.privacy,{resolve:async()=>({token:'synthetic-statement-privacy-token'})},f.storage);
  activePrivacyJob=deletion;const summary=await processor.process(deletion,deletion.lease);assert.notEqual(summary,'deferred');assert.equal(await f.privacy.complete(deletion,deletion.lease,summary),true);
  assert.equal((await f.read(original.id)).publicationSha256,published.publicationSha256);
  assert((await f.heads(effect.job.id)).every(row=>row.evidence_redacted_at!==null));
  await exportScope('PARTICIPANT',participant,true);await f.emit(effect.external);await f.drain();await exportScope('PARTICIPANT',participant,true);
  // The second request has no live identity to rediscover. Its durable exact
  // tenant/source/scope match must still prevent an original-file denial.
  const repeated=await f.createPrivacyJob('PARTICIPANT',participant);await discoverDeletion(repeated);
  assert.equal(await f.privacy.hasPendingFinanceReview(repeated),true);
  for(const id of recordIds){
   await assert.rejects(()=>f.privacyReview(id,repeated,'NO_SUBJECT_MATCH'),dbCode('22023'));
   await f.privacyReview(id,repeated,'POLICY_RETAINED');
  }
  for(const id of expectedIds.filter(id=>!recordIds.includes(id)))await f.privacyReview(id,repeated,'POLICY_RETAINED');
  activePrivacyJob=repeated;const repeatedSummary=await processor.process(repeated,repeated.lease);assert.notEqual(repeatedSummary,'deferred');
  assert.equal(await f.privacy.complete(repeated,repeated.lease,repeatedSummary),true);
  await exportScope('PARTICIPANT',participant,true);
  assert.equal((await f.read(original.id)).publicationSha256,published.publicationSha256);
  // Finish negative-scope exports through the real artifact/completion path;
  // the ordinary privacy claim permits only one live lease per tenant.
  const completeEmptyExport=async(repository,job)=>{
   assert.deepEqual((await repository.exportData(job,job.lease)).ticketIds,[],'Unrelated scope has no native ticket');
   let artifact;const processor=new PrivacyProcessor(repository,{resolve:async reference=>{assert.equal(reference,job.zammadPrivacySecretReference);return{token:'synthetic-statement-privacy-token'};}},
    {put:async(_key,value)=>{artifact=Uint8Array.from(value);},delete:async()=>assert.fail('Export cannot delete')});
   const summary=await processor.process(job,job.lease);assert.notEqual(summary,'deferred');assert(artifact);
   assert.deepEqual(JSON.parse(new TextDecoder().decode(artifact)).local.metaCostStatements,[]);
   assert.equal(await repository.complete(job,job.lease,summary),true);
  };
  // Same raw value in another scope is not the same hashed relationship.
  const differentScope=await f.createPrivacyJob('REFERENCE',participant,'EXPORT');
  assert.deepEqual((await f.privacy.exportData(differentScope,differentScope.lease)).metaCostStatements,[]);
  await completeEmptyExport(f.privacy,differentScope);
  const foreignScope=await foreign.createPrivacyJob('PARTICIPANT',participant,'EXPORT');
  assert.deepEqual((await foreign.privacy.exportData(foreignScope,foreignScope.lease)).metaCostStatements,[]);
  await completeEmptyExport(foreign.privacy,foreignScope);
  const unknownParticipant='12025550162',uncertainExport=await f.createPrivacyJob('PARTICIPANT',unknownParticipant,'EXPORT');
  const uncertainData=await f.privacy.exportData(uncertainExport,uncertainExport.lease);
  assert.equal(uncertainData.metaCostStatements.length,0,'Redaction cannot manufacture a new subject association');
  assert.deepEqual(uncertainData.ticketIds,[],'Unknown subject has no native ticket');
  assert.equal(uncertainData.metaCostSourceReviewStatus[0].unknownRecordSubjectCoverage,recordIds.length);
  let uncertaintyArtifact;const uncertaintyProcessor=new PrivacyProcessor(f.privacy,{resolve:async reference=>{assert.equal(reference,uncertainExport.zammadPrivacySecretReference);return{token:'synthetic-statement-privacy-token'};}},
   {put:async(_key,value)=>{uncertaintyArtifact=Uint8Array.from(value);},delete:async()=>assert.fail('Export cannot delete')});
  const uncertaintySummary=await uncertaintyProcessor.process(uncertainExport,uncertainExport.lease);assert.notEqual(uncertaintySummary,'deferred');assert(uncertaintyArtifact);
  const uncertaintyLocal=JSON.parse(new TextDecoder().decode(uncertaintyArtifact)).local;assert.deepEqual(uncertaintyLocal.metaCostStatements,[]);
  assert.deepEqual(uncertaintyLocal.metaCostSourceReviewStatus,uncertainData.metaCostSourceReviewStatus);
  assert.equal(await f.privacy.complete(uncertainExport,uncertainExport.lease,uncertaintySummary),true);
  const uncertainDelete=await f.createPrivacyJob('PARTICIPANT',unknownParticipant);await discoverDeletion(uncertainDelete);
  assert.equal(await f.privacy.hasPendingFinanceReview(uncertainDelete),true);
  for(const id of recordIds)assert.equal((await f.read(id)).privacyReviews.filter(row=>row.jobState==='RUNNING'&&row.state==='PENDING').length,1);
  await assert.rejects(()=>f.privacy.complete(uncertainDelete,uncertainDelete.lease,{}),dbCode('55000'));
  // A reviewed unknown subject decision remains distinct from the earlier known
  // subject binding. It cannot remove the retained record or restore effects.
  for(const id of recordIds)await f.privacyReview(id,uncertainDelete,'NO_SUBJECT_MATCH');
  activePrivacyJob=uncertainDelete;const reviewedSummary=await processor.process(uncertainDelete,uncertainDelete.lease);assert.notEqual(reviewedSummary,'deferred');
  assert.equal(await f.privacy.complete(uncertainDelete,uncertainDelete.lease,reviewedSummary),true);
  return{selectedRowsOnlyOriginalAndDerived:true,previewOnlyDiscovered:true,sourceOnlyAndCombinedWithoutDuplicates:true,
   uncertaintyAfterRedactionRequiresReview:true,threeActualSubjectArtifacts:true,unrelatedAndForeignExcluded:true,
   originalNoSubjectAttestationDoesNotDenyRecordLink:true,qualifiedRetentionAndPostRedactionMetadata:true,immutablePublication:true};
 }finally{globalThis.fetch=previousFetch;if(foreign)await foreign.close();await f.close();}
}

export async function verifyMetaStatementConcurrentUpload(options){
 const f=await createMetaStatementScenario(options);let release,upload;
 try{
  const source=await f.reserve();let entered;
  const admittedPut=new Promise(resolve=>{entered=resolve;}),putResponse=new Promise(resolve=>{release=resolve;});let writes=0;
  const delayedStorage={...f.storage,put:async(key,bytes)=>{writes++;f.objects.set(key,Uint8Array.from(bytes));entered();await putResponse;}};
  const delayed=new MetaCostSourceService(f.sourceRepository,f.scanner,delayedStorage);
  upload=delayed.upload(f.tenantId,source.id,source.bytes,'application/json');void upload.catch(()=>undefined);
  await Promise.race([admittedPut,upload]);assert.equal(writes,1);
  assert.equal((await f.read(source.id)).writeDisposition,'ADMITTED');
  await assert.rejects(()=>f.sourceService.upload(f.tenantId,source.id,source.bytes,'application/json'),error=>error.code==='SOURCE_WRITE_UNRESOLVED');
  const restarted=new MetaCostSourceService(new MetaCostSourceRepository(f.worker),f.scanner,delayedStorage);
  await assert.rejects(()=>restarted.upload(f.tenantId,source.id,source.bytes,'application/json'),error=>error.code==='SOURCE_WRITE_UNRESOLVED');
  const job=await f.createPrivacyJob('PARTICIPANT','synthetic-admitted-write-subject');await f.privacy.discover(job,job.lease);
  assert.equal(await f.privacy.hasPendingFinanceReview(job),true);assert.equal((await f.privacy.targets(job)).some(t=>t.type==='META_COST_SOURCE'),false);
  await assert.rejects(()=>f.privacyReview(source.id,job,'PURGE_REQUIRED'),dbCode('55000'));
  await assert.rejects(()=>f.reserve(),dbCode('40001')); // Actual DELETE intent fences concurrent imports.
  release();await assert.rejects(()=>upload,error=>error.code==='SOURCE_WRITE_REQUIRES_REVIEW');
  assert.equal(writes,1);assert.equal((await f.read(source.id)).sourceState,'PURGE_PENDING');
  await f.privacyReview(source.id,job,'PURGE_REQUIRED');const target=(await f.privacy.targets(job)).find(t=>t.type==='META_COST_SOURCE');assert(target);
  await f.privacy.beginTargetExternal(job,job.lease,target);
  // Simulate a DELETE that happened with its response lost. The persisted
  // attempt is already terminal, so the same owned DELETE may safely repeat.
  await f.storage.delete(target.objectKey);assert.equal(f.objects.has(target.objectKey),false);
  const recovered=new PrivacyRepository(f.worker);await recovered.beginTargetExternal(job,job.lease,target);
  await f.storage.delete(target.objectKey);await recovered.markTargetExternal(job,job.lease,target);
  const summary=await recovered.finalize(job,job.lease);assert.equal(summary.metaCostSourcesPurged,1);
  assert.equal(await recovered.complete(job,job.lease,summary),true);assert.equal(f.deletes.length,2);assert.equal(writes,1);

  const refused = await f.reserve();
  let rejectedPuts = 0;
  let proposedAttempt;
  const rejectingRepository = new MetaCostSourceRepository({ connect: async () => {
    const client = await f.worker.connect();
    return {
      query: async (sql, values) => {
        if (sql.includes('app.settle_meta_cost_source_write')) {
          assert.equal(values[3], 'NOT_WRITTEN');
          proposedAttempt = values[2];
          throw new Error('Synthetic settlement database failure');
        }
        return client.query(sql, values);
      },
      release: () => client.release(),
    };
  } });
  const rejectingUpload = new MetaCostSourceService(rejectingRepository, f.scanner, {
    ...f.storage,
    put: async () => { rejectedPuts++; throw new MediaRuntimeError('Synthetic storage refusal', 'MEDIA_STORAGE_HTTP', false); },
  });
  const retry = () => rejectingUpload.upload(f.tenantId, refused.id, refused.bytes, 'application/json');
  await assert.rejects(retry, error => error.code === 'SOURCE_WRITE_UNRESOLVED');
  const unresolved = await f.read(refused.id);
  assert.equal(unresolved.sourceState, 'UPLOADING');
  assert.equal(unresolved.writeDisposition, 'ADMITTED');
  assert.equal(unresolved.writeAttemptId, proposedAttempt);
  await assert.rejects(retry, error => error.code === 'SOURCE_WRITE_UNRESOLVED');
  await f.action('META_SOURCE_RECONCILE', refused.id, {
    expectedVersion: Number(unresolved.version), originalSha256: unresolved.originalSha256,
    writeAttemptId: proposedAttempt, outcome: 'NOT_WRITTEN', scanSha256: unresolved.scanSha256,
    terminalDispositionEvidenceSha256: sha('Synthetic definitive refusal for the admitted attempt'),
  });
  const settled = await f.read(refused.id);
  assert.equal(settled.writeAttemptId, proposedAttempt);
  assert.equal(settled.writeDisposition, 'NOT_WRITTEN');
  assert.equal(settled.sourceState, 'PURGE_PENDING');
  await assert.rejects(retry, dbCode('P0002'));
  assert.equal(rejectedPuts, 1);
  return{oneAdmittedPutAcrossConcurrentAndRestartedCalls:true,privacyWaitsForTerminalWrite:true,lateWriteNeverRestoresReady:true,terminalDeleteResponseLossRecoverable:true,rejectedSettlementRemainsFencedUntilReconciled:true};
 }finally{release?.();await upload?.catch(()=>undefined);await f.close();}
}

export async function verifyMetaStatementLegalHold(options){
 const f=await createMetaStatementScenario(options);
 try{
  const source=await f.reserve();await f.finish(source);
  const controller=new PrivacyController(f.database,{wakePrivacy:async()=>{}},{create:async()=>assert.fail('No artifact requested')},{privacyTarget:async()=>assert.fail('No native target in this fixture')});
  // This is the actual authenticated-role controller/domain call; HTTP/OIDC
  // acceptance remains the separate stack gate. No legal-hold row is seeded.
  const request={id:'statement-hold',principal:{tenantId:f.tenantId,userId:f.actorId,subject:`managed-${f.actorId}`,
   email:`managed-${f.actorId}@example.invalid`,displayName:'Synthetic owner',role:'tenant_owner',authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:['mfa']}};
  const hold=await controller.createHold(request,{scopeType:'TENANT',scopeValue:f.tenantId,reason:'Synthetic active-hold regression'}, "privacy-hold-fixture-1");assert.equal(hold.state,'ACTIVE');
  const job=await f.createPrivacyJob('TENANT',f.tenantId);
  await assert.rejects(()=>f.privacy.discover(job,job.lease),PrivacyLegalHoldError);
  assert.equal((await f.privacy.targets(job)).some(t=>['META_COST_SOURCE','META_COST_RECORD'].includes(t.type)),false);
  assert.equal(f.deletes.length,0);assert.equal((await f.read(source.id)).sourceState,'READY');
  await assert.rejects(()=>f.sourceService.original(f.tenantId,source.id),dbCode('40001'));
  // A hold and retained original cannot be bypassed through direct runtime DML.
  for(const pool of [f.app,f.worker])await assert.rejects(()=>f.tx(pool,f.tenantId,c=>c.query('DELETE FROM public.meta_cost_statement_versions WHERE tenant_id=$1 AND id=$2',[f.tenantId,source.id])),dbCode('42501'));
  return{actualTenantHoldPreventsSourceTargets:true,noStorageDelete:true,retainedRecordNotDirectlyDeletable:true};
 }finally{await f.close();}
}

export async function verifyMetaStatementDiscoveryBound(options){
 const f=await createMetaStatementScenario(options);
 try{
  const first=await f.reserve();
  // Exercise 1001 actual domain reservations, not INSERTs into a protected
  // finance table. They remain unuploaded staging descriptions with no claim.
  const generated=await f.tx(f.platform,f.tenantId,client=>client.query(`SELECT app.operator_meta_statement('META_STATEMENT_RESERVE',$1,NULL,
   jsonb_set($2::jsonb,'{source,documentId}',to_jsonb($3::text||'-'||n::text)),$3::text||'-'||n::text,'synthetic-mfa-operator','statement-batch') value
   FROM generate_series(1,1000) n`,[f.tenantId,first.input,randomUUID()]));assert.equal(generated.rows.length,1000);
  const job=await f.createPrivacyJob('PARTICIPANT','synthetic-unmapped-batch');
  await f.privacy.discover(job,job.lease);
  const frozen=(await f.tx(f.worker,f.tenantId,client=>client.query('SELECT stage FROM public.privacy_jobs WHERE tenant_id=$1 AND id=$2',[f.tenantId,job.id]))).rows[0];
  assert.equal(frozen.stage,'EXTERNAL');job.stage=frozen.stage;
  const counts=()=>f.tx(f.worker,f.tenantId,async client=>(await client.query("SELECT count(*)::integer count FROM privacy_job_targets WHERE tenant_id=$1 AND job_id=$2 AND target_type='FINANCE_SOURCE_REVIEW'",[f.tenantId,job.id])).rows[0].count);
  assert.equal(await counts(),1000);assert.equal(await f.privacy.hasPendingExternalTargets(job),true);
  await assert.rejects(()=>f.privacy.complete(job,job.lease,{}),dbCode('55000'));
  const preserved=(await f.tx(f.worker,f.tenantId,client=>client.query("SELECT target_type,target_id,target_sha256,finance_binding FROM public.privacy_job_targets WHERE tenant_id=$1 AND job_id=$2 AND target_type='FINANCE_SOURCE_REVIEW' ORDER BY id LIMIT 1",[f.tenantId,job.id]))).rows[0];
  for(const pool of [f.worker,f.platform]){
   await assert.rejects(()=>f.tx(pool,f.tenantId,c=>c.query('INSERT INTO public.privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256,finance_binding) VALUES($1,$2,$3,$4,$5,$6)',
    [f.tenantId,job.id,preserved.target_type,preserved.target_id,preserved.target_sha256,preserved.finance_binding])),dbCode(pool===f.worker?'23514':'42501'),'Runtime callers cannot bypass frozen finance membership');
  }
  await assert.rejects(()=>f.tx(f.worker,f.tenantId,c=>c.query("INSERT INTO public.privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256) VALUES($1,$2,'ZAMMAD_TICKET','730099',$3)",[f.tenantId,job.id,sha('730099')])),dbCode('23514'),'Ordinary target membership remains frozen');
  await assert.rejects(()=>f.tx(f.worker,f.foreignTenantId,c=>c.query('SELECT app.discover_meta_cost_privacy($1,$2,$3)',[job.id,job.lease,job.fencingToken])),dbCode('42501','40001'));
  await assert.rejects(()=>f.privacy.discover(job,randomUUID()));
  assert.equal(await counts(),1000);
  await f.privacy.discover(job,job.lease);
  assert.equal((await f.tx(f.worker,f.tenantId,c=>c.query('SELECT stage FROM public.privacy_jobs WHERE tenant_id=$1 AND id=$2',[f.tenantId,job.id]))).rows[0].stage,'EXTERNAL');
  assert.equal(await counts(),1001);assert.equal(await f.privacy.hasPendingFinanceReview(job),true);
  assert.equal((await f.tx(f.worker,f.tenantId,client=>client.query('SELECT app.meta_cost_privacy_has_remaining($1) value',[job.id]))).rows[0].value,false);
  await assert.rejects(()=>f.privacy.complete(job,job.lease,{metaCostSourcesPurged:1001}),dbCode('55000'));
  assert.equal(f.puts.length,0);assert.equal(f.deletes.length,0);
  return{actualReservations:1001,firstDiscovery:1000,secondDiscovery:1,noTailOrReviewFalseCompletion:true};
 }finally{await f.close();}
}

export async function verifyMetaStatementRolesAndLookup(options){
 const f=await createMetaStatementScenario(options),admin=new Client({connectionString:options.adminUrl});
 try{
  await admin.connect();const source=await f.reserve();await f.finish(source);
  for(const pool of [f.app,f.worker,f.platform]){
   const permissions=(await pool.query("SELECT has_table_privilege(current_user,'public.meta_cost_statement_versions','SELECT') r,has_table_privilege(current_user,'public.meta_cost_statement_versions','INSERT') i,has_table_privilege(current_user,'public.meta_cost_statement_versions','UPDATE') u,has_table_privilege(current_user,'public.meta_cost_statement_versions','DELETE') d")).rows[0];
   assert.deepEqual(permissions,{r:false,i:false,u:false,d:false});
   await assert.rejects(()=>f.tx(pool,f.tenantId,c=>c.query('SELECT * FROM public.meta_cost_statement_versions')),dbCode('42501'));
   await assert.rejects(()=>f.tx(pool,f.tenantId,c=>c.query('SELECT app.reserve_meta_cost_statement($1,$2,$3)',[f.tenantId,source.input,'forbidden-direct'])),dbCode('42501'));
  }
  for(const pool of [f.app,f.worker])await assert.rejects(()=>f.tx(pool,f.tenantId,c=>c.query('SELECT app.operator_meta_statement($1,$2,$3,$4,$5,$6,$7)',
   ['META_STATEMENT_RESERVE',f.tenantId,null,source.input,randomUUID(),'forged-operator','forged-request'])),dbCode('42501'));
  assert.equal((await f.tx(f.app,f.foreignTenantId,c=>c.query('SELECT app.meta_cost_statement_publication($1,$2) value',[f.tenantId,source.id]))).rows[0].value,null);
  await assert.rejects(()=>f.tx(f.worker,f.foreignTenantId,c=>c.query('SELECT app.meta_cost_source_access($1,$2,true)',[f.foreignTenantId,source.id])),dbCode('P0002'));
  const schema=(await admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_catalog.pg_class WHERE oid='public.meta_cost_statement_versions'::regclass")).rows[0];assert.deepEqual(schema,{relrowsecurity:true,relforcerowsecurity:true});
  const names=['meta_cost_statement_versions','meta_messaging_accounts','meta_billing_policy_versions','meta_cost_assessments','retention_policies','privacy_jobs'];
  const definitions={};for(const name of names){const rows=(await admin.query(`SELECT attname,pg_catalog.format_type(atttypid,atttypmod) type FROM pg_catalog.pg_attribute
   WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`,['public.'+name])).rows;assert(rows.length);definitions[name]=rows.map(row=>'"'+row.attname.replaceAll('"','""')+'" '+row.type).join(',');}
  const original=(await admin.query('SELECT to_jsonb(s) value FROM public.meta_cost_statement_versions s WHERE id=$1',[source.id])).rows[0].value;
  for(const [config,role,operation] of [[{connectionString:options.appUrl},'wasalx_runtime','PUBLICATION'],[options.workerConfig,'wasalx_connector_worker','SOURCE'],
   [{connectionString:options.platformOperationsUrl,options:'-c role=wasalx_platform_operations_client'},'wasalx_platform_operations_client','OPERATOR']]){
   const client=new Client({...config,statement_timeout:10000,query_timeout:12000});await client.connect();
   try{
    assert.equal((await client.query('SELECT current_user')).rows[0].current_user,role);await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenantId]);
    for(const name of names){await client.query(`CREATE TEMP TABLE "${name}" (${definitions[name]}) ON COMMIT DROP`);await client.query(`GRANT SELECT ON pg_temp."${name}" TO PUBLIC`);}
    const forged={...original,evidence_mode:'LIVE',publication:{...original.publication,amount:'999999999',evidenceMode:'LIVE'},source_state:'PURGED'};
    await client.query('INSERT INTO pg_temp.meta_cost_statement_versions SELECT (pg_catalog.jsonb_populate_record(NULL::pg_temp.meta_cost_statement_versions,$1)).*',[forged]);
    if(operation==='PUBLICATION'){
     const result=(await client.query('SELECT app.meta_cost_statement_publication($1,$2) value',[f.tenantId,source.id])).rows[0].value;
     assert.equal(result.statement.evidenceMode,'SIMULATED');assert.equal(decimal(result.statement.amount),'1.01');
    }else if(operation==='SOURCE'){
     const result=(await client.query('SELECT app.meta_cost_source_access($1,$2,true) value',[f.tenantId,source.id])).rows[0].value;assert.equal(result.sourceState,'READY');assert.equal(result.sha256,source.input.source.originalSha256);
    }else{
     const result=(await client.query('SELECT app.operator_meta_statement_read($1,NULL,$2,NULL,NULL,$3,$4) value',[f.tenantId,source.id,'synthetic-mfa-operator','shadow-read'])).rows[0].value;
     assert.equal(result.evidenceMode,'SIMULATED');assert.equal(result.sourceState,'READY');
     await client.query('CREATE TEMP TABLE pg_timezone_names(name text) ON COMMIT DROP');await client.query('GRANT SELECT ON pg_temp.pg_timezone_names TO PUBLIC');
     await client.query("INSERT INTO pg_temp.pg_timezone_names VALUES('Synthetic/Invalid_Zone')");
     await client.query('SAVEPOINT invalid_zone');
     try{await assert.rejects(()=>client.query('SELECT app.operator_meta_statement($1,$2,NULL,$3,$4,$5,$6)',[
      'META_STATEMENT_RESERVE',f.tenantId,{...source.input,timezone:'Synthetic/Invalid_Zone'},randomUUID(),'synthetic-mfa-operator','shadow-zone']),dbCode('22023'));}
     finally{await client.query('ROLLBACK TO SAVEPOINT invalid_zone');}
     const actual=(await client.query('SELECT app.operator_meta_statement($1,$2,NULL,$3,$4,$5,$6) value',[
      'META_STATEMENT_RESERVE',f.tenantId,source.input,randomUUID(),'synthetic-mfa-operator','real-zone'])).rows[0].value;assert.equal(actual.id,source.id);assert.equal(actual.duplicateSource,true);
    }
   }finally{await client.query('ROLLBACK').catch(()=>undefined);await client.end();}
  }
  for(const change of [{periodFrom:'today'},{periodTo:'2026-10-08 12:00:00'},{periodFrom:'2026-10-01T24:00:00.000Z'},{accountId:randomUUID()},{source:{...source.input.source,sourceTotal:0.01}},
   {source:{...source.input.source,sourceAccountIdentifier:'99999999'}},{source:{...source.input.source,issuerKind:'APPROVED_PARTNER',issuerAuthorityVersionId:randomUUID()}}])
   await assert.rejects(()=>f.action('META_STATEMENT_RESERVE',null,{...source.input,...change}),dbCode('22023','55000'));
  return{restrictedRuntimeRoles:true,forcedRls:true,foreignScopeHidden:true,freshSessionForgedShadowsIgnored:true,realScopedPositive:true};
 }finally{await admin.end().catch(()=>undefined);await f.close();}
}

export async function verifyMetaCostStatementsPostgres(options){
 return{
  lineage:await verifyMetaStatementLineage(options),correctionFence:await verifyMetaStatementCorrectionFence(options),
  sourcePrivacy:await verifyMetaStatementSourcePrivacy(options),scopedArtifact:await verifyMetaStatementScopedArtifact(options),
  selectedSubjects:await verifyMetaStatementSelectedSubjects(options),
  concurrentUpload:await verifyMetaStatementConcurrentUpload(options),legalHold:await verifyMetaStatementLegalHold(options),
  discoveryBound:await verifyMetaStatementDiscoveryBound(options),rolesAndLookup:await verifyMetaStatementRolesAndLookup(options),
 };
}
