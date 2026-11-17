import {createHash} from 'node:crypto';
import {parseTicketEventFlow,planTicketEvent,ticketCommandAllowed} from '../../../packages/core/src/ticket-event-flow.js';
import {findTicketMessage,loadEffectiveTicketEvent,pinTicketEventExecution,resolveGroupQuote,ticketEventSourceHash} from '../../../packages/core/src/ticket-event-runtime.js';
import {assertTicketCommandBarrier,assertTicketEffectsClear,lockTicketCommand,ticketCommandDisposition,assertDeniedCommandSource,findQuotedCommandCases} from '../../../packages/core/src/ticket-command-guards.js';
import type {TicketEventReceipt,TicketEventTransaction} from '../../../packages/core/src/ticket-event-runtime.js';

export type QuotedCommandInput={tenantId:string;connectionId:string;inboxId:string;bindingId:string;groupId:string;participantId:string;
  messageId:string;quotedMessageId?:string;text:string;fromMe?:boolean;fromApi:boolean;hasMedia:boolean;provider:'WAHA'|'META'};
type Candidate={correlationId:string;ticketId:string;groupUuid:string;flowVersionId:string;definition:unknown;generation:number;
  version:string|number;state:string;nativeObservedAt:string|Date|null;reference:string;ticketNumber:string;groupName:string;instanceId:string;quoteMessageId:string};
export type QuotedCommandNativeContext={updatedAt:string;stateId:string;lastArticleId:string;nativeGroupId:string;connectionId:string;externalGroupId:string;activeAgent:boolean;deniedTranscript?:string};

/** This lookup never consults current target, membership or configuration. */
export async function readStoredQuotedCommand(client:TicketEventTransaction,input:QuotedCommandInput) {
  if(!/^\/[a-z][a-z0-9_-]{0,31}$/iu.test(input.text.trim()))return null;
  const source=ticketEventSourceHash('INBOUND',input.connectionId,input.messageId);
  const rows=(await client.query<{id:string;correlation_id:string;mode:'CUSTOM';flow_version_id:string;state:TicketEventReceipt['state'];
    native_action_state:string|null;native_action_snapshot:Record<string,unknown>|null;native_result:unknown}>(
    "SELECT id,correlation_id,mode,flow_version_id,state,native_action_state,native_action_snapshot,native_result FROM ticket_event_executions WHERE tenant_id=$1 AND event='quoted_command' AND source_sha256=$2",
    [input.tenantId,source])).rows;
  if(rows.length>1)throw new Error('Ambiguous command execution');
  const row=rows[0];if(!row)return null;
  return {receipt:{id:row.id,tenantId:input.tenantId,correlationId:row.correlation_id,event:'quoted_command' as const,
    mode:row.mode,flowVersionId:row.flow_version_id,state:row.state},nativeActionState:row.native_action_state,
    snapshot:row.native_action_snapshot,result:row.native_result};
}

/** Execute within this.tenant; no native effects. Existing receipt wins before
 * current config. The caller must terminally reject a configured exact command
 * on unauthorized/missing quote; NEVER fall through to normal correlation. */
export async function resolveQuotedCommand(client:TicketEventTransaction,input:QuotedCommandInput):Promise<Candidate|null> {
  if(!/^\/[a-z][a-z0-9_-]{0,31}$/iu.test(input.text.trim()))return null;
  const source=ticketEventSourceHash('INBOUND',input.connectionId,input.messageId);
  const previous=(await client.query<{flow_version_id:string|null}>(`SELECT flow_version_id FROM ticket_event_executions
    WHERE tenant_id=$1 AND event='quoted_command' AND source_sha256=$2`,[input.tenantId,source])).rows;
  if(previous.length>1)throw new Error('Ambiguous command execution');
  const group=(await client.query<{id:string;name:string}>(`SELECT g.id,COALESCE(g.wasalx_name,g.display_name) AS name
    FROM group_bindings binding JOIN whatsapp_groups g ON g.tenant_id=binding.tenant_id AND g.id=binding.whatsapp_group_id
    WHERE binding.tenant_id=$1 AND binding.id=$2 AND binding.state='ACTIVE'
      AND g.connection_id=$3 AND g.external_group_id=$4`,[input.tenantId,input.bindingId,input.connectionId,input.groupId])).rows[0];
  if(!group)throw new Error('Command group is unavailable');
  const selection=previous[0]?{mode:'CUSTOM' as const,flowVersionId:previous[0].flow_version_id}:
    await loadEffectiveTicketEvent(client,{tenantId:input.tenantId,whatsappGroupId:group.id,event:'quoted_command'});
  if(selection.mode!=='CUSTOM'||!selection.flowVersionId)return null;
  const version=(await client.query<{definition:unknown}>(`SELECT definition FROM bot_flow_versions
    WHERE tenant_id=$1 AND id=$2 AND state IN ('ACTIVE','RETIRED')`,[input.tenantId,selection.flowVersionId])).rows[0];
  if(!version)throw new Error('Pinned command workflow is unavailable');
  const definition=parseTicketEventFlow(version.definition);
  if(definition.event!=='quoted_command')throw new Error('Command workflow type mismatch');
  if(input.text.trim()!==definition.command)return null;
  if(!input.quotedMessageId||input.fromMe||input.fromApi||/[\p{Cc}\p{Cf}]/u.test(input.quotedMessageId))throw new Error('QUOTED_COMMAND_UNAUTHORIZED_SOURCE');
  const quote=await resolveGroupQuote(client,{...input,requested:input.quotedMessageId});
  if(!quote.messageId)throw new Error('QUOTED_COMMAND_TARGET_UNAVAILABLE');
  const target=await findQuotedCommandCases(client,{...input,quoteMessageId:quote.messageId});
  if(target.length!==1)throw new Error('QUOTED_COMMAND_TARGET_UNAVAILABLE');
  const row=target[0]!;
  const eligible=await findTicketMessage(client,{tenantId:input.tenantId,connectionId:input.connectionId,
    groupId:input.groupId,ticketId:row.zammad_ticket_id,requested:input.quotedMessageId});
  if(eligible!==quote.messageId)throw new Error('QUOTED_COMMAND_TARGET_UNAVAILABLE');
  return {correlationId:row.id,ticketId:row.zammad_ticket_id,groupUuid:group.id,flowVersionId:selection.flowVersionId,
    definition,generation:row.generation,version:row.version,state:row.state,nativeObservedAt:row.zammad_state_observed_at,
    reference:row.normalized_reference,ticketNumber:row.zammad_ticket_number,groupName:group.name,instanceId:row.instance_id,quoteMessageId:quote.messageId};
}

/** Native context is a real service-authenticated read, not supplied flags. */
export async function prepareQuotedCommand(client:TicketEventTransaction,input:QuotedCommandInput,candidate:Candidate,native:QuotedCommandNativeContext) {
  await lockTicketCommand(client,{tenantId:input.tenantId,ticketId:candidate.ticketId,instanceId:candidate.instanceId});
  const current=await resolveQuotedCommand(client,input);
  if(!current||current.correlationId!==candidate.correlationId||current.flowVersionId!==candidate.flowVersionId||
    current.generation!==candidate.generation||Number(current.version)!==Number(candidate.version)||current.quoteMessageId!==candidate.quoteMessageId)throw new Error('Command admission changed');
  const locked=(await client.query<{generation:number;version:string|number;state:string;replaced_by_correlation_id:string|null}>(
    'SELECT generation,version,state,replaced_by_correlation_id FROM case_correlations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
    [input.tenantId,candidate.correlationId])).rows[0];
  if(!locked||locked.generation!==candidate.generation||Number(locked.version)!==Number(candidate.version)||locked.state==='DETACHED'||locked.replaced_by_correlation_id)
    throw new Error('Command case changed while waiting for its lock');
  const stored=await readStoredQuotedCommand(client,input);
  if(stored?.nativeActionState&&stored.snapshot){
    if(ticketCommandDisposition(stored.snapshot)==='TRANSCRIPT_ONLY_DENIED'&&stored.nativeActionState==='PREPARED'&&native.deniedTranscript!=='v1')
      throw new Error('Native denied transcript capability is required');
    return {receipt:stored.receipt,plan:stored.snapshot.plan as ReturnType<typeof planTicketEvent>,quoteMessageId:candidate.quoteMessageId,
      state:stored.receipt.state==='PENDING'?stored.nativeActionState:'TERMINAL',snapshot:stored.snapshot,result:stored.result};
  }
  const actor=(await client.query<{source_authorized:boolean;member_id:string|null;member_role:string|null;member_email:string|null}>(
    'SELECT * FROM app.ticket_command_actor($1,$2,$3,$4)',[input.tenantId,input.connectionId,input.groupId,input.participantId])).rows[0];
  const definition=parseTicketEventFlow(candidate.definition);
  const agentRole=['tenant_owner','tenant_admin','supervisor','agent'].includes(actor?.member_role??'');
  const commandActor={sourceAuthorized:actor?.source_authorized===true,activeMember:!!actor?.member_id,
    activeAgent:!!actor?.member_id&&agentRole&&native.activeAgent,...(actor?.member_id?{memberId:actor.member_id}:{})};
  const denied=!ticketCommandAllowed(definition.permission!,commandActor);
  if(denied&&native.deniedTranscript!=='v1')throw new Error('Native denied transcript capability is required');
  const plan:ReturnType<typeof planTicketEvent>=denied?{effects:[],skippedNodeIds:[],steps:0,replyTransformed:false}:planTicketEvent(definition,{provider:input.provider,reactions:input.provider==='WAHA',
    variables:{'event.kind':'quoted_command','provider.kind':input.provider,'group.name':candidate.groupName,
      'case.number':candidate.ticketNumber,'case.reference':candidate.reference,'case.state':candidate.state,
      'case.transition':'CLOSED','message.text':input.text,'message.has_media':input.hasMedia,
      'sender.kind':actor?.member_id&&agentRole?'AGENT':'CUSTOMER','command.text':input.text},
    actor:commandActor,
    quotes:{explicitRequested:true,explicit:{messageId:candidate.quoteMessageId,authorized:true}}});
  if(native.connectionId!==input.connectionId||native.externalGroupId!==input.groupId)throw new Error('Native destination changed');
  const receipt=await pinTicketEventExecution(client,{tenantId:input.tenantId,correlationId:candidate.correlationId,event:'quoted_command',
    sourceSha256:ticketEventSourceHash('INBOUND',input.connectionId,input.messageId),selection:{mode:'CUSTOM',flowVersionId:candidate.flowVersionId}});
  const prior=(await client.query<{native_action_state:string|null;native_action_snapshot:Record<string,unknown>|null;native_result:unknown}>(
    'SELECT native_action_state,native_action_snapshot,native_result FROM ticket_event_executions WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
    [input.tenantId,receipt.id])).rows[0]!;
  if(receipt.state!=='PENDING')return {receipt,plan,quoteMessageId:candidate.quoteMessageId,state:'TERMINAL',snapshot:prior.native_action_snapshot,result:prior.native_result};
  if(prior.native_action_state)return {receipt,plan:prior.native_action_snapshot!.plan,quoteMessageId:candidate.quoteMessageId,state:prior.native_action_state,snapshot:prior.native_action_snapshot,result:prior.native_result};
  if(!denied&&!plan.effects.some(effect=>effect.type==='close_ticket'))return {receipt,plan,quoteMessageId:candidate.quoteMessageId,state:'NO_NATIVE_ACTION',snapshot:null,result:null};
  const snapshot={tenant_id:input.tenantId,instance_id:candidate.instanceId,execution_id:receipt.id,
    ...(denied?{disposition:'TRANSCRIPT_ONLY_DENIED',denied_transcript:'v1',command_authorized:false,command_actor:commandActor}:{}),
    ticket_id:candidate.ticketId,correlation_id:candidate.correlationId,generation:candidate.generation,correlation_version:Number(candidate.version),
    native_observed_at:candidate.nativeObservedAt,connection_id:input.connectionId,external_group_id:input.groupId,
    participant_id:input.participantId,member_id:actor?.member_id??null,member_email:actor?.member_email??null,permission:definition.permission!.mode,
    expected_native_updated_at:native.updatedAt,expected_native_state_id:native.stateId,expected_native_article_id:native.lastArticleId,
    native_group_id:native.nativeGroupId,plan,command_text:denied?input.text:input.text.trim(),message_id:input.messageId,
    quoted_message_id:input.quotedMessageId,resolved_quoted_message_id:candidate.quoteMessageId,original_inbox_id:input.inboxId,source_sha256:ticketEventSourceHash('INBOUND',input.connectionId,input.messageId)};
  const requestSha256=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const sealed={...snapshot,request_sha256:requestSha256};
  if(denied)await assertDeniedCommandSource(client,sealed);
  await client.query(`UPDATE ticket_event_executions SET native_action_state='PREPARED',native_action_snapshot=$1
    WHERE tenant_id=$2 AND id=$3 AND state='PENDING' AND native_action_state IS NULL`,[sealed,input.tenantId,receipt.id]);
  // The received command exists before close feedback; native article identity
  // is filled only after the atomic native receipt has been proven.
  await client.query("INSERT INTO message_links (tenant_id,connection_id,external_message_id,zammad_ticket_id,direction,quoted_external_message_id) VALUES ($1,$2,$3,$4,'INBOUND',$5) ON CONFLICT (connection_id,external_message_id,zammad_ticket_id) DO NOTHING",
    [input.tenantId,input.connectionId,input.messageId,candidate.ticketId,input.quotedMessageId]);
  return {receipt,plan,quoteMessageId:candidate.quoteMessageId,state:'PREPARED',snapshot:sealed,result:null};
}

/** this.tenant must commit this method before native POST. Native read context
 * was checked above; native endpoint compares it again under Ticket.with_lock. */
export async function claimQuotedCommand(client:TicketEventTransaction,input:QuotedCommandInput,executionId:string) {
  const row=(await client.query<{native_action_snapshot:Record<string,unknown>;native_action_state:string}>(
    'SELECT native_action_snapshot,native_action_state FROM ticket_event_executions WHERE tenant_id=$1 AND id=$2',
    [input.tenantId,executionId])).rows[0];
  if(!row||row.native_action_state!=='PREPARED')return false;
  const snapshot=row.native_action_snapshot;
  await assertTicketCommandBarrier(client,{tenantId:input.tenantId,ticketId:String(snapshot.ticket_id),excludeExecutionId:executionId});
  const current=await resolveQuotedCommand(client,input);
  if(!current||current.correlationId!==snapshot.correlation_id||current.generation!==snapshot.generation||
    Number(current.version)!==snapshot.correlation_version||
    current.quoteMessageId!==(snapshot.resolved_quoted_message_id??snapshot.quoted_message_id))throw new Error('Command case changed');
  await assertTicketEffectsClear(client,{tenantId:input.tenantId,ticketId:current.ticketId});
  if(ticketCommandDisposition(snapshot)==='TRANSCRIPT_ONLY_DENIED')await assertDeniedCommandSource(client,snapshot);
  else {
  const actor=(await client.query<{source_authorized:boolean;member_id:string|null;member_role:string|null;member_email:string|null}>(
    'SELECT * FROM app.ticket_command_actor($1,$2,$3,$4)',[input.tenantId,input.connectionId,input.groupId,input.participantId])).rows[0];
  if(!actor?.source_authorized|| (snapshot.permission!=='ANYONE'&&actor.member_id!==snapshot.member_id)||
    (snapshot.permission==='AGENTS'&&!['tenant_owner','tenant_admin','supervisor','agent'].includes(actor.member_role??'')))throw new Error('Command actor changed');
  }
  const claimed=await client.query(`UPDATE ticket_event_executions SET native_action_state='ATTEMPTED',native_attempted_at=now()
    WHERE tenant_id=$1 AND id=$2 AND state='PENDING' AND native_action_state='PREPARED'`,[input.tenantId,executionId]);
  return claimed.rowCount===1;
}
