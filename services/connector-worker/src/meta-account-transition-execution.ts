import { createHash } from 'node:crypto';
import { MetaGroupsAdapter } from '../../../packages/connectors/src/meta.js';
import { ProviderError } from '../../../packages/connectors/src/types.js';
import { metaMigrationRecoveryId, parseMetaMigrationInitiation, parseMetaMigrationObservation } from '../../../packages/connectors/src/meta-account-transition-execute.js';
import { assertMetaCredentialProof } from '../../../packages/core/src/meta-account-relation.js';
import { metaTransitionStageHolds, type MetaTransitionStage, type MetaTransitionStageFacts } from '../../../packages/core/src/meta-account-transition-execution.js';
import type { MetaActualRequestExecution } from '../../../packages/core/src/meta-account-policy.js';
import type { ConnectionOperationJob } from './connection-operation-repository.js';
import type { SecretResolver } from './secrets.js';
import { currentMetaTransportBinding } from './meta-transport-binding.js';
import { currentMetaRuntimeCandidate, type MetaRuntimeEvidenceCandidate } from './meta-request-provenance.js';
import {readMetaTransitionTarget,type MetaTransitionTargetObservation} from './meta-account-transition-target.js';

export type MetaTransitionExecutionContext = {
  transitionId: string; revision: number; stage: MetaTransitionStage | 'OBSERVE' | 'RECONCILE';
  sourceAccountId: string; providerSourceAccountId: string; targetCurrency: string;
  destinationAccountId: string | null; providerDestinationAccountId: string | null;
  migrationId: string | null; secretReference: string; accountProof: unknown;
  appId: string; graphVersion: string; phoneNumberId: string;
  scopeSha256: string; admissionSha256: string; evidenceMode: 'LIVE' | 'SIMULATED';
  /** Exact server-approved line from P08; null for the customer-card path. */
  approvedCreditLineId: string | null;
  requestedMode:'CUSTOMER'|'WASALX_MANAGED';
  /** Exact queue-selected completed one-use renewal; null retains original proof. */
  observers:Record<string,null|{operationId:string;secretReference:string;credentialFingerprint:string;accountProof:unknown;observerAccountId:string;phoneNumberId:string;appId:string}>;
  targetDependenciesCurrent:boolean;
  scope:{bindings:Array<{id:string;revision:number;connectionId:string;sessionId:string;phoneId:string;appId:string;
   secretReference:string;fingerprint:string;providerState:Record<string,unknown>}>};
  financial:null|{secretReference:string;credentialFingerprint:string;credentialMetadata:unknown;holderBusinessId:string;
   creditLineId:string;receivingBusinessId:string;solutionId:string|null};
  facts: MetaTransitionStageFacts;
};
export type MetaTransitionCheckpoint = {
  id: string; ownerId: string; stage: MetaTransitionStage;
  outcome: 'ATTEMPTED' | 'SUCCEEDED' | 'REJECTED' | 'UNKNOWN';
  recoveryMigrationId: string | null;
};
export type MetaTransitionSlot = { disposition: 'NEW_ATTEMPT'; checkpointId: string; reservationToken: string }
  | { disposition: 'HISTORICAL_NO_POST'; checkpointId: string; outcome: MetaTransitionCheckpoint['outcome'] };
/** Concrete SQL adapter is a P09-owned extension of ConnectionOperationStore.
 * These are not tenant API inputs. It must resolve the current original actor,
 * reservation, full account scope, original checkpoint and runtime receipts. */
export interface MetaTransitionExecutionStore {
  transitionExecutionContext(job: ConnectionOperationJob, leaseId: string, appId: string): Promise<MetaTransitionExecutionContext>;
  transitionCheckpoint(job: ConnectionOperationJob, stage: MetaTransitionStage): Promise<MetaTransitionCheckpoint | undefined>;
  resolveTransitionExecution(job: ConnectionOperationJob, context: MetaTransitionExecutionContext,
    candidate: MetaRuntimeEvidenceCandidate | undefined, transportSha: string): Promise<MetaActualRequestExecution>;
  reserveTransitionStage(job: ConnectionOperationJob, leaseId: string, stage: MetaTransitionStage,
    requestSha: string, execution: MetaActualRequestExecution): Promise<MetaTransitionSlot>;
  /** Uses the original checkpoint + reservation token, independently of a late lease. */
  recordTransitionResponse(job: ConnectionOperationJob, slot: Extract<MetaTransitionSlot, { disposition: 'NEW_ATTEMPT' }>,
    outcome: 'SUCCEEDED' | 'REJECTED' | 'UNKNOWN', result: unknown): Promise<void>;
  /** Appends an observation; never rewrites the original checkpoint outcome. */
  recordTransitionObservation(job: ConnectionOperationJob, leaseId: string,
    observation: MetaTransitionTargetObservation, originalContextSha: string): Promise<boolean>;
  reconcileTransition(job:ConnectionOperationJob,leaseId:string,appId:string):Promise<boolean>;
  finishTransition(job:ConnectionOperationJob,leaseId:string,succeeded:boolean):Promise<void>;
}
export type MetaTransitionExecutionDependencies = {
  readTransport: typeof currentMetaTransportBinding;
  readRuntime: typeof currentMetaRuntimeCandidate;
};
const held = () => new ProviderError('Account transition remains held.', false, 'META_TRANSITION_NOT_ATTEMPTED', undefined, true);
const semanticHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Called only by the explicit EXECUTE_META_ACCOUNT_TRANSITION dispatcher.
 * Ordinary START, funding verification and preview never enter this function.
 * No loop, automatic provider retry, secret mutation or local activation. */
export async function executeMetaAccountTransition(job: ConnectionOperationJob, leaseId: string, appId: string,
  store: MetaTransitionExecutionStore, secrets: SecretResolver,
  dependencies: MetaTransitionExecutionDependencies = { readTransport: currentMetaTransportBinding, readRuntime: currentMetaRuntimeCandidate }): Promise<void> {
  const initial = await store.transitionExecutionContext(job, leaseId, appId);
  const tokenSecret = await secrets.resolve(initial.secretReference, { kind: 'meta-connection', tenantId: job.tenantId, connectionId: job.connectionId });
  const token = tokenSecret.accessToken ?? tokenSecret.token ?? tokenSecret.value;
  if (!token || initial.appId !== appId || !assertMetaCredentialProof(initial.accountProof, { appId, accessToken: token })) throw held();
  let slot: Extract<MetaTransitionSlot, { disposition: 'NEW_ATTEMPT' }> | undefined;
  const guard = async () => {
    const current = await store.transitionExecutionContext(job, leaseId, appId);
    if (semanticHash(current)!==semanticHash(initial)
      || !assertMetaCredentialProof(current.accountProof, { appId, accessToken: token })) throw held();
    return current;
  };
  const adapter = new MetaGroupsAdapter({ accessToken: token, graphVersion: initial.graphVersion,
    phoneNumberIdFor: () => initial.phoneNumberId, wabaIdFor: () => initial.providerSourceAccountId,
    beforeRequest: async () => { await guard(); }, beforeFinancialMutation: async requestSha => {
      if (initial.stage === 'OBSERVE'||initial.stage==='RECONCILE') throw held();
      const transport = await dependencies.readTransport(initial.graphVersion);
      const candidate = await dependencies.readRuntime({ graphVersion: initial.graphVersion, transportBindingSha256: transport.transportBindingSha256 });
      const execution = await store.resolveTransitionExecution(job, initial, candidate, transport.transportBindingSha256);
      const current = await guard();
      if (execution.mode !== initial.evidenceMode || metaTransitionStageHolds(initial.stage, current.facts).length) throw held();
      const reserved = await store.reserveTransitionStage(job, leaseId, initial.stage, requestSha, execution);
      if (reserved.disposition !== 'NEW_ATTEMPT') throw held();
      // The SQL transaction has committed ATTEMPTED before the adapter's fetch.
      // Losing this local response still leaves the stable slot non-repeatable.
      slot = reserved;
    } });
  const calls = adapter.accountTransitionCalls();
  let migrationId = initial.migrationId;
  if(initial.stage==='RECONCILE'){
    await guard();
    if(!await store.reconcileTransition(job,leaseId,appId))throw held();
    return;
  }
  if (initial.stage !== 'OBSERVE') {
    if(initial.requestedMode==='CUSTOMER'?initial.approvedCreditLineId!==null:
      !initial.financial||initial.approvedCreditLineId!==initial.financial.creditLineId)throw held();
    const prior = await store.transitionCheckpoint(job, initial.stage);
    if (prior) {
      if (prior.ownerId !== initial.transitionId || prior.stage !== initial.stage) throw held();
      // Known-ID read recovery is separate and remains explicit. It does not
      // consume a new mutation slot or activate a successor account.
      if (prior.recoveryMigrationId && prior.recoveryMigrationId === migrationId) {
        const raw = await calls.observe(migrationId);
        const observed = parseMetaMigrationObservation(raw, migrationId, initial.targetCurrency, initial.providerDestinationAccountId ?? undefined);
        if (!await store.recordTransitionObservation(job, leaseId,await readMetaTransitionTarget(job,initial,observed,secrets,guard), initial.admissionSha256)) throw held();
        return;
      }
      throw held();
    }
    if (metaTransitionStageHolds(initial.stage, initial.facts).length) throw held();
    let raw: unknown;
    try {
      raw = initial.stage === 'INITIATE'
        ? await calls.initiate(initial.providerSourceAccountId, initial.targetCurrency, initial.approvedCreditLineId ?? undefined)
        : migrationId ? await calls.complete(migrationId) : (() => { throw held(); })();
    } catch (error) {
      if (slot) {
        const rejected = error instanceof ProviderError && error.outcomeKnown === true;
        await store.recordTransitionResponse(job, slot, rejected ? 'REJECTED' : 'UNKNOWN',
          { reason: rejected ? 'KNOWN_PROVIDER_REJECTION' : 'PROVIDER_OUTCOME_UNRESOLVED' });
      }
      throw error;
    }
    if (!slot) throw held();
    let result: unknown;
    try {
      if (initial.stage === 'INITIATE') {
        const parsed = parseMetaMigrationInitiation(raw);
        migrationId = parsed.migrationId;
        result = { migrationId: parsed.migrationId, migrationStatus: parsed.status };
      } else {
        if (!migrationId) throw held();
        const parsed = parseMetaMigrationObservation(raw, migrationId, initial.targetCurrency, initial.providerDestinationAccountId ?? undefined);
        result = { migrationId: parsed.migrationId, migrationStatus: parsed.status, destination: parsed.destination };
      }
    } catch (error) {
      const recoveryMigrationId = metaMigrationRecoveryId(raw,initial.stage, initial.stage === 'COMPLETE' ? migrationId ?? undefined : undefined);
      await store.recordTransitionResponse(job, slot, 'UNKNOWN', { reason: 'PROVIDER_OUTCOME_UNRESOLVED',
        ...(recoveryMigrationId ? { migrationId: recoveryMigrationId } : {}) });
      throw error;
    }
    // Keep success persistence outside the provider/parse catch. DB uncertainty
    // never downgrades a known response or grants a replacement POST.
    await store.recordTransitionResponse(job, slot, 'SUCCEEDED', result);
    // A new explicit read action refreshes the revision/context after this
    // durable result. Do not silently reuse pre-mutation currentness for GET.
    return;
  }
  if (!migrationId) throw held();
  const observed = parseMetaMigrationObservation(await calls.observe(migrationId), migrationId,
    initial.targetCurrency, initial.providerDestinationAccountId ?? undefined);
  if (!await store.recordTransitionObservation(job, leaseId,await readMetaTransitionTarget(job,initial,observed,secrets,guard), initial.admissionSha256)) throw held();
}

/** Domain-separated private result binding; not the exact outgoing request or
 * PostgreSQL JSONB digest used by historical billing evidence. */
export const metaTransitionResultDigest = (value: unknown) => semanticHash({ domain: 'meta-transition-result-v1', value });
