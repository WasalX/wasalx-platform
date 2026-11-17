import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createMetaManagedFundingFixture} from './meta-managed-funding-postgres.mjs';
import {parseMetaAccountPolicyBirthV2,parseHistoricalEffectAssessment} from '../packages/core/dist/meta-account-policy.js';
/** Called by the integrated P10 gate, whose actual draft function consumes the
 * returned account and terms IDs. This file never inserts tariff/authority rows.
 * Caller owns the isolated database; each fixture owns only its pools/env. */
export async function verifyMetaManagedFixtureProducers(options,createDraftTariff){
 const managed=await createMetaManagedFundingFixture(options);let customer;
 try{
  customer=await createMetaManagedFundingFixture(options);
  assert.notEqual(managed.phoneNumberId,customer.phoneNumberId);
  assert.notEqual(managed.providerAccountId,customer.providerAccountId);
  for(const [fixture,mode] of [[managed,'MANAGED'],[customer,'CUSTOMER']]){
   const draft=await createDraftTariff(fixture,mode);
   const accepted=mode==='MANAGED'?await fixture.acceptManagedTariff(draft):await fixture.acceptCustomerTariff(draft);
   const queued=await fixture.queue(),before=JSON.stringify(queued.job.metaBillingSnapshot);
   assert.equal(parseMetaAccountPolicyBirthV2(queued.job.metaBillingSnapshot).payment.mode,mode);
   await fixture.outbox.beginSend(queued.job,queued.lease);
   await fixture.outbox.admitMetaMessageRequest(queued.job,queued.lease,'b'.repeat(64),fixture.runtimeCandidate);
   const stored=(await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query(`SELECT a.meta_billing_admission,
    encode(digest(d.meta_billing_snapshot::text,'sha256'),'hex') birth_sha
    FROM delivery_outbox d JOIN delivery_attempts a ON a.tenant_id=d.tenant_id AND a.delivery_id=d.id
    WHERE d.tenant_id=$1 AND d.id=$2 AND a.attempt_number=1`,[fixture.tenantId,queued.job.id]))).rows[0];
   assert.equal(stored.meta_billing_admission.birthDigest.sha256,stored.birth_sha);
   assert.equal(JSON.stringify(stored.meta_billing_admission.snapshot),before);
   assert.equal(stored.meta_billing_admission.snapshot.policyVersionId,accepted.policyVersionId);
   const external=`synthetic-producer-${randomUUID()}`;
   await fixture.outbox.complete(queued.job,queued.lease,'SENT',external);
   const historical=(await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query('SELECT app.resolve_meta_message_effect($1,$2,$3) value',[fixture.tenantId,queued.job.id,external]))).rows[0].value;
   assert.equal(parseHistoricalEffectAssessment(historical).state,'ATTRIBUTED');
   assert.equal(historical.admission.birthDigest.sha256,stored.birth_sha);
   const unknown=await fixture.queue();await fixture.outbox.beginSend(unknown.job,unknown.lease);
   await fixture.outbox.admitMetaMessageRequest(unknown.job,unknown.lease,'c'.repeat(64),fixture.runtimeCandidate);
   await fixture.outbox.outcomeUnknown(unknown.job,unknown.lease,'Synthetic unknown Messages outcome');
   const unresolved=(await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query('SELECT app.resolve_meta_message_effect($1,$2,$3) value',[fixture.tenantId,unknown.job.id,'unobserved-external-id']))).rows[0].value;
   assert.equal(parseHistoricalEffectAssessment(unresolved).state,'UNKNOWN_ATTRIBUTION');
   await fixture.tx(fixture.platform,fixture.tenantId,c=>c.query('SELECT app.operator_withdraw_meta_runtime($1,$2,$3)',
    [fixture.runtimeCandidate.receiptId,'synthetic-mfa-operator','historical-runtime-withdraw']));
   const withdrawn=(await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query('SELECT app.resolve_meta_runtime_execution($1,$2,$3,$4,$5,$6) value',
    [fixture.tenantId,fixture.accountId,fixture.runtimeCandidate.receiptId,fixture.runtimeCandidate.descriptor,fixture.runtimeCandidate.descriptorSha256,fixture.runtimeCandidate.descriptor.transportBindingSha256]))).rows[0].value;
   assert.equal(withdrawn.mode,'UNKNOWN');
   const retained=(await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query('SELECT app.resolve_meta_message_effect($1,$2,$3) value',[fixture.tenantId,queued.job.id,external]))).rows[0].value;
   assert.deepEqual(retained,historical,'Runtime withdrawal cannot rewrite historical effect');
  }
 }finally{await customer?.close();await managed.close();}
}
