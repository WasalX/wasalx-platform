import { recordWhatsAppMarketingRejection } from "./whatsapp-marketing-preferences.js";
import { createHash, randomUUID } from "node:crypto";
import { applyMetaLifecycleObservation, assertMetaLifecycleAccess, classifyMetaLifecycleValue, metaLifecycleAccountId, metaLifecycleBlockingReasons, metaLifecyclePayloadSha256, MetaLifecycleError, normalizeMetaDisplayPhoneNumber, parseMetaLifecycleObservation, parseMetaLifecycleState } from "../../../packages/core/src/meta-account-relation.js";
import {assertDirectNativeBarrier,assertDirectEffectsClear} from '../../../packages/core/src/direct-keep-open.js';
import {inspectDirectKeepOpenInput,inspectDirectWelcomeResendInput,applyDirectKeepOpenInput,type CustomerControlSnapshot,type InspectedControl} from './direct-keep-open-runtime.js';
import { Pool, type PoolClient } from "pg";
import { setMetaTestPhoneTransaction } from "../../../packages/core/src/meta-test-phone-policy.js";
import type { DirectProviderMessage, ProviderMessage, ProviderMessageMutation, ProviderReceipt } from "../../../packages/connectors/src/types.js";
import { supportsBotActionInvocation } from "../../../packages/core/src/bot-action-capabilities.js";
import { advanceBotFlow, parseBotFlow, resolveBotEntryCommand, resolveBotHandoff, type BotFlowEffect } from "../../../packages/core/src/bot-flow.js";
import { clientRoutingApplies, parseClientRouting, resolveClientRoute, type ClientRoutingInput } from "../../../packages/core/src/client-routing.js";
import type { MediaRecord, MediaReservation } from "../../../packages/core/src/media.js";
import { completeTicketEventExecution, enqueueTicketEventFeedback, findTicketMessage, loadEffectiveTicketEvent, pinTicketEventExecution, resolveGroupQuote, resolveTicketEventQuotes, ticketEventSourceHash } from "../../../packages/core/src/ticket-event-runtime.js";
import { directLocationText } from "./direct-location.js";
import type { ClientRouteDecision, DirectBotContext, GroupActionExecution, GroupCommandAction, InboundContext, InboundEvent, InboundMediaContext, InboundRule } from "./types.js";
import type { BotActionResult } from "./bot-action.js";
import {readStoredQuotedCommand,resolveQuotedCommand,prepareQuotedCommand,claimQuotedCommand,type QuotedCommandInput,type QuotedCommandNativeContext} from './quoted-command.js';
import {lockTicketCommand,assertTicketCommandBarrier,ticketCommandDisposition} from '../../../packages/core/src/ticket-command-guards.js';
import { resolveMetaDirectMessage, assertMetaDirectIdentityCurrent, holdMetaIdentityChange,applyMetaIdentityTransition } from './meta-direct-identity.js';
import type { MetaIdentityChange } from '../../../packages/core/src/meta-direct-identity.js';
import { projectCoexistence } from "./meta-coexistence-repository.js";
import { applyMetaPassiveRouting } from './meta-routing.js';

type InboundRow={id:string;tenant_id:string;connection_id:string;provider:"WAHA"|"META";engine:"GOWS"|"NOWEB"|"CLOUD_API";provider_event_id:string;event_type:string;payload:Record<string,unknown>;attempts:number;received_at:string|Date;meta_webhook_app_id:string|null};
type MetaCredentialRow={provider_session_id:string;opaque_session_id:string;meta_waba_id:string|null;meta_account_proof:unknown;meta_lifecycle:unknown;meta_lifecycle_present:boolean};
type ContextRow=MetaCredentialRow&{participant_phone:string|null;binding_id:string;external_group_id:string;group_name:string;connection_name:string;connection_phone:string|null;zammad_group_id:string;default_priority:InboundContext["defaultPriority"];assignment_mode:InboundContext["assignmentMode"];fixed_owner_id:string|null;sla_policy_id:string|null;business_hours_mode:InboundContext["businessHoursMode"];business_hours_calendar_id:string|null;acknowledgement_template:string;group_disclosure_enabled:boolean;group_disclosure_message:string|null;max_identifiers:number;agent_prefix:string;media_enabled:boolean;retention_days:number;rule_set_id:string;rule_version:number;zammad_base_url:string;zammad_secret_reference:string;connection_secret_reference:string;provider_base_url:string|null;waha_worker_id:string|null;assignment_fencing_token:string|number|null;assignment_lease_expires_at:string|Date|null;rule_id:string|null;rule_name:string|null;matcher_type:InboundRule["matcherType"]|null;pattern:string|null;matcher_options:Record<string,unknown>|null;priority:number|null;enabled:boolean|null;client_routing_version_id:string|null;client_routing_definition:unknown|null};
type DirectContextRow=MetaCredentialRow&{assignment_id:string;zammad_group_id:string;connection_name:string;connection_phone:string|null;participant_name:string|null;participant_phone:string|null;zammad_base_url:string;zammad_secret_reference:string;connection_secret_reference:string;provider_base_url:string|null;waha_worker_id:string|null;assignment_fencing_token:string|number|null;assignment_lease_expires_at:string|Date|null;media_days:number;client_routing_version_id:string|null;client_routing_definition:unknown|null};
type WorkspaceMediaRow=MetaCredentialRow&{connection_secret_reference:string;provider_base_url:string|null;waha_worker_id:string|null;assignment_fencing_token:string|number|null;assignment_lease_expires_at:string|Date|null;media_days:number};
type DirectConversationRow={human_ownership_epoch:string|number;human_pause_started_at:string|Date|null;customer_control:CustomerControlSnapshot|null;zammad_customer_id:number|null;fencing_token:string|number;id:string;flow_version_id:string;state:"BOT"|"ACTION_PENDING"|"HANDOFF_PENDING"|"HUMAN"|"RESOLVED";current_node_id:string;step_count:number;variables:Record<string,string>;zammad_ticket_id:string;zammad_ticket_number:string;last_activity_at:string|Date;client_routing_version_id:string|null;client_route_status:string|null;client_id:string|null;client_route_matched_by:string|null;routing_definition:unknown|null};
type DirectChoicePromptRow={no_further_attempts?:boolean;external_message_id:string|null;state:string;created_at:string|Date;bot_content:Record<string,unknown>|null;content_redacted_at:string|Date|null};
type CorrelationRow={id:string;zammad_ticket_id:string;zammad_ticket_number:string;state:"OPEN"|"RESOLVED"|"DETACHED";generation:number};
type TicketIdentity={id:string;number:string;articleId?:string;feedbackQueued?:boolean};
type ProviderStatusRow={connection_state:string;provider_session_id:string;opaque_session_id:string;provider_state:string|null;provider_state_data:Record<string,unknown>|null;last_provider_status_at:string|Date|null;waha_worker_id:string|null};
type WahaIdentityContextRow={provider_session_id:string;opaque_session_id:string;waha_worker_id:string;base_url:string;secret_reference:string};
function metaCredentialContext(row:MetaCredentialRow){return{providerSessionId:row.provider_session_id,phoneNumberId:row.opaque_session_id,wabaId:row.meta_waba_id,proof:row.meta_account_proof,...(row.meta_lifecycle_present?{lifecycle:row.meta_lifecycle}:{})}}
type DeliveryReceiptRow={id:string;state:string;zammad_ticket_id:string;content_redacted_at?:string|Date|null;meta_direct_recipient?:unknown};
type MutationTargetRow={id:string;external_message_id:string;provider_metadata:Record<string,unknown>};
type GroupActionDefinitionRow={id:string;action_revision_id:string;action_key:string;revision:number|string;kind:"HTTP_JSON"|"NOTION_CREATE_PAGE";endpoint_url:string;http_method:"GET"|"POST";auth_scheme:"NONE"|"BEARER";secret_reference:string|null;headers:Record<string,string>;response_mapping:Record<string,string>;timeout_ms:number;max_response_bytes:number};
type GroupActionExecutionRow={id:string;state:GroupActionExecution["state"];attempts:number;action_snapshot:unknown;request_input:Record<string,string>;response_variables:Record<string,string>|null;safe_error:string|null;request_sha256:string};
export type RecordedMessageMutation={targetExternalMessageId:string;ticketIds:string[];alreadyRecorded:boolean;supersededByRevocation?:boolean};
export type DeliveryReceiptResult="APPLIED"|"RECORDED"|"DUPLICATE"|"UNMATCHED";
export type ProviderStatusObservation={opaqueSessionId:string;observedAt:string;providerState:string;connectionState:string;reason?:string};
export type WahaIdentityContext={providerSessionId:string;opaqueSessionId:string;wahaWorkerId:string;baseUrl:string;secretReference:string};
export class InboundAssociationError extends Error {
  constructor(readonly code:"QUOTE_REFERENCE_CONFLICT"|"QUOTE_TARGET_AMBIGUOUS"|"QUOTE_TARGET_UNAVAILABLE",message:string){super(message)}
}
export type QuarantineReason="IDENTIFIER_LIMIT_EXCEEDED"|"MEDIA_MALWARE_DETECTED"|"MEDIA_TOO_LARGE"|"MEDIA_TYPE_UNSAFE"|"MEDIA_DOWNLOAD_REJECTED"|"NON_RETRYABLE_REVIEW";

export class InboundRepository{
  private readonly pool:Pool;
  constructor(pool:Pool){this.pool=pool}
  async projectCoexistence(event: InboundEvent, leaseId: string, appId: string) {
    return this.tenant(event.tenantId, client => projectCoexistence(client, event, leaseId, appId));
  }
  private async tenant<T>(tenantId:string,operation:(client:PoolClient)=>Promise<T>){const client=await this.pool.connect();try{await client.query("BEGIN");await setMetaTestPhoneTransaction(client,tenantId);const result=await operation(client);await client.query("COMMIT");return result}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}}
  async applyMetaRouting(event:InboundEvent,leaseId:string,appId:string){return this.tenant(event.tenantId,client=>applyMetaPassiveRouting(client,event,leaseId,appId));}

  async storedQuotedCommand(input:QuotedCommandInput){return this.tenant(input.tenantId,client=>readStoredQuotedCommand(client,input));}
  async linkQuotedCommandReceipt(input:QuotedCommandInput,id:string){return this.tenant(input.tenantId,async client=>{
    const row=(await client.query<{native_action_snapshot:Record<string,unknown>;native_result:{article_id?:string;disposition?:string;outcome?:string}}>(
      "SELECT native_action_snapshot,native_result FROM ticket_event_executions WHERE tenant_id=$1 AND id=$2 AND event='quoted_command' AND native_action_state='SUCCEEDED'",
      [input.tenantId,id])).rows[0];
    const snapshot=row?.native_action_snapshot,articleId=row?.native_result?.article_id;
    if(!snapshot||snapshot.connection_id!==input.connectionId||snapshot.message_id!==input.messageId||snapshot.quoted_message_id!==input.quotedMessageId||!articleId||!/^[1-9][0-9]*$/u.test(articleId))throw new Error('Command transcript receipt is unavailable');
    if(ticketCommandDisposition(snapshot)==='TRANSCRIPT_ONLY_DENIED'&&(row.native_result.disposition!=='TRANSCRIPT_ONLY_DENIED'||row.native_result.outcome!=='REJECTED'))throw new Error('Denied command receipt is invalid');
    await lockTicketCommand(client,{tenantId:input.tenantId,ticketId:String(snapshot.ticket_id),instanceId:String(snapshot.instance_id)});
    const linked=await client.query("INSERT INTO message_links (tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction,quoted_external_message_id) VALUES ($1,$2,$3,$4,$5,'INBOUND',$6) ON CONFLICT (connection_id,external_message_id,zammad_ticket_id) DO UPDATE SET zammad_article_id=EXCLUDED.zammad_article_id WHERE message_links.zammad_article_id IS NULL OR message_links.zammad_article_id=EXCLUDED.zammad_article_id RETURNING id",
      [input.tenantId,input.connectionId,input.messageId,snapshot.ticket_id,articleId,input.quotedMessageId]);
    if(linked.rowCount!==1)throw new Error('Command transcript link conflicts with its immutable receipt');
  });}
  async quotedCommandCandidate(input:QuotedCommandInput){return this.tenant(input.tenantId,client=>resolveQuotedCommand(client,input));}
  async quotedCommandActor(input:QuotedCommandInput){return this.tenant(input.tenantId,async client=>(await client.query<{member_email:string|null}>(
    'SELECT member_email FROM app.ticket_command_actor($1,$2,$3,$4)',[input.tenantId,input.connectionId,input.groupId,input.participantId])).rows[0]);}
  async prepareQuotedCommand(input:QuotedCommandInput,candidate:NonNullable<Awaited<ReturnType<typeof resolveQuotedCommand>>>,native:QuotedCommandNativeContext){
    return this.tenant(input.tenantId,client=>prepareQuotedCommand(client,input,candidate,native));}
  async claimQuotedCommand(input:QuotedCommandInput,id:string){return this.tenant(input.tenantId,client=>claimQuotedCommand(client,input,id));}
  async recordQuotedCommandNative(tenantId:string,id:string,state:'SUCCEEDED'|'OUTCOME_UNKNOWN',result:unknown=null){return this.tenant(tenantId,async client=>{
    const updated=await client.query(`UPDATE ticket_event_executions SET native_action_state=$1,native_result=$2
      WHERE tenant_id=$3 AND id=$4 AND state='PENDING' AND native_action_state IN ('ATTEMPTED','OUTCOME_UNKNOWN')`,[state,state==='SUCCEEDED'?result:null,tenantId,id]);
    if(updated.rowCount!==1)throw new Error('Command action receipt changed');
  });}
  async finishQuotedCommand(input:QuotedCommandInput,prepared:Awaited<ReturnType<typeof prepareQuotedCommand>>){return this.tenant(input.tenantId,async client=>{
    const initial=await resolveQuotedCommand(client,input);if(!initial)throw new Error('Command target changed');
    await lockTicketCommand(client,{tenantId:input.tenantId,ticketId:initial.ticketId});
    const candidate=await resolveQuotedCommand(client,input);
    if(!candidate||candidate.correlationId!==initial.correlationId)throw new Error('Command target changed');
    const row=(await client.query<{state:string;native_action_state:string|null;native_action_snapshot:{generation:number;quoted_message_id:string;resolved_quoted_message_id?:string;plan:ReturnType<typeof import('../../../packages/core/src/ticket-event-flow.js').planTicketEvent>}|null}>(
      'SELECT state,native_action_state,native_action_snapshot FROM ticket_event_executions WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[input.tenantId,prepared.receipt.id])).rows[0];
    if(!row)throw new Error('Command receipt is unavailable');if(row.state!=='PENDING')return 0;
    if(row.native_action_state&&row.native_action_state!=='SUCCEEDED')throw new Error('Command native outcome is not proven');
    if(row.native_action_snapshot&&candidate.generation!==row.native_action_snapshot.generation)throw new Error('Command generation changed');
    if(row.native_action_snapshot)ticketCommandDisposition(row.native_action_snapshot);
    const pinnedQuote=row.native_action_snapshot?(row.native_action_snapshot.resolved_quoted_message_id??row.native_action_snapshot.quoted_message_id):prepared.quoteMessageId;
    if(candidate.quoteMessageId!==pinnedQuote)throw new Error('Command quote changed');
    const plan=(row.native_action_snapshot?.plan??prepared.plan) as ReturnType<typeof import('../../../packages/core/src/ticket-event-flow.js').planTicketEvent>;
    const feedback={...plan,effects:plan.effects.filter(effect=>effect.type==='send_text'||effect.type==='reaction')};
    if(!feedback.effects.length){await client.query("UPDATE ticket_event_executions SET state=$1,completed_at=now() WHERE tenant_id=$2 AND id=$3 AND state='PENDING'",[row.native_action_state==='SUCCEEDED'?'APPLIED':'SKIPPED',input.tenantId,prepared.receipt.id]);return 0;}
    const result=await enqueueTicketEventFeedback(client,{receipt:prepared.receipt,connectionId:input.connectionId,groupBindingId:input.bindingId,
      ticketId:candidate.ticketId,provider:input.provider,reactions:input.provider==='WAHA',variables:{},quotes:{},preparedPlan:feedback});return result.queued;
  });}

  async claim(tenantId:string,leaseId:string,limit=25):Promise<InboundEvent[]>{
    return this.tenant(tenantId,async client=>(await client.query<InboundRow>(`SELECT inbox.id,inbox.tenant_id,inbox.connection_id,inbox.provider,
      connection.engine,inbox.provider_event_id,inbox.event_type,inbox.payload,inbox.attempts,inbox.received_at,inbox.meta_webhook_app_id
      FROM app.claim_inbound_events($1,$2) AS inbox
      JOIN connections AS connection ON connection.tenant_id=inbox.tenant_id AND connection.id=inbox.connection_id`,[leaseId,limit])).rows.map(row=>({
      id:row.id,tenantId:row.tenant_id,connectionId:row.connection_id,provider:row.provider.toLowerCase() as "waha"|"meta",providerEngine:row.engine,
      providerEventId:row.provider_event_id,eventType:row.event_type,payload:row.payload,attempts:row.attempts,
      receivedAt:new Date(row.received_at).toISOString(),...(row.meta_webhook_app_id?{metaWebhookAppId:row.meta_webhook_app_id}:{}),
    })));
  }

  async wahaIdentityContext(event:InboundEvent,opaqueSessionId:string):Promise<WahaIdentityContext|null>{return this.tenant(event.tenantId,async client=>{
    const row=(await client.query<WahaIdentityContextRow>(`SELECT session.id AS provider_session_id,session.opaque_session_id,
             runtime.waha_worker_id,runtime.base_url,runtime.secret_reference
        FROM provider_sessions AS session
        JOIN LATERAL app.current_waha_session_runtime(session.id) AS runtime ON true
       WHERE session.tenant_id=$1 AND session.connection_id=$2
         AND session.ownership_state='ACTIVE' AND session.opaque_session_id=$3`,
      [event.tenantId,event.connectionId,opaqueSessionId])).rows[0];
    return row?{providerSessionId:row.provider_session_id,opaqueSessionId:row.opaque_session_id,wahaWorkerId:row.waha_worker_id,baseUrl:row.base_url,secretReference:row.secret_reference}:null;
  })}

  async context(event:InboundEvent,externalGroupId:string,participantId?:string):Promise<InboundContext|null>{return this.tenant(event.tenantId,async client=>{
    await client.query(`WITH selected AS (
      SELECT binding.rule_set_id
        FROM whatsapp_groups group_record
        JOIN group_bindings binding ON binding.tenant_id=group_record.tenant_id
          AND binding.whatsapp_group_id=group_record.id AND binding.state='ACTIVE'
        JOIN rule_sets rule_set ON rule_set.tenant_id=binding.tenant_id
          AND rule_set.id=binding.rule_set_id AND rule_set.state='ACTIVE'
       WHERE group_record.tenant_id=$1 AND group_record.connection_id=$2
         AND group_record.external_group_id=$3
       FOR SHARE OF group_record
    ) UPDATE event_inbox event
          SET governing_rule_set_id=selected.rule_set_id
         FROM selected
        WHERE event.tenant_id=$1 AND event.connection_id=$2 AND event.id=$4
          AND event.governing_rule_set_id IS NULL`,[event.tenantId,event.connectionId,externalGroupId,event.id]);
    const rows=(await client.query<ContextRow>(`
      SELECT b.id AS binding_id,g.external_group_id,COALESCE(g.wasalx_name,g.display_name) AS group_name,
             CASE WHEN participant.normalized_phone ~ '^\\+[1-9][0-9]{5,14}$' THEN participant.normalized_phone END AS participant_phone,
             c.name AS connection_name,c.phone_e164 AS connection_phone,b.zammad_group_id,
             b.default_priority,b.assignment_mode,b.fixed_owner_id,b.sla_policy_id,
             b.business_hours_mode,b.business_hours_calendar_id,
             b.acknowledgement_template,settings.group_disclosure_enabled,
             settings.group_disclosure_message,b.max_identifiers,b.agent_prefix,
             b.media_enabled,
             LEAST(
               b.retention_days,
               retention.media_days,
               CASE WHEN settings.group_workspace_enabled AND workspace.capture_enabled
                    THEN workspace.retention_days ELSE b.retention_days END
             ) AS retention_days,
             s.id AS rule_set_id,
             s.version AS rule_version,z.base_url AS zammad_base_url,
             z.service_secret_reference AS zammad_secret_reference,
             CASE WHEN c.provider='WAHA' THEN worker.secret_reference
                  ELSE c.secret_reference END AS connection_secret_reference,
             worker.base_url AS provider_base_url,ps.id AS provider_session_id,ps.opaque_session_id,
             ps.provider_state_data->>'wabaId' AS meta_waba_id,
             COALESCE(ps.provider_state_data->'metaAccountProof','null'::jsonb) AS meta_account_proof,
             ps.provider_state_data->'metaLifecycle' AS meta_lifecycle,ps.provider_state_data ? 'metaLifecycle' AS meta_lifecycle_present,
             ps.waha_worker_id,ps.assignment_fencing_token,
             ps.assignment_lease_expires_at,r.id AS rule_id,r.name AS rule_name,
             r.matcher_type,r.pattern,r.matcher_options,r.priority,r.enabled,
             e.governing_client_routing_version_id AS client_routing_version_id,
             routing.definition AS client_routing_definition
        FROM whatsapp_groups g
        LEFT JOIN group_workspace_participants participant
          ON participant.tenant_id=g.tenant_id AND participant.whatsapp_group_id=g.id
          AND participant.external_participant_id=$5
        JOIN connections c
          ON c.id=g.connection_id AND c.tenant_id=g.tenant_id AND c.state='WORKING'
        JOIN LATERAL (
          SELECT id,opaque_session_id,waha_worker_id,assignment_fencing_token,
                 assignment_lease_expires_at,provider_state_data
            FROM provider_sessions
           WHERE tenant_id=c.tenant_id AND connection_id=c.id
             AND ownership_state='ACTIVE' AND state='WORKING'
           ORDER BY created_at DESC LIMIT 1
        ) ps ON true
        LEFT JOIN LATERAL app.current_waha_session_runtime(ps.id) worker ON true
          AND worker.health_state='HEALTHY'
          AND worker.lifecycle_state IN ('ACTIVE','DRAINING')
          AND worker.last_heartbeat_at>=now()-make_interval(secs=>worker.heartbeat_ttl_seconds)
          AND ps.assignment_lease_expires_at>=now()
        JOIN group_bindings b
          ON b.whatsapp_group_id=g.id AND b.tenant_id=g.tenant_id AND b.state='ACTIVE'
        JOIN tenant_settings settings ON settings.tenant_id=b.tenant_id
        JOIN retention_policies retention ON retention.tenant_id=b.tenant_id
        LEFT JOIN group_workspace_settings workspace
          ON workspace.tenant_id=b.tenant_id AND workspace.whatsapp_group_id=b.whatsapp_group_id
        JOIN event_inbox e
          ON e.tenant_id=b.tenant_id AND e.id=$4 AND e.connection_id=c.id
        LEFT JOIN client_routing_versions routing
          ON routing.tenant_id=e.tenant_id AND routing.id=e.governing_client_routing_version_id
        JOIN rule_sets s
          ON s.id=e.governing_rule_set_id AND s.tenant_id=b.tenant_id
         AND s.state IN ('ACTIVE','RETIRED')
        JOIN zammad_instances z ON z.tenant_id=b.tenant_id AND z.state='WORKING'
        LEFT JOIN trigger_rules r ON r.rule_set_id=s.id AND r.tenant_id=s.tenant_id
       WHERE g.tenant_id=$1 AND g.connection_id=$2 AND g.external_group_id=$3
         AND (c.provider<>'WAHA' OR (g.sync_state='ACTIVE' AND g.last_synced_at>=now()-interval '30 minutes'))
         AND (c.provider='META' OR worker.waha_worker_id IS NOT NULL)
       ORDER BY r.priority`,[event.tenantId,event.connectionId,externalGroupId,event.id,participantId??null])).rows;
    if(!rows[0])return null;
    const first=rows[0];
    const route=pinnedClientRoute(first.client_routing_version_id,first.client_routing_definition,{connectionId:event.connectionId,whatsappGroupId:externalGroupId,entryGroupId:first.zammad_group_id});
    return{...(first.participant_phone?{participantPhone:first.participant_phone}:{}),bindingId:first.binding_id,groupId:first.external_group_id,groupName:first.group_name,connectionName:first.connection_name,...(first.connection_phone?{connectionPhone:first.connection_phone}:{}),zammadGroup:route?.zammadGroupId??first.zammad_group_id,defaultPriority:first.default_priority,assignmentMode:route?.ownerId?"fixed_owner":first.assignment_mode,fixedOwnerId:route?.ownerId??first.fixed_owner_id,slaPolicyId:first.sla_policy_id,businessHoursMode:first.business_hours_mode,businessHoursCalendarId:first.business_hours_calendar_id,acknowledgementTemplate:first.acknowledgement_template,groupDisclosureEnabled:first.group_disclosure_enabled,groupDisclosureMessage:first.group_disclosure_message,maxIdentifiers:first.max_identifiers,agentPrefix:first.agent_prefix,ruleSetId:first.rule_set_id,ruleVersion:first.rule_version,zammadBaseUrl:first.zammad_base_url,zammadSecretReference:first.zammad_secret_reference,connectionSecretReference:first.connection_secret_reference,providerBaseUrl:first.provider_base_url??undefined,providerSessionId:first.opaque_session_id,...(event.provider==="meta"?{metaCredentialContext:metaCredentialContext(first)}:{}),wahaWorkerId:first.waha_worker_id??undefined,wahaAssignmentFencingToken:first.assignment_fencing_token==null?undefined:Number(first.assignment_fencing_token),wahaAssignmentLeaseExpiresAt:first.assignment_lease_expires_at==null?undefined:new Date(first.assignment_lease_expires_at).toISOString(),mediaEnabled:first.media_enabled,retentionDays:first.retention_days,...(route?{clientRoute:route.decision}:{}),rules:rows.filter(row=>row.rule_id&&row.matcher_type&&row.pattern&&row.priority!=null).map(row=>{const options=row.matcher_options??{};const command=groupCommand(options.groupCommand);return{id:row.rule_id!,name:row.rule_name!,matcherType:row.matcher_type!,pattern:row.pattern!,prefix:typeof options.prefix==="string"?options.prefix:null,digitLength:typeof options.digitLength==="number"?options.digitLength:null,priority:row.priority!,enabled:row.enabled??true,version:first.rule_version,...(options.teamSenderPolicy==="include"||options.teamSenderPolicy==="exclude"?{teamSenderPolicy:options.teamSenderPolicy}:{}),...(command?{groupCommand:command}:{})}})};
  })}

  async messageIsWithinAdmissionWindow(event:InboundEvent,providerTimestamp:string){
    const timestamp=new Date(providerTimestamp);
    if(!Number.isFinite(timestamp.getTime()))return false;
    return this.tenant(event.tenantId,async client=>(await client.query(
      `SELECT 1 FROM webhook_routes route
        WHERE route.tenant_id=$1 AND route.connection_id=$2 AND route.provider=$3
          AND route.reservation_release_id IS NULL
          AND date_trunc('second',$4::timestamptz)>=date_trunc('second',route.admission_opened_at)`,
      [event.tenantId,event.connectionId,event.provider.toUpperCase(),timestamp.toISOString()],
    )).rowCount===1);
  }

  async originalReprocessParticipant(event:InboundEvent,groupId:string){
    return this.tenant(event.tenantId,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`privacy:${event.tenantId}`]);
      const row=(await client.query<{external_message_id:string;external_participant_id:string;participant_name:string|null;from_me:boolean;from_api:boolean}>(`
        SELECT message.external_message_id,message.external_participant_id,message.participant_name,message.from_me,message.from_api
          FROM quarantine_records review
          JOIN normalized_messages message ON message.tenant_id=review.tenant_id
            AND message.event_inbox_id=review.source_event_inbox_id AND message.connection_id=review.connection_id
         WHERE review.tenant_id=$1 AND review.id=$2 AND review.reprocess_event_id=$3
           AND review.state='REPROCESS_QUEUED' AND review.connection_id=$4 AND message.external_group_id=$5
           AND NOT EXISTS (SELECT 1 FROM privacy_jobs job WHERE job.tenant_id=review.tenant_id
             AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
             AND (job.job_type='DELETE' OR (job.job_type='RETENTION_SWEEP' AND EXISTS (
               SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=job.tenant_id
                 AND target.job_id=job.id AND target.target_type='NORMALIZED_MESSAGE'
                 AND target.target_id=message.id::text AND target.state IN ('PENDING','EXTERNAL_COMPLETE')))))`,
        [event.tenantId,event.payload.quarantineId,event.id,event.connectionId,groupId])).rows[0];
      return row?{replyToMessageId:row.external_message_id,participantId:row.external_participant_id,participantName:row.participant_name??undefined,fromMe:row.from_me,fromApi:row.from_api}:null;
    });
  }

  async groupRuleSender(event:InboundEvent,message:ProviderMessage):Promise<"team"|"customer"|"unknown"> {
    return this.tenant(event.tenantId,async client=>{
      const row=(await client.query<{sender:"team"|"customer"|"unknown"}>(
        `SELECT app.group_rule_sender($1,$2,$3,$4) AS sender`,
        [event.tenantId,event.connectionId,message.groupId,message.participantId],
      )).rows[0];
      return row?.sender??"unknown";
    });
  }

  async hasRunnableGroupBinding(event:InboundEvent,externalGroupId:string){return this.tenant(event.tenantId,async client=>(await client.query(
    `SELECT 1 FROM whatsapp_groups group_record
      JOIN connections connection ON connection.tenant_id=group_record.tenant_id AND connection.id=group_record.connection_id
      JOIN group_bindings binding ON binding.tenant_id=group_record.tenant_id AND binding.whatsapp_group_id=group_record.id AND binding.state='ACTIVE'
      JOIN event_inbox event ON event.tenant_id=group_record.tenant_id AND event.id=$4 AND event.governing_rule_set_id IS NOT NULL
     WHERE group_record.tenant_id=$1 AND group_record.connection_id=$2 AND group_record.external_group_id=$3
       AND connection.state NOT IN ('PAUSED','REVOKED')`,
    [event.tenantId,event.connectionId,externalGroupId,event.id],
  )).rowCount===1)}

  async workspaceMediaContext(event:InboundEvent,externalGroupId:string):Promise<InboundMediaContext|null>{return this.tenant(event.tenantId,async client=>{
    const row=(await client.query<WorkspaceMediaRow>(`SELECT CASE WHEN connection.provider='WAHA' THEN worker.secret_reference
             ELSE connection.secret_reference END AS connection_secret_reference,
           worker.base_url AS provider_base_url,session.id AS provider_session_id,session.opaque_session_id,
           session.provider_state_data->>'wabaId' AS meta_waba_id,
           COALESCE(session.provider_state_data->'metaAccountProof','null'::jsonb) AS meta_account_proof,
             session.provider_state_data->'metaLifecycle' AS meta_lifecycle,session.provider_state_data ? 'metaLifecycle' AS meta_lifecycle_present,
           session.waha_worker_id,
           session.assignment_fencing_token,session.assignment_lease_expires_at,
           LEAST(workspace.retention_days,retention.media_days) AS media_days
      FROM whatsapp_groups group_record
      JOIN connections connection ON connection.tenant_id=group_record.tenant_id AND connection.id=group_record.connection_id AND connection.state='WORKING'
      JOIN tenant_settings tenant ON tenant.tenant_id=group_record.tenant_id AND tenant.group_workspace_enabled
      JOIN group_workspace_settings workspace ON workspace.tenant_id=group_record.tenant_id
        AND workspace.whatsapp_group_id=group_record.id AND workspace.capture_enabled
      JOIN retention_policies retention ON retention.tenant_id=group_record.tenant_id
      JOIN LATERAL (SELECT id,opaque_session_id,waha_worker_id,assignment_fencing_token,assignment_lease_expires_at,provider_state_data
        FROM provider_sessions WHERE tenant_id=connection.tenant_id AND connection_id=connection.id
          AND ownership_state='ACTIVE' AND state='WORKING' ORDER BY created_at DESC LIMIT 1) session ON true
      LEFT JOIN LATERAL app.current_waha_session_runtime(session.id) worker ON true
        AND worker.health_state='HEALTHY' AND worker.lifecycle_state IN ('ACTIVE','DRAINING')
        AND worker.last_heartbeat_at>=now()-make_interval(secs=>worker.heartbeat_ttl_seconds)
        AND session.assignment_lease_expires_at>=now()
     WHERE group_record.tenant_id=$1 AND group_record.connection_id=$2 AND group_record.external_group_id=$3
       AND (connection.provider='META' OR worker.waha_worker_id IS NOT NULL)`,[event.tenantId,event.connectionId,externalGroupId])).rows[0];
    return row?{connectionSecretReference:row.connection_secret_reference,providerBaseUrl:row.provider_base_url??undefined,
      providerSessionId:row.opaque_session_id,...(event.provider==="meta"?{metaCredentialContext:metaCredentialContext(row)}:{}),wahaWorkerId:row.waha_worker_id??undefined,
      wahaAssignmentFencingToken:row.assignment_fencing_token==null?undefined:Number(row.assignment_fencing_token),
      wahaAssignmentLeaseExpiresAt:row.assignment_lease_expires_at==null?undefined:new Date(row.assignment_lease_expires_at).toISOString(),
      mediaEnabled:true,retentionDays:row.media_days}:null;
  })}

  async workspaceMutationContext(event:InboundEvent,externalGroupId:string):Promise<Partial<Pick<InboundContext,"zammadBaseUrl"|"zammadSecretReference">>|null>{return this.tenant(event.tenantId,async client=>{
    const row=(await client.query<{zammad_base_url:string|null;zammad_secret_reference:string|null}>(`SELECT zammad.base_url AS zammad_base_url,
             zammad.service_secret_reference AS zammad_secret_reference
        FROM whatsapp_groups group_record
        JOIN tenant_settings tenant ON tenant.tenant_id=group_record.tenant_id AND tenant.group_workspace_enabled
        JOIN group_workspace_settings workspace ON workspace.tenant_id=group_record.tenant_id
          AND workspace.whatsapp_group_id=group_record.id AND workspace.capture_enabled
        LEFT JOIN zammad_instances zammad ON zammad.tenant_id=group_record.tenant_id AND zammad.state='WORKING'
       WHERE group_record.tenant_id=$1 AND group_record.connection_id=$2 AND group_record.external_group_id=$3`,[
      event.tenantId,event.connectionId,externalGroupId,
    ])).rows[0];
    return row?{
      ...(row.zammad_base_url&&row.zammad_secret_reference
        ?{zammadBaseUrl:row.zammad_base_url,zammadSecretReference:row.zammad_secret_reference}
        :{}),
    }:null;
  })}

  async beginGroupCommandAction(
    event:InboundEvent,
    ruleId:string,
    actionId:string,
    requestInput:Record<string,string>,
    maxAttempts:number,
  ):Promise<GroupActionExecution|null>{return this.tenant(event.tenantId,async client=>{
    const requestSha256=createHash("sha256").update(JSON.stringify(Object.entries(requestInput).sort(([left],[right])=>left.localeCompare(right)))).digest("hex");
    const existing=(await client.query<GroupActionExecutionRow>(`SELECT id,state,attempts,action_snapshot,request_input,response_variables,safe_error,request_sha256
        FROM group_action_executions
       WHERE tenant_id=$1 AND event_inbox_id=$2 AND trigger_rule_id=$3 FOR UPDATE`,[event.tenantId,event.id,ruleId])).rows[0];
    if(existing){
      if(storedGroupCommandAction(existing.action_snapshot).actionId!==actionId)throw new Error("Pinned group command action changed during retry");
      if(existing.request_sha256!==requestSha256)throw new Error("Pinned group command request changed during retry");
      if(existing.state==="RUNNING"){
        const row=(await client.query<GroupActionExecutionRow>(`UPDATE group_action_executions
             SET state='OUTCOME_UNKNOWN',safe_error='Group action result is unknown and requires operator review',
                 completed_at=now(),updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND state='RUNNING'
       RETURNING id,state,attempts,action_snapshot,request_input,response_variables,safe_error,request_sha256`,[event.tenantId,existing.id])).rows[0]!;
        await auditGroupAction(client,event.tenantId,row,"bot.group_action_outcome_unknown",ruleId);
        return groupActionExecution(row);
      }
      if(existing.state==="FAILED_RETRYABLE"&&existing.attempts>=Math.min(25,Math.max(1,maxAttempts))){
        const row=(await client.query<GroupActionExecutionRow>(`UPDATE group_action_executions
             SET state='FAILED_TERMINAL',safe_error='Group action retry limit reached',completed_at=now(),updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND state='FAILED_RETRYABLE'
       RETURNING id,state,attempts,action_snapshot,request_input,response_variables,safe_error,request_sha256`,[event.tenantId,existing.id])).rows[0]!;
        await auditGroupAction(client,event.tenantId,row,"bot.group_action_failed",ruleId);
        return groupActionExecution(row);
      }
      const action=storedGroupCommandAction(existing.action_snapshot);
      if((existing.state==="PREPARED"||existing.state==="FAILED_RETRYABLE")&&action.secretReference?.startsWith(`secret://tenants/${event.tenantId}/routing/integrations/`)&&!(await client.query(
        "SELECT 1 FROM client_routing_integrations WHERE tenant_id=$1 AND secret_reference=$2 AND provider='NOTION' AND state='CONNECTED'",
        [event.tenantId,action.secretReference],
      )).rowCount){
        const row=(await client.query<GroupActionExecutionRow>(`UPDATE group_action_executions
             SET state='FAILED_TERMINAL',safe_error='Group action credential connection is unavailable',completed_at=now(),updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND state IN ('PREPARED','FAILED_RETRYABLE')
       RETURNING id,state,attempts,action_snapshot,request_input,response_variables,safe_error,request_sha256`,[event.tenantId,existing.id])).rows[0]!;
        await auditGroupAction(client,event.tenantId,row,"bot.group_action_failed",ruleId);
        return groupActionExecution(row);
      }
      return groupActionExecution(existing);
    }
    const definition=(await client.query<GroupActionDefinitionRow>(`SELECT action.id,revision.id AS action_revision_id,action.action_key,revision.revision,
             revision.kind,revision.endpoint_url,revision.http_method,revision.auth_scheme,
             revision.secret_reference,revision.headers,revision.response_mapping,
             revision.timeout_ms,revision.max_response_bytes
        FROM trigger_rules rule
        JOIN automation_action_revision_pins pin
          ON pin.tenant_id=rule.tenant_id AND pin.rule_set_id=rule.rule_set_id
        JOIN bot_action_definitions action
          ON action.tenant_id=pin.tenant_id AND action.id=pin.action_definition_id
        JOIN bot_action_revisions revision
          ON revision.tenant_id=pin.tenant_id AND revision.id=pin.action_revision_id
       WHERE rule.tenant_id=$1 AND rule.id=$2 AND action.action_key=$3
         AND revision.state='ACTIVE'
         AND (revision.secret_reference IS NULL OR revision.secret_reference NOT LIKE 'secret://tenants/'||revision.tenant_id::text||'/routing/integrations/%'
           OR EXISTS (SELECT 1 FROM client_routing_integrations integration
             WHERE integration.tenant_id=revision.tenant_id
               AND integration.secret_reference=revision.secret_reference
               AND integration.provider='NOTION' AND integration.state='CONNECTED'))`,[event.tenantId,ruleId,actionId])).rows[0];
    if(!definition||!supportsBotActionInvocation({kind:definition.kind,endpointUrl:definition.endpoint_url,httpMethod:definition.http_method,authScheme:definition.auth_scheme,secretReference:definition.secret_reference},"GROUP_COMMAND"))return null;
    const action=groupCommandAction(definition);
    const row=(await client.query<GroupActionExecutionRow>(`INSERT INTO group_action_executions
          (tenant_id,event_inbox_id,trigger_rule_id,action_definition_id,action_revision_id,action_key,action_revision,action_snapshot,request_input,request_sha256)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id,state,attempts,action_snapshot,request_input,response_variables,safe_error,request_sha256`,[
      event.tenantId,event.id,ruleId,definition.id,definition.action_revision_id,definition.action_key,Number(definition.revision),action,requestInput,requestSha256,
    ])).rows[0]!;
    return groupActionExecution(row);
  })}

  async claimGroupCommandAction(event:InboundEvent,executionId:string):Promise<GroupActionExecution|null>{return this.tenant(event.tenantId,async client=>{
    const row=(await client.query<GroupActionExecutionRow>(`UPDATE group_action_executions
         SET state='RUNNING',attempts=attempts+1,safe_error=NULL,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND state IN ('PREPARED','FAILED_RETRYABLE')
       RETURNING id,state,attempts,action_snapshot,request_input,response_variables,safe_error,request_sha256`,[event.tenantId,executionId])).rows[0];
    return row?groupActionExecution(row):null;
  })}

  async completeGroupCommandAction(event:InboundEvent,executionId:string,ruleId:string,result:BotActionResult):Promise<GroupActionExecution>{return this.tenant(event.tenantId,async client=>{
    const terminal=result.state!=="FAILED_RETRYABLE";
    const row=(await client.query<GroupActionExecutionRow>(`UPDATE group_action_executions SET state=$3,
           response_variables=$4,safe_error=$5,completed_at=CASE WHEN $6 THEN now() ELSE NULL END,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND state='RUNNING'
         RETURNING id,state,attempts,action_snapshot,request_input,response_variables,safe_error,request_sha256`,[
      event.tenantId,executionId,result.state,result.state==="SUCCEEDED"?result.variables:{},result.state==="SUCCEEDED"?null:result.safeError,terminal,
    ])).rows[0];
    if(!row)throw new Error("Group action execution fence was lost");
    if(terminal)await auditGroupAction(client,event.tenantId,row,result.state==="SUCCEEDED"?"bot.group_action_succeeded":result.state==="OUTCOME_UNKNOWN"?"bot.group_action_outcome_unknown":"bot.group_action_failed",ruleId);
    return groupActionExecution(row);
  })}

  async resolveMetaDirectMessage(event:InboundEvent,leaseId:string,message:DirectProviderMessage,appId:string){
    return this.tenant(event.tenantId,client=>resolveMetaDirectMessage(client,event,leaseId,message,appId));
  }
  async assertMetaDirectIdentityCurrent(event:InboundEvent,leaseId:string,canonical:string,appId:string){
    return this.tenant(event.tenantId,client=>assertMetaDirectIdentityCurrent(client,event,leaseId,canonical,appId));
  }
  async holdMetaIdentityChange(event:InboundEvent,leaseId:string,change:MetaIdentityChange,appId:string){
    return this.tenant(event.tenantId,client=>holdMetaIdentityChange(client,event,leaseId,change,appId));
  }
  async applyMetaIdentityTransition(event:InboundEvent,leaseId:string,change:MetaIdentityChange,appId:string){
    return this.tenant(event.tenantId,client=>applyMetaIdentityTransition(client,event,leaseId,change,appId));
  }

  async directContext(event:InboundEvent,externalChatId?:string,participantIdentifier?:string,verifiedMetaPhone?:string):Promise<DirectBotContext|null>{return this.tenant(event.tenantId,async client=>{
    const assigned=await client.query(`SELECT 1 FROM bot_assignments assignment
       WHERE assignment.tenant_id=$1 AND assignment.connection_id=$2
         AND (assignment.state='ACTIVE' OR EXISTS (
           SELECT 1 FROM bot_conversations conversation
            WHERE conversation.tenant_id=assignment.tenant_id
              AND conversation.assignment_id=assignment.id
              AND conversation.external_chat_id=$3::text
              AND conversation.state<>'RESOLVED'
         )) LIMIT 1`,[event.tenantId,event.connectionId,externalChatId??null]);
    if(!assigned.rowCount)return null;
    const row=(await client.query<DirectContextRow>(`SELECT assignment.id AS assignment_id,assignment.zammad_group_id,
             connection.name AS connection_name,connection.phone_e164 AS connection_phone,
             participant.display_name AS participant_name,participant.normalized_phone AS participant_phone,
             zammad.base_url AS zammad_base_url,zammad.service_secret_reference AS zammad_secret_reference,
             CASE WHEN connection.provider='WAHA' THEN worker.secret_reference ELSE connection.secret_reference END AS connection_secret_reference,
             worker.base_url AS provider_base_url,provider_session.id AS provider_session_id,provider_session.opaque_session_id,
             provider_session.provider_state_data->>'wabaId' AS meta_waba_id,
             COALESCE(provider_session.provider_state_data->'metaAccountProof','null'::jsonb) AS meta_account_proof,
             provider_session.provider_state_data->'metaLifecycle' AS meta_lifecycle,provider_session.provider_state_data ? 'metaLifecycle' AS meta_lifecycle_present,
             provider_session.waha_worker_id,provider_session.assignment_fencing_token,
             provider_session.assignment_lease_expires_at,retention.media_days,
             inbox.governing_client_routing_version_id AS client_routing_version_id,
             routing.definition AS client_routing_definition
        FROM bot_assignments assignment
        JOIN connections connection
          ON connection.tenant_id=assignment.tenant_id AND connection.id=assignment.connection_id
         AND connection.state='WORKING'
        JOIN LATERAL (
          SELECT session.id,session.opaque_session_id,session.waha_worker_id,
                  session.assignment_fencing_token,session.assignment_lease_expires_at,session.provider_state_data
            FROM provider_sessions session
           WHERE session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
             AND session.ownership_state='ACTIVE' AND session.state='WORKING'
           ORDER BY session.created_at DESC LIMIT 1
        ) provider_session ON true
        LEFT JOIN LATERAL app.current_waha_session_runtime(provider_session.id) worker ON true
          AND worker.health_state='HEALTHY'
          AND worker.lifecycle_state IN ('ACTIVE','DRAINING')
          AND worker.last_heartbeat_at>=now()-make_interval(secs=>worker.heartbeat_ttl_seconds)
          AND provider_session.assignment_lease_expires_at>=now()
        JOIN zammad_instances zammad ON zammad.tenant_id=assignment.tenant_id AND zammad.state='WORKING'
        JOIN retention_policies retention ON retention.tenant_id=assignment.tenant_id AND retention.state='ACTIVE'
        JOIN event_inbox inbox ON inbox.tenant_id=assignment.tenant_id AND inbox.id=$4 AND inbox.connection_id=connection.id
        LEFT JOIN client_routing_versions routing
          ON routing.tenant_id=inbox.tenant_id AND routing.id=inbox.governing_client_routing_version_id
        LEFT JOIN participant_identities participant
          ON participant.tenant_id=assignment.tenant_id AND participant.connection_id=assignment.connection_id
         AND participant.external_participant_id=$5
       WHERE assignment.tenant_id=$1 AND assignment.connection_id=$2
         AND (assignment.state='ACTIVE' OR EXISTS (
           SELECT 1 FROM bot_conversations conversation
            WHERE conversation.tenant_id=assignment.tenant_id
              AND conversation.assignment_id=assignment.id
              AND conversation.external_chat_id=$3::text
              AND conversation.state<>'RESOLVED'
         ))
         AND (connection.provider='META' OR worker.waha_worker_id IS NOT NULL)`,[event.tenantId,event.connectionId,externalChatId??null,event.id,participantIdentifier??null])).rows[0];
    if(!row)throw new Error("Direct bot dependencies are temporarily unavailable");const route=pinnedClientRoute(row.client_routing_version_id,row.client_routing_definition,{identifier:event.provider==="meta"?verifiedMetaPhone?.replace(/^\+/u,""):participantIdentifier,identifierNamespace:"whatsapp",entryGroupId:row.zammad_group_id});
    return{assignmentId:row.assignment_id,assignmentZammadGroup:row.zammad_group_id,connectionName:row.connection_name,...(row.connection_phone?{connectionPhone:row.connection_phone}:{}),...(row.participant_name?{participantName:row.participant_name}:{}),...(row.participant_phone?{participantPhone:row.participant_phone}:{}),zammadGroup:route?.zammadGroupId??row.zammad_group_id,...(route?.ownerId?{ownerId:route.ownerId}:{}),zammadBaseUrl:row.zammad_base_url,zammadSecretReference:row.zammad_secret_reference,connectionSecretReference:row.connection_secret_reference,providerBaseUrl:row.provider_base_url??undefined,providerSessionId:row.opaque_session_id,...(event.provider==="meta"?{metaCredentialContext:metaCredentialContext(row)}:{}),wahaWorkerId:row.waha_worker_id??undefined,wahaAssignmentFencingToken:row.assignment_fencing_token==null?undefined:Number(row.assignment_fencing_token),wahaAssignmentLeaseExpiresAt:row.assignment_lease_expires_at==null?undefined:new Date(row.assignment_lease_expires_at).toISOString(),mediaEnabled:true,retentionDays:row.media_days,...(route?{clientRoute:route.decision}:{})};
  })}

  async currentMetaCredentialProof(event:InboundEvent,secretReference:string,expected:NonNullable<InboundMediaContext["metaCredentialContext"]>){return this.tenant(event.tenantId,async client=>{
    const lifecycle=parseMetaLifecycleState(expected.lifecycle);assertMetaLifecycleAccess(lifecycle);
    const row=(await client.query<{meta_account_proof:unknown}>(`SELECT COALESCE(session.provider_state_data->'metaAccountProof','null'::jsonb) AS meta_account_proof
        FROM connections connection
        JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
       WHERE connection.tenant_id=$1 AND connection.id=$2 AND connection.provider='META' AND connection.state='WORKING'
         AND connection.secret_reference=$3 AND session.id=$4::uuid
         AND session.opaque_session_id=$5 AND session.ownership_state='ACTIVE' AND session.state='WORKING'
         AND (session.provider_state_data->>'wabaId') IS NOT DISTINCT FROM $6::text
         AND COALESCE(session.provider_state_data->'metaAccountProof','null'::jsonb)=$7::jsonb
         AND EXISTS (SELECT 1 FROM app.meta_lifecycle_guard(connection.id,session.id,session.opaque_session_id,session.provider_state_data->>'wabaId',$8::text,$9::bigint) guard
                       WHERE guard.revision_matches AND NOT guard.blocked AND NOT guard.unresolved_hold)`,
      [event.tenantId,event.connectionId,secretReference,expected.providerSessionId,expected.phoneNumberId,expected.wabaId,JSON.stringify(expected.proof??null),event.metaWebhookAppId??process.env.META_APP_ID??"",lifecycle?.revision??0])).rows[0];
    if(!row)throw new Error("Meta credential context changed before media retrieval");
    return row.meta_account_proof;
  })}

  async recordRuleObservations(
    event:InboundEvent,
    context:InboundContext,
    evaluatedRules:ReadonlyArray<{id:string;enabled:boolean}>,
    matches:ReadonlyArray<{ruleId:string}>,
  ){
    const counts=new Map(
      evaluatedRules.filter(rule=>rule.enabled).map(rule=>[rule.id,0]),
    );
    for(const match of matches){
      if(counts.has(match.ruleId))counts.set(match.ruleId,Math.min(2000,(counts.get(match.ruleId)??0)+1));
    }
    if(counts.size===0)return;
    return this.tenant(event.tenantId,async client=>{
      await client.query(
        `INSERT INTO rule_match_observations (
           tenant_id,event_inbox_id,group_binding_id,rule_set_id,
           trigger_rule_id,matched_reference_count,evaluated_at
         )
         SELECT $1,$2,$3,$4,observation.rule_id,observation.match_count,now()
           FROM unnest($5::uuid[],$6::integer[]) AS observation(rule_id,match_count)
         ON CONFLICT (tenant_id,event_inbox_id,trigger_rule_id) DO NOTHING`,
        [event.tenantId,event.id,context.bindingId,context.ruleSetId,[...counts.keys()],[...counts.values()]],
      );
    });
  }

  async renewWahaWorkerAssignment<T extends InboundMediaContext>(event:InboundEvent,context:T):Promise<T>{if(event.provider!=="waha")return context;if(!context.wahaWorkerId||context.wahaAssignmentFencingToken===undefined||!context.providerBaseUrl)throw new Error("WAHA worker assignment is unavailable for inbound media");return this.tenant(event.tenantId,async client=>{const row=(await client.query<{waha_worker_id:string;base_url:string;secret_reference:string;assignment_fencing_token:string|number;assignment_lease_expires_at:string|Date}>(`SELECT waha_worker_id,base_url,secret_reference,assignment_fencing_token,assignment_lease_expires_at FROM app.renew_waha_session_assignment((SELECT id FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND opaque_session_id=$3 AND ownership_state='ACTIVE' AND state='WORKING'),$4,$5,interval '90 seconds')`,[event.tenantId,event.connectionId,context.providerSessionId,context.wahaWorkerId,context.wahaAssignmentFencingToken])).rows[0];if(!row||row.waha_worker_id!==context.wahaWorkerId||Number(row.assignment_fencing_token)!==context.wahaAssignmentFencingToken||row.base_url!==context.providerBaseUrl||row.secret_reference!==context.connectionSecretReference)throw new Error("WAHA worker assignment changed before inbound media download");return{...context,wahaAssignmentLeaseExpiresAt:new Date(row.assignment_lease_expires_at).toISOString()}})}

  async findByHash(tenantId:string,sha256:string):Promise<MediaRecord|null>{return this.tenant(tenantId,async client=>{const row=(await client.query<{id:string;tenant_id:string;sha256:string;object_key:string;mime_type:string;byte_size:string|number;scan_state:string;expires_at:string|Date;created_at:string|Date}>(`SELECT media.id,media.tenant_id,media.sha256,media.object_key,media.mime_type,media.byte_size,media.scan_state,media.expires_at,media.created_at FROM media_objects media WHERE media.tenant_id=$1 AND media.sha256=$2 AND media.scan_state='CLEAN' AND NOT EXISTS (SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=media.tenant_id AND target.target_type='MEDIA_OBJECT' AND target.target_id=media.id::text AND target.state IN ('PENDING','EXTERNAL_COMPLETE','COMPLETE'))`,[tenantId,sha256])).rows[0];return row?mediaRecord(row):null})}

  async reserve(record:MediaRecord):Promise<MediaReservation>{return this.tenant(record.tenantId,async client=>{const row=(await client.query<{id:string;tenant_id:string;sha256:string;object_key:string;mime_type:string;byte_size:string|number;scan_state:"STAGING"|"CLEAN";expires_at:string|Date;created_at:string|Date}>(`INSERT INTO media_objects AS media (id,tenant_id,sha256,object_key,mime_type,byte_size,scan_state,expires_at,created_at) SELECT $1,$2,$3,$4,$5,$6,'STAGING',$7,$8 WHERE NOT EXISTS (SELECT 1 FROM privacy_jobs job WHERE job.tenant_id=$2 AND job.job_type='DELETE' AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')) ON CONFLICT (tenant_id,sha256) DO UPDATE SET expires_at=GREATEST(media.expires_at,EXCLUDED.expires_at) WHERE NOT EXISTS (SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=media.tenant_id AND target.target_type='MEDIA_OBJECT' AND target.target_id=media.id::text AND target.state IN ('PENDING','EXTERNAL_COMPLETE','COMPLETE')) RETURNING id,tenant_id,sha256,object_key,mime_type,byte_size,scan_state,expires_at,created_at`,[record.id,record.tenantId,record.sha256,record.objectKey,record.mimeType,record.byteSize,record.expiresAt,record.createdAt])).rows[0];if(!row||!['STAGING','CLEAN'].includes(row.scan_state))throw new Error("Media reservation could not be persisted");return mediaReservation(row)})}

  async promote(record:MediaRecord):Promise<MediaRecord>{return this.tenant(record.tenantId,async client=>{const row=(await client.query<{id:string;tenant_id:string;sha256:string;object_key:string;mime_type:string;byte_size:string|number;scan_state:string;expires_at:string|Date;created_at:string|Date}>(`UPDATE media_objects media SET scan_state='CLEAN',expires_at=GREATEST(media.expires_at,$1::timestamptz) WHERE media.tenant_id=$2 AND media.sha256=$3 AND media.object_key=$4 AND media.mime_type=$5 AND media.byte_size=$6 AND media.scan_state IN ('STAGING','CLEAN') AND NOT EXISTS (SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=media.tenant_id AND target.target_type='MEDIA_OBJECT' AND target.target_id=media.id::text AND target.state IN ('PENDING','EXTERNAL_COMPLETE','COMPLETE')) RETURNING media.id,media.tenant_id,media.sha256,media.object_key,media.mime_type,media.byte_size,media.scan_state,media.expires_at,media.created_at`,[record.expiresAt,record.tenantId,record.sha256,record.objectKey,record.mimeType,record.byteSize])).rows[0];if(!row)throw new Error("Media reservation could not be promoted");return mediaRecord(row)})}

  async mediaAssetUpload(tenantId:string,assetId:string){return this.tenant(tenantId,async client=>{const row=(await client.query<{filename:string;mime_type:string;byte_size:string|number;declared_sha256:string;media_days:string|number}>(`SELECT asset.filename,asset.mime_type,asset.byte_size,asset.declared_sha256,policy.media_days FROM bot_media_assets asset
      JOIN retention_policies policy ON policy.tenant_id=asset.tenant_id
      WHERE asset.tenant_id=$1 AND asset.id=$2 AND asset.state='UPLOADING' AND asset.upload_expires_at>=now()`,[tenantId,assetId])).rows[0];
    if(!row)throw new Error("Media upload is unavailable or expired");return{filename:row.filename,mimeType:row.mime_type,byteSize:Number(row.byte_size),retentionDays:Number(row.media_days),contentSha256:row.declared_sha256}})}

  async completeMediaAssetUpload(tenantId:string,assetId:string,mediaObjectId:string){return this.tenant(tenantId,async client=>{const updated=await client.query<{id:string;mime_type:string;byte_size:string|number}>(`UPDATE bot_media_assets asset SET state='READY',media_object_id=media.id,content_sha256=media.sha256,updated_at=now()
      FROM media_objects media WHERE asset.tenant_id=$2 AND asset.id=$3 AND asset.state='UPLOADING'
        AND media.tenant_id=asset.tenant_id AND media.id=$1 AND media.scan_state='CLEAN'
        AND NOT EXISTS (SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=media.tenant_id AND target.target_type='MEDIA_OBJECT' AND target.target_id=media.id::text AND target.state IN ('PENDING','EXTERNAL_COMPLETE','COMPLETE'))
      RETURNING asset.id,asset.mime_type,asset.byte_size`,[mediaObjectId,tenantId,assetId]);if(updated.rowCount!==1)throw new Error("Media upload completion fence was lost");const asset=updated.rows[0]!;await client.query(`INSERT INTO audit_events
        (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
        VALUES ($1,'SYSTEM','connector-worker','bot_media_asset.upload_completed','bot_media_asset',$2,
          jsonb_build_object('state','READY','result_code','SCAN_CLEAN','mime_type',$3::text,'byte_size',$4::bigint),$5)`,[
      tenantId,asset.id,asset.mime_type,asset.byte_size,`bot-media:${asset.id}:ready`,
    ])})}

  async failMediaAssetUpload(tenantId:string,assetId:string,safeError:string){return this.tenant(tenantId,async client=>{const updated=await client.query<{id:string;mime_type:string;byte_size:string|number}>(`UPDATE bot_media_assets SET state='FAILED',filename='[removed]',request_sha256=NULL,declared_sha256=NULL,safe_error=$1,updated_at=now()
      WHERE tenant_id=$2 AND id=$3 AND state='UPLOADING' RETURNING id,mime_type,byte_size`,[safeError.slice(0,500),tenantId,assetId]);const asset=updated.rows[0];if(asset)await client.query(`INSERT INTO audit_events
        (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
        VALUES ($1,'SYSTEM','connector-worker','bot_media_asset.upload_failed','bot_media_asset',$2,
          jsonb_build_object('state','FAILED','result_code','UPLOAD_REJECTED','mime_type',$3::text,'byte_size',$4::bigint),$5)`,[
      tenantId,asset.id,asset.mime_type,asset.byte_size,`bot-media:${asset.id}:failed`,
    ])})}

  async linkMediaObject(event:InboundEvent,message:ProviderMessage,mediaObjectId:string,filename:string,mimeType:string){return this.tenant(event.tenantId,async client=>{const result=await client.query(`UPDATE normalized_messages message SET provider_metadata=message.provider_metadata || jsonb_build_object('media_object_id',$1::text,'media_scan_state','CLEAN','fileName',$2::text,'mimeType',$3::text) WHERE message.tenant_id=$4 AND message.event_inbox_id=$5 AND message.connection_id=$6 AND message.external_message_id=$7 AND EXISTS (SELECT 1 FROM media_objects media WHERE media.tenant_id=message.tenant_id AND media.id=$1 AND media.scan_state='CLEAN' AND NOT EXISTS (SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=media.tenant_id AND target.target_type='MEDIA_OBJECT' AND target.target_id=media.id::text AND target.state IN ('PENDING','EXTERNAL_COMPLETE','COMPLETE')))`,[mediaObjectId,filename,mimeType,event.tenantId,event.id,event.connectionId,message.messageId]);if(result.rowCount!==1)throw new Error("Normalized message media link could not be persisted")})}

  async normalize(event:InboundEvent,message:ProviderMessage,captureOnly=false){return this.tenant(event.tenantId,async client=>{const inserted=await client.query<{id:string}>(`WITH capture AS (
      SELECT EXISTS (
        SELECT 1 FROM tenant_settings tenant
        JOIN whatsapp_groups group_record ON group_record.tenant_id=tenant.tenant_id
          AND group_record.connection_id=$3 AND group_record.external_group_id=$5
        JOIN group_workspace_settings workspace ON workspace.tenant_id=group_record.tenant_id
          AND workspace.whatsapp_group_id=group_record.id
        WHERE tenant.tenant_id=$1 AND tenant.group_workspace_enabled AND workspace.capture_enabled
          AND $12::timestamptz>=workspace.enabled_at
      ) AS enabled
    ) INSERT INTO normalized_messages
      (tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,
       participant_name,message_text,quoted_external_message_id,from_api,from_me,provider_timestamp,
       provider_metadata,history_captured_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             CASE WHEN capture.enabled THEN now() END
        FROM capture WHERE NOT $14 OR capture.enabled
      ON CONFLICT (connection_id,external_message_id) DO NOTHING RETURNING id`,[event.tenantId,event.id,event.connectionId,message.messageId,message.groupId,message.participantId,message.participantName??null,message.text,message.quotedMessageId??null,message.fromApi,message.fromMe??false,message.timestamp,{...(message.media??{}),eventKind:message.eventKind??"MESSAGE"},captureOnly]);if(inserted.rows[0]){if(!message.fromMe)await upsertParticipantName(client,event,message.participantId,message.participantName,message.participantPhone,1);return"new" as const;}const existing=(await client.query<{event_inbox_id:string;processing_status:string}>("SELECT event_inbox_id,processing_status FROM normalized_messages WHERE tenant_id=$1 AND connection_id=$2 AND external_message_id=$3",[event.tenantId,event.connectionId,message.messageId])).rows[0];if(!existing)return"skipped" as const;return existing.event_inbox_id===event.id&&existing.processing_status==="PROCESSING"?"resume" as const:"duplicate" as const})}

  async linkZammadCustomer(event:InboundEvent,message:ProviderMessage,customer:{id:number;login:string}){return this.tenant(event.tenantId,async client=>{
    if(!message.fromMe)await upsertParticipantName(client,event,message.participantId,message.participantName,message.participantPhone,1);
    const result=await client.query("UPDATE normalized_messages SET provider_metadata=provider_metadata || jsonb_build_object('zammad_customer_id',$1::bigint,'zammad_customer_login',$2::text) WHERE tenant_id=$3 AND event_inbox_id=$4 AND connection_id=$5 AND external_message_id=$6",[customer.id,customer.login,event.tenantId,event.id,event.connectionId,message.messageId]);
    if(result.rowCount!==1)throw new Error("Normalized message customer link could not be persisted");
  })}

  async ticketsForQuotedMessage(event:InboundEvent,quotedMessageId:string,context:InboundContext,references:string[]=[]){
    return this.tenant(event.tenantId,async client=>{
      const resolved=await resolveGroupQuote(client,{tenantId:event.tenantId,connectionId:event.connectionId,groupId:context.groupId,requested:quotedMessageId});
      if(resolved.ambiguous)throw new InboundAssociationError("QUOTE_TARGET_AMBIGUOUS","The quoted message has more than one identity in this group.");
      const canonical=resolved.messageId??quotedMessageId;
      const rows=(await client.query<{zammad_ticket_id:string;normalized_reference:string}>(
        `SELECT DISTINCT correlation.zammad_ticket_id,correlation.normalized_reference
           FROM message_links link
           JOIN case_correlations correlation
             ON correlation.tenant_id=link.tenant_id AND correlation.zammad_ticket_id=link.zammad_ticket_id
           JOIN group_bindings binding
             ON binding.tenant_id=correlation.tenant_id AND binding.id=correlation.group_binding_id
           JOIN whatsapp_groups group_record
             ON group_record.tenant_id=binding.tenant_id AND group_record.id=binding.whatsapp_group_id
          WHERE link.tenant_id=$1 AND link.connection_id=$2 AND link.external_message_id=$3
            AND correlation.group_binding_id=$4 AND correlation.state IN ('OPEN','RESOLVED')
            AND group_record.connection_id=$2 AND group_record.external_group_id=$5
          ORDER BY correlation.zammad_ticket_id,correlation.normalized_reference`,
        [event.tenantId,event.connectionId,canonical,context.bindingId,context.groupId],
      )).rows;
      if(rows.length>1)throw new InboundAssociationError("QUOTE_TARGET_AMBIGUOUS","The quoted message belongs to more than one case. Review it before routing.");
      if(rows[0]&&references.some(reference=>reference!==rows[0].normalized_reference))
        throw new InboundAssociationError("QUOTE_REFERENCE_CONFLICT","The quoted case and message reference disagree. Review it before routing.");
      if(rows[0]&&await findTicketMessage(client,{tenantId:event.tenantId,connectionId:event.connectionId,groupId:context.groupId,
        ticketId:rows[0].zammad_ticket_id,requested:quotedMessageId})!==canonical)
        throw new InboundAssociationError("QUOTE_TARGET_UNAVAILABLE","The quoted message is unavailable in this ticket.");
      if(rows.length===0){
        const known=(await client.query<{known:boolean}>(
          "SELECT EXISTS (SELECT 1 FROM message_links WHERE tenant_id=$1 AND connection_id=$2 AND external_message_id=$3) AS known",
          [event.tenantId,event.connectionId,canonical],
        )).rows[0]?.known===true;
        if(known)throw new InboundAssociationError("QUOTE_TARGET_UNAVAILABLE","The quoted case is detached or unavailable in this group.");
      }
      return rows.map(row=>row.zammad_ticket_id);
    });
  }

  async ticketsForCaseNumbers(event:InboundEvent,context:InboundContext,caseNumbers:string[]){
    if(caseNumbers.length===0)return[];
    if(caseNumbers.length>20||caseNumbers.some(value=>!/^\d{1,32}$/u.test(value)))throw new Error("Case number lookup is invalid");
    return this.tenant(event.tenantId,async client=>(await client.query<{zammad_ticket_id:string}>(
      `SELECT DISTINCT zammad_ticket_id
         FROM case_correlations
        WHERE tenant_id=$1
          AND group_binding_id=$2
          AND zammad_ticket_number=ANY($3::text[])
          AND state IN ('OPEN','RESOLVED')
        ORDER BY zammad_ticket_id`,
      [event.tenantId,context.bindingId,caseNumbers],
    )).rows.map(row=>row.zammad_ticket_id));
  }

  async recordMessageMutation(
    event:InboundEvent,
    mutation:ProviderMessageMutation,
    workspaceOnly=false,
  ):Promise<RecordedMessageMutation|null>{
    if(
      event.provider!=="waha"||mutation.provider!=="waha"||mutation.connectionId!==event.connectionId
      ||mutation.targetMessageIdCandidates.length<1||mutation.targetMessageIdCandidates.length>4
      ||mutation.targetMessageIdCandidates.some(value=>value.length<1||value.length>1024||hasUnsafeMutationValue(value))
      ||mutation.groupId.length<1||mutation.groupId.length>512||hasUnsafeMutationValue(mutation.groupId)
    ){
      throw new Error("Provider message mutation candidates are invalid");
    }
    return this.tenant(event.tenantId,async client=>{
      const targets=(await client.query<MutationTargetRow>(
        `SELECT message.id,message.external_message_id,message.provider_metadata
           FROM normalized_messages message
          WHERE message.tenant_id=$1
            AND message.connection_id=$2
            AND message.external_group_id=$3
            AND message.external_message_id=ANY($4::text[])
            AND (NOT $5 OR (message.history_captured_at IS NOT NULL AND EXISTS (
              SELECT 1 FROM whatsapp_groups group_record
              JOIN tenant_settings tenant ON tenant.tenant_id=group_record.tenant_id
              JOIN group_workspace_settings workspace ON workspace.tenant_id=group_record.tenant_id
                AND workspace.whatsapp_group_id=group_record.id
              WHERE group_record.tenant_id=message.tenant_id
                AND group_record.connection_id=message.connection_id
                AND group_record.external_group_id=message.external_group_id
                AND tenant.group_workspace_enabled AND workspace.capture_enabled
                AND message.provider_timestamp>=workspace.enabled_at
            )))
          ORDER BY message.external_message_id
          LIMIT 2
          FOR UPDATE`,
        [event.tenantId,event.connectionId,mutation.groupId,mutation.targetMessageIdCandidates,workspaceOnly],
      )).rows;
      if(targets.length===0)return null;
      if(targets.length!==1)throw new Error("Provider message mutation target is ambiguous");
      const target=targets[0]!;
      const current=Array.isArray(target.provider_metadata?.mutations)
        ? target.provider_metadata.mutations.filter(isStoredMutation).slice(-20)
        : [];
      const alreadyRecorded=current.some(item=>item.event_id===event.providerEventId);
      const supersededByRevocation=mutation.kind==="EDITED"&&current.some(item=>item.kind==="REVOKED");
      if(!alreadyRecorded&&!supersededByRevocation){
        const entry={
          event_id:event.providerEventId,
          kind:mutation.kind,
          action_message_id:mutation.actionMessageId,
          target_message_id:target.external_message_id,
          participant_id:mutation.participantId,
          observed_at:mutation.timestamp,
          ...(mutation.replacementText===undefined?{}:{replacement_text:mutation.replacementText}),
        };
        const updated=await client.query(
          `UPDATE normalized_messages
              SET provider_metadata=jsonb_set(
                    provider_metadata,
                    '{mutations}',
                    $1::jsonb,
                    true
                  )
            WHERE tenant_id=$2 AND id=$3`,
          [JSON.stringify([...current.slice(-19),entry]),event.tenantId,target.id],
        );
        if(updated.rowCount!==1)throw new Error("Provider message mutation could not be persisted");
      }
      const ticketIds=(await client.query<{zammad_ticket_id:string}>(
        `SELECT DISTINCT zammad_ticket_id
           FROM message_links
          WHERE tenant_id=$1
            AND connection_id=$2
            AND external_message_id=$3
          ORDER BY zammad_ticket_id`,
        [event.tenantId,event.connectionId,target.external_message_id],
      )).rows.map(row=>row.zammad_ticket_id);
      return{targetExternalMessageId:target.external_message_id,ticketIds,alreadyRecorded,...(supersededByRevocation?{supersededByRevocation:true}:{})};
    });
  }

  async correlate(
    event:InboundEvent,
    context:InboundContext,
    message:ProviderMessage,
    reference:string,
    actions:{create:(correlationKey:string)=>Promise<TicketIdentity>;append:(ticketId:string)=>Promise<string|undefined>;reopen:(ticketId:string)=>Promise<string|undefined>},
    expectedTicketId?:string,
    matchesReference=false,
  ):Promise<TicketIdentity>{
    return this.tenant(event.tenantId,async client=>{
      const baseKey=`${event.tenantId}:${context.bindingId}:${reference}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[baseKey]);
      // Match native ticket-state callback lock order before locking the row.
      const observed=(await client.query<{zammad_ticket_id:string}>(
        `SELECT zammad_ticket_id FROM case_correlations
          WHERE tenant_id=$1 AND group_binding_id=$2 AND normalized_reference=$3 AND state<>'DETACHED'
          ORDER BY generation DESC LIMIT 1`,
        [event.tenantId,context.bindingId,reference],
      )).rows[0];
      if(observed)await assertTicketCommandBarrier(client,{tenantId:event.tenantId,ticketId:observed.zammad_ticket_id});
      let correlation=(await client.query<CorrelationRow>(
        `SELECT id,zammad_ticket_id,zammad_ticket_number,state,generation
           FROM case_correlations
          WHERE tenant_id=$1 AND group_binding_id=$2 AND normalized_reference=$3
            AND state<>'DETACHED'
          ORDER BY generation DESC
          LIMIT 1
          FOR UPDATE`,
        [event.tenantId,context.bindingId,reference],
      )).rows[0];
      if(expectedTicketId&&correlation?.zammad_ticket_id!==expectedTicketId)
        throw new InboundAssociationError("QUOTE_TARGET_UNAVAILABLE","The referenced case is detached or no longer available in this group.");
      const linked=correlation?((await client.query(
        "SELECT 1 FROM message_links WHERE tenant_id=$1 AND connection_id=$2 AND external_message_id=$3 AND zammad_ticket_id=$4",
        [event.tenantId,event.connectionId,message.messageId,correlation.zammad_ticket_id],
      )).rowCount??0)>0:false;

      const previousState=correlation?correlation.state:"NONE";
      let articleId:string|undefined;
      if(!correlation){
        const predecessor=(await client.query<{id:string;generation:number}>(
          `SELECT id,generation
             FROM case_correlations
            WHERE tenant_id=$1 AND group_binding_id=$2 AND normalized_reference=$3
            ORDER BY generation DESC
            LIMIT 1
            FOR UPDATE`,
          [event.tenantId,context.bindingId,reference],
        )).rows[0];
        const generation=Number(predecessor?.generation??0)+1;
        const correlationKey=generation===1?baseKey:`${baseKey}:generation:${generation}`;
        const ticket=await actions.create(correlationKey);articleId=ticket.articleId;
        await lockTicketCommand(client,{tenantId:event.tenantId,ticketId:ticket.id});
        const created=(await client.query<CorrelationRow>(
          `INSERT INTO case_correlations (
             tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,
             zammad_ticket_number,state,latest_external_message_id,original_external_message_id,generation,
             predecessor_correlation_id,client_routing_version_id,client_route_status,
             client_id,client_route_matched_by
           ) VALUES ($1,$2,$3,$4,$5,'OPEN',$6,$6,$7,$8,$9,$10,$11,$12)
           RETURNING id,zammad_ticket_id,zammad_ticket_number,state,generation`,
          [event.tenantId,context.bindingId,reference,ticket.id,ticket.number,message.messageId,generation,predecessor?.id??null,context.clientRoute?.versionId??null,context.clientRoute?.status??null,context.clientRoute?.clientId??null,context.clientRoute?.matchedBy??null],
        )).rows[0];
        if(!created)throw new Error("Case correlation could not be persisted");
        if(predecessor){
          const linkedPredecessor=await client.query(
            `UPDATE case_correlations
                SET replaced_by_correlation_id=$1,version=version+1,updated_at=now()
              WHERE tenant_id=$2 AND id=$3 AND state='DETACHED' AND replaced_by_correlation_id IS NULL`,
            [created.id,event.tenantId,predecessor.id],
          );
          if(linkedPredecessor.rowCount!==1)throw new Error("Case generation predecessor could not be linked");
        }
        correlation=created;
      }else if(!linked){
        const reopening=correlation.state==="RESOLVED";
        const reopenedAt=reopening?await actions.reopen(correlation.zammad_ticket_id):undefined;
        articleId=await actions.append(correlation.zammad_ticket_id);
        await client.query(
          `UPDATE case_correlations
              SET state='OPEN',latest_external_message_id=$1,version=version+1,
                  zammad_state_observed_at=CASE WHEN $2 THEN COALESCE($3::timestamptz,zammad_state_observed_at) ELSE zammad_state_observed_at END,
                  zammad_state_id=CASE WHEN $2 THEN NULL ELSE zammad_state_id END,
                  updated_at=now()
            WHERE tenant_id=$4 AND id=$5 AND state<>'DETACHED'`,
          [message.messageId,reopening,reopenedAt??null,event.tenantId,correlation.id],
        );
      }
      await client.query(
        "INSERT INTO message_links (tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction,quoted_external_message_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (connection_id,external_message_id,zammad_ticket_id) DO UPDATE SET zammad_article_id=COALESCE(message_links.zammad_article_id,EXCLUDED.zammad_article_id)",
        [event.tenantId,event.connectionId,message.messageId,correlation.zammad_ticket_id,articleId??null,message.fromMe?"MANUAL_DEVICE":"INBOUND",message.quotedMessageId??null],
      );
      const group=(await client.query<{whatsapp_group_id:string;original_external_message_id:string|null}>(
        `SELECT binding.whatsapp_group_id,correlation.original_external_message_id
           FROM group_bindings binding
           JOIN whatsapp_groups destination ON destination.tenant_id=binding.tenant_id AND destination.id=binding.whatsapp_group_id
           JOIN case_correlations correlation ON correlation.tenant_id=binding.tenant_id AND correlation.group_binding_id=binding.id
          WHERE binding.tenant_id=$1 AND binding.id=$2 AND correlation.id=$3
            AND destination.connection_id=$4 AND destination.external_group_id=$5`,
        [event.tenantId,context.bindingId,correlation.id,event.connectionId,message.groupId],
      )).rows[0];
      if(!group)throw new Error("Ticket event group context is unavailable");
      const selection=await loadEffectiveTicketEvent(client,{tenantId:event.tenantId,whatsappGroupId:group.whatsapp_group_id,event:"reference_received"});
      const receipt=await pinTicketEventExecution(client,{tenantId:event.tenantId,correlationId:correlation.id,event:"reference_received",
        sourceSha256:ticketEventSourceHash("INBOUND",event.connectionId,message.messageId),selection});
      let feedbackQueued=false;
      if(receipt.state==="PENDING"){
        if(receipt.mode==="LEGACY"){
          // These two existing paths have never emitted a legacy acknowledgement.
          if(message.fromMe||expectedTicketId)await completeTicketEventExecution(client,receipt,"SKIPPED");
        }else{
          const sender=message.fromMe?"team":receipt.mode==="CUSTOM"?(await client.query<{sender:string}>(
            "SELECT app.group_rule_sender($1,$2,$3,$4) AS sender",
            [event.tenantId,event.connectionId,message.groupId,message.participantId],
          )).rows[0]?.sender:"unknown";
          const quotes=receipt.mode==="CUSTOM"?await resolveTicketEventQuotes(client,{tenantId:event.tenantId,connectionId:event.connectionId,
            groupId:message.groupId,ticketId:correlation.zammad_ticket_id,originalMessageId:group.original_external_message_id,currentMessageId:message.messageId}):{};
          const feedback=await enqueueTicketEventFeedback(client,{receipt,connectionId:event.connectionId,groupBindingId:context.bindingId,
            ticketId:correlation.zammad_ticket_id,provider:event.provider==="waha"?"WAHA":"META",reactions:event.provider==="waha",quotes,
            variables:{"event.kind":"reference_received","provider.kind":event.provider==="waha"?"WAHA":"META",
              "group.name":context.groupName,"case.number":correlation.zammad_ticket_number,"case.reference":reference,
              "case.state":"OPEN","case.transition":previousState==="NONE"?"CREATED":previousState==="RESOLVED"?"REOPENED":"APPENDED",
              "case.previous_state":previousState,"message.text":message.text,"message.has_media":Boolean(message.media),"message.matches_reference":matchesReference,
              "sender.kind":sender==="team"?"AGENT":sender==="customer"?"CUSTOMER":"UNKNOWN"}});
          feedbackQueued=feedback.queued>0;
        }
      }
      return{id:correlation.zammad_ticket_id,number:correlation.zammad_ticket_number,...(feedbackQueued?{feedbackQueued:true}:{})};
    });
  }

  async linkQuotedMessage(
    event:InboundEvent,message:ProviderMessage,ticketId:string,context:InboundContext,
    actions:{append:()=>Promise<string|undefined>;reopen:()=>Promise<string|undefined>},
    matchedReferences:readonly string[]=[],
  ){
    const rows=await this.tenant(event.tenantId,async client=>(await client.query<{normalized_reference:string}>(
      `SELECT normalized_reference FROM case_correlations
        WHERE tenant_id=$1 AND group_binding_id=$2 AND zammad_ticket_id=$3 AND state<>'DETACHED'
        ORDER BY generation DESC LIMIT 2`,
      [event.tenantId,context.bindingId,ticketId],
    )).rows);
    if(rows.length!==1)throw new InboundAssociationError("QUOTE_TARGET_UNAVAILABLE","The referenced case is detached or no longer available in this group.");
    // Reuse correlated locking, duplicate checks, reopen and latest projection.
    // expectedTicketId fences a detach/successor race without creating a case.
    return this.correlate(event,context,message,rows[0].normalized_reference,{
      create:async()=>{throw new InboundAssociationError("QUOTE_TARGET_UNAVAILABLE","The referenced case is no longer available.")},
      append:actions.append,reopen:actions.reopen,
    },ticketId,matchedReferences.includes(rows[0].normalized_reference));
  }

  async enqueueAcknowledgement(
    event:InboundEvent,
    context:InboundContext,
    message:ProviderMessage,
    text:string,
    ticketIds:string[],
    disclosure:string|null,
    reprocessReplyToMessageId?:string,
    commandResponse=false,
  ){
    let replyToMessageId=message.messageId;
    if(event.eventType==="quarantine.reprocess"){
      if(!reprocessReplyToMessageId||reprocessReplyToMessageId.length>1024||hasUnsafeMutationValue(reprocessReplyToMessageId))throw new Error("Original provider reply target is unavailable");
      replyToMessageId=reprocessReplyToMessageId;
    }
    return this.tenant(event.tenantId,async client=>{
      const sourceSha256=ticketEventSourceHash("INBOUND",event.connectionId,message.messageId);
      const governed=(await client.query<{zammad_ticket_id:string;zammad_ticket_number:string;mode:string}>(
        `SELECT correlation.zammad_ticket_id,correlation.zammad_ticket_number,execution.mode
           FROM ticket_event_executions execution JOIN case_correlations correlation
             ON correlation.tenant_id=execution.tenant_id AND correlation.id=execution.correlation_id
          WHERE execution.tenant_id=$1 AND execution.event='reference_received' AND execution.source_sha256=$2
            AND correlation.group_binding_id=$3 AND correlation.zammad_ticket_id=ANY($4::text[])`,
        [event.tenantId,sourceSha256,context.bindingId,ticketIds],
      )).rows;
      const managed=new Set(governed.filter(row=>row.mode!=="LEGACY").map(row=>row.zammad_ticket_id));
      const legacyIds=ticketIds.filter(id=>!managed.has(id));
      let acknowledgementText=text;
      if(!commandResponse&&managed.size){
        const numbers=legacyIds.map(id=>governed.find(row=>row.zammad_ticket_id===id)?.zammad_ticket_number);
        if(numbers.some(value=>value===undefined))throw new Error("Legacy acknowledgement case context is unavailable");
        acknowledgementText=legacyIds.length?context.acknowledgementTemplate.replaceAll("{{tickets}}",numbers.join(", "))
          .replaceAll("{{count}}",String(numbers.length)).replaceAll("{{reference}}",numbers.join(", ")):"";
      }
      const completeLegacy=async()=>{await client.query(`UPDATE ticket_event_executions execution SET state='APPLIED',completed_at=now()
        FROM case_correlations correlation WHERE execution.tenant_id=$1 AND execution.event='reference_received'
          AND execution.source_sha256=$2 AND execution.mode='LEGACY' AND execution.state='PENDING'
          AND correlation.tenant_id=execution.tenant_id AND correlation.id=execution.correlation_id
          AND correlation.group_binding_id=$3 AND correlation.zammad_ticket_id=ANY($4::text[])`,
        [event.tenantId,sourceSha256,context.bindingId,legacyIds]);};
      const idempotencyKey=acknowledgementIdempotencyKey(event.tenantId,event.connectionId,message.messageId);
      // Replaying an inbound event must return the original acknowledgement;
      // it must never allocate a new disclosure attempt.
      let delivery=(await client.query<{id:string;content_redacted_at:string|Date|null}>(
        "SELECT id,content_redacted_at FROM delivery_outbox WHERE tenant_id=$1 AND idempotency_key=$2",
        [event.tenantId,idempotencyKey],
      )).rows[0];
      if(delivery?.content_redacted_at){await completeLegacy();return delivery.id;}
      if(!delivery){
        // The binding lock serializes simultaneous first matches for one group.
        // Without it two deliveries could both decide that disclosure is due.
        const binding=await client.query(
          "SELECT 1 FROM group_bindings WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [event.tenantId,context.bindingId],
        );
        if(binding.rowCount!==1)throw new Error("Acknowledgement group binding is unavailable");
        // A concurrent replay can have committed while this transaction waited
        // on the binding lock. Re-read before attempting the globally unique
        // idempotency key so the replay remains a clean no-op.
        delivery=(await client.query<{id:string;content_redacted_at:string|Date|null}>(
          "SELECT id,content_redacted_at FROM delivery_outbox WHERE tenant_id=$1 AND idempotency_key=$2",
          [event.tenantId,idempotencyKey],
        )).rows[0];
        if(delivery?.content_redacted_at){await completeLegacy();return delivery.id;}
        if(!delivery){
        const normalizedDisclosure=disclosure?.trim()||null;
        const disclosureSha256=normalizedDisclosure
          ? createHash("sha256").update(normalizedDisclosure,"utf8").digest("hex")
          : null;
        const alreadyScheduled=disclosureSha256
          ? (await client.query(
              `SELECT 1 FROM group_disclosure_deliveries
                WHERE tenant_id=$1 AND group_binding_id=$2 AND disclosure_sha256=$3
                  AND state IN ('QUEUED','SENT','OUTCOME_UNKNOWN')
                LIMIT 1`,
              [event.tenantId,context.bindingId,disclosureSha256],
            )).rowCount===1
          : false;
        const includeDisclosure=Boolean(normalizedDisclosure&&disclosureSha256&&!alreadyScheduled);
        // Disclosure is a separate tenant requirement, including when ordinary feedback is OFF.
        // Reuse its existing per-group digest ledger and ACK identity; never emit empty text.
        const messageBody=includeDisclosure?[acknowledgementText,normalizedDisclosure].filter(Boolean).join("\n\n"):acknowledgementText;
        if(!messageBody){await completeLegacy();return null;}
        delivery=(await client.query<{id:string;content_redacted_at:string|Date|null}>(
          "INSERT INTO delivery_outbox (tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,reply_to_message_id,idempotency_key,state) VALUES ($1,$2,$3,$4,$5,$6,'text/plain',$7,$8,'QUEUED') RETURNING id,content_redacted_at",
          [event.tenantId,event.connectionId,context.bindingId,ticketIds[0],null,messageBody,replyToMessageId,idempotencyKey],
        )).rows[0];
        if(delivery&&includeDisclosure&&disclosureSha256){
          await client.query(
            `INSERT INTO group_disclosure_deliveries
              (tenant_id,group_binding_id,disclosure_sha256,delivery_id,state)
             VALUES ($1,$2,$3,$4,'QUEUED')`,
            [event.tenantId,context.bindingId,disclosureSha256,delivery.id],
          );
        }
        }
      }
      if(!delivery)throw new Error("Acknowledgement could not be queued");
      for(const ticketId of new Set(ticketIds))await client.query(
        "INSERT INTO delivery_ticket_links (tenant_id,delivery_id,zammad_ticket_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [event.tenantId,delivery.id,ticketId],
      );
      await completeLegacy();
      return delivery.id;
    });
  }

  async processDirectMessage(
    event:InboundEvent,
    context:DirectBotContext,
    message:DirectProviderMessage,
    customer:{id:number;login:string},
    actions:{
      create:(correlationKey:string,reference:string)=>Promise<TicketIdentity>;
      append:(ticketId:string)=>Promise<string|undefined>;
    },
  ){
    return this.tenant(event.tenantId,async client=>{
      const routeKey=`${event.tenantId}:${context.assignmentId}:${message.chatId}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[routeKey]);
      const duplicate=(await client.query(`SELECT 1 FROM normalized_messages
        WHERE tenant_id=$1 AND connection_id=$2 AND external_message_id=$3`,[
        event.tenantId,event.connectionId,message.messageId,
      ])).rowCount;
      if(duplicate)return{duplicate:true,queued:false,state:undefined,ignored:false};
      let conversation=(await client.query<DirectConversationRow>(`SELECT conversation.human_ownership_epoch,conversation.human_pause_started_at,conversation.customer_control,conversation.zammad_customer_id,conversation.fencing_token,conversation.id,conversation.flow_version_id,conversation.state,conversation.current_node_id,
               conversation.step_count,conversation.variables,conversation.zammad_ticket_id,conversation.zammad_ticket_number,
               conversation.last_activity_at,
               conversation.client_routing_version_id,conversation.client_route_status,conversation.client_id,
               conversation.client_route_matched_by,routing.definition AS routing_definition
          FROM bot_conversations conversation
          LEFT JOIN client_routing_versions routing ON routing.tenant_id=conversation.tenant_id
            AND routing.id=conversation.client_routing_version_id
         WHERE conversation.tenant_id=$1 AND conversation.assignment_id=$2 AND conversation.external_chat_id=$3 AND conversation.state<>'RESOLVED'
         ORDER BY conversation.created_at DESC LIMIT 1 FOR UPDATE OF conversation`,[
        event.tenantId,context.assignmentId,message.chatId,
      ])).rows[0];
      const existingConversation=Boolean(conversation);
      const assignment=(await client.query<{flow_version_id:string;start_node:string;state:string;definition:unknown}>(`SELECT assignment.flow_version_id,
               assignment.state,version.definition,version.definition->>'start' AS start_node
          FROM bot_assignments assignment
          JOIN bot_flow_versions version ON version.tenant_id=assignment.tenant_id AND version.id=assignment.flow_version_id
         WHERE assignment.tenant_id=$1 AND assignment.id=$2
         FOR SHARE OF assignment`,[event.tenantId,context.assignmentId])).rows[0];
      if(!assignment||(assignment.state!=="ACTIVE"&&!conversation)){
        return{duplicate:false,queued:false,state:conversation?.state,ignored:true};
      }
      // Inert unsupported/manual inputs and stale ordinary choices retain their
      // existing early guards; only current customer controls inspect policy here.
      const inspectPolicy=!message.fromMe&&(message.input.type==='text'||message.input.type==='location'||
        (message.input.type==='choice'&&conversation?.customer_control!=null));
      const pinnedDefinition=conversation&&inspectPolicy?(await client.query<{definition:unknown}>('SELECT definition FROM bot_flow_versions WHERE tenant_id=$1 AND id=$2',[event.tenantId,conversation.flow_version_id])).rows[0]?.definition:null;
      const pinnedFlow=pinnedDefinition?parseBotFlow(pinnedDefinition):null;
      let inspected:InspectedControl|null=null;
      if(conversation){
        try{
          await assertDirectNativeBarrier(client,{tenantId:event.tenantId,conversationId:conversation.id});
          if(pinnedFlow?.keepOpenPolicy)inspected=await inspectDirectKeepOpenInput(client,{tenantId:event.tenantId,connectionId:event.connectionId,eventId:event.id,
            chatId:message.chatId,flow:pinnedFlow,conversation,message,customerId:customer.id,assignmentActive:assignment.state==='ACTIVE'});
        }catch(error){if(error instanceof Error&&['DIRECT_NATIVE_EFFECT_HOLD','DIRECT_PENDING_EFFECTS'].includes(error.message))return{duplicate:false,queued:false,state:conversation.state,ignored:false,pendingTarget:true};throw error;}
      }
      const entryFlow=pinnedFlow??(!conversation&&message.input.type==='text'&&assignment.definition?parseBotFlow(assignment.definition):null);
      const entryEligible=!inspected&&!message.fromMe&&message.input.type==='text'&&assignment.state==='ACTIVE'&&
        (!conversation||conversation.state==='BOT')&&Boolean(entryFlow?.entryCommands?.some(command=>command.enabled));
      if(entryEligible){
        // Explicit command-enabled flows admit current own input before any
        // normalized/native side effect; old definitions keep their old path.
        if(!Number.isSafeInteger(customer.id)||customer.id<=0||!Number.isFinite(Date.parse(message.timestamp))||
          (conversation&&(Number(conversation.zammad_customer_id)!==customer.id||!providerSecondIsCurrent(message.timestamp,conversation.last_activity_at))))
          return{duplicate:false,queued:false,state:conversation?.state,ignored:true,ignoreReason:'DIRECT_ENTRY_INPUT_NOT_CURRENT'};
        if(conversation){
          try{await assertDirectEffectsClear(client,{tenantId:event.tenantId,conversationId:conversation.id});}
          catch(error){if(error instanceof Error&&['DIRECT_NATIVE_EFFECT_HOLD','DIRECT_PENDING_EFFECTS'].includes(error.message))return{duplicate:false,queued:false,state:conversation.state,ignored:false,pendingTarget:true};throw error;}
        }
      }
      const entryCommand=entryEligible&&entryFlow?resolveBotEntryCommand(entryFlow,conversation?.current_node_id,directBotInput(message),
        {...conversation?.variables,...directInputVariables(message)}):null;
      if(!entryCommand&&!inspected&&conversation&&pinnedFlow?.welcomeResendMinutes!=null){
        try{inspected=await inspectDirectWelcomeResendInput(client,{
          tenantId:event.tenantId,connectionId:event.connectionId,eventId:event.id,chatId:message.chatId,
          flow:pinnedFlow,flowVersionId:conversation.flow_version_id,conversation,message,customerId:customer.id,
          assignmentActive:assignment.state==='ACTIVE'});
        }catch(error){if(error instanceof Error&&['DIRECT_NATIVE_EFFECT_HOLD','DIRECT_PENDING_EFFECTS'].includes(error.message))return{duplicate:false,queued:false,state:conversation.state,ignored:false,pendingTarget:true};throw error;}
      }
      if(!inspected&&message.input.type==="choice"&&message.input.source==="META_NATIVE"){
        const prompt=conversation?.state==="BOT"?(await client.query<DirectChoicePromptRow>(`SELECT external_message_id,state,created_at,bot_content,content_redacted_at,
            app.delivery_no_further_attempts(tenant_id,id) AS no_further_attempts
          FROM delivery_outbox
          WHERE tenant_id=$1 AND connection_id=$2 AND bot_conversation_id=$3 AND external_chat_id=$4
            AND direct_origin='BOT' AND state IN ('CLAIMED','SENDING','OUTCOME_UNKNOWN','SENT','DELIVERED','READ')
            AND (content_redacted_at IS NOT NULL
              OR (bot_content->>'type'='choices' AND bot_content->>'nodeId'=$5))
          ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,[
          event.tenantId,event.connectionId,conversation.id,message.chatId,conversation.current_node_id,
        ])).rows[0]:undefined;
        if(prompt?.no_further_attempts){
          return{duplicate:false,queued:false,state:conversation?.state,ignored:true,ignoreReason:"DIRECT_CHOICE_PROMPT_MISMATCH"};
        }
        if(prompt&&(["CLAIMED","SENDING","OUTCOME_UNKNOWN"].includes(prompt.state)||!prompt.external_message_id)){
          return{duplicate:false,queued:false,state:conversation?.state,ignored:false,pendingTarget:true};
        }
        if(!prompt||!matchesMetaNativeChoicePrompt(message,conversation!,prompt)){
          return{duplicate:false,queued:false,state:conversation?.state,ignored:true,ignoreReason:"DIRECT_CHOICE_PROMPT_MISMATCH"};
        }
      }
      const inserted=(await client.query<{id:string}>(`INSERT INTO normalized_messages
        (tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,
         external_participant_id,participant_name,message_text,quoted_external_message_id,from_api,from_me,
         provider_timestamp,provider_metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11,$12)
        ON CONFLICT (connection_id,external_message_id) DO NOTHING RETURNING id`,[
        event.tenantId,event.id,event.connectionId,message.messageId,message.chatId,message.senderId,
        message.senderName??null,directInputText(message),message.quotedMessageId??null,message.fromMe,message.timestamp,directInputMetadata(message),
      ])).rows[0];
      if(!inserted)return{duplicate:true,queued:false,state:undefined,ignored:false};
      if(!message.fromMe)await upsertParticipantName(client,event,message.senderId,message.senderName,message.senderPhone,directNameQuality(message.senderNameQuality));
      await client.query(`UPDATE normalized_messages SET provider_metadata=provider_metadata ||
        jsonb_build_object('zammad_customer_id',$1::bigint,'zammad_customer_login',$2::text)
        WHERE tenant_id=$3 AND event_inbox_id=$4`,[customer.id,customer.login,event.tenantId,event.id]);
      if(message.input.type==="reaction"&&!conversation){
        return{duplicate:false,queued:false,state:undefined,ignored:false};
      }
      let inboundArticleId:string|undefined;
      if(!conversation){
        if(!assignment?.start_node)throw new Error("Direct bot assignment is unavailable");
        const correlationKey=createHash("sha256").update(routeKey,"utf8").digest("hex");
        const reference=`BOT-${correlationKey.slice(0,12).toUpperCase()}`;
        const prior=(await client.query<{zammad_ticket_id:string;zammad_ticket_number:string}>(`SELECT zammad_ticket_id,zammad_ticket_number
          FROM bot_conversations WHERE tenant_id=$1 AND assignment_id=$2 AND connection_id=$3
            AND external_chat_id=$4 AND state='RESOLVED'
          ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,[
          event.tenantId,context.assignmentId,event.connectionId,message.chatId,
        ])).rows[0];
        const ticket=prior
          ?{id:prior.zammad_ticket_id,number:prior.zammad_ticket_number,articleId:await actions.append(prior.zammad_ticket_id)}
          :await actions.create(correlationKey,reference);
        inboundArticleId=ticket.articleId;
        conversation=(await client.query<DirectConversationRow>(`INSERT INTO bot_conversations
          (zammad_customer_id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,state,current_node_id,
           normalized_reference,zammad_ticket_id,zammad_ticket_number,last_external_message_id,last_activity_at,
           client_routing_version_id,client_route_status,client_id,client_route_matched_by)
          VALUES ($16,$1,$2,$3,$4,$5,'BOT',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          RETURNING human_ownership_epoch,human_pause_started_at,customer_control,zammad_customer_id,fencing_token,id,flow_version_id,state,current_node_id,step_count,variables,zammad_ticket_id,zammad_ticket_number,
            last_activity_at,client_routing_version_id,client_route_status,client_id,client_route_matched_by,NULL::jsonb AS routing_definition`,[
          event.tenantId,context.assignmentId,event.connectionId,assignment.flow_version_id,message.chatId,
          assignment.start_node,reference,ticket.id,ticket.number,message.messageId,message.timestamp,context.clientRoute?.versionId??null,
          context.clientRoute?.status??null,context.clientRoute?.clientId??null,context.clientRoute?.matchedBy??null,customer.id,
        ])).rows[0];
        if(!conversation)throw new Error("Direct bot conversation could not be created");
      }else{
        inboundArticleId=await actions.append(conversation.zammad_ticket_id);
      }
      await client.query(`INSERT INTO message_links
        (tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction,quoted_external_message_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (connection_id,external_message_id,zammad_ticket_id)
        DO UPDATE SET zammad_article_id=COALESCE(message_links.zammad_article_id,EXCLUDED.zammad_article_id)`,[
        event.tenantId,event.connectionId,message.messageId,conversation.zammad_ticket_id,inboundArticleId??null,
        message.fromMe?"MANUAL_DEVICE":"INBOUND",message.quotedMessageId??null,
      ]);
      if(event.provider==='meta'&&!message.fromMe)await client.query('SELECT app.seal_meta_direct_native_anchor($1)',[event.id]);
      const eventKind=message.input.type==="choice"?"CHOICE":message.input.type==="location"?"LOCATION":message.input.type==="flow_response"?"FLOW_RESPONSE":message.input.type==="reaction"?"REACTION":"MESSAGE";
      let neutralControlInput=false;
      if(inspected&&pinnedFlow){
        const applied=await applyDirectKeepOpenInput(client,{tenantId:event.tenantId,connectionId:event.connectionId,eventId:event.id,
          chatId:message.chatId,flow:pinnedFlow,conversation,message,customerId:customer.id,assignmentActive:assignment.state==='ACTIVE'},inspected);
        if(applied.resumed){conversation={...conversation,state:'BOT',current_node_id:inspected.kind==='MAIN_MENU'?(pinnedFlow.mainMenuNodeId??pinnedFlow.start):pinnedFlow.start,variables:{},step_count:0,
          customer_control:null,human_pause_started_at:null,fencing_token:Number(conversation.fencing_token)+1};neutralControlInput=true;}
        if(applied.handled){
          await client.query(`INSERT INTO bot_conversation_events(tenant_id,conversation_id,event_inbox_id,event_kind,safe_metadata)
            VALUES($1,$2,$3,$4,$5)`,[event.tenantId,conversation.id,event.id,eventKind,JSON.stringify({customer_control:inspected.kind,human_ownership_epoch:Number(conversation.human_ownership_epoch)})]);
          await client.query(`UPDATE bot_conversations SET last_external_message_id=$1,last_activity_at=$2,
            fencing_token=fencing_token+1,updated_at=now() WHERE tenant_id=$3 AND id=$4`,[message.messageId,message.timestamp,event.tenantId,conversation.id]);
          return{duplicate:false,queued:applied.queued,state:conversation.state,ignored:false};
        }
      }
      if(message.input.type==="reaction"||message.input.type==="unsupported"||message.fromMe||assignment.state!=="ACTIVE"||conversation.state==="HUMAN"||conversation.state==="HANDOFF_PENDING"||conversation.state==="ACTION_PENDING"){
        await client.query(`INSERT INTO bot_conversation_events
          (tenant_id,conversation_id,event_inbox_id,event_kind,from_node_id,to_node_id,safe_metadata)
          VALUES ($1,$2,$3,$4,$5,$5,$6)`,[
          event.tenantId,conversation.id,event.id,eventKind,conversation.current_node_id,
          JSON.stringify({input_type:message.input.type,manual_device:message.fromMe,human_owned:conversation.state==="HUMAN",handoff_pending:conversation.state==="HANDOFF_PENDING",action_pending:conversation.state==="ACTION_PENDING",assignment_paused:assignment.state!=="ACTIVE"}),
        ]);
        await client.query(`UPDATE bot_conversations SET last_external_message_id=$1,last_activity_at=$2,
          fencing_token=fencing_token+1,updated_at=now() WHERE tenant_id=$3 AND id=$4`,[
          message.messageId,message.timestamp,event.tenantId,conversation.id,
        ]);
        return{duplicate:false,queued:false,state:conversation.state,ignored:false};
      }
      const definition=(await client.query<{definition:unknown}>(`SELECT definition FROM bot_flow_versions
        WHERE tenant_id=$1 AND id=$2`,[event.tenantId,conversation.flow_version_id])).rows[0]?.definition;
      const flow=pinnedFlow??parseBotFlow(definition);
      const variables={...(entryCommand?{}:conversation.variables),...directInputVariables(message)};
      for(const node of flow.nodes)if(node.type==="whatsapp_flow")variables[`flow.${node.id}.token`]??=randomUUID();
      const advanced=advanceBotFlow(flow,entryCommand?.target??conversation.current_node_id,
        (neutralControlInput||entryCommand||(!existingConversation&&flow.welcomeResendMinutes!=null))?undefined:directBotInput(message),variables);
      if(message.input.type==="flow_response"&&flow.nodes.some(node=>node.id===conversation.current_node_id&&node.type==="whatsapp_flow")){
        delete variables[`flow.${conversation.current_node_id}.token`];
        const repeated=advanced.effects.find((effect):effect is Extract<BotFlowEffect,{type:"send_whatsapp_flow"}>=>effect.type==="send_whatsapp_flow"&&effect.nodeId===conversation.current_node_id);
        if(repeated){repeated.flowToken=randomUUID();variables[`flow.${repeated.nodeId}.token`]=repeated.flowToken}
      }
      let queued=false;
      const welcomeDeliveryIds:string[]=[];
      for(const [index,effect] of advanced.effects.entries()){
        const delivery=directDelivery(effect);
        if(!delivery)continue;
        const idempotencyKey=`bot:${conversation.id}:${event.id}:${index}`;
        const created=(await client.query<{id:string}>(`INSERT INTO delivery_outbox
          (tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,zammad_article_id,
           message_body,content_type,idempotency_key,state,bot_content,direct_origin,created_at,meta_routing_source_event_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'text/plain',$8,'QUEUED',$9,'BOT',transaction_timestamp()+$10*interval '1 microsecond',$11)
          ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id`,[
          event.tenantId,event.connectionId,conversation.id,message.chatId,conversation.zammad_ticket_id,
          null,delivery.text,idempotencyKey,
          delivery.content??null,index,event.provider==='meta'?event.id:null,
        ])).rows[0];
        if(created){
          queued=true;
          welcomeDeliveryIds.push(created.id);
          if(delivery.mediaAssetId){const media=await client.query(`INSERT INTO delivery_media
            (tenant_id,delivery_id,bot_media_asset_id,filename,mime_type,byte_size,state,media_object_id)
            SELECT $1,$2,asset.id,asset.filename,asset.mime_type,asset.byte_size,'READY',asset.media_object_id
              FROM bot_media_assets asset JOIN bot_flow_media_asset_pins pin
                ON pin.tenant_id=asset.tenant_id AND pin.bot_media_asset_id=asset.id AND pin.bot_flow_version_id=$3
             WHERE asset.tenant_id=$1 AND asset.id=$4 AND asset.media_object_id IS NOT NULL AND asset.state IN ('READY','RETIRED')
               AND NOT EXISTS (SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=asset.tenant_id AND target.target_type='MEDIA_OBJECT' AND target.target_id=asset.media_object_id::text AND target.state IN ('PENDING','EXTERNAL_COMPLETE','COMPLETE'))`,[
            event.tenantId,created.id,conversation.flow_version_id,delivery.mediaAssetId,
          ]);if(media.rowCount!==1)throw new Error("Pinned bot media is unavailable")}
          await client.query(`INSERT INTO delivery_ticket_links (tenant_id,delivery_id,zammad_ticket_id)
            VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,[event.tenantId,created.id,conversation.zammad_ticket_id]);
        }
      }
      if(advanced.state==="ACTION"){
        const action=advanced.effects.find((effect):effect is Extract<BotFlowEffect,{type:"action"}>=>effect.type==="action");
        if(!action)throw new Error("Bot action effect is unavailable");
        const definitionId=(await client.query<{id:string}>("SELECT id FROM bot_action_definitions WHERE tenant_id=$1 AND action_key=$2 AND state='ACTIVE'",[event.tenantId,action.actionId])).rows[0]?.id;
        if(!definitionId)throw new Error("Configured bot action is unavailable");
        const actionJob=await client.query(`INSERT INTO bot_action_jobs
          (tenant_id,conversation_id,action_definition_id,source_event_id,action_node_id,request_input,on_success_node_id,on_failure_node_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[
          event.tenantId,conversation.id,definitionId,event.id,action.nodeId,action.input,action.onSuccess,action.onFailure,
        ]);
        queued=actionJob.rowCount===1||queued;
      }
      if(advanced.state==="HANDOFF"){
        const handoff=advanced.effects.find((effect):effect is Extract<BotFlowEffect,{type:"handoff"}>=>effect.type==="handoff");
        if(!handoff)throw new Error("Bot handoff effect is unavailable");
        const pinned=existingConversation?storedClientRoute(conversation.client_routing_version_id,conversation.routing_definition,conversation.client_route_status,conversation.client_id,conversation.client_route_matched_by):context.clientRoute?{zammadGroupId:context.zammadGroup,...(context.ownerId?{ownerId:context.ownerId}:{}),decision:context.clientRoute}:null;
        const target=resolveBotHandoff(handoff,pinned?.zammadGroupId??context.assignmentZammadGroup,pinned?.ownerId,pinned?.decision);
        const handoffJob=await client.query(`INSERT INTO bot_handoff_jobs
          (tenant_id,conversation_id,source_event_id,handoff_node_id,zammad_group_id,zammad_owner_id,priority)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[
          event.tenantId,conversation.id,event.id,handoff.nodeId,target.groupId,target.ownerId??null,handoff.priority,
        ]);
        queued=handoffJob.rowCount===1||queued;
      }
      const state=advanced.state==="ACTION"?"ACTION_PENDING":advanced.state==="HANDOFF"?"HANDOFF_PENDING":advanced.state==="RESOLVED"?"RESOLVED":"BOT";
      await client.query(`INSERT INTO bot_conversation_events
        (tenant_id,conversation_id,event_inbox_id,event_kind,from_node_id,to_node_id,safe_metadata,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7::jsonb ? 'welcome_cycle' THEN clock_timestamp() ELSE transaction_timestamp() END)`,[
        event.tenantId,conversation.id,event.id,eventKind,conversation.current_node_id,advanced.currentNodeId,
        JSON.stringify({input_type:message.input.type,result:advanced.state,effects:advanced.effects.map(effect=>effect.type),...(entryCommand?{entry_command_id:entryCommand.id}:{}),
          // Explicit menu returns own a fresh batch even when their node differs from start.
          ...(flow.welcomeResendMinutes!=null&&
            (neutralControlInput||advanced.effects.some(effect=>effect.nodeId===flow.start&&directDelivery(effect)))&&welcomeDeliveryIds.length
            ?{welcome_cycle:{flow_version_id:conversation.flow_version_id,delivery_ids:welcomeDeliveryIds}}:{})}),
      ]);
      await client.query(`UPDATE bot_conversations SET state=$1,current_node_id=$2,step_count=step_count+$3,
        variables=$4,last_external_message_id=$5,last_activity_at=$6,resolved_at=CASE WHEN $1='RESOLVED' THEN now() ELSE NULL END,
        resolution_kind=CASE WHEN $1='RESOLVED' THEN 'FLOW' ELSE NULL END,fencing_token=fencing_token+1,updated_at=now()
        WHERE tenant_id=$7 AND id=$8`,[
        state,advanced.currentNodeId,advanced.steps,variables,message.messageId,message.timestamp,event.tenantId,conversation.id,
      ]);
      return{duplicate:false,queued,state,ignored:false};
    });
  }

  async applyMetaLifecycle(event:InboundEvent,leaseId:string,appId:string){
    const admitted=metaLifecycleAdmission(event,appId);
    return this.tenant(event.tenantId,async client=>{
      // Use the same connection -> session -> inbox order as signed admission.
      const connection=(await client.query<{state:string}>(
        "SELECT state FROM connections WHERE tenant_id=$1 AND id=$2 AND provider='META' AND EXISTS(SELECT 1 FROM webhook_routes r WHERE r.tenant_id=$1 AND r.connection_id=$2 AND r.provider='META' AND r.reservation_release_id IS NULL) FOR UPDATE",
        [event.tenantId,event.connectionId])).rows[0];
      if(!connection)throw new MetaLifecycleError();
      const session=(await client.query<{id:string;opaque_session_id:string;ownership_state:string;state:string;provider_state_data:Record<string,unknown>;other_active:boolean}>(
        `SELECT session.id,session.opaque_session_id,session.ownership_state,session.state,session.provider_state_data,
                EXISTS(SELECT 1 FROM provider_sessions current_session WHERE current_session.tenant_id=$1 AND current_session.connection_id=$2
                       AND current_session.ownership_state='ACTIVE' AND current_session.id<>session.id) AS other_active
           FROM provider_sessions session WHERE session.tenant_id=$1 AND session.connection_id=$2 AND session.id=$3::uuid FOR UPDATE`,
        [event.tenantId,event.connectionId,admitted.asset.providerSessionId])).rows[0];
      const inbox=(await client.query<{payload:Record<string,unknown>}>(
        `SELECT payload FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND provider='META'
           AND event_type=$4 AND status='PROCESSING' AND lease_id=$5 AND lease_expires_at>clock_timestamp() FOR UPDATE`,
        [event.tenantId,event.connectionId,event.id,event.eventType,leaseId])).rows[0];
      if(!inbox||metaLifecyclePayloadSha256(inbox.payload)!==metaLifecyclePayloadSha256(event.payload))throw new MetaLifecycleError();
      // Never redirect an old session callback to a newly onboarded asset. Same-session token rotation is deliberately allowed.
      const stateData=session?.provider_state_data;
      const proof=lifecycleRecord(stateData?.metaAccountProof);
      const metadata=lifecycleRecord(proof?.credentialMetadata);
      if(!session||!stateData||!['ACTIVE','RETIRED'].includes(session.ownership_state))throw new MetaLifecycleError();
      const sameAsset=!(session.ownership_state==='RETIRED'&&session.other_active);
      if(sameAsset&&(session.other_active||session.opaque_session_id!==admitted.asset.phoneNumberId||stateData.wabaId!==admitted.asset.wabaId
        ||proof?.phoneNumberId!==admitted.asset.phoneNumberId||proof?.wabaId!==admitted.asset.wabaId
        ||proof?.providerSessionId!==session.id||proof?.tenantId!==event.tenantId||proof?.connectionId!==event.connectionId
        ||metadata?.appId!==appId))throw new MetaLifecycleError();
      let result:"APPLIED"|"DUPLICATE"|"IGNORED_STALE"="IGNORED_STALE";
      if(sameAsset){
        if(admitted.phoneScope==="EXACT_DISPLAY"&&normalizeMetaDisplayPhoneNumber(proof?.displayPhoneNumber)!==admitted.displayPhoneNumber)throw new MetaLifecycleError();
        const applied=applyMetaLifecycleObservation(stateData.metaLifecycle,admitted.observation);result=applied.outcome;
        const blocked=metaLifecycleBlockingReasons(applied.state).length>0;
        const localHold=["PAUSED","REVOKED"].includes(connection.state)||session.ownership_state!=="ACTIVE";
        const updated=await client.query(`UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaLifecycle}',$1::jsonb),
          state=CASE WHEN $2 AND NOT $3 THEN 'ACTION_REQUIRED' ELSE state END,updated_at=now()
          WHERE tenant_id=$4 AND connection_id=$5 AND id=$6`,
          [JSON.stringify(applied.state),blocked,localHold,event.tenantId,event.connectionId,session.id]);
        if(updated.rowCount!==1)throw new MetaLifecycleError();
        if(blocked&&!localHold)await client.query(`UPDATE connections SET state='ACTION_REQUIRED',
          action_reason='Meta account access requires lifecycle reconciliation.',updated_at=now() WHERE tenant_id=$1 AND id=$2`,[event.tenantId,event.connectionId]);
      }
      // A persisted block and its acknowledgement are one transaction. Failed negatives remain durable effect holds.
      const completed=await client.query(`UPDATE event_inbox SET status=$1,payload=jsonb_build_object('redacted',true,'payload_sha256',payload_sha256),
        provider_event_id='redacted:'||provider_event_id_sha256,processed_at=now(),lease_id=NULL,lease_expires_at=NULL,safe_error=$2,updated_at=now()
        WHERE tenant_id=$3 AND id=$4 AND status='PROCESSING' AND lease_id=$5 AND lease_expires_at>clock_timestamp()`,
        [sameAsset?'PROCESSED':'IGNORED',sameAsset?null:'META_LIFECYCLE_OLD_ASSET',event.tenantId,event.id,leaseId]);
      if(completed.rowCount!==1)throw new MetaLifecycleError();
      return result;
    });
  }

  async applyProviderStatus(event:InboundEvent,observation:ProviderStatusObservation,identity?:{phoneE164:string;pinnedWahaWorkerId:string}){return this.tenant(event.tenantId,async client=>{
    const active=(await client.query<ProviderStatusRow>(`SELECT c.state AS connection_state,ps.id AS provider_session_id,ps.opaque_session_id,
             ps.provider_state,ps.provider_state_data,ps.last_provider_status_at,ps.waha_worker_id
      FROM connections c
      JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id AND ps.ownership_state='ACTIVE'
      WHERE c.tenant_id=$1 AND c.id=$2
      FOR UPDATE OF c,ps`,[event.tenantId,event.connectionId])).rows[0];
    if(!active||active.opaque_session_id!==observation.opaqueSessionId||["PAUSED","REVOKED"].includes(active.connection_state))return"IGNORED" as const;
    const duplicateCleanup=(await client.query(`SELECT 1 FROM connection_operations
      WHERE tenant_id=$1 AND connection_id=$2
        AND idempotency_key='duplicate-identity:'||$3::text
        AND state<>'SUCCEEDED'
      LIMIT 1`,[event.tenantId,event.connectionId,active.provider_session_id])).rowCount;
    if(duplicateCleanup)return"IGNORED" as const;
    const pending=(await client.query(`SELECT 1 FROM connection_operations
      WHERE tenant_id=$1 AND connection_id=$2
        AND operation_type IN ('PROVISION','START','RESTART','PAUSE','DISCONNECT')
        AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
      LIMIT 1`,[event.tenantId,event.connectionId])).rowCount;
    if(pending)return"IGNORED" as const;
    const observedAt=new Date(observation.observedAt);
    const lastObserved=active.last_provider_status_at?new Date(active.last_provider_status_at):undefined;
    if(!Number.isFinite(observedAt.getTime())||(lastObserved&&observedAt.getTime()<=lastObserved.getTime()))return"IGNORED" as const;
    const previousQrSequence=Number(active.provider_state_data?.qrSequence??0);
    const qrSequence=observation.providerState==="SCAN_QR_CODE"
      ? active.provider_state==="SCAN_QR_CODE"
        ? Number.isSafeInteger(previousQrSequence)&&previousQrSequence>=1
          ? Math.min(previousQrSequence+1,6)
          : 2
        : 1
      : undefined;
    const providerStateData={status:observation.providerState,observedAt:observation.observedAt,eventId:event.providerEventId,...(qrSequence?{qrSequence}: {})};
    if(observation.providerState==="WORKING"){
      if(!identity||active.waha_worker_id!==identity.pinnedWahaWorkerId)throw new Error("WAHA working identity evidence is unavailable");
      const cleanupOperationId=(await client.query<{cleanup_operation_id:string|null}>(
        "SELECT app.queue_duplicate_waha_identity_cleanup($1,$2,$3,$4,$5) AS cleanup_operation_id",
        [event.connectionId,active.provider_session_id,identity.pinnedWahaWorkerId,identity.phoneE164,event.id],
      )).rows[0]?.cleanup_operation_id;
      if(cleanupOperationId){
        const session=await client.query(`UPDATE provider_sessions
          SET state='ACTION_REQUIRED',provider_state='WORKING',provider_state_data=$1::jsonb,last_provider_status_at=$2,
              onboarding_scan_completed_at=CASE
                WHEN onboarding_authorization_method='QR'
                  AND onboarding_scan_completed_at IS NULL AND onboarding_scan_acknowledged_at IS NOT NULL
                  AND onboarding_scan_acknowledged_at<=COALESCE(onboarding_working_at,$2)
                  THEN onboarding_scan_acknowledged_at
                ELSE onboarding_scan_completed_at END,
              onboarding_working_at=CASE WHEN onboarding_qr_ready_at IS NOT NULL
                THEN COALESCE(onboarding_working_at,$2) ELSE onboarding_working_at END,
              updated_at=now()
          WHERE tenant_id=$3 AND connection_id=$4 AND id=$5 AND ownership_state='ACTIVE'`,[
          JSON.stringify(providerStateData),observation.observedAt,event.tenantId,event.connectionId,active.provider_session_id,
        ]);
        if(session.rowCount!==1)throw new Error("Duplicate identity cleanup could not be fenced");
        return"DUPLICATE_IDENTITY" as const;
      }
    }
    const session=await client.query(`UPDATE provider_sessions
      SET state=$1,provider_state=$2,provider_state_data=$3::jsonb,last_provider_status_at=$4,
          onboarding_qr_ready_at=CASE WHEN $2='SCAN_QR_CODE' THEN $4 ELSE onboarding_qr_ready_at END,
          onboarding_authorization_method=CASE
            WHEN $2='SCAN_QR_CODE' AND provider_state IS DISTINCT FROM 'SCAN_QR_CODE' THEN 'QR'
            ELSE onboarding_authorization_method END,
          onboarding_scan_acknowledged_at=CASE
            WHEN $2='SCAN_QR_CODE' THEN NULL
            ELSE onboarding_scan_acknowledged_at END,
          onboarding_scan_completed_at=CASE
            WHEN $2='SCAN_QR_CODE' THEN NULL
            WHEN $2='WORKING' AND onboarding_authorization_method='QR'
              AND onboarding_scan_completed_at IS NULL
              AND onboarding_scan_acknowledged_at IS NOT NULL
              AND onboarding_scan_acknowledged_at<=COALESCE(onboarding_working_at,$4)
              THEN onboarding_scan_acknowledged_at
            ELSE onboarding_scan_completed_at END,
          onboarding_working_at=CASE
            WHEN $2='SCAN_QR_CODE' THEN NULL
            WHEN $2='WORKING' AND onboarding_qr_ready_at IS NOT NULL THEN COALESCE(onboarding_working_at,$4)
            ELSE onboarding_working_at END,
          updated_at=now()
      WHERE tenant_id=$5 AND connection_id=$6 AND id=$7 AND ownership_state='ACTIVE'`,[
      observation.connectionState,observation.providerState,JSON.stringify(providerStateData),observation.observedAt,event.tenantId,event.connectionId,active.provider_session_id,
    ]);
    if(session.rowCount!==1)return"IGNORED" as const;
    await client.query(`UPDATE connections
      SET state=$1,action_reason=$2,phone_e164=COALESCE($3,phone_e164),last_heartbeat_at=CASE WHEN $1='WORKING' THEN now() ELSE last_heartbeat_at END,updated_at=now()
      WHERE tenant_id=$4 AND id=$5`,[observation.connectionState,observation.reason??null,identity?.phoneE164??null,event.tenantId,event.connectionId]);
    return"APPLIED" as const;
  })}

  async applyDeliveryReceipts(event:InboundEvent,receipts:ProviderReceipt[]):Promise<DeliveryReceiptResult[]>{
    if(receipts.length>100)throw new Error("Receipt event exceeds the safe item limit");
    return this.tenant(event.tenantId,async client=>{
      // Provider arrays are not guaranteed to be ordered. Apply their provider
      // timestamps oldest-first inside one transaction so every valid item is
      // committed together and a later status cannot be regressed.
      const ordered=[...receipts].sort((left,right)=>{
        const time=new Date(left.timestamp).getTime()-new Date(right.timestamp).getTime();
        return time||receiptOrder(left.status)-receiptOrder(right.status)||left.receiptKey.localeCompare(right.receiptKey);
      });
      const results:DeliveryReceiptResult[]=[];
      for(const receipt of ordered)results.push(await this.applyDeliveryReceiptInTransaction(client,event,receipt));
      return results;
    });
  }

  async applyDeliveryReceipt(event:InboundEvent,receipt:ProviderReceipt):Promise<DeliveryReceiptResult>{
    const result=await this.applyDeliveryReceipts(event,[receipt]);
    return result[0]??"UNMATCHED";
  }

  private async applyDeliveryReceiptInTransaction(client:PoolClient,event:InboundEvent,receipt:ProviderReceipt):Promise<DeliveryReceiptResult>{
    if(receipt.connectionId!==event.connectionId||receipt.provider!==event.provider)throw new Error("Receipt tenant context is invalid");
    if(!/^[0-9a-f]{64}$/.test(receipt.receiptKey))throw new Error("Receipt key is invalid");
    if(!/^[A-Z0-9_.-]{1,64}$/.test(receipt.providerStatus))throw new Error("Receipt provider status is invalid");
    const providerTimestamp=new Date(receipt.timestamp);
    if(!Number.isFinite(providerTimestamp.getTime()))throw new Error("Receipt timestamp is invalid");
    const candidate=(await client.query<DeliveryReceiptRow>(`SELECT id,state,zammad_ticket_id,content_redacted_at
      FROM delivery_outbox
      WHERE tenant_id=$1 AND connection_id=$2 AND (
        external_message_id=$3 OR (
          content_redacted_at IS NOT NULL
          AND external_message_id_sha256=app.delivery_external_message_sha256($1,$2,$3)
        )
      )`,[event.tenantId,event.connectionId,receipt.externalMessageId])).rows[0];
    if(!candidate)return"UNMATCHED";
    if(candidate.content_redacted_at)return"DUPLICATE";
    let outcomeReviewLocked=false;
    if(candidate.state==="OUTCOME_UNKNOWN"){
      outcomeReviewLocked=Boolean((await client.query(`SELECT 1 FROM quarantine_records
        WHERE tenant_id=$1 AND delivery_id=$2 AND reason_code='PROVIDER_OUTCOME_UNKNOWN'
        FOR UPDATE`,[event.tenantId,candidate.id])).rowCount);
      if(!outcomeReviewLocked)throw new Error("Provider-outcome review is missing");
    }
    const delivery=(await client.query<DeliveryReceiptRow>(`SELECT id,state,zammad_ticket_id,meta_direct_recipient
      FROM delivery_outbox
      WHERE tenant_id=$1 AND id=$2 AND connection_id=$3 AND external_message_id=$4
        AND content_redacted_at IS NULL
      FOR UPDATE`,[event.tenantId,candidate.id,event.connectionId,receipt.externalMessageId])).rows[0];
    if(!delivery)return"UNMATCHED";
    if(delivery.state==="OUTCOME_UNKNOWN"&&!outcomeReviewLocked)throw new Error("Provider-outcome review lock order changed; retry the receipt");
    const next=receipt.scope==="MESSAGE"?receiptTransition(delivery.state,receipt.status):undefined;
    const appliedState=receipt.scope==="PARTICIPANT_OBSERVED"?"OBSERVED":next??"IGNORED";
    const errorCodes=safeReceiptErrorCodes(receipt.errorCodes);
    const pricing=receipt.metaPricingObservation;
    const inserted=(await client.query<{id:string}>(`INSERT INTO delivery_receipts
      (tenant_id,delivery_id,connection_id,event_inbox_id,provider,external_message_id,receipt_key_sha256,receipt_scope,receipt_status,provider_status,provider_timestamp,error_codes,safe_metadata,applied_state,
       meta_pricing_version,meta_pricing_state,meta_pricing_reason,meta_pricing_model,meta_pricing_category,meta_pricing_type,meta_pricing_billable,meta_pricing_revision_sha256,meta_observed_envelope_account_id,meta_observed_phone_number_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      ON CONFLICT (tenant_id,connection_id,receipt_key_sha256) DO NOTHING RETURNING id`,[
      event.tenantId,delivery.id,event.connectionId,event.id,event.provider.toUpperCase(),receipt.externalMessageId,
      receipt.receiptKey,receipt.scope,receipt.status,receipt.providerStatus,providerTimestamp.toISOString(),
      JSON.stringify(errorCodes),JSON.stringify(safeReceiptMetadata(receipt.metadata)),appliedState,
      pricing?.version??null,pricing?.state??null,pricing?.reason??null,pricing?.model??null,
      pricing?.category??null,pricing?.type??null,pricing?.billable??null,pricing?.revisionSha256??null,
      pricing?.observedEnvelopeAccountId??null,pricing?.observedPhoneNumberId??null,
    ])).rows[0];
    if(!inserted)return"DUPLICATE";
    if(event.provider==="meta"&&receipt.status==="FAILED"&&errorCodes.includes("131050")&&delivery.meta_direct_recipient){
      await recordWhatsAppMarketingRejection(client,event.tenantId,event.connectionId,delivery.meta_direct_recipient,providerTimestamp,event.id);
    }
    // WAHA group receipts are explicitly per-participant. Retain the evidence
    // but never present one participant's acknowledgement as an aggregate group
    // delivery/read/failure state.
    if(receipt.scope==="PARTICIPANT_OBSERVED"||!next)return"RECORDED";
    const safeFailure=next==="FAILED_TERMINAL"
      ? `Provider reported a terminal delivery failure${errorCodes.length?` (${errorCodes.join(", ")})`:""}.`.slice(0,500)
      : null;
    const updated=await client.query(`UPDATE delivery_outbox
      SET state=$1,safe_error=$2,manual_retry_allowed=false,lease_id=NULL,lease_expires_at=NULL,updated_at=now()
      WHERE tenant_id=$3 AND id=$4 AND state=$5 AND content_redacted_at IS NULL`,[next,safeFailure,event.tenantId,delivery.id,delivery.state]);
    if(updated.rowCount!==1)throw new Error("Delivery receipt state fence was lost");
    await client.query("SELECT app.project_delivery_status($1,$2,$3,$4)",[
      delivery.id,next,receipt.externalMessageId,safeFailure,
    ]);
    if(next==="FAILED_TERMINAL"){
      await client.query(
        `UPDATE group_disclosure_deliveries
            SET state='FAILED',updated_at=now()
          WHERE tenant_id=$1 AND delivery_id=$2 AND state IN ('SENT','OUTCOME_UNKNOWN')`,
        [event.tenantId,delivery.id],
      );
      await client.query(`INSERT INTO quarantine_records
        (tenant_id,source_kind,reason_code,state,connection_id,delivery_id,safe_summary,safe_metadata)
        VALUES ($1,'OUTBOUND','PROVIDER_DELIVERY_FAILED','OPEN',$2,$3,'Provider reported a terminal delivery failure',$4::jsonb)
        ON CONFLICT (tenant_id,delivery_id,reason_code) WHERE delivery_id IS NOT NULL DO NOTHING`,[
        event.tenantId,event.connectionId,delivery.id,JSON.stringify({error_codes:errorCodes,provider_status:receipt.providerStatus}),
      ]);
    }else if(delivery.state==="OUTCOME_UNKNOWN"){
      await client.query(
        `UPDATE group_disclosure_deliveries SET state='SENT',updated_at=now()
          WHERE tenant_id=$1 AND delivery_id=$2 AND state='OUTCOME_UNKNOWN'`,
        [event.tenantId,delivery.id],
      );
    }
    if(delivery.state==="OUTCOME_UNKNOWN"){
      const resolved=await client.query(`UPDATE quarantine_records
        SET state='RESOLVED',resolution_code='DELIVERY_RECEIPT_CONFIRMED',resolved_at=now(),
            version=version+1,updated_at=now()
        WHERE tenant_id=$1 AND delivery_id=$2 AND reason_code='PROVIDER_OUTCOME_UNKNOWN' AND state='OPEN'`,
      [event.tenantId,delivery.id]);
      if(resolved.rowCount)await client.query(`INSERT INTO audit_events
        (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
        VALUES ($1,'SYSTEM','connector-worker','review.delivery_resolved_by_receipt','delivery',$2,$3::jsonb,$4)`,[
        event.tenantId,delivery.id,JSON.stringify({state:next,receipt_status:receipt.status}),`delivery-receipt:${inserted.id}`,
      ]);
    }
    return"APPLIED";
  }

  async quarantineInbound(event:InboundEvent,input:{
    bindingId?:string;
    reasonCode:QuarantineReason;
    safeSummary:string;
    safeMetadata?:Record<string,unknown>;
    mediaObjectId?:string;
  }){return this.tenant(event.tenantId,async client=>{
    const row=(await client.query<{id:string}>(`INSERT INTO quarantine_records
      (tenant_id,source_kind,reason_code,state,connection_id,group_binding_id,source_event_inbox_id,media_object_id,safe_summary,safe_metadata)
      VALUES ($1,'INBOUND',$2,'OPEN',$3,$4,$5,$6,$7,$8::jsonb)
      ON CONFLICT (tenant_id,source_event_inbox_id) WHERE source_event_inbox_id IS NOT NULL AND group_action_execution_id IS NULL
      DO UPDATE SET id=quarantine_records.id
      RETURNING id`,[
      event.tenantId,input.reasonCode,event.connectionId,input.bindingId??null,event.id,input.mediaObjectId??null,
      input.safeSummary.slice(0,240),JSON.stringify(safeQuarantineMetadata(input.safeMetadata??{})),
    ])).rows[0];
    if(!row)throw new Error("Review record could not be persisted");
    return row.id;
  })}

  async completeQuarantineReprocess(event:InboundEvent,ticketIds:string[]){
    const quarantineId=typeof event.payload.quarantineId==="string"?event.payload.quarantineId:"";
    if(!quarantineId)return;
    return this.tenant(event.tenantId,async client=>{
      const updated=await client.query(`UPDATE quarantine_records
        SET state='RESOLVED',resolution_code='REPROCESSED',resolved_at=now(),version=version+1,
            safe_metadata=safe_metadata || jsonb_build_object('ticket_count',$1::integer),updated_at=now()
        WHERE tenant_id=$2 AND id=$3 AND state='REPROCESS_QUEUED' AND reprocess_event_id=$4`,[
        new Set(ticketIds).size,event.tenantId,quarantineId,event.id,
      ]);
      if(updated.rowCount!==1){const existing=await client.query(`SELECT 1 FROM quarantine_records
        WHERE tenant_id=$1 AND id=$2 AND state='RESOLVED' AND resolution_code='REPROCESSED' AND reprocess_event_id=$3`,[
        event.tenantId,quarantineId,event.id,
      ]);if(existing.rowCount!==1)throw new Error("Review reprocess fence was lost")}
    });
  }

  async reopenQuarantineReprocess(event:InboundEvent,safeCode:string){
    const quarantineId=typeof event.payload.quarantineId==="string"?event.payload.quarantineId:"";
    if(!quarantineId)return;
    return this.tenant(event.tenantId,async client=>{await client.query(`UPDATE quarantine_records
      SET state='OPEN',reprocess_event_id=NULL,version=version+1,
          safe_metadata=safe_metadata || jsonb_build_object('reprocess_error_code',$1::text),updated_at=now()
      WHERE tenant_id=$2 AND id=$3 AND state='REPROCESS_QUEUED' AND reprocess_event_id=$4`,[
      safeCode.replace(/[^A-Z0-9_.-]/g,"_").slice(0,64),event.tenantId,quarantineId,event.id,
    ])});
  }

  async complete(event:InboundEvent,leaseId:string,status:"PROCESSED"|"UNMATCHED"|"IGNORED"|"DUPLICATE"|"QUARANTINED",redactPayload:boolean,safeError?:string){return this.tenant(event.tenantId,async client=>{if(status==="PROCESSED"||status==="UNMATCHED"||status==="QUARANTINED")await client.query("UPDATE normalized_messages SET processing_status='COMPLETE' WHERE tenant_id=$1 AND event_inbox_id=$2",[event.tenantId,event.id]);const payload=redactPayload?"jsonb_build_object('redacted',true,'payload_sha256',payload_sha256)":"payload";const providerEventId=redactPayload?"'redacted:'||provider_event_id_sha256":"provider_event_id";const result=await client.query(`UPDATE event_inbox SET status=$1,payload=${payload},provider_event_id=${providerEventId},processed_at=now(),lease_id=NULL,lease_expires_at=NULL,safe_error=$5,updated_at=now() WHERE tenant_id=$2 AND id=$3 AND lease_id=$4`,[status,event.tenantId,event.id,leaseId,safeError?.slice(0,120)??null]);if(result.rowCount!==1)throw new Error("Inbound event lease was lost")})}

  async fail(event:InboundEvent,leaseId:string,retryable:boolean,error:string,availableAt?:string){return this.tenant(event.tenantId,async client=>{const state=retryable?"FAILED_RETRYABLE":"FAILED_TERMINAL";const result=await client.query("UPDATE event_inbox SET status=$1,safe_error=$2,available_at=COALESCE($3,available_at),processed_at=CASE WHEN $1='FAILED_TERMINAL' THEN now() ELSE NULL END,lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$4 AND id=$5 AND lease_id=$6",[state,error.slice(0,500),availableAt??null,event.tenantId,event.id,leaseId]);if(result.rowCount!==1)throw new Error("Inbound event lease was lost")})}
  async close(){await this.pool.end()}
}

function pinnedClientRoute(versionId:string|null,definition:unknown,input:ClientRoutingInput):{zammadGroupId:string;ownerId?:string;decision:ClientRouteDecision}|null{
  if(!versionId||!definition)return null;
  const routing=parseClientRouting(definition);
  if(!clientRoutingApplies(routing,input.entryGroupId))return null;
  const resolved=resolveClientRoute(routing,input);
  if(resolved.status==="CONFLICT")throw new Error("Pinned client routing is ambiguous");
  const route=resolved.client??routing.fallback;
  return{zammadGroupId:route.zammadGroupId,...(route.ownerId?{ownerId:route.ownerId}:{}),decision:{versionId,status:resolved.status,matchedBy:resolved.matchedBy,...(resolved.client?{clientId:resolved.client.id}:{}),...(resolved.client?.escalationGroupId?{escalationGroupId:resolved.client.escalationGroupId}:{}),...(resolved.client?.escalationOwnerId?{escalationOwnerId:resolved.client.escalationOwnerId}:{})}};
}

export function storedClientRoute(versionId:string|null,definition:unknown,status:string|null,clientId:string|null,matchedBy:string|null){
  if(!versionId||!definition||!status||!matchedBy)return null;const routing=parseClientRouting(definition);
  const client=status==="MATCHED"?routing.clients.find(item=>item.id===clientId):undefined;const route=status==="FALLBACK"?routing.fallback:client;
  if(!route||(status!=="MATCHED"&&status!=="FALLBACK"))throw new Error("Stored client routing decision is unavailable");
  return{zammadGroupId:route.zammadGroupId,...(route.ownerId?{ownerId:route.ownerId}:{}),decision:{versionId,status:status as "MATCHED"|"FALLBACK",matchedBy:matchedBy as ClientRouteDecision["matchedBy"],...(clientId?{clientId}:{}),...(client?.escalationGroupId?{escalationGroupId:client.escalationGroupId}:{}),...(client?.escalationOwnerId?{escalationOwnerId:client.escalationOwnerId}:{})} satisfies ClientRouteDecision};
}

function directInputText(message:DirectProviderMessage){
  if(message.input.type==="text"||message.input.type==="unsupported")return message.input.text;
  if(message.input.type==="choice")return message.input.label;
  if(message.input.type==="flow_response")return["WhatsApp form response",...Object.entries(message.input.data).sort(([left],[right])=>left.localeCompare(right)).map(([key,value])=>`${key}: ${value.replace(/\s+/gu," ")}`)].join("\n");
  if(message.input.type==="reaction")return message.input.removed?"Removed a reaction":message.input.emoji?`Reacted with ${message.input.emoji}`:"Reaction received";
  return directLocationText(message.input);
}

function directInputMetadata(message:DirectProviderMessage){
  return{direct:true,input_type:message.input.type,...(message.senderPhone?{sender_phone:message.senderPhone}:{}),...(message.input.type==="choice"?{choice_id:message.input.choiceId??message.input.label,...(message.input.source?{choice_source:message.input.source}:{})}:{}),...(message.input.type==="location"?{location:{latitude:message.input.latitude,longitude:message.input.longitude,...(message.input.name?{name:message.input.name}:{}),...(message.input.address?{address:message.input.address}:{})}}:{})};
}

export function providerSecondIsCurrent(providerTimestamp:string,boundaryTimestamp:string|Date){
  const providerAt=Date.parse(providerTimestamp);const boundaryAt=new Date(boundaryTimestamp).getTime();
  return Number.isFinite(providerAt)&&Number.isFinite(boundaryAt)&&Math.floor(providerAt/1000)>=Math.floor(boundaryAt/1000);
}

function matchesMetaNativeChoicePrompt(message:DirectProviderMessage,conversation:DirectConversationRow,prompt:DirectChoicePromptRow){
  if(message.input.type!=="choice"||message.input.source!=="META_NATIVE"||prompt.content_redacted_at||
    prompt.bot_content?.type!=="choices"||prompt.bot_content.nodeId!==conversation.current_node_id||
    message.quotedMessageId!==prompt.external_message_id)return false;
  const{choiceId,label}=message.input;
  const options=Array.isArray(prompt.bot_content.options)?prompt.bot_content.options:[];
  const selected=options.some(option=>option!==null&&typeof option==="object"&&!Array.isArray(option)&&
    (option as Record<string,unknown>).id===choiceId&&(option as Record<string,unknown>).label===label);
  return selected&&providerSecondIsCurrent(message.timestamp,prompt.created_at)&&providerSecondIsCurrent(message.timestamp,conversation.last_activity_at);
}

function directNameQuality(value:DirectProviderMessage["senderNameQuality"]){
  return value==="VERIFIED"||value==="CONTACT"?3:value==="NOTIFY"?2:value==="PUSH"?1:0;
}

function directBotInput(message:DirectProviderMessage){
  if(message.input.type==="choice")return{type:"choice" as const,choiceId:message.input.choiceId??message.input.label};
  if(message.input.type==="location")return{type:"location" as const,latitude:message.input.latitude,longitude:message.input.longitude};
  if(message.input.type==="flow_response")return{type:"flow_response" as const,flowToken:message.input.flowToken,data:message.input.data};
  if(message.input.type==="reaction"||message.input.type==="unsupported")return{type:"text" as const,text:""};
  return{type:"text" as const,text:message.input.text};
}

function directInputVariables(message:DirectProviderMessage):Record<string,string>{
  if(message.input.type==="text")return{"message.text":message.input.text};
  if(message.input.type==="choice")return{"message.choice_id":message.input.choiceId??message.input.label,"message.choice_label":message.input.label};
  if(message.input.type==="flow_response")return Object.fromEntries(Object.entries(message.input.data).map(([key,value])=>[`message.flow.${key}`,value]));
  if(message.input.type==="reaction"||message.input.type==="unsupported")return{};
  return{"message.location.latitude":String(message.input.latitude),"message.location.longitude":String(message.input.longitude),...(message.input.name?{"message.location.name":message.input.name}:{}),...(message.input.address?{"message.location.address":message.input.address}:{})};
}

export function directDelivery(effect:BotFlowEffect):{text:string;content?:Record<string,unknown>;mediaAssetId?:string}|undefined{
  if(effect.type==="send_text")return{text:effect.text};
  if(effect.type==="send_media")return{text:effect.caption??"",content:{type:"media",assetId:effect.assetId},mediaAssetId:effect.assetId};
  if(effect.type==="send_choices")return{text:effect.prompt,content:{type:"choices",nodeId:effect.nodeId,...(effect.buttonLabel?{buttonLabel:effect.buttonLabel}:{}),options:effect.options}};
  if(effect.type==="request_location")return{text:effect.prompt};
  if(effect.type==="send_location")return{text:directLocationText(effect),content:{type:"location",latitude:effect.latitude,longitude:effect.longitude,...(effect.name?{name:effect.name}:{}),...(effect.address?{address:effect.address}:{})}};
  if(effect.type==="send_template")return{text:effect.transcriptText,content:{type:"template",name:effect.templateName,languageCode:effect.languageCode,bodyParameters:effect.bodyParameters}};
  if(effect.type==="send_whatsapp_flow")return{text:effect.prompt,content:{type:"flow",id:effect.flowId,token:effect.flowToken,buttonLabel:effect.buttonLabel,...(effect.screen?{screen:effect.screen}:{}),data:effect.data}};
  if(effect.type==="handoff"&&effect.message)return{text:effect.message};
  return undefined;
}

function receiptTransition(current:string,receipt:ProviderReceipt["status"]){
  if(current==="OUTCOME_UNKNOWN"){
    if(receipt==="SENT")return"SENT";
    if(receipt==="DELIVERED")return"DELIVERED";
    if(receipt==="READ")return"READ";
    return"FAILED_TERMINAL";
  }
  if(receipt==="SENT")return undefined;
  if(receipt==="DELIVERED"&&current==="SENT")return"DELIVERED";
  if(receipt==="READ"&&(current==="SENT"||current==="DELIVERED"))return"READ";
  if(receipt==="FAILED"&&current==="SENT")return"FAILED_TERMINAL";
  return undefined;
}

function receiptOrder(receipt:ProviderReceipt["status"]){
  if(receipt==="SENT")return 1;
  if(receipt==="DELIVERED")return 2;
  if(receipt==="READ")return 3;
  return 4;
}

function safeReceiptErrorCodes(values:string[]){return[...new Set(values.filter(value=>/^[A-Z0-9_.-]{1,64}$/.test(value)))].slice(0,20)}
function acknowledgementIdempotencyKey(tenantId:string,connectionId:string,messageId:string){return`ack:${createHash("sha256").update(`wasalx-ack\x1f${tenantId}\x1f${connectionId}\x1f${messageId}`,"utf8").digest("hex")}`}
function safeReceiptMetadata(value:Record<string,string|number|boolean>){const output:Record<string,string|number|boolean>={};for(const key of["ack","engine","groupReceipt","errorCount"]){const item=value[key];if(typeof item==="string"||typeof item==="number"||typeof item==="boolean")output[key]=typeof item==="string"?item.slice(0,64):item}return output}
function safeQuarantineMetadata(value:Record<string,unknown>){const output:Record<string,string|number|boolean>={};for(const key of["reference_count","configured_limit","media_type","media_size","error_code"]){const item=value[key];if(typeof item==="string"||typeof item==="number"||typeof item==="boolean")output[key]=typeof item==="string"?stripUnsafeControls(item).slice(0,120):item}return output}
function stripUnsafeControls(value:string){return Array.from(value).filter(character=>{const code=character.charCodeAt(0);return code>=32&&code!==127}).join("")}
function isStoredMutation(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==="object"&&!Array.isArray(value)&&typeof (value as Record<string,unknown>).event_id==="string"}
function hasUnsafeMutationValue(value:string){return Array.from(value).some(character=>{const code=character.codePointAt(0)??0;return code<32||code===127})}

function groupCommand(value:unknown):InboundRule["groupCommand"]|undefined{
  if(!value||typeof value!=="object"||Array.isArray(value))return undefined;
  const command=value as Record<string,unknown>;
  if(typeof command.actionId!=="string"||typeof command.successReply!=="string"||typeof command.failureReply!=="string"||!command.input||typeof command.input!=="object"||Array.isArray(command.input))throw new Error("Pinned group command configuration is invalid");
  const input=Object.fromEntries(Object.entries(command.input as Record<string,unknown>).map(([key,item])=>{if(typeof item!=="string")throw new Error("Pinned group command input is invalid");return[key,item]}));
  return{actionId:command.actionId,input,successReply:command.successReply,failureReply:command.failureReply};
}

function groupCommandAction(row:GroupActionDefinitionRow):GroupCommandAction{return{
  actionId:row.action_key,actionDefinitionId:row.id,revision:Number(row.revision),kind:row.kind,
  endpointUrl:row.endpoint_url,httpMethod:row.http_method,authScheme:row.auth_scheme,
  ...(row.secret_reference?{secretReference:row.secret_reference}:{}),headers:row.headers??{},
  responseMapping:row.response_mapping??{},timeoutMs:Number(row.timeout_ms),maxResponseBytes:Number(row.max_response_bytes),
}}

function storedGroupCommandAction(value:unknown):GroupCommandAction{
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Pinned group action snapshot is invalid");
  const action=value as Record<string,unknown>;
  if(typeof action.actionId!=="string"||typeof action.actionDefinitionId!=="string"||typeof action.revision!=="number"||
    (action.authScheme!=="NONE"&&action.authScheme!=="BEARER")||typeof action.endpointUrl!=="string"||typeof action.timeoutMs!=="number"||typeof action.maxResponseBytes!=="number"||
    !action.headers||typeof action.headers!=="object"||Array.isArray(action.headers)||!action.responseMapping||typeof action.responseMapping!=="object"||Array.isArray(action.responseMapping)||
    !supportsBotActionInvocation({kind:action.kind,endpointUrl:action.endpointUrl,httpMethod:action.httpMethod,authScheme:action.authScheme,secretReference:action.secretReference},"GROUP_COMMAND"))throw new Error("Pinned group action snapshot is invalid");
  return action as GroupCommandAction;
}

function groupActionExecution(row:GroupActionExecutionRow):GroupActionExecution{return{
  id:row.id,state:row.state,attempts:Number(row.attempts),action:storedGroupCommandAction(row.action_snapshot),
  requestInput:row.request_input??{},responseVariables:row.response_variables??{},...(row.safe_error?{safeError:row.safe_error}:{}),
}}

async function auditGroupAction(client:PoolClient,tenantId:string,row:GroupActionExecutionRow,action:string,ruleId:string){
  const snapshot=storedGroupCommandAction(row.action_snapshot);
  await client.query(`INSERT INTO audit_events
      (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
    VALUES ($1,'SYSTEM','connector-worker',$2,'group_action_execution',$3,$4,$5)`,[
    tenantId,action,row.id,{state:row.state,attempts:Number(row.attempts),action_key:snapshot.actionId,action_revision:snapshot.revision,trigger_rule_id:ruleId},`group-action:${row.id}:${row.state}`,
  ]);
}

function mediaRecord(row:{id:string;tenant_id:string;sha256:string;object_key:string;mime_type:string;byte_size:string|number;scan_state:string;expires_at:string|Date;created_at:string|Date}):MediaRecord{if(row.scan_state!=="CLEAN")throw new Error("Media record is not clean");return{id:row.id,tenantId:row.tenant_id,sha256:row.sha256,objectKey:row.object_key,mimeType:row.mime_type,byteSize:Number(row.byte_size),scanState:"CLEAN",expiresAt:new Date(row.expires_at).toISOString(),createdAt:new Date(row.created_at).toISOString()}}
function mediaReservation(row:{id:string;tenant_id:string;sha256:string;object_key:string;mime_type:string;byte_size:string|number;scan_state:"STAGING"|"CLEAN";expires_at:string|Date;created_at:string|Date}):MediaReservation{return{id:row.id,tenantId:row.tenant_id,sha256:row.sha256,objectKey:row.object_key,mimeType:row.mime_type,byteSize:Number(row.byte_size),scanState:row.scan_state,expiresAt:new Date(row.expires_at).toISOString(),createdAt:new Date(row.created_at).toISOString()}}


async function upsertParticipantName(client:PoolClient,event:InboundEvent,participantId:string,name:string|undefined,phone:string|undefined,quality:number){
  const cleaned=(name??"").normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu," ").replace(/\s+/gu," ").trim().slice(0,100);
  const human=cleaned&&!/^whatsapp participant$/iu.test(cleaned)&&!/^\+?[1-9][0-9]{5,19}(?:@(c\.us|s\.whatsapp\.net|lid))?$/iu.test(cleaned)?cleaned:null;
  const verifiedPhone=/^\+[1-9][0-9]{5,14}$/u.test(phone??"")?phone:null;
  await client.query(`INSERT INTO participant_identities
    (tenant_id,connection_id,external_participant_id,display_name,normalized_phone,display_name_quality)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (connection_id,external_participant_id) DO UPDATE SET
    display_name=CASE WHEN EXCLUDED.display_name IS NULL THEN participant_identities.display_name
      WHEN participant_identities.display_name IS NULL OR EXCLUDED.display_name_quality>=participant_identities.display_name_quality
      THEN EXCLUDED.display_name ELSE participant_identities.display_name END,
    display_name_quality=GREATEST(participant_identities.display_name_quality,EXCLUDED.display_name_quality),
    normalized_phone=COALESCE(EXCLUDED.normalized_phone,participant_identities.normalized_phone)`,
    [event.tenantId,event.connectionId,participantId,human,verifiedPhone,human?quality:0]);
}

function lifecycleRecord(value:unknown):Record<string,unknown>|undefined{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;}
function metaLifecycleAdmission(event:InboundEvent,appId:string){
  const payload=event.payload,admission=lifecycleRecord(payload.admission),asset=lifecycleRecord(admission?.asset);
  const entry=Array.isArray(payload.entry)&&payload.entry.length===1?lifecycleRecord(payload.entry[0]):undefined;
  const change=Array.isArray(entry?.changes)&&entry.changes.length===1?lifecycleRecord(entry.changes[0]):undefined;
  const value=lifecycleRecord(change?.value);
  if(event.provider!=='meta'||payload.object!=='whatsapp_business_account'||!admission||admission.schemaVersion!==1||!asset
    ||asset.appId!==appId||typeof asset.providerSessionId!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(asset.providerSessionId)
    ||typeof asset.phoneNumberId!=='string'||!/^\d{5,32}$/u.test(asset.phoneNumberId)||typeof asset.wabaId!=='string'||!/^\d{5,32}$/u.test(asset.wabaId)
    ||!entry||!Number.isSafeInteger(entry.time)||Number(entry.time)<=0||change?.field!=='account_update'||!value)throw new MetaLifecycleError();
  const observedAt=new Date(Number(entry.time)*1_000).toISOString();
  const unit={object:payload.object,entry:[{id:entry.id,time:entry.time,changes:[{field:'account_update',value}]}]};
  const payloadSha256=metaLifecyclePayloadSha256(unit);
  const classified=classifyMetaLifecycleValue(value,appId);
  const accountId=metaLifecycleAccountId(entry.id,value);
  if(accountId!==asset.wabaId||admission.observedAt!==observedAt||admission.providerPayloadSha256!==payloadSha256
    ||admission.kind!==classified.kind||JSON.stringify(admission.reasons)!==JSON.stringify(classified.reasons))throw new MetaLifecycleError();
  const displayPhoneNumber=value.phone_number===undefined?undefined:normalizeMetaDisplayPhoneNumber(value.phone_number);
  const phoneScope=admission.phoneScope;
  if(!['ACCOUNT','EXACT_DISPLAY','UNRESOLVED_DISPLAY'].includes(String(phoneScope))
    ||(phoneScope==='ACCOUNT'&&value.phone_number!==undefined)||(phoneScope!=='ACCOUNT'&&!displayPhoneNumber))throw new MetaLifecycleError();
  const effective=phoneScope==='UNRESOLVED_DISPLAY'
    ?classified.kind==='BLOCK'?{...classified,reasons:['UNRESOLVED_PHONE']}:{...classified,kind:'OBSERVATION',reasons:[]}
    :classified;
  const observation=parseMetaLifecycleObservation({...effective,observedAt,payloadSha256});
  if(event.eventType!==`meta.account.lifecycle.${observation.kind.toLowerCase()}`)throw new MetaLifecycleError();
  return{asset:{providerSessionId:asset.providerSessionId,phoneNumberId:asset.phoneNumberId,wabaId:asset.wabaId},phoneScope,displayPhoneNumber,observation};
}
