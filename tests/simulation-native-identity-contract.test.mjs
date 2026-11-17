import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHandoverPreconditions, assertNativeLoginDenial, buildGovernedHandoverInput, currentProjectionDisposition, waitForNativeProjectionSettlement } from '../scripts/release/simulation-native-identity-contract.mjs';

test('native login requires a credential denial, never a server error or successful session', () => {
  const body = () => ({ data: { login: { session: null, twoFactorRequired: null, errors: [{ message: 'Login failed. Check your credentials.' }] } } });
  assert.doesNotThrow(() => assertNativeLoginDenial(200, 'application/json; charset=utf-8', body()));
  for (const status of [401, 403, 404, 500]) assert.throws(() => assertNativeLoginDenial(status, 'application/json', body()));
  assert.throws(() => assertNativeLoginDenial(200, 'text/html', body()));
  for (const mutate of [value => value.errors = [{ message: 'Server unavailable' }], value => value.data.login.session = { id: 'unexpected' }, value => value.data.login.twoFactorRequired = {}, value => value.data.login.errors = [], value => value.data.login.errors[0].message = 'Invalid authenticity token']) {
    const value = body(); mutate(value); assert.throws(() => assertNativeLoginDenial(200, 'application/json', value));
  }
});

const row = { user_id: 'member', revision: 3, native_user_id: '12' };
test('unknown and adoption outcomes are held and never replayed automatically', () => {
  for (const state of ['UNAVAILABLE', 'CONFLICT', 'ADOPTION_REQUIRED', 'PROTECTED'])
    assert.deepEqual(currentProjectionDisposition({ enabled: true, members: [{ ...row, sync_state: state }] }, 'member'), { kind: 'held', state, noReplay: true });
  assert.deepEqual(currentProjectionDisposition({ enabled: true, members: [{ ...row, sync_state: 'PENDING' }] }, 'member'), { kind: 'pending', noReplay: true });
  assert.deepEqual(currentProjectionDisposition({ enabled: true, members: [{ ...row, sync_state: 'READY' }] }, 'member'), { kind: 'ready', revision: 3, nativeUserId: '12' });
});

test('handover rejects missing bootstrap OIDC or stale human projection before native effects', () => {
  const owner = { state: 'READY', memberState: 'ACTIVE', role: 'tenant_owner', revision: 2, appliedRevision: 2, nativeUserId: '17' };
  const legacy = { active: true, admin: true, nativeUserId: '1', oidcAuthorizationId: '7', oidcSubject: 'synthetic-bootstrap', runtimeTokenId: '10', privacyTokenId: '11' };
  const installed = { candidate_commit_sha: 'a'.repeat(40), candidate_tree_sha: 'b'.repeat(40), native_package_sha256: 'c'.repeat(64) };
  assert.equal(assertHandoverPreconditions({ owner, legacy, installed }), true);
  assert.throws(() => assertHandoverPreconditions({ owner, legacy: { ...legacy, oidcAuthorizationId: null }, installed }));
  assert.throws(() => assertHandoverPreconditions({ owner: { ...owner, appliedRevision: 1 }, legacy, installed }));
  assert.throws(() => assertHandoverPreconditions({ owner, legacy: { ...legacy, nativeUserId: '17' }, installed }));
  const input = buildGovernedHandoverInput({ action: 'PREPARE', operationId: '00000000-0000-4000-8000-000000000001', tenantId: '00000000-0000-4000-8000-000000000001', instanceId: '00000000-0000-4000-8000-000000000003', owner: { ...owner, userId: '00000000-0000-4000-8000-000000000002', subject: 'synthetic-owner' }, legacy, installed, expectedRevision: 0, expectedReceiptSha256: null, expectedGroupGrantsSha256: 'd'.repeat(64) });
  assert.equal(input.action, 'PREPARE');
  assert.equal(input.human_native_user_id, '17');
  assert.equal(input.legacy_oidc_authorization_id, '7');
  assert.throws(() => buildGovernedHandoverInput({ action: 'BIND', operationId: input.operation_id, tenantId: input.tenant_id, instanceId: input.instance_id, owner: { ...owner, userId: input.human_portal_user_id, subject: input.human_subject }, legacy, installed, expectedRevision: 1, expectedReceiptSha256: null, expectedGroupGrantsSha256: 'd'.repeat(64) }));
});

const projectionStatus = (state, memberState = 'ACTIVE', revision = 1) => ({ enabled: true, members: [
  { user_id: 'owner', sync_state: 'READY', member_state: 'ACTIVE', revision: 1, applied_revision: 1, native_user_id: '11' },
  { user_id: 'member', sync_state: state, member_state: memberState, revision, applied_revision: state === 'READY' ? revision : revision - 1, native_user_id: '12' },
] });
const twoActors = [{ userId: 'owner', memberState: 'ACTIVE', revision: 1 }, { userId: 'member', memberState: 'ACTIVE', revision: 1 }];
function settlementReader(statuses) {
  let at = 0, reads = 0;
  const budgets = [];
  return {
    read: async budget => { budgets.push(budget); return structuredClone(statuses[Math.min(reads++, statuses.length - 1)]); },
    clock: { timeoutMs: 1000, pollMs: 500, now: () => at, sleep: async ms => { at += ms; } },
    summary: () => ({ at, reads, budgets }),
  };
}

test('initial owner and member poll observes the original in-flight fence without replay', async () => {
  const first = projectionStatus('PENDING'); first.members[0] = { ...first.members[0], sync_state: 'UNAVAILABLE', applied_revision: 0, native_user_id: null };
  const observation = settlementReader([first, projectionStatus('READY')]);
  const ready = await waitForNativeProjectionSettlement(observation.read, twoActors, observation.clock);
  assert(ready.members.every(row => row.sync_state === 'READY'));
  assert.deepEqual(observation.summary(), { at: 500, reads: 2, budgets: [1000, 500] });
});

test('lifecycle suspension and restoration use the same bounded read-only settlement rule', async () => {
  for (const [memberState, revision] of [['SUSPENDED', 2], ['ACTIVE', 3]]) {
    const observation = settlementReader([projectionStatus('UNAVAILABLE', memberState, revision), projectionStatus('READY', memberState, revision)]);
    const ready = await waitForNativeProjectionSettlement(observation.read, [{ userId: 'member', memberState, revision }], observation.clock);
    assert.equal(ready.members[1].applied_revision, revision);
    assert.equal(observation.summary().reads, 2);
  }
});

test('persistent unknown and pending states stop at the finite deadline without another read', async () => {
  for (const state of ['UNAVAILABLE', 'PENDING']) {
    const observation = settlementReader([projectionStatus(state)]);
    await assert.rejects(() => waitForNativeProjectionSettlement(observation.read, twoActors, observation.clock), /deadline; preserve original intent; no replay/);
    assert.deepEqual(observation.summary(), { at: 1000, reads: 2, budgets: [1000, 500] });
  }
});

test('terminal identity conflicts stop immediately instead of using the in-flight observation window', async () => {
  for (const state of ['CONFLICT', 'ADOPTION_REQUIRED', 'PROTECTED']) {
    const observation = settlementReader([projectionStatus(state), projectionStatus('READY')]);
    await assert.rejects(() => waitForNativeProjectionSettlement(observation.read, twoActors, observation.clock), /owner reconciliation.*no automatic replay/);
    assert.equal(observation.summary().reads, 1);
    assert.equal(observation.summary().at, 0);
  }
});

test('settlement rejects changed identity scope, revision, state and stale READY assertions', async () => {
  const mutations = [
    value => value.members.pop(),
    value => value.members.push({ ...value.members[1] }),
    value => value.members[1].revision++,
    value => value.members[1].member_state = 'SUSPENDED',
    value => value.members[1].applied_revision = 0,
    value => value.members[1].native_user_id = null,
  ];
  for (const mutate of mutations) {
    const status = projectionStatus('READY'); mutate(status);
    const observation = settlementReader([status]);
    await assert.rejects(() => waitForNativeProjectionSettlement(observation.read, twoActors, observation.clock));
    assert.equal(observation.summary().reads, 1);
  }
});

test('read transport failure is not retried or reclassified as settled', async () => {
  let reads = 0;
  await assert.rejects(() => waitForNativeProjectionSettlement(async () => { reads++; throw Error('read failed'); }, twoActors), /read failed/);
  assert.equal(reads, 1);
});

test('a READY response arriving at the deadline cannot qualify the original operation', async () => {
  let at = 0, reads = 0;
  await assert.rejects(() => waitForNativeProjectionSettlement(async () => {
    reads++; at = 1000; return projectionStatus('READY');
  }, twoActors, { timeoutMs: 1000, pollMs: 500, now: () => at, sleep: async ms => { at += ms; } }), /exceeded settlement deadline; preserve original intent; no replay/);
  assert.equal(reads, 1);
});
