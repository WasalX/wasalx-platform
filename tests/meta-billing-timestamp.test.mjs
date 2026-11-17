import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseMetaAccountPolicyBirthV2,parseMetaMessageAdmissionV2} from '../packages/core/dist/meta-account-policy.js';
const sha='a'.repeat(64);
function birth(observedAt){return {schemaVersion:2,claim:'ACCOUNT_POLICY_BOUND',tenantId:randomUUID(),connectionId:randomUUID(),accountId:randomUUID(),providerAccountId:'123',identifierKind:'MESSAGING_ACCOUNT_ID',accountModel:'PHASE1_WABA_ALIAS',bindingId:randomUUID(),bindingRevision:1,accountAuthorityRevision:1,policyVersionId:randomUUID(),payment:{mode:'CUSTOMER',actualPayer:'UNVERIFIED',managed:null},funding:{responseSha256:sha,observedAt}};}
function admission(instant,snapshot){return {schemaVersion:2,claim:'MESSAGES_REQUEST_ADMITTED',attemptId:randomUUID(),attemptNumber:1,deliveryId:randomUUID(),admittedAt:instant,requestSha256:sha,birthDigest:{format:'pg-jsonb-text-v1',sha256:sha},snapshot,execution:{mode:'UNKNOWN',runtimeEvidenceReceiptId:null,runtimeEvidenceSha256:null,transportBindingSha256:null},funding:{responseSha256:sha,observedAt:instant,expiresAt:instant}};}
test('billing timestamps accept unchanged JS and explicit-zone PostgreSQL producer bytes',()=>{
 for(const instant of ['2026-10-08T00:00:00.000Z','2026-10-08T00:00:00+00:00','2026-10-08T03:00:00.123456+03:00','2026-10-07T19:00:00.1-05:00']){
  const snapshot=birth(instant),original=JSON.stringify(snapshot);
  assert.equal(parseMetaAccountPolicyBirthV2(snapshot),snapshot);
  const value=admission(instant,snapshot);assert.equal(parseMetaMessageAdmissionV2(value),value);
  assert.equal(JSON.stringify(snapshot),original);assert.equal(value.snapshot.funding.observedAt,instant);
 }
});
test('billing timestamps reject implicit zones, invalid dates and nonproducer spellings',()=>{
 for(const instant of ['2026-10-08T00:00:00','2026-10-08','2026-02-30T00:00:00Z','2026-10-08T24:00:00Z','2026-10-08T00:60:00Z','2026-10-08T00:00:60Z','2026-10-08T00:00:00.1234567Z','2026-10-08T00:00:00+24:00','2026-10-08 00:00:00Z','Infinity','']){
  assert.throws(()=>parseMetaAccountPolicyBirthV2(birth(instant)));
  assert.throws(()=>parseMetaMessageAdmissionV2(admission(instant,birth('2026-10-08T00:00:00.000Z'))));
 }
});
