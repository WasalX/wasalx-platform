import {directControlDeliveryAllowed,directHumanDeliveryAllowed} from '@wasalx/core/direct-delivery-guards';
import { createHash } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { appendAudit } from "./audit.js";
import { DatabaseService } from "./database.service.js";
import { Requires } from "./permission.guard.js";
import { RuleTestService } from "./rule-test.service.js";
import { TenantDrainService } from "./tenant-drain.service.js";
import type { AuthenticatedRequest } from "./types.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVIEW_STATES=new Set(["OPEN","REPROCESS_QUEUED","RESOLVED","DISCARDED"]);
const RESOLUTION_CODES=new Set(["REVIEWED_NO_ACTION","CONFIGURATION_CORRECTED","HANDLED_EXTERNALLY","ACTION_ALREADY_COMPLETED","ACTION_RETRY_REQUESTED","DELIVERY_CONFIRMED_SENT","DELIVERY_RETRY_REQUESTED","DELIVERY_NO_FURTHER_ATTEMPTS"]);

type ActionBody={expectedVersion?:unknown;resolutionCode?:unknown;ruleId?:unknown;normalizedReference?:unknown;confirmation?:unknown};
type ReviewRow={id:string;source_kind:"INBOUND"|"OUTBOUND";reason_code:string;state:string;connection_id:string|null;group_binding_id:string|null;group_action_execution_id:string|null;source_event_inbox_id:string|null;delivery_id:string|null;version:number;safe_summary:string;governing_client_routing_version_id?:string|null};
type ActionRequestRow={quarantine_id:string;actor_id:string;request_sha256:string;action:string;result_state:string;result_version:number};

@Controller("v1/reviews")
export class QuarantineController{
  constructor(private readonly database:DatabaseService,private readonly rules:RuleTestService,private readonly drains:TenantDrainService){}

  @Get()
  @Requires("review:read")
  list(@Req()request:AuthenticatedRequest,@Query("state")state?:string,@Query("cursor")cursor?:string){
    const filter=state?.toUpperCase();
    if(filter&&!REVIEW_STATES.has(filter))throw new BadRequestException("Review state is invalid");
    if(cursor&&!Number.isFinite(new Date(cursor).getTime()))throw new BadRequestException("Review cursor is invalid");
    return this.database.rows(request.principal.tenantId,`SELECT q.id,q.source_kind,q.reason_code,q.state,q.safe_summary,q.safe_metadata,q.version,
      q.group_action_execution_id,q.delivery_id,
      q.created_at,q.updated_at,q.resolved_at,c.name AS connection_name,c.provider,
      g.display_name AS group_name,d.zammad_ticket_id,
      CASE WHEN d.zammad_ticket_id IS NULL THEN NULL
           WHEN d.bot_conversation_id IS NOT NULL THEN direct_conversation.zammad_ticket_number
           ELSE correlated_case.zammad_ticket_number END AS ticket_number,
      d.state AS delivery_state
      FROM quarantine_records q
      LEFT JOIN connections c ON c.tenant_id=q.tenant_id AND c.id=q.connection_id
      LEFT JOIN delivery_outbox d ON d.tenant_id=q.tenant_id AND d.id=q.delivery_id
      LEFT JOIN group_bindings b ON b.tenant_id=q.tenant_id AND b.id=q.group_binding_id
      LEFT JOIN whatsapp_groups g ON g.tenant_id=q.tenant_id
        AND g.id=COALESCE(d.group_workspace_group_id,b.whatsapp_group_id)
      LEFT JOIN bot_conversations direct_conversation
        ON direct_conversation.tenant_id=d.tenant_id
       AND direct_conversation.id=d.bot_conversation_id
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
      WHERE q.tenant_id=$1 AND ($2::text IS NULL OR q.state=$2)
        AND ($3::timestamptz IS NULL OR q.created_at<$3)
      ORDER BY CASE WHEN q.state IN ('OPEN','REPROCESS_QUEUED') THEN 0 ELSE 1 END,q.created_at DESC,q.id
      LIMIT 100`,[request.principal.tenantId,filter??null,cursor??null]);
  }

  @Get(":id")
  @Requires("review:read")
  async detail(@Req()request:AuthenticatedRequest,@Param("id")id:string){
    validId(id);
    return this.database.withTenant(request.principal.tenantId,async client=>{
      const review=(await client.query(`SELECT q.id,q.source_kind,q.reason_code,q.state,q.safe_summary,q.safe_metadata,q.version,
        q.group_action_execution_id,q.delivery_id,
        q.created_at,q.updated_at,q.resolved_at,q.resolution_code,q.reprocess_event_id,
        c.name AS connection_name,c.provider,g.display_name AS group_name,
        d.zammad_ticket_id,
        CASE WHEN d.zammad_ticket_id IS NULL THEN NULL
             WHEN d.bot_conversation_id IS NOT NULL THEN direct_conversation.zammad_ticket_number
             ELSE correlated_case.zammad_ticket_number END AS ticket_number,
        d.state AS delivery_state
        FROM quarantine_records q
        LEFT JOIN connections c ON c.tenant_id=q.tenant_id AND c.id=q.connection_id
        LEFT JOIN delivery_outbox d ON d.tenant_id=q.tenant_id AND d.id=q.delivery_id
        LEFT JOIN group_bindings b ON b.tenant_id=q.tenant_id AND b.id=q.group_binding_id
        LEFT JOIN whatsapp_groups g ON g.tenant_id=q.tenant_id
          AND g.id=COALESCE(d.group_workspace_group_id,b.whatsapp_group_id)
        LEFT JOIN bot_conversations direct_conversation
          ON direct_conversation.tenant_id=d.tenant_id
         AND direct_conversation.id=d.bot_conversation_id
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
        WHERE q.tenant_id=$1 AND q.id=$2`,[request.principal.tenantId,id])).rows[0];
      if(!review)throw new BadRequestException("Review item was not found");
      const ruleOptions=(await client.query(`SELECT r.id,r.name,r.matcher_type,r.pattern,r.matcher_options,r.priority
        FROM quarantine_records q
        JOIN group_bindings b ON b.tenant_id=q.tenant_id AND b.id=q.group_binding_id
        JOIN rule_sets s ON s.tenant_id=q.tenant_id AND s.id=b.rule_set_id AND s.state='ACTIVE'
        JOIN trigger_rules r ON r.tenant_id=s.tenant_id AND r.rule_set_id=s.id AND r.enabled
        WHERE q.tenant_id=$1 AND q.id=$2 AND q.source_kind='INBOUND' AND q.group_action_execution_id IS NULL
        ORDER BY r.priority`,[request.principal.tenantId,id])).rows;
      return{...review,rule_options:ruleOptions};
    });
  }

  @Post(":id/resolve")
  @Requires("review:write")
  async resolve(@Req()request:AuthenticatedRequest,@Param("id")id:string,@Headers("idempotency-key")key:string|undefined,@Body()body:ActionBody){
    const resolution=typeof body.resolutionCode==="string"?body.resolutionCode.toUpperCase():"";
    if(!RESOLUTION_CODES.has(resolution))throw new BadRequestException("Resolution code is invalid");
    if(resolution==="ACTION_RETRY_REQUESTED"&&body.confirmation!=="RETRY")throw new BadRequestException("Type RETRY to confirm repeating an action whose outcome is unknown");
    if(resolution==="DELIVERY_RETRY_REQUESTED"&&body.confirmation!=="RETRY")throw new BadRequestException("Type RETRY to confirm retrying an unknown delivery outcome");
    if(resolution==="DELIVERY_CONFIRMED_SENT"&&body.confirmation!=="SENT")throw new BadRequestException("Confirm SENT after verifying the provider destination");
    if(resolution==="DELIVERY_NO_FURTHER_ATTEMPTS"&&body.confirmation!=="STOP")throw new BadRequestException("Type STOP to confirm no further attempts while the outcome remains unknown");
    const result=await this.terminal(request,id,key,body,"RESOLVE","RESOLVED",resolution);
    if(("wakeRequired" in result&&result.wakeRequired===true)||resolution==="ACTION_RETRY_REQUESTED")await this.drains.wakeInbound(request.principal.tenantId);
    if(("wakeOutbound" in result&&result.wakeOutbound===true)||resolution==="DELIVERY_NO_FURTHER_ATTEMPTS"||resolution==="DELIVERY_RETRY_REQUESTED")await this.drains.wake(request.principal.tenantId);
    if("wakePrivacy" in result&&result.wakePrivacy===true)await this.drains.wakePrivacy(request.principal.tenantId);
    const response={...result} as typeof result&{wakeRequired?:boolean;wakeOutbound?:boolean;wakePrivacy?:boolean};delete response.wakeRequired;delete response.wakeOutbound;delete response.wakePrivacy;return response;
  }

  @Post(":id/discard")
  @Requires("review:write")
  discard(@Req()request:AuthenticatedRequest,@Param("id")id:string,@Headers("idempotency-key")key:string|undefined,@Body()body:ActionBody){
    return this.terminal(request,id,key,body,"DISCARD","DISCARDED","DISCARDED_BY_OPERATOR");
  }

  @Post(":id/reprocess")
  @Requires("review:write")
  async reprocess(@Req()request:AuthenticatedRequest,@Param("id")id:string,@Headers("idempotency-key")key:string|undefined,@Body()body:ActionBody){
    validId(id);const idempotencyKey=validKey(key);const expectedVersion=validVersion(body.expectedVersion);
    const ruleId=typeof body.ruleId==="string"&&UUID.test(body.ruleId)?body.ruleId:"";
    const reference=cleanReference(body.normalizedReference);
    if(!ruleId)throw new BadRequestException("An active rule is required");
    const requestHash=hashRequest({action:"REPROCESS",reviewId:id,expectedVersion,ruleId,reference});
    const result=await this.database.withTenant(request.principal.tenantId,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`privacy:${request.principal.tenantId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`review:${request.principal.tenantId}:${idempotencyKey}`]);
      const duplicate=await priorAction(client,request,id,idempotencyKey,requestHash,"REPROCESS");if(duplicate)return duplicate;
      const review=(await client.query<ReviewRow>(`SELECT q.id,q.source_kind,q.reason_code,q.state,q.connection_id,q.group_binding_id,q.source_event_inbox_id,q.version,q.safe_summary,
          source.governing_client_routing_version_id
        FROM quarantine_records q
        LEFT JOIN event_inbox source ON source.tenant_id=q.tenant_id AND source.id=q.source_event_inbox_id
        WHERE q.tenant_id=$1 AND q.id=$2 FOR UPDATE OF q`,[request.principal.tenantId,id])).rows[0];
      if(!review)throw new BadRequestException("Review item was not found");
      if(review.source_kind!=="INBOUND"||!review.connection_id||!review.group_binding_id)throw new BadRequestException("Only inbound review items can be deterministically reprocessed");
      if(review.state!=="OPEN")throw new BadRequestException("Only open review items can be reprocessed");
      if(review.version!==expectedVersion)throw new BadRequestException("Review item changed; reload before acting");
      if((await client.query(`SELECT 1 FROM privacy_jobs job
        WHERE job.tenant_id=$1 AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
          AND (job.job_type='DELETE' OR (job.job_type='RETENTION_SWEEP' AND EXISTS (
            SELECT 1 FROM normalized_messages message
            JOIN privacy_job_targets target ON target.tenant_id=message.tenant_id
              AND target.job_id=job.id AND target.target_type='NORMALIZED_MESSAGE'
              AND target.target_id=message.id::text AND target.state IN ('PENDING','EXTERNAL_COMPLETE')
            WHERE message.tenant_id=job.tenant_id AND message.event_inbox_id=$2
          )))
        LIMIT 1`,[request.principal.tenantId,review.source_event_inbox_id])).rowCount){
        throw new BadRequestException("The message cannot be reprocessed while privacy processing is active");
      }
      const option=(await client.query<{id:string;name:string;matcher_type:string;pattern:string;matcher_options:Record<string,unknown>;priority:number;external_group_id:string;provider:"WAHA"|"META"}>(`SELECT r.id,r.name,r.matcher_type,r.pattern,r.matcher_options,r.priority,g.external_group_id,c.provider
        FROM quarantine_records q
        JOIN group_bindings b ON b.tenant_id=q.tenant_id AND b.id=q.group_binding_id
        JOIN whatsapp_groups g ON g.tenant_id=b.tenant_id AND g.id=b.whatsapp_group_id
        JOIN connections c ON c.tenant_id=q.tenant_id AND c.id=q.connection_id
        JOIN rule_sets s ON s.tenant_id=b.tenant_id AND s.id=b.rule_set_id AND s.state='ACTIVE'
        JOIN trigger_rules r ON r.tenant_id=s.tenant_id AND r.rule_set_id=s.id AND r.enabled
        WHERE q.tenant_id=$1 AND q.id=$2 AND r.id=$3 AND b.state='ACTIVE' AND c.state='WORKING'`,[request.principal.tenantId,id,ruleId])).rows[0];
      if(!option)throw new BadRequestException("The selected rule is not active for this group");
      const originalIdentity=(await client.query<{from_api:boolean}>(`SELECT message.from_api FROM normalized_messages message
        WHERE message.tenant_id=$1 AND message.event_inbox_id=$2
          AND message.connection_id=$3 AND message.external_group_id=$4`,
        [request.principal.tenantId,review.source_event_inbox_id,review.connection_id,option.external_group_id])).rows[0];
      if(!originalIdentity||originalIdentity.from_api)throw new BadRequestException("Original message identity is unavailable or cannot be reprocessed");
      const options=option.matcher_options??{};
      let sender:"team"|"customer"|"unknown"="unknown";
      if(options.teamSenderPolicy==="exclude"){
        const original=(await client.query<{sender:"team"|"customer"|"unknown"}>(
          `SELECT app.group_rule_sender(message.tenant_id,message.connection_id,message.external_group_id,message.external_participant_id) AS sender
             FROM normalized_messages message
            WHERE message.tenant_id=$1 AND message.event_inbox_id=$2
              AND message.connection_id=$3 AND message.external_group_id=$4`,
          [request.principal.tenantId,review.source_event_inbox_id,review.connection_id,option.external_group_id],
        )).rows[0];
        sender=original?.sender??"unknown";
        if(sender!=="customer")throw new BadRequestException("The original sender is excluded or cannot be verified for this rule");
      }
      const evaluation=this.rules.evaluate({message:reference,sender,rules:[{id:option.id,name:option.name,matcherType:option.matcher_type,pattern:option.pattern,matcherOptions:options,prefix:options.prefix,digitLength:options.digitLength,priority:option.priority,enabled:true}]});
      const match=evaluation.matches[0];
      const canonical=evaluation.normalized.toUpperCase();
      if(evaluation.matches.length!==1||!match||match.normalizedValue!==canonical)throw new BadRequestException("The corrected reference must be exactly one deterministic match for the selected rule");
      const eventId=crypto.randomUUID();const nextVersion=review.version+1;const requestedAt=new Date().toISOString();
      const payload={quarantineId:id,externalGroupId:option.external_group_id,normalizedReference:canonical,ruleId:option.id,requestedAt};
      await client.query(`INSERT INTO event_inbox
        (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,
         governing_client_routing_version_id)
        VALUES ($1,$2,$3,$4,$5,'quarantine.reprocess',$6::jsonb,$7,'ACCEPTED',$8)`,[
        eventId,request.principal.tenantId,review.connection_id,option.provider,`review:${id}:${nextVersion}`,JSON.stringify(payload),hashRequest(payload),review.governing_client_routing_version_id??null,
      ]);
      const updated=await client.query(`UPDATE quarantine_records SET state='REPROCESS_QUEUED',reprocess_event_id=$1,version=$2,updated_at=now()
        WHERE tenant_id=$3 AND id=$4 AND state='OPEN' AND version=$5`,[eventId,nextVersion,request.principal.tenantId,id,review.version]);
      if(updated.rowCount!==1)throw new BadRequestException("Review item changed; reload before acting");
      await recordAction(client,request,id,idempotencyKey,requestHash,"REPROCESS","REPROCESS_QUEUED",nextVersion);
      await appendAudit(client,request.principal,{action:"review.reprocess_queued",targetType:"quarantine_record",targetId:id,requestId:request.id,previousValue:{state:review.state,version:review.version},newValue:{state:"REPROCESS_QUEUED",version:nextVersion,rule_id:ruleId}});
      return{id,state:"REPROCESS_QUEUED",version:nextVersion,duplicate:false};
    });
    if(!result.duplicate)await this.drains.wakeInbound(request.principal.tenantId);
    return result;
  }

  private async terminal(request:AuthenticatedRequest,id:string,key:string|undefined,body:ActionBody,action:"RESOLVE"|"DISCARD",state:"RESOLVED"|"DISCARDED",resolutionCode:string){
    validId(id);const idempotencyKey=validKey(key);const expectedVersion=validVersion(body.expectedVersion);const requestHash=hashRequest({action,reviewId:id,expectedVersion,resolutionCode});
    return this.database.withTenant(request.principal.tenantId,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`privacy:${request.principal.tenantId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`review:${request.principal.tenantId}:${idempotencyKey}`]);
      const duplicate=await priorAction(client,request,id,idempotencyKey,requestHash,action);if(duplicate)return duplicate;
      const review=(await client.query<ReviewRow>(`SELECT id,source_kind,reason_code,state,connection_id,group_binding_id,
          group_action_execution_id,source_event_inbox_id,delivery_id,version,safe_summary
        FROM quarantine_records WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[request.principal.tenantId,id])).rows[0];
      if(!review)throw new BadRequestException("Review item was not found");
      if(review.state!=="OPEN")throw new BadRequestException("Only open review items can be resolved or discarded");
      if(review.version!==expectedVersion)throw new BadRequestException("Review item changed; reload before acting");
      const deliveryOutcomeResolution=review.reason_code==="PROVIDER_OUTCOME_UNKNOWN"&&Boolean(review.delivery_id);
      const groupActionResolution=review.reason_code==="GROUP_ACTION_OUTCOME_UNKNOWN"&&Boolean(review.group_action_execution_id);
      let wakeOutbound=false;let wakePrivacy=false;
      if(deliveryOutcomeResolution){
        if(action!=="RESOLVE"||!(["DELIVERY_CONFIRMED_SENT","DELIVERY_RETRY_REQUESTED","DELIVERY_NO_FURTHER_ATTEMPTS"] as string[]).includes(resolutionCode))throw new BadRequestException("Choose whether the delivery was sent or explicitly confirm a retry");
        const delivery=(await client.query<{id:string;state:string;external_message_id:string|null;content_redacted_at:string|Date|null;retryable_content:boolean;privacy_blocked:boolean;bot_conversation_id:string|null;direct_origin:string|null;lease_id:string|null;lease_expires_at:string|null}>(`SELECT delivery.id,delivery.state,delivery.external_message_id,delivery.content_redacted_at,
          delivery.bot_conversation_id,delivery.direct_origin,delivery.lease_id,delivery.lease_expires_at,
          app.delivery_has_active_privacy_target(delivery.id) AS privacy_blocked,
          (delivery.content_redacted_at IS NULL AND (btrim(delivery.message_body)<>'' OR EXISTS (
            SELECT 1 FROM delivery_media descriptor
            JOIN media_objects media ON media.tenant_id=descriptor.tenant_id AND media.id=descriptor.media_object_id
              AND media.scan_state='CLEAN' AND media.expires_at>now()
             WHERE descriptor.tenant_id=delivery.tenant_id AND descriptor.delivery_id=delivery.id AND descriptor.state='READY'
          ) OR (delivery.agent_display_name IS NOT NULL
            AND delivery.agent_identity_placement_snapshot IN ('HEADER','FOOTER')))) AS retryable_content
          FROM delivery_outbox delivery
          WHERE delivery.tenant_id=$1 AND delivery.id=$2
            AND delivery.content_redacted_at IS NULL
          FOR UPDATE OF delivery`,[request.principal.tenantId,review.delivery_id])).rows[0];
        if(!delivery||delivery.state!=="OUTCOME_UNKNOWN")throw new BadRequestException("The ambiguous delivery changed; reload before acting");
        if(resolutionCode==="DELIVERY_NO_FURTHER_ATTEMPTS"){
          if(delivery.lease_id||delivery.lease_expires_at)throw new BadRequestException("The delivery still has an active or uncertain lease; reconcile it before acting");
          wakeOutbound=true;
        }else{
        const retry=resolutionCode==="DELIVERY_RETRY_REQUESTED";
        if(retry&&delivery.privacy_blocked)throw new BadRequestException("The delivery is being removed by a privacy request and cannot be retried");
        if(retry&&delivery.direct_origin==='HUMAN'&&delivery.bot_conversation_id&&!await directHumanDeliveryAllowed(client,{tenantId:request.principal.tenantId,conversationId:delivery.bot_conversation_id,deliveryId:delivery.id}))throw new BadRequestException('Agent reply ownership changed');
        if(retry&&delivery.direct_origin==="BOT"&&delivery.bot_conversation_id){const conversation=(await client.query<{state:string;resolution_kind:string|null}>(
          "SELECT state,resolution_kind FROM bot_conversations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,delivery.bot_conversation_id],
        )).rows[0];if(!conversation||(conversation.state==="HUMAN"&&!await directControlDeliveryAllowed(client,{tenantId:request.principal.tenantId,conversationId:delivery.bot_conversation_id,deliveryId:delivery.id}))||(conversation.state==="RESOLVED"&&["OPERATOR","CUSTOMER_CONFIRMED"].includes(conversation.resolution_kind??"")))throw new BadRequestException("Bot replies cannot be retried while a person owns or has closed the conversation");const handoff=(await client.query<{state:string}>("SELECT state FROM bot_handoff_jobs WHERE tenant_id=$1 AND conversation_id=$2 AND state IN ('QUEUED','FAILED_RETRYABLE','RUNNING') ORDER BY created_at,id FOR UPDATE",[request.principal.tenantId,delivery.bot_conversation_id])).rows[0];if(handoff?.state==="RUNNING")throw new BadRequestException("Bot replies cannot be retried while human handoff is running")}
        const disclosure=(await client.query<{group_binding_id:string;disclosure_sha256:string}>(`SELECT group_binding_id,disclosure_sha256 FROM group_disclosure_deliveries
          WHERE tenant_id=$1 AND delivery_id=$2 FOR UPDATE`,[request.principal.tenantId,delivery.id])).rows[0];
        if(disclosure)await client.query("SELECT 1 FROM group_bindings WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,disclosure.group_binding_id]);
        if(retry&&!delivery.retryable_content)throw new BadRequestException("The delivery content is no longer available for retry");
        if(retry&&disclosure){
          const replacement=await client.query(`SELECT 1 FROM group_disclosure_deliveries
            WHERE tenant_id=$1 AND group_binding_id=$2 AND disclosure_sha256=$3
              AND delivery_id<>$4 AND state IN ('QUEUED','SENT','OUTCOME_UNKNOWN') LIMIT 1`,
            [request.principal.tenantId,disclosure.group_binding_id,disclosure.disclosure_sha256,delivery.id]);
          if(replacement.rowCount)throw new BadRequestException("A newer delivery already carries this group disclosure");
        }
        const nextState=retry?"QUEUED":"SENT";
        const deliveryUpdate=await client.query(`UPDATE delivery_outbox SET state=$1,available_at=CASE WHEN $1='QUEUED' THEN now() ELSE available_at END,
          lease_id=NULL,lease_expires_at=NULL,safe_error=NULL,manual_retry_allowed=false,blocked_by_delivery_id=NULL,updated_at=now()
          WHERE tenant_id=$2 AND id=$3 AND state='OUTCOME_UNKNOWN'
            AND content_redacted_at IS NULL
            AND ($1='SENT' OR NOT app.delivery_has_active_privacy_target(id))`,[nextState,request.principal.tenantId,delivery.id]);
        if(deliveryUpdate.rowCount!==1)throw new BadRequestException("The ambiguous delivery changed; reload before acting");
        await client.query(`UPDATE group_disclosure_deliveries SET state=$1,updated_at=now()
          WHERE tenant_id=$2 AND delivery_id=$3 AND state='OUTCOME_UNKNOWN'`,[retry?"QUEUED":"SENT",request.principal.tenantId,delivery.id]);
        await client.query("SELECT app.project_delivery_status($1,$2,$3,$4)",[delivery.id,nextState,delivery.external_message_id,null]);
        wakeOutbound=retry;
        wakePrivacy=!retry&&delivery.privacy_blocked;
        }
      }else if(groupActionResolution){
        if(action!=="RESOLVE"||!(["ACTION_ALREADY_COMPLETED","ACTION_RETRY_REQUESTED"] as string[]).includes(resolutionCode))throw new BadRequestException("Choose whether the external action already completed or explicitly confirm a retry");
        const execution=(await client.query<{id:string;state:string;attempts:number;action_key:string;event_status:string}>(`SELECT execution.id,execution.state,execution.attempts,execution.action_key,event.status AS event_status
          FROM group_action_executions execution
          JOIN event_inbox event ON event.tenant_id=execution.tenant_id AND event.id=execution.event_inbox_id
          WHERE execution.tenant_id=$1 AND execution.id=$2 AND execution.event_inbox_id=$3
          FOR UPDATE OF execution,event`,[request.principal.tenantId,review.group_action_execution_id,review.source_event_inbox_id])).rows[0];
         if(!execution||execution.state!=="OUTCOME_UNKNOWN")throw new BadRequestException("The ambiguous action changed; reload before acting");
         if(execution.event_status!=="FAILED_TERMINAL")throw new BadRequestException("The inbound action is still finishing; reload before acting");
         const retry=resolutionCode==="ACTION_RETRY_REQUESTED";
         if(retry&&(await client.query(`SELECT 1 FROM privacy_jobs job
           WHERE job.tenant_id=$1 AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
             AND ((job.job_type='DELETE' AND EXISTS (
                    SELECT 1 FROM event_inbox source
                     WHERE source.tenant_id=job.tenant_id AND source.id=$2
                       AND source.received_at<=job.created_at
                  ))
               OR (job.job_type='RETENTION_SWEEP' AND EXISTS (
                    SELECT 1 FROM normalized_messages message
                    JOIN privacy_job_targets target ON target.tenant_id=message.tenant_id
                      AND target.job_id=job.id AND target.target_type='NORMALIZED_MESSAGE'
                      AND target.target_id=message.id::text
                      AND target.state IN ('PENDING','EXTERNAL_COMPLETE')
                    WHERE message.tenant_id=job.tenant_id AND message.event_inbox_id=$2
                  )))
           LIMIT 1`,[request.principal.tenantId,review.source_event_inbox_id])).rowCount){
           throw new BadRequestException("The action cannot be retried while privacy processing is active");
         }
         const actionUpdate=await client.query(`UPDATE group_action_executions
          SET state=$1,safe_error=NULL,completed_at=CASE WHEN $1='SUCCEEDED' THEN completed_at END,updated_at=now()
          WHERE tenant_id=$2 AND id=$3 AND state='OUTCOME_UNKNOWN'`,[retry?"PREPARED":"SUCCEEDED",request.principal.tenantId,execution.id]);
        if(actionUpdate.rowCount!==1)throw new BadRequestException("The ambiguous action changed; reload before acting");
        const eventUpdate=retry
          ?await client.query(`UPDATE event_inbox SET status='FAILED_RETRYABLE',available_at=now(),processed_at=NULL,
             lease_id=NULL,lease_expires_at=NULL,safe_error=NULL,updated_at=now()
             WHERE tenant_id=$1 AND id=$2 AND status='FAILED_TERMINAL'`,[request.principal.tenantId,review.source_event_inbox_id])
          :await client.query(`UPDATE event_inbox SET status='PROCESSED',safe_error=NULL,updated_at=now()
             WHERE tenant_id=$1 AND id=$2 AND status='FAILED_TERMINAL'`,[request.principal.tenantId,review.source_event_inbox_id]);
        if(eventUpdate.rowCount!==1)throw new BadRequestException("The inbound action changed; reload before acting");
        if(!retry){
          const messageUpdate=await client.query(`UPDATE normalized_messages SET processing_status='COMPLETE'
            WHERE tenant_id=$1 AND event_inbox_id=$2 AND processing_status='PROCESSING'`,[request.principal.tenantId,review.source_event_inbox_id]);
          if(messageUpdate.rowCount!==1)throw new BadRequestException("The inbound message changed; reload before acting");
        }
      }else if((["ACTION_ALREADY_COMPLETED","ACTION_RETRY_REQUESTED","DELIVERY_CONFIRMED_SENT","DELIVERY_RETRY_REQUESTED","DELIVERY_NO_FURTHER_ATTEMPTS"] as string[]).includes(resolutionCode)){
        throw new BadRequestException("This resolution applies only to an external action with an unknown outcome");
      }
      const nextVersion=review.version+1;
      const updated=await client.query(`UPDATE quarantine_records SET state=$1,resolution_code=$2,resolved_by=$3,resolved_at=now(),version=$4,updated_at=now()
        WHERE tenant_id=$5 AND id=$6 AND state='OPEN' AND version=$7`,[state,resolutionCode,request.principal.userId,nextVersion,request.principal.tenantId,id,review.version]);
      if(updated.rowCount!==1)throw new BadRequestException("Review item changed; reload before acting");
      await recordAction(client,request,id,idempotencyKey,requestHash,action,state,nextVersion);
      const groupActionAudit=resolutionCode==="ACTION_RETRY_REQUESTED"
        ?{external_action_retry_requested:true}
        :{external_action_reissued:false,automatic_reply_queued:false};
      const auditAction=deliveryOutcomeResolution
        ?resolutionCode==="DELIVERY_NO_FURTHER_ATTEMPTS"?"review.delivery_no_further_attempts":resolutionCode==="DELIVERY_RETRY_REQUESTED"?"review.delivery_retry_requested":"review.delivery_confirmed_sent"
        :groupActionResolution?(resolutionCode==="ACTION_RETRY_REQUESTED"?"review.group_action_retry_requested":"review.group_action_completed_without_retry")
          :action==="RESOLVE"?"review.resolved":"review.discarded";
       const deliveryOutcomeAudit=resolutionCode==="DELIVERY_NO_FURTHER_ATTEMPTS"
         ?{provider_outcome:"OUTCOME_UNKNOWN",no_further_attempts:true,provider_reissued:false}
         :resolutionCode==="DELIVERY_RETRY_REQUESTED"
         ?{provider_reissue_requested:true,provider_reissued:false}
         :{operator_verified_sent:true,provider_reissued:false};
       await appendAudit(client,request.principal,{action:auditAction,targetType:"quarantine_record",targetId:id,requestId:request.id,previousValue:{state:review.state,version:review.version},newValue:{state,version:nextVersion,resolution_code:resolutionCode,...(groupActionResolution?groupActionAudit:{}),...(deliveryOutcomeResolution?deliveryOutcomeAudit:{})}});
      return{id,state,version:nextVersion,duplicate:false,...(groupActionResolution?{wakeRequired:resolutionCode==="ACTION_RETRY_REQUESTED"}: {}),...(wakeOutbound?{wakeOutbound:true}:{}),...(wakePrivacy?{wakePrivacy:true}:{})};
    });
  }
}

async function priorAction(client:PoolClient,request:AuthenticatedRequest,id:string,key:string,hash:string,action:string){const row=(await client.query<ActionRequestRow>(`SELECT quarantine_id,actor_id,request_sha256,action,result_state,result_version FROM quarantine_action_requests WHERE tenant_id=$1 AND idempotency_key=$2`,[request.principal.tenantId,key])).rows[0];if(!row)return null;if(row.quarantine_id!==id||row.actor_id!==request.principal.userId||row.request_sha256!==hash||row.action!==action)throw new BadRequestException("Idempotency key was already used for a different review action");return{id,state:row.result_state,version:row.result_version,duplicate:true}}
async function recordAction(client:PoolClient,request:AuthenticatedRequest,id:string,key:string,hash:string,action:string,state:string,version:number){await client.query(`INSERT INTO quarantine_action_requests (tenant_id,quarantine_id,actor_id,idempotency_key,request_sha256,action,result_state,result_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[request.principal.tenantId,id,request.principal.userId,key,hash,action,state,version])}
function validId(value:string){if(!UUID.test(value))throw new BadRequestException("Review ID is invalid")}
function validKey(value:string|undefined){if(!value||value.length<16||value.length>200||hasUnsafeControl(value))throw new BadRequestException("Idempotency-Key is required");return value}
function validVersion(value:unknown){if(!Number.isSafeInteger(value)||Number(value)<1)throw new BadRequestException("Expected review version is required");return Number(value)}
function cleanReference(value:unknown){if(typeof value!=="string")throw new BadRequestException("A corrected reference is required");const cleaned=value.normalize("NFC").trim();if(!cleaned||cleaned.length>256||hasUnsafeControl(cleaned))throw new BadRequestException("Corrected reference is invalid");return cleaned}
function hasUnsafeControl(value:string){return Array.from(value).some(character=>{const code=character.charCodeAt(0);return code<32||code===127})}
function hashRequest(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex")}
