import type {TicketEventTransaction} from './ticket-event-runtime.js';
type GuardRow={state:string;resolution_kind:string|null;human_ownership_epoch:string|number;human_pause_started_at:string|Date|null;
  fencing_token:string|number;customer_control:Record<string,unknown>|null;keep_open_policy:Record<string,unknown>|null;
  direct_origin:string;direct_ownership_epoch:string|number|null;bot_content:Record<string,unknown>|null;content_redacted_at:string|null};
/** Current owned customer-control output is the only BOT-origin exception to
 * HUMAN suppression. This exact predicate is reused by all three retry APIs
 * and beginSend; it never grants ordinary BOT delivery while HUMAN. */
export async function directControlDeliveryAllowed(client:TicketEventTransaction,input:{tenantId:string;conversationId:string;deliveryId:string}){
  const row=(await client.query<GuardRow>(`SELECT conversation.state,conversation.resolution_kind,conversation.human_ownership_epoch,
    conversation.human_pause_started_at,conversation.fencing_token,conversation.customer_control,version.definition->'keepOpenPolicy' AS keep_open_policy,
    delivery.direct_origin,delivery.direct_ownership_epoch,delivery.bot_content,delivery.content_redacted_at
    FROM bot_conversations conversation JOIN bot_flow_versions version ON version.tenant_id=conversation.tenant_id AND version.id=conversation.flow_version_id
    JOIN delivery_outbox delivery ON delivery.tenant_id=conversation.tenant_id AND delivery.bot_conversation_id=conversation.id
    WHERE conversation.tenant_id=$1 AND conversation.id=$2 AND delivery.id=$3`,[input.tenantId,input.conversationId,input.deliveryId])).rows[0];
  const s=row?.customer_control,p=row?.keep_open_policy;
  if(!row||row.state!=='HUMAN'||row.direct_origin!=='BOT'||row.content_redacted_at||!s||!p||
    s.promptDeliveryId!==input.deliveryId||row.bot_content?.controlId!==input.deliveryId||row.bot_content?.nodeId!=='wasalx_customer_control'||
    s.epoch!==Number(row.human_ownership_epoch)||!['REQUEST','CONFIRM'].includes(String(s.phase)))return false;
  if(s.phase==='CONFIRM')return p.customerResolution===true&&s.confirmationFencingToken===Number(row.fencing_token)&&
    s.humanPauseStartedAt===(row.human_pause_started_at?new Date(row.human_pause_started_at).toISOString():null)&&
    typeof s.expiresAt==='string'&&Date.parse(s.expiresAt)>=Date.now();
  return p.mainMenu===true||p.customerResolution===true;
}
export async function directHumanDeliveryAllowed(client:TicketEventTransaction,input:{tenantId:string;conversationId:string;deliveryId:string}){
  const row=(await client.query<{state:string;epoch:string|number;delivery_epoch:string|number|null;policy:unknown}>(`SELECT conversation.state,conversation.human_ownership_epoch AS epoch,
    delivery.direct_ownership_epoch AS delivery_epoch,version.definition->'keepOpenPolicy' AS policy FROM bot_conversations conversation
    JOIN bot_flow_versions version ON version.tenant_id=conversation.tenant_id AND version.id=conversation.flow_version_id
    JOIN delivery_outbox delivery ON delivery.tenant_id=conversation.tenant_id AND delivery.bot_conversation_id=conversation.id
    WHERE conversation.tenant_id=$1 AND conversation.id=$2 AND delivery.id=$3 AND delivery.direct_origin='HUMAN'`,[input.tenantId,input.conversationId,input.deliveryId])).rows[0];
  return !!row&&row.state==='HUMAN'&&(!row.policy||row.delivery_epoch!==null&&Number(row.delivery_epoch)===Number(row.epoch));
}
