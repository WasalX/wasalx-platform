import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadRetainedDirectSources } from './simulation-direct-continuation.mjs';
import { definitions } from './simulation-navigation-quality-definitions.mjs';
import { makeOwnedGetHandler } from './simulation-owned-get-boundary.mjs';
import { qualityRequestObservers } from './simulation-quality-request-observers.mjs';

const suffixOf = id => id.split('::').at(-1);
const sourceSuffix = id => suffixOf(id) === 'safe-error-recovery' ? 'degraded' : suffixOf(id);
const retainedSuffixes = new Set(['loading', 'degraded', 'keyboard-focus', 'empty']);
export const q083RetainedNavigationTestIds = definitions.filter(row => retainedSuffixes.has(sourceSuffix(row.id))).map(row => row.id);
export const q084NavigationTestIds = definitions.filter(row => ['network', 'console'].includes(suffixOf(row.id))).map(row => row.id);

const one = (rows, label) => { assert.equal(rows.length, 1, label); return rows[0]; };
export function validateQ083Sources(source, { candidate, retained }) {
  assert.equal(retained.namespace, 'fresh399-8117-v5-q083');
  assert.deepEqual(retained.outcomes, { passed: 0, failed: 0, blocked: 0, unexecuted: 152 });
  assert.deepEqual(retained.mappedTestIds, q083RetainedNavigationTestIds);
  assert.equal(source.setup.namespace, retained.namespace);
  assert.equal(source.dispatch.namespace, retained.namespace);
  assert.deepEqual(source.dispatch.application, { root: source.dispatch.application.root, sha: candidate.sha, tree: candidate.tree });
  assert.equal(source.dispatch.manifest.sha256, retained.sources.manifest.sha256);
  assert.equal(source.manifest.namespace, retained.namespace);
  assert.equal(source.manifest.evidenceMode, 'simulated');
  assert.equal(source.manifest.scope, 'selected-vertical');
  assert.deepEqual(source.manifest.requiredTestIds, retained.manifestTestIds);
  assert.equal(source.terminal.namespace, retained.namespace);
  assert.equal(source.terminal.evidenceMode, 'simulated');
  assert.equal(source.terminal.scope, 'selected-vertical');
  assert.equal(source.terminal.status, 'terminal');
  assert.equal(source.terminal.exitCode, 1);
  assert.equal(source.terminal.applicationSha, candidate.sha);
  assert.equal(source.terminal.applicationTree, candidate.tree);
  assert.equal(source.terminal.toolingSha, source.observation.bindings.toolingSha);
  assert.equal(source.terminal.manifestSha256, retained.sources.manifest.sha256);
  assert.equal(source.terminal.dispatchSha256, retained.sources.dispatch.sha256);

  const observation = source.observation;
  assert.equal(observation.namespace, retained.namespace);
  assert.equal(observation.evidenceMode, 'simulated');
  assert.equal(observation.scope, 'selected-vertical');
  assert.equal(observation.disposition, 'terminal-consumed-never-retry-never-replay');
  assert.equal(observation.bindings.applicationSha, candidate.sha);
  assert.equal(observation.bindings.applicationTree, candidate.tree);
  assert.match(observation.bindings.toolingSha, /^[a-f0-9]{40}$/u);
  assert.match(observation.bindings.toolingTree, /^[a-f0-9]{40}$/u);
  assert.equal(observation.bindings.manifestSha256, retained.sources.manifest.sha256);
  assert.equal(observation.bindings.dispatchSha256, retained.sources.dispatch.sha256);
  assert.deepEqual(observation.terminal.testCounts, { selected: 152, passed: 0, failed: 0, blocked: 0, unexecuted: 152, terminalTestRows: 0, distinctTerminalTestIds: 0 });
  assert.deepEqual(observation.terminal.stageObservationsNotCountedAsSelectedTests.observedSuffixes, { loading: 'failed', degraded: 'passed', reload: 'passed', 'keyboard-focus': 'passed', empty: 'passed' });
  assert.equal(observation.terminal.failure.classification, 'test-harness-owned-request-observer-drain');
  assert.equal(observation.terminal.failure.mutations, 0);
  assert.equal(observation.terminal.failure.workspaceBindingsUnchanged, true);
  assert.equal(observation.terminal.failure.productFailureEstablished, false);
  assert.equal(observation.terminal.failure.effectUncertain, false);
  assert.equal(observation.supportingRetainedFailures.count, 2);
  assert.equal(observation.supportingRetainedFailures.sourceNamespace, 'fresh399-8117-v5-q082');
  assert.equal(observation.supportingRetainedFailures.result, 'failed');
  assert.equal(observation.supportingRetainedFailures.notApplied, true);
  assert.equal(observation.supportingRetainedFailures.httpStatus, 500);
  assert.equal(observation.supportingRetainedFailures.noReplay, true);
  assert.equal(observation.supportingRetainedFailures.selectedByQ083Manifest, false);
  assert.equal(observation.supportingRetainedFailures.coverageKind, 'retained-proof-completion');
  assert.deepEqual(observation.supportingRetainedFailures.testIds, source.setup.retainedQ082.derivedFailureIds);
  for (const key of ['eventInboxCreated', 'deliveryOutboxCreated', 'normalizedMessagesCreated', 'messageLinksCreated', 'groupActionExecutionsCreated', 'connectionOperationsCreated', 'botFlowOperationsCreated']) assert.equal(observation.effects[key], 0);
  assert.equal(observation.effects.provider.before.receivedSends, observation.effects.provider.after.receivedSends);
  assert.equal(observation.effects.provider.before.receipts, observation.effects.provider.after.receipts);
  assert.deepEqual({ sends: observation.effects.provider.newSends, receipts: observation.effects.provider.newReceipts, pending: observation.effects.provider.after.pending }, { sends: 0, receipts: 0, pending: 0 });
  assert.equal(observation.effects.smtp.changedDuringQ083, false);
  assert.deepEqual({ events: observation.safetyReadback.unsettledEvents, deliveries: observation.safetyReadback.unsettledDeliveries, unknown: observation.safetyReadback.unknownOutcomeDeliveries, operations: observation.safetyReadback.unsettledConnectionOperations, actions: observation.safetyReadback.unsettledGroupActions }, { events: 0, deliveries: 0, unknown: 0, operations: 0, actions: 0 });
  assert.deepEqual({ expected: observation.safetyReadback.cleanup.expected, closed: observation.safetyReadback.cleanup.closed }, { expected: 7, closed: 7 });
  for (const [artifact, sourceName] of [['setup', 'setup'], ['dispatch', 'dispatch'], ['manifest', 'manifest'], ['result', 'terminal'], ['intents', 'intents'], ['launcherFailure', 'failure']]) assert.equal(observation.artifacts[artifact].sha256, retained.sources[sourceName].sha256);

  assert.equal(createHash('sha256').update(source.failure.error).digest('hex'), observation.terminal.failure.observerMessageSha256);
  const selected = source.intents.filter(row => retained.manifestTestIds.includes(row.testId) && ['passed', 'failed', 'blocked'].includes(row.result));
  assert.equal(selected.length, 0, 'q083 emitted no selected terminal rows');
  const shell = source.intents.filter(row => row.phase === 'shell-quality');
  assert.deepEqual(shell.map(row => [row.suffix, row.result]), [['loading', 'failed'], ['degraded', 'passed'], ['reload', 'passed'], ['keyboard-focus', 'passed'], ['empty', 'passed']]);
  assert(shell.every(row => row.startedAt && row.finishedAt && Date.parse(row.startedAt) <= Date.parse(row.finishedAt)));
  assert.equal(shell[0].proof.errorClass, 'AssertionError');
  assert.deepEqual({ protected: shell[1].proof.protectedApplication, recovered: shell[1].proof.visibleRetryRestoredSameWorkspace }, { protected: true, recovered: true });
  assert.deepEqual({ reloaded: shell[2].proof.reloaded, sameWorkspace: shell[2].proof.sameWorkspace }, { reloaded: true, sameWorkspace: true });
  assert.deepEqual({ keyboardOpened: shell[3].proof.keyboardOpened, focusReturned: shell[3].proof.escapeReturnsSummary, unchanged: shell[3].proof.workspaceUnchanged }, { keyboardOpened: true, focusReturned: true, unchanged: true });
  assert.deepEqual({ empty: shell[4].proof.actualEmptyFilter, restored: shell[4].proof.clearRestoresRecords }, { empty: true, restored: true });
  const safety = one(source.intents.filter(row => row.phase === 'shell-quality-safety'), 'q083 shell safety');
  assert.deepEqual({ mutations: safety.mutations, unchanged: safety.workspaceBindingsUnchanged, drain: safety.observerDrain.messageSha256 }, { mutations: 0, unchanged: true, drain: observation.terminal.failure.observerMessageSha256 });
  const cleanup = one(source.intents.filter(row => row.phase === 'cleanup'), 'q083 cleanup');
  assert.equal(cleanup.results.length, 7);
  assert(cleanup.results.every(row => row.status === 'closed'));
  const mapped = definitions.filter(row => retained.mappedTestIds.includes(row.id)).map(definition => ({ ...one(shell.filter(row => row.suffix === sourceSuffix(definition.id)), definition.id), testId: definition.id }));
  const reload = one(shell.filter(row => row.suffix === 'reload'), 'q083 reload observation');
  return { mapped, reload };
}

async function collectNetworkConsole(session) {
  const page = session.ownerPage, origin = session.portalOrigin, path = '/api/workspaces', network = [], errors = [], mutations = [], observer = qualityRequestObservers(page, origin, network, errors);
  const read = () => page.evaluate(async () => { const response = await fetch('/api/workspaces', { cache: 'no-store' }); if (!response.ok) throw Error('Workspace read failed'); return (await response.json()).data.map(row => ({ id: row.id, current: row.current, role: row.role })); });
  const before = await read();
  const guard = async route => { const request = route.request(); if (new URL(request.url()).origin === origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) { mutations.push(new URL(request.url()).pathname); return route.abort(); } return route.fallback(); };
  const pageError = error => errors.push({ kind: 'pageerror', name: error.name, classification: 'unclassified' });
  const consoleError = message => { if (message.type() !== 'error') return; let sourcePath; try { sourcePath = new URL(message.location().url).pathname; } catch {/* Missing or invalid locations remain unclassified. */} errors.push({ kind: 'console', sourcePath, messageSha256: createHash('sha256').update(message.text()).digest('hex'), classification: sourcePath === path && /Failed to load resource.*503/.test(message.text()) ? 'owned503' : 'unclassified' }); };
  page.on('request', observer.onRequest); page.on('requestfinished', observer.finished); page.on('requestfailed', observer.failed); page.on('pageerror', pageError); page.on('console', consoleError); await page.route('**/api/**', guard);
  try {
    let seen = 0; const handler = makeOwnedGetHandler({ origin, path, mode: 'error', onSeen: () => seen++ }); await page.route('**/api/**', handler);
    try { await observer.navigate(origin + '/app?view=overview'); const alert = page.getByRole('alert').filter({ hasText: 'Workspace access could not be verified' }); await alert.waitFor(); assert(seen > 0); await page.unroute('**/api/**', handler); await alert.getByRole('button', { name: 'Try again', exact: true }).click(); await page.locator('.app-shell:not([inert])').waitFor({ state: 'visible', timeout: 15000 }); } finally { await page.unroute('**/api/**', handler); }
    await observer.flush();
    const failures = network.filter(row => row.status >= 400 || row.status === 0);
    assert(failures.some(row => row.path === path && row.status === 503));
    assert(failures.every(row => row.path === path && row.status === 503 || row.classification === 'owned navigation cancellation'));
    assert(errors.every(row => row.classification === 'owned503'));
    const at = new Date().toISOString();
    return [{ suffix: 'network', result: 'passed', startedAt: at, finishedAt: at, proof: { requests: network.length, failures: failures.length, classifications: [...new Set(failures.map(row => row.classification ?? 'owned503'))] } }, { suffix: 'console', result: 'passed', startedAt: at, finishedAt: at, proof: { errors: errors.length, classified: errors.every(row => row.classification === 'owned503'), privateTextExcluded: true } }];
  } finally {
    await page.unroute('**/api/**', guard); page.off('request', observer.onRequest); page.off('requestfinished', observer.finished); page.off('requestfailed', observer.failed); page.off('pageerror', pageError); page.off('console', consoleError);
    assert.equal(mutations.length, 0); assert.deepEqual(await read(), before);
  }
}

export async function q083NavigationContinuationStage(session, { namespace, inputs, config }) {
  assert(session.actorBinding?.userMatched && session.actorBinding?.workspaceMatched);
  assert.equal(inputs.group?.evidenceMode, 'simulated'); assert.equal(inputs.group.namespace, namespace); assert.equal(inputs.group.tenantId, session.tenantId);
  await session.verifyOwner(session.ownerPage); await session.ownerPage.setViewportSize({ width: 1440, height: 1000 });
  const retained = validateQ083Sources(await loadRetainedDirectSources(session, config.retainedQ083.sources), { candidate: session.candidate, retained: config.retainedQ083 });
  const current = await collectNetworkConsole(session);
  const fresh = definitions.filter(row => q084NavigationTestIds.includes(row.id)).map(definition => ({ ...one(current.filter(row => row.suffix === suffixOf(definition.id)), definition.id), testId: definition.id }));
  const freshBound = fresh.map(row => ({ ...row, viewport: session.ownerPage.viewportSize(), contextId: config.contextId, actorBinding: session.actorBinding, tenantId: session.tenantId }));
  for (const row of freshBound) await session.checkpoint({ phase: 'navigation-quality-mapped', ...row });
  const bind = row => ({ ...row, viewport: session.ownerPage.viewportSize(), contextId: config.contextId, actorBinding: session.actorBinding, tenantId: session.tenantId, coverageKind: 'retained-proof-completion', retainedFrom: { namespace: config.retainedQ083.namespace, sources: config.retainedQ083.sources } });
  const mapped = [...retained.mapped.map(bind), ...freshBound];
  const results = definitions.map(definition => one(mapped.filter(row => row.testId === definition.id), definition.id));
  results.push(bind({ ...retained.reload, testId: 'supporting:q083:shell-quality:reload' }));
  return { evidenceMode: 'simulated', namespace, tenantId: session.tenantId, results, noReplay: true, noProviderSends: true };
}
