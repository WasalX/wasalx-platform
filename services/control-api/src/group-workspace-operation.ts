import { ConflictException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { ZammadClaims } from "./service-auth.service.js";
import { groupWorkspaceAccessSql } from "./group-workspace-access.js";

export type GroupWorkspaceOperationKind="SEND"|"REACTION";
export type GroupWorkspaceOperationBinding={claims:ZammadClaims;groupId:string;kind:GroupWorkspaceOperationKind;key:string;targetMessageId:string|null};
type Receipt={disposition:"ADMITTED"|"CANCELLED";zammad_instance_id:string;zammad_user_id:string;whatsapp_group_id:string;
  kind:GroupWorkspaceOperationKind;target_message_id:string|null;request_sha256:string|null;delivery_id:string|null;
  state:string|null;created_at:string};
type Unproven={disposition:"UNKNOWN"};
type VisibleDelivery={id:string;state:string;message_text:string;participant_name:string|null;provider_timestamp:string;
  media_filename?:string|null;media_mime_type?:string|null;media_available?:boolean|null;sender_phone?:string|null};
const REACTION_CONTENT_TYPE="application/vnd.wasalx.whatsapp-reaction";
const UUID_REQUEST=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_NATIVE_KEY_SQL="^group-workspace(-reaction)?:[1-9][0-9]{0,15}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

function nativeOperationRequestId(kind:GroupWorkspaceOperationKind,userId:string,key:string){
  const prefix=`${kind==="SEND"?"group-workspace":"group-workspace-reaction"}:${userId}:`;
  const requestId=key.startsWith(prefix)?key.slice(prefix.length):"";
  return UUID_REQUEST.test(requestId)?requestId:null;
}

export function canonicalGroupWorkspaceSubmissionKey(kind:GroupWorkspaceOperationKind,userId:string,key:string){
  const requestId=nativeOperationRequestId(kind,userId,key);
  return requestId?groupWorkspaceOperationKey(kind,userId,requestId):key;
}

export function groupWorkspaceOperationKey(kind:GroupWorkspaceOperationKind,userId:string,requestId:string){
  return `${kind==="SEND"?"group-workspace":"group-workspace-reaction"}:${userId}:${requestId.toLowerCase()}`;
}

export async function lockGroupWorkspaceOperation(client:PoolClient,binding:GroupWorkspaceOperationBinding){
  const {claims,groupId}=binding;
  const key=canonicalGroupWorkspaceSubmissionKey(binding.kind,claims.userId!,binding.key);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`group-workspace-operation:${claims.tenantId}:${key}`]);
  const access=(await client.query(`SELECT g.id FROM whatsapp_groups g
    JOIN tenant_settings tenant_settings ON tenant_settings.tenant_id=g.tenant_id
    JOIN tenants tenant ON tenant.id=g.tenant_id AND tenant.state='ACTIVE'
    JOIN zammad_instances instance ON instance.tenant_id=g.tenant_id AND instance.id=$6 AND instance.state='WORKING'
    JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
    WHERE g.tenant_id=$1 AND g.id=$2 AND tenant_settings.group_workspace_enabled AND workspace.capture_enabled
      AND ${groupWorkspaceAccessSql("g","workspace","$3","$4","$5")}
    FOR SHARE OF g,workspace`,[claims.tenantId,groupId,claims.userId,claims.groupIds,claims.groupAdmin,claims.instanceId])).rows[0];
  if(!access)throw new NotFoundException("Group workspace was not found");
  // Recheck managed membership after waiting; legacy native actors have no projection.
  const membership=(await client.query<{revision:string|number;role:string;allowed:boolean}>(`SELECT p.revision,p.role,
    (p.sync_state='READY' AND p.revision=p.applied_revision AND p.member_state='ACTIVE' AND p.role<>'auditor'
      AND m.state='ACTIVE' AND m.role=p.role AND tenant.state='ACTIVE'
      AND u.oidc_subject=p.oidc_subject AND p.email=u.email AND settings.native_membership_sync_enabled) AS allowed
    FROM native_membership_projections p JOIN tenants tenant ON tenant.id=p.tenant_id
    JOIN users u ON u.id=p.user_id JOIN tenant_settings settings ON settings.tenant_id=p.tenant_id
    LEFT JOIN tenant_memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.user_id
    WHERE p.tenant_id=$1 AND p.zammad_instance_id=$2 AND p.native_user_id=$3`,[claims.tenantId,claims.instanceId,claims.userId])).rows[0];
  if(membership&&(!membership.allowed||claims.membershipRevision!==Number(membership.revision)
    ||(claims.groupAdmin&&!["tenant_owner","tenant_admin"].includes(membership.role))))
    throw new UnauthorizedException("Current agent membership is required");
  if(!membership&&claims.membershipRevision!==undefined)throw new UnauthorizedException("Current agent membership is required");
  if(claims.expiresAt!==undefined&&Math.floor(Date.now()/1000)>=claims.expiresAt)
    throw new UnauthorizedException("Agent assertion has expired");
}

export async function readGroupWorkspaceOperation(client:PoolClient,binding:GroupWorkspaceOperationBinding):Promise<Receipt|Unproven|null>{
  const {claims,groupId,kind,targetMessageId}=binding;
  const key=canonicalGroupWorkspaceSubmissionKey(kind,claims.userId!,binding.key);
  const nativeRequest=nativeOperationRequestId(kind,claims.userId!,key);
  // Only the complete server-owned native key is a UUID alias; arbitrary legacy keys stay opaque.
  const aliases=nativeRequest?(await client.query<{id:string;idempotency_key:string}>(`SELECT id,idempotency_key FROM delivery_outbox
    WHERE tenant_id=$1 AND idempotency_key ~ '${UUID_NATIVE_KEY_SQL}' AND lower(idempotency_key)=$2 LIMIT 2`,[claims.tenantId,key])).rows:null;
  const receipts=(await client.query<Receipt>(`SELECT receipt.*,delivery.state
    FROM group_workspace_operation_receipts receipt LEFT JOIN delivery_outbox delivery
      ON delivery.tenant_id=receipt.tenant_id AND delivery.id=receipt.delivery_id
    WHERE receipt.tenant_id=$1 AND ${nativeRequest?`receipt.idempotency_key ~ '${UUID_NATIVE_KEY_SQL}' AND lower(receipt.idempotency_key)=$2`:"receipt.idempotency_key=$2"}
    LIMIT 2`,[claims.tenantId,key])).rows;
  if(receipts.length>1)return{disposition:"UNKNOWN"};
  const existing=receipts[0];
  if(existing){
    if(existing.zammad_instance_id!==claims.instanceId||existing.zammad_user_id!==claims.userId
      ||existing.whatsapp_group_id!==groupId.toLowerCase()||existing.kind!==kind||existing.target_message_id!==(targetMessageId?.toLowerCase()??null))
      throw new ConflictException("Operation belongs to a different group request");
    if(aliases&&(aliases.length>1||(existing.disposition==="CANCELLED"?aliases.length>0:aliases.length!==1||aliases[0]!.id!==existing.delivery_id)))
      return{disposition:"UNKNOWN"};
    return existing;
  }
  if(aliases&&aliases.length>1)return{disposition:"UNKNOWN"};
  const historicalKey=aliases?.[0]?.idempotency_key??key;
  // Older outbox keys are not identity proof. Require the original server audit and instance lifetime too.
  const historical=(await client.query<{id:string;state:string;request_sha256:string|null;created_at:string;bound:boolean}>(`SELECT delivery.id,delivery.state,
      delivery.request_sha256,delivery.created_at,
      (delivery.delivery_origin='GROUP_WORKSPACE' AND delivery.group_workspace_group_id=$3
        AND delivery.content_redacted_at IS NULL AND delivery.created_at>=instance.created_at
        AND (($4='SEND' AND delivery.content_type<>$7)
          OR ($4='REACTION' AND delivery.content_type=$7 AND target.id=$5
            AND target.external_message_id=delivery.reply_to_message_id))
        AND EXISTS (SELECT 1 FROM audit_events audit WHERE audit.tenant_id=delivery.tenant_id
          AND audit.actor_type='ZAMMAD_USER' AND audit.actor_id=$6
          AND audit.request_id=CASE WHEN $4='SEND' THEN 'zammad-group-send:' ELSE 'zammad-group-reaction:' END||$2
          AND audit.action=ANY(CASE WHEN $4='SEND' THEN ARRAY['group_workspace.message_queued']
            ELSE ARRAY['group_workspace.reaction_queued','group_workspace.reaction_removal_queued'] END)
          AND audit.target_type=CASE WHEN $4='SEND' THEN 'whatsapp_group' ELSE 'normalized_message' END
          AND lower(audit.target_id)=CASE WHEN $4='SEND' THEN $3::text ELSE $5::text END
          AND audit.new_value->>'delivery_id'=delivery.id::text)) AS bound
    FROM delivery_outbox delivery JOIN zammad_instances instance ON instance.tenant_id=delivery.tenant_id AND instance.id=$8
    LEFT JOIN whatsapp_groups group_record ON group_record.tenant_id=delivery.tenant_id AND group_record.id=$3
    LEFT JOIN normalized_messages target ON target.tenant_id=delivery.tenant_id AND target.id=$5
      AND target.connection_id=delivery.connection_id AND target.external_group_id=group_record.external_group_id
    WHERE delivery.tenant_id=$1 AND delivery.idempotency_key=$2`,[
    claims.tenantId,historicalKey,groupId,kind,targetMessageId,claims.userId,REACTION_CONTENT_TYPE,claims.instanceId,
  ])).rows[0];
  if(!historical)return null;
  if(historical.bound!==true||!historical.request_sha256||!/^[0-9a-f]{64}$/u.test(historical.request_sha256))return{disposition:"UNKNOWN"};
  await recordGroupWorkspaceOperation(client,binding,historical.request_sha256,historical.id);
  return{disposition:"ADMITTED",zammad_instance_id:claims.instanceId,zammad_user_id:claims.userId!,whatsapp_group_id:groupId,
    kind,target_message_id:targetMessageId,request_sha256:historical.request_sha256,delivery_id:historical.id,state:historical.state,created_at:historical.created_at};
}

export async function recordGroupWorkspaceOperation(client:PoolClient,binding:GroupWorkspaceOperationBinding,requestSha256:string|null,deliveryId:string|null){
  const {claims,groupId,kind,targetMessageId}=binding;
  const key=canonicalGroupWorkspaceSubmissionKey(kind,claims.userId!,binding.key);
  await client.query(`INSERT INTO group_workspace_operation_receipts
    (tenant_id,zammad_instance_id,zammad_user_id,whatsapp_group_id,kind,idempotency_key,target_message_id,request_sha256,disposition,delivery_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[
    claims.tenantId,claims.instanceId,claims.userId,groupId,kind,key,targetMessageId,requestSha256,deliveryId?"ADMITTED":"CANCELLED",deliveryId,
  ]);
}

export async function visibleGroupWorkspaceDelivery<T extends VisibleDelivery>(client:PoolClient,tenantId:string,created:T){
  const media=(await client.query<VisibleDelivery>(`SELECT delivery.id,delivery.state,delivery.message_body AS message_text,
      delivery.agent_display_name AS participant_name,delivery.created_at AS provider_timestamp,
      media.filename AS media_filename,media.mime_type AS media_mime_type,
      (media.state='READY' AND media.media_object_id IS NOT NULL) AS media_available
    FROM delivery_outbox root JOIN delivery_outbox delivery
      ON delivery.tenant_id=root.tenant_id AND delivery.batch_id=root.batch_id
    JOIN delivery_media media ON media.tenant_id=delivery.tenant_id AND media.delivery_id=delivery.id
    WHERE root.tenant_id=$1 AND root.id=$2 AND root.content_redacted_at IS NULL AND delivery.content_redacted_at IS NULL
    ORDER BY delivery.batch_sequence LIMIT 1`,[tenantId,created.id])).rows[0];
  return media?{...created,...media}:created;
}

export async function replayGroupWorkspaceOperation(client:PoolClient,binding:GroupWorkspaceOperationBinding,receipt:Receipt|Unproven|null,requestSha256:string){
  if(!receipt)return null;
  if(receipt.disposition==="UNKNOWN")throw new ConflictException({code:"GROUP_OPERATION_SCOPE_UNKNOWN",message:"The original request scope could not be verified"});
  if(receipt.disposition==="CANCELLED")throw new ConflictException({code:"GROUP_OPERATION_CANCELLED",message:"This request was stopped before admission"});
  if(receipt.request_sha256!==requestSha256)throw new ConflictException("Idempotency key was already used for a different group request");
  const row=(await client.query<VisibleDelivery>(`SELECT delivery.id,delivery.state,
      delivery.message_body AS message_text,delivery.agent_display_name AS participant_name,delivery.created_at AS provider_timestamp,
      media.filename AS media_filename,media.mime_type AS media_mime_type,
      (media.state='READY' AND media.media_object_id IS NOT NULL) AS media_available,connection.phone_e164 AS sender_phone
    FROM delivery_outbox delivery LEFT JOIN delivery_media media ON media.tenant_id=delivery.tenant_id AND media.delivery_id=delivery.id
    JOIN connections connection ON connection.tenant_id=delivery.tenant_id AND connection.id=delivery.connection_id
    WHERE delivery.tenant_id=$1 AND delivery.id=$2 AND delivery.content_redacted_at IS NULL`,[binding.claims.tenantId,receipt.delivery_id])).rows[0];
  const replay={...(row??{id:receipt.delivery_id!,state:receipt.state??"UNKNOWN",message_text:"",participant_name:null,provider_timestamp:receipt.created_at}),duplicate:true};
  return binding.kind==="SEND"&&row&&!row.message_text&&!row.media_filename
    ?visibleGroupWorkspaceDelivery(client,binding.claims.tenantId,replay):replay;
}
