import { createHash } from 'node:crypto';
import { MetaGroupsAdapter } from '../../../packages/connectors/src/meta.js';
import { ProviderError } from '../../../packages/connectors/src/types.js';
import { parseMetaTemplateCopyResult } from '../../../packages/connectors/src/meta-template-copy.js';
import { assertMetaCredentialProof, metaLifecyclePayloadSha256 } from '../../../packages/core/src/meta-account-relation.js';
import { metaTemplateContinuity, metaTemplateCopyEligible, metaTemplateSendShape, type MetaTemplateDependency } from '../../../packages/core/src/meta-template-continuity.js';
import type { MetaTemplateInventory } from '../../../packages/core/src/meta-template-inventory.js';
import type { MetaActualRequestExecution } from '../../../packages/core/src/meta-account-policy.js';
import type { ConnectionOperationJob } from './connection-operation-repository.js';
import type { SecretResolver } from './secrets.js';
import { currentMetaTransportBinding } from './meta-transport-binding.js';
import { currentMetaRuntimeCandidate, type MetaRuntimeEvidenceCandidate } from './meta-request-provenance.js';

type Account = { id: string; providerId: string; connectionId: string; phoneId: string; secretReference: string;
  credentialProof: unknown; observedOwnerBusinessId: string; safetyRevision: number };
export type MetaTemplatePreparationContext = {
  transitionId: string; stage: 'OBSERVE' | 'COPY' | 'RECONCILE'; revision: number; appId: string; graphVersion: string;
  source: Account; target: Account; contextSha256: string;
  dependencies: MetaTemplateDependency[]; metaFlowDependencyCount: number; selectedSourceIds: string[];
  /** Immutable server observation chosen by COPY. No caller supplied inventory. */
  selectedInventory: MetaTemplateInventory | null;
  selectedTargetInventory: MetaTemplateInventory | null;
};
type Slot = { disposition: 'NEW_ATTEMPT'; id: string; reservationToken: string }
  | { disposition: 'HISTORICAL_NO_POST'; id: string; outcome: 'ATTEMPTED' | 'SUCCEEDED' | 'REJECTED' | 'UNKNOWN' };
export type MetaTemplatePreparationObservation = {
  schemaVersion: 1; source: MetaTemplateInventory; target: MetaTemplateInventory;
  sourceSafetyRevision: number; targetSafetyRevision: number;
  sourceResponseSha256: string; targetResponseSha256: string;
  dependencies: Array<MetaTemplateDependency & ReturnType<typeof metaTemplateContinuity>>;
  metaFlowDependencyCount: number;
  choices: Array<{ sourceTemplateId: string; name: string; language: string; selectable: boolean;
    compatibility: 'EQUIVALENT' | 'MISSING' | 'DIFFERENT' | 'UNSUPPORTED' | 'UNAVAILABLE' }>;
};
export interface MetaTemplatePreparationStore {
  templatePreparationContext(job: ConnectionOperationJob, lease: string, appId: string): Promise<MetaTemplatePreparationContext>;
  templateCopyCheckpoint(job: ConnectionOperationJob): Promise<null | { outcome: 'ATTEMPTED' | 'SUCCEEDED' | 'REJECTED' | 'UNKNOWN' }>;
  resolveTemplateExecution(job: ConnectionOperationJob, context: MetaTemplatePreparationContext,
    candidate: MetaRuntimeEvidenceCandidate | undefined, transportSha256: string): Promise<MetaActualRequestExecution>;
  reserveTemplateCopy(job: ConnectionOperationJob, lease: string, requestSha256: string, execution: MetaActualRequestExecution, appId: string): Promise<Slot>;
  recordTemplateCopyResponse(job: ConnectionOperationJob, slot: Extract<Slot, { disposition: 'NEW_ATTEMPT' }>,
    outcome: 'SUCCEEDED' | 'REJECTED' | 'UNKNOWN', result: unknown): Promise<void>;
  completeTemplateObservation(job: ConnectionOperationJob, lease: string, contextSha256: string,
    observation: MetaTemplatePreparationObservation, appId: string): Promise<boolean>;
  failTemplateOperation(job: ConnectionOperationJob, lease: string): Promise<void>;
}
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const hold = () => new ProviderError('Template preparation remains held.', false, 'META_TEMPLATE_NOT_ATTEMPTED', undefined, true);

/** One deliberate operation, one POST at most. No copy retry or implicit cutover.
 * SQL must commit the stable transition+TEMPLATE_COPY slot before the adapter fetch.
 * Observation can update compatibility; it never rewrites the original outcome. */
export async function prepareMetaTemplates(job: ConnectionOperationJob, lease: string, appId: string,
  store: MetaTemplatePreparationStore, secrets: SecretResolver,
  dependencies = { readTransport: currentMetaTransportBinding, readRuntime: currentMetaRuntimeCandidate }): Promise<void> {
  const initial = await store.templatePreparationContext(job, lease, appId);
  if (initial.appId !== appId || initial.source.id === initial.target.id
    || initial.source.providerId === initial.target.providerId
    || !initial.source.observedOwnerBusinessId || initial.source.observedOwnerBusinessId !== initial.target.observedOwnerBusinessId) throw hold();
  const tokens = await Promise.all([initial.source, initial.target].map(async account => {
    const secret = await secrets.resolve(account.secretReference, { kind: 'meta-connection', tenantId: job.tenantId, connectionId: account.connectionId });
    const token = secret.accessToken ?? secret.token ?? secret.value;
    if (!token || !assertMetaCredentialProof(account.credentialProof, { appId, accessToken: token })) throw hold();
    return token;
  }));
  const guard = async () => {
    const current = await store.templatePreparationContext(job, lease, appId);
    if (hash(current) !== hash(initial)) throw hold();
    for (const [index, account] of [current.source, current.target].entries())
      if (!assertMetaCredentialProof(account.credentialProof, { appId, accessToken: tokens[index]! })) throw hold();
  };
  let slot: Extract<Slot, { disposition: 'NEW_ATTEMPT' }> | undefined;
  const adapters = [initial.source, initial.target].map((account, index) => new MetaGroupsAdapter({
    accessToken: tokens[index]!, graphVersion: initial.graphVersion,
    phoneNumberIdFor: () => account.phoneId, wabaIdFor: () => account.providerId, beforeRequest: guard,
    beforeTemplateMutation: async requestSha256 => {
      if (index !== 1 || initial.stage !== 'COPY' || slot) throw hold();
      const transport = await dependencies.readTransport(initial.graphVersion);
      const candidate = await dependencies.readRuntime({ graphVersion: initial.graphVersion, transportBindingSha256: transport.transportBindingSha256 });
      const execution = await store.resolveTemplateExecution(job, initial, candidate, transport.transportBindingSha256);
      await guard();
      if (execution.mode !== 'LIVE' && execution.mode !== 'SIMULATED') throw hold();
      const claim = await store.reserveTemplateCopy(job, lease, requestSha256, execution, appId);
      if (claim.disposition !== 'NEW_ATTEMPT') throw hold();
      slot = claim;
    },
  }));
  // Fresh exact-token ownership/access proof precedes template reads/copy. Its
  // concrete adapter uses documented owner -> owned-list membership, not popup data.
  for (let i = 0; i < adapters.length; i++) {
    const account = i === 0 ? initial.source : initial.target;
    await adapters[i]!.verifyTemplateAccountAccess(account.providerId, account.observedOwnerBusinessId);
  }
  // The token that performs the copy must itself see the source as well.
  await adapters[1]!.verifyTemplateAccountAccess(initial.source.providerId, initial.source.observedOwnerBusinessId);
  if (initial.stage === 'COPY') {
    if (await store.templateCopyCheckpoint(job)) throw hold();
    const inventory = initial.selectedInventory;
    if (!inventory?.complete || inventory.accountId !== initial.source.providerId || initial.selectedSourceIds.length < 1
      || initial.selectedSourceIds.length > 500 || new Set(initial.selectedSourceIds).size !== initial.selectedSourceIds.length
      || initial.selectedSourceIds.some(id => !inventory.items.some(item => item.id === id && metaTemplateCopyEligible(item, 'EXPLICIT_COPY')))) throw hold();
    // Re-read the source immediately; a changed template cannot inherit the old confirmation.
    const current = await adapters[0]!.templatePreparationCalls().inventory(initial.source.providerId);
    if (!current.complete || initial.selectedSourceIds.some(id => {
      const old = inventory.items.find(item => item.id === id), fresh = current.items.find(item => item.id === id);
      return !old || !fresh || metaLifecyclePayloadSha256(old) !== metaLifecyclePayloadSha256(fresh) || !metaTemplateCopyEligible(fresh, 'EXPLICIT_COPY');
    })) throw hold();
    const targetBeforeCopy = await adapters[1]!.templatePreparationCalls().inventory(initial.target.providerId);
    if (!initial.selectedTargetInventory?.complete || !targetBeforeCopy.complete
      || metaLifecyclePayloadSha256(targetBeforeCopy) !== metaLifecyclePayloadSha256(initial.selectedTargetInventory)) throw hold();
    let result: ReturnType<typeof parseMetaTemplateCopyResult>;
    try {
      const raw = await adapters[1]!.templatePreparationCalls().copy({ sourceAccountId: initial.source.providerId,
        targetAccountId: initial.target.providerId, templateIds: initial.selectedSourceIds });
      if (!slot) throw hold();
      result = parseMetaTemplateCopyResult(raw, initial.selectedSourceIds);
    } catch (error) {
      if (slot) await store.recordTemplateCopyResponse(job, slot,
        error instanceof ProviderError && error.outcomeKnown === true ? 'REJECTED' : 'UNKNOWN',
        { reason: error instanceof ProviderError && error.outcomeKnown === true ? 'KNOWN_PROVIDER_REJECTION' : 'PROVIDER_OUTCOME_UNRESOLVED' });
      throw error;
    }
    // Local recording failure does not classify the provider response again.
    // The original committed ATTEMPTED slot stays non-repeatable.
    await store.recordTemplateCopyResponse(job, slot!, 'SUCCEEDED', result);
  }
  // Each page runs the real currentness callback. Later signed invalidation
  // changes safetyRevision and makes the completion CAS fail without clearing it.
  const source = await adapters[0]!.templatePreparationCalls().inventory(initial.source.providerId);
  const target = await adapters[1]!.templatePreparationCalls().inventory(initial.target.providerId);
  await guard();
  if (!await store.completeTemplateObservation(job, lease, initial.contextSha256, { schemaVersion: 1, source, target,
    sourceSafetyRevision: initial.source.safetyRevision, targetSafetyRevision: initial.target.safetyRevision,
    sourceResponseSha256: hash(source), targetResponseSha256: hash(target),
    metaFlowDependencyCount: initial.metaFlowDependencyCount,
    choices: source.items.map(item => {
      const shape = metaTemplateSendShape(item);
      const result = shape ? metaTemplateContinuity(source, target, { name: item.name, language: item.language,
        parameterCount: shape.parameterCount }) : null;
      const compatibility = !source.complete || !target.complete ? 'UNAVAILABLE' as const
        : !shape || result?.reason === 'UNSUPPORTED_DEFINITION' ? 'UNSUPPORTED' as const
        : result?.ready ? 'EQUIVALENT' as const : result?.reason === 'TARGET_MISSING' ? 'MISSING' as const : 'DIFFERENT' as const;
      return { sourceTemplateId: item.id, name: item.name, language: item.language,
        selectable: compatibility === 'MISSING' && metaTemplateCopyEligible(item, 'EXPLICIT_COPY'), compatibility };
    }),
    dependencies: initial.dependencies.map(dependency => ({ ...dependency, ...metaTemplateContinuity(source, target, dependency) })) }, appId)) throw hold();
}
