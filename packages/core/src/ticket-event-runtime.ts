import { createHash, randomUUID } from "node:crypto";
import { parseTicketEventFlow, planTicketEvent, selectTicketQuote, type TicketEvent, type TicketEventDefinition, type TicketQuoteContext, type TicketEventEffect } from "./ticket-event-flow.js";

/** Existing pg transaction, including its tenant context. This helper does not
 * open transactions, send provider requests or own a scheduler. */
export type TicketEventTransaction = {
  query<Row extends Record<string,unknown> = Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:Row[];rowCount:number|null}>;
};
export type TicketEventSelection={mode:"CUSTOM"|"OFF"|"LEGACY";flowVersionId:string|null};
export type TicketEventReceipt=TicketEventSelection&{id:string;tenantId:string;correlationId:string;event:TicketEvent;state:"PENDING"|"APPLIED"|"SKIPPED"};
type ReceiptRow={id:string;tenant_id:string;correlation_id:string;event:TicketEvent;mode:TicketEventSelection["mode"];flow_version_id:string|null;state:TicketEventReceipt["state"]};

export function ticketEventSourceHash(kind:"INBOUND"|"NATIVE_STATE"|"ARTICLE",ownerId:string,sourceId:string){
  return createHash("sha256").update(JSON.stringify([kind,ownerId,sourceId])).digest("hex");
}
export async function loadEffectiveTicketEvent(client:TicketEventTransaction,input:{tenantId:string;whatsappGroupId:string;event:TicketEvent}):Promise<TicketEventSelection>{
  const row=(await client.query<{mode:"CUSTOM"|"OFF";flow_version_id:string|null}>(
    `SELECT mode,flow_version_id FROM ticket_event_bindings
       WHERE tenant_id=$1 AND event=$3
         AND (whatsapp_group_id=$2 OR whatsapp_group_id IS NULL) AND mode<>'INHERIT'
       ORDER BY (whatsapp_group_id IS NOT NULL) DESC LIMIT 1`,
    [input.tenantId,input.whatsappGroupId,input.event],
  )).rows[0];
  return row?{mode:row.mode,flowVersionId:row.flow_version_id}:{mode:"LEGACY",flowVersionId:null};
}
export async function pinTicketEventExecution(client:TicketEventTransaction,input:{
  tenantId:string;correlationId:string;event:TicketEvent;sourceSha256:string;selection:TicketEventSelection;
}):Promise<TicketEventReceipt>{
  if(!/^[a-f0-9]{64}$/.test(input.sourceSha256))throw new Error("Ticket event source identity is invalid");
  const values=[input.tenantId,input.correlationId,input.event,input.sourceSha256];
  // Always honor an existing execution before considering newly activated config.
  let row=(await client.query<ReceiptRow>(
    "SELECT id,tenant_id,correlation_id,event,mode,flow_version_id,state FROM ticket_event_executions WHERE tenant_id=$1 AND correlation_id=$2 AND event=$3 AND source_sha256=$4 FOR UPDATE",values,
  )).rows[0];
  if(!row){
    row=(await client.query<ReceiptRow>(
      `INSERT INTO ticket_event_executions (tenant_id,correlation_id,event,source_sha256,mode,flow_version_id)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,correlation_id,event,source_sha256) DO NOTHING
         RETURNING id,tenant_id,correlation_id,event,mode,flow_version_id,state`,
      [...values,input.selection.mode,input.selection.flowVersionId],
    )).rows[0];
    if(!row)row=(await client.query<ReceiptRow>(
      "SELECT id,tenant_id,correlation_id,event,mode,flow_version_id,state FROM ticket_event_executions WHERE tenant_id=$1 AND correlation_id=$2 AND event=$3 AND source_sha256=$4 FOR UPDATE",values,
    )).rows[0];
  }
  if(!row)throw new Error("Ticket event execution could not be pinned");
  return{id:row.id,tenantId:row.tenant_id,correlationId:row.correlation_id,event:row.event,mode:row.mode,flowVersionId:row.flow_version_id,state:row.state};
}
export async function loadPinnedTicketEvent(client:TicketEventTransaction,receipt:Pick<TicketEventReceipt,"tenantId"|"event"|"mode"|"flowVersionId">):Promise<TicketEventDefinition>{
  if(receipt.mode!=="CUSTOM"||!receipt.flowVersionId)throw new Error("Ticket event has no custom graph");
  const row=(await client.query<{definition:unknown}>(
    "SELECT definition FROM bot_flow_versions WHERE tenant_id=$1 AND id=$2 AND state IN ('ACTIVE','RETIRED')",
    [receipt.tenantId,receipt.flowVersionId],
  )).rows[0];
  if(!row)throw new Error("The pinned ticket event version is unavailable");
  const definition=parseTicketEventFlow(row.definition);
  if(definition.event!==receipt.event)throw new Error("Pinned ticket event kind does not match");
  return definition;
}
export async function completeTicketEventExecution(client:TicketEventTransaction,receipt:TicketEventReceipt,state:"APPLIED"|"SKIPPED"){
  if(receipt.state!=="PENDING")return;
  const result=await client.query(
    "UPDATE ticket_event_executions SET state=$1,completed_at=now() WHERE tenant_id=$2 AND id=$3 AND state='PENDING'",
    [state,receipt.tenantId,receipt.id],
  );
  if(result.rowCount!==1)throw new Error("Ticket event execution changed");
  receipt.state=state;
}
// Resolve accepted matching triggers using their original rule observations and
// immutable correlation receipts. Never re-test message text under today's rules.
export async function resolveTicketReferenceMessages(client:TicketEventTransaction,input:{
  tenantId:string;correlationId:string;executionId:string;connectionId:string;groupId:string;ticketId:string;
}):Promise<string[]>{
  const close=(await client.query<{id:string}>(
    "SELECT id FROM ticket_event_executions WHERE tenant_id=$1 AND id=$2 AND correlation_id=$3 AND event='ticket_closed'",
    [input.tenantId,input.executionId,input.correlationId],
  )).rows[0];
  if(!close)throw new Error("The close event is unavailable");
  const sources=(await client.query<{source_sha256:string}>(
    `SELECT source_sha256 FROM ticket_event_executions
      WHERE tenant_id=$1 AND correlation_id=$2 AND event='reference_received' AND created_at<=(SELECT cutoff.created_at FROM ticket_event_executions cutoff
        WHERE cutoff.tenant_id=$1 AND cutoff.correlation_id=$2 AND cutoff.id=$3 AND cutoff.event='ticket_closed')
      ORDER BY created_at,id LIMIT 1001`,[input.tenantId,input.correlationId,input.executionId],
  )).rows;
  const candidates=(await client.query<{external_message_id:string;eligible:boolean}>(`
    SELECT message.external_message_id,
      COALESCE(message.provider_metadata->>'eventKind','MESSAGE')<>'REACTION'
      AND NOT COALESCE(message.provider_metadata->'mutations','[]'::jsonb) @> '[{"kind":"REVOKED"}]'::jsonb
      AND NOT EXISTS (SELECT 1 FROM privacy_job_targets privacy
        WHERE privacy.tenant_id=message.tenant_id AND privacy.target_type='NORMALIZED_MESSAGE'
          AND privacy.target_id=message.id::text AND privacy.state IN ('PENDING','EXTERNAL_COMPLETE','COMPLETE')) AS eligible
    FROM case_correlations correlation
    JOIN group_bindings binding ON binding.tenant_id=correlation.tenant_id AND binding.id=correlation.group_binding_id
    JOIN whatsapp_groups destination ON destination.tenant_id=binding.tenant_id AND destination.id=binding.whatsapp_group_id
    JOIN message_links link ON link.tenant_id=correlation.tenant_id AND link.zammad_ticket_id=correlation.zammad_ticket_id
      AND link.connection_id=destination.connection_id AND link.direction IN ('INBOUND','MANUAL_DEVICE')
    JOIN normalized_messages message ON message.tenant_id=link.tenant_id AND message.connection_id=link.connection_id
      AND message.external_message_id=link.external_message_id AND message.external_group_id=destination.external_group_id
    JOIN event_inbox inbox ON inbox.tenant_id=message.tenant_id AND inbox.id=message.event_inbox_id
      AND inbox.connection_id=message.connection_id
    WHERE correlation.tenant_id=$1 AND correlation.id=$2 AND correlation.zammad_ticket_id=$3
      AND correlation.state<>'DETACHED' AND destination.connection_id=$4 AND destination.external_group_id=$5
      AND inbox.event_type<>'quarantine.reprocess'
      AND EXISTS (SELECT 1 FROM rule_match_observations observation
        JOIN trigger_rules rule ON rule.tenant_id=observation.tenant_id AND rule.rule_set_id=observation.rule_set_id
          AND rule.id=observation.trigger_rule_id
        WHERE observation.tenant_id=message.tenant_id AND observation.event_inbox_id=inbox.id
          AND observation.group_binding_id=binding.id AND observation.rule_set_id=inbox.governing_rule_set_id
          AND observation.matched_reference_count>0 AND rule.matcher_options->'groupCommand' IS NULL)
      AND NOT EXISTS (SELECT 1 FROM rule_match_observations observation
        JOIN trigger_rules rule ON rule.tenant_id=observation.tenant_id AND rule.rule_set_id=observation.rule_set_id
          AND rule.id=observation.trigger_rule_id
        WHERE observation.tenant_id=message.tenant_id AND observation.event_inbox_id=inbox.id
          AND observation.group_binding_id=binding.id AND observation.rule_set_id=inbox.governing_rule_set_id
          AND observation.matched_reference_count>0 AND rule.matcher_options->'groupCommand' IS NOT NULL)
    ORDER BY message.provider_timestamp,message.id LIMIT 1001`,
    [input.tenantId,input.correlationId,input.ticketId,input.connectionId,input.groupId],
  )).rows;
  // ponytail: one transactional snapshot is capped at 1000 rows; use bounded pagination only if tenants hit this ceiling.
  // Never truncate a partially known target set.
  if(sources.length>1000||candidates.length>1000)throw new Error("Reference message history exceeds the safe processing bound");
  const sourceHashes=new Set(sources.map(row=>row.source_sha256));
  const accepted=candidates.filter(row=>sourceHashes.has(ticketEventSourceHash("INBOUND",input.connectionId,row.external_message_id)));
  if(!accepted.length)throw new Error("Accepted reference message evidence is unavailable");
  return [...new Set(accepted.filter(row=>row.eligible).map(row=>selectTicketQuote("ORIGINAL",{original:{messageId:row.external_message_id,authorized:true}})!))];
}

// Reuse the existing outbox's <=11-part batches and destination ordering. No new
// scheduler: all rows are pinned atomically and UNKNOWN predecessors still hold.
export function ticketEventFeedbackBatches(effects:readonly TicketEventEffect[]){
  const batches:TicketEventEffect[][]=[];
  for(let offset=0;offset<effects.length;){
    const count=effects.length-offset===12?10:Math.min(11,effects.length-offset);
    batches.push(effects.slice(offset,offset+count));offset+=count;
  }
  return batches;
}

export async function enqueueTicketEventFeedback(client:TicketEventTransaction,input:{
  receipt:TicketEventReceipt;connectionId:string;groupBindingId:string;ticketId:string;
  provider:"WAHA"|"META";reactions:boolean;variables:Record<string,string|boolean|number|undefined>;quotes:TicketQuoteContext;
  preparedPlan?:ReturnType<typeof planTicketEvent>;
}){
  const receipt=input.receipt;
  if(receipt.event!=="reference_received"&&receipt.event!=="ticket_closed"&&!(receipt.event==='quoted_command'&&input.preparedPlan))throw new Error("This event is not a feedback hook");
  if(receipt.state!=="PENDING")return{handled:receipt.mode!=="LEGACY",queued:0,replay:true};
  if(receipt.mode==="LEGACY")return{handled:false,queued:0,replay:false};
  if(receipt.mode==="OFF"){await completeTicketEventExecution(client,receipt,"SKIPPED");return{handled:true,queued:0,replay:false};}
  const definition=await loadPinnedTicketEvent(client,receipt);
  const plan=input.preparedPlan??planTicketEvent(definition,{provider:input.provider,reactions:input.reactions,variables:input.variables,quotes:input.quotes});
  if(plan.effects.some(effect=>effect.type!=="send_text"&&effect.type!=="reaction"))throw new Error("Feedback hook contains a non-feedback effect");
  const effects:TicketEventEffect[]=[];
  let referenceMessages:string[]|undefined;
  for(const effect of plan.effects){
    if(effect.type==="reaction"&&effect.referenceMessages){
      referenceMessages??=await resolveTicketReferenceMessages(client,{tenantId:receipt.tenantId,correlationId:receipt.correlationId,
        executionId:receipt.id,connectionId:input.connectionId,groupId:(await client.query<{external_group_id:string}>(
          `SELECT destination.external_group_id FROM group_bindings binding
            JOIN whatsapp_groups destination ON destination.tenant_id=binding.tenant_id AND destination.id=binding.whatsapp_group_id
            WHERE binding.tenant_id=$1 AND binding.id=$2 AND destination.connection_id=$3`,
          [receipt.tenantId,input.groupBindingId,input.connectionId],
        )).rows[0]?.external_group_id??"",ticketId:input.ticketId});
      for(const target of referenceMessages)effects.push({...effect,replyToMessageId:target});
    }else effects.push(effect);
  }
  const batches=ticketEventFeedbackBatches(effects);
  // All parts have one transaction timestamp; sorted UUIDs retain chunk order in
  // the existing destination-order tie breaker. Multi-chunk batches never end1.
  const batchIds=batches.map(batch=>batch.length>1?randomUUID():null).filter(id=>id!==null).sort();
  for(const batch of batches){
  const batchId=batch.length>1?batchIds.shift()!:null;
  for(const [index,effect] of batch.entries()){
    if(effect.type!=="send_text"&&effect.type!=="reaction")throw new Error("Unsupported feedback effect");
    const contentType=effect.type==="reaction"?"application/vnd.wasalx.whatsapp-reaction":"text/plain";
    const body=effect.type==="reaction"?effect.emoji:effect.text;
    const inserted=(await client.query<{id:string}>(
      `INSERT INTO delivery_outbox (
           tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,
           message_body,content_type,reply_to_message_id,idempotency_key,state,available_at,safe_error,
           delivery_origin,agent_identity_placement_snapshot,batch_id,batch_sequence,batch_part_count,ticket_event_execution_id)
         VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,'QUEUED',
           CASE WHEN $10=0 THEN now() ELSE 'infinity'::timestamptz END,
           CASE WHEN $10=0 THEN NULL ELSE 'Waiting for an earlier message part to complete.' END,
           'TICKET','OFF',$9,$10,$11,$12)
         ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id`,
      [receipt.tenantId,input.connectionId,input.groupBindingId,input.ticketId,body,contentType,effect.replyToMessageId??null,
       "ticket-event:"+receipt.id+":"+effect.nodeId+(effect.type==="reaction"&&effect.referenceMessages
         ?":"+createHash("sha256").update(effect.replyToMessageId!).digest("hex"):""),batchId,index,batch.length,receipt.id],
    )).rows[0];
    if(!inserted)throw new Error("Ticket event effect exists without its completed execution");
    await client.query("INSERT INTO delivery_ticket_links (tenant_id,delivery_id,zammad_ticket_id) VALUES ($1,$2,$3)",[receipt.tenantId,inserted.id,input.ticketId]);
  }
  }
  await completeTicketEventExecution(client,receipt,effects.length?"APPLIED":"SKIPPED");
  return{handled:true,queued:effects.length,replay:false};
}

// SQL expressions are supplied only by our queries, never by request values.
// GOWS replies can contain a bare stanza or a serialized ID with different
// fromMe/participant fields. The actual destination, not the ID, defines scope.
export function groupQuoteMatchesSql(requested:string,candidate:string,group:string,provider:string){
  const stanza=(value:string)=>`CASE
    WHEN length(${value})<=512 AND ${value} ~ '^[A-Za-z0-9]+$' THEN ${value}
    WHEN length(${value})<=512
      AND ${value} ~ '^(true|false)_[0-9-]+@g[.]us_[A-Za-z0-9]+(_[0-9]+@(c[.]us|s[.]whatsapp[.]net|lid))?$'
      AND split_part(${value},'_',2)=${group} THEN split_part(${value},'_',3) END`;
  return `(${candidate}=${requested} OR (${provider}='WAHA' AND ${group} ~ '^[0-9-]+@g[.]us$'
    AND (${stanza(requested)})=(${stanza(candidate)})))`;
}

/** Resolve identity before ticket/availability filters: an unavailable exact
 * target or an off-ticket alias must not redirect an action to another message. */
export async function resolveGroupQuote(client:TicketEventTransaction,input:{
  tenantId:string;connectionId:string;groupId:string;requested:string;
}):Promise<{messageId:string|null;ambiguous:boolean}>{
  const row=(await client.query<{external_message_id:string|null;ambiguous:boolean}>(`
    WITH quote_identities AS (
      -- A retained exact link is a deny-redirection anchor even after privacy
      -- removes group provenance. It still has to pass group/ticket eligibility.
      SELECT link.external_message_id FROM message_links link
        WHERE link.tenant_id=$1 AND link.connection_id=$2 AND link.external_message_id=$4
      UNION
      SELECT message.external_message_id FROM normalized_messages message
        WHERE message.tenant_id=$1 AND message.connection_id=$2 AND message.external_group_id=$3
      UNION
      SELECT delivery.external_message_id FROM delivery_outbox delivery
        LEFT JOIN group_bindings binding ON binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id
        JOIN whatsapp_groups destination ON destination.tenant_id=delivery.tenant_id
          AND destination.id=COALESCE(delivery.group_workspace_group_id,binding.whatsapp_group_id)
        WHERE delivery.tenant_id=$1 AND delivery.connection_id=$2 AND destination.connection_id=$2 AND destination.external_group_id=$3
      UNION
      SELECT link.external_message_id FROM message_links link
        JOIN case_correlations correlation ON correlation.tenant_id=link.tenant_id AND correlation.zammad_ticket_id=link.zammad_ticket_id
        JOIN group_bindings binding ON binding.tenant_id=correlation.tenant_id AND binding.id=correlation.group_binding_id
        JOIN whatsapp_groups destination ON destination.tenant_id=binding.tenant_id AND destination.id=binding.whatsapp_group_id
        WHERE link.tenant_id=$1 AND link.connection_id=$2 AND destination.connection_id=$2 AND destination.external_group_id=$3
          AND NOT EXISTS (SELECT 1 FROM normalized_messages message WHERE message.tenant_id=link.tenant_id
            AND message.connection_id=link.connection_id AND message.external_message_id=link.external_message_id
            AND message.external_group_id IS DISTINCT FROM $3)
          AND NOT EXISTS (SELECT 1 FROM delivery_outbox delivery
            LEFT JOIN group_bindings db ON db.tenant_id=delivery.tenant_id AND db.id=delivery.group_binding_id
            LEFT JOIN whatsapp_groups dg ON dg.tenant_id=delivery.tenant_id AND dg.id=COALESCE(delivery.group_workspace_group_id,db.whatsapp_group_id)
            WHERE delivery.tenant_id=link.tenant_id AND delivery.connection_id=link.connection_id AND delivery.external_message_id=link.external_message_id
              AND COALESCE(dg.external_group_id,delivery.external_chat_id) IS NOT NULL
              AND COALESCE(dg.external_group_id,delivery.external_chat_id)<>$3)
    )
    SELECT CASE WHEN count(*) FILTER (WHERE candidate.external_message_id=$4)>0 THEN $4
      WHEN count(DISTINCT candidate.external_message_id)=1 THEN min(candidate.external_message_id) END AS external_message_id,
      count(*) FILTER (WHERE candidate.external_message_id=$4)=0 AND count(DISTINCT candidate.external_message_id)>1 AS ambiguous
    FROM quote_identities candidate JOIN connections connection ON connection.tenant_id=$1 AND connection.id=$2
    WHERE ${groupQuoteMatchesSql('$4','candidate.external_message_id','$3','connection.provider')}`,
    [input.tenantId,input.connectionId,input.groupId,input.requested],
  )).rows[0];
  return {messageId:row?.external_message_id??null,ambiguous:row?.ambiguous===true};
}

/** Shared eligible-message lookup: API wrappers can convert null to their own
 * HTTP error. Original is explicitly requested, never next-oldest fallback. */
export async function findTicketMessage(client:TicketEventTransaction,input:{
  tenantId:string;connectionId:string;groupId:string;ticketId:string;
  requested:string|null;requestedArticleId?:string|null;direct?:boolean;
}):Promise<string|null>{
  let requested=input.requested;
  if(requested&&!input.direct){
    const resolved=await resolveGroupQuote(client,{...input,requested});
    if(!resolved.messageId)return null;
    requested=resolved.messageId;
  }
  const row=(await client.query<{external_message_id:string}>(
    `SELECT link.external_message_id FROM message_links link
       LEFT JOIN normalized_messages message ON message.tenant_id=link.tenant_id
         AND message.connection_id=link.connection_id AND message.external_message_id=link.external_message_id
       LEFT JOIN delivery_outbox delivery ON delivery.tenant_id=link.tenant_id
         AND delivery.connection_id=link.connection_id AND delivery.external_message_id=link.external_message_id
       LEFT JOIN group_bindings binding ON binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id
       LEFT JOIN whatsapp_groups destination ON destination.tenant_id=delivery.tenant_id
         AND destination.id=COALESCE(binding.whatsapp_group_id,delivery.group_workspace_group_id)
      WHERE link.tenant_id=$1 AND link.connection_id=$2 AND link.zammad_ticket_id=$3
        AND ($5::text IS NULL OR link.external_message_id=$5)
        AND ($6::text IS NULL OR link.zammad_article_id=$6)
        AND (
          (link.direction IN ('INBOUND','MANUAL_DEVICE') AND message.external_group_id=$4
            AND COALESCE(message.provider_metadata->>'eventKind','MESSAGE')<>'REACTION'
            AND NOT COALESCE(message.provider_metadata->'mutations','[]'::jsonb) @> '[{"kind":"REVOKED"}]'::jsonb
            AND NOT EXISTS (SELECT 1 FROM privacy_job_targets privacy
              WHERE privacy.tenant_id=message.tenant_id AND privacy.target_type='NORMALIZED_MESSAGE'
                AND privacy.target_id=message.id::text AND privacy.state IN ('PENDING','EXTERNAL_COMPLETE','COMPLETE')))
          OR
          (link.direction='OUTBOUND' AND (destination.external_group_id=$4 OR ($7 AND delivery.external_chat_id=$4))
            AND delivery.state IN ('SENT','DELIVERED','READ') AND delivery.content_redacted_at IS NULL
            AND delivery.content_type<>'application/vnd.wasalx.whatsapp-reaction'
            AND NOT COALESCE(message.provider_metadata->'mutations','[]'::jsonb) @> '[{"kind":"REVOKED"}]'::jsonb
            AND NOT app.delivery_has_active_privacy_target(delivery.id)
            AND ($5::text IS NOT NULL OR $6::text IS NOT NULL
              OR (link.zammad_article_id IS NOT NULL AND delivery.ticket_event_execution_id IS NULL)))
        )
      ORDER BY COALESCE(message.provider_timestamp,link.created_at) DESC,link.id DESC LIMIT 1`,
    [input.tenantId,input.connectionId,input.ticketId,input.groupId,requested,input.requestedArticleId??null,input.direct===true],
  )).rows[0];
  return row?.external_message_id??null;
}
export async function resolveTicketEventQuotes(client:TicketEventTransaction,input:{
  tenantId:string;connectionId:string;groupId:string;ticketId:string;originalMessageId:string|null;currentMessageId?:string;
}):Promise<TicketQuoteContext>{
  const latest=await findTicketMessage(client,{...input,requested:null});
  const original=input.originalMessageId?await findTicketMessage(client,{...input,requested:input.originalMessageId}):null;
  const current=input.currentMessageId?await findTicketMessage(client,{...input,requested:input.currentMessageId}):null;
  return{...(latest?{latest:{messageId:latest,authorized:true}}:{}),...(original?{original:{messageId:original,authorized:true}}:{}),...(current&&current===input.currentMessageId?{current:{messageId:current,authorized:true}}:{})};
}
