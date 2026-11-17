import { createHash } from 'node:crypto';
import { MetaGroupsAdapter } from '../../../packages/connectors/src/meta.js';
import { ProviderError } from '../../../packages/connectors/src/types.js';
import { assertMetaCredentialProof } from '../../../packages/core/src/meta-account-relation.js';
import type { MetaActualRequestExecution, MetaAccountFundingProof } from '../../../packages/core/src/meta-account-policy.js';
import type { MetaTemplateInventory } from '../../../packages/core/src/meta-template-inventory.js';
import type { MetaTemplateDependency } from '../../../packages/core/src/meta-template-continuity.js';
import { buildMetaTemplateMapping, parseMetaTemplateMapping, type MetaTemplateMappingProof } from '../../../packages/core/src/meta-template-mapping.js';
import type { ConnectionOperationJob } from './connection-operation-repository.js';
import type { SecretResolver } from './secrets.js';
import { currentMetaTransportBinding } from './meta-transport-binding.js';
import { currentMetaRuntimeCandidate, type MetaRuntimeEvidenceCandidate } from './meta-request-provenance.js';

type Asset = { accountId: string; providerAccountId: string; connectionId: string; phoneId: string; observedOwnerBusinessId: string;
  secretReference: string; credentialProof: unknown };
export type MetaLegacyMigrationContext = {
  transitionId: string; revision: number; stage: 'OBSERVE' | 'REGISTER' | 'RECONCILE'; appId: string; graphVersion: string;
  originalScopeSha256: string; currentScopeSha256: string; contextSha256: string; source: Asset; destination: Asset;
  /** The original completed B1 operation result, never a mutable UI inventory.
   * Source semantic bytes remain available when source access ends. Only a
   * fresh current target GET can complete the post-registration mapping. */
  templates: { observationOperationId: string; observationSha256: string; source: MetaTemplateInventory;
    sourceSafetyRevision: number; targetSafetyRevision: number; dependencies: MetaTemplateDependency[];
    metaFlowDependencyCount: number; originalMapping: MetaTemplateMappingProof };
  /** These are sealed provider/capability and local admission facts, not request
   * booleans or SDK event claims. Their authoritative producer is a required
   * separate integration seam; absence must return null, never a default. */
  registerAdmission: null | { evidenceMode: 'SIMULATED'; eligibilityReceiptId: string; providerContractSha256: string;
    runtimeEvidenceReceiptId: string;
    authorizationOperationId: string; confirmationOperationId: string; templateObservationOperationId: string;
    sourceTwoStepRequirement: 'PROVIDER_CONFIRMED'; destinationFunding: 'VERIFIED';
    scopeCurrent: true; drainClear: true; sourceServiceQuiesced: true; expiresAt: string };
};
type Checkpoint = { id: string; outcome: 'ATTEMPTED' | 'SUCCEEDED' | 'REJECTED' | 'UNKNOWN' };
type NewCheckpoint = { disposition: 'NEW_ATTEMPT'; id: string; reservationToken: string };
export type MetaLegacyReadback = { schemaVersion: 1; claim: 'LEGACY_TARGET_REGISTRATION_OBSERVED';
  sourceAccountId: string; destinationAccountId: string; phoneId: string; relation: unknown;
  appSubscribed: true; observedAt: string; originalCheckpointId: string; originalOutcome: Checkpoint['outcome'];
  templateObservationOperationId: string; templateMapping: MetaTemplateMappingProof;
  fundingProof: Omit<MetaAccountFundingProof, 'currency'> | null };
export interface MetaLegacyMigrationStore {
  context(job: ConnectionOperationJob, lease: string, appId: string, phase: 'BEFORE_REGISTER' | 'READBACK'): Promise<MetaLegacyMigrationContext>;
  resolveExecution(job: ConnectionOperationJob, context: MetaLegacyMigrationContext,
    candidate: MetaRuntimeEvidenceCandidate | undefined, transportSha256: string): Promise<MetaActualRequestExecution>;
  originalCheckpoint(job: ConnectionOperationJob): Promise<Checkpoint | null>;
  reserveOriginalRegister(job: ConnectionOperationJob, lease: string, requestSha256: string,
    contextSha256: string, execution: MetaActualRequestExecution): Promise<NewCheckpoint | { disposition: 'HISTORICAL_NO_POST'; checkpoint: Checkpoint }>;
  recordOriginalRegister(job: ConnectionOperationJob, slot: NewCheckpoint, outcome: 'SUCCEEDED' | 'REJECTED' | 'UNKNOWN',
    result: { registered: true } | { reason: 'KNOWN_PROVIDER_REJECTION' | 'PROVIDER_OUTCOME_UNRESOLVED' }): Promise<void>;
  recordReadback(job: ConnectionOperationJob, lease: string, contextSha256: string, observation: MetaLegacyReadback): Promise<boolean>;
  /** Performs the actual sealed account/binding/identity/template successor,
   * leaves the target PAUSED, and never changes the original provider outcome. */
  reconcile(job: ConnectionOperationJob, lease: string, contextSha256: string, observation: MetaLegacyReadback): Promise<boolean>;
  failOperation(job: ConnectionOperationJob, lease: string): Promise<void>;
}
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const held = () => new ProviderError('Number migration requires a current review.', false, 'META_MIGRATION_NOT_ATTEMPTED', undefined, true);
const sha256 = (value: string) => /^[a-f0-9]{64}$/u.test(value);

/** Finite legacy stage consumer. Registration is reachable only through its
 * distinct sealed claim, never NEW_NUMBER or ADD_ACCESS. This module does not
 * manufacture legacy applicability, payer authority or a changed-phone bridge.
 * Source and target access/identity producers remain explicit dependencies. */
export async function executeMetaLegacyMigration(job: ConnectionOperationJob, lease: string, appId: string,
  store: MetaLegacyMigrationStore, secrets: SecretResolver,
  dependencies = { readTransport: currentMetaTransportBinding, readRuntime: currentMetaRuntimeCandidate }): Promise<void> {
  const original = await store.originalCheckpoint(job);
  const phase = original ? 'READBACK' as const : 'BEFORE_REGISTER' as const;
  const context = await store.context(job, lease, appId, phase);
  if (context.appId !== appId || context.graphVersion !== 'v24.0' || !sha256(context.contextSha256) || !sha256(context.originalScopeSha256)
    || !sha256(context.currentScopeSha256) || context.source.providerAccountId === context.destination.providerAccountId
    || context.source.phoneId !== context.destination.phoneId) throw held();
  // A different Graph ID requires an independently reviewed provider mapping;
  // display-phone equality and account portfolio observations are insufficient.
  const secret = await secrets.resolve(context.destination.secretReference,
    { kind: 'meta-connection', tenantId: job.tenantId, connectionId: context.destination.connectionId });
  const accessToken = secret.accessToken ?? secret.token ?? secret.value;
  if (!accessToken || !assertMetaCredentialProof(context.destination.credentialProof, { appId, accessToken })) throw held();
  const contextSha = context.contextSha256;
  const transport = await dependencies.readTransport(context.graphVersion);
  const candidate = await dependencies.readRuntime({ graphVersion: context.graphVersion, transportBindingSha256: transport.transportBindingSha256 });
  const execution = await store.resolveExecution(job, context, candidate, transport.transportBindingSha256);
  let newSlot: NewCheckpoint | undefined;
  const guard = async () => {
    const current = await store.context(job, lease, appId, newSlot || original ? 'READBACK' : 'BEFORE_REGISTER');
    if (current.contextSha256 !== contextSha || current.originalScopeSha256 !== context.originalScopeSha256 || current.currentScopeSha256 !== context.currentScopeSha256
      || current.destination.secretReference !== context.destination.secretReference
      || sha(current.destination.credentialProof) !== sha(context.destination.credentialProof)
      || !assertMetaCredentialProof(current.destination.credentialProof, { appId, accessToken })) throw held();
  };
  const adapter = new MetaGroupsAdapter({ accessToken, graphVersion: context.graphVersion,
    phoneNumberIdFor: () => context.destination.phoneId, wabaIdFor: () => context.destination.providerAccountId,
    beforeRequest: guard, beforeLegacyMigrationMutation: async requestSha256 => {
      if (original || newSlot || context.stage !== 'REGISTER') throw held();
      const fresh = await store.context(job, lease, appId, 'BEFORE_REGISTER');
      if (fresh.contextSha256 !== contextSha) throw held();
      // Re-resolve the actual mounted descriptor and transport at the final
      // request boundary. A server context hint is never transport evidence.
      const currentTransport = await dependencies.readTransport(fresh.graphVersion);
      const currentCandidate = await dependencies.readRuntime({ graphVersion: fresh.graphVersion, transportBindingSha256: currentTransport.transportBindingSha256 });
      const currentExecution = await store.resolveExecution(job, fresh, currentCandidate, currentTransport.transportBindingSha256);
      if (sha(currentExecution) !== sha(execution) || currentExecution.mode !== 'SIMULATED'
        || fresh.registerAdmission?.runtimeEvidenceReceiptId !== currentExecution.runtimeEvidenceReceiptId) throw held();
      const claim = await store.reserveOriginalRegister(job, lease, requestSha256, contextSha, currentExecution);
      if (claim.disposition !== 'NEW_ATTEMPT') throw held();
      newSlot = claim; // Claim transaction commits before adapter fetch begins.
    } });
  if (context.stage === 'REGISTER') {
    const admission = context.registerAdmission;
    if (original || !admission || !sha256(admission.providerContractSha256)
      || !Number.isFinite(Date.parse(admission.expiresAt)) || Date.parse(admission.expiresAt) <= Date.now()
      || admission.sourceTwoStepRequirement !== 'PROVIDER_CONFIRMED' || admission.destinationFunding !== 'VERIFIED'
      || admission.scopeCurrent !== true || admission.drainClear !== true || admission.sourceServiceQuiesced !== true
      // Current retained primary research supplies no per-asset LIVE legacy
      // eligibility producer. A software fixture grant cannot become live proof.
      || admission.evidenceMode !== 'SIMULATED' || execution.mode !== 'SIMULATED'
      || admission.runtimeEvidenceReceiptId !== execution.runtimeEvidenceReceiptId || !secret.registrationPin) throw held();
    const sourceSecret = await secrets.resolve(context.source.secretReference,
      { kind: 'meta-connection', tenantId: job.tenantId, connectionId: context.source.connectionId });
    const sourceToken = sourceSecret.accessToken ?? sourceSecret.token ?? sourceSecret.value;
    if (!sourceToken || !assertMetaCredentialProof(context.source.credentialProof, { appId, accessToken: sourceToken })) throw held();
    const sourceAdapter = new MetaGroupsAdapter({ accessToken: sourceToken, graphVersion: context.graphVersion,
      phoneNumberIdFor: () => context.source.phoneId, wabaIdFor: () => context.source.providerAccountId, beforeRequest: guard });
    await sourceAdapter.verifyTemplateAccountAccess(context.source.providerAccountId, context.source.observedOwnerBusinessId);
    const sourceInventory = await sourceAdapter.templatePreparationCalls().inventory(context.source.providerAccountId);
    const targetInventory = await adapter.templatePreparationCalls().inventory(context.destination.providerAccountId);
    const currentMapping = buildMetaTemplateMapping({ source: sourceInventory, target: targetInventory,
      sourceSafetyRevision: context.templates.sourceSafetyRevision, targetSafetyRevision: context.templates.targetSafetyRevision,
      dependencies: context.templates.dependencies, metaFlowDependencyCount: context.templates.metaFlowDependencyCount });
    const originalMapping = parseMetaTemplateMapping(context.templates.originalMapping);
    if (!currentMapping || !originalMapping || currentMapping.sourceInventorySha256 !== originalMapping.sourceInventorySha256
      || currentMapping.targetInventorySha256 !== originalMapping.targetInventorySha256
      || sha(currentMapping.mappings) !== sha(originalMapping.mappings)) throw held();
    await adapter.verifySignupOwner(job.connectionId, context.destination.observedOwnerBusinessId);
    const readiness = await adapter.signupReadiness(job.connectionId, appId);
    // The guide requires an already subscribed destination. Do not perform an
    // uncheckpointed subscription or share/revoke a credit line from this stage.
    if (!readiness.subscribed) throw held();
    const phone = await adapter.signupPhone(job.connectionId);
    if (phone.mode !== 'STANDARD' || phone.numberState !== 'REGISTRATION_REQUIRED') throw held();
    let result: { registered: true };
    try { result = await adapter.registerLegacyMigrationPhone(job.connectionId, secret.registrationPin); }
    catch (error) {
      if (newSlot) await store.recordOriginalRegister(job, newSlot,
        error instanceof ProviderError && error.outcomeKnown === true ? 'REJECTED' : 'UNKNOWN',
        { reason: error instanceof ProviderError && error.outcomeKnown === true ? 'KNOWN_PROVIDER_REJECTION' : 'PROVIDER_OUTCOME_UNRESOLVED' });
      throw error;
    }
    if (!newSlot) throw held();
    // A local receipt failure leaves the original ATTEMPTED barrier. It must
    // never be caught and reclassified into a retryable provider operation.
    await store.recordOriginalRegister(job, newSlot, 'SUCCEEDED', result);
  }
  const checkpoint = await store.originalCheckpoint(job);
  if (!checkpoint || checkpoint.outcome === 'REJECTED') throw held();
  await guard();
  const relation = await adapter.verifyPhoneAccountRelationship(job.connectionId);
  const phone = await adapter.signupPhone(job.connectionId);
  const readiness = await adapter.signupReadiness(job.connectionId, appId);
  if (relation.phoneNumberId !== context.destination.phoneId || relation.wabaId !== context.destination.providerAccountId
    || phone.mode !== 'STANDARD' || phone.numberState !== 'REGISTERED' || !readiness.subscribed
    || !['AVAILABLE', 'LIMITED'].includes(readiness.messaging)) throw held();
  const targetInventory = await adapter.templatePreparationCalls().inventory(context.destination.providerAccountId);
  const mapping = buildMetaTemplateMapping({ source: context.templates.source, target: targetInventory,
    sourceSafetyRevision: context.templates.sourceSafetyRevision, targetSafetyRevision: context.templates.targetSafetyRevision,
    dependencies: context.templates.dependencies, metaFlowDependencyCount: context.templates.metaFlowDependencyCount });
  const originalMapping = parseMetaTemplateMapping(context.templates.originalMapping);
  if (!mapping || !originalMapping || mapping.sourceInventorySha256 !== originalMapping.sourceInventorySha256
    || sha(mapping.mappings) !== sha(originalMapping.mappings)) throw held();
  let fundingProof: MetaLegacyReadback['fundingProof'] = null;
  if (context.stage === 'OBSERVE' && checkpoint.outcome === 'SUCCEEDED') {
    const { funding } = await adapter.billingAccountProof(context.destination.providerAccountId);
    // Retain only the incumbent funding proof. Optional currency discovery does
    // not authorize a payer, currency, policy, or account change. SQL matches
    // these facts to the original reserved target and existing payment guard.
    fundingProof = { schemaVersion: funding.schemaVersion, accountId: funding.accountId,
      observedOwnerBusinessId: funding.observedOwnerBusinessId, primaryFundingId: funding.primaryFundingId,
      status: funding.status, actualPayer: funding.actualPayer, responseSha256: funding.responseSha256,
      observedAt: funding.observedAt, expiresAt: funding.expiresAt };
  }
  await guard();
  const observation:MetaLegacyReadback={ schemaVersion: 1, claim: 'LEGACY_TARGET_REGISTRATION_OBSERVED',
    sourceAccountId: context.source.providerAccountId, destinationAccountId: context.destination.providerAccountId,
    phoneId: context.destination.phoneId, relation, appSubscribed: true, observedAt: new Date().toISOString(),
    originalCheckpointId: checkpoint.id, originalOutcome: checkpoint.outcome,
    templateObservationOperationId: context.templates.observationOperationId, templateMapping: mapping, fundingProof };
  // Equivalent target contents and registration readback do not establish the
  // original mutation's outcome. UNKNOWN/ATTEMPTED remain deliberate read-only.
  if (context.stage === 'RECONCILE') {
    if(checkpoint.outcome!=='SUCCEEDED'||!await store.reconcile(job,lease,contextSha,observation))throw held();
  } else if(!await store.recordReadback(job,lease,contextSha,observation))throw held();
}
