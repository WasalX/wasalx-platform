import assert from 'node:assert/strict';
import test from 'node:test';
import {enqueueTicketEventFeedback,resolveTicketReferenceMessages,ticketEventFeedbackBatches,ticketEventSourceHash} from '../packages/core/dist/ticket-event-runtime.js';
import {InboundRepository} from '../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js';
import {OutboxRepository} from '../services/connector-worker/dist/services/connector-worker/src/repository.js';
import {ZammadTicketStateController} from '../services/control-api/dist/zammad-ticket-state.controller.js';
const tenantId='10000000-0000-4000-8000-000000000001',instanceId='11000000-0000-4000-8000-000000000001';
const event={id:'source',tenantId,connectionId:'connection',provider:'waha',providerEventId:'provider-source',eventType:'message',payload:{},attempts:1};
const context={bindingId:'binding',groupName:'Support',acknowledgementTemplate:'Cases {{tickets}} ({{count}})'};
const message={provider:'waha',connectionId:'connection',eventId:'provider-source',messageId:'source-message',groupId:'fixture-0019@example.test',participantId:'fixture-0026@example.test',text:'REF123',fromMe:false,fromApi:false,timestamp:new Date().toISOString()};
function flow(kind,text='Feedback {{case.transition}}',reaction=false){return{schemaVersion:1,kind:'TICKET_EVENT',name:'Case feedback',event:kind,start:'send',maxSteps:4,nodes:[reaction?{id:'send',type:'reaction',emoji:'✅',quote:'ORIGINAL',next:'done'}:{id:'send',type:'send_text',text,quote:'ORIGINAL',next:'done'},{id:'done',type:'end'}]};}
function database({mode='CUSTOM',kind='reference_received',initial='OPEN',reaction=false}={}){
 const executions=[],deliveries=[],queries=[],links=new Set(),disclosures=[];
 const state={mode,initial,closed:false,blocked:false,stale:false,eligible:true,commandHeld:false,stored:null,version:'version-old',flow:flow(kind,undefined,reaction)};
 const correlation={id:'correlation',group_binding_id:'binding',zammad_ticket_id:'42',zammad_ticket_number:'1042',normalized_reference:'REF123',state:initial,generation:1,original_external_message_id:'original',whatsapp_group_id:'group',connection_id:'connection',external_group_id:'fixture-0019@example.test',group_name:'Support',provider:'WAHA'};
 const result=rows=>({rows,rowCount:rows.length});
 const client={release(){},query:async(sql,values=[])=>{
  queries.push({sql,values});
  if(sql.includes('WITH quote_identities'))return result([{external_message_id:values[3],ambiguous:false}]);
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.includes('set_config')||sql.includes('pg_advisory_xact_lock'))return result([{}]);
  if(sql.includes('FROM zammad_instances'))return result([{id:instanceId}]);
  if(sql.includes('SELECT execution.id FROM ticket_event_executions execution')){assert.deepEqual(values,[tenantId,'42',null]);return result(state.commandHeld?[{id:'held-command'}]:[]);}
  if(sql.includes('INSERT INTO zammad_ticket_state_events')){if(state.stored)return result([]);state.stored={id:'native-event',request_sha256:values[3],processing_state:'ACCEPTED',correlations_updated:0};return result([{...state.stored}]);}
  if(sql.startsWith('SELECT id,request_sha256'))return result([{...state.stored}]);
  if(sql.includes(' AS stale'))return result([{stale:state.stale}]);
  if(sql.includes('FROM case_correlations correlation')&&sql.includes("correlation.state='OPEN'"))return result(!state.closed?[correlation]:[]);
  if(sql.includes('UPDATE case_correlations')&&sql.includes('zammad_state_id=$2')){if(state.closed)return result([]);state.closed=true;correlation.state='RESOLVED';return result([{id:correlation.id}]);}
  if(sql.includes('FROM bot_conversations'))return result(state.blocked?[{id:'direct',current_node_id:'handoff',eligible:true}]:[]);
  if(sql.includes("SELECT 'delivery'"))return result(state.blocked?[{kind:'delivery',id:'inflight'}]:[]);
  if(sql.includes(' AS exists'))return result([{exists:true}]);
  if(sql.includes('execution.id AS execution_id'))return result(executions.filter(row=>row.event==='ticket_closed'&&row.state==='PENDING').map(row=>({...correlation,execution_id:row.id,mode:row.mode,flow_version_id:row.flow_version_id,eligible:state.eligible})));
  if(sql.startsWith('UPDATE zammad_ticket_state_events')||sql.trimStart().startsWith('UPDATE zammad_ticket_state_events')){state.stored.processing_state=values[0];state.stored.correlations_updated=values[1];return result([{...state.stored}]);}
  if(sql.includes('INSERT INTO audit_events'))return result([{}]);
  if(sql.startsWith('SELECT zammad_ticket_id FROM case_correlations'))return result(initial==='NONE'?[]:[correlation]);
  if(sql.includes('SELECT normalized_reference FROM case_correlations'))return result([correlation]);
  if(sql.includes('SELECT id,zammad_ticket_id,zammad_ticket_number,state,generation'))return result(initial==='NONE'?[]:[correlation]);
  if(sql.startsWith('SELECT 1 FROM message_links'))return result(links.has(values[2])?[{}]:[]);
  if(sql.includes('SELECT id,generation'))return result([]);
  if(sql.includes('INSERT INTO case_correlations')){correlation.state='OPEN';return result([correlation]);}
  if(sql.includes('UPDATE case_correlations')){correlation.state='OPEN';return result([{}]);}
  if(sql.startsWith('INSERT INTO message_links')){links.add(values[2]);return result([{}]);}
  if(sql.includes('SELECT binding.whatsapp_group_id'))return result([{whatsapp_group_id:'group',original_external_message_id:'original'}]);
  if(sql.startsWith('SELECT mode,flow_version_id'))return result(state.mode==='LEGACY'?[]:[{mode:state.mode,flow_version_id:state.mode==='CUSTOM'?state.version:null}]);
  if(sql.startsWith('SELECT id,tenant_id,correlation_id'))return result(executions.filter(row=>row.correlation_id===values[1]&&row.event===values[2]&&row.source_sha256===values[3]));
  if(sql.includes('INSERT INTO ticket_event_executions')){const row={id:'execution-'+executions.length,tenant_id:values[0],correlation_id:values[1],event:values[2],source_sha256:values[3],mode:values[4],flow_version_id:values[5],state:'PENDING'};executions.push(row);return result([row]);}
  if(sql==='SELECT app.group_rule_sender($1,$2,$3,$4) AS sender')return result([{sender:'customer'}]);
  if(sql.includes('SELECT link.external_message_id'))return result([{external_message_id:values[4]??message.messageId}]);
  if(sql.startsWith('SELECT definition'))return result([{definition:state.flow}]);
  if(sql.startsWith('UPDATE ticket_event_executions SET state=')){executions.find(row=>row.id===values[2]).state=values[0];return result([{}]);}
  if(sql.includes('SELECT correlation.zammad_ticket_id,correlation.zammad_ticket_number,execution.mode'))return result(executions.filter(row=>row.event==='reference_received').map(row=>({...correlation,mode:row.mode})));
  if(sql.startsWith("UPDATE ticket_event_executions execution SET state='APPLIED'")){for(const row of executions)if(row.mode==='LEGACY'&&row.state==='PENDING')row.state='APPLIED';return result([{}]);}
  if(sql.startsWith('SELECT id,content_redacted_at FROM delivery_outbox'))return result(deliveries.filter(row=>row.key===values[1]).map(row=>({id:row.id,content_redacted_at:null})));
  if(sql.startsWith('SELECT 1 FROM group_bindings'))return result([{}]);
  if(sql.includes('SELECT 1 FROM group_disclosure_deliveries'))return result(disclosures.includes(values[2])?[{}]:[]);
  if(sql.includes('INSERT INTO group_disclosure_deliveries')){disclosures.push(values[2]);return result([{}]);}
  if(sql.trimStart().startsWith('INSERT INTO delivery_outbox')){const custom=sql.includes('ticket_event_execution_id');const item={id:'delivery-'+deliveries.length,body:values[custom?4:5],key:values[custom?7:7],reply:values[custom?6:6],type:custom?values[5]:'text/plain',custom};deliveries.push(item);return result([{id:item.id}]);}
  if(sql.startsWith('INSERT INTO delivery_ticket_links'))return result([{}]);
  throw new Error('Unexpected query '+sql);
 }};
 return{client,state,executions,deliveries,queries,disclosures};
}
const actions={create:async()=>({id:'42',number:'1042'}),append:async()=> '100',reopen:async()=>new Date().toISOString()};

test('trigger-only feedback covers direct and quoted references, not ordinary or unrelated follow-ups',async()=>{
 for(const initial of ['NONE','OPEN','RESOLVED'])for(const quoted of [false,true])for(const matched of [false,true]){
  if(initial==='NONE'&&quoted)continue;
  const db=database({initial}),repo=new InboundRepository({connect:async()=>db.client});
  db.state.flow={...flow('reference_received'),start:'matched',nodes:[
   {id:'matched',type:'condition',variable:'message.matches_reference',operator:'eq',value:true,onTrue:'react',onFalse:'done'},
   {id:'react',type:'reaction',emoji:'⏳',quote:'CURRENT',next:'done'},{id:'done',type:'end'},
  ]};
  const current={...message,messageId:'delayed-trigger',timestamp:'2020-01-01T00:00:00Z'};
  if(quoted)await repo.linkQuotedMessage(event,current,'42',context,actions,matched?['REF123']:['OTHER']);
  else await repo.correlate(event,context,current,'REF123',actions,undefined,matched);
  assert.equal(db.deliveries.length,matched?1:0);
  if(matched){assert.equal(db.deliveries[0].reply,'delayed-trigger');assert.equal(db.deliveries[0].body,'⏳');}
 }
});
test('received feedback covers create, append and reopen, and replay never switches activation',async()=>{
 for(const [initial,transition] of [['NONE','CREATED'],['OPEN','APPENDED'],['RESOLVED','REOPENED']]){
  const db=database({initial}),repo=new InboundRepository({connect:async()=>db.client});
  const first=await repo.correlate(event,context,message,'REF123',actions);
  assert.equal(first.feedbackQueued,true);assert.equal(db.deliveries[0].body,'Feedback '+transition);assert.equal(db.deliveries[0].reply,'original');
  db.state.mode='OFF';db.state.version='version-new';
  await repo.correlate(event,context,message,'REF123',actions);
  assert.equal(db.deliveries.length,1);assert.equal(db.executions[0].flow_version_id,'version-old');assert.equal(db.executions[0].state,'APPLIED');
 }
});
test('manual agent messages run managed events; quoted legacy follow-ups and manual legacy skip ACK',async()=>{
 const custom=database(),managed=new InboundRepository({connect:async()=>custom.client});
 assert.equal((await managed.correlate(event,context,{...message,fromMe:true},'REF123',actions)).feedbackQueued,true);
 assert.equal(custom.queries.some(q=>q.sql.includes('app.group_rule_sender')),false);
 for(const quoted of [false,true]){const db=database({mode:'LEGACY'}),repo=new InboundRepository({connect:async()=>db.client});await repo.correlate(event,context,{...message,fromMe:!quoted},'REF123',actions,quoted?'42':undefined);assert.equal(db.executions[0].state,'SKIPPED');assert.equal(db.deliveries.length,0);}
});
test('CUSTOM and OFF suppress ordinary ACK but preserve one-time disclosure and command responses',async()=>{
 for(const mode of ['CUSTOM','OFF']){
  const db=database({mode,reaction:true}),repo=new InboundRepository({connect:async()=>db.client});
  await repo.correlate(event,context,message,'REF123',actions);
  const id=await repo.enqueueAcknowledgement(event,context,message,'Legacy acknowledgement',['42'],'Disclosure');
  assert.ok(id);assert.deepEqual(db.deliveries.filter(row=>!row.custom).map(row=>row.body),['Disclosure']);
  await repo.enqueueAcknowledgement(event,context,message,'Ignored changed acknowledgement',['42'],'Disclosure');assert.equal(db.disclosures.length,1);
  const next={...message,messageId:'next'};await repo.correlate(event,context,next,'REF123',actions);
  assert.equal(await repo.enqueueAcknowledgement(event,context,next,'Legacy acknowledgement',['42'],'Disclosure'),null);
  const command={...message,messageId:'command'};await repo.correlate(event,context,command,'REF123',actions);
  await repo.enqueueAcknowledgement(event,context,command,'External action result',['42'],'Disclosure',undefined,true);
  assert.equal(db.deliveries.at(-1).body,'External action result');
 }
});
test('legacy ACK bytes are unchanged and completion happens in its transaction',async()=>{
 const db=database({mode:'LEGACY'}),repo=new InboundRepository({connect:async()=>db.client});
 await repo.correlate(event,context,message,'REF123',actions);assert.equal(db.executions[0].state,'PENDING');
 await repo.enqueueAcknowledgement(event,context,message,'Original ACK',['42'],'Disclosure');
 assert.equal(db.deliveries[0].body,'Original ACK\n\nDisclosure');assert.equal(db.executions[0].state,'APPLIED');
 assert.ok(db.queries.findLastIndex(q=>q.sql.startsWith('UPDATE ticket_event_executions execution'))<db.queries.findLastIndex(q=>q.sql==='COMMIT'));
});
test('mixed managed and legacy cases acknowledge only the legacy case numbers',async()=>{
 const db=database(),query=db.client.query;
 db.client.query=async(sql,values)=>sql.includes('SELECT correlation.zammad_ticket_id,correlation.zammad_ticket_number,execution.mode')
  ?{rows:[{zammad_ticket_id:'42',zammad_ticket_number:'1042',mode:'CUSTOM'},{zammad_ticket_id:'43',zammad_ticket_number:'1043',mode:'LEGACY'}],rowCount:2}:query(sql,values);
 const repo=new InboundRepository({connect:async()=>db.client});
 await repo.enqueueAcknowledgement(event,context,message,'Cases 1042, 1043 (2)',['42','43'],null);
 assert.equal(db.deliveries[0].body,'Cases 1043 (1)');
});
function callback(db){const controller=new ZammadTicketStateController({withTenant:async(_,fn)=>fn(db.client)},{verify:async()=>({tenantId,instanceId})});const at=new Date(Date.now()-1000).toISOString();const body={tenant_id:tenantId,ticket_id:42,ticket_number:'1042',state_id:4,state_name:'closed',state_type_name:'closed',transitioned_at:at,idempotency_key:'native-close-'+at};return()=>controller.ticketState(undefined,body.idempotency_key,'request',body);}
test('closed callback queues once against original trigger; duplicate does not enqueue',async()=>{
 const db=database({kind:'ticket_closed'}),invoke=callback(db);
 assert.equal((await invoke()).state,'APPLIED');assert.equal(db.deliveries[0].body,'Feedback CLOSED');assert.equal(db.deliveries[0].reply,'original');
 assert.equal((await invoke()).duplicate,true);assert.equal(db.deliveries.length,1);
});
test('blocked close pins version and retries the same transition after effects settle',async()=>{
 const db=database({kind:'ticket_closed'}),invoke=callback(db);db.state.blocked=true;
 assert.equal((await invoke()).state,'BLOCKED_EFFECTS');assert.equal(db.executions[0].state,'PENDING');assert.equal(db.deliveries.length,0);
 db.state.mode='OFF';db.state.version='version-new';db.state.blocked=false;
 assert.equal((await invoke()).state,'APPLIED');assert.equal(db.executions[0].flow_version_id,'version-old');assert.equal(db.deliveries.length,1);
 await invoke();assert.equal(db.deliveries.length,1);
});
test('stale or reopened held closes retire feedback without sending',async()=>{
 for(const stale of [false,true]){const db=database({kind:'ticket_closed'}),invoke=callback(db);db.state.blocked=true;await invoke();db.state.blocked=false;db.state.stale=stale;db.state.eligible=false;assert.equal((await invoke()).state,'IGNORED_STALE');assert.equal(db.executions[0].state,'SKIPPED');assert.equal(db.deliveries.length,0);}
});
test('close feedback send fence cancels stale effects before provider authorization',async()=>{
 const queries=[];const repo=Object.create(OutboxRepository.prototype);repo.queueStatus=async()=>queries.push('status');
 repo.tenant=async(_,fn)=>fn({query:async(sql)=>{queries.push(sql);if(sql.startsWith('SELECT state FROM connections'))return{rows:[{state:'WORKING'}],rowCount:1};if(sql.includes('FROM connection_operations'))return{rows:[],rowCount:0};if(sql.includes("safe_error='Close feedback"))return{rows:[{id:'delivery'}],rowCount:1};return{rows:[],rowCount:0};}});
 assert.equal(await repo.beginSend({id:'delivery',tenantId,connectionId:'connection',attempts:1,provider:'waha'},'lease'),false);
 assert.equal(queries.some(q=>q.includes('authorize_waha_outbound_send')),false);assert.equal(queries.some(q=>q.includes("SET state='SENDING'")),false);
 assert.ok(queries.some(q=>q.includes("correlation.state<>'RESOLVED' OR correlation.updated_at>execution.created_at")));assert.equal(queries.at(-1),'status');
});

test('held quoted command prevents append and reopen before native actions or event feedback',async()=>{
 for(const initial of ['OPEN','RESOLVED']){
  const db=database({initial});db.state.commandHeld=true;let nativeActions=0;
  const blockedActions={create:async()=>{nativeActions++;return{id:'42',number:'1042'}},append:async()=>{nativeActions++;return'100'},reopen:async()=>{nativeActions++;return new Date().toISOString()}};
  const repo=new InboundRepository({connect:async()=>db.client});
  await assert.rejects(()=>repo.correlate(event,context,message,'REF123',blockedActions),/QUOTED_COMMAND_EFFECT_HOLD/);
  assert.equal(nativeActions,0);assert.equal(db.executions.length,0);assert.equal(db.deliveries.length,0);
  assert.equal(db.queries.some(q=>/^(?:INSERT|UPDATE|DELETE)\b/u.test(q.sql.trim())),false);
 }
});

test('held quoted command defers exactly the claimed delivery and lost lease never reaches provider authorization',async()=>{
 for(const leaseOwned of [true,false]){
  const calls=[];const repo=Object.create(OutboxRepository.prototype);
  repo.tenant=async(scope,work)=>{assert.equal(scope,tenantId);return work({query:async(sql,values=[])=>{
   calls.push({sql,values});
   if(sql.includes('pg_advisory_xact_lock')){assert.deepEqual(values,[tenantId,'42',null]);return{rows:[],rowCount:1};}
   if(sql.includes('SELECT execution.id FROM ticket_event_executions execution'))return{rows:[{id:'pending-command'}],rowCount:1};
   if(sql.includes("safe_error='Ticket command outcome is pending.'")){assert.deepEqual(values,[tenantId,'delivery','lease']);return{rows:[],rowCount:leaseOwned?1:0};}
   if(sql.startsWith('DELETE FROM delivery_attempts')){assert.deepEqual(values,[tenantId,'delivery',2]);return{rows:[],rowCount:1};}
   throw Error('Unexpected post-command-fence worker query');
  }})};
  const invoke=()=>repo.beginSend({id:'delivery',tenantId,connectionId:'connection',ticketId:'42',attempts:2,provider:'waha'},'lease');
  if(leaseOwned)assert.equal(await invoke(),false);else await assert.rejects(invoke,/lease was lost/);
  assert.equal(calls.some(call=>call.sql.includes('authorize_waha_outbound_send')||call.sql.includes("SET state='SENDING'")),false);
  assert.equal(calls.filter(call=>call.sql.startsWith('DELETE FROM delivery_attempts')).length,leaseOwned?1:0);
 }
});


test('reference targets require exact original correlation receipts; unavailable targets are not substituted',async()=>{
 const values=[];let candidates=[{external_message_id:'trigger-1',eligible:true},{external_message_id:'trigger-2',eligible:true},
   {external_message_id:'foreign-generation',eligible:true},{external_message_id:'revoked',eligible:false}];
 const client={query:async(sql,args)=>{values.push(args);
   if(sql.startsWith('SELECT id FROM ticket_event_executions'))return{rows:[{id:'close'}],rowCount:1};
   if(sql.includes('SELECT source_sha256 FROM ticket_event_executions')){assert.match(sql,/created_at<=\(SELECT cutoff\.created_at/);assert.ok(sql.includes('cutoff.id=$3'));return{rows:['trigger-1','trigger-2','revoked'].map(id=>({source_sha256:ticketEventSourceHash('INBOUND','connection',id)})),rowCount:3};}
   assert.match(sql,/rule_match_observations/);assert.match(sql,/matched_reference_count>0/);assert.match(sql,/groupCommand/);
   return{rows:candidates,rowCount:candidates.length};
 }};
 const input={tenantId,correlationId:'correlation',executionId:'close',connectionId:'connection',groupId:'fixture-0019@example.test',ticketId:'42'};
 assert.deepEqual(await resolveTicketReferenceMessages(client,input),['trigger-1','trigger-2']);
 assert.deepEqual(values[0],[tenantId,'close','correlation']);
 assert.deepEqual(values[1],[tenantId,'correlation','close'],'cutoff is bound by immutable execution ID, not a rounded JSDate');
 assert.deepEqual(values[2],[tenantId,'correlation','42','connection','fixture-0019@example.test']);
 candidates=[{external_message_id:'foreign-generation',eligible:true}];
 await assert.rejects(()=>resolveTicketReferenceMessages(client,input),/evidence is unavailable/);
});

test('expanded closure reactions reuse <=11 existing batch parts, without trailing singleton or truncation',()=>{
 for(const count of [0,1,2,11,12,22,23,1000]){
  const effects=Array.from({length:count},(_,index)=>({type:'reaction',nodeId:'close',emoji:'✅',replyToMessageId:String(index),referenceMessages:true}));
  const batches=ticketEventFeedbackBatches(effects);
  assert.deepEqual(batches.flat(),effects);
  assert.ok(batches.every(batch=>batch.length<=11));
  if(count>11)assert.ok(batches.every(batch=>batch.length>=2));
 }
});


test('one close updates each reference once and keeps one closure text across existing batches',async()=>{
 const targets=Array.from({length:13},(_,index)=>'reference-'+index),rows=[];
 const definition={...flow('ticket_closed'),start:'react',nodes:[
  {id:'react',type:'reaction',emoji:'✅',quote:'REFERENCE_MESSAGES',next:'send'},
  {id:'send',type:'send_text',text:'Closed {{case.number}}',quote:'ORIGINAL',missingVariable:'ERROR',next:'done'},
  {id:'done',type:'end'}]};
 const client={query:async(sql,args)=>{
  if(sql.startsWith('SELECT definition FROM bot_flow_versions'))return{rows:[{definition}],rowCount:1};
  if(sql.includes('SELECT destination.external_group_id'))return{rows:[{external_group_id:'fixture-0019@example.test'}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ticket_event_executions'))return{rows:[{id:'close'}],rowCount:1};
  if(sql.includes('SELECT source_sha256 FROM ticket_event_executions')){assert.match(sql,/created_at<=\(SELECT cutoff\.created_at/);assert.ok(sql.includes('cutoff.id=$3'));return{rows:targets.map(id=>({source_sha256:ticketEventSourceHash('INBOUND','connection',id)})),rowCount:targets.length};}
  if(sql.includes('FROM case_correlations correlation'))return{rows:targets.map(id=>({external_message_id:id,eligible:true})),rowCount:targets.length};
  if(sql.trimStart().startsWith('INSERT INTO delivery_outbox')){rows.push(args);return{rows:[{id:'effect-'+rows.length}],rowCount:1};}
  if(sql.startsWith('INSERT INTO delivery_ticket_links'))return{rows:[],rowCount:1};
  if(sql.startsWith('UPDATE ticket_event_executions SET state='))return{rows:[],rowCount:1};
  throw new Error('Unexpected reference-close query');
 }};
 const receipt={id:'close',tenantId,correlationId:'correlation',event:'ticket_closed',mode:'CUSTOM',flowVersionId:'version',state:'PENDING'};
 const input={receipt,connectionId:'connection',groupBindingId:'binding',ticketId:'42',provider:'WAHA',reactions:true,
  variables:{'event.kind':'ticket_closed','provider.kind':'WAHA','case.number':'42'},quotes:{original:{messageId:targets[0],authorized:true}}};
 assert.equal((await enqueueTicketEventFeedback(client,input)).queued,14);
 assert.equal(rows.filter(row=>row[5]==='text/plain').length,1);
 assert.deepEqual(rows.filter(row=>row[5]==='application/vnd.wasalx.whatsapp-reaction').map(row=>row[6]),targets);
 assert.equal(new Set(rows.map(row=>row[7])).size,14);
 const batches=Map.groupBy(rows,row=>row[8]);
 assert.deepEqual([...batches.values()].map(batch=>batch.length),[11,3]);
 assert.deepEqual([...batches.keys()],[...batches.keys()].sort());
 for(const batch of batches.values())assert.deepEqual(batch.map(row=>row[9]),batch.map((_,index)=>index));
 const queriesBeforeReplay=rows.length;
 assert.deepEqual(await enqueueTicketEventFeedback(client,input),{handled:true,queued:0,replay:true});
 assert.equal(rows.length,queriesBeforeReplay);
});
