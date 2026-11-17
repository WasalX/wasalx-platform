import {BadRequestException,ConflictException,ForbiddenException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {assertMetaCredentialProof,assertMetaLifecycleAccess} from '@wasalx/core/meta-account-relation';
import {metaRoutingRuntime} from '@wasalx/core/meta-routing';
import {META_ADD_ACCESS_ACTIVATION_REASONS,parseMetaAddAccessActivationRequest,type MetaAddAccessActivationView,type MetaAddAccessActivationReason} from '@wasalx/core/meta-add-access-activation-contract';
import type {AuthenticatedRequest} from './types.js';
import {requirePrivilegedAuthentication} from './privileged-auth.js';
import {appendAudit} from './audit.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const reasons=new Set<MetaAddAccessActivationReason>(META_ADD_ACCESS_ACTIVATION_REASONS);
type Context={applicable:boolean;reason:MetaAddAccessActivationReason;contextVersion?:string;admission?:Record<string,unknown>;credentialProof?:unknown};
export function metaActivationId(id:string){if(!uuid.test(id))throw new BadRequestException('Connection is invalid');return id;}
async function context(client:PoolClient,connectionId:string):Promise<Context>{
  const value=(await client.query<{value:Context}>('SELECT app.meta_add_access_activation_context($1,$2,$3::jsonb) AS value',
    [connectionId,process.env.META_APP_ID??'',JSON.stringify(metaRoutingRuntime(process.env))])).rows[0]?.value;
  if(!value||typeof value.applicable!=='boolean'||!reasons.has(value.reason))throw new ConflictException('Connection activation is unavailable');
  if(value.reason==='READY_TO_CHECK'){
    try{
      if(!value.admission||!value.contextVersion||!/^[0-9a-f]{64}$/u.test(value.contextVersion)
        ||!assertMetaCredentialProof(value.credentialProof,{appId:process.env.META_APP_ID??''}))throw new Error('Credential context unavailable');
      // SQL fences pending signed lifecycle events; the shared parser also rejects
      // malformed or already blocked persisted lifecycle state.
      const state=(await client.query<{value:unknown}>('SELECT provider_state_data->\'metaLifecycle\' AS value FROM provider_sessions WHERE tenant_id=app.current_tenant_id() AND id=$1',
        [value.admission.providerSessionId])).rows[0];
      assertMetaLifecycleAccess(state?.value??undefined);
    }catch{return{applicable:true,reason:'CREDENTIAL_REQUIRED'};}
  }
  return value;
}
export async function metaActivationView(client:PoolClient,connectionId:string):Promise<MetaAddAccessActivationView>{
  metaActivationId(connectionId);const current=await context(client,connectionId);
  const operation=(await client.query<{id:string;state:string;locally_activated:boolean}>(`SELECT id,state,
    COALESCE(state='SUCCEEDED' AND result->'metaAddAccessActivated'='true'::jsonb,false) AS locally_activated
    FROM connection_operations WHERE tenant_id=app.current_tenant_id() AND connection_id=$1 AND payload ? 'metaAddAccessActivation'
    ORDER BY created_at DESC,id DESC LIMIT 1`,[connectionId])).rows[0];
  return{connectionId,applicable:current.applicable,readyToCheck:current.reason==='READY_TO_CHECK',reason:current.reason,
    contextVersion:current.reason==='READY_TO_CHECK'?current.contextVersion!:null,
    operation:operation?{id:operation.id,state:operation.state,locallyActivated:operation.locally_activated}:null,
    providerConfigurationReadback:false,conversationPermission:'SEPARATE_REQUIRED'};
}
export async function queueMetaActivation(client:PoolClient,request:AuthenticatedRequest,connectionId:string,key:unknown,body:unknown){
  metaActivationId(connectionId);
  if(!process.env.PORTAL_PUBLIC_ORIGIN||request.headers.origin!==process.env.PORTAL_PUBLIC_ORIGIN)throw new ForbiddenException('Request origin is invalid');
  if(typeof key!=='string'||!key||key.length>255||key.trim()!==key||/\p{Cc}/u.test(key))throw new BadRequestException('Idempotency key is invalid');
  let input;try{input=parseMetaAddAccessActivationRequest(body);}catch{throw new BadRequestException('Activation request is invalid');}
  await requirePrivilegedAuthentication(client,request.principal,'activating saved Meta access');
  const actor=(await client.query<{current:boolean}>('SELECT app.meta_add_access_activation_actor($1) AS current',[request.principal.userId])).rows[0];
  if(actor?.current!==true)throw new ForbiddenException('Connection administration requires current membership');
  const {tenantId,userId}=request.principal;
  const replay=async()=>{
    const existing=(await client.query(`SELECT operation.*,connection.state AS connection_state FROM connection_operations operation
      JOIN connections connection ON connection.tenant_id=operation.tenant_id AND connection.id=operation.connection_id
      WHERE operation.tenant_id=$1 AND operation.idempotency_key=$2`,[tenantId,key])).rows[0];
    if(existing&&(existing.connection_id!==connectionId||existing.operation_type!=='START'||existing.requested_by_type!=='USER'
      ||existing.requested_by_id!==userId||existing.payload?.metaAddAccessExpectedContextVersion!==input.expectedContextVersion))
      throw new ConflictException('Idempotency key belongs to another operation');
    return existing;
  };
  const previous=await replay();if(previous)return{operation:previous,duplicate:true};
  const current=await context(client,connectionId);
  // context locks the connection, so a racing identical request is now visible.
  const raced=await replay();if(raced)return{operation:raced,duplicate:true};
  if(current.reason!=='READY_TO_CHECK'||!current.admission||current.contextVersion!==input.expectedContextVersion)
    throw new ConflictException({code:'META_ADD_ACCESS_ACTIVATION_CHANGED',message:'Refresh the connection checks before activating.'});
  const a=current.admission;
  const operation=(await client.query(`INSERT INTO connection_operations
    (tenant_id,connection_id,operation_type,idempotency_key,payload,max_attempts,requested_by_type,requested_by_id,request_id)
    VALUES($1,$2,'START',$3,$4::jsonb,1,'USER',$5,$6) RETURNING *`,[tenantId,connectionId,key,
    JSON.stringify({requestedFromState:'PAUSED',metaBinding:{secretReference:a.secretReference,providerSessionId:a.providerSessionId,phoneNumberId:a.phoneNumberId,wabaId:a.wabaId},
      metaLifecycleExpectedRevision:a.lifecycleRevision,metaAddAccessActivation:a,metaAddAccessExpectedContextVersion:input.expectedContextVersion}),userId,String(request.id)])).rows[0];
  if(!operation)throw new ConflictException('Activation operation is unavailable');
  await appendAudit(client,request.principal,{action:'connection.meta_saved_access_activation_requested',targetType:'connection',targetId:connectionId,
    requestId:String(request.id),newValue:{operation_id:operation.id,providerEffects:'READ_ONLY',conversationPermission:'SEPARATE_REQUIRED'}});
  return{operation:{...operation,connection_state:'PAUSED'},duplicate:false};
}
