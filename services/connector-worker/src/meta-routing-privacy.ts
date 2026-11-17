import type { PoolClient } from "pg";
import type { PrivacyJob } from "./privacy-repository.js";

/** Routing receipts use the existing discovered-target and LOCAL-lease authority. */
export async function discoverMetaRoutingPrivacy(client:PoolClient,job:PrivacyJob){
  await client.query(`INSERT INTO privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256)
    SELECT $1::uuid,$2::uuid,'META_ROUTING_EVENT',source.id::text,encode(digest(source.id::text,'sha256'),'hex')
    FROM event_inbox source JOIN retention_policies policy ON policy.tenant_id=source.tenant_id
    WHERE source.tenant_id=$1 AND source.meta_routing_evidence IS NOT NULL AND source.meta_routing_evidence->'redacted' IS DISTINCT FROM 'true'::jsonb
      AND source.received_at<=(SELECT created_at FROM privacy_jobs WHERE tenant_id=$1 AND id=$2)
      AND (($3='DELETE' AND($4='TENANT' OR($4='PARTICIPANT' AND app.meta_direct_participant_matches(source.connection_id,source.meta_routing_evidence#>>'{peer,value}',$5))))
        OR EXISTS(SELECT 1 FROM normalized_messages message JOIN privacy_job_targets target ON target.tenant_id=message.tenant_id
          AND target.job_id=$2 AND target.target_type='NORMALIZED_MESSAGE' AND target.target_id=message.id::text
          WHERE message.tenant_id=source.tenant_id AND message.event_inbox_id=source.id)
        OR EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias JOIN privacy_job_targets target ON target.tenant_id=alias.tenant_id
          AND target.job_id=$2 AND target.target_type='META_DIRECT_ALIAS' AND target.target_id=alias.id::text
          WHERE alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id
            AND(alias.participant_identity_id=source.meta_routing_participant_id OR(alias.kind=source.meta_routing_evidence#>>'{peer,kind}' AND alias.value=source.meta_routing_evidence#>>'{peer,value}')))
        OR($3='RETENTION_SWEEP' AND policy.state='ACTIVE' AND(source.meta_routing_evidence->>'observedAt')::timestamptz
          <=$6::timestamptz-make_interval(days=>policy.resolved_case_days)))
      AND CASE WHEN source.meta_routing_evidence#>>'{peer,value}' IS NULL THEN NOT app.has_applicable_privacy_hold('TENANT',$1::text)
        ELSE NOT app.has_applicable_privacy_hold('PARTICIPANT',source.meta_routing_evidence#>>'{peer,value}') END
    ON CONFLICT(tenant_id,job_id,target_type,target_sha256) DO NOTHING`,[job.tenantId,job.id,job.jobType,job.scopeType,job.scopeValue,job.createdAt]);
  await client.query(`INSERT INTO privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256)
    SELECT $1::uuid,$2::uuid,'META_ROUTING_ACTION',action.id::text,encode(digest(action.id::text,'sha256'),'hex')
    FROM meta_thread_control_actions action JOIN retention_policies policy ON policy.tenant_id=action.tenant_id
    WHERE action.tenant_id=$1 AND action.redacted_at IS NULL AND action.state IN('SUCCEEDED','FAILED')
      AND action.created_at<=(SELECT created_at FROM privacy_jobs WHERE tenant_id=$1 AND id=$2)
      AND(($3='DELETE' AND($4='TENANT' OR($4='PARTICIPANT' AND app.meta_direct_participant_matches(action.connection_id,action.recipient_snapshot->>'value',$5))))
        OR EXISTS(SELECT 1 FROM bot_conversations conversation JOIN privacy_job_targets target ON target.tenant_id=conversation.tenant_id
          AND target.job_id=$2 AND target.target_type='ZAMMAD_TICKET' AND target.target_id=conversation.zammad_ticket_id
          WHERE conversation.tenant_id=action.tenant_id AND conversation.id=action.conversation_id)
        OR($3='RETENTION_SWEEP' AND policy.state='ACTIVE' AND action.created_at<=$6::timestamptz-make_interval(days=>policy.resolved_case_days)))
      AND NOT app.has_applicable_privacy_hold('PARTICIPANT',action.recipient_snapshot->>'value')
    ON CONFLICT(tenant_id,job_id,target_type,target_sha256) DO NOTHING`,[job.tenantId,job.id,job.jobType,job.scopeType,job.scopeValue,job.createdAt]);
}

export async function finalizeMetaRoutingPrivacy(client:PoolClient,job:PrivacyJob){
  // Remove derived grants before detaching their personal source references.
  await client.query(`DELETE FROM meta_primary_delivery_admissions admission WHERE admission.tenant_id=$1 AND EXISTS(
    SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=admission.tenant_id AND target.job_id=$2
      AND target.target_type='META_ROUTING_EVENT' AND target.target_id=admission.source_event_id::text)`,[job.tenantId,job.id]);
  await client.query(`DELETE FROM meta_thread_ownership ownership WHERE ownership.tenant_id=$1 AND EXISTS(
    SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=ownership.tenant_id AND target.job_id=$2
      AND((target.target_type='META_ROUTING_EVENT' AND target.target_id=ownership.source_event_id::text)
        OR(target.target_type='META_ROUTING_ACTION' AND target.target_id=ownership.source_action_id::text)
        OR(target.target_type='META_DIRECT_ALIAS' AND EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias
          WHERE alias.tenant_id=ownership.tenant_id AND alias.id::text=target.target_id AND alias.participant_identity_id=ownership.participant_identity_id))))`,[job.tenantId,job.id]);
  await client.query(`UPDATE event_inbox source SET payload='{}'::jsonb,meta_routing_evidence=(meta_routing_evidence-'peer')||'{"redacted":true}'::jsonb,
    meta_routing_participant_id=NULL,provider_event_id='redacted:'||provider_event_id_sha256,status='REDACTED',safe_error=NULL,
    processed_at=COALESCE(processed_at,now()),lease_id=NULL,lease_expires_at=NULL,updated_at=now()
    WHERE source.tenant_id=$1 AND EXISTS(SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=source.tenant_id
      AND target.job_id=$2 AND target.target_type='META_ROUTING_EVENT' AND target.target_id=source.id::text)`,[job.tenantId,job.id]);
  await client.query(`UPDATE meta_thread_control_actions action SET recipient_snapshot=jsonb_build_object('redacted',true,'sha256',encode(digest(recipient_snapshot::text,'sha256'),'hex')),
    participant_identity_id=NULL,conversation_id=NULL,redacted_at=clock_timestamp()
    WHERE action.tenant_id=$1 AND action.redacted_at IS NULL AND EXISTS(SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=action.tenant_id
      AND target.job_id=$2 AND target.target_type='META_ROUTING_ACTION' AND target.target_id=action.id::text)`,[job.tenantId,job.id]);
}

export async function exportMetaRoutingPrivacy(client:PoolClient,tenantId:string,all:boolean,participants:string[]){
  const events=(await client.query(`SELECT source.id,source.connection_id,source.meta_routing_evidence,source.received_at,
    (SELECT jsonb_build_object('claim','PRIMARY_DELIVERY','appId',admission.app_id,'runtime',admission.runtime_binding,
      'observedAt',admission.observed_at,'createdAt',admission.created_at)
     FROM meta_primary_delivery_admissions admission WHERE admission.tenant_id=source.tenant_id AND admission.source_event_id=source.id) AS primary_delivery
    FROM event_inbox source
    WHERE source.tenant_id=$1 AND source.meta_routing_evidence IS NOT NULL AND source.meta_routing_evidence->'redacted' IS DISTINCT FROM 'true'::jsonb
      AND($2 OR EXISTS(SELECT 1 FROM unnest($3::text[]) scope(value) WHERE app.meta_direct_participant_matches(source.connection_id,source.meta_routing_evidence#>>'{peer,value}',scope.value)))
    ORDER BY received_at,id LIMIT 5001`,[tenantId,all,participants])).rows;
  const actions=(await client.query(`SELECT action.id,action.connection_id,action.action,action.target_role,action.recipient_snapshot,action.state,
    action.provider_request_id,action.created_at,action.completed_at FROM meta_thread_control_actions action
    WHERE action.tenant_id=$1 AND action.redacted_at IS NULL AND($2 OR EXISTS(SELECT 1 FROM unnest($3::text[]) scope(value)
      WHERE app.meta_direct_participant_matches(action.connection_id,action.recipient_snapshot->>'value',scope.value))) ORDER BY created_at,id LIMIT 5001`,[tenantId,all,participants])).rows;
  if(events.length>5000||actions.length>5000)throw new Error("Routing export exceeds the supported scope");
  return{events,actions};
}
