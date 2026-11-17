import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMetaLegacyMigrationRequest, parseMetaLegacyMigrationActionRequest, parseMetaLegacyMigrationCancelRequest } from '../packages/core/dist/meta-legacy-migration-contract.js';
const create={templateObservationOperationId:'aAaAaAaA-bBbB-4CcC-8DdD-eEeEeEeEeEeE',expectedSourceBindingRevision:2,expectedTargetBindingRevision:3};
const action={expectedRevision:4,expectedReviewSha256:'a'.repeat(64)};
test('local cancel accepts only the original positive CAS revision',()=>{
 assert.deepEqual(parseMetaLegacyMigrationCancelRequest({expectedRevision:4}),{expectedRevision:4});
 for(const body of [{},{expectedRevision:'4'},{expectedRevision:0},{expectedRevision:4,force:true},null,[]])
  assert.throws(()=>parseMetaLegacyMigrationCancelRequest(body));
});
test('migration create takes only a local immutable observation and current revisions',()=>{
 assert.deepEqual(parseMetaLegacyMigrationRequest(create),create);
 for(const extra of [{legacy:true},{phoneNumberId:'123'},{destinationAccountId:'456'},{payer:'CUSTOMER'},{canRegister:true}])
  assert.throws(()=>parseMetaLegacyMigrationRequest({...create,...extra}));
 for(const expectedSourceBindingRevision of [0,-1,'2',Number.MAX_SAFE_INTEGER+1,null])
  assert.throws(()=>parseMetaLegacyMigrationRequest({...create,expectedSourceBindingRevision}));
});
test('only an exact REGISTER intent includes local cutover confirmation',()=>{
 for(const read of ['OBSERVE','RECONCILE']){
  assert.deepEqual(parseMetaLegacyMigrationActionRequest(action,read),action);
  assert.throws(()=>parseMetaLegacyMigrationActionRequest({...action,confirmCutover:true},read));
 }
 const register={...action,confirmCutover:true};assert.deepEqual(parseMetaLegacyMigrationActionRequest(register,'REGISTER'),register);
 for(const confirmCutover of [false,'true',1,null])assert.throws(()=>parseMetaLegacyMigrationActionRequest({...action,confirmCutover},'REGISTER'));
 assert.throws(()=>parseMetaLegacyMigrationActionRequest(action,'REGISTER'));
 assert.throws(()=>parseMetaLegacyMigrationActionRequest({...register,providerEligibility:true},'REGISTER'));
 assert.throws(()=>parseMetaLegacyMigrationActionRequest(action,'RETRY'));
});
