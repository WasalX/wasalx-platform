import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {ConnectionsController} from '../services/control-api/dist/connections.controller.js';
import {metaTransitionObservation} from '../packages/core/dist/meta-account-transition-observation.js';
import {executeMetaAccountTransition} from '../services/connector-worker/dist/services/connector-worker/src/meta-account-transition-execution.js';
import {metaTransitionExecutionRepository} from '../services/connector-worker/dist/services/connector-worker/src/meta-account-transition-execution-repository.js';
import {createMetaManagedFundingFixture} from './meta-managed-funding-postgres.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const methods={INITIATE:'initiateMetaTransition',OBSERVE:'observeMetaTransition',COMPLETE:'completeMetaTransition',RECONCILE:'reconcileMetaTransition'};

/** Reuses the P08 actual-role/account/runtime fixture. Synthetic registry inputs
 * and intercepted Graph responses are never installed or live evidence. No
 * checkpoint, provider completion, reservation, binding or bridge is seeded.
 * All of those are created by their production app/worker/platform functions.
 * Serial caller owns the disposable canonical database and awaits close(). */
export async function createMetaTransitionExecutionFixture(options,{requestedMode='CUSTOMER'}={}){
 assert.ok(['CUSTOMER','WASALX_MANAGED'].includes(requestedMode));
 const base=await createMetaManagedFundingFixture(options),admin=new Client({connectionString:options.adminUrl});
 const close=async()=>{await Promise.allSettled([base.close(),admin.end()]);};
 try{
  await admin.connect();
  if(requestedMode==='WASALX_MANAGED')await base.acceptManagedTariff(null);else await base.acceptCustomerTariff(null);
  const {tenantId,actorId,connectionId,accountId,providerAccountId,phoneNumberId,app,worker,platform,tx,operations}=base;
  const controller=new ConnectionsController({withTenant:(tenant,fn)=>tx(app,tenant,fn)},{},{wakeConnection:async()=>{}});
  const request={id:'transition-fixture',principal:{tenantId,userId:actorId,role:'tenant_owner',authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:['mfa']}};
  const source=(await tx(app,tenantId,c=>c.query(`SELECT b.id,b.revision,b.provider_session_id,b.secret_reference,b.app_id,s.provider_state_data
    FROM meta_connection_account_bindings b JOIN provider_sessions s ON s.tenant_id=b.tenant_id AND s.id=b.provider_session_id
    WHERE b.tenant_id=$1 AND b.connection_id=$2 AND b.state='ACTIVE'`,[tenantId,connectionId]))).rows[0];
  assert.ok(source);const appId=source.app_id,sourceProof=source.provider_state_data.metaAccountProof;
  const targetProviderAccountId=String(BigInt('0x'+randomUUID().replaceAll('-',''))%100000000000000000000000000000n);
  const targetTermsText='Synthetic target account terms. No live credit or payment agreement.',targetTermsSha=sha(targetTermsText);
  const sourceArrangement=requestedMode==='WASALX_MANAGED'?(await tx(worker,tenantId,c=>c.query(
   'SELECT arrangement.* FROM meta_funding_arrangement_versions arrangement JOIN meta_billing_policy_versions policy ON policy.tenant_id=arrangement.tenant_id AND policy.arrangement_version_id=arrangement.id JOIN meta_messaging_accounts account ON account.tenant_id=policy.tenant_id AND account.active_policy_version_id=policy.id WHERE account.tenant_id=$1 AND account.id=$2',[tenantId,accountId]))).rows[0]:null;
  const targetAllocationId=String(BigInt(targetProviderAccountId)+1n);
  const migrationId='synthetic_migration_'+randomUUID().replaceAll('-','');
  const store=metaTransitionExecutionRepository((tenant,fn)=>tx(worker,tenant,fn));
  const claim=async()=>{const lease=randomUUID(),jobs=await operations.claim(tenantId,lease,1);assert.equal(jobs.length,1);return{job:jobs[0],lease};};
  const sqlValue=(pool,sql,args)=>tx(pool,tenantId,async c=>(await c.query(sql,args)).rows[0].value);
  const plan=async id=>(await tx(app,tenantId,c=>c.query('SELECT * FROM meta_account_transitions WHERE tenant_id=$1 AND id=$2',[tenantId,id]))).rows[0];
  const createPreview=async()=>{
   const page=await controller.metaTransitionPage(request,connectionId);assert.ok(page.prepare);
   const body={requestedMode,targetCurrency:'EUR',expectedAccountRevision:page.prepare.accountRevision,expectedBindingRevision:page.prepare.bindingRevision};
   const result=await controller.createMetaTransitionPreview(request,connectionId,'preview-'+randomUUID(),body),work=await claim();
   assert.equal(work.job.id,(await plan(result.id)).current_observation_operation_id);const frame=await operations.guardMetaTransitionPreview(work.job,work.lease,appId);assert.ok(frame.context);
   await operations.completeMetaTransitionPreview(work.job,work.lease,appId,metaTransitionObservation(frame.request,frame.context,
    {sourceAccountId:providerAccountId,currency:'USD',phoneIds:[phoneNumberId],phonesComplete:true,templatesComplete:false}));
   return result.id;
  };
  const authorize=async id=>{
   const current=await plan(id),scope=await sqlValue(app,'SELECT app.meta_transition_scope($1) AS value',[accountId]);
   const scopeSha=(await tx(app,tenantId,c=>c.query("SELECT encode(digest(app.meta_transition_scope($1)::text,'sha256'),'hex') AS sha",[accountId]))).rows[0].sha;
   const proof={tenantId,sourceAccountId:accountId,transitionId:id,requestedMode,targetCurrency:'EUR',mode:'SIMULATED',graphVersion:'v24.0',
    variant:'STANDARD_SAME_HIERARCHY',adminAuthority:'VERIFIED',phoneScope:'COMPLETE_LOCAL_ONLY',templateScope:'VERIFIED',sourceCurrency:'USD',
    evidenceSha256:sha('synthetic-transition-prerequisites-not-installed'),scopeSha256:scopeSha,expiresAt:new Date(Date.now()+10*60_000).toISOString(),
    appId,authorityRevision:String(scope.authorityRevision),...(sourceArrangement?{
     sourcePayment:'LINE',paymentAction:'APPROVED_LINE',arrangementVersionId:sourceArrangement.id,
     creditLineId:sourceArrangement.credit_line_id,delegatedHolderBusinessId:sourceArrangement.holder_business_id,
     targetReceivingBusinessId:sourceArrangement.receiving_business_id,targetTermsDocumentText:targetTermsText,
     targetTermsDocumentSha256:targetTermsSha,targetTermsVersion:'SYNTHETIC_TRANSITION_TARGET_V1',cloneFundingGrant:'EXACT_TRANSITION_DERIVED_TARGET',
    }:{sourcePayment:'CARD',paymentAction:'RETAIN_CARD'})};
   return sqlValue(platform,'SELECT app.operator_authorize_meta_transition($1,$2,$3,$4,$5) AS value',
    [id,current.revision,proof,'synthetic-mfa-operator','transition-prerequisites']);
  };
  const confirmation=async id=>{const current=await plan(id);return{expectedRevision:Number(current.revision),
   expectedPreviewSha256:await sqlValue(app,'SELECT app.meta_transition_confirmation($1) AS value',[id])};};
  const action=(id,kind,key,body)=>controller[methods[kind]](request,connectionId,id,key,body);
  const resolve=(id,kind,key,body)=>controller[methods[kind]+'Resolution'](request,connectionId,id,key,body);
  const reviewTarget=async id=>{const current=await plan(id);return sqlValue(platform,
   'SELECT app.operator_review_meta_transition_target($1,$2,$3,$4,$5) AS value',
   [id,current.provider_observation_operation_id,{mode:'SIMULATED',templates:'VERIFIED',flows:'VERIFIED',scopeSha256:current.execution_scope_sha256,
    templateEvidenceSha256:sha('synthetic-target-no-template-dependencies'),flowEvidenceSha256:sha('synthetic-target-no-flow-dependencies'),
    expiresAt:new Date(Date.now()+10*60_000).toISOString(),...(sourceArrangement?{termsDocumentText:targetTermsText,termsDocumentSha256:targetTermsSha}:{})},'synthetic-mfa-operator','transition-target-review']);};
  const traffic=[],readbackSecrets=new Map();let providerStatus='READY_TO_COMPLETE',originalCredentialAvailable=true;
  const executeQueued=async(work,{beforeFetch,unknownStage,targetReadFailure=false}={})=>{
   const priorFetch=globalThis.fetch;
   globalThis.fetch=async(raw,init)=>{
    const url=new URL(String(raw)),path=url.pathname.replace(/^\/v[0-9]+\.[0-9]+/u,'');assert.equal(url.origin,'https://graph.facebook.com');
    const method=init.method;traffic.push({path,method});if(beforeFetch)await beforeFetch({path,method,work});
    if(!originalCredentialAvailable&&init.headers.authorization==='Bearer synthetic-managed-account-token')return Response.json({error:{code:190,type:'OAuthException',message:'Synthetic original credential revoked'}},{status:401});
    if(path===`/${providerAccountId}/set_payment_method_migration_intent`){assert.equal(method,'POST');assert.deepEqual(JSON.parse(init.body),{currency:'EUR',...(sourceArrangement?{extended_credit_id:sourceArrangement.credit_line_id}:{})});
     if(unknownStage==='INITIATE')throw new TypeError('Synthetic request loss after INITIATE');return Response.json({migration_id:migrationId,migration_status:'INITIATED'});}
    if(path===`/${migrationId}/resume_migration`){assert.equal(method,'POST');assert.equal(init.body,undefined);
     if(unknownStage==='COMPLETE')throw new TypeError('Synthetic request loss after COMPLETE');providerStatus='COMPLETED';return Response.json({id:migrationId,status:providerStatus,destination_waba:{id:targetProviderAccountId,currency:'EUR'}});}
    assert.equal(method,'GET','Every target/known-ID read is side-effect free');
    if(path===`/${migrationId}`)return Response.json({id:migrationId,status:providerStatus,destination_waba:{id:targetProviderAccountId,currency:'EUR'}});
    if(targetReadFailure)return Response.json({error:{code:10,type:'OAuthException',message:'Synthetic inaccessible target'}},{status:403});
    if(sourceArrangement){
     if(path===`/${sourceArrangement.holder_business_id}/extendedcredits`)return Response.json({data:[{id:sourceArrangement.credit_line_id}]});
     if(path===`/${sourceArrangement.credit_line_id}/owning_credit_allocation_configs`){assert.equal(url.searchParams.get('receiving_business_id'),sourceArrangement.receiving_business_id);
      return Response.json({id:targetAllocationId,receiving_business:{id:sourceArrangement.receiving_business_id}});}
     if(path===`/${targetAllocationId}`&&url.searchParams.get('fields')==='receiving_credential')return Response.json({id:targetAllocationId,receiving_credential:{id:'synthetic-target-card'}});
    }
    if(path===`/${targetProviderAccountId}/phone_numbers`){assert.equal(providerStatus,'COMPLETED','An unfinished clone is not required to expose final phone membership');return Response.json({data:[{id:phoneNumberId}]});}
    if(path===`/${targetProviderAccountId}/message_templates`){assert.equal(providerStatus,'COMPLETED');assert.equal(url.searchParams.get('limit'),'100');return Response.json({data:[]});}
    if(path===`/${targetProviderAccountId}/subscribed_apps`)return Response.json({data:[{whatsapp_business_api_data:{id:appId}}]});
    if(path===`/${phoneNumberId}`&&url.searchParams.get('fields')==='health_status')return Response.json({id:phoneNumberId,
     health_status:{can_send_message:'AVAILABLE',entities:[['PHONE_NUMBER',phoneNumberId],['WABA',targetProviderAccountId],['APP',appId]].map(([entity_type,id])=>({entity_type,id,can_send_message:'AVAILABLE'}))}});
    if(path===`/${targetProviderAccountId}`){const fields=url.searchParams.get('fields');
     if(fields==='id,currency')return Response.json({id:targetProviderAccountId,currency:'EUR'});
     if(fields==='id,owner_business{id}')return Response.json({id:targetProviderAccountId,owner_business:{id:'123456789001'}});
     if(fields==='primary_funding_id')return Response.json({id:targetProviderAccountId,primary_funding_id:'synthetic-target-card'});
    }
    throw new Error(`Unexpected synthetic transition request: ${path} ${url.searchParams.get('fields')}`);
   };
   try{await executeMetaAccountTransition(work.job,work.lease,appId,store,{resolve:async reference=>{
     if(sourceArrangement&&reference===sourceArrangement.financial_secret_reference)return{accessToken:'synthetic-financial-token'};
     if(readbackSecrets.has(reference))return readbackSecrets.get(reference);
     assert.equal(reference,source.secret_reference);return{accessToken:'synthetic-managed-account-token'};}},
     {readTransport:async()=>({transportBindingSha256:options.runtimeEvidence.transportBindingSha256}),readRuntime:async()=>base.runtimeCandidate});
    await store.finishTransition(work.job,work.lease,true);
   }catch(error){await store.finishTransition(work.job,work.lease,false);throw error;}finally{globalThis.fetch=priorFetch;}
  };
  const run=async(id,kind,options)=>{const body=await confirmation(id),accepted=await action(id,kind,randomUUID(),body),work=await claim();
   assert.equal(work.job.id,accepted.operationId);await executeQueued(work,options);return work;};
  const providerComplete=async id=>{await authorize(id);await run(id,'INITIATE');await run(id,'OBSERVE');await reviewTarget(id);
   await run(id,'OBSERVE');await run(id,'COMPLETE');await run(id,'OBSERVE');const current=await plan(id);assert.equal(current.provider_status,'COMPLETED');
   assert.equal(current.identity_successor_receipt,null);return current;};
  return{...base,admin,close,controller,request,requestedMode,sourceArrangement,sourceBindingId:source.id,sourceBindingRevision:Number(source.revision),providerSessionId:source.provider_session_id,
   sourceProof,secretReference:source.secret_reference,appId,targetProviderAccountId,migrationId,store,claim,sqlValue,plan,createPreview,authorize,
   confirmation,action,resolve,reviewTarget,traffic,executeQueued,run,providerComplete,readbackSecrets,
   revokeOriginalCredential:()=>{originalCredentialAvailable=false;}};
 }catch(error){await close();throw error;}
}
