import {assertDirectNativeBarrier} from '@wasalx/core/direct-keep-open';
import {validateDirectCloseReceipt,recordDirectCloseReceipt,type DirectCloseReceipt} from '@wasalx/core/direct-customer-close';
import { createHash } from "node:crypto";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  Post,
  Req,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { completeTicketEventExecution, enqueueTicketEventFeedback, loadEffectiveTicketEvent, pinTicketEventExecution, resolveTicketEventQuotes, ticketEventSourceHash, type TicketEventReceipt } from "@wasalx/core/ticket-event-runtime";
import { PUBLIC_ROUTE } from "./auth.guard.js";
import { DatabaseService } from "./database.service.js";
import { ServiceAuthService, type ZammadServiceRequest } from "./service-auth.service.js";

type TicketStateBody = {
  customer_close_receipt?: unknown;
  tenant_id?: string;
  ticket_id?: string | number;
  ticket_number?: string;
  state_id?: string | number;
  state_name?: string;
  state_type_name?: string;
  transitioned_at?: string;
  idempotency_key?: string;
};

type ValidTicketState = {
  customerCloseReceipt?: DirectCloseReceipt;
  ticketId: string;
  ticketNumber: string | null;
  stateId: number;
  stateName: string;
  stateTypeName: string;
  lifecycleState: "OPEN" | "RESOLVED";
  transitionedAt: string;
  idempotencyKey: string;
};

type StoredEvent = {
  id: string;
  request_sha256: string;
  processing_state: "ACCEPTED" | "APPLIED" | "IGNORED_STALE" | "NO_CORRELATION" | "BLOCKED_EFFECTS";
  correlations_updated: number;
};

type ClosedCase = {id:string;group_binding_id:string;zammad_ticket_id:string;zammad_ticket_number:string;normalized_reference:string;
  original_external_message_id:string|null;whatsapp_group_id:string;connection_id:string;external_group_id:string;group_name:string;provider:"WAHA"|"META"};
type PendingClosedCase=ClosedCase&{execution_id:string;mode:TicketEventReceipt["mode"];flow_version_id:string|null;eligible:boolean};

@Controller("internal/v1/zammad")
@SetMetadata(PUBLIC_ROUTE, true)
export class ZammadTicketStateController {
  constructor(
    private readonly database: DatabaseService,
    private readonly auth: ServiceAuthService,
  ) {}

  @Post("ticket-state")
  async ticketState(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyHeader: string | undefined,
    @Headers("x-request-id") requestIdHeader: string | undefined,
    @Body() body: TicketStateBody,
    @Req() request?: ZammadServiceRequest,
  ) {
    const claims = await this.auth.verify(authorization, "zammad:ticket-state", request);
    if (body.tenant_id !== claims.tenantId) throw new UnauthorizedException("Tenant mismatch");
    const input = validateTicketState(body, idempotencyHeader);
    const requestSha256 = ticketStateFingerprint(input);
    const requestId = cleanRequestId(requestIdHeader);

    return this.database.withTenant(claims.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[
        `zammad-ticket-state:${claims.tenantId}:${claims.instanceId}:${input.ticketId}`,
      ]);
      const active = await client.query<{ id: string }>(
        "SELECT id FROM zammad_instances WHERE tenant_id=$1 AND id=$2 AND state='WORKING'",
        [claims.tenantId, claims.instanceId],
      );
      if (!active.rows[0]) throw new UnauthorizedException("Zammad instance is not active");
      let event = (
        await client.query<StoredEvent>(
          `INSERT INTO zammad_ticket_state_events (
             tenant_id,zammad_instance_id,idempotency_key,request_sha256,
             zammad_ticket_id,zammad_ticket_number,zammad_state_id,zammad_state_name,
             zammad_state_type_name,lifecycle_state,transitioned_at,request_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (tenant_id,idempotency_key) DO NOTHING
           RETURNING id,request_sha256,processing_state,correlations_updated`,
          [
            claims.tenantId,
            claims.instanceId,
            input.idempotencyKey,
            requestSha256,
            input.ticketId,
            input.ticketNumber,
            input.stateId,
            input.stateName,
            input.stateTypeName,
            input.lifecycleState,
            input.transitionedAt,
            requestId,
          ],
        )
      ).rows[0];

      let duplicate = false;
      if (!event) {
        const existing = (
          await client.query<StoredEvent>(
            `SELECT id,request_sha256,processing_state,correlations_updated
               FROM zammad_ticket_state_events
              WHERE tenant_id=$1 AND idempotency_key=$2`,
            [claims.tenantId, input.idempotencyKey],
          )
        ).rows[0];
        if (!existing || existing.request_sha256 !== requestSha256) {
          throw new ConflictException("Idempotency key was already used for a different ticket transition");
        }
        if (existing.processing_state !== "BLOCKED_EFFECTS") return lifecycleResult(existing, true);
        // A blocked close is pending, not a terminal idempotency result. Retry
        // only the identical transition under the same ticket lock and fences.
        event = existing;
        duplicate = true;
      }

      const stale = (await client.query<{ stale: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM zammad_ticket_state_events WHERE tenant_id=$1 AND zammad_instance_id=$2
          AND zammad_ticket_id=$3 AND id<>$4
          AND (transitioned_at>$5 OR (transitioned_at=$5 AND lifecycle_state<>$6))
      ) AS stale`,[claims.tenantId,claims.instanceId,input.ticketId,event.id,input.transitionedAt,input.lifecycleState])).rows[0]?.stale === true;
      // Snapshot the actual OPEN transition under the existing native ticket lock.
      const closingCases=!stale&&input.lifecycleState==="RESOLVED"?(await client.query<ClosedCase>(`
        SELECT correlation.id,correlation.group_binding_id,correlation.zammad_ticket_id,correlation.zammad_ticket_number,
          correlation.normalized_reference,correlation.original_external_message_id,binding.whatsapp_group_id,
          destination.connection_id,destination.external_group_id,COALESCE(destination.wasalx_name,destination.display_name) AS group_name,connection.provider
        FROM case_correlations correlation
        JOIN group_bindings binding ON binding.tenant_id=correlation.tenant_id AND binding.id=correlation.group_binding_id
        JOIN whatsapp_groups destination ON destination.tenant_id=binding.tenant_id AND destination.id=binding.whatsapp_group_id
        JOIN connections connection ON connection.tenant_id=destination.tenant_id AND connection.id=destination.connection_id
        WHERE correlation.tenant_id=$1 AND correlation.zammad_ticket_id=$2 AND correlation.state='OPEN'
          AND (correlation.zammad_state_observed_at IS NULL OR correlation.zammad_state_observed_at<$3)
        ORDER BY correlation.id FOR UPDATE OF correlation`,[claims.tenantId,input.ticketId,input.transitionedAt])).rows:[];
      const updated = stale ? { rows: [], rowCount: 0 } : await client.query<{ id: string }>(
        `UPDATE case_correlations
            SET state=$1,
                zammad_state_id=$2,
                zammad_state_observed_at=$3,
                version=version+1,
                updated_at=now()
          WHERE tenant_id=$4
            AND zammad_ticket_id=$5
            AND state<>'DETACHED'
            AND (zammad_state_observed_at IS NULL OR zammad_state_observed_at<$3)
        RETURNING id`,
        [input.lifecycleState, input.stateId, input.transitionedAt, claims.tenantId, input.ticketId],
      );
      const closeSource=ticketEventSourceHash("NATIVE_STATE",claims.instanceId,event.id);
      for(const correlation of closingCases){
        if(!updated.rows.some(row=>row.id===correlation.id))continue;
        const selection=await loadEffectiveTicketEvent(client,{tenantId:claims.tenantId,whatsappGroupId:correlation.whatsapp_group_id,event:"ticket_closed"});
        await pinTicketEventExecution(client,{tenantId:claims.tenantId,correlationId:correlation.id,event:"ticket_closed",sourceSha256:closeSource,selection});
      }
      const resolvedConversations: string[] = [];
      const blockedEffects: Array<{ conversation_id: string; effects: Array<{ kind: string; id: string }> }> = [];
      let newerConversation = false;
      if (!stale && input.lifecycleState === "RESOLVED") {
        const conversations = await client.query<{ id: string; current_node_id: string; eligible: boolean }>(`
          SELECT id,current_node_id,(created_at<=$3 AND last_activity_at<=$3 AND updated_at<=$3) AS eligible
            FROM bot_conversations WHERE tenant_id=$1 AND zammad_ticket_id=$2 AND (state='HUMAN' OR ($4::uuid IS NOT NULL AND state='BOT'))
            ORDER BY id FOR UPDATE`,[claims.tenantId,input.ticketId,input.transitionedAt,input.customerCloseReceipt?.command_id??null]);
        for (const conversation of conversations.rows) {
          if (!conversation.eligible) { newerConversation = true; continue; }
          let customerConfirmed=false;
          if(input.customerCloseReceipt){
            const command=(await client.query<{state:string;conversation_id:string;native_action_snapshot:Record<string,unknown>;human_ownership_epoch:string|number;conversation_fencing_token:string|number}>(`SELECT state,conversation_id,native_action_snapshot,human_ownership_epoch,conversation_fencing_token
              FROM direct_customer_close_commands WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[claims.tenantId,input.customerCloseReceipt.command_id])).rows[0];
            if(!command||!['ATTEMPTED','OUTCOME_UNKNOWN','SUCCEEDED'].includes(command.state)||command.conversation_id!==conversation.id||
              command.native_action_snapshot?.instance_id!==claims.instanceId||command.native_action_snapshot.ticket_id!==input.ticketId)throw new ConflictException('Customer close provenance is invalid');
            validateDirectCloseReceipt(input.customerCloseReceipt,command.native_action_snapshot);
            const fence=(await client.query<{epoch:string|number;fence:string|number;customer_id:number}>(`SELECT human_ownership_epoch AS epoch,fencing_token AS fence,zammad_customer_id AS customer_id
              FROM bot_conversations WHERE tenant_id=$1 AND id=$2`,[claims.tenantId,conversation.id])).rows[0];
            if(!fence||Number(fence.epoch)!==Number(command.human_ownership_epoch)||Number(fence.fence)!==Number(command.conversation_fencing_token)||String(fence.customer_id)!==input.customerCloseReceipt.customer_id){newerConversation=true;continue;}
            customerConfirmed=true;
          }
          try{await assertDirectNativeBarrier(client,{tenantId:claims.tenantId,conversationId:conversation.id,
            ...(customerConfirmed?{excludeCloseCommandId:input.customerCloseReceipt!.command_id}:{})});}
          catch(error){if(error instanceof Error&&error.message==='DIRECT_NATIVE_EFFECT_HOLD'){blockedEffects.push({conversation_id:conversation.id,effects:[{kind:'native_pending',id:conversation.id}]});continue;}throw error;}
          const effects = await client.query<{ kind: string; id: string }>(`
            SELECT 'delivery' AS kind,id FROM delivery_outbox WHERE tenant_id=$1 AND bot_conversation_id=$2
              AND (lease_id IS NOT NULL OR (state IN ('QUEUED','CLAIMED','SENDING','FAILED_RETRYABLE') OR (state IN ('OUTCOME_UNKNOWN','BLOCKED') AND NOT app.delivery_no_further_attempts(tenant_id,id)))
                OR (state='FAILED_TERMINAL' AND manual_retry_allowed))
            UNION ALL SELECT 'action',id FROM bot_action_jobs WHERE tenant_id=$1 AND conversation_id=$2
              AND (lease_id IS NOT NULL OR state NOT IN ('SUCCEEDED','FAILED_TERMINAL'))
            UNION ALL SELECT 'handoff',id FROM bot_handoff_jobs WHERE tenant_id=$1 AND conversation_id=$2
              AND (lease_id IS NOT NULL OR state NOT IN ('SUCCEEDED','FAILED_TERMINAL'))`,[claims.tenantId,conversation.id]);
          if (effects.rows.length) { blockedEffects.push({ conversation_id: conversation.id, effects: effects.rows }); continue; }
          await client.query(`UPDATE bot_conversations SET state='RESOLVED',resolved_at=now(),resolution_kind=$3,customer_control=NULL,
            fencing_token=fencing_token+1,updated_at=now() WHERE tenant_id=$1 AND id=$2`,[claims.tenantId,conversation.id,customerConfirmed?'CUSTOMER_CONFIRMED':'OPERATOR']);
          await client.query(`INSERT INTO bot_conversation_events (tenant_id,conversation_id,event_kind,from_node_id,to_node_id,safe_metadata)
            VALUES ($1,$2,'RESOLVED',$3,$3,$4)`,[claims.tenantId,conversation.id,conversation.current_node_id,
            { native_ticket_closed: true, ticket_state_event_id: event.id,...(customerConfirmed?{cause:'CUSTOMER_CONFIRMED',customer_close_command_id:input.customerCloseReceipt!.command_id}:{}) }]);
          if(customerConfirmed)await recordDirectCloseReceipt(client,{tenantId:claims.tenantId,commandId:input.customerCloseReceipt!.command_id,receipt:input.customerCloseReceipt});
          resolvedConversations.push(conversation.id);
        }
      }
      const activeCorrelation =
        updated.rowCount === 0
          ? (
              await client.query<{ exists: boolean }>(
                `SELECT EXISTS(
                   SELECT 1 FROM case_correlations
                    WHERE tenant_id=$1 AND zammad_ticket_id=$2 AND state<>'DETACHED'
                 ) AS exists`,
                [claims.tenantId, input.ticketId],
              )
            ).rows[0]?.exists === true
          : true;
      // A BLOCKED_EFFECTS retry has already changed the correlation to RESOLVED.
      // The pinned pending receipt retains that OPEN -> RESOLVED transition/version.
      const pendingClosed=input.lifecycleState==="RESOLVED"?(await client.query<PendingClosedCase>(`
        SELECT correlation.id,correlation.group_binding_id,correlation.zammad_ticket_id,correlation.zammad_ticket_number,
          correlation.normalized_reference,correlation.original_external_message_id,binding.whatsapp_group_id,
          destination.connection_id,destination.external_group_id,COALESCE(destination.wasalx_name,destination.display_name) AS group_name,
          connection.provider,execution.id AS execution_id,execution.mode,execution.flow_version_id,
          (correlation.state='RESOLVED' AND correlation.zammad_state_observed_at=$3
            AND correlation.updated_at<=execution.created_at) AS eligible
        FROM ticket_event_executions execution
        JOIN case_correlations correlation ON correlation.tenant_id=execution.tenant_id AND correlation.id=execution.correlation_id
        JOIN group_bindings binding ON binding.tenant_id=correlation.tenant_id AND binding.id=correlation.group_binding_id
        JOIN whatsapp_groups destination ON destination.tenant_id=binding.tenant_id AND destination.id=binding.whatsapp_group_id
        JOIN connections connection ON connection.tenant_id=destination.tenant_id AND connection.id=destination.connection_id
        WHERE execution.tenant_id=$1 AND execution.event='ticket_closed' AND execution.source_sha256=$2 AND execution.state='PENDING'
        ORDER BY correlation.id FOR UPDATE OF execution,correlation`,[claims.tenantId,closeSource,input.transitionedAt])).rows:[];
      let closedFeedbackApplied=false;
      for(const correlation of pendingClosed){
        const receipt:TicketEventReceipt={id:correlation.execution_id,tenantId:claims.tenantId,correlationId:correlation.id,
          event:"ticket_closed",mode:correlation.mode,flowVersionId:correlation.flow_version_id,state:"PENDING"};
        if(stale||!correlation.eligible){await completeTicketEventExecution(client,receipt,"SKIPPED");continue;}
        if(blockedEffects.length)continue;
        if(receipt.mode==="LEGACY")await completeTicketEventExecution(client,receipt,"SKIPPED");
        else{
          const quotes=receipt.mode==="CUSTOM"?await resolveTicketEventQuotes(client,{tenantId:claims.tenantId,connectionId:correlation.connection_id,
            groupId:correlation.external_group_id,ticketId:correlation.zammad_ticket_id,originalMessageId:correlation.original_external_message_id}):{};
          await enqueueTicketEventFeedback(client,{receipt,connectionId:correlation.connection_id,groupBindingId:correlation.group_binding_id,
            ticketId:correlation.zammad_ticket_id,provider:correlation.provider,reactions:correlation.provider==="WAHA",quotes,
            variables:{"event.kind":"ticket_closed","provider.kind":correlation.provider,"group.name":correlation.group_name,
              "case.number":correlation.zammad_ticket_number,"case.reference":correlation.normalized_reference,"case.state":"RESOLVED",
              "case.transition":"CLOSED","case.previous_state":"OPEN","case.closed_at":input.transitionedAt}});
        }
        closedFeedbackApplied=true;
      }
      const processingState = blockedEffects.length ? "BLOCKED_EFFECTS" :
        (updated.rowCount ?? 0) > 0 || resolvedConversations.length > 0 || closedFeedbackApplied
          ? "APPLIED"
          : activeCorrelation || stale || newerConversation
            ? "IGNORED_STALE"
            : "NO_CORRELATION";
      const correlationsUpdated = Number(event.correlations_updated ?? 0) + (updated.rowCount ?? 0);
      const completed = (
        await client.query<StoredEvent>(
          `UPDATE zammad_ticket_state_events
              SET processing_state=$1,
                  correlations_updated=$2,
                  processed_at=now()
            WHERE tenant_id=$3 AND id=$4
          RETURNING id,request_sha256,processing_state,correlations_updated`,
          [processingState, correlationsUpdated, claims.tenantId, event.id],
        )
      ).rows[0]!;

      await client.query(
        `INSERT INTO audit_events (
           tenant_id,actor_type,actor_id,action,target_type,target_id,
           previous_value,new_value,request_id
         ) VALUES ($1,'SERVICE',$2,$3,'zammad_ticket',$4,NULL,$5,$6)`,
        [
          claims.tenantId,
          claims.instanceId,
          processingState === "APPLIED" ? "case.lifecycle_projected" : "case.lifecycle_observed",
          input.ticketId,
          {
            lifecycle_state: input.lifecycleState,
            zammad_state_id: input.stateId,
            zammad_state_name: input.stateName,
            zammad_state_type_name: input.stateTypeName,
            transitioned_at: input.transitionedAt,
            processing_state: processingState,
            correlations_updated: updated.rowCount ?? 0,
            conversations_resolved: resolvedConversations,
            blocked_effects: blockedEffects,
            newer_conversation: newerConversation,
          },
          requestId,
        ],
      );
      return lifecycleResult(completed, duplicate);
    });
  }
}

function validateTicketState(body: TicketStateBody, idempotencyHeader: string | undefined): ValidTicketState {
  const ticketId = positiveIdentifier(body.ticket_id, "Ticket ID");
  const stateId = Number(positiveIdentifier(body.state_id, "State ID"));
  const ticketNumber = body.ticket_number === undefined
    ? null
    : cleanIdentifier(body.ticket_number, 64, "Ticket number");
  const stateName = cleanText(body.state_name, 100, "State name");
  const stateTypeName = cleanText(body.state_type_name, 100, "State type name").toLowerCase();
  const transitionedAt = cleanTimestamp(body.transitioned_at);
  const idempotencyKey = cleanIdentifier(body.idempotency_key, 255, "Idempotency key");
  if (idempotencyHeader !== idempotencyKey) {
    throw new BadRequestException("Idempotency header and payload must match");
  }
  const normalizedState = stateName.toLocaleLowerCase("en");
  const lifecycleState = stateTypeName === "closed" || normalizedState === "closed" || normalizedState === "resolved"
    ? "RESOLVED"
    : "OPEN";
  let customerCloseReceipt:DirectCloseReceipt|undefined;
  if(body.customer_close_receipt!==undefined){
    const r=body.customer_close_receipt as DirectCloseReceipt;
    if(!r||r.state!=='SUCCEEDED'||typeof r.command_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(r.command_id)||
      r.ticket_id!==ticketId||r.closed_at!==transitionedAt||lifecycleState!=='RESOLVED'||typeof r.request_sha256!=='string'||!/^[a-f0-9]{64}$/u.test(r.request_sha256)||
      !Number.isSafeInteger(r.human_ownership_epoch)||r.human_ownership_epoch<0||!Number.isSafeInteger(r.conversation_fencing_token)||r.conversation_fencing_token<0)throw new BadRequestException('Customer close receipt is invalid');
    positiveIdentifier(r.article_id,'Customer close article');positiveIdentifier(r.customer_id,'Customer');
    customerCloseReceipt={state:r.state,command_id:r.command_id,ticket_id:r.ticket_id,article_id:r.article_id,request_sha256:r.request_sha256,
      closed_at:r.closed_at,customer_id:r.customer_id,human_ownership_epoch:r.human_ownership_epoch,conversation_fencing_token:r.conversation_fencing_token};
  }
  return {
    ...(customerCloseReceipt?{customerCloseReceipt}:{}),
    ticketId,
    ticketNumber,
    stateId,
    stateName,
    stateTypeName,
    lifecycleState,
    transitionedAt,
    idempotencyKey,
  };
}

function positiveIdentifier(value: unknown, label: string) {
  if (typeof value !== "number" && typeof value !== "string") throw new BadRequestException(`${label} is invalid`);
  const text = String(value);
  if (!/^[1-9][0-9]{0,15}$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new BadRequestException(`${label} is invalid`);
  }
  return text;
}

function cleanIdentifier(value: unknown, maximum: number, label: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\p{Cc}\p{Cf}\s]/u.test(value)) {
    throw new BadRequestException(`${label} is invalid`);
  }
  return value;
}

function cleanText(value: unknown, maximum: number, label: string) {
  if (typeof value !== "string") throw new BadRequestException(`${label} is invalid`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > maximum || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    throw new BadRequestException(`${label} is invalid`);
  }
  return normalized;
}

function cleanTimestamp(value: unknown) {
  if (
    typeof value !== "string"
    || value.length > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) throw new BadRequestException("Transition timestamp is invalid");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() < Date.UTC(2000, 0, 1) || date.getTime() > Date.now() + 10 * 60_000) {
    throw new BadRequestException("Transition timestamp is invalid");
  }
  // PostgreSQL preserves microseconds emitted by Zammad. Converting through a
  // JavaScript Date would truncate them and could make two rapid transitions
  // indistinguishable to the stale-event fence.
  return value;
}

function cleanRequestId(value: string | undefined) {
  if (value && value.length <= 255 && !/[\p{Cc}\p{Cf}]/u.test(value)) return value;
  return crypto.randomUUID();
}

function ticketStateFingerprint(input: ValidTicketState) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function lifecycleResult(event: StoredEvent, duplicate: boolean) {
  return {
    id: event.id,
    state: event.processing_state,
    correlations_updated: Number(event.correlations_updated),
    duplicate,
  };
}
