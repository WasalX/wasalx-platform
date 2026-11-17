import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { q083RetainedNavigationTestIds, validateQ083Sources } from '../scripts/release/simulation-q083-navigation-continuation.mjs';

const candidate = { sha: 'a'.repeat(40), tree: 'b'.repeat(40) };
const failureText = 'owned observer drain';
const failureHash = createHash('sha256').update(failureText).digest('hex');
const hashes = Object.fromEntries(['setup', 'dispatch', 'manifest', 'terminal', 'failure', 'observation', 'intents'].map(name => [name, name[0].repeat(64)]));
const paths = { setup: 'setup.8117-v5-q083.json', dispatch: 'dispatch.8117-v5-q083.json', manifest: 'manifest.8117-v5-q083.json', terminal: 'qualification-app-q083.result.json', failure: 'scenario-fresh399-8117-v5-q083/launcher-failure.json', observation: 'q083-monitor-observation.json', intents: 'scenario-fresh399-8117-v5-q083/intents.jsonl' };
const sources = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, { path, sha256: hashes[name] }]));
const manifestTestIds = Array.from({ length: 152 }, (_, index) => 'test-' + index);
const retained = { namespace: 'fresh399-8117-v5-q083', outcomes: { passed: 0, failed: 0, blocked: 0, unexecuted: 152 }, mappedTestIds: q083RetainedNavigationTestIds, sources, manifestTestIds };
const shell = (suffix, result, proof, offset) => ({ phase: 'shell-quality', suffix, result, startedAt: `2026-09-13T12:00:${String(offset).padStart(2, '0')}.000Z`, finishedAt: `2026-09-13T12:00:${String(offset).padStart(2, '0')}.500Z`, proof });
function fixture() {
  const artifacts = Object.fromEntries([['setup', 'setup'], ['dispatch', 'dispatch'], ['manifest', 'manifest'], ['result', 'terminal'], ['intents', 'intents'], ['launcherFailure', 'failure']].map(([artifact, name]) => [artifact, { sha256: hashes[name] }]));
  return {
    setup: { namespace: retained.namespace, retainedQ082: { derivedFailureIds: ['ticket-1', 'ticket-2'] } },
    dispatch: { namespace: retained.namespace, application: { root: '/candidate', ...candidate }, manifest: { sha256: hashes.manifest } },
    manifest: { namespace: retained.namespace, evidenceMode: 'simulated', scope: 'selected-vertical', requiredTestIds: manifestTestIds },
    terminal: { namespace: retained.namespace, evidenceMode: 'simulated', scope: 'selected-vertical', status: 'terminal', exitCode: 1, applicationSha: candidate.sha, applicationTree: candidate.tree, toolingSha: 'c'.repeat(40), manifestSha256: hashes.manifest, dispatchSha256: hashes.dispatch },
    failure: { error: failureText },
    observation: { namespace: retained.namespace, evidenceMode: 'simulated', scope: 'selected-vertical', disposition: 'terminal-consumed-never-retry-never-replay', bindings: { applicationSha: candidate.sha, applicationTree: candidate.tree, toolingSha: 'c'.repeat(40), toolingTree: 'd'.repeat(40), manifestSha256: hashes.manifest, dispatchSha256: hashes.dispatch }, terminal: { testCounts: { selected: 152, passed: 0, failed: 0, blocked: 0, unexecuted: 152, terminalTestRows: 0, distinctTerminalTestIds: 0 }, stageObservationsNotCountedAsSelectedTests: { observedSuffixes: { loading: 'failed', degraded: 'passed', reload: 'passed', 'keyboard-focus': 'passed', empty: 'passed' } }, failure: { classification: 'test-harness-owned-request-observer-drain', message: 'observer failed', observerMessageSha256: failureHash, mutations: 0, workspaceBindingsUnchanged: true, productFailureEstablished: false, effectUncertain: false } }, supportingRetainedFailures: { count: 2, sourceNamespace: 'fresh399-8117-v5-q082', coverageKind: 'retained-proof-completion', selectedByQ083Manifest: false, result: 'failed', notApplied: true, httpStatus: 500, noReplay: true, testIds: ['ticket-1', 'ticket-2'] }, effects: { eventInboxCreated: 0, deliveryOutboxCreated: 0, normalizedMessagesCreated: 0, messageLinksCreated: 0, groupActionExecutionsCreated: 0, connectionOperationsCreated: 0, botFlowOperationsCreated: 0, provider: { before: { receivedSends: 27, receipts: 27 }, newSends: 0, newReceipts: 0, after: { receivedSends: 27, receipts: 27, pending: 0 } }, smtp: { changedDuringQ083: false } }, safetyReadback: { unsettledEvents: 0, unsettledDeliveries: 0, unknownOutcomeDeliveries: 0, unsettledConnectionOperations: 0, unsettledGroupActions: 0, cleanup: { expected: 7, closed: 7 } }, artifacts },
    intents: [
      shell('loading', 'failed', { errorClass: 'AssertionError' }, 1),
      shell('degraded', 'passed', { protectedApplication: true, visibleRetryRestoredSameWorkspace: true }, 2),
      shell('reload', 'passed', { reloaded: true, sameWorkspace: true }, 3),
      shell('keyboard-focus', 'passed', { keyboardOpened: true, escapeReturnsSummary: true, workspaceUnchanged: true }, 4),
      shell('empty', 'passed', { actualEmptyFilter: true, clearRestoresRecords: true }, 5),
      { phase: 'shell-quality-safety', mutations: 0, workspaceBindingsUnchanged: true, observerDrain: { messageSha256: failureHash } },
      { phase: 'cleanup', results: Array.from({ length: 7 }, (_, index) => ({ name: 'owned-' + index, status: 'closed' })) },
    ],
  };
}

test('q083 immutable shell evidence maps nine exact tests and preserves reload as supporting only', () => {
  const result = validateQ083Sources(fixture(), { candidate, retained });
  assert.deepEqual(result.mapped.map(row => row.testId), q083RetainedNavigationTestIds);
  assert.equal(result.mapped.filter(row => row.result === 'failed').length, 2);
  assert.equal(result.mapped.filter(row => row.result === 'passed').length, 7);
  assert.equal(result.reload.suffix, 'reload');
});

test('q083 retained evidence fails closed when zero-effect truth changes', () => {
  const source = fixture(); source.observation.effects.provider.newSends = 1;
  assert.throws(() => validateQ083Sources(source, { candidate, retained }));
});
