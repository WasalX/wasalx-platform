import type {BotKeepOpenPolicy} from './bot-flow.js';
import type {TicketEventTransaction} from './ticket-event-runtime.js';

export const BOT_CUSTOMER_CONFIRMATION_TTL_SECONDS=600;
export type DirectKeepOpenControl='MAIN_MENU'|'RESOLUTION_REQUEST'|'CONFIRM_RESOLUTION'|'KEEP_OPEN';
export function directKeepOpenTextControl(text:string,policy:BotKeepOpenPolicy|undefined):DirectKeepOpenControl|null {
  const value=text.normalize('NFC').trim().toLocaleLowerCase('en-US');
  if(policy?.mainMenu&&['main menu','القائمة الرئيسية'].includes(value))return 'MAIN_MENU';
  if(policy?.customerResolution&&['resolve my ticket','حل تذكرتي'].includes(value))return 'RESOLUTION_REQUEST';
  return null;
}
export function directHumanPauseExpired(policy:BotKeepOpenPolicy|undefined,anchor:string|Date|null,inputAt:string|Date):boolean {
  if(policy?.humanReplyPauseMinutes==null||anchor==null)return false;
  const started=new Date(anchor).getTime(),received=new Date(inputAt).getTime();
  return Number.isFinite(started)&&Number.isFinite(received)&&received>=started+policy.humanReplyPauseMinutes*60_000;
}

/** Native pre-commit admission must never wait while holding a native ticket
 * transaction. Inbound holds this route lock while appending the native article. */
export async function tryLockDirectConversation(client:TicketEventTransaction,input:{tenantId:string;assignmentId:string;chatId:string;conversationId:string}) {
  const route=`${input.tenantId}:${input.assignmentId}:${input.chatId}`;
  const acquired=(await client.query<{acquired:boolean}>(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[route])).rows[0]?.acquired;
  if(!acquired)throw new Error('DIRECT_CONVERSATION_BUSY');
  return (await client.query<{id:string}>(
    'SELECT id FROM bot_conversations WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT',[input.tenantId,input.conversationId])).rows[0];
}

export async function assertDirectNativeBarrier(client:TicketEventTransaction,input:{tenantId:string;conversationId:string;excludeReplyIntentId?:string;excludeCloseCommandId?:string}) {
  const pending=(await client.query(`SELECT 'reply' AS kind,id FROM direct_native_reply_intents
    WHERE tenant_id=$1 AND conversation_id=$2 AND state IN ('PENDING','OUTCOME_UNKNOWN')
      AND ($3::uuid IS NULL OR id<>$3)
    UNION ALL SELECT 'close',id FROM direct_customer_close_commands
    WHERE tenant_id=$1 AND conversation_id=$2 AND (state IN ('QUEUED','ATTEMPTED','OUTCOME_UNKNOWN')
      OR (state='SUCCEEDED' AND EXISTS(SELECT 1 FROM bot_conversations conversation WHERE conversation.tenant_id=$1 AND conversation.id=$2
        AND conversation.state IN ('BOT','HUMAN') AND conversation.fencing_token=direct_customer_close_commands.conversation_fencing_token)))
      AND ($4::uuid IS NULL OR id<>$4) LIMIT 1`,
    [input.tenantId,input.conversationId,input.excludeReplyIntentId??null,input.excludeCloseCommandId??null])).rows;
  if(pending.length)throw new Error('DIRECT_NATIVE_EFFECT_HOLD');
}

/** Caller holds the conversation row. Exclusions are exact accepted operation
 * bindings, not caller-selected origins or a blanket omission of HUMAN effects. */
export async function assertDirectEffectsClear(client:TicketEventTransaction,input:{tenantId:string;conversationId:string;excludeReplyIntentId?:string;excludeCloseCommandId?:string}) {
  await assertDirectNativeBarrier(client,input);
  const effects=(await client.query(`SELECT 'delivery' AS kind,id FROM delivery_outbox
    WHERE tenant_id=$1 AND bot_conversation_id=$2 AND (
      lease_id IS NOT NULL OR state IN ('QUEUED','CLAIMED','SENDING','FAILED_RETRYABLE')
      OR (state IN ('OUTCOME_UNKNOWN','BLOCKED') AND NOT app.delivery_no_further_attempts(tenant_id,id))
      OR (state='FAILED_TERMINAL' AND manual_retry_allowed))
    UNION ALL SELECT 'action',id FROM bot_action_jobs
      WHERE tenant_id=$1 AND conversation_id=$2 AND (lease_id IS NOT NULL OR state NOT IN ('SUCCEEDED','FAILED_TERMINAL'))
    UNION ALL SELECT 'handoff',id FROM bot_handoff_jobs
      WHERE tenant_id=$1 AND conversation_id=$2 AND (lease_id IS NOT NULL OR state NOT IN ('SUCCEEDED','FAILED_TERMINAL')) LIMIT 1`,
    [input.tenantId,input.conversationId])).rows;
  if(effects.length)throw new Error('DIRECT_PENDING_EFFECTS');
}

/** Only the whole successful agent batch in the current ownership epoch resets
 * the pause; status/read events and BOT/control prompts never call this. */
export async function resetDirectHumanPauseForCompletedBatch(client:TicketEventTransaction,input:{tenantId:string;conversationId:string;deliveryId:string}) {
  const changed=await client.query(`UPDATE bot_conversations conversation
    SET human_pause_started_at=GREATEST(conversation.human_pause_started_at,completed.finished_at)
    FROM delivery_outbox current_delivery
    CROSS JOIN LATERAL (
      SELECT max(attempt.finished_at) AS finished_at
      FROM delivery_outbox member JOIN delivery_attempts attempt
        ON attempt.tenant_id=member.tenant_id AND attempt.delivery_id=member.id AND attempt.attempt_number=member.attempts
      WHERE member.tenant_id=current_delivery.tenant_id AND member.bot_conversation_id=current_delivery.bot_conversation_id
        AND member.direct_origin='HUMAN' AND member.direct_ownership_epoch=current_delivery.direct_ownership_epoch
        AND ((current_delivery.batch_id IS NOT NULL AND member.batch_id=current_delivery.batch_id)
          OR (current_delivery.batch_id IS NULL AND member.id=current_delivery.id))
        AND attempt.state IN ('SENT','DELIVERED','READ') AND attempt.finished_at IS NOT NULL
    ) completed
    WHERE conversation.tenant_id=$1 AND conversation.id=$2 AND conversation.state='HUMAN'
      AND current_delivery.tenant_id=conversation.tenant_id AND current_delivery.id=$3
      AND current_delivery.bot_conversation_id=conversation.id AND current_delivery.direct_origin='HUMAN'
      AND current_delivery.direct_ownership_epoch=conversation.human_ownership_epoch AND completed.finished_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM delivery_outbox member WHERE member.tenant_id=current_delivery.tenant_id
          AND ((current_delivery.batch_id IS NOT NULL AND member.batch_id=current_delivery.batch_id)
            OR (current_delivery.batch_id IS NULL AND member.id=current_delivery.id))
          AND (member.bot_conversation_id IS DISTINCT FROM conversation.id OR member.direct_origin IS DISTINCT FROM 'HUMAN'
            OR member.direct_ownership_epoch IS DISTINCT FROM conversation.human_ownership_epoch
            OR member.state NOT IN ('SENT','DELIVERED','READ') OR member.lease_id IS NOT NULL
            OR NOT EXISTS (SELECT 1 FROM delivery_attempts attempt WHERE attempt.tenant_id=member.tenant_id
              AND attempt.delivery_id=member.id AND attempt.attempt_number=member.attempts
              AND attempt.state IN ('SENT','DELIVERED','READ') AND attempt.finished_at IS NOT NULL)))
      AND (SELECT count(*) FROM delivery_outbox member WHERE member.tenant_id=current_delivery.tenant_id
        AND ((current_delivery.batch_id IS NOT NULL AND member.batch_id=current_delivery.batch_id)
          OR (current_delivery.batch_id IS NULL AND member.id=current_delivery.id)))=current_delivery.batch_part_count`,
    [input.tenantId,input.conversationId,input.deliveryId]);
  return changed.rowCount===1;
}

/** Reuse the existing tenant-wide DELETE fence, with ticket-targeted retention.
 * Native pre-commit calls use a nonwaiting privacy advisory lock first. */
export async function assertDirectTicketPrivacyClear(client:TicketEventTransaction,input:{tenantId:string;ticketId:string}){
  const active=(await client.query(`SELECT 1 FROM privacy_jobs job WHERE job.tenant_id=$1 AND job.job_type IN ('DELETE','RETENTION_SWEEP')
    AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE') AND (job.job_type='DELETE' OR EXISTS(SELECT 1 FROM privacy_job_targets target
      WHERE target.tenant_id=job.tenant_id AND target.job_id=job.id AND target.target_type='ZAMMAD_TICKET' AND target.target_id=$2
        AND target.state IN ('PENDING','EXTERNAL_COMPLETE'))) LIMIT 1`,[input.tenantId,input.ticketId])).rowCount;
  if(active)throw new Error('DIRECT_PRIVACY_HOLD');
}
