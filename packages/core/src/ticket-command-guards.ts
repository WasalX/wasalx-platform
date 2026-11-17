import type {TicketEventTransaction} from './ticket-event-runtime.js';
import {resolveGroupQuote,findTicketMessage} from './ticket-event-runtime.js';

/** Same current-case universe at preparation and immediately before native write. */
export async function findQuotedCommandCases(client:TicketEventTransaction,input:{tenantId:string;connectionId:string;quoteMessageId:string;bindingId:string}) {
  return (await client.query<{id:string;zammad_ticket_id:string;generation:number;version:string|number;state:string;
    zammad_state_observed_at:string|Date|null;normalized_reference:string;zammad_ticket_number:string;instance_id:string}>(`
    SELECT DISTINCT correlation.id,correlation.zammad_ticket_id,correlation.generation,correlation.version,correlation.state,
      correlation.zammad_state_observed_at,correlation.normalized_reference,correlation.zammad_ticket_number,z.id AS instance_id
    FROM message_links link JOIN case_correlations correlation ON correlation.tenant_id=link.tenant_id
      AND correlation.zammad_ticket_id=link.zammad_ticket_id
    JOIN zammad_instances z ON z.tenant_id=correlation.tenant_id AND z.state='WORKING'
    WHERE link.tenant_id=$1 AND link.connection_id=$2 AND link.external_message_id=$3
      AND correlation.group_binding_id=$4 AND correlation.state IN ('OPEN','RESOLVED')
      AND correlation.replaced_by_correlation_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM case_correlations successor WHERE successor.tenant_id=correlation.tenant_id
        AND successor.group_binding_id=correlation.group_binding_id AND successor.normalized_reference=correlation.normalized_reference
        AND successor.generation>correlation.generation)`,
    [input.tenantId,input.connectionId,input.quoteMessageId,input.bindingId])).rows;
}

/** Legacy snapshots are CLOSE. A denied command can only persist its transcript. */
export function ticketCommandDisposition(snapshot:Record<string,unknown>):'CLOSE'|'TRANSCRIPT_ONLY_DENIED' {
  if(snapshot.disposition===undefined||snapshot.disposition==='CLOSE')return 'CLOSE';
  const plan=snapshot.plan as {effects?:unknown[]}|undefined;
  if(snapshot.disposition!=='TRANSCRIPT_ONLY_DENIED'||snapshot.denied_transcript!=='v1'||snapshot.command_authorized!==false||
    !Array.isArray(plan?.effects)||plan.effects.length!==0||!['AGENTS','SPECIFIC','ANYONE'].includes(String(snapshot.permission)))
    throw new Error('Invalid command disposition');
  return 'TRANSCRIPT_ONLY_DENIED';
}

export async function assertDeniedCommandSource(client:TicketEventTransaction,snapshot:Record<string,unknown>) {
  const source=(await client.query(`SELECT message.id FROM normalized_messages message
    JOIN event_inbox inbox ON inbox.tenant_id=message.tenant_id AND inbox.id=message.event_inbox_id
      AND inbox.connection_id=message.connection_id
    WHERE message.tenant_id=$1 AND message.connection_id=$2 AND message.external_message_id=$3
      AND message.external_group_id=$4 AND message.external_participant_id=$5
      AND message.quoted_external_message_id=$6 AND message.message_text=$7
      AND message.event_inbox_id=$8 AND NOT message.from_me AND NOT message.from_api
      AND NOT COALESCE(message.provider_metadata->'mutations','[]'::jsonb) @> '[{"kind":"REVOKED"}]'::jsonb
      AND NOT EXISTS(SELECT 1 FROM privacy_job_targets privacy WHERE privacy.tenant_id=message.tenant_id
        AND privacy.target_type='NORMALIZED_MESSAGE' AND privacy.target_id=message.id::text
        AND privacy.state IN ('PENDING','EXTERNAL_COMPLETE','COMPLETE'))`,
    [snapshot.tenant_id,snapshot.connection_id,snapshot.message_id,snapshot.external_group_id,snapshot.participant_id,
      snapshot.quoted_message_id,snapshot.command_text,snapshot.original_inbox_id])).rows;
  if(source.length!==1)throw new Error('Denied command source is unavailable');
}

export async function lockTicketCommand(client:TicketEventTransaction,input:{tenantId:string;ticketId:string;instanceId?:string}) {
  const result=await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(
    'zammad-ticket-state:'||$1::text||':'||id::text||':'||$2::text,0))
    FROM zammad_instances WHERE tenant_id=$1::uuid AND state='WORKING'
      AND ($3::uuid IS NULL OR id=$3)`,[input.tenantId,input.ticketId,input.instanceId??null]);
  if(result.rowCount!==1)throw new Error('Native ticket instance is unavailable');
}

/** Call BEFORE the existing ticket-outbound lock, new enqueue/retry/claim/send,
 * or correlate native append/reopen. Existing accepted duplicate readbacks do
 * not create effects and may return before this guard. */
export async function assertTicketCommandBarrier(client:TicketEventTransaction,input:{tenantId:string;ticketId:string;excludeExecutionId?:string}) {
  await lockTicketCommand(client,input);
  const held=(await client.query(`SELECT execution.id FROM ticket_event_executions execution
    JOIN case_correlations correlation ON correlation.tenant_id=execution.tenant_id AND correlation.id=execution.correlation_id
    WHERE execution.tenant_id=$1 AND correlation.zammad_ticket_id=$2
      AND execution.event='quoted_command' AND execution.state='PENDING'
      AND execution.native_action_state IN ('ATTEMPTED','OUTCOME_UNKNOWN')
      AND ($3::uuid IS NULL OR execution.id<>$3)
    UNION ALL SELECT command.id FROM direct_customer_close_commands command JOIN bot_conversations conversation
      ON conversation.tenant_id=command.tenant_id AND conversation.id=command.conversation_id
      WHERE command.tenant_id=$1 AND conversation.zammad_ticket_id=$2 AND (command.state IN ('QUEUED','ATTEMPTED','OUTCOME_UNKNOWN')
        OR (command.state='SUCCEEDED' AND conversation.state IN ('BOT','HUMAN') AND conversation.fencing_token=command.conversation_fencing_token)) LIMIT 1`,
    [input.tenantId,input.ticketId,input.excludeExecutionId??null])).rows[0];
  if(held)throw new Error('QUOTED_COMMAND_EFFECT_HOLD');
}

export async function assertTicketEffectsClear(client:TicketEventTransaction,input:{tenantId:string;ticketId:string}) {
  const effects=(await client.query(`SELECT 'delivery' AS kind,id FROM delivery_outbox
    WHERE tenant_id=$1 AND zammad_ticket_id=$2 AND (
      lease_id IS NOT NULL OR state IN ('QUEUED','CLAIMED','SENDING','FAILED_RETRYABLE')
      OR (state IN ('OUTCOME_UNKNOWN','BLOCKED') AND NOT app.delivery_no_further_attempts(tenant_id,id))
      OR (state='FAILED_TERMINAL' AND manual_retry_allowed))
    UNION ALL SELECT 'action',job.id FROM bot_action_jobs job JOIN bot_conversations conversation
      ON conversation.tenant_id=job.tenant_id AND conversation.id=job.conversation_id
      WHERE job.tenant_id=$1 AND conversation.zammad_ticket_id=$2
        AND (job.lease_id IS NOT NULL OR job.state NOT IN ('SUCCEEDED','FAILED_TERMINAL'))
    UNION ALL SELECT 'handoff',job.id FROM bot_handoff_jobs job JOIN bot_conversations conversation
      ON conversation.tenant_id=job.tenant_id AND conversation.id=job.conversation_id
      WHERE job.tenant_id=$1 AND conversation.zammad_ticket_id=$2
        AND (job.lease_id IS NOT NULL OR job.state NOT IN ('SUCCEEDED','FAILED_TERMINAL'))`,
    [input.tenantId,input.ticketId])).rows;
  if(effects.length)throw new Error('QUOTED_COMMAND_PENDING_EFFECTS');
}

/** For existing ZammadInternalController GET; caller first verifies the signed
 * zammad:ticket-state claims including exact installed native peer. */
export async function ticketCommandAdmission(client:TicketEventTransaction,input:{tenantId:string;instanceId:string;executionId:string;deniedTranscript?:string}) {
  const row=(await client.query<{native_action_state:string;native_action_snapshot:Record<string,unknown>;zammad_ticket_id:string}>(`
    SELECT execution.native_action_state,execution.native_action_snapshot,correlation.zammad_ticket_id
    FROM ticket_event_executions execution JOIN case_correlations correlation
      ON correlation.tenant_id=execution.tenant_id AND correlation.id=execution.correlation_id
    WHERE execution.tenant_id=$1 AND execution.id=$2 AND execution.event='quoted_command'
      AND execution.mode='CUSTOM' AND execution.native_action_state IN ('ATTEMPTED','OUTCOME_UNKNOWN','SUCCEEDED')`,
    [input.tenantId,input.executionId])).rows[0];
  if(!row)throw new Error('Command execution was not found');
  await lockTicketCommand(client,{...input,ticketId:row.zammad_ticket_id});
  const current=(await client.query<{native_action_state:string;native_action_snapshot:Record<string,unknown>;generation:number;version:string|number;state:string;replaced_by_correlation_id:string|null;group_binding_id:string}>(`
    SELECT execution.native_action_state,execution.native_action_snapshot,correlation.generation,correlation.version,
      correlation.state,correlation.replaced_by_correlation_id,correlation.group_binding_id FROM ticket_event_executions execution
      JOIN case_correlations correlation ON correlation.tenant_id=execution.tenant_id AND correlation.id=execution.correlation_id
    WHERE execution.tenant_id=$1 AND execution.id=$2`,
    [input.tenantId,input.executionId])).rows[0];
  if(!current)throw new Error('Command execution changed');
  const snapshot=current.native_action_snapshot;
  if(snapshot.execution_id!==input.executionId||snapshot.tenant_id!==input.tenantId||snapshot.instance_id!==input.instanceId||
    snapshot.ticket_id!==row.zammad_ticket_id)throw new Error('Command execution binding is invalid');
  const denied=ticketCommandDisposition(snapshot)==='TRANSCRIPT_ONLY_DENIED';
  // Required even for receipt recovery: old native code must never receive a denial as CLOSE.
  if(denied&&input.deniedTranscript!=='v1')throw new Error('Native denied transcript capability is required');
  let effectsClear=false;
  if(current.native_action_state==='ATTEMPTED') {
    if(current.state==='DETACHED'||current.replaced_by_correlation_id||current.generation!==snapshot.generation||
      Number(current.version)!==snapshot.correlation_version)throw new Error('Command case changed');
    await assertTicketEffectsClear(client,{tenantId:input.tenantId,ticketId:row.zammad_ticket_id});
    if(denied){
      await assertDeniedCommandSource(client,snapshot);
      const target={tenantId:input.tenantId,connectionId:String(snapshot.connection_id),groupId:String(snapshot.external_group_id),
        requested:String(snapshot.quoted_message_id),ticketId:row.zammad_ticket_id};
      const quote=await resolveGroupQuote(client,target);
      if(!quote.messageId||quote.messageId!==snapshot.resolved_quoted_message_id||await findTicketMessage(client,target)!==quote.messageId)
        throw new Error('Denied command quote is unavailable');
      const cases=await findQuotedCommandCases(client,{...target,quoteMessageId:quote.messageId,bindingId:current.group_binding_id});
      if(cases.length!==1||cases[0]!.id!==snapshot.correlation_id||cases[0]!.zammad_ticket_id!==row.zammad_ticket_id)
        throw new Error('Denied command case is unavailable');
    }
    else {
    // Action permission remains mandatory even for explicitly configured ANYONE.
    const actor=(await client.query<{source_authorized:boolean;member_id:string|null;member_role:string|null;member_email:string|null}>(
      `SELECT * FROM app.ticket_command_actor($1,$2,$3,$4)`,[input.tenantId,snapshot.connection_id,
        snapshot.external_group_id,snapshot.participant_id])).rows[0];
    if(!actor?.source_authorized)throw new Error('Command source is no longer trusted');
    if(snapshot.permission!=='ANYONE' && (actor.member_id!==snapshot.member_id||actor.member_email!==snapshot.member_email))
      throw new Error('Command actor is no longer active');
    if(snapshot.permission==='AGENTS' && !['tenant_owner','tenant_admin','supervisor','agent'].includes(actor.member_role??''))
      throw new Error('Command support role is no longer active');
    }
    effectsClear=true;
  }
  return {...snapshot,native_action_state:current.native_action_state,effects_clear:effectsClear};
}
