import {directControlDeliveryAllowed,directHumanDeliveryAllowed} from '@wasalx/core/direct-delivery-guards';
import { createHash } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  ForbiddenException,
  Get,
  Header,
  Headers,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { appendAudit } from "./audit.js";
import { DatabaseService } from "./database.service.js";
import { Requires } from "./permission.guard.js";
import { TenantDrainService } from "./tenant-drain.service.js";
import type { AuthenticatedRequest } from "./types.js";
import { requireOperationKey, withOperationReceipt } from "./idempotent-operation.js";
import { deliveryHoldExpiresAtSql,deliveryHoldReasonSql,deliveryOrderingPredecessorSql } from "./delivery-presentation.js";
import { can } from "./rbac.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type DeliveryDestinationRow={zammad_ticket_number:string};

@Controller("v1/deliveries")
export class DeliveriesController {
  constructor(
    private readonly database: DatabaseService,
    private readonly drain: TenantDrainService,
  ) {}

  @Get()
  @Requires("delivery:read")
  list(
    @Req() request: AuthenticatedRequest,
    @Query("before") before?: string,
    @Query("limit") limitValue?: string,
  ) {
    if (before !== undefined && !UUID.test(before)) throw new BadRequestException("Delivery cursor is invalid");
    const limit = boundedLimit(limitValue);
    return this.database.rows(
      request.principal.tenantId,
      `WITH cursor AS (
         SELECT created_at,id FROM delivery_outbox WHERE tenant_id=$1 AND id=$2
       ) SELECT d.id,
              d.connection_id,
              d.zammad_ticket_id,
              CASE WHEN d.zammad_ticket_id IS NULL THEN NULL
                   WHEN d.bot_conversation_id IS NOT NULL THEN direct_conversation.zammad_ticket_number
                   ELSE correlated_case.zammad_ticket_number END AS ticket_number,
              d.zammad_article_id,
              d.delivery_origin,
              d.direct_origin,
              CASE WHEN d.bot_conversation_id IS NOT NULL THEN 'DIRECT' ELSE 'GROUP' END AS destination_kind,
              EXISTS (SELECT 1 FROM zammad_instances instance
                       WHERE instance.tenant_id=d.tenant_id AND instance.state='WORKING'
                         AND instance.agent_base_url IS NOT NULL) AS zammad_agent_available,
              outcome_review.id AS outcome_review_id,
              outcome_review.resolution_code AS outcome_resolution_code,
              d.state,
              d.attempts,
              d.available_at,
              ${deliveryHoldReasonSql("d")} AS hold_reason,
              ${deliveryHoldExpiresAtSql("d","waha_policy")} AS hold_expires_at,
              d.external_message_id,
              d.safe_error,
              d.manual_retry_allowed,
              (d.content_redacted_at IS NULL AND btrim(d.message_body)<>'') AS body_available,
              d.blocked_by_delivery_id,
              d.batch_id,
              d.batch_sequence,
              d.batch_part_count,
              d.created_at,
              d.updated_at,
              c.provider,
              CASE WHEN d.bot_conversation_id IS NOT NULL THEN 'Private WhatsApp conversation'
                   ELSE COALESCE(workspace_group.wasalx_name,workspace_group.display_name,
                                 bound_group.wasalx_name,bound_group.display_name) END AS group_name,
              dm.filename AS media_filename,
              dm.mime_type AS media_mime_type,
              dm.byte_size AS media_byte_size,
              dm.state AS media_state,
              COALESCE(receipt.receipt_count, 0)::integer AS receipt_count,
              receipt.last_receipt_at,
              receipt.last_receipt_status,
              receipt.last_receipt_scope
         FROM delivery_outbox d
         JOIN connections c
           ON c.id = d.connection_id
          AND c.tenant_id = d.tenant_id
    LEFT JOIN group_bindings b
           ON b.id = d.group_binding_id
          AND b.tenant_id = d.tenant_id
    LEFT JOIN whatsapp_groups bound_group
           ON bound_group.id = b.whatsapp_group_id
          AND bound_group.tenant_id = d.tenant_id
    LEFT JOIN whatsapp_groups workspace_group
           ON workspace_group.id = d.group_workspace_group_id
          AND workspace_group.tenant_id = d.tenant_id
    LEFT JOIN waha_outbound_connection_policies waha_policy
           ON waha_policy.tenant_id = d.tenant_id
          AND waha_policy.connection_id = d.connection_id
    LEFT JOIN bot_conversations direct_conversation
           ON direct_conversation.id = d.bot_conversation_id
          AND direct_conversation.tenant_id = d.tenant_id
          AND direct_conversation.zammad_ticket_id = d.zammad_ticket_id
    LEFT JOIN LATERAL (
          SELECT correlation.zammad_ticket_number
            FROM case_correlations correlation
           WHERE correlation.tenant_id = d.tenant_id
             AND correlation.zammad_ticket_id = d.zammad_ticket_id
             AND d.bot_conversation_id IS NULL
        ORDER BY correlation.updated_at DESC,correlation.id DESC
           LIMIT 1
        ) correlated_case ON true
    LEFT JOIN LATERAL (
          SELECT review.id,review.resolution_code
            FROM quarantine_records review
           WHERE review.tenant_id=d.tenant_id
             AND review.delivery_id=d.id
             AND review.reason_code='PROVIDER_OUTCOME_UNKNOWN'
             AND (review.state='OPEN' OR (review.state='RESOLVED' AND review.resolution_code='DELIVERY_NO_FURTHER_ATTEMPTS'))
        ORDER BY review.created_at DESC,review.id DESC
           LIMIT 1
        ) outcome_review ON true
    LEFT JOIN delivery_media dm
           ON dm.delivery_id = d.id
          AND dm.tenant_id = d.tenant_id
          AND d.content_redacted_at IS NULL
    LEFT JOIN LATERAL (
          SELECT count(*) AS receipt_count,
                 max(r.provider_timestamp) AS last_receipt_at,
                 (array_agg(r.receipt_status ORDER BY r.provider_timestamp DESC, r.created_at DESC))[1] AS last_receipt_status,
                 (array_agg(r.receipt_scope ORDER BY r.provider_timestamp DESC, r.created_at DESC))[1] AS last_receipt_scope
            FROM delivery_receipts r
           WHERE r.tenant_id = d.tenant_id
             AND r.delivery_id = d.id
        ) receipt ON true
        WHERE d.tenant_id = $1
          AND ($2::uuid IS NULL OR (d.created_at,d.id)<(SELECT created_at,id FROM cursor))
        ORDER BY d.created_at DESC,d.id DESC
        LIMIT $3`,
      [request.principal.tenantId, before ?? null, limit],
    );
  }

  @Get(":id")
  @Requires("delivery:read")
  async detail(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    if (!UUID.test(id)) throw new BadRequestException("Delivery ID is invalid");
    return this.database.withTenant(request.principal.tenantId, async (client) => {
      const delivery = (await client.query(
        `SELECT d.id,d.connection_id,d.zammad_ticket_id,
                CASE WHEN d.zammad_ticket_id IS NULL THEN NULL
                     WHEN d.bot_conversation_id IS NOT NULL THEN direct_conversation.zammad_ticket_number
                     ELSE correlated_case.zammad_ticket_number END AS ticket_number,
                d.zammad_article_id,d.delivery_origin,d.direct_origin,
                CASE WHEN d.bot_conversation_id IS NOT NULL THEN 'DIRECT' ELSE 'GROUP' END AS destination_kind,
                EXISTS (SELECT 1 FROM zammad_instances instance
                         WHERE instance.tenant_id=d.tenant_id AND instance.state='WORKING'
                           AND instance.agent_base_url IS NOT NULL) AS zammad_agent_available,
                outcome_review.id AS outcome_review_id,
              outcome_review.resolution_code AS outcome_resolution_code,
                d.state,d.attempts,d.available_at,
                ${deliveryHoldReasonSql("d")} AS hold_reason,
                ${deliveryHoldExpiresAtSql("d","waha_policy")} AS hold_expires_at,
                d.external_message_id,d.safe_error,d.manual_retry_allowed,
                (d.content_redacted_at IS NULL AND btrim(d.message_body)<>'') AS body_available,
                d.batch_id,d.batch_sequence,
                d.batch_part_count,d.created_at,d.updated_at,d.updated_at::text AS revision,c.provider,
                ${deliveryOrderingPredecessorSql("d")} AS ordering_predecessor_id,
                EXISTS (SELECT 1 FROM audit_events stopped WHERE stopped.tenant_id=d.tenant_id
                  AND stopped.target_id=d.id::text AND stopped.target_type='delivery'
                  AND stopped.action='delivery.retry_stopped') AS retry_stopped,
                CASE WHEN d.bot_conversation_id IS NOT NULL THEN 'Private WhatsApp conversation'
                     ELSE COALESCE(workspace_group.wasalx_name,workspace_group.display_name,
                                   bound_group.wasalx_name,bound_group.display_name) END AS group_name,
                dm.filename AS media_filename,dm.mime_type AS media_mime_type,
                dm.byte_size AS media_byte_size,dm.state AS media_state
           FROM delivery_outbox d
           JOIN connections c ON c.id=d.connection_id AND c.tenant_id=d.tenant_id
      LEFT JOIN group_bindings b ON b.id=d.group_binding_id AND b.tenant_id=d.tenant_id
      LEFT JOIN whatsapp_groups bound_group ON bound_group.id=b.whatsapp_group_id AND bound_group.tenant_id=d.tenant_id
      LEFT JOIN whatsapp_groups workspace_group ON workspace_group.id=d.group_workspace_group_id AND workspace_group.tenant_id=d.tenant_id
      LEFT JOIN waha_outbound_connection_policies waha_policy ON waha_policy.tenant_id=d.tenant_id AND waha_policy.connection_id=d.connection_id
      LEFT JOIN bot_conversations direct_conversation
             ON direct_conversation.id=d.bot_conversation_id
            AND direct_conversation.tenant_id=d.tenant_id
            AND direct_conversation.zammad_ticket_id=d.zammad_ticket_id
      LEFT JOIN LATERAL (
            SELECT correlation.zammad_ticket_number
              FROM case_correlations correlation
             WHERE correlation.tenant_id=d.tenant_id
               AND correlation.zammad_ticket_id=d.zammad_ticket_id
               AND d.bot_conversation_id IS NULL
          ORDER BY correlation.updated_at DESC,correlation.id DESC
             LIMIT 1
          ) correlated_case ON true
      LEFT JOIN LATERAL (
            SELECT review.id,review.resolution_code
              FROM quarantine_records review
             WHERE review.tenant_id=d.tenant_id
               AND review.delivery_id=d.id
               AND review.reason_code='PROVIDER_OUTCOME_UNKNOWN'
               AND (review.state='OPEN' OR (review.state='RESOLVED' AND review.resolution_code='DELIVERY_NO_FURTHER_ATTEMPTS'))
          ORDER BY review.created_at DESC,review.id DESC
             LIMIT 1
          ) outcome_review ON true
      LEFT JOIN delivery_media dm ON dm.delivery_id=d.id AND dm.tenant_id=d.tenant_id
       AND d.content_redacted_at IS NULL
          WHERE d.tenant_id=$1 AND d.id=$2`,
        [request.principal.tenantId, id],
      )).rows[0];
      if (!delivery) throw new NotFoundException("Delivery was not found");
      const [receipts, attempts] = await Promise.all([
        client.query(
          `SELECT id,receipt_scope,receipt_status,provider_status,provider_timestamp,error_codes,safe_metadata,applied_state,created_at,
                  meta_pricing_version,meta_pricing_state,meta_pricing_reason,meta_pricing_model,meta_pricing_category,
                  meta_pricing_type,meta_pricing_billable,meta_pricing_revision_sha256
             FROM delivery_receipts
            WHERE tenant_id=$1 AND delivery_id=$2
            ORDER BY provider_timestamp,created_at,id`,
          [request.principal.tenantId, id],
        ),
        client.query(
          `SELECT id,attempt_number,state,provider_code,safe_error,started_at,finished_at
             FROM delivery_attempts
            WHERE tenant_id=$1 AND delivery_id=$2
            ORDER BY attempt_number`,
          [request.principal.tenantId, id],
        ),
      ]);
      return { ...delivery, receipts: receipts.rows, delivery_attempts: attempts.rows };
    });
  }

  @Get(":id/workspace-ticket")
  @Requires("delivery:read")
  async agentDestination(@Req() request:AuthenticatedRequest,@Param("id") id:string){
    if(!can(request.principal.role,"ticket:read"))throw new ForbiddenException("Workspace access is unavailable");
    if(!UUID.test(id))throw new BadRequestException("Delivery ID is invalid");
    const row=(await this.database.rows<DeliveryDestinationRow>(request.principal.tenantId,
      `SELECT conversation.zammad_ticket_number
         FROM delivery_outbox delivery
         JOIN bot_conversations conversation ON conversation.tenant_id=delivery.tenant_id
           AND conversation.id=delivery.bot_conversation_id
           AND conversation.zammad_ticket_id=delivery.zammad_ticket_id
        WHERE delivery.tenant_id=$1 AND delivery.id=$2
          AND delivery.bot_conversation_id IS NOT NULL
          AND delivery.zammad_ticket_id IS NOT NULL`,[request.principal.tenantId,id]))[0];
    if(!row||!/^[1-9][0-9]{0,15}$/u.test(row.zammad_ticket_number))throw new NotFoundException("The support case workspace is unavailable");
    return{ticket_number:row.zammad_ticket_number};
  }

  @Post(":id/content")
  @Header("cache-control", "private, no-store")
  @Requires("delivery:content:read")
  async content(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { purpose?: unknown; confirmation?: unknown } = {},
  ) {
    if (!UUID.test(id)) throw new BadRequestException("Delivery ID is invalid");
    if (body.purpose !== "OPERATIONAL_REVIEW" || body.confirmation !== "REVEAL") {
      throw new BadRequestException("Explicit operational-review confirmation is required");
    }
    return this.database.withTenant(request.principal.tenantId, async (client) => {
      const delivery = (
        await client.query<{
          message_body: string;
          zammad_ticket_id: string;
          zammad_article_id: string;
        }>(
          `SELECT message_body, zammad_ticket_id, zammad_article_id
             FROM delivery_outbox
            WHERE tenant_id = $1
              AND id = $2
              AND content_redacted_at IS NULL
              AND btrim(message_body)<>''`,
          [request.principal.tenantId, id],
        )
      ).rows[0];
      if (!delivery) throw new NotFoundException("Delivery was not found");
      const revealedAt = new Date().toISOString();
      await appendAudit(client, request.principal, {
        action: "delivery.content_revealed",
        targetType: "delivery",
        targetId: id,
        requestId: request.id,
        newValue: {
          purpose: "OPERATIONAL_REVIEW",
          zammad_ticket_id: delivery.zammad_ticket_id,
          zammad_article_id: delivery.zammad_article_id,
          revealed_at: revealedAt,
        },
      });
      return {
        body: delivery.message_body,
        revealed_at: revealedAt,
        expires_in_seconds: 60,
      };
    });
  }

  @Post(":id/stop-retrying")
  @Requires("delivery:retry")
  async stopRetrying(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: { confirmation?: unknown; expectedRevision?: unknown },
  ) {
    if (!UUID.test(id) || body?.confirmation!=="STOP" || typeof body.expectedRevision!=="string"
      || !body.expectedRevision || body.expectedRevision.length>80) throw new BadRequestException("Delivery confirmation is invalid");
    const key=requireOperationKey(idempotencyKey);
    const requestSha256=createHash("sha256").update(JSON.stringify({id,expectedRevision:body.expectedRevision,confirmation:"STOP"})).digest("hex");
    const result=await this.database.withTenant(request.principal.tenantId,client=>
      withOperationReceipt(client,request.principal,"DELIVERY_STOP_RETRY",key,requestSha256,String(request.id),async()=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`privacy:${request.principal.tenantId}`]);
        const previous=(await client.query<{state:string;manual_retry_allowed:boolean;revision:string}>(
          `SELECT state,manual_retry_allowed,updated_at::text AS revision FROM delivery_outbox d
           WHERE tenant_id=$1 AND id=$2 AND state='FAILED_TERMINAL' AND manual_retry_allowed
             AND content_redacted_at IS NULL
             AND lease_id IS NULL AND lease_expires_at IS NULL
             AND NOT app.delivery_has_active_privacy_target(id)
             AND NOT EXISTS (SELECT 1 FROM quarantine_records q WHERE q.tenant_id=d.tenant_id
               AND q.delivery_id=d.id AND q.reason_code='PROVIDER_OUTCOME_UNKNOWN' AND q.state='OPEN')
           FOR UPDATE`,[request.principal.tenantId,id])).rows[0];
        if(!previous || previous.revision!==body.expectedRevision) throw new ConflictException("Delivery changed or cannot stop retrying; inspect it again");
        await client.query("UPDATE delivery_outbox SET manual_retry_allowed=false,updated_at=now() WHERE tenant_id=$1 AND id=$2",[request.principal.tenantId,id]);
        await appendAudit(client,request.principal,{action:"delivery.retry_stopped",targetType:"delivery",targetId:id,
          requestId:request.id,previousValue:previous,newValue:{state:"FAILED_TERMINAL",manual_retry_allowed:false,reason:"OPERATOR_STOP_RETRY"}});
        return{id,state:"FAILED_TERMINAL",manual_retry_allowed:false};
      }));
    await this.drain.wake(request.principal.tenantId);
    return result;
  }

  @Post(":id/retry")
  @Requires("delivery:retry")
  async retry(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    if (!UUID.test(id)) throw new BadRequestException("Delivery ID is invalid");
    const key = requireOperationKey(idempotencyKey);
    const requestSha256 = createHash("sha256").update(JSON.stringify({ deliveryId: id })).digest("hex");
    const result = await this.database.withTenant(request.principal.tenantId, async (client) => {
      return withOperationReceipt(client, request.principal, "DELIVERY_RETRY", key, requestSha256, String(request.id), async () => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`privacy:${request.principal.tenantId}`]);
        const previous = (
        await client.query<{ state: string; attempts: number; safe_error: string | null; manual_retry_allowed: boolean; bot_conversation_id: string | null; direct_origin: string | null }>(
          `SELECT state, attempts, safe_error, manual_retry_allowed,bot_conversation_id,direct_origin
             FROM delivery_outbox
            WHERE tenant_id = $1
              AND id = $2
              AND (
                state = 'FAILED_RETRYABLE'
                OR (state = 'FAILED_TERMINAL' AND manual_retry_allowed)
              )
              AND content_redacted_at IS NULL
              AND NOT app.delivery_has_active_privacy_target(id)
              FOR UPDATE`,
          [request.principal.tenantId, id],
        )
      ).rows[0];
      if (!previous) throw new BadRequestException("Delivery is not retryable");
      if(previous.direct_origin==='HUMAN'&&previous.bot_conversation_id&&!await directHumanDeliveryAllowed(client,{tenantId:request.principal.tenantId,conversationId:previous.bot_conversation_id,deliveryId:id}))throw new BadRequestException('Agent reply ownership changed');
        if(previous.direct_origin==="BOT"&&previous.bot_conversation_id){
        const conversation=(await client.query<{state:string;resolution_kind:string|null}>(
          "SELECT state,resolution_kind FROM bot_conversations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [request.principal.tenantId,previous.bot_conversation_id],
        )).rows[0];
        if(!conversation||(conversation.state==="HUMAN"&&!await directControlDeliveryAllowed(client,{tenantId:request.principal.tenantId,conversationId:previous.bot_conversation_id,deliveryId:id}))||(conversation.state==="RESOLVED"&&["OPERATOR","CUSTOMER_CONFIRMED"].includes(conversation.resolution_kind??""))){
          throw new BadRequestException("Bot replies cannot be retried while a person owns or has closed the conversation");
        }
        const handoff=(await client.query<{state:string}>(
          "SELECT state FROM bot_handoff_jobs WHERE tenant_id=$1 AND conversation_id=$2 AND state IN ('QUEUED','FAILED_RETRYABLE','RUNNING') ORDER BY created_at,id FOR UPDATE",
          [request.principal.tenantId,previous.bot_conversation_id],
        )).rows[0];
        if(handoff?.state==="RUNNING")throw new BadRequestException("Bot replies cannot be retried while human handoff is running");
      }
      const disclosure = (
        await client.query<{ group_binding_id: string; disclosure_sha256: string }>(
          `SELECT group_binding_id,disclosure_sha256
             FROM group_disclosure_deliveries
            WHERE tenant_id=$1 AND delivery_id=$2
            FOR UPDATE`,
          [request.principal.tenantId,id],
        )
      ).rows[0];
      if(disclosure){
        // Serialize explicit recovery with inbound acknowledgements. If a later
        // acknowledgement already scheduled the same disclosure after this
        // known failure, retrying the old message would create a duplicate.
        await client.query(
          "SELECT 1 FROM group_bindings WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [request.principal.tenantId,disclosure.group_binding_id],
        );
        const replacement=await client.query(
          `SELECT 1 FROM group_disclosure_deliveries
            WHERE tenant_id=$1 AND group_binding_id=$2 AND disclosure_sha256=$3
              AND delivery_id<>$4 AND state IN ('QUEUED','SENT','OUTCOME_UNKNOWN')
            LIMIT 1`,
          [request.principal.tenantId,disclosure.group_binding_id,disclosure.disclosure_sha256,id],
        );
        if(replacement.rowCount){
          throw new BadRequestException("A newer delivery already carries this group disclosure");
        }
      }
      const queued = (
        await client.query<{ id: string; state: string }>(
          `UPDATE delivery_outbox
              SET state = 'QUEUED',
                  available_at = now(),
                  lease_id = NULL,
                  lease_expires_at = NULL,
                  safe_error = NULL,
                  manual_retry_allowed = false,
                  blocked_by_delivery_id = NULL,
                  updated_at = now()
            WHERE tenant_id = $1
              AND id = $2
              AND content_redacted_at IS NULL
              AND NOT app.delivery_has_active_privacy_target(id)
        RETURNING id, state`,
          [request.principal.tenantId, id],
        )
      ).rows[0]!;
      await client.query(
        `UPDATE group_disclosure_deliveries
            SET state='QUEUED',updated_at=now()
          WHERE tenant_id=$1 AND delivery_id=$2
            AND state IN ('FAILED','OUTCOME_UNKNOWN')`,
        [request.principal.tenantId,id],
      );
      await appendAudit(client, request.principal, {
        action: "delivery.retry_requested",
        targetType: "delivery",
        targetId: id,
        requestId: request.id,
        previousValue: previous,
        newValue: {
          state: queued.state,
        },
      });
        return queued;
      }, "Idempotency key was already used for another delivery retry");
    });
    await this.drain.wake(request.principal.tenantId);
    return result;
  }
}

function boundedLimit(value: string | undefined) {
  if (value === undefined) return 200;
  if (!/^[1-9][0-9]{0,2}$/u.test(value)) throw new BadRequestException("Delivery limit is invalid");
  const limit = Number(value);
  if (limit > 200) throw new BadRequestException("Delivery limit is invalid");
  return limit;
}
