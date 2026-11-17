import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {Client} from "pg";

// Seed a dormant original manual generation before the actual migration runner.
// No application role can create the resulting compatibility admission.
export async function seedMetaRoutingLegacyUpgrade(admin){
 const tenantId=randomUUID(),connectionId=randomUUID(),sessionId=randomUUID();
 await admin.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Routing upgrade fixture',$2,'SUSPENDED')",[tenantId,`routing-upgrade-${tenantId}`]);
 await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Original manual routing','META','CLOUD_API','WORKING',$3)",[connectionId,tenantId,`secret://${tenantId}/connections/${connectionId}/meta`]);
 await admin.query("INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data) VALUES($1,$2,$3,'12345678','WORKING','meta-cloud://87654321/12345678','ACTIVE','{\"wabaId\":\"87654321\"}')",[sessionId,tenantId,connectionId]);
 return{tenantId,connectionId,sessionId};
}

export async function verifyMetaRoutingLegacyUpgrade(admin,f,appUrl){
 const {tenantId,connectionId,sessionId}=f;
 const client=new Client({connectionString:appUrl,options:'-c statement_timeout=5000 -c lock_timeout=3000'});await client.connect();
 let failure,setupComplete=false;const cleanupFailures=[];
 const guard=()=>client.query("SELECT * FROM app.meta_direct_routing_guard($1,$2,'12345678','87654321',NULL,'123456789',$3)",[connectionId,sessionId,{mode:"SIMULATED",graphOrigin:"https://routing-provider.invalid",graphVersion:"v24.0",simulationBindingSha256:"7".repeat(64)}]).then(r=>r.rows[0]);
 try{
  const access=(await client.query(`SELECT current_user,session_user,pg_has_role(current_user,'wasalx_app','MEMBER') member,pg_has_role(session_user,'wasalx_app','MEMBER') session_member,
   has_database_privilege(current_user,current_database(),'TEMP') temporary,
   has_schema_privilege(current_user,'public','CREATE') public_create,has_schema_privilege(current_user,'app','CREATE') app_create,
   active.rolsuper,active.rolbypassrls,login.rolsuper session_super,login.rolbypassrls session_bypass
   FROM pg_catalog.pg_roles active JOIN pg_catalog.pg_roles login ON login.rolname=session_user WHERE active.rolname=current_user`)).rows[0];
  assert.deepEqual(access,{current_user:'wasalx_runtime',session_user:'wasalx_runtime',member:true,session_member:true,
   temporary:true,public_create:false,app_create:false,rolsuper:false,rolbypassrls:false,session_super:false,session_bypass:false});
  await client.query("BEGIN");await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
  // Fresh login and shadows precede its first guard or invalidation call.
  for(const table of ['provider_sessions','meta_routing_legacy_admissions','event_inbox','meta_thread_control_actions','meta_thread_ownership','meta_routing_reviews']){
   await client.query(`CREATE TEMP TABLE ${table}(LIKE public.${table})`);
  }
  await client.query('INSERT INTO pg_temp.provider_sessions SELECT * FROM public.provider_sessions WHERE id=$1',[sessionId]);
  await client.query("UPDATE pg_temp.provider_sessions SET opaque_session_id='999'");
  await client.query('INSERT INTO pg_temp.meta_routing_legacy_admissions SELECT * FROM public.meta_routing_legacy_admissions WHERE provider_session_id=$1',[sessionId]);
  assert.equal((await client.query('SELECT count(*)::integer count FROM pg_temp.meta_routing_legacy_admissions')).rows[0].count,1);
  setupComplete=true;
  const original=await guard();assert.equal(original.claim,"LEGACY_COMPATIBILITY");assert.equal(original.allowed,true);assert.equal(original.epoch,'0');
  // Exercise the real provider-session trigger as the app role, not an isolated expression.
  const unchanged=(await client.query("SELECT provider_state_data FROM public.provider_sessions WHERE id=$1",[sessionId])).rows[0].provider_state_data;
  assert.equal((await client.query("UPDATE public.provider_sessions SET provider_state_data=provider_state_data,updated_at=clock_timestamp() WHERE id=$1",[sessionId])).rowCount,1);
  assert.deepEqual((await client.query("SELECT provider_state_data FROM public.provider_sessions WHERE id=$1",[sessionId])).rows[0].provider_state_data,unchanged);
  assert.equal((await guard()).allowed,true,'An unchanged JSON document preserves the original legacy admission');
  for(const mutation of ["provider_state_data=jsonb_set(provider_state_data,'{metaSignup}','{}')","opaque_session_id='12345679'","provider_state_data=jsonb_set(provider_state_data,'{wabaId}','\"87654322\"')","ownership_state='RETIRED',retired_at=clock_timestamp()"]){
   await client.query("SAVEPOINT routing_upgrade");
   assert.equal((await client.query(`UPDATE public.provider_sessions SET ${mutation} WHERE id=$1`,[sessionId])).rowCount,1);
   assert.equal((await guard()).allowed,false);
   assert.equal((await client.query('SELECT disabled_at IS NOT NULL disabled FROM public.meta_routing_legacy_admissions WHERE provider_session_id=$1',[sessionId])).rows[0].disabled,true);
   assert.equal((await client.query('SELECT disabled_at FROM pg_temp.meta_routing_legacy_admissions')).rows[0].disabled_at,null);
   // Restoring mutable JSON/asset cannot recreate the original authority.
   assert.equal((await client.query("UPDATE public.provider_sessions SET opaque_session_id='12345678',ownership_state='ACTIVE',retired_at=NULL,provider_state_data=jsonb_set(provider_state_data-'metaSignup','{wabaId}','\"87654321\"') WHERE id=$1",[sessionId])).rowCount,1);
   assert.equal((await guard()).allowed,false);await client.query("ROLLBACK TO SAVEPOINT routing_upgrade");
  }
  const id=randomUUID();await client.query(`INSERT INTO public.event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,meta_routing_evidence)
   VALUES($1::uuid,$2,$3,'META',$1::text,'meta.routing.unresolved','{"redacted":true}',$4,'ACCEPTED',$5)`,[id,tenantId,connectionId,"a".repeat(64),{schemaVersion:1,category:"UNRESOLVED_ROUTING",providerSessionId:sessionId,phoneNumberId:"12345678",accountId:"87654321",appId:"123456789",observedAt:new Date().toISOString(),payloadSha256:"a".repeat(64)}]);
  assert.equal((await guard()).reason,'NEGATIVE_PENDING');
  assert.equal((await client.query("SELECT disabled_at IS NOT NULL disabled FROM public.meta_routing_legacy_admissions WHERE provider_session_id=$1",[sessionId])).rows[0].disabled,true);
  assert.equal((await client.query('SELECT disabled_at FROM pg_temp.meta_routing_legacy_admissions')).rows[0].disabled_at,null);
  assert.equal((await client.query('SELECT count(*)::integer count FROM pg_temp.event_inbox')).rows[0].count,0);
  await client.query('SAVEPOINT routing_upgrade_forbidden');
  await assert.rejects(()=>client.query('INSERT INTO public.meta_routing_legacy_admissions SELECT * FROM pg_temp.meta_routing_legacy_admissions'),error=>error.code==='42501');
  await client.query('ROLLBACK TO SAVEPOINT routing_upgrade_forbidden');
 }catch(error){failure=error;}finally{
  try{await client.query("ROLLBACK");}catch(error){cleanupFailures.push(error);}
  try{await client.end();}catch(error){cleanupFailures.push(error);}
 }
if(cleanupFailures.length)throw new AggregateError([...(failure?[failure]:[]),...cleanupFailures],'Routing upgrade cleanup failed; collection is blocked');
 try{
  assert.equal((await admin.query('SELECT disabled_at FROM public.meta_routing_legacy_admissions WHERE provider_session_id=$1',[sessionId])).rows[0].disabled_at,null,'rollback restores the unchanged original migration admission');
 }catch(error){throw new AggregateError([...(failure?[failure]:[]),error],'Routing upgrade restoration readback failed; collection is blocked');}
 // Only admitted fixture setup, rollback/end and successful public readback can admit collection.
 if(failure){if(setupComplete)failure.metaRoutingLegacyUpgradeCleanupConfirmed=true;throw failure;}
 return{originalManualAdmitted:true,notOwn:true,markerRevokes:true,assetRevokes:true,accountRevokes:true,retirementRevokes:true,signedUnknownRevokes:true,actualRoleShadowIsolation:true,liveEvidence:false};
}
