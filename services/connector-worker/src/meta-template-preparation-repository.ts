import type { PoolClient } from 'pg';
import { metaTransitionContext } from '../../../packages/core/src/meta-account-transition-context.js';
import type { MetaActualRequestExecution } from '../../../packages/core/src/meta-account-policy.js';
import type { MetaTemplatePreparationStore, MetaTemplatePreparationContext } from './meta-template-preparation.js';
import { ConnectionOperationLeaseLostError, type ConnectionOperationJob } from './connection-operation-repository.js';
type Tenant = <T>(tenantId: string, work: (client: PoolClient) => Promise<T>) => Promise<T>;
type Raw = Record<string, unknown>;
function object(value: unknown): Raw { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectionOperationLeaseLostError(); return value as Raw; }
function context(value: unknown, job: ConnectionOperationJob, appId: string): MetaTemplatePreparationContext {
  const v = object(value), source = object(v.source), target = object(v.target);
  if (typeof v.actorId !== 'string' || typeof target.connectionId !== 'string' || typeof v.transitionId !== 'string'
    || typeof v.contextSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(v.contextSha256)
    || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1 || v.appId !== appId || v.graphVersion !== 'v24.0'
    || !['OBSERVE', 'COPY', 'RECONCILE'].includes(String(v.stage))) throw new ConnectionOperationLeaseLostError();
  const normalize = (raw: Raw, connectionId: string) => {
    const parsed = metaTransitionContext(raw, { tenantId: job.tenantId, connectionId, actorId: v.actorId as string, appId });
    if (typeof raw.observedOwnerBusinessId !== 'string' || !/^\d{1,32}$/u.test(raw.observedOwnerBusinessId)
      || !Number.isSafeInteger(raw.safetyRevision) || Number(raw.safetyRevision) < 0) throw new ConnectionOperationLeaseLostError();
    return { parsed, account: { id: parsed.accountId, providerId: parsed.providerAccountId, connectionId,
      phoneId: parsed.session.opaqueSessionId, secretReference: parsed.secretReference,
      credentialProof: parsed.session.providerStateData.metaAccountProof, observedOwnerBusinessId: raw.observedOwnerBusinessId,
      safetyRevision: Number(raw.safetyRevision) } };
  };
  const left = normalize(source, job.connectionId), right = normalize(target, target.connectionId);
  const selected = v.selectedSourceIds;
  if (!Array.isArray(selected) || selected.length > 500 || selected.some(id => typeof id !== 'string' || !/^\d{1,32}$/u.test(id)))
    throw new ConnectionOperationLeaseLostError();
  return { transitionId: v.transitionId, revision: Number(v.revision), stage: v.stage as MetaTemplatePreparationContext['stage'], appId,
    graphVersion: 'v24.0', source: left.account, target: right.account, contextSha256: v.contextSha256,
    dependencies: [...left.parsed.templateDependencies], metaFlowDependencyCount: left.parsed.metaFlowDependencies.length,
    selectedSourceIds: selected as string[], selectedInventory: v.selectedInventory as MetaTemplatePreparationContext['selectedInventory'],
    selectedTargetInventory: v.selectedTargetInventory as MetaTemplatePreparationContext['selectedTargetInventory'] };
}

/** Uses the incumbent tenant transaction. No exception is caught inside a
 * transaction and turned into success after partially writing a checkpoint. */
export function metaTemplatePreparationRepository(tenant: Tenant): MetaTemplatePreparationStore {
  const value = <T>(job: ConnectionOperationJob, sql: string, args: unknown[]): Promise<T> => tenant(job.tenantId, async client => {
    const result = (await client.query<{ value: T }>(sql, args)).rows[0]?.value;
    if (result === null || result === undefined) throw new ConnectionOperationLeaseLostError(); return result;
  });
  return {
    templatePreparationContext: async (job, lease, appId) => context(await value(job,
      'SELECT app.meta_template_operation_context($1,$2,$3,$4) AS value', [job.id, lease, job.fencingToken, appId]), job, appId),
    templateCopyCheckpoint: (job) => tenant(job.tenantId, async client => {
      const intent = object(job.payload.metaTemplatePreparation);
      return (await client.query<{ outcome: 'ATTEMPTED' | 'SUCCEEDED' | 'REJECTED' | 'UNKNOWN' }>(
        `SELECT outcome FROM meta_provider_effect_checkpoints WHERE tenant_id=$1 AND owner_kind='ACCOUNT_TRANSITION'
         AND owner_id=$2 AND stage='TEMPLATE_COPY'`, [job.tenantId, intent.id])).rows[0] ?? null;
    }),
    resolveTemplateExecution: async (job, ctx, candidate, transport) => candidate
      ? value<MetaActualRequestExecution>(job, 'SELECT app.resolve_meta_runtime_execution($1,$2,$3,$4,$5,$6) AS value',
        [job.tenantId, ctx.target.id, candidate.receiptId, candidate.descriptor, candidate.descriptorSha256, transport])
      : { mode: 'UNKNOWN', runtimeEvidenceReceiptId: null, runtimeEvidenceSha256: null, transportBindingSha256: null },
    reserveTemplateCopy: (job, lease, sha, execution, appId) => value(job,
      'SELECT app.reserve_meta_template_copy($1,$2,$3,$4,$5,$6) AS value', [job.id, lease, job.fencingToken, appId, sha, execution]),
    recordTemplateCopyResponse: async (job, slot, outcome, result) => {
      if (await value(job, 'SELECT app.record_meta_template_copy_response($1,$2,$3,$4) AS value',
        [slot.id, slot.reservationToken, outcome, result]) !== true) throw new Error('Original template response conflicts with retained evidence.');
    },
    completeTemplateObservation: async (job, lease, sha, observation, appId) => value(job,
      'SELECT app.complete_meta_template_observation($1,$2,$3,$4,$5,$6) AS value', [job.id, lease, job.fencingToken, appId, sha, observation]),
    failTemplateOperation: async (job, lease) => {
      if (await value(job, 'SELECT app.fail_meta_template_operation($1,$2,$3) AS value', [job.id, lease, job.fencingToken]) !== true)
        throw new ConnectionOperationLeaseLostError();
    },
  };
}
