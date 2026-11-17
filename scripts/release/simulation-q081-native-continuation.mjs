import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadRetainedDirectSources } from './simulation-direct-continuation.mjs';
import { ensureNativeAgent } from './simulation-native-agent.mjs';
import { createAndFilterNativeGroupTicket } from './simulation-native-business-ticket.mjs';
import { completeNativeBusinessTestIds } from './simulation-native-business-stage.mjs';
import { q076NativeUnexecutedIds, validateQ076NativeSources } from './simulation-q076-native-continuation.mjs';

const one = (rows, label) => {
  assert.equal(rows.length, 1, label);
  return rows[0];
};

export function validateQ081Sources(source, { candidate, project, retained }) {
  assert.deepEqual(Object.keys(source).sort(), Object.keys(retained.sources).sort());
  assert.equal(source.setup.namespace, retained.namespace);
  assert.equal(source.manifest.evidenceMode, 'simulated');
  assert.equal(source.manifest.scope, 'selected-vertical');
  assert.equal(source.dispatch.namespace, retained.namespace);
  assert.equal(source.dispatch.application.sha, candidate.sha);
  assert.equal(source.dispatch.application.tree, candidate.tree);
  assert.equal(source.manifest.namespace, retained.namespace);
  assert.deepEqual(source.manifest.requiredTestIds, retained.manifestTestIds);
  assert.equal(source.admission.project, project);
  assert.equal(source.admission.evidenceMode, 'simulated');
  assert.deepEqual(source.admission.candidate, candidate);
  assert.equal(source.context.project, project);
  assert.equal(source.context.evidenceMode, 'simulated');
  assert.deepEqual(source.context.candidate, candidate);
  assert.equal(source.context.native.role, 'zammad_agent');
  assert.equal(source.terminal.namespace, retained.namespace);
  assert.equal(source.terminal.evidenceMode, 'simulated');
  assert.equal(source.terminal.scope, 'selected-vertical');
  assert.equal(source.terminal.status, 'terminal');
  assert.equal(source.terminal.exitCode, 1);
  assert.equal(source.terminal.applicationSha, candidate.sha);
  assert.equal(source.terminal.applicationTree, candidate.tree);
  assert.equal(source.terminal.manifestSha256, retained.sources.manifest.sha256);
  assert.equal(source.context.owner.role, 'tenant_owner');
  assert.equal(source.context.locale, 'en');
  assert.equal(source.desktopBinding.role, 'zammad_agent');
  assert.equal(source.desktopBinding.evidenceMode, 'simulated');
  assert.equal(source.desktopBinding.locale, source.context.locale);
  assert.equal(source.desktopBinding.actorRef, source.context.native.actorRef);
  assert.equal(source.desktopBinding.tenantRef, source.context.native.tenantRef);
  assert.deepEqual(source.desktopBinding.viewport, { width: 1440, height: 1000 });
  assert.equal(source.desktopBinding.sourceIntentsSha256, retained.sources.intents.sha256);
  assert.deepEqual(source.desktopBinding.checkpointTestIds, q076NativeUnexecutedIds.slice(0, 2));
  assert.equal(source.observation.namespace, retained.namespace);
  assert.equal(source.observation.evidenceMode, 'simulated');
  assert.equal(source.observation.scope, 'selected-vertical');
  assert.equal(source.observation.bindings.applicationSha, candidate.sha);
  assert.equal(source.observation.bindings.applicationTree, candidate.tree);
  assert.equal(source.observation.bindings.manifestSha256, retained.sources.manifest.sha256);
  assert.equal(source.observation.bindings.dispatchSha256, retained.sources.dispatch.sha256);
  assert.equal(source.observation.artifacts.intents.sha256, retained.sources.intents.sha256);
  assert.equal(source.observation.terminal.failure.classification, 'test-harness-retained-message-navigation');
  assert.equal(source.observation.terminal.failure.errorSha256, createHash('sha256').update(source.failure.error).digest('hex'));
  assert.equal(source.correction.corrects.sha256, retained.sources.observation.sha256);
  assert.equal(source.correction.evidenceMode, 'simulated');
  assert.equal(source.correction.bindings.manifestSha256, retained.sources.manifest.sha256);
  assert.equal(source.correction.bindings.dispatchSha256, retained.sources.dispatch.sha256);
  assert.equal(source.correction.bindings.intentsSha256, retained.sources.intents.sha256);
  assert.equal(source.correction.bindings.invocationId, source.observation.invocationId);
  assert.equal(source.correction.preservedFacts.effects.q081ActionsOrProductEffects, 0);
  assert.equal(source.correction.preservedFacts.effects.newSends, 0);
  assert.equal(source.correction.preservedFacts.effects.newReceipts, 0);
  assert.equal(source.correction.preservedFacts.disposition, 'terminal-consumed-never-retry-never-replay');
  assert.deepEqual(source.correction.testCounts.selected.results, retained.checkpointOutcomes.filter(row => retained.manifestTestIds.includes(row.testId)));
  assert.deepEqual(source.correction.testCounts.supportingOutsideSelection.results, retained.checkpointOutcomes.filter(row => !retained.manifestTestIds.includes(row.testId)).map(row => ({ ...row, selectedByManifest: false })));
  const rows = source.intents.filter(row => ['q076-native-readback-result', 'native-email-failure-ui'].includes(row.phase) && ['passed', 'failed', 'blocked'].includes(row.result));
  assert.equal(rows.length, 3);
  for (const expected of retained.checkpointOutcomes) {
    const row = one(rows.filter(value => value.testId === expected.testId), expected.testId);
    assert.equal(row.result, expected.result);
    assert.equal(row.contextId, expected.contextId);
    assert.equal(row.phase, expected.phase);
  }
  const terminal = rows.filter(row => retained.manifestTestIds.includes(row.testId));
  assert(terminal.every(row => row.evidenceMode === 'simulated'));
  assert(terminal.every(row => row.contextId === 'zammad_agent-en-desktop'));
  for (const row of terminal) assert.deepEqual(row.actualViewport, source.desktopBinding.viewport);
  return { terminal };
}

export function mergeQ081NativeResults(priorTerminal, q081Terminal, ticketResults) {
  const merged = new Map(priorTerminal);
  for (const result of [...q081Terminal, ...ticketResults]) {
    assert(!merged.has(result.testId), 'Retained native result replayed: ' + result.testId);
    merged.set(result.testId, result);
  }
  assert.equal(merged.size, completeNativeBusinessTestIds.length);
  assert.deepEqual([...merged.keys()].sort(), [...completeNativeBusinessTestIds].sort());
  return completeNativeBusinessTestIds.map(id => merged.get(id));
}

export function failedQ081TicketResults(ticket, { startedAt, finishedAt } = {}) {
  assert.deepEqual(
    { result: ticket?.result, settled: ticket?.settled, notApplied: ticket?.notApplied, noReplay: ticket?.noReplay },
    { result: 'failed', settled: true, notApplied: true, noReplay: true },
  );
  assert(Number.isSafeInteger(ticket.httpStatus));
  const at = finishedAt ?? new Date().toISOString();
  return q076NativeUnexecutedIds.slice(2).map(testId => ({
    testId,
    result: 'failed',
    startedAt: startedAt ?? at,
    finishedAt: at,
    proof: { ...ticket, blocker: 'NATIVE_TICKET_CREATE_NOT_APPLIED' },
  }));
}

export async function q081NativeContinuationStage(session, { namespace, inputs, config }) {
  const group = inputs.group;
  assert.equal(group.namespace, namespace);
  assert.equal(group.tenantId, session.tenantId);
  assert.equal(inputs.directConnection.connectionId, group.connectionId);
  assert.equal(inputs.nativeGroupQuality.namespace, namespace);
  assert(session.actorBinding.userMatched && session.actorBinding.workspaceMatched);
  const prior = validateQ076NativeSources(await loadRetainedDirectSources(session, config.retainedQ076.sources), { candidate: session.candidate, project: session.model.name, sources: config.retainedQ076.sources });
  const q081 = validateQ081Sources(await loadRetainedDirectSources(session, config.retainedQ081.sources), { candidate: session.candidate, project: session.model.name, retained: config.retainedQ081 });
  assert.notEqual(namespace, prior.namespace);
  assert.notEqual(namespace, config.retainedQ081.namespace);

  const agent = await ensureNativeAgent(session);
  await agent.verify();
  const [media] = await session.scoped('SELECT id,provider_metadata FROM normalized_messages WHERE tenant_id=$1 AND connection_id=$2 AND id=$3', [session.tenantId, group.connectionId, prior.edited.targetId]);
  assert(media?.provider_metadata?.media_object_id);
  const linked = one(await session.scoped('SELECT zammad_ticket_id FROM message_links WHERE tenant_id=$1 AND connection_id=$2 AND external_message_id=$3', [session.tenantId, group.connectionId, prior.fixtures.unsafeName.externalMessageId]), 'q076 existing ticket link');
  assert(linked.zammad_ticket_id);
  assert.equal((await session.scoped('SELECT id FROM message_links WHERE tenant_id=$1 AND connection_id=$2 AND external_message_id=$3', [session.tenantId, group.connectionId, prior.fixtures.phoneFallback.externalMessageId])).length, 0, 'q081 continuation target already linked');
  const providerBefore = await session.directCallbacks.providerRead({ requireSettled: true });
  let uncertain = false;
  const ticketStartedAt = new Date().toISOString();
  const ticket = await createAndFilterNativeGroupTicket({
    page: agent.page,
    origin: session.nativeOrigin,
    groupId: group.groupId,
    messageId: prior.fixtures.phoneFallback.id,
    externalMessageId: prior.fixtures.phoneFallback.externalMessageId,
    connectionId: group.connectionId,
    tenantId: session.tenantId,
    marker: 'Alpha native continuation ' + namespace,
    checkpoint: async value => {
      if (value.phase === 'intent') uncertain = true;
      await session.checkpoint(value);
      if (value.phase === 'accepted' || value.phase === 'native-business-create-reconciled' && value.notApplied) uncertain = false;
    },
    scoped: session.scoped,
    providerRead: () => session.directCallbacks.providerRead({ requireSettled: true }),
    run: session.run,
    railsId: session.containers['zammad-railsserver'].Id,
  });
  assert(!uncertain, 'Reconcile q081 continuation ticket before any repeat');
  assert.deepEqual(await session.directCallbacks.providerRead({ requireSettled: true }), providerBefore);
  const ticketResults = ticket.result === 'failed' ? failedQ081TicketResults(ticket, { startedAt: ticketStartedAt }) : [ticket.filtered, ticket.created];
  assert.deepEqual(ticketResults.map(result => result.testId), q076NativeUnexecutedIds.slice(2));
  if (ticket.result === 'failed') for (const result of ticketResults) await session.checkpoint({ phase: 'native-business', evidenceMode: 'simulated', ...result });
  return {
    evidenceMode: 'simulated',
    namespace,
    tenantId: session.tenantId,
    results: mergeQ081NativeResults(prior.terminal, q081.terminal, ticketResults),
    fixture: { groupId: group.groupId, messageId: prior.fixtures.phoneFallback.id, ticketId: ticket.created?.proof.ticketId ?? null },
    media: { evidenceMode: 'simulated', namespace, tenantId: session.tenantId, connectionId: group.connectionId, messageId: media.id, mediaId: media.provider_metadata.media_object_id },
    retainedFrom: { q076: prior.namespace, q081: config.retainedQ081.namespace },
    noProviderSends: true,
    noReplay: true,
  };
}
