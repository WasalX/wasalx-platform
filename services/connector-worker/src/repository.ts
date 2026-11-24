import {reconsiderMetaIdentityTransitions} from "./meta-direct-identity.js";
import { metaTestRecipientAdmission, resolveMetaTestRecipientLink } from "../../../packages/core/src/meta-test-recipient-link.js";
import { parseWahaTestRecipientAllowlist } from "../../../packages/core/src/waha-test-recipient-scope.js";
import type {MetaRuntimeEvidenceCandidate} from "./meta-request-provenance.js";
import type {MetaTemplateSendContext,MetaTemplateSendProof} from "./meta-template-send.js";
import {assertMetaDirectEffectCurrent,MetaDirectEffectNotAttempted,parseMetaDirectRecipientSnapshot} from "../../../packages/core/src/meta-direct-identity.js";
import {metaLifecyclePayloadSha256,parseMetaLifecycleState} from "../../../packages/core/src/meta-account-relation.js";
import {ProviderError} from "../../../packages/connectors/src/types.js";
import {parseMetaActualRequestExecution,parseMetaBillingSnapshot} from "../../../packages/core/src/meta-account-policy.js";
import {metaRoutingRuntime} from '../../../packages/core/src/meta-routing.js';
import {assertTicketCommandBarrier} from '../../../packages/core/src/ticket-command-guards.js';
import {directControlDeliveryAllowed,directHumanDeliveryAllowed} from '../../../packages/core/src/direct-delivery-guards.js';
import {queueCustomerControlPrompt} from './direct-keep-open-runtime.js';
import {prepareDirectCustomerClose,recordDirectCloseReceipt,type DirectCloseContext} from '../../../packages/core/src/direct-customer-close.js';
import {resetDirectHumanPauseForCompletedBatch} from '../../../packages/core/src/direct-keep-open.js';
import { Pool, type PoolClient } from "pg";
import { setMetaTestPhoneTransaction } from "../../../packages/core/src/meta-test-phone-policy.js";
import { parseBotFlow, resolveBotHandoff, type BotFlowAdvance } from "../../../packages/core/src/bot-flow.js";
import { directDelivery, storedClientRoute } from "./inbound-repository.js";
import type { BotActionJob, BotHandoffJob, ConversationStateJob, DirectCustomerCloseJob, DeliveryJob, StatusJob } from "./types.js";
import { optionalLocationLabel } from "./direct-location.js";

type DeliveryRow={id:string;tenant_id:string;ticket_event_execution_id:string|null;connection_id:string;group_binding_id:string|null;group_workspace_group_id:string|null;bot_conversation_id:string|null;direct_origin:"BOT"|"HUMAN"|null;bot_content:unknown;meta_direct_recipient:unknown;meta_billing_snapshot:unknown;external_group_id:string;zammad_ticket_id:string|null;zammad_article_id:string|null;message_body:string;content_type:string;reply_to_message_id:string|null;mentions:string[];idempotency_key:string;attempts:number;created_at:string|Date;batch_id:string|null;batch_sequence:number;provider:"WAHA"|"META";opaque_session_id:string;meta_provider_session_id:string;meta_waba_id:string|null;meta_account_proof:unknown;meta_lifecycle:unknown;meta_lifecycle_present:boolean;connection_secret_reference:string;provider_base_url:string|null;waha_worker_id:string|null;assignment_fencing_token:string|number|null;assignment_lease_expires_at:string|Date|null;waha_response_window_seconds:string|number|null;zammad_base_url:string;zammad_secret_reference:string;agent_prefix:string|null;agent_prefix_snapshot:string|null;agent_identity_placement:string|null;agent_display_name:string|null;media_enabled:boolean;retention_days:number;delivery_media_id:string|null;zammad_attachment_id:string|number|null;zammad_upload_id:string|null;zammad_upload_store_id:string|number|null;bot_media_asset_id:string|null;media_filename:string|null;media_mime_type:string|null;media_byte_size:string|number|null;media_state:"PENDING"|"READY"|"FAILED"|null;media_object_id:string|null;object_key:string|null;media_sha256:string|null;stored_mime_type:string|null;stored_byte_size:string|number|null;media_expires_at:string|Date|null;provider_media_id:string|null};
type StatusRow={id:string;delivery_id:string;tenant_id:string;zammad_ticket_id:string;delivery_state:string;external_message_id:string|null;safe_error:string|null;attempts:number;zammad_base_url:string;zammad_secret_reference:string};
type ConversationStateRow={keep_open_enabled:boolean;id:string;tenant_id:string;conversation_id:string;zammad_ticket_id:string;conversation_state:ConversationStateJob["state"];conversation_fencing_token:string|number;attempts:number;zammad_base_url:string;zammad_secret_reference:string};
type BotActionRow={id:string;tenant_id:string;origin:"DIRECT_FLOW"|"QUALIFICATION";conversation_id:string|null;source_event_id:string|null;action_node_id:string;request_input:Record<string,string>;on_success_node_id:string;on_failure_node_id:string;attempts:number;fencing_token:string|number;execution_result_state:"SUCCEEDED"|"FAILED_TERMINAL"|null;execution_result_variables:Record<string,string>|null;execution_result_safe_error:string|null;action_key:string;kind:BotActionJob["kind"];endpoint_url:string;http_method:BotActionJob["httpMethod"];auth_scheme:BotActionJob["authScheme"];secret_reference:string|null;credential_available:boolean;headers:Record<string,string>;response_mapping:Record<string,string>;timeout_ms:number;max_response_bytes:number;flow_definition:unknown|null;conversation_variables:Record<string,string>|null;zammad_ticket_id:string|null;zammad_base_url:string|null;zammad_secret_reference:string|null;assignment_group_id:string|null;client_routing_version_id:string|null;client_route_status:string|null;client_id:string|null;client_route_matched_by:string|null;routing_definition:unknown|null};
type BotHandoffRow={id:string;tenant_id:string;conversation_id:string;handoff_node_id:string;zammad_group_id:string;zammad_owner_id:string|null;priority:BotHandoffJob["priority"];attempts:number;fencing_token:string|number;zammad_ticket_id:string;zammad_base_url:string;zammad_secret_reference:string};

export class OutboxRepository{
  private readonly pool:Pool;
  constructor(pool:Pool){this.pool=pool}
  private async tenant<T>(tenantId:string,operation:(client:PoolClient)=>Promise<T>){const client=await this.pool.connect();try{await client.query("BEGIN");await setMetaTestPhoneTransaction(client,tenantId);const value=await operation(client);await client.query("COMMIT");return value}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}}
  async reconsiderMetaIdentityTransitions(tenantId:string,scope:{conversationIds:string[];deliveryIds:string[];ticketIds:string[];sourceEventIds?:string[]},appId:string){
    return this.tenant(tenantId,async client=>{
      await client.query('SAVEPOINT meta_transition_settlement');
      try{await reconsiderMetaIdentityTransitions(client,tenantId,scope,appId)}catch(error){
        await client.query('ROLLBACK TO SAVEPOINT meta_transition_settlement');
        if(!(error instanceof Error&&'code' in error&&error.code==='55P03'))throw error;
      }
      await client.query('RELEASE SAVEPOINT meta_transition_settlement');
    });
  }
  async claimDeliveries(tenantId:string,leaseId:string,limit=25):Promise<DeliveryJob[]>{return this.tenant(tenantId,async(client)=>{const retention=(await client.query<{media_days:number}>("SELECT media_days FROM retention_policies WHERE tenant_id=$1",[tenantId])).rows[0];if(!retention)return[];const result=await client.query<DeliveryRow>(`WITH claimed AS (SELECT * FROM app.claim_delivery_jobs($1,$2))
    SELECT d.id,d.tenant_id,d.ticket_event_execution_id,d.connection_id,d.group_binding_id,d.group_workspace_group_id,d.bot_conversation_id,d.direct_origin,d.bot_content,d.meta_direct_recipient,d.meta_billing_snapshot,
           COALESCE(g.external_group_id,workspace_group.external_group_id,d.external_chat_id) AS external_group_id,d.zammad_ticket_id,d.zammad_article_id,
           d.message_body,d.content_type,d.reply_to_message_id,d.mentions,d.idempotency_key,d.attempts,d.created_at,d.batch_id,d.batch_sequence,c.provider,ps.opaque_session_id,ps.id AS meta_provider_session_id,ps.provider_state_data->>'wabaId' AS meta_waba_id,ps.provider_state_data->'metaAccountProof' AS meta_account_proof,ps.provider_state_data->'metaLifecycle' AS meta_lifecycle,ps.provider_state_data ? 'metaLifecycle' AS meta_lifecycle_present,
           CASE WHEN c.provider='WAHA' THEN worker.secret_reference ELSE c.secret_reference END AS connection_secret_reference,
           worker.base_url AS provider_base_url,ps.waha_worker_id,ps.assignment_fencing_token,
           ps.assignment_lease_expires_at,policy.response_window_seconds AS waha_response_window_seconds,
           z.base_url AS zammad_base_url,
           z.service_secret_reference AS zammad_secret_reference,b.agent_prefix,d.agent_prefix_snapshot,
           COALESCE(d.agent_identity_placement_snapshot,b.agent_identity_placement,'HEADER') AS agent_identity_placement,d.agent_display_name,
           CASE WHEN d.bot_conversation_id IS NOT NULL OR d.group_workspace_group_id IS NOT NULL THEN true ELSE COALESCE(b.media_enabled,false) END AS media_enabled,
           LEAST(
             COALESCE(b.retention_days,rp.media_days),
             rp.media_days,
             CASE WHEN tenant.group_workspace_enabled AND workspace.capture_enabled
                  THEN workspace.retention_days ELSE rp.media_days END
           ) AS retention_days,
           dm.id AS delivery_media_id,dm.zammad_attachment_id,dm.zammad_upload_id,dm.zammad_upload_store_id,dm.bot_media_asset_id,
           dm.filename AS media_filename,dm.mime_type AS media_mime_type,
           dm.byte_size AS media_byte_size,dm.state AS media_state,dm.media_object_id,dm.provider_media_id,
           mo.object_key,mo.sha256 AS media_sha256,mo.mime_type AS stored_mime_type,mo.byte_size AS stored_byte_size,
           mo.expires_at AS media_expires_at
      FROM claimed d
      JOIN connections c ON c.id=d.connection_id AND c.tenant_id=d.tenant_id
      LEFT JOIN group_bindings b ON b.id=d.group_binding_id AND b.tenant_id=d.tenant_id
      LEFT JOIN whatsapp_groups g ON g.id=b.whatsapp_group_id AND g.tenant_id=d.tenant_id
      LEFT JOIN whatsapp_groups workspace_group ON workspace_group.id=d.group_workspace_group_id AND workspace_group.tenant_id=d.tenant_id
      JOIN tenant_settings tenant ON tenant.tenant_id=d.tenant_id
      LEFT JOIN group_workspace_settings workspace ON workspace.tenant_id=d.tenant_id
        AND workspace.whatsapp_group_id=COALESCE(workspace_group.id,g.id)
      JOIN retention_policies rp ON rp.tenant_id=d.tenant_id
      JOIN LATERAL (SELECT id,opaque_session_id,provider_state_data,waha_worker_id,assignment_fencing_token,assignment_lease_expires_at FROM provider_sessions WHERE tenant_id=d.tenant_id AND connection_id=d.connection_id AND ownership_state='ACTIVE' AND state='WORKING' ORDER BY created_at DESC LIMIT 1) ps ON true
      LEFT JOIN LATERAL app.current_waha_session_runtime(ps.id) worker ON true
        AND worker.health_state='HEALTHY'
        AND worker.lifecycle_state IN ('ACTIVE','DRAINING')
        AND worker.last_heartbeat_at>=now()-make_interval(secs=>worker.heartbeat_ttl_seconds)
        AND ps.assignment_lease_expires_at>=now()
      LEFT JOIN waha_outbound_connection_policies policy ON policy.tenant_id=d.tenant_id AND policy.connection_id=d.connection_id
      JOIN zammad_instances z ON z.tenant_id=d.tenant_id AND z.state='WORKING'
      LEFT JOIN delivery_media dm ON dm.tenant_id=d.tenant_id AND dm.delivery_id=d.id
      LEFT JOIN media_objects mo ON mo.tenant_id=dm.tenant_id AND mo.id=dm.media_object_id AND mo.scan_state='CLEAN'
     WHERE c.state='WORKING' AND (c.provider='META' OR worker.waha_worker_id IS NOT NULL)
     ORDER BY d.created_at,d.id`,[leaseId,limit]);for(const row of result.rows)await client.query("INSERT INTO delivery_attempts (tenant_id,delivery_id,attempt_number,state) VALUES ($1,$2,$3,'CLAIMED') ON CONFLICT (delivery_id,attempt_number) DO NOTHING",[tenantId,row.id,row.attempts]);return result.rows.map(row=>({id:row.id,tenantId:row.tenant_id,...(row.ticket_event_execution_id?{ticketEventExecutionId:row.ticket_event_execution_id}:{}),connectionId:row.connection_id,...(row.group_binding_id?{groupBindingId:row.group_binding_id}:{}),...(row.group_workspace_group_id?{groupWorkspaceGroupId:row.group_workspace_group_id}:{}),...(row.bot_conversation_id?{botConversationId:row.bot_conversation_id}:{}),...(row.direct_origin?{directOrigin:row.direct_origin}:{}),metaDirectRecipientSnapshot:row.meta_direct_recipient??null,metaBillingSnapshot:row.meta_billing_snapshot??null,groupId:row.external_group_id,recipientType:row.bot_conversation_id?"DIRECT":"GROUP",...(row.zammad_ticket_id?{ticketId:row.zammad_ticket_id}:{}),...(row.zammad_article_id?{articleId:row.zammad_article_id}:{}),text:row.message_body,contentType:row.content_type,replyToMessageId:row.reply_to_message_id??undefined,...(row.mentions.length?{mentions:row.mentions}:{}),idempotencyKey:row.idempotency_key,attempts:row.attempts,createdAt:new Date(row.created_at).toISOString(),...(row.batch_id?{batchId:row.batch_id,batchSequence:row.batch_sequence}:{}),provider:row.provider.toLowerCase() as "waha"|"meta",sessionId:row.opaque_session_id,connectionSecretReference:row.connection_secret_reference,...(row.provider==="META"?{metaCredentialContext:{providerSessionId:row.meta_provider_session_id,phoneNumberId:row.opaque_session_id,wabaId:row.meta_waba_id,proof:row.meta_account_proof??null,...(row.meta_lifecycle_present?{lifecycle:row.meta_lifecycle}:{})}}:{}),providerBaseUrl:row.provider_base_url??undefined,wahaWorkerId:row.waha_worker_id??undefined,wahaAssignmentFencingToken:row.assignment_fencing_token==null?undefined:Number(row.assignment_fencing_token),wahaAssignmentLeaseExpiresAt:row.assignment_lease_expires_at==null?undefined:new Date(row.assignment_lease_expires_at).toISOString(),wahaResponseWindowSeconds:row.waha_response_window_seconds==null?undefined:Number(row.waha_response_window_seconds),zammadBaseUrl:row.zammad_base_url,zammadSecretReference:row.zammad_secret_reference,agentPrefix:row.agent_display_name?(row.agent_prefix_snapshot??row.agent_prefix??undefined):undefined,agentDisplayName:row.agent_display_name??undefined,agentIdentityPlacement:row.agent_identity_placement==="FOOTER"||row.agent_identity_placement==="OFF"?row.agent_identity_placement:"HEADER",mediaEnabled:row.media_enabled,retentionDays:row.retention_days,...directContent(row.bot_content),...(row.delivery_media_id&&(row.bot_media_asset_id||row.zammad_attachment_id!=null||(row.zammad_upload_id&&row.zammad_upload_store_id!=null))&&row.media_filename&&row.media_mime_type&&row.media_byte_size!=null&&row.media_state?{media:{id:row.delivery_media_id,...(row.zammad_attachment_id==null?{}:{zammadAttachmentId:Number(row.zammad_attachment_id)}),...(row.zammad_upload_id?{zammadUploadId:row.zammad_upload_id,zammadUploadStoreId:Number(row.zammad_upload_store_id)}:{}),...(row.bot_media_asset_id?{botMediaAssetId:row.bot_media_asset_id}:{}),filename:row.media_filename,mimeType:row.media_mime_type,byteSize:Number(row.media_byte_size),state:row.media_state,mediaObjectId:row.media_object_id??undefined,objectKey:row.object_key??undefined,sha256:row.media_sha256??undefined,storedMimeType:row.stored_mime_type??undefined,storedByteSize:row.stored_byte_size==null?undefined:Number(row.stored_byte_size),expiresAt:row.media_expires_at==null?undefined:new Date(row.media_expires_at).toISOString(),providerMediaId:row.provider_media_id??undefined}}:{})}))})}


  async assertBotActionIdentityCurrent(job:Extract<BotActionJob,{origin:"DIRECT_FLOW"}>,leaseId:string,appId:string){return this.tenant(job.tenantId,async client=>{
    const rows=(await client.query<{conversation_id:string;source_event_id:string;connection_id:string;zammad_ticket_id:string}>(`SELECT action.conversation_id,action.source_event_id,conversation.connection_id,conversation.zammad_ticket_id
      FROM bot_action_jobs action JOIN bot_conversations conversation ON conversation.tenant_id=action.tenant_id AND conversation.id=action.conversation_id
      WHERE action.tenant_id=$1 AND action.id=$2 AND action.origin='DIRECT_FLOW' AND action.state='RUNNING'
        AND action.lease_id=$3 AND action.fencing_token=$4 AND action.lease_expires_at>clock_timestamp()
        AND action.execution_result_state IS NULL AND action.conversation_id=$5 AND action.source_event_id=$6
        AND action.action_node_id=$7 AND conversation.state='ACTION_PENDING' AND conversation.current_node_id=action.action_node_id
        AND conversation.zammad_ticket_id=$8 FOR NO KEY UPDATE OF action,conversation NOWAIT`,
      [job.tenantId,job.id,leaseId,job.fencingToken,job.conversationId,job.sourceEventId,job.actionNodeId,job.zammadTicketId])).rows;
    if(rows.length!==1)throw new MetaDirectEffectNotAttempted();const row=rows[0]!;
    await assertMetaDirectEffectCurrent(client,{tenantId:job.tenantId,conversationId:row.conversation_id,connectionId:row.connection_id,ticketId:row.zammad_ticket_id,sourceEventIds:[row.source_event_id],appId,nonwaiting:true});
  }).catch(error=>{throw this.directEffectAdmissionError(error)})}

  async holdUnattemptedBotActionIdentity(job:Extract<BotActionJob,{origin:"DIRECT_FLOW"}>,leaseId:string){return this.tenant(job.tenantId,async client=>{
    // Only the pre-transport guard calls this. No recorded outcome or pending HTTP can be rewound.
    const changed=await client.query(`UPDATE bot_action_jobs SET state='FAILED_TERMINAL',completed_at=now(),
      safe_error='Meta direct identity requires reconciliation; action not attempted.',
      lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND origin='DIRECT_FLOW'
      AND state='RUNNING' AND lease_id=$3 AND fencing_token=$4 AND execution_result_state IS NULL AND lease_expires_at>clock_timestamp()`,
      [job.tenantId,job.id,leaseId,job.fencingToken]);if(changed.rowCount!==1)throw new Error('Bot action identity hold lease was lost');
  })}

  async assertBotHandoffIdentityCurrent(job:BotHandoffJob,leaseId:string,appId:string){return this.tenant(job.tenantId,async client=>{
    const rows=(await client.query<{conversation_id:string;source_event_id:string;connection_id:string;zammad_ticket_id:string}>(`SELECT handoff.conversation_id,handoff.source_event_id,conversation.connection_id,conversation.zammad_ticket_id
      FROM bot_handoff_jobs handoff JOIN bot_conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
      WHERE handoff.tenant_id=$1 AND handoff.id=$2 AND handoff.state='RUNNING' AND handoff.lease_id=$3
        AND handoff.fencing_token=$4 AND handoff.lease_expires_at>clock_timestamp() AND handoff.conversation_id=$5
        AND handoff.handoff_node_id=$6 AND conversation.state='HANDOFF_PENDING' AND conversation.current_node_id=handoff.handoff_node_id
        AND conversation.zammad_ticket_id=$7 AND handoff.zammad_group_id=$8 AND handoff.zammad_owner_id IS NOT DISTINCT FROM $9
        AND handoff.priority=$10 FOR NO KEY UPDATE OF handoff,conversation NOWAIT`,
      [job.tenantId,job.id,leaseId,job.fencingToken,job.conversationId,job.handoffNodeId,job.zammadTicketId,job.zammadGroupId,job.zammadOwnerId??null,job.priority])).rows;
    if(rows.length!==1)throw new MetaDirectEffectNotAttempted();const row=rows[0]!;
    await assertMetaDirectEffectCurrent(client,{tenantId:job.tenantId,conversationId:row.conversation_id,connectionId:row.connection_id,ticketId:row.zammad_ticket_id,sourceEventIds:[row.source_event_id],appId,nonwaiting:true});
  }).catch(error=>{throw this.directEffectAdmissionError(error)})}

  async assertDirectCustomerCloseIdentityCurrent(job:DirectCustomerCloseJob,leaseId:string,appId:string){return this.tenant(job.tenantId,async client=>{
    const rows=(await client.query<{conversation_id:string;request_event_id:string;confirmation_event_id:string;connection_id:string;zammad_ticket_id:string}>(`SELECT command.conversation_id,command.request_event_id,command.confirmation_event_id,conversation.connection_id,conversation.zammad_ticket_id
      FROM direct_customer_close_commands command JOIN bot_conversations conversation ON conversation.tenant_id=command.tenant_id AND conversation.id=command.conversation_id
      WHERE command.tenant_id=$1 AND command.id=$2 AND command.state IN('QUEUED','ATTEMPTED') AND command.lease_id=$3
        AND command.fencing_token=$4 AND command.lease_expires_at>clock_timestamp() AND conversation.zammad_ticket_id=$5
        AND conversation.state IN('BOT','HUMAN') AND conversation.fencing_token=command.conversation_fencing_token
        AND conversation.human_ownership_epoch=command.human_ownership_epoch
      FOR NO KEY UPDATE OF command,conversation NOWAIT`,[job.tenantId,job.id,leaseId,job.fencingToken,job.ticketId])).rows;
    if(rows.length!==1)throw new MetaDirectEffectNotAttempted();const row=rows[0]!;
    await assertMetaDirectEffectCurrent(client,{tenantId:job.tenantId,conversationId:row.conversation_id,connectionId:row.connection_id,ticketId:row.zammad_ticket_id,sourceEventIds:[row.request_event_id,row.confirmation_event_id],appId,nonwaiting:true});
  }).catch(error=>{throw this.directEffectAdmissionError(error)})}

  private directEffectAdmissionError(error:unknown){return error instanceof MetaDirectEffectNotAttempted?error:
    new MetaDirectEffectNotAttempted((error as {code?:string})?.code==='55P03'?'BUSY':'HELD');}

  async holdUnattemptedDirectCustomerCloseIdentity(job:DirectCustomerCloseJob,leaseId:string){return this.tenant(job.tenantId,async client=>{
    // Exact unattempted state only. A committed ATTEMPTED/UNKNOWN always uses receipt recovery.
    const changed=await client.query(`UPDATE direct_customer_close_commands SET state='FAILED_TERMINAL',
      native_action_snapshot=jsonb_build_object('command_id',id::text,'tenant_id',tenant_id::text,'meta_identity_held',true),
      native_result=jsonb_build_object('state','NOT_ATTEMPTED','reason','META_DIRECT_IDENTITY_HELD'),completed_at=now(),
      lease_id=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2 AND state='QUEUED' AND native_attempted_at IS NULL
        AND lease_id=$3 AND fencing_token=$4 AND lease_expires_at>clock_timestamp()`,[job.tenantId,job.id,leaseId,job.fencingToken]);
    if(changed.rowCount!==1)throw new Error('Customer close unattempted identity hold lease was lost');
  })}

  async claimBotActions(tenantId:string,leaseId:string,limit=25):Promise<BotActionJob[]>{return this.tenant(tenantId,async client=>{
    const rows=(await client.query<BotActionRow>(`WITH claimed AS (SELECT * FROM app.claim_bot_action_jobs($1,$2))
    SELECT job.id,job.tenant_id,job.origin,job.conversation_id,job.source_event_id,job.action_node_id,job.request_input,
           job.on_success_node_id,job.on_failure_node_id,job.attempts,job.fencing_token,
           job.execution_result_state,job.execution_result_variables,job.execution_result_safe_error,
           definition.action_key,revision.kind,
           revision.endpoint_url,revision.http_method,revision.auth_scheme,revision.secret_reference,
           CASE WHEN revision.secret_reference LIKE 'secret://tenants/'||job.tenant_id::text||'/routing/integrations/%'
             THEN EXISTS (SELECT 1 FROM client_routing_integrations integration
               WHERE integration.tenant_id=job.tenant_id AND integration.secret_reference=revision.secret_reference
                 AND integration.provider='NOTION' AND integration.state='CONNECTED') ELSE true END AS credential_available,
           revision.headers,revision.response_mapping,revision.timeout_ms,revision.max_response_bytes,
           flow.definition AS flow_definition,conversation.variables AS conversation_variables,
           conversation.zammad_ticket_id,assignment.zammad_group_id AS assignment_group_id,
           conversation.client_routing_version_id,conversation.client_route_status,conversation.client_id,
           conversation.client_route_matched_by,routing.definition AS routing_definition,
           zammad.base_url AS zammad_base_url,zammad.service_secret_reference AS zammad_secret_reference
      FROM claimed job
      JOIN bot_action_definitions definition ON definition.tenant_id=job.tenant_id AND definition.id=job.action_definition_id
      JOIN bot_action_revisions revision ON revision.tenant_id=job.tenant_id AND revision.id=job.action_revision_id
      LEFT JOIN bot_conversations conversation ON conversation.tenant_id=job.tenant_id AND conversation.id=job.conversation_id
      LEFT JOIN bot_assignments assignment ON assignment.tenant_id=conversation.tenant_id AND assignment.id=conversation.assignment_id
      LEFT JOIN bot_flow_versions flow ON flow.tenant_id=conversation.tenant_id AND flow.id=conversation.flow_version_id
      LEFT JOIN client_routing_versions routing ON routing.tenant_id=conversation.tenant_id AND routing.id=conversation.client_routing_version_id
      LEFT JOIN zammad_instances zammad ON zammad.tenant_id=job.tenant_id AND zammad.state='WORKING'
      WHERE job.origin='QUALIFICATION' OR (conversation.id IS NOT NULL AND assignment.id IS NOT NULL AND flow.id IS NOT NULL AND zammad.id IS NOT NULL)`,[leaseId,limit])).rows;
    return rows.map(row=>{const base={id:row.id,tenantId:row.tenant_id,actionNodeId:row.action_node_id,requestInput:row.request_input,onSuccessNodeId:row.on_success_node_id,onFailureNodeId:row.on_failure_node_id,attempts:row.attempts,fencingToken:Number(row.fencing_token),credentialAvailable:row.credential_available,...recordedBotActionResult(row),actionKey:row.action_key,kind:row.kind,endpointUrl:row.endpoint_url,httpMethod:row.http_method,authScheme:row.auth_scheme,...(row.secret_reference?{secretReference:row.secret_reference}:{}),headers:row.headers,responseMapping:row.response_mapping,timeoutMs:row.timeout_ms,maxResponseBytes:row.max_response_bytes};if(row.origin==='QUALIFICATION')return{...base,origin:row.origin};if(!row.conversation_id||!row.source_event_id||!row.flow_definition||!row.conversation_variables||!row.zammad_ticket_id||!row.zammad_base_url||!row.zammad_secret_reference||!row.assignment_group_id)throw new Error("Direct bot action context is incomplete");const route=storedClientRoute(row.client_routing_version_id,row.routing_definition,row.client_route_status,row.client_id,row.client_route_matched_by);return{...base,origin:row.origin,conversationId:row.conversation_id,sourceEventId:row.source_event_id,flowDefinition:row.flow_definition,conversationVariables:row.conversation_variables,zammadTicketId:row.zammad_ticket_id,zammadBaseUrl:row.zammad_base_url,zammadSecretReference:row.zammad_secret_reference,handoffZammadGroupId:route?.zammadGroupId??row.assignment_group_id,...(route?.ownerId?{handoffZammadOwnerId:route.ownerId}:{}),...(route?{clientRoute:route.decision}:{})}});
  })}

  async claimBotHandoffs(tenantId:string,leaseId:string,limit=25):Promise<BotHandoffJob[]>{return this.tenant(tenantId,async client=>{
    const rows=(await client.query<BotHandoffRow>(`WITH claimed AS (SELECT * FROM app.claim_bot_handoff_jobs($1,$2))
      SELECT job.id,job.tenant_id,job.conversation_id,job.handoff_node_id,job.zammad_group_id,job.zammad_owner_id,job.priority,
             job.attempts,job.fencing_token,conversation.zammad_ticket_id,zammad.base_url AS zammad_base_url,
             zammad.service_secret_reference AS zammad_secret_reference
        FROM claimed job
        JOIN bot_conversations conversation ON conversation.tenant_id=job.tenant_id AND conversation.id=job.conversation_id
          AND conversation.state='HANDOFF_PENDING'
        JOIN zammad_instances zammad ON zammad.tenant_id=job.tenant_id AND zammad.state='WORKING'`,[leaseId,limit])).rows;
    return rows.map(row=>({id:row.id,tenantId:row.tenant_id,conversationId:row.conversation_id,handoffNodeId:row.handoff_node_id,zammadGroupId:row.zammad_group_id,...(row.zammad_owner_id?{zammadOwnerId:row.zammad_owner_id}:{}),priority:row.priority,attempts:row.attempts,fencingToken:Number(row.fencing_token),zammadTicketId:row.zammad_ticket_id,zammadBaseUrl:row.zammad_base_url,zammadSecretReference:row.zammad_secret_reference}));
  })}

  async completeBotHandoff(job:BotHandoffJob,leaseId:string){return this.tenant(job.tenantId,async client=>{
    const locked=(await client.query(`SELECT 1 FROM bot_handoff_jobs job JOIN bot_conversations conversation
      ON conversation.tenant_id=job.tenant_id AND conversation.id=job.conversation_id
      WHERE job.tenant_id=$1 AND job.id=$2 AND job.state='RUNNING' AND job.lease_id=$3
        AND job.fencing_token=$4 AND job.lease_expires_at>=now() AND conversation.state='HANDOFF_PENDING'
      FOR UPDATE OF job,conversation`,[job.tenantId,job.id,leaseId,job.fencingToken])).rowCount;
    if(locked!==1)throw new Error("Bot handoff lease or conversation state was lost");
    const pending=await client.query(`SELECT 1 FROM delivery_outbox WHERE tenant_id=$1 AND bot_conversation_id=$2
      AND direct_origin='BOT' AND ((state IN ('QUEUED','CLAIMED','SENDING','FAILED_RETRYABLE') OR (state IN ('OUTCOME_UNKNOWN','BLOCKED') AND NOT app.delivery_no_further_attempts(tenant_id,id)))
        OR (state='FAILED_TERMINAL' AND manual_retry_allowed)) LIMIT 1`,[job.tenantId,job.conversationId]);
    if(pending.rowCount)throw new Error("Bot replies are still pending before human handoff");
    await client.query("UPDATE bot_conversations SET state='HUMAN',human_ownership_epoch=human_ownership_epoch+1,human_pause_started_at=now(),customer_control=CASE WHEN customer_control->>'epoch'=(human_ownership_epoch+1)::text THEN customer_control ELSE NULL END,fencing_token=fencing_token+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",[job.tenantId,job.conversationId]);
    const controlContext=(await client.query<{connection_id:string;external_chat_id:string;zammad_ticket_id:string;human_ownership_epoch:string|number;definition:unknown}>(`SELECT conversation.connection_id,conversation.external_chat_id,conversation.zammad_ticket_id,conversation.human_ownership_epoch,version.definition
      FROM bot_conversations conversation JOIN bot_flow_versions version ON version.tenant_id=conversation.tenant_id AND version.id=conversation.flow_version_id
      WHERE conversation.tenant_id=$1 AND conversation.id=$2`,[job.tenantId,job.conversationId])).rows[0];
    const controlFlow=controlContext&&parseBotFlow(controlContext.definition);
    const policy=controlFlow?.keepOpenPolicy;
    const handoffNode=controlFlow?.nodes.find(node=>node.id===job.handoffNodeId);
    if(controlContext&&policy)await queueCustomerControlPrompt(client,{tenantId:job.tenantId,connectionId:controlContext.connection_id,
      eventId:job.id,chatId:controlContext.external_chat_id,conversationId:job.conversationId,ticketId:controlContext.zammad_ticket_id,
      epoch:Number(controlContext.human_ownership_epoch),phase:'REQUEST',mainMenu:policy.mainMenu,customerResolution:policy.customerResolution,
      arabic:handoffNode?.type==='handoff'&&/[\u0600-\u06ff]/u.test(handoffNode.message??''),
      ...(handoffNode?.type==='handoff'&&handoffNode.mainMenuReturn?{mainMenuLabel:handoffNode.mainMenuReturn.label}:{})});
    await client.query(`INSERT INTO bot_conversation_events (tenant_id,conversation_id,event_kind,from_node_id,to_node_id,safe_metadata)
      VALUES ($1,$2,'HANDOFF_COMPLETED',$3,$3,$4)`,[job.tenantId,job.conversationId,job.handoffNodeId,JSON.stringify({zammad_routed:true})]);
    const updated=await client.query("UPDATE bot_handoff_jobs SET state='SUCCEEDED',lease_id=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND fencing_token=$4",[job.tenantId,job.id,leaseId,job.fencingToken]);
    if(updated.rowCount!==1)throw new Error("Bot handoff completion fence was lost");
  })}

  async retryBotHandoff(job:BotHandoffJob,leaseId:string,safeError:string,availableAt:string){return this.finishBotHandoff(job,leaseId,"FAILED_RETRYABLE",safeError,availableAt)}
  async failBotHandoff(job:BotHandoffJob,leaseId:string,safeError:string){return this.finishBotHandoff(job,leaseId,"FAILED_TERMINAL",safeError)}
  private async finishBotHandoff(job:BotHandoffJob,leaseId:string,state:"FAILED_RETRYABLE"|"FAILED_TERMINAL",safeError:string,availableAt?:string){return this.tenant(job.tenantId,async client=>{const updated=await client.query(`UPDATE bot_handoff_jobs SET state=$1,safe_error=$2,available_at=COALESCE($3,available_at),lease_id=NULL,
      lease_expires_at=NULL,completed_at=CASE WHEN $1='FAILED_TERMINAL' THEN now() ELSE NULL END,updated_at=now()
      WHERE tenant_id=$4 AND id=$5 AND state='RUNNING' AND lease_id=$6 AND fencing_token=$7`,[state,safeError.slice(0,500),availableAt??null,job.tenantId,job.id,leaseId,job.fencingToken]);if(updated.rowCount!==1)throw new Error("Bot handoff lease was lost")})}

  async retryBotAction(job:BotActionJob,leaseId:string,safeError:string,availableAt:string){return this.tenant(job.tenantId,async client=>{const updated=await client.query(`UPDATE bot_action_jobs SET state='FAILED_RETRYABLE',available_at=$1,safe_error=$2,
      lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$3 AND id=$4 AND state='RUNNING'
      AND lease_id=$5 AND fencing_token=$6`,[availableAt,safeError.slice(0,500),job.tenantId,job.id,leaseId,job.fencingToken]);if(updated.rowCount!==1)throw new Error("Bot action lease was lost")})}

  async recordBotActionResult(job:BotActionJob,leaseId:string,state:"SUCCEEDED"|"FAILED_TERMINAL",variables:Record<string,string>,safeError?:string){return this.tenant(job.tenantId,async client=>{
    const updated=await client.query(`UPDATE bot_action_jobs SET execution_result_state=$1,execution_result_variables=$2,
      execution_result_safe_error=$3,execution_result_recorded_at=now(),updated_at=now()
      WHERE tenant_id=$4 AND id=$5 AND state='RUNNING' AND lease_id=$6 AND fencing_token=$7
        AND lease_expires_at>=now() AND execution_result_state IS NULL`,[
      state,variables,state==="FAILED_TERMINAL"?(safeError??"Bot action failed").slice(0,500):null,
      job.tenantId,job.id,leaseId,job.fencingToken,
    ]);
    if(updated.rowCount!==1)throw new Error("Bot action result fence was lost");
  })}

  async outcomeUnknownBotAction(job:BotActionJob,leaseId:string,safeError:string){return this.tenant(job.tenantId,async client=>{
    if(job.origin==="QUALIFICATION"){
      const updated=await client.query(`UPDATE bot_action_jobs SET state='OUTCOME_UNKNOWN',safe_error=$1,lease_id=NULL,lease_expires_at=NULL,
        completed_at=now(),updated_at=now() WHERE tenant_id=$2 AND id=$3 AND origin='QUALIFICATION' AND state='RUNNING'
        AND lease_id=$4 AND fencing_token=$5`,[safeError.slice(0,500),job.tenantId,job.id,leaseId,job.fencingToken]);
      if(updated.rowCount!==1)throw new Error("Bot action qualification lease was lost");
      return;
    }
    const current=await client.query(`SELECT 1 FROM bot_action_jobs action JOIN bot_conversations conversation
      ON conversation.tenant_id=action.tenant_id AND conversation.id=action.conversation_id
      WHERE action.tenant_id=$1 AND action.id=$2 AND action.state='RUNNING' AND action.lease_id=$3
        AND action.fencing_token=$4 AND action.lease_expires_at>=now() AND conversation.state='ACTION_PENDING'
        AND conversation.current_node_id=action.action_node_id FOR UPDATE OF action,conversation`,[job.tenantId,job.id,leaseId,job.fencingToken]);
    if(current.rowCount!==1)throw new Error("Bot action lease or conversation state was lost");
    await client.query(`UPDATE bot_action_jobs SET state='OUTCOME_UNKNOWN',safe_error=$1,lease_id=NULL,lease_expires_at=NULL,
      completed_at=now(),updated_at=now() WHERE tenant_id=$2 AND id=$3 AND state='RUNNING' AND lease_id=$4 AND fencing_token=$5`,[safeError.slice(0,500),job.tenantId,job.id,leaseId,job.fencingToken]);
    await client.query("UPDATE bot_conversations SET fencing_token=fencing_token+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",[job.tenantId,job.conversationId]);
    await client.query(`INSERT INTO bot_conversation_events (tenant_id,conversation_id,event_kind,from_node_id,to_node_id,safe_metadata)
      VALUES ($1,$2,'ACTION_OUTCOME_UNKNOWN',$3,$3,$4)`,[job.tenantId,job.conversationId,job.actionNodeId,JSON.stringify({operator_resolution_required:true})]);
  })}

  async completeBotActionQualification(job:Extract<BotActionJob,{origin:"QUALIFICATION"}>,leaseId:string,terminalState:"SUCCEEDED"|"FAILED_TERMINAL",variables:Record<string,string>,safeError?:string){return this.tenant(job.tenantId,async client=>{
    const updated=await client.query(`UPDATE bot_action_jobs SET state=$1,response_variables=$2,safe_error=$3,
      lease_id=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now()
      WHERE tenant_id=$4 AND id=$5 AND origin='QUALIFICATION' AND state='RUNNING'
        AND lease_id=$6 AND fencing_token=$7 AND execution_result_state=$1`,[
      terminalState,variables,safeError?.slice(0,500)??null,job.tenantId,job.id,leaseId,job.fencingToken,
    ]);
    if(updated.rowCount!==1)throw new Error("Bot action qualification completion fence was lost");
  })}

  async completeBotAction(job:Extract<BotActionJob,{origin:"DIRECT_FLOW"}>,leaseId:string,terminalState:"SUCCEEDED"|"FAILED_TERMINAL",variables:Record<string,string>,advanced:BotFlowAdvance,safeError?:string){return this.tenant(job.tenantId,async client=>{
    const current=(await client.query<{external_chat_id:string;zammad_ticket_id:string;flow_version_id:string}>(`SELECT conversation.external_chat_id,conversation.zammad_ticket_id,conversation.flow_version_id FROM bot_action_jobs action
      JOIN bot_conversations conversation ON conversation.tenant_id=action.tenant_id AND conversation.id=action.conversation_id
      WHERE action.tenant_id=$1 AND action.id=$2 AND action.state='RUNNING' AND action.lease_id=$3
        AND action.fencing_token=$4 AND action.execution_result_state=$5 AND action.lease_expires_at>=now() AND conversation.state='ACTION_PENDING'
        AND conversation.current_node_id=action.action_node_id FOR UPDATE OF action,conversation`,[job.tenantId,job.id,leaseId,job.fencingToken,terminalState])).rows[0];
    if(!current)throw new Error("Bot action lease or conversation state was lost");
    const merged={...job.conversationVariables,...variables};
    // The job definition is the immutable conversation version loaded by claimBotActions.
    const flow=parseBotFlow(job.flowDefinition),welcomeDeliveryIds:string[]=[];
    let queued=false,welcomeQueued=false;
    for(const [index,effect] of advanced.effects.entries()){
      const delivery=directDelivery(effect);if(!delivery)continue;
      const inserted=await client.query<{id:string}>(`INSERT INTO delivery_outbox
        (tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state,bot_content,direct_origin,created_at,meta_routing_source_event_id)
        SELECT $1,conversation.connection_id,conversation.id,conversation.external_chat_id,conversation.zammad_ticket_id,$2,$3,'text/plain',$4,'QUEUED',$5,'BOT',transaction_timestamp()+$7*interval '1 microsecond',
          CASE WHEN EXISTS(SELECT 1 FROM connections c WHERE c.tenant_id=conversation.tenant_id AND c.id=conversation.connection_id AND c.provider='META') THEN $8::uuid ELSE NULL END
          FROM bot_conversations conversation WHERE conversation.tenant_id=$1 AND conversation.id=$6
        ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id`,[job.tenantId,null,delivery.text,`bot-action:${job.id}:${index}`,delivery.content??null,job.conversationId,index,job.sourceEventId]);
      const deliveryId=inserted.rows[0]?.id;if(deliveryId&&delivery.mediaAssetId){const media=await client.query(`INSERT INTO delivery_media
        (tenant_id,delivery_id,bot_media_asset_id,filename,mime_type,byte_size,state,media_object_id)
        SELECT $1,$2,asset.id,asset.filename,asset.mime_type,asset.byte_size,'READY',asset.media_object_id
          FROM bot_media_assets asset JOIN bot_flow_media_asset_pins pin
            ON pin.tenant_id=asset.tenant_id AND pin.bot_media_asset_id=asset.id AND pin.bot_flow_version_id=$3
         WHERE asset.tenant_id=$1 AND asset.id=$4 AND asset.media_object_id IS NOT NULL AND asset.state IN ('READY','RETIRED')
           AND NOT EXISTS (SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=asset.tenant_id AND target.target_type='MEDIA_OBJECT' AND target.target_id=asset.media_object_id::text AND target.state IN ('PENDING','EXTERNAL_COMPLETE','COMPLETE'))`,[
        job.tenantId,deliveryId,current.flow_version_id,delivery.mediaAssetId,
      ]);if(media.rowCount!==1)throw new Error("Pinned bot media is unavailable")}
      if(deliveryId){welcomeDeliveryIds.push(deliveryId);welcomeQueued=welcomeQueued||effect.nodeId===flow.start;}
      queued=Boolean(deliveryId)||queued;
    }
    if(advanced.state==="ACTION"){
      const next=advanced.effects.find(effect=>effect.type==="action");
      if(!next||next.type!=="action")throw new Error("Next bot action effect is unavailable");
      const definition=(await client.query<{id:string}>("SELECT id FROM bot_action_definitions WHERE tenant_id=$1 AND action_key=$2 AND state='ACTIVE'",[job.tenantId,next.actionId])).rows[0]?.id;
      if(!definition)throw new Error("Next configured bot action is unavailable");
      await client.query(`INSERT INTO bot_action_jobs (tenant_id,conversation_id,action_definition_id,source_event_id,action_node_id,request_input,on_success_node_id,on_failure_node_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[job.tenantId,job.conversationId,definition,job.sourceEventId,next.nodeId,next.input,next.onSuccess,next.onFailure]);
    }
    if(advanced.state==="HANDOFF"){
      const handoff=advanced.effects.find(effect=>effect.type==="handoff");
      if(!handoff||handoff.type!=="handoff")throw new Error("Bot handoff effect is unavailable");
      const target=resolveBotHandoff(handoff,job.handoffZammadGroupId,job.handoffZammadOwnerId,job.clientRoute);
      await client.query(`INSERT INTO bot_handoff_jobs
        (tenant_id,conversation_id,source_event_id,handoff_node_id,zammad_group_id,zammad_owner_id,priority)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[
        job.tenantId,job.conversationId,job.sourceEventId,handoff.nodeId,target.groupId,target.ownerId??null,handoff.priority,
      ]);
    }
    const conversationState=advanced.state==="ACTION"?"ACTION_PENDING":advanced.state==="HANDOFF"?"HANDOFF_PENDING":advanced.state==="RESOLVED"?"RESOLVED":"BOT";
    await client.query(`UPDATE bot_conversations SET state=$1,current_node_id=$2,variables=$3,step_count=step_count+$4,
      fencing_token=fencing_token+1,resolved_at=CASE WHEN $1='RESOLVED' THEN now() ELSE NULL END,
      resolution_kind=CASE WHEN $1='RESOLVED' THEN 'FLOW' ELSE NULL END,updated_at=now()
      WHERE tenant_id=$5 AND id=$6`,[conversationState,advanced.currentNodeId,merged,advanced.steps,job.tenantId,job.conversationId]);
    await client.query(`INSERT INTO bot_conversation_events (tenant_id,conversation_id,event_kind,from_node_id,to_node_id,safe_metadata,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $6::jsonb ? 'welcome_cycle' THEN clock_timestamp() ELSE transaction_timestamp() END)`,[job.tenantId,job.conversationId,terminalState==="SUCCEEDED"?"ACTION_SUCCEEDED":"ACTION_FAILED",job.actionNodeId,advanced.currentNodeId,JSON.stringify({action_state:terminalState,response_variables:Object.keys(variables).sort(),
        ...(flow.welcomeResendMinutes!=null&&welcomeQueued
          ?{welcome_cycle:{flow_version_id:current.flow_version_id,delivery_ids:welcomeDeliveryIds}}:{})})]);
    const updated=await client.query(`UPDATE bot_action_jobs SET state=$1,response_variables=$2,safe_error=$3,
      lease_id=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now() WHERE tenant_id=$4 AND id=$5 AND state='RUNNING' AND lease_id=$6 AND fencing_token=$7`,[terminalState,variables,safeError?.slice(0,500)??null,job.tenantId,job.id,leaseId,job.fencingToken]);
    if(updated.rowCount!==1)throw new Error("Bot action completion fence was lost");
    return{queued,state:conversationState};
  })}
  async beginSend(job:DeliveryJob,leaseId:string){return this.tenant(job.tenantId,async client=>{if(job.ticketId){try{await assertTicketCommandBarrier(client,{tenantId:job.tenantId,ticketId:job.ticketId});}catch(error){
    if(!(error instanceof Error)||error.message!=='QUOTED_COMMAND_EFFECT_HOLD')throw error;
    const deferred=await client.query("UPDATE delivery_outbox SET state='QUEUED',attempts=GREATEST(0,attempts-1),available_at=now()+interval '30 seconds',safe_error='Ticket command outcome is pending.',lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND state='CLAIMED'",[job.tenantId,job.id,leaseId]);
    if(deferred.rowCount!==1)throw new Error('Delivery lease was lost while applying the command fence');
    await client.query("DELETE FROM delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2 AND attempt_number=$3 AND state='CLAIMED'",[job.tenantId,job.id,job.attempts]);return false;
  }}const connection=(await client.query<{state:string}>("SELECT state FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[job.tenantId,job.connectionId])).rows[0];const lifecyclePending=(await client.query("SELECT 1 FROM connection_operations WHERE tenant_id=$1 AND connection_id=$2 AND operation_type IN ('PAUSE','DISCONNECT') AND state IN ('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE') LIMIT 1",[job.tenantId,job.connectionId])).rowCount;const metaSuperseded=job.provider==="meta"&&!await this.metaDeliveryContextCurrent(client,job);if(connection?.state!=="WORKING"||lifecyclePending||metaSuperseded){const deferred=await client.query("UPDATE delivery_outbox SET state='QUEUED',attempts=GREATEST(0,attempts-1),available_at=now()+interval '5 seconds',safe_error='Connection lifecycle change is pending.',lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND state='CLAIMED'",[job.tenantId,job.id,leaseId]);if(deferred.rowCount!==1)throw new Error("Delivery lease was lost while applying the connection lifecycle fence");await client.query("DELETE FROM delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2 AND attempt_number=$3 AND state='CLAIMED'",[job.tenantId,job.id,job.attempts]);return false}
    if(job.provider==="meta")await this.metaBillingCurrent(client,job);
    // Cancel close feedback that was queued for an earlier lifecycle epoch.
    // Lock the correlation before checking it, matching callback row serialization.
    await client.query(`SELECT correlation.id FROM delivery_outbox delivery
      JOIN ticket_event_executions execution ON execution.tenant_id=delivery.tenant_id AND execution.id=delivery.ticket_event_execution_id
      JOIN case_correlations correlation ON correlation.tenant_id=execution.tenant_id AND correlation.id=execution.correlation_id
      WHERE delivery.tenant_id=$1 AND delivery.id=$2 AND execution.event='ticket_closed'
      FOR UPDATE OF correlation`,[job.tenantId,job.id]);
    const staleClosed=await client.query(`UPDATE delivery_outbox delivery
      SET state='FAILED_TERMINAL',manual_retry_allowed=false,safe_error='Close feedback was cancelled because the case changed.',
        lease_id=NULL,lease_expires_at=NULL,updated_at=now()
      FROM ticket_event_executions execution,case_correlations correlation
      WHERE delivery.tenant_id=$1 AND delivery.id=$2 AND delivery.lease_id=$3 AND delivery.state='CLAIMED'
        AND execution.tenant_id=delivery.tenant_id AND execution.id=delivery.ticket_event_execution_id AND execution.event='ticket_closed'
        AND correlation.tenant_id=execution.tenant_id AND correlation.id=execution.correlation_id
        AND (correlation.state<>'RESOLVED' OR correlation.updated_at>execution.created_at)
      RETURNING delivery.id`,[job.tenantId,job.id,leaseId]);
    if(staleClosed.rowCount){
      const detail="Close feedback was cancelled because the case changed.";
      await client.query("UPDATE delivery_attempts SET state='FAILED_TERMINAL',safe_error=$1,finished_at=now() WHERE tenant_id=$2 AND delivery_id=$3 AND attempt_number=$4",[detail,job.tenantId,job.id,job.attempts]);
      await this.queueStatus(client,job,"FAILED_TERMINAL",undefined,detail);
      return false;
    }
    if(job.botConversationId){await client.query("SELECT 1 FROM bot_conversations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[job.tenantId,job.botConversationId]);await client.query("SELECT 1 FROM bot_handoff_jobs WHERE tenant_id=$1 AND conversation_id=$2 AND state IN ('QUEUED','FAILED_RETRYABLE','RUNNING') ORDER BY created_at,id FOR UPDATE",[job.tenantId,job.botConversationId])}const controlAllowed=job.botConversationId?await directControlDeliveryAllowed(client,{tenantId:job.tenantId,conversationId:job.botConversationId,deliveryId:job.id}):false;const blocked=await client.query(`UPDATE delivery_outbox delivery
      SET state='FAILED_TERMINAL',manual_retry_allowed=false,safe_error='Bot reply was cancelled because a person owns the conversation.',
          lease_id=NULL,lease_expires_at=NULL,updated_at=now()
      FROM bot_conversations conversation
      WHERE delivery.tenant_id=$1 AND delivery.id=$2 AND delivery.lease_id=$3 AND delivery.state='CLAIMED'
        AND delivery.direct_origin='BOT' AND conversation.tenant_id=delivery.tenant_id
        AND conversation.id=delivery.bot_conversation_id
        AND ((conversation.state='HUMAN' AND NOT $4::boolean) OR (conversation.state='RESOLVED' AND conversation.resolution_kind IN ('OPERATOR','CUSTOMER_CONFIRMED'))
          OR EXISTS (SELECT 1 FROM bot_handoff_jobs handoff WHERE handoff.tenant_id=conversation.tenant_id
            AND handoff.conversation_id=conversation.id AND handoff.state='RUNNING'))
      RETURNING delivery.id`,[job.tenantId,job.id,leaseId,controlAllowed]);if(blocked.rowCount){await client.query("UPDATE delivery_attempts SET state='FAILED_TERMINAL',safe_error='Bot reply was cancelled because a person owns the conversation.',finished_at=now() WHERE tenant_id=$1 AND delivery_id=$2 AND attempt_number=$3",[job.tenantId,job.id,job.attempts]);await this.queueStatus(client,job,"FAILED_TERMINAL",undefined,"Bot reply was cancelled because a person owns the conversation.");return false}if(job.directOrigin==='HUMAN'&&job.botConversationId&&!await directHumanDeliveryAllowed(client,{tenantId:job.tenantId,conversationId:job.botConversationId,deliveryId:job.id})){
      const cancelled=await client.query("UPDATE delivery_outbox SET state='FAILED_TERMINAL',manual_retry_allowed=false,safe_error='Agent reply belongs to an earlier ownership epoch.',lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND state='CLAIMED'",[job.tenantId,job.id,leaseId]);
      if(cancelled.rowCount!==1)throw new Error('Delivery lease was lost during ownership validation');
      await client.query("UPDATE delivery_attempts SET state='FAILED_TERMINAL',safe_error='Agent reply belongs to an earlier ownership epoch.',finished_at=now() WHERE tenant_id=$1 AND delivery_id=$2 AND attempt_number=$3",[job.tenantId,job.id,job.attempts]);await this.queueStatus(client,job,'FAILED_TERMINAL',undefined,'Agent reply belongs to an earlier ownership epoch.');return false;
    }if(job.provider==="waha"){if(!job.wahaWorkerId||job.wahaAssignmentFencingToken===undefined)throw new Error("WAHA worker assignment is missing");const renewed=await client.query("SELECT waha_worker_id FROM app.renew_waha_session_assignment((SELECT id FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND opaque_session_id=$3 AND ownership_state='ACTIVE'),$4,$5,interval '90 seconds')",[job.tenantId,job.connectionId,job.sessionId,job.wahaWorkerId,job.wahaAssignmentFencingToken]);if(renewed.rowCount!==1)throw new Error("WAHA worker assignment was lost before send");const decision=(await client.query<{authorized:boolean;next_available_at:string|Date|null;reason_code:string}>("SELECT * FROM app.authorize_waha_outbound_send($1)",[job.id])).rows[0];if(!decision?.authorized){if(decision?.reason_code==="NO_RECENT_INBOUND_RESPONSE_WINDOW"&&wahaDeferralExpired(job)){const detail="Delivery expired before a recent inbound response opened the send window.";const expired=await client.query("UPDATE delivery_outbox SET state='FAILED_TERMINAL',manual_retry_allowed=false,safe_error=$1,lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$2 AND id=$3 AND lease_id=$4 AND state='CLAIMED'",[detail,job.tenantId,job.id,leaseId]);if(expired.rowCount!==1)throw new Error("Delivery lease was lost while expiring a stale WAHA reply");await client.query("UPDATE delivery_attempts SET state='FAILED_TERMINAL',safe_error=$1,finished_at=now() WHERE tenant_id=$2 AND delivery_id=$3 AND attempt_number=$4",[detail,job.tenantId,job.id,job.attempts]);await client.query("UPDATE group_disclosure_deliveries SET state='FAILED',updated_at=now() WHERE tenant_id=$1 AND delivery_id=$2 AND state='QUEUED'",[job.tenantId,job.id]);await this.queueStatus(client,job,"FAILED_TERMINAL",undefined,detail);return false}const availableAt=decision?.next_available_at?new Date(decision.next_available_at):new Date(Date.now()+300_000);if(!Number.isFinite(availableAt.getTime()))throw new Error("WAHA outbound safety returned an invalid schedule");const deferred=await client.query("UPDATE delivery_outbox SET state='QUEUED',attempts=GREATEST(0,attempts-1),available_at=$1,safe_error=$2,lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$3 AND id=$4 AND lease_id=$5 AND state='CLAIMED'",[availableAt.toISOString(),`WAHA outbound safety deferred this delivery (${decision?.reason_code??"DENIED"})`.slice(0,500),job.tenantId,job.id,leaseId]);if(deferred.rowCount!==1)throw new Error("Delivery lease was lost while applying WAHA outbound safety");await client.query("DELETE FROM delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2 AND attempt_number=$3 AND state='CLAIMED'",[job.tenantId,job.id,job.attempts]);return false}}const updated=await client.query("UPDATE delivery_outbox SET state='SENDING',lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND state='CLAIMED' AND lease_expires_at>=now() AND content_redacted_at IS NULL AND NOT app.delivery_has_active_privacy_target(id)",[job.tenantId,job.id,leaseId]);if(updated.rowCount!==1){const privacyBlocked=(await client.query<{blocked:boolean}>("SELECT state='PRIVACY_CANCELLED' OR content_redacted_at IS NOT NULL OR app.delivery_has_active_privacy_target(id) AS blocked FROM delivery_outbox WHERE tenant_id=$1 AND id=$2",[job.tenantId,job.id])).rows[0]?.blocked;if(privacyBlocked){await this.cancelClaimForPrivacy(client,job,leaseId);return false}throw new Error("Delivery lease was lost before send")}await client.query("UPDATE delivery_attempts SET state='SENDING' WHERE tenant_id=$1 AND delivery_id=$2 AND attempt_number=$3 AND state='CLAIMED'",[job.tenantId,job.id,job.attempts]);return true})}
  async metaTestRecipientLink(job:DeliveryJob) {
    return this.tenant(job.tenantId,client=>resolveMetaTestRecipientLink(client,{
      tenantId:job.tenantId,connectionId:job.connectionId,deliveryId:job.id,
      appId:process.env.META_APP_ID??"",scope:parseWahaTestRecipientAllowlist(process.env.WASALX_TEST_RECIPIENT_ALLOWLIST),
    }));
  }
  async metaTestRecipientAdmission(job:DeliveryJob) {
    return this.tenant(job.tenantId,client=>metaTestRecipientAdmission(client,{
      tenantId:job.tenantId,connectionId:job.connectionId,deliveryId:job.id,
      appId:process.env.META_APP_ID??"",scope:parseWahaTestRecipientAllowlist(process.env.WASALX_TEST_RECIPIENT_ALLOWLIST),
    }));
  }
  async deferMetaTestRecipient(job:DeliveryJob,leaseId:string) {
    return this.tenant(job.tenantId,async client=>{
      const deferred=await client.query(`UPDATE public.delivery_outbox SET state='QUEUED',attempts=GREATEST(0,attempts-1),
        available_at=now()+interval '5 seconds',safe_error='Verified recipient source is still processing.',
        lease_id=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND state='CLAIMED' AND lease_expires_at>=clock_timestamp()`,[job.tenantId,job.id,leaseId]);
      if(deferred.rowCount!==1)throw new Error("Delivery lease was lost while waiting for recipient evidence");
      await client.query("DELETE FROM public.delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2 AND attempt_number=$3 AND state='CLAIMED'",[job.tenantId,job.id,job.attempts]);
    });
  }
  async admitAgentReplySignal(job: DeliveryJob, leaseId: string, sourceId?: string) {
    return this.tenant(job.tenantId, async client => {
      const privacy = await client.query<{ allowed: boolean }>(
        "SELECT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||$1::text,0)) AS allowed", [job.tenantId],
      );
      if (privacy.rows[0]?.allowed !== true) return;
      if ((await client.query<{ active: boolean }>(
        "SELECT app.lock_current_active_tenant_for_event_admission() AS active",
      )).rows[0]?.active !== true) return;
      const source = (await client.query<{ id: string; messageId: string }>(`WITH latest AS MATERIALIZED (
        SELECT message.id, message.external_message_id AS "messageId"
        FROM delivery_outbox delivery
        JOIN connections connection ON connection.tenant_id=delivery.tenant_id AND connection.id=delivery.connection_id
        JOIN message_links link ON link.tenant_id=delivery.tenant_id AND link.connection_id=delivery.connection_id
          AND link.zammad_ticket_id=delivery.zammad_ticket_id AND link.direction='INBOUND'
        JOIN normalized_messages message ON message.tenant_id=link.tenant_id AND message.connection_id=link.connection_id
          AND message.external_message_id=link.external_message_id AND message.external_group_id=delivery.external_chat_id
        JOIN event_inbox event ON event.tenant_id=message.tenant_id AND event.id=message.event_inbox_id
        WHERE delivery.tenant_id=$1 AND delivery.id=$2 AND delivery.attempts=$4
          AND delivery.direct_origin='HUMAN' AND delivery.delivery_origin='TICKET' AND delivery.batch_sequence=0
          AND ((delivery.state='SENDING' AND delivery.lease_id=$3 AND delivery.lease_expires_at>clock_timestamp())
            OR delivery.state IN ('SENT','DELIVERED','READ'))
          AND delivery.content_redacted_at IS NULL AND NOT app.delivery_has_active_privacy_target(delivery.id)
          AND connection.state='WORKING'
          AND NOT EXISTS (SELECT 1 FROM connection_operations op WHERE op.tenant_id=delivery.tenant_id
            AND op.connection_id=delivery.connection_id AND op.operation_type IN ('PAUSE','DISCONNECT')
            AND op.state IN ('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE'))
          AND message.created_at<=delivery.created_at AND link.created_at<=delivery.created_at
          AND NOT message.from_me AND NOT message.from_api AND message.provider_metadata->'direct'='true'::jsonb
          AND message.provider_metadata->>'input_type'<>'reaction' AND event.status='PROCESSED'
          AND NOT EXISTS (SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=message.tenant_id
            AND target.target_type='NORMALIZED_MESSAGE' AND target.target_id=message.id::text
            AND target.state IN ('PENDING','EXTERNAL_COMPLETE','COMPLETE'))
          AND (connection.provider='WAHA' OR event.meta_direct_asset=$5::jsonb)
        ORDER BY message.provider_timestamp DESC, message.created_at DESC, message.id DESC LIMIT 1
      )
      ${sourceId
        ? 'SELECT id, "messageId" FROM latest WHERE id=$6'
        : `UPDATE normalized_messages message SET agent_reply_signal_claimed_at=clock_timestamp()
            FROM latest WHERE message.tenant_id=$1 AND message.id=latest.id AND message.agent_reply_signal_claimed_at IS NULL
            RETURNING latest.id, latest."messageId"`}`,
      [job.tenantId, job.id, leaseId, job.attempts, job.metaCredentialContext ? JSON.stringify({
        providerSessionId: job.metaCredentialContext.providerSessionId,
        phoneNumberId: job.metaCredentialContext.phoneNumberId,
        wabaId: job.metaCredentialContext.wabaId,
      }) : null, ...(sourceId ? [sourceId] : [])])).rows[0];
      if (!source || !sourceId) return source;
      if (job.provider === "meta") return await this.metaDeliveryContextCurrent(client, job, true, true) ? source : undefined;
      const assignment = await client.query(`SELECT 1 FROM provider_sessions session
        JOIN LATERAL app.current_waha_session_runtime(session.id) runtime ON true
        WHERE session.tenant_id=$1 AND session.connection_id=$2 AND session.opaque_session_id=$3
          AND session.waha_worker_id=$4 AND session.assignment_fencing_token=$5
          AND session.assignment_lease_expires_at>clock_timestamp()
          AND session.ownership_state='ACTIVE' AND session.state='WORKING'
          AND runtime.health_state='HEALTHY' AND runtime.lifecycle_state IN ('ACTIVE','DRAINING')
          AND runtime.last_heartbeat_at>=now()-make_interval(secs=>runtime.heartbeat_ttl_seconds)`,
      [job.tenantId, job.connectionId, job.sessionId, job.wahaWorkerId, job.wahaAssignmentFencingToken]);
      return assignment.rowCount === 1 ? source : undefined;
    }).catch(error => {
      if (error instanceof Error && "code" in error && error.code === "55P03") {
        throw new ProviderError("Reply signal context is busy.", true, "REPLY_SIGNAL_CONTEXT_BUSY");
      }
      throw error;
    });
  }
  private async metaDeliveryContextCurrent(client:PoolClient,job:DeliveryJob,requireWorking=true,nonwaiting=false){
    const context=job.metaCredentialContext;
    if(!context)return false;
    const row=(await client.query<{current:boolean}>(`/* meta_delivery_context_current */
      SELECT c.secret_reference=$3 AND ps.id=$4::uuid AND ps.opaque_session_id=$5
        AND (ps.provider_state_data->>'wabaId') IS NOT DISTINCT FROM $6::text
        AND COALESCE(ps.provider_state_data->'metaAccountProof','null'::jsonb)=$7::jsonb
        AND (NOT $8::boolean OR (c.state='WORKING' AND ps.state='WORKING')) AS current
      FROM connections c JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id
      WHERE c.tenant_id=$1 AND c.id=$2 AND c.provider='META' AND c.state NOT IN ('PAUSED','REVOKED')
        AND ps.ownership_state='ACTIVE'
        -- ACTIVE routes cannot be released; keep this reader compatible with pre-release migration prefixes.
        AND EXISTS(SELECT 1 FROM webhook_routes route WHERE route.tenant_id=c.tenant_id AND route.connection_id=c.id
          AND route.provider='META' AND route.state='ACTIVE') ${nonwaiting ? 'FOR SHARE OF ps NOWAIT' : 'FOR UPDATE OF ps'}`,
      [job.tenantId,job.connectionId,job.connectionSecretReference,context.providerSessionId,context.phoneNumberId,context.wabaId,JSON.stringify(context.proof??null),requireWorking])).rows;
    if(row.length!==1||row[0].current!==true)return false;
    let revision:number;
    try{revision=parseMetaLifecycleState(context.lifecycle)?.revision??0;}catch{return false;}
    const guard=(await client.query<{revision_matches:boolean;blocked:boolean;unresolved_hold:boolean}>(
      "SELECT * FROM app.meta_lifecycle_guard($1,$2,$3,$4,$5,$6)",
      [job.connectionId,context.providerSessionId,context.phoneNumberId,context.wabaId,process.env.META_APP_ID??"",revision])).rows;
    if(guard.length!==1||guard[0].revision_matches!==true||guard[0].blocked!==false||guard[0].unresolved_hold!==false)return false;
    if(job.recipientType!=="DIRECT")return job.metaDirectRecipientSnapshot==null;
    let snapshot:ReturnType<typeof parseMetaDirectRecipientSnapshot>;
    try{snapshot=parseMetaDirectRecipientSnapshot(job.metaDirectRecipientSnapshot);}catch{return false;}
    if(snapshot.asset.providerSessionId!==context.providerSessionId||snapshot.asset.phoneNumberId!==context.phoneNumberId||snapshot.asset.wabaId!==context.wabaId)return false;
    const delivery=await client.query(`SELECT 1 FROM delivery_outbox WHERE tenant_id=$1 AND id=$2 AND connection_id=$3
      AND bot_conversation_id IS NOT NULL AND external_chat_id=$4 AND meta_direct_recipient=$5::jsonb`,
      [job.tenantId,job.id,job.connectionId,job.groupId,JSON.stringify(snapshot)]);
    if(delivery.rowCount!==1)return false;
    let participantId:string|null=null;
    if(snapshot.claim==="ALIAS_VERIFIED"){
      participantId=snapshot.participantId;
      const alias=await client.query(`SELECT 1 FROM meta_direct_identity_aliases alias JOIN participant_identities participant
        ON participant.tenant_id=alias.tenant_id AND participant.connection_id=alias.connection_id AND participant.id=alias.participant_identity_id
        WHERE alias.tenant_id=$1 AND alias.connection_id=$2 AND alias.id=$3 AND alias.participant_identity_id=$4
          AND alias.provider_session_id=$5 AND alias.phone_number_id=$6 AND alias.waba_id=$7
          AND alias.kind=$8 AND alias.value=$9 AND alias.revision=$10 AND alias.state='ACTIVE'
          AND participant.external_participant_id=$11 FOR SHARE OF alias,participant`,
        [job.tenantId,job.connectionId,snapshot.aliasId,snapshot.participantId,context.providerSessionId,context.phoneNumberId,context.wabaId,
          snapshot.recipient.kind,snapshot.recipient.value,snapshot.aliasRevision,job.groupId]);
      if(alias.rowCount!==1)return false;
    }else{
      if(snapshot.recipient.value!==job.groupId)return false;
      const bound=await client.query(`SELECT 1 FROM meta_direct_identity_aliases alias JOIN participant_identities participant
        ON participant.tenant_id=alias.tenant_id AND participant.id=alias.participant_identity_id
        WHERE alias.tenant_id=$1 AND alias.connection_id=$2
          AND ((alias.kind='PHONE' AND alias.value=$3) OR participant.external_participant_id=$3) LIMIT 1`,[job.tenantId,job.connectionId,job.groupId]);
      if(bound.rowCount)return false;
    }
    const identity=(await client.query<{clear:boolean}>("SELECT app.meta_direct_identity_guard($1,$2,$3,$4,$5) AS clear",
      [job.connectionId,context.providerSessionId,context.phoneNumberId,context.wabaId,participantId])).rows[0];
    if(identity?.clear!==true)return false;
    const routing=(await client.query<{allowed:boolean}>(`SELECT guard.allowed FROM delivery_outbox delivery
      CROSS JOIN LATERAL app.meta_direct_routing_guard($1,$2,$3,$4,$5,$6,$7::jsonb,delivery.meta_routing_epoch,
        CASE WHEN delivery.meta_routing_source_event_id IS NULL THEN NULL ELSE ARRAY[delivery.meta_routing_source_event_id] END) guard
      WHERE delivery.tenant_id=$8 AND delivery.id=$9 AND delivery.meta_routing_epoch IS NOT NULL
        AND(guard.claim<>'PRIMARY_DELIVERY' OR(delivery.meta_routing_source_event_id IS NOT NULL AND EXISTS(
          SELECT 1 FROM meta_primary_delivery_admissions admission WHERE admission.tenant_id=delivery.tenant_id
          AND admission.source_event_id=delivery.meta_routing_source_event_id AND admission.created_at<=delivery.created_at)))
        AND(delivery.meta_routing_epoch=0 OR EXISTS(SELECT 1 FROM meta_thread_ownership ownership WHERE ownership.tenant_id=delivery.tenant_id
          AND ownership.connection_id=$1 AND ownership.provider_session_id=$2 AND ownership.participant_identity_id=$5
          AND delivery.created_at>=ownership.epoch_started_at))`,
      [job.connectionId,context.providerSessionId,context.phoneNumberId,context.wabaId,participantId,process.env.META_APP_ID??"",
        JSON.stringify(metaRoutingRuntime(process.env)),job.tenantId,job.id])).rows[0];
    return routing?.allowed===true;
  }
  async assertMetaDeliveryContextCurrent(job:DeliveryJob,leaseId:string){
    if(job.provider!=="meta")return;
    await this.tenant(job.tenantId,async client=>{
      await client.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[job.tenantId,job.connectionId]);
      const current=await this.metaDeliveryContextCurrent(client,job);
      const delivery=await client.query(`SELECT id FROM delivery_outbox WHERE tenant_id=$1 AND id=$2 AND lease_id=$3
        AND state='SENDING' AND lease_expires_at>=now() AND content_redacted_at IS NULL`,[job.tenantId,job.id,leaseId]);
      const pending=await client.query("SELECT 1 FROM connection_operations WHERE tenant_id=$1 AND connection_id=$2 AND operation_type IN ('PAUSE','DISCONNECT') AND state IN ('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE') LIMIT 1",[job.tenantId,job.connectionId]);
      if(!current||delivery.rowCount!==1||pending.rowCount)throw new ProviderError("Meta credential context changed before dispatch.",false,"META_CREDENTIAL_CONTEXT_CHANGED",undefined,true);
    });
  }
  /** Funding only gates send-like effects. Upload/read diagnostics use credential authority. */
  private async metaBillingCurrent(client:PoolClient,job:DeliveryJob) {
    const row=(await client.query<{allowed:boolean}>("SELECT app.meta_billing_delivery_current($1) AS allowed",[job.id])).rows[0];
    if(row?.allowed!==true)throw new ProviderError("Meta payment settings need a fresh review before sending.",false,"META_BILLING_SEND_HELD",undefined,true);
  }
  async assertMetaBillingSendCurrent(job:DeliveryJob,leaseId:string) {
    if(job.provider!=='meta')return;
    await this.tenant(job.tenantId,async client=>{
      if((await client.query<{acquired:boolean}>("SELECT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||$1::text,0)) AS acquired",[job.tenantId])).rows[0]?.acquired!==true)
        throw new ProviderError('Message privacy admission is busy.',true,'META_MESSAGE_NOT_ATTEMPTED',undefined,true);
      if((await client.query<{active:boolean}>('SELECT app.lock_current_active_tenant_for_event_admission() AS active')).rows[0]?.active!==true)
        throw new ProviderError('Workspace message access is held.',false,'META_MESSAGE_NOT_ATTEMPTED',undefined,true);
      await client.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[job.tenantId,job.connectionId]);
      const delivery=await client.query("SELECT id FROM delivery_outbox WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND state='SENDING' AND lease_expires_at>clock_timestamp() AND content_redacted_at IS NULL AND NOT app.delivery_has_active_privacy_target(id) FOR UPDATE",[job.tenantId,job.id,leaseId]);
      if(delivery.rowCount!==1)throw new ProviderError('Message lease is unavailable.',false,'META_MESSAGE_NOT_ATTEMPTED',undefined,true);
      await this.metaBillingCurrent(client,job);
    });
  }
  async metaInheritedTemplateContext(job:DeliveryJob,leaseId:string):Promise<MetaTemplateSendContext|null> {
    if(job.provider!=='meta')return null;
    return this.tenant(job.tenantId,async client=>{
      const row=(await client.query<{value:MetaTemplateSendContext|null}>(
        'SELECT app.meta_inherited_template_send_context($1,$2) AS value',[job.id,leaseId])).rows[0];
      if(!row)throw new ProviderError('Template admission is unavailable.',false,'META_TEMPLATE_SEND_HELD',undefined,true);
      return row.value;
    });
  }
  async admitMetaMessageRequest(job:DeliveryJob,leaseId:string,requestSha256:string,runtime?:MetaRuntimeEvidenceCandidate,requestPhoneNumberId=job.sessionId,templateProof:MetaTemplateSendProof|null=null) {
    if(job.provider!=='meta')return;
    await this.tenant(job.tenantId,async client=>{
      if((await client.query<{acquired:boolean}>("SELECT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||$1::text,0)) AS acquired",[job.tenantId])).rows[0]?.acquired!==true)
        throw new ProviderError('Message privacy admission is busy.',true,'META_MESSAGE_NOT_ATTEMPTED',undefined,true);
      if((await client.query<{active:boolean}>('SELECT app.lock_current_active_tenant_for_event_admission() AS active')).rows[0]?.active!==true)
        throw new ProviderError('Workspace message access is held.',false,'META_MESSAGE_NOT_ATTEMPTED',undefined,true);
      await client.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[job.tenantId,job.connectionId]);
      if(!await this.metaDeliveryContextCurrent(client,job))throw new ProviderError('Meta credential context changed.',false,'META_MESSAGE_NOT_ATTEMPTED',undefined,true);
      // Keep the account observation stable until this exact request stamp commits.
      // Another phone's funding read cannot race the guard and change its evidence.
      await client.query(`SELECT binding.id FROM meta_connection_account_bindings binding JOIN meta_messaging_accounts account
        ON account.tenant_id=binding.tenant_id AND account.id=binding.account_id
        WHERE binding.tenant_id=$1 AND binding.connection_id=$2 AND binding.state='ACTIVE' FOR SHARE OF binding,account`,[job.tenantId,job.connectionId]);
      await this.metaBillingCurrent(client,job);
      const row=(await client.query<{id:string;meta_billing_snapshot:unknown;funding_response_sha256:string|null;funding_observed_at:Date|null;funding_expires_at:Date|null;birth_sha256:string|null}>(`SELECT attempt.id,delivery.meta_billing_snapshot,CASE WHEN delivery.meta_billing_snapshot IS NULL THEN NULL ELSE encode(digest(delivery.meta_billing_snapshot::text,'sha256'),'hex') END AS birth_sha256,account.funding_response_sha256,account.funding_observed_at,account.funding_expires_at
        FROM delivery_outbox delivery JOIN delivery_attempts attempt ON attempt.tenant_id=delivery.tenant_id AND attempt.delivery_id=delivery.id AND attempt.attempt_number=delivery.attempts
        LEFT JOIN meta_connection_account_bindings binding ON binding.tenant_id=delivery.tenant_id AND binding.connection_id=delivery.connection_id AND binding.state='ACTIVE'
          AND (delivery.meta_billing_snapshot IS NULL OR delivery.meta_billing_snapshot->>'claim'='LEGACY_UNATTRIBUTED' OR binding.id::text=delivery.meta_billing_snapshot->>'bindingId')
        LEFT JOIN meta_messaging_accounts account ON account.tenant_id=binding.tenant_id AND account.id=binding.account_id
        WHERE delivery.tenant_id=$1 AND delivery.id=$2 AND delivery.lease_id=$3 AND delivery.state='SENDING' AND delivery.lease_expires_at>clock_timestamp()
          AND delivery.content_redacted_at IS NULL AND NOT app.delivery_has_active_privacy_target(delivery.id)
          AND attempt.state='SENDING' AND attempt.finished_at IS NULL AND attempt.meta_billing_admission IS NULL FOR UPDATE OF delivery,attempt`,[job.tenantId,job.id,leaseId])).rows[0];
      if(!row||!/^[a-f0-9]{64}$/u.test(requestSha256))throw new ProviderError('Message request admission is unavailable.',false,'META_MESSAGE_NOT_ATTEMPTED',undefined,true);
      const snapshot=row.meta_billing_snapshot===null ? null : parseMetaBillingSnapshot(row.meta_billing_snapshot);
      if(metaLifecyclePayloadSha256(snapshot)!==metaLifecyclePayloadSha256(job.metaBillingSnapshot??null))
        throw new ProviderError('Queued payment attribution changed.',false,'META_MESSAGE_NOT_ATTEMPTED',undefined,true);
      // Preserve the actual final route even when birth/account authority is absent.
      // This is a request fact, never an inferred WABA, payer or execution mode.
      if(!/^[0-9]{1,32}$/u.test(requestPhoneNumberId)||requestPhoneNumberId!==job.sessionId)
        throw new ProviderError("Messages request asset changed.",false,"META_MESSAGE_NOT_ATTEMPTED",undefined,true);
      const admission={schemaVersion:1,requestPhoneNumberId,claim:'MESSAGES_REQUEST_ADMITTED',attemptId:row.id,attemptNumber:job.attempts,deliveryId:job.id,
        admittedAt:new Date().toISOString(),requestSha256,snapshot,funding:{responseSha256:row.funding_response_sha256,observedAt:row.funding_observed_at?.toISOString()??null,expiresAt:row.funding_expires_at?.toISOString()??null}};
      let finalAdmission:unknown=admission;
      // Only new schema2 birth or genuine NULL/legacy retains honest new attempt provenance.
      // An older schema1 account birth retains its schema1 authority plus this new request fact.
      if(snapshot===null||snapshot.claim==="LEGACY_UNATTRIBUTED"||snapshot.schemaVersion===2){
        let execution=parseMetaActualRequestExecution({mode:"UNKNOWN",runtimeEvidenceReceiptId:null,runtimeEvidenceSha256:null,transportBindingSha256:null});
        if(runtime&&snapshot?.claim==="ACCOUNT_POLICY_BOUND"){
          execution=parseMetaActualRequestExecution((await client.query<{execution:unknown}>(
            "SELECT app.resolve_meta_runtime_execution($1,$2,$3,$4,$5,$6) AS execution",
            [job.tenantId,snapshot.accountId,runtime.receiptId,runtime.descriptor,runtime.descriptorSha256,runtime.descriptor.transportBindingSha256])).rows[0]?.execution);
        }
        if(snapshot?.schemaVersion===2&&snapshot.payment.mode==="MANAGED"&&execution.mode!==snapshot.payment.managed.evidenceMode)
          throw new ProviderError("Approved message execution authority is unavailable.",false,"META_MESSAGE_NOT_ATTEMPTED",undefined,true);
        finalAdmission={...admission,schemaVersion:2,
          birthDigest:snapshot===null?null:{format:"pg-jsonb-text-v1",sha256:row.birth_sha256},execution,
          providerContext:snapshot?.claim==="ACCOUNT_POLICY_BOUND"?(await client.query<{context:{phoneNumberId:string}|null}>(
            "SELECT app.meta_message_provider_context($1) AS context",[job.connectionId])).rows[0]?.context??null:null};
        if(snapshot?.claim==="ACCOUNT_POLICY_BOUND"&&(!((finalAdmission as {providerContext:{phoneNumberId:string}|null}).providerContext)
          ||(finalAdmission as {providerContext:{phoneNumberId:string}}).providerContext.phoneNumberId!==requestPhoneNumberId))
          throw new ProviderError("Messages request asset changed.",false,"META_MESSAGE_NOT_ATTEMPTED",undefined,true);
      }
      await client.query("UPDATE delivery_attempts SET meta_billing_admission=$1 WHERE tenant_id=$2 AND id=$3",[finalAdmission,job.tenantId,row.id]);
      // Same original attempt and transaction. A changed mapping or signed
      // template negative rolls back payment admission before Messages fetch.
      const templateAdmission=(await client.query<{admitted:boolean}>(
        'SELECT app.record_meta_inherited_template_admission($1,$2,$3,$4) AS admitted',
        [job.id,leaseId,requestSha256,templateProof])).rows[0];
      if(templateAdmission?.admitted!==true)
        throw new ProviderError('Template admission changed.',false,'META_TEMPLATE_SEND_HELD',undefined,true);
    });
  }
  async complete(job:DeliveryJob,leaseId:string,state:string,externalMessageId:string){
    await this.tenant(job.tenantId,async client=>{if(job.botConversationId)await client.query('SELECT id FROM bot_conversations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[job.tenantId,job.botConversationId]);const updated=await client.query("UPDATE delivery_outbox SET state=$1,external_message_id=$2,manual_retry_allowed=false,blocked_by_delivery_id=NULL,lease_id=NULL,lease_expires_at=NULL,safe_error=NULL,updated_at=now() WHERE tenant_id=$3 AND id=$4 AND lease_id=$5 AND state='SENDING'",[state,externalMessageId,job.tenantId,job.id,leaseId]);if(updated.rowCount!==1)throw new Error("Delivery lease was lost");const attempt=await client.query("UPDATE delivery_attempts SET state=$1,finished_at=now(),external_message_id=$5 WHERE tenant_id=$2 AND delivery_id=$3 AND attempt_number=$4 AND state='SENDING' AND finished_at IS NULL AND external_message_id IS NULL",[state,job.tenantId,job.id,job.attempts,externalMessageId]);if(attempt.rowCount!==1)throw new Error("The current delivery attempt was lost");await client.query("UPDATE group_disclosure_deliveries SET state='SENT',external_message_id=$1,updated_at=now() WHERE tenant_id=$2 AND delivery_id=$3 AND state='QUEUED'",[externalMessageId,job.tenantId,job.id]);if(job.botConversationId&&job.directOrigin==='HUMAN')await resetDirectHumanPauseForCompletedBatch(client,{tenantId:job.tenantId,conversationId:job.botConversationId,deliveryId:job.id});const linked=(await client.query<{zammad_ticket_id:string}>("SELECT zammad_ticket_id FROM delivery_ticket_links WHERE tenant_id=$1 AND delivery_id=$2 ORDER BY zammad_ticket_id",[job.tenantId,job.id])).rows;const ticketIds=linked.length?linked.map(row=>row.zammad_ticket_id):job.ticketId?[job.ticketId]:[];const articleId=job.articleId&&/^[1-9][0-9]{0,15}$/u.test(job.articleId)?job.articleId:null;if(job.contentType!=="application/vnd.wasalx.whatsapp-reaction")for(const ticketId of ticketIds)await client.query("INSERT INTO message_links (tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction) VALUES ($1,$2,$3,$4,$5,'OUTBOUND') ON CONFLICT (connection_id,external_message_id,zammad_ticket_id) DO UPDATE SET zammad_article_id=COALESCE(message_links.zammad_article_id,EXCLUDED.zammad_article_id)",[job.tenantId,job.connectionId,externalMessageId,ticketId,articleId]);await this.queueStatus(client,job,state,externalMessageId)});
  }
  async linkMediaObject(job:DeliveryJob,leaseId:string,mediaObjectId:string){if(!job.media)throw new Error("Delivery has no media descriptor");return this.tenant(job.tenantId,async client=>{const updated=await client.query("UPDATE delivery_media descriptor SET state='READY',media_object_id=$1,safe_error=NULL,updated_at=now() FROM delivery_outbox delivery,media_objects media WHERE descriptor.tenant_id=$2 AND descriptor.id=$3 AND descriptor.delivery_id=$4 AND (descriptor.state='PENDING' OR (descriptor.state='READY' AND descriptor.media_object_id=$1)) AND delivery.tenant_id=descriptor.tenant_id AND delivery.id=descriptor.delivery_id AND delivery.lease_id=$5 AND delivery.lease_expires_at>=now() AND delivery.state='SENDING' AND delivery.content_redacted_at IS NULL AND media.tenant_id=descriptor.tenant_id AND media.id=$1 AND media.scan_state='CLEAN' AND NOT EXISTS (SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=media.tenant_id AND target.target_type='MEDIA_OBJECT' AND target.target_id=media.id::text AND target.state IN ('PENDING','EXTERNAL_COMPLETE','COMPLETE'))",[mediaObjectId,job.tenantId,job.media!.id,job.id,leaseId]);if(updated.rowCount!==1)throw new Error("Delivery media link could not be persisted")})}
  async linkProviderMedia(job:DeliveryJob,leaseId:string,providerMediaId:string){if(!job.media)throw new Error("Delivery has no media descriptor");return this.tenant(job.tenantId,async client=>{const updated=await client.query("UPDATE delivery_media descriptor SET provider_media_id=$1,updated_at=now() FROM delivery_outbox delivery WHERE descriptor.tenant_id=$2 AND descriptor.id=$3 AND descriptor.delivery_id=$4 AND descriptor.state='READY' AND (descriptor.provider_media_id IS NULL OR descriptor.provider_media_id=$1) AND delivery.tenant_id=descriptor.tenant_id AND delivery.id=descriptor.delivery_id AND delivery.lease_id=$5 AND delivery.lease_expires_at>=now() AND delivery.state='SENDING' AND delivery.content_redacted_at IS NULL",[providerMediaId,job.tenantId,job.media!.id,job.id,leaseId]);if(updated.rowCount!==1)throw new Error("Provider media link could not be persisted")})}
  private async cancelClaimForPrivacy(client:PoolClient,job:DeliveryJob,leaseId:string){const cancelled=await client.query("UPDATE delivery_outbox SET state='PRIVACY_CANCELLED',manual_retry_allowed=false,blocked_by_delivery_id=NULL,safe_error='Delivery cancelled by privacy lifecycle.',lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND state='CLAIMED' AND app.delivery_has_active_privacy_target(id) RETURNING id",[job.tenantId,job.id,leaseId]);if(!cancelled.rowCount)return false;await client.query("UPDATE delivery_attempts SET state='PRIVACY_CANCELLED',safe_error='Delivery cancelled by privacy lifecycle.',finished_at=COALESCE(finished_at,now()) WHERE tenant_id=$1 AND delivery_id=$2 AND attempt_number=$3 AND finished_at IS NULL",[job.tenantId,job.id,job.attempts]);await client.query("UPDATE group_disclosure_deliveries SET state='FAILED',updated_at=now() WHERE tenant_id=$1 AND delivery_id=$2 AND state='QUEUED'",[job.tenantId,job.id]);return true}
  async renewDeliveryLease(job:DeliveryJob,leaseId:string){return this.tenant(job.tenantId,async client=>{
    // Wait before row locks so privacy contention does not abort lease renewal.
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('privacy:'||$1::uuid::text,0))",[job.tenantId]);
    return(await client.query("UPDATE delivery_outbox SET lease_expires_at=now()+interval '5 minutes',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND state='SENDING' AND lease_expires_at>=now() AND content_redacted_at IS NULL RETURNING id",[job.tenantId,job.id,leaseId])).rowCount===1;
  })}
  async linkBotArticle(job:DeliveryJob,leaseId:string,articleId:string){return this.tenant(job.tenantId,async client=>{const updated=await client.query(`UPDATE delivery_outbox SET zammad_article_id=$1,updated_at=now()
      WHERE tenant_id=$2 AND id=$3 AND lease_id=$4 AND lease_expires_at>=now() AND state='SENDING'
        AND content_redacted_at IS NULL
        AND ((direct_origin='BOT' AND bot_conversation_id IS NOT NULL)
          OR (ticket_event_execution_id=$5 AND content_type='text/plain' AND EXISTS (
            SELECT 1 FROM ticket_event_executions execution JOIN case_correlations correlation
              ON correlation.tenant_id=execution.tenant_id AND correlation.id=execution.correlation_id
            WHERE execution.tenant_id=delivery_outbox.tenant_id AND execution.id=delivery_outbox.ticket_event_execution_id
              AND execution.mode='CUSTOM' AND execution.state='APPLIED' AND execution.event IN ('reference_received','ticket_closed','quoted_command')
              AND correlation.zammad_ticket_id=delivery_outbox.zammad_ticket_id
              AND correlation.group_binding_id=delivery_outbox.group_binding_id)))
        AND (zammad_article_id IS NULL OR zammad_article_id=$1)`,[articleId,job.tenantId,job.id,leaseId,job.ticketEventExecutionId??null]);if(updated.rowCount!==1)throw new Error("Bot article link could not be persisted")})}
  async fail(job:DeliveryJob,leaseId:string,retryable:boolean,safeError:string,availableAt?:string,manualRetryAllowed=false,errorCode?:string,quarantineMediaCode?:string){return this.tenant(job.tenantId,async(client)=>{
    let currentMetaAuthenticationFailure=false;
    if(!retryable&&errorCode==="META_AUTHENTICATION_FAILED"&&job.provider==="meta"){
      // Connection then session before delivery, matching the send/rotation lock order.
      await client.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[job.tenantId,job.connectionId]);
      currentMetaAuthenticationFailure=await this.metaDeliveryContextCurrent(client,job,false);
    }
    const state=retryable?"FAILED_RETRYABLE":"FAILED_TERMINAL";const updated=await client.query("UPDATE delivery_outbox SET state=$1,available_at=COALESCE($2,available_at),safe_error=$3,manual_retry_allowed=CASE WHEN $1='FAILED_TERMINAL' THEN $7 ELSE false END,lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$4 AND id=$5 AND lease_id=$6 AND lease_expires_at>=now() AND state IN ('CLAIMED','SENDING') AND content_redacted_at IS NULL",[state,availableAt??null,safeError.slice(0,500),job.tenantId,job.id,leaseId,manualRetryAllowed]);if(updated.rowCount!==1)throw new Error("Delivery lease was lost");if(!retryable&&quarantineMediaCode&&job.media){await client.query("UPDATE delivery_media SET state='FAILED',safe_error=$1,updated_at=now() WHERE tenant_id=$2 AND id=$3 AND delivery_id=$4",[safeError.slice(0,500),job.tenantId,job.media.id,job.id]);await client.query(`INSERT INTO quarantine_records
    (tenant_id,source_kind,reason_code,state,connection_id,delivery_id,safe_summary,safe_metadata)
    VALUES ($1,'OUTBOUND','OUTBOUND_MEDIA_REJECTED','OPEN',$2,$3,'Outbound media requires operator review',$4::jsonb)
    ON CONFLICT (tenant_id,delivery_id,reason_code) WHERE delivery_id IS NOT NULL DO NOTHING`,[job.tenantId,job.connectionId,job.id,JSON.stringify({error_code:quarantineMediaCode.replace(/[^A-Z0-9_.-]/g,"_").slice(0,64),media_type:job.media.mimeType.slice(0,120),media_size:job.media.byteSize})])}await client.query("UPDATE delivery_attempts SET state=$1,safe_error=$2,provider_code=$6,finished_at=now() WHERE tenant_id=$3 AND delivery_id=$4 AND attempt_number=$5",[state,safeError.slice(0,500),job.tenantId,job.id,job.attempts,errorCode&&/^[A-Za-z0-9_.:-]{1,128}$/.test(errorCode)?errorCode:null]);if(!retryable)await client.query("UPDATE group_disclosure_deliveries SET state='FAILED',updated_at=now() WHERE tenant_id=$1 AND delivery_id=$2 AND state='QUEUED'",[job.tenantId,job.id]);if(currentMetaAuthenticationFailure)await client.query("UPDATE connections SET state='ACTION_REQUIRED',action_reason=$1,updated_at=now() WHERE tenant_id=$2 AND id=$3 AND provider='META' AND state NOT IN ('PAUSED','REVOKED')",[safeError.slice(0,500),job.tenantId,job.connectionId]);await this.queueStatus(client,job,state,undefined,safeError)})}
  async outcomeUnknown(job:DeliveryJob,leaseId:string,safeError:string,errorCode?:string){return this.tenant(job.tenantId,async client=>{const detail=`Provider outcome is unknown; verify the destination before retrying. ${safeError}`.slice(0,500);const updated=await client.query("UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN',manual_retry_allowed=false,safe_error=$1,lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$2 AND id=$3 AND lease_id=$4 AND state='SENDING'",[detail,job.tenantId,job.id,leaseId]);if(updated.rowCount!==1)throw new Error("Delivery lease was lost");await client.query("UPDATE delivery_attempts SET state='OUTCOME_UNKNOWN',safe_error=$1,provider_code=$5,finished_at=now() WHERE tenant_id=$2 AND delivery_id=$3 AND attempt_number=$4",[detail,job.tenantId,job.id,job.attempts,errorCode&&/^[A-Za-z0-9_.:-]{1,128}$/.test(errorCode)?errorCode:null]);await client.query("UPDATE group_disclosure_deliveries SET state='OUTCOME_UNKNOWN',updated_at=now() WHERE tenant_id=$1 AND delivery_id=$2 AND state='QUEUED'",[job.tenantId,job.id]);await this.queueStatus(client,job,"OUTCOME_UNKNOWN",undefined,detail)})}
  private async queueStatus(client:PoolClient,job:DeliveryJob,state:string,externalMessageId?:string,safeError?:string){await client.query("SELECT app.project_delivery_status($1,$2,$3,$4)",[job.id,state,externalMessageId??null,safeError?.slice(0,500)??null])}
  async claimDirectCustomerCloses(tenantId:string,leaseId:string,limit=10):Promise<DirectCustomerCloseJob[]>{return this.tenant(tenantId,async client=>{
    // An abandoned ATTEMPTED lease becomes receipt-only recovery, never a second POST.
    await client.query(`UPDATE direct_customer_close_commands SET state='OUTCOME_UNKNOWN',lease_id=NULL,lease_expires_at=NULL
      WHERE tenant_id=$1 AND state='ATTEMPTED' AND lease_expires_at<now()`,[tenantId]);
    const result=await client.query<{id:string;state:'QUEUED'|'OUTCOME_UNKNOWN';fencing_token:string|number;zammad_ticket_id:string;instance_id:string;base_url:string;secret_reference:string}>(`WITH selected AS (
      SELECT id FROM direct_customer_close_commands WHERE tenant_id=$1 AND state IN ('QUEUED','OUTCOME_UNKNOWN')
        AND (lease_id IS NULL OR lease_expires_at<now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $3
    ), claimed AS (UPDATE direct_customer_close_commands command SET lease_id=$2,lease_expires_at=now()+interval '90 seconds',fencing_token=fencing_token+1
      FROM selected WHERE command.id=selected.id AND command.tenant_id=$1 RETURNING command.*)
    SELECT claimed.id,claimed.state,claimed.fencing_token,conversation.zammad_ticket_id,instance.id AS instance_id,instance.base_url,instance.service_secret_reference AS secret_reference
      FROM claimed JOIN bot_conversations conversation ON conversation.tenant_id=claimed.tenant_id AND conversation.id=claimed.conversation_id
      JOIN zammad_instances instance ON instance.tenant_id=claimed.tenant_id AND instance.state='WORKING'`,[tenantId,leaseId,limit]);
    return result.rows.map(r=>({id:r.id,tenantId,instanceId:r.instance_id,ticketId:r.zammad_ticket_id,state:r.state,fencingToken:Number(r.fencing_token),zammadBaseUrl:r.base_url,zammadSecretReference:r.secret_reference}));
  })}
  async prepareDirectCustomerClose(job:DirectCustomerCloseJob,leaseId:string,context:DirectCloseContext,appId:string=""){return this.tenant(job.tenantId,client=>prepareDirectCustomerClose(client,{tenantId:job.tenantId,instanceId:job.instanceId,commandId:job.id,leaseId,fencingToken:job.fencingToken,context,appId}));}
  async completeDirectCustomerClose(job:DirectCustomerCloseJob,receipt:unknown){return this.tenant(job.tenantId,client=>recordDirectCloseReceipt(client,{tenantId:job.tenantId,commandId:job.id,receipt}));}
  async rejectUnattemptedDirectCustomerClose(job:DirectCustomerCloseJob,leaseId:string,context:DirectCloseContext,reason:string){return this.tenant(job.tenantId,async client=>{
    if(!['DIRECT_CLOSE_NATIVE_ALREADY_CLOSED','DIRECT_CLOSE_CONVERSATION_CHANGED','DIRECT_CLOSE_NATIVE_IDENTITY_CHANGED','DIRECT_PRIVACY_HOLD'].includes(reason))throw new Error('Direct close rejection is not authoritative');
    const changed=await client.query(`UPDATE direct_customer_close_commands SET state='FAILED_TERMINAL',native_action_snapshot=$1,
      native_result=$2,completed_at=now(),lease_id=NULL,lease_expires_at=NULL WHERE tenant_id=$3 AND id=$4 AND state='QUEUED'
      AND lease_id=$5 AND fencing_token=$6`,[{unattempted_native_context:context},{state:'NOT_ATTEMPTED',reason},job.tenantId,job.id,leaseId,job.fencingToken]);
    return changed.rowCount===1;
  })}
  async holdDirectCustomerClose(job:DirectCustomerCloseJob,leaseId:string){return this.tenant(job.tenantId,async client=>{
    await client.query(`UPDATE direct_customer_close_commands SET state=CASE WHEN state='ATTEMPTED' THEN 'OUTCOME_UNKNOWN' ELSE state END,
      lease_id=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND fencing_token=$4
      AND state IN ('QUEUED','ATTEMPTED','OUTCOME_UNKNOWN')`,[job.tenantId,job.id,leaseId,job.fencingToken]);
  })}
  async claimConversationStates(tenantId:string,leaseId:string,limit=25):Promise<ConversationStateJob[]>{return this.tenant(tenantId,async client=>(await client.query<ConversationStateRow>(`WITH claimed AS (SELECT * FROM app.claim_zammad_conversation_state_jobs($1,$2))
    SELECT (jsonb_typeof(version.definition->'keepOpenPolicy')='object') AS keep_open_enabled,job.id,job.tenant_id,job.conversation_id,job.zammad_ticket_id,job.conversation_state,
           job.conversation_fencing_token,job.attempts,zammad.base_url AS zammad_base_url,
           zammad.service_secret_reference AS zammad_secret_reference
      FROM claimed job JOIN zammad_instances zammad ON zammad.tenant_id=job.tenant_id AND zammad.state='WORKING'
      JOIN bot_conversations conversation ON conversation.tenant_id=job.tenant_id AND conversation.id=job.conversation_id
      JOIN bot_flow_versions version ON version.tenant_id=conversation.tenant_id AND version.id=conversation.flow_version_id`,[leaseId,limit])).rows.map(row=>({id:row.id,tenantId:row.tenant_id,conversationId:row.conversation_id,ticketId:row.zammad_ticket_id,state:row.conversation_state,conversationFencingToken:Number(row.conversation_fencing_token),keepOpenEnabled:row.keep_open_enabled===true,attempts:row.attempts,zammadBaseUrl:row.zammad_base_url,zammadSecretReference:row.zammad_secret_reference})))}
  async beginConversationState(job:ConversationStateJob,leaseId:string){return this.tenant(job.tenantId,async client=>{
    const projection=(await client.query<{conversation_id:string;zammad_ticket_id:string;conversation_state:string;conversation_fencing_token:string|number}>(`SELECT conversation_id,zammad_ticket_id,conversation_state,conversation_fencing_token
      FROM zammad_conversation_state_outbox
      WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND lease_expires_at>=now() AND completed_at IS NULL
        AND conversation_fencing_token=$4 AND conversation_state=$5
      FOR UPDATE`,[job.tenantId,job.id,leaseId,job.conversationFencingToken,job.state])).rows[0];
    if(!projection)return false;
    const current=(await client.query<{id:string;state:string;fencing_token:string|number}>(`SELECT id,state,fencing_token FROM bot_conversations
      WHERE tenant_id=$1 AND zammad_ticket_id=$2
      ORDER BY (state<>'RESOLVED') DESC,created_at DESC,id DESC LIMIT 1`,[job.tenantId,projection.zammad_ticket_id])).rows[0];
    if(current?.id===projection.conversation_id&&current.state===projection.conversation_state&&Number(current.fencing_token)===Number(projection.conversation_fencing_token))return true;
    // Same-state inbound activity advances the conversation fence without a new
    // projection. Refresh the pending row, then require a new exact-fence claim.
    if(current?.id===projection.conversation_id&&current.state===projection.conversation_state&&Number(current.fencing_token)>Number(projection.conversation_fencing_token)){
      const refreshed=await client.query(`UPDATE zammad_conversation_state_outbox
        SET conversation_fencing_token=$4,attempts=0,available_at=now(),completed_at=NULL,
          lease_id=NULL,lease_expires_at=NULL,safe_error=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND lease_id=$3
          AND conversation_fencing_token=$5 AND conversation_state=$6`,
        [job.tenantId,job.id,leaseId,Number(current.fencing_token),job.conversationFencingToken,job.state]);
      if(refreshed.rowCount!==1)throw new Error("Conversation-state projection lease was lost");
      return false;
    }
    const retired=await client.query(`UPDATE zammad_conversation_state_outbox
      SET completed_at=now(),lease_id=NULL,lease_expires_at=NULL,safe_error=NULL,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND lease_id=$3`,[job.tenantId,job.id,leaseId]);
    if(retired.rowCount!==1)throw new Error("Conversation-state projection lease was lost");
    return false;
  })}
  async completeConversationState(job:ConversationStateJob,leaseId:string){return this.tenant(job.tenantId,async client=>{
    const completed=await client.query(`UPDATE zammad_conversation_state_outbox SET completed_at=now(),lease_id=NULL,lease_expires_at=NULL,safe_error=NULL,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND conversation_id=$4 AND zammad_ticket_id=$5
        AND conversation_fencing_token=$6 AND conversation_state=$7`,[job.tenantId,job.id,leaseId,job.conversationId,job.ticketId,job.conversationFencingToken,job.state]);
    const current=(await client.query<{id:string;state:string;fencing_token:string|number}>(`SELECT id,state,fencing_token FROM bot_conversations
      WHERE tenant_id=$1 AND zammad_ticket_id=$2
      ORDER BY (state<>'RESOLVED') DESC,created_at DESC,id DESC LIMIT 1`,[job.tenantId,job.ticketId])).rows[0];
    const changed=current&&(current.id!==job.conversationId||current.state!==job.state);
    if(changed){
      // A late HTTP completion can overwrite an already completed successor.
      // Refresh that current state even if token-only activity advanced its fence.
      const requeued=await client.query(`UPDATE zammad_conversation_state_outbox
        SET conversation_fencing_token=$5,attempts=0,available_at=now(),completed_at=NULL,lease_id=NULL,lease_expires_at=NULL,safe_error=NULL,updated_at=now()
        WHERE tenant_id=$1 AND conversation_id=$2 AND zammad_ticket_id=$3
          AND conversation_state=$4 AND conversation_fencing_token<=$5`,[job.tenantId,current.id,job.ticketId,current.state,Number(current.fencing_token)]);
      if(requeued.rowCount===1)return;
    }
    if(completed.rowCount!==1)throw new Error("Conversation-state projection lease was lost");
  })}
  async retryConversationState(job:ConversationStateJob,leaseId:string,error:string,availableAt:string){return this.tenant(job.tenantId,async client=>{const result=await client.query(`UPDATE zammad_conversation_state_outbox SET safe_error=$1,available_at=$2,lease_id=NULL,lease_expires_at=NULL,updated_at=now()
      WHERE tenant_id=$3 AND id=$4 AND lease_id=$5 AND conversation_fencing_token=$6 AND conversation_state=$7`,[error.slice(0,500),availableAt,job.tenantId,job.id,leaseId,job.conversationFencingToken,job.state]);if(result.rowCount!==1)throw new Error("Conversation-state projection lease was lost")})}
  async failConversationState(job:ConversationStateJob,leaseId:string,error:string){return this.tenant(job.tenantId,async client=>{const result=await client.query(`UPDATE zammad_conversation_state_outbox SET safe_error=$1,completed_at=now(),lease_id=NULL,lease_expires_at=NULL,updated_at=now()
      WHERE tenant_id=$2 AND id=$3 AND lease_id=$4 AND conversation_fencing_token=$5 AND conversation_state=$6`,[`TERMINAL: ${error}`.slice(0,500),job.tenantId,job.id,leaseId,job.conversationFencingToken,job.state]);if(result.rowCount!==1)throw new Error("Conversation-state projection lease was lost")})}
  async claimStatuses(tenantId:string,leaseId:string,limit=25):Promise<StatusJob[]>{return this.tenant(tenantId,async(client)=>(await client.query<StatusRow>(`WITH claimed AS (SELECT * FROM app.claim_zammad_status_jobs($1,$2)) SELECT s.id,s.delivery_id,s.tenant_id,s.zammad_ticket_id,s.delivery_state,s.external_message_id,s.safe_error,s.attempts,z.base_url AS zammad_base_url,z.service_secret_reference AS zammad_secret_reference FROM claimed s JOIN zammad_instances z ON z.tenant_id=s.tenant_id`,[leaseId,limit])).rows.map(row=>({id:row.id,deliveryId:row.delivery_id,tenantId:row.tenant_id,ticketId:row.zammad_ticket_id,state:row.delivery_state,externalMessageId:row.external_message_id??undefined,safeError:row.safe_error??undefined,attempts:row.attempts,zammadBaseUrl:row.zammad_base_url,zammadSecretReference:row.zammad_secret_reference})))}
  async completeStatus(job:StatusJob,leaseId:string){return this.tenant(job.tenantId,async(client)=>{const result=await client.query("UPDATE zammad_status_outbox SET completed_at=now(),lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3",[job.tenantId,job.id,leaseId]);if(result.rowCount!==1)throw new Error("Status lease was lost")})}
  async retryStatus(job:StatusJob,leaseId:string,error:string,availableAt:string){return this.tenant(job.tenantId,async(client)=>{const result=await client.query("UPDATE zammad_status_outbox SET safe_error=$1,available_at=$2,lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$3 AND id=$4 AND lease_id=$5",[error.slice(0,500),availableAt,job.tenantId,job.id,leaseId]);if(result.rowCount!==1)throw new Error("Status lease was lost")})}
  async failStatus(job:StatusJob,leaseId:string,error:string){return this.tenant(job.tenantId,async(client)=>{const result=await client.query("UPDATE zammad_status_outbox SET safe_error=$1,completed_at=now(),lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$2 AND id=$3 AND lease_id=$4",[`TERMINAL: ${error}`.slice(0,500),job.tenantId,job.id,leaseId]);if(result.rowCount!==1)throw new Error("Status lease was lost")})}
  async ready(){const result=await this.pool.query<{ok:number}>("SELECT 1 AS ok");return result.rows[0]?.ok===1}
  async close(){await this.pool.end()}
}

export function wahaDeferralExpired(job:Pick<DeliveryJob,"createdAt"|"wahaResponseWindowSeconds">,now=Date.now()){
  const createdAt=Date.parse(job.createdAt??"");
  const windowSeconds=job.wahaResponseWindowSeconds;
  return Number.isFinite(createdAt)&&typeof windowSeconds==="number"&&Number.isSafeInteger(windowSeconds)&&windowSeconds>=300&&now>=createdAt+windowSeconds*1_000
}

function directContent(value:unknown):Pick<DeliveryJob,"choices"|"location"|"template"|"flow">{
  if(!value||typeof value!=="object"||Array.isArray(value))return{};
  const content=value as Record<string,unknown>;
  if(content.type==="media"&&Object.keys(content).length===2&&typeof content.assetId==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(content.assetId))return{};
  if(content.type==="choices"&&Array.isArray(content.options)){
    const options=content.options.filter((option):option is {id:string;label:string}=>Boolean(option&&typeof option==="object"&&!Array.isArray(option)&&typeof (option as Record<string,unknown>).id==="string"&&typeof (option as Record<string,unknown>).label==="string"));
    const buttonLabel=typeof content.buttonLabel==="string"&&content.buttonLabel===content.buttonLabel.trim()&&[...content.buttonLabel].length>=1&&[...content.buttonLabel].length<=20?content.buttonLabel:undefined;
    if(options.length===content.options.length&&options.length>=1&&options.length<=10&&(content.buttonLabel===undefined||buttonLabel))return{choices:{...(buttonLabel?{buttonLabel}:{}),options}};
  }
  if(content.type==="template"&&typeof content.name==="string"&&/^[a-z0-9_]{1,512}$/u.test(content.name)&&typeof content.languageCode==="string"&&/^[a-z]{2,3}(?:_[A-Z]{2})?$/u.test(content.languageCode)&&Array.isArray(content.bodyParameters)&&content.bodyParameters.length<=20&&content.bodyParameters.every(value=>typeof value==="string"&&value===value.trim()&&[...value].length>=1&&[...value].length<=1024))return{template:{name:content.name,languageCode:content.languageCode,bodyParameters:content.bodyParameters as string[]}};
  if(content.type==="flow"&&typeof content.id==="string"&&/^[1-9][0-9]{0,31}$/u.test(content.id)&&typeof content.token==="string"&&/^[A-Za-z0-9_-]{1,510}={0,2}$/u.test(content.token)&&typeof content.buttonLabel==="string"&&content.buttonLabel===content.buttonLabel.trim()&&[...content.buttonLabel].length>=1&&[...content.buttonLabel].length<=30&&(!content.screen||typeof content.screen==="string"&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(content.screen))&&content.data&&typeof content.data==="object"&&!Array.isArray(content.data)){
    const entries=Object.entries(content.data as Record<string,unknown>);if(entries.length<=25&&entries.every(([key,value])=>/^[a-z][a-z0-9_.-]{0,127}$/u.test(key)&&typeof value==="string"&&value===value.trim()&&[...value].length>=1&&[...value].length<=2000))return{flow:{id:content.id,token:content.token,buttonLabel:content.buttonLabel,...(typeof content.screen==="string"?{screen:content.screen}:{}),data:content.data as Record<string,string>}};
  }
  if(content.type==="location"&&typeof content.latitude==="number"&&typeof content.longitude==="number"&&Number.isFinite(content.latitude)&&Number.isFinite(content.longitude)&&content.latitude>=-90&&content.latitude<=90&&content.longitude>=-180&&content.longitude<=180){const name=optionalLocationLabel(content.name,160);const address=optionalLocationLabel(content.address,500);return{location:{latitude:content.latitude,longitude:content.longitude,...(name?{name}:{}),...(address?{address}:{})}}}
  throw new Error("Direct delivery content is invalid");
}

function recordedBotActionResult(row:Pick<BotActionRow,"execution_result_state"|"execution_result_variables"|"execution_result_safe_error">):Pick<BotActionJob,"recordedResult">{
  if(row.execution_result_state===null){
    if(row.execution_result_variables!==null||row.execution_result_safe_error!==null)throw new Error("Bot action recorded result is invalid");
    return{};
  }
  const variables=row.execution_result_variables;
  if(!variables||typeof variables!=="object"||Array.isArray(variables)||Object.values(variables).some(value=>typeof value!=="string"))throw new Error("Bot action recorded result is invalid");
  if(row.execution_result_state==="SUCCEEDED"){
    if(row.execution_result_safe_error!==null)throw new Error("Bot action recorded result is invalid");
    return{recordedResult:{state:"SUCCEEDED",variables}};
  }
  if(!row.execution_result_safe_error)throw new Error("Bot action recorded result is invalid");
  return{recordedResult:{state:"FAILED_TERMINAL",variables,safeError:row.execution_result_safe_error}};
}
