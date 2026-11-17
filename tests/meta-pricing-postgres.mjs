import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {Client,Pool} from 'pg';
import {DatabaseService} from '../services/control-api/dist/database.service.js';
import {WebhookIngressController} from '../services/control-api/dist/webhook-ingress.controller.js';
import {InboundRepository} from '../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js';
import {InboundProcessor} from '../services/connector-worker/dist/services/connector-worker/src/inbound-processor.js';
import {MetaGroupsAdapter} from '../services/connector-worker/dist/packages/connectors/src/meta.js';

// Runs only in the canonical owned PostgreSQL gate. Provider signatures are
// synthetic; admission, RLS/FKs, transactions, normalization and privacy are real.
export async function verifyMetaPricingReceipts(adminUrl,workerConfig,appUrl){
 const admin=new Client({connectionString:adminUrl});await admin.connect();
 const pool=new Pool(workerConfig),repository=new InboundRepository(pool);
 const savedUrl=process.env.DATABASE_URL,savedSecret=process.env.META_APP_SECRET_REFERENCE,savedApp=process.env.META_APP_ID;
 process.env.DATABASE_URL=appUrl;const database=new DatabaseService();
 if(savedUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=savedUrl;
 process.env.META_APP_SECRET_REFERENCE='secret://synthetic/pricing';process.env.META_APP_ID='12025550130';
 const tenantId=randomUUID(),otherTenantId=randomUUID(),connectionId=randomUUID(),sessionId=randomUUID(),groupId=randomUUID();
 const phoneId='15550004701',accountId='987654321',secret='synthetic-pricing-signature',deliveryId=randomUUID(),messageId=`wamid.${deliveryId}`;
 const adapter=new MetaGroupsAdapter({accessToken:'unused-token-value',graphVersion:'v24.0',phoneNumberIdFor:()=>phoneId});
 const controller=new WebhookIngressController(database,{resolveHmac:async()=>secret},{wakeInbound:async()=>{}});
 const processor=new InboundProcessor(repository,{resolve:async()=>assert.fail('Receipts must never resolve sending credentials')});
 const timestamp=String(Math.floor(Date.now()/1000)),free={billable:false,pricing_model:'PMP',category:'service',type:'free_customer_service'},paid={...free,billable:true,type:'regular'};
 const envelope=(status,pricing,id=messageId)=>({object:'whatsapp_business_account',entry:[{id:accountId,changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:phoneId},statuses:[{id,status,timestamp,recipient_user_id:'SA.synthetic',...(pricing===undefined?{}:{pricing})}]}}]}]});
 const emit=async payload=>{const rawBody=Buffer.from(JSON.stringify(payload));return controller.meta({rawBody,headers:{'x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(rawBody).digest('hex')}},payload)};
 const rows=async()=> (await admin.query('SELECT * FROM delivery_receipts WHERE tenant_id=$1 AND delivery_id=$2 ORDER BY created_at,id',[tenantId,deliveryId])).rows;
 const state=async()=> (await admin.query('SELECT state,attempts,external_message_id FROM delivery_outbox WHERE id=$1',[deliveryId])).rows[0];
 const tx=async(work,scope=tenantId)=>{const client=await pool.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[scope]);const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}};
 const addDelivery=async(id,external)=>{
  await admin.query('BEGIN');
  try{
   await admin.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
   const inserted=await admin.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,group_workspace_group_id,delivery_origin,message_body,content_type,idempotency_key,state,attempts,external_message_id)
    VALUES($1,$2,$3,$4,'GROUP_WORKSPACE','Synthetic pricing fixture','text/plain',$5,'SENT',1,$6) RETURNING meta_billing_snapshot`,[id,tenantId,connectionId,groupId,`pricing-${id}`,external]);
   assert.equal(inserted.rows[0].meta_billing_snapshot.claim,'LEGACY_UNATTRIBUTED','Receipt fixture preserves unknown payer/send attribution');
   await admin.query('COMMIT');return inserted;
  }catch(error){await admin.query('ROLLBACK');throw error;}
 };
 const loadedEvent=async id=>{const row=(await admin.query('SELECT * FROM event_inbox WHERE id=$1',[id])).rows[0];return{id:row.id,tenantId:row.tenant_id,connectionId:row.connection_id,provider:'meta',providerEventId:row.provider_event_id,eventType:row.event_type,payload:row.payload,attempts:row.attempts}};
 try{
  for(const id of [tenantId,otherTenantId])await admin.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Pricing fixture',$2,'ACTIVE')",[id,`pricing-${id}`]);
  await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Pricing fixture','META','CLOUD_API','WORKING',$3)",[connectionId,tenantId,`secret://${tenantId}/connections/${connectionId}/meta`]);
  // Deliberately legacy/unverified metadata: signed receipt handling must not
  // invent a credential verification or depend on new payer/send authority.
  await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data)
   VALUES($1,$2,$3,$4,'WORKING',$5,'ACTIVE',$6)`,[sessionId,tenantId,connectionId,phoneId,`meta-cloud://${accountId}/${phoneId}`,{wabaId:accountId}]));
  await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state) VALUES($1,$2,'META',$3,$4,'ACTIVE')",[tenantId,connectionId,phoneId,`secret://${tenantId}/connections/${connectionId}/meta-webhook`]));
  await admin.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,$4,'Pricing fixture')",[groupId,tenantId,connectionId,`pricing-${groupId}`]);
  await addDelivery(deliveryId,messageId);
  assert.equal((await emit(envelope('sent'))).count,1);await processor.drainTenant(tenantId);
  assert.equal((await rows())[0].meta_pricing_state,'ABSENT');
  assert.equal((await emit(envelope('read'))).count,1);await processor.drainTenant(tenantId);
  assert.equal((await state()).state,'READ');
  assert.equal((await emit(envelope('delivered',free))).count,1);await processor.drainTenant(tenantId);
  const correction=envelope('delivered',paid),equivalent=structuredClone(correction);
  equivalent.entry[0].changes[0].value.statuses[0].pricing=Object.fromEntries(Object.entries(paid).reverse());
  const admitted=await Promise.all([emit(correction),emit(equivalent)]);
  assert.equal(admitted.reduce((sum,row)=>sum+row.count,0),1);assert.equal(admitted.reduce((sum,row)=>sum+row.duplicates,0),1);
  await processor.drainTenant(tenantId);
  assert.equal((await emit(envelope('failed',paid))).count,1);await processor.drainTenant(tenantId);
  for(const pricing of [null,{...paid,billable:'true'},{...paid,category:'private-unknown'}]){assert.equal((await emit(envelope('delivered',pricing))).count,1);await processor.drainTenant(tenantId);}
  const history=await rows();assert.equal(history.length,8);assert.equal(history.filter(row=>row.meta_pricing_state==='UNAVAILABLE').length,3);
  const paidReceipt=history.find(row=>row.receipt_status==='DELIVERED'&&row.meta_pricing_billable===true);
  for(const changed of [{recipient_user_id:'SA.other'},{errors:[{code:131000}]}]){
   const nonpricing=envelope('delivered',paid);Object.assign(nonpricing.entry[0].changes[0].value.statuses[0],changed);
   await assert.rejects(()=>emit(nonpricing),error=>error.getStatus?.()===409,'Same status/time/pricing revision does not authorize unrelated payload correction');
  }
  assert.equal(paidReceipt.applied_state,'IGNORED');assert.equal(paidReceipt.meta_observed_envelope_account_id,accountId);assert.equal(paidReceipt.meta_observed_phone_number_id,phoneId);
  assert.equal(new Set(history.map(row=>row.meta_pricing_revision_sha256)).size,6);
  assert.deepEqual(await state(),{state:'READ',attempts:1,external_message_id:messageId});
  assert.equal((await admin.query('SELECT count(*) FROM delivery_attempts WHERE delivery_id=$1',[deliveryId])).rows[0].count,'0');
  assert.deepEqual((await admin.query('SELECT provider_state_data FROM provider_sessions WHERE id=$1',[sessionId])).rows[0].provider_state_data,{wabaId:accountId});
  assert(history.every(row=>!JSON.stringify(row.safe_metadata).includes('pricing')&&!JSON.stringify(row).includes('private-unknown')));
  assert.equal((await tx(c=>c.query('SELECT * FROM delivery_receipts WHERE delivery_id=$1',[deliveryId]),otherTenantId)).rowCount,0);
  await assert.rejects(()=>tx(c=>c.query('UPDATE delivery_receipts SET meta_pricing_billable=false WHERE id=$1',[paidReceipt.id])),{code:'42501'});
  await assert.rejects(()=>tx(c=>c.query('DELETE FROM delivery_receipts WHERE id=$1',[paidReceipt.id])),{code:'42501'});
  await assert.rejects(()=>tx(c=>c.query('UPDATE delivery_receipts SET external_message_id=NULL WHERE id=$1',[paidReceipt.id])),{code:'42501'});

  const correctionEvent=await loadedEvent(paidReceipt.event_inbox_id);
  const normalized=await adapter.normalizeReceipts(connectionId,correction);
  assert.deepEqual(await Promise.all([repository.applyDeliveryReceipts(correctionEvent,normalized),repository.applyDeliveryReceipts(correctionEvent,normalized)]),[['DUPLICATE'],['DUPLICATE']]);
  // One bad item rolls back the earlier valid insertion in the same worker tx.
  const fresh={...normalized[0],receiptKey:'e'.repeat(64)},bad={...fresh,receiptKey:'f'.repeat(64),metaPricingObservation:{...fresh.metaPricingObservation,billable:null}};
  await assert.rejects(()=>repository.applyDeliveryReceipts(correctionEvent,[fresh,bad]),{code:'23514'});
  assert.equal((await rows()).length,history.length);assert.deepEqual(await state(),{state:'READ',attempts:1,external_message_id:messageId});
  assert.deepEqual(await repository.applyDeliveryReceipts(correctionEvent,[fresh]),['RECORDED']);
  const foreignEvent={...correctionEvent,tenantId:otherTenantId};assert.deepEqual(await repository.applyDeliveryReceipts(foreignEvent,normalized),['UNMATCHED']);
  await assert.rejects(()=>repository.applyDeliveryReceipts({...correctionEvent,id:randomUUID()},[{...fresh,receiptKey:'d'.repeat(64)}]),{code:'23503'});
  await assert.rejects(()=>repository.applyDeliveryReceipts(correctionEvent,[{...fresh,receiptKey:'c'.repeat(64),metaPricingObservation:{...fresh.metaPricingObservation,observedEnvelopeAccountId:'unsafe'}}]),{code:'23514'});

  // A receipt before the send response remains unmatched, then binds only the
  // exact original connection/message after the provider response is recorded.
  const pendingMessage=`wamid.${randomUUID()}`,pendingPayload=envelope('delivered',paid,pendingMessage);
  assert.equal((await emit(pendingPayload)).count,1);
  const pendingRow=(await admin.query("SELECT id FROM event_inbox WHERE tenant_id=$1 AND status='ACCEPTED' ORDER BY received_at DESC LIMIT 1",[tenantId])).rows[0];
  const pendingEvent=await loadedEvent(pendingRow.id),pendingReceipts=await adapter.normalizeReceipts(connectionId,pendingPayload);
  assert.deepEqual(await repository.applyDeliveryReceipts(pendingEvent,pendingReceipts),['UNMATCHED']);
  await addDelivery(randomUUID(),pendingMessage);assert.deepEqual(await repository.applyDeliveryReceipts(pendingEvent,pendingReceipts),['APPLIED']);

  // Existing NULL evidence is legal and remains NULL. New observation columns
  // are protected by 0137's whole-row identity-redaction exception.
  const legacyId=randomUUID();await tx(c=>c.query(`INSERT INTO delivery_receipts(id,tenant_id,delivery_id,connection_id,event_inbox_id,provider,external_message_id,receipt_key_sha256,receipt_scope,receipt_status,provider_status,provider_timestamp,applied_state)
   VALUES($1,$2,$3,$4,$5,'META',$6,$7,'MESSAGE','SENT','SENT',now(),'IGNORED')`,[legacyId,tenantId,deliveryId,connectionId,paidReceipt.event_inbox_id,messageId,'b'.repeat(64)]));
  assert.equal((await rows()).find(row=>row.id===legacyId).meta_pricing_version,null);
  const beforeRedaction=await rows();
  await tx(async c=>{
   await c.query(`UPDATE delivery_outbox SET content_redacted_at=now(),group_workspace_group_id=NULL,message_body='',external_message_id=NULL,manual_retry_allowed=false,updated_at=now() WHERE id=$1`,[deliveryId]);
   await c.query('UPDATE delivery_receipts SET external_message_id=NULL WHERE delivery_id=$1',[deliveryId]);
  });
  assert.deepEqual(await rows(),beforeRedaction.map(row=>({...row,external_message_id:null})));
  await assert.rejects(()=>tx(c=>c.query('UPDATE delivery_receipts SET external_message_id=$1 WHERE id=$2',[messageId,paidReceipt.id])),{code:'42501'});
  await assert.rejects(()=>tx(c=>c.query(`INSERT INTO delivery_receipts(tenant_id,delivery_id,connection_id,event_inbox_id,provider,external_message_id,receipt_key_sha256,receipt_scope,receipt_status,provider_status,provider_timestamp,applied_state)
   VALUES($1,$2,$3,$4,'META',$5,$6,'MESSAGE','SENT','SENT',now(),'IGNORED')`,[tenantId,deliveryId,connectionId,paidReceipt.event_inbox_id,messageId,'a'.repeat(64)])),{code:'42501'});
  assert.deepEqual(await repository.applyDeliveryReceipts(correctionEvent,[{...fresh,receiptKey:'a'.repeat(64)}]),['DUPLICATE']);
  assert.equal((await rows()).length,beforeRedaction.length);
  return{signedAdmission:true,canonicalConcurrentReplay:true,pricingCorrections:true,nonpricingConflict:true,legacyUnknown:true,rls:true,fk:true,atomicRollback:true,unmatchedBeforeResponse:true,privacyNoRestoration:true,noResends:true,claim:'OBSERVATIONS_ONLY'};
 }finally{
  if(savedSecret===undefined)delete process.env.META_APP_SECRET_REFERENCE;else process.env.META_APP_SECRET_REFERENCE=savedSecret;
  if(savedApp===undefined)delete process.env.META_APP_ID;else process.env.META_APP_ID=savedApp;
  await database.onModuleDestroy();await pool.end();await admin.end();
 }
}
