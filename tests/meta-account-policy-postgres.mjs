import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {Client,Pool} from 'pg';
import {migrate} from '../services/control-api/dist/migrate.js';
import {ConnectionsController} from '../services/control-api/dist/connections.controller.js';
import {assertMetaTransitionWriter,requestMetaTransitionPreview} from '../services/control-api/dist/meta-account-transition.js';
import {ConnectionOperationRepository} from '../services/connector-worker/dist/services/connector-worker/src/connection-operation-repository.js';
import {OutboxRepository} from '../services/connector-worker/dist/services/connector-worker/src/repository.js';
import {PrivacyRepository} from '../services/connector-worker/dist/services/connector-worker/src/privacy-repository.js';
import {verifyMetaCredentialMetadata} from '../packages/core/dist/meta-account-relation.js';
import {verifyMetaTransitionPreview} from './meta-account-transition-postgres.mjs';
import {metaAccountFundingProof} from '../packages/core/dist/meta-account-policy.js';
import {metaBillingDiagnosticBinding,metaBillingDiagnosticProofCurrent} from '../packages/core/dist/meta-billing-diagnostic.js';
import {ConflictException} from '../services/control-api/node_modules/@nestjs/common/index.js';
import {requirePrivilegedAuthentication} from '../services/control-api/dist/privileged-auth.js';

/** Actual roles/SQL, simulated bounded Graph observations, no provider or payment mutation. */
export async function verifyMetaAccountPolicy(adminUrl,workerConfig,appUrl){
 const admin=new Client({connectionString:adminUrl});await admin.connect();const worker=new Pool(workerConfig),app=new Pool({connectionString:appUrl});
 const operations=new ConnectionOperationRepository(worker),outbox=new OutboxRepository(worker);
 const privacy=new PrivacyRepository(worker);
 const tenant=randomUUID(),other=randomUUID(),user=randomUUID(),connection=randomUUID(),session=randomUUID(),group=randomUUID();
 const phone='840000000001',account='840000000002',appId='12025550130',token='synthetic-account-token',secret=`secret://${tenant}/connections/${connection}/meta`;
 const proof={schemaVersion:1,claim:'PHONE_ACCOUNT_RELATION_VERIFIED',tenantId:tenant,connectionId:connection,providerSessionId:session,phoneNumberId:phone,wabaId:account,secretReference:secret,
  credentialFingerprint:createHash('sha256').update(token).digest('hex'),operationId:randomUUID(),fencingToken:1,graphVersion:'v24.0',verifiedAt:new Date().toISOString(),responseSha256:'a'.repeat(64),
  credentialMetadata:verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0}},{appId})};
 const priorApp=process.env.META_APP_ID;
 const tx=async(pool,t,fn)=>{const client=await pool.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[t]);const value=await fn(client);await client.query('COMMIT');return value;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}};
 const controller=new ConnectionsController({withTenant:(t,fn)=>tx(app,t,fn)},{},{wakeConnection:async()=>{}});
 const request={id:'account-policy-pg',principal:{tenantId:tenant,userId:user,role:'tenant_owner',authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:['mfa']}};
 const claim=async()=>{const lease=randomUUID(),jobs=await operations.claim(tenant,lease,1);assert.equal(jobs.length,1);return{job:jobs[0],lease};};
 const present=()=>metaAccountFundingProof(account,{id:account,owner_business:{id:'840000000003'}},{id:account,primary_funding_id:'synthetic-funding'});
 const state=async()=>(await admin.query('SELECT c.state,c.action_reason,c.secret_reference,ps.provider_state_data,ps.state AS session_state FROM connections c JOIN provider_sessions ps ON ps.connection_id=c.id WHERE c.id=$1',[connection])).rows[0];
 const queue=async()=>{const id=randomUUID(),lease=randomUUID();await tx(app,tenant,client=>client.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,group_workspace_group_id,delivery_origin,message_body,content_type,idempotency_key,state,attempts,lease_id,lease_expires_at)
   VALUES($1,$2,$3,$4,'GROUP_WORKSPACE','Synthetic account proof','text/plain',$5,'CLAIMED',1,$6,now()+interval '120 seconds')`,[id,tenant,connection,group,`account-${id}`,lease]));
  await admin.query("INSERT INTO delivery_attempts(tenant_id,delivery_id,attempt_number,state) VALUES($1,$2,1,'CLAIMED')",[tenant,id]);
  const snapshot=(await admin.query('SELECT meta_billing_snapshot FROM delivery_outbox WHERE id=$1',[id])).rows[0].meta_billing_snapshot;
  return{lease,job:{id,tenantId:tenant,connectionId:connection,groupId:'synthetic-meta-group',recipientType:'GROUP',groupWorkspaceGroupId:group,text:'Synthetic account proof',contentType:'text/plain',idempotencyKey:`account-${id}`,attempts:1,provider:'meta',sessionId:phone,connectionSecretReference:secret,metaCredentialContext:{providerSessionId:session,phoneNumberId:phone,wabaId:account,proof},metaBillingSnapshot:snapshot,zammadBaseUrl:'https://zammad.invalid',zammadSecretReference:'unused'}};};
 try{
  process.env.META_APP_ID=appId;
  await admin.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Account policy',$2,'ACTIVE'),($3,'Account isolation',$4,'ACTIVE')",[tenant,`account-${tenant}`,other,`account-${other}`]);
  await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,'account@example.invalid','Account fixture')",[user,`account-${user}`]);
  await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')",[tenant,user]);
  await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference,action_reason) VALUES($1,$2,'Account fixture','META','CLOUD_API','WORKING',$3,'Retained operator reason')",[connection,tenant,secret]);
  await withFixtureTenant(admin,tenant,()=>admin.query(`INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data)
   VALUES($1,$2,$3,$4,'WORKING',$5,'ACTIVE',$6)`,[session,tenant,connection,phone,`meta-cloud://${account}/${phone}`,{wabaId:account,metaAccountProof:proof}]));
  await withFixtureTenant(admin,tenant,()=>admin.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state) VALUES($1,$2,'META',$3,'secret://platform/meta-webhook','ACTIVE')",[tenant,connection,phone]));
  await admin.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,'synthetic-meta-group','Account fixture group')",[group,tenant,connection]);
  const legacy=await queue();assert.equal(legacy.job.metaBillingSnapshot.claim,'LEGACY_UNATTRIBUTED');
  assert.equal(await tx(worker,tenant,async client=>(await client.query('SELECT app.meta_billing_delivery_current($1) AS ready',[legacy.job.id])).rows[0].ready),true);
  await tx(app,tenant,async c=>{
   assert.deepEqual((await c.query("SELECT current_user AS role,session_user AS login,pg_has_role(current_user,'wasalx_app','MEMBER') app_member,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) bypass")).rows[0],{role:'wasalx_runtime',login:'wasalx_runtime',app_member:true,bypass:false});
   assert.equal((await c.query("SELECT pg_has_role(current_user,'wasalx_meta_transition_executor','MEMBER') allowed")).rows[0].allowed,false,'App cannot adopt the internal executor');
   assert.equal((await c.query("SELECT has_function_privilege(current_user,'app.meta_managed_privacy_authorized(uuid)','EXECUTE') allowed")).rows[0].allowed,false);
   await c.query('SAVEPOINT private_helper_acl');
   await assert.rejects(()=>c.query('SELECT app.meta_managed_privacy_authorized($1)',[tenant]),{code:'42501'},'Ordinary policy writers cannot call the private leased privacy helper');
   await c.query('ROLLBACK TO SAVEPOINT private_helper_acl');await c.query('RELEASE SAVEPOINT private_helper_acl');
  });
  let original=await state();const body={mode:'CUSTOMER',expectedRevision:0};
  const admitted=await Promise.all([controller.requestMetaBillingPolicy(request,connection,'account-same',body),controller.requestMetaBillingPolicy(request,connection,'account-same',body)]);
  assert.equal(admitted[0].id,admitted[1].id);assert.equal(admitted.filter(v=>v.duplicate).length,1);
  await assert.rejects(()=>controller.requestMetaBillingPolicy(request,connection,'account-same',{...body,expectedRevision:1}),/another request/);
  assert.deepEqual(await state(),original,'Declaring responsibility changes no connection lifecycle');
  assert.equal(await tx(worker,tenant,async client=>(await client.query('SELECT app.meta_billing_delivery_current($1) AS ready',[legacy.job.id])).rows[0].ready),false,'Old queued legacy attribution cannot adopt new account policy');
  const first=await claim();const observed=present();
  await operations.completeMetaBillingDiagnostic(first.job,first.lease,appId,observed.diagnostic,observed.funding);
  assert.deepEqual(await state(),original,'Funding completion changes account readiness only');
  let safe=await controller.metaBillingPolicy(request,connection);assert.equal(safe.sendReady,true);assert.equal(safe.actualPayer,'UNVERIFIED');
  await verifyAbsentRequesterMembership({admin,app,tx,tenant,connection,appId});
  const transitionPreview=await verifyMetaTransitionPreview({admin,app,worker,tx,tenant,other,user,connection,account,phone,appId,request,controller,operations,state});
  assert.equal(transitionPreview.lifecycleUnchanged,true);
  const waha=randomUUID(),wahaGroup=randomUUID(),wahaDelivery=randomUUID();
  await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Non-Meta preservation','WAHA','GOWS','PAUSED',$3)",[waha,tenant,`secret://${tenant}/connections/${waha}/waha`]);
  await admin.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,'synthetic-waha-group','Non-Meta group')",[wahaGroup,tenant,waha]);
  const nonMetaSql=`INSERT INTO delivery_outbox(id,tenant_id,connection_id,group_workspace_group_id,delivery_origin,message_body,content_type,idempotency_key,state,meta_billing_snapshot)
    VALUES($1,$2,$3,$4,'GROUP_WORKSPACE','Non-Meta fixture','text/plain',$5,'QUEUED',$6)`;
  await tx(app,tenant,client=>client.query(nonMetaSql,[wahaDelivery,tenant,waha,wahaGroup,`waha-${wahaDelivery}`,null]));
  assert.equal((await admin.query('SELECT meta_billing_snapshot FROM delivery_outbox WHERE id=$1',[wahaDelivery])).rows[0].meta_billing_snapshot,null);
  await assert.rejects(()=>tx(app,tenant,client=>client.query(nonMetaSql,[randomUUID(),tenant,waha,wahaGroup,`forged-${randomUUID()}`,{schemaVersion:1,claim:'LEGACY_UNATTRIBUTED'}])),{code:'23514'});
  await assert.rejects(()=>tx(app,tenant,client=>client.query("INSERT INTO meta_messaging_accounts(tenant_id,provider_account_id,state) VALUES($1,'840000000099','READY')",[tenant])),{code:'23514'});
  await assert.rejects(()=>tx(app,tenant,client=>client.query("UPDATE meta_messaging_accounts SET primary_funding_id='forged',authority_revision=authority_revision+1 WHERE tenant_id=$1",[tenant])),{code:'23514'},'No current private receipt permits fabricated funding');
  await assert.rejects(()=>tx(app,tenant,client=>client.query("UPDATE meta_connection_account_bindings SET phone_number_id='840000000099',revision=revision+1 WHERE tenant_id=$1",[tenant])),{code:'23514'},'A forged binding cannot replace the current verified asset');
  await assert.rejects(()=>tx(app,tenant,client=>client.query("UPDATE meta_messaging_accounts SET state='RETIRED',authority_revision=authority_revision+1 WHERE tenant_id=$1",[tenant])),{code:'23514'},'Private history cannot be retired outside the leased tenant deletion');
  assert.ok(!JSON.stringify(safe).includes('synthetic-funding'));assert.ok(!JSON.stringify(safe).includes(account));
  const current=await queue();assert.equal(current.job.metaBillingSnapshot.claim,'ACCOUNT_POLICY_BOUND');
  assert.equal(current.job.metaBillingSnapshot.accountAuthorityRevision,safe.revision);
  await verifyMetaPolicyLookupClosure({workerConfig,appUrl,tenant,connection,group,user,accountId:current.job.metaBillingSnapshot.accountId,
   deliveryId:current.job.id,fundingOperationId:first.job.id});
  await outbox.beginSend(current.job,current.lease);
  assert.equal((await admin.query('SELECT meta_billing_admission FROM delivery_attempts WHERE delivery_id=$1',[current.job.id])).rows[0].meta_billing_admission,null,'BeginSend is not final message admission');
  const attempt=(await admin.query('SELECT id FROM delivery_attempts WHERE delivery_id=$1',[current.job.id])).rows[0].id;
  const forged={schemaVersion:1,claim:'MESSAGES_REQUEST_ADMITTED',attemptId:attempt,attemptNumber:1,deliveryId:current.job.id,
   admittedAt:new Date().toISOString(),requestSha256:'b'.repeat(64),snapshot:current.job.metaBillingSnapshot,
   funding:{responseSha256:'f'.repeat(64),observedAt:observed.funding.observedAt,expiresAt:observed.funding.expiresAt}};
  await assert.rejects(()=>tx(worker,tenant,client=>client.query('UPDATE delivery_attempts SET meta_billing_admission=$1 WHERE id=$2',[forged,attempt])),{code:'55000'},'Admission binds actual private funding, not caller facts');
  const exactAdmission={...forged,funding:{responseSha256:observed.funding.responseSha256,observedAt:observed.funding.observedAt,expiresAt:observed.funding.expiresAt}};
  await assert.rejects(()=>tx(worker,tenant,client=>client.query('UPDATE delivery_attempts SET delivery_id=$1,meta_billing_admission=$2 WHERE id=$3',[wahaDelivery,exactAdmission,attempt])),
   e=>e.code==='23514'&&e.message==='Retained attempt identity is immutable','First admission cannot be combined with a same-tenant retarget');
  await assert.rejects(()=>tx(app,tenant,client=>client.query('UPDATE delivery_attempts SET meta_billing_admission=$1 WHERE id=$2',[exactAdmission,attempt])),
   e=>e.code==='23514'&&e.message==='Only the connector worker may admit a Messages request','API cannot forge otherwise exact worker request evidence');
  await assert.rejects(()=>outbox.admitMetaMessageRequest({...current.job,metaBillingSnapshot:{...current.job.metaBillingSnapshot,providerAccountId:'840000000099'}},current.lease,'b'.repeat(64)),e=>e.code==='META_MESSAGE_NOT_ATTEMPTED','The wire job cannot change the database birth attribution');
  assert.equal((await admin.query('SELECT meta_billing_admission FROM delivery_attempts WHERE id=$1',[attempt])).rows[0].meta_billing_admission,null);
  await outbox.admitMetaMessageRequest(current.job,current.lease,'b'.repeat(64));
  const stamped=(await admin.query('SELECT meta_billing_admission FROM delivery_attempts WHERE delivery_id=$1',[current.job.id])).rows[0].meta_billing_admission;
  assert.equal(stamped.snapshot.providerAccountId,account);assert.equal(stamped.requestSha256,'b'.repeat(64));assert.equal(stamped.funding.responseSha256,observed.funding.responseSha256);
  for(const pool of [app,worker])for(const unchangedEffect of [false,true])for(const [field,value] of [['id',randomUUID()],['delivery_id',wahaDelivery],['attempt_number',3]]){
   await assert.rejects(()=>tx(pool,tenant,client=>client.query(`UPDATE delivery_attempts SET ${field}=$1${unchangedEffect?',external_message_id=external_message_id':''} WHERE id=$2`,[value,attempt])),
    e=>e.code==='23514'&&e.message==='Retained attempt identity is immutable','Retained attempt stays on its original identity and privacy target');
  }
  // Establish every other success predicate under admin in a rolled-back transaction;
  // only the exact app role must prevent the first effect assignment. No ACL changes.
  await admin.query('BEGIN');try{
   await admin.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
   await admin.query("UPDATE delivery_outbox SET state='SENT',external_message_id='wamid.app-forgery' WHERE id=$1",[current.job.id]);
   await admin.query('SET LOCAL ROLE wasalx_app');
   await assert.rejects(()=>admin.query("UPDATE delivery_attempts SET external_message_id='wamid.app-forgery',state='SENT',finished_at=now() WHERE id=$1",[attempt]),
    e=>e.code==='23514'&&e.message==='Only the connector worker may record provider effect evidence');
  }finally{await admin.query('ROLLBACK');}
  await assert.rejects(()=>outbox.admitMetaMessageRequest(current.job,current.lease,'b'.repeat(64)),e=>e.code==='META_MESSAGE_NOT_ATTEMPTED','Same attempt cannot redispatch');
  const stray=randomUUID();await admin.query("INSERT INTO delivery_attempts(id,tenant_id,delivery_id,attempt_number,state) VALUES($1,$2,$3,2,'SENDING')",[stray,tenant,current.job.id]);
  await assert.rejects(()=>tx(worker,tenant,client=>client.query("UPDATE delivery_attempts SET external_message_id='forged',state='SENT',finished_at=now() WHERE id=$1",[stray])),{code:'23514'},'A noncurrent SENDING attempt cannot invent effect association');
  await outbox.complete(current.job,current.lease,'SENT','wamid.account-success');
  await assert.rejects(()=>tx(worker,tenant,client=>client.query("UPDATE delivery_attempts SET external_message_id='wamid.account-success',state='SENT',finished_at=now() WHERE id=$1",[stray])),{code:'23514'},'The final parent effect belongs to exactly its admitted current attempt');
  await admin.query("UPDATE delivery_attempts SET state='FAILED_TERMINAL',finished_at=now() WHERE id=$1",[stray]);
  const success=(await admin.query('SELECT d.external_message_id,a.external_message_id AS attempt_effect FROM delivery_outbox d JOIN delivery_attempts a ON a.delivery_id=d.id AND a.attempt_number=d.attempts WHERE d.id=$1',[current.job.id])).rows[0];
  assert.deepEqual(success,{external_message_id:'wamid.account-success',attempt_effect:'wamid.account-success'});
  await assert.rejects(()=>tx(worker,tenant,client=>client.query("UPDATE delivery_attempts SET external_message_id='forged' WHERE delivery_id=$1",[current.job.id])),e=>e.code==='23514');
  assert.equal((await tx(app,other,client=>client.query('SELECT id FROM meta_messaging_accounts WHERE id=$1',[current.job.metaBillingSnapshot.accountId]))).rowCount,0,'RLS hides another tenant account');
  for(const pool of [app,worker]){
   await assert.rejects(()=>tx(pool,tenant,client=>client.query("UPDATE connection_operations SET result=jsonb_set(result,'{metaAccountFundingProof,primaryFundingId}','\"forged\"') WHERE id=$1",[first.job.id])),{code:'23514'});
   await assert.rejects(()=>tx(pool,tenant,client=>client.query("UPDATE connection_operations SET payload=jsonb_set(payload,'{metaAccountPolicy,authorityRevision}','999') WHERE id=$1",[first.job.id])),{code:'23514'});
  }
  await assert.rejects(()=>tx(app,tenant,client=>client.query('UPDATE meta_messaging_accounts SET last_observation_operation_id=NULL WHERE tenant_id=$1',[tenant])),{code:'23514'},'The retained authority pointer cannot discard its exact observation');
  await assert.rejects(()=>tx(app,tenant,client=>client.query('DELETE FROM connection_operations WHERE id=$1',[first.job.id])),{code:'55000'},'Superseded private receipts cannot be deleted');
  const refresh=await controller.requestMetaBillingDiagnostic(request,connection,'account-refresh',{});assert.ok(refresh.id);
  const refreshJob=await claim(),freshSame=present();await operations.completeMetaBillingDiagnostic(refreshJob.job,refreshJob.lease,appId,freshSame.diagnostic,freshSame.funding);
  assert.equal((await controller.metaBillingPolicy(request,connection)).revision,safe.revision,'Timestamp-only same facts do not invalidate snapshots');
  const expiry=await queue();
  // Create a bounded historical observation through the actual leased completion
  // path inside a rolled-back worker transaction; never rewrite a completed receipt.
  await controller.requestMetaBillingDiagnostic(request,connection,'account-expiry',{});const expiryRead=await claim();
  const past=metaAccountFundingProof(account,{id:account,owner_business:{id:'840000000003'}},{id:account,primary_funding_id:'synthetic-funding'},new Date(Date.now()-16*60_000));
  const historical=await worker.connect();try{await historical.query('BEGIN');await historical.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
   await historical.query('SELECT id FROM app.complete_connection_operation($1,$2,$3,$4)',[expiryRead.job.id,expiryRead.lease,expiryRead.job.fencingToken,{metaBillingDiagnostic:past.diagnostic,metaAccountFundingProof:past.funding}]);
   await historical.query('UPDATE meta_messaging_accounts SET funding_observed_at=$1,funding_expires_at=$2,last_observation_operation_id=$3 WHERE tenant_id=$4',[past.funding.observedAt,past.funding.expiresAt,expiryRead.job.id,tenant]);
   assert.equal((await historical.query('SELECT app.meta_billing_delivery_current($1) ready',[expiry.job.id])).rows[0].ready,false,'Expired funding cannot authorize a final send');
  }finally{await historical.query('ROLLBACK');historical.release();}
  await operations.completeMetaBillingDiagnostic(expiryRead.job,expiryRead.lease,appId,freshSame.diagnostic,freshSame.funding);
  await admin.query('BEGIN');try{
   await admin.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
   await admin.query('UPDATE meta_connection_account_bindings SET revision=revision+1 WHERE tenant_id=$1',[tenant]);
   assert.equal((await admin.query('SELECT app.meta_billing_delivery_current($1) ready',[expiry.job.id])).rows[0].ready,false,'A binding generation change never adopts an old birth snapshot');
   assert.equal(Number((await admin.query('SELECT authority_revision FROM meta_messaging_accounts WHERE tenant_id=$1',[tenant])).rows[0].authority_revision),safe.revision,'Connection generation is independent from shared account authority');
  }finally{await admin.query('ROLLBACK');}
  // The second phone learns the shared revision through its own current proof,
  // then a credential-only refresh of A must not invalidate B's birth/admission.
  const connectionB=randomUUID(),sessionB=randomUUID(),groupB=randomUUID(),phoneB='840000000004',secretB=`secret://${tenant}/connections/${connectionB}/meta`;
  const proofB={...proof,connectionId:connectionB,providerSessionId:sessionB,phoneNumberId:phoneB,secretReference:secretB,operationId:randomUUID()};
  await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Second account phone','META','CLOUD_API','WORKING',$3)",[connectionB,tenant,secretB]);
  await withFixtureTenant(admin,tenant,()=>admin.query(`INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data)
    VALUES($1,$2,$3,$4,'WORKING',$5,'ACTIVE',$6)`,[sessionB,tenant,connectionB,phoneB,`meta-cloud://${account}/${phoneB}`,{wabaId:account,metaAccountProof:proofB}]));
  await withFixtureTenant(admin,tenant,()=>admin.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state) VALUES($1,$2,'META',$3,'secret://platform/meta-webhook','ACTIVE')",[tenant,connectionB,phoneB]));
  await admin.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,'synthetic-meta-group-b','Second phone group')",[groupB,tenant,connectionB]);
  const originalBinding=(await tx(app,tenant,client=>client.query('SELECT provider_session_id,revision FROM meta_connection_account_bindings WHERE tenant_id=$1 AND connection_id=$2',[tenant,connection]))).rows;
  await assert.rejects(()=>tx(app,tenant,client=>client.query('UPDATE meta_connection_account_bindings SET provider_session_id=$3,revision=revision+1 WHERE tenant_id=$1 AND connection_id=$2',[tenant,connection,sessionB])),{code:'23514'},'A same-tenant session from another connection cannot replace the admitted binding');
  assert.deepEqual((await tx(app,tenant,client=>client.query('SELECT provider_session_id,revision FROM meta_connection_account_bindings WHERE tenant_id=$1 AND connection_id=$2',[tenant,connection]))).rows,originalBinding);
  const viewB=await controller.metaBillingPolicy(request,connectionB);assert.equal(viewB.enrolled,false);assert.equal(viewB.revision,safe.revision);
  await assert.rejects(()=>controller.requestMetaBillingPolicy(request,connectionB,'account-b-stale',{mode:'CUSTOMER',expectedRevision:0}),/changed/);
  await controller.requestMetaBillingPolicy(request,connectionB,'account-b',{mode:'CUSTOMER',expectedRevision:viewB.revision});const enrolledB=await claim();
  await operations.completeMetaBillingDiagnostic(enrolledB.job,enrolledB.lease,appId,observed.diagnostic,observed.funding);
  safe=await controller.metaBillingPolicy(request,connection);const sharedRevision=safe.revision;
  const queueB=async()=>{const id=randomUUID(),lease=randomUUID();await tx(worker,tenant,client=>client.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,group_workspace_group_id,delivery_origin,message_body,content_type,idempotency_key,state,attempts,lease_id,lease_expires_at)
    VALUES($1,$2,$3,$4,'GROUP_WORKSPACE','Second phone','text/plain',$5,'CLAIMED',1,$6,clock_timestamp()+interval '120 seconds')`,[id,tenant,connectionB,groupB,`account-${id}`,lease]));
   await tx(worker,tenant,client=>client.query("INSERT INTO delivery_attempts(tenant_id,delivery_id,attempt_number,state) VALUES($1,$2,1,'CLAIMED')",[tenant,id]));
   const snap=(await admin.query('SELECT meta_billing_snapshot FROM delivery_outbox WHERE id=$1',[id])).rows[0].meta_billing_snapshot;
   return{lease,job:{...current.job,id,connectionId:connectionB,groupId:'synthetic-meta-group-b',groupWorkspaceGroupId:groupB,sessionId:phoneB,connectionSecretReference:secretB,
    metaCredentialContext:{providerSessionId:sessionB,phoneNumberId:phoneB,wabaId:account,proof:proofB},metaBillingSnapshot:snap,idempotencyKey:`account-${id}`,attempts:1}};};
  const stableB=await queueB();
  proof.credentialFingerprint=createHash('sha256').update('synthetic-rotated-account-token').digest('hex');proof.operationId=randomUUID();
  await withFixtureTenant(admin,tenant,()=>admin.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof}',$1) WHERE id=$2",[proof,session]));
  original=await state();await controller.requestMetaBillingDiagnostic(request,connection,'account-rotation-a',{});const rotatedA=await claim();
  await operations.completeMetaBillingDiagnostic(rotatedA.job,rotatedA.lease,appId,observed.diagnostic,observed.funding);
  assert.equal((await controller.metaBillingPolicy(request,connection)).revision,sharedRevision);
  await outbox.beginSend(stableB.job,stableB.lease);await outbox.admitMetaMessageRequest(stableB.job,stableB.lease,'d'.repeat(64));
  await outbox.complete(stableB.job,stableB.lease,'SENT','wamid.second-phone');
  await controller.requestMetaBillingDiagnostic(request,connection,'account-stale-read',{});const staleRead=await claim();
  await controller.requestMetaBillingDiagnostic(request,connectionB,'account-newer-read',{});const newerRead=await claim();
  await operations.completeMetaBillingDiagnostic(newerRead.job,newerRead.lease,appId,observed.diagnostic,present().funding);
  await operations.failMetaBillingDiagnostic(staleRead.job,staleRead.lease,{retryable:false,code:'META_AUTHENTICATION_FAILED',safeError:'Synthetic stale read',connectionState:'WORKING'},appId);
  assert.equal((await controller.metaBillingPolicy(request,connectionB)).sendReady,true,'An older failed read cannot downgrade a newer same-facts observation');
  const beforeFailure=await queueB();await outbox.beginSend(beforeFailure.job,beforeFailure.lease);
  await controller.requestMetaBillingDiagnostic(request,connection,'account-read-denied',{});const deniedRead=await claim();
  await assert.rejects(()=>tx(app,tenant,client=>client.query('SELECT id FROM app.complete_connection_operation($1,$2,$3,$4)',[deniedRead.job.id,deniedRead.lease,deniedRead.job.fencingToken,{metaAccountFundingProof:present().funding}])),{code:'23514'},'App role cannot fabricate a private funding completion');
  await operations.failMetaBillingDiagnostic(deniedRead.job,deniedRead.lease,{retryable:true,code:'META_AUTHENTICATION_FAILED',safeError:'Synthetic funding GET 403',connectionState:'WORKING'},appId);
  await assert.rejects(()=>outbox.admitMetaMessageRequest(beforeFailure.job,beforeFailure.lease,'e'.repeat(64)),e=>e.outcomeKnown===true&&e.code==='META_BILLING_SEND_HELD');
  assert.equal((await admin.query('SELECT meta_billing_admission FROM delivery_attempts WHERE delivery_id=$1',[beforeFailure.job.id])).rows[0].meta_billing_admission,null);
  await outbox.fail(beforeFailure.job,beforeFailure.lease,false,'Funding held before Messages',undefined,false,'META_BILLING_SEND_HELD');
  await controller.requestMetaBillingDiagnostic(request,connection,'account-read-restored',{});const restoredRead=await claim();
  await operations.completeMetaBillingDiagnostic(restoredRead.job,restoredRead.lease,appId,observed.diagnostic,present().funding);
  assert.equal((await controller.metaBillingPolicy(request,connectionB)).sendReady,true);
  assert.equal(await tx(worker,tenant,async client=>(await client.query('SELECT app.meta_billing_delivery_current($1) ready',[beforeFailure.job.id])).rows[0].ready),false,'Reapproval never revives the prior birth generation');
  await assert.rejects(()=>tx(app,tenant,client=>client.query('DELETE FROM connection_operations WHERE id=$1',[first.job.id])),{code:'55000'},'An older superseded private proof remains retained');
  const beforeNone=await queue();await controller.requestMetaBillingDiagnostic(request,connection,'account-none',{});const noneJob=await claim();
  const none=metaAccountFundingProof(account,{id:account},{id:account});await operations.completeMetaBillingDiagnostic(noneJob.job,noneJob.lease,appId,none.diagnostic,none.funding);
  await assert.rejects(()=>outbox.beginSend(beforeNone.job,beforeNone.lease),e=>e.code==='META_BILLING_SEND_HELD');
  assert.equal((await controller.metaBillingPolicy(request,connection)).sendReady,false,'NONE holds ordinary text, no inferred free/service exception');
  assert.equal((await admin.query('SELECT meta_billing_admission FROM delivery_attempts WHERE delivery_id=$1',[beforeNone.job.id])).rows[0].meta_billing_admission,null);
  assert.deepEqual(await state(),original);
  await controller.requestMetaBillingDiagnostic(request,connection,'account-late-positive',{});const late=await claim();
  const negative=randomUUID();await admin.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status)
    VALUES($1,$2,$3,'META',$4,'meta.account.lifecycle.block',$5,$6,'ACCEPTED')`,[negative,tenant,connection,`account-negative-${negative}`,
      {admission:{asset:{providerSessionId:session,phoneNumberId:phone,wabaId:account,appId}}},'c'.repeat(64)]);
  await operations.completeMetaBillingDiagnostic(late.job,late.lease,appId,observed.diagnostic,observed.funding);
  const latest=(await admin.query('SELECT state,funding_status FROM meta_messaging_accounts WHERE tenant_id=$1',[tenant])).rows[0];
  assert.deepEqual(latest,{state:'HELD',funding_status:'NONE'},'A pending authoritative negative prevents late positive funding from releasing access');
  // Fixture-only removal; no production recovery/event replay is implemented here.
  await admin.query('DELETE FROM event_inbox WHERE id=$1',[negative]);
  const privacyJob=async(type)=>{
   const id=randomUUID(),leaseId=randomUUID();const created=(await admin.query(`INSERT INTO privacy_jobs
    (id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,lease_id,lease_expires_at,fencing_token)
    VALUES($1::uuid,$2::uuid,$3,'TENANT',$2::text,$4,$5,'RUNNING','DISCOVER',1,$6,clock_timestamp()+interval '10 minutes',1) RETURNING created_at`,
    [id,tenant,type,type==='EXPORT'?'EXPORT_ONLY':'DELETE_TICKETS',`billing-privacy-${id}`,leaseId])).rows[0].created_at;
   return{id,tenantId:tenant,leaseId,jobType:type,scopeType:'TENANT',scopeValue:tenant,disposition:type==='EXPORT'?'EXPORT_ONLY':'DELETE_TICKETS',
    state:'RUNNING',stage:'DISCOVER',attempts:1,maxAttempts:25,fencingToken:1,createdAt:created.toISOString(),unmatchedDiagnosticHours:24,exportTtlHours:24,
    zammadBaseUrl:'https://privacy.invalid',zammadPrivacySecretReference:`secret://${tenant}/zammad/privacy`};
  };
  const exportedJob=await privacyJob('EXPORT');await privacy.discover(exportedJob,exportedJob.leaseId);exportedJob.stage='EXPORT';const exported=await privacy.exportData(exportedJob,exportedJob.leaseId);
  assert.ok(exported.metaBillingEvidence.some(v=>v.attempt_id===attempt&&v.meta_billing_admission.snapshot.providerAccountId===account));
  assert.equal(exported.metaAccountTransitions.length,2);
  assert.ok(exported.metaAccountTransitions.every(value=>!Object.hasOwn(value,'requested_by')&&!Object.hasOwn(value,'result')));
  assert.equal(exported.metaAccountPolicies[0].mode,'CUSTOMER');assert.equal(exported.metaAccountPolicies[0].actual_payer,'UNVERIFIED');
  assert.ok(exported.metaAccountPolicies[0].private_funding_proof,'Tenant private export includes the source funding receipt');
  assert.ok(exported.metaAccountPolicies.some(v=>v.funding_observation_operation_id===first.job.id&&v.private_funding_proof.responseSha256===observed.funding.responseSha256),'Original funding receipt remains exported after later observations');
  assert.ok(exported.metaAccountPolicies.some(v=>v.funding_observation_operation_id===deniedRead.job.id&&v.private_funding_proof.status==='UNAVAILABLE'),'Unavailable historical observations remain distinct');
  await withFixtureTenant(admin,tenant,()=>admin.query("UPDATE privacy_jobs SET state='SUCCEEDED',stage='DONE',completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[exportedJob.id]));
  const hold=randomUUID();await admin.query(`INSERT INTO privacy_legal_holds(id,tenant_id,scope_type,scope_value,scope_sha256,reason,created_by)
   VALUES($1::uuid,$2::uuid,'TENANT',$2::text,$3,'Synthetic account hold',$4)`,[hold,tenant,createHash('sha256').update(tenant).digest('hex'),user]);
  const deletion=await privacyJob('DELETE');await assert.rejects(()=>privacy.discover(deletion,deletion.leaseId),{name:'PrivacyLegalHoldError'});
  await admin.query("UPDATE privacy_legal_holds SET state='RELEASED',released_at=clock_timestamp(),released_by=$1 WHERE id=$2",[user,hold]);
  // Unattempted fixture queues can become terminal; the actual attempted success remains preserved.
  await withFixtureTenant(admin,tenant,()=>admin.query("UPDATE delivery_outbox SET state='FAILED_TERMINAL',lease_id=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND state='CLAIMED'",[tenant]));
  await privacy.discover(deletion,deletion.leaseId);deletion.stage='EXTERNAL';
  await withFixtureTenant(admin,tenant,()=>admin.query("UPDATE privacy_job_targets SET state='EXTERNAL_COMPLETE' WHERE job_id=$1 AND target_type IN('ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT')",[deletion.id]));
  await withFixtureTenant(admin,tenant,()=>admin.query("UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN' WHERE id=$1",[current.job.id]));
  await assert.rejects(()=>privacy.finalize(deletion,deletion.leaseId),{code:'DELIVERY_OUTCOME_UNRESOLVED',retryable:true});
  assert.deepEqual((await admin.query('SELECT meta_billing_admission FROM delivery_attempts WHERE id=$1',[attempt])).rows[0].meta_billing_admission,stamped,'UNKNOWN preserves exact historical admission');
  await withFixtureTenant(admin,tenant,()=>admin.query("UPDATE delivery_outbox SET state='SENT' WHERE id=$1",[current.job.id]));
  const expiredPrivacy=await worker.connect();try{await expiredPrivacy.query('BEGIN');await expiredPrivacy.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
   await expiredPrivacy.query("UPDATE privacy_jobs SET stage='LOCAL',lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[deletion.id]);
   await assert.rejects(()=>expiredPrivacy.query(`UPDATE connection_operations SET result=jsonb_set(result,'{metaAccountFundingProof}',
     jsonb_build_object('redacted',true,'sha256',encode(digest((result->'metaAccountFundingProof')::text,'sha256'),'hex'))) WHERE id=$1`,[first.job.id]),{code:'23514'},'An expired privacy lease cannot redact retained funding evidence');
  }finally{await expiredPrivacy.query('ROLLBACK');expiredPrivacy.release();}
  await assert.rejects(()=>privacy.finalize({...deletion,fencingToken:2},deletion.leaseId),/lease/i);
  await verifyTransitionRequesterPrivacy({tx,worker,app,admin,tenant,other,deletion});
  await privacy.finalize(deletion,deletion.leaseId);
  const previewRows=(await admin.query('SELECT requested_by,state FROM meta_account_transitions WHERE tenant_id=$1',[tenant])).rows;
  assert.equal(previewRows.length,2);assert.ok(previewRows.every(value=>value.requested_by===null&&value.state==='CANCELLED'));
  const previewEvidence=(await admin.query(`SELECT id,result,payload,requested_by_id FROM connection_operations WHERE tenant_id=$1 AND operation_type='PREVIEW_META_ACCOUNT_TRANSITION'`,[tenant])).rows;
  assert.deepEqual(previewEvidence.map(value=>value.id).sort(),transitionPreview.observationOperationIds,'All actual initial/refresh/cancelled read histories survive tenant deletion under their exact operation IDs');
  assert.ok(previewEvidence.every(value=>!Object.hasOwn(value.payload.metaAccountTransition,'actorId')),'No second initiating actor copy survives tenant deletion');
  assert.ok(previewEvidence.every(value=>value.requested_by_id===user),'Existing operation audit attribution follows its retained audit policy');
  assert.ok(previewEvidence.some(value=>value.result));assert.ok(previewEvidence.filter(value=>value.result).every(value=>value.result.redacted===true));
  const removed=(await admin.query('SELECT d.meta_billing_snapshot,a.meta_billing_admission,a.external_message_id FROM delivery_outbox d JOIN delivery_attempts a ON a.delivery_id=d.id WHERE d.id=$1 AND a.id=$2',[current.job.id,attempt])).rows[0];
  assert.equal(removed.meta_billing_snapshot.redacted,true);assert.equal(removed.meta_billing_admission.redacted,true);assert.equal(removed.external_message_id,null);
  assert.equal((await admin.query('SELECT state FROM meta_messaging_accounts WHERE tenant_id=$1',[tenant])).rows[0].state,'RETIRED');
  await assert.rejects(()=>tx(app,tenant,client=>client.query("UPDATE meta_messaging_accounts SET state='READY',authority_revision=authority_revision+1 WHERE tenant_id=$1",[tenant])),{code:'23514'});
  const privateReceipt=(await admin.query('SELECT result FROM connection_operations WHERE id=$1',[first.job.id])).rows[0].result.metaAccountFundingProof;
  assert.equal(privateReceipt.redacted,true);assert.ok(!JSON.stringify(privateReceipt).includes('synthetic-funding'));
  await assert.rejects(()=>tx(worker,tenant,client=>client.query("UPDATE connection_operations SET result=jsonb_set(result,'{metaAccountFundingProof}',$1) WHERE id=$2",[observed.funding,first.job.id])),{code:'23514'},'Redacted evidence cannot be restored');
  return{customerIntentNotPayer:true,allWriterBirthSnapshot:true,legacyNoAdoption:true,currentFundingGate:true,ordinaryTextHeldOnNone:true,exactAttemptAdmission:true,knownSuccessAtomicAssociation:true,rls:true,idempotency:true,operationOnlyLifecycle:true,timestampRefreshNoAuthorityChange:true,expiry:true,bindingGeneration:true,privateExport:true,legalHold:true,unknownPreserved:true,privacyRedaction:true,noResurrection:true};
 }finally{if(priorApp===undefined)delete process.env.META_APP_ID;else process.env.META_APP_ID=priorApp;await Promise.all([worker.end(),app.end()]);await admin.end();}
}

/** Fresh real login backends, before any relevant function plan is cached.
 * Explicit public writes plus forged/empty temporary readers prove lookup
 * closure without removing TEMP, changing roles/ACLs or weakening RLS. */
async function verifyMetaPolicyLookupClosure({workerConfig,appUrl,tenant,connection,group,user,accountId,deliveryId,fundingOperationId}){
 const readers=['guard_meta_account_policy_state()','preserve_meta_funding_receipt()','meta_billing_birth_snapshot(uuid)',
  'snapshot_meta_billing()','meta_billing_send_guard(uuid,uuid,text,text,bigint,bigint)','meta_billing_delivery_current(uuid)',
  'preserve_meta_billing_evidence()','preserve_meta_attempt_effect()','delivery_no_further_attempts(uuid,uuid)'];
 const securityDefiners=new Set(['app.meta_billing_birth_snapshot(uuid)','app.delivery_no_further_attempts(uuid,uuid)']);
 const tables=['meta_messaging_accounts','meta_connection_account_bindings','meta_billing_policy_versions','connections','provider_sessions',
  'connection_operations','delivery_outbox','delivery_attempts','privacy_jobs','privacy_job_targets','quarantine_records'];
 const stopped=randomUUID(),next=randomUUID(),clean=randomUUID(),retained=randomUUID(),batch=randomUUID();
 const setup=new Client(workerConfig);await setup.connect();
 const catalog=async client=>(await client.query(`SELECT p.oid::regprocedure::text AS signature,p.proowner,p.prosecdef,p.proacl,p.proconfig,
  n.nspname AS namespace FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE p.oid=ANY($1::regprocedure[]) ORDER BY p.oid`,[readers.map(v=>`app.${v}`)])).rows;
 const begin=async client=>{await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);};
 const funding=async client=>(await client.query(`SELECT jsonb_build_object('responseSha256',funding_response_sha256,
  'observedAt',funding_observed_at,'expiresAt',funding_expires_at) value FROM public.meta_messaging_accounts WHERE tenant_id=$1 AND id=$2`,[tenant,accountId])).rows[0].value;
 const admission=async(client,id,attemptId)=>{
  const snapshot=(await client.query('SELECT meta_billing_snapshot FROM public.delivery_outbox WHERE id=$1',[id])).rows[0].meta_billing_snapshot;
  const hasContext=(await client.query("SELECT to_regprocedure('app.meta_message_provider_context(uuid)') IS NOT NULL AS present")).rows[0].present;
  const phone=(await client.query("SELECT opaque_session_id FROM public.provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE' AND state='WORKING'",[tenant,connection])).rows[0].opaque_session_id;
  const value={schemaVersion:1,claim:'MESSAGES_REQUEST_ADMITTED',attemptId,attemptNumber:1,deliveryId:id,admittedAt:new Date().toISOString(),requestSha256:'b'.repeat(64),snapshot,funding:await funding(client)};
  if(hasContext)value.requestPhoneNumberId=phone;
  if(snapshot?.schemaVersion===2){
   value.schemaVersion=2;value.birthDigest=(await client.query("SELECT jsonb_build_object('format','pg-jsonb-text-v1','sha256',encode(digest(meta_billing_snapshot::text,'sha256'),'hex')) value FROM public.delivery_outbox WHERE id=$1",[id])).rows[0].value;
   value.execution={mode:'UNKNOWN',runtimeEvidenceReceiptId:null,runtimeEvidenceSha256:null,transportBindingSha256:null};
   value.providerContext=(await client.query('SELECT app.meta_message_provider_context($1) value',[connection])).rows[0].value;
  }
  return value;
 };
 const insertDelivery=async(client,id,state='QUEUED',sequence=null)=>client.query(`INSERT INTO public.delivery_outbox
  (id,tenant_id,connection_id,group_workspace_group_id,delivery_origin,message_body,content_type,idempotency_key,state,
   attempts,lease_id,lease_expires_at,batch_id,batch_sequence,batch_part_count)
  VALUES($1,$2,$3,$4,'GROUP_WORKSPACE','Lookup closure','text/plain',$5,$6,$7,$8,$9,$10,$11,$12)`,
  [id,tenant,connection,group,`lookup-${id}`,state,state==='SENDING'?1:0,state==='SENDING'?randomUUID():null,
   state==='SENDING'?new Date(Date.now()+120000):null,sequence===null?null:batch,sequence??0,sequence===null?1:2]);
 try{
  // Real-worker setup precedes fresh shadows. Historical batch callbacks are
  // not repaired here and must not run against synthetic temporary indexes.
  await begin(setup);
  const baseline=await catalog(setup);assert.equal(baseline.length,readers.length);
  for(const [id,sequence] of [[stopped,0],[next,1]])await insertDelivery(setup,id,'QUEUED',sequence);
  await insertDelivery(setup,clean);await insertDelivery(setup,retained,'SENDING');
  const retainedAttempt=(await setup.query("INSERT INTO public.delivery_attempts(tenant_id,delivery_id,attempt_number,state) VALUES($1,$2,1,'SENDING') RETURNING id",[tenant,retained])).rows[0].id;
  await setup.query('UPDATE public.delivery_attempts SET meta_billing_admission=$1 WHERE id=$2',[await admission(setup,retained,retainedAttempt),retainedAttempt]);
  await setup.query("UPDATE public.delivery_outbox SET state='SENT',external_message_id='wamid.lookup-retained',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[retained]);
  await setup.query("UPDATE public.delivery_attempts SET state='SENT',external_message_id='wamid.lookup-retained',finished_at=clock_timestamp() WHERE id=$1",[retainedAttempt]);
  await setup.query("UPDATE public.delivery_outbox SET state='OUTCOME_UNKNOWN' WHERE id IN($1,$2)",[stopped,retained]);
  assert.equal((await setup.query(`UPDATE public.quarantine_records SET state='RESOLVED',resolution_code='DELIVERY_NO_FURTHER_ATTEMPTS',
   resolved_by=$1,resolved_at=clock_timestamp(),version=version+1 WHERE tenant_id=$2 AND delivery_id=$3 AND reason_code='PROVIDER_OUTCOME_UNKNOWN'`,[user,tenant,stopped])).rowCount,1);
  await setup.query('COMMIT');
  for(const [config,expectedRole,expectedLogin,member] of [[{connectionString:appUrl},'wasalx_runtime','wasalx_runtime','wasalx_app'],
   [workerConfig,'wasalx_connector_worker','wasalx_connector_worker_runtime','wasalx_connector_worker']]){
   const client=new Client(config);await client.connect();
   try{
    await begin(client);
    assert.deepEqual((await client.query(`SELECT current_user AS role,session_user AS login,r.rolsuper AS superuser,r.rolbypassrls AS bypass,
     pg_has_role(current_user,$1,'MEMBER') AS member,has_database_privilege(current_database(),'TEMP') AS temporary,
     has_schema_privilege('public','CREATE') AS public_create,has_schema_privilege('app','CREATE') AS app_create
     FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,[member])).rows[0],
     {role:expectedRole,login:expectedLogin,superuser:false,bypass:false,member:true,temporary:true,public_create:false,app_create:false});
    for(const table of tables)await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
    const actual=await catalog(client);assert.deepEqual(actual,baseline,'Owner, security mode, row_security and ACLs stay unchanged');
    for(const row of actual){assert.equal(row.namespace,'app');assert.ok(row.proconfig.includes('search_path=pg_catalog, public, app, pg_temp'));
     const expectedDefiner=securityDefiners.has(row.signature);
     assert.equal(row.prosecdef,expectedDefiner,`${row.signature} security mode`);
     assert.equal(row.proconfig.includes('row_security=off'),expectedDefiner,`${row.signature} row security`);}
    const birth=(await client.query('SELECT app.meta_billing_birth_snapshot($1) value',[connection])).rows[0].value;
    assert.equal(birth.claim,'ACCOUNT_POLICY_BOUND');assert.equal(birth.accountId,accountId);
    assert.equal((await client.query('SELECT app.meta_billing_delivery_current($1) ready',[deliveryId])).rows[0].ready,true);
    for(const table of ['meta_messaging_accounts','meta_connection_account_bindings','meta_billing_policy_versions','connections','provider_sessions','connection_operations','delivery_outbox','delivery_attempts'])
     await client.query(`INSERT INTO pg_temp.${table} SELECT * FROM public.${table} WHERE tenant_id=$1`,[tenant]);
    await client.query('SAVEPOINT held_account');
    await client.query("UPDATE public.meta_messaging_accounts SET state='HELD',authority_revision=authority_revision+1 WHERE tenant_id=$1 AND id=$2",[tenant,accountId]);
    assert.equal((await client.query('SELECT app.meta_billing_delivery_current($1) ready',[deliveryId])).rows[0].ready,false,'Fake READY cannot override held public authority');
    await client.query(`UPDATE pg_temp.connection_operations SET result=jsonb_set(result,'{metaAccountFundingProof,primaryFundingId}','"forged-shadow-funding"'),
     payload=jsonb_set(payload,'{metaAccountPolicy,authorityRevision}',to_jsonb((SELECT authority_revision FROM public.meta_messaging_accounts WHERE tenant_id=$1 AND id=$2))) WHERE id=$3`,[tenant,accountId,fundingOperationId]);
    await client.query('SAVEPOINT forged_funding');
    await assert.rejects(()=>client.query("UPDATE public.meta_messaging_accounts SET primary_funding_id='forged-shadow-funding',authority_revision=authority_revision+1 WHERE tenant_id=$1 AND id=$2",[tenant,accountId]),{code:'23514'});
    await client.query('ROLLBACK TO SAVEPOINT held_account');
    assert.equal((await client.query('SELECT app.delivery_no_further_attempts($1,$2) held',[tenant,stopped])).rows[0].held,true,'Empty review shadow cannot hide real disposition');
    assert.deepEqual((await client.query('SELECT lease_id,lease_expires_at FROM public.delivery_outbox WHERE id=$1',[clean])).rows[0],{lease_id:null,lease_expires_at:null});
    await client.query(`INSERT INTO pg_temp.quarantine_records(tenant_id,source_kind,reason_code,state,delivery_id,safe_summary,resolution_code,resolved_at)
     VALUES($1,'OUTBOUND','PROVIDER_OUTCOME_UNKNOWN','RESOLVED',$2,'Forged stop','DELIVERY_NO_FURTHER_ATTEMPTS',clock_timestamp())`,[tenant,clean]);
    assert.equal((await client.query('SELECT app.delivery_no_further_attempts($1,$2) held',[tenant,clean])).rows[0].held,false,'Lease-free fake resolved review cannot stop a public unsuppressed row');
    await client.query('TRUNCATE pg_temp.delivery_outbox,pg_temp.quarantine_records');
    await client.query("UPDATE public.delivery_outbox SET state='DELIVERED' WHERE id=$1",[stopped]);
    assert.deepEqual((await client.query('SELECT state,blocked_by_delivery_id FROM public.delivery_outbox WHERE id=$1',[next])).rows[0],
     {state:'BLOCKED',blocked_by_delivery_id:stopped},'Known receipt cannot resume sealed successor');
    await client.query(`INSERT INTO pg_temp.privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,lease_id,lease_expires_at,fencing_token)
     VALUES($1::uuid,$2::uuid,'DELETE','TENANT',$2::text,'DELETE_TICKETS',$3,'RUNNING','LOCAL',$4,clock_timestamp()+interval '5 minutes',1)`,[randomUUID(),tenant,`shadow-${randomUUID()}`,randomUUID()]);
    await client.query('SAVEPOINT forged_receipt');
    await assert.rejects(()=>client.query(`UPDATE public.connection_operations SET result=jsonb_set(result,'{metaAccountFundingProof}',
     jsonb_build_object('redacted',true,'sha256',encode(digest((result->'metaAccountFundingProof')::text,'sha256'),'hex'))) WHERE id=$1`,[fundingOperationId]),{code:'23514'});
    await client.query('ROLLBACK TO SAVEPOINT forged_receipt');
    if(expectedRole==='wasalx_connector_worker'){
     // First-admission and first-effect lookup branches run under fresh shadows.
     const effect=randomUUID();await insertDelivery(client,effect,'SENDING');
     const effectAttempt=(await client.query("INSERT INTO public.delivery_attempts(tenant_id,delivery_id,attempt_number,state) VALUES($1,$2,1,'SENDING') RETURNING id",[tenant,effect])).rows[0].id;
     await client.query('INSERT INTO pg_temp.delivery_outbox SELECT * FROM public.delivery_outbox WHERE id=$1',[effect]);
     const exact=await admission(client,effect,effectAttempt),forged={...exact,funding:{...exact.funding,responseSha256:'f'.repeat(64)}};
     await client.query('UPDATE pg_temp.meta_messaging_accounts SET funding_response_sha256=$1',[forged.funding.responseSha256]);
     await client.query('SAVEPOINT forged_admission');
     await assert.rejects(()=>client.query('UPDATE public.delivery_attempts SET meta_billing_admission=$1 WHERE id=$2',[forged,effectAttempt]),{code:'55000'});
     await client.query('ROLLBACK TO SAVEPOINT forged_admission');
     await client.query("UPDATE pg_temp.delivery_outbox SET state='FAILED_TERMINAL' WHERE id=$1",[effect]);
     await client.query('UPDATE public.delivery_attempts SET meta_billing_admission=$1 WHERE id=$2',[exact,effectAttempt]);
     await client.query("UPDATE pg_temp.delivery_outbox SET state='SENT',external_message_id='wamid.lookup-fresh' WHERE id=$1",[effect]);
     await client.query('SAVEPOINT forged_effect');
     await assert.rejects(()=>client.query("UPDATE public.delivery_attempts SET external_message_id='wamid.lookup-fresh',state='SENT',finished_at=clock_timestamp() WHERE id=$1",[effectAttempt]),{code:'23514'});
     await client.query('ROLLBACK TO SAVEPOINT forged_effect');
     await client.query("UPDATE public.delivery_outbox SET state='SENT',external_message_id='wamid.lookup-fresh',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[effect]);
     await client.query("UPDATE pg_temp.delivery_outbox SET state='QUEUED',external_message_id=NULL WHERE id=$1",[effect]);
     await client.query("UPDATE public.delivery_attempts SET external_message_id='wamid.lookup-fresh',state='SENT',finished_at=clock_timestamp() WHERE id=$1",[effectAttempt]);
     const privacyJob=randomUUID();await client.query(`INSERT INTO public.privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,lease_id,lease_expires_at,fencing_token)
      VALUES($1::uuid,$2::uuid,'DELETE','TENANT',$2::text,'DELETE_TICKETS',$3,'RUNNING','DISCOVER',$4,clock_timestamp()+interval '5 minutes',1)`,[privacyJob,tenant,`lookup-privacy-${privacyJob}`,randomUUID()]);
     await client.query("INSERT INTO public.privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256) VALUES($1,$2,'DELIVERY',$3,$4)",[tenant,privacyJob,retained,createHash('sha256').update(retained).digest('hex')]);
     await client.query("UPDATE public.privacy_jobs SET stage='LOCAL' WHERE tenant_id=$1 AND id=$2",[tenant,privacyJob]);
     await client.query('INSERT INTO pg_temp.delivery_outbox SELECT * FROM public.delivery_outbox WHERE id=$1',[retained]);
     await client.query("UPDATE pg_temp.delivery_outbox SET state='SENT' WHERE id=$1",[retained]);
     const redactSnapshot=()=>client.query(`UPDATE public.delivery_outbox SET meta_billing_snapshot=jsonb_build_object('redacted',true,'sha256',encode(digest(meta_billing_snapshot::text,'sha256'),'hex')) WHERE id=$1`,[retained]);
     const redactAdmission=()=>client.query(`UPDATE public.delivery_attempts SET meta_billing_admission=jsonb_build_object('redacted',true,'sha256',encode(digest(meta_billing_admission::text,'sha256'),'hex')) WHERE id=$1`,[retainedAttempt]);
     const redactEffect=()=>client.query('UPDATE public.delivery_attempts SET external_message_id=NULL WHERE id=$1',[retainedAttempt]);
     for(const [name,write] of [['snapshot',redactSnapshot],['admission',redactAdmission],['effect',redactEffect]]){
      await client.query(`SAVEPOINT privacy_${name}`);await assert.rejects(write,{code:'23514'});await client.query(`ROLLBACK TO SAVEPOINT privacy_${name}`);
     }
     await client.query("UPDATE public.delivery_outbox SET state='SENT' WHERE id=$1",[retained]);
     await client.query("UPDATE pg_temp.delivery_outbox SET state='OUTCOME_UNKNOWN' WHERE id=$1",[retained]);
     await redactSnapshot();await redactAdmission();await redactEffect();
     const redacted=(await client.query('SELECT meta_billing_snapshot,meta_billing_admission,a.external_message_id FROM public.delivery_outbox d JOIN public.delivery_attempts a ON a.delivery_id=d.id WHERE d.id=$1',[retained])).rows[0];
     for(const value of [redacted.meta_billing_snapshot,redacted.meta_billing_admission]){assert.equal(value.redacted,true);assert.match(value.sha256,/^[a-f0-9]{64}$/u);}
     assert.equal(redacted.external_message_id,null);
    }
   }finally{try{await client.query('ROLLBACK');}finally{await client.end();}}
  }
  // Leave only settled/cancelable rows for the incumbent tenant privacy test.
  // Never delete source rows, rewrite retained evidence or replay an event.
  await begin(setup);
  await setup.query("UPDATE public.delivery_outbox SET state='DELIVERED' WHERE id=$1",[stopped]);
  await setup.query("UPDATE public.delivery_outbox SET state='FAILED_TERMINAL',blocked_by_delivery_id=NULL WHERE id IN($1,$2)",[next,clean]);
  await setup.query("UPDATE public.delivery_outbox SET state='SENT' WHERE id=$1",[retained]);
  await setup.query(`UPDATE public.quarantine_records SET state='RESOLVED',resolution_code='DELIVERY_NO_FURTHER_ATTEMPTS',
   resolved_by=$1,resolved_at=clock_timestamp(),version=version+1 WHERE tenant_id=$2 AND delivery_id=$3 AND state='OPEN'`,[user,tenant,retained]);
  await setup.query('COMMIT');
 }finally{await setup.query('ROLLBACK').catch(()=>undefined);await setup.end();}
}


/** Real pre-0170 row: apply actual migration prefix, seed, then exact successor.
 * No fabricated migration, trigger disable, source backfill or public-stack action. */
export async function verifyMetaLegacyNullBilling(adminUrl,workerConfig,appUrl,requireCost=false){
 assert(appUrl,'Use the actual app role for historical CUSTOMER policy production');
 const database=`wasalx_billing_legacy_${process.pid}_${Date.now()}`,directory=await mkdtemp(resolve(tmpdir(),'wasalx-billing-legacy-'));
 const maintenanceUrl=new URL(adminUrl);maintenanceUrl.pathname='/postgres';const databaseUrl=new URL(adminUrl);databaseUrl.pathname=`/${database}`;
 const workerUrl=new URL(workerConfig.connectionString);workerUrl.pathname=`/${database}`;const applicationUrl=new URL(appUrl);applicationUrl.pathname=`/${database}`;
 const maintenance=new Client({connectionString:maintenanceUrl.toString()}),inspector=new Client({connectionString:databaseUrl.toString()});
 const previousAdmin=process.env.DATABASE_ADMIN_URL,previousApp=process.env.META_APP_ID;let created=false,connected=false,pool,app;
 const tx=async(p,t,fn)=>{const c=await p.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[t]);const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 try{
  await maintenance.connect();await maintenance.query(`CREATE DATABASE "${database}"`);created=true;
  const source=new URL('../services/control-api/migrations/',import.meta.url),files=(await readdir(source)).filter(name=>/^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort();
  const prefix=files.filter(file=>file<'0170_meta_account_policy.sql');assert.equal(prefix.length,169);
  assert(files.every((file,index)=>Number(file.slice(0,4))===index+1),'Only actual contiguous integrated migration bytes');
  await Promise.all(prefix.map(async f=>writeFile(resolve(directory,f),await readFile(new URL(f,source)))));
  process.env.DATABASE_ADMIN_URL=databaseUrl.toString();await migrate(directory);await inspector.connect();connected=true;
  pool=new Pool({...workerConfig,connectionString:workerUrl.toString()});app=new Pool({connectionString:applicationUrl.toString()});
  const tenant=randomUUID(),user=randomUUID(),connection=randomUUID(),session=randomUUID(),group=randomUUID(),phone='840000000061',account='840000000062';
  const appId='12025550130',secret=`secret://${tenant}/connections/${connection}/meta`;process.env.META_APP_ID=appId;
  await inspector.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Legacy billing migration',$2,'ACTIVE')",[tenant,`legacy-billing-${tenant}`]);
  await inspector.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Upgrade owner')",[user,`upgrade-${user}`,`upgrade-${user}@example.invalid`]);
  await inspector.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')",[tenant,user]);
  await inspector.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Legacy Meta','META','CLOUD_API','WORKING',$3)",[connection,tenant,secret]);
  await inspector.query("INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data) VALUES($1,$2,$3,$4,'WORKING',$5,'ACTIVE','{}')",[session,tenant,connection,phone,`meta-cloud://${account}/${phone}`]);
  await inspector.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state) VALUES($1,$2,'META',$3,'secret://platform/meta-webhook','ACTIVE')",[tenant,connection,phone]);
  await inspector.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,'legacy-account-group','Legacy account group')",[group,tenant,connection]);
  const insert=async(ctx={connection,session,group,phone,secret,proof:null,account:null})=>{
   const id=randomUUID(),lease=randomUUID();await tx(app,tenant,c=>c.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,group_workspace_group_id,delivery_origin,message_body,content_type,idempotency_key,state,attempts,lease_id,lease_expires_at)
    VALUES($1,$2,$3,$4,'GROUP_WORKSPACE','Actual migration-age queue','text/plain',$5,'CLAIMED',1,$6,clock_timestamp()+interval '10 minutes')`,[id,tenant,ctx.connection,ctx.group,`upgrade-${id}`,lease]));
   await tx(pool,tenant,c=>c.query("INSERT INTO delivery_attempts(tenant_id,delivery_id,attempt_number,state) VALUES($1,$2,1,'CLAIMED')",[tenant,id]));
   return{lease,job:{id,tenantId:tenant,connectionId:ctx.connection,groupWorkspaceGroupId:ctx.group,groupId:ctx.proof?'schema1-group':'legacy-account-group',recipientType:'GROUP',provider:'meta',sessionId:ctx.phone,connectionSecretReference:ctx.secret,
    metaCredentialContext:{providerSessionId:ctx.session,phoneNumberId:ctx.phone,wabaId:ctx.account,proof:ctx.proof},metaBillingSnapshot:null,attempts:1,text:'Actual migration-age queue',contentType:'text/plain',idempotencyKey:`upgrade-${id}`,zammadBaseUrl:'https://legacy.invalid',zammadSecretReference:'unused'}};
  };
  const nullBirth=await insert();
  await writeFile(resolve(directory,'0170_meta_account_policy.sql'),await readFile(new URL('0170_meta_account_policy.sql',source)));await migrate(directory);
  const legacy=await insert();legacy.job.metaBillingSnapshot=(await inspector.query('SELECT meta_billing_snapshot FROM delivery_outbox WHERE id=$1',[legacy.job.id])).rows[0].meta_billing_snapshot;
  assert.equal(legacy.job.metaBillingSnapshot.claim,'LEGACY_UNATTRIBUTED');
  // Real historical schema1 CUSTOMER producer before the managed migration.
  const ctx={connection:randomUUID(),session:randomUUID(),group:randomUUID(),phone:'840000000071',account:'840000000072',secret:'',proof:null};ctx.secret=`secret://${tenant}/connections/${ctx.connection}/meta`;
  ctx.proof={schemaVersion:1,claim:'PHONE_ACCOUNT_RELATION_VERIFIED',tenantId:tenant,connectionId:ctx.connection,providerSessionId:ctx.session,phoneNumberId:ctx.phone,wabaId:ctx.account,secretReference:ctx.secret,
   credentialFingerprint:createHash('sha256').update('synthetic-upgrade-account-token').digest('hex'),operationId:randomUUID(),fencingToken:1,graphVersion:'v24.0',verifiedAt:new Date().toISOString(),responseSha256:'a'.repeat(64),
   credentialMetadata:verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0}},{appId})};
  await inspector.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Schema1 producer','META','CLOUD_API','WORKING',$3)",[ctx.connection,tenant,ctx.secret]);
  await inspector.query("INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data) VALUES($1,$2,$3,$4,'WORKING',$5,'ACTIVE',$6)",[ctx.session,tenant,ctx.connection,ctx.phone,`meta-cloud://${ctx.account}/${ctx.phone}`,{wabaId:ctx.account,metaAccountProof:ctx.proof}]);
  await inspector.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state) VALUES($1,$2,'META',$3,'secret://platform/meta-webhook','ACTIVE')",[tenant,ctx.connection,ctx.phone]);
  await inspector.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,'schema1-group','Schema1 group')",[ctx.group,tenant,ctx.connection]);
  const operations=new ConnectionOperationRepository(pool);
  const request={id:'historical-schema1-producer',principal:{tenantId:tenant,userId:user,role:'tenant_owner',authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:['mfa']}};
  // Current181 API code requires later reservation/partial-index contracts.
  // Execute the original0170 producer's app-role SQL at its actual schema phase,
  // as for the restricted original worker completion below; never fake a helper.
  await tx(app,tenant,async c=>{
   const role=(await c.query("SELECT pg_has_role(current_user,'wasalx_app','MEMBER') app_role,(SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) superuser")).rows[0];
   assert.equal(role.app_role,true);assert.equal(role.superuser,false);
   assert.equal((await c.query("SELECT to_regprocedure('app.assert_meta_account_unreserved(uuid)') missing")).rows[0].missing,null);
   await requirePrivilegedAuthentication(c,request.principal,'selecting historical Meta payment responsibility');
   assert.equal((await c.query('SELECT app.lock_current_active_tenant_for_event_admission() active')).rows[0].active,true);
   const current=(await c.query('SELECT provider,state,secret_reference FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenant,ctx.connection])).rows[0];
   assert.equal(current.provider,'META');assert.equal(current.state,'WORKING');assert.equal(current.secret_reference,ctx.secret);
   const source=(await c.query("SELECT id,opaque_session_id,provider_state_data FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND state='WORKING' AND ownership_state='ACTIVE' FOR SHARE",[tenant,ctx.connection])).rows[0];
   assert.equal(source.id,ctx.session);
   const binding=metaBillingDiagnosticBinding(current.secret_reference,{id:source.id,opaqueSessionId:source.opaque_session_id,providerStateData:source.provider_state_data},appId);
   const result=await requestHistoricalCustomerPolicy0170(c,{tenantId:tenant,connectionId:ctx.connection,userId:user,idempotencyKey:'historical-customer',expectedRevision:0,requestId:request.id,binding,proof:source.provider_state_data.metaAccountProof});
   assert.equal(result.duplicate,false);assert.equal(result.operation.operation_type,'VERIFY_META_BILLING');
  });
  const operationLease=randomUUID(),operation=(await operations.claim(tenant,operationLease,1))[0];assert(operation);
  const observed=metaAccountFundingProof(ctx.account,{id:ctx.account},{id:ctx.account,primary_funding_id:'synthetic-upgrade-funding'}),funding=observed.funding,policy=operation.payload.metaAccountPolicy;
  // Phase-specific restricted domain SQL: the later repository wrapper calls a
  // managed-only helper that does not exist yet. 0170's actual receipt and
  // account guards authorize this transition; no authority rows are seeded.
  await tx(pool,tenant,async c=>{
   assert.equal((await c.query('SELECT id FROM app.complete_connection_operation($1,$2,$3,$4::jsonb)',[operation.id,operationLease,operation.fencingToken,JSON.stringify({metaBillingDiagnostic:observed.diagnostic,metaAccountFundingProof:funding})])).rowCount,1);
   assert.equal((await c.query(`UPDATE meta_messaging_accounts SET observed_owner_business_id=$1,funding_status=$2,primary_funding_id=$3,funding_response_sha256=$4,
    funding_observed_at=$5,funding_expires_at=$6,last_observation_operation_id=$7,state='READY',active_policy_version_id=$8,authority_revision=authority_revision+1,updated_at=now()
    WHERE tenant_id=$9 AND id=$10 AND authority_revision=$11 AND requested_policy_version_id=$8 AND last_observation_operation_id IS NOT DISTINCT FROM $12::uuid`,
    [funding.observedOwnerBusinessId,funding.status,funding.primaryFundingId,funding.responseSha256,funding.observedAt,funding.expiresAt,operation.id,policy.policyVersionId,tenant,policy.accountId,policy.authorityRevision,policy.observationOperationId])).rowCount,1);
  });
  const schema1=await insert(ctx);schema1.job.metaBillingSnapshot=(await inspector.query('SELECT meta_billing_snapshot FROM delivery_outbox WHERE id=$1',[schema1.job.id])).rows[0].meta_billing_snapshot;
  assert.equal(schema1.job.metaBillingSnapshot.schemaVersion,1);assert.equal(schema1.job.metaBillingSnapshot.actualPayer,'UNVERIFIED');
  const originalSnapshots=[nullBirth,legacy,schema1].map(x=>structuredClone(x.job.metaBillingSnapshot));
  // Preserve an actual old admission (no phone field) as an immutable historical
  // control. It is not backfilled by the migration or replayed by the new worker.
  const historical=await insert(),oldOutbox=new OutboxRepository(pool);historical.job.metaBillingSnapshot=(await inspector.query('SELECT meta_billing_snapshot FROM delivery_outbox WHERE id=$1',[historical.job.id])).rows[0].meta_billing_snapshot;
  await oldOutbox.beginSend(historical.job,historical.lease);
  const oldAttempt=(await inspector.query('SELECT id FROM delivery_attempts WHERE delivery_id=$1',[historical.job.id])).rows[0].id;
  const oldAdmission={schemaVersion:1,claim:'MESSAGES_REQUEST_ADMITTED',attemptId:oldAttempt,attemptNumber:1,deliveryId:historical.job.id,admittedAt:new Date().toISOString(),requestSha256:'a'.repeat(64),snapshot:historical.job.metaBillingSnapshot,funding:{responseSha256:null,observedAt:null,expiresAt:null}};
  await tx(pool,tenant,c=>c.query('UPDATE delivery_attempts SET meta_billing_admission=$1 WHERE id=$2',[oldAdmission,oldAttempt]));
  await oldOutbox.outcomeUnknown(historical.job,historical.lease,'Synthetic historical request; no real provider call');
  const remaining=files.filter(f=>f>'0170_meta_account_policy.sql');assert(remaining.some(f=>f.endsWith('_meta_managed_payment_authority.sql')));
  await Promise.all(remaining.map(async f=>writeFile(resolve(directory,f),await readFile(new URL(f,source)))));await migrate(directory);
  const outbox=new OutboxRepository(pool),privacy=new PrivacyRepository(pool);
  const costPresent=(await inspector.query("SELECT to_regclass('public.meta_cost_assessments') IS NOT NULL present")).rows[0].present;
  if(requireCost)assert.equal(costPresent,true,'P10 gate requires its actual integrated assessor');
  for(const [i,item] of [nullBirth,legacy,schema1].entries()){
   assert.deepEqual((await inspector.query('SELECT meta_billing_snapshot FROM delivery_outbox WHERE id=$1',[item.job.id])).rows[0].meta_billing_snapshot,originalSnapshots[i]);
   assert.equal(await outbox.beginSend(item.job,item.lease),true);
   await outbox.admitMetaMessageRequest(item.job,item.lease,'b'.repeat(64),undefined,item.job.sessionId);
   const stamp=(await inspector.query('SELECT meta_billing_admission FROM delivery_attempts WHERE delivery_id=$1',[item.job.id])).rows[0].meta_billing_admission;
   assert.equal(stamp.requestPhoneNumberId,item.job.sessionId);assert.deepEqual(stamp.snapshot,originalSnapshots[i]);
   if(i===2){assert.equal(stamp.schemaVersion,1);assert.equal(stamp.snapshot.mode,'CUSTOMER');assert.equal(stamp.snapshot.actualPayer,'UNVERIFIED');assert.equal(stamp.execution,undefined);assert.equal(stamp.providerContext,undefined);}
   else{assert.equal(stamp.execution.mode,'UNKNOWN');assert.equal(stamp.providerContext,null);}
   await outbox.complete(item.job,item.lease,'SENT',`wamid.upgrade-${item.job.id}`);
   if(costPresent){
    const assessments=(await tx(pool,tenant,c=>c.query('SELECT state,amount,currency FROM meta_cost_assessments WHERE tenant_id=$1 AND delivery_id=$2',[tenant,item.job.id]))).rows;
    assert.equal(assessments.length,2);assert(assessments.every(r=>r.state==='UNATTRIBUTED'&&r.amount===null&&r.currency===null));
   }
  }
  assert.deepEqual((await inspector.query('SELECT meta_billing_admission FROM delivery_attempts WHERE id=$1',[oldAttempt])).rows[0].meta_billing_admission,oldAdmission);
  const privacyId=randomUUID(),privacyLease=randomUUID();await inspector.query(`INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,lease_id,lease_expires_at,fencing_token)
    VALUES($1::uuid,$2::uuid,'EXPORT','TENANT',$2::text,'EXPORT_ONLY',$3,'RUNNING','DISCOVER',1,$4,clock_timestamp()+interval '5 minutes',1)`,[privacyId,tenant,`legacy-export-${privacyId}`,privacyLease]);
  const exportJob={id:privacyId,tenantId:tenant,jobType:'EXPORT',scopeType:'TENANT',scopeValue:tenant,disposition:'EXPORT_ONLY',state:'RUNNING',stage:'DISCOVER',fencingToken:1};
  await privacy.discover(exportJob,privacyLease);exportJob.stage='EXPORT';const exported=await privacy.exportData(exportJob,privacyLease);
  for(const item of [nullBirth,legacy,schema1])assert.equal(exported.metaBillingEvidence.find(v=>v.delivery_id===item.job.id).meta_billing_admission.requestPhoneNumberId,item.job.sessionId);
  assert.equal((await tx(pool,tenant,c=>c.query('SELECT count(*)::integer count FROM meta_connection_account_bindings WHERE tenant_id=$1 AND connection_id=$2',[tenant,connection]))).rows[0].count,0,'Legacy connection never adopts the other connection authority');
  return{actualMigrationPrefix:true,nullLegacySchema1RequestPhones:true,birthAndOldAdmissionPreserved:true,noAuthorityUpgrade:true,unattributedWithoutAmounts:costPresent,privateExport:true};
 }finally{
  if(previousAdmin===undefined)delete process.env.DATABASE_ADMIN_URL;else process.env.DATABASE_ADMIN_URL=previousAdmin;
  if(previousApp===undefined)delete process.env.META_APP_ID;else process.env.META_APP_ID=previousApp;
  try{if(pool)await pool.end();if(app)await app.end();if(connected)await inspector.end();}
  finally{try{if(created){await maintenance.query(`DROP DATABASE "${database}" WITH (FORCE)`);assert.equal((await maintenance.query('SELECT count(*)::integer count FROM pg_database WHERE datname=$1',[database])).rows[0].count,0);}}
   finally{try{await maintenance.end();}finally{await rm(directory,{recursive:true,force:true});}}}
 }
}

// The connector role cannot read tenant membership. Requester removal must
// use the existing exact tenant LOCAL/privacy authority without role widening.
async function verifyTransitionRequesterPrivacy({tx,worker,app,admin,tenant,other,deletion}){
 const before=(await admin.query('SELECT to_jsonb(plan) value FROM public.meta_account_transitions plan WHERE tenant_id=$1 ORDER BY id',[tenant])).rows.map(row=>row.value);
 assert.equal(before.length,2);assert.ok(before.every(row=>row.requested_by!==null));
 const clear="UPDATE public.meta_account_transitions SET requested_by=NULL WHERE tenant_id=$1 AND requested_by IS NOT NULL";
 for(const pool of [worker,app])await tx(pool,tenant,async c=>{
  if(pool===worker)assert.equal((await c.query("SELECT has_table_privilege(current_user,'public.tenant_memberships','SELECT') allowed")).rows[0].allowed,false);
  await c.query('SAVEPOINT requester_scope');
  await assert.rejects(()=>c.query(clear,[tenant]),{code:'23514'},'EXTERNAL is not LOCAL requester-redaction authority');
  await c.query('ROLLBACK TO SAVEPOINT requester_scope');await c.query('RELEASE SAVEPOINT requester_scope');
 });
 assert.equal((await tx(worker,other,c=>c.query(clear,[tenant]))).rowCount,0,'Foreign tenant context cannot touch the retained transition');
 await tx(worker,tenant,async c=>{
  await c.query('SAVEPOINT requester_scope');
  await c.query("UPDATE public.privacy_jobs SET stage='LOCAL' WHERE id=$1",[deletion.id]);
  await c.query('SAVEPOINT requester_denial');
  await assert.rejects(()=>c.query("UPDATE public.meta_account_transitions SET requested_by=NULL,revision=revision+1 WHERE tenant_id=$1",[tenant]),{code:'23514'},'Requester-only privacy cannot rewrite revision');
  await c.query('ROLLBACK TO SAVEPOINT requester_denial');await c.query('RELEASE SAVEPOINT requester_denial');
  assert.equal((await c.query(clear,[tenant])).rowCount,before.length);
  const removed=(await c.query('SELECT to_jsonb(plan) value FROM public.meta_account_transitions plan WHERE tenant_id=$1 ORDER BY id',[tenant])).rows.map(row=>row.value);
  assert.deepEqual(removed,before.map(row=>({...row,requested_by:null})),'Exact IDs/proof/history remain unchanged');
  await c.query('ROLLBACK TO SAVEPOINT requester_scope');await c.query('RELEASE SAVEPOINT requester_scope');
  await c.query('SAVEPOINT requester_scope');
  await c.query("UPDATE public.privacy_jobs SET stage='LOCAL',lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[deletion.id]);
  await assert.rejects(()=>c.query(clear,[tenant]),{code:'23514'},'Expired LOCAL lease cannot remove requester');
  await c.query('ROLLBACK TO SAVEPOINT requester_scope');await c.query('RELEASE SAVEPOINT requester_scope');
 });
 assert.deepEqual((await admin.query('SELECT to_jsonb(plan) value FROM public.meta_account_transitions plan WHERE tenant_id=$1 ORDER BY id',[tenant])).rows.map(row=>row.value),before,'Rollback probes do not erase attribution before actual finalize');
}

// Exact original0170 request producer from P08a2-v8 meta-account-policy.ts
// SHA256 67b233dc05483408d747a43ab0812b20e9beb4dbcc658dd75a24d2f83cd8257e; types only removed for this historical fixture.
// Latest production API continues to be exercised by verifyMetaAccountPolicy.
async function requestHistoricalCustomerPolicy0170(client,input) {
  const {tenantId,connectionId,binding}=input;
  const privacy=(await client.query(`SELECT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||$1::text,0))
    AND NOT EXISTS(SELECT 1 FROM privacy_jobs WHERE tenant_id=$1::uuid AND job_type='DELETE' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) AS clear`,[tenantId])).rows[0];
  if(privacy?.clear!==true)throw new ConflictException("Payment settings are unavailable during privacy processing.");
  if (!metaBillingDiagnosticProofCurrent(binding,input.proof,{tenantId,connectionId}) || !binding.wabaId || !binding.providerSessionId || !binding.phoneNumberId)
    throw new ConflictException("Verify the Meta account connection before selecting payment responsibility.");
  const requestSha=createHash("sha256").update(JSON.stringify({connectionId,mode:"CUSTOMER",expectedRevision:input.expectedRevision})).digest("hex");
  const replay=(await client.query("SELECT request_sha256 FROM meta_billing_policy_versions WHERE tenant_id=$1 AND idempotency_key=$2",[tenantId,input.idempotencyKey])).rows[0];
  if(replay){if(replay.request_sha256!==requestSha)throw new ConflictException("Idempotency key was used for another request.");
    const operation=(await client.query("SELECT * FROM connection_operations WHERE tenant_id=$1 AND idempotency_key=$2",[tenantId,input.idempotencyKey])).rows[0];
    if(!operation)throw new ConflictException("Payment request receipt is unavailable.");return{operation,duplicate:true};}
  const pending=await client.query("SELECT 1 FROM connection_operations WHERE tenant_id=$1 AND connection_id=$2 AND state IN('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE') LIMIT 1",[tenantId,connectionId]);
  if(pending.rowCount)throw new ConflictException("A connection operation is already pending.");
  // Global numeric identifier uniqueness prevents accidental cross-workspace adoption.
  // A collision remains a generic hold; it does not establish legal ownership.
  await client.query("INSERT INTO meta_messaging_accounts(tenant_id,provider_account_id) VALUES($1,$2) ON CONFLICT(provider_account_id) DO NOTHING",[tenantId,binding.wabaId]);
  const account=(await client.query("SELECT id,authority_revision,last_observation_operation_id FROM meta_messaging_accounts WHERE tenant_id=$1 AND provider_account_id=$2 AND state<>'RETIRED' FOR UPDATE",[tenantId,binding.wabaId])).rows[0];
  if(!account)throw new ConflictException("The Meta account requires an access review.");
  const current=Number(account.authority_revision);
  const prior=await client.query("SELECT 1 FROM meta_billing_policy_versions WHERE tenant_id=$1 AND account_id=$2 LIMIT 1",[tenantId,account.id]);
  if(input.expectedRevision!==(prior.rowCount?current:0))throw new ConflictException("Payment settings changed. Refresh and try again.");
  const proof=input.proof;
  const bound=(await client.query(`INSERT INTO meta_connection_account_bindings
    (tenant_id,account_id,connection_id,provider_session_id,phone_number_id,app_id,secret_reference,credential_fingerprint,proof_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(tenant_id,connection_id) DO UPDATE SET provider_session_id=EXCLUDED.provider_session_id,
      phone_number_id=EXCLUDED.phone_number_id,app_id=EXCLUDED.app_id,secret_reference=EXCLUDED.secret_reference,
      credential_fingerprint=EXCLUDED.credential_fingerprint,proof_sha256=EXCLUDED.proof_sha256,state='ACTIVE',
      revision=meta_connection_account_bindings.revision+1,updated_at=now()
    WHERE meta_connection_account_bindings.account_id=EXCLUDED.account_id AND meta_connection_account_bindings.state<>'RETIRED'
    RETURNING id,revision,account_id`,[tenantId,account.id,connectionId,binding.providerSessionId,binding.phoneNumberId,binding.appId,
      binding.secretReference,proof.credentialFingerprint,binding.proofSha256])).rows[0];
  if(!bound)throw new ConflictException("Changing the connected Meta account requires an access review.");
  const policyId=randomUUID();
  await client.query(`INSERT INTO meta_billing_policy_versions(id,tenant_id,account_id,version,mode,requested_by,request_sha256,idempotency_key)
    SELECT $1,$2,$3,COALESCE(max(version),0)+1,'CUSTOMER',$4,$5,$6 FROM meta_billing_policy_versions WHERE tenant_id=$2 AND account_id=$3`,
    [policyId,tenantId,account.id,input.userId,requestSha,input.idempotencyKey]);
  const revision=current+1;
  await client.query("UPDATE meta_messaging_accounts SET requested_policy_version_id=$1,state='HELD',authority_revision=$2,updated_at=now() WHERE tenant_id=$3 AND id=$4",[policyId,revision,tenantId,account.id]);
  const operation=(await client.query(`INSERT INTO connection_operations(tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,requested_by_id,request_id)
    VALUES($1,$2,'VERIFY_META_BILLING',$3,$4,'USER',$5,$6) RETURNING *`,[tenantId,connectionId,input.idempotencyKey,
      {metaBillingDiagnostic:binding,metaAccountPolicy:{accountId:account.id,bindingId:bound.id,bindingRevision:Number(bound.revision),authorityRevision:revision,policyVersionId:policyId,observationOperationId:account.last_observation_operation_id}},input.userId,input.requestId])).rows[0];
  return{operation,duplicate:false};
}


// A real second owner has no billing-policy references. Its rollback-scoped
// preview proves the original membership FK fallback without disabling a guard.
async function verifyAbsentRequesterMembership({admin,app,tx,tenant,connection,appId}){
 const actorId=randomUUID(),key=`requester-fallback-${actorId}`;
 await admin.query("INSERT INTO public.users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Requester fallback owner')",[actorId,key,`${key}@example.invalid`]);
 await withFixtureTenant(admin,tenant,()=>admin.query("INSERT INTO public.tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')",[tenant,actorId]));
 try{
  await tx(app,tenant,async c=>{
   await c.query('SAVEPOINT requester_membership');
   const actor={tenantId:tenant,connectionId:connection,userId:actorId,appId,requestId:key};
   await assertMetaTransitionWriter(c,actor);
   const context=(await c.query('SELECT app.meta_account_transition_context($1,$2,$3) value',[connection,actorId,appId])).rows[0].value;
   assert.ok(context);
   const created=await requestMetaTransitionPreview(c,actor,key,{requestedMode:'CUSTOMER',targetCurrency:'SAR',expectedAccountRevision:context.accountRevision,expectedBindingRevision:context.bindingRevision});
   const before=(await c.query('SELECT to_jsonb(p) value FROM public.meta_account_transitions p WHERE tenant_id=$1 AND id=$2',[tenant,created.id])).rows[0].value;
   assert.equal(before.requested_by,actorId);
   assert.equal((await c.query("SELECT has_function_privilege(current_user,'app.meta_managed_privacy_authorized(uuid)','EXECUTE') allowed")).rows[0].allowed,false);
   assert.equal((await c.query('DELETE FROM public.tenant_memberships WHERE tenant_id=$1 AND user_id=$2',[tenant,actorId])).rowCount,1);
   const after=(await c.query('SELECT to_jsonb(p) value FROM public.meta_account_transitions p WHERE tenant_id=$1 AND id=$2',[tenant,created.id])).rows[0].value;
   assert.deepEqual(after,{...before,requested_by:null},'Actual app membership removal clears only the original requester, without private-helper execution');
   await c.query('ROLLBACK TO SAVEPOINT requester_membership');await c.query('RELEASE SAVEPOINT requester_membership');
  });
 }finally{
  await withFixtureTenant(admin,tenant,()=>admin.query('DELETE FROM public.tenant_memberships WHERE tenant_id=$1 AND user_id=$2',[tenant,actorId]));
  await admin.query('DELETE FROM public.users WHERE id=$1',[actorId]);
 }
 assert.equal((await admin.query('SELECT count(*)::integer count FROM public.meta_account_transitions WHERE tenant_id=$1 AND idempotency_key=$2',[tenant,key])).rows[0].count,0,'The rollback probe creates no pending work');
}
