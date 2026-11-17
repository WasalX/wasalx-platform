import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Client,Pool} from 'pg';
import {ConnectionsController} from '../services/control-api/dist/connections.controller.js';
import {ConnectionOperationRepository} from '../services/connector-worker/dist/services/connector-worker/src/connection-operation-repository.js';
import {OutboxRepository} from '../services/connector-worker/dist/services/connector-worker/src/repository.js';
import {executeMetaManagedFunding} from '../services/connector-worker/dist/services/connector-worker/src/meta-managed-funding.js';
import {verifyMetaCredentialMetadata} from '../packages/core/dist/meta-account-relation.js';
import {metaAccountFundingProof} from '../packages/core/dist/meta-account-policy.js';
import {MetaGroupsAdapter} from '../services/connector-worker/dist/packages/connectors/src/meta.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
// One process-local sequence starts in a UUID-derived numeric namespace. Each
// constructor receives six distinct Graph identities, including its global route.
let nextAssetFamily=BigInt('0x'+randomUUID().replaceAll('-',''))%1000000000000000000000n;
function assetFamily(){const base=(++nextAssetFamily)*10n;return Array.from({length:6},(_,i)=>String(base+BigInt(i+1)));}
/** Ordinary fixture rows use admin; billing authority, receipts and attempts do
 * not. The caller owns the disposable DB and explicitly supplies synthetic SQL
 * registry inputs or separately qualified stack evidence. Fixture inputs never
 * prove installed images/runtime. Every provider response below is SIMULATED.
 * Serial caller only: the bounded fake fetch is restored before returning.
 * No production URL, credential, finance effect, LIVE claim or schema-2 seed. */
export async function createMetaManagedFundingFixture({adminUrl,workerConfig,appUrl,platformOperationsUrl,runtimeEvidence,observedCurrency='USD',currencyResponseKind='OBSERVED'}){
 assert.ok(['OBSERVED','MISSING','DENIED','MALFORMED','WRONG_ACCOUNT','EXPLICIT_NONE'].includes(currencyResponseKind));
 for(const key of ['workerImageDigest','sourceTree','releaseEvidenceSha256','sourceEvidenceSha256','transportBindingSha256'])
  assert.ok(typeof runtimeEvidence?.[key]==='string',`Explicit fixture registry input missing: ${key}`);
 const admin=new Client({connectionString:adminUrl});
 const worker=new Pool(workerConfig),app=new Pool({connectionString:appUrl}),platform=new Pool({connectionString:platformOperationsUrl,options:'-c role=wasalx_platform_operations_client'});
 let closed=false;const priorAppId=process.env.META_APP_ID;
 const close=async()=>{if(closed)return;closed=true;if(priorAppId===undefined)delete process.env.META_APP_ID;else process.env.META_APP_ID=priorAppId;
  await Promise.allSettled([worker.end(),app.end(),platform.end(),admin.end()]);};
 try{
  await admin.connect();
  for(const [pool,expected] of [[app,'wasalx_runtime'],[worker,'wasalx_connector_worker'],[platform,'wasalx_platform_operations_client']]){
   const role=(await pool.query('SELECT current_user,session_user,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass')).rows[0];
   assert.equal(role.current_user,expected);assert.equal(role.bypass,false);
   if(pool===app)assert.equal(role.session_user,expected);
   if(pool===platform)assert.equal(role.session_user,'wasalx_platform_operations_runtime');
   if(pool===worker)assert.equal(role.session_user,'wasalx_connector_worker_runtime');
  }
  const tenantId=randomUUID(),foreignTenantId=randomUUID(),actorId=randomUUID(),connectionId=randomUUID(),sessionId=randomUUID(),groupId=randomUUID();
  const [phoneNumberId,providerAccountId,receivingBusinessId,holderBusinessId,creditLineId,allocationId]=assetFamily();
  const appId='12025550130',graphVersion='v24.0',token='synthetic-managed-account-token',financialToken='synthetic-financial-token';
  const secretReference=`secret://${tenantId}/connections/${connectionId}/meta`,financialSecretReference='secret://platform/meta/financial-fixture';
  process.env.META_APP_ID=appId;
  const tx=async(pool,tenant,fn)=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);const value=await fn(c);await c.query('COMMIT');return value;}
   catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}};
  const proof={schemaVersion:1,claim:'PHONE_ACCOUNT_RELATION_VERIFIED',tenantId,connectionId,providerSessionId:sessionId,phoneNumberId,wabaId:providerAccountId,
   secretReference,credentialFingerprint:sha(token),operationId:randomUUID(),fencingToken:1,graphVersion,verifiedAt:new Date().toISOString(),responseSha256:sha('simulated-phone-membership'),
   credentialMetadata:verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0,data_access_expires_at:0}},{appId})};
  await admin.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Managed fixture',$2,'ACTIVE'),($3,'Foreign fixture',$4,'ACTIVE')",[tenantId,`managed-${tenantId}`,foreignTenantId,`foreign-${foreignTenantId}`]);
  await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Synthetic managed fixture')",[actorId,`managed-${actorId}`,`managed-${actorId}@example.invalid`]);
  await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')",[tenantId,actorId]);
  await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference,action_reason) VALUES($1,$2,'Managed fixture','META','CLOUD_API','WORKING',$3,'Retained operator pause')",[connectionId,tenantId,secretReference]);
  await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data) VALUES($1,$2,$3,$4,'WORKING',$5,'ACTIVE',$6)",
   [sessionId,tenantId,connectionId,phoneNumberId,`meta-cloud://${providerAccountId}/${phoneNumberId}`,{wabaId:providerAccountId,metaAccountProof:proof}]));
  await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state) VALUES($1,$2,'META',$3,'secret://platform/meta-webhook','ACTIVE')",[tenantId,connectionId,phoneNumberId]));
  await admin.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,'managed-fixture-group','Managed fixture group')",[groupId,tenantId,connectionId]);
  const operations=new ConnectionOperationRepository(worker),outbox=new OutboxRepository(worker);
  const controller=new ConnectionsController({withTenant:(tenant,fn)=>tx(app,tenant,fn)},{},{wakeConnection:async()=>{}});
  const request={id:'managed-fixture',principal:{tenantId,userId:actorId,role:'tenant_owner',authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:['mfa']}};
  const claim=async()=>{const lease=randomUUID(),jobs=await operations.claim(tenantId,lease,1);assert.equal(jobs.length,1);return{job:jobs[0],lease};};
  // Real create/current binding + immutable CUSTOMER intent, then real leased
  // diagnostic receipt. NONE is held and is never asserted as a paid-send grant.
  await controller.requestMetaBillingPolicy(request,connectionId,'managed-stage1',{mode:'CUSTOMER',expectedRevision:0});
  const helperAcl=(await tx(app,tenantId,c=>c.query(`SELECT count(*)::integer AS functions,
   bool_and(has_function_privilege(p.proowner,'app.meta_account_proof_sha256(jsonb)','EXECUTE')) AS sha,
   bool_and(has_function_privilege(p.proowner,'app.meta_account_proof_canonical_json(jsonb,integer)','EXECUTE')) AS canonical
   FROM pg_proc p WHERE p.oid=ANY(ARRAY[
    'app.operator_queue_meta_funding_attachment(uuid,bigint,text,text,text)'::regprocedure,
    'app.operator_queue_meta_funding_readback(uuid,bigint,text,text,text)'::regprocedure])`))).rows[0];
  assert.deepEqual(helperAcl,{functions:2,sha:true,canonical:true},'Retained definer owners can execute both pure proof helpers');
  const storedProof=(await tx(app,tenantId,c=>c.query(`SELECT b.proof_sha256,
   encode(digest((s.provider_state_data->'metaAccountProof')::text,'sha256'),'hex') AS sql_sha,
   app.meta_account_proof_sha256(s.provider_state_data->'metaAccountProof') AS canonical_sha
   FROM meta_connection_account_bindings b JOIN provider_sessions s ON s.tenant_id=b.tenant_id AND s.id=b.provider_session_id
   WHERE b.tenant_id=$1 AND b.connection_id=$2`,[tenantId,connectionId]))).rows[0];
  assert.equal(storedProof.proof_sha256,storedProof.sql_sha,'Actual app boundary persists established SQL binding identity');
  assert.notEqual(storedProof.sql_sha,storedProof.canonical_sha,'Canonical operation identity stays separate from SQL storage identity');
  const first=await claim();
  const none=metaAccountFundingProof(providerAccountId,{id:providerAccountId,owner_business:{id:receivingBusinessId}},{id:providerAccountId});
  await operations.completeMetaBillingDiagnostic(first.job,first.lease,appId,none.diagnostic,none.funding);
  const accountId=(await tx(app,tenantId,c=>c.query('SELECT account_id FROM meta_connection_account_bindings WHERE tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]))).rows[0].account_id;
  // Prove that the real leased diagnostic projected same-account NONE evidence;
  // explicit JSON null is UNAVAILABLE and must never authorize attachment.
  const initialFunding=(await tx(app,tenantId,c=>c.query(`SELECT state,funding_status,primary_funding_id,funding_response_sha256,
   funding_observed_at,funding_expires_at,last_observation_operation_id FROM meta_messaging_accounts WHERE tenant_id=$1 AND id=$2`,[tenantId,accountId]))).rows[0];
  assert.equal(initialFunding.state,'HELD');assert.equal(initialFunding.funding_status,'NONE');assert.equal(initialFunding.primary_funding_id,null);
  assert.equal(initialFunding.last_observation_operation_id,first.job.id);assert.equal(initialFunding.funding_response_sha256,none.funding.responseSha256);
  assert.equal(initialFunding.funding_observed_at.toISOString(),none.funding.observedAt);assert.equal(initialFunding.funding_expires_at.toISOString(),none.funding.expiresAt);
  const platformCall=async(sql,args)=>tx(platform,tenantId,async c=>(await c.query(sql,args)).rows[0].value);
  const registration=await platformCall('SELECT app.operator_register_meta_simulated_runtime($1,$2,$3) value',[
   {...runtimeEvidence,schemaVersion:1,mode:'SIMULATED',tenantId,accountId,graphVersion,expiresAt:new Date(Date.now()+60*60_000).toISOString()},'synthetic-mfa-operator','managed-runtime']);
  const runtimeCandidate={receiptId:registration.receiptId,descriptor:JSON.parse(registration.descriptorText),descriptorSha256:registration.descriptorSha256};
  const terms=await platformCall('SELECT app.operator_register_meta_simulated_terms($1,$2,$3) value',[
   {schemaVersion:1,tenantId,accountId,evidenceMode:'SIMULATED',documentSha256:sha('Simulated account payment terms. No live funding agreement or provider payment.'),documentText:'Simulated account payment terms. No live funding agreement or provider payment.',termsVersion:'SYNTHETIC_MANAGED_V1'},'synthetic-mfa-operator','managed-terms']);
  const commercialTermsVersionId=terms.commercialTermsVersionId;
  const account=async()=>(await tx(app,tenantId,c=>c.query('SELECT authority_revision,state,requested_policy_version_id FROM meta_messaging_accounts WHERE tenant_id=$1 AND id=$2',[tenantId,accountId]))).rows[0];
  let postCount=0,attached=false,managedAccepted=false,unknownPost=false,failedReadback=false,customerFunding=false,acceptedArrangement;
  const simulate=async fn=>{const original=globalThis.fetch;globalThis.fetch=async(raw,init)=>{
   const url=new URL(String(raw));assert.equal(url.origin,'https://graph.facebook.com');
   const path=url.pathname.replace(/^\/v[0-9]+\.[0-9]+/u,'');let body;
   if(path===`/${holderBusinessId}/extendedcredits`)body={data:[{id:creditLineId}]};
   else if(path===`/${providerAccountId}`&&url.searchParams.get('fields')==='id,owner_business{id}')body={id:providerAccountId,owner_business:{id:receivingBusinessId}};
   else if(path===`/${providerAccountId}`&&url.searchParams.get('fields')==='primary_funding_id')body={id:providerAccountId,...(attached?{primary_funding_id:'synthetic-receiving-credential'}:customerFunding?{primary_funding_id:'synthetic-customer-payment'}:{})};
   else if(path===`/${providerAccountId}`&&url.searchParams.get('fields')==='id,currency'){
    if(currencyResponseKind==='DENIED')return new Response(JSON.stringify({error:{code:200,message:'Synthetic optional field denial'}}),{status:403});
    body={id:currencyResponseKind==='WRONG_ACCOUNT'?holderBusinessId:providerAccountId,
     ...(currencyResponseKind==='MISSING'?{}:{currency:currencyResponseKind==='MALFORMED'?{unexpected:true}:currencyResponseKind==='EXPLICIT_NONE'?null:observedCurrency})};
   }
   else if(path===`/${creditLineId}/whatsapp_credit_sharing_and_attach`){assert.equal(init.method,'POST');assert.equal(url.searchParams.get('waba_id'),providerAccountId);assert.equal(url.searchParams.get('waba_currency'),'USD');postCount++;assert.equal(postCount,1,'No second financial POST');if(unknownPost)throw new TypeError('Simulated connection loss after financial request');attached=true;body={allocation_config_id:allocationId,waba_id:providerAccountId};}
   else if(path===`/${allocationId}`&&url.searchParams.get('fields')==='receiving_credential'){if(failedReadback)throw new TypeError('Simulated readback unavailable');body={id:allocationId,receiving_credential:{id:'synthetic-receiving-credential'}};}
   else if(path===`/${creditLineId}/owning_credit_allocation_configs`){assert.equal(url.searchParams.get('receiving_business_id'),receivingBusinessId);body={id:allocationId,receiving_business:{id:receivingBusinessId}};}
   else throw new Error(`Unexpected simulated Graph request: ${path}`);
   return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
  };try{return await fn();}finally{globalThis.fetch=original;}};
  // Non-null tariffs must use the same public view and command as an owner.
  // Direct no-tariff terms below remain the explicit pre-P10 domain fixture.
  const readTariffOffer=async(mode,draftUuid,choiceId)=>{
   let tariffAfter;const seen=new Set();
   do{const view=await controller.metaBillingPolicy(request,connectionId,{tariffMode:mode,...(mode==='MANAGED'?{choiceId}:{}),...(tariffAfter?{tariffAfter}:{})});
    const page=view.tariffOffers;assert.ok(page&&Array.isArray(page.items));
    const offer=page.items.find(item=>item.id===draftUuid);if(offer)return{offer,revision:view.revision};
    tariffAfter=page.nextAfter;if(tariffAfter){assert.equal(seen.has(tariffAfter),false);seen.add(tariffAfter);}
   }while(tariffAfter);
   throw new Error('Exact public tariff offer is unavailable');
  };
  const acceptPublicTariff=async(mode,draftUuid,choiceId,key)=>{
   const {offer,revision}=await readTariffOffer(mode,draftUuid,choiceId);
   const body={mode,expectedRevision:revision,...(mode==='MANAGED'?{choiceId}:{}),tariffVersionId:offer.id,
    tariffDefinitionSha256:offer.definitionSha256,documentSha256:offer.documentSha256,acceptedTerms:true};
   const result=await controller.requestMetaBillingPolicy(request,connectionId,key,body);
   assert.equal(result.state,'HELD');assert.equal(result.sendReady,false);
   const policy=(await tx(app,tenantId,c=>c.query(`SELECT p.id,p.accepted_tariff_version_id,p.commercial_terms_version_id,a.state,a.active_policy_version_id
    FROM meta_messaging_accounts a JOIN meta_billing_policy_versions p ON p.tenant_id=a.tenant_id AND p.id=a.requested_policy_version_id
    WHERE a.tenant_id=$1 AND a.id=$2`,[tenantId,accountId]))).rows[0];
   assert.equal(policy.accepted_tariff_version_id,draftUuid);assert.equal(policy.commercial_terms_version_id,commercialTermsVersionId);
   assert.equal(policy.state,'HELD');assert.equal(policy.active_policy_version_id,null);
   return{policyVersionId:policy.id,body,key};
  };
  const acceptManagedTariff=async(draftUuid,{simulateUnknown=false,simulateReadbackFailure=false,beforeAttach}={})=>{
   if(draftUuid!==null)assert.match(draftUuid,/^[a-f0-9-]{36}$/u);assert.equal(managedAccepted,false,'Explicit policy acceptance is one-time per fixture');
   const metadata=verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:['business_management'],expires_at:0}},{appId,purpose:'FINANCIAL'});
   const admission=await platformCall('SELECT app.operator_meta_managed_approval_context($1,$2) value',[tenantId,accountId]);
   const approved=await platformCall('SELECT app.operator_approve_meta_simulated_arrangement($1,$2,$3) value',[
    {schemaVersion:1,tenantId,accountId,familyId:null,admission,kind:'OWN_SOLUTION_PARTNER_LINE',appId,holderBusinessId,creditLineId,solutionId:null,receivingBusinessId,
     financialSecretReference,financialCredentialFingerprint:sha(financialToken),financialCredentialMetadata:metadata,graphVersion,requestedCurrency:'USD',evidenceMode:'SIMULATED',
     commercialTermsVersionId,approvalSha256:sha('Synthetic independently authorized solution-partner fixture'),expiresAt:new Date(Date.now()+60*60_000).toISOString()},'synthetic-mfa-operator','managed-approval']);
   const beforePolicy=await account();
   const policy=draftUuid===null?(await tx(app,tenantId,c=>c.query('SELECT app.accept_meta_managed_policy($1,$2,$3,$4,$5,$6,$7) value',
    [connectionId,approved.arrangementVersionId,commercialTermsVersionId,null,Number(beforePolicy.authority_revision),actorId,'managed-accept']))).rows[0].value
    :await acceptPublicTariff('MANAGED',draftUuid,approved.arrangementVersionId,'managed-accept');
   const queued=await platformCall('SELECT app.operator_queue_meta_funding_attachment($1,$2,$3,$4,$5) value',
    [approved.arrangementVersionId,Number((await account()).authority_revision),'managed-attach','synthetic-mfa-operator','managed-attach']);
   const work=await claim();assert.equal(work.job.id,queued.operationId);
   if(beforeAttach)await beforeAttach({job:work.job,lease:work.lease,appId,worker,tenantId,connectionId,providerSessionId:sessionId,accountId,runtimeCandidate,operations,
    transportBindingSha256:runtimeEvidence.transportBindingSha256});
   const secrets={resolve:async(reference)=>{assert.ok([secretReference,financialSecretReference].includes(reference));return{accessToken:reference===secretReference?token:financialToken};}};
   unknownPost=simulateUnknown;failedReadback=simulateReadbackFailure;
   let observation;try{observation=await simulate(()=>executeMetaManagedFunding(work.job,work.lease,appId,operations,secrets,{
    readTransport:async()=>({transportBindingSha256:runtimeEvidence.transportBindingSha256}),readRuntime:async()=>runtimeCandidate}));}
   catch(error){if(!simulateUnknown&&!simulateReadbackFailure)throw error;await operations.failMetaBillingDiagnostic(work.job,work.lease,{retryable:false,code:'SIMULATED_FINANCIAL_READ_UNAVAILABLE',safeError:'Simulated financial continuation is held'},appId);
    assert.equal(postCount,1);managedAccepted=true;return{...approved,policyVersionId:policy.policyVersionId,acceptance:policy.body?{body:policy.body,key:policy.key}:null,commercialTermsVersionId,runtimeEvidenceReceiptId:registration.receiptId,fundingOperationId:work.job.id,outcome:simulateUnknown?'UNKNOWN':'SUCCEEDED_READBACK_PENDING'};}
   await operations.completeMetaBillingDiagnostic(work.job,work.lease,appId,observation.diagnostic,observation.funding);
   assert.equal((await account()).state,'READY');assert.equal(postCount,1);
   managedAccepted=true;acceptedArrangement=approved.arrangementVersionId;
   return{...approved,policyVersionId:policy.policyVersionId,acceptance:policy.body?{body:policy.body,key:policy.key}:null,commercialTermsVersionId,runtimeEvidenceReceiptId:registration.receiptId,fundingOperationId:work.job.id};
  };
  const acceptCustomerTariff=async draftUuid=>{
   if(draftUuid!==null)assert.match(draftUuid,/^[a-f0-9-]{36}$/u);assert.equal(managedAccepted,false);
   const revision=Number((await account()).authority_revision);
   const policy=draftUuid===null?(await tx(app,tenantId,c=>c.query('SELECT app.accept_meta_customer_terms($1,$2,$3,$4,$5,$6) value',
    [connectionId,commercialTermsVersionId,null,revision,actorId,'customer-accept']))).rows[0].value
    :await acceptPublicTariff('CUSTOMER',draftUuid,null,'customer-accept');
   await controller.requestMetaBillingDiagnostic(request,connectionId,'customer-ready',{});const read=await claim();
   customerFunding=true;
   const present=await simulate(()=>new MetaGroupsAdapter({accessToken:token,graphVersion,phoneNumberIdFor:()=>phoneNumberId}).billingAccountProof(providerAccountId));
   await operations.completeMetaBillingDiagnostic(read.job,read.lease,appId,present.diagnostic,present.funding);
   assert.equal((await account()).state,'READY');
   return{policyVersionId:policy.policyVersionId,commercialTermsVersionId,evidenceMode:'SIMULATED',actualPayer:'UNVERIFIED'};
  };
  const refreshCurrency=async(value=observedCurrency,kind=currencyResponseKind)=>{
   assert.ok(['OBSERVED','MISSING','DENIED','MALFORMED','WRONG_ACCOUNT','EXPLICIT_NONE'].includes(kind));observedCurrency=value;currencyResponseKind=kind;
   await controller.requestMetaBillingDiagnostic(request,connectionId,`currency-${randomUUID()}`,{});const read=await claim();
   const present=await simulate(()=>new MetaGroupsAdapter({accessToken:token,graphVersion,phoneNumberIdFor:()=>phoneNumberId}).billingAccountProof(providerAccountId));
   await operations.completeMetaBillingDiagnostic(read.job,read.lease,appId,present.diagnostic,present.funding);return present.funding;
  };
  const acceptReplacementTariff=async draftUuid=>{
   assert.ok(acceptedArrangement,'A real managed arrangement must already be accepted');
   const policy=await acceptPublicTariff('MANAGED',draftUuid,acceptedArrangement,`replacement-${randomUUID()}`);
   await refreshCurrency();assert.equal((await account()).state,'READY');assert.equal(postCount,1,'Tariff replacement does not repeat the financial POST');
   return policy;
  };
  const queue=async({mentions=[],createdAt=new Date().toISOString()}={})=>{
   const id=randomUUID(),lease=randomUUID();
   await tx(app,tenantId,c=>c.query("INSERT INTO delivery_outbox(id,tenant_id,connection_id,group_workspace_group_id,delivery_origin,message_body,content_type,idempotency_key,state,attempts,lease_id,lease_expires_at,mentions,created_at) VALUES($1,$2,$3,$4,'GROUP_WORKSPACE','Synthetic historical managed effect','text/plain',$5,'CLAIMED',1,$6,clock_timestamp()+interval '120 seconds',$7,$8)",[id,tenantId,connectionId,groupId,`managed-${id}`,lease,mentions,createdAt]));
   await tx(worker,tenantId,c=>c.query("INSERT INTO delivery_attempts(tenant_id,delivery_id,attempt_number,state) VALUES($1,$2,1,'CLAIMED')",[tenantId,id]));
   const snapshot=(await tx(worker,tenantId,c=>c.query('SELECT meta_billing_snapshot FROM delivery_outbox WHERE tenant_id=$1 AND id=$2',[tenantId,id]))).rows[0].meta_billing_snapshot;
   return{lease,job:{id,tenantId,connectionId,groupId:'managed-fixture-group',recipientType:'GROUP',groupWorkspaceGroupId:groupId,text:'Synthetic historical managed effect',contentType:'text/plain',idempotencyKey:`managed-${id}`,attempts:1,provider:'meta',sessionId:phoneNumberId,connectionSecretReference:secretReference,
    metaCredentialContext:{providerSessionId:sessionId,phoneNumberId,wabaId:providerAccountId,proof},metaBillingSnapshot:snapshot,zammadBaseUrl:'https://zammad.invalid',zammadSecretReference:'unused'}};
  };
  // No auto-complete: consumer controls receipt-before-response and response-
  // before-receipt with the real repository methods on the returned job/lease.
  return{admin,tenantId,foreignTenantId,accountId,connectionId,commercialTermsVersionId,phoneNumberId,providerAccountId,
   actorId,app,worker,platform,tx,controller,request,readTariffOffer,acceptPublicTariff,financialPostCount:()=>postCount,outbox,operations,runtimeCandidate,queue,acceptManagedTariff,acceptCustomerTariff,acceptReplacementTariff,refreshCurrency,
   readback:async checkpointId=>{failedReadback=false;const queued=await platformCall('SELECT app.operator_queue_meta_funding_readback($1,$2,$3,$4,$5) value',[checkpointId,Number((await account()).authority_revision),`readback-${randomUUID()}`,'synthetic-mfa-operator','managed-readback']);const work=await claim();assert.equal(work.job.id,queued.operationId);const observed=await simulate(()=>executeMetaManagedFunding(work.job,work.lease,appId,operations,{resolve:async reference=>({accessToken:reference===secretReference?token:financialToken})},{readTransport:async()=>({transportBindingSha256:runtimeEvidence.transportBindingSha256}),readRuntime:async()=>runtimeCandidate}));await operations.completeMetaBillingDiagnostic(work.job,work.lease,appId,observed.diagnostic,observed.funding);assert.equal(postCount,1);return observed;},close};
 }catch(error){await close();throw error;}
}
