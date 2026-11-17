import {assertMetaDirectEffectCurrent} from './meta-direct-identity.js';
import type {TicketEventTransaction} from './ticket-event-runtime.js';
import {assertDirectEffectsClear,assertDirectTicketPrivacyClear,tryLockDirectConversation} from './direct-keep-open.js';
import {lockTicketCommand} from './ticket-command-guards.js';

export type DirectCloseReceipt={state:'SUCCEEDED';command_id:string;ticket_id:string;article_id:string;request_sha256:string;closed_at:string;customer_id:string;human_ownership_epoch:number;conversation_fencing_token:number};
export type DirectCloseContext={updated_at:string;state_id:string;last_article_id:string;native_group_id:string;connection_id:string;external_chat_id:string;customer_id:string;closed:boolean};
type CloseRow={id:string;request_event_id:string;confirmation_event_id:string;state:string;conversation_id:string;human_ownership_epoch:string|number;conversation_fencing_token:string|number;request_sha256:string;native_action_snapshot:Record<string,unknown>|null;native_result:DirectCloseReceipt|null;lease_id:string|null;fencing_token:string|number;zammad_ticket_id:string;zammad_customer_id:number;assignment_id:string;external_chat_id:string;connection_id:string;conversation_state:string;current_epoch:string|number;current_fence:string|number};
async function closeRow(client:TicketEventTransaction,tenantId:string,id:string){return(await client.query<CloseRow>(`SELECT command.*,conversation.zammad_ticket_id,conversation.zammad_customer_id,
  conversation.assignment_id,conversation.external_chat_id,conversation.connection_id,conversation.state AS conversation_state,
  conversation.human_ownership_epoch AS current_epoch,conversation.fencing_token AS current_fence
  FROM direct_customer_close_commands command JOIN bot_conversations conversation
    ON conversation.tenant_id=command.tenant_id AND conversation.id=command.conversation_id
  WHERE command.tenant_id=$1 AND command.id=$2`,[tenantId,id])).rows[0];}
function currentIdentity(row:CloseRow){if(!['BOT','HUMAN'].includes(row.conversation_state)||Number(row.current_epoch)!==Number(row.human_ownership_epoch)||
  Number(row.current_fence)!==Number(row.conversation_fencing_token)||!row.zammad_customer_id)throw new Error('DIRECT_CLOSE_CONVERSATION_CHANGED');}

/** Caller commits this returned ATTEMPTED snapshot BEFORE its one native POST.
 * No HTTP operation is performed while any application lock is held. */
export async function prepareDirectCustomerClose(client:TicketEventTransaction,input:{tenantId:string;instanceId:string;commandId:string;leaseId:string;fencingToken:number;context:DirectCloseContext;appId?:string}){
  const row=await closeRow(client,input.tenantId,input.commandId);if(!row)throw new Error('DIRECT_CLOSE_NOT_FOUND');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`privacy:${input.tenantId}`]);
  await lockTicketCommand(client,{tenantId:input.tenantId,ticketId:row.zammad_ticket_id,instanceId:input.instanceId});
  await client.query('SELECT id FROM bot_conversations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[input.tenantId,row.conversation_id]);
  await client.query('SELECT id FROM direct_customer_close_commands WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[input.tenantId,row.id]);
  const current=await closeRow(client,input.tenantId,row.id);if(!current||current.state!=='QUEUED'||current.lease_id!==input.leaseId||Number(current.fencing_token)!==input.fencingToken)throw new Error('DIRECT_CLOSE_LEASE_CHANGED');
  currentIdentity(current);
  await assertDirectTicketPrivacyClear(client,{tenantId:input.tenantId,ticketId:current.zammad_ticket_id});
  if(input.context.closed)throw new Error('DIRECT_CLOSE_NATIVE_ALREADY_CLOSED');
  await assertDirectEffectsClear(client,{tenantId:input.tenantId,conversationId:current.conversation_id,excludeCloseCommandId:current.id});
  const active=(await client.query(`SELECT instance.id FROM zammad_instances instance JOIN bot_assignments assignment ON assignment.tenant_id=instance.tenant_id
    JOIN connections connection ON connection.tenant_id=assignment.tenant_id AND connection.id=assignment.connection_id
    WHERE instance.tenant_id=$1 AND instance.id=$2 AND instance.state='WORKING' AND assignment.id=$3 AND assignment.state='ACTIVE'
      AND connection.id=$4 AND connection.state='WORKING'`,[input.tenantId,input.instanceId,current.assignment_id,current.connection_id])).rowCount;
  if(active!==1||input.context.connection_id!==current.connection_id||input.context.external_chat_id!==current.external_chat_id||input.context.customer_id!==String(current.zammad_customer_id))throw new Error('DIRECT_CLOSE_NATIVE_IDENTITY_CHANGED');
  await assertMetaDirectEffectCurrent(client,{tenantId:input.tenantId,conversationId:current.conversation_id,
    connectionId:current.connection_id,ticketId:current.zammad_ticket_id,sourceEventIds:[current.request_event_id,current.confirmation_event_id],appId:input.appId??'',nonwaiting:true});
  const snapshot={command_id:current.id,tenant_id:input.tenantId,instance_id:input.instanceId,conversation_id:current.conversation_id,
    ticket_id:current.zammad_ticket_id,customer_id:String(current.zammad_customer_id),connection_id:current.connection_id,external_chat_id:current.external_chat_id,
    request_sha256:current.request_sha256,human_ownership_epoch:Number(current.human_ownership_epoch),conversation_fencing_token:Number(current.conversation_fencing_token),
    expected_native_updated_at:input.context.updated_at,expected_native_state_id:input.context.state_id,expected_native_article_id:input.context.last_article_id,native_group_id:input.context.native_group_id};
  const changed=await client.query(`UPDATE direct_customer_close_commands SET state='ATTEMPTED',native_action_snapshot=$1,native_attempted_at=now()
    WHERE tenant_id=$2 AND id=$3 AND state='QUEUED' AND lease_id=$4 AND fencing_token=$5 AND lease_expires_at>now()`,[snapshot,input.tenantId,current.id,input.leaseId,input.fencingToken]);
  if(changed.rowCount!==1)throw new Error('DIRECT_CLOSE_LEASE_CHANGED');return snapshot;
}

/** Signed native reader. ATTEMPTED execution has a fresh nonwaiting ownership
 * fence; UNKNOWN is read-only receipt recovery and never grants execution. */
export async function directCustomerCloseAdmission(client:TicketEventTransaction,input:{tenantId:string;instanceId:string;commandId:string;appId?:string}){
  const row=await closeRow(client,input.tenantId,input.commandId),snapshot=row?.native_action_snapshot;
  if(!row||!snapshot||!['ATTEMPTED','OUTCOME_UNKNOWN','SUCCEEDED'].includes(row.state)||snapshot.instance_id!==input.instanceId||
    snapshot.tenant_id!==input.tenantId||snapshot.command_id!==row.id||snapshot.ticket_id!==row.zammad_ticket_id)throw new Error('DIRECT_CLOSE_ADMISSION_UNAVAILABLE');
  let effectsClear=false;
  if(row.state==='ATTEMPTED'){
    await tryLockDirectConversation(client,{tenantId:input.tenantId,assignmentId:row.assignment_id,chatId:row.external_chat_id,conversationId:row.conversation_id});
    const current=await closeRow(client,input.tenantId,row.id);if(!current||current.state!=='ATTEMPTED')throw new Error('DIRECT_CLOSE_ADMISSION_CHANGED');
    currentIdentity(current);await assertDirectTicketPrivacyClear(client,{tenantId:input.tenantId,ticketId:current.zammad_ticket_id});await assertDirectEffectsClear(client,{tenantId:input.tenantId,conversationId:current.conversation_id,excludeCloseCommandId:current.id});
    await assertMetaDirectEffectCurrent(client,{tenantId:input.tenantId,conversationId:current.conversation_id,
      connectionId:current.connection_id,ticketId:current.zammad_ticket_id,sourceEventIds:[current.request_event_id,current.confirmation_event_id],appId:input.appId??'',nonwaiting:true});
    effectsClear=true;
  }
  return{...snapshot,native_action_state:row.state,effects_clear:effectsClear};
}

export function validateDirectCloseReceipt(receipt:unknown,snapshot:Record<string,unknown>):DirectCloseReceipt{
  const r=receipt as DirectCloseReceipt;if(!r||r.state!=='SUCCEEDED'||r.command_id!==snapshot.command_id||r.ticket_id!==snapshot.ticket_id||
    r.request_sha256!==snapshot.request_sha256||r.customer_id!==snapshot.customer_id||r.human_ownership_epoch!==snapshot.human_ownership_epoch||
    r.conversation_fencing_token!==snapshot.conversation_fencing_token||!/^[1-9][0-9]{0,15}$/u.test(r.article_id)||
    typeof r.closed_at!=='string'||!Number.isFinite(Date.parse(r.closed_at)))throw new Error('DIRECT_CLOSE_RECEIPT_CONFLICT');return r;
}
export async function recordDirectCloseReceipt(client:TicketEventTransaction,input:{tenantId:string;commandId:string;receipt:unknown}){
  const row=await closeRow(client,input.tenantId,input.commandId);if(!row?.native_action_snapshot)throw new Error('DIRECT_CLOSE_NOT_FOUND');
  const receipt=validateDirectCloseReceipt(input.receipt,row.native_action_snapshot);
  if(row.state==='SUCCEEDED'){
    const existing=validateDirectCloseReceipt(row.native_result,row.native_action_snapshot);
    if(existing.article_id!==receipt.article_id||existing.closed_at!==receipt.closed_at)throw new Error('DIRECT_CLOSE_RECEIPT_CONFLICT');return receipt;
  }
  const changed=await client.query(`UPDATE direct_customer_close_commands SET state='SUCCEEDED',native_result=$1,completed_at=now(),lease_id=NULL,lease_expires_at=NULL
    WHERE tenant_id=$2 AND id=$3 AND state IN ('ATTEMPTED','OUTCOME_UNKNOWN')`,[receipt,input.tenantId,row.id]);
  if(changed.rowCount!==1)throw new Error('DIRECT_CLOSE_OUTCOME_CHANGED');return receipt;
}
