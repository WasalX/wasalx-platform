import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { prepareTicketReply, ticketReplyTarget } from "../services/control-api/dist/ticket-reply-target.js";
import { BotFlowsService } from "../services/control-api/dist/bot-flows.service.js";
import { enqueueTicketEventFeedback, pinTicketEventExecution, resolveGroupQuote, resolveTicketEventQuotes, resolveTicketReferenceMessages, ticketEventSourceHash } from "../packages/core/dist/ticket-event-runtime.js";
import { OutboxRepository } from "../services/connector-worker/dist/services/connector-worker/src/repository.js";
import { InboundRepository } from "../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js";
import { assertTicketCommandBarrier, ticketCommandAdmission } from "../packages/core/dist/ticket-command-guards.js";
import { PrivacyRepository } from "../services/connector-worker/dist/services/connector-worker/src/privacy-repository.js";
import { ZammadGroupWorkspaceController } from "../services/control-api/dist/group-workspace.controller.js";
import { ZammadInternalController } from "../services/control-api/dist/zammad-internal.controller.js";

// Called inside the existing PostgreSQL gate; all fixtures are rolled back.
export async function verifyGroupQuoteProjection(client, tenantId) {
  for (const provider of ['WAHA','META']) await verifyProviderQuote(client,tenantId,provider);
}

async function verifyProviderQuote(client, tenantId, provider) {
  const groupId="13900000-0000-4000-8000-000000000099",connectionId="12900000-0000-4000-8000-000000000099";
  const group="120363000000099@g.us",token="SyntheticQuoteStanza001";
  const quote=`false_${group}_${token}_123456789@lid`,target=`true_${group}_${token}_12025550121@c.us`;
  const alternate=`false_${group}_${token}_12025550122@c.us`;
  const claims={tenantId,userId:"77",groupIds:[],groupAdmin:true,instanceId:"11000000-0000-4000-8000-000000000001"};
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    await client.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Quote connection',$3,$4,'WORKING',$5)",[connectionId,tenantId,provider,provider==="META"?"CLOUD_API":"GOWS",`secret://${tenantId}/connections/${connectionId}/meta`]);
    await client.query("UPDATE tenant_settings SET group_workspace_enabled=true WHERE tenant_id=$1",[tenantId]);
    await client.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,$4,'Quote projection')",[groupId,tenantId,connectionId,group]);
    await client.query("INSERT INTO group_workspace_settings(tenant_id,whatsapp_group_id,capture_enabled,enabled_at,retention_days,visibility,updated_by) VALUES($1,$2,true,now()-interval '1 day',30,'ALL_AGENTS','10100000-0000-4000-8000-000000000001')",[tenantId,groupId]);
    const messageId="63900000-0000-4000-8000-000000000001";
    await client.query("INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status) VALUES($1,$2,$3,$4,'quote-projection','message.reaction','{}','quote-projection','PROCESSED')",[messageId,tenantId,connectionId,provider]);
    await client.query("INSERT INTO normalized_messages(id,tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,participant_name,message_text,quoted_external_message_id,provider_timestamp,provider_metadata,processing_status,history_captured_at) VALUES($1,$2,$1,$3,'reaction',$4,'12025550121@c.us','Agent','Reaction',$5,now(),'{\"eventKind\":\"REACTION\"}','COMPLETE',now())",[messageId,tenantId,connectionId,group,quote]);
    const addTarget=async(id,external,age="1 minute")=>client.query("INSERT INTO delivery_outbox(id,tenant_id,connection_id,group_workspace_group_id,message_body,content_type,idempotency_key,state,delivery_origin,external_message_id,created_at) VALUES($1,$2,$3,$4,'Acknowledgement','text/plain',$1::uuid::text,'SENT','GROUP_WORKSPACE',$5,now()-$6::interval)",[id,tenantId,connectionId,groupId,external,age]);
    const first="63800000-0000-4000-8000-000000000001",second="63800000-0000-4000-8000-000000000002";
    await addTarget(first,target);
    await client.query('SET LOCAL ROLE wasalx_app');
    const identity=await resolveGroupQuote(client,{tenantId,connectionId,groupId:group,requested:token});
    assert.deepEqual(identity,{messageId:provider==='WAHA'?target:null,ambiguous:false});
    assert.equal((await resolveGroupQuote(client,{tenantId,connectionId,groupId:group,requested:target})).messageId,target);
    await client.query('RESET ROLE');
    const controller=new ZammadGroupWorkspaceController({rows:async(scope,sql,params)=>{
      assert.equal(scope,tenantId);
      await client.query("SET LOCAL ROLE wasalx_app");
      try{return(await client.query(sql,params)).rows}
      finally{await client.query("RESET ROLE")}
    }},{verify:async()=>claims},{});
    const projected=async()=>{
      const page=await controller.messages("test",groupId,undefined,"1");
      const context=await controller.context("test",groupId,messageId);
      return [page,context].map(items=>items.find(item=>item.id===messageId)?.quoted_external_message_id);
    };
    await client.query("INSERT INTO group_workspace_participants(tenant_id,whatsapp_group_id,external_participant_id,display_name) VALUES($1,$2,'12025550121@c.us','Older roster name')",[tenantId,groupId]);
    for(const read of [()=>controller.messages("test",groupId,undefined,"1"),()=>controller.context("test",groupId,messageId)]) {
      assert.equal((await read()).find(item=>item.id===messageId)?.participant_name,"Agent","captured nickname wins over roster fallback");
    }
    await client.query("UPDATE normalized_messages SET participant_name=NULL WHERE id=$1",[messageId]);
    assert.equal((await controller.messages("test",groupId,undefined,"1")).find(item=>item.id===messageId)?.participant_name,"Older roster name");
    await client.query("UPDATE normalized_messages SET participant_name='Agent' WHERE id=$1",[messageId]);
    if(provider==="META"){
      assert.deepEqual(await projected(),[quote,quote],"Meta does not use WAHA identity fallback");
      await client.query("UPDATE normalized_messages SET quoted_external_message_id=$2 WHERE id=$1",[messageId,target]);
      assert.deepEqual(await projected(),[target,target],"Meta exact identities remain supported");
      return;
    }
    assert.deepEqual(await projected(),[target,target],"delivery-only target resolves in both read paths");
    await client.query("UPDATE normalized_messages SET quoted_external_message_id=$2 WHERE id=$1",[messageId,token]);
    assert.deepEqual(await projected(),[target,target],"GOWS bare replyTo stanza resolves without changing stored evidence");
    await client.query("UPDATE normalized_messages SET quoted_external_message_id=$2 WHERE id=$1",[messageId,quote]);
    await addTarget(second,alternate,"2 minutes");
    assert.deepEqual(await projected(),[quote,quote],"off-page second identity remains ambiguous");
    await client.query("DELETE FROM delivery_outbox WHERE id=$1",[second]);
    await addTarget(second,quote);
    assert.deepEqual(await projected(),[quote,quote],"exact identity wins");
    await client.query("DELETE FROM delivery_outbox WHERE id=$1",[second]);
    for(const invalid of [`false_999999@g.us_${token}_123456789@lid`,`false_${group}_${token}_bad`,`${token}!`,'A'.repeat(513)]){
      await client.query("UPDATE normalized_messages SET quoted_external_message_id=$2 WHERE id=$1",[messageId,invalid]);
      assert.deepEqual(await projected(),[invalid,invalid],"malformed or foreign embedded group cannot alias a target");
    }
    await client.query("UPDATE normalized_messages SET quoted_external_message_id=$2 WHERE id=$1",[messageId,quote]);
    const foreignGroup="13900000-0000-4000-8000-000000000098";
    await client.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,'120363000000098@g.us','Other group')",[foreignGroup,tenantId,connectionId]);
    await addTarget(second,alternate);
    await client.query("UPDATE delivery_outbox SET group_workspace_group_id=$2 WHERE id=$1",[second,foreignGroup]);
    assert.deepEqual(await projected(),[target,target],"same-token delivery from another group cannot introduce ambiguity");
    await client.query("SAVEPOINT redacted_quote_target");
    await client.query("UPDATE delivery_outbox SET content_redacted_at=now(),group_workspace_group_id=NULL,external_message_id=NULL,message_body='' WHERE id=$1",[first]);
    assert.deepEqual(await projected(),[quote,quote],"redacted target is excluded");
    await client.query("ROLLBACK TO SAVEPOINT redacted_quote_target");
    await client.query("UPDATE delivery_outbox SET created_at=now()-interval '2 days' WHERE id=$1",[first]);
    assert.deepEqual(await projected(),[quote,quote],"pre-capture target is excluded");
    assert.equal((await client.query("SELECT quoted_external_message_id FROM normalized_messages WHERE id=$1",[messageId])).rows[0].quoted_external_message_id,quote);
  } finally { await client.query("ROLLBACK"); }
}

// Isolated PostgreSQL only: no native workers/provider effects; complete rollback.
export async function verifyTicketEventTargets(client, tenantId, fixture) {
  const { userId, foreignTenantId, botAssignmentId, botFlowVersionId } = fixture;
  assert(userId && foreignTenantId && botAssignmentId && botFlowVersionId);
  await client.query('BEGIN');
  let serial=0;
  const role=async(scope,name,action)=>{
    assert(['wasalx_app','wasalx_connector_worker'].includes(name));
    const savepoint=`ticket_events_${++serial}`;await client.query(`SAVEPOINT ${savepoint}`);
    try {
      await client.query("SELECT set_config('app.tenant_id',$1,true)",[scope]);
      await client.query(`SET LOCAL ROLE ${name}`);
      const result=await action(client);await client.query('RESET ROLE');
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);return result;
    } catch(error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);throw error;
    }
  };
  const connectionId=randomUUID(),groupId=randomUUID(),otherGroupId=randomUUID(),bindingId=randomUUID();
  const group='120363000000997@g.us',otherGroup='120363000000996@g.us',ticketId='97401';
  const prefix=`ticket-events-pg-${randomUUID()}`;
  const link=(external,articleId,direction,ticket=ticketId,age='0 seconds')=>client.query(
    `INSERT INTO message_links(tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction,created_at)
     VALUES($1,$2,$3,$4,$5,$6,now()-$7::interval)`,[tenantId,connectionId,external,ticket,articleId,direction,age]);
  const incoming=async(name,age,{destination=group,ticket=ticketId,article=null,metadata={},externalId=null}={})=>{
    const id=randomUUID(),external=externalId??`${prefix}-${name}`;
    await client.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status)
      VALUES($1,$2,$3,'WAHA',$4,'message','{}',$5,'PROCESSED')`,[id,tenantId,connectionId,external,'0'.repeat(64)]);
    await client.query(`INSERT INTO normalized_messages(id,tenant_id,event_inbox_id,connection_id,external_message_id,
      external_group_id,external_participant_id,message_text,provider_timestamp,provider_metadata,processing_status)
      VALUES($1,$2,$1,$3,$4,$5,'12025550156@c.us','Synthetic target',now()-$6::interval,$7,'COMPLETE')`,
      [id,tenantId,connectionId,external,destination,age,metadata]);
    await link(external,article,'INBOUND',ticket,age);return {id,external,article};
  };
  const sent=async(name,age,{article=null,state='SENT',contentType='text/plain',destinationId=groupId,ack=false,reply=null,externalId=null,ticket=ticketId}={})=>{
    const id=randomUUID(),external=externalId??`${prefix}-${name}`;
    await client.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,group_workspace_group_id,zammad_ticket_id,
      zammad_article_id,message_body,content_type,idempotency_key,state,delivery_origin,external_message_id,updated_at,group_binding_id,reply_to_message_id)
      VALUES($1,$2,$3,$4,$5,$6,'Synthetic reply',$7,$8,$9,'TICKET',$10,now()-$11::interval,$12,$13)`,
      [id,tenantId,connectionId,ack?null:destinationId,ticket,article,contentType,
       ack?`ack:${createHash('sha256').update(`${prefix}-${name}`).digest('hex')}`:`${prefix}-${name}`,state,external,age,ack?bindingId:null,reply]);
    await link(external,article,'OUTBOUND',ticket,age);return {id,external,article};
  };
  const privacy=async(type,targetId)=>{
    const id=randomUUID();
    await client.query(`INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,unmatched_diagnostic_hours_snapshot)
      VALUES($1,$2,'RETENTION_SWEEP','TENANT',$2::uuid::text,'RETENTION_DELETE',$3,24)`,[id,tenantId,`${prefix}-${id}`]);
    await client.query(`INSERT INTO privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256)
      VALUES($1,$2,$3,$4,$5)`,[tenantId,id,type,targetId,createHash('sha256').update(targetId).digest('hex')]);
  };
  const target=overrides=>role(tenantId,'wasalx_app',c=>ticketReplyTarget(c,{
    tenantId,connectionId,groupId:group,ticketId,requested:null,...overrides}));
  try {
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    await client.query(`INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference)
      VALUES($1,$2,'Ticket event PG','WAHA','GOWS','WORKING',$3)`,[connectionId,tenantId,`secret://${tenantId}/connections/${connectionId}/session`]);
    for(const [id,external] of [[groupId,group],[otherGroupId,otherGroup]])await client.query(
      `INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,$4,'Synthetic target group')`,
      [id,tenantId,connectionId,external]);
    const ruleSet=(await client.query('SELECT rule_set_id FROM group_bindings WHERE tenant_id=$1 ORDER BY id LIMIT 1',[tenantId])).rows[0]?.rule_set_id;
    assert(ruleSet,'existing isolated rule-set prerequisite');
    await client.query(`INSERT INTO group_bindings(id,tenant_id,whatsapp_group_id,rule_set_id,zammad_group_id,
      default_priority,assignment_mode,acknowledgement_template,agent_prefix,retention_days,state)
      VALUES($1,$2,$3,$4,'Operations','normal','zammad_auto','Case {{tickets}}','Agent:',30,'PAUSED')`,[bindingId,tenantId,groupId,ruleSet]);
    const first=await incoming('customer','10 minutes',{article:'974101'});
    assert.equal(await target(),first.external);
    assert.equal(await target({requestedArticleId:first.article}),first.external,'empty native Message-ID preserves article->provider identity');
    const agent=await sent('agent','8 minutes',{article:'974102'});
    assert.equal(await target(),agent.external,'latest sent agent in same ticket is usable');
    const eventQuotes=(currentMessageId,overrides={})=>role(tenantId,'wasalx_connector_worker',c=>resolveTicketEventQuotes(c,{
      tenantId,connectionId,groupId:group,ticketId,originalMessageId:first.external,currentMessageId,...overrides}));
    const delayed=await incoming('delayed-trigger','9 minutes',{article:'974199'});
    assert.deepEqual(await eventQuotes(delayed.external),{
      latest:{messageId:agent.external,authorized:true},original:{messageId:first.external,authorized:true},current:{messageId:delayed.external,authorized:true},
    },'current event is independent of provider timestamp ordering');
    assert.equal((await eventQuotes(delayed.external,{ticketId:'97499'})).current,undefined);
    assert.equal((await eventQuotes(delayed.external,{groupId:otherGroup})).current,undefined);
    assert.equal((await eventQuotes(delayed.external,{tenantId:foreignTenantId})).current,undefined);
    await privacy('NORMALIZED_MESSAGE',delayed.id);
    assert.equal((await eventQuotes(delayed.external)).current,undefined,'privacy blocks exact current target without fallback');
    const ack=await sent('ack','1 minute',{ack:true,reply:first.external});
    const reaction=await incoming('reaction','1 minute',{metadata:{eventKind:'REACTION'},article:'974103'});
    const outgoingReaction=await sent('outgoing-reaction','1 minute',{article:'974104',contentType:'application/vnd.wasalx.whatsapp-reaction'});
    const outgoingRevoked=await sent('outgoing-revoked','1 minute',{article:'974114'});
    const outgoingEchoId=randomUUID();
    await client.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status)
      VALUES($1,$2,$3,'WAHA',$4,'message','{}',$5,'PROCESSED')`,[outgoingEchoId,tenantId,connectionId,`${prefix}-outgoing-echo`,'0'.repeat(64)]);
    await client.query(`INSERT INTO normalized_messages(id,tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,
      external_participant_id,message_text,provider_timestamp,provider_metadata,processing_status)
      VALUES($1,$2,$1,$3,$4,$5,'12025550156@c.us','Synthetic revoked echo',now(),$6,'COMPLETE')`,
      [outgoingEchoId,tenantId,connectionId,outgoingRevoked.external,group,{mutations:[{kind:'REVOKED'}]}]);
    const unsent=await sent('unsent','1 minute',{article:'974105',state:'QUEUED'});
    const revoked=await incoming('revoked','1 minute',{article:'974106',metadata:{mutations:[{kind:'REVOKED'}]}});
    const hidden=await incoming('private','1 minute',{article:'974107'});await privacy('NORMALIZED_MESSAGE',hidden.id);
    const other=await incoming('other-group','1 minute',{destination:otherGroup,article:'974108'});
    await sent('other-group-agent','1 minute',{destinationId:otherGroupId,article:'974109'});
    await incoming('other-ticket','1 minute',{ticket:'97402',article:'974110'});
    const redacted={id:randomUUID(),external:`${prefix}-redacted`,article:'974113'};
    await client.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,message_body,content_type,idempotency_key,state,
      delivery_origin,content_redacted_at) VALUES($1,$2,$3,'','text/plain',$4,'SENT','TICKET',now())`,
      [redacted.id,tenantId,connectionId,`${prefix}-redacted`]);
    await link(redacted.external,redacted.article,'OUTBOUND');
    assert.equal(await target(),agent.external,'ACK/reactions/unsent/revoke/privacy/foreign destination cannot win');
    assert.equal(await target({requestedArticleId:first.article}),first.external,'explicit selected older article wins');
    assert.equal(await target({requested:ack.external}),ack.external,'explicit same-ticket ACK may intentionally be quoted');
    for(const row of [reaction,outgoingReaction,outgoingRevoked,unsent,revoked,hidden,other,redacted])await assert.rejects(
      ()=>target({requested:row.external}),/no longer available/);
    for(const row of [reaction,outgoingReaction,outgoingRevoked,unsent,revoked,hidden,other,redacted])assert.equal((await eventQuotes(row.external)).current,undefined);
    await privacy('DELIVERY',agent.id);assert.equal(await target(),first.external);
    await assert.rejects(()=>target({requestedArticleId:agent.article}),/no longer available/);
    assert.equal(await role(foreignTenantId,'wasalx_app',c=>ticketReplyTarget(c,{
      tenantId:foreignTenantId,connectionId,groupId:group,ticketId,requested:null})),null,'other tenant cannot select target');
    await assert.rejects(()=>role(foreignTenantId,'wasalx_app',c=>ticketReplyTarget(c,{
      tenantId:foreignTenantId,connectionId,groupId:group,ticketId,requested:first.external})),/no longer available/);

    // Real SQL/RLS regression for GOWS2026.7.2: extractReplyTo returns a bare
    // stanza while send returns a serialized ID. All mutations roll back.
    await client.query('SAVEPOINT group_quote_aliases');
    const stanza='ABCDEF1234567890123456',canonical=`true_${group}_${stanza}_12025550121@c.us`;
    const alias=`false_${group}_${stanza}_123456789@lid`;
    const quoted=await sent('canonical','1 minute',{externalId:canonical,article:'974150'});
    assert.equal((await eventQuotes(stanza)).current,undefined,'missing exact event identity never substitutes a serialized quote alias');
    assert.equal((await eventQuotes(canonical)).current.messageId,canonical);
    const caseId=(await client.query(`INSERT INTO case_correlations(tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,zammad_ticket_number,state)
      VALUES($1,$2,'DLX100534413602',$3,'997401','OPEN') RETURNING id`,[tenantId,bindingId,ticketId])).rows[0].id;
    await verifyBindingRepliesWithoutWorkspace(client,{tenantId,foreignTenantId,userId,connectionId,groupId,group,bindingId,ticketId,caseId,role});
    const repository=new InboundRepository({connect:async()=>({release(){},query:(sql,values)=>
      ['BEGIN','COMMIT','ROLLBACK'].includes(sql)?Promise.resolve({rows:[],rowCount:0}):client.query(sql,values)})});
    const associated=(requested,refs=[])=>role(tenantId,'wasalx_connector_worker',()=>repository.ticketsForQuotedMessage(
      {tenantId,connectionId},requested,{bindingId,groupId:group},refs));
    const identity=(requested,overrides={})=>role(tenantId,'wasalx_app',c=>resolveGroupQuote(c,{tenantId,connectionId,groupId:group,requested,...overrides}));
    for(const requested of [stanza,alias,canonical]){
      assert.equal(await target({requested}),canonical);
      assert.deepEqual(await associated(requested),[ticketId]);
    }
    await assert.rejects(()=>associated(stanza,['DLX000000000001']),{code:'QUOTE_REFERENCE_CONFLICT'});
    const scoped=async(action)=>{await client.query('SAVEPOINT alias_case');try{await action();}finally{await client.query('ROLLBACK TO SAVEPOINT alias_case');await client.query('RELEASE SAVEPOINT alias_case');}};
    for(const ticket of [ticketId,'97402'])await scoped(async()=>{
      const alternate=`false_${group}_${stanza}_12025550122@c.us`;
      await sent(`second-${ticket}`,'2 minutes',{externalId:alternate,ticket,article:'974151'});
      assert.deepEqual(await identity(stanza),{messageId:null,ambiguous:true},'identity ambiguity precedes ticket filtering');
      await assert.rejects(()=>target({requested:stanza}),/no longer available/);
      await assert.rejects(()=>associated(stanza),{code:'QUOTE_TARGET_AMBIGUOUS'});
      assert.equal(await target({requested:canonical}),canonical,'exact wins over aliases');
    });
    await scoped(async()=>{
      await incoming('exact','1 minute',{externalId:stanza,ticket:'97402',article:'974152'});
      assert.deepEqual(await identity(stanza),{messageId:stanza,ambiguous:false});
      await assert.rejects(()=>target({requested:stanza}),/no longer available/,'exact foreign-ticket target never falls back');
    });
    await scoped(async()=>{
      await link(alias,'974155','OUTBOUND','97499');
      assert.deepEqual(await identity(alias),{messageId:alias,ambiguous:false},'retained exact identity with no remaining group provenance blocks redirection');
      await assert.rejects(()=>target({requested:alias}),/no longer available/);
      await assert.rejects(()=>associated(alias),{code:'QUOTE_TARGET_UNAVAILABLE'});
    });
    await scoped(async()=>{
      await incoming('retained','1 minute',{externalId:alias,article:'974153',metadata:{mutations:[{kind:'REVOKED'}]}});
      assert.deepEqual(await identity(stanza),{messageId:null,ambiguous:true},'unavailable identities still make aliases ambiguous');
      await assert.rejects(()=>target({requested:alias}),/no longer available/,'revoked exact does not fall back');
    });
    for(const invalidate of [
      ()=>client.query("UPDATE delivery_outbox SET state='QUEUED' WHERE id=$1",[quoted.id]),
      ()=>privacy('DELIVERY',quoted.id),
      ()=>client.query("UPDATE delivery_outbox SET content_redacted_at=now(),external_message_id=NULL,group_workspace_group_id=NULL,zammad_ticket_id=NULL,zammad_article_id=NULL,message_body='' WHERE id=$1",[quoted.id]),
    ])await scoped(async()=>{
      await invalidate();assert.deepEqual(await identity(stanza),{messageId:canonical,ambiguous:false});
      await assert.rejects(()=>target({requested:stanza}),/no longer available/);
      await assert.rejects(()=>associated(stanza),{code:'QUOTE_TARGET_UNAVAILABLE'});
    });
    await scoped(async()=>{
      await client.query("UPDATE case_correlations SET state='DETACHED',detached_at=now() WHERE id=$1",[caseId]);
      await assert.rejects(()=>associated(stanza),{code:'QUOTE_TARGET_UNAVAILABLE'});
    });
    await scoped(async()=>{
      await client.query('UPDATE delivery_outbox SET group_workspace_group_id=$2 WHERE id=$1',[quoted.id,otherGroupId]);
      assert.deepEqual(await identity(stanza),{messageId:null,ambiguous:false},'case binding cannot override actual delivery destination');
    });
    await scoped(async()=>{
      await incoming('contradictory','1 minute',{externalId:alias,destination:otherGroup,article:'974154'});
      assert.deepEqual(await identity(stanza),{messageId:canonical,ambiguous:false},'case binding cannot override captured message destination');
    });
    for(const requested of [`false_${otherGroup}_${stanza}_123@lid`,`${stanza}!`,stanza.toLowerCase(),'A'.repeat(513)])
      assert.deepEqual(await identity(requested),{messageId:null,ambiguous:false});
    for(const overrides of [{groupId:otherGroup},{connectionId:randomUUID()},{tenantId:foreignTenantId}])
      assert.deepEqual(await identity(stanza,overrides),{messageId:null,ambiguous:false});
    await client.query('ROLLBACK TO SAVEPOINT group_quote_aliases');await client.query('RELEASE SAVEPOINT group_quote_aliases');
    const directChat='12025550157@c.us',directTicket='97403';
    await client.query(`INSERT INTO bot_conversations(tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,
      normalized_reference,state,current_node_id,zammad_ticket_id,zammad_ticket_number,last_activity_at)
      VALUES($1,$2,$3,$4,$5,'BOT-000000097403','HUMAN','handoff',$6,'997403',now())`,
      [tenantId,botAssignmentId,connectionId,botFlowVersionId,directChat,directTicket]);
    const direct=await incoming('direct','5 minutes',{destination:directChat,ticket:directTicket,article:'974111'});
    const foreignDirect=await incoming('wrong-direct-chat','1 minute',{destination:'12025550158@c.us',ticket:directTicket,article:'974112'});
    assert.equal(await target({groupId:directChat,ticketId:directTicket,direct:true,requestedArticleId:direct.article}),direct.external);
    await assert.rejects(()=>target({groupId:directChat,ticketId:directTicket,direct:true,requestedArticleId:foreignDirect.article}),/no longer available/);

    const flags=(await client.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid IN ('ticket_event_bindings'::regclass,'ticket_event_executions'::regclass)`)).rows;
    assert.equal(flags.length,2);assert(flags.every(r=>r.relrowsecurity&&r.relforcerowsecurity));
    const definition={schemaVersion:1,kind:'TICKET_EVENT',name:prefix,event:'reference_received',start:'done',maxSteps:2,nodes:[{id:'done',type:'end'}]};
    const createFlow=(scope,actor,flow)=>role(scope,'wasalx_app',async c=>{
      const family=(await c.query('SELECT app.create_bot_flow_family($1,$2) AS id',[`${prefix}-${randomUUID()}`,actor])).rows[0].id;
      const version=(await c.query('SELECT * FROM app.create_bot_flow_version($1,$2,NULL,$3)',[family,flow,actor])).rows[0];
      const active=(await c.query('SELECT * FROM app.activate_bot_flow_version($1,$2,NULL,$3)',[version.id,version.revision,actor])).rows[0];
      return {family,...version,...active,id:version.id};
    });
    const flow=await createFlow(tenantId,userId,definition);
    const service=new BotFlowsService({withTenant:(scope,work)=>role(scope,'wasalx_app',work)}, {}, {});
    const principal={tenantId,userId,role:'tenant_owner'};
    const body={event:'reference_received',groupId,mode:'CUSTOM',flowVersionId:flow.id,expectedRevision:0};
    const assigned=await service.bindTicketEvent(principal,`${prefix}-bind`,prefix,body);assert.equal(assigned.revision,1);
    const replay=await service.bindTicketEvent(principal,`${prefix}-bind`,prefix,body);
    assert.equal(replay.id,assigned.id);assert.equal(replay.revision,1);assert.equal(replay.duplicate,true);
    await assert.rejects(()=>service.bindTicketEvent(principal,`${prefix}-stale`,prefix,body),/changed/);
    await assert.rejects(()=>service.bindTicketEvent(principal,`${prefix}-bind`,prefix,{...body,mode:'OFF',flowVersionId:null}),/Idempotency/);
    const off=await service.bindTicketEvent(principal,`${prefix}-off`,prefix,{...body,mode:'OFF',flowVersionId:null,expectedRevision:1});assert.equal(off.revision,2);
    const readBinding=async()=>(await client.query('SELECT mode,flow_version_id,revision FROM ticket_event_bindings WHERE id=$1',[assigned.id])).rows[0];
    const before=await readBinding();assert.deepEqual(before,{mode:'OFF',flow_version_id:null,revision:'2'});
    const foreignActor=(await client.query("SELECT user_id FROM tenant_memberships WHERE tenant_id=$1 AND role='tenant_owner' LIMIT 1",[foreignTenantId])).rows[0]?.user_id;
    assert(foreignActor,'existing isolated foreign owner prerequisite');
    const foreignFlow=await createFlow(foreignTenantId,foreignActor,definition);
    await assert.rejects(()=>service.bindTicketEvent(principal,`${prefix}-foreign`,prefix,{...body,flowVersionId:foreignFlow.id,expectedRevision:2}),/not found/);
    await assert.rejects(()=>role(tenantId,'wasalx_app',c=>c.query(`INSERT INTO ticket_event_bindings
      (tenant_id,whatsapp_group_id,event,mode,flow_version_id,updated_by) VALUES($1,$2,'ticket_closed','CUSTOM',$3,$4)`,
      [tenantId,groupId,foreignFlow.id,userId])),e=>['23514','23503'].includes(e.code));
    await assert.rejects(()=>role(tenantId,'wasalx_app',c=>c.query('UPDATE bot_flow_versions SET definition=$2 WHERE id=$1',[flow.id,{...definition,name:'Changed'}])),e=>['42501','55000','23514'].includes(e.code));
    await assert.rejects(()=>role(tenantId,'wasalx_app',c=>c.query('SELECT * FROM app.create_bot_flow_version($1,$2,$3,$4)',
      [flow.family,{...definition,event:'ticket_closed'},flow.id,userId])),e=>e.code==='23514');
    assert.equal((await role(foreignTenantId,'wasalx_app',c=>c.query('SELECT id FROM ticket_event_bindings WHERE id=$1',[assigned.id]))).rowCount,0);
    assert.equal((await role(foreignTenantId,'wasalx_app',c=>c.query("UPDATE ticket_event_bindings SET mode='OFF' WHERE id=$1",[assigned.id]))).rowCount,0);
    await assert.rejects(()=>role(foreignTenantId,'wasalx_app',c=>c.query(`INSERT INTO ticket_event_bindings
      (tenant_id,event,mode,updated_by) VALUES($1,'ticket_closed','OFF',$2)`,[tenantId,userId])),e=>e.code==='42501');
    assert.equal((await role(tenantId,'wasalx_connector_worker',c=>c.query('SELECT id FROM ticket_event_bindings WHERE id=$1',[assigned.id]))).rowCount,1);
    await assert.rejects(()=>role(tenantId,'wasalx_connector_worker',c=>c.query('UPDATE ticket_event_bindings SET revision=revision+1 WHERE id=$1',[assigned.id])),e=>e.code==='42501');
    const sourceBinding=(await client.query('SELECT id FROM group_bindings WHERE tenant_id=$1 ORDER BY id LIMIT 1',[tenantId])).rows[0]?.id;assert(sourceBinding);
    const correlation=(await client.query(`INSERT INTO case_correlations(tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,zammad_ticket_number,state)
      VALUES($1,$2,$3,'97404','997404','OPEN') RETURNING id`,[tenantId,sourceBinding,prefix])).rows[0].id;
    const execution=(await role(tenantId,'wasalx_connector_worker',c=>c.query(`INSERT INTO ticket_event_executions
      (tenant_id,correlation_id,event,source_sha256,flow_version_id,mode) VALUES($1,$2,'reference_received',$3,$4,'CUSTOM') RETURNING id`,
      [tenantId,correlation,'a'.repeat(64),flow.id]))).rows[0].id;
    await assert.rejects(()=>role(tenantId,'wasalx_connector_worker',c=>c.query(`INSERT INTO ticket_event_executions
      (tenant_id,correlation_id,event,source_sha256,flow_version_id,mode) VALUES($1,$2,'reference_received',$3,$4,'CUSTOM')`,
      [tenantId,correlation,'a'.repeat(64),flow.id])),e=>e.code==='23505');
    await assert.rejects(()=>role(tenantId,'wasalx_connector_worker',c=>c.query('UPDATE ticket_event_executions SET source_sha256=$2 WHERE id=$1',[execution,'b'.repeat(64)])),e=>e.code==='55000');
    assert.equal((await role(tenantId,'wasalx_connector_worker',c=>c.query("UPDATE ticket_event_executions SET state='APPLIED',completed_at=now() WHERE id=$1 RETURNING id",[execution]))).rowCount,1);
    await assert.rejects(()=>role(tenantId,'wasalx_connector_worker',c=>c.query("UPDATE ticket_event_executions SET state='SKIPPED' WHERE id=$1",[execution])),e=>e.code==='55000');
    assert.equal((await role(foreignTenantId,'wasalx_connector_worker',c=>c.query('SELECT id FROM ticket_event_executions WHERE id=$1',[execution]))).rowCount,0);
    assert.deepEqual(await readBinding(),before,'failed CAS/foreign writes preserve exact binding');
    await verifyTicketEventFeedbackAdmission(client,tenantId,userId,bindingId,connectionId,role,createFlow);
    await verifyAllReferenceCloseFeedback(client,tenantId,foreignTenantId,userId,role,createFlow);
    await verifyDeniedQuotedCommandTranscript(client,tenantId,userId,{connectionId,groupId,bindingId,group,incoming,privacy},role,createFlow);
    await verifyTicketEventPrivacyFinalization(client,userId,role,createFlow);
  } finally {await client.query('ROLLBACK');}
}

async function verifyBindingRepliesWithoutWorkspace(client,{tenantId,foreignTenantId,userId,connectionId,groupId,group,bindingId,ticketId,caseId,role}) {
  await client.query('SAVEPOINT binding_reply_authorization');
  try {
    await client.query("UPDATE group_bindings SET zammad_group_id='2',state='ACTIVE' WHERE id=$1",[bindingId]);
    assert.equal((await client.query('SELECT 1 FROM group_workspace_settings WHERE tenant_id=$1 AND whatsapp_group_id=$2',[tenantId,groupId])).rowCount,0);
    assert.equal((await client.query('SELECT 1 FROM group_workspace_grants WHERE tenant_id=$1 AND whatsapp_group_id=$2',[tenantId,groupId])).rowCount,0);
    const instanceId=(await client.query("SELECT id FROM zammad_instances WHERE tenant_id=$1 AND state='WORKING' LIMIT 1",[tenantId])).rows[0]?.id;
    assert(instanceId,'active isolated native instance prerequisite');
    const claims={tenantId,instanceId,userId:'17',groupIds:['2'],groupAdmin:false};
    const database={
      rows:async(scope,sql,values)=>role(scope,'wasalx_app',async c=>(await c.query(sql,values)).rows),
      withTenant:async(scope,work)=>role(scope,'wasalx_app',work),
    };
    const controller=new ZammadInternalController(database,{verify:async()=>({...claims})},{wake:async()=>assert.fail('read-only preview must not wake workers')});
    const preview=(overrides={})=>controller.replyPreview('fixture',{tenant_id:claims.tenantId,connection_id:connectionId,
      group_id:group,ticket_id:ticketId,body:'Synthetic agent reply',internal:false,has_attachments:false,agent:{id:17,display_name:'Agent'},...overrides});
    const preflight=()=>controller.outboundPreflight('fixture',connectionId,group,ticketId);
    const allowed=async()=>{assert.match((await preview()).text,/Synthetic agent reply$/u);assert.equal((await preflight()).available,true);};
    const denied=async()=>{for(const read of [preview,preflight])await assert.rejects(()=>read(),error=>error.getStatus?.()===404);};
    await allowed();
    await verifyRestoredSentDraftCandidate(client,{tenantId,instanceId,connectionId,bindingId,group,ticketId,preview,role});
    claims.groupIds=['3'];await denied();claims.groupIds=['2'];
    await assert.rejects(()=>preview({ticket_id:'97499'}),error=>error.getStatus?.()===404);
    await assert.rejects(()=>preview({group_id:'120363000000994@g.us'}),error=>error.getStatus?.()===404);
    const originalTenant=claims.tenantId;claims.tenantId=foreignTenantId;
    const originalInstance=claims.instanceId;
    claims.instanceId=(await client.query("SELECT id FROM zammad_instances WHERE tenant_id=$1 AND state='WORKING' LIMIT 1",[foreignTenantId])).rows[0].id;
    await denied();claims.tenantId=originalTenant;claims.instanceId=originalInstance;
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    await client.query("UPDATE case_correlations SET state='DETACHED',detached_at=now() WHERE id=$1",[caseId]);await denied();
    await client.query("UPDATE case_correlations SET state='RESOLVED',detached_at=NULL WHERE id=$1",[caseId]);await allowed();
    await client.query("UPDATE group_bindings SET state='PAUSED' WHERE id=$1",[bindingId]);await denied();
    await client.query("UPDATE group_bindings SET state='ACTIVE' WHERE id=$1",[bindingId]);
    await client.query("UPDATE connections SET state='ACTION_REQUIRED' WHERE id=$1",[connectionId]);await denied();
    await client.query("UPDATE connections SET state='WORKING' WHERE id=$1",[connectionId]);
    const routingId=randomUUID();
    const definition={schemaVersion:1,sources:[],clients:[{id:'synthetic',zammadGroupId:'5'}],fallback:{zammadGroupId:'6'}};
    await client.query(`INSERT INTO client_routing_versions(id,tenant_id,version,state,definition,snapshot_sha256,created_by,
      activated_by,activated_at,retired_by,retired_at)
      SELECT $1,$2,COALESCE(MAX(version),0)+1,'RETIRED',$3,repeat('0',64),$4,$4,now(),$4,now()
      FROM client_routing_versions WHERE tenant_id=$2`,[routingId,tenantId,definition,userId]);
    await client.query(`UPDATE case_correlations SET client_routing_version_id=$2,client_route_status='MATCHED',
      client_id='synthetic',client_route_matched_by='WHATSAPP_GROUP' WHERE id=$1`,[caseId,routingId]);
    await denied();claims.groupIds=['5'];await allowed();
    await client.query("UPDATE case_correlations SET client_id='missing-client' WHERE id=$1",[caseId]);await denied();
    await client.query(`UPDATE case_correlations SET client_route_status='FALLBACK',client_id=NULL,
      client_route_matched_by='FALLBACK' WHERE id=$1`,[caseId]);
    await denied();claims.groupIds=['6'];await allowed();
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT binding_reply_authorization');
    await client.query('RELEASE SAVEPOINT binding_reply_authorization');
  }
}

async function verifyRestoredSentDraftCandidate(client,{tenantId,instanceId,connectionId,bindingId,group,ticketId,preview,role}) {
  await client.query('SAVEPOINT restored_draft_detector');
  const originalWrite=process.stderr.write,events=[];
  process.stderr.write=function(chunk,...args){
    const text=String(chunk);
    if(text.includes('"event":"POSSIBLE_SENT_DRAFT_RESTORE_MATCH"')){events.push(JSON.parse(text));return true;}
    return originalWrite.call(this,chunk,...args);
  };
  try {
    const text=`Synthetic restored draft ${randomUUID()}`,quote=(await preview()).replyToMessageId;
    assert(quote);
    const check=(overrides={})=>preview({body:text,reply_to_message_id:quote,restored_draft:true,...overrides});
    const binding=(await client.query('SELECT agent_prefix,agent_identity_placement FROM group_bindings WHERE id=$1',[bindingId])).rows[0];
    const prepared=await role(tenantId,'wasalx_app',c=>prepareTicketReply(c,{tenantId,connectionId,groupId:group,ticketId,requested:quote,
      groupBindingId:bindingId,body:text,contentType:'text/plain',hasAttachments:false,agentDisplayName:'Agent',
      agentPrefixSnapshot:binding.agent_prefix,agentIdentityPlacementSnapshot:binding.agent_identity_placement},false));
    let serial=0;
    const add=async(overrides={})=>{
      const id=randomUUID(),external=`restored-draft-${randomUUID()}`,article=String(978000+serial++);
      const row={connectionId,ticketId,body:prepared.body,contentType:prepared.contentType,quote:prepared.replyToMessageId,state:'SENT',article,...overrides};
      await client.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,
        message_body,content_type,idempotency_key,state,external_message_id,reply_to_message_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id,tenantId,row.connectionId,bindingId,row.ticketId,row.article,row.body,row.contentType,external,row.state,external,row.quote]);
      await client.query(`INSERT INTO message_links(tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction,created_at)
        VALUES($1,$2,$3,$4,$5,'OUTBOUND',clock_timestamp())`,[tenantId,row.connectionId,external,row.ticketId,row.article]);
      return{id,article};
    };
    for(const change of [{body:prepared.body+' differs'},{contentType:prepared.contentType==='text/plain'?'text/html':'text/plain'},
      {quote:null},{state:'QUEUED'},{state:'OUTCOME_UNKNOWN'},{ticketId:'979999'}])await add(change);
    await check();assert.equal(events.length,0,'mismatched or unconfirmed deliveries never log');
    const match=await add();
    await check();assert.equal(events.length,1);
    assert.equal(events[0].delivery_id,match.id);assert.equal(events[0].article_id,match.article);
    assert.equal(events[0].tenant_id,tenantId);assert.equal(events[0].instance_id,instanceId);
    assert.equal(events[0].scope,'RECENT_100_TICKET_LINKS');
    const fields=Object.keys(events[0]).sort();
    assert.deepEqual(fields,['article_id','connection_id','delivery_id','event','instance_id','level','scope','tenant_id','ticket_id','timestamp']);
    assert(!JSON.stringify(events).includes(text));assert(!JSON.stringify(events).includes(quote));
    // An older matching restored body remains a possible candidate after a newer different actual send.
    await add({body:prepared.body+' newer actual send',state:'DELIVERED'});
    await check();assert.equal(events.length,2);assert.equal(events[1].delivery_id,match.id);
    await preview({body:text,reply_to_message_id:quote});await check({restored_draft:false});assert.equal(events.length,2);
    await assert.rejects(()=>check({agent:{id:18,display_name:'Other agent'}}),error=>error.getStatus?.()===401);
    await assert.rejects(()=>check({ticket_id:'979998'}),error=>error.getStatus?.()===404);assert.equal(events.length,2);
    // Push the exact match outside the materialized window; no full-history fallback is allowed.
    await client.query(`INSERT INTO message_links(tenant_id,connection_id,external_message_id,zammad_ticket_id,direction,created_at)
      SELECT $1,$2,$3||n::text,$4,'INBOUND',clock_timestamp()+n*interval '1 millisecond' FROM generate_series(1,100) n`,
      [tenantId,connectionId,`draft-window-${randomUUID()}-`,ticketId]);
    await check();assert.equal(events.length,2,'matching historical links outside the100-link window are not checked');
  } finally {
    process.stderr.write=originalWrite;
    await client.query('ROLLBACK TO SAVEPOINT restored_draft_detector');await client.query('RELEASE SAVEPOINT restored_draft_detector');
  }
}

// The real finalizer runs with its worker role in an isolated tenant.
// Its transaction adapter reuses this gate's rollback-only connection.
async function verifyTicketEventPrivacyFinalization(client,userId,role,createFlow) {
  const tenantId=randomUUID(),connectionId=randomUUID(),groupId=randomUUID(),bindingId=randomUUID();
  const ruleFamily=randomUUID(),ruleSet=randomUUID(),prefix=`event-privacy-${randomUUID()}`;
  await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
  await client.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Event privacy fixture',$2,'ACTIVE')",[tenantId,prefix]);
  await client.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')",[tenantId,userId]);
  await client.query(`INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference)
    VALUES($1,$2,'Event privacy connection','WAHA','GOWS','WORKING',$3)`,
    [connectionId,tenantId,`secret://${tenantId}/connections/${connectionId}/session`]);
  await client.query(`INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name)
    VALUES($1,$2,$3,'120363000000995@g.us','Event privacy group')`,[groupId,tenantId,connectionId]);
  await client.query("INSERT INTO rule_families(id,tenant_id,name,created_by) VALUES($1,$2,'Event privacy rules',$3)",[ruleFamily,tenantId,userId]);
  await client.query(`INSERT INTO rule_sets(id,tenant_id,family_id,name,version,state,revision,snapshot_sha256,created_by)
    VALUES($1,$2,$3,'Event privacy rules',1,'DRAFT',1,repeat('0',64),$4)`,[ruleSet,tenantId,ruleFamily,userId]);
  await client.query(`INSERT INTO group_bindings(id,tenant_id,whatsapp_group_id,rule_set_id,zammad_group_id,
    default_priority,assignment_mode,acknowledgement_template,agent_prefix,retention_days,state)
    VALUES($1,$2,$3,$4,'Operations','normal','zammad_auto','Case {{tickets}}','Agent:',30,'PAUSED')`,
    [bindingId,tenantId,groupId,ruleSet]);
  const flow=await createFlow(tenantId,userId,{schemaVersion:1,kind:'TICKET_EVENT',name:prefix,event:'reference_received',
    start:'done',maxSteps:2,nodes:[{id:'done',type:'end'}]});
  const feedback=[];
  for(const [index,ticket] of ['97405','97406','97407'].entries()) {
    const correlation=randomUUID(),execution=randomUUID(),delivery=randomUUID();
    await client.query(`INSERT INTO case_correlations(id,tenant_id,group_binding_id,normalized_reference,
      zammad_ticket_id,zammad_ticket_number,state,original_external_message_id)
      VALUES($1,$2,$3,$4,$5,$5,'OPEN',$6)`,[correlation,tenantId,bindingId,`${prefix}-${index}`,ticket,`${prefix}-original-${index}`]);
    await client.query(`INSERT INTO ticket_event_executions(id,tenant_id,correlation_id,event,source_sha256,
      flow_version_id,mode,state,completed_at) VALUES($1,$2,$3,'reference_received',$4,$5,'CUSTOM','APPLIED',now())`,
      [execution,tenantId,correlation,createHash('sha256').update(ticket).digest('hex'),flow.id]);
    await client.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,group_binding_id,zammad_ticket_id,
      message_body,content_type,idempotency_key,state,delivery_origin,ticket_event_execution_id,external_message_id)
      VALUES($1,$2,$3,$4,$5,'Keep workflow audit','text/plain',$6,'SENT','TICKET',$7,$8)`,
      [delivery,tenantId,connectionId,bindingId,ticket,`${prefix}-delivery-${index}`,execution,`${prefix}-sent-${index}`]);
    await client.query("INSERT INTO delivery_ticket_links(tenant_id,delivery_id,zammad_ticket_id) VALUES($1,$2,$3)",[tenantId,delivery,ticket]);
    feedback.push({ticket,correlation,execution,delivery});
  }
  await client.query(`INSERT INTO privacy_legal_holds(tenant_id,scope_type,scope_value,scope_sha256,reason,created_by)
    VALUES($1,'ZAMMAD_TICKET',$2,$3,'Preserve held event feedback',$4)`,
    [tenantId,feedback[1].ticket,createHash('sha256').update(feedback[1].ticket).digest('hex'),userId]);
  const job={id:randomUUID(),tenantId,leaseId:randomUUID(),jobType:'DELETE',scopeType:'ZAMMAD_TICKET',
    scopeValue:feedback[0].ticket,disposition:'DELETE_TICKETS',state:'RUNNING',stage:'LOCAL',
    attempts:1,maxAttempts:25,fencingToken:1,unmatchedDiagnosticHours:24,exportTtlHours:24,
    zammadBaseUrl:'https://privacy.invalid',zammadPrivacySecretReference:`secret://tenants/${tenantId}/zammad/privacy`,
    createdAt:new Date().toISOString()};
  await client.query(`INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,
    state,stage,attempts,lease_id,lease_expires_at,fencing_token)
    VALUES($1,$2,'DELETE','ZAMMAD_TICKET',$3,'DELETE_TICKETS',$4,'RUNNING','DISCOVER',1,$5,now()+interval '10 minutes',1)`,
    [job.id,tenantId,job.scopeValue,`${prefix}-delete`,job.leaseId]);
  for(const [type,id,state] of [
    ['ZAMMAD_TICKET',feedback[0].ticket,'EXTERNAL_COMPLETE'],
    ...feedback.map(item=>['DELIVERY',item.delivery,'PENDING']),
  ]) await client.query(`INSERT INTO privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256,state)
    VALUES($1,$2,$3,$4,$5,$6)`,[tenantId,job.id,type,id,createHash('sha256').update(id).digest('hex'),state]);
  await client.query("UPDATE privacy_jobs SET stage='LOCAL' WHERE id=$1",[job.id]);
  const repository=new PrivacyRepository({});
  repository.tenant=(scope,work)=>role(scope,'wasalx_connector_worker',work);
  const result=await repository.finalize(job,job.leaseId);
  assert.equal(result.deliveryBodies,1,'only the unheld targeted ticket body is removed');
  const deleted=feedback[0];
  assert.equal((await client.query("SELECT id FROM case_correlations WHERE id=$1",[deleted.correlation])).rowCount,0);
  assert.equal((await client.query("SELECT id FROM ticket_event_executions WHERE id=$1",[deleted.execution])).rowCount,0);
  assert.deepEqual((await client.query(`SELECT state,message_body,ticket_event_execution_id,zammad_ticket_id,
    content_redacted_at IS NOT NULL AS redacted FROM delivery_outbox WHERE id=$1`,[deleted.delivery])).rows,
    [{state:'SENT',message_body:'',ticket_event_execution_id:null,zammad_ticket_id:null,redacted:true}],
    'delivery audit survives while receipt/case are removed in FK-safe order');
  for(const protectedItem of feedback.slice(1)) {
    assert.equal((await client.query("SELECT id FROM case_correlations WHERE id=$1",[protectedItem.correlation])).rowCount,1);
    assert.deepEqual((await client.query(`SELECT message_body,ticket_event_execution_id,content_redacted_at
      FROM delivery_outbox WHERE id=$1`,[protectedItem.delivery])).rows,
      [{message_body:'Keep workflow audit',ticket_event_execution_id:protectedItem.execution,content_redacted_at:null}],
      'held and non-target feedback are retained unchanged');
  }
  assert.equal((await client.query("SELECT state FROM privacy_jobs WHERE id=$1",[job.id])).rows[0].state,'SUCCEEDED');
}

async function verifyTicketEventFeedbackAdmission(client,tenantId,userId,bindingId,connectionId,role,createFlow) {
  const correlation=randomUUID(),ticketId='97408',prefix=`event-batch-${randomUUID()}`;
  await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
  await client.query(`INSERT INTO case_correlations(id,tenant_id,group_binding_id,normalized_reference,
    zammad_ticket_id,zammad_ticket_number,state) VALUES($1,$2,$3,$4,$5,$5,'OPEN')`,
    [correlation,tenantId,bindingId,prefix,ticketId]);
  for(const count of [1,2,11,12]) {
    const flow=await createFlow(tenantId,userId,{schemaVersion:1,kind:'TICKET_EVENT',name:prefix,event:'reference_received',
      start:'send0',maxSteps:32,nodes:[
        ...Array.from({length:count},(_,index)=>({id:`send${index}`,type:'send_text',text:'Feedback',quote:'NONE',
          next:index+1===count?'done':`send${index+1}`})),{id:'done',type:'end'},
      ]});
    const sourceSha256=createHash('sha256').update(`${prefix}-${count}`).digest('hex');
    const enqueue=()=>role(tenantId,'wasalx_connector_worker',async c=>{
      const receipt=await pinTicketEventExecution(c,{tenantId,correlationId:correlation,event:'reference_received',
        sourceSha256,selection:{mode:'CUSTOM',flowVersionId:flow.id}});
      return {receipt,result:await enqueueTicketEventFeedback(c,{receipt,connectionId,groupBindingId:bindingId,ticketId,
        provider:'WAHA',reactions:true,variables:{'event.kind':'reference_received','provider.kind':'WAHA'},quotes:{}})};
    });
    if(count===12) {
      const before=(await client.query("SELECT count(*)::integer AS count FROM delivery_outbox WHERE tenant_id=$1 AND zammad_ticket_id=$2",[tenantId,ticketId])).rows[0].count;
      await assert.rejects(enqueue,/11-message limit/);
      assert.equal((await client.query("SELECT count(*)::integer AS count FROM delivery_outbox WHERE tenant_id=$1 AND zammad_ticket_id=$2",[tenantId,ticketId])).rows[0].count,before,
        'over-limit plan writes no outbox deliveries');
      continue;
    }
    const first=await enqueue();
    assert.equal(first.result.queued,count);assert.equal(first.receipt.state,'APPLIED');
    const rows=(await client.query(`SELECT batch_id,batch_sequence,batch_part_count,
      available_at='infinity'::timestamptz AS waiting
      FROM delivery_outbox WHERE tenant_id=$1 AND ticket_event_execution_id=$2 ORDER BY batch_sequence`,
      [tenantId,first.receipt.id])).rows;
    assert.equal(rows.length,count);
    assert.equal(new Set(rows.map(row=>row.batch_id)).size,1);
    for(const [index,row] of rows.entries()) {
      assert.equal(row.batch_sequence,index);assert.equal(row.batch_part_count,count);assert.equal(row.waiting,index>0);
      if(count===1)assert.equal(row.batch_id,null,'one message is not an outbox batch');
      else assert.match(row.batch_id,/^[0-9a-f-]{36}$/);
    }
    const replay=await enqueue();assert.equal(replay.result.replay,true);assert.equal(replay.result.queued,0);
    assert.equal((await client.query("SELECT count(*)::integer AS count FROM delivery_outbox WHERE ticket_event_execution_id=$1",[first.receipt.id])).rows[0].count,count);
  }
}

// Existing isolated gate/transaction only: real SQL/RLS/claims, no HTTP/provider.
async function verifyAllReferenceCloseFeedback(client,tenantId,foreignTenantId,userId,role,createFlow) {
  const connectionId=randomUUID(),groupId=randomUUID(),bindingId=randomUUID(),correlation=randomUUID();
  const ruleFamily=randomUUID();let ruleSet,ruleId,commandRuleId;
  const group='120363000000994@g.us',ticketId='97409',prefix=`reference-close-${randomUUID()}`;
  const clock="date_trunc('milliseconds',now())+interval '456 microseconds'";
  await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
  await client.query(`INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference)
    VALUES($1,$2,'All reference close','WAHA','GOWS','WORKING',$3)`,
    [connectionId,tenantId,`secret://${tenantId}/connections/${connectionId}/session`]);
  await client.query(`INSERT INTO provider_sessions(tenant_id,connection_id,opaque_session_id,state,session_storage_reference)
    VALUES($1,$2,$3,'WORKING',$4)`,[tenantId,connectionId,prefix,`storage://${prefix}`]);
  await client.query(`INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name)
    VALUES($1,$2,$3,$4,'All reference close')`,[groupId,tenantId,connectionId,group]);
  await client.query("INSERT INTO rule_families(id,tenant_id,name,created_by) VALUES($1,$2,$3,$4)",[ruleFamily,tenantId,prefix,userId]);
  const rules=[
    {name:'Reference',matcherType:'starts_with',pattern:'DLX',matcherOptions:{},priority:1,enabled:true,savedExamples:[]},
    {name:'Command',matcherType:'starts_with',pattern:'/close',matcherOptions:{groupCommand:{command:'/close'}},priority:2,enabled:true,savedExamples:[]},
  ];
  const snapshot=(await role(tenantId,'wasalx_app',c=>c.query(
    'SELECT * FROM app.create_rule_set_snapshot($1,$2,1,NULL,NULL,$3,$4::jsonb)',[ruleFamily,prefix,userId,JSON.stringify(rules)]))).rows[0];
  ruleSet=snapshot.id;assert.match(snapshot.snapshot_sha256,/^[a-f0-9]{64}$/);assert.notEqual(snapshot.snapshot_sha256,'0'.repeat(64));
  const storedRules=(await client.query('SELECT id,name FROM trigger_rules WHERE tenant_id=$1 AND rule_set_id=$2 ORDER BY priority',[tenantId,ruleSet])).rows;
  assert.equal(storedRules.length,2);ruleId=storedRules.find(row=>row.name==='Reference').id;commandRuleId=storedRules.find(row=>row.name==='Command').id;
  await client.query(`UPDATE rule_sets SET state='ACTIVE',activated_at=now(),activated_by=$2,revision=revision+1 WHERE id=$1`,[ruleSet,userId]);
  await client.query(`INSERT INTO group_bindings(id,tenant_id,whatsapp_group_id,rule_set_id,zammad_group_id,
    default_priority,assignment_mode,acknowledgement_template,agent_prefix,retention_days,state)
    VALUES($1,$2,$3,$4,'Operations','normal','zammad_auto','Case {{tickets}}','Agent:',30,'ACTIVE')`,
    [bindingId,tenantId,groupId,ruleSet]);
  await client.query(`INSERT INTO case_correlations(id,tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,
    zammad_ticket_number,state,generation,zammad_state_observed_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$5,'RESOLVED',1,${clock},${clock},${clock})`,[correlation,tenantId,bindingId,prefix,ticketId]);
  const flow=await createFlow(tenantId,userId,{schemaVersion:1,kind:'TICKET_EVENT',name:prefix,event:'ticket_closed',start:'react',maxSteps:4,nodes:[
    {id:'react',type:'reaction',emoji:'✅',quote:'REFERENCE_MESSAGES',next:'send'},
    {id:'send',type:'send_text',text:'Closed {{case.number}}',quote:'ORIGINAL',next:'done'},
    {id:'done',type:'end'},
  ]});
  let messageSequence=0;
  const add=async(name,{match=1,command=false,generation=correlation,destination=group,ticket=ticketId,age='0 seconds',mode='LEGACY',metadata={}}={})=>{
    const id=randomUUID(),external=`${prefix}-${name}`;
    await client.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,
      payload_sha256,status,governing_rule_set_id) VALUES($1,$2,$3,'WAHA',$4,'message','{}',repeat('0',64),'PROCESSED',$5)`,
      [id,tenantId,connectionId,external,ruleSet]);
    await client.query(`INSERT INTO normalized_messages(id,tenant_id,event_inbox_id,connection_id,external_message_id,
      external_group_id,external_participant_id,message_text,provider_timestamp,provider_metadata,processing_status)
      VALUES($1,$2,$1,$3,$4,$5,'12025550156@c.us','Synthetic reference',now()-interval '1 hour'+$7::integer*interval '1 millisecond',$6,'COMPLETE')`,
      [id,tenantId,connectionId,external,destination,metadata,++messageSequence]);
    await client.query(`INSERT INTO message_links(tenant_id,connection_id,external_message_id,zammad_ticket_id,direction)
      VALUES($1,$2,$3,$4,'INBOUND')`,[tenantId,connectionId,external,ticket]);
    for(const [rule,count] of [[ruleId,match],[commandRuleId,command?1:0]])await client.query(`INSERT INTO rule_match_observations
      (tenant_id,event_inbox_id,group_binding_id,rule_set_id,trigger_rule_id,matched_reference_count,evaluated_at)
      VALUES($1,$2,$3,$4,$5,$6,now())`,[tenantId,id,bindingId,ruleSet,rule,count]);
    await client.query(`INSERT INTO ticket_event_executions(tenant_id,correlation_id,event,source_sha256,mode,state,completed_at,created_at)
      VALUES($1,$2,'reference_received',$3,$5,'SKIPPED',${clock}+$4::interval,${clock}+$4::interval)`,
      [tenantId,generation,ticketEventSourceHash('INBOUND',connectionId,external),age,mode]);
    return{id,external};
  };
  const otherCorrelation=randomUUID();
  await client.query(`INSERT INTO case_correlations(id,tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,
    zammad_ticket_number,state,generation) VALUES($1,$2,$3,$4,$5,$5,'RESOLVED',2)`,
    [otherCorrelation,tenantId,bindingId,prefix+'-other-generation',ticketId]);
  const first=await add('first',{age:'-1 microsecond'}),second=await add('repeat');
  await add('plain-followup',{match:0});await add('command',{command:true});
  await add('other-generation',{generation:otherCorrelation});await add('wrong-group',{destination:'120363000000993@g.us'});
  await add('wrong-ticket',{ticket:'97499'});await add('post-close',{age:'1 microsecond'});
  const revoked=await add('revoked',{metadata:{mutations:[{kind:'REVOKED'}]}});
  const hidden=await add('private'),privacyId=randomUUID();
  await client.query(`INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,unmatched_diagnostic_hours_snapshot)
    VALUES($1,$2,'RETENTION_SWEEP','TENANT',$2::uuid::text,'RETENTION_DELETE',$3,24)`,[privacyId,tenantId,prefix+'-privacy']);
  await client.query(`INSERT INTO privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256)
    VALUES($1,$2,'NORMALIZED_MESSAGE',$3,$4)`,[tenantId,privacyId,hidden.id,createHash('sha256').update(hidden.id).digest('hex')]);
  const closeSource=createHash('sha256').update(prefix+'-close').digest('hex');
  // Explicit fractional tie: these immutable receipts must not cross a JSDate boundary.
  await client.query(`INSERT INTO ticket_event_executions(tenant_id,correlation_id,event,source_sha256,mode,flow_version_id,created_at)
    VALUES($1,$2,'ticket_closed',$3,'CUSTOM',$4,${clock})`,[tenantId,correlation,closeSource,flow.id]);
  const close=await role(tenantId,'wasalx_app',c=>pinTicketEventExecution(c,{tenantId,correlationId:correlation,event:'ticket_closed',
    sourceSha256:closeSource,selection:{mode:'CUSTOM',flowVersionId:flow.id}}));
  assert.equal((await client.query(`SELECT extract(microseconds FROM created_at)::integer%1000 AS tail
    FROM ticket_event_executions WHERE tenant_id=$1 AND id=$2`,[tenantId,close.id])).rows[0].tail,456);
  const input={tenantId,correlationId:correlation,executionId:close.id,connectionId,groupId:group,ticketId};
  const resolve=(scope=tenantId,overrides={})=>role(scope,'wasalx_app',c=>resolveTicketReferenceMessages(c,{...input,...overrides}));
  assert.deepEqual(await resolve(),[first.external,second.external],
    'same-generation original/repeat only; plain/command/foreign/privacy/revoke/post-close excluded');
  assert.deepEqual(await role(tenantId,'wasalx_connector_worker',c=>resolveTicketReferenceMessages(c,input)),[first.external,second.external]);
  for(const overrides of [{tenantId:foreignTenantId},{connectionId:randomUUID()},{ticketId:'97499'},{groupId:'120363000000993@g.us'}])
    await assert.rejects(()=>resolve(tenantId,overrides),/unavailable/,'scope cannot substitute another target');
  await assert.rejects(()=>resolve(foreignTenantId),/unavailable/,'RLS hides the other tenant close receipt');
  const accepted=[first,second];for(let i=0;i<11;i++)accepted.push(await add('fanout-'+i,{mode:i===0?'OFF':'LEGACY'}));
  // Historical governing rule is retained even after current binding changes.
  const alternate=(await client.query("SELECT rule_set_id FROM group_bindings WHERE tenant_id=$1 AND id<>$2 ORDER BY id LIMIT 1",[tenantId,bindingId])).rows[0].rule_set_id;
  await client.query(`UPDATE rule_sets SET state='RETIRED',retired_at=now(),retired_by=$2,revision=revision+1 WHERE id=$1`,[ruleSet,userId]);
  await client.query('UPDATE group_bindings SET rule_set_id=$2,revision=revision+1 WHERE id=$1',[bindingId,alternate]);
  assert.deepEqual(await resolve(),accepted.map(item=>item.external),'retired pinned rules count; current rules are not reevaluated');
  const enqueue=()=>role(tenantId,'wasalx_app',c=>enqueueTicketEventFeedback(c,{receipt:close,connectionId,groupBindingId:bindingId,ticketId,
    provider:'WAHA',reactions:true,variables:{'event.kind':'ticket_closed','provider.kind':'WAHA','case.number':ticketId},
    quotes:{original:{messageId:first.external,authorized:true}}}));
  assert.equal((await enqueue()).queued,14,'thirteen reactions including legacy/off plus exactly one closure text');
  const rows=(await client.query(`SELECT id,reply_to_message_id,content_type,idempotency_key,batch_id,batch_sequence,batch_part_count,
    available_at='infinity'::timestamptz AS waiting FROM delivery_outbox WHERE tenant_id=$1 AND ticket_event_execution_id=$2
    ORDER BY batch_id,batch_sequence`,[tenantId,close.id])).rows;
  assert.equal(rows.length,14);assert.equal(new Set(rows.map(row=>row.idempotency_key)).size,14);
  assert.deepEqual(rows.filter(row=>row.content_type==='application/vnd.wasalx.whatsapp-reaction').map(row=>row.reply_to_message_id),accepted.map(item=>item.external));
  assert.equal(rows.filter(row=>row.content_type==='text/plain').length,1);
  const batches=Map.groupBy(rows,row=>row.batch_id);assert.deepEqual([...batches.values()].map(batch=>batch.length),[11,3]);
  for(const batch of batches.values())for(const [index,row] of batch.entries()){
    assert.equal(row.batch_sequence,index);assert.equal(row.batch_part_count,batch.length);assert.equal(row.waiting,index>0);
  }
  assert.deepEqual(await enqueue(),{handled:true,queued:0,replay:true});
  assert.equal((await client.query('SELECT count(*)::int AS count FROM delivery_outbox WHERE ticket_event_execution_id=$1',[close.id])).rows[0].count,14);
  // Actual claim ordering across chunks; no native provider is invoked.
  await client.query('SAVEPOINT reference_unknown');
  const firstClaim=(await role(tenantId,'wasalx_app',c=>c.query('SELECT id FROM app.claim_delivery_jobs($1,100)',[randomUUID()]))).rows.filter(row=>rows.some(item=>item.id===row.id));
  assert.deepEqual(firstClaim,[{id:rows[0].id}]);
  await client.query("UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN',lease_id=NULL,lease_expires_at=NULL,manual_retry_allowed=false WHERE id=$1",[rows[0].id]);
  const held=(await role(tenantId,'wasalx_app',c=>c.query('SELECT id FROM app.claim_delivery_jobs($1,100)',[randomUUID()]))).rows.filter(row=>rows.some(item=>item.id===row.id));
  assert.deepEqual(held,[],'UNKNOWN holds later chunks and same-batch successors');
  assert.equal((await enqueue()).queued,0,'duplicate close never replays UNKNOWN');
  await client.query('ROLLBACK TO SAVEPOINT reference_unknown');await client.query('RELEASE SAVEPOINT reference_unknown');
  const repository=new OutboxRepository({});repository.tenant=(scope,work)=>role(scope,'wasalx_connector_worker',work);
  for(const change of ["state='OPEN',updated_at=now()+interval '1 second'","updated_at=now()+interval '1 second'"]){
    await client.query('SAVEPOINT reference_stale');
    const leaseId=randomUUID();
    const claimed=(await role(tenantId,'wasalx_app',c=>c.query('SELECT id,attempts FROM app.claim_delivery_jobs($1,100)',[leaseId]))).rows.find(row=>row.id===rows[0].id);
    assert(claimed,'exact fresh closure head claimed');
    await client.query(`UPDATE case_correlations SET ${change} WHERE id=$1`,[correlation]);
    assert.equal(await repository.beginSend({id:claimed.id,tenantId,connectionId,ticketId,attempts:claimed.attempts,provider:'waha'},leaseId),false);
    assert.deepEqual((await client.query('SELECT state,manual_retry_allowed,external_message_id FROM delivery_outbox WHERE id=$1',[claimed.id])).rows,
      [{state:'FAILED_TERMINAL',manual_retry_allowed:false,external_message_id:null}]);
    await client.query('ROLLBACK TO SAVEPOINT reference_stale');await client.query('RELEASE SAVEPOINT reference_stale');
  }
  await client.query('SAVEPOINT reference_history_bound');
  await client.query(`INSERT INTO ticket_event_executions(tenant_id,correlation_id,event,source_sha256,mode,state,completed_at,created_at)
    SELECT $1,$2,'reference_received',encode(sha256(convert_to($3||series.i::text,'UTF8')),'hex'),'LEGACY','SKIPPED',${clock},${clock}
    FROM generate_series(1,1001) AS series(i)`,[tenantId,correlation,prefix+'-history-bound-']);
  await assert.rejects(()=>resolve(),/safe processing bound/);
  assert.equal((await client.query('SELECT count(*)::int AS count FROM delivery_outbox WHERE ticket_event_execution_id=$1',[close.id])).rows[0].count,14);
  await client.query('ROLLBACK TO SAVEPOINT reference_history_bound');await client.query('RELEASE SAVEPOINT reference_history_bound');
  assert.equal((await client.query('SELECT count(*)::int AS count FROM normalized_messages WHERE id=ANY($1::uuid[])',[[revoked.id,hidden.id]])).rows[0].count,2,
    'ineligible historical messages preserved, not deleted');
  console.log('PASS all-reference closure targets/RLS/retired-history/14effects/order/UNKNOWN/stale/bound (isolated rollback; no provider)');
}


// Actual quoted-command SQL/RLS/finalizer; native receipts are controlled values.
async function verifyDeniedQuotedCommandTranscript(client,tenantId,userId,fixture,role,createFlow) {
  const {connectionId,groupId,bindingId,group,incoming,privacy}=fixture;
  const ticketId='97410',prefix=`denied-command-${randomUUID()}`;
  await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
  await client.query("UPDATE group_bindings SET state='ACTIVE' WHERE id=$1",[bindingId]);
  const correlation=(await client.query(`INSERT INTO case_correlations(tenant_id,group_binding_id,normalized_reference,
    zammad_ticket_id,zammad_ticket_number,state) VALUES($1,$2,$3,$4,$4,'OPEN') RETURNING id,version,generation,state`,
    [tenantId,bindingId,prefix,ticketId])).rows[0];
  const flow=await createFlow(tenantId,userId,{schemaVersion:1,kind:'TICKET_EVENT',name:prefix,event:'quoted_command',command:'/close',
    permission:{mode:'AGENTS'},start:'close',maxSteps:2,nodes:[{id:'close',type:'close_ticket',next:'done'},{id:'done',type:'end'}]});
  const service=new BotFlowsService({withTenant:(scope,work)=>role(scope,'wasalx_app',work)}, {}, {});
  await service.bindTicketEvent({tenantId,userId,role:'tenant_owner'},`${prefix}-bind`,prefix,
    {event:'quoted_command',groupId,mode:'CUSTOM',flowVersionId:flow.id,expectedRevision:0});
  const repository=new InboundRepository({});repository.tenant=(scope,work)=>role(scope,'wasalx_connector_worker',work);
  const quote=await incoming(`${prefix}-quote`,'1 minute',{ticket:ticketId,article:'974100'});
  const inputFor=async name=>{
    const message=await incoming(`${prefix}-${name}`,'0 seconds',{ticket:ticketId});
    // incoming() seeds quote-target links; a received command has no link until
    // the actual prepare method admits its immutable transcript target.
    await client.query('DELETE FROM message_links WHERE tenant_id=$1 AND connection_id=$2 AND external_message_id=$3 AND zammad_ticket_id=$4',
      [tenantId,connectionId,message.external,ticketId]);
    await client.query(`UPDATE normalized_messages SET external_participant_id='000000000000@lid',message_text='/close',
      quoted_external_message_id=$2 WHERE id=$1`,[message.id,quote.external]);
    return {tenantId,connectionId,inboxId:message.id,bindingId,groupId:group,participantId:'000000000000@lid',
      messageId:message.external,quotedMessageId:quote.external,text:'/close',fromMe:false,fromApi:false,hasMedia:false,provider:'WAHA'};
  };
  const native={updatedAt:'2026-10-07T00:00:00.000000Z',stateId:'2',lastArticleId:'974100',nativeGroupId:'2',
    connectionId,externalGroupId:group,activeAgent:false,deniedTranscript:'v1'};
  const prepare=async input=>{
    const candidate=await repository.quotedCommandCandidate(input);assert(candidate);
    return repository.prepareQuotedCommand(input,candidate,native);
  };
  const status=async id=>(await client.query('SELECT state,native_action_state,native_action_snapshot FROM ticket_event_executions WHERE id=$1',[id])).rows[0];
  const before=await client.query('SELECT state,version,generation FROM case_correlations WHERE id=$1',[correlation.id]);
  const input=await inputFor('recorded'),prepared=await prepare(input),id=prepared.receipt.id;
  assert.equal(prepared.state,'PREPARED');assert.equal(prepared.snapshot.command_authorized,false);
  assert.equal(prepared.snapshot.command_actor.sourceAuthorized,false);assert.deepEqual(prepared.plan.effects,[]);
  const pinned=JSON.parse(JSON.stringify(prepared.snapshot));
  const candidate=await repository.quotedCommandCandidate(input);
  await assert.rejects(()=>repository.prepareQuotedCommand(input,candidate,{...native,deniedTranscript:undefined}),/capability/);
  assert.deepEqual((await status(id)).native_action_snapshot,pinned);
  assert.equal(await repository.claimQuotedCommand(input,id),true);
  const admission={tenantId,instanceId:pinned.instance_id,executionId:id};
  for(const deniedTranscript of [undefined,'v2'])await assert.rejects(()=>role(tenantId,'wasalx_app',c=>ticketCommandAdmission(c,{...admission,deniedTranscript})),/capability/);
  const admitted=await role(tenantId,'wasalx_app',c=>ticketCommandAdmission(c,{...admission,deniedTranscript:'v1'}));
  assert.equal(admitted.effects_clear,true);assert.equal(admitted.disposition,'TRANSCRIPT_ONLY_DENIED');
  // Revoke the pinned target after claim: source admission must revalidate it.
  await client.query('SAVEPOINT denied_target_revoked');
  await client.query(`UPDATE normalized_messages SET provider_metadata='{"mutations":[{"kind":"REVOKED"}]}' WHERE id=$1`,[quote.id]);
  await assert.rejects(()=>role(tenantId,'wasalx_app',c=>ticketCommandAdmission(c,{...admission,deniedTranscript:'v1'})),/quote|target/i);
  await client.query('ROLLBACK TO SAVEPOINT denied_target_revoked');await client.query('RELEASE SAVEPOINT denied_target_revoked');
  // A second eligible current case on this ticket makes admission ambiguous.
  await client.query('SAVEPOINT denied_second_case');
  await client.query(`INSERT INTO case_correlations(tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,zammad_ticket_number,state)
    VALUES($1,$2,$3,$4,$4,'OPEN')`,[tenantId,bindingId,`${prefix}-other`,ticketId]);
  await assert.rejects(()=>role(tenantId,'wasalx_app',c=>ticketCommandAdmission(c,{...admission,deniedTranscript:'v1'})),/case|target|quote/i);
  await client.query('ROLLBACK TO SAVEPOINT denied_second_case');await client.query('RELEASE SAVEPOINT denied_second_case');
  await client.query('SAVEPOINT denied_successor');
  await client.query(`INSERT INTO case_correlations(tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,zammad_ticket_number,
    state,generation,detached_at,predecessor_correlation_id) VALUES($1,$2,$3,'97411','97411','DETACHED',2,now(),$4)`,
    [tenantId,bindingId,prefix,correlation.id]);
  await assert.rejects(()=>role(tenantId,'wasalx_app',c=>ticketCommandAdmission(c,{...admission,deniedTranscript:'v1'})),/case|target|quote/i);
  await client.query('ROLLBACK TO SAVEPOINT denied_successor');await client.query('RELEASE SAVEPOINT denied_successor');
  const receipt={state:'SUCCEEDED',execution_id:id,ticket_id:ticketId,article_id:'974101',request_sha256:pinned.request_sha256,
    disposition:'TRANSCRIPT_ONLY_DENIED',outcome:'REJECTED',recorded_at:'2026-10-07T00:00:01.000000Z'};
  await repository.recordQuotedCommandNative(tenantId,id,'SUCCEEDED',receipt);
  await repository.linkQuotedCommandReceipt(input,id);
  await assert.rejects(()=>role(tenantId,'wasalx_connector_worker',c=>c.query("UPDATE ticket_event_executions SET state='SKIPPED',completed_at=now() WHERE id=$1",[id])),e=>e.code==='55000');
  assert.equal(await repository.finishQuotedCommand(input,prepared),0);
  assert.equal((await status(id)).state,'APPLIED');assert.equal((await status(id)).native_action_state,'SUCCEEDED');
  assert.equal(await repository.finishQuotedCommand(input,prepared),0);await repository.linkQuotedCommandReceipt(input,id);
  assert.equal((await client.query('SELECT count(*)::integer AS n FROM ticket_event_executions WHERE tenant_id=$1 AND source_sha256=$2',
    [tenantId,ticketEventSourceHash('INBOUND',connectionId,input.messageId)])).rows[0].n,1);
  assert.deepEqual((await client.query('SELECT zammad_article_id,quoted_external_message_id FROM message_links WHERE connection_id=$1 AND external_message_id=$2 AND zammad_ticket_id=$3',
    [connectionId,input.messageId,ticketId])).rows,[{zammad_article_id:'974101',quoted_external_message_id:quote.external}]);
  assert.equal((await client.query('SELECT count(*)::integer AS n FROM delivery_outbox WHERE ticket_event_execution_id=$1',[id])).rows[0].n,0);
  assert.deepEqual((await client.query('SELECT state,version,generation FROM case_correlations WHERE id=$1',[correlation.id])).rows,before.rows);
  // Rebinding to a permissive definition cannot upgrade the accepted denial.
  const permissive=await createFlow(tenantId,userId,{schemaVersion:1,kind:'TICKET_EVENT',name:`${prefix}-anyone`,event:'quoted_command',command:'/close',
    permission:{mode:'ANYONE'},start:'close',maxSteps:2,nodes:[{id:'close',type:'close_ticket',next:'done'},{id:'done',type:'end'}]});
  await service.bindTicketEvent({tenantId,userId,role:'tenant_owner'},`${prefix}-rebind`,prefix,
    {event:'quoted_command',groupId,mode:'CUSTOM',flowVersionId:permissive.id,expectedRevision:1});
  assert.deepEqual((await prepare(input)).snapshot,pinned);
  // Back to AGENTS for a fresh denial; old pinned snapshots remain untouched.
  await service.bindTicketEvent({tenantId,userId,role:'tenant_owner'},`${prefix}-restore`,prefix,
    {event:'quoted_command',groupId,mode:'CUSTOM',flowVersionId:flow.id,expectedRevision:2});
  const unknownInput=await inputFor('unknown'),unknown=await prepare(unknownInput),unknownId=unknown.receipt.id;
  assert.equal(await repository.claimQuotedCommand(unknownInput,unknownId),true);
  await repository.recordQuotedCommandNative(tenantId,unknownId,'OUTCOME_UNKNOWN');
  await assert.rejects(()=>role(tenantId,'wasalx_connector_worker',c=>assertTicketCommandBarrier(c,{tenantId,ticketId})),/QUOTED_COMMAND_EFFECT_HOLD/);
  await assert.rejects(()=>repository.finishQuotedCommand(unknownInput,unknown),/not proven/);
  const unknownAdmission={tenantId,instanceId:unknown.snapshot.instance_id,executionId:unknownId};
  await assert.rejects(()=>role(tenantId,'wasalx_app',c=>ticketCommandAdmission(c,unknownAdmission)),/capability/);
  assert.equal((await role(tenantId,'wasalx_app',c=>ticketCommandAdmission(c,{...unknownAdmission,deniedTranscript:'v1'}))).effects_clear,false);
  await client.query('SAVEPOINT denied_unknown_historical');
  await privacy('NORMALIZED_MESSAGE',unknownInput.inboxId);
  assert.equal((await role(tenantId,'wasalx_app',c=>ticketCommandAdmission(c,{...unknownAdmission,deniedTranscript:'v1'}))).effects_clear,false,
    'UNKNOWN receipt lookup retains original identity rather than reauthorizing or permitting another action');
  await client.query('ROLLBACK TO SAVEPOINT denied_unknown_historical');await client.query('RELEASE SAVEPOINT denied_unknown_historical');
  assert.equal(await repository.claimQuotedCommand(unknownInput,unknownId),false,'UNKNOWN cannot obtain another native POST claim');
  await repository.recordQuotedCommandNative(tenantId,unknownId,'SUCCEEDED',{...receipt,execution_id:unknownId,article_id:'974102',request_sha256:unknown.snapshot.request_sha256});
  await repository.linkQuotedCommandReceipt(unknownInput,unknownId);assert.equal(await repository.finishQuotedCommand(unknownInput,unknown),0);
  assert.equal((await status(unknownId)).state,'APPLIED');
  await role(tenantId,'wasalx_connector_worker',c=>assertTicketCommandBarrier(c,{tenantId,ticketId}));
  assert.deepEqual((await client.query('SELECT state,version,generation FROM case_correlations WHERE id=$1',[correlation.id])).rows,before.rows);
  // Source privacy invalidates a fresh PREPARED claim; no action admission.
  const privateInput=await inputFor('private'),privatePrepared=await prepare(privateInput);
  await privacy('NORMALIZED_MESSAGE',privateInput.inboxId);
  await assert.rejects(()=>repository.claimQuotedCommand(privateInput,privatePrepared.receipt.id),/source/);
  assert.equal((await status(privatePrepared.receipt.id)).native_action_state,'PREPARED');
  assert.equal((await client.query('SELECT count(*)::integer AS n FROM delivery_outbox WHERE ticket_event_execution_id=ANY($1::uuid[])',
    [[id,unknownId,privatePrepared.receipt.id]])).rows[0].n,0);
}
