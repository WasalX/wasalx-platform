import assert from 'node:assert/strict';
import test from 'node:test';
import { isLegacyPage, isLegacyView, parseLegacyIntent, legacyActionResultMatches, legacyCreateResultMatches, legacyCancelSuperseded, legacyIntentKey, legacyIntentSettled, type LegacyIntent } from '../lib/meta-legacy-intent.ts';
import type { MetaLegacyMigrationView } from '../packages/core/src/meta-legacy-migration-contract.ts';
const id = (n: number) => `66000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const original: LegacyIntent = { version: 1, action: 'REGISTER', key: id(3), operationId: id(4), planId: id(2), body: { expectedRevision: 5, expectedReviewSha256: 'a'.repeat(64), confirmCutover: true } };
const view = (): MetaLegacyMigrationView => ({ id: id(2), revision: 7, sourceConnection: { id: id(1), name: 'Source' }, destinationAccount: { label: 'Destination', paymentResponsibility: 'CUSTOMER' }, state: 'OUTCOME_UNKNOWN', reviewSha256: 'b'.repeat(64), expiresAt: null, reasons: ['PROVIDER_OUTCOME_UNRESOLVED'], capability: { live: false, qualificationOnly: true }, impact: { sourceConnections: 2, destinationConnections: 1, inheritedFlowVersions: 2, templates: 3, keepsOriginalHistory: true, result: 'PAUSED' }, authorization: { targetConnectionId: id(1), targetLegacyMigrationId: id(2), canPrepare: true, canContinue: false }, actions: { observe: true, register: false, reconcile: false, cancel: false }, originalRegistration: { outcome: 'UNKNOWN', attemptedAt: '2026-10-08T00:00:00Z' }, pendingAction: { operationId: id(4), requestKey: id(3), action: 'REGISTER', requestRevision: 5, state: 'SUCCEEDED' } });
test('retained migration commands are bounded, nonsecret, and partitioned by actor/workspace/source', () => {
  assert.deepEqual(parseLegacyIntent(JSON.stringify(original)), original);
  for (const other of [['b', 'a', id(1)], ['a', 'b', id(1)], ['a', 'a', id(9)]]) assert.notEqual(legacyIntentKey('a', 'a', id(1)), legacyIntentKey(other[0]!, other[1]!, other[2]!));
  for (const value of ['{', ' '.repeat(8193), JSON.stringify({ ...original, key: 'invalid' }), JSON.stringify({ ...original, body: { ...original.body, token: 'never' } }), JSON.stringify({ ...original, body: { expectedRevision: 5, expectedReviewSha256: 'a'.repeat(64), confirmCutover: false } })]) assert.throws(() => parseLegacyIntent(value));
});
test('exact local operation settlement never settles the separate original registration UNKNOWN', () => {
  assert.equal(legacyIntentSettled(original, view(), id(1)), true);
  for (const patch of [{ requestKey: id(9) }, { operationId: id(9) }, { action: 'OBSERVE' }, { requestRevision: 6 }, { state: 'RUNNING' }, { operationId: null }]) assert.equal(legacyIntentSettled(original, { ...view(), pendingAction: { ...view().pendingAction, ...patch } }, id(1)), false);
  for (const patch of [{ id: id(9) }, { pendingAction: null }, { revision: 100, pendingAction: null }]) assert.equal(legacyIntentSettled(original, { ...view(), ...patch }, id(1)), false);
  assert.equal(legacyIntentSettled(original, view(), id(9)), false);
  assert.equal(legacyActionResultMatches(original, { id: id(2), operationId: id(4), duplicate: true, pendingAction: view().pendingAction }), true);
  assert.equal(legacyActionResultMatches(original, { id: id(2), operationId: id(9), duplicate: true, pendingAction: view().pendingAction }), false);
  assert.equal(view().originalRegistration?.outcome, 'UNKNOWN');
});
test('both create race orders require the original body/key; latest plan alone never settles create', () => {
  const intent: LegacyIntent = { version: 1, action: 'CREATE', key: id(3), operationId: null, planId: null, body: { templateObservationOperationId: id(8), expectedSourceBindingRevision: 2, expectedTargetBindingRevision: 3 } };
  const result = { requestKey: id(3), request: intent.body, operationId: id(4), duplicate: true, id: null, state: 'NO_EFFECT' };
  assert.equal(legacyCreateResultMatches(intent, result), true);
  assert.equal(legacyCreateResultMatches(intent, { ...result, state: 'ADMITTED', id: id(2) }), true);
  for (const patch of [{ requestKey: id(9) }, { id: id(9) }, { operationId: null }, { request: { ...intent.body, expectedTargetBindingRevision: 9 } }, { request: { ...intent.body, providerId: 'never' } }]) assert.equal(legacyCreateResultMatches(intent, { ...result, ...patch }), false);
  assert.equal(legacyIntentSettled({ ...intent, planId: id(2), operationId: id(4) }, view(), id(1)), false);
});
test('cancel alone uses exact successor or monotonic supersession; provider operations do not', () => {
  const cancel: LegacyIntent = { version: 1, key: id(3), operationId: null, action: 'CANCEL', planId: id(2), body: { expectedRevision: 5 } };
  const local = { ...view(), originalRegistration: null, pendingAction: null };
  assert.equal(legacyIntentSettled(cancel, { ...local, state: 'CANCELLED', revision: 6 }, id(1)), true);
  assert.equal(legacyCancelSuperseded(cancel, { ...local, state: 'REVIEW', revision: 6 }, id(1)), true);
  assert.equal(legacyCancelSuperseded(original, view(), id(1)), false);
  assert.equal(legacyIntentSettled(cancel, { ...local, state: 'CANCELLED', revision: 7 }, id(1)), false);
  assert.equal(legacyCancelSuperseded(cancel, { ...local, state: 'CANCELLED', revision: 7 }, id(1)), false);
});
test('views bind source and authorization purpose, keep live disabled and reject inconsistent mutation flags', () => {
  assert.equal(isLegacyPage({ currentPlan: view(), prepare: { templateObservationOperationId: id(8), sourceBindingRevision: 1, targetBindingRevision: 1 } }, id(1)), true);
  for (const patch of [{ sourceConnection: { id: id(9), name: 'Wrong' } }, { authorization: { ...view().authorization, targetLegacyMigrationId: id(9) } }, { capability: { live: true, qualificationOnly: true } }, { actions: { ...view().actions, register: true } }, { actions: { ...view().actions, cancel: true } }, { actions: { ...view().actions, reconcile: true } }, { impact: { ...view().impact, result: 'WORKING' } }, { reasons: ['INVENTED_REASON'] }]) assert.equal(isLegacyView({ ...view(), ...patch }, id(1)), false);
});

test('finite view enums reject non-string values without settling the retained original operation', () => {
  for (const malformed of [ ['READY'], { value: 'READY' }, null, 1, true ]) {
    const candidate = { ...view(), state: malformed };
    assert.equal(isLegacyView(candidate, id(1)), false);
    assert.equal(legacyIntentSettled(original, candidate, id(1)), false);
  }
  for (const malformed of [ ['CUSTOMER'], { value: 'CUSTOMER' }, null, 1, true ]) {
    const candidate = { ...view(), destinationAccount: { ...view().destinationAccount, paymentResponsibility: malformed } };
    assert.equal(isLegacyView(candidate, id(1)), false);
    assert.equal(legacyIntentSettled(original, candidate, id(1)), false);
  }
  for (const malformed of [ ['SUCCEEDED'], { value: 'SUCCEEDED' }, null, 1, true ]) {
    const candidate = { ...view(), originalRegistration: { ...view().originalRegistration, outcome: malformed } };
    assert.equal(isLegacyView(candidate, id(1)), false);
    assert.equal(legacyIntentSettled(original, candidate, id(1)), false);
  }
  const ready = { ...view(), state: 'READY', originalRegistration: null, pendingAction: null,
    actions: { observe: true, register: true, reconcile: false, cancel: true } };
  assert.equal(isLegacyView(ready, id(1)), true);
  assert.equal(isLegacyView({ ...ready, state: ['READY'] }, id(1)), false);
  assert.equal(isLegacyView({ ...ready, destinationAccount: { ...ready.destinationAccount, paymentResponsibility: ['CUSTOMER'] } }, id(1)), false);
});
