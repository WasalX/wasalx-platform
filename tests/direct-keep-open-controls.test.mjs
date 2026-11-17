import assert from 'node:assert/strict';
import {assertMetaDirectEffectCurrent} from '../packages/core/dist/meta-direct-identity.js';
import {metaDirectEffectQueryFixture} from './meta-direct-effect-query-fixture.mjs';
import {routingFixtureEnvironment} from './meta-routing-fixture.mjs';
import test from 'node:test';
import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {MetaGroupsAdapter} from '../services/connector-worker/dist/packages/connectors/src/meta.js';
import {WahaAdapter} from '../services/connector-worker/dist/packages/connectors/src/waha.js';
import {InboundRepository} from '../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js';
import {OutboxRepository} from '../services/connector-worker/dist/services/connector-worker/src/repository.js';
import {inspectDirectKeepOpenInput,inspectDirectWelcomeResendInput,applyDirectKeepOpenInput,queueCustomerControlPrompt} from '../services/connector-worker/dist/services/connector-worker/src/direct-keep-open-runtime.js';
import {directControlDeliveryAllowed,directHumanDeliveryAllowed} from '../packages/core/dist/direct-delivery-guards.js';
import {validateDirectCloseReceipt,recordDirectCloseReceipt,directCustomerCloseAdmission,prepareDirectCustomerClose} from '../packages/core/dist/direct-customer-close.js';
import {advanceBotFlow,parseBotFlow,botChoicePosition,resolveBotEntryCommand} from '../packages/core/dist/bot-flow.js';
const policy={humanReplyPauseMinutes:120,mainMenu:true,customerResolution:true};
const ids={tenant:'10000000-0000-4000-8000-000000000001',conversation:'20000000-0000-4000-8000-000000000001',
  connection:'30000000-0000-4000-8000-000000000001',event:'40000000-0000-4000-8000-000000000001',
  request:'50000000-0000-4000-8000-000000000001',prompt:'60000000-0000-4000-8000-000000000001',command:'70000000-0000-4000-8000-000000000001'};
const at='2026-10-06T12:00:00.000Z',anchor='2026-10-06T11:00:00.000Z';
function fixture(overrides={}){
  const conversation={id:ids.conversation,state:'HUMAN',current_node_id:'handoff',human_ownership_epoch:'3',fencing_token:'10',
    zammad_customer_id:'8',human_pause_started_at:anchor,customer_control:null,zammad_ticket_id:'41',last_activity_at:'2026-10-06T11:59:00Z',...overrides};
  return{tenantId:ids.tenant,connectionId:ids.connection,eventId:ids.event,chatId:'12025550120@c.us',customerId:8,assignmentActive:true,
    flow:{schemaVersion:1,name:'Owned direct',start:'menu',maxSteps:20,nodes:[],keepOpenPolicy:policy},conversation,
    message:{messageId:'customer-own-message',chatId:'12025550120@c.us',senderId:'12025550120@c.us',fromMe:false,timestamp:at,input:{type:'text',text:'Main menu'}}};
}
function snapshot(overrides={}){return{phase:'CONFIRM',requestEventId:ids.request,promptDeliveryId:ids.prompt,epoch:3,createdAt:'2026-10-06T11:59:00.000Z',expiresAt:'2026-10-06T12:09:00.000Z',confirmationFencingToken:10,humanPauseStartedAt:anchor,
  options:[{id:'owned-confirm',label:'Confirm resolution',kind:'CONFIRM_RESOLUTION'},{id:'owned-cancel',label:'Keep ticket open',kind:'KEEP_OPEN'}],...overrides};}
function database({pending=false,promptState='SENT',promptExternal='provider-owned-prompt'}={}){const calls=[];return{calls,query:async(sql,values)=>{calls.push({sql,values});
  if(sql.startsWith("SELECT 'reply' AS kind"))return{rows:pending?[{kind:'reply',id:'held'}]:[],rowCount:pending?1:0};
  if(sql.startsWith("SELECT 'delivery' AS kind"))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT external_message_id,state'))return{rows:[{external_message_id:promptExternal,state:promptState,content_redacted_at:null,bot_content:{controlId:ids.prompt}}],rowCount:1};
  if(sql.startsWith('UPDATE bot_conversations')||sql.startsWith('INSERT INTO bot_conversation_events')||sql.startsWith('INSERT INTO delivery_outbox')||sql.startsWith('INSERT INTO direct_customer_close_commands'))return{rows:[],rowCount:1};
  throw new Error('Unexpected SQL '+sql);
}};}
test('own bigint-native customer can request localized menu; foreign customer cannot',async()=>{
  const f=fixture(),db=database();assert.equal((await inspectDirectKeepOpenInput(db,f)).kind,'MAIN_MENU');
  assert.equal(await inspectDirectKeepOpenInput(database(),{...f,customerId:9}),null);
});
test('old/from-device/reaction inputs never trigger ownership controls',async()=>{
  for(const message of [{...fixture().message,timestamp:'2026-10-06T11:58:00Z'},{...fixture().message,fromMe:true},{...fixture().message,input:{type:'reaction'}}]){
    const db=database();assert.equal(await inspectDirectKeepOpenInput(db,{...fixture(),message}),null);assert.equal(db.calls.length,0);
  }
});
test('lazy expiry on fresh ordinary input resumes same pinned start without native close or output',async()=>{
  const f=fixture({human_pause_started_at:'2026-10-06T09:59:59Z'});f.message.input={type:'text',text:'Another question'};
  const db=database(),inspected=await inspectDirectKeepOpenInput(db,f);assert.equal(inspected.kind,'EXPIRED');
  assert.deepEqual(await applyDirectKeepOpenInput(db,f,inspected),{handled:false,resumed:true,queued:false});
  const update=db.calls.find(c=>c.sql.startsWith('UPDATE bot_conversations'));assert.deepEqual(update.values,['menu',ids.tenant,ids.conversation]);
  assert.equal(db.calls.some(c=>c.sql.startsWith('INSERT INTO delivery_outbox')||c.sql.startsWith('INSERT INTO direct_customer_close_commands')),false);
});
test('native pending intent prevents menu/expiry mutation',async()=>{
  const db=database({pending:true});await assert.rejects(inspectDirectKeepOpenInput(db,fixture()),/DIRECT_NATIVE_EFFECT_HOLD/);
  assert.equal(db.calls.some(c=>/^(UPDATE|INSERT)/u.test(c.sql)),false);
});
test('localized resolution request queues a bound confirmation, never closes immediately',async()=>{
  for(const text of ['Resolve my ticket','حل تذكرتي']){const f=fixture();f.message.input={type:'text',text};const db=database();
    const inspected=await inspectDirectKeepOpenInput(db,f);assert.equal(inspected.kind,'RESOLUTION_REQUEST');
    await applyDirectKeepOpenInput(db,f,inspected);assert.equal(db.calls.filter(c=>c.sql.startsWith('INSERT INTO delivery_outbox')).length,1);
    assert.equal(db.calls.some(c=>c.sql.startsWith('INSERT INTO direct_customer_close_commands')),false);
    const stored=JSON.parse(db.calls.find(c=>c.sql.startsWith('UPDATE bot_conversations')).values[0]);assert.equal(stored.epoch,3);assert.equal(stored.confirmationFencingToken,11);
  }
});
test('unbound yes/confirmation is ordinary text, not customer closure',async()=>{
  for(const text of ['yes','نعم','Confirm resolution','تأكيد الحل']){const f=fixture();f.message.input={type:'text',text};assert.equal(await inspectDirectKeepOpenInput(database(),f),null);}
});
test('Arabic native request choice preserves Arabic confirmation buttons',async()=>{
  const request=snapshot({phase:'REQUEST',expiresAt:null,options:[{id:'arabic-resolve',label:'حل تذكرتي',kind:'RESOLUTION_REQUEST'}]});
  const f=fixture({customer_control:request});f.message.input={type:'choice',source:'META_NATIVE',choiceId:'arabic-resolve',label:'حل تذكرتي'};f.message.quotedMessageId='provider-owned-prompt';
  const db=database(),selected=await inspectDirectKeepOpenInput(db,f);assert.equal(selected.kind,'RESOLUTION_REQUEST');
  await applyDirectKeepOpenInput(db,f,selected);
  const stored=JSON.parse(db.calls.find(call=>call.sql.startsWith('UPDATE bot_conversations')).values[0]);
  assert.deepEqual(stored.options.map(option=>option.label),['تأكيد الحل','إبقاء التذكرة مفتوحة']);
});
test('native interactive selection requires exact current prompt quote and choice ID/label',async()=>{
  const f=fixture({customer_control:snapshot()});f.message.input={type:'choice',source:'META_NATIVE',choiceId:'owned-confirm',label:'Confirm resolution'};
  f.message.quotedMessageId='provider-owned-prompt';assert.equal((await inspectDirectKeepOpenInput(database(),f)).kind,'CONFIRM_RESOLUTION');
  for(const quote of [undefined,'foreign-prompt'])assert.equal(await inspectDirectKeepOpenInput(database(),{...f,message:{...f.message,quotedMessageId:quote}}),null);
  assert.equal(await inspectDirectKeepOpenInput(database(),{...f,message:{...f.message,input:{...f.message.input,label:'changed'}}}),null);
});
test('bounded numbered fallback shares Latin/Arabic-Indic/Eastern normalization',async()=>{
  for(const text of ['1','١','۱']){assert.equal(botChoicePosition(text),0);const f=fixture({customer_control:snapshot()});f.message.input={type:'text',text};assert.equal((await inspectDirectKeepOpenInput(database(),f)).kind,'CONFIRM_RESOLUTION');}
  for(const text of ['2','٢','۲']){const f=fixture({customer_control:snapshot()});f.message.input={type:'text',text};assert.equal((await inspectDirectKeepOpenInput(database(),f)).kind,'KEEP_OPEN');}
  for(const text of ['01','٠١','0','100'])assert.equal(botChoicePosition(text),-1);
});
test('stale epoch/fence/anchor/TTL or unsent prompt cannot authorize customer close',async()=>{
  for(const s of [snapshot({epoch:2}),snapshot({confirmationFencingToken:9}),snapshot({humanPauseStartedAt:'2026-10-06T10:00:00Z'}),snapshot({expiresAt:'2026-10-06T11:59:59Z'})]){
    const f=fixture({customer_control:s});f.message.input={type:'text',text:'1'};assert.equal(await inspectDirectKeepOpenInput(database(),f),null);
  }
  const f=fixture({customer_control:snapshot()});f.message.input={type:'text',text:'1'};assert.equal(await inspectDirectKeepOpenInput(database({promptState:'SENDING'}),f),null);
});
test('accepted confirmation creates one immutable own command, not provider output',async()=>{
  const f=fixture({customer_control:snapshot()}),db=database();await applyDirectKeepOpenInput(db,f,{kind:'CONFIRM_RESOLUTION',snapshot:f.conversation.customer_control});
  const commands=db.calls.filter(c=>c.sql.startsWith('INSERT INTO direct_customer_close_commands'));assert.equal(commands.length,1);
  assert.deepEqual(commands[0].values.slice(1,8),[ids.tenant,ids.conversation,ids.request,ids.event,ids.prompt,3,11]);assert.match(commands[0].values[8],/^[a-f0-9]{64}$/u);
  assert.equal(db.calls.some(c=>c.sql.startsWith('INSERT INTO delivery_outbox')),false);
});
test('cancel keeps native ticket open and clears only current control',async()=>{
  const f=fixture({customer_control:snapshot()}),db=database();await applyDirectKeepOpenInput(db,f,{kind:'KEEP_OPEN',snapshot:f.conversation.customer_control});
  assert.equal(db.calls.length,1);assert.deepEqual(db.calls[0].values,[ids.tenant,ids.conversation]);assert.match(db.calls[0].sql,/customer_control=NULL/u);
});
function deliveryDb(row){return{query:async()=>({rows:[row],rowCount:1})};}
test('only exact current source-owned control can send as BOT while HUMAN',async()=>{
  const row={state:'HUMAN',human_ownership_epoch:'3',fencing_token:'10',human_pause_started_at:anchor,customer_control:snapshot({expiresAt:new Date(Date.now()+60_000).toISOString()}),keep_open_policy:policy,direct_origin:'BOT',bot_content:{controlId:ids.prompt,nodeId:'wasalx_customer_control'},content_redacted_at:null};
  const input={tenantId:ids.tenant,conversationId:ids.conversation,deliveryId:ids.prompt};assert.equal(await directControlDeliveryAllowed(deliveryDb(row),input),true);
  for(const altered of [{state:'RESOLVED'},{bot_content:{}},{content_redacted_at:'now'},{human_ownership_epoch:'4'},{fencing_token:'11'},{customer_control:snapshot({expiresAt:'2000-01-01T00:00:00Z'})}])assert.equal(await directControlDeliveryAllowed(deliveryDb({...row,...altered}),input),false);
});
test('HUMAN output cannot cross ownership epochs; absent legacy remains HUMAN-only',async()=>{
  const input={tenantId:ids.tenant,conversationId:ids.conversation,deliveryId:ids.prompt};
  assert.equal(await directHumanDeliveryAllowed(deliveryDb({state:'HUMAN',epoch:'3',delivery_epoch:'3',policy}),input),true);
  for(const row of [{state:'BOT',epoch:'3',delivery_epoch:'3',policy},{state:'HUMAN',epoch:'4',delivery_epoch:'3',policy},{state:'HUMAN',epoch:'3',delivery_epoch:null,policy}])assert.equal(await directHumanDeliveryAllowed(deliveryDb(row),input),false);
  assert.equal(await directHumanDeliveryAllowed(deliveryDb({state:'HUMAN',epoch:'3',delivery_epoch:null,policy:null}),input),true);
});
const closeSnapshot={command_id:ids.command,ticket_id:'41',request_sha256:'a'.repeat(64),customer_id:'8',human_ownership_epoch:3,conversation_fencing_token:11};
const closeReceipt={...closeSnapshot,state:'SUCCEEDED',article_id:'91',closed_at:at};
test('receipt binds command/ticket/customer/epoch/fence; raw OPERATOR receipt cannot become customer close',()=>{
  assert.deepEqual(validateDirectCloseReceipt(closeReceipt,closeSnapshot),closeReceipt);
  for(const changed of [{command_id:ids.event},{ticket_id:'42'},{customer_id:'9'},{human_ownership_epoch:4},{conversation_fencing_token:12},{state:'OPERATOR'},{article_id:'0'}])assert.throws(()=>validateDirectCloseReceipt({...closeReceipt,...changed},closeSnapshot),/DIRECT_CLOSE_RECEIPT_CONFLICT/);
});
test('UNKNOWN native admission reads frozen snapshot only, never grants a second POST',async()=>{
  const calls=[],row={id:ids.command,state:'OUTCOME_UNKNOWN',conversation_id:ids.conversation,zammad_ticket_id:'41',native_action_snapshot:{...closeSnapshot,tenant_id:ids.tenant,instance_id:ids.connection}};
  const db={query:async(sql)=>{calls.push(sql);return{rows:[row],rowCount:1}}};
  const admitted=await directCustomerCloseAdmission(db,{tenantId:ids.tenant,instanceId:ids.connection,commandId:ids.command});assert.equal(admitted.effects_clear,false);assert.equal(admitted.native_action_state,'OUTCOME_UNKNOWN');assert.equal(calls.length,1);assert.equal(/^(UPDATE|INSERT)/u.test(calls[0]),false);
});
test('accepted receipt replay tolerates JSONB key order but rejects changed native article',async()=>{
  const reordered={closed_at:at,article_id:'91',state:'SUCCEEDED',...closeSnapshot};const row={id:ids.command,state:'SUCCEEDED',native_action_snapshot:closeSnapshot,native_result:reordered};
  const db={query:async()=>({rows:[row],rowCount:1})};assert.deepEqual(await recordDirectCloseReceipt(db,{tenantId:ids.tenant,commandId:ids.command,receipt:closeReceipt}),closeReceipt);
  await assert.rejects(recordDirectCloseReceipt(db,{tenantId:ids.tenant,commandId:ids.command,receipt:{...closeReceipt,article_id:'92'}}),/DIRECT_CLOSE_RECEIPT_CONFLICT/);
});
function closePrepareDatabase({closed=false,epoch=3,privacy=false,pending=false,changed=1,meta=false,identityHeld=false,identityBusy=false,routingHeld=false,state='QUEUED'}={}){
  const calls=[],row={id:ids.command,request_event_id:ids.request,confirmation_event_id:ids.event,state,conversation_id:ids.conversation,human_ownership_epoch:3,conversation_fencing_token:11,
    request_sha256:'a'.repeat(64),lease_id:ids.prompt,fencing_token:2,zammad_ticket_id:'41',zammad_customer_id:'8',assignment_id:ids.request,
    external_chat_id:meta?'12025550120':'12025550120@c.us',connection_id:ids.connection,conversation_state:'HUMAN',current_epoch:epoch,current_fence:11};
  const effect=metaDirectEffectQueryFixture({tenantId:ids.tenant,conversationId:ids.conversation,connectionId:ids.connection,ticketId:'41',chatId:row.external_chat_id,meta,held:identityHeld,busy:identityBusy,routingHeld,routingSources:[ids.request,ids.event]});
  return{calls,effect,row,context:{updated_at:at,state_id:'2',last_article_id:'90',native_group_id:'2',connection_id:ids.connection,external_chat_id:row.external_chat_id,customer_id:'8',closed},
    query:async(sql,values)=>{calls.push({sql,values});
      const guarded=effect.query(sql,values);if(guarded!==undefined)return guarded;
      if(sql.startsWith('SELECT command.*'))return{rows:[row],rowCount:1};
      if(sql.startsWith('SELECT pg_try_advisory_xact_lock'))return{rows:[{acquired:true}],rowCount:1};
      if(sql.startsWith('SELECT pg_advisory_xact_lock')||sql.startsWith('SELECT id FROM bot_conversations')||sql.startsWith('SELECT id FROM direct_customer_close_commands')||sql.startsWith('SELECT instance.id'))return{rows:[{id:ids.command}],rowCount:1};
      if(sql.startsWith('SELECT 1 FROM privacy_jobs job'))return{rows:privacy?[{}]:[],rowCount:privacy?1:0};
      if(sql.startsWith("SELECT 'reply' AS kind"))return{rows:pending?[{}]:[],rowCount:pending?1:0};
      if(sql.startsWith("SELECT 'delivery' AS kind"))return{rows:[],rowCount:0};
      if(sql.startsWith('UPDATE direct_customer_close_commands'))return{rows:[],rowCount:changed};
      throw new Error('Unexpected SQL '+sql);
    }};
}
const closePrepareInput={tenantId:ids.tenant,instanceId:ids.connection,commandId:ids.command,leaseId:ids.prompt,fencingToken:2};
test('native already closed rejects before ATTEMPTED and cannot invent CUSTOMER_CONFIRMED',async()=>{
  const db=closePrepareDatabase({closed:true});await assert.rejects(prepareDirectCustomerClose(db,{...closePrepareInput,context:db.context}),/DIRECT_CLOSE_NATIVE_ALREADY_CLOSED/);
  assert.equal(db.calls.some(call=>/^(INSERT|UPDATE)/u.test(call.sql)),false);
});
test('changed epoch, privacy hold or other pending native work cannot prepare a customer close',async()=>{
  for(const [options,error] of [[{epoch:4},/DIRECT_CLOSE_CONVERSATION_CHANGED/],[{privacy:true},/DIRECT_PRIVACY_HOLD/],[{pending:true},/DIRECT_NATIVE_EFFECT_HOLD/]]){
    const db=closePrepareDatabase(options);await assert.rejects(prepareDirectCustomerClose(db,{...closePrepareInput,context:db.context}),error);
    assert.equal(db.calls.some(call=>/^(INSERT|UPDATE)/u.test(call.sql)),false);
  }
});
test('customer close freezes exact native context and lease before the external caller may POST',async()=>{
  const db=closePrepareDatabase(),snapshot=await prepareDirectCustomerClose(db,{...closePrepareInput,context:db.context});
  const writes=db.calls.filter(call=>/^(INSERT|UPDATE)/u.test(call.sql));assert.equal(writes.length,1);assert.match(writes[0].sql,/state='ATTEMPTED'/u);
  assert.deepEqual(writes[0].values,[snapshot,ids.tenant,ids.command,ids.prompt,2]);assert.equal(snapshot.customer_id,'8');assert.equal(snapshot.expected_native_article_id,'90');
});
test('lost command lease cannot return an admitted external close snapshot',async()=>{
  const db=closePrepareDatabase({changed:0});await assert.rejects(prepareDirectCustomerClose(db,{...closePrepareInput,context:db.context}),/DIRECT_CLOSE_LEASE_CHANGED/);
});


test('generated REQUEST and CONFIRM controls pass both real adapters and retain correlated choices',async(t)=>{
  // Force the production failure class rather than relying on random UUID first characters.
  let serial=0;const originalFetch=globalThis.fetch;
  t.mock.method(crypto,'randomUUID',()=>`10000000-0000-4000-8000-${String(++serial).padStart(12,'0')}`);
  syncBuiltinESMExports();
  try{
    for(const phase of ['REQUEST','CONFIRM'])for(const arabic of [false,true]){
      const writes=[],db={query:async(sql,values)=>{writes.push({sql,values});return{rows:[],rowCount:1}}};
      const control=await queueCustomerControlPrompt(db,{tenantId:ids.tenant,connectionId:ids.connection,eventId:ids.event,
        chatId:'12025550120@c.us',conversationId:ids.conversation,ticketId:'41',epoch:3,fencingToken:10,
        humanPauseStartedAt:anchor,phase,mainMenu:true,customerResolution:true,arabic});
      const insertion=writes.find(call=>call.sql.startsWith('INSERT INTO delivery_outbox'));
      const content=JSON.parse(insertion.values[8]),text=insertion.values[6];
      assert.deepEqual(content.options,control.options.map(({id,label})=>({id,label})));
      assert.equal(content.controlId,control.promptDeliveryId);
      assert.equal(new Set(content.options.map(option=>option.id)).size,content.options.length);
      let metaBody,wahaBody;
      globalThis.fetch=async(url,init)=>{
        const body=JSON.parse(init.body);
        if(String(url).startsWith('https://graph.test/')){metaBody=body;return new Response(JSON.stringify({messages:[{id:'wamid.control-proof'}]}),{status:200,headers:{'content-type':'application/json'}})}
        assert.equal(new URL(String(url)).pathname,'/api/sendText');wahaBody=body;
        return new Response(JSON.stringify({id:'waha-control-proof'}),{status:200,headers:{'content-type':'application/json'}});
      };
      const common={connectionId:ids.connection,recipientType:'DIRECT',text,choices:{options:content.options},idempotencyKey:'control-contract'};
      const meta=new MetaGroupsAdapter({accessToken:'synthetic-control-contract-token',graphVersion:'v24.0',baseUrl:'https://graph.test',phoneNumberIdFor:()=> '123456789'});
      const waha=new WahaAdapter({baseUrl:'https://waha.test',apiKey:'synthetic-control-key',sessionFor:()=> 'control-test'});
      assert.equal((await meta.send({...common,groupId:'12025550120'})).state,'SENT');
      assert.equal((await waha.send({...common,groupId:'12025550120@c.us'})).state,'SENT');
      assert.deepEqual(metaBody.interactive.action.buttons.map(button=>({id:button.reply.id,label:button.reply.title})),content.options);
      assert.equal(wahaBody.text,[text,...content.options.map((option,index)=>`${index+1}. ${option.label}`)].join('\n'));
      const choice=control.options.find(option=>option.kind===(phase==='CONFIRM'?'CONFIRM_RESOLUTION':'RESOLUTION_REQUEST'));
      const f=fixture({customer_control:control});f.message.timestamp=new Date(Date.now()+1000).toISOString();
      const reads=database(),baseQuery=reads.query;
      reads.query=(sql,values)=>sql.startsWith('SELECT external_message_id,state')
        ?Promise.resolve({rows:[{external_message_id:'provider-owned-prompt',state:'SENT',content_redacted_at:null,bot_content:{controlId:control.promptDeliveryId}}],rowCount:1})
        :baseQuery(sql,values);
      f.message.input={type:'choice',source:'META_NATIVE',choiceId:choice.id,label:choice.label};f.message.quotedMessageId='provider-owned-prompt';
      assert.equal((await inspectDirectKeepOpenInput(reads,f)).kind,choice.kind);
      f.message.input={type:'choice',source:'META_NATIVE',choiceId:'foreign-choice',label:choice.label};
      assert.equal(await inspectDirectKeepOpenInput(reads,f),null);
      f.message.input={type:'text',text:String(control.options.indexOf(choice)+1)};
      assert.equal((await inspectDirectKeepOpenInput(reads,f)).kind,choice.kind);
    }
  }finally{globalThis.fetch=originalFetch;t.mock.restoreAll();syncBuiltinESMExports()}
});

test('handoff controls follow the pinned handoff message language, including Arabic',async()=>{
  for(const [message,labels] of [['سيتابع معك فريق الدعم',['القائمة الرئيسية','حل تذكرتي']],['Our support team will follow up',['Main menu','Resolve my ticket']]]){
    const calls=[],definition={schemaVersion:1,name:'Pinned flow',start:'handoff',maxSteps:8,keepOpenPolicy:policy,
      nodes:[{id:'handoff',type:'handoff',target:'FIXED',zammadGroupId:'2',priority:'2 normal',message}]};
    const client={release(){},query:async(sql,values)=>{
      calls.push({sql,values});
      if(sql.startsWith('SELECT conversation.connection_id'))return{rows:[{connection_id:ids.connection,external_chat_id:'12025550120@c.us',zammad_ticket_id:'41',human_ownership_epoch:'3',definition}],rowCount:1};
      if(sql.startsWith('SELECT 1 FROM delivery_outbox'))return{rows:[],rowCount:0};
      return{rows:[],rowCount:1};
    }};
    const repository=new OutboxRepository({connect:async()=>client});
    await repository.completeBotHandoff({tenantId:ids.tenant,id:ids.event,conversationId:ids.conversation,handoffNodeId:'handoff',fencingToken:1},ids.prompt);
    const insertion=calls.find(call=>call.sql.startsWith('INSERT INTO delivery_outbox'));
    assert.deepEqual(JSON.parse(insertion.values[8]).options.map(option=>option.label),labels);
  }
});

test('valid current Meta close source pins authorize one ATTEMPTED snapshot',async(t)=>{
 t.after(routingFixtureEnvironment('123456789'));
 const db=closePrepareDatabase({meta:true});const snapshot=await prepareDirectCustomerClose(db,{...closePrepareInput,context:db.context,appId:db.effect.appId});
 assert.equal(snapshot.ticket_id,'41');assert.equal(db.calls.filter(c=>c.sql.startsWith('UPDATE direct_customer_close_commands')).length,1);
});
test('Meta held alias, routing or busy native lock denies close before ATTEMPTED without mutation',async(t)=>{
 t.after(routingFixtureEnvironment('123456789'));
 for(const options of [{meta:true,identityHeld:true},{meta:true,identityBusy:true},{meta:true,routingHeld:true}]){
  const db=closePrepareDatabase(options);
  await assert.rejects(prepareDirectCustomerClose(db,{...closePrepareInput,context:db.context,appId:db.effect.appId}),{code:'META_DIRECT_EFFECT_NOT_ATTEMPTED',outcomeKnown:true});
  assert.equal(db.calls.some(c=>/^(INSERT|UPDATE)/u.test(c.sql)),false);
   if(options.routingHeld)assert.equal(db.calls.filter(c=>c.sql.startsWith('SELECT allowed,claim FROM app.meta_direct_routing_guard')).length,1);
 }
});
test('Meta ATTEMPTED close admission rechecks held identity; UNKNOWN receipt-only read does not',async()=>{
 const attempted=closePrepareDatabase({meta:true,identityHeld:true,state:'ATTEMPTED'});
 attempted.row.native_action_snapshot={...closeSnapshot,tenant_id:ids.tenant,instance_id:ids.connection};
 await assert.rejects(directCustomerCloseAdmission(attempted,{tenantId:ids.tenant,instanceId:ids.connection,commandId:ids.command,appId:attempted.effect.appId}),{code:'META_DIRECT_EFFECT_NOT_ATTEMPTED',outcomeKnown:true});
 assert.equal(attempted.calls.some(c=>/^(INSERT|UPDATE)/u.test(c.sql)),false);
 const unknown=closePrepareDatabase({meta:true,identityHeld:true,state:'OUTCOME_UNKNOWN'});
 unknown.row.native_action_snapshot=attempted.row.native_action_snapshot;
 const result=await directCustomerCloseAdmission(unknown,{tenantId:ids.tenant,instanceId:ids.connection,commandId:ids.command,appId:unknown.effect.appId});
 assert.equal(result.effects_clear,false);assert.equal(result.native_action_state,'OUTCOME_UNKNOWN');assert.equal(unknown.calls.length,1);
});

test('retained ordinary alias anchor authorizes native precommit but never an expired queued source',async t=>{
 t.after(routingFixtureEnvironment('123456789'));
 const fixture=metaDirectEffectQueryFixture({tenantId:ids.tenant,conversationId:ids.conversation,connectionId:ids.connection,ticketId:'41',chatId:'100',meta:true,sourceStatus:'REDACTED'});
 const calls=[];const client={query:async(sql,values)=>{calls.push({sql,values});const result=fixture.query(sql,values);assert.notEqual(result,undefined,`Unexpected capsule fixture SQL: ${sql}`);return result}};
 const input={tenantId:ids.tenant,conversationId:ids.conversation,appId:fixture.appId};
 await assertMetaDirectEffectCurrent(client,input);
 assert(calls.some(call=>call.sql==='SELECT app.meta_direct_alias_source_valid($1,$2,$3) AS valid'));
 await assert.rejects(assertMetaDirectEffectCurrent(client,{...input,sourceEventIds:[fixture.sourceId]}),{code:'META_DIRECT_EFFECT_NOT_ATTEMPTED',outcomeKnown:true});
 assert.equal(calls.some(call=>/^(INSERT|UPDATE)/u.test(call.sql)),false);
});
test('missing or invalid ordinary alias anchor cannot authorize a native reply',async()=>{
 const fixture=metaDirectEffectQueryFixture({tenantId:ids.tenant,conversationId:ids.conversation,connectionId:ids.connection,ticketId:'41',chatId:'100',meta:true,anchorValid:false});
 const client={query:async(sql,values)=>{const result=fixture.query(sql,values);assert.notEqual(result,undefined,`Unexpected capsule fixture SQL: ${sql}`);return result}};
 await assert.rejects(assertMetaDirectEffectCurrent(client,{tenantId:ids.tenant,conversationId:ids.conversation,appId:fixture.appId}),{code:'META_DIRECT_EFFECT_NOT_ATTEMPTED',outcomeKnown:true});
});

const welcomeVersion='81000000-0000-4000-8000-000000000001';
const welcomeIds=['82000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000002'];
function welcomeFixture(){const f=fixture({state:'BOT',current_node_id:'submenu',variables:{'action.old':'discard'}});
  f.flow={...f.flow,welcomeResendMinutes:60};f.flowVersionId=welcomeVersion;
  f.message={...f.message,timestamp:'2026-10-06T12:00:00Z',input:{type:'text',text:'A new request'}};return f;}
function welcomeDatabase({cycle={flow_version_id:welcomeVersion,delivery_ids:welcomeIds},outputs,pending=false,progressed=true}={}){
  const db=database({pending}),query=db.query;
  db.query=async(sql,values)=>{
    if(sql.startsWith('SELECT safe_metadata')){db.calls.push({sql,values});return{rows:cycle?[{safe_metadata:{welcome_cycle:cycle}}]:[]};}
    if(sql.startsWith('SELECT 1 FROM bot_conversation_events')){db.calls.push({sql,values});return{rows:progressed?[{}]:[]};}
    if(sql.startsWith('SELECT d.id,d.state')){db.calls.push({sql,values});return{rows:outputs??welcomeIds.map(id=>({id,state:'SENT',lease_id:null,lease_expires_at:null,
      external_message_id:'provider-'+id,content_redacted_at:null,finished_at:'2026-10-06T11:00:00Z',attempt_state:'SENT',provider_matched:true}))};}
    return query(sql,values);
  };return db;
}
test('welcome restart uses full successful completion at exact interval and reuses main-menu reset',async()=>{
  const f=welcomeFixture(),db=welcomeDatabase();
  const inspected=await inspectDirectWelcomeResendInput(db,f);assert.equal(inspected.kind,'WELCOME_RESEND');
  assert.deepEqual(await applyDirectKeepOpenInput(db,f,inspected),{handled:false,resumed:true,queued:false});
  const update=db.calls.find(c=>c.sql.startsWith('UPDATE bot_conversations'));
  assert.match(update.sql,/variables='{}',step_count=0/);assert.deepEqual(update.values,['menu',ids.tenant,ids.conversation]);
  assert.equal(db.calls.some(c=>c.sql.startsWith('INSERT INTO delivery_outbox')),false,'normal inbound advancement alone queues welcome');
  assert.equal(JSON.parse(db.calls.find(c=>c.sql.startsWith('INSERT INTO bot_conversation_events')).values[2]).cause,'WELCOME_INTERVAL_EXPIRED');
});
test('welcome interval anchors last successful member, never queued time or agent/input clocks',async()=>{
  const f=welcomeFixture(),db=welcomeDatabase();
  const rows=(await db.query('SELECT d.id,d.state',[])).rows;rows[1].finished_at='2026-10-06T11:00:01Z';
  assert.equal(await inspectDirectWelcomeResendInput(welcomeDatabase({outputs:rows}),f),null);
  f.message.timestamp='2026-10-06T12:00:01Z';assert.equal((await inspectDirectWelcomeResendInput(welcomeDatabase({outputs:rows}),f)).kind,'WELCOME_RESEND');
});
test('welcome is disabled for legacy/null and never steals ownership or foreign/stale/unsupported inputs',async()=>{
  const f=welcomeFixture();
  for(const override of [{flow:{...f.flow,welcomeResendMinutes:undefined}},{flow:{...f.flow,welcomeResendMinutes:null}},
    {assignmentActive:false},{customerId:9},...['HUMAN','HANDOFF_PENDING','ACTION_PENDING','RESOLVED'].map(state=>({conversation:{...f.conversation,state}})),
    {message:{...f.message,fromMe:true}},{message:{...f.message,timestamp:'2026-10-06T11:58:00Z'}},
    ...['reaction','unsupported','choice','flow_response'].map(type=>({message:{...f.message,input:{type}}}))]){
    const db=welcomeDatabase();assert.equal(await inspectDirectWelcomeResendInput(db,{...f,...override}),null);assert.equal(db.calls.length,0);
  }
  assert.equal(await inspectDirectWelcomeResendInput(welcomeDatabase({cycle:null}),f),null,'no guessed anchor');
});
test('inert first input cannot consume a never-displayed welcome choice',async()=>{
  const f=welcomeFixture(),db=welcomeDatabase({cycle:null,progressed:false});
  const inspected=await inspectDirectWelcomeResendInput(db,f);assert.equal(inspected.kind,'INITIAL_WELCOME');
  await applyDirectKeepOpenInput(db,f,inspected);
  assert.equal(db.calls.find(call=>call.sql.startsWith('UPDATE bot_conversations')).values[0],f.flow.start);
  assert.equal(JSON.parse(db.calls.find(call=>call.sql.startsWith('INSERT INTO bot_conversation_events')).values[2]).cause,'INITIAL_WELCOME');
  await assert.rejects(inspectDirectWelcomeResendInput(welcomeDatabase({cycle:null,progressed:false,pending:true}),f),/DIRECT_NATIVE_EFFECT_HOLD/);
});
test('partial, missing, uncertain, redacted, leased or wrong-provider welcome bursts hold without reset',async()=>{
  const f=welcomeFixture(),rows=(await welcomeDatabase().query('SELECT d.id,d.state',[])).rows;
  const invalid=[[],rows.slice(1),[rows[0],rows[0]],...['QUEUED','SENDING','OUTCOME_UNKNOWN','FAILED_TERMINAL','BLOCKED'].map(state=>[{...rows[0],state},rows[1]]),
    ...[{lease_id:'held'},{lease_expires_at:'2026-10-06T13:00:00Z'},{external_message_id:null},{provider_matched:false},
      {finished_at:null},{finished_at:'invalid'},{attempt_state:'OUTCOME_UNKNOWN'},{content_redacted_at:'2026-10-06T11:59:00Z'}].map(change=>[{...rows[0],...change},rows[1]])];
  for(const outputs of invalid){const db=welcomeDatabase({outputs});await assert.rejects(inspectDirectWelcomeResendInput(db,f),/DIRECT_PENDING_EFFECTS/);
    assert.equal(db.calls.some(c=>/^(UPDATE|INSERT)/u.test(c.sql)),false);}
  for(const cycle of [{flow_version_id:'foreign',delivery_ids:welcomeIds},{flow_version_id:welcomeVersion,delivery_ids:[]},
    {flow_version_id:welcomeVersion,delivery_ids:[welcomeIds[0],welcomeIds[0]]},{flow_version_id:welcomeVersion,delivery_ids:['invalid']}])
    await assert.rejects(inspectDirectWelcomeResendInput(welcomeDatabase({cycle}),f),/DIRECT_PENDING_EFFECTS/);
});
test('pending native or later provider effects block due welcome and query is exact tenant/conversation/output bound',async()=>{
  const f=welcomeFixture(),db=welcomeDatabase({pending:true});await assert.rejects(inspectDirectWelcomeResendInput(db,f),/DIRECT_NATIVE_EFFECT_HOLD/);
  const call=db.calls.find(c=>c.sql.startsWith('SELECT d.id,d.state'));
  assert.deepEqual(call.values,[ids.tenant,ids.conversation,ids.connection,f.chatId,welcomeIds]);
  assert.match(call.sql,/attempt.attempt_number=d.attempts/);assert.match(call.sql,/d.direct_origin='BOT'/);
  const held=welcomeDatabase(),baseQuery=held.query;held.query=(sql,values)=>sql.startsWith("SELECT 'delivery' AS kind")
    ?Promise.resolve({rows:[{kind:'delivery',id:'uncertain'}]}):baseQuery(sql,values);
  await assert.rejects(inspectDirectWelcomeResendInput(held,f),/DIRECT_PENDING_EFFECTS/);
});

for(const [explicitEntry,existing,entryAtStart,inertFirst,mainMenu] of [[false,false,false,false],[true,false,false,false],[true,true,false,false],[true,true,true,false],[false,true,false,true],[false,true,false,false,true]])test(`${mainMenu?'main-menu return to different node':inertFirst?'inert-first existing BOT':existing?'settled due BOT':'new own input'} ${explicitEntry?`selects ${entryAtStart?'start':'away'} entry before welcome`:'pins initial welcome'} once; duplicate source has no second effects`,async()=>{
 const definition={schemaVersion:1,name:'Owned welcome',start:'menu',maxSteps:10,welcomeResendMinutes:60,
  ...(mainMenu?{mainMenuNodeId:'legacy',keepOpenPolicy:policy}:{}),
  ...(explicitEntry?{entryCommands:[{id:'owned_entry',aliases:['Special topic'],target:entryAtStart?'menu':'legacy',enabled:true}]}:{}),nodes:[
  {id:'menu',type:'choice',prompt:'Welcome {{message.text}}',options:[{id:'agent',label:'Agent',next:'handoff'}]},
  {id:'handoff',type:'handoff',target:'FIXED',zammadGroupId:'2',priority:'2 normal',message:'Agent will join'},
  ...((explicitEntry&&!entryAtStart)||mainMenu?[{id:'legacy',type:'choice',prompt:'Special topic menu',options:[...(mainMenu?[{id:'tracking',label:'Tracking',next:'handoff'}]:[]),{id:'agent2',label:'Agent',next:'handoff'}]}]:[])]};
 const calls=[],outputs=[],events=[];let duplicate=false;
 const client={release(){},query:async(sql,values)=>{
  calls.push({sql,values});
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.includes('set_config')||sql.includes('pg_advisory_xact_lock')||sql.startsWith('SELECT zammad_ticket_id,zammad_ticket_number'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT 1 FROM normalized_messages'))return{rows:duplicate?[{}]:[],rowCount:duplicate?1:0};
  if(sql.startsWith('SELECT conversation.human_ownership_epoch'))return{rows:existing?[{...welcomeFixture().conversation,flow_version_id:welcomeVersion,current_node_id:'menu',variables:{'action.old':'must-not-leak'},step_count:5,zammad_ticket_number:'50041'}]:[],rowCount:existing?1:0};
  if(sql.startsWith("SELECT 'reply' AS kind")||sql.startsWith("SELECT 'delivery' AS kind"))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT safe_metadata')){assert(inertFirst,'Explicit entry must win before due welcome inspection');return{rows:[],rowCount:0};}
  if(sql.startsWith('SELECT 1 FROM bot_conversation_events')){assert(inertFirst);return{rows:[],rowCount:0};}
  if(sql.startsWith('SELECT assignment.flow_version_id'))return{rows:[{flow_version_id:welcomeVersion,start_node:'menu',state:'ACTIVE',definition}],rowCount:1};
  if(sql.startsWith('INSERT INTO normalized_messages'))return{rows:[{id:'normalized'}],rowCount:1};
  if(sql.startsWith('INSERT INTO bot_conversations'))return{rows:[{...welcomeFixture().conversation,id:ids.conversation,state:'BOT',flow_version_id:welcomeVersion,current_node_id:'menu',variables:{},step_count:0,zammad_ticket_number:'50041'}],rowCount:1};
  if(sql.startsWith('SELECT definition FROM bot_flow_versions'))return{rows:[{definition}],rowCount:1};
  if(sql.startsWith('INSERT INTO delivery_outbox')){outputs.push(values);return{rows:[{id:welcomeIds[0]}],rowCount:1};}
  if(sql.startsWith('INSERT INTO bot_conversation_events')){events.push(values);return{rows:[],rowCount:1};}
  if(sql.startsWith('INSERT INTO bot_handoff_jobs'))assert.fail('Initial text1 must render opted-in welcome, not select handoff');
  if(sql.startsWith('UPDATE normalized_messages')||sql.startsWith('INSERT INTO participant_identities')||sql.startsWith('INSERT INTO message_links')||sql.startsWith('INSERT INTO delivery_ticket_links')||sql.startsWith('UPDATE bot_conversations'))return{rows:[],rowCount:1};
  throw Error('Unexpected SQL '+sql);
 }};
 const repo=new InboundRepository({connect:async()=>client}),f=welcomeFixture();
 const event={id:ids.event,tenantId:ids.tenant,connectionId:ids.connection,provider:'waha'};
 const message={...f.message,input:{type:'text',text:mainMenu?'Main menu':explicitEntry?'Special topic':'1'},senderId:f.chatId};
 const selected=resolveBotEntryCommand(definition,existing?'menu':undefined,message.input,{});
 assert.deepEqual(selected,explicitEntry?{id:'owned_entry',target:entryAtStart?'menu':'legacy'}:null);
 const context={assignmentId:'own-assignment',assignmentZammadGroup:'2',zammadGroup:'2'};
 let nativeCreates=0,nativeAppends=0;const actions={create:async()=>{nativeCreates++;return{id:'41',number:'50041',articleId:'31'};},append:async()=>{assert(existing&&!duplicate);nativeAppends++;return'31';}};
 assert.equal((await repo.processDirectMessage(event,context,message,{id:8,login:'synthetic'},actions)).queued,true);
 assert.equal(outputs.length,1);assert.equal(outputs[0][8].nodeId,(explicitEntry&&!entryAtStart)||mainMenu?'legacy':'menu');
 const marker=JSON.parse(events.at(-1)[6]).welcome_cycle;
 assert.deepEqual(marker,explicitEntry&&!entryAtStart?undefined:{flow_version_id:welcomeVersion,delivery_ids:[welcomeIds[0]]});
 if(mainMenu){
  const next=welcomeFixture();next.flow=definition;next.conversation={...next.conversation,current_node_id:'legacy'};next.message={...next.message,input:{type:'text',text:'2'}};
  const old=[{id:ids.prompt,state:'FAILED_TERMINAL',lease_id:null,lease_expires_at:null,external_message_id:null,content_redacted_at:null,finished_at:'2026-10-06T11:00:00Z',attempt_state:'FAILED_TERMINAL',provider_matched:false}];
  await assert.rejects(inspectDirectWelcomeResendInput(welcomeDatabase({cycle:{flow_version_id:welcomeVersion,delivery_ids:[ids.prompt]},outputs:old}),next),/DIRECT_PENDING_EFFECTS/);
  const fresh={id:welcomeIds[0],state:'SENT',lease_id:null,lease_expires_at:null,external_message_id:'provider-menu',content_redacted_at:null,finished_at:'2026-10-06T11:59:59Z',attempt_state:'SENT',provider_matched:true};
  for(const state of ['QUEUED','OUTCOME_UNKNOWN'])await assert.rejects(inspectDirectWelcomeResendInput(welcomeDatabase({cycle:marker,outputs:[{...fresh,state}]}),next),/DIRECT_PENDING_EFFECTS/);
  assert.equal(await inspectDirectWelcomeResendInput(welcomeDatabase({cycle:marker,outputs:[fresh]}),next),null);
  assert.equal(advanceBotFlow(parseBotFlow(definition),'legacy',next.message.input,{}).state,'HANDOFF');
  assert.equal(old[0].state,'FAILED_TERMINAL','old failed history is never rewritten');
 }
 assert(calls.findIndex(c=>c.sql.startsWith('INSERT INTO delivery_outbox'))<calls.findIndex(c=>c.sql.startsWith('INSERT INTO bot_conversation_events')&&c.sql.includes('event_inbox_id')));
 assert.equal(calls.at(-1).sql,'COMMIT');duplicate=true;
 assert.equal((await repo.processDirectMessage(event,context,message,{id:8,login:'synthetic'},actions)).duplicate,true);
 assert.equal(outputs.length,1);assert.equal(nativeCreates,existing?0:1);assert.equal(nativeAppends,existing?1:0);assert.equal(events.length,inertFirst||mainMenu?2:1);
});


test('configured handoff label changes one post-success REQUEST prompt only',async()=>{
  for(const configured of [false,true]){
    const calls=[],definition={schemaVersion:1,name:'Pinned handoff',start:'handoff',mainMenuNodeId:'menu',maxSteps:8,keepOpenPolicy:policy,
      nodes:[{id:'handoff',type:'handoff',target:'CLIENT_PRIMARY',priority:'2 normal',message:'Our team will follow up',
        ...(configured?{mainMenuReturn:{label:'Main Menu'}}:{})},
        {id:'menu',type:'choice',prompt:'Menu',options:[{id:'agent',label:'Talk to us',next:'handoff'}]}]};
    const client={query:async(sql,values)=>{calls.push({sql,values});
      if(sql.startsWith('SELECT conversation.connection_id'))return{rows:[{connection_id:ids.connection,external_chat_id:'12025550120@c.us',zammad_ticket_id:'41',human_ownership_epoch:'3',definition}],rowCount:1};
      if(sql.startsWith('SELECT 1 FROM delivery_outbox'))return{rows:[],rowCount:0};return{rows:[],rowCount:1};}};
    const repository=Object.create(OutboxRepository.prototype);repository.tenant=async(_tenant,action)=>action(client);
    await repository.completeBotHandoff({tenantId:ids.tenant,id:ids.event,conversationId:ids.conversation,handoffNodeId:'handoff',fencingToken:1},ids.prompt);
    const insertions=calls.filter(call=>call.sql.startsWith('INSERT INTO delivery_outbox'));assert.equal(insertions.length,1);
    const content=JSON.parse(insertions[0].values[8]);assert.deepEqual(content.options.map(o=>o.label),[configured?'Main Menu':'Main menu','Resolve my ticket']);
    const human=calls.findIndex(call=>call.sql.includes("SET state='HUMAN'"));
    assert(human>=0&&human<calls.indexOf(insertions[0]));assert.match(calls[human].sql,/human_pause_started_at=now\(\)/u);
    assert.equal(calls.filter(call=>call.sql.includes("SET state='SUCCEEDED'")).length,1);
  }
});

test('pending BOT outputs prevent handoff completion and configured controls',async()=>{
  for(const held of ['QUEUED','OUTCOME_UNKNOWN','BLOCKED']){
    const calls=[],client={query:async(sql,values)=>{calls.push({sql,values});
      if(sql.startsWith('SELECT 1 FROM delivery_outbox'))return{rows:[{state:held}],rowCount:1};return{rows:[],rowCount:1};}};
    const repository=Object.create(OutboxRepository.prototype);repository.tenant=async(_tenant,action)=>action(client);
    await assert.rejects(repository.completeBotHandoff({tenantId:ids.tenant,id:ids.event,conversationId:ids.conversation,handoffNodeId:'handoff',fencingToken:1},ids.prompt),/Bot replies are still pending/);
    assert.equal(calls.some(call=>/^(INSERT|UPDATE)/u.test(call.sql)),false);
  }
});

test('MAIN_MENU uses explicit target while expiry still restarts welcome; neither closes native ticket',async()=>{
  for(const [kind,target]of [['MAIN_MENU','step_1'],['EXPIRED','welcome']]){
    const f=fixture();f.flow={...f.flow,start:'welcome',mainMenuNodeId:'step_1'};const db=database();
    assert.deepEqual(await applyDirectKeepOpenInput(db,f,{kind,snapshot:null}),{handled:false,resumed:true,queued:false});
    const update=db.calls.find(c=>c.sql.startsWith('UPDATE bot_conversations'));assert.deepEqual(update.values,[target,ids.tenant,ids.conversation]);
    assert.match(update.sql,/variables='\{\}',step_count=0/u);assert.equal(db.calls.length,2);
    assert.equal(db.calls.some(c=>c.sql.includes('direct_customer_close_commands')||c.sql.includes('delivery_outbox')),false);
  }
  for(const target of [undefined,null]){const f=fixture();f.flow={...f.flow,start:'welcome',mainMenuNodeId:target};const db=database();
    await applyDirectKeepOpenInput(db,f,{kind:'MAIN_MENU',snapshot:null});assert.equal(db.calls[0].values[0],'welcome');}
});

test('custom-label control keeps exact native binding and bounded numeric fallback',async()=>{
  const writes=database(),s=await queueCustomerControlPrompt(writes,{tenantId:ids.tenant,connectionId:ids.connection,eventId:ids.event,
    chatId:fixture().chatId,conversationId:ids.conversation,ticketId:'41',epoch:3,phase:'REQUEST',mainMenu:true,customerResolution:false,arabic:false,mainMenuLabel:'Main Menu'});
  const reads=(options={})=>{const db=database(options),query=db.query;db.query=async(sql,values)=>{
    const result=await query(sql,values);if(sql.startsWith('SELECT external_message_id,state'))result.rows[0].bot_content.controlId=s.promptDeliveryId;return result;};return db;};
  assert.equal(s.options.length,1);const f=fixture({customer_control:s,human_pause_started_at:new Date().toISOString()});f.message.timestamp=new Date(Date.now()+1000).toISOString();
  f.message.input={type:'choice',source:'META_NATIVE',choiceId:s.options[0].id,label:'Main Menu'};f.message.quotedMessageId='provider-owned-prompt';
  assert.equal((await inspectDirectKeepOpenInput(reads(),f)).kind,'MAIN_MENU');
  for(const text of ['1','١','۱']){f.message.input={type:'text',text};assert.equal((await inspectDirectKeepOpenInput(reads(),f)).kind,'MAIN_MENU');}
  f.message.input={type:'text',text:'1'};assert.equal(await inspectDirectKeepOpenInput(reads(),{...f,conversation:{...f.conversation,customer_control:null}}),null);
  for(const change of [{customerId:9},{assignmentActive:false},{message:{...f.message,fromMe:true}},
    ...['HANDOFF_PENDING','ACTION_PENDING','RESOLVED'].map(state=>({conversation:{...f.conversation,state}})),
    {conversation:{...f.conversation,customer_control:{...s,epoch:2}}},
    {message:{...f.message,timestamp:'2000-01-01T00:00:00Z'}},
    {message:{...f.message,input:{type:'choice',source:'META_NATIVE',choiceId:s.options[0].id,label:'Main Menu'},quotedMessageId:'foreign'}}])
    assert.equal(await inspectDirectKeepOpenInput(reads(),{...f,...change}),null);
  for(const promptState of ['QUEUED','SENDING','OUTCOME_UNKNOWN','BLOCKED'])assert.equal(await inspectDirectKeepOpenInput(reads({promptState}),f),null);
  await assert.rejects(inspectDirectKeepOpenInput(reads({pending:true}),f),/DIRECT_NATIVE_EFFECT_HOLD/);
});

test('custom Main Menu label renders through real Meta buttons and WAHA numbered text',async()=>{
  const writes=database();const s=await queueCustomerControlPrompt(writes,{tenantId:ids.tenant,connectionId:ids.connection,eventId:ids.event,
    chatId:fixture().chatId,conversationId:ids.conversation,ticketId:'41',epoch:3,phase:'REQUEST',mainMenu:true,customerResolution:true,arabic:true,mainMenuLabel:'القائمة الرئيسية'});
  const insertion=writes.calls.find(call=>call.sql.startsWith('INSERT INTO delivery_outbox')),content=JSON.parse(insertion.values[8]),text=insertion.values[6];
  let metaBody,wahaBody;const originalFetch=globalThis.fetch;
  try{globalThis.fetch=async(url,init)=>{const body=JSON.parse(init.body);if(String(url).startsWith('https://graph.test/')){metaBody=body;return new Response(JSON.stringify({messages:[{id:'wamid.handoff-proof'}]}),{status:200,headers:{'content-type':'application/json'}})}
    wahaBody=body;return new Response(JSON.stringify({id:'waha-handoff-proof'}),{status:200,headers:{'content-type':'application/json'}});};
    const common={connectionId:ids.connection,recipientType:'DIRECT',text,choices:{options:content.options},idempotencyKey:'handoff-menu-contract'};
    const meta=new MetaGroupsAdapter({accessToken:'synthetic-handoff-contract-token',graphVersion:'v24.0',baseUrl:'https://graph.test',phoneNumberIdFor:()=> '123456789'});
    const waha=new WahaAdapter({baseUrl:'https://waha.test',apiKey:'synthetic-handoff-key',sessionFor:()=> 'handoff-test'});
    assert.equal((await meta.send({...common,groupId:'12025550120'})).state,'SENT');assert.equal((await waha.send({...common,groupId:'12025550120@c.us'})).state,'SENT');
    assert.deepEqual(metaBody.interactive.action.buttons.map(button=>({id:button.reply.id,label:button.reply.title})),content.options);
    assert.equal(wahaBody.text,[text,...content.options.map((option,index)=>`${index+1}. ${option.label}`)].join('\n'));
    assert.deepEqual(s.options.map(o=>o.kind),['MAIN_MENU','RESOLUTION_REQUEST']);
  }finally{globalThis.fetch=originalFetch;}
});



function actionWelcomeFixture({interval=60,next='answer'}={}){
 const flow=parseBotFlow({schemaVersion:1,name:'Pinned action welcome',start:'menu',maxSteps:10,
  ...(interval===undefined?{}:{welcomeResendMinutes:interval}),nodes:[
   {id:'menu',type:'choice',prompt:'Welcome',options:[{id:'lookup',label:'Lookup',next:'lookup'},{id:'more',label:'More',next:'other'}]},
   {id:'lookup',type:'action',actionId:'synthetic.lookup',input:{},onSuccess:'answer',onFailure:'menu'},
   {id:'answer',type:'send_text',text:'Finished',next:'menu'},
   {id:'other',type:'choice',prompt:'Other menu',options:[{id:'back',label:'Back',next:'menu'}]}]});
 const job={origin:'DIRECT_FLOW',tenantId:ids.tenant,id:ids.event,conversationId:ids.conversation,sourceEventId:ids.request,
  actionNodeId:'lookup',fencingToken:4,flowDefinition:flow,conversationVariables:{'message.text':'Lookup'},
  onSuccessNodeId:next,onFailureNodeId:'menu'};
 return{flow,job,advanced:advanceBotFlow(flow,next,undefined,job.conversationVariables)};
}
function actionWelcomeDatabase({current=true,skipInsert=false}={}){
 const calls=[],outputs=[],events=[];let active=current;
 const client={release(){},query:async(sql,values)=>{
  calls.push({sql,values});
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.includes('set_config'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT conversation.external_chat_id'))return{rows:active?[{external_chat_id:'12025550120@c.us',zammad_ticket_id:'41',flow_version_id:welcomeVersion}]:[],rowCount:active?1:0};
  if(sql.startsWith('INSERT INTO delivery_outbox')){
   if(skipInsert)return{rows:[],rowCount:0};
   const id=welcomeIds[outputs.length];assert(id);outputs.push({id,values});return{rows:[{id}],rowCount:1};
  }
  if(sql.startsWith('INSERT INTO bot_conversation_events')){events.push(values);return{rows:[],rowCount:1};}
  if(sql.startsWith('UPDATE bot_conversations'))return{rows:[],rowCount:1};
  if(sql.startsWith('UPDATE bot_action_jobs')){active=false;return{rows:[],rowCount:1};}
  throw Error('Unexpected action completion SQL '+sql);
 }};
 return{client,calls,outputs,events,repository:new OutboxRepository({connect:async()=>client})};
}
for(const terminalState of ['SUCCEEDED','FAILED_TERMINAL'])test(`action-completed welcome ${terminalState} records its full created burst once and resets the interval only after delivery`,async()=>{
 const f=actionWelcomeFixture({next:terminalState==='SUCCEEDED'?'answer':'menu'}),db=actionWelcomeDatabase();
 const variables=terminalState==='SUCCEEDED'?{'action.status':'ready'}:{};
 assert.deepEqual(await db.repository.completeBotAction(f.job,ids.prompt,terminalState,variables,f.advanced),{queued:true,state:'BOT'});
 const expectedIds=terminalState==='SUCCEEDED'?welcomeIds:[welcomeIds[0]];
 assert.deepEqual(db.outputs.map(row=>row.id),expectedIds);
 const metadata=JSON.parse(db.events[0][5]);
 assert.deepEqual(metadata,{action_state:terminalState,response_variables:Object.keys(variables),welcome_cycle:{flow_version_id:welcomeVersion,delivery_ids:expectedIds}});
 assert.equal(db.events[0][2],terminalState==='SUCCEEDED'?'ACTION_SUCCEEDED':'ACTION_FAILED');
 const current=db.calls.find(row=>row.sql.startsWith('SELECT conversation.external_chat_id'));
 assert.deepEqual(current.values,[ids.tenant,f.job.id,ids.prompt,4,terminalState]);
 assert.match(current.sql,/action\.state='RUNNING'[\s\S]*action\.execution_result_state=\$5[\s\S]*action\.lease_expires_at>=now\(\)[\s\S]*conversation\.state='ACTION_PENDING'[\s\S]*conversation\.current_node_id=action\.action_node_id FOR UPDATE OF action,conversation/);
 assert(db.calls.findIndex(row=>row.sql.startsWith('INSERT INTO delivery_outbox'))<db.calls.findIndex(row=>row.sql.startsWith('INSERT INTO bot_conversation_events')));
 const own=welcomeFixture();own.flow=f.flow;
 const outputs=expectedIds.map((id,index)=>({id,state:'SENT',lease_id:null,lease_expires_at:null,external_message_id:'provider-'+id,
  content_redacted_at:null,finished_at:`2026-10-06T11:${index?'20':'10'}:00Z`,attempt_state:'SENT',provider_matched:true}));
 assert.equal(await inspectDirectWelcomeResendInput(welcomeDatabase({cycle:metadata.welcome_cycle,outputs}),own),null,'the old due cycle must not trigger an immediate second welcome');
 own.message.timestamp=terminalState==='SUCCEEDED'?'2026-10-06T12:20:00Z':'2026-10-06T12:10:00Z';
 assert.equal((await inspectDirectWelcomeResendInput(welcomeDatabase({cycle:metadata.welcome_cycle,outputs}),own)).kind,'WELCOME_RESEND');
 await assert.rejects(db.repository.completeBotAction(f.job,ids.prompt,terminalState,variables,f.advanced),/lease or conversation state was lost/);
 assert.equal(db.events.length,1);assert.equal(db.outputs.length,expectedIds.length);
});
test('action-completed welcome does not mark absent/null policy, a different menu or an uncreated output',async()=>{
 for(const [interval,next,skipInsert] of [[null,'answer',false],[undefined,'answer',false],[60,'other',false],[60,'answer',true]]){
  const f=actionWelcomeFixture({interval,next});if(interval===undefined){delete f.flow.welcomeResendMinutes;f.job.flowDefinition=f.flow;}
  const db=actionWelcomeDatabase({skipInsert});
  await db.repository.completeBotAction(f.job,ids.prompt,'SUCCEEDED',{},f.advanced);
  assert.equal('welcome_cycle' in JSON.parse(db.events[0][5]),false);
 }
});
test('action-completed welcome never creates output or a cycle after a lost result, lease or conversation fence',async()=>{
 const f=actionWelcomeFixture(),db=actionWelcomeDatabase({current:false});
 await assert.rejects(db.repository.completeBotAction(f.job,ids.prompt,'SUCCEEDED',{},f.advanced),/lease or conversation state was lost/);
 assert.equal(db.outputs.length,0);assert.equal(db.events.length,0);
 assert.equal(db.calls.some(row=>/^(INSERT|UPDATE)/u.test(row.sql)),false);assert.equal(db.calls.at(-1).sql,'ROLLBACK');
});
