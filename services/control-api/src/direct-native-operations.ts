import {assertMetaDirectEffectCurrent} from '@wasalx/core/meta-direct-identity';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {parseBotFlow} from '@wasalx/core/bot-flow';
import {assertDirectEffectsClear,assertDirectNativeBarrier,assertDirectTicketPrivacyClear,tryLockDirectConversation} from '@wasalx/core/direct-keep-open';

type NativeReplyInput={tenantId:string;instanceId:string;operationId:string;connectionId:string;chatId:string;ticketId:string;
  actorId:string;nativeGroupId:string;actorFullGroupIds:string[];requestSha256:string;appId?:string};
type DirectRow={id:string;assignment_id:string;state:string;human_ownership_epoch:string;fencing_token:string;
  zammad_customer_id:number|null;definition:unknown;external_chat_id:string;zammad_ticket_id:string};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

/** Called only with signed native actor claims after native Pundit update/full
 * group checks. Native holds the ticket row through its article transaction. */
export async function reserveDirectNativeReply(client:PoolClient,input:NativeReplyInput) {
  if(!uuid.test(input.operationId)||!/^[a-f0-9]{64}$/u.test(input.requestSha256)||
    !input.actorFullGroupIds.includes(input.nativeGroupId))throw new Error('DIRECT_NATIVE_ACTOR_DENIED');
  const privacyLock=(await client.query<{acquired:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`privacy:${input.tenantId}`])).rows[0]?.acquired;
  if(!privacyLock)throw new Error('DIRECT_CONVERSATION_BUSY');
  await assertDirectTicketPrivacyClear(client,{tenantId:input.tenantId,ticketId:input.ticketId});
  const current=(await client.query<DirectRow>(`SELECT conversation.id,conversation.assignment_id,conversation.state,
      conversation.human_ownership_epoch,conversation.fencing_token,conversation.zammad_customer_id,
      conversation.external_chat_id,conversation.zammad_ticket_id,version.definition
    FROM bot_conversations conversation JOIN bot_flow_versions version
      ON version.tenant_id=conversation.tenant_id AND version.id=conversation.flow_version_id
    JOIN connections connection ON connection.tenant_id=conversation.tenant_id AND connection.id=conversation.connection_id
    JOIN bot_assignments assignment ON assignment.tenant_id=conversation.tenant_id AND assignment.id=conversation.assignment_id
    WHERE conversation.tenant_id=$1 AND conversation.connection_id=$2 AND conversation.external_chat_id=$3
      AND conversation.zammad_ticket_id=$4 AND conversation.state IN ('BOT','HUMAN')
      AND connection.state='WORKING' AND assignment.state='ACTIVE'
      AND NOT EXISTS(SELECT 1 FROM whatsapp_groups g WHERE g.tenant_id=conversation.tenant_id
        AND g.connection_id=conversation.connection_id AND g.external_group_id=conversation.external_chat_id)`,
    [input.tenantId,input.connectionId,input.chatId,input.ticketId])).rows[0];
  if(!current||!parseBotFlow(current.definition).keepOpenPolicy||!current.zammad_customer_id)throw new Error('DIRECT_NATIVE_DESTINATION_DENIED');
  const locked=await tryLockDirectConversation(client,{tenantId:input.tenantId,assignmentId:current.assignment_id,
    chatId:input.chatId,conversationId:current.id});
  if(!locked)throw new Error('DIRECT_CONVERSATION_CHANGED');
  const fresh=(await client.query<DirectRow>(`SELECT conversation.id,conversation.assignment_id,conversation.state,
    conversation.human_ownership_epoch,conversation.fencing_token,conversation.zammad_customer_id,conversation.external_chat_id,conversation.zammad_ticket_id,version.definition
    FROM bot_conversations conversation JOIN bot_flow_versions version ON version.tenant_id=conversation.tenant_id AND version.id=conversation.flow_version_id
    JOIN bot_assignments assignment ON assignment.tenant_id=conversation.tenant_id AND assignment.id=conversation.assignment_id
    JOIN connections connection ON connection.tenant_id=conversation.tenant_id AND connection.id=conversation.connection_id
    WHERE conversation.tenant_id=$1 AND conversation.id=$2 AND conversation.state IN ('BOT','HUMAN')
      AND assignment.state='ACTIVE' AND connection.state='WORKING' FOR SHARE OF assignment,connection NOWAIT`,[input.tenantId,current.id])).rows[0];
  if(!fresh||!parseBotFlow(fresh.definition).keepOpenPolicy||fresh.external_chat_id!==input.chatId||fresh.zammad_ticket_id!==input.ticketId||!fresh.zammad_customer_id)throw new Error('DIRECT_CONVERSATION_CHANGED');
  await assertMetaDirectEffectCurrent(client,{tenantId:input.tenantId,conversationId:current.id,connectionId:input.connectionId,
    ticketId:input.ticketId,appId:input.appId??'',nonwaiting:true});
  const existing=(await client.query<{id:string;conversation_id:string;instance_id:string;native_ticket_id:string;native_actor_id:string;
    request_sha256:string;human_ownership_epoch:string;state:string}>(
    'SELECT * FROM direct_native_reply_intents WHERE tenant_id=$1 AND id=$2',[input.tenantId,input.operationId])).rows[0];
  if(existing){
    if(existing.conversation_id!==current.id||existing.instance_id!==input.instanceId||existing.native_ticket_id!==input.ticketId||
      existing.native_actor_id!==input.actorId||existing.request_sha256!==input.requestSha256||existing.state!=='PENDING'||fresh.state!=='HUMAN'||
      Number(existing.human_ownership_epoch)!==Number(fresh.human_ownership_epoch))throw new Error('DIRECT_NATIVE_INTENT_CONFLICT');
    await assertMetaDirectEffectCurrent(client,{tenantId:input.tenantId,conversationId:current.id,appId:input.appId??'',
      routingNativeIntentId:existing.id,nonwaiting:true});
    return {id:existing.id,conversation_id:current.id,human_ownership_epoch:Number(existing.human_ownership_epoch)};
  }
  // Re-read after the nonwaiting lock. A capability GET was not an ownership reservation.
  await assertDirectEffectsClear(client,{tenantId:input.tenantId,conversationId:current.id});
  let epoch=Number(fresh.human_ownership_epoch);
  if(fresh.state==='BOT'){
    const changed=(await client.query<{human_ownership_epoch:string}>(`UPDATE bot_conversations SET state='HUMAN',
      human_ownership_epoch=human_ownership_epoch+1,human_pause_started_at=now(),customer_control=NULL,
      fencing_token=fencing_token+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND state='BOT'
      RETURNING human_ownership_epoch`,[input.tenantId,current.id])).rows[0];
    if(!changed)throw new Error('DIRECT_CONVERSATION_CHANGED');epoch=Number(changed.human_ownership_epoch);
    await client.query(`INSERT INTO bot_conversation_events(tenant_id,conversation_id,event_kind,safe_metadata)
      VALUES($1,$2,'HANDOFF_COMPLETED',$3)`,[input.tenantId,current.id,JSON.stringify({cause:'NATIVE_AGENT_REACQUIRED',native_actor_id:input.actorId,human_ownership_epoch:epoch})]);
  }
  if(fresh.state==='HUMAN')await client.query(`UPDATE bot_conversations SET customer_control=CASE WHEN customer_control->>'phase'='CONFIRM' THEN NULL ELSE customer_control END
    WHERE tenant_id=$1 AND id=$2`,[input.tenantId,current.id]);
  await client.query(`INSERT INTO direct_native_reply_intents(id,tenant_id,conversation_id,instance_id,native_ticket_id,native_actor_id,
    human_ownership_epoch,request_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [input.operationId,input.tenantId,current.id,input.instanceId,input.ticketId,input.actorId,epoch,input.requestSha256]);
  return{id:input.operationId,conversation_id:current.id,human_ownership_epoch:epoch};
}

/** Outbound caller locks the conversation BEFORE its queue/receipt transaction.
 * A replay returns its prior accepted outbox; it does not acquire new ownership. */
export async function admitDirectReplyIntent(client:PoolClient,input:{tenantId:string;instanceId:string;conversationId:string;
  operationId:string;ticketId:string;articleId:string;actorId:string;appId?:string}) {
  const intent=(await client.query<{human_ownership_epoch:string;meta_routing_epoch:string|null;meta_primary_source_event_id:string|null;state:string;native_article_id:string|null;delivery_id:string|null}>(`
    SELECT intent.human_ownership_epoch,intent.meta_routing_epoch,intent.meta_primary_source_event_id,intent.state,intent.native_article_id,intent.delivery_id
    FROM direct_native_reply_intents intent JOIN bot_conversations conversation
      ON conversation.tenant_id=intent.tenant_id AND conversation.id=intent.conversation_id
    WHERE intent.tenant_id=$1 AND intent.id=$2 AND intent.conversation_id=$3 AND intent.instance_id=$4
      AND intent.native_ticket_id=$5 AND intent.native_actor_id=$6 AND conversation.state='HUMAN'
      AND intent.human_ownership_epoch=conversation.human_ownership_epoch FOR UPDATE OF conversation,intent`,
    [input.tenantId,input.operationId,input.conversationId,input.instanceId,input.ticketId,input.actorId])).rows[0];
  if(!intent||!['PENDING','ADMITTED'].includes(intent.state)||
    (intent.state==='ADMITTED'&&intent.native_article_id!==input.articleId))throw new Error('DIRECT_NATIVE_INTENT_DENIED');
  await assertDirectNativeBarrier(client,{tenantId:input.tenantId,conversationId:input.conversationId,excludeReplyIntentId:input.operationId});
  if(intent.state==='PENDING')await assertMetaDirectEffectCurrent(client,{tenantId:input.tenantId,conversationId:input.conversationId,
    ticketId:input.ticketId,appId:input.appId??'',routingNativeIntentId:input.operationId});
  return{epoch:Number(intent.human_ownership_epoch),routingEpoch:intent.meta_routing_epoch==null?undefined:Number(intent.meta_routing_epoch),
    ...(intent.meta_primary_source_event_id?{routingSourceEventId:intent.meta_primary_source_event_id}:{}),acceptedDeliveryId:intent.delivery_id};
}

export async function completeDirectReplyIntent(client:PoolClient,input:{tenantId:string;operationId:string;articleId:string;deliveryId:string}) {
  const changed=await client.query(`UPDATE direct_native_reply_intents SET state='ADMITTED',native_article_id=$1,
    delivery_id=$2,completed_at=now() WHERE tenant_id=$3 AND id=$4 AND state='PENDING'`,
    [input.articleId,input.deliveryId,input.tenantId,input.operationId]);
  if(changed.rowCount!==1)throw new Error('DIRECT_NATIVE_INTENT_CHANGED');
}

export function directCloseRequestSha256(value:{conversationId:string;customerId:number;requestEventId:string;
  confirmationEventId:string;promptDeliveryId:string;epoch:number;fencingToken:number}) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function reconcileAbsentDirectReplyIntent(client:PoolClient,input:{tenantId:string;instanceId:string;operationId:string;ticketId:string;nativeTicketLocked:boolean;articleAbsent:boolean;nativeUpdatedAt:string;lastArticleId:string}){
  if(input.nativeTicketLocked!==true||input.articleAbsent!==true||!Number.isFinite(Date.parse(input.nativeUpdatedAt))||!/^(?:0|[1-9][0-9]{0,15})$/u.test(input.lastArticleId))throw new Error('DIRECT_NATIVE_ABSENCE_PROOF_INVALID');
  const row=(await client.query<{id:string;conversation_id:string;assignment_id:string;external_chat_id:string;state:string}>(`SELECT intent.id,intent.conversation_id,intent.state,conversation.assignment_id,conversation.external_chat_id
    FROM direct_native_reply_intents intent JOIN bot_conversations conversation ON conversation.tenant_id=intent.tenant_id AND conversation.id=intent.conversation_id
    WHERE intent.tenant_id=$1 AND intent.id=$2 AND intent.instance_id=$3 AND intent.native_ticket_id=$4`,[input.tenantId,input.operationId,input.instanceId,input.ticketId])).rows[0];
  if(!row)throw new Error('DIRECT_NATIVE_INTENT_DENIED');
  await tryLockDirectConversation(client,{tenantId:input.tenantId,assignmentId:row.assignment_id,chatId:row.external_chat_id,conversationId:row.conversation_id});
  const changed=await client.query(`UPDATE direct_native_reply_intents SET state='CANCELLED_PROVEN_ABSENT',completed_at=now(),
    reconciliation=$1 WHERE tenant_id=$2 AND id=$3 AND state IN ('PENDING','OUTCOME_UNKNOWN')`,[{native_ticket_locked:true,article_absent:true,native_updated_at:input.nativeUpdatedAt,last_article_id:input.lastArticleId},input.tenantId,row.id]);
  if(changed.rowCount!==1)throw new Error('DIRECT_NATIVE_INTENT_RECONCILIATION_CHANGED');return{state:'CANCELLED_PROVEN_ABSENT',operation_id:row.id};
}
