import assert from 'node:assert/strict';
import {metaDirectEffectQueryFixture} from './meta-direct-effect-query-fixture.mjs';
import {assertMetaDirectEffectCurrent} from '../packages/core/dist/meta-direct-identity.js';
import {routingFixtureEnvironment} from './meta-routing-fixture.mjs';
import test from 'node:test';
import {reserveDirectNativeReply,admitDirectReplyIntent} from '../services/control-api/dist/direct-native-operations.js';
import {directHumanPauseExpired,directKeepOpenTextControl,tryLockDirectConversation,assertDirectEffectsClear} from '../packages/core/dist/direct-keep-open.js';
const policy={humanReplyPauseMinutes:120,mainMenu:true,customerResolution:true};
const ids={tenantId:'10000000-0000-4000-8000-000000000001',instanceId:'20000000-0000-4000-8000-000000000001',
  conversationId:'30000000-0000-4000-8000-000000000001',assignmentId:'40000000-0000-4000-8000-000000000001',
  operationId:'50000000-0000-4000-8000-000000000001',connectionId:'60000000-0000-4000-8000-000000000001',chatId:'12025550120@c.us',ticketId:'41',actorId:'7',nativeGroupId:'2',actorFullGroupIds:['2'],requestSha256:'a'.repeat(64)};
function database({state='BOT',existing=null,busy=false,hold=null,meta=false,identityHeld=false,identityBusy=false,routingHeld=false}={}){
  const calls=[];const row={id:ids.conversationId,assignment_id:ids.assignmentId,state,human_ownership_epoch:'2',fencing_token:'5',zammad_customer_id:8,
    external_chat_id:meta?ids.chatId.replace('@c.us',''):ids.chatId,zammad_ticket_id:ids.ticketId,definition:{schemaVersion:1,name:'Owned policy',start:'end',maxSteps:10,nodes:[{id:'end',type:'end'}],keepOpenPolicy:policy}};
  const effect=metaDirectEffectQueryFixture({...ids,chatId:row.external_chat_id,meta,held:identityHeld,busy:identityBusy,routingHeld});
  return{calls,effect,row,query:async(sql,values)=>{calls.push({sql,values});
    const guarded=effect.query(sql,values);if(guarded!==undefined)return guarded;
    if(sql.startsWith('SELECT conversation.id,conversation.assignment_id'))return{rows:[row],rowCount:1};
    if(sql.startsWith('SELECT pg_try_advisory_xact_lock'))return{rows:[{acquired:!busy}],rowCount:1};
    if(sql.startsWith('SELECT 1 FROM privacy_jobs job'))return{rows:[],rowCount:0};
    if(sql.startsWith('SELECT id FROM bot_conversations'))return{rows:[{id:ids.conversationId}],rowCount:1};
    if(sql.startsWith('SELECT * FROM direct_native_reply_intents'))return{rows:existing?[existing]:[],rowCount:existing?1:0};
    if(sql.startsWith('SELECT id,state,human_ownership_epoch'))return{rows:[row],rowCount:1};
    if(sql.startsWith("SELECT 'reply' AS kind"))return{rows:hold?[{kind:hold,id:'held'}]:[],rowCount:hold?1:0};
    if(sql.startsWith("SELECT 'delivery' AS kind"))return{rows:[],rowCount:0};
    if(sql.startsWith("UPDATE bot_conversations SET state='HUMAN'"))return{rows:[{human_ownership_epoch:'3'}],rowCount:1};
    if(sql.startsWith('INSERT INTO bot_conversation_events')||sql.startsWith('INSERT INTO direct_native_reply_intents'))return{rows:[],rowCount:1};
    throw new Error('Unexpected SQL '+sql);
  }};
}
test('expiry uses successful human anchor and exact finite boundary; absence/null disabled',()=>{
  assert.equal(directHumanPauseExpired(undefined,'2026-10-06T00:00:00Z','2026-10-07T00:00:00Z'),false);
  assert.equal(directHumanPauseExpired({...policy,humanReplyPauseMinutes:null},'2026-10-06T00:00:00Z','2026-10-07T00:00:00Z'),false);
  assert.equal(directHumanPauseExpired(policy,null,'2026-10-07T00:00:00Z'),false);
  assert.equal(directHumanPauseExpired(policy,'2026-10-06T00:00:00Z','2026-10-06T01:59:59Z'),false);
  assert.equal(directHumanPauseExpired(policy,'2026-10-06T00:00:00Z','2026-10-06T02:00:00Z'),true);
  assert.equal(directHumanPauseExpired(policy,'invalid','2026-10-07T00:00:00Z'),false);
});
test('localized menu/request are opt-in and ordinary yes never resolves',()=>{
  for(const text of ['Main menu','القائمة الرئيسية'])assert.equal(directKeepOpenTextControl(text,policy),'MAIN_MENU');
  for(const text of ['Resolve my ticket','حل تذكرتي'])assert.equal(directKeepOpenTextControl(text,policy),'RESOLUTION_REQUEST');
  for(const text of ['yes','نعم','Confirm resolution','تأكيد الحل'])assert.equal(directKeepOpenTextControl(text,policy),null);
  assert.equal(directKeepOpenTextControl('Main menu',undefined),null);
});
test('busy route returns without waiting on a native/application lock or creating intent',async()=>{
  const db=database({busy:true});await assert.rejects(tryLockDirectConversation(db,{...ids}),/DIRECT_CONVERSATION_BUSY/);
  assert.equal(db.calls.length,1);assert.match(db.calls[0].sql,/pg_try_advisory_xact_lock/);
  assert.equal(db.calls.some(c=>/INSERT|UPDATE|FOR UPDATE/u.test(c.sql)),false);
});
test('available native admission uses exact conversation NOWAIT after route try-lock',async()=>{
  const db=database();await tryLockDirectConversation(db,{...ids});assert.equal(db.calls.length,2);
  assert.match(db.calls[1].sql,/FOR UPDATE NOWAIT/u);assert.deepEqual(db.calls[1].values,[ids.tenantId,ids.conversationId]);
});
test('no actual full native group permission rejects before any SQL',async()=>{
  const db=database();await assert.rejects(reserveDirectNativeReply(db,{...ids,actorFullGroupIds:['9']}),/DIRECT_NATIVE_ACTOR_DENIED/);assert.equal(db.calls.length,0);
});
test('new opted-in BOT reply reacquires once and creates blocking intent, no provider output',async()=>{
  const db=database();assert.deepEqual(await reserveDirectNativeReply(db,ids),{id:ids.operationId,conversation_id:ids.conversationId,human_ownership_epoch:3});
  assert.equal(db.calls.filter(c=>c.sql.startsWith('UPDATE bot_conversations')).length,1);
  assert.equal(db.calls.filter(c=>c.sql.startsWith('INSERT INTO direct_native_reply_intents')).length,1);
  assert.equal(db.calls.some(c=>c.sql.startsWith('INSERT INTO delivery_outbox')),false);
  const inserted=db.calls.find(c=>c.sql.startsWith('INSERT INTO direct_native_reply_intents'));
  assert.deepEqual(inserted.values,[ids.operationId,ids.tenantId,ids.conversationId,ids.instanceId,ids.ticketId,ids.actorId,3,ids.requestSha256]);
});
test('matching intent replay returns original epoch without another state/intent mutation',async()=>{
  const existing={id:ids.operationId,conversation_id:ids.conversationId,instance_id:ids.instanceId,native_ticket_id:ids.ticketId,native_actor_id:ids.actorId,request_sha256:ids.requestSha256,human_ownership_epoch:'2',state:'PENDING'};
  const db=database({state:'HUMAN',existing});assert.equal((await reserveDirectNativeReply(db,ids)).human_ownership_epoch,2);
  assert.equal(db.calls.some(c=>/^(INSERT|UPDATE)/u.test(c.sql)),false);
});
test('changed duplicate actor cannot take original intent or mutate state',async()=>{
  const existing={id:ids.operationId,conversation_id:ids.conversationId,instance_id:ids.instanceId,native_ticket_id:ids.ticketId,native_actor_id:'99',request_sha256:ids.requestSha256,human_ownership_epoch:'2',state:'PENDING'};
  const db=database({existing});await assert.rejects(reserveDirectNativeReply(db,ids),/DIRECT_NATIVE_INTENT_CONFLICT/);
  assert.equal(db.calls.some(c=>/^(INSERT|UPDATE)/u.test(c.sql)),false);
});
test('unresolved native reply/close stops all new ownership mutation',async()=>{
  for(const hold of ['reply','close']){const db=database({hold});await assert.rejects(reserveDirectNativeReply(db,ids),/DIRECT_NATIVE_EFFECT_HOLD/);
    assert.equal(db.calls.some(c=>/^(INSERT|UPDATE)/u.test(c.sql)),false);}
});
test('shared clear guard keeps both origins, leases and ambiguous retries',async()=>{
  const db=database();await assertDirectEffectsClear(db,{tenantId:ids.tenantId,conversationId:ids.conversationId});
  const sql=db.calls.at(-1).sql;assert.match(sql,/OUTCOME_UNKNOWN/u);assert.match(sql,/lease_id IS NOT NULL/u);
  assert.equal(/direct_origin\s*=/u.test(sql),false);assert.match(sql,/manual_retry_allowed/u);
});
test('intent admission rejects foreign/current-epoch absence, no other operation exclusion',async()=>{
  const db={query:async(sql,values)=>{assert.match(sql,/intent\.human_ownership_epoch=conversation\.human_ownership_epoch/u);assert.deepEqual(values,[ids.tenantId,ids.operationId,ids.conversationId,ids.instanceId,ids.ticketId,ids.actorId]);return{rows:[],rowCount:0}}};
  await assert.rejects(admitDirectReplyIntent(db,{...ids,articleId:'87'}),/DIRECT_NATIVE_INTENT_DENIED/);
});

test('valid current Meta alias permits one native ownership reacquisition and intent',async(t)=>{
 t.after(routingFixtureEnvironment('123456789'));
 const db=database({meta:true});await reserveDirectNativeReply(db,{...ids,chatId:db.row.external_chat_id,appId:db.effect.appId});
 assert.equal(db.calls.filter(c=>c.sql.startsWith('INSERT INTO direct_native_reply_intents')).length,1);
});
test('primary delivery cannot confer authority on an old epoch-zero native intent without its original source',async t=>{
 t.after(routingFixtureEnvironment('123456789'));
 for(const nativeSource of [null,'74000000-0000-4000-8000-000000000001']){
  const fixture=metaDirectEffectQueryFixture({...ids,chatId:'100',meta:true,routingClaim:'PRIMARY_DELIVERY',nativeSource});
  const calls=[],client={query:async(sql,values)=>{calls.push(sql);const result=fixture.query(sql,values);assert.notEqual(result,undefined,`Unexpected SQL ${sql}`);return result}};
  const operation=assertMetaDirectEffectCurrent(client,{tenantId:ids.tenantId,conversationId:ids.conversationId,appId:fixture.appId,routingNativeIntentId:ids.operationId});
  if(nativeSource)await operation;else await assert.rejects(operation,{code:'META_DIRECT_EFFECT_NOT_ATTEMPTED',outcomeKnown:true});
  assert.equal(calls.some(sql=>/^(INSERT|UPDATE)/u.test(sql)),false);
 }
});
test('Meta held alias, routing or busy current asset prevents native precommit ownership and intent mutation',async(t)=>{
 t.after(routingFixtureEnvironment('123456789'));
 for(const options of [{meta:true,identityHeld:true},{meta:true,identityBusy:true},{meta:true,routingHeld:true}]){
  const db=database(options);
  await assert.rejects(reserveDirectNativeReply(db,{...ids,chatId:db.row.external_chat_id,appId:db.effect.appId}),{code:'META_DIRECT_EFFECT_NOT_ATTEMPTED',outcomeKnown:true});
  assert.equal(db.calls.some(c=>/^(INSERT|UPDATE)/u.test(c.sql)),false);
   if(options.routingHeld)assert.equal(db.calls.filter(c=>c.sql.startsWith('SELECT allowed,claim FROM app.meta_direct_routing_guard')).length,1);
 }
});
