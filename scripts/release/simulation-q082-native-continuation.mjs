import assert from 'node:assert/strict';
import { loadRetainedDirectSources } from './simulation-direct-continuation.mjs';
import { validateQ076NativeSources } from './simulation-q076-native-continuation.mjs';
import { failedQ081TicketResults, mergeQ081NativeResults, validateQ081Sources } from './simulation-q081-native-continuation.mjs';
import { reconcileNativeTicketOutcome } from './simulation-native-business-ticket.mjs';

const one = (rows, label) => { assert.equal(rows.length, 1, label); return rows[0]; };
export function validateQ082Sources(source, { candidate, project, retained }) {
  assert.equal(source.setup.namespace, retained.namespace);
  assert.equal(source.dispatch.namespace, retained.namespace);
  assert.equal(source.dispatch.application.sha, candidate.sha);
  assert.equal(source.dispatch.application.tree, candidate.tree);
  assert.equal(source.dispatch.manifest.sha256, retained.sources.manifest.sha256);
  assert.equal(source.manifest.namespace, retained.namespace);
  assert.equal(source.manifest.evidenceMode, 'simulated');
  assert.equal(source.manifest.scope, 'selected-vertical');
  assert.deepEqual(source.manifest.requiredTestIds, retained.manifestTestIds);
  assert.equal(source.admission.project, project);
  assert.equal(source.admission.evidenceMode, 'simulated');
  assert.deepEqual(source.admission.candidate, candidate);
  assert.equal(source.context.project, project);
  assert.equal(source.context.evidenceMode, 'simulated');
  assert.deepEqual(source.context.candidate, candidate);
  assert.equal(source.context.owner.role, 'tenant_owner');
  assert.equal(source.context.native.role, 'zammad_agent');
  assert.equal(source.context.locale, 'en');
  assert.equal(source.terminal.namespace, retained.namespace);
  assert.equal(source.terminal.evidenceMode, 'simulated');
  assert.equal(source.terminal.scope, 'selected-vertical');
  assert.equal(source.terminal.status, 'terminal');
  assert.equal(source.terminal.exitCode, 1);
  assert.equal(source.terminal.applicationSha, candidate.sha);
  assert.equal(source.terminal.applicationTree, candidate.tree);
  assert.equal(source.terminal.manifestSha256, retained.sources.manifest.sha256);
  assert.equal(source.terminal.dispatchSha256, retained.sources.dispatch.sha256);

  const observation = source.observation;
  assert.equal(observation.namespace, retained.namespace);
  assert.equal(observation.evidenceMode, 'simulated');
  assert.equal(observation.scope, 'selected-vertical');
  assert.equal(observation.disposition, 'terminal-consumed-never-retry-never-replay');
  assert.equal(observation.bindings.applicationSha, candidate.sha);
  assert.equal(observation.bindings.applicationTree, candidate.tree);
  assert.equal(observation.bindings.manifestSha256, retained.sources.manifest.sha256);
  assert.equal(observation.bindings.dispatchSha256, retained.sources.dispatch.sha256);
  assert.deepEqual(observation.terminal.testCounts, { selected: 154, passed: 0, failed: 0, blocked: 0, unexecuted: 154, terminalTestRows: 0, distinctTerminalTestIds: 0 });
  assert.equal(observation.terminal.failure.classification, 'test-harness-return-shape-contract');
  assert.equal(observation.terminal.failure.assertion, 'assert(!ticket.result)');
  assert.equal(observation.nativeTicketAttempt.httpStatus, 500);
  assert.equal(observation.nativeTicketAttempt.terminalResult, 'failed');
  assert.equal(observation.nativeTicketAttempt.notApplied, true);
  assert.equal(observation.nativeTicketAttempt.ticketId, null);
  assert.equal(observation.nativeTicketAttempt.articleId, null);
  assert.equal(observation.nativeTicketAttempt.noReplay, true);
  for (const key of ['targetMessageLinkCount', 'targetTicketReceiptCount', 'zammadOperationArticleCount', 'zammadMarkerTicketCount']) assert.equal(observation.nativeTicketAttempt[key], 0);
  for (const key of ['eventInboxCreated', 'deliveryOutboxCreated', 'normalizedMessagesCreated', 'messageLinksCreated', 'groupActionExecutionsCreated', 'connectionOperationsCreated', 'botFlowOperationsCreated']) assert.equal(observation.effects[key], 0);
  assert.deepEqual({ sends: observation.effects.provider.newSends, receipts: observation.effects.provider.newReceipts, pending: observation.effects.provider.after.pending }, { sends: 0, receipts: 0, pending: 0 });
  assert.deepEqual({ events: observation.safetyReadback.unsettledEvents, deliveries: observation.safetyReadback.unsettledDeliveries, unknown: observation.safetyReadback.unknownOutcomeDeliveries, operations: observation.safetyReadback.unsettledConnectionOperations, actions: observation.safetyReadback.unsettledGroupActions }, { events: 0, deliveries: 0, unknown: 0, operations: 0, actions: 0 });
  assert.deepEqual({ expected: observation.safetyReadback.cleanup.expected, closed: observation.safetyReadback.cleanup.closed }, { expected: 8, closed: 8 });
  for (const [artifact, sourceName] of [['setup', 'setup'], ['dispatch', 'dispatch'], ['manifest', 'manifest'], ['result', 'terminal'], ['admission', 'admission'], ['contextBinding', 'context'], ['intents', 'intents'], ['launcherFailure', 'failure']]) assert.equal(observation.artifacts[artifact].sha256, retained.sources[sourceName].sha256);

  const selected = source.intents.filter(row => retained.manifestTestIds.includes(row.testId) && ['passed', 'failed', 'blocked'].includes(row.result));
  assert.equal(selected.length, 0, 'q082 emitted no selected terminal rows');
  const intent = one(source.intents.filter(row => row.phase === 'intent' && row.step === 'native-business-create'), 'q082 ticket intent');
  const response = one(source.intents.filter(row => row.phase === 'native-business-create-response'), 'q082 ticket response');
  const reconciled = one(source.intents.filter(row => row.phase === 'native-business-create-reconciled'), 'q082 ticket reconciliation');
  assert.equal(response.status, 500);
  assert.equal(response.responseSha256, observation.nativeTicketAttempt.responseSha256);
  assert.deepEqual({ result: reconciled.status, notApplied: reconciled.notApplied, httpStatus: reconciled.httpStatus, noReplay: reconciled.noReplay }, { result: 'failed', notApplied: true, httpStatus: 500, noReplay: true });
  assert.equal(reconciled.ticketId, null);
  assert.equal(reconciled.articleId, null);
  assert.deepEqual({ intentAt: intent.at, responseAt: response.at, reconciledAt: reconciled.at }, { intentAt: observation.nativeTicketAttempt.intentAt, responseAt: observation.nativeTicketAttempt.responseAt, reconciledAt: observation.nativeTicketAttempt.reconciledAt });
  assert(Date.parse(intent.at) < Date.parse(response.at) && Date.parse(response.at) < Date.parse(reconciled.at));
  const ticket = { result: 'failed', settled: true, notApplied: true, httpStatus: 500, noReplay: true };
  return { intent, reconciled, ticket, ticketResults: failedQ081TicketResults(ticket, { startedAt: intent.at, finishedAt: reconciled.at }) };
}

export async function q082NativeContinuationStage(session, { namespace, inputs, config }) {
  const group = inputs.group;
  assert.equal(group.namespace, namespace);
  assert.equal(group.tenantId, session.tenantId);
  assert.equal(inputs.directConnection.connectionId, group.connectionId);
  assert.equal(inputs.nativeGroupQuality.namespace, namespace);
  assert(session.actorBinding.userMatched && session.actorBinding.workspaceMatched);
  const prior = validateQ076NativeSources(await loadRetainedDirectSources(session, config.retainedQ076.sources), { candidate: session.candidate, project: session.model.name, sources: config.retainedQ076.sources });
  const q081 = validateQ081Sources(await loadRetainedDirectSources(session, config.retainedQ081.sources), { candidate: session.candidate, project: session.model.name, retained: config.retainedQ081 });
  const q082 = validateQ082Sources(await loadRetainedDirectSources(session, config.retainedQ082.sources), { candidate: session.candidate, project: session.model.name, retained: config.retainedQ082 });
  assert.notEqual(namespace, config.retainedQ082.namespace);
  const [media] = await session.scoped('SELECT id,provider_metadata FROM normalized_messages WHERE tenant_id=$1 AND connection_id=$2 AND id=$3', [session.tenantId, group.connectionId, prior.edited.targetId]);
  assert(media?.provider_metadata?.media_object_id);
  const current = await reconcileNativeTicketOutcome({ run: session.run, railsId: session.containers['zammad-railsserver'].Id, tenantId: session.tenantId, messageId: prior.fixtures.phoneFallback.id, externalMessageId: prior.fixtures.phoneFallback.externalMessageId, connectionId: group.connectionId, marker: q082.intent.body.title, scoped: session.scoped, httpStatus: q082.ticket.httpStatus });
  assert.deepEqual(current, q082.ticket, 'q082 not-applied outcome drifted');
  const providerBefore = await session.directCallbacks.providerRead({ requireSettled: true });
  const ticketResults = q082.ticketResults.map(result => ({ ...result, coverageKind: 'retained-proof-completion', proof: { ...result.proof, productFinding: 'NATIVE_TICKET_CREATE_HTTP_500', retainedFrom: { namespace: config.retainedQ082.namespace, sources: config.retainedQ082.sources } } }));
  assert.deepEqual(await session.directCallbacks.providerRead({ requireSettled: true }), providerBefore);
  return {
    evidenceMode: 'simulated', namespace, tenantId: session.tenantId,
    results: mergeQ081NativeResults(prior.terminal, q081.terminal, ticketResults),
    fixture: { groupId: group.groupId, messageId: prior.fixtures.phoneFallback.id, ticketId: null },
    media: { evidenceMode: 'simulated', namespace, tenantId: session.tenantId, connectionId: group.connectionId, messageId: media.id, mediaId: media.provider_metadata.media_object_id },
    retainedFrom: { q076: prior.namespace, q081: config.retainedQ081.namespace, q082: config.retainedQ082.namespace }, noProviderSends: true, noReplay: true,
  };
}
