import test from 'node:test';
import assert from 'node:assert/strict';
import { gowsDeliveryIds, observeGowsReceiptRows } from '../scripts/release/simulation-gows-receipt-stage.mjs';

const passedRows = () => [
  { testId: gowsDeliveryIds[0], result: 'passed', proof: { deliveryId: 'group-delivery' } },
  { testId: gowsDeliveryIds[1], result: 'passed', proof: { outbox: [{ id: 'direct-delivery' }] } },
];

function browser(currentState = 'Sent') {
  let viewport = { width: 1024, height: 768 };
  const visits = [];
  const waitFor = async () => {};
  const status = { innerText: async () => currentState };
  const current = { getByRole: () => ({ waitFor }), locator: () => status };
  const heading = { waitFor };
  const dialog = { waitFor, getByRole: () => ({ waitFor }), locator: () => ({ filter: ({has}) => { assert.equal(has, heading, 'has must be relative to the section, without a dialog ancestor'); return current; } }) };
  let url = 'https://portal.example/app', responseListener;
  const response = { url: () => url.replace('/app?view=deliveries&delivery=', '/api/deliveries/'), request: () => ({ method: () => 'GET' }), status: () => 200 };
  return { visits, page: { on: (event, listener) => { assert.equal(event, 'response'); responseListener = listener; }, off: (event, listener) => { assert.equal(event, 'response'); assert.equal(listener, responseListener); responseListener = undefined; }, setViewportSize: async value => { viewport = value; }, viewportSize: () => viewport, evaluate: async () => 'en', goto: async value => { url = value; visits.push(value); responseListener?.(response); }, url: () => url, getByRole: (role, options) => { if (role === 'heading') { assert.deepEqual(options, {name: 'Current delivery state', exact: true}); return heading; } return dialog; } } };
}

test('retained GOWS effects are rendered in owner desktop without replay', async () => {
  const { page, visits } = browser();
  const stable = [{ id: 'group-delivery', state: 'SENT' }, { id: 'direct-delivery', state: 'SENT' }];
  const provider = { receipts: ['retained'] };
  const checkpoints = [];
  const result = await observeGowsReceiptRows({ page, portalOrigin: 'https://portal.example', rows: passedRows(), verifyOwner: async () => ({ userMatched: true, workspaceMatched: true }), ownerId: 'owner', tenantId: 'tenant', providerRead: async () => provider, readStable: async ids => (assert.deepEqual(ids, ['group-delivery', 'direct-delivery']), stable), checkpoint: async row => checkpoints.push(row) });
  assert.deepEqual(visits, ['https://portal.example/app?view=deliveries&delivery=group-delivery', 'https://portal.example/app?view=deliveries&delivery=direct-delivery']);
  assert(result.every(row => row.result === 'passed' && row.contextId === 'tenant_owner-en-desktop' && row.proof.ownerUi.visible && row.proof.ownerUi.detailStatus === 200 && row.proof.ownerUi.phase === 'verify-owner-after' && row.proof.noProviderReplay));
  assert.deepEqual(result.map(row => row.actualViewport), [{ width: 1440, height: 1000 }, { width: 1440, height: 1000 }]);
  assert.equal(checkpoints.length, 2);
  assert(result.every(row => row.proof.actorVerified && row.verifiedContext.role === 'tenant_owner' && row.verifiedContext.viewport.width === 1440));
  assert.deepEqual(page.viewportSize(), { width: 1024, height: 768 });
});

test('GOWS owner observation preserves blocked rows and fails closed on effect drift', async () => {
  const { page } = browser();
  let providerRead = 0;
  const blocked = { testId: gowsDeliveryIds[0], result: 'blocked', proof: { blockedByTestId: 'upstream' } };
  const rows = [blocked, passedRows()[1]];
  await assert.rejects(observeGowsReceiptRows({ page, portalOrigin: 'https://portal.example', rows, verifyOwner: async () => ({ userMatched: true, workspaceMatched: true }), ownerId: 'owner', tenantId: 'tenant', providerRead: async () => ({ receipts: providerRead++ ? ['changed'] : ['retained'] }), readStable: async () => [{ id: 'direct-delivery', state: 'SENT' }], checkpoint: async () => {} }), /changed retained effects/);
  assert.deepEqual(rows[0], blocked);
});

test('GOWS owner observation reads the current-state status instead of timeline history', async () => {
  const { page } = browser('Delivered');
  const rows = passedRows();
  const result = await observeGowsReceiptRows({ page, portalOrigin: 'https://portal.example', rows, verifyOwner: async () => ({ userMatched: true, workspaceMatched: true }), ownerId: 'owner', tenantId: 'tenant', providerRead: async () => ({ receipts: ['retained Sent history'] }), readStable: async ids => ids.map(id => ({ id, state: 'SENT' })), checkpoint: async () => {} });
  assert(result.every(row => row.result === 'failed' && row.proof.ownerUi.visible === false && row.proof.ownerUi.phase === 'current-state' && row.proof.ownerUi.detailStatus === 200));
});
