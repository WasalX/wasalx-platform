import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get,
  Headers, InternalServerErrorException, NotFoundException, Optional, Param, Post, Put, Query, Req,
  SetMetadata, UnauthorizedException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { maximumMediaBytes, normalizeMediaMime, safeMediaFilename } from "@wasalx/core/media";
import {
  GROUP_WORKSPACE_MAX_ATTACHMENTS, GROUP_WORKSPACE_MAX_TOTAL_BYTES,
  groupWorkspaceMediaCapabilities, providerOutboundMediaRule,
} from "@wasalx/core/provider-media-capabilities";
import { appendAudit } from "./audit.js";
import { PUBLIC_ROUTE } from "./auth.guard.js";
import { DatabaseService } from "./database.service.js";
import { Requires } from "./permission.guard.js";
import { ServiceAuthService, type ZammadClaims, type ZammadServiceRequest } from "./service-auth.service.js";
import { TenantDrainService } from "./tenant-drain.service.js";
import { deliveryHoldExpiresAtSql,deliveryHoldReasonSql } from "./delivery-presentation.js";
import type { AuthenticatedRequest } from "./types.js";
import { queueOutboundParts, type QueuedOutboundAttachment } from "./zammad-internal.controller.js";
import { PrivacyArtifactService } from "./privacy-artifact.service.js";
import { requireOperationKey, withOperationReceipt } from "./idempotent-operation.js";
import { groupWorkspaceAccessSql } from "./group-workspace-access.js";
import { canonicalGroupWorkspaceSubmissionKey, groupWorkspaceOperationKey, lockGroupWorkspaceOperation, readGroupWorkspaceOperation, recordGroupWorkspaceOperation, replayGroupWorkspaceOperation, visibleGroupWorkspaceDelivery, type GroupWorkspaceOperationBinding } from "./group-workspace-operation.js";
import { groupQuoteMatchesSql } from "@wasalx/core/ticket-event-runtime";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_ID=/^[1-9][0-9]{0,15}$/u;
const WAHA_MENTION=/^[1-9][0-9]{5,19}@(c\.us|s\.whatsapp\.net|lid)$/u;
const MIME_TYPE=/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const GROUP_REACTION_CONTENT_TYPE="application/vnd.wasalx.whatsapp-reaction";
const GROUP_REACTIONS=new Set(["👍","❤️","😂","😮","😢","🙏","✅"]);
const GROUP_MESSAGE_REACTION_SELECT_SQL=`reaction_state.active_emoji AS reaction_active_emoji,
  reaction_state.requested_emoji AS reaction_requested_emoji,reaction_state.delivery_state AS reaction_delivery_state`;
const GROUP_MESSAGE_REACTION_JOIN_SQL=`LEFT JOIN LATERAL (
  SELECT latest.message_body AS requested_emoji,latest.state AS delivery_state,
    (SELECT applied.message_body FROM delivery_outbox applied
      WHERE applied.tenant_id=message.tenant_id AND applied.connection_id=message.connection_id
        AND applied.content_type='${GROUP_REACTION_CONTENT_TYPE}'
        AND applied.reply_to_message_id=message.external_message_id
        AND applied.state IN ('SENT','DELIVERED','READ')
      ORDER BY applied.created_at DESC,applied.id DESC LIMIT 1) AS active_emoji
  FROM delivery_outbox latest
  WHERE latest.tenant_id=message.tenant_id AND latest.connection_id=message.connection_id
    AND latest.content_type='${GROUP_REACTION_CONTENT_TYPE}'
    AND latest.reply_to_message_id=message.external_message_id
  ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1
) reaction_state ON true`;
const GROUP_MESSAGE_PARTICIPANT_JOIN_SQL=`LEFT JOIN group_workspace_participants participant
  ON participant.tenant_id=message.tenant_id AND participant.whatsapp_group_id=g.id
  AND participant.external_participant_id=message.external_participant_id
LEFT JOIN participant_identities retained_identity
  ON retained_identity.tenant_id=message.tenant_id AND retained_identity.connection_id=message.connection_id
  AND retained_identity.external_participant_id=message.external_participant_id`;
const groupMessageSenderNameSql=(columnName:"participant_name"|"sender_name")=>`CASE WHEN message.from_me
  THEN COALESCE(sent_delivery.agent_display_name,message.participant_name,connection.name)
 ELSE COALESCE(
 (SELECT btrim(candidate.name)
    FROM (VALUES (1,message.participant_name),(2,retained_identity.display_name),
                 (3,participant.display_name)) AS candidate(priority,name)
   WHERE NULLIF(btrim(candidate.name),'') IS NOT NULL
     AND lower(btrim(candidate.name))<>'whatsapp participant'
     AND btrim(candidate.name)!~* '^\\+?[1-9][0-9]{5,19}(@(c\\.us|s\\.whatsapp\\.net|lid))?$'
   ORDER BY candidate.priority LIMIT 1),
 CASE WHEN retained_identity.normalized_phone~'^\\+[1-9][0-9]{5,14}$'
      THEN retained_identity.normalized_phone END,
 CASE WHEN participant.normalized_phone~'^\\+[1-9][0-9]{5,14}$'
      THEN participant.normalized_phone END,
 CASE WHEN connection.provider='WAHA'
       AND message.external_participant_id~'^[1-9][0-9]{5,14}@(c\\.us|s\\.whatsapp\\.net)$'
      THEN '+'||split_part(message.external_participant_id,'@',1)
      WHEN connection.provider='META' AND message.external_participant_id~'^[1-9][0-9]{5,14}$'
      THEN '+'||message.external_participant_id END,
 'WhatsApp participant')
 END AS ${columnName}`;
const GROUP_MESSAGE_SENDER_PHONE_SQL=`CASE WHEN message.from_me THEN connection.phone_e164
  WHEN participant.normalized_phone~'^\\+[1-9][0-9]{5,19}$' THEN participant.normalized_phone
  WHEN connection.provider='META' AND message.external_participant_id~'^[1-9][0-9]{5,14}$'
    THEN '+'||message.external_participant_id
  WHEN connection.provider='WAHA' AND message.external_participant_id~'^[1-9][0-9]{5,14}@(c\\.us|s\\.whatsapp\\.net)$'
    THEN '+'||split_part(message.external_participant_id,'@',1)
  END AS sender_phone`;
const GROUP_MESSAGE_IDENTITY_KEY_SQL=`CASE WHEN message.from_me THEN 'self'
  ELSE encode(digest(message.tenant_id::text||chr(31)||message.connection_id::text||chr(31)||message.external_participant_id,'sha256'),'hex')
  END AS participant_identity_key`;
const messageRevokedSql=(alias:string)=>`COALESCE(${alias}.provider_metadata->'mutations','[]'::jsonb)
  @> '[{"kind":"REVOKED"}]'::jsonb`;
const GROUP_MESSAGE_REVOKED_SQL=messageRevokedSql("message");
const messageNotRedactedEchoSql=(alias:string)=>`NOT EXISTS (
  SELECT 1 FROM delivery_outbox redacted_delivery
   WHERE redacted_delivery.tenant_id=${alias}.tenant_id
     AND redacted_delivery.connection_id=${alias}.connection_id
     AND redacted_delivery.external_message_id_sha256=app.delivery_external_message_sha256(
       ${alias}.tenant_id,${alias}.connection_id,${alias}.external_message_id
     )
     AND redacted_delivery.content_redacted_at IS NOT NULL
)`;
const GROUP_MESSAGE_NOT_REDACTED_ECHO_SQL=messageNotRedactedEchoSql("message");
const GROUP_MESSAGE_MEDIA_JOIN_SQL=`LEFT JOIN media_objects media_object ON media_object.tenant_id=message.tenant_id
  AND media_object.id=CASE WHEN message.provider_metadata->>'media_object_id'~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN (message.provider_metadata->>'media_object_id')::uuid END`;
const GROUP_MESSAGE_MEDIA_SQL=`CASE WHEN ${GROUP_MESSAGE_REVOKED_SQL} THEN NULL
    ELSE NULLIF(message.provider_metadata->>'fileName','') END AS media_filename,
  CASE WHEN ${GROUP_MESSAGE_REVOKED_SQL} THEN NULL
    ELSE COALESCE(media_object.mime_type,NULLIF(message.provider_metadata->>'mimeType','')) END AS media_mime_type,
  CASE WHEN ${GROUP_MESSAGE_REVOKED_SQL} THEN NULL
    WHEN lower(message.provider_metadata->>'type') IN ('image','video','audio','document')
      THEN lower(message.provider_metadata->>'type')
    WHEN COALESCE(media_object.mime_type,message.provider_metadata->>'mimeType','') LIKE 'image/%' THEN 'image'
    WHEN COALESCE(media_object.mime_type,message.provider_metadata->>'mimeType','') LIKE 'video/%' THEN 'video'
    WHEN COALESCE(media_object.mime_type,message.provider_metadata->>'mimeType','') LIKE 'audio/%' THEN 'audio'
    WHEN media_object.id IS NOT NULL OR message.provider_metadata ? 'fileName' OR message.provider_metadata ? 'mimeType' THEN 'document'
    END AS media_kind,
  CASE WHEN ${GROUP_MESSAGE_REVOKED_SQL} THEN false
    ELSE COALESCE(media_object.scan_state='CLEAN' AND media_object.expires_at>now(),false) END AS media_available`;
const VISIBILITIES=new Set(["RESTRICTED","ALL_AGENTS"]);
const SUBJECT_TYPES=new Set(["USER","TEAM"]);
const GROUP_WORKSPACE_SCOPES=new Set(["MY","TEAM","UNASSIGNED","ALL"]);
const GROUP_WORKSPACE_UNREAD_LIMIT=100;

// Full authorized identity scope keeps off-page matches ambiguous.
const GROUP_QUOTE_CANDIDATES_SQL=`quote_candidates AS (
  SELECT DISTINCT g.tenant_id,g.connection_id,g.external_group_id,
    connection.provider,message.external_message_id
  FROM normalized_messages message
  JOIN accessible_group g ON g.tenant_id=message.tenant_id
    AND g.connection_id=message.connection_id
    AND g.external_group_id=message.external_group_id
  JOIN connections connection ON connection.tenant_id=g.tenant_id
    AND connection.id=g.connection_id
  WHERE message.history_captured_at IS NOT NULL
    AND message.provider_timestamp>=g.enabled_at
    AND message.external_message_id IS NOT NULL
    AND ${GROUP_MESSAGE_NOT_REDACTED_ECHO_SQL}
  UNION
  SELECT DISTINCT g.tenant_id,g.connection_id,g.external_group_id,
    connection.provider,delivery.external_message_id
  FROM delivery_outbox delivery
  LEFT JOIN group_bindings binding ON binding.tenant_id=delivery.tenant_id
    AND binding.id=delivery.group_binding_id
  JOIN accessible_group g ON g.tenant_id=delivery.tenant_id
    AND g.connection_id=delivery.connection_id
    AND g.id=COALESCE(delivery.group_workspace_group_id,binding.whatsapp_group_id)
  JOIN connections connection ON connection.tenant_id=g.tenant_id
    AND connection.id=g.connection_id
  WHERE delivery.created_at>=g.enabled_at
    AND delivery.content_redacted_at IS NULL
    AND delivery.external_message_id IS NOT NULL
    AND delivery.state IN ('SENT','DELIVERED','READ')
    AND delivery.content_type<>'application/vnd.wasalx.whatsapp-reaction'
    AND (btrim(delivery.message_body)<>'' OR EXISTS (
      SELECT 1 FROM delivery_media media WHERE media.tenant_id=delivery.tenant_id
        AND media.delivery_id=delivery.id))
)`;
const GROUP_QUOTE_JOIN_SQL=`LEFT JOIN LATERAL (
  SELECT CASE
    WHEN count(*) FILTER (WHERE candidate.external_message_id=message.quoted_external_message_id)>0
      THEN message.quoted_external_message_id
    WHEN count(DISTINCT candidate.external_message_id)=1
      THEN min(candidate.external_message_id)
    ELSE NULL END AS external_id
  FROM quote_candidates candidate
  WHERE message.quoted_external_message_id IS NOT NULL
    AND candidate.tenant_id=message.tenant_id
    AND candidate.connection_id=message.connection_id
    AND candidate.external_group_id=message.external_group_id
    AND ${groupQuoteMatchesSql('message.quoted_external_message_id','candidate.external_message_id','message.external_group_id','connection.provider')}
) quote_target ON true`;

@Controller("v1/group-workspace")
export class GroupWorkspaceController{
  constructor(private readonly database:DatabaseService){}

  @Get("settings")
  @Requires("settings:read")
  async settings(@Req()request:AuthenticatedRequest){
    const row=(await this.database.rows(request.principal.tenantId,`SELECT group_workspace_enabled,
      group_history_default_retention_days,group_history_default_visibility,version
      FROM tenant_settings WHERE tenant_id=$1`,[request.principal.tenantId]))[0];
    return{...row,version:apiVersion(row.version)};
  }

  @Put("settings")
  @Requires("settings:write")
  async updateSettings(@Req()request:AuthenticatedRequest,@Headers("idempotency-key")idempotencyHeader:string|undefined,@Body()body:Record<string,unknown>){
    if(request.principal.role!=="tenant_owner")throw new ForbiddenException("Only a tenant owner can change group workspace defaults");
    const key=requireOperationKey(idempotencyHeader);
    const enabled=requireBoolean(body.enabled,"enabled");
    const retentionDays=integer(body.retentionDays,1,3650,"retentionDays");
    const visibility=oneOf(body.visibility,VISIBILITIES,"visibility");
    const expectedVersion=integer(body.expectedVersion,1,Number.MAX_SAFE_INTEGER,"expectedVersion");
    const requestSha256=operationHash({enabled,retentionDays,visibility,expectedVersion});
    return this.database.withTenant(request.principal.tenantId,async client=>{
      return withOperationReceipt(client,request.principal,"GROUP_WORKSPACE_DEFAULTS",key,requestSha256,String(request.id),async()=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`group-workspace-consent:${request.principal.tenantId}`]);
        const previous=(await client.query(`SELECT group_workspace_enabled,
          group_history_default_retention_days,group_history_default_visibility,version
          FROM tenant_settings WHERE tenant_id=$1`,[request.principal.tenantId])).rows[0];
        const updated=(await client.query(`SELECT * FROM app.update_group_workspace_defaults($1,$2,$3,$4,$5)`,[
          expectedVersion,enabled,retentionDays,visibility,request.principal.userId,
        ])).rows[0];
        if(!updated)throw new ConflictException("Group workspace settings changed; reload before saving");
        if(!enabled)await client.query("DELETE FROM group_workspace_participants WHERE tenant_id=$1",[request.principal.tenantId]);
        await appendAudit(client,request.principal,{action:"group_workspace.defaults_updated",targetType:"tenant",
          targetId:request.principal.tenantId,requestId:String(request.id),previousValue:previous,newValue:updated});
        return{...updated,version:apiVersion(updated.version)};
      },"Idempotency key was already used for different group workspace defaults");
    });
  }

  @Get("groups/:groupId")
  @Requires("group:read")
  async group(@Req()request:AuthenticatedRequest,@Param("groupId")groupId:string){
    assertUuid(groupId,"Group ID");
    const row=(await this.database.rows(request.principal.tenantId,`SELECT g.id,g.display_name,g.wasalx_name,
      COALESCE(workspace.capture_enabled,false) AS capture_enabled,workspace.enabled_at,
      COALESCE(workspace.retention_days,tenant.group_history_default_retention_days) AS retention_days,
      COALESCE(workspace.visibility,tenant.group_history_default_visibility) AS visibility,
      COALESCE(workspace.agent_prefix,'Agent:') AS agent_prefix,
      COALESCE(workspace.agent_identity_placement,'HEADER') AS agent_identity_placement,
      COALESCE(workspace.version,0) AS version,tenant.group_workspace_enabled,
      COALESCE(jsonb_agg(jsonb_build_object('id',grant_record.id,'subject_type',grant_record.subject_type,
        'subject_external_id',grant_record.subject_external_id) ORDER BY grant_record.subject_type,grant_record.subject_external_id)
        FILTER (WHERE grant_record.id IS NOT NULL),'[]'::jsonb) AS grants
      FROM whatsapp_groups g JOIN tenant_settings tenant ON tenant.tenant_id=g.tenant_id
      LEFT JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
      LEFT JOIN group_workspace_grants grant_record ON grant_record.tenant_id=g.tenant_id AND grant_record.whatsapp_group_id=g.id
      WHERE g.tenant_id=$1 AND g.id=$2
      GROUP BY g.id,workspace.capture_enabled,workspace.enabled_at,workspace.retention_days,
        workspace.visibility,workspace.agent_prefix,workspace.agent_identity_placement,workspace.version,tenant.group_workspace_enabled,
        tenant.group_history_default_retention_days,tenant.group_history_default_visibility`,[
      request.principal.tenantId,groupId,
    ]))[0];
    if(!row)throw new NotFoundException("WhatsApp group was not found");
    return{...row,version:apiVersion(row.version)};
  }

  @Put("groups/:groupId")
  @Requires("group:write")
  async updateGroup(@Req()request:AuthenticatedRequest,@Param("groupId")groupId:string,
    @Headers("idempotency-key")idempotencyHeader:string|undefined,@Body()body:Record<string,unknown>){
    assertUuid(groupId,"Group ID");
    const key=requireOperationKey(idempotencyHeader);
    const captureEnabled=requireBoolean(body.captureEnabled,"captureEnabled");
    const retentionDays=integer(body.retentionDays,1,3650,"retentionDays");
    const visibility=oneOf(body.visibility,VISIBILITIES,"visibility");
    const agentPrefix=workspaceAgentPrefix(body.agentPrefix);
    const agentIdentityPlacement=oneOf(body.agentIdentityPlacement,new Set(["HEADER","FOOTER","OFF"]),"agentIdentityPlacement");
    const expectedVersion=integer(body.expectedVersion,0,Number.MAX_SAFE_INTEGER,"expectedVersion");
    const requestSha256=operationHash({groupId,captureEnabled,retentionDays,visibility,agentPrefix,agentIdentityPlacement,expectedVersion});
    return this.database.withTenant(request.principal.tenantId,async client=>{
      return withOperationReceipt(client,request.principal,"GROUP_WORKSPACE_CAPTURE",key,requestSha256,String(request.id),async()=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`group-workspace-consent:${request.principal.tenantId}`]);
        const tenant=(await client.query<{group_workspace_enabled:boolean}>(
          "SELECT group_workspace_enabled FROM tenant_settings WHERE tenant_id=$1",
          [request.principal.tenantId],
        )).rows[0];
        if(!tenant?.group_workspace_enabled)throw new BadRequestException("Enable the group workspace before capturing history");
        const previous=(await client.query("SELECT * FROM group_workspace_settings WHERE tenant_id=$1 AND whatsapp_group_id=$2",[
          request.principal.tenantId,groupId,
        ])).rows[0]??null;
        const updated=(await client.query(`INSERT INTO group_workspace_settings
          (tenant_id,whatsapp_group_id,capture_enabled,enabled_at,retention_days,visibility,agent_prefix,agent_identity_placement,updated_by)
          SELECT $1,g.id,$3,CASE WHEN $3 THEN now() END,$4,$5,$6,$7,$8 FROM whatsapp_groups g
          WHERE g.tenant_id=$1 AND g.id=$2 AND ($9=0 OR EXISTS (
            SELECT 1 FROM group_workspace_settings current
            WHERE current.tenant_id=g.tenant_id AND current.whatsapp_group_id=g.id AND current.version=$9
          ))
          ON CONFLICT (tenant_id,whatsapp_group_id) DO UPDATE SET capture_enabled=EXCLUDED.capture_enabled,
            enabled_at=CASE WHEN EXCLUDED.capture_enabled AND NOT group_workspace_settings.capture_enabled
                            THEN now() ELSE group_workspace_settings.enabled_at END,
            retention_days=EXCLUDED.retention_days,visibility=EXCLUDED.visibility,agent_prefix=EXCLUDED.agent_prefix,
            agent_identity_placement=EXCLUDED.agent_identity_placement,version=group_workspace_settings.version+1,
            updated_by=EXCLUDED.updated_by,updated_at=now()
          WHERE group_workspace_settings.version=$9
          RETURNING capture_enabled,enabled_at,retention_days,visibility,agent_prefix,agent_identity_placement,version`,[
          request.principal.tenantId,groupId,captureEnabled,retentionDays,visibility,agentPrefix,agentIdentityPlacement,request.principal.userId,expectedVersion,
        ])).rows[0];
        if(!updated){
          const exists=(await client.query("SELECT 1 FROM whatsapp_groups WHERE tenant_id=$1 AND id=$2",[request.principal.tenantId,groupId])).rowCount;
          if(!exists)throw new NotFoundException("WhatsApp group was not found");
          throw new ConflictException("Group workspace settings changed; reload before saving");
        }
        if(!captureEnabled)await client.query("DELETE FROM group_workspace_participants WHERE tenant_id=$1 AND whatsapp_group_id=$2",[
          request.principal.tenantId,groupId,
        ]);
        await appendAudit(client,request.principal,{action:"group_workspace.group_updated",targetType:"whatsapp_group",
          targetId:groupId,requestId:String(request.id),previousValue:previous,newValue:updated});
        return{...updated,version:apiVersion(updated.version)};
      },"Idempotency key was already used for different group capture settings");
    });
  }

  @Post("groups/:groupId/grants")
  @Requires("group:write")
  async grant(@Req()request:AuthenticatedRequest,@Param("groupId")groupId:string,
    @Headers("idempotency-key")idempotencyHeader:string|undefined,@Body()body:Record<string,unknown>){
    assertUuid(groupId,"Group ID");
    const key=requireOperationKey(idempotencyHeader);
    const subjectType=oneOf(body.subjectType,SUBJECT_TYPES,"subjectType");
    const subjectExternalId=positiveId(body.subjectExternalId,"subjectExternalId");
    const requestSha256=operationHash({groupId,subjectType,subjectExternalId});
    return this.database.withTenant(request.principal.tenantId,async client=>{
      return withOperationReceipt(client,request.principal,"GROUP_WORKSPACE_GRANT",key,requestSha256,String(request.id),async()=>{
        const created=(await client.query<{id:string}>(`INSERT INTO group_workspace_grants
          (tenant_id,whatsapp_group_id,subject_type,subject_external_id,created_by)
          SELECT $1,g.id,$3,$4,$5 FROM whatsapp_groups g WHERE g.tenant_id=$1 AND g.id=$2
          ON CONFLICT (tenant_id,whatsapp_group_id,subject_type,subject_external_id) DO NOTHING RETURNING id`,[
          request.principal.tenantId,groupId,subjectType,subjectExternalId,request.principal.userId,
        ])).rows[0];
        if(!created){
          const existing=(await client.query<{id:string}>(`SELECT id FROM group_workspace_grants
            WHERE tenant_id=$1 AND whatsapp_group_id=$2 AND subject_type=$3 AND subject_external_id=$4`,[
            request.principal.tenantId,groupId,subjectType,subjectExternalId,
          ])).rows[0];
          if(!existing)throw new NotFoundException("WhatsApp group was not found");
          return existing;
        }
        await appendAudit(client,request.principal,{action:"group_workspace.access_granted",targetType:"whatsapp_group",
          targetId:groupId,requestId:String(request.id),newValue:{grant_id:created.id,subject_type:subjectType,subject_external_id:subjectExternalId}});
        return created;
      },"Idempotency key was already used for a different group access grant");
    });
  }

  @Delete("groups/:groupId/grants/:grantId")
  @Requires("group:write")
  async revoke(@Req()request:AuthenticatedRequest,@Param("groupId")groupId:string,@Param("grantId")grantId:string,
    @Headers("idempotency-key")idempotencyHeader:string|undefined){
    assertUuid(groupId,"Group ID");assertUuid(grantId,"Grant ID");
    const key=requireOperationKey(idempotencyHeader);const requestSha256=operationHash({groupId,grantId});
    return this.database.withTenant(request.principal.tenantId,async client=>{
      return withOperationReceipt(client,request.principal,"GROUP_WORKSPACE_REVOKE",key,requestSha256,String(request.id),async()=>{
        const removed=(await client.query<{subject_type:string;subject_external_id:string}>(`DELETE FROM group_workspace_grants
          WHERE tenant_id=$1 AND whatsapp_group_id=$2 AND id=$3 RETURNING subject_type,subject_external_id`,[
          request.principal.tenantId,groupId,grantId,
        ])).rows[0];
        if(!removed)throw new NotFoundException("Group access grant was not found");
        await appendAudit(client,request.principal,{action:"group_workspace.access_revoked",targetType:"whatsapp_group",
          targetId:groupId,requestId:String(request.id),previousValue:{grant_id:grantId,...removed}});
        return{removed:true};
      },"Idempotency key was already used for a different group access revoke");
    });
  }
}

@Controller("internal/v1/zammad/group-workspace")
@SetMetadata(PUBLIC_ROUTE,true)
export class ZammadGroupWorkspaceController{
  constructor(private readonly database:DatabaseService,private readonly auth:ServiceAuthService,private readonly drain:TenantDrainService,
    @Optional() private readonly artifacts?:PrivacyArtifactService){}

  private async agent(authorization:string|undefined,request?:ZammadServiceRequest){
    const claims=await this.auth.verify(authorization,"zammad:groups",request);
    if(!claims.userId)throw new UnauthorizedException("A Zammad agent identity is required");
    return claims;
  }

  @Get("groups")
  async groups(@Headers("authorization")authorization:string|undefined,@Req()request?:ZammadServiceRequest,
    @Query("after")after?:string,@Query("limit")limitValue?:string,@Query("scope")scopeValue?:string,
    @Query("selected")selected?:string){
    const claims=await this.agent(authorization,request);
    const limit=limitValue===undefined?50:integer(limitValue,1,100,"limit");
    const scope=scopeValue===undefined?"ALL":oneOf(scopeValue,GROUP_WORKSPACE_SCOPES,"scope");
    if(after!==undefined)assertUuid(after,"Group cursor");
    if(selected!==undefined)assertUuid(selected,"Selected group");
    const rows=await this.database.rows<Record<string,unknown>&{id:string;media_provider:"WAHA"|"META"}>(claims.tenantId,`WITH accessible_groups AS (
      SELECT g.id,g.tenant_id,g.connection_id,g.external_group_id,workspace.enabled_at,
      connection.provider AS media_provider,
      COALESCE(g.wasalx_name,g.display_name) AS name,
      CASE WHEN g.participant_count_known THEN g.participant_count ELSE NULL END AS participant_count,workspace.visibility,
      (connection.state='WORKING' AND EXISTS (SELECT 1 FROM provider_sessions session
        WHERE session.tenant_id=g.tenant_id AND session.connection_id=g.connection_id
          AND session.ownership_state='ACTIVE' AND session.state='WORKING')) AS send_available,
      CASE WHEN EXISTS (SELECT 1 FROM group_workspace_grants direct_grant WHERE direct_grant.tenant_id=g.tenant_id
             AND direct_grant.whatsapp_group_id=g.id AND direct_grant.subject_type='USER' AND direct_grant.subject_external_id=$2) THEN 'MY'
           WHEN EXISTS (SELECT 1 FROM group_workspace_grants team_grant WHERE team_grant.tenant_id=g.tenant_id
             AND team_grant.whatsapp_group_id=g.id AND team_grant.subject_type='TEAM' AND team_grant.subject_external_id=ANY($3::text[])) THEN 'TEAM'
           WHEN workspace.visibility='ALL_AGENTS' THEN 'ALL'
           ELSE 'UNASSIGNED' END AS access_scope
      FROM whatsapp_groups g JOIN tenant_settings tenant ON tenant.tenant_id=g.tenant_id
      JOIN connections connection ON connection.tenant_id=g.tenant_id AND connection.id=g.connection_id
      JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
      WHERE g.tenant_id=$1 AND tenant.group_workspace_enabled AND workspace.capture_enabled
        AND ${groupWorkspaceAccessSql("g","workspace","$2","$3","$5")}
    ), cursor AS (
      SELECT name,id FROM accessible_groups WHERE id=$8
    ), paged_groups AS (
      SELECT * FROM accessible_groups
      WHERE ($6='ALL' OR access_scope=$6 OR ($7::uuid IS NOT NULL AND id=$7))
        AND ($8::uuid IS NULL OR (name,id)>(SELECT name,id FROM cursor))
        AND ($8::uuid IS NULL OR $7::uuid IS NULL OR id<>$7)
      ORDER BY CASE WHEN $8::uuid IS NULL AND id=$7 THEN 0 ELSE 1 END,name,id
      LIMIT $9
    ) SELECT page.id,page.connection_id,page.media_provider,page.name,page.participant_count,page.visibility,
      page.send_available,page.access_scope,COALESCE(unread.unread_count,0) AS unread_count
      FROM paged_groups page
      LEFT JOIN group_workspace_read_cursors cursor_record ON cursor_record.tenant_id=page.tenant_id
        AND cursor_record.whatsapp_group_id=page.id AND cursor_record.zammad_instance_id=$4 AND cursor_record.zammad_user_id=$2
      LEFT JOIN normalized_messages cursor_message ON cursor_message.tenant_id=cursor_record.tenant_id AND cursor_message.id=cursor_record.last_message_id
      LEFT JOIN LATERAL (SELECT count(*)::integer AS unread_count FROM (
        SELECT 1 FROM normalized_messages message
        WHERE message.tenant_id=page.tenant_id AND message.connection_id=page.connection_id
          AND message.external_group_id=page.external_group_id AND message.history_captured_at IS NOT NULL
          AND ${GROUP_MESSAGE_NOT_REDACTED_ECHO_SQL}
          AND NOT message.from_me AND message.provider_timestamp>=page.enabled_at AND (
            (cursor_message.id IS NOT NULL AND (message.provider_timestamp,message.id)>(cursor_message.provider_timestamp,cursor_message.id))
            OR (cursor_message.id IS NULL AND (cursor_record.read_at IS NULL OR message.history_captured_at>cursor_record.read_at))
          ) LIMIT ${GROUP_WORKSPACE_UNREAD_LIMIT}
      ) unread_messages) unread ON true
      ORDER BY CASE WHEN $8::uuid IS NULL AND page.id=$7 THEN 0 ELSE 1 END,page.name,page.id`,[
      claims.tenantId,claims.userId,claims.groupIds,claims.instanceId,claims.groupAdmin,scope,selected??null,after??null,limit+1,
    ]);
    const items=rows.slice(0,limit).map(({media_provider,...group})=>({
      ...group,
      reactions_available:media_provider==="WAHA",
      media_capabilities:groupWorkspaceMediaCapabilities(media_provider),
    }));
    return{items,next_cursor:rows.length>limit?items.at(-1)?.id??null:null};
  }

  @Get("groups/:groupId/messages")
  async messages(@Headers("authorization")authorization:string|undefined,@Param("groupId")groupId:string,
    @Query("before")before:string|undefined,@Query("limit")limitValue:string|undefined,@Req()request?:ZammadServiceRequest){
    const claims=await this.agent(authorization,request);assertUuid(groupId,"Group ID");
    const limit=limitValue===undefined?50:integer(limitValue,1,100,"limit");
    if(before!==undefined)assertUuid(before,"Message cursor");
    await this.assertAccess(claims,groupId);
    const rows=await this.database.rows(claims.tenantId,`WITH accessible_group AS (
      SELECT g.id,g.tenant_id,g.connection_id,g.external_group_id,workspace.enabled_at
      FROM whatsapp_groups g JOIN tenant_settings tenant ON tenant.tenant_id=g.tenant_id
      JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
      WHERE g.tenant_id=$1 AND g.id=$2 AND tenant.group_workspace_enabled AND workspace.capture_enabled
        AND ${groupWorkspaceAccessSql("g","workspace","$5","$6","$7")}
    ), ${GROUP_QUOTE_CANDIDATES_SQL}, cursor AS (
      SELECT message.provider_timestamp,message.id FROM normalized_messages message
      JOIN accessible_group cursor_group ON cursor_group.tenant_id=message.tenant_id
        AND cursor_group.connection_id=message.connection_id AND cursor_group.external_group_id=message.external_group_id
      WHERE message.tenant_id=$1 AND message.id=$3 AND message.history_captured_at IS NOT NULL
        AND message.provider_timestamp>=cursor_group.enabled_at
      UNION ALL
      SELECT delivery.created_at,delivery.id FROM delivery_outbox delivery
      LEFT JOIN group_bindings binding ON binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id
      JOIN accessible_group cursor_group ON cursor_group.tenant_id=delivery.tenant_id AND cursor_group.connection_id=delivery.connection_id
        AND (delivery.group_workspace_group_id=cursor_group.id OR binding.whatsapp_group_id=cursor_group.id)
      WHERE delivery.tenant_id=$1 AND delivery.id=$3 AND delivery.created_at>=cursor_group.enabled_at
    ), routed_deliveries AS (
      (SELECT delivery.* FROM delivery_outbox delivery
      JOIN accessible_group route_group ON route_group.tenant_id=delivery.tenant_id
        AND route_group.connection_id=delivery.connection_id AND delivery.group_workspace_group_id=route_group.id
      WHERE delivery.tenant_id=$1 AND delivery.created_at>=route_group.enabled_at
        AND delivery.content_redacted_at IS NULL
        AND ($3::uuid IS NULL OR (delivery.created_at,delivery.id)<(SELECT provider_timestamp,id FROM cursor))
      ORDER BY delivery.created_at DESC,delivery.id DESC LIMIT $4)
      UNION ALL
      (SELECT delivery.* FROM delivery_outbox delivery
      JOIN group_bindings binding ON binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id
      JOIN accessible_group route_group ON route_group.tenant_id=delivery.tenant_id
        AND route_group.connection_id=delivery.connection_id AND binding.whatsapp_group_id=route_group.id
      WHERE delivery.tenant_id=$1 AND delivery.created_at>=route_group.enabled_at
        AND delivery.content_redacted_at IS NULL
        AND ($3::uuid IS NULL OR (delivery.created_at,delivery.id)<(SELECT provider_timestamp,id FROM cursor))
      ORDER BY delivery.created_at DESC,delivery.id DESC LIMIT $4)
    ), items AS (
    (SELECT message.id,message.external_message_id,sent_delivery.id AS delivery_id,
      ${groupMessageSenderNameSql("participant_name")},
      ${GROUP_MESSAGE_SENDER_PHONE_SQL},
      ${GROUP_MESSAGE_IDENTITY_KEY_SQL},
      CASE WHEN ${GROUP_MESSAGE_REVOKED_SQL} THEN 'Message deleted'
           WHEN message.provider_metadata->'mutations'->-1->>'kind'='EDITED'
             THEN COALESCE(message.provider_metadata->'mutations'->-1->>'replacement_text',message.message_text)
           ELSE message.message_text END AS message_text,
      COALESCE(quote_target.external_id,message.quoted_external_message_id) AS quoted_external_message_id,message.from_me,message.provider_timestamp,
      CASE WHEN ${GROUP_MESSAGE_REVOKED_SQL} THEN 'REVOKED'
           ELSE message.provider_metadata->'mutations'->-1->>'kind' END AS latest_mutation,
      (COALESCE(message.provider_metadata->>'eventKind','MESSAGE')<>'REACTION'
        AND NOT (${GROUP_MESSAGE_REVOKED_SQL})) AS quote_allowed,
       (NOT message.from_me AND message.external_participant_id<>''
         AND COALESCE(message.provider_metadata->>'eventKind','MESSAGE')<>'REACTION'
         AND NOT (${GROUP_MESSAGE_REVOKED_SQL})) AS ticket_creatable,
      EXISTS (SELECT 1 FROM message_links link WHERE link.tenant_id=message.tenant_id
        AND link.connection_id=message.connection_id AND link.external_message_id=message.external_message_id) AS linked_to_ticket,
      ${GROUP_MESSAGE_REACTION_SELECT_SQL},
      'MESSAGE'::text AS source_kind,NULL::text AS delivery_state,NULL::text AS delivery_hold_reason,
      NULL::timestamptz AS delivery_next_attempt_at,NULL::timestamptz AS delivery_hold_expires_at,
      ${GROUP_MESSAGE_MEDIA_SQL}
      FROM normalized_messages message
      JOIN accessible_group g ON g.tenant_id=message.tenant_id AND g.connection_id=message.connection_id
        AND g.external_group_id=message.external_group_id
      JOIN connections connection ON connection.tenant_id=g.tenant_id AND connection.id=g.connection_id
      ${GROUP_QUOTE_JOIN_SQL}
      LEFT JOIN delivery_outbox sent_delivery ON sent_delivery.tenant_id=message.tenant_id
        AND sent_delivery.connection_id=message.connection_id
        AND sent_delivery.external_message_id=message.external_message_id
        AND sent_delivery.content_type<>'${GROUP_REACTION_CONTENT_TYPE}'
      ${GROUP_MESSAGE_PARTICIPANT_JOIN_SQL}
      ${GROUP_MESSAGE_REACTION_JOIN_SQL}
      ${GROUP_MESSAGE_MEDIA_JOIN_SQL}
      WHERE message.tenant_id=$1 AND message.history_captured_at IS NOT NULL
        AND message.provider_timestamp>=g.enabled_at
        AND ${GROUP_MESSAGE_NOT_REDACTED_ECHO_SQL}
        AND ($3::uuid IS NULL OR (message.provider_timestamp,message.id)<(SELECT provider_timestamp,id FROM cursor))
      ORDER BY message.provider_timestamp DESC,message.id DESC LIMIT $4)
      UNION ALL
      SELECT delivery.id,delivery.external_message_id,delivery.id AS delivery_id,delivery.agent_display_name,connection.phone_e164,
        'self'::text AS participant_identity_key,delivery.message_body,
        delivery.reply_to_message_id,true,delivery.created_at,NULL::text,false,false,false,
        NULL::text,NULL::text,NULL::text,
        'DELIVERY'::text,delivery.state,
        ${deliveryHoldReasonSql("delivery")},
        CASE WHEN delivery.state='QUEUED' AND delivery.safe_error IS NOT NULL THEN delivery.available_at END,
        ${deliveryHoldExpiresAtSql("delivery","policy")},
        media.filename,COALESCE(delivery_object.mime_type,media.mime_type),
        CASE WHEN media.mime_type LIKE 'image/%' THEN 'image' WHEN media.mime_type LIKE 'video/%' THEN 'video'
          WHEN media.mime_type LIKE 'audio/%' THEN 'audio' WHEN media.mime_type IS NOT NULL THEN 'document' END,
        COALESCE(media.state='READY' AND delivery_object.scan_state='CLEAN' AND delivery_object.expires_at>now(),false) AS media_available
      FROM routed_deliveries delivery JOIN accessible_group g ON g.tenant_id=delivery.tenant_id
        AND g.connection_id=delivery.connection_id
      JOIN connections connection ON connection.tenant_id=g.tenant_id AND connection.id=g.connection_id
      LEFT JOIN waha_outbound_connection_policies policy ON policy.tenant_id=delivery.tenant_id AND policy.connection_id=delivery.connection_id
      LEFT JOIN delivery_media media ON media.tenant_id=delivery.tenant_id AND media.delivery_id=delivery.id
      LEFT JOIN media_objects delivery_object ON delivery_object.tenant_id=media.tenant_id AND delivery_object.id=media.media_object_id
      WHERE delivery.content_type<> '${GROUP_REACTION_CONTENT_TYPE}'
        AND delivery.content_redacted_at IS NULL
        AND (btrim(delivery.message_body)<>'' OR EXISTS (SELECT 1 FROM delivery_media visible_media
          WHERE visible_media.tenant_id=delivery.tenant_id AND visible_media.delivery_id=delivery.id))
        AND NOT EXISTS (SELECT 1 FROM normalized_messages echo WHERE echo.tenant_id=delivery.tenant_id
          AND echo.connection_id=delivery.connection_id AND echo.external_group_id=g.external_group_id
          AND echo.external_message_id=delivery.external_message_id AND delivery.external_message_id IS NOT NULL
          AND echo.history_captured_at IS NOT NULL AND echo.provider_timestamp>=g.enabled_at)
    ) SELECT * FROM items ORDER BY provider_timestamp DESC,id DESC LIMIT $4`,[
      claims.tenantId,groupId,before??null,limit,claims.userId,claims.groupIds,claims.groupAdmin,
    ]);
    return projectGroupMessages(rows);
  }

  @Get("groups/:groupId/participants")
  async participants(@Headers("authorization")authorization:string|undefined,@Param("groupId")groupId:string,@Query("q")query:string|undefined,
    @Req()request?:ZammadServiceRequest){
    const claims=await this.agent(authorization,request);assertUuid(groupId,"Group ID");await this.assertAccess(claims,groupId);
    const search=participantSearch(query);
    return this.database.rows(claims.tenantId,`WITH accessible_group AS (
      SELECT group_record.id,group_record.tenant_id,group_record.connection_id,group_record.external_group_id,workspace.enabled_at
      FROM whatsapp_groups group_record JOIN tenant_settings tenant ON tenant.tenant_id=group_record.tenant_id
      JOIN group_workspace_settings workspace ON workspace.tenant_id=group_record.tenant_id AND workspace.whatsapp_group_id=group_record.id
      WHERE group_record.tenant_id=$1 AND group_record.id=$2 AND tenant.group_workspace_enabled AND workspace.capture_enabled
        AND ${groupWorkspaceAccessSql("group_record","workspace","$4","$5","$6")}
    ), roster AS (
      SELECT participant.external_participant_id AS id,participant.display_name,participant.normalized_phone,
             participant.synchronized_at AS observed_at
      FROM group_workspace_participants participant JOIN accessible_group group_record
        ON group_record.tenant_id=participant.tenant_id AND group_record.id=participant.whatsapp_group_id
      WHERE participant.tenant_id=$1
    ), latest AS (
      SELECT DISTINCT ON (message.external_participant_id) message.external_participant_id AS id,message.participant_name
      FROM normalized_messages message JOIN accessible_group group_record ON group_record.tenant_id=message.tenant_id
        AND group_record.connection_id=message.connection_id
        AND group_record.external_group_id=message.external_group_id
      JOIN connections connection ON connection.tenant_id=group_record.tenant_id AND connection.id=group_record.connection_id
      WHERE message.tenant_id=$1 AND connection.provider='WAHA' AND message.history_captured_at IS NOT NULL
        AND message.provider_timestamp>=group_record.enabled_at
        AND ${GROUP_MESSAGE_NOT_REDACTED_ECHO_SQL}
        AND NOT message.from_me AND message.external_participant_id~'^[1-9][0-9]{5,19}@(c\\.us|s\\.whatsapp\\.net|lid)$'
        AND ($3='' OR COALESCE(message.participant_name,'') ILIKE '%'||$3||'%'
          OR ($3~'[0-9]' AND split_part(message.external_participant_id,'@',1) LIKE '%'||regexp_replace($3,'[^0-9]','','g')||'%'))
      ORDER BY message.external_participant_id,message.provider_timestamp DESC,message.id DESC
    ), available AS (
      SELECT roster.id,roster.display_name,roster.normalized_phone,roster.observed_at FROM roster
      UNION ALL
      SELECT latest.id,latest.participant_name,NULL::text,now() FROM latest
    ), combined AS (
      SELECT id,(array_agg(NULLIF(display_name,'') ORDER BY observed_at DESC) FILTER (WHERE NULLIF(display_name,'') IS NOT NULL))[1] AS display_name,
             max(normalized_phone) AS normalized_phone
      FROM available GROUP BY id
    ), matched_identity AS (
      SELECT DISTINCT COALESCE(normalized_phone,'id:'||id) AS identity_key FROM combined
      WHERE $3='' OR COALESCE(display_name,'') ILIKE '%'||$3||'%'
        OR ($3~'[0-9]' AND COALESCE(normalized_phone,split_part(id,'@',1)) LIKE '%'||regexp_replace($3,'[^0-9]','','g')||'%')
    ), ranked AS (
      SELECT combined.*,first_value(display_name) OVER (PARTITION BY COALESCE(normalized_phone,'id:'||id)
        ORDER BY (NULLIF(display_name,'') IS NULL),CASE WHEN id~'@(c\\.us|s\\.whatsapp\\.net)$' THEN 0 ELSE 1 END,id) AS identity_display_name,
        row_number() OVER (PARTITION BY COALESCE(normalized_phone,'id:'||id)
          ORDER BY CASE WHEN id~'@(c\\.us|s\\.whatsapp\\.net)$' THEN 0 ELSE 1 END,id) AS identity_rank
      FROM combined JOIN matched_identity ON matched_identity.identity_key=COALESCE(combined.normalized_phone,'id:'||combined.id)
    ) SELECT id,COALESCE(CASE WHEN COALESCE(identity_display_name,'')~'^[1-9][0-9]{5,19}@(c\\.us|s\\.whatsapp\\.net|lid)$'
      THEN NULL ELSE identity_display_name END,normalized_phone,CASE WHEN id LIKE '%@lid' THEN 'WhatsApp participant'
      ELSE '+'||split_part(id,'@',1) END) AS name,normalized_phone AS phone
      FROM ranked WHERE identity_rank=1
      ORDER BY COALESCE(identity_display_name,normalized_phone,split_part(id,'@',1)),id LIMIT 20`,[
      claims.tenantId,groupId,search,claims.userId,claims.groupIds,claims.groupAdmin,
    ]);
  }

  @Get("groups/:groupId/messages/:messageId/media")
  async media(@Headers("authorization")authorization:string|undefined,@Param("groupId")groupId:string,@Param("messageId")messageId:string,
    @Req()request?:ZammadServiceRequest){
    const claims=await this.agent(authorization,request);assertUuid(groupId,"Group ID");assertUuid(messageId,"Message ID");await this.assertAccess(claims,groupId);
    const row=(await this.database.rows(claims.tenantId,`WITH accessible_group AS (
      SELECT group_record.id,group_record.tenant_id,group_record.connection_id,group_record.external_group_id,workspace.enabled_at
      FROM whatsapp_groups group_record JOIN tenant_settings tenant ON tenant.tenant_id=group_record.tenant_id
      JOIN group_workspace_settings workspace ON workspace.tenant_id=group_record.tenant_id AND workspace.whatsapp_group_id=group_record.id
      WHERE group_record.tenant_id=$1 AND group_record.id=$2 AND tenant.group_workspace_enabled AND workspace.capture_enabled
        AND ${groupWorkspaceAccessSql("group_record","workspace","$4","$5","$6")}
    ) SELECT source.filename,source.mime_type,source.byte_size,source.object_key,source.sha256 FROM (
      SELECT NULLIF(message.provider_metadata->>'fileName','') AS filename,object.mime_type,object.byte_size,object.object_key,object.sha256
      FROM normalized_messages message JOIN accessible_group group_record ON group_record.tenant_id=message.tenant_id
        AND group_record.connection_id=message.connection_id AND group_record.external_group_id=message.external_group_id
      JOIN media_objects object ON object.tenant_id=message.tenant_id
        AND object.id=CASE WHEN message.provider_metadata->>'media_object_id'~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN (message.provider_metadata->>'media_object_id')::uuid END
        AND object.scan_state='CLEAN' AND object.expires_at>now()
      WHERE message.tenant_id=$1 AND message.id=$3 AND message.history_captured_at IS NOT NULL
        AND message.provider_timestamp>=group_record.enabled_at
        AND ${GROUP_MESSAGE_NOT_REDACTED_ECHO_SQL}
        AND NOT (${GROUP_MESSAGE_REVOKED_SQL})
      UNION ALL
      SELECT descriptor.filename,object.mime_type,object.byte_size,object.object_key,object.sha256
      FROM delivery_outbox delivery
      LEFT JOIN group_bindings binding ON binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id
      JOIN accessible_group group_record ON group_record.tenant_id=delivery.tenant_id
        AND group_record.id=COALESCE(delivery.group_workspace_group_id,binding.whatsapp_group_id)
        AND group_record.connection_id=delivery.connection_id
      JOIN delivery_media descriptor ON descriptor.tenant_id=delivery.tenant_id AND descriptor.delivery_id=delivery.id AND descriptor.state='READY'
      JOIN media_objects object ON object.tenant_id=descriptor.tenant_id AND object.id=descriptor.media_object_id
        AND object.scan_state='CLEAN' AND object.expires_at>now()
      WHERE delivery.tenant_id=$1 AND group_record.id=$2 AND delivery.id=$3
        AND delivery.content_redacted_at IS NULL
        AND delivery.created_at>=group_record.enabled_at
    ) source LIMIT 1`,[claims.tenantId,groupId,messageId,claims.userId,claims.groupIds,claims.groupAdmin]))[0] as {filename:string|null;mime_type:string;byte_size:string|number;object_key:string;sha256:string}|undefined;
    if(!row||!this.artifacts)throw new NotFoundException("Group message media was not found");
    if(!/^[a-f0-9]{64}$/u.test(row.sha256)||row.object_key!==`${claims.tenantId}/sha256/${row.sha256.slice(0,2)}/${row.sha256}`)throw new NotFoundException("Group message media was not found");
    const filename=safeMediaFilename(row.filename?.trim()||"attachment");
    const mimeType=normalizeMediaMime(typeof row.mime_type==="string"?row.mime_type:"");
    const byteSize=Number(row.byte_size),maximumBytes=maximumMediaBytes(mimeType);
    if(!maximumBytes||!Number.isSafeInteger(byteSize)||byteSize<1||byteSize>maximumBytes)throw new NotFoundException("Group message media was not found");
    return{url:await this.artifacts.signedMediaUrl(claims.tenantId,row.object_key,row.sha256,filename,mimeType,60),filename,mime_type:mimeType,byte_size:byteSize,sha256:row.sha256};
  }

  @Get("groups/:groupId/messages/:messageId/context")
  async context(@Headers("authorization")authorization:string|undefined,@Param("groupId")groupId:string,@Param("messageId")messageId:string,
    @Req()request?:ZammadServiceRequest){
    const claims=await this.agent(authorization,request);assertUuid(groupId,"Group ID");assertUuid(messageId,"Message ID");
    await this.assertAccess(claims,groupId);
    const rows=await this.database.rows(claims.tenantId,`WITH accessible_group AS (
      SELECT g.id,g.tenant_id,g.connection_id,g.external_group_id,workspace.enabled_at
      FROM whatsapp_groups g JOIN tenant_settings tenant ON tenant.tenant_id=g.tenant_id
      JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
      WHERE g.tenant_id=$1 AND g.id=$2 AND tenant.group_workspace_enabled AND workspace.capture_enabled
        AND ${groupWorkspaceAccessSql("g","workspace","$4","$5","$6")}
    ), ${GROUP_QUOTE_CANDIDATES_SQL}, all_items AS (
      SELECT message.id,message.external_message_id,sent_delivery.id AS delivery_id,
        ${groupMessageSenderNameSql("participant_name")},${GROUP_MESSAGE_SENDER_PHONE_SQL},${GROUP_MESSAGE_IDENTITY_KEY_SQL},
        CASE WHEN ${GROUP_MESSAGE_REVOKED_SQL} THEN 'Message deleted'
             WHEN message.provider_metadata->'mutations'->-1->>'kind'='EDITED'
               THEN COALESCE(message.provider_metadata->'mutations'->-1->>'replacement_text',message.message_text)
             ELSE message.message_text END AS message_text,
        COALESCE(quote_target.external_id,message.quoted_external_message_id) AS quoted_external_message_id,message.from_me,message.provider_timestamp,
        CASE WHEN ${GROUP_MESSAGE_REVOKED_SQL} THEN 'REVOKED'
             ELSE message.provider_metadata->'mutations'->-1->>'kind' END AS latest_mutation,
        (COALESCE(message.provider_metadata->>'eventKind','MESSAGE')<>'REACTION'
          AND NOT (${GROUP_MESSAGE_REVOKED_SQL})) AS quote_allowed,
        (NOT message.from_me AND message.external_participant_id<>''
          AND COALESCE(message.provider_metadata->>'eventKind','MESSAGE')<>'REACTION'
          AND NOT (${GROUP_MESSAGE_REVOKED_SQL})) AS ticket_creatable,
        EXISTS (SELECT 1 FROM message_links link WHERE link.tenant_id=message.tenant_id
          AND link.connection_id=message.connection_id AND link.external_message_id=message.external_message_id) AS linked_to_ticket,
        ${GROUP_MESSAGE_REACTION_SELECT_SQL},
        'MESSAGE'::text AS source_kind,NULL::text AS delivery_state,NULL::text AS delivery_hold_reason,
        NULL::timestamptz AS delivery_next_attempt_at,NULL::timestamptz AS delivery_hold_expires_at,
        ${GROUP_MESSAGE_MEDIA_SQL}
      FROM normalized_messages message JOIN accessible_group g ON g.tenant_id=message.tenant_id
        AND g.connection_id=message.connection_id AND g.external_group_id=message.external_group_id
      JOIN connections connection ON connection.tenant_id=g.tenant_id AND connection.id=g.connection_id
      ${GROUP_QUOTE_JOIN_SQL}
      LEFT JOIN delivery_outbox sent_delivery ON sent_delivery.tenant_id=message.tenant_id
        AND sent_delivery.connection_id=message.connection_id AND sent_delivery.external_message_id=message.external_message_id
        AND sent_delivery.content_type<>'${GROUP_REACTION_CONTENT_TYPE}'
      ${GROUP_MESSAGE_PARTICIPANT_JOIN_SQL}
      ${GROUP_MESSAGE_REACTION_JOIN_SQL}
      ${GROUP_MESSAGE_MEDIA_JOIN_SQL}
      WHERE message.tenant_id=$1 AND message.history_captured_at IS NOT NULL AND message.provider_timestamp>=g.enabled_at
        AND ${GROUP_MESSAGE_NOT_REDACTED_ECHO_SQL}
      UNION ALL
      SELECT delivery.id,delivery.external_message_id,delivery.id,delivery.agent_display_name,connection.phone_e164,
        'self'::text,delivery.message_body,delivery.reply_to_message_id,true,delivery.created_at,NULL::text,false,false,
        (delivery.zammad_ticket_id IS NOT NULL OR EXISTS (SELECT 1 FROM delivery_ticket_links ticket_link
          WHERE ticket_link.tenant_id=delivery.tenant_id AND ticket_link.delivery_id=delivery.id)),
        NULL::text,NULL::text,NULL::text,
        'DELIVERY'::text,delivery.state,${deliveryHoldReasonSql("delivery")},
        CASE WHEN delivery.state='QUEUED' AND delivery.safe_error IS NOT NULL THEN delivery.available_at END,
        ${deliveryHoldExpiresAtSql("delivery","policy")},media.filename,COALESCE(delivery_object.mime_type,media.mime_type),
        CASE WHEN media.mime_type LIKE 'image/%' THEN 'image' WHEN media.mime_type LIKE 'video/%' THEN 'video'
          WHEN media.mime_type LIKE 'audio/%' THEN 'audio' WHEN media.mime_type IS NOT NULL THEN 'document' END,
        COALESCE(media.state='READY' AND delivery_object.scan_state='CLEAN' AND delivery_object.expires_at>now(),false)
      FROM delivery_outbox delivery
      LEFT JOIN group_bindings binding ON binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id
      JOIN accessible_group g ON g.tenant_id=delivery.tenant_id AND g.connection_id=delivery.connection_id
        AND g.id=COALESCE(delivery.group_workspace_group_id,binding.whatsapp_group_id)
      JOIN connections connection ON connection.tenant_id=g.tenant_id AND connection.id=g.connection_id
      LEFT JOIN waha_outbound_connection_policies policy ON policy.tenant_id=delivery.tenant_id AND policy.connection_id=delivery.connection_id
      LEFT JOIN delivery_media media ON media.tenant_id=delivery.tenant_id AND media.delivery_id=delivery.id
      LEFT JOIN media_objects delivery_object ON delivery_object.tenant_id=media.tenant_id AND delivery_object.id=media.media_object_id
      WHERE delivery.tenant_id=$1 AND delivery.created_at>=g.enabled_at AND delivery.content_type<>'${GROUP_REACTION_CONTENT_TYPE}'
        AND delivery.content_redacted_at IS NULL
        AND (btrim(delivery.message_body)<>'' OR media.id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM normalized_messages echo WHERE echo.tenant_id=delivery.tenant_id
          AND echo.connection_id=delivery.connection_id AND echo.external_group_id=g.external_group_id
          AND echo.external_message_id=delivery.external_message_id AND delivery.external_message_id IS NOT NULL
          AND echo.history_captured_at IS NOT NULL AND echo.provider_timestamp>=g.enabled_at)
    ), selected AS (
      SELECT provider_timestamp,id FROM all_items WHERE id=$3
    ), bounded AS (
      (SELECT * FROM all_items WHERE (provider_timestamp,id)<=(SELECT provider_timestamp,id FROM selected)
        ORDER BY provider_timestamp DESC,id DESC LIMIT 11)
      UNION ALL
      (SELECT * FROM all_items WHERE (provider_timestamp,id)>(SELECT provider_timestamp,id FROM selected)
        ORDER BY provider_timestamp,id LIMIT 10)
    ) SELECT * FROM bounded ORDER BY provider_timestamp,id`,[
      claims.tenantId,groupId,messageId,claims.userId,claims.groupIds,claims.groupAdmin,
    ]);
    if(!rows.some(row=>(row as {id:string}).id===messageId))throw new NotFoundException("Group message was not found");
    return projectGroupMessages(rows);
  }

  @Get("groups/:groupId/tickets")
  async tickets(@Headers("authorization")authorization:string|undefined,@Param("groupId")groupId:string,
    @Query("before")before:string|undefined,@Query("limit")limitValue:string|undefined,@Req()request?:ZammadServiceRequest){
    const claims=await this.agent(authorization,request);assertUuid(groupId,"Group ID");
    const limit=limitValue===undefined?100:integer(limitValue,1,200,"limit");
    if(before!==undefined)assertUuid(before,"Ticket cursor");
    await this.assertAccess(claims,groupId);
    const rows=await this.database.rows(claims.tenantId,`WITH accessible_group AS (
      SELECT g.id,g.tenant_id,g.connection_id,g.external_group_id,workspace.enabled_at
      FROM whatsapp_groups g JOIN tenant_settings tenant ON tenant.tenant_id=g.tenant_id
      JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
      WHERE g.tenant_id=$1 AND g.id=$2 AND tenant.group_workspace_enabled AND workspace.capture_enabled
        AND ${groupWorkspaceAccessSql("g","workspace","$5","$6","$7")}
    ), candidate_links AS (
      SELECT link.id AS link_id,link.zammad_ticket_id AS ticket_id,
        link.zammad_article_id AS article_id,message.id AS message_id,link.created_at AS linked_at
      FROM message_links link
      JOIN accessible_group g ON g.tenant_id=link.tenant_id AND g.connection_id=link.connection_id
      JOIN normalized_messages message ON message.tenant_id=link.tenant_id AND message.connection_id=link.connection_id
        AND message.external_group_id=g.external_group_id AND message.external_message_id=link.external_message_id
        AND message.history_captured_at IS NOT NULL AND message.provider_timestamp>=g.enabled_at
      WHERE link.tenant_id=$1 AND ${GROUP_MESSAGE_NOT_REDACTED_ECHO_SQL}
      UNION ALL
      SELECT (substr(cursor_hash.value,1,8)||'-'||substr(cursor_hash.value,9,4)||'-4'||
          substr(cursor_hash.value,14,3)||'-8'||substr(cursor_hash.value,18,3)||'-'||substr(cursor_hash.value,21,12))::uuid,
        linked_ticket.ticket_id,delivery.zammad_article_id,delivery.id,delivery.created_at
      FROM delivery_outbox delivery
      LEFT JOIN group_bindings binding ON binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id
      JOIN accessible_group g ON g.tenant_id=delivery.tenant_id AND g.connection_id=delivery.connection_id
        AND g.id=COALESCE(delivery.group_workspace_group_id,binding.whatsapp_group_id)
      CROSS JOIN LATERAL (
        SELECT ticket_link.zammad_ticket_id AS ticket_id FROM delivery_ticket_links ticket_link
        WHERE ticket_link.tenant_id=delivery.tenant_id AND ticket_link.delivery_id=delivery.id
        UNION SELECT delivery.zammad_ticket_id WHERE delivery.zammad_ticket_id IS NOT NULL
      ) linked_ticket
      CROSS JOIN LATERAL (SELECT md5(delivery.id::text||chr(31)||linked_ticket.ticket_id) AS value) cursor_hash
      WHERE delivery.tenant_id=$1 AND delivery.created_at>=g.enabled_at
        AND delivery.content_redacted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM normalized_messages echo WHERE echo.tenant_id=delivery.tenant_id
          AND echo.connection_id=delivery.connection_id AND echo.external_group_id=g.external_group_id
          AND echo.external_message_id=delivery.external_message_id AND delivery.external_message_id IS NOT NULL
          AND echo.history_captured_at IS NOT NULL AND echo.provider_timestamp>=g.enabled_at)
    ), latest_ticket_links AS (
      SELECT DISTINCT ON (ticket_id) * FROM candidate_links
      ORDER BY ticket_id,linked_at DESC,link_id DESC
    ), cursor AS (
      SELECT linked_at AS created_at,link_id AS id FROM candidate_links WHERE link_id=$3
      ORDER BY linked_at DESC LIMIT 1
    ) SELECT latest.link_id,latest.ticket_id,latest.article_id,latest.message_id,latest.linked_at,
      (SELECT jsonb_agg(jsonb_build_object('message_id',related.message_id,'article_id',related.article_id)
        ORDER BY related.linked_at,related.link_id) FROM (
          SELECT message_id,article_id,linked_at,link_id FROM candidate_links
          WHERE ticket_id=latest.ticket_id ORDER BY linked_at DESC,link_id DESC LIMIT 100
        ) related) AS links
      FROM latest_ticket_links latest
      WHERE ($3::uuid IS NULL OR (latest.linked_at,latest.link_id)<(SELECT created_at,id FROM cursor))
      ORDER BY latest.linked_at DESC,latest.link_id DESC LIMIT $4`,[
      claims.tenantId,groupId,before??null,limit+1,claims.userId,claims.groupIds,claims.groupAdmin,
    ]);
    return{items:rows.slice(0,limit),next_cursor:rows.length>limit?(rows[limit-1] as {link_id:string}).link_id:null};
  }

  @Get("tickets/:ticketId/message-context")
  async ticketMessageContext(@Headers("authorization")authorization:string|undefined,@Param("ticketId")ticketIdValue:string,
    @Req()request?:ZammadServiceRequest,@Query("article_ids")articleIdsValue?:string){
    const claims=await this.agent(authorization,request);const ticketId=positiveId(ticketIdValue,"Ticket ID");
    const articleIds=articleIdsValue===undefined?null:articleIdsValue.split(",").map(value=>positiveId(value,"Article ID"));
    if(articleIds&&(articleIds.length<1||articleIds.length>20||new Set(articleIds).size!==articleIds.length))
      throw new BadRequestException("Invalid article IDs");
    const contexts=await this.database.rows<{group_id:string;message_id:string;article_id?:string|null;sender_name:string|null;sender_phone:string|null;from_me:boolean}>(claims.tenantId,`WITH contexts AS (
      SELECT g.id AS group_id,message.id AS message_id,link.zammad_article_id AS article_id,
      ${groupMessageSenderNameSql("sender_name")},
      ${GROUP_MESSAGE_SENDER_PHONE_SQL},message.from_me,link.created_at,link.id AS link_id
      FROM message_links link
      JOIN normalized_messages message ON message.tenant_id=link.tenant_id
        AND message.connection_id=link.connection_id AND message.external_message_id=link.external_message_id
        AND message.history_captured_at IS NOT NULL
      JOIN connections connection ON connection.tenant_id=message.tenant_id AND connection.id=message.connection_id
      LEFT JOIN delivery_outbox sent_delivery ON sent_delivery.tenant_id=message.tenant_id
        AND sent_delivery.connection_id=message.connection_id
        AND sent_delivery.external_message_id=message.external_message_id
        AND sent_delivery.content_type<>'${GROUP_REACTION_CONTENT_TYPE}'
      JOIN whatsapp_groups g ON g.tenant_id=message.tenant_id AND g.connection_id=message.connection_id
        AND g.external_group_id=message.external_group_id
      ${GROUP_MESSAGE_PARTICIPANT_JOIN_SQL}
      JOIN tenant_settings tenant ON tenant.tenant_id=g.tenant_id
      JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
      WHERE link.tenant_id=$1 AND link.zammad_ticket_id=$2
        AND ($6::text[] IS NULL OR link.zammad_article_id=ANY($6::text[]))
        AND tenant.group_workspace_enabled AND workspace.capture_enabled
        AND message.provider_timestamp>=workspace.enabled_at
        AND ${GROUP_MESSAGE_NOT_REDACTED_ECHO_SQL}
        AND ${groupWorkspaceAccessSql("g","workspace","$3","$4","$5")}
      UNION ALL
      SELECT g.id,delivery.id,CASE WHEN delivery.zammad_ticket_id=$2 THEN delivery.zammad_article_id END,delivery.agent_display_name,connection.phone_e164,true,
        delivery.created_at,delivery.id
      FROM delivery_outbox delivery
      LEFT JOIN group_bindings binding ON binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id
      JOIN connections connection ON connection.tenant_id=delivery.tenant_id AND connection.id=delivery.connection_id
      JOIN whatsapp_groups g ON g.tenant_id=delivery.tenant_id AND g.connection_id=delivery.connection_id
        AND g.id=COALESCE(delivery.group_workspace_group_id,binding.whatsapp_group_id)
      JOIN tenant_settings tenant ON tenant.tenant_id=g.tenant_id
      JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
      WHERE delivery.tenant_id=$1 AND tenant.group_workspace_enabled AND workspace.capture_enabled
        AND delivery.content_redacted_at IS NULL
        AND ($6::text[] IS NULL OR (delivery.zammad_ticket_id=$2 AND delivery.zammad_article_id=ANY($6::text[])))
        AND delivery.created_at>=workspace.enabled_at
        AND (delivery.zammad_ticket_id=$2 OR EXISTS (SELECT 1 FROM delivery_ticket_links ticket_link
          WHERE ticket_link.tenant_id=delivery.tenant_id AND ticket_link.delivery_id=delivery.id
            AND ticket_link.zammad_ticket_id=$2))
        AND NOT EXISTS (SELECT 1 FROM normalized_messages echo WHERE echo.tenant_id=delivery.tenant_id
          AND echo.connection_id=delivery.connection_id AND echo.external_group_id=g.external_group_id
          AND echo.external_message_id=delivery.external_message_id AND delivery.external_message_id IS NOT NULL
          AND echo.history_captured_at IS NOT NULL AND echo.provider_timestamp>=workspace.enabled_at)
        AND ${groupWorkspaceAccessSql("g","workspace","$3","$4","$5")}
    ) SELECT group_id,message_id,article_id,sender_name,sender_phone,from_me FROM contexts
      ORDER BY created_at,link_id LIMIT 101`,[
      claims.tenantId,ticketId,claims.userId,claims.groupIds,claims.groupAdmin,articleIds,
    ]);
    if(!contexts[0]&&!articleIds)throw new NotFoundException("Ticket message context was not found");
    const items=contexts.slice(0,100);
    return{...items[0],items,truncated:contexts.length>100};
  }

  @Get("groups/:groupId/messages/:messageId/source")
  async source(@Headers("authorization")authorization:string|undefined,@Param("groupId")groupId:string,@Param("messageId")messageId:string,
    @Req()request?:ZammadServiceRequest){
    const claims=await this.agent(authorization,request);assertUuid(groupId,"Group ID");assertUuid(messageId,"Message ID");
    await this.assertAccess(claims,groupId);
    const rows=await this.database.rows(claims.tenantId,`WITH accessible_group AS (
      SELECT g.id,g.tenant_id,g.connection_id,g.external_group_id,workspace.enabled_at,
        COALESCE(g.wasalx_name,g.display_name) AS group_name
      FROM whatsapp_groups g JOIN tenant_settings tenant ON tenant.tenant_id=g.tenant_id
      JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
      WHERE g.tenant_id=$1 AND g.id=$2 AND tenant.group_workspace_enabled AND workspace.capture_enabled
        AND ${groupWorkspaceAccessSql("g","workspace","$4","$5","$6")}
    ) SELECT message.id,message.external_message_id,
      ${GROUP_MESSAGE_IDENTITY_KEY_SQL},
      ${groupMessageSenderNameSql("participant_name")},${GROUP_MESSAGE_SENDER_PHONE_SQL},
      message.connection_id,g.id AS group_id,g.external_group_id,connection.provider,
      g.group_name,message.from_me,
      CASE WHEN ${GROUP_MESSAGE_REVOKED_SQL} THEN 'Message deleted'
           WHEN message.provider_metadata->'mutations'->-1->>'kind'='EDITED'
             THEN COALESCE(message.provider_metadata->'mutations'->-1->>'replacement_text',message.message_text)
           ELSE message.message_text END AS message_text,
      CASE WHEN ${GROUP_MESSAGE_REVOKED_SQL} THEN 'REVOKED'
           ELSE message.provider_metadata->'mutations'->-1->>'kind' END AS latest_mutation,
      (NOT message.from_me AND message.external_participant_id<>''
        AND COALESCE(message.provider_metadata->>'eventKind','MESSAGE')<>'REACTION'
        AND NOT (${GROUP_MESSAGE_REVOKED_SQL})) AS ticket_creatable,
      ${GROUP_MESSAGE_MEDIA_SQL},
      CASE WHEN message.provider_metadata->>'zammad_customer_id'~'^[1-9][0-9]{0,15}$'
           THEN message.provider_metadata->>'zammad_customer_id' END AS zammad_customer_id,
      COALESCE(jsonb_agg(jsonb_build_object('ticket_id',link.zammad_ticket_id,'article_id',link.zammad_article_id)
        ORDER BY link.created_at DESC) FILTER (WHERE link.id IS NOT NULL),'[]'::jsonb) AS links
      FROM normalized_messages message JOIN accessible_group g ON g.tenant_id=message.tenant_id
        AND g.connection_id=message.connection_id AND g.external_group_id=message.external_group_id
      JOIN connections connection ON connection.tenant_id=g.tenant_id AND connection.id=g.connection_id
      LEFT JOIN delivery_outbox sent_delivery ON sent_delivery.tenant_id=message.tenant_id
        AND sent_delivery.connection_id=message.connection_id
        AND sent_delivery.external_message_id=message.external_message_id
        AND sent_delivery.content_type<>'${GROUP_REACTION_CONTENT_TYPE}'
      ${GROUP_MESSAGE_PARTICIPANT_JOIN_SQL}
      ${GROUP_MESSAGE_MEDIA_JOIN_SQL}
      LEFT JOIN message_links link ON link.tenant_id=message.tenant_id AND link.connection_id=message.connection_id
        AND link.external_message_id=message.external_message_id
      WHERE message.tenant_id=$1 AND message.id=$3 AND message.history_captured_at IS NOT NULL
        AND message.provider_timestamp>=g.enabled_at
        AND ${GROUP_MESSAGE_NOT_REDACTED_ECHO_SQL}
        AND COALESCE(message.provider_metadata->>'eventKind','MESSAGE')<>'REACTION'
      GROUP BY message.id,g.id,g.external_group_id,g.group_name,connection.id,media_object.id,
        participant.display_name,participant.normalized_phone,retained_identity.id,
        retained_identity.display_name,retained_identity.normalized_phone,sent_delivery.agent_display_name`,[
      claims.tenantId,groupId,messageId,claims.userId,claims.groupIds,claims.groupAdmin,
    ]);
    if(!rows[0])throw new NotFoundException("Group message was not found");
    const source=rows[0] as Record<string,unknown>;
    return typeof source.media_filename==="string"
      ? {...source,media_filename:safeMediaFilename(source.media_filename)}
      : source;
  }

  @Post("groups/:groupId/messages/:messageId/tickets")
  async linkTicket(@Headers("authorization")authorization:string|undefined,@Headers("idempotency-key")idempotencyKey:string|undefined,
    @Param("groupId")groupId:string,@Param("messageId")messageId:string,@Body()body:Record<string,unknown>,@Req()request?:ZammadServiceRequest){
    const claims=await this.agent(authorization,request);assertUuid(groupId,"Group ID");assertUuid(messageId,"Message ID");
    const key=boundedKey(idempotencyKey,"Idempotency key");
    const ticketId=positiveId(body.ticketId,"Ticket ID");const articleId=positiveId(body.articleId,"Article ID");
    const requestSha256=createHash("sha256").update(JSON.stringify({groupId,messageId,ticketId,articleId}),"utf8").digest("hex");
    await this.assertAccess(claims,groupId);
    return this.database.withTenant(claims.tenantId,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${claims.tenantId}:${key}`]);
      const replay=(await client.query<{request_sha256:string;message_link_id:string;zammad_article_id:string}>(`SELECT request_sha256,message_link_id,zammad_article_id
        FROM group_workspace_ticket_receipts WHERE tenant_id=$1 AND idempotency_key=$2`,[
        claims.tenantId,key,
      ])).rows[0];
      if(replay){
        if(replay.request_sha256!==requestSha256)throw new ConflictException("Idempotency key was already used for a different ticket link");
        return{id:replay.message_link_id,zammad_article_id:replay.zammad_article_id,duplicate:true};
      }
      const message=(await client.query<{connection_id:string;external_message_id:string;from_me:boolean;quoted_external_message_id:string|null}>(`SELECT message.connection_id,
        message.external_message_id,message.from_me,message.quoted_external_message_id
        FROM normalized_messages message JOIN whatsapp_groups g ON g.tenant_id=message.tenant_id
          AND g.id=$2 AND g.connection_id=message.connection_id AND g.external_group_id=message.external_group_id
        JOIN tenant_settings tenant ON tenant.tenant_id=g.tenant_id
        JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
        WHERE message.tenant_id=$1 AND message.id=$3 AND message.history_captured_at IS NOT NULL
          AND message.provider_timestamp>=workspace.enabled_at
          AND ${GROUP_MESSAGE_NOT_REDACTED_ECHO_SQL}
          AND NOT (${GROUP_MESSAGE_REVOKED_SQL})
          AND COALESCE(message.provider_metadata->>'eventKind','MESSAGE')<>'REACTION'
          AND tenant.group_workspace_enabled AND workspace.capture_enabled
          AND ${groupWorkspaceAccessSql("g","workspace","$4","$5","$6")}
          FOR SHARE OF message,g,workspace`,[
        claims.tenantId,groupId,messageId,claims.userId,claims.groupIds,claims.groupAdmin,
      ])).rows[0];
      if(!message)throw new NotFoundException("Group message was not found");
      if(message.from_me)throw new BadRequestException("Outbound group messages cannot be linked to a Customer ticket article");
      const created=(await client.query<{id:string}>(`INSERT INTO message_links
        (tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction,quoted_external_message_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (connection_id,external_message_id,zammad_ticket_id) DO NOTHING RETURNING id`,[
        claims.tenantId,message.connection_id,message.external_message_id,ticketId,articleId,
        "INBOUND",message.quoted_external_message_id,
      ])).rows[0];
      let linked:{id:string;zammad_article_id:string};let changed=false;
      if(!created){
        const existing=(await client.query<{id:string;zammad_article_id:string|null}>(`SELECT id,zammad_article_id FROM message_links
          WHERE tenant_id=$1 AND connection_id=$2 AND external_message_id=$3 AND zammad_ticket_id=$4`,[
          claims.tenantId,message.connection_id,message.external_message_id,ticketId,
        ])).rows[0];
        if(!existing)throw new ConflictException("Message link changed; retry the request");
        if(existing.zammad_article_id===null){
          const completed=(await client.query<{id:string;zammad_article_id:string}>(`UPDATE message_links SET zammad_article_id=$1
            WHERE tenant_id=$2 AND id=$3 AND zammad_article_id IS NULL RETURNING id,zammad_article_id`,[
            articleId,claims.tenantId,existing.id,
          ])).rows[0];
          if(!completed)throw new ConflictException("Message link changed; retry the request");
          linked=completed;changed=true;
        }else{
          if(existing.zammad_article_id!==articleId)throw new ConflictException("Message is already linked to another ticket article");
          linked={id:existing.id,zammad_article_id:existing.zammad_article_id};
        }
      }else{
        linked={...created,zammad_article_id:articleId};changed=true;
      }
      if(changed)await client.query(`INSERT INTO audit_events
          (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
          VALUES ($1,'ZAMMAD_USER',$2,'group_workspace.ticket_linked','whatsapp_group',$3,$4,$5)`,[
          claims.tenantId,claims.userId,groupId,{message_id:messageId,ticket_id:ticketId,article_id:articleId},`zammad-group-link:${key}`,
        ]);
      await client.query(`INSERT INTO group_workspace_ticket_receipts
        (tenant_id,zammad_instance_id,zammad_user_id,whatsapp_group_id,normalized_message_id,
          idempotency_key,request_sha256,message_link_id,zammad_ticket_id,zammad_article_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[
        claims.tenantId,claims.instanceId,claims.userId,groupId,messageId,key,requestSha256,linked.id,ticketId,articleId,
      ]);
      return{...linked,duplicate:!changed};
    });
  }

  @Post("groups/:groupId/read")
  async markRead(@Headers("authorization")authorization:string|undefined,@Param("groupId")groupId:string,@Body()body:Record<string,unknown>,
    @Req()request?:ZammadServiceRequest){
    const claims=await this.agent(authorization,request);assertUuid(groupId,"Group ID");
    const messageId=String(body.messageId??"");assertUuid(messageId,"Message ID");await this.assertAccess(claims,groupId);
    return this.database.withTenant(claims.tenantId,async client=>{
      const message=(await client.query(`WITH accessible_group AS (
        SELECT g.id,g.tenant_id,g.connection_id,g.external_group_id,workspace.enabled_at
        FROM whatsapp_groups g JOIN tenant_settings tenant ON tenant.tenant_id=g.tenant_id
        JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
        WHERE g.tenant_id=$1 AND g.id=$2 AND tenant.group_workspace_enabled AND workspace.capture_enabled
          AND ${groupWorkspaceAccessSql("g","workspace","$4","$5","$6")}
      ) SELECT message.id FROM normalized_messages message JOIN accessible_group g
        ON g.tenant_id=message.tenant_id AND g.connection_id=message.connection_id AND g.external_group_id=message.external_group_id
        WHERE message.tenant_id=$1 AND message.id=$3 AND message.history_captured_at IS NOT NULL
          AND message.provider_timestamp>=g.enabled_at
          AND ${GROUP_MESSAGE_NOT_REDACTED_ECHO_SQL}`, [
        claims.tenantId,groupId,messageId,claims.userId,claims.groupIds,claims.groupAdmin,
      ])).rows[0];
      if(!message)throw new NotFoundException("Group message was not found");
      const advanced=await client.query<{last_message_id:string}>(`INSERT INTO group_workspace_read_cursors
        (tenant_id,zammad_instance_id,zammad_user_id,whatsapp_group_id,last_message_id)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,zammad_instance_id,zammad_user_id,whatsapp_group_id)
        DO UPDATE SET last_message_id=EXCLUDED.last_message_id,read_at=now()
        WHERE group_workspace_read_cursors.last_message_id IS NULL OR
          (SELECT (current_message.provider_timestamp,current_message.id)<(next_message.provider_timestamp,next_message.id)
            FROM normalized_messages current_message,normalized_messages next_message
            WHERE current_message.tenant_id=$1 AND current_message.id=group_workspace_read_cursors.last_message_id
              AND next_message.tenant_id=$1 AND next_message.id=EXCLUDED.last_message_id)
        RETURNING last_message_id`,[
        claims.tenantId,claims.instanceId,claims.userId,groupId,messageId,
      ]);
      if(advanced.rows.length)await client.query(`INSERT INTO audit_events
          (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
          VALUES ($1,'ZAMMAD_USER',$2,'group_workspace.read','whatsapp_group',$3,$4,$5)`,[
          claims.tenantId,claims.userId,groupId,{message_id:messageId},crypto.randomUUID(),
        ]);
      return{read:true};
    });
  }

  @Post("groups/:groupId/send")
  async send(@Headers("authorization")authorization:string|undefined,@Headers("idempotency-key")idempotencyKey:string|undefined,
    @Param("groupId")groupId:string,@Body()body:Record<string,unknown>,@Req()request?:ZammadServiceRequest){
    const claims=await this.agent(authorization,request);assertUuid(groupId,"Group ID");
    const key=canonicalGroupWorkspaceSubmissionKey("SEND",claims.userId!,boundedKey(idempotencyKey,"Idempotency key"));
    const attachments=workspaceAttachments(body.attachments);
    const message=outboundMessage(body.message,attachments.length>0);
    const mentions=workspaceMentions(body.mentions);
    const replyToMessageId=body.replyToMessageId==null?null:String(body.replyToMessageId);if(replyToMessageId)assertUuid(replyToMessageId,"Quoted message ID");
    const agentDisplayName=cleanDisplayName(body.agentDisplayName);
    const logicalAttachments=attachments.map(({uploadCacheId,sourceStoreId,filename,mimeType,byteSize})=>({uploadCacheId,sourceStoreId,filename,mimeType,byteSize}));
    const fingerprint=createHash("sha256").update(JSON.stringify({groupId,message,replyToMessageId,agentDisplayName,attachments:logicalAttachments,mentions}),"utf8").digest("hex");
    const binding={claims,groupId,key,kind:"SEND" as const,targetMessageId:null};
    const result=await this.database.withTenant(claims.tenantId,async client=>{
      await lockGroupWorkspaceOperation(client,binding);
      const prior=await readGroupWorkspaceOperation(client,binding);
      const replay=await replayGroupWorkspaceOperation(client,binding,prior,fingerprint);
      if(replay)return{...replay,sender_phone:replay.sender_phone??null};
      const route=(await client.query<{connection_id:string;provider:"WAHA"|"META";phone_e164:string;external_message_id:string|null;agent_prefix:string;agent_identity_placement:"HEADER"|"FOOTER"|"OFF"}>(`SELECT g.connection_id,
        connection.provider,connection.phone_e164,quoted.external_message_id,
        COALESCE((SELECT configured.agent_prefix FROM group_bindings configured
          WHERE configured.tenant_id=g.tenant_id AND configured.whatsapp_group_id=g.id),workspace.agent_prefix) AS agent_prefix,
        COALESCE((SELECT configured.agent_identity_placement FROM group_bindings configured
          WHERE configured.tenant_id=g.tenant_id AND configured.whatsapp_group_id=g.id),workspace.agent_identity_placement) AS agent_identity_placement
        FROM whatsapp_groups g
        JOIN connections connection ON connection.tenant_id=g.tenant_id AND connection.id=g.connection_id
        JOIN tenant_settings tenant ON tenant.tenant_id=g.tenant_id
        JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
        LEFT JOIN normalized_messages quoted ON quoted.tenant_id=g.tenant_id AND quoted.id=$6
          AND quoted.connection_id=g.connection_id AND quoted.external_group_id=g.external_group_id
          AND quoted.history_captured_at IS NOT NULL
          AND quoted.provider_timestamp>=workspace.enabled_at
          AND NOT (${messageRevokedSql("quoted")})
          AND COALESCE(quoted.provider_metadata->>'eventKind','MESSAGE')<>'REACTION'
          AND ${messageNotRedactedEchoSql("quoted")}
        WHERE g.tenant_id=$1 AND g.id=$2 AND connection.state='WORKING'
          AND tenant.group_workspace_enabled AND workspace.capture_enabled
          AND EXISTS (SELECT 1 FROM provider_sessions session WHERE session.tenant_id=g.tenant_id
            AND session.connection_id=g.connection_id AND session.ownership_state='ACTIVE' AND session.state='WORKING')
          AND ($6::uuid IS NULL OR quoted.id IS NOT NULL)
          AND ${groupWorkspaceAccessSql("g","workspace","$3","$4","$5")}
          FOR SHARE OF g,workspace`,[
        claims.tenantId,groupId,claims.userId,claims.groupIds,claims.groupAdmin,replyToMessageId,
      ])).rows[0];
      if(!route)throw new NotFoundException(replyToMessageId?"Quoted group message was not found":"Group workspace was not found");
      for(const attachment of attachments){
        const rule=providerOutboundMediaRule(route.provider,attachment.mimeType);
        if(!rule||attachment.byteSize>rule.maximumBytes)throw new BadRequestException("This attachment type or size is unavailable for this group");
      }
      if(mentions.length){
        if(route.provider!=="WAHA")throw new BadRequestException("Mentions are unavailable for this WhatsApp connection");
        const available=(await client.query<{external_participant_id:string;normalized_phone:string|null}>(`SELECT candidate.external_participant_id,
            max(candidate.normalized_phone) AS normalized_phone
          FROM (
            SELECT participant.external_participant_id,participant.normalized_phone
            FROM group_workspace_participants participant
            WHERE participant.tenant_id=$1 AND participant.whatsapp_group_id=$2
              AND participant.external_participant_id=ANY($3::text[])
            UNION ALL
            SELECT DISTINCT message.external_participant_id,NULL::text AS normalized_phone
            FROM normalized_messages message JOIN whatsapp_groups group_record ON group_record.tenant_id=message.tenant_id
              AND group_record.id=$2 AND group_record.connection_id=message.connection_id
              AND group_record.external_group_id=message.external_group_id
            JOIN group_workspace_settings workspace ON workspace.tenant_id=group_record.tenant_id
              AND workspace.whatsapp_group_id=group_record.id AND workspace.capture_enabled
            WHERE message.tenant_id=$1 AND message.history_captured_at IS NOT NULL AND NOT message.from_me
              AND message.provider_timestamp>=workspace.enabled_at
              AND ${GROUP_MESSAGE_NOT_REDACTED_ECHO_SQL}
              AND message.external_participant_id=ANY($3::text[])
          ) candidate GROUP BY candidate.external_participant_id`,[claims.tenantId,groupId,mentions])).rows;
        if(available.length!==mentions.length)throw new BadRequestException("Mentioned participants are unavailable in this group");
        if(available.some(participant=>!workspaceMentionAppears(message,participant.external_participant_id,participant.normalized_phone)))
          throw new BadRequestException("Mentioned participants must appear in the message");
      }
      const created=await queueOutboundParts(client,{tenantId:claims.tenantId,connectionId:route.connection_id,
        groupBindingId:null,workspaceGroupId:groupId,botConversationId:null,externalChatId:null,ticketId:null,articleId:null,
        body:message,contentType:"text/plain",replyToMessageId:route.external_message_id,idempotencyKey:key,requestSha256:fingerprint,
        agentDisplayName,agentPrefixSnapshot:route.agent_prefix,agentIdentityPlacementSnapshot:route.agent_identity_placement,
        deliveryOrigin:"GROUP_WORKSPACE",directOrigin:null,attachments,mentions});
      if(!prior)await recordGroupWorkspaceOperation(client,binding,fingerprint,created.id);
      if(!created.duplicate)await client.query(`INSERT INTO audit_events
          (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
          VALUES ($1,'ZAMMAD_USER',$2,'group_workspace.message_queued','whatsapp_group',$3,$4,$5)`,[
          claims.tenantId,claims.userId,groupId,{delivery_id:created.id,quoted_message:replyToMessageId!==null,attachment_count:attachments.length,mention_count:mentions.length},`zammad-group-send:${key}`,
        ]);
      const visible=message||!attachments.length||created.media_filename?created:await visibleGroupWorkspaceDelivery(client,claims.tenantId,created);
      return{...visible,duplicate:created.duplicate,sender_phone:route.phone_e164};
    });
    await this.drain.wake(claims.tenantId);
    return{...result,external_message_id:null,from_me:true,latest_mutation:null,quote_allowed:false,
      ticket_creatable:false,linked_to_ticket:false,source_kind:"DELIVERY",delivery_state:result.state,
      delivery_hold_reason:null,delivery_next_attempt_at:null,delivery_hold_expires_at:null};
  }

  @Post("groups/:groupId/messages/:messageId/reactions")
  async react(@Headers("authorization")authorization:string|undefined,@Headers("idempotency-key")idempotencyKey:string|undefined,
    @Param("groupId")groupId:string,@Param("messageId")messageId:string,@Body()body:Record<string,unknown>,
    @Req()request?:ZammadServiceRequest){
    const claims=await this.agent(authorization,request);assertUuid(groupId,"Group ID");assertUuid(messageId,"Message ID");
    const key=canonicalGroupWorkspaceSubmissionKey("REACTION",claims.userId!,boundedKey(idempotencyKey,"Idempotency key"));const removed=body.removed===undefined?false:requireBoolean(body.removed,"Reaction removal");const emoji=workspaceReaction(body.emoji,removed);
    const requestSha256=createHash("sha256").update(JSON.stringify({groupId,messageId,emoji,removed}),"utf8").digest("hex");
    const binding={claims,groupId,key,kind:"REACTION" as const,targetMessageId:messageId};
    const result=await this.database.withTenant(claims.tenantId,async client=>{
      await lockGroupWorkspaceOperation(client,binding);
      const prior=await readGroupWorkspaceOperation(client,binding);
      const replay=await replayGroupWorkspaceOperation(client,binding,prior,requestSha256);
      if(replay)return{id:replay.id,state:replay.state,duplicate:true};
      const target=(await client.query<{connection_id:string;external_message_id:string;provider:"WAHA"|"META"}>(`SELECT g.connection_id,
        message.external_message_id,connection.provider
        FROM normalized_messages message JOIN whatsapp_groups g ON g.tenant_id=message.tenant_id
          AND g.id=$2 AND g.connection_id=message.connection_id AND g.external_group_id=message.external_group_id
        JOIN connections connection ON connection.tenant_id=g.tenant_id AND connection.id=g.connection_id
        JOIN tenant_settings tenant ON tenant.tenant_id=g.tenant_id
        JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
        WHERE message.tenant_id=$1 AND message.id=$3 AND message.history_captured_at IS NOT NULL
          AND message.provider_timestamp>=workspace.enabled_at AND NOT (${GROUP_MESSAGE_REVOKED_SQL})
          AND ${GROUP_MESSAGE_NOT_REDACTED_ECHO_SQL}
          AND tenant.group_workspace_enabled AND workspace.capture_enabled AND connection.state='WORKING'
          AND EXISTS (SELECT 1 FROM provider_sessions session WHERE session.tenant_id=g.tenant_id
            AND session.connection_id=g.connection_id AND session.ownership_state='ACTIVE' AND session.state='WORKING')
          AND ${groupWorkspaceAccessSql("g","workspace","$4","$5","$6")}
        FOR SHARE OF message,g,workspace`,[
        claims.tenantId,groupId,messageId,claims.userId,claims.groupIds,claims.groupAdmin,
      ])).rows[0];
      if(!target)throw new NotFoundException("Group message was not found");
      if(target.provider!=="WAHA")throw new BadRequestException("Reactions are unavailable for this WhatsApp connection");
      const created=await queueOutboundParts(client,{tenantId:claims.tenantId,connectionId:target.connection_id,
        groupBindingId:null,workspaceGroupId:groupId,botConversationId:null,externalChatId:null,ticketId:null,articleId:null,
        body:emoji,contentType:GROUP_REACTION_CONTENT_TYPE,replyToMessageId:target.external_message_id,
        idempotencyKey:key,requestSha256,agentDisplayName:null,agentPrefixSnapshot:"Agent:",agentIdentityPlacementSnapshot:"OFF",
        deliveryOrigin:"GROUP_WORKSPACE",directOrigin:null,attachments:[],mentions:[]});
      if(!prior)await recordGroupWorkspaceOperation(client,binding,requestSha256,created.id);
      if(!created.duplicate)await client.query(`INSERT INTO audit_events
          (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
          VALUES ($1,'ZAMMAD_USER',$2,$3,'normalized_message',$4,$5,$6)`,[
        claims.tenantId,claims.userId,removed?"group_workspace.reaction_removal_queued":"group_workspace.reaction_queued",messageId,{delivery_id:created.id,group_id:groupId},`zammad-group-reaction:${key}`,
      ]);
      return{id:created.id,state:created.state,duplicate:created.duplicate};
    });
    await this.drain.wake(claims.tenantId);return result;
  }

  @Post("groups/:groupId/operation-receipt")
  async operationReceipt(@Headers("authorization")authorization:string|undefined,@Param("groupId")groupId:string,
    @Body()body:Record<string,unknown>,@Req()request?:ZammadServiceRequest){
    const claims=await this.agent(authorization,request);assertUuid(groupId,"Group ID");
    if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(key=>!["kind","requestId","targetMessageId","action"].includes(key)))throw new BadRequestException("Receipt request is invalid");
    if(body.kind!=="SEND"&&body.kind!=="REACTION")throw new BadRequestException("Operation kind is invalid");
    if(body.action!=="LOOKUP"&&body.action!=="CANCEL_IF_UNADMITTED")throw new BadRequestException("Receipt action is invalid");
    if(typeof body.requestId!=="string")throw new BadRequestException("Request ID is invalid");assertUuid(body.requestId,"Request ID");
    const targetMessageId=body.kind==="REACTION"?String(body.targetMessageId??""):null;
    if(targetMessageId!==null)assertUuid(targetMessageId,"Target message ID");
    else if(body.targetMessageId!==undefined&&body.targetMessageId!==null)throw new BadRequestException("Send target is invalid");
    const binding:GroupWorkspaceOperationBinding={claims,groupId,kind:body.kind,key:groupWorkspaceOperationKey(body.kind,claims.userId!,body.requestId),targetMessageId};
    return this.database.withTenant(claims.tenantId,async client=>{
      await lockGroupWorkspaceOperation(client,binding);
      const receipt=await readGroupWorkspaceOperation(client,binding);
      if(receipt?.disposition==="ADMITTED")return{outcome:"ADMITTED",terminal:true,deliveryId:receipt.delivery_id,state:receipt.state??"UNKNOWN"};
      if(receipt?.disposition==="CANCELLED")return{outcome:"NOT_APPLIED",terminal:true};
      if(receipt?.disposition==="UNKNOWN"||body.action==="LOOKUP")return{outcome:"UNKNOWN",terminal:false};
      await recordGroupWorkspaceOperation(client,binding,null,null);
      return{outcome:"NOT_APPLIED",terminal:true};
    });
  }

  private async assertAccess(claims:ZammadClaims,groupId:string){
    const rows=await this.database.rows<{allowed:boolean}>(claims.tenantId,`SELECT EXISTS (
      SELECT 1 FROM whatsapp_groups g JOIN tenant_settings tenant ON tenant.tenant_id=g.tenant_id
      JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
      WHERE g.tenant_id=$1 AND g.id=$2 AND tenant.group_workspace_enabled AND workspace.capture_enabled
        AND ${groupWorkspaceAccessSql("g","workspace","$3","$4","$5")}
      ) AS allowed`,[claims.tenantId,groupId,claims.userId,claims.groupIds,claims.groupAdmin]);
    if(!rows[0]?.allowed)throw new NotFoundException("Group workspace was not found");
  }
}

function assertUuid(value:string,label:string){if(!UUID.test(value))throw new BadRequestException(`${label} is invalid`)}
function projectGroupMessages(rows:Record<string,unknown>[]){return rows.map(row=>{
  if(row.latest_mutation==="REVOKED")return{...row,media_filename:null,media_mime_type:null,media_kind:null,media_available:false};
  const rawFilename=typeof row.media_filename==="string"?row.media_filename.trim():"";
  const filename=rawFilename?safeMediaFilename(rawFilename):null;
  const normalizedMime=typeof row.media_mime_type==="string"?normalizeMediaMime(row.media_mime_type):"";
  const mimeType=normalizedMime.length<=127&&MIME_TYPE.test(normalizedMime)?normalizedMime:null;
  const rawKind=typeof row.media_kind==="string"?row.media_kind.toLowerCase():"";
  const mediaKind=rawKind==="image"||rawKind==="video"||rawKind==="audio"||rawKind==="document"?rawKind
    :mimeType?.startsWith("image/")?"image":mimeType?.startsWith("video/")?"video":mimeType?.startsWith("audio/")?"audio"
      :(filename||mimeType)?"document":null;
  return{...row,media_filename:filename,media_mime_type:mimeType,media_kind:mediaKind,
    media_available:Boolean(mediaKind&&row.media_available===true)};
})}
function positiveId(value:unknown,label:string){const text=String(value??"");if(!POSITIVE_ID.test(text))throw new BadRequestException(`${label} is invalid`);return text}
function apiVersion(value:unknown){
  const normalized=typeof value==="bigint"?Number(value):typeof value==="string"&&/^(0|[1-9][0-9]*)$/u.test(value)?Number(value):value;
  if(!Number.isSafeInteger(normalized)||Number(normalized)<0)throw new InternalServerErrorException("Group history version is invalid");
  return Number(normalized);
}
function workspaceAgentPrefix(value:unknown){if(typeof value!=="string")throw new BadRequestException("agentPrefix is invalid");const text=value.normalize("NFC").replace(/\s+/gu," ").trim();if([...text].length<1||[...text].length>80||[...text].some(isControl))throw new BadRequestException("agentPrefix is invalid");return text}
function requireBoolean(value:unknown,label:string){if(typeof value!=="boolean")throw new BadRequestException(`${label} is required`);return value}
function integer(value:unknown,minimum:number,maximum:number,label:string){const parsed=typeof value==="string"&&/^\d+$/u.test(value)?Number(value):value;if(!Number.isSafeInteger(parsed)||Number(parsed)<minimum||Number(parsed)>maximum)throw new BadRequestException(`${label} is invalid`);return Number(parsed)}
function oneOf(value:unknown,values:Set<string>,label:string){const text=String(value??"").toUpperCase();if(!values.has(text))throw new BadRequestException(`${label} is invalid`);return text}
function boundedKey(value:unknown,label:string){const text=String(value??"");if(!/^[A-Za-z0-9:_-]{8,255}$/u.test(text))throw new BadRequestException(`${label} is invalid`);return text}
function operationHash(value:Record<string,unknown>){return createHash("sha256").update(JSON.stringify(value),"utf8").digest("hex")}
function outboundMessage(value:unknown,attachmentPresent=false){if(value===undefined||value===null)value="";if(typeof value!=="string")throw new BadRequestException("Message is required");const text=value.replace(/\r\n?/gu,"\n").trim();if((!text&&!attachmentPresent)||[...text].length>4096||[...text].some(character=>isControl(character)&&character!=="\t"&&character!=="\n"))throw new BadRequestException("Message is invalid");return text}
function participantSearch(value:unknown){const text=String(value??"").normalize("NFC").trim();if([...text].length>80||[...text].some(isControl))throw new BadRequestException("Participant search is invalid");return text}
function workspaceMentions(value:unknown){if(value===undefined)return[];if(!Array.isArray(value)||value.length>20)throw new BadRequestException("Mentions are invalid");const mentions=value.map(item=>String(item));if(new Set(mentions).size!==mentions.length||mentions.some(item=>!WAHA_MENTION.test(item)))throw new BadRequestException("Mentions are invalid");return mentions}
function workspaceReaction(value:unknown,removed=false){if(removed){if(value!==undefined&&value!==null&&value!=="")throw new BadRequestException("Reaction removal is invalid");return""}const emoji=String(value??"").normalize("NFC");if(!GROUP_REACTIONS.has(emoji))throw new BadRequestException("Reaction is invalid");return emoji}
function workspaceMentionAppears(message:string,mention:string,normalizedPhone:string|null){const identifier=normalizedPhone?.match(/^\+[1-9][0-9]{5,19}$/u)?normalizedPhone.slice(1):mention.slice(0,mention.indexOf("@"));return new RegExp(`(^|[^0-9])@${identifier}(?![0-9])`,"u").test(message)}
function cleanDisplayName(value:unknown){const text=[...String(value??"").normalize("NFC")].map(character=>isControl(character)?" ":character).join("").replace(/\s+/gu," ").trim();if([...text].length<1||[...text].length>160)throw new BadRequestException("Agent display name is invalid");return text}
function isControl(character:string){const code=character.codePointAt(0)??0;return code<32||code===127}
function workspaceAttachments(value:unknown):Extract<QueuedOutboundAttachment,{source:"WORKSPACE"}>[]{
  if(value===undefined)return[];if(!Array.isArray(value)||value.length>GROUP_WORKSPACE_MAX_ATTACHMENTS)throw new BadRequestException("Attachments are invalid");
  const result=value.map((item):Extract<QueuedOutboundAttachment,{source:"WORKSPACE"}>=>{if(!item||typeof item!=="object"||Array.isArray(item))throw new BadRequestException("Attachment is invalid");const record=item as Record<string,unknown>;
    const uploadId=String(record.uploadId??record.upload_id??"");assertUuid(uploadId,"Upload ID");const storeId=Number(positiveId(record.storeId??record.store_id,"Upload item ID"));
    const uploadCacheId=String(record.uploadCacheId??record.upload_cache_id??uploadId);assertUuid(uploadCacheId,"Upload cache ID");
    const sourceStoreId=Number(positiveId(record.sourceStoreId??record.source_store_id??storeId,"Upload source item ID"));
    const filename=String(record.filename??"").normalize("NFC").trim();if(!filename||[...filename].length>120||[...filename].some(isControl)||filename.includes("/")||filename.includes("\\")||filename.includes(".."))throw new BadRequestException("Attachment filename is invalid");
    const mimeType=String(record.mimeType??"").trim().toLowerCase().split(";",1)[0]??"";if(!MIME_TYPE.test(mimeType)||mimeType.length>127)throw new BadRequestException("Attachment content type is invalid");
    const byteSize=Number(positiveId(record.byteSize,"Attachment size"));if(byteSize>100_000_000)throw new BadRequestException("Attachment is too large");
    return{source:"WORKSPACE",uploadId,storeId,uploadCacheId,sourceStoreId,filename,mimeType,byteSize};});
  if(new Set(result.map(item=>`${item.uploadCacheId}:${item.sourceStoreId}`)).size!==result.length)throw new BadRequestException("Attachment items must be unique");
  if(result.reduce((sum,item)=>sum+item.byteSize,0)>GROUP_WORKSPACE_MAX_TOTAL_BYTES)throw new BadRequestException("Total attachment size is too large");
  return result;
}
