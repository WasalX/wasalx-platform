import {assertMetaDirectEffectCurrent} from '@wasalx/core/meta-direct-identity';
import {directControlDeliveryAllowed,directHumanDeliveryAllowed} from '@wasalx/core/direct-delivery-guards';
import { createHash } from "node:crypto";
import {reserveDirectNativeReply,admitDirectReplyIntent,completeDirectReplyIntent,reconcileAbsentDirectReplyIntent} from "./direct-native-operations.js";
import type { PoolClient } from "pg";
import { BadRequestException, Body, ConflictException, Controller, Get, Headers, NotFoundException, Param, Post, Query, Req, SetMetadata, UnauthorizedException } from "@nestjs/common";
import { clientRoutingApplies, normalizeRoutingEmail, parseClientRouting, resolveClientRoute, type ClientRoute, type ClientRoutingDefinition } from "@wasalx/core/client-routing";
import { PUBLIC_ROUTE } from "./auth.guard.js";
import { DatabaseService } from "./database.service.js";
import { ServiceAuthService, type ZammadClaims, type ZammadServiceRequest } from "./service-auth.service.js";
import { TenantDrainService } from "./tenant-drain.service.js";
import { groupBindingReplyAccessSql, groupWorkspaceAccessSql } from "./group-workspace-access.js";
import { prepareTicketReply } from "./ticket-reply-target.js";
import { directMessageCapabilities } from "@wasalx/core/bot-flow";
import { renderOutboundText } from "@wasalx/core/outbound-text";
import { completeTicketEventExecution, type TicketEventReceipt } from "@wasalx/core/ticket-event-runtime";
import { recordStructuredLog } from "@wasalx/observability";

import {directCustomerCloseAdmission} from '@wasalx/core/direct-customer-close';
import {ticketCommandAdmission,assertTicketCommandBarrier,lockTicketCommand} from '@wasalx/core/ticket-command-guards';

type OutboundAttachment={id?:string|number;filename?:string;content_type?:string;size?:string|number};
type OutboundBody={native_reply_intent_id?:string;tenant_id?:string;connection_id?:string;group_id?:string;ticket_id?:string|number;article_id?:string|number;body?:string;content_type?:string;reply_to_message_id?:string;reply_to_article_id?:string|number;idempotency_key?:string;internal?:boolean;agent?:{id?:string|number;display_name?:string};attachments?:OutboundAttachment[]};
type ValidAttachment={id:number;filename:string;mimeType:string;byteSize:number};
export type QueuedOutboundAttachment=
  |{source:"ARTICLE";id:number;filename:string;mimeType:string;byteSize:number}
  |{source:"WORKSPACE";uploadId:string;storeId:number;uploadCacheId:string;sourceStoreId:number;filename:string;mimeType:string;byteSize:number};
export type QueueOutboundInput={tenantId:string;connectionId:string;groupBindingId:string|null;workspaceGroupId:string|null;
  botConversationId:string|null;externalChatId:string|null;ticketId:string|null;articleId:string|null;body:string;contentType:string;
  replyToMessageId:string|null;idempotencyKey:string;requestSha256:string;agentDisplayName:string|null;agentPrefixSnapshot:string|null;
  agentIdentityPlacementSnapshot:"HEADER"|"FOOTER"|"OFF"|null;
  deliveryOrigin:"TICKET"|"GROUP_WORKSPACE";directOrigin:"HUMAN"|null;attachments:QueuedOutboundAttachment[];mentions:string[];
  quoteGroupId?:string;replyToArticleId?:string;directOwnershipEpoch?:number;metaRoutingEpoch?:number;metaRoutingSourceEventId?:string};
type RetryBody={tenant_id?:string;instance_id?:string;ticket_id?:string|number;article_id?:string|number;delivery_id?:string;actor_id?:string|number;idempotency_key?:string;confirm_outcome_unknown?:boolean};
type EmailRoutingBody={tenant_id?:string;instance_id?:string;ticket_id?:string|number;article_id?:string|number;ticket_number?:string;sender_email?:string;admitted_at?:string;entry_group_id?:string|number};
type EmailRoutingAcknowledgementBody={tenant_id?:string;instance_id?:string;route_id?:string;ticket_id?:string|number;article_id?:string|number;idempotency_key?:string;application_status?:string;observed_group_id?:string|number;observed_owner_id?:string|number|null};
type EmailRouteRow={id:string;zammad_instance_id:string|null;source_article_id:string|null;request_sha256:string|null;client_routing_version_id:string|null;client_route_status:"MATCHED"|"FALLBACK"|"UNCONFIGURED";client_id:string|null;client_route_matched_by:"EMAIL"|"DOMAIN"|"CLIENT_IDENTIFIER"|"FALLBACK"|null;definition:unknown|null};
type EmailRouteApplicationRow={route_id:string;idempotency_key:string;request_sha256:string;application_status:"APPLIED"|"MANUAL_OVERRIDE";observed_group_id:string;observed_owner_id:string|null};
type TicketContextRow={ticket_id:string;connection_id:string;provider:"WAHA"|"META";connection_state:string;binding_state:string;group_name:string;correlation_state:string;bot_state?:string|null;last_customer_message_at?:string|Date|null;last_heartbeat_at:string|Date|null;last_provider_event_at:string|Date|null;delivery_id:string|null;zammad_article_id:string|null;delivery_state:string|null;delivery_updated_at:string|Date|null;manual_retry_allowed:boolean|null};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_CONTEXT_STATES=new Set(["WAHA","META"]);
const CONNECTION_CONTEXT_STATES=new Set(["PROVISIONING","AWAITING_AUTH","CONNECTING","WORKING","DEGRADED","ACTION_REQUIRED","FAILED","PAUSED","REVOKED"]);
const BINDING_CONTEXT_STATES=new Set(["DRAFT","ACTIVE","PAUSED"]);
const CORRELATION_CONTEXT_STATES=new Set(["OPEN","RESOLVED","DETACHED"]);
const DELIVERY_CONTEXT_STATES=new Set(["QUEUED","CLAIMED","SENDING","SENT","DELIVERED","READ","FAILED_RETRYABLE","FAILED_TERMINAL","OUTCOME_UNKNOWN","BLOCKED"]);
@Controller("internal/v1/zammad")
@SetMetadata(PUBLIC_ROUTE,true)
export class ZammadInternalController{
  constructor(private readonly database:DatabaseService,private readonly auth:ServiceAuthService,private readonly drain:TenantDrainService){}
  private async claims(authorization:string|undefined,scope:string,request?:ZammadServiceRequest){const claims=await this.auth.verify(authorization,scope,request);const rows=await this.database.rows<{id:string}>(claims.tenantId,"SELECT id FROM zammad_instances WHERE tenant_id=$1 AND id=$2 AND state='WORKING'",[claims.tenantId,claims.instanceId]);if(!rows[0])throw new UnauthorizedException("Zammad instance is not active");return claims}
  @Get("health")async health(@Headers("authorization")authorization:string|undefined,@Req()request?:ZammadServiceRequest){const claims=await this.claims(authorization,"zammad:health",request);return{ok:true,tenant_id:claims.tenantId,instance_id:claims.instanceId,time:new Date().toISOString()}}
  @Post("privacy/admission")
  async privacyAdmission(@Headers("authorization")authorization:string|undefined,@Body()body:{job_id?:string;lease_id?:string;fencing_token?:number;target_id?:string;operation?:string;native_id?:string;attempt?:number},@Req()request?:ZammadServiceRequest){
    const claims=await this.claims(authorization,"zammad:privacy",request);
    const operations=["DELETE_TICKET","READ_TICKET","READ_ARTICLES","CREATE_USER_TASK","READ_USER_TASK"];
    if(!body.job_id||!UUID.test(body.job_id)||!body.lease_id||!UUID.test(body.lease_id)||(body.target_id!==undefined&&!UUID.test(body.target_id))||(!body.target_id&&!["READ_TICKET","READ_ARTICLES"].includes(body.operation??""))||
      !Number.isSafeInteger(body.fencing_token)||Number(body.fencing_token)<1||!Number.isSafeInteger(body.attempt)||Number(body.attempt)<0||
      !body.operation||!operations.includes(body.operation)||typeof body.native_id!=="string"||!body.native_id||!/^[1-9][0-9]{0,18}$/u.test(body.native_id)||
      Object.keys(body).some(key=>!["job_id","lease_id","fencing_token","target_id","operation","native_id","attempt"].includes(key)))throw new BadRequestException("Privacy admission is invalid");
    const targetType=["CREATE_USER_TASK","READ_USER_TASK"].includes(body.operation)?"ZAMMAD_USER":"ZAMMAD_TICKET";
    return this.database.withTenant(claims.tenantId,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`privacy:${claims.tenantId}`]);
      const row=(await client.query<{job_type:string;stage:string;disposition:string;target_type:string;target_id:string;state:string;attempts:number;external_operation_id:string|null;external_started_at:Date|null;held:boolean;id:string}>(`SELECT target.id,job.job_type,job.stage,job.disposition,target.target_type,target.target_id,target.state,target.attempts,target.external_operation_id,target.external_started_at,
        (app.has_applicable_privacy_hold(job.scope_type,job.scope_value) OR app.has_applicable_privacy_hold(target.target_type,target.target_id)) AS held
        FROM privacy_jobs job JOIN privacy_job_targets target ON target.tenant_id=job.tenant_id AND target.job_id=job.id
        JOIN tenants tenant ON tenant.id=job.tenant_id AND tenant.state='ACTIVE'
        WHERE job.tenant_id=$1 AND job.id=$2 AND job.state='RUNNING' AND job.lease_id=$3 AND job.fencing_token=$4
          AND job.lease_expires_at>=clock_timestamp() AND ($5::uuid IS NULL OR target.id=$5) AND ($5::uuid IS NOT NULL OR target.target_id=$6) AND target.target_type=$7
        FOR SHARE OF job,target`,[claims.tenantId,body.job_id,body.lease_id,body.fencing_token,body.target_id??null,body.native_id,targetType])).rows[0];
      let allowed=!!row&&row.state==="PENDING"&&Number(row.attempts)===body.attempt;
      if(row&&allowed){
        if(body.operation==="READ_TICKET"||body.operation==="READ_ARTICLES")allowed=row.job_type==="EXPORT"&&row.stage==="EXPORT"&&row.disposition==="EXPORT_ONLY"&&row.target_type==="ZAMMAD_TICKET"&&row.target_id===body.native_id;
        else if(body.operation==="DELETE_TICKET")allowed=["DELETE","RETENTION_SWEEP"].includes(row.job_type)&&row.stage==="EXTERNAL"&&["DELETE_TICKETS","RETENTION_DELETE"].includes(row.disposition)&&row.target_type==="ZAMMAD_TICKET"&&row.target_id===body.native_id&&!row.held&&!!row.external_started_at&&body.attempt!>0;
        else if(body.operation==="CREATE_USER_TASK")allowed=row.job_type==="DELETE"&&row.stage==="EXTERNAL"&&row.disposition==="ZAMMAD_USER_DATA_PRIVACY"&&row.target_type==="ZAMMAD_USER"&&row.target_id===body.native_id&&!row.held&&row.external_operation_id===null&&!!row.external_started_at&&body.attempt===1;
        else allowed=row.job_type==="DELETE"&&row.stage==="EXTERNAL"&&row.disposition==="ZAMMAD_USER_DATA_PRIVACY"&&row.target_type==="ZAMMAD_USER"&&row.external_operation_id===body.native_id&&!!row.external_started_at;
      }
      return{allowed,tenant_id:claims.tenantId,instance_id:claims.instanceId,job_id:body.job_id,target_id:row?.id??null,operation:body.operation,native_id:body.native_id,source_native_id:allowed?row!.target_id:null};
    });
  }
  @Post("routing")async emailRouting(@Headers("authorization")authorization:string|undefined,@Body()body:EmailRoutingBody,@Req()request?:ZammadServiceRequest){
    const claims=await this.claims(authorization,"zammad:routing",request);const input=validateEmailRouting(body,claims);
    const requestSha256=emailRoutingRequestSha256(claims,input);
    return this.database.withTenant(claims.tenantId,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`client-routing:${claims.tenantId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`zammad-email-route:${claims.tenantId}:${input.ticketId}`]);
      let route=(await client.query<EmailRouteRow>(`SELECT pinned.id,pinned.zammad_instance_id,pinned.source_article_id,pinned.request_sha256,
          pinned.client_routing_version_id,pinned.client_route_status,pinned.client_id,pinned.client_route_matched_by,version.definition
        FROM zammad_email_routes pinned
        LEFT JOIN client_routing_versions version
          ON version.tenant_id=pinned.tenant_id AND version.id=pinned.client_routing_version_id
        WHERE pinned.tenant_id=$1 AND pinned.zammad_ticket_id=$2`,[claims.tenantId,input.ticketId])).rows[0];
      let duplicate=true;
      if(route){
        if(route.zammad_instance_id!==claims.instanceId||route.source_article_id!==input.articleId||route.request_sha256!==requestSha256){
          throw new ConflictException("The ticket route is already pinned to different native-email provenance");
        }
      }else{
        duplicate=false;
        const version=(await client.query<{id:string;definition:unknown}>(`SELECT id,definition FROM client_routing_versions
          WHERE tenant_id=$1 AND state IN ('ACTIVE','RETIRED')
            AND activated_at<=$2::timestamptz AND (retired_at IS NULL OR retired_at>$2::timestamptz)
          ORDER BY activated_at DESC,version DESC LIMIT 1`,[claims.tenantId,input.admittedAt])).rows[0];
        if(!version||!clientRoutingApplies(parseClientRouting(version.definition),input.entryGroupId)){
          route=(await client.query<EmailRouteRow>(`INSERT INTO zammad_email_routes
            (tenant_id,zammad_ticket_id,zammad_instance_id,source_article_id,request_sha256,client_route_status)
            VALUES ($1,$2,$3,$4,$5,'UNCONFIGURED')
            RETURNING id,zammad_instance_id,source_article_id,request_sha256,
              client_routing_version_id,client_route_status,client_id,client_route_matched_by,NULL::jsonb AS definition`,
            [claims.tenantId,input.ticketId,claims.instanceId,input.articleId,requestSha256])).rows[0]!;
        }else{
          const definition=parseClientRouting(version.definition);const resolved=resolveClientRoute(definition,{email:input.senderEmail});
          if(resolved.status==="CONFLICT")throw new Error("Active client routing contains an ambiguous email route");
          route=(await client.query<EmailRouteRow>(`INSERT INTO zammad_email_routes
            (tenant_id,zammad_ticket_id,zammad_instance_id,source_article_id,request_sha256,
             client_routing_version_id,client_route_status,client_id,client_route_matched_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            RETURNING id,zammad_instance_id,source_article_id,request_sha256,
              client_routing_version_id,client_route_status,client_id,client_route_matched_by,$10::jsonb AS definition`,[
            claims.tenantId,input.ticketId,claims.instanceId,input.articleId,requestSha256,
            version.id,resolved.status,resolved.client?.id??null,resolved.matchedBy,JSON.stringify(definition),
          ])).rows[0]!;
        }
        await client.query(`INSERT INTO audit_events
          (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
          VALUES ($1,'SERVICE',$2,'zammad_email.route_pinned','zammad_ticket',$3,$4,$5)`,[
          claims.tenantId,claims.instanceId,input.ticketId,{route_id:route.id,source_article_id:input.articleId,admitted_at:input.admittedAt,routing_version_id:route.client_routing_version_id,status:route.client_route_status,client_id:route.client_id,matched_by:route.client_route_matched_by},zammadRequestId(request,claims.instanceId,input.ticketId),
        ]);
      }
      return emailRoutingResult(input.ticketId,route,duplicate);
    });
  }
  @Post("routing/acknowledgement")async emailRoutingAcknowledgement(@Headers("authorization")authorization:string|undefined,@Body()body:EmailRoutingAcknowledgementBody,@Req()request?:ZammadServiceRequest){
    const claims=await this.claims(authorization,"zammad:routing",request);const input=validateEmailRoutingAcknowledgement(body,claims);
    const requestSha256=emailRoutingAcknowledgementSha256(claims,input);
    return this.database.withTenant(claims.tenantId,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`zammad-email-route-ack:${claims.tenantId}:${input.routeId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`zammad-email-route-ack-key:${claims.tenantId}:${input.idempotencyKey}`]);
      const route=(await client.query<{id:string}>(`SELECT id FROM zammad_email_routes
        WHERE tenant_id=$1 AND id=$2 AND zammad_instance_id=$3
          AND zammad_ticket_id=$4 AND source_article_id=$5`,
        [claims.tenantId,input.routeId,claims.instanceId,input.ticketId,input.articleId])).rows[0];
      if(!route)throw new NotFoundException("The native-email route was not found");
      const existing=(await client.query<EmailRouteApplicationRow>(`SELECT route_id,idempotency_key,request_sha256,
          application_status,observed_group_id,observed_owner_id
        FROM zammad_email_route_applications
        WHERE tenant_id=$1 AND (route_id=$2 OR idempotency_key=$3)
        ORDER BY (route_id=$2) DESC LIMIT 1`,[claims.tenantId,input.routeId,input.idempotencyKey])).rows[0];
      if(existing){
        if(existing.route_id!==input.routeId||existing.idempotency_key!==input.idempotencyKey||existing.request_sha256!==requestSha256){
          throw new ConflictException("The routing acknowledgement conflicts with an existing receipt");
        }
        return emailRoutingAcknowledgementResult(existing,true);
      }
      const requestId=zammadRequestId(request,claims.instanceId,input.ticketId);
      const receipt=(await client.query<EmailRouteApplicationRow>(`INSERT INTO zammad_email_route_applications
        (tenant_id,route_id,zammad_instance_id,idempotency_key,request_sha256,application_status,
         observed_group_id,observed_owner_id,request_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING route_id,idempotency_key,request_sha256,application_status,observed_group_id,observed_owner_id`,[
        claims.tenantId,input.routeId,claims.instanceId,input.idempotencyKey,requestSha256,input.applicationStatus,
        input.observedGroupId,input.observedOwnerId,requestId,
      ])).rows[0]!;
      await client.query(`INSERT INTO audit_events
        (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
        VALUES ($1,'SERVICE',$2,$3,'zammad_email_route',$4,$5,$6)`,[
        claims.tenantId,claims.instanceId,
        input.applicationStatus==="APPLIED"?'zammad_email.route_applied':'zammad_email.route_manually_overridden',
        input.routeId,{ticket_id:input.ticketId,source_article_id:input.articleId,observed_group_id:input.observedGroupId,observed_owner_id:input.observedOwnerId},requestId,
      ]);
      return emailRoutingAcknowledgementResult(receipt,false);
    });
  }
  @Post("tickets/:ticketId/read-signal")
  async readSignal(@Headers("authorization") authorization: string | undefined,
    @Param("ticketId") ticketIdValue: string,
    @Body() body: { connection_id?: string; group_id?: string; customer_id?: string; opened_at?: number },
    @Req() request: ZammadServiceRequest) {
    const claims = await this.claims(authorization, "zammad:ticket-read", request);
    const groupId = String(positiveIdentifier(body?.group_id, "Native group ID"));
    if (!claims.userId || !claims.groupIds.includes(groupId)) throw new UnauthorizedException("Native agent ticket access is required");
    const ticketId = String(positiveIdentifier(ticketIdValue, "Ticket ID"));
    const customerId = String(positiveIdentifier(body.customer_id, "Customer ID"));
    const { connection_id: connectionId, opened_at: openedAt } = body;
    const now = Date.now();
    if (typeof connectionId !== "string" || !UUID.test(connectionId) || typeof openedAt !== "number" ||
        !Number.isSafeInteger(openedAt) || openedAt < now - 120_000 || openedAt > now + 5_000) {
      throw new BadRequestException("Direct ticket read context is invalid or expired");
    }
    const target = await this.database.rows<{ id: string }>(claims.tenantId, `SELECT id FROM bot_conversations
      WHERE tenant_id=$1 AND connection_id=$2 AND zammad_ticket_id=$3 AND zammad_customer_id=$4 LIMIT 1`,
    [claims.tenantId, connectionId, ticketId, customerId]);
    if (!target[0]) throw new NotFoundException("Direct ticket was not found");
    await this.drain.wakeDirectTicketRead(claims.tenantId, {
      instanceId: claims.instanceId, actorId: claims.userId, ticketId, connectionId, customerId, openedAt,
    });
    return { queued: true };
  }

  @Get("tickets/:ticketId/context")async ticketContext(@Headers("authorization")authorization:string|undefined,@Param("ticketId")ticketIdValue:string,@Req()request?:ZammadServiceRequest){
    const claims=await this.claims(authorization,"zammad:context",request);
    const ticketId=String(positiveIdentifier(ticketIdValue,"Ticket ID"));
    const context=await this.database.withTenant(claims.tenantId,async client=>{
      const group=(await client.query<TicketContextRow>(`WITH selected_correlation AS (
        SELECT correlation.group_binding_id,correlation.zammad_ticket_id,correlation.state,
               correlation.generation
          FROM case_correlations correlation
         WHERE correlation.tenant_id=$1 AND correlation.zammad_ticket_id=$2
         ORDER BY (correlation.state<>'DETACHED') DESC,correlation.generation DESC
         LIMIT 1
      )
      SELECT correlation.zammad_ticket_id AS ticket_id,connection.id AS connection_id,
             connection.provider,connection.state AS connection_state,binding.state AS binding_state,
             COALESCE(group_record.wasalx_name,group_record.display_name) AS group_name,
             correlation.state AS correlation_state,
             connection.last_heartbeat_at,connection.last_provider_event_at,
             latest_delivery.id AS delivery_id,latest_delivery.zammad_article_id,
             latest_delivery.state AS delivery_state,latest_delivery.updated_at AS delivery_updated_at,
             latest_delivery.manual_retry_allowed
        FROM selected_correlation correlation
        JOIN group_bindings binding
          ON binding.tenant_id=$1 AND binding.id=correlation.group_binding_id
        JOIN whatsapp_groups group_record
          ON group_record.tenant_id=$1 AND group_record.id=binding.whatsapp_group_id
        JOIN connections connection
          ON connection.tenant_id=$1 AND connection.id=group_record.connection_id
        LEFT JOIN LATERAL (
          SELECT delivery.id,delivery.zammad_article_id,delivery.state,delivery.updated_at,
                 delivery.manual_retry_allowed
            FROM delivery_outbox delivery
           WHERE delivery.tenant_id=$1 AND delivery.zammad_ticket_id=$2
             AND delivery.zammad_article_id ~ '^[1-9][0-9]*$'
             AND delivery.content_redacted_at IS NULL
           ORDER BY delivery.updated_at DESC,delivery.id DESC
           LIMIT 1
        ) latest_delivery ON true`,[claims.tenantId,ticketId])).rows[0];
      if(group)return group;
      const workspace=(await client.query<TicketContextRow>(`SELECT link.zammad_ticket_id AS ticket_id,
             connection.id AS connection_id,connection.provider,connection.state AS connection_state,
             'ACTIVE'::text AS binding_state,COALESCE(group_record.wasalx_name,group_record.display_name) AS group_name,
             'OPEN'::text AS correlation_state,connection.last_heartbeat_at,connection.last_provider_event_at,
             latest_delivery.id AS delivery_id,latest_delivery.zammad_article_id,
             latest_delivery.state AS delivery_state,latest_delivery.updated_at AS delivery_updated_at,
             latest_delivery.manual_retry_allowed
        FROM message_links link
        JOIN normalized_messages message ON message.tenant_id=link.tenant_id
          AND message.connection_id=link.connection_id AND message.external_message_id=link.external_message_id
          AND message.history_captured_at IS NOT NULL
        JOIN whatsapp_groups group_record ON group_record.tenant_id=message.tenant_id
          AND group_record.connection_id=message.connection_id AND group_record.external_group_id=message.external_group_id
        JOIN tenant_settings tenant ON tenant.tenant_id=group_record.tenant_id
        JOIN group_workspace_settings workspace ON workspace.tenant_id=group_record.tenant_id
          AND workspace.whatsapp_group_id=group_record.id
        JOIN connections connection ON connection.tenant_id=group_record.tenant_id AND connection.id=group_record.connection_id
        LEFT JOIN LATERAL (
          SELECT delivery.id,delivery.zammad_article_id,delivery.state,delivery.updated_at,delivery.manual_retry_allowed
            FROM delivery_outbox delivery
           WHERE delivery.tenant_id=$1 AND delivery.zammad_ticket_id=$2
             AND delivery.zammad_article_id ~ '^[1-9][0-9]*$'
             AND delivery.content_redacted_at IS NULL
           ORDER BY delivery.updated_at DESC,delivery.id DESC LIMIT 1
        ) latest_delivery ON true
       WHERE link.tenant_id=$1 AND link.zammad_ticket_id=$2
         AND tenant.group_workspace_enabled AND workspace.capture_enabled
       ORDER BY link.created_at DESC,link.id DESC LIMIT 1`,[claims.tenantId,ticketId])).rows[0];
      if(workspace)return workspace;
      return(await client.query<TicketContextRow>(`SELECT conversation.zammad_ticket_id AS ticket_id,
             connection.id AS connection_id,connection.provider,connection.state AS connection_state,
             'ACTIVE'::text AS binding_state,'Private WhatsApp conversation'::text AS group_name,
             CASE WHEN conversation.state='RESOLVED' THEN 'RESOLVED' ELSE 'OPEN' END AS correlation_state,
             conversation.state AS bot_state,
             GREATEST(
               (SELECT message.provider_timestamp
                  FROM normalized_messages message
                 WHERE message.tenant_id=conversation.tenant_id AND message.connection_id=conversation.connection_id
                   AND message.external_group_id=conversation.external_chat_id
                   AND NOT message.from_me AND message.provider_metadata @> '{"direct":true}'
                 ORDER BY message.provider_timestamp DESC LIMIT 1),
               (SELECT ownership.last_customer_message_at
                  FROM meta_thread_ownership ownership
                  JOIN participant_identities participant ON participant.tenant_id=ownership.tenant_id
                    AND participant.connection_id=ownership.connection_id AND participant.id=ownership.participant_identity_id
                  JOIN provider_sessions session ON session.tenant_id=ownership.tenant_id
                    AND session.connection_id=ownership.connection_id AND session.id=ownership.provider_session_id
                    AND session.ownership_state='ACTIVE'
                 WHERE ownership.tenant_id=conversation.tenant_id AND ownership.connection_id=conversation.connection_id
                   AND participant.external_participant_id=conversation.external_chat_id)
             ) AS last_customer_message_at,
             connection.last_heartbeat_at,connection.last_provider_event_at,
             latest_delivery.id AS delivery_id,latest_delivery.zammad_article_id,
             latest_delivery.state AS delivery_state,latest_delivery.updated_at AS delivery_updated_at,
             latest_delivery.manual_retry_allowed
        FROM bot_conversations conversation
        JOIN connections connection ON connection.tenant_id=conversation.tenant_id AND connection.id=conversation.connection_id
        LEFT JOIN LATERAL (
          SELECT delivery.id,delivery.zammad_article_id,delivery.state,delivery.updated_at,delivery.manual_retry_allowed
            FROM delivery_outbox delivery
           WHERE delivery.tenant_id=$1 AND delivery.zammad_ticket_id=$2
             AND delivery.zammad_article_id ~ '^[1-9][0-9]*$'
             AND delivery.content_redacted_at IS NULL
           ORDER BY delivery.updated_at DESC,delivery.id DESC LIMIT 1
        ) latest_delivery ON true
       WHERE conversation.tenant_id=$1 AND conversation.zammad_ticket_id=$2
       ORDER BY (conversation.state<>'RESOLVED') DESC,conversation.created_at DESC LIMIT 1`,
        [claims.tenantId,ticketId])).rows[0];
    });
    if(!context)throw new NotFoundException("WasalX ticket context was not found");
    const provider=contextEnum(context.provider,PROVIDER_CONTEXT_STATES,"provider");
    const {customerServiceWindowSeconds}=directMessageCapabilities(context.provider.toLowerCase() as Lowercase<TicketContextRow["provider"]>);
    const lastCustomerMessageAt=context.last_customer_message_at??null;
    return{
      ticket_id:context.ticket_id,
      connection_id:context.connection_id,
      provider,
      connection_state:contextEnum(context.connection_state,CONNECTION_CONTEXT_STATES,"connection state"),
      binding_state:contextEnum(context.binding_state,BINDING_CONTEXT_STATES,"binding state"),
      group_name:contextText(context.group_name,"group name"),
      correlation_state:contextEnum(context.correlation_state,CORRELATION_CONTEXT_STATES,"correlation state"),
      bot_state:context.bot_state==null?null:contextEnum(context.bot_state,new Set(["BOT","ACTION_PENDING","HANDOFF_PENDING","HUMAN","RESOLVED"]),"conversation state"),
      last_heartbeat_at:isoOrNull(context.last_heartbeat_at),
      last_provider_event_at:isoOrNull(context.last_provider_event_at),
      service_window_expires_at:lastCustomerMessageAt!==null&&customerServiceWindowSeconds!==null
        ?isoOrNull(new Date(new Date(lastCustomerMessageAt).getTime()+customerServiceWindowSeconds*1000)):null,
      delivery_id:context.delivery_id,
      zammad_article_id:context.zammad_article_id,
      delivery_state:context.delivery_state===null?null:contextEnum(context.delivery_state,DELIVERY_CONTEXT_STATES,"delivery state"),
      delivery_updated_at:isoOrNull(context.delivery_updated_at),
      delivery_retry_allowed:retryAllowed(context.delivery_state,context.manual_retry_allowed),
      delivery_retry_requires_confirmation:false,
    };
  }
@Post('direct-native-intents/:operationId/absent')
async absentDirectNativeIntent(@Headers('authorization')authorization:string|undefined,@Param('operationId')operationId:string,
  @Body()body:{ticket_id?:string;native_ticket_locked?:boolean;article_absent?:boolean;native_updated_at?:string;last_article_id?:string},@Req()request?:ZammadServiceRequest){
  const claims=await this.claims(authorization,'zammad:ticket-state',request);
  if(!UUID.test(operationId)||typeof body.ticket_id!=='string'||!/^[1-9][0-9]{0,15}$/u.test(body.ticket_id)||typeof body.native_updated_at!=='string'||typeof body.last_article_id!=='string')throw new BadRequestException('Invalid native absence proof');
  return this.database.withTenant(claims.tenantId,client=>reconcileAbsentDirectReplyIntent(client,{tenantId:claims.tenantId,instanceId:claims.instanceId,operationId,
    ticketId:body.ticket_id!,nativeTicketLocked:body.native_ticket_locked===true,articleAbsent:body.article_absent===true,nativeUpdatedAt:body.native_updated_at!,lastArticleId:body.last_article_id!}));
}
@Get('direct-customer-closes/:commandId')
async directCustomerClose(@Headers('authorization')authorization:string|undefined,@Param('commandId')commandId:string,@Req()request?:ZammadServiceRequest){
  const claims=await this.claims(authorization,'zammad:ticket-state',request);if(!UUID.test(commandId))throw new BadRequestException('Invalid customer close command');
  return this.database.withTenant(claims.tenantId,client=>directCustomerCloseAdmission(client,{tenantId:claims.tenantId,instanceId:claims.instanceId,commandId,appId:process.env.META_APP_ID??''}));
}
@Get('quoted-commands/:executionId')
async quotedCommandAdmission(@Headers('authorization') authorization:string|undefined,
  @Param('executionId') executionId:string,@Req() request?:ZammadServiceRequest,@Query('denied_transcript') deniedTranscript?:string) {
  const claims=await this.claims(authorization,'zammad:ticket-state',request);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(executionId))
    throw new BadRequestException('Command execution is invalid');
  return this.database.withTenant(claims.tenantId,client=>ticketCommandAdmission(client,{
    tenantId:claims.tenantId,instanceId:claims.instanceId,executionId,deniedTranscript,
  }));
}


  @Get("outbound/preflight")async outboundPreflight(@Headers("authorization")authorization:string|undefined,
    @Query("connection_id")connectionId:unknown,@Query("group_id")groupId:unknown,
    @Query("ticket_id")ticketIdValue:unknown,@Req()request?:ZammadServiceRequest){
    const claims=await this.claims(authorization,"zammad:outbound",request);
    if(!claims.userId)throw new UnauthorizedException("A Zammad agent identity is required");
    if(typeof connectionId!=="string"||!UUID.test(connectionId)||typeof groupId!=="string"||!groupId||groupId.length>512||hasControl(groupId))throw new BadRequestException("WhatsApp destination is invalid");
    const ticketId=String(positiveIdentifier(ticketIdValue,"Ticket ID"));
    const allowed=await this.database.withTenant(claims.tenantId,async client=>{await assertTicketCommandBarrier(client,{tenantId:claims.tenantId,ticketId});const routeAllowed=(await client.query<{allowed:boolean}>(`SELECT EXISTS (
      SELECT 1 FROM connections c JOIN whatsapp_groups g ON g.tenant_id=c.tenant_id AND g.connection_id=c.id
      JOIN group_bindings b ON b.tenant_id=g.tenant_id AND b.whatsapp_group_id=g.id
      LEFT JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
      WHERE c.tenant_id=$1 AND c.id=$2 AND g.external_group_id=$3 AND c.state='WORKING' AND b.state='ACTIVE'
        AND (${groupBindingReplyAccessSql("b","$4","$6")}
          OR ${groupWorkspaceAccessSql("g","workspace","$5","$6","$7")})
      UNION ALL
      SELECT 1 FROM connections c JOIN whatsapp_groups g ON g.tenant_id=c.tenant_id AND g.connection_id=c.id
      JOIN tenant_settings tenant ON tenant.tenant_id=g.tenant_id
      JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
      WHERE c.tenant_id=$1 AND c.id=$2 AND g.external_group_id=$3 AND c.state='WORKING'
        AND tenant.group_workspace_enabled AND workspace.capture_enabled
        AND ${groupWorkspaceAccessSql("g","workspace","$5","$6","$7")}
      UNION ALL
      SELECT 1 FROM bot_conversations conversation JOIN connections c
        ON c.tenant_id=conversation.tenant_id AND c.id=conversation.connection_id
      WHERE conversation.tenant_id=$1 AND conversation.connection_id=$2 AND conversation.external_chat_id=$3
        AND conversation.zammad_ticket_id=$4 AND c.state='WORKING'
        AND (conversation.state='HUMAN' OR (conversation.state='BOT' AND EXISTS(SELECT 1 FROM bot_flow_versions v WHERE v.tenant_id=conversation.tenant_id AND v.id=conversation.flow_version_id AND jsonb_typeof(v.definition->'keepOpenPolicy')='object')))
        AND NOT EXISTS (SELECT 1 FROM whatsapp_groups group_record WHERE group_record.tenant_id=conversation.tenant_id
          AND group_record.connection_id=conversation.connection_id AND group_record.external_group_id=conversation.external_chat_id)
    ) AS allowed`,[claims.tenantId,connectionId,groupId,ticketId,claims.userId,claims.groupIds,claims.groupAdmin])).rows[0]?.allowed;
      if(routeAllowed){
        const direct=(await client.query<{id:string}>(`SELECT conversation.id FROM bot_conversations conversation
          JOIN connections connection ON connection.tenant_id=conversation.tenant_id AND connection.id=conversation.connection_id
          WHERE conversation.tenant_id=$1 AND conversation.connection_id=$2 AND conversation.external_chat_id=$3
            AND conversation.zammad_ticket_id=$4 AND connection.provider='META'
            AND (conversation.state='HUMAN' OR (conversation.state='BOT' AND EXISTS(
              SELECT 1 FROM bot_flow_versions version WHERE version.tenant_id=conversation.tenant_id
                AND version.id=conversation.flow_version_id AND jsonb_typeof(version.definition->'keepOpenPolicy')='object')))
            AND NOT EXISTS(SELECT 1 FROM whatsapp_groups g WHERE g.tenant_id=conversation.tenant_id
              AND g.connection_id=conversation.connection_id AND g.external_group_id=conversation.external_chat_id)
          ORDER BY conversation.created_at DESC,conversation.id DESC LIMIT 1`,
          [claims.tenantId,connectionId,groupId,ticketId])).rows[0];
        if(direct)await assertMetaDirectEffectCurrent(client,{tenantId:claims.tenantId,conversationId:direct.id,connectionId,ticketId,
          appId:process.env.META_APP_ID??'',nonwaiting:true});
      }
      return routeAllowed;});
    if(!allowed)throw new NotFoundException("WhatsApp destination was not found");
    const keepOpen=(await this.database.rows<{enabled:boolean}>(claims.tenantId,`SELECT EXISTS(SELECT 1 FROM bot_conversations conversation
      JOIN bot_flow_versions version ON version.tenant_id=conversation.tenant_id AND version.id=conversation.flow_version_id
      WHERE conversation.tenant_id=$1 AND conversation.connection_id=$2 AND conversation.external_chat_id=$3
        AND conversation.zammad_ticket_id=$4 AND conversation.state IN ('BOT','HUMAN')
        AND jsonb_typeof(version.definition->'keepOpenPolicy')='object') AS enabled`,[claims.tenantId,connectionId,groupId,ticketId]))[0]?.enabled;
    return{available:true,keep_open:keepOpen===true};
  }
  @Post("reply-preview")async replyPreview(@Headers("authorization")authorization:string|undefined,@Body()body:OutboundBody&{has_attachments?:boolean;restored_draft?:boolean},@Req()request?:ZammadServiceRequest){
    const claims=await this.claims(authorization,"zammad:outbound",request);
    const input=validateReplyBody(body,claims);
    if(!claims.userId||input.agentId!==claims.userId)throw new UnauthorizedException("A matching Zammad agent identity is required");
    if(body.restored_draft!==undefined&&typeof body.restored_draft!=="boolean")throw new BadRequestException("Restored draft flag is invalid");
    if(typeof body.has_attachments!=="boolean"||(!input.body.trim()&&!body.has_attachments))throw new BadRequestException("A message or attachment is required");
    return this.database.withTenant(claims.tenantId,async client=>{
      const route=await resolveOutboundRoute(client,claims,input,true);
      if(route.bot_conversation_id&&route.provider==='META')await assertMetaDirectEffectCurrent(client,{
        tenantId:claims.tenantId,conversationId:route.bot_conversation_id,connectionId:input.connectionId,ticketId:input.ticketId,
        appId:process.env.META_APP_ID??'',nonwaiting:true});
      const prepared=await prepareTicketReply(client,{
        tenantId:claims.tenantId,connectionId:input.connectionId,groupId:input.groupId,ticketId:input.ticketId,
        requested:input.replyToMessageId,requestedArticleId:input.replyToArticleId,direct:!!route.bot_conversation_id,
        groupBindingId:route.binding_id,body:input.body,contentType:input.contentType,hasAttachments:body.has_attachments!,
        agentDisplayName:input.agentDisplayName,agentPrefixSnapshot:route.agent_prefix,
        agentIdentityPlacementSnapshot:route.agent_identity_placement,
      },false);
      if(body.restored_draft===true){
        // An older matching body can recur after newer different sends. This recent-window candidate
        // is neither proof of persistence origin nor a reason to change the draft.
        const match=(await client.query<{id:string;zammad_article_id:string}>(`WITH recent_ticket_links AS MATERIALIZED (
          SELECT connection_id,external_message_id,zammad_article_id,direction,created_at,id FROM message_links
          WHERE tenant_id=$1 AND zammad_ticket_id=$3 ORDER BY created_at DESC,id DESC LIMIT 100
        ) SELECT delivery.id,delivery.zammad_article_id FROM recent_ticket_links link
        JOIN delivery_outbox delivery ON delivery.tenant_id=$1 AND delivery.connection_id=$2
          AND delivery.external_message_id_sha256 IS NOT NULL
          AND delivery.external_message_id_sha256=app.delivery_external_message_sha256($1,$2,link.external_message_id)
        WHERE link.connection_id=$2 AND link.direction='OUTBOUND' AND delivery.external_message_id=link.external_message_id
          AND delivery.zammad_ticket_id=$3 AND delivery.zammad_article_id=link.zammad_article_id
          AND delivery.zammad_article_id ~ '^[1-9][0-9]{0,15}$' AND delivery.delivery_origin='TICKET'
          AND delivery.state IN ('SENT','DELIVERED','READ') AND delivery.content_redacted_at IS NULL
          AND delivery.message_body=$4 AND delivery.content_type=$5 AND delivery.reply_to_message_id IS NOT DISTINCT FROM $6
        ORDER BY link.created_at DESC,link.id DESC LIMIT 1`,
        [claims.tenantId,input.connectionId,input.ticketId,prepared.body,prepared.contentType,prepared.replyToMessageId])).rows[0];
        if(match)recordStructuredLog("warn","POSSIBLE_SENT_DRAFT_RESTORE_MATCH",{scope:"RECENT_100_TICKET_LINKS",
          tenant_id:claims.tenantId,instance_id:claims.instanceId,connection_id:input.connectionId,ticket_id:input.ticketId,
          article_id:match.zammad_article_id,delivery_id:match.id});
      }
      return{text:renderOutboundText({text:prepared.body,contentType:prepared.contentType,agentDisplayName:input.agentDisplayName,
        agentPrefix:prepared.agentPrefixSnapshot,agentIdentityPlacement:prepared.agentIdentityPlacementSnapshot}),
        replyToMessageId:prepared.replyToMessageId};
    });
  }
  @Post("outbound/native-intent")async nativeReplyIntent(@Headers("authorization")authorization:string|undefined,
    @Body()body:{operation_id?:string;connection_id?:string;chat_id?:string;ticket_id?:string|number;native_group_id?:string|number;request_sha256?:string},@Req()request?:ZammadServiceRequest){
    const claims=await this.claims(authorization,"zammad:outbound",request);
    if(!claims.userId||!body.operation_id||!UUID.test(body.operation_id)||!body.connection_id||!UUID.test(body.connection_id)||
      !body.chat_id||body.chat_id.length>512||hasControl(body.chat_id)||!body.request_sha256||!/^[a-f0-9]{64}$/u.test(body.request_sha256))throw new BadRequestException("Direct reply admission is invalid");
    return this.database.withTenant(claims.tenantId,client=>reserveDirectNativeReply(client,{tenantId:claims.tenantId,
      instanceId:claims.instanceId,operationId:body.operation_id!,connectionId:body.connection_id!,chatId:body.chat_id!,
      ticketId:String(positiveIdentifier(body.ticket_id,"Ticket ID")),nativeGroupId:String(positiveIdentifier(body.native_group_id,"Native group")),
      actorId:claims.userId!,actorFullGroupIds:claims.groupIds,requestSha256:body.request_sha256!,appId:process.env.META_APP_ID??''}));
  }
  @Post("outbound")async outbound(@Headers("authorization")authorization:string|undefined,@Body()body:OutboundBody,@Req()request?:ZammadServiceRequest){
    const claims=await this.claims(authorization,"zammad:outbound",request);
    if(!claims.userId)throw new UnauthorizedException("A Zammad agent identity is required");
    const input=this.validateOutbound(body,claims);
    if(input.agentId!==claims.userId)throw new UnauthorizedException("Zammad agent identity does not match the article author");
    const result=await this.database.withTenant(claims.tenantId,async client=>{
      const route=await resolveOutboundRoute(client,claims,input);
      let directOwnershipEpoch:number|undefined;
      let admitted:{epoch:number;routingEpoch?:number;routingSourceEventId?:string;acceptedDeliveryId:string|null}|undefined;
      if(route.bot_conversation_id){
        const policy=(await client.query<{enabled:boolean}>(`SELECT jsonb_typeof(version.definition->'keepOpenPolicy')='object' AS enabled
          FROM bot_conversations conversation JOIN bot_flow_versions version ON version.tenant_id=conversation.tenant_id AND version.id=conversation.flow_version_id
          WHERE conversation.tenant_id=$1 AND conversation.id=$2`,[claims.tenantId,route.bot_conversation_id])).rows[0]?.enabled;
        if(policy){if(!body.native_reply_intent_id||!UUID.test(body.native_reply_intent_id))throw new BadRequestException("Native direct reply admission is required");
          admitted=await admitDirectReplyIntent(client,{tenantId:claims.tenantId,instanceId:claims.instanceId,conversationId:route.bot_conversation_id,
            operationId:body.native_reply_intent_id,ticketId:input.ticketId,articleId:input.articleId,actorId:input.agentId!,appId:process.env.META_APP_ID??''});directOwnershipEpoch=admitted.epoch;}
      }
      const agentPrefixSnapshot=input.agentDisplayName
        ? cleanText(route.agent_prefix,80,"Agent prefix")
        : null;
      const agentIdentityPlacementSnapshot=input.agentDisplayName?route.agent_identity_placement:null;
      const requestSha256=outboundFingerprint(input);
      const queued=await queueOutboundParts(client,{tenantId:claims.tenantId,connectionId:route.connection_id,
        groupBindingId:route.binding_id,workspaceGroupId:route.group_workspace_group_id,botConversationId:route.bot_conversation_id,
        externalChatId:route.external_chat_id,ticketId:input.ticketId,articleId:input.articleId,body:input.body,
        contentType:input.contentType,replyToMessageId:input.replyToMessageId,idempotencyKey:input.idempotencyKey,
        requestSha256,agentDisplayName:input.agentDisplayName,agentPrefixSnapshot,agentIdentityPlacementSnapshot,deliveryOrigin:"TICKET",
        directOrigin:route.bot_conversation_id?"HUMAN":null,directOwnershipEpoch,metaRoutingEpoch:admitted?.routingEpoch,metaRoutingSourceEventId:admitted?.routingSourceEventId,mentions:[],
        ...(!route.bot_conversation_id||input.replyToArticleId||input.replyToMessageId?{quoteGroupId:input.groupId}:{}),
        ...(input.replyToArticleId?{replyToArticleId:input.replyToArticleId}:{}),
        attachments:input.attachments.map(attachment=>({source:"ARTICLE" as const,...attachment}))});
      if(admitted&&!admitted.acceptedDeliveryId)await completeDirectReplyIntent(client,{tenantId:claims.tenantId,
        operationId:body.native_reply_intent_id!,articleId:input.articleId,deliveryId:queued.id});
      Reflect.deleteProperty(queued,"duplicate");
      return queued;
    });
    await this.drain.wake(claims.tenantId);
    return result;
  }
  @Post("retry")async retry(@Headers("authorization")authorization:string|undefined,@Body()body:RetryBody,@Req()request?:ZammadServiceRequest){
    const claims=await this.claims(authorization,"zammad:retry",request);
    if(!claims.userId)throw new UnauthorizedException("A Zammad agent identity is required");
    const input=validateRetry(body,claims);
    if(input.actorId!==claims.userId)throw new UnauthorizedException("Zammad agent identity does not match the retry requester");
    const result=await this.database.withTenant(claims.tenantId,async client=>{
      await lockTicketCommand(client,{tenantId:claims.tenantId,ticketId:input.ticketId});
      const requestId=`zammad-retry:${input.idempotencyKey}`;
      const requestSha256=retryFingerprint(input);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${claims.tenantId}:${requestId}`]);
      const previous=(await client.query<{id:string;state:string;manual_retry_allowed:boolean;safe_error:string|null;bot_conversation_id:string|null;direct_origin:string|null}>(
        `SELECT delivery.id,delivery.state,delivery.manual_retry_allowed,delivery.safe_error,
                delivery.bot_conversation_id,delivery.direct_origin
          FROM delivery_outbox delivery
          LEFT JOIN group_bindings binding ON binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id
          LEFT JOIN whatsapp_groups group_record ON group_record.tenant_id=delivery.tenant_id
            AND group_record.id=COALESCE(delivery.group_workspace_group_id,binding.whatsapp_group_id)
          LEFT JOIN group_workspace_settings workspace ON workspace.tenant_id=group_record.tenant_id
            AND workspace.whatsapp_group_id=group_record.id
          WHERE delivery.tenant_id=$1 AND delivery.id=$2 AND delivery.zammad_ticket_id=$3 AND delivery.zammad_article_id=$4
            AND delivery.content_redacted_at IS NULL
            AND NOT app.delivery_has_active_privacy_target(delivery.id)
            AND ((delivery.bot_conversation_id IS NOT NULL AND delivery.group_binding_id IS NULL
                  AND delivery.group_workspace_group_id IS NULL)
              OR (group_record.id IS NOT NULL AND ${groupWorkspaceAccessSql("group_record","workspace","$5","$6","$7")}))
          FOR UPDATE OF delivery`,[claims.tenantId,input.deliveryId,input.ticketId,input.articleId,
          claims.userId,claims.groupIds,claims.groupAdmin],
      )).rows[0];
      if(!previous)throw new NotFoundException("Retryable delivery was not found");
      const prior=(await client.query<{target_id:string;new_value:Record<string,unknown>|null}>(
        "SELECT target_id,new_value FROM audit_events WHERE tenant_id=$1 AND action='delivery.retry_requested_from_zammad' AND request_id=$2 ORDER BY created_at DESC LIMIT 1",
        [claims.tenantId,requestId],
      )).rows[0];
      if(prior){
        const value=prior.new_value??{};
        if(prior.target_id!==input.deliveryId||value.request_sha256!==requestSha256)throw new BadRequestException("Idempotency key was already used for a different Zammad retry");
        return{delivery:{id:input.deliveryId,state:String(value.state??"QUEUED"),duplicate:true},wake:false};
      }
      await assertTicketCommandBarrier(client,{tenantId:claims.tenantId,ticketId:input.ticketId});
      if(!retryAllowed(previous.state,previous.manual_retry_allowed))throw new NotFoundException("Retryable delivery was not found");
      if(previous.direct_origin==='HUMAN'&&previous.bot_conversation_id&&!await directHumanDeliveryAllowed(client,{tenantId:claims.tenantId,conversationId:previous.bot_conversation_id,deliveryId:previous.id}))throw new BadRequestException('Agent reply ownership changed');
        if(previous.direct_origin==="BOT"&&previous.bot_conversation_id){const conversation=(await client.query<{state:string;resolution_kind:string|null}>(
        "SELECT state,resolution_kind FROM bot_conversations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[claims.tenantId,previous.bot_conversation_id],
      )).rows[0];if(!conversation||(conversation.state==="HUMAN"&&!await directControlDeliveryAllowed(client,{tenantId:claims.tenantId,conversationId:previous.bot_conversation_id,deliveryId:previous.id}))||(conversation.state==="RESOLVED"&&["OPERATOR","CUSTOMER_CONFIRMED"].includes(conversation.resolution_kind??"")))throw new BadRequestException("Bot replies cannot be retried while a person owns or has closed the conversation");const handoff=(await client.query<{state:string}>("SELECT state FROM bot_handoff_jobs WHERE tenant_id=$1 AND conversation_id=$2 AND state IN ('QUEUED','FAILED_RETRYABLE','RUNNING') ORDER BY created_at,id FOR UPDATE",[claims.tenantId,previous.bot_conversation_id])).rows[0];if(handoff?.state==="RUNNING")throw new BadRequestException("Bot replies cannot be retried while human handoff is running")}
      const disclosure=(await client.query<{group_binding_id:string;disclosure_sha256:string}>(
        "SELECT group_binding_id,disclosure_sha256 FROM group_disclosure_deliveries WHERE tenant_id=$1 AND delivery_id=$2 FOR UPDATE",
        [claims.tenantId,input.deliveryId],
      )).rows[0];
      if(disclosure){
        await client.query("SELECT 1 FROM group_bindings WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[claims.tenantId,disclosure.group_binding_id]);
        const replacement=await client.query(
          `SELECT 1 FROM group_disclosure_deliveries
            WHERE tenant_id=$1 AND group_binding_id=$2 AND disclosure_sha256=$3
              AND delivery_id<>$4 AND state IN ('QUEUED','SENT','OUTCOME_UNKNOWN') LIMIT 1`,
          [claims.tenantId,disclosure.group_binding_id,disclosure.disclosure_sha256,input.deliveryId],
        );
        if(replacement.rowCount)throw new BadRequestException("A newer delivery already carries this group disclosure");
      }
      const queued=(await client.query<{id:string;state:string}>(
        `UPDATE delivery_outbox SET state='QUEUED',available_at=now(),lease_id=NULL,lease_expires_at=NULL,
          safe_error=NULL,manual_retry_allowed=false,blocked_by_delivery_id=NULL,updated_at=now()
          WHERE tenant_id=$1 AND id=$2 AND zammad_ticket_id=$3 AND zammad_article_id=$4
            AND content_redacted_at IS NULL
            AND NOT app.delivery_has_active_privacy_target(id)
          RETURNING id,state`,
        [claims.tenantId,input.deliveryId,input.ticketId,input.articleId],
      )).rows[0]!;
      await client.query(
        "UPDATE group_disclosure_deliveries SET state='QUEUED',updated_at=now() WHERE tenant_id=$1 AND delivery_id=$2 AND state IN ('FAILED','OUTCOME_UNKNOWN')",
        [claims.tenantId,input.deliveryId],
      );
      await client.query(
        `INSERT INTO audit_events
          (tenant_id,actor_type,actor_id,action,target_type,target_id,previous_value,new_value,request_id)
          VALUES ($1,'ZAMMAD_AGENT',$2,'delivery.retry_requested_from_zammad','delivery',$3,$4,$5,$6)`,
        [claims.tenantId,`${claims.instanceId}:${input.actorId}`,input.deliveryId,previous,{
          state:queued.state,request_sha256:requestSha256,zammad_instance_id:claims.instanceId,
          zammad_ticket_id:input.ticketId,zammad_article_id:input.articleId,
        },requestId],
      );
      return{delivery:{...queued,duplicate:false},wake:true};
    });
    if(result.wake)await this.drain.wake(claims.tenantId);
    return result.delivery;
  }
  private validateOutbound(body:OutboundBody,claims:ZammadClaims){
    const input=validateReplyBody(body,claims);
    const articleId=String(positiveIdentifier(body.article_id,"Article ID"));
    if(input.replyToArticleId===articleId)throw new BadRequestException("An article cannot quote itself");
    if(typeof body.idempotency_key!=="string"||!body.idempotency_key||body.idempotency_key.length>255||hasControl(body.idempotency_key))throw new BadRequestException("Idempotency key is invalid");
    if(body.attachments!==undefined&&!Array.isArray(body.attachments))throw new BadRequestException("Attachments are invalid");
    if((body.attachments?.length??0)>10)throw new BadRequestException("At most ten attachments are accepted per article");
    const attachments=(body.attachments??[]).map(validateAttachment);
    if(new Set(attachments.map(item=>item.id)).size!==attachments.length)throw new BadRequestException("Attachment IDs must be unique");
    if(attachments.reduce((sum,item)=>sum+item.byteSize,0)>250_000_000)throw new BadRequestException("Total attachment size is too large");
    if(!input.body.trim()&&attachments.length===0)throw new BadRequestException("A message body or attachment is required");
    return{...input,articleId,idempotencyKey:body.idempotency_key,attachments};
  }
}

function zammadRequestId(request:ZammadServiceRequest|undefined,instanceId:string,ticketId:string){const raw=request?.headers?.["x-request-id"];const value=Array.isArray(raw)?raw[0]:raw;return typeof value==="string"&&value.length<=200&&!Array.from(value).some(character=>{const code=character.codePointAt(0)??0;return code<32||code===127})?value:`zammad-email-route:${instanceId}:${ticketId}`}

function validateAttachment(value:OutboundAttachment):ValidAttachment{
  if(!value||typeof value!=="object"||value.id==null||value.filename==null||value.content_type==null||value.size==null)throw new BadRequestException("Attachment descriptors are incomplete");
  const id=positiveIdentifier(value.id,"Attachment ID");
  if(typeof value.filename!=="string"||typeof value.content_type!=="string")throw new BadRequestException("Attachment descriptor text is invalid");
  const filename=cleanFilename(value.filename);
  const mimeType=value.content_type.trim().toLowerCase().split(";",1)[0]??"";
  if(!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)||mimeType.length>127)throw new BadRequestException("Attachment content type is invalid");
  const byteSize=positiveIdentifier(value.size,"Attachment size");
  if(byteSize>100_000_000)throw new BadRequestException("Attachment descriptor exceeds the hard size limit");
  return{id,filename,mimeType,byteSize};
}

function isoOrNull(value:string|Date|null){
  if(value===null)return null;
  const date=value instanceof Date?value:new Date(value);
  return Number.isFinite(date.getTime())?date.toISOString():null;
}
function contextEnum(value:string,allowed:ReadonlySet<string>,label:string){
  if(!allowed.has(value))throw new Error(`Stored WasalX ${label} is invalid`);
  return value;
}
function contextText(value:string,label:string){
  const normalized=value.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu," ").replace(/\s+/g," ").trim();
  if(!normalized)throw new Error(`Stored WasalX ${label} is invalid`);
  return normalized.slice(0,200);
}
function retryAllowed(state:string|null,manualRetryAllowed:boolean|null){return state==="FAILED_RETRYABLE"||(state==="FAILED_TERMINAL"&&manualRetryAllowed===true)}
function validateRetry(body:RetryBody,claims:ZammadClaims){
  if(body.tenant_id!==claims.tenantId||body.instance_id!==claims.instanceId)throw new UnauthorizedException("Tenant or Zammad instance mismatch");
  const ticketId=String(positiveIdentifier(body.ticket_id,"Ticket ID"));
  const articleId=String(positiveIdentifier(body.article_id,"Article ID"));
  const actorId=String(positiveIdentifier(body.actor_id,"Actor ID"));
  if(typeof body.delivery_id!=="string"||!UUID.test(body.delivery_id))throw new BadRequestException("Delivery ID is invalid");
  if(typeof body.idempotency_key!=="string"||!body.idempotency_key||body.idempotency_key.length>255||hasControl(body.idempotency_key))throw new BadRequestException("Idempotency key is invalid");
  return{ticketId,articleId,actorId,deliveryId:body.delivery_id,idempotencyKey:body.idempotency_key,confirmOutcomeUnknown:body.confirm_outcome_unknown===true};
}
function positiveIdentifier(value:unknown,label:string){if(typeof value!=="string"&&typeof value!=="number")throw new BadRequestException(`${label} is invalid`);if(typeof value==="string"&&!/^\d{1,16}$/.test(value))throw new BadRequestException(`${label} is invalid`);const number=typeof value==="number"?value:Number(value);if(!Number.isSafeInteger(number)||number<=0)throw new BadRequestException(`${label} is invalid`);return number}
function cleanText(value:string,limit:number,label:string){const normalized=value.normalize("NFC").trim();if(!normalized||normalized.length>limit||hasControl(normalized))throw new BadRequestException(`${label} is invalid`);return normalized}
function cleanFilename(value:string){const normalized=cleanText(value,120,"Attachment filename");if(normalized.includes("/")||normalized.includes("\\")||normalized.includes("..")||/[\p{Cf}]/u.test(normalized))throw new BadRequestException("Attachment filename is invalid");return normalized}
function hasControl(value:string){return/[\p{Cc}\p{Cf}]/u.test(value)}
function outboundFingerprint(input:{connectionId:string;groupId:string;ticketId:string;articleId:string;body:string;contentType:string;replyToMessageId:string|null;idempotencyKey:string;agentId:string|null;agentDisplayName:string|null;attachments:ValidAttachment[]}){return createHash("sha256").update(JSON.stringify(input)).digest("hex")}
function retryFingerprint(input:{ticketId:string;articleId:string;actorId:string;deliveryId:string;confirmOutcomeUnknown:boolean}){return createHash("sha256").update(JSON.stringify(input)).digest("hex")}
function mediaIdempotencyKey(base:string,attachmentId:string|number){return`wasalx-media:${createHash("sha256").update(`${base}\0${attachmentId}`).digest("hex")}`}

export async function queueOutboundParts(client:PoolClient,input:QueueOutboundInput){
  if(input.ticketId)await lockTicketCommand(client,{tenantId:input.tenantId,ticketId:input.ticketId});
  const accepted=await acceptedOutboundParts(client,input);
  if(accepted)return accepted;
  if(input.ticketId)await assertTicketCommandBarrier(client,{tenantId:input.tenantId,ticketId:input.ticketId});
  let eventReceipt:TicketEventReceipt|null=null;
  if(input.quoteGroupId&&input.ticketId){
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`ticket-outbound:${input.tenantId}:${input.ticketId}`]);
    const accepted=(await client.query<{reply_to_message_id:string|null}>(
      "SELECT reply_to_message_id FROM delivery_outbox WHERE tenant_id=$1 AND idempotency_key=$2",
      [input.tenantId,input.idempotencyKey])).rows[0];
    if(accepted)input={...input,replyToMessageId:accepted.reply_to_message_id};
    else{
      const prepared=await prepareTicketReply(client,{
        ...input,groupId:input.quoteGroupId,ticketId:input.ticketId,requested:input.replyToMessageId,
        requestedArticleId:input.replyToArticleId,direct:!!input.botConversationId,hasAttachments:input.attachments.length>0,
      },true);
      eventReceipt=prepared.receipt;
      input={...input,...prepared};
    }
  }
  const parts:Array<{body:string;contentType:string;attachment?:QueuedOutboundAttachment}>=[];
  // A media-only message needs a text identity part only when attribution is
  // enabled. Voice and document endpoints cannot reliably carry that label.
  if(input.body.trim()||input.contentType==="application/vnd.wasalx.whatsapp-reaction"||(input.agentDisplayName&&input.attachments.length&&input.agentIdentityPlacementSnapshot!=="OFF"))parts.push({body:input.body,contentType:input.contentType});
  for(const attachment of input.attachments)parts.push({body:"",contentType:attachment.mimeType,attachment});
  const batchId=parts.length>1?crypto.randomUUID():null;
  let primary:{id:string;state:string;message_text:string;participant_name:string|null;provider_timestamp:string;
    media_filename?:string;media_mime_type?:string;media_available?:boolean}|undefined;
  for(const [index,part] of parts.entries()){
    const attachmentKey=part.attachment?.source==="ARTICLE"?part.attachment.id:
      part.attachment?`${part.attachment.uploadCacheId}:${part.attachment.sourceStoreId}`:"text";
    const partKey=index===0?input.idempotencyKey:mediaIdempotencyKey(input.idempotencyKey,attachmentKey);
    const conflictClause=index===0?"ON CONFLICT (tenant_id,idempotency_key) DO NOTHING":"";
    const created=(await client.query<{id:string;state:string;message_text:string;participant_name:string|null;provider_timestamp:string}>(`INSERT INTO delivery_outbox
      (tenant_id,connection_id,group_binding_id,group_workspace_group_id,bot_conversation_id,external_chat_id,zammad_ticket_id,zammad_article_id,
       message_body,content_type,reply_to_message_id,idempotency_key,state,available_at,safe_error,request_sha256,agent_display_name,
       agent_prefix_snapshot,batch_id,batch_sequence,batch_part_count,direct_origin,delivery_origin,mentions,agent_identity_placement_snapshot,direct_ownership_epoch,meta_routing_epoch,meta_routing_source_event_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'QUEUED',CASE WHEN $17=0 THEN now() ELSE 'infinity'::timestamptz END,
       CASE WHEN $17=0 THEN NULL ELSE 'Waiting for an earlier message part to complete.' END,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
      ${conflictClause}
      RETURNING id,state,message_body AS message_text,agent_display_name AS participant_name,created_at AS provider_timestamp`,[
      input.tenantId,input.connectionId,input.groupBindingId,input.workspaceGroupId,input.botConversationId,input.externalChatId,
      input.ticketId,input.articleId,part.body,part.contentType,input.replyToMessageId,partKey,input.requestSha256,
      input.agentDisplayName,index===0?input.agentPrefixSnapshot:null,batchId,index,parts.length,input.directOrigin,input.deliveryOrigin,index===0?input.mentions:[],index===0?input.agentIdentityPlacementSnapshot:"OFF",input.directOwnershipEpoch??null,input.metaRoutingEpoch??null,input.metaRoutingSourceEventId??null,
    ])).rows[0];
    if(!created)break;
    primary??={...created,...(part.attachment?{media_filename:part.attachment.filename,
      media_mime_type:part.attachment.mimeType,media_available:false}:{})};
    if(part.attachment){
      await client.query(`INSERT INTO delivery_media
        (tenant_id,delivery_id,zammad_attachment_id,zammad_upload_id,zammad_upload_store_id,filename,mime_type,byte_size)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[
        input.tenantId,created.id,part.attachment.source==="ARTICLE"?part.attachment.id:null,
        part.attachment.source==="WORKSPACE"?part.attachment.uploadId:null,
        part.attachment.source==="WORKSPACE"?part.attachment.storeId:null,
        part.attachment.filename,part.attachment.mimeType,part.attachment.byteSize,
      ]);
    }
  }
  if(primary){
    if(eventReceipt)await completeTicketEventExecution(client,eventReceipt,eventReceipt.mode==="OFF"?"SKIPPED":"APPLIED");
    return{...primary,duplicate:false};
  }
  const existing=await acceptedOutboundParts(client,input);
  if(!existing)throw new BadRequestException("Outbound delivery could not be queued");
  return existing;
}
function validateEmailRouting(body:EmailRoutingBody,claims:ZammadClaims){
  if(body.tenant_id!==claims.tenantId||body.instance_id!==claims.instanceId)throw new UnauthorizedException("Tenant or Zammad instance mismatch");
  const ticketId=String(positiveIdentifier(body.ticket_id,"Ticket ID"));
  const articleId=String(positiveIdentifier(body.article_id,"Article ID"));
  if(body.ticket_number!==undefined&&(typeof body.ticket_number!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(body.ticket_number)))throw new BadRequestException("Ticket number is invalid");
  if(typeof body.sender_email!=="string"||body.sender_email.length>320||hasControl(body.sender_email))throw new BadRequestException("Sender email is invalid");
  const admittedAt=emailAdmissionTimestamp(body.admitted_at);
  const entryGroupId=body.entry_group_id===undefined?undefined:String(positiveIdentifier(body.entry_group_id,"Entry group ID"));
  try{return{ticketId,articleId,senderEmail:normalizeRoutingEmail(body.sender_email),admittedAt,...(entryGroupId?{entryGroupId}:{})}}catch{throw new BadRequestException("Sender email is invalid")}
}
function validateEmailRoutingAcknowledgement(body:EmailRoutingAcknowledgementBody,claims:ZammadClaims){
  if(body.tenant_id!==claims.tenantId||body.instance_id!==claims.instanceId)throw new UnauthorizedException("Tenant or Zammad instance mismatch");
  if(typeof body.route_id!=="string"||!UUID.test(body.route_id))throw new BadRequestException("Route ID is invalid");
  const ticketId=String(positiveIdentifier(body.ticket_id,"Ticket ID"));
  const articleId=String(positiveIdentifier(body.article_id,"Article ID"));
  if(typeof body.idempotency_key!=="string"||body.idempotency_key.length<1||body.idempotency_key.length>255||hasControl(body.idempotency_key))throw new BadRequestException("Idempotency key is invalid");
  if(body.application_status!=="APPLIED"&&body.application_status!=="MANUAL_OVERRIDE")throw new BadRequestException("Routing application status is invalid");
  const observedGroupId=String(positiveIdentifier(body.observed_group_id,"Observed Zammad group ID"));
  const observedOwnerId=body.observed_owner_id==null?null:String(positiveIdentifier(body.observed_owner_id,"Observed Zammad owner ID"));
  return{routeId:body.route_id,ticketId,articleId,idempotencyKey:body.idempotency_key,
    applicationStatus:body.application_status,observedGroupId,observedOwnerId};
}
function emailRoutingRequestSha256(claims:ZammadClaims,input:{ticketId:string;articleId:string;senderEmail:string;admittedAt:string;entryGroupId?:string}){
  // Keep historical pending jobs bound to their original request digest.
  const provenance=[claims.tenantId,claims.instanceId,input.ticketId,input.articleId,input.senderEmail,input.admittedAt];
  if(input.entryGroupId!==undefined)provenance.push(input.entryGroupId);
  return createHash("sha256").update(JSON.stringify(provenance)).digest("hex");
}
function emailAdmissionTimestamp(value:unknown){
  if(typeof value!=="string")throw new BadRequestException("Email admission timestamp is invalid");
  const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/u.exec(value);
  if(!match)throw new BadRequestException("Email admission timestamp is invalid");
  const date=new Date(`${match[1]}.${match[2]!.slice(0,3)}Z`);
  if(!Number.isFinite(date.getTime())||date.toISOString()!==`${match[1]}.${match[2]!.slice(0,3)}Z`
    ||date.getUTCFullYear()<2000||date.getTime()>Date.now()+600_000)throw new BadRequestException("Email admission timestamp is invalid");
  return value;
}
function emailRoutingAcknowledgementSha256(claims:ZammadClaims,input:{routeId:string;ticketId:string;articleId:string;idempotencyKey:string;applicationStatus:string;observedGroupId:string;observedOwnerId:string|null}){
  return createHash("sha256").update(JSON.stringify([claims.tenantId,claims.instanceId,input.routeId,input.ticketId,input.articleId,input.idempotencyKey,input.applicationStatus,input.observedGroupId,input.observedOwnerId])).digest("hex");
}
function emailRoutingResult(ticketId:string,row:EmailRouteRow,duplicate:boolean){
  if(row.client_route_status==="UNCONFIGURED")return{route_id:row.id,ticket_id:ticketId,source_article_id:row.source_article_id,routed:false,status:row.client_route_status,duplicate};
  if(!row.client_routing_version_id||!row.definition)throw new Error("Pinned email routing version is unavailable");
  const definition:ClientRoutingDefinition=parseClientRouting(row.definition);let target:ClientRoute|ClientRoutingDefinition["fallback"]|undefined;
  if(row.client_route_status==="FALLBACK")target=definition.fallback;
  else target=definition.clients.find(client=>client.id===row.client_id);
  if(!target)throw new Error("Pinned email routing target is unavailable");
  return{route_id:row.id,ticket_id:ticketId,source_article_id:row.source_article_id,routed:true,status:row.client_route_status,duplicate,routing_version_id:row.client_routing_version_id,
    client_id:row.client_id,matched_by:row.client_route_matched_by,zammad_group_id:String(positiveIdentifier(target.zammadGroupId,"Zammad group ID")),
    ...(target.ownerId?{owner_id:String(positiveIdentifier(target.ownerId,"Zammad owner ID"))}:{})};
}
function emailRoutingAcknowledgementResult(row:EmailRouteApplicationRow,duplicate:boolean){
  return{route_id:row.route_id,acknowledged:true,application_status:row.application_status,
    observed_group_id:row.observed_group_id,observed_owner_id:row.observed_owner_id,duplicate};
}

async function resolveOutboundRoute(client:PoolClient,claims:ZammadClaims,input:{connectionId:string;groupId:string;ticketId:string},allowBotPreview=false){
      const binding=(await client.query<{connection_id:string;binding_id:string;group_workspace_group_id:null;bot_conversation_id:null;external_chat_id:null;provider:"WAHA"|"META";agent_prefix:string;agent_identity_placement:"HEADER"|"FOOTER"|"OFF";media_enabled:boolean}>(`SELECT c.id AS connection_id,b.id AS binding_id,NULL::uuid AS group_workspace_group_id,NULL::uuid AS bot_conversation_id,
               NULL::text AS external_chat_id,c.provider,b.agent_prefix,b.agent_identity_placement,b.media_enabled
        FROM connections c
        JOIN whatsapp_groups g ON g.connection_id=c.id AND g.tenant_id=c.tenant_id
        JOIN group_bindings b ON b.whatsapp_group_id=g.id AND b.tenant_id=g.tenant_id
        LEFT JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
        WHERE c.tenant_id=$1 AND c.id=$2 AND g.external_group_id=$3
          AND c.state='WORKING' AND b.state='ACTIVE'
          AND (${groupBindingReplyAccessSql("b","$7","$5")}
            OR ${groupWorkspaceAccessSql("g","workspace","$4","$5","$6")})
        FOR SHARE OF c,g,b`,[claims.tenantId,input.connectionId,input.groupId,
        claims.userId,claims.groupIds,claims.groupAdmin,input.ticketId])).rows[0];
      const workspace=binding??(await client.query<{connection_id:string;binding_id:null;group_workspace_group_id:string;bot_conversation_id:null;external_chat_id:null;provider:"WAHA"|"META";agent_prefix:string;agent_identity_placement:"HEADER"|"FOOTER"|"OFF";media_enabled:boolean}>(`SELECT c.id AS connection_id,NULL::uuid AS binding_id,
               g.id AS group_workspace_group_id,NULL::uuid AS bot_conversation_id,NULL::text AS external_chat_id,
               c.provider,workspace.agent_prefix,workspace.agent_identity_placement,
               true AS media_enabled
          FROM connections c
          JOIN whatsapp_groups g ON g.connection_id=c.id AND g.tenant_id=c.tenant_id
          JOIN tenant_settings tenant ON tenant.tenant_id=g.tenant_id
          JOIN group_workspace_settings workspace ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
         WHERE c.tenant_id=$1 AND c.id=$2 AND g.external_group_id=$3
           AND c.state='WORKING' AND tenant.group_workspace_enabled AND workspace.capture_enabled
           AND ${groupWorkspaceAccessSql("g","workspace","$4","$5","$6")}
         FOR SHARE OF c,g,workspace`,[claims.tenantId,input.connectionId,input.groupId,
        claims.userId,claims.groupIds,claims.groupAdmin])).rows[0];
      const route=workspace??(await client.query<{connection_id:string;binding_id:null;group_workspace_group_id:null;bot_conversation_id:string;external_chat_id:string;provider:"WAHA"|"META";agent_prefix:string;agent_identity_placement:"HEADER"|"FOOTER"|"OFF";media_enabled:boolean}>(`SELECT c.id AS connection_id,NULL::uuid AS binding_id,
               NULL::uuid AS group_workspace_group_id,conversation.id AS bot_conversation_id,conversation.external_chat_id,c.provider,
               assignment.agent_prefix,assignment.agent_identity_placement,true AS media_enabled
          FROM bot_conversations conversation
          JOIN bot_assignments assignment ON assignment.tenant_id=conversation.tenant_id AND assignment.id=conversation.assignment_id
          JOIN connections c ON c.tenant_id=conversation.tenant_id AND c.id=conversation.connection_id
         WHERE conversation.tenant_id=$1 AND conversation.connection_id=$2
           AND conversation.external_chat_id=$3 AND conversation.zammad_ticket_id=$4
           AND c.state='WORKING' AND (conversation.state='HUMAN' OR ($5::boolean AND conversation.state='BOT' AND EXISTS(SELECT 1 FROM bot_flow_versions v WHERE v.tenant_id=conversation.tenant_id AND v.id=conversation.flow_version_id AND jsonb_typeof(v.definition->'keepOpenPolicy')='object')))
           AND NOT EXISTS (SELECT 1 FROM whatsapp_groups group_record WHERE group_record.tenant_id=conversation.tenant_id
             AND group_record.connection_id=conversation.connection_id AND group_record.external_group_id=conversation.external_chat_id)
         ORDER BY conversation.created_at DESC LIMIT 1
         FOR SHARE OF c,conversation`,[claims.tenantId,input.connectionId,input.groupId,input.ticketId,allowBotPreview])).rows[0];
      if(!route)throw new NotFoundException("WhatsApp destination was not found");
  return route;
}

function validateReplyBody(body:OutboundBody,claims:ZammadClaims){
  if(body.tenant_id!==claims.tenantId)throw new UnauthorizedException("Tenant mismatch");
  if(body.internal)throw new BadRequestException("Internal notes are never communicative");
  if(typeof body.connection_id!=="string"||!UUID.test(body.connection_id)||typeof body.group_id!=="string"||!body.group_id||body.group_id.length>512||hasControl(body.group_id))throw new BadRequestException("Outbound identifiers are invalid");
  if(body.body!==undefined&&typeof body.body!=="string")throw new BadRequestException("Message body is invalid");
  const messageBody=body.body??"";
  if(messageBody.length>65_536)throw new BadRequestException("Message is too large");
  const contentType=body.content_type??"text/plain";
  if(contentType!=="text/plain"&&contentType!=="text/html")throw new BadRequestException("Message content type is invalid");
  const ticketId=String(positiveIdentifier(body.ticket_id,"Ticket ID"));
  if(body.agent?.display_name!==undefined&&typeof body.agent.display_name!=="string")throw new BadRequestException("Agent display name is invalid");
  const agentDisplayName=body.agent?.display_name===undefined?null:cleanText(body.agent.display_name,120,"Agent display name");
  const agentId=String(positiveIdentifier(body.agent?.id,"Agent ID"));
  if(body.reply_to_message_id!==undefined&&(typeof body.reply_to_message_id!=="string"||!body.reply_to_message_id.trim()||body.reply_to_message_id.length>512||hasControl(body.reply_to_message_id)))throw new BadRequestException("Reply message ID is invalid");
  const replyToArticleId=body.reply_to_article_id===undefined?undefined:String(positiveIdentifier(body.reply_to_article_id,"Quoted article ID"));
  return{connectionId:body.connection_id,groupId:body.group_id,ticketId,body:messageBody,contentType,
    replyToMessageId:body.reply_to_message_id??null,...(replyToArticleId?{replyToArticleId}:{}),agentId,agentDisplayName};
}

async function acceptedOutboundParts(client:PoolClient,input:QueueOutboundInput){
  const existing=(await client.query<{id:string;state:string;request_sha256:string|null;message_text:string;participant_name:string|null;
    provider_timestamp:string;media_filename:string|null;media_mime_type:string|null;media_available:boolean|null}>(
    `SELECT delivery.id,delivery.state,delivery.request_sha256,delivery.message_body AS message_text,
      delivery.agent_display_name AS participant_name,delivery.created_at AS provider_timestamp,
      media.filename AS media_filename,media.mime_type AS media_mime_type,
      (media.state='READY' AND media.media_object_id IS NOT NULL) AS media_available
      FROM delivery_outbox delivery LEFT JOIN delivery_media media
        ON media.tenant_id=delivery.tenant_id AND media.delivery_id=delivery.id
      WHERE delivery.tenant_id=$1 AND delivery.idempotency_key=$2
        AND delivery.content_redacted_at IS NULL`,
    [input.tenantId,input.idempotencyKey],
  )).rows[0];
  if(!existing)return null;
  if(existing.request_sha256!==input.requestSha256)throw new ConflictException(`Idempotency key was already used for a different outbound ${input.deliveryOrigin==="TICKET"?"article":"message"}`);
  Reflect.deleteProperty(existing,"request_sha256");
  if(!existing.media_filename){Reflect.deleteProperty(existing,"media_filename");Reflect.deleteProperty(existing,"media_mime_type");Reflect.deleteProperty(existing,"media_available")}
  return{...existing,duplicate:true};
}
