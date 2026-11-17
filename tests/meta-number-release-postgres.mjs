import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { withFixtureTenant } from "./meta-routing-fixture.mjs";
import { DatabaseService } from "../services/control-api/dist/database.service.js";
import { ConnectionsController } from "../services/control-api/dist/connections.controller.js";
import { MetaGroupsClientFactory } from "../services/control-api/dist/meta-groups.client.js";
import { ConnectionOperationRepository } from "../services/connector-worker/dist/services/connector-worker/src/connection-operation-repository.js";
import { ConnectionOperationProcessor } from "../services/connector-worker/dist/services/connector-worker/src/connection-operation-processor.js";
import { BotFlowsService } from "../services/control-api/dist/bot-flows.service.js";
import { QuarantineController } from "../services/control-api/dist/quarantine.controller.js";
import { SecretCleanupRepository } from "../services/control-api/dist/secret-cleanup.repository.js";
import { verifyMetaPrimaryDelivery } from "./meta-primary-delivery-postgres.mjs";

// Synthetic provider fixtures, actual API/worker/database roles and independent PostgreSQL transactions.
export async function verifyMetaNumberRelease(adminUrl,appUrl,workerConfig,cleanupUrl){
  const before={...process.env},oldFetch=globalThis.fetch;
  const appId="12025550130",wabaId="987654321098765",token="synthetic-number-release-token-not-live";
  Object.assign(process.env,{DATABASE_URL:appUrl,META_APP_ID:appId,META_GRAPH_VERSION:"v24.0",
    META_APP_SECRET_REFERENCE:"secret://platform/meta-webhook",SECRET_CLEANUP_DATABASE_URL:cleanupUrl,PORTAL_PUBLIC_ORIGIN:"https://portal.example.invalid"});
  const admin=new Client({connectionString:adminUrl});await admin.connect();
  const db=new DatabaseService(),pool=new Pool(workerConfig),repository=new ConnectionOperationRepository(pool);
  const cleanup=new SecretCleanupRepository();
  const tenants=[randomUUID(),randomUUID()],actor=randomUUID(),fallbackActor=randomUUID(),stored=new Map();
  const requests=tenants.map(tenantId=>({id:randomUUID(),headers:{origin:process.env.PORTAL_PUBLIC_ORIGIN},principal:{
    tenantId,userId:actor,role:"tenant_owner",subject:`release-${actor}`,email:"synthetic@example.invalid",displayName:"Fixture",
    authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:["mfa"]}}));
  const secrets={ready:async()=>true,storeMetaCredential:async(reference,value)=>{stored.set(reference,value)}};
  const controller=new ConnectionsController(db,secrets,{wakeConnection:async()=>{}},new MetaGroupsClientFactory(),
    {resolveHmac:async()=>"synthetic-meta-app-secret"},{resolveAccessToken:async reference=>stored.get(reference)?.accessToken});
  const processor=new ConnectionOperationProcessor(repository,{resolve:async reference=>stored.get(reference)},
    {wahaBaseUrl:"https://unused.invalid",publicWebhookBaseUrl:"https://portal.example.invalid",metaGraphVersion:"v24.0",metaAppId:appId,workerIdentity:"number-release-fixture"});
  let credentialExpiryKind=null;
  let phone=String(4_000_000_000+Math.floor(Math.random()*1_000_000_000));
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input));assert.equal(url.origin,"https://graph.facebook.com");
    if(url.pathname.endsWith("/debug_token")){
      const expires=Math.floor(Date.now()/1000)+15;
      return Response.json({data:{app_id:appId,is_valid:true,expires_at:credentialExpiryKind==="CREDENTIAL"?expires:0,
        ...(credentialExpiryKind==="DATA_ACCESS"?{data_access_expires_at:expires}:{}),scopes:["whatsapp_business_management","whatsapp_business_messaging"]}});
    }
    if(url.pathname.endsWith("/phone_numbers"))return Response.json({data:[{id:phone,display_phone_number:"12025550161",status:"CONNECTED",
      account_mode:"LIVE",host_platform:"CLOUD_API",code_verification_status:"VERIFIED"}]});
    if(url.pathname.endsWith("/subscribed_apps"))return init.method==="POST"?Response.json({success:true}):Response.json({data:[{whatsapp_business_api_data:{id:appId}}]});
    if(url.searchParams.get("fields")==="health_status")return Response.json({health_status:{can_send_message:"AVAILABLE",entities:[
      {entity_type:"PHONE_NUMBER",id:phone,can_send_message:"AVAILABLE"},{entity_type:"WABA",id:wabaId,can_send_message:"AVAILABLE"},
      {entity_type:"APP",id:appId,can_send_message:"AVAILABLE"}]}});
    if(url.pathname===`/v24.0/${phone}`)return Response.json({id:phone,display_phone_number:"12025550161",verified_name:"Fixture"});
    assert.fail(`Unexpected fixture request ${url.pathname}`);
  };
  const tenantQuery=(tenant,sql,args=[])=>db.withTenant(tenant,client=>client.query(sql,args));
  const create=index=>controller.create(requests[index],randomUUID(),{name:"Release fixture",provider:"META",phoneNumberId:phone,wabaId,accessToken:token});
  const drain=async(index)=>{
    const value=await processor.drainTenant(tenants[index]);
    assert.equal(value.failedTerminal,0,JSON.stringify(value));assert.equal(value.failedRetryable,0,JSON.stringify(value));
    assert.equal(value.succeeded,1,JSON.stringify(value));return value;
  };
  const disconnect=async(index,id)=>{
    await controller.disconnect(requests[index],id,randomUUID(),{confirmation:"DISCONNECT"});await drain(index);
    const row=(await controller.metaNumberRelease(requests[index],id));
    assert.equal(row.state,"REVOKED");assert.ok(row.disconnectOperationId);assert.equal(row.releaseId,null);
    return {routeId:row.routeId,phoneNumberId:row.phoneNumberId,disconnectOperationId:row.disconnectOperationId};
  };
  const rejected=async(work,status=409)=>assert.rejects(work,error=>error.getStatus?.()===status);
  try{
    const security=(await admin.query(`SELECT
      has_function_privilege('wasalx_connector_worker','app.release_meta_number(uuid,uuid,uuid,text,text,uuid,text)','EXECUTE') worker_release,
      has_table_privilege('wasalx_app','public.meta_number_releases','INSERT') app_insert,
      has_column_privilege('wasalx_meta_number_release_executor','public.connections','state','UPDATE') executor_activate,
      has_column_privilege('wasalx_meta_number_release_executor','public.webhook_routes','hmac_secret_reference','UPDATE') executor_rekey,
      (SELECT rolcanlogin OR rolbypassrls FROM pg_roles WHERE rolname='wasalx_meta_number_release_executor') privileged_role`)).rows[0];
    assert.deepEqual(security,{worker_release:false,app_insert:false,executor_activate:false,executor_rekey:false,privileged_role:false});
    const unscoped=(await admin.query(`SELECT source.relname,constraint_record.conname FROM pg_constraint constraint_record
      JOIN pg_class source ON source.oid=constraint_record.conrelid
      JOIN pg_attribute source_tenant ON source_tenant.attrelid=constraint_record.conrelid AND source_tenant.attname='tenant_id' AND NOT source_tenant.attisdropped
      JOIN pg_attribute target_tenant ON target_tenant.attrelid=constraint_record.confrelid AND target_tenant.attname='tenant_id' AND NOT target_tenant.attisdropped
      WHERE constraint_record.contype='f' AND NOT(source_tenant.attnum=ANY(constraint_record.conkey))`)).rows;
    assert.deepEqual(unscoped,[],"Every tenant-to-tenant relationship includes the source tenant");
    assert.equal((await admin.query("SELECT count(*)::int n FROM pg_constraint WHERE contype='f' AND conrelid='public.webhook_routes'::regclass AND confrelid='public.meta_number_releases'::regclass")).rows[0].n,0,"Release evidence has no reverse route FK cycle");
    for(const tenant of tenants)await admin.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Number release fixture',$2,'ACTIVE')",[tenant,`number-release-${tenant}`]);
    await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,'synthetic@example.invalid','Fixture')",[actor,`number-release-${actor}`]);
    await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,'fallback@example.invalid','Fixture fallback')",[fallbackActor,`number-release-${fallbackActor}`]);
    for(const tenant of tenants)await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,state) VALUES($1,$2,'tenant_owner','ACTIVE')",[tenant,fallbackActor]);
    for(const tenant of tenants)await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,state) VALUES($1,$2,'tenant_owner','ACTIVE')",[tenant,actor]);
    const originalPhone=phone;
    const drainCases=["TICKET_EVENT","GROUP_UNKNOWN","NATIVE_STATUS","FAILED_RETRYABLE","BLOCKED","OUTCOME_UNKNOWN","MANUAL_RETRY","ATTEMPTED_QUEUE"];
    const drainFailures=[];
    for(const [index,kind] of drainCases.entries()){
      try{
      phone=String(BigInt(originalPhone)+BigInt(index+1));
      const connection=await create(0);await drain(0);
      const expected=await disconnect(0,connection.id);
      const effect=await seedPendingGroupEffect(admin,db,requests[0],connection.id,kind);
      await rejected(()=>controller.releaseMetaNumber(requests[0],connection.id,randomUUID(),expected));
      assert.equal((await admin.query("SELECT reservation_release_id FROM webhook_routes WHERE connection_id=$1",[connection.id])).rows[0].reservation_release_id,null,kind);
      if(kind==="OUTCOME_UNKNOWN"){
        const review=(await admin.query("SELECT id,version FROM quarantine_records WHERE tenant_id=$1 AND delivery_id=$2 AND reason_code='PROVIDER_OUTCOME_UNKNOWN'",[tenants[0],effect.delivery])).rows[0];
        assert.ok(review,"Unknown delivery retains a supported review item");
        const reviews=new QuarantineController(db,{}, {wake:async()=>{}});
        await reviews.resolve(requests[0],review.id,randomUUID(),{expectedVersion:Number(review.version),resolutionCode:"DELIVERY_NO_FURTHER_ATTEMPTS",confirmation:"STOP"});
        const history=(await admin.query("SELECT * FROM delivery_outbox WHERE id=$1",[effect.delivery])).rows[0];
        const attempts=(await admin.query("SELECT * FROM delivery_attempts WHERE delivery_id=$1 ORDER BY id",[effect.delivery])).rows;
        assert.equal(history.state,"OUTCOME_UNKNOWN");
        assert.equal(attempts.length,1);assert.equal(attempts[0].state,"OUTCOME_UNKNOWN");
        assert.equal((await tenantQuery(tenants[0],"SELECT app.delivery_no_further_attempts($1,$2) stopped",[tenants[0],effect.delivery])).rows[0].stopped,true);
        assert.equal((await controller.releaseMetaNumber(requests[0],connection.id,randomUUID(),expected)).released,true);
        assert.deepEqual((await admin.query("SELECT * FROM delivery_outbox WHERE id=$1",[effect.delivery])).rows[0],history,"Release preserves the unknown outcome after supported STOP");
        assert.deepEqual((await admin.query("SELECT * FROM delivery_attempts WHERE delivery_id=$1 ORDER BY id",[effect.delivery])).rows,attempts,"Release never replays or rewrites attempts");
      }
      }catch(error){drainFailures.push(new Error(`Drain case ${kind}`,{cause:error}));}
    }
    if(drainFailures.length)throw new AggregateError(drainFailures,"Number release drain failure union");
    phone=String(BigInt(originalPhone)+100n);
    const primaryConnection=await create(0);await drain(0);
    await verifyMetaPrimaryDelivery({admin,db,pool,controller,request:requests[0],connection:primaryConnection,appId,wabaId,phoneNumberId:phone,foreignTenant:tenants[1],
      rotate:async()=>{await controller.rotateMetaCredential(requests[0],primaryConnection.id,randomUUID(),{accessToken:token});await drain(0)}});
    for(const [index,expiryKind] of ['CREDENTIAL','DATA_ACCESS'].entries()){
      credentialExpiryKind=expiryKind;
      phone=String(BigInt(originalPhone)+101n+BigInt(index));const expiring=await create(0);await drain(0);
      const row=(await admin.query("SELECT id,provider_state_data FROM provider_sessions WHERE connection_id=$1 AND ownership_state='ACTIVE'",[expiring.id])).rows[0];
      const expiry=row.provider_state_data.metaAccountProof.credentialMetadata[expiryKind==='CREDENTIAL'?'expiresAt':'dataAccessExpiresAt'];
      const current=()=>tenantQuery(tenants[0],"SELECT app.meta_primary_delivery_eligible($1,$2,$3,$4,$5,$6) AS eligible",[expiring.id,row.id,phone,wabaId,appId,{mode:'LIVE',graphOrigin:'https://graph.facebook.com',graphVersion:'v24.0'}]).then(r=>r.rows[0].eligible);
      assert.equal(await current(),true,expiryKind);
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiry*1000-Date.now())+25));
      assert.equal(await current(),false,expiryKind+' expiry cannot grant new primary replies');
    }
    credentialExpiryKind=null;
    phone=originalPhone;
    const original=await create(0);await drain(0);
    const originalLifecycle=(await db.resolveMetaLifecycleRoutes(wabaId,appId)).find(row=>row.connection_id===original.id);
    const originalSession=(await admin.query("SELECT * FROM provider_sessions WHERE connection_id=$1",[original.id])).rows[0];
    const accountId=randomUUID();
    await withFixtureTenant(admin,tenants[0],async()=>{
      await admin.query("INSERT INTO meta_messaging_accounts(id,tenant_id,provider_account_id) VALUES($1,$2,$3)",[accountId,tenants[0],wabaId]);
      await admin.query(`INSERT INTO meta_connection_account_bindings(tenant_id,account_id,connection_id,provider_session_id,
        phone_number_id,app_id,secret_reference,credential_fingerprint,proof_sha256)
        SELECT c.tenant_id,$1,c.id,s.id,s.opaque_session_id,$2,c.secret_reference,
          s.provider_state_data#>>'{metaAccountProof,credentialFingerprint}',
          encode(digest((s.provider_state_data->'metaAccountProof')::text,'sha256'),'hex')
        FROM connections c JOIN provider_sessions s ON s.tenant_id=c.tenant_id AND s.connection_id=c.id
        WHERE c.id=$3 AND s.ownership_state='ACTIVE'`,[accountId,appId,original.id]);
    });
    await assert.rejects(()=>tenantQuery(tenants[0],"UPDATE meta_connection_account_bindings SET state='RETIRED',revision=revision+1 WHERE connection_id=$1",[original.id]),error=>error.code==='23514');
    const originalReference=(await admin.query("SELECT secret_reference FROM connections WHERE id=$1",[original.id])).rows[0].secret_reference;
    await rejected(()=>controller.releaseMetaNumber(requests[0],original.id,randomUUID(),{
      routeId:randomUUID(),phoneNumberId:phone,disconnectOperationId:original.operation.id}));
    const releaseBody=await disconnect(0,original.id);
    await rejected(()=>controller.releaseMetaNumber(requests[0],original.id,randomUUID(),{...releaseBody,disconnectOperationId:original.operation.id}));
    assert.equal((await tenantQuery(tenants[1],"SELECT app.meta_signup_phone_available($1) available",[phone])).rows[0].available,false,"Revocation alone retains the reservation");
    await rejected(()=>create(1));
    await rejected(()=>controller.releaseMetaNumber(requests[1],original.id,randomUUID(),releaseBody),404);
    await admin.query("UPDATE tenant_memberships SET role='agent' WHERE tenant_id=$1 AND user_id=$2",[tenants[0],actor]);
    await rejected(()=>controller.releaseMetaNumber(requests[0],original.id,randomUUID(),releaseBody),403);
    await admin.query("UPDATE tenant_memberships SET role='tenant_owner' WHERE tenant_id=$1 AND user_id=$2",[tenants[0],actor]);
    await rejected(()=>controller.releaseMetaNumber(requests[0],original.id,randomUUID(),{...releaseBody,phoneNumberId:String(BigInt(phone)+1n)}));

    const unresolved=randomUUID();
    await withFixtureTenant(admin,tenants[0],()=>admin.query(`INSERT INTO connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,state,
      requested_by_type,requested_by_id,request_id,error_code,completed_at)
      VALUES($1::uuid,$2,$3,'START',$1::uuid::text,'FAILED_TERMINAL','USER',$4,'release-unknown','META_PROVIDER_OUTCOME_UNKNOWN',now())`,[unresolved,tenants[0],original.id,actor]));
    await rejected(()=>controller.releaseMetaNumber(requests[0],original.id,randomUUID(),releaseBody));
    await withFixtureTenant(admin,tenants[0],()=>admin.query("DELETE FROM connection_operations WHERE id=$1",[unresolved]));
    const releaseKey=randomUUID(),released=await controller.releaseMetaNumber(requests[0],original.id,releaseKey,releaseBody);
    assert.equal(released.released,true);assert.equal(released.duplicate,false);
    assert.equal((await admin.query("SELECT state FROM meta_connection_account_bindings WHERE connection_id=$1",[original.id])).rows[0].state,"RETIRED");
    assert.deepEqual((await admin.query("SELECT id,tenant_id,state FROM meta_messaging_accounts WHERE id=$1",[accountId])).rows[0],{id:accountId,tenant_id:tenants[0],state:"HELD"},"Phone release does not transfer the WABA or payment authority");
    assert.deepEqual(await controller.releaseMetaNumber(requests[0],original.id,releaseKey,releaseBody),{...released,duplicate:true});
    await rejected(()=>controller.releaseMetaNumber(requests[0],original.id,releaseKey,{...releaseBody,routeId:randomUUID()}));
    assert.equal((await admin.query("SELECT count(*)::int n FROM audit_events WHERE action='connection.meta_number_released' AND target_id=$1",[original.id])).rows[0].n,1);
    assert.equal((await admin.query("SELECT count(*)::int n FROM meta_number_releases WHERE connection_id=$1",[original.id])).rows[0].n,1);
    const oldHistory=(await admin.query("SELECT * FROM provider_sessions WHERE connection_id=$1",[original.id])).rows;
    assert.equal(oldHistory[0].id,originalSession.id);assert.equal(oldHistory[0].ownership_state,"RETIRED");
    assert.equal((await tenantQuery(tenants[0],"SELECT * FROM app.resolve_meta_webhook_route($1)",[phone])).rowCount,0);
    assert.equal((await tenantQuery(tenants[0],"SELECT * FROM app.resolve_meta_lifecycle_routes($1,$2) WHERE connection_id=$3",[wabaId,appId,original.id])).rowCount,0);
    await rejected(()=>db.acceptMetaLifecycleEvent(originalLifecycle,{providerEventId:randomUUID(),eventType:"meta.account.lifecycle.observation",payload:{},payloadSha256:"a".repeat(64)}),404);
    for(const sql of ["UPDATE webhook_routes SET reservation_release_id=NULL WHERE connection_id=$1",
      "UPDATE webhook_routes SET state='ACTIVE' WHERE connection_id=$1","DELETE FROM webhook_routes WHERE connection_id=$1",
      "UPDATE connections SET state='WORKING' WHERE id=$1","DELETE FROM connections WHERE id=$1",
      "UPDATE provider_sessions SET ownership_state='ACTIVE',retired_at=NULL WHERE connection_id=$1",
      "DELETE FROM provider_sessions WHERE connection_id=$1"]){
      await assert.rejects(()=>tenantQuery(tenants[0],sql,[original.id]),error=>["23514","42501"].includes(error.code));
    }

    // Hold an actual old cleanup claim while normal same-tenant recovery writes a NEW secret.
    await admin.query("UPDATE secret_cleanup_outbox SET available_at='-infinity' WHERE connection_id=$1 AND secret_reference=$2",[original.id,originalReference]);
    const cleanupLease=randomUUID(),tasks=await cleanup.claim(cleanupLease,1),oldTask=tasks.find(task=>task.secretReference===originalReference);
    assert.ok(oldTask,"Disconnect must have durably queued the old credential cleanup");
    const restored=await create(0);assert.notEqual(restored.id,original.id);await drain(0);
    const admission=(await admin.query("SELECT admission_opened_at FROM webhook_routes WHERE connection_id=$1",[restored.id])).rows[0].admission_opened_at;
    for(const [time,current] of [[null,false],[new Date(admission.getTime()-1000).toISOString(),false],[new Date(admission.getTime()+1000).toISOString(),true]]){
      assert.equal((await tenantQuery(tenants[0],"SELECT app.meta_number_event_current($1,$2::timestamptz) current",[restored.id,time])).rows[0].current,current);
    }
    const newLifecycle=(await db.resolveMetaLifecycleRoutes(wabaId,appId)).find(row=>row.connection_id===restored.id);
    const oldSeconds=Math.floor(admission.getTime()/1000)-1,oldObserved=new Date(oldSeconds*1000).toISOString();
    await rejected(()=>db.acceptMetaLifecycleEvent(newLifecycle,{providerEventId:randomUUID(),eventType:"meta.account.lifecycle.observation",
      payload:{entry:[{time:oldSeconds}],admission:{observedAt:oldObserved}},payloadSha256:"a".repeat(64)}),404);
    const routing={...newLifecycle,account_id:wabaId};
    for(const evidence of [{category:"CONTROL_PASSED",observedAt:oldObserved},
      {category:"UNRESOLVED_ROUTING",observedAt:new Date().toISOString()}]){
      await rejected(()=>db.acceptMetaRoutingEvent(routing,{providerEventId:randomUUID(),eventType:"meta.routing.control",
        payload:{},payloadSha256:"a".repeat(64),evidence:{schemaVersion:1,accountId:wabaId,phoneNumberId:phone,payloadSha256:"a".repeat(64),...evidence}}),404);
    }
    assert.equal((await admin.query("SELECT count(*)::int n FROM event_inbox WHERE connection_id=$1",[restored.id])).rows[0].n,0,"Old or receipt-time-only callbacks are refused before persistence");
    const restoredReference=(await admin.query("SELECT secret_reference FROM connections WHERE id=$1",[restored.id])).rows[0].secret_reference;
    assert.notEqual(restoredReference,originalReference);assert.ok(stored.has(restoredReference));
    stored.delete(oldTask.secretReference);assert.equal(await cleanup.complete(oldTask,cleanupLease),true);
    assert.ok(stored.has(restoredReference),"An already claimed cleanup cannot delete restored credentials");
    assert.deepEqual((await admin.query("SELECT * FROM provider_sessions WHERE connection_id=$1",[original.id])).rows,oldHistory,"Recovery never revives or rewrites the historical session");

    const restoredBody=await disconnect(0,restored.id);
    await controller.releaseMetaNumber(requests[0],restored.id,randomUUID(),restoredBody);
    // Real concurrent normal API claims: exactly one tenant wins, the other keeps #372's permanent-conflict response.
    const race=await Promise.allSettled([create(0),create(1)]);
    assert.equal(race.filter(row=>row.status==="fulfilled").length,1);
    const loser=race.find(row=>row.status==="rejected").reason;
    assert.equal(loser.getStatus(),409);assert.equal(loser.getResponse().code,"META_SIGNUP_ASSET_CONFLICT");
    const winningIndex=race.findIndex(row=>row.status==="fulfilled"),winner=race[winningIndex].value;await drain(winningIndex);
    assert.equal((await admin.query("SELECT count(*)::int n FROM webhook_routes WHERE provider='META' AND external_key=$1 AND reservation_release_id IS NULL",[phone])).rows[0].n,1);
    await rejected(()=>controller.releaseMetaNumber(requests[0],original.id,randomUUID(),releaseBody));
    // Release and reconnect from the other tenant as well, using supported operations, without stealing the winner.
    const winningBody=await disconnect(winningIndex,winner.id);
    await controller.releaseMetaNumber(requests[winningIndex],winner.id,randomUUID(),winningBody);
    const other=await create(1-winningIndex);await drain(1-winningIndex);
    assert.notEqual(other.id,winner.id);
    const releasedSession=(await admin.query("SELECT id FROM provider_sessions WHERE connection_id=$1",[restored.id])).rows[0];
    await assert.rejects(()=>withFixtureTenant(admin,tenants[0],()=>admin.query(
      "UPDATE provider_sessions SET tenant_id=$1,connection_id=$2,opaque_session_id=$3 WHERE id=$4",
      [tenants[1-winningIndex],other.id,String(BigInt(phone)+1000n),releasedSession.id])),
      error=>error.code==='23514' && error.message==='Released session history is immutable',
      "Changing the NEW binding cannot escape the released OLD-session guard");
    assert.equal((await admin.query("SELECT count(*)::int n FROM webhook_routes WHERE external_key=$1",[phone])).rows[0].n,4,"Every historical route is retained");
    return {normalDisconnectReleaseReconnect:true,sameTenantRecovery:true,otherTenantRecovery:true,concurrentClaims:true,
      cleanupRecoveryRace:true,staleSessionDenied:true,lateLifecycleAndRoutingDenied:true,drainCases:drainCases.length,tenantAuthorization:true,historyRetained:true};
  }finally{
    globalThis.fetch=oldFetch;
    for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);
    await db.onModuleDestroy();await pool.end();await cleanup.onModuleDestroy();await admin.end();
    // The canonical gate owns its isolated database. Retain synthetic historical rows until that database is dropped.
  }
}

async function seedPendingGroupEffect(admin,db,request,connection,kind){
  const {tenantId:tenant,userId:actor}=request.principal;
  const action=kind==="GROUP_UNKNOWN"?await new BotFlowsService(db).saveAction(request.principal,randomUUID(),{
    actionKey:"synthetic_release",name:"Synthetic",kind:"HTTP_JSON",endpointUrl:"https://synthetic.invalid/action",httpMethod:"POST",
    authScheme:"NONE",secretReference:null,headers:{},responseMapping:{},timeoutMs:5000,maxResponseBytes:262144,state:"PAUSED",expectedRevision:null}):null;
  const group=randomUUID(),family=randomUUID(),rule=randomUUID(),binding=randomUUID(),correlation=randomUUID();
  return withFixtureTenant(admin,tenant,async()=>{
    await admin.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,$4,'Synthetic drain group')",[group,tenant,connection,`synthetic-${group}`]);
    await admin.query("INSERT INTO rule_families(id,tenant_id,name,created_by) VALUES($1,$2,$3,$4)",[family,tenant,`release-${family}`,actor]);
    await admin.query("INSERT INTO rule_sets(id,tenant_id,family_id,name,version,state,snapshot_sha256,created_by) VALUES($1,$2,$3,$5,1,'DRAFT',encode(digest('[]','sha256'),'hex'),$4)",[rule,tenant,family,actor,`Synthetic drain ${rule}`]);
    await admin.query(`INSERT INTO group_bindings(id,tenant_id,whatsapp_group_id,rule_set_id,zammad_group_id,default_priority,assignment_mode,acknowledgement_template,agent_prefix,retention_days,state)
      VALUES($1,$2,$3,$4,'Operations','normal','zammad_auto','Case {{reference}}','Agent:',30,'DRAFT')`,[binding,tenant,group,rule]);
    await admin.query("INSERT INTO case_correlations(id,tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,zammad_ticket_number,state) VALUES($1,$2,$3,'SYNTHETIC','1','1','OPEN')",[correlation,tenant,binding]);
    if(kind==="TICKET_EVENT"){
      await admin.query("INSERT INTO ticket_event_executions(tenant_id,correlation_id,event,source_sha256,mode) VALUES($1,$2,'before_agent_reply',$3,'OFF')",[tenant,correlation,"a".repeat(64)]);return;
    }
    if(kind==="GROUP_UNKNOWN"){
      const trigger=randomUUID(),event=randomUUID();
      await admin.query("INSERT INTO trigger_rules(id,tenant_id,rule_set_id,name,matcher_type,pattern,priority) VALUES($1,$2,$3,'Synthetic','contains','synthetic',1)",[trigger,tenant,rule]);
      await admin.query("INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status) VALUES($1,$2,$3,'META',$4,'message','{}',$5,'PROCESSED')",[event,tenant,connection,randomUUID(),"a".repeat(64)]);
      await admin.query(`INSERT INTO group_action_executions(tenant_id,event_inbox_id,trigger_rule_id,action_definition_id,action_key,action_revision,action_snapshot,request_input,request_sha256,state,completed_at,action_revision_id)
        VALUES($1,$2,$3,$4,'synthetic_release',1,'{}','{}',$5,'OUTCOME_UNKNOWN',now(),$6)`,[tenant,event,trigger,action.id,"a".repeat(64),action.actionRevisionId]);return;
    }
    const delivery=randomUUID(),state=kind==="NATIVE_STATUS"?"SENT":kind==="MANUAL_RETRY"?"FAILED_TERMINAL":kind==="ATTEMPTED_QUEUE"?"QUEUED":kind;
    const batch=kind==="BLOCKED"?randomUUID():null,predecessor=kind==="BLOCKED"?randomUUID():null;
    if(predecessor)await admin.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state,batch_id,batch_sequence,batch_part_count)
      VALUES($1,$2,$3,$4,'1','1','Synthetic predecessor','text/plain',$5,'FAILED_TERMINAL',$6,0,2)`,[predecessor,tenant,connection,binding,randomUUID(),batch]);
    await admin.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state,attempts,manual_retry_allowed,batch_id,batch_sequence,batch_part_count,blocked_by_delivery_id)
      VALUES($1,$2,$3,$4,'1','1','Synthetic not sent','text/plain',$5,$6,$7,$8,$9,$10,$11,$12)`,[delivery,tenant,connection,binding,randomUUID(),state,["ATTEMPTED_QUEUE","OUTCOME_UNKNOWN"].includes(kind)?1:0,kind==="MANUAL_RETRY",batch,predecessor?1:0,predecessor?2:1,predecessor]);
    if(kind==="NATIVE_STATUS")await admin.query("INSERT INTO zammad_status_outbox(tenant_id,delivery_id,zammad_ticket_id,delivery_state) VALUES($1,$2,'1','SENT') ON CONFLICT(tenant_id,delivery_id,zammad_ticket_id) DO NOTHING",[tenant,delivery]);
    if(kind==="OUTCOME_UNKNOWN")await admin.query("INSERT INTO delivery_attempts(tenant_id,delivery_id,attempt_number,state,finished_at) VALUES($1,$2,1,'OUTCOME_UNKNOWN',now())",[tenant,delivery]);
    return {delivery};
  });
}
