import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {botChoicePosition,type BotFlowDefinition} from '../../../packages/core/src/bot-flow.js';
import {BOT_CUSTOMER_CONFIRMATION_TTL_SECONDS,assertDirectEffectsClear,directHumanPauseExpired,directKeepOpenTextControl} from '../../../packages/core/src/direct-keep-open.js';
import type {DirectProviderMessage} from '../../../packages/connectors/src/types.js';

export type CustomerControlSnapshot={phase:'REQUEST'|'CONFIRM';requestEventId:string;promptDeliveryId:string;
  epoch:number;createdAt:string;expiresAt:string|null;confirmationFencingToken?:number;humanPauseStartedAt?:string|null;
  options:Array<{id:string;label:string;kind:'MAIN_MENU'|'RESOLUTION_REQUEST'|'CONFIRM_RESOLUTION'|'KEEP_OPEN'}>};
type Conversation={id:string;state:string;current_node_id:string;human_ownership_epoch:number|string;
  human_pause_started_at:string|Date|null;customer_control:CustomerControlSnapshot|null;zammad_customer_id:number|string|null;
  zammad_ticket_id:string;fencing_token:number|string;last_activity_at:string|Date};
type Input={tenantId:string;connectionId:string;eventId:string;chatId:string;flow:BotFlowDefinition;
  conversation:Conversation;message:DirectProviderMessage;customerId:number;assignmentActive:boolean};
export type InspectedControl={kind:'MAIN_MENU'|'RESOLUTION_REQUEST'|'CONFIRM_RESOLUTION'|'KEEP_OPEN'|'EXPIRED'|'INITIAL_WELCOME'|'WELCOME_RESEND';snapshot:CustomerControlSnapshot|null};

export async function inspectDirectKeepOpenInput(client:PoolClient,input:Input):Promise<InspectedControl|null>{
  const {conversation:c,message,flow}=input,policy=flow.keepOpenPolicy;
  if(!policy||!input.assignmentActive||!['BOT','HUMAN'].includes(c.state)||message.fromMe||
    Number(c.zammad_customer_id)!==input.customerId||message.input.type==='reaction'||message.input.type==='unsupported')return null;
  const received=new Date(message.timestamp).getTime();
  if(!Number.isFinite(received)||Math.floor(received/1000)<Math.floor(new Date(c.last_activity_at).getTime()/1000))return null;
  const text=message.input.type==='text'?directKeepOpenTextControl(message.input.text,policy):null;
  let kind:InspectedControl['kind']|null=text;
  const snapshot=c.customer_control;
  if(!kind&&snapshot&&snapshot.epoch===Number(c.human_ownership_epoch)&&
    (snapshot.phase!=='CONFIRM'||(snapshot.confirmationFencingToken===Number(c.fencing_token)&&
      snapshot.humanPauseStartedAt===(c.human_pause_started_at?new Date(c.human_pause_started_at).toISOString():null)))&&
    (snapshot.expiresAt===null||received<=Date.parse(snapshot.expiresAt))&&received>=Date.parse(snapshot.createdAt)){
    const prompt=(await client.query<{external_message_id:string|null;state:string;content_redacted_at:string|null;bot_content:Record<string,unknown>}>(
      `SELECT external_message_id,state,content_redacted_at,bot_content FROM delivery_outbox WHERE tenant_id=$1 AND id=$2
        AND connection_id=$3 AND bot_conversation_id=$4 AND external_chat_id=$5 AND direct_origin='BOT'`,
      [input.tenantId,snapshot.promptDeliveryId,input.connectionId,c.id,input.chatId])).rows[0];
    if(prompt&&['SENT','DELIVERED','READ'].includes(prompt.state)&&prompt.external_message_id&&!prompt.content_redacted_at&&
      prompt.bot_content?.controlId===snapshot.promptDeliveryId){
      if(message.input.type==='choice'&&message.input.source==='META_NATIVE'&&message.quotedMessageId===prompt.external_message_id)
        { const choice=message.input; kind=snapshot.options.find(o=>o.id===choice.choiceId&&o.label===choice.label)?.kind??null; }
      if(message.input.type==='text'){
        const selected=message.input.text.normalize('NFC').trim();
        // Numbered-text fallback is bound to this current prompt/epoch/TTL and
        // fresh own customer. An ordinary unbound yes/confirmation phrase is inert.
        const position=botChoicePosition(selected);kind=snapshot.options[position]?.kind??snapshot.options.find(o=>selected===o.label)?.kind??null;
      }
    }
  }
  if(kind==='MAIN_MENU'&&!policy.mainMenu)kind=null;
  if((kind==='RESOLUTION_REQUEST'||kind==='CONFIRM_RESOLUTION')&&!policy.customerResolution)kind=null;
  if(!kind&&c.state==='HUMAN'&&['text','location'].includes(message.input.type)&&directHumanPauseExpired(policy,c.human_pause_started_at,message.timestamp))kind='EXPIRED';
  if(!kind)return null;
  // This runs before normalized message/native append, allowing existing bounded
  // inbound retry when ownership effects have not yet settled.
  await assertDirectEffectsClear(client,{tenantId:input.tenantId,conversationId:c.id});
  return{kind,snapshot};
}

/** A fresh customer input may restart only its settled pinned welcome cycle.
 * Completion comes from the full explicit output set, never queued/read timestamps. */
export async function inspectDirectWelcomeResendInput(client:PoolClient,input:Input&{flowVersionId:string}):Promise<InspectedControl|null>{
  const {conversation:c,message,flow}=input;
  if(flow.welcomeResendMinutes==null||!input.assignmentActive||c.state!=='BOT'||message.fromMe||
    Number(c.zammad_customer_id)!==input.customerId||!['text','location'].includes(message.input.type))return null;
  const received=Date.parse(message.timestamp),latest=new Date(c.last_activity_at).getTime();
  if(!Number.isFinite(received)||!Number.isFinite(latest)||received<latest)return null;
  const cycle=(await client.query<{safe_metadata:{welcome_cycle?:{flow_version_id?:string;delivery_ids?:unknown}}}>(
    `SELECT safe_metadata FROM bot_conversation_events WHERE tenant_id=$1 AND conversation_id=$2
      AND safe_metadata ? 'welcome_cycle' ORDER BY created_at DESC,id DESC LIMIT 1`,
    [input.tenantId,c.id])).rows[0]?.safe_metadata.welcome_cycle;
  if(!cycle){
    const progressed=await client.query(`SELECT 1 FROM bot_conversation_events WHERE tenant_id=$1 AND conversation_id=$2
      AND safe_metadata ? 'effects' LIMIT 1`,[input.tenantId,c.id]);
    if(progressed.rows.length)return null;
    await assertDirectEffectsClear(client,{tenantId:input.tenantId,conversationId:c.id});
    return{kind:'INITIAL_WELCOME',snapshot:null};
  }
  const ids=cycle.delivery_ids;
  if(cycle.flow_version_id!==input.flowVersionId||!Array.isArray(ids)||ids.length<1||ids.length>100||
    new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)))
    throw new Error('DIRECT_PENDING_EFFECTS');
  const outputs=(await client.query<{id:string;state:string;lease_id:string|null;lease_expires_at:string|Date|null;
    external_message_id:string|null;content_redacted_at:string|Date|null;finished_at:string|Date|null;attempt_state:string|null;provider_matched:boolean}>(
    `SELECT d.id,d.state,d.lease_id,d.lease_expires_at,d.external_message_id,d.content_redacted_at,
      attempt.finished_at,attempt.state AS attempt_state,attempt.external_message_id=d.external_message_id AS provider_matched
     FROM delivery_outbox d LEFT JOIN delivery_attempts attempt ON attempt.tenant_id=d.tenant_id
       AND attempt.delivery_id=d.id AND attempt.attempt_number=d.attempts
     WHERE d.tenant_id=$1 AND d.bot_conversation_id=$2 AND d.connection_id=$3 AND d.external_chat_id=$4
       AND d.direct_origin='BOT' AND d.id=ANY($5::uuid[])`,
    [input.tenantId,c.id,input.connectionId,input.chatId,ids])).rows;
  if(outputs.length!==ids.length||new Set(outputs.map(o=>o.id)).size!==ids.length||outputs.some(o=>
    !ids.includes(o.id)||!['SENT','DELIVERED','READ'].includes(o.state)||o.lease_id!==null||o.lease_expires_at!==null||
    !o.external_message_id||o.content_redacted_at!==null||!o.provider_matched||
    !o.attempt_state||!['SENT','DELIVERED','READ'].includes(o.attempt_state)||o.finished_at==null||
    !Number.isFinite(new Date(o.finished_at).getTime())))throw new Error('DIRECT_PENDING_EFFECTS');
  const completed=Math.max(...outputs.map(o=>new Date(o.finished_at!).getTime()));
  if(received<completed+flow.welcomeResendMinutes*60_000)return null;
  await assertDirectEffectsClear(client,{tenantId:input.tenantId,conversationId:c.id});
  return{kind:'WELCOME_RESEND',snapshot:null};
}

export async function queueCustomerControlPrompt(client:PoolClient,input:{tenantId:string;connectionId:string;eventId:string;
  chatId:string;conversationId:string;ticketId:string;epoch:number;fencingToken?:number;humanPauseStartedAt?:string|Date|null;
  phase:'REQUEST'|'CONFIRM';mainMenu:boolean;customerResolution:boolean;arabic:boolean;mainMenuLabel?:string}){
  const id=randomUUID(),createdAt=new Date().toISOString();
  const options:CustomerControlSnapshot['options']=input.phase==='CONFIRM'
    ?[{id:`control_${randomUUID()}`,label:input.arabic?'تأكيد الحل':'Confirm resolution',kind:'CONFIRM_RESOLUTION'},
      {id:`control_${randomUUID()}`,label:input.arabic?'إبقاء التذكرة مفتوحة':'Keep ticket open',kind:'KEEP_OPEN'}]
    :[...(input.mainMenu?[{id:`control_${randomUUID()}`,label:input.mainMenuLabel??(input.arabic?'القائمة الرئيسية':'Main menu'),kind:'MAIN_MENU' as const}]:[]),
      ...(input.customerResolution?[{id:`control_${randomUUID()}`,label:input.arabic?'حل تذكرتي':'Resolve my ticket',kind:'RESOLUTION_REQUEST' as const}]:[])];
  if(!options.length)return null;
  const text=input.phase==='CONFIRM'
    ?'Has this request been resolved? Confirm to close this ticket, or keep it open.\nهل تم حل هذا الطلب؟ أكّد لإغلاق هذه التذكرة، أو أبقها مفتوحة.'
    :'You can return to the main menu while this ticket stays open, or request closure after the issue is resolved.\nيمكنك العودة للقائمة الرئيسية مع بقاء التذكرة مفتوحة، أو طلب إغلاقها بعد حل المشكلة.';
  const snapshot:CustomerControlSnapshot={phase:input.phase,requestEventId:input.eventId,promptDeliveryId:id,epoch:input.epoch,createdAt,
    expiresAt:input.phase==='CONFIRM'?new Date(Date.parse(createdAt)+BOT_CUSTOMER_CONFIRMATION_TTL_SECONDS*1000).toISOString():null,
    ...(input.phase==='CONFIRM'?{confirmationFencingToken:input.fencingToken,
      humanPauseStartedAt:input.humanPauseStartedAt?new Date(input.humanPauseStartedAt).toISOString():null}:{}),options};
  await client.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,
    message_body,content_type,idempotency_key,state,bot_content,direct_origin,meta_routing_source_event_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,'text/plain',$8,'QUEUED',$9,'BOT',
      CASE WHEN EXISTS(SELECT 1 FROM connections c WHERE c.tenant_id=$2 AND c.id=$3 AND c.provider='META') THEN $10::uuid ELSE NULL END)`,
    [id,input.tenantId,input.connectionId,input.conversationId,input.chatId,input.ticketId,text,
      `direct-control:${input.conversationId}:${input.eventId}:${input.phase}`,
      JSON.stringify({type:'choices',nodeId:'wasalx_customer_control',controlId:id,options:options.map(({id,label})=>({id,label}))}),input.eventId]);
  await client.query('UPDATE bot_conversations SET customer_control=$1 WHERE tenant_id=$2 AND id=$3',
    [JSON.stringify(snapshot),input.tenantId,input.conversationId]);
  return snapshot;
}

export async function applyDirectKeepOpenInput(client:PoolClient,input:Input,inspected:InspectedControl){
  const c=input.conversation;
  if(inspected.kind==='MAIN_MENU'||inspected.kind==='EXPIRED'||inspected.kind==='INITIAL_WELCOME'||inspected.kind==='WELCOME_RESEND'){
    const changed=await client.query(`UPDATE bot_conversations SET state='BOT',current_node_id=$1,variables='{}',step_count=0,
      customer_control=NULL,human_pause_started_at=NULL,resolved_at=NULL,resolution_kind=NULL,
      fencing_token=fencing_token+1,updated_at=now() WHERE tenant_id=$2 AND id=$3 AND state IN ('HUMAN','BOT')`,
      [inspected.kind==='MAIN_MENU'?(input.flow.mainMenuNodeId??input.flow.start):input.flow.start,input.tenantId,c.id]);
    if(changed.rowCount!==1)throw new Error('DIRECT_RESUME_STATE_CHANGED');
    await client.query(`INSERT INTO bot_conversation_events(tenant_id,conversation_id,event_kind,safe_metadata)
      VALUES($1,$2,'RESUMED',$3)`,[input.tenantId,c.id,JSON.stringify({cause:inspected.kind==='EXPIRED'?'AUTO_PAUSE_EXPIRED':inspected.kind==='INITIAL_WELCOME'?'INITIAL_WELCOME':inspected.kind==='WELCOME_RESEND'?'WELCOME_INTERVAL_EXPIRED':'CUSTOMER_MAIN_MENU',source_event_id:input.eventId,human_ownership_epoch:Number(c.human_ownership_epoch)})]);
    return{handled:false,resumed:true,queued:false};
  }
  if(inspected.kind==='RESOLUTION_REQUEST'){
    await queueCustomerControlPrompt(client,{tenantId:input.tenantId,connectionId:input.connectionId,eventId:input.eventId,
      chatId:input.chatId,conversationId:c.id,ticketId:c.zammad_ticket_id,epoch:Number(c.human_ownership_epoch),phase:'CONFIRM',
      fencingToken:Number(c.fencing_token)+1,humanPauseStartedAt:c.human_pause_started_at,
      mainMenu:false,customerResolution:true,arabic:[
        input.message.input.type==='text'?input.message.input.text:input.message.input.type==='choice'?input.message.input.label:'',
        inspected.snapshot?.options.find(option=>option.kind==='RESOLUTION_REQUEST')?.label??''
      ].some(label=>/[\u0600-\u06ff]/u.test(label))});
    return{handled:true,resumed:false,queued:true};
  }
  if(inspected.kind==='KEEP_OPEN'){
    await client.query('UPDATE bot_conversations SET customer_control=NULL WHERE tenant_id=$1 AND id=$2',[input.tenantId,c.id]);
    return{handled:true,resumed:false,queued:false};
  }
  const snapshot=inspected.snapshot;
  if(!snapshot||snapshot.phase!=='CONFIRM'||snapshot.epoch!==Number(c.human_ownership_epoch))throw new Error('DIRECT_CONFIRMATION_CHANGED');
  const request={conversationId:c.id,customerId:input.customerId,requestEventId:snapshot.requestEventId,
    confirmationEventId:input.eventId,promptDeliveryId:snapshot.promptDeliveryId,epoch:snapshot.epoch,fencingToken:Number(c.fencing_token)+1};
  const requestSha=createHash('sha256').update(JSON.stringify(request)).digest('hex');
  await client.query(`INSERT INTO direct_customer_close_commands(id,tenant_id,conversation_id,request_event_id,confirmation_event_id,
    confirmation_prompt_delivery_id,human_ownership_epoch,conversation_fencing_token,request_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),input.tenantId,c.id,snapshot.requestEventId,input.eventId,
    snapshot.promptDeliveryId,snapshot.epoch,Number(c.fencing_token)+1,requestSha]);
  await client.query('UPDATE bot_conversations SET customer_control=NULL WHERE tenant_id=$1 AND id=$2',[input.tenantId,c.id]);
  return{handled:true,resumed:false,queued:true};
}
