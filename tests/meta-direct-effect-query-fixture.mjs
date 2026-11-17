import assert from 'node:assert/strict';
import {verifyMetaCredentialMetadata} from '../packages/core/dist/meta-account-relation.js';

// Strict finite SQL fixture for existing API/close tests, not an alternate runtime.
export function metaDirectEffectQueryFixture({tenantId,conversationId,connectionId,ticketId,chatId,customerId=8,meta=false,held=false,busy=false,anchorValid=true,sourceStatus='PROCESSED',routingHeld=false,routingSources=null,routingClaim='OWN',nativeSource=null}){
 const appId='123456789',sessionId='71000000-0000-4000-8000-000000000001';
 const participantId='72000000-0000-4000-8000-000000000001',aliasId='73000000-0000-4000-8000-000000000001',sourceId='74000000-0000-4000-8000-000000000001';
 const secretReference=`secret://${tenantId}/connections/${connectionId}/meta`,phoneNumberId='123456789',wabaId='234567890';
 const asset={providerSessionId:sessionId,phoneNumberId,wabaId};
 const proof={schemaVersion:1,claim:'PHONE_ACCOUNT_RELATION_VERIFIED',tenantId,connectionId,...asset,secretReference,credentialFingerprint:'b'.repeat(64),
  operationId:'75000000-0000-4000-8000-000000000001',fencingToken:1,graphVersion:'v24.0',verifiedAt:new Date().toISOString(),responseSha256:'a'.repeat(64),
  credentialMetadata:verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0}},{appId})};
 const rows=value=>({rows:value,rowCount:value.length});
 let nativeIntentRead=false;
 return {appId,sourceId,query(sql,values){
  if(sql.startsWith('SELECT conversation.connection_id,connection.provider')){
   assert.deepEqual(values,[tenantId,conversationId]);return rows([{connection_id:connectionId,provider:meta?'META':'WAHA'}]);
  }
  if(!meta)return undefined;
  if(sql.startsWith('SELECT pg_try_advisory_xact_lock_shared')){assert.deepEqual(values,[tenantId]);return rows([{clear:true,acquired:true}]);}
  if(sql.startsWith('SELECT id,state,secret_reference FROM connections')){
   assert.deepEqual(values,[tenantId,connectionId]);assert.match(sql,/FOR NO KEY UPDATE NOWAIT$/);
   if(busy)throw Object.assign(new Error('Synthetic connection busy'),{code:'55P03'});
   return rows([{id:connectionId,state:'WORKING',secret_reference:secretReference}]);
  }
  if(sql.startsWith('SELECT 1 FROM connection_operations'))return rows([]);
  if(sql.startsWith('SELECT id,state,opaque_session_id,provider_state_data'))return rows([{id:sessionId,state:'WORKING',opaque_session_id:phoneNumberId,provider_state_data:{wabaId,metaAccountProof:proof}}]);
  if(sql.startsWith('SELECT connection_id,external_chat_id,zammad_ticket_id,zammad_customer_id'))return rows([{connection_id:connectionId,external_chat_id:chatId,zammad_ticket_id:ticketId,zammad_customer_id:customerId}]);
  if(sql.startsWith('SELECT * FROM app.meta_lifecycle_guard')){assert.deepEqual(values,[connectionId,sessionId,phoneNumberId,wabaId,appId,0]);return rows([{revision_matches:true,blocked:false,unresolved_hold:false}]);}
  if(sql.startsWith('SELECT id FROM participant_identities'))return rows([{id:participantId}]);
  if(sql.startsWith('SELECT id,state,provider_session_id,phone_number_id,waba_id,source_event_id'))return rows([{id:aliasId,state:held?'HELD':'ACTIVE',provider_session_id:sessionId,phone_number_id:phoneNumberId,waba_id:wabaId,source_event_id:sourceId}]);
  if(sql==='SELECT app.meta_direct_alias_source_valid($1,$2,$3) AS valid'){assert.deepEqual(values,[aliasId,chatId,String(customerId)]);return rows([{valid:anchorValid}]);}
  if(sql.startsWith('SELECT meta_direct_asset,status,meta_direct_identity_change,payload_sha256'))return rows([{meta_direct_asset:asset,status:sourceStatus,meta_direct_identity_change:null,payload_sha256:'c'.repeat(64)}]);
  if(sql.startsWith('SELECT 1 FROM normalized_messages'))return rows([{one:1}]);
  if(sql.startsWith('SELECT 1 FROM privacy_jobs job LEFT JOIN privacy_job_targets'))return rows([]);
  if(sql.startsWith('SELECT app.meta_direct_identity_guard'))return rows([{clear:!held}]);
  if(sql.startsWith('SELECT intent.meta_routing_epoch,intent.meta_primary_source_event_id')){
   nativeIntentRead=true;return rows([{meta_routing_epoch:'0',meta_primary_source_event_id:nativeSource}]);
  }
  if(sql.startsWith('SELECT allowed,claim FROM app.meta_direct_routing_guard')){
   assert.deepEqual(values,[connectionId,sessionId,phoneNumberId,wabaId,participantId,appId,
    JSON.stringify({mode:'SIMULATED',graphOrigin:'https://routing-provider.invalid',graphVersion:'v24.0',simulationBindingSha256:'7'.repeat(64)}),nativeSource?[nativeSource]:routingSources,null,nativeIntentRead?0:null]);
   return rows([{allowed:!routingHeld,claim:routingClaim}]);
  }
  return undefined;
 }};
}
