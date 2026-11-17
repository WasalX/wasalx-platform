import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Client,Pool} from 'pg';
import {ConnectionOperationRepository,ConnectionOperationLeaseLostError} from '../services/connector-worker/dist/services/connector-worker/src/connection-operation-repository.js';
import {ConnectionsController} from '../services/control-api/dist/connections.controller.js';
import {metaBillingDiagnosticFromResponses,metaBillingDiagnosticBinding} from '../packages/core/dist/meta-billing-diagnostic.js';
import {verifyMetaCredentialMetadata} from '../packages/core/dist/meta-account-relation.js';

/** Called only from the existing owned, isolated canonical PostgreSQL gate. No provider calls. */
export async function verifyMetaBillingDiagnostics(adminUrl,workerConfig,appUrl){
 const admin=new Client({connectionString:adminUrl});await admin.connect();
 const pool=new Pool(workerConfig),apiPool=new Pool({connectionString:appUrl}),repository=new ConnectionOperationRepository(pool);
 const tenantId=randomUUID(),connectionId=randomUUID(),sessionId=randomUUID(),userId=randomUUID(),otherTenant=randomUUID();
 const appId='12025550130',phoneId='830000000001',wabaId='830000000002',secretReference=`secret://${tenantId}/connections/${connectionId}/meta`;
 const proof={schemaVersion:1,claim:'PHONE_ACCOUNT_RELATION_VERIFIED',tenantId,connectionId,providerSessionId:sessionId,phoneNumberId:phoneId,wabaId,secretReference,
  credentialFingerprint:createHash('sha256').update('synthetic-billing-token').digest('hex'),operationId:randomUUID(),fencingToken:1,graphVersion:'v24.0',
  verifiedAt:new Date().toISOString(),responseSha256:'a'.repeat(64),credentialMetadata:verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,
   scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0}},{appId})};
 const priorApp=process.env.META_APP_ID;
 const tx=async(tenant,fn)=>{const client=await apiPool.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);const result=await fn(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
 const controller=new ConnectionsController({withTenant:tx}, {}, {wakeConnection:async()=>{}});
 const request={id:'billing-pg',principal:{tenantId,userId,subject:`billing-${userId}`,email:'billing@example.invalid',displayName:'Billing fixture',role:'tenant_owner',
  authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:['mfa']}};
 const runtime=async()=>(await admin.query(`SELECT c.state,c.action_reason,c.secret_reference,c.updated_at,ps.state session_state,ps.provider_state_data,
   ps.worker_id,ps.fencing_token,ps.lease_expires_at,ps.updated_at session_updated_at,wr.state route_state,wr.updated_at route_updated_at
   FROM connections c JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id
   JOIN webhook_routes wr ON wr.tenant_id=c.tenant_id AND wr.connection_id=c.id WHERE c.id=$1`,[connectionId])).rows[0];
 const claim=async()=>{const leaseId=randomUUID();const jobs=await repository.claim(tenantId,leaseId,1);assert.equal(jobs.length,1);return{job:jobs[0],leaseId};};
 const enqueue=async(key)=>controller.requestMetaBillingDiagnostic(request,connectionId,key,{});
 const observation=metaBillingDiagnosticFromResponses(wabaId,{id:wabaId,owner_business:{id:'830000000003'}},{id:wabaId,primary_funding_id:'private-funding-id'});
 try{
  process.env.META_APP_ID=appId;
  await admin.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Billing diagnostics',$2,'ACTIVE'),($3,'Billing isolation',$4,'ACTIVE')",[tenantId,`billing-${tenantId}`,otherTenant,`billing-${otherTenant}`]);
  await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,'billing@example.invalid','Billing fixture')",[userId,`billing-${userId}`]);
  await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')",[tenantId,userId]);
  await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference,action_reason) VALUES($1,$2,'Billing diagnostics','META','CLOUD_API','PAUSED',$3,'Operator pause retained')",[connectionId,tenantId,secretReference]);
  await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data)
   VALUES($1,$2,$3,$4,'PAUSED',$5,'ACTIVE',$6)`,[sessionId,tenantId,connectionId,phoneId,`meta-cloud://${wabaId}/${phoneId}`,{wabaId,metaAccountProof:proof,operatorSetting:'retained'}]));
  await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state) VALUES($1,$2,'META',$3,'secret://platform/meta-webhook','PAUSED')",[tenantId,connectionId,phoneId]));
  const original=await runtime();
  const accepted=await Promise.all([enqueue('billing-same-key'),enqueue('billing-same-key')]);
  assert.equal(accepted[0].operation.id,accepted[1].operation.id);assert.equal(accepted.filter(x=>x.duplicate).length,1,'Same-key concurrent admission records one operation');
  await assert.rejects(()=>enqueue('billing-conflict'),/already pending/);
  await assert.rejects(()=>controller.metaBillingDiagnostic({...request,principal:{...request.principal,tenantId:otherTenant}},connectionId),/not found/);
  const first=await claim();assert.equal(await repository.guardMetaBillingDiagnostic(first.job,first.leaseId,appId),'CURRENT','PAUSED current proof permits read-only diagnostic');
  await repository.completeMetaBillingDiagnostic(first.job,first.leaseId,appId,observation);
  assert.deepEqual(await runtime(),original,'Successful diagnostic changes no lifecycle, action reason, data, route, ownership or timestamps');
  const safe=await controller.metaBillingDiagnostic(request,connectionId);assert.equal(safe.current,true);assert.equal(safe.diagnostic.paymentMethod,'PRESENT');
  assert.ok(!JSON.stringify(safe).includes('private-funding-id'));assert.ok(!JSON.stringify(safe).includes('830000000003'));
  await assert.rejects(()=>repository.failMetaBillingDiagnostic(first.job,first.leaseId,{retryable:false,code:'OLD',safeError:'old lease',connectionState:'FAILED'}),ConnectionOperationLeaseLostError);
  await enqueue('billing-retry');const retry=await claim();
  await repository.failMetaBillingDiagnostic(retry.job,retry.leaseId,{retryable:true,code:'META_RATE_LIMITED',safeError:'Read temporarily unavailable',retryAt:new Date(Date.now()-1000).toISOString(),connectionState:'FAILED'});
  assert.deepEqual(await runtime(),original,'Retryable diagnostic failure leaves PAUSED lifecycle untouched');
  const reclaimed=await claim();assert.ok(reclaimed.job.fencingToken>retry.job.fencingToken);
  await assert.rejects(()=>repository.completeMetaBillingDiagnostic(retry.job,retry.leaseId,appId,observation),ConnectionOperationLeaseLostError);
  await repository.failMetaBillingDiagnostic(reclaimed.job,reclaimed.leaseId,{retryable:false,code:'META_AUTHENTICATION_FAILED',safeError:'Access unavailable',connectionState:'ACTION_REQUIRED'});
  assert.deepEqual(await runtime(),original,'Authentication failure changes only diagnostic operation');
  await enqueue('billing-negative');const blocked=await claim();assert.equal(await repository.guardMetaBillingDiagnostic(blocked.job,blocked.leaseId,appId),'CURRENT');
  const inboxId=randomUUID();await admin.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status)
   VALUES($1,$2,$3,'META',$4,'meta.account.lifecycle.block',$5,$6,'ACCEPTED')`,[inboxId,tenantId,connectionId,`billing-negative-${inboxId}`,
   {admission:{asset:{providerSessionId:sessionId,phoneNumberId:phoneId,wabaId,appId}}},'b'.repeat(64)]);
  assert.equal(await repository.guardMetaBillingDiagnostic(blocked.job,blocked.leaseId,appId),'HELD','Pending signed negative fences next request before worker application');
  await repository.completeMetaBillingDiagnostic(blocked.job,blocked.leaseId,appId,observation);
  assert.equal((await controller.metaBillingDiagnostic(request,connectionId)).diagnostic.reason,'ACCESS_HELD');assert.deepEqual(await runtime(),original);
  // Synthetic hold removal here is fixture setup, never a production recovery or event replay.
  await admin.query('DELETE FROM event_inbox WHERE id=$1',[inboxId]);
  await enqueue('billing-superseded');const superseded=await claim();
  const rotated={...proof,credentialFingerprint:'c'.repeat(64),operationId:randomUUID()};
  await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof}',$1::jsonb) WHERE id=$2",[JSON.stringify(rotated),sessionId]));
  const afterRotation=await runtime();assert.equal(await repository.guardMetaBillingDiagnostic(superseded.job,superseded.leaseId,appId),'CHANGED');
  await repository.completeMetaBillingDiagnostic(superseded.job,superseded.leaseId,appId,observation);
  assert.deepEqual(await runtime(),afterRotation,'Old diagnostic cannot overwrite newer proof');
  assert.equal((await controller.metaBillingDiagnostic(request,connectionId)).diagnostic.reason,'BINDING_CHANGED');
  await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE webhook_routes SET state='REVOKED' WHERE tenant_id=$1 AND connection_id=$2",[tenantId,connectionId]));
  await enqueue('billing-revoked');const revoked=await claim();assert.equal(await repository.guardMetaBillingDiagnostic(revoked.job,revoked.leaseId,appId),'HELD');
  await repository.completeMetaBillingDiagnostic(revoked.job,revoked.leaseId,appId,observation);
  assert.equal((await controller.metaBillingDiagnostic(request,connectionId)).current,false);
  const expired={...rotated,credentialMetadata:{...rotated.credentialMetadata,expiresAt:Math.floor(Date.now()/1000)-1}};
  await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE webhook_routes SET state='PAUSED' WHERE tenant_id=$1 AND connection_id=$2",[tenantId,connectionId]));
  await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof}',$1::jsonb) WHERE id=$2",[JSON.stringify(expired),sessionId]));
  await enqueue('billing-expired');const expiry=await claim();assert.equal(await repository.guardMetaBillingDiagnostic(expiry.job,expiry.leaseId,appId),'HELD');
  await repository.completeMetaBillingDiagnostic(expiry.job,expiry.leaseId,appId,observation);
  assert.equal((await controller.metaBillingDiagnostic(request,connectionId)).diagnostic.reason,'ACCESS_HELD');
  await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET provider_state_data=$1 WHERE id=$2",[{wabaId,operatorSetting:'retained'},sessionId]));
  const legacy=await runtime();await enqueue('billing-legacy');const legacyJob=await claim();
  assert.equal(await repository.guardMetaBillingDiagnostic(legacyJob.job,legacyJob.leaseId,appId),'HELD','Legacy missing proof is a diagnostic hold, not connection deactivation');
  await repository.completeMetaBillingDiagnostic(legacyJob.job,legacyJob.leaseId,appId,observation);assert.deepEqual(await runtime(),legacy);
  await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET provider_state_data=$1 WHERE id=$2",[{wabaId,metaAccountProof:proof,operatorSetting:'retained'},sessionId]));
  await enqueue('billing-inactive-tenant');const inactive=await claim();const inactiveRuntime=await runtime();
  await admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1",[tenantId]);
  assert.equal(await repository.guardMetaBillingDiagnostic(inactive.job,inactive.leaseId,appId),'HELD','Actual worker role checks active tenant through existing boolean, without tenant SELECT grant');
  await repository.completeMetaBillingDiagnostic(inactive.job,inactive.leaseId,appId,observation);
  assert.equal((await admin.query('SELECT result FROM connection_operations WHERE id=$1',[inactive.job.id])).rows[0].result.metaBillingDiagnostic.reason,'ACCESS_HELD');
  assert.deepEqual(await runtime(),inactiveRuntime,'Inactive-tenant completion does not mutate connection/session/route');
  await admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1",[tenantId]);
  const projection=metaBillingDiagnosticBinding(secretReference,expiry.job.providerSession,appId);assert.equal(projection.providerSessionId,sessionId);
  return{operationOnlySuccess:true,operationOnlyRetryAndFailure:true,pausedPreserved:true,staleLeaseDenied:true,concurrentReplay:true,rls:true,pendingNegativeBeforeRequest:true,credentialSupersession:true,revokedRouteHeld:true,expiryHeld:true,safeProjection:true};
 }finally{if(priorApp===undefined)delete process.env.META_APP_ID;else process.env.META_APP_ID=priorApp;await Promise.all([pool.end(),apiPool.end()]);await admin.end();}
}
