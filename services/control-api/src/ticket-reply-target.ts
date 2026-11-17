import type { PoolClient } from "pg";
import { BadRequestException } from "@nestjs/common";
import { planTicketEvent, type TicketQuoteContext } from "@wasalx/core/ticket-event-flow";
import { findTicketMessage, loadEffectiveTicketEvent, loadPinnedTicketEvent, pinTicketEventExecution, ticketEventSourceHash, type TicketEventReceipt } from "@wasalx/core/ticket-event-runtime";
import { renderOutboundText } from "@wasalx/core/outbound-text";

type ReplyTargetInput={tenantId:string;connectionId:string;groupId:string;ticketId:string;requested:string|null;requestedArticleId?:string|null;direct?:boolean};
export async function ticketReplyTarget(client:PoolClient,input:ReplyTargetInput):Promise<string|null>{
  const target=await findTicketMessage(client,input);
  if((input.requested||input.requestedArticleId)&&!target)throw new BadRequestException("The selected WhatsApp message is no longer available in this ticket");
  return target;
}

/** Preview and durable admission evaluate the same graph. Only admission pins a
 * decision; its caller commits that receipt together with the existing outbox. */
export async function prepareTicketReply(client:PoolClient,input:ReplyTargetInput&{
  groupBindingId:string|null;body:string;contentType:string;hasAttachments:boolean;articleId?:string|null;
  agentDisplayName:string|null;agentPrefixSnapshot:string|null;agentIdentityPlacementSnapshot:"HEADER"|"FOOTER"|"OFF"|null;
},persist:boolean){
  const replyToMessageId=input.direct&&!input.requested&&!input.requestedArticleId?null:await ticketReplyTarget(client,input);
  const unchanged={body:input.body,contentType:input.contentType,replyToMessageId,
    agentPrefixSnapshot:input.agentPrefixSnapshot,agentIdentityPlacementSnapshot:input.agentIdentityPlacementSnapshot,
    receipt:null as TicketEventReceipt|null};
  if(!input.groupBindingId)return unchanged;
  const context=(await client.query<{id:string;whatsapp_group_id:string;provider:"WAHA"|"META";display_name:string;
    normalized_reference:string;zammad_ticket_number:string;state:"OPEN"|"RESOLVED";original_external_message_id:string|null}>(`
    SELECT correlation.id,binding.whatsapp_group_id,connection.provider,COALESCE(group_record.wasalx_name,group_record.display_name) AS display_name,
      correlation.normalized_reference,correlation.zammad_ticket_number,correlation.state,correlation.original_external_message_id
    FROM case_correlations correlation
    JOIN group_bindings binding ON binding.tenant_id=correlation.tenant_id AND binding.id=correlation.group_binding_id
    JOIN whatsapp_groups group_record ON group_record.tenant_id=binding.tenant_id AND group_record.id=binding.whatsapp_group_id
    JOIN connections connection ON connection.tenant_id=group_record.tenant_id AND connection.id=group_record.connection_id
    WHERE correlation.tenant_id=$1 AND correlation.group_binding_id=$2 AND correlation.zammad_ticket_id=$3
      AND correlation.state IN ('OPEN','RESOLVED') AND connection.id=$4 AND group_record.external_group_id=$5
`,[input.tenantId,input.groupBindingId,input.ticketId,input.connectionId,input.groupId])).rows[0];
  if(!context){
    const detached=(await client.query(`SELECT id FROM case_correlations
      WHERE tenant_id=$1 AND group_binding_id=$2 AND zammad_ticket_id=$3 LIMIT 1`,
      [input.tenantId,input.groupBindingId,input.ticketId])).rowCount;
    if(detached)throw new BadRequestException("This ticket is no longer linked to the active WhatsApp case");
    // A manually created group-workspace ticket has no trigger or case graph.
    // Its authorized message links still provide ordinary native quoting.
    return unchanged;
  }
  const event="before_agent_reply";
  const selection=await loadEffectiveTicketEvent(client,{tenantId:input.tenantId,whatsappGroupId:context.whatsapp_group_id,event});
  if(persist&&!input.articleId)throw new BadRequestException("A native article is required for a ticket reply");
  const receipt=persist?await pinTicketEventExecution(client,{tenantId:input.tenantId,correlationId:context.id,event,
    sourceSha256:ticketEventSourceHash("ARTICLE",input.ticketId,input.articleId!),selection}):null;
  const pinned=receipt??{...selection,tenantId:input.tenantId,event};
  if(pinned.mode==="LEGACY")return{...unchanged,receipt};
  // A custom graph (including its exception path) replaces legacy attribution.
  const raw=renderOutboundText({text:input.body,contentType:input.contentType});
  const result={...unchanged,body:raw,contentType:"text/plain",agentPrefixSnapshot:null,agentIdentityPlacementSnapshot:"OFF" as const,receipt};
  if(pinned.mode==="OFF")return result;
  const explicitRequested=!!(input.requested||input.requestedArticleId);
  const original=context.original_external_message_id?await findTicketMessage(client,{...input,requested:context.original_external_message_id,requestedArticleId:null}):null;
  const quotes:TicketQuoteContext={explicitRequested,
    ...(explicitRequested&&replyToMessageId?{explicit:{messageId:replyToMessageId,authorized:true}}:{}),
    ...(replyToMessageId?{latest:{messageId:replyToMessageId,authorized:true}}:{}),
    ...(original?{original:{messageId:original,authorized:true}}:{})};
  try{
    const flow=await loadPinnedTicketEvent(client,pinned);
    const plan=planTicketEvent(flow,{provider:context.provider,reactions:context.provider==="WAHA",quotes,variables:{
      "event.kind":event,"provider.kind":context.provider,"group.name":context.display_name,
      "case.number":context.zammad_ticket_number,"case.reference":context.normalized_reference,"case.state":context.state,
      "case.transition":"APPENDED","reply.text":raw,"reply.has_attachments":input.hasAttachments,
      "reply.has_explicit_quote":explicitRequested,"agent.name":input.agentDisplayName??undefined,
    }});
    const effect=plan.effects.find(effect=>effect.type==="format_reply");
    return effect&&effect.type==="format_reply"?{...result,body:effect.text,replyToMessageId:effect.replyToMessageId??null}:result;
  }catch{throw new BadRequestException("The ticket reply workflow cannot be applied; check its variables and quote target")}
}
