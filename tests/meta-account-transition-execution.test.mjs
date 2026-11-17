import assert from 'node:assert/strict';
import test from 'node:test';
import { MetaAccountTransitionCalls, parseMetaMigrationInitiation, parseMetaMigrationObservation,
  metaMigrationRecoveryId } from '../services/connector-worker/dist/packages/connectors/src/meta-account-transition-execute.js';
import { metaTransitionFundingPath, metaTransitionStageHolds, parseMetaTransitionExecutionAction }
  from '../packages/core/dist/meta-account-transition-execution.js';

const eligibility = () => ({ graphVersionQualified: true, adminAuthorityCurrent: true, variant: 'STANDARD',
  sourceCurrency: 'USD', targetCurrency: 'EUR', endpointCurrencyQualified: true, requestedMode: 'CUSTOMER',
  sourcePayment: 'CARD', replaceCustomerCard: false, managedAuthorityCurrent: false });
const facts = () => ({ eligibility: eligibility(), reservationCurrent: true, scopeCurrent: true,
  externalImpactSettled: true, drainClear: true, sourceAuthorityCurrent: true, runtimeCurrent: true,
  confirmationCurrent: true, existingStage: 'NONE', initiationSettlement: 'EXACT_MIGRATION_ID_ACCEPTED',
  observedStatus: 'READY_TO_COMPLETE', targetVerified: true, targetPaymentReady: true, continuityVerified: true });

test('currency-only customer request omits every finance field; approved managed request has exact line; completion has no invented body', async () => {
  const calls = [];
  const client = new MetaAccountTransitionCalls(async (...args) => { calls.push(args); return {}; });
  await client.initiate('101', 'EUR');
  await client.initiate('101', 'EUR', '202');
  await client.complete('mig_known');
  await client.observe('mig_known');
  assert.deepEqual(calls, [
    ['/101/set_payment_method_migration_intent', {method:'POST',body:{currency:'EUR'}}, 'mutation', true],
    ['/101/set_payment_method_migration_intent', {method:'POST',body:{currency:'EUR',extended_credit_id:'202'}}, 'mutation', true],
    ['/mig_known/resume_migration', {method:'POST'}, 'mutation', true],
    ['/mig_known', {method:'GET'}, 'read', false],
  ]);
});

test('opaque migration IDs remain one bounded segment; arbitrary URLs/encoded separators are never dispatched', async () => {
  let dispatched = 0;
  const client = new MetaAccountTransitionCalls(async () => { dispatched++; return {}; });
  for (const id of ['https://other.invalid/x', '../foreign', 'a/b', 'a%2fb', '', 'a\n', 'a'.repeat(257)]) {
    await assert.rejects(() => client.observe(id));
    await assert.rejects(() => client.complete(id));
  }
  assert.equal(dispatched, 0);
});

test('initiation uses its own response keys and preserves only a bounded recovery ID on malformed accepted response', () => {
  assert.deepEqual(parseMetaMigrationInitiation({migration_id:'mig_one',migration_status:'INITIATED'}),
    {migrationId:'mig_one',status:'INITIATED'});
  assert.throws(() => parseMetaMigrationInitiation({id:'mig_one',status:'INITIATED'}));
  const malformed = {migration_id:'mig_one',migration_status:'UNKNOWN_NEW_STATE',access_token:'synthetic-do-not-copy'};
  assert.throws(() => parseMetaMigrationInitiation(malformed));
  assert.equal(metaMigrationRecoveryId(malformed,'INITIATE'), 'mig_one');
  assert.equal(metaMigrationRecoveryId(malformed,'INITIATE','mig_foreign'), null);
  assert.equal(metaMigrationRecoveryId(malformed,'COMPLETE','mig_one'),null);
  assert.equal(metaMigrationRecoveryId({...malformed,id:'mig_other'},'INITIATE'),null);
  assert.equal(metaMigrationRecoveryId({id:'mig_one',status:'UNRECOGNIZED'},'COMPLETE','mig_one'),'mig_one');
});

test('readiness requires exact returned migration, target and currency; optional omissions cannot advance completion', () => {
  const good = {id:'mig_one',status:'READY_TO_COMPLETE',destination_waba:{id:'303',currency:'EUR',name:'ignored'}};
  assert.deepEqual(parseMetaMigrationObservation(good,'mig_one','EUR','303'),
    {migrationId:'mig_one',status:'READY_TO_COMPLETE',destination:{id:'303',currency:'EUR'}});
  for (const value of [{...good,id:'mig_other'},{...good,destination_waba:{id:'304',currency:'EUR'}},
    {...good,destination_waba:{id:'303',currency:'USD'}},{id:'mig_one',status:'COMPLETED'},
    {id:'mig_one',status:'UNRECOGNIZED',destination_waba:good.destination_waba}]) {
    assert.throws(() => parseMetaMigrationObservation(value,'mig_one','EUR','303'));
  }
  for (const status of ['FAILED','FAILED_TO_COMPLETE','REJECTED']) {
    assert.equal(parseMetaMigrationObservation({id:'mig_one',status},'mig_one','EUR').status,status);
  }
});

test('unsupported payment directions, currency/version and exclusions are held without inferring evidence', () => {
  assert.equal(metaTransitionFundingPath(eligibility()).path,'RETAIN_CUSTOMER_CARD');
  for (const sourcePayment of ['CARD','LINE']) {
    assert.equal(metaTransitionFundingPath({...eligibility(),requestedMode:'WASALX_MANAGED',managedAuthorityCurrent:true,sourcePayment}).path,
      sourcePayment==='CARD'?'CARD_TO_APPROVED_LINE':'LINE_TO_APPROVED_LINE');
  }
  for (const delta of [{sourcePayment:'LINE'},{replaceCustomerCard:true},{sourcePayment:'UNKNOWN'},
    {targetCurrency:'USD'},{variant:'COEXISTENCE'},{variant:'AUTHORIZED_AGENT'},{variant:'UNKNOWN'},
    {adminAuthorityCurrent:false},{graphVersionQualified:false},{endpointCurrencyQualified:false},
    {requestedMode:'WASALX_MANAGED',managedAuthorityCurrent:false}]) {
    const result=metaTransitionFundingPath({...eligibility(),...delta});
    assert.equal(result.path,null);assert.ok(result.holds.length);
  }
});

test('completion cannot reuse a provider slot or bypass target, full-scope, drain and explicit confirmation facts', () => {
  assert.deepEqual(metaTransitionStageHolds('COMPLETE',facts()),[]);
  for (const existingStage of ['ATTEMPTED','UNKNOWN','SUCCEEDED','REJECTED'])
    assert.ok(metaTransitionStageHolds('COMPLETE',{...facts(),existingStage}).includes('STAGE_ALREADY_ATTEMPTED'));
  for (const delta of [{reservationCurrent:false},{scopeCurrent:false},{externalImpactSettled:false},{drainClear:false},
    {sourceAuthorityCurrent:false},{runtimeCurrent:false},{confirmationCurrent:false},{initiationSettlement:'UNRESOLVED'},
    {observedStatus:'IN_PROGRESS'},{targetVerified:false},{targetPaymentReady:false},{continuityVerified:false}])
    assert.ok(metaTransitionStageHolds('COMPLETE',{...facts(),...delta}).length);
});

test('public effect command accepts only current revision and preview hash, never authority or provider identifiers', () => {
  const command={expectedRevision:2,expectedPreviewSha256:'a'.repeat(64)};
  assert.deepEqual(parseMetaTransitionExecutionAction(command),command);
  for (const delta of [{lineId:'123'},{sourceAccountId:'123'},{mode:'LIVE'},{targetId:'123'},
    {expectedRevision:'2'},{expectedRevision:0},{expectedPreviewSha256:'unbound'}])
    assert.throws(()=>parseMetaTransitionExecutionAction({...command,...delta}));
});
