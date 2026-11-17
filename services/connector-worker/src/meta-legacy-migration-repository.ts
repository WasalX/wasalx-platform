import type { PoolClient } from 'pg';
import type { ConnectionOperationJob } from './connection-operation-repository.js';
import { ConnectionOperationLeaseLostError } from './connection-operation-repository.js';
import type { MetaLegacyMigrationStore, MetaLegacyMigrationContext } from './meta-legacy-migration.js';
import type { MetaActualRequestExecution } from '../../../packages/core/src/meta-account-policy.js';
import type { MetaTemplateInventory } from '../../../packages/core/src/meta-template-inventory.js';
import type { MetaTemplateDependency } from '../../../packages/core/src/meta-template-continuity.js';
import { buildMetaTemplateMapping } from '../../../packages/core/src/meta-template-mapping.js';

type TenantTransaction = <T>(tenantId: string, work: (client: PoolClient) => Promise<T>) => Promise<T>;
type Raw=Record<string,unknown>;
const object=(v:unknown):Raw=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new ConnectionOperationLeaseLostError();return v as Raw;};
function migrationContext(value:unknown,job:ConnectionOperationJob,appId:string):MetaLegacyMigrationContext {
  const v=object(value),left=object(v.source),right=object(v.destination),observed=object(v.templateObservation),safety=object(v.currentTemplateSafety);
  if(v.appId!==appId||v.graphVersion!=='v24.0'||typeof v.transitionId!=='string'
    ||!Number.isSafeInteger(v.revision)||Number(v.revision)<1
    ||!['OBSERVE','REGISTER','RECONCILE'].includes(String(v.stage))
    ||['contextSha256','originalScopeSha256','currentScopeSha256','templateObservationSha256']
      .some(key=>typeof v[key]!=='string'||!/^[a-f0-9]{64}$/u.test(v[key] as string))
    ||typeof v.templateObservationOperationId!=='string'
    ||observed.observationOperationId!==v.templateObservationOperationId
    ||observed.metaFlowDependencyCount!==0||!Number.isSafeInteger(observed.sourceSafetyRevision)||Number(observed.sourceSafetyRevision)<0
    ||!Number.isSafeInteger(observed.targetSafetyRevision)||Number(observed.targetSafetyRevision)<0
    ||!Array.isArray(observed.dependencies)||observed.dependencies.length>2000
    ||!Number.isSafeInteger(safety.source)||Number(safety.source)<0||!Number.isSafeInteger(safety.target)||Number(safety.target)<0)
    throw new ConnectionOperationLeaseLostError();
  for(const asset of [left,right]) {
    if(asset.connectionId!==job.connectionId||typeof asset.accountId!=='string'
      ||typeof asset.providerAccountId!=='string'||!/^\d{1,32}$/u.test(asset.providerAccountId)
      ||typeof asset.phoneId!=='string'||!/^\d{1,32}$/u.test(asset.phoneId)
      ||typeof asset.observedOwnerBusinessId!=='string'||!/^\d{1,32}$/u.test(asset.observedOwnerBusinessId)
      ||typeof asset.secretReference!=='string'||!asset.secretReference)throw new ConnectionOperationLeaseLostError();
    object(asset.credentialProof);
  }
  const source=object(observed.source),target=object(observed.target);
  if(source.accountId!==left.providerAccountId||target.accountId!==right.providerAccountId||source.complete!==true||target.complete!==true
    ||!Array.isArray(source.items)||!Array.isArray(target.items))throw new ConnectionOperationLeaseLostError();
  const dependencies=observed.dependencies.map(value=>{
    const d=object(value);
    if(d.ready!==true)throw new ConnectionOperationLeaseLostError();
    return {flowVersionId:d.flowVersionId,name:d.name,language:d.language,parameterCount:d.parameterCount} as MetaTemplateDependency;
  });
  const mapping=buildMetaTemplateMapping({source:source as unknown as MetaTemplateInventory,target:target as unknown as MetaTemplateInventory,
    sourceSafetyRevision:Number(observed.sourceSafetyRevision),targetSafetyRevision:Number(observed.targetSafetyRevision),
    dependencies,metaFlowDependencyCount:0});
  if(!mapping)throw new ConnectionOperationLeaseLostError();
  return {transitionId:v.transitionId,revision:Number(v.revision),stage:v.stage as MetaLegacyMigrationContext['stage'],appId,graphVersion:'v24.0',
    originalScopeSha256:v.originalScopeSha256 as string,currentScopeSha256:v.currentScopeSha256 as string,contextSha256:v.contextSha256 as string,
    source:left as unknown as MetaLegacyMigrationContext['source'],destination:right as unknown as MetaLegacyMigrationContext['destination'],
    templates:{observationOperationId:v.templateObservationOperationId,observationSha256:v.templateObservationSha256 as string,
      source:source as unknown as MetaTemplateInventory,sourceSafetyRevision:Number(safety.source),targetSafetyRevision:Number(safety.target),
      dependencies,metaFlowDependencyCount:0,originalMapping:mapping},registerAdmission:v.registerAdmission as MetaLegacyMigrationContext['registerAdmission']};
}

/** Same operation ledger and provider-effect table as P08/P09. A false mutation
 * result throws inside the transaction so rejected validation cannot commit a
 * partial target binding/reservation. Original checkpoint read is historical. */
export function metaLegacyMigrationRepository(tenant: TenantTransaction): MetaLegacyMigrationStore {
  const value = <T>(job: ConnectionOperationJob, sql: string, args: unknown[], requireTrue = false): Promise<T> =>
    tenant(job.tenantId, async client => {
      const result = (await client.query<{ value: T }>(sql, args)).rows[0]?.value;
      if (result === null || result === undefined || (requireTrue && result !== true)) throw new ConnectionOperationLeaseLostError();
      return result;
    });
  return {
    context: async (job, lease, appId, phase) => migrationContext(await value<unknown>(job,
      'SELECT app.meta_legacy_migration_context($1,$2,$3,$4,$5) AS value', [job.id, lease, job.fencingToken, appId, phase]),job,appId),
    resolveExecution: (job, ctx, candidate, transport) => candidate
      ? value<MetaActualRequestExecution>(job, 'SELECT app.resolve_meta_runtime_execution($1,$2,$3,$4,$5,$6) AS value',
        [job.tenantId, ctx.destination.accountId, candidate.receiptId, candidate.descriptor, candidate.descriptorSha256, transport])
      : Promise.resolve({ mode: 'UNKNOWN', runtimeEvidenceReceiptId: null, runtimeEvidenceSha256: null, transportBindingSha256: null }),
    originalCheckpoint: (job) => tenant(job.tenantId, async client => {
      const intent = job.payload.metaLegacyMigration as { id?: unknown } | undefined;
      if (typeof intent?.id !== 'string') throw new ConnectionOperationLeaseLostError();
      return (await client.query<{ id: string; outcome: 'ATTEMPTED' | 'SUCCEEDED' | 'REJECTED' | 'UNKNOWN' }>(
        `SELECT checkpoint.id,checkpoint.outcome FROM public.meta_provider_effect_checkpoints checkpoint
         JOIN public.meta_account_transitions plan ON plan.tenant_id=checkpoint.tenant_id AND plan.id=checkpoint.owner_id
         WHERE checkpoint.tenant_id=$1 AND checkpoint.owner_kind='ACCOUNT_TRANSITION' AND checkpoint.owner_id=$2
          AND checkpoint.stage='LEGACY_REGISTER' AND plan.transition_kind='LEGACY_PHONE'
          AND plan.initiating_connection_id=$3`, [job.tenantId, intent.id, job.connectionId])).rows[0] ?? null;
    }),
    reserveOriginalRegister: (job, lease, requestSha256, contextSha256, execution) => value(job,
      'SELECT app.reserve_meta_legacy_registration($1,$2,$3,$4,$5,$6) AS value',
      [job.id, lease, job.fencingToken, requestSha256, contextSha256, execution]),
    recordOriginalRegister: async (job, slot, outcome, result) => {
      await value(job, 'SELECT app.record_meta_legacy_registration($1,$2,$3,$4) AS value',
        [slot.id, slot.reservationToken, outcome, result], true);
    },
    recordReadback: (job, lease, contextSha256, observation) => value(job,
      'SELECT app.record_meta_legacy_readback($1,$2,$3,$4,$5) AS value',
      [job.id, lease, job.fencingToken, contextSha256, observation], true),
    reconcile: (job, lease, contextSha256, observation) => value(job,
      'SELECT app.reconcile_meta_legacy_migration($1,$2,$3,$4,$5) AS value',
      [job.id, lease, job.fencingToken, contextSha256, observation], true),
    failOperation: async(job,lease)=>{await value(job,'SELECT app.fail_meta_legacy_operation($1,$2,$3) AS value',
      [job.id,lease,job.fencingToken],true);},
  };
}
