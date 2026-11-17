import assert from 'node:assert/strict';
import test from 'node:test';
import { isTemplatePage, isTemplateView, parseTemplateIntent, templateActionResultMatches, templateCreateResultMatches, templateCancelSuperseded, templateIntentKey, templateIntentSettled, type TemplateIntent } from '../lib/meta-template-intent.ts';
import type { MetaTemplatePreparationView } from '../packages/core/src/meta-template-preparation-contract.ts';

const id = (n: number) => `65000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const copy: TemplateIntent = { version: 1, key: id(3), operationId: id(4), planId: id(2), action: 'COPY', body: { expectedRevision: 5, expectedObservationSha256: 'a'.repeat(64), choices: [id(6)] } };
const view = (): MetaTemplatePreparationView => ({ id: id(2), revision: 7, sourceConnection: { id: id(1), name: 'Source' }, targetConnection: { id: id(8), name: 'Target' }, state: 'READY', observationSha256: 'b'.repeat(64),
  observedAt: '2026-10-08T00:00:00Z', expiresAt: '2026-10-09T00:00:00Z', choices: [], reasons: [], actions: { observe: true, copy: false, reconcile: true, cancel: false },
  originalCopy: { outcome: 'UNKNOWN', attemptedAt: '2026-10-08T00:00:00Z' }, canCutOver: false,
  pendingAction: { operationId: id(4), requestKey: id(3), action: 'COPY', requestRevision: 5, state: 'SUCCEEDED' } });

test('original intent retains exact subset and scope across reload; malformed or expanded stored commands cannot dispatch', () => {
  assert.deepEqual(parseTemplateIntent(JSON.stringify(copy)), copy);
  assert.equal(parseTemplateIntent(null), null);
  assert.notEqual(templateIntentKey('tenant-a', 'actor-a', id(1)), templateIntentKey('tenant-a', 'actor-b', id(1)));
  assert.notEqual(templateIntentKey('tenant-a', 'actor-a', id(1)), templateIntentKey('tenant-b', 'actor-a', id(1)));
  for (const value of ['{', ' '.repeat(32769), JSON.stringify({ ...copy, key: 'wrong' }), JSON.stringify({ ...copy, body: { ...copy.body, token: 'forbidden' } }), JSON.stringify({ ...copy, body: { ...copy.body, choices: [] } }), JSON.stringify({ ...copy, body: { ...copy.body, choices: [id(6), id(6)] } })]) assert.throws(() => parseTemplateIntent(value));
});
test('only exact persisted operation evidence settles a local request; readiness alone does not', () => {
  assert.equal(templateIntentSettled(copy, view(), id(1)), true);
  for (const change of [{ requestKey: id(9) }, { operationId: id(9) }, { action: 'OBSERVE' }, { requestRevision: 6 }, { state: 'RUNNING' }, { operationId: undefined }]) {
    assert.equal(templateIntentSettled(copy, { ...view(), pendingAction: { ...view().pendingAction, ...change } }, id(1)), false);
  }
  assert.equal(templateIntentSettled(copy, { ...view(), pendingAction: null }, id(1)), false);
  assert.equal(templateIntentSettled(copy, { ...view(), id: id(9) }, id(1)), false);
  assert.equal(templateIntentSettled(copy, view(), id(9)), false);
  assert.equal(templateIntentSettled(copy, { ...view(), canCutOver: true }, id(1)), false);
  // Operation settlement never rewrites the separate original external effect.
  assert.equal(view().originalCopy?.outcome, 'UNKNOWN');
  assert.equal(templateActionResultMatches(copy, { id: id(2), operationId: id(4), duplicate: true, pendingAction: view().pendingAction }), true);
  assert.equal(templateActionResultMatches(copy, { id: id(2), operationId: id(9), duplicate: true, pendingAction: view().pendingAction }), false);
});
test('collection resolution binds original request/key and only its null-plan no-effect tombstone', () => {
  const intent: TemplateIntent = { version: 1, key: id(3), operationId: null, planId: null, action: 'CREATE', body: { targetConnectionId: id(8), expectedAccountRevision: 2, expectedBindingRevision: 3 } };
  const result = { requestKey: id(3), request: intent.body, operationId: id(4), duplicate: true, state: 'NO_EFFECT', id: null, pendingAction: null };
  assert.equal(templateCreateResultMatches(intent, result), true);
  for (const replacement of [{ requestKey: id(9) }, { request: { ...intent.body, targetConnectionId: id(9) } }, { request: { ...intent.body, expectedBindingRevision: 4 } }, { id: id(9) }, { pendingAction: view().pendingAction }, { operationId: null }]) assert.equal(templateCreateResultMatches(intent, { ...result, ...replacement }), false);
  const admitted = { ...result, state: 'ADMITTED', id: id(2), pendingAction: { ...view().pendingAction, action: 'OBSERVE', requestRevision: 1 } };
  assert.equal(templateCreateResultMatches(intent, admitted), true);
  assert.equal(templateCreateResultMatches({ ...intent, planId: id(2), operationId: id(4) }, result), false);
  assert.equal(templateIntentSettled({ ...intent, planId: id(2), operationId: id(4) }, { ...view(), pendingAction: admitted.pendingAction }, id(1)), true);
});
test('provider-free cancel goal requires exact plan and successor revision', () => {
  const intent: TemplateIntent = { version: 1, action: 'CANCEL', key: id(3), operationId: null, planId: id(2), body: { expectedRevision: 5 } };
  assert.equal(templateIntentSettled(intent, { ...view(), state: 'CANCELLED', revision: 6 }, id(1)), true);
  assert.equal(templateCancelSuperseded(intent, { ...view(), state: 'HELD', revision: 6 }, id(1)), true);
  assert.equal(templateCancelSuperseded(intent, { ...view(), state: 'CANCELLED', revision: 7 }, id(1)), false);
  assert.equal(templateCancelSuperseded(copy, view(), id(1)), false);
  for (const revision of [5, 7]) assert.equal(templateIntentSettled(intent, { ...view(), state: 'CANCELLED', revision }, id(1)), false);
});
test('read projection is bounded and source-bound before enabling actions', () => {
  assert.equal(isTemplatePage({ prepare: { accountRevision: 2, bindingRevision: 3, targets: [] }, currentPlan: view() }, id(1)), true);
  for (const change of [{ sourceConnection: { id: id(9), name: 'Foreign' } }, { actions: { copy: true } }, { choices: [{ id: id(6), name: 'existing', language: 'en', selectable: true, compatibility: 'DIFFERENT' }] }, { observationSha256: 'bad' }, { choices: [{ id: id(6), name: 'x', language: 'en', selectable: 'true', compatibility: 'MISSING' }] }]) assert.equal(isTemplateView({ ...view(), ...change }, id(1)), false);
});
