import type {PoolClient} from 'pg';
import type {ConnectionOperationJob} from './connection-operation-repository.js';
import {ConnectionOperationLeaseLostError} from './connection-operation-repository.js';
import {metaTransitionResultDigest,type MetaTransitionExecutionStore,type MetaTransitionExecutionContext,
 type MetaTransitionCheckpoint,type MetaTransitionSlot} from './meta-account-transition-execution.js';
import type {MetaActualRequestExecution} from '../../../packages/core/src/meta-account-policy.js';

export type MetaTransitionTenantTransaction=<T>(tenantId:string,work:(client:PoolClient)=>Promise<T>)=>Promise<T>;
export function metaTransitionExecutionRepository(tenant:MetaTransitionTenantTransaction):MetaTransitionExecutionStore {
 const value=async<T>(job:ConnectionOperationJob,sql:string,args:unknown[]):Promise<T>=>tenant(job.tenantId,async client=>{
  const result=(await client.query<{value:T}>(sql,args)).rows[0]?.value;
  if(result===undefined||result===null)throw new ConnectionOperationLeaseLostError();return result;
 });
 return {
  transitionExecutionContext:(job,lease,app)=>value<MetaTransitionExecutionContext>(job,
   'SELECT app.meta_transition_operation_context($1,$2,$3,$4) AS value',[job.id,lease,job.fencingToken,app]),
  transitionCheckpoint:async(job,stage)=>tenant(job.tenantId,async client=>{
   const intent=job.payload.metaAccountTransitionExecution as {id?:unknown}|undefined;
   if(typeof intent?.id!=='string')throw new ConnectionOperationLeaseLostError();
   const r=(await client.query<{id:string;owner_id:string;stage:MetaTransitionCheckpoint['stage'];outcome:MetaTransitionCheckpoint['outcome'];result:{migrationId?:unknown}|null}>(
    `SELECT id,owner_id,stage,outcome,result FROM public.meta_provider_effect_checkpoints
     WHERE tenant_id=$1 AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=$2 AND stage=$3`,[job.tenantId,intent.id,stage])).rows[0];
   return r?{id:r.id,ownerId:r.owner_id,stage:r.stage,outcome:r.outcome,recoveryMigrationId:typeof r.result?.migrationId==='string'?r.result.migrationId:null}:undefined;
  }),
  resolveTransitionExecution:async(job,context,candidate,transportSha)=>candidate
   ?value<MetaActualRequestExecution>(job,'SELECT app.resolve_meta_runtime_execution($1,$2,$3,$4,$5,$6) AS value',
     [job.tenantId,context.sourceAccountId,candidate.receiptId,candidate.descriptor,candidate.descriptorSha256,transportSha])
   :{mode:'UNKNOWN',runtimeEvidenceReceiptId:null,runtimeEvidenceSha256:null,transportBindingSha256:null},
  reserveTransitionStage:(job,lease,_stage,requestSha,execution)=>value<MetaTransitionSlot>(job,
   'SELECT app.reserve_meta_account_transition_stage($1,$2,$3,$4,$5) AS value',[job.id,lease,job.fencingToken,requestSha,execution]),
  recordTransitionResponse:async(job,slot,outcome,result)=>{
   if(await value<boolean>(job,'SELECT app.record_meta_transition_response($1,$2,$3,$4,$5) AS value',
    [slot.checkpointId,slot.reservationToken,outcome,result,metaTransitionResultDigest(result)])!==true)
    throw new Error('Original transition response conflicts with retained evidence.');
  },
  recordTransitionObservation:(job,lease,observation,contextSha)=>value<boolean>(job,
   'SELECT app.record_meta_transition_observation($1,$2,$3,$4,$5) AS value',[job.id,lease,job.fencingToken,observation,contextSha]),
  reconcileTransition:(job,lease,app)=>value<boolean>(job,
   'SELECT app.reconcile_meta_account_transition($1,$2,$3,$4) AS value',[job.id,lease,job.fencingToken,app]),
  finishTransition:async(job,lease,succeeded)=>{
   if(await value<boolean>(job,'SELECT app.finish_meta_transition_operation($1,$2,$3,$4) AS value',
    [job.id,lease,job.fencingToken,succeeded])!==true)throw new ConnectionOperationLeaseLostError();
  },
 };
}
