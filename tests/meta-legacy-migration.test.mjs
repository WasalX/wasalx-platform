import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { executeMetaLegacyMigration } from '../services/connector-worker/dist/services/connector-worker/src/meta-legacy-migration.js';
import { parseMetaTemplateInventoryItem } from '../packages/core/dist/meta-template-inventory.js';
import { buildMetaTemplateMapping } from '../packages/core/dist/meta-template-mapping.js';
import { verifyMetaCredentialMetadata } from '../packages/core/dist/meta-account-relation.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const id = tail => `20000000-0000-4000-8000-${String(tail).padStart(12, '0')}`;
const appId = '100000001', sourceAccount = '100000002', targetAccount = '100000003', phone = '100000004', business = '100000005';
const sourceToken = 'synthetic-legacy-source', targetToken = 'synthetic-legacy-target';
const rawItem = templateId => ({ id: templateId, name: 'order_update', language: 'en_US', status: 'APPROVED', category: 'UTILITY',
  parameter_format: 'POSITIONAL', quality_score: { score: 'GREEN' }, components: [{ type: 'BODY', text: 'Order {{1}} is ready.' }] });
const dependency = { flowVersionId: id(50), name: 'order_update', language: 'en_US', parameterCount: 1 };
const inventory = (accountId, templateId) => ({ accountId, complete: true, items: [parseMetaTemplateInventoryItem(rawItem(templateId))] });
function fixture({ stage = 'REGISTER', outcome = null, mode = 'SIMULATED', fault = null, changedPhone = false } = {}) {
  const sourceInventory = inventory(sourceAccount, '100000006'), targetInventory = inventory(targetAccount, '100000007');
  const mapping = buildMetaTemplateMapping({ source: sourceInventory, target: targetInventory,
    sourceSafetyRevision: 0, targetSafetyRevision: 0, dependencies: [dependency], metaFlowDependencyCount: 0 });
  const metadata = verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,
    scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0}},
    {appId,now:new Date(Date.now()-1000)});
  const asset = (accountId, providerAccountId, token, suffix) => ({ accountId, providerAccountId, connectionId:id(2),phoneId: phone,
    observedOwnerBusinessId: business, secretReference: `secret://${id(1)}/connections/${id(2)}/meta/${suffix}`,
    credentialProof: { credentialFingerprint: sha(token), credentialMetadata: metadata } });
  const context = { transitionId: id(3), revision: 3, stage, appId, graphVersion: 'v24.0',
    originalScopeSha256: 'b'.repeat(64), currentScopeSha256: 'b'.repeat(64), contextSha256: 'c'.repeat(64),
    source: asset(id(4), sourceAccount, sourceToken, 'source'), destination: asset(id(5), targetAccount, targetToken, 'target'),
    templates: { observationOperationId: id(6), observationSha256: 'd'.repeat(64), source: sourceInventory,
      sourceSafetyRevision: 0, targetSafetyRevision: 0, dependencies: [dependency], metaFlowDependencyCount: 0, originalMapping: mapping },
    registerAdmission: { evidenceMode: 'SIMULATED', eligibilityReceiptId: id(7), providerContractSha256: 'e'.repeat(64),
      runtimeEvidenceReceiptId: id(8), authorizationOperationId: id(9), confirmationOperationId: id(10), templateObservationOperationId: id(6),
      sourceTwoStepRequirement: 'PROVIDER_CONFIRMED', destinationFunding: 'VERIFIED', scopeCurrent: true,
      drainClear: true, sourceServiceQuiesced: true, expiresAt: new Date(Date.now() + 60_000).toISOString() } };
  if (changedPhone) context.destination.phoneId = '199999999';
  const state = { checkpoint: outcome ? { id: id(11), outcome } : null, posts: 0, claims: 0, readbacks: [], reconciles: 0,
    registered: outcome !== null, requests: [], recordFailure: false, drift: false, resolutions: 0 };
  const execution = { mode, runtimeEvidenceReceiptId: id(8), runtimeEvidenceSha256: 'f'.repeat(64), transportBindingSha256: '1'.repeat(64) };
  const store = {
    context: async () => ({ ...context, contextSha256: state.drift ? '0'.repeat(64) : context.contextSha256 }),
    resolveExecution: async () => { state.resolutions++; return execution; },
    originalCheckpoint: async () => state.checkpoint,
    reserveOriginalRegister: async (_job, _lease, requestSha, contextSha, actual) => {
      assert.equal(contextSha, context.contextSha256); assert.match(requestSha, /^[a-f0-9]{64}$/u); assert.deepEqual(actual, execution);
      if (state.checkpoint) return { disposition: 'HISTORICAL_NO_POST', checkpoint: state.checkpoint };
      state.claims++; state.checkpoint = { id: id(11), outcome: 'ATTEMPTED' };
      return { disposition: 'NEW_ATTEMPT', id: id(11), reservationToken: id(12) };
    },
    recordOriginalRegister: async (_job, slot, result) => {
      assert.equal(slot.id, id(11)); if (state.recordFailure) throw new Error('Synthetic receipt write failed');
      state.checkpoint.outcome = result;
    },
    recordReadback: async (_job, _lease, contextSha, observed) => {
      assert.equal(contextSha, context.contextSha256); state.readbacks.push(observed); return true;
    },
    reconcile: async () => { state.reconciles++; return true; },
  };
  const fetcher = async (input, init) => {
    const url = new URL(input); state.requests.push([init.method, url.pathname]);
    assert.equal(url.origin, 'https://graph.facebook.com');
    if (url.pathname.endsWith('/register')) {
      assert.equal(state.checkpoint?.outcome, 'ATTEMPTED'); assert.equal(state.claims, 1); state.posts++; state.registered = true;
      assert.deepEqual(JSON.parse(init.body), { messaging_product: 'whatsapp', pin: '246810' });
      if (fault === 'disconnect') throw new Error('Synthetic accepted disconnect');
      if (fault === 'malformed') return Response.json({ id: 'unexpected' });
      return Response.json({ success: true });
    }
    if (url.pathname.endsWith('/owned_whatsapp_business_accounts')) return Response.json({ data: [{ id: sourceAccount }, { id: targetAccount }] });
    if (url.pathname.endsWith('/message_templates')) return Response.json({ data: [rawItem(url.pathname.includes(sourceAccount) ? '100000006' : '100000007')] });
    if (url.pathname.endsWith('/subscribed_apps')) return Response.json({ data: [{ whatsapp_business_api_data: { id: appId } }] });
    if (url.pathname.endsWith('/phone_numbers')) return Response.json({ data: [{ id: phone, display_phone_number: '+1 555 0100',
      status: state.registered ? 'CONNECTED' : 'PENDING', code_verification_status: 'VERIFIED', account_mode: 'LIVE', host_platform: 'CLOUD_API' }] });
    if (url.pathname === `/v24.0/${phone}` && url.searchParams.get('fields') === 'health_status') return Response.json({ health_status: {
      can_send_message: 'AVAILABLE', entities: [{ entity_type: 'PHONE_NUMBER', id: phone, can_send_message: 'AVAILABLE' },
        { entity_type: 'WABA', id: targetAccount, can_send_message: 'AVAILABLE' }, { entity_type: 'APP', id: appId, can_send_message: 'AVAILABLE' }] } });
    if (url.pathname === `/v24.0/${phone}`) return Response.json({ id: phone, is_on_biz_app: false, platform_type: 'CLOUD_API' });
    if (url.pathname === `/v24.0/${targetAccount}` && url.searchParams.get('fields') === 'primary_funding_id') {
      if (fault === 'funding-unavailable') return Response.json({error:{code:10}},{status:403});
      return Response.json({id:targetAccount,primary_funding_id:'synthetic-template-target-payment'});
    }
    if ([`/v24.0/${sourceAccount}`, `/v24.0/${targetAccount}`].includes(url.pathname)) return Response.json({ id: url.pathname.split('/').at(-1), owner_business: { id: business } });
    assert.fail(`Unexpected synthetic route ${url.pathname}`);
  };
  const job = { id: id(20), tenantId: id(1), connectionId: id(2), fencingToken: 1,
    payload: { metaLegacyMigration: { id: id(3), stage } } };
  const secrets = { resolve: async reference => ({ accessToken: reference.endsWith('/source') ? sourceToken : targetToken, registrationPin: '246810' }) };
  const dependencies = { readTransport: async () => ({ transportBindingSha256: '1'.repeat(64) }),
    readRuntime: async () => ({ receiptId: id(8), descriptor: {}, descriptorSha256: 'f'.repeat(64) }) };
  return { context, state, store, execution, async run() { const previous = globalThis.fetch; globalThis.fetch = fetcher;
    try { await executeMetaLegacyMigration(job, id(21), appId, store, secrets, dependencies); }
    finally { globalThis.fetch = previous; } } };
}

test('separate legacy stage commits one original slot before registration and preserves exact template mapping', async () => {
  const f = fixture(); await f.run(); assert.equal(f.state.posts, 1); assert.equal(f.state.claims, 1);
  assert.equal(f.state.checkpoint.outcome, 'SUCCEEDED'); assert.equal(f.state.readbacks.length, 1); assert.equal(f.state.reconciles, 0);
  assert.equal(f.state.readbacks[0].templateMapping.mappings[0].targetTemplateId, '100000007');
  assert.equal(f.state.resolutions, 2);
  await assert.rejects(f.run); assert.equal(f.state.posts, 1); assert.equal(f.state.claims, 1);
});
for (const fault of ['disconnect', 'malformed']) test(`uncertain ${fault} registration is never issued again; equal readback cannot reconcile`, async () => {
  const f = fixture({ fault }); await assert.rejects(f.run); assert.equal(f.state.posts, 1); assert.equal(f.state.checkpoint.outcome, 'UNKNOWN');
  f.context.stage = 'RECONCILE'; await assert.rejects(f.run);
  assert.equal(f.state.posts, 1); assert.equal(f.state.claims, 1); assert.equal(f.state.reconciles, 0);
  assert.equal(f.state.readbacks.length,0,'A rejected reconciliation cannot publish only its readback');
  f.context.stage='OBSERVE';await f.run();
  assert.equal(f.state.readbacks.at(-1).originalOutcome, 'UNKNOWN');
});
test('failed local result write preserves ATTEMPTED and no registration replay', async () => {
  const f = fixture(); f.state.recordFailure = true; await assert.rejects(f.run, /receipt write/);
  assert.equal(f.state.checkpoint.outcome, 'ATTEMPTED'); f.context.stage = 'OBSERVE'; f.state.recordFailure = false;
  await f.run(); assert.equal(f.state.posts, 1); assert.equal(f.state.claims, 1); assert.equal(f.state.readbacks.at(-1).originalOutcome, 'ATTEMPTED');
});
test('known original success permits readback-only reconcile', async () => {
  const f = fixture({ stage: 'RECONCILE', outcome: 'SUCCEEDED' }); await f.run();
  assert.equal(f.state.posts, 0); assert.equal(f.state.claims, 0); assert.equal(f.state.reconciles, 1);
  assert.equal(f.state.readbacks.length,0,'The dedicated readback writer is not a separate pre-reconcile commit');
});
test('the complete fresh readback reaches one atomic reconciliation call; a local failure never restages registration',async()=>{
  const f=fixture({stage:'RECONCILE',outcome:'SUCCEEDED'});
  let calls=0;
  f.store.reconcile=async(_job,_lease,contextSha,observation)=>{
    calls++;assert.equal(contextSha,f.context.contextSha256);assert.equal(observation.originalOutcome,'SUCCEEDED');
    assert.equal(observation.originalCheckpointId,f.state.checkpoint.id);
    assert.equal(observation.templateMapping.mappings[0].targetTemplateId,'100000007');
    throw new Error('Synthetic successor rollback');
  };
  await assert.rejects(f.run,/successor rollback/u);
  assert.equal(calls,1);assert.equal(f.state.readbacks.length,0);assert.equal(f.state.posts,0);
  assert.equal(f.state.checkpoint.outcome,'SUCCEEDED');
});
for (const mode of ['LIVE', 'UNKNOWN']) test(`current unavailable legacy capability cannot authorize ${mode} registration`, async () => {
  const f = fixture({ mode }); await assert.rejects(f.run); assert.equal(f.state.posts, 0); assert.equal(f.state.claims, 0);
});
test('missing eligibility and changed phone ID fail before provider reads or mutation', async () => {
  for (const f of [fixture({ changedPhone: true }), fixture()]) {
    f.context.registerAdmission = null; await assert.rejects(f.run); assert.equal(f.state.requests.length, 0); assert.equal(f.state.posts, 0);
  }
});

test('only explicit known-success observation reads exact target funding; uncertain outcomes retain null evidence',async()=>{
  for(const outcome of ['SUCCEEDED','UNKNOWN','ATTEMPTED']){
    const f=fixture({stage:'OBSERVE',outcome});await f.run();
    const proof=f.state.readbacks[0].fundingProof;
    if(outcome==='SUCCEEDED'){
      assert.equal(proof.accountId,targetAccount);assert.equal(proof.primaryFundingId,'synthetic-template-target-payment');
      assert.equal(proof.actualPayer,'UNVERIFIED');assert.equal(proof.status,'PRESENT');assert.equal(Object.keys(proof).length,9);
      assert.equal(Date.parse(proof.expiresAt)-Date.parse(proof.observedAt),15*60_000);
    }else assert.equal(proof,null);
    assert.equal(f.state.posts,0);assert.equal(f.state.claims,0);assert.equal(f.state.checkpoint.outcome,outcome);
  }
});
test('explicit observation uses its current identity context without replacing the original effect scope',async()=>{
 const f=fixture({stage:'OBSERVE',outcome:'SUCCEEDED'});f.context.currentScopeSha256='9'.repeat(64);
 await f.run();assert.equal(f.state.readbacks.length,1);assert.ok(f.state.readbacks[0].fundingProof);
 assert.equal(f.context.originalScopeSha256,'b'.repeat(64));assert.equal(f.state.posts,0);assert.equal(f.state.claims,0);
 assert.equal(f.state.reconciles,0);assert.equal(f.state.checkpoint.outcome,'SUCCEEDED');
});
test('identity changes after the initial observation context block the next provider request',async()=>{
 const f=fixture({stage:'OBSERVE',outcome:'SUCCEEDED'}),original=f.store.context;let reads=0;
 f.store.context=async()=>{const value=await original();return ++reads===1?value:{...value,currentScopeSha256:'9'.repeat(64)};};
 await assert.rejects(f.run);assert.equal(f.state.requests.length,0);assert.equal(f.state.readbacks.length,0);
 assert.equal(f.state.posts,0);assert.equal(f.state.claims,0);assert.equal(f.state.checkpoint.outcome,'SUCCEEDED');
});
test('failed funding GET cannot publish a successful recovery readback or reopen registration',async()=>{
  const f=fixture({stage:'OBSERVE',outcome:'SUCCEEDED',fault:'funding-unavailable'});
  await assert.rejects(f.run);assert.equal(f.state.readbacks.length,0);assert.equal(f.state.posts,0);assert.equal(f.state.claims,0);
  assert.equal(f.state.checkpoint.outcome,'SUCCEEDED');
});
