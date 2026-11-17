import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolveMetaTestRecipientLink} from '../packages/core/dist/meta-test-recipient-link.js';
import {parseWahaTestRecipientAllowlist} from '../packages/core/dist/waha-test-recipient-scope.js';

import {parseMetaTestPhonePolicy,setMetaTestPhoneTransaction} from '../packages/core/dist/meta-test-phone-policy.js';
export async function verifyMetaTestPhoneSnapshots({
 tx,pool,
 tenantId,connectionId,sessionId,appId,phoneNumberId,wabaId,phone,bsuid,
 phoneAlias,bsuidAlias,conversationId,ticketId,sourceEventId,originalDeliveryId,
}){
 const sender={tenantId,connectionId,providerSessionId:sessionId,appId,wabaId,phoneNumberId};
 const environment={NODE_ENV:'test',META_APP_ID:appId,WASALX_TEST_RECIPIENT_ALLOWLIST:JSON.stringify([phone]),
  WASALX_META_TEST_PHONE_SENDERS:JSON.stringify([sender])};
 const off={environment:'test',senders:[],recipients:[]};
 const policy=parseMetaTestPhonePolicy(environment);
 assert(policy,'The real parser enables the exact synthetic TEST sender');
 const parsed=patch=>parseMetaTestPhonePolicy({...environment,...patch});
 const replacementPhone=phone=== '15550000999'?'15550000888':'15550000999';
 const original=await tx(async client=>(await client.query(`SELECT meta_direct_recipient,idempotency_key
  FROM public.delivery_outbox WHERE tenant_id=$1 AND id=$2`,[tenantId,originalDeliveryId])).rows[0]);
 assert(original,'Original immutable fixture delivery is required');
 assert.deepEqual(original.meta_direct_recipient.recipient,{kind:'BSUID',value:bsuid});

 await tx(async client=>{
  const count=async()=>(await client.query(`SELECT
   (SELECT count(*)::int FROM public.delivery_outbox WHERE tenant_id=$1) deliveries,
   (SELECT count(*)::int FROM public.normalized_messages WHERE tenant_id=$1) normalized,
   (SELECT count(*)::int FROM public.bot_conversation_events WHERE tenant_id=$1) events`,[tenantId])).rows[0];
  const before=await count();
  await client.query('SAVEPOINT rc21_phone_fixture');
  try{
   const isolated=async work=>{
    await client.query('SAVEPOINT rc21_phone_case');
    try{return await work();}finally{
     await client.query('ROLLBACK TO SAVEPOINT rc21_phone_case');
     await client.query('RELEASE SAVEPOINT rc21_phone_case');
    }
   };
   const birth=async({idempotencyKey=`rc21-phone-${randomUUID()}`,origin='HUMAN',snapshot=null,replay=false}={})=>{
    return client.query(`INSERT INTO public.delivery_outbox
     (id,tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,message_body,
      content_type,idempotency_key,state,direct_origin,zammad_article_id,meta_routing_source_event_id,meta_direct_recipient)
     VALUES($1,$2,$3,$4,$5,$6,'Synthetic TEST phone-policy birth','text/plain',$7,'SENT',$8,
      CASE WHEN $8='HUMAN' THEN '98239' ELSE NULL END,CASE WHEN $8='BOT' THEN $9::uuid ELSE NULL END,$10)
     ${replay?'ON CONFLICT(tenant_id,idempotency_key) DO NOTHING':''}
     RETURNING id,idempotency_key,meta_direct_recipient`,
    [randomUUID(),tenantId,connectionId,conversationId,phone,ticketId,idempotencyKey,origin,sourceEventId,snapshot]);
   };
   const bsuidBirth=async(inputPolicy=off)=>{
    await setMetaTestPhoneTransaction(client,tenantId,inputPolicy);
    const row=(await birth()).rows[0];
    assert.deepEqual(row.meta_direct_recipient.recipient,{kind:'BSUID',value:bsuid});
    assert.equal(row.meta_direct_recipient.aliasId,bsuidAlias);
    assert.equal(Object.hasOwn(row.meta_direct_recipient,'testPhoneSender'),false);
    return row;
   };
   await isolated(()=>bsuidBirth());

   // The parent fixture creates this same ordinary alias provenance later.
   // Supply it temporarily here; no invented alias, native anchor or authority GUC.
   const aliases=(await client.query(`SELECT alias.id,alias.kind,alias.revision,alias.participant_identity_id,
    alias.source_event_id,source.provider_event_id,conversation.zammad_customer_id::text AS customer_id
    FROM public.meta_direct_identity_aliases alias
    JOIN public.event_inbox source ON source.tenant_id=alias.tenant_id AND source.id=alias.source_event_id
    JOIN public.bot_conversations conversation ON conversation.tenant_id=alias.tenant_id AND conversation.id=$4
    WHERE alias.tenant_id=$1 AND alias.connection_id=$2 AND alias.id=ANY($3::uuid[])`,
   [tenantId,connectionId,[phoneAlias,bsuidAlias],conversationId])).rows;
   assert.equal(aliases.length,2);
   for(const alias of aliases){
    await client.query(`INSERT INTO public.normalized_messages
     (tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,
      message_text,provider_timestamp,provider_metadata)
     SELECT $1,$2,$3,$4,$5,$5,'Synthetic joint identity mapping',clock_timestamp(),$6
     WHERE NOT EXISTS(SELECT 1 FROM public.normalized_messages WHERE tenant_id=$1 AND event_inbox_id=$2)`,
    [tenantId,alias.source_event_id,connectionId,alias.provider_event_id,phone,
     {direct:true,zammad_customer_id:Number(alias.customer_id)}]);
    assert.equal((await client.query('SELECT app.meta_direct_alias_source_valid($1,$2,$3) AS valid',
     [alias.id,phone,alias.customer_id])).rows[0].valid,true,'Use the real alias-source validator');
   }
   // The actual HUMAN callback normally supplied this append-only MESSAGE link.
   // If omitted by a fixture variant, add only the already valid matching source.
   await client.query(`INSERT INTO public.bot_conversation_events
    (tenant_id,conversation_id,event_inbox_id,event_kind,safe_metadata)
    SELECT $1,$2,source.id,'MESSAGE','{}'::jsonb FROM public.event_inbox source
    WHERE source.tenant_id=$1 AND source.id=$3 AND source.connection_id=$4 AND source.provider='META'
     AND source.event_type='messages' AND source.meta_direct_identity_change IS NULL
     AND source.meta_direct_asset=$5::jsonb AND source.status='PROCESSED'
     AND EXISTS(SELECT 1 FROM app.meta_direct_source_identity(source.payload) identity
      WHERE identity.joint_contact AND identity.phone=$6 AND identity.bsuid=$7)
     AND EXISTS(SELECT 1 FROM public.normalized_messages message
      WHERE message.tenant_id=source.tenant_id AND message.event_inbox_id=source.id
       AND message.external_participant_id=$6 AND message.provider_metadata->'direct'='true'
       AND message.provider_metadata->>'zammad_customer_id'=$8)
     AND NOT EXISTS(SELECT 1 FROM public.bot_conversation_events event
      WHERE event.tenant_id=$1 AND event.event_inbox_id=source.id)`,
   [tenantId,conversationId,sourceEventId,connectionId,{providerSessionId:sessionId,phoneNumberId,wabaId},phone,bsuid,aliases[0].customer_id]);
   assert.equal((await client.query(`SELECT 1 FROM public.bot_conversation_events
    WHERE tenant_id=$1 AND conversation_id=$2 AND event_inbox_id=$3`,[tenantId,conversationId,sourceEventId])).rowCount,1);

   for(const nodeEnvironment of ['test','development'])await isolated(async()=>{
    await setMetaTestPhoneTransaction(client,tenantId,parsed({NODE_ENV:nodeEnvironment}));
    for(const origin of ['HUMAN','BOT']){
     const row=(await birth({origin})).rows[0],snapshot=row.meta_direct_recipient;
     assert.equal(snapshot.claim,'ALIAS_VERIFIED');
     assert.deepEqual(snapshot.recipient,{kind:'PHONE',value:phone});
     assert.equal(snapshot.aliasId,phoneAlias);
     assert.equal(String(snapshot.aliasRevision),String(aliases.find(a=>a.id===phoneAlias).revision));
     assert.equal(snapshot.participantId,aliases.find(a=>a.id===phoneAlias).participant_identity_id);
     assert.deepEqual(snapshot.asset,{providerSessionId:sessionId,phoneNumberId,wabaId});
     assert.equal(snapshot.testPhoneSender,true);
      const linked=await resolveMetaTestRecipientLink(client,{tenantId,connectionId,deliveryId:row.id,appId,
       scope:parseWahaTestRecipientAllowlist(JSON.stringify([phone]))});
      assert.equal(linked?.phone,phone,'The real SQL receipt-link reader accepts the frozen PHONE alias');
      assert.equal(linked?.bsuid,bsuid,'The same ordinary joint BSUID evidence remains bound');
     await client.query('SAVEPOINT rc21_phone_immutable');
     await assert.rejects(client.query(`UPDATE public.delivery_outbox SET
      meta_direct_recipient=meta_direct_recipient-'testPhoneSender' WHERE tenant_id=$1 AND id=$2`,[tenantId,row.id]),/immutable/);
     await client.query('ROLLBACK TO SAVEPOINT rc21_phone_immutable');
     await client.query('RELEASE SAVEPOINT rc21_phone_immutable');
    }
   });

   for(const nodeEnvironment of ['production',undefined]){
    assert.equal(parsed({NODE_ENV:nodeEnvironment}),undefined);
    await isolated(()=>bsuidBirth(off));
   }
   assert.equal(parsed({WASALX_META_TEST_PHONE_SENDERS:undefined}),undefined);
   for(const fence of [undefined,'', '[]'])assert.throws(()=>parsed({WASALX_TEST_RECIPIENT_ALLOWLIST:fence}),/fence|invalid/);
   for(const [field,value]of Object.entries({tenantId:randomUUID(),connectionId:randomUUID(),providerSessionId:randomUUID(),
    appId:appId==='9'?'8':'9',wabaId:wabaId==='9'?'8':'9',phoneNumberId:phoneNumberId==='9'?'8':'9'})){
    await isolated(()=>bsuidBirth(parsed({WASALX_META_TEST_PHONE_SENDERS:JSON.stringify([{...sender,[field]:value}])})));
   }
   for(const recipients of [[],[replacementPhone]])await isolated(async()=>{
    await setMetaTestPhoneTransaction(client,tenantId,{...policy,recipients});
    await assert.rejects(birth(),error=>error.code==='55000'&&/allowlisted verified PHONE/.test(error.message));
   });
   await isolated(async()=>{
    await setMetaTestPhoneTransaction(client,tenantId,policy);
    await client.query("UPDATE public.meta_direct_identity_aliases SET state='HELD',revision=revision+1 WHERE tenant_id=$1 AND id=$2",[tenantId,phoneAlias]);
    await assert.rejects(birth(),error=>error.code==='55000'&&/reconciliation|held/.test(error.message));
   });
   await isolated(async()=>{
    await setMetaTestPhoneTransaction(client,tenantId,policy);
    await client.query(`UPDATE public.event_inbox SET status='PROCESSING',lease_id=$3,
     lease_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id IN(
      SELECT event_inbox_id FROM public.bot_conversation_events WHERE tenant_id=$1 AND conversation_id=$2)`,
    [tenantId,conversationId,randomUUID()]);
    await assert.rejects(birth(),error=>error.code==='55000'&&/current joint conversation evidence/.test(error.message));
   });
   await isolated(async()=>{
    await setMetaTestPhoneTransaction(client,tenantId,policy);
    await client.query(`UPDATE public.provider_sessions SET provider_state_data=jsonb_set(provider_state_data,
     '{metaAccountProof,credentialMetadata,appId}',to_jsonb($3::text)) WHERE tenant_id=$1 AND id=$2`,
    [tenantId,sessionId,appId==='9'?'8':'9']);
    try{
     const row=(await birth()).rows[0];
     assert.equal(row.meta_direct_recipient.recipient.kind,'BSUID','A mismatched proof must never enable the PHONE exception');
    }catch(error){assert(['23514','55000'].includes(error.code),'Only an existing identity/routing guard refusal is an alternative');}
   });
   await isolated(async()=>{
    await setMetaTestPhoneTransaction(client,tenantId,off);
    await assert.rejects(birth({snapshot:{...original.meta_direct_recipient,recipient:{kind:'PHONE',value:phone},
     aliasId:phoneAlias,testPhoneSender:true}}),/snapshot does not match admitted alias/);
   });
   await isolated(async()=>{
    await setMetaTestPhoneTransaction(client,tenantId,policy);
    assert.equal((await birth({idempotencyKey:original.idempotency_key,replay:true})).rowCount,0);
    assert.deepEqual((await client.query('SELECT meta_direct_recipient FROM public.delivery_outbox WHERE tenant_id=$1 AND id=$2',
     [tenantId,originalDeliveryId])).rows[0].meta_direct_recipient,original.meta_direct_recipient,
    'Enabling PHONE cannot rebind committed BSUID history through an idempotent insert');
   });
  }finally{
   await client.query('ROLLBACK TO SAVEPOINT rc21_phone_fixture');
   await client.query('RELEASE SAVEPOINT rc21_phone_fixture');
  }
  assert.deepEqual(await count(),before,'Rollback preserves exact parent fixture/export counts');
 });

 // Pin one real pooled backend across both transaction boundaries: a second
 // checkout alone would not prove that the originally enabled backend is clean.
 const client=await pool.connect();
 try{
  const context=async()=>(await client.query(`SELECT NULLIF(current_setting('app.tenant_id',true),'') tenant,
   NULLIF(current_setting('app.meta_test_phone_policy',true),'') policy`)).rows[0];
  const baseline=await context();
  for(const terminal of ['COMMIT','ROLLBACK']){
   await client.query('BEGIN');
   await setMetaTestPhoneTransaction(client,tenantId,policy);
   let current=await context();
   assert.equal(current.tenant,tenantId);
   assert.deepEqual(JSON.parse(current.policy),policy);
   await client.query(terminal);
   assert.deepEqual(await context(),baseline,`${terminal} restores both local settings on the same backend`);
   await client.query('BEGIN');
   await setMetaTestPhoneTransaction(client,randomUUID(),policy);
   current=await context();
   assert.notEqual(current.tenant,tenantId);
   assert.equal(current.policy,null,'A following foreign tenant cannot inherit the sender policy');
   await client.query('ROLLBACK');
   assert.deepEqual(await context(),baseline);
  }
 }finally{await client.query('ROLLBACK');client.release();}
 assert.deepEqual((await tx(c=>c.query('SELECT meta_direct_recipient FROM public.delivery_outbox WHERE tenant_id=$1 AND id=$2',
  [tenantId,originalDeliveryId]))).rows[0].meta_direct_recipient,original.meta_direct_recipient);
}
