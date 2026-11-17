import {parseMetaPolicySelection} from '@wasalx/core/meta-billing-policy-contract';
import { ConflictException, BadRequestException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { metaBillingDiagnosticProofCurrent, type MetaBillingDiagnosticBinding } from "@wasalx/core/meta-billing-diagnostic";

/** Declared customer responsibility is independent of observed payment readiness. */
export async function requestMetaCustomerPolicy(client:PoolClient, input:{tenantId:string;connectionId:string;userId:string;
  idempotencyKey:string;expectedRevision:number;requestId:string;binding:MetaBillingDiagnosticBinding;proof:unknown}) {
  const {tenantId,connectionId,binding}=input;
  const privacy=(await client.query<{clear:boolean}>(`SELECT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||$1::text,0))
    AND NOT EXISTS(SELECT 1 FROM privacy_jobs WHERE tenant_id=$1::uuid AND job_type='DELETE' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) AS clear`,[tenantId])).rows[0];
  if(privacy?.clear!==true)throw new ConflictException("Payment settings are unavailable during privacy processing.");
  if (!metaBillingDiagnosticProofCurrent(binding,input.proof,{tenantId,connectionId}) || !binding.wabaId || !binding.providerSessionId || !binding.phoneNumberId)
    throw new ConflictException("Verify the Meta account connection before selecting payment responsibility.");
  const requestSha=createHash("sha256").update(JSON.stringify({connectionId,mode:"CUSTOMER",expectedRevision:input.expectedRevision})).digest("hex");
  const replay=(await client.query<{request_sha256:string}>("SELECT request_sha256 FROM meta_billing_policy_versions WHERE tenant_id=$1 AND idempotency_key=$2",[tenantId,input.idempotencyKey])).rows[0];
  if(replay){if(replay.request_sha256!==requestSha)throw new ConflictException("Idempotency key was used for another request.");
    const operation=(await client.query("SELECT * FROM connection_operations WHERE tenant_id=$1 AND idempotency_key=$2",[tenantId,input.idempotencyKey])).rows[0];
    if(!operation)throw new ConflictException("Payment request receipt is unavailable.");return{operation,duplicate:true};}
  const pending=await client.query("SELECT 1 FROM connection_operations WHERE tenant_id=$1 AND connection_id=$2 AND state IN('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE') LIMIT 1",[tenantId,connectionId]);
  if(pending.rowCount)throw new ConflictException("A connection operation is already pending.");
  // Global numeric identifier uniqueness prevents accidental cross-workspace adoption.
  // A collision remains a generic hold; it does not establish legal ownership.
  await client.query("INSERT INTO meta_messaging_accounts(tenant_id,provider_account_id) VALUES($1,$2) ON CONFLICT(provider_account_id) DO NOTHING",[tenantId,binding.wabaId]);
  const account=(await client.query<{id:string;authority_revision:string;last_observation_operation_id:string|null}>("SELECT id,authority_revision,last_observation_operation_id FROM meta_messaging_accounts WHERE tenant_id=$1 AND provider_account_id=$2 AND state<>'RETIRED' FOR UPDATE",[tenantId,binding.wabaId])).rows[0];
  if(!account)throw new ConflictException("The Meta account requires an access review.");
  await client.query('SELECT app.assert_meta_account_unreserved($1)',[account.id]);
  const current=Number(account.authority_revision);
  const prior=await client.query("SELECT 1 FROM meta_billing_policy_versions WHERE tenant_id=$1 AND account_id=$2 LIMIT 1",[tenantId,account.id]);
  if(input.expectedRevision!==(prior.rowCount?current:0))throw new ConflictException("Payment settings changed. Refresh and try again.");
  const proof=input.proof as {credentialFingerprint:string};
  const bound=(await client.query<{id:string;revision:string;account_id:string}>(`INSERT INTO meta_connection_account_bindings
    (tenant_id,account_id,connection_id,provider_session_id,phone_number_id,app_id,secret_reference,credential_fingerprint,proof_sha256)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,encode(public.digest((s.provider_state_data->'metaAccountProof')::text,'sha256'),'hex')
      FROM (SELECT provider_state_data FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$3 AND id=$4
        AND opaque_session_id=$5 AND ownership_state='ACTIVE' AND state IN('WORKING','PAUSED')
        AND app.meta_account_proof_sha256(provider_state_data->'metaAccountProof')=$9 FOR SHARE) s WHERE true
    ON CONFLICT(tenant_id,connection_id) WHERE state<>'RETIRED' DO UPDATE SET provider_session_id=EXCLUDED.provider_session_id,
      phone_number_id=EXCLUDED.phone_number_id,app_id=EXCLUDED.app_id,secret_reference=EXCLUDED.secret_reference,
      credential_fingerprint=EXCLUDED.credential_fingerprint,proof_sha256=EXCLUDED.proof_sha256,state=CASE WHEN meta_connection_account_bindings.account_transition_id IS NOT NULL THEN meta_connection_account_bindings.state ELSE 'ACTIVE' END,
      revision=meta_connection_account_bindings.revision+1,updated_at=now()
    WHERE meta_connection_account_bindings.account_id=EXCLUDED.account_id AND meta_connection_account_bindings.state<>'RETIRED'
    RETURNING id,revision,account_id`,[tenantId,account.id,connectionId,binding.providerSessionId,binding.phoneNumberId,binding.appId,
      binding.secretReference,proof.credentialFingerprint,binding.proofSha256])).rows[0];
  if(!bound)throw new ConflictException("Changing the connected Meta account requires an access review.");
  const policyId=randomUUID();
  await client.query(`INSERT INTO meta_billing_policy_versions(id,tenant_id,account_id,version,mode,requested_by,request_sha256,idempotency_key)
    SELECT $1,$2,$3,COALESCE(max(version),0)+1,'CUSTOMER',$4,$5,$6 FROM meta_billing_policy_versions WHERE tenant_id=$2 AND account_id=$3`,
    [policyId,tenantId,account.id,input.userId,requestSha,input.idempotencyKey]);
  const revision=current+1;
  await client.query("UPDATE meta_messaging_accounts SET requested_policy_version_id=$1,state='HELD',authority_revision=$2,updated_at=now() WHERE tenant_id=$3 AND id=$4",[policyId,revision,tenantId,account.id]);
  const operation=(await client.query(`INSERT INTO connection_operations(tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,requested_by_id,request_id)
    VALUES($1,$2,'VERIFY_META_BILLING',$3,$4,'USER',$5,$6) RETURNING *`,[tenantId,connectionId,input.idempotencyKey,
      {metaBillingDiagnostic:binding,metaAccountPolicy:{accountId:account.id,bindingId:bound.id,bindingRevision:Number(bound.revision),authorityRevision:revision,policyVersionId:policyId,observationOperationId:account.last_observation_operation_id}},input.userId,input.requestId])).rows[0];
  return{operation,duplicate:false};
}

export type {MetaPolicySelection} from '@wasalx/core/meta-billing-policy-contract';
export function metaPolicyBody(body:unknown){
 try{return parseMetaPolicySelection(body);}catch{throw new BadRequestException("Select an available payment option and review its terms.");}
}
