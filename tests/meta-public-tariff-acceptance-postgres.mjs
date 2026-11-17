import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createMetaManagedFundingFixture} from './meta-managed-funding-postgres.mjs';
import {createDraftTariff} from './meta-cost-postgres.mjs';

/** Real tenant controller/app role and existing platform actions. Synthetic
 * funding remains labelled synthetic. No acceptance or authority row is seeded. */
export async function verifyMetaPublicTariffAcceptance(options){
 const fixtures=[];const make=async()=>{const f=await createMetaManagedFundingFixture(options);fixtures.push(f);return f;};
 const account=async f=>{const row=(await f.tx(f.app,f.tenantId,c=>c.query(`SELECT a.authority_revision,a.state,a.requested_policy_version_id,a.active_policy_version_id,
  (SELECT count(*)::int FROM meta_billing_policy_versions p WHERE p.tenant_id=a.tenant_id AND p.account_id=a.id) AS policy_count,
  (SELECT count(*)::int FROM audit_events e WHERE e.tenant_id=a.tenant_id AND e.action='connection.meta_tariff_policy_requested') AS audit_count,
  (SELECT count(*)::int FROM connection_operations o WHERE o.tenant_id=a.tenant_id) AS operation_count
  FROM meta_messaging_accounts a WHERE a.tenant_id=$1 AND a.id=$2`,[f.tenantId,f.accountId]))).rows[0];
  // Financial checkpoint details are worker-only; retain that real role boundary.
  const checkpoints=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT id,outcome FROM meta_provider_effect_checkpoints WHERE tenant_id=$1 ORDER BY id',[f.tenantId]))).rows;
  return{...row,checkpoints};};
 const activate=async(f,id,body)=>(await f.tx(f.platform,f.tenantId,c=>c.query('SELECT app.operator_meta_cost($1,$2,$3,$4,$5,$6,$7) value',[
  'META_COST_ACTIVATE',f.tenantId,id,body,randomUUID(),'synthetic-mfa-operator','public-tariff-activation']))).rows[0].value;
 try{
  const customer=await make(),foreign=await make(),managed=await make();
  const draft=await createDraftTariff(customer,'CUSTOMER'),foreignDraft=await createDraftTariff(foreign,'CUSTOMER');
  const found=await customer.readTariffOffer('CUSTOMER',draft,null),offer=found.offer;
  const body={mode:'CUSTOMER',expectedRevision:found.revision,tariffVersionId:draft,tariffDefinitionSha256:offer.definitionSha256,documentSha256:offer.documentSha256,acceptedTerms:true};
  const rejected=async(input,request=customer.request,status)=>{const before=await account(customer);await assert.rejects(()=>customer.controller.requestMetaBillingPolicy(request,customer.connectionId,randomUUID(),input),error=>status===undefined||error.getStatus?.()===status);assert.deepEqual(await account(customer),before);};
  for(const input of [{...body,tariffDefinitionSha256:'0'.repeat(64)},{...body,documentSha256:'0'.repeat(64)},
   {...body,tariffVersionId:foreignDraft},{...body,expectedRevision:body.expectedRevision+1},{...body,acceptedTerms:false},
   {...body,evidenceMode:'LIVE'},{...body,commercialTermsVersionId:customer.commercialTermsVersionId},
   {...body,mode:'MANAGED',choiceId:randomUUID()}])await rejected(input,customer.request,
    input.acceptedTerms===false||Object.hasOwn(input,'evidenceMode')||Object.hasOwn(input,'commercialTermsVersionId')?400:409);
  await rejected(body,foreign.request);
  const source=(await customer.tx(customer.app,customer.tenantId,c=>c.query('SELECT definition FROM meta_cost_tariff_versions WHERE tenant_id=$1 AND id=$2',[customer.tenantId,draft]))).rows[0].definition;
  const invalidDraft=async changes=>(await customer.tx(customer.platform,customer.tenantId,c=>c.query('SELECT app.operator_meta_cost($1,$2,NULL,$3,$4,$5,$6) value',
   ['META_COST_DRAFT',customer.tenantId,{definition:{...source,...changes},supersedesId:null},randomUUID(),'synthetic-mfa-operator','public-negative-draft']))).rows[0].value;
  const hashTerms=(await customer.tx(customer.platform,customer.tenantId,c=>c.query('SELECT app.operator_register_meta_simulated_terms($1,$2,$3) value',[
   {schemaVersion:1,tenantId:customer.tenantId,accountId:customer.accountId,evidenceMode:'SIMULATED',documentSha256:'d'.repeat(64),termsVersion:'HASH_ONLY_HISTORY'},'synthetic-mfa-operator','public-hash-only']))).rows[0].value;
  for(const changes of [{purpose:'UPSTREAM_REFERENCE',commercialTermsVersionId:null},{evidenceMode:'LIVE'},
   {commercialTermsVersionId:foreign.commercialTermsVersionId},{commercialTermsVersionId:hashTerms.commercialTermsVersionId}]){
   const invalid=await invalidDraft(changes);await rejected({...body,tariffVersionId:invalid.id,tariffDefinitionSha256:invalid.definitionSha256},customer.request,409);
   const visible=(await customer.controller.metaBillingPolicy(customer.request,customer.connectionId,{tariffMode:'CUSTOMER'})).tariffOffers.items;
   assert.equal(visible.some(item=>item.id===invalid.id),false);
  }
  await rejected(body,{...customer.request,principal:{...customer.request.principal,authenticationMethods:[]}});
  // A genuine second active owner preserves the incumbent last-owner guard.
  await customer.admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')",[customer.tenantId,foreign.actorId]);
  await customer.admin.query("UPDATE tenant_memberships SET role='agent' WHERE tenant_id=$1 AND user_id=$2",[customer.tenantId,customer.actorId]);
  try{await rejected(body);}finally{await customer.admin.query("UPDATE tenant_memberships SET role='tenant_owner' WHERE tenant_id=$1 AND user_id=$2",[customer.tenantId,customer.actorId]);}
  await assert.rejects(()=>customer.controller.metaBillingPolicy({...customer.request,principal:{...customer.request.principal,role:'agent'}},customer.connectionId,{tariffMode:'CUSTOMER'}));
  const key=randomUUID(),accepted=await customer.controller.requestMetaBillingPolicy(customer.request,customer.connectionId,key,body);
  assert.deepEqual(accepted,{requestedMode:'CUSTOMER',state:'HELD',sendReady:false,replay:false});
  const after=await account(customer);assert.equal(after.active_policy_version_id,null);assert.equal(after.policy_count,2);
  const projection=(await customer.tx(customer.app,customer.tenantId,c=>c.query('SELECT * FROM app.meta_accepted_terms_projection($1,$2,$3)',[customer.tenantId,after.requested_policy_version_id,customer.commercialTermsVersionId]))).rows[0];
  assert.equal(projection.accepted_tariff_version_id,draft);assert.equal(projection.document_sha256,body.documentSha256);assert.equal(projection.evidence_mode,'SIMULATED');
  const activation=await activate(customer,draft,{expectedDefinitionSha256:offer.definitionSha256,policyVersionId:after.requested_policy_version_id});assert.equal(activation.state,'ACTIVE');
  assert.equal((await customer.controller.requestMetaBillingPolicy(customer.request,customer.connectionId,key,body)).replay,true);assert.deepEqual(await account(customer),after);
  await rejected({...body,expectedRevision:Number(after.authority_revision)},customer.request,409); // New key cannot accept an activated version; complete rollback.
  await assert.rejects(()=>customer.controller.requestMetaBillingPolicy(customer.request,customer.connectionId,key,{...body,expectedRevision:body.expectedRevision+1}),error=>error.getStatus?.()===409);assert.deepEqual(await account(customer),after);
  const other=await customer.controller.metaBillingPolicy(customer.request,customer.connectionId,{tariffMode:'CUSTOMER'});assert.equal(other.tariffOffers.items.some(v=>v.id===draft),false);
  // Every eligible version remains reachable; transport exposes no financial IDs.
  const ids=[];for(let i=0;i<12;i++)ids.push(await createDraftTariff(customer,'CUSTOMER'));
  let cursor;const visible=[];do{const page=(await customer.controller.metaBillingPolicy(customer.request,customer.connectionId,{tariffMode:'CUSTOMER',...(cursor?{tariffAfter:cursor}:{})})).tariffOffers;
   assert.ok(page.items.length<=10);for(const item of page.items){assert.equal(item.currency,'USD');assert.equal(item.rates[0].unitPrice,'0.005');
    for(const secret of ['tenantId','accountId','commercialTermsVersionId','sourceSha256','creditLineId','receivingCredentialId'])assert.equal(Object.hasOwn(item,secret),false);visible.push(item.id);}cursor=page.nextAfter;
  }while(cursor);assert.deepEqual(new Set(visible),new Set(ids));
  const managedDraft=await createDraftTariff(managed,'MANAGED');const funded=await managed.acceptManagedTariff(managedDraft);
  const managedTariff=(await managed.tx(managed.app,managed.tenantId,c=>c.query('SELECT definition_sha256 FROM meta_cost_tariff_versions WHERE tenant_id=$1 AND id=$2',[managed.tenantId,managedDraft]))).rows[0];
  assert.equal((await activate(managed,managedDraft,{expectedDefinitionSha256:managedTariff.definition_sha256,policyVersionId:funded.policyVersionId})).state,'ACTIVE');
  const managedPolicy=(await managed.tx(managed.app,managed.tenantId,c=>c.query('SELECT accepted_tariff_version_id FROM meta_billing_policy_versions WHERE tenant_id=$1 AND id=$2',[managed.tenantId,funded.policyVersionId]))).rows[0];assert.equal(managedPolicy.accepted_tariff_version_id,managedDraft);
  // The original public MANAGED body/key survives activation and changes no
  // account/policy/audit/checkpoint/operation/provider state on exact replay.
  const original=funded.acceptance;assert.ok(original);const managedBefore=await account(managed),postsBefore=managed.financialPostCount();
  const managedReplay=()=>managed.controller.requestMetaBillingPolicy(managed.request,managed.connectionId,original.key,original.body);
  assert.deepEqual(await managedReplay(),{requestedMode:'MANAGED',state:'HELD',sendReady:false,replay:true});
  assert.deepEqual(await account(managed),managedBefore);assert.equal(managed.financialPostCount(),postsBefore);
  const rejectReplay=async(input=original.body,request=managed.request,status)=>{
   const before=await account(managed);await assert.rejects(()=>managed.controller.requestMetaBillingPolicy(request,managed.connectionId,original.key,input),error=>status===undefined||error.getStatus?.()===status);
   assert.deepEqual(await account(managed),before);assert.equal(managed.financialPostCount(),postsBefore);
  };
  for(const input of [{...original.body,expectedRevision:original.body.expectedRevision+1},{...original.body,documentSha256:'0'.repeat(64)},
   {...original.body,tariffDefinitionSha256:'0'.repeat(64)},{...original.body,choiceId:randomUUID()},{...original.body,tariffVersionId:foreignDraft}])await rejectReplay(input,managed.request,409);
  await rejectReplay(original.body,foreign.request,404);
  await managed.admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')",[managed.tenantId,foreign.actorId]);
  await managed.admin.query("UPDATE tenant_memberships SET role='agent' WHERE tenant_id=$1 AND user_id=$2",[managed.tenantId,managed.actorId]);
  try{await rejectReplay();}finally{await managed.admin.query("UPDATE tenant_memberships SET role='tenant_owner' WHERE tenant_id=$1 AND user_id=$2",[managed.tenantId,managed.actorId]);}
  // Remove ACTIVE eligibility using the actual app-role guarded downgrade. No
  // identity/authority row is inserted, deleted or reactivated for this oracle.
  const held=await managed.tx(managed.app,managed.tenantId,c=>c.query("UPDATE meta_connection_account_bindings SET state='HELD',revision=revision+1 WHERE tenant_id=$1 AND connection_id=$2 AND state='ACTIVE' RETURNING id",[managed.tenantId,managed.connectionId]));assert.equal(held.rowCount,1);
  await rejectReplay(original.body,managed.request,409);
  // Privacy is tested on CUSTOMER's still-current binding, with its original key.
  // An actual pending tenant deletion hides offers and blocks new public consent.
  await customer.admin.query(`INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key)
   VALUES($1::uuid,$2::uuid,'DELETE','TENANT',$2::text,'DELETE_TICKETS',$3)`,[randomUUID(),customer.tenantId,randomUUID()]);
  assert.deepEqual((await customer.controller.metaBillingPolicy(customer.request,customer.connectionId,{tariffMode:'CUSTOMER'})).tariffOffers.items,[]);
  await rejected({...body,tariffVersionId:ids[0],expectedRevision:Number(after.authority_revision)},customer.request,409);
  const privacyBefore=await account(customer);await assert.rejects(()=>customer.controller.requestMetaBillingPolicy(customer.request,customer.connectionId,key,body),error=>error.getStatus?.()===409);assert.deepEqual(await account(customer),privacyBefore);
  return{mode:'SYNTHETIC_NOT_INSTALLED',publicCustomerAcceptance:true,publicManagedAcceptance:true,exactActivation:true,negativeRollback:true,immutableReplay:true,boundedOffers:true};
 }finally{for(const f of fixtures.reverse())await f.close();}
}
