import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath,pathToFileURL } from "node:url";
import { Client } from "pg";
import { migrate } from "../services/control-api/dist/migrate.js";
import { NativeRoutingSyncService } from "../services/control-api/dist/native-routing-sync.service.js";

// Synthetic, rollback-only fixtures on the explicitly supplied isolated gate DB.
export async function verifyNativeRouting(adminUrl){
  const client=new Client({connectionString:adminUrl});await client.connect();
  const tenant=randomUUID(),foreign=randomUUID(),user=randomUUID(),instance=randomUUID(),connection=randomUUID(),family=randomUUID(),version=randomUUID(),assignment=randomUUID(),group=randomUUID(),rules=randomUUID(),ruleFamily=randomUUID(),binding=randomUUID(),routing=randomUUID();
  const revision=async()=>Number((await client.query("SELECT desired_revision FROM native_routing_projections WHERE tenant_id=$1",[tenant])).rows[0].desired_revision);
  let sequence=0;const rejects=async(action,code)=>{const name=`routing_negative_${++sequence}`;await client.query(`SAVEPOINT ${name}`);await assert.rejects(action,error=>error.code===code);await client.query(`ROLLBACK TO SAVEPOINT ${name}`);};
  const bump=async(action)=>{const before=await revision();await action();assert.ok(await revision()>before,"Effective configuration changes enqueue atomically");};
  try{
    await client.query("BEGIN");await client.query("SELECT set_config('app.tenant_id','',true)");
    await client.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Synthetic routing',$2,'ACTIVE'),($3,'Foreign routing',$4,'ACTIVE')",[tenant,`routing-${tenant}`,foreign,`routing-${foreign}`]);
    // Canonical bootstrap seeds native instances before a tenant context exists.
    await client.query("INSERT INTO zammad_instances(id,tenant_id,base_url,version,state,database_reference,search_namespace,storage_prefix,service_secret_reference,privacy_secret_reference) VALUES($1,$2,'https://native.example.invalid','0.5.67','WORKING','synthetic','synthetic','synthetic',$3,$4)",[instance,tenant,`secret://tenants/${tenant}/zammad/service`,`secret://tenants/${tenant}/zammad/privacy`]);
    assert.equal(await revision(),1,"Trusted bootstrap queues the instance without tenant context");
    await client.query("SET LOCAL ROLE wasalx_app");
    await rejects(()=>client.query("SELECT app.queue_native_routing($1)",[tenant]),"42501");
    await client.query("RESET ROLE");
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[foreign]);
    await client.query("SET LOCAL ROLE wasalx_app");
    await rejects(()=>client.query("SELECT app.queue_native_routing($1)",[tenant]),"42501");
    await client.query("RESET ROLE");
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
    await client.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Synthetic routing owner')",[user,`routing-${user}`,`${user}@example.invalid`]);
    await client.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')",[tenant,user]);
    assert.equal(await revision(),1);
    assert.deepEqual((await client.query("SELECT applied_revision::int,next_action,attempted_request,last_checked_at FROM native_routing_projections WHERE tenant_id=$1",[tenant])).rows[0],{applied_revision:0,next_action:"CHECK",attempted_request:null,last_checked_at:null});
    const sync=new NativeRoutingSyncService({},{});
    for(const departmentDefaults of [[],[{id:randomUUID(),zammadGroupId:"5",zammadOwnerId:"7",enabled:true}]]){
      await sync.command(client,tenant,{action:"SAVE_DEFAULTS",expectedRevision:await revision(),departmentDefaults});
      assert.deepEqual((await client.query("SELECT department_defaults FROM native_routing_projections WHERE tenant_id=$1",[tenant])).rows[0].department_defaults,departmentDefaults,"Actual pg saves empty and populated lists as JSON arrays");
    }
    await client.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Synthetic connection','WAHA','GOWS','WORKING','secret://synthetic')",[connection,tenant]);
    await client.query("INSERT INTO bot_flow_families(id,tenant_id,name,created_by) VALUES($1,$2,'Synthetic flow',$3)",[family,tenant,user]);
    const definition={schemaVersion:1,name:"Synthetic",start:"agent",maxSteps:2,nodes:[{id:"agent",type:"handoff",target:"FIXED",zammadGroupId:"5",priority:"2 normal"}]};
    const beforeDraft=await revision();
    await client.query("INSERT INTO bot_flow_versions(id,tenant_id,family_id,version,state,definition,snapshot_sha256,created_by) VALUES($1,$2,$3,1,'DRAFT',$4,repeat('a',64),$5)",[version,tenant,family,definition,user]);
    assert.equal(await revision(),beforeDraft,"Draft-only edits have no native effect");
    await bump(()=>client.query("SELECT * FROM app.activate_bot_flow_version($1,1,NULL,$2)",[version,user]));
    await bump(()=>client.query("INSERT INTO bot_assignments(id,tenant_id,connection_id,flow_family_id,flow_version_id,zammad_group_id,state,created_by,updated_by) VALUES($1,$2,$3,$4,$5,'5','ACTIVE',$6,$6)",[assignment,tenant,connection,family,version,user]));
    await bump(()=>client.query("UPDATE bot_assignments SET state='PAUSED',revision=revision+1 WHERE id=$1",[assignment]));
    await bump(()=>client.query("UPDATE bot_assignments SET state='ACTIVE',revision=revision+1 WHERE id=$1",[assignment]));
    await client.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,'fixture-0027@example.test','Synthetic')",[group,tenant,connection]);
    await client.query("INSERT INTO rule_families(id,tenant_id,name,created_by) VALUES($1,$2,'Synthetic rule',$3)",[ruleFamily,tenant,user]);
    await client.query("INSERT INTO rule_sets(id,tenant_id,family_id,name,version,state,revision,snapshot_sha256,created_by,activated_by,activated_at) VALUES($1,$2,$3,'Synthetic',1,'ACTIVE',1,repeat('b',64),$4,$4,now())",[rules,tenant,ruleFamily,user]);
    await client.query("INSERT INTO group_bindings(id,tenant_id,whatsapp_group_id,rule_set_id,zammad_group_id,default_priority,assignment_mode,acknowledgement_template,agent_prefix,retention_days,state) VALUES($1,$2,$3,$4,'5','normal','zammad_auto','Synthetic','Agent',30,'DRAFT')",[binding,tenant,group,rules]);
    await client.query("SET LOCAL ROLE wasalx_app");
    await bump(()=>client.query("UPDATE group_bindings SET state='ACTIVE',revision=revision+1 WHERE id=$1",[binding]));
    await client.query("RESET ROLE");
    await bump(()=>client.query("UPDATE group_bindings SET state='PAUSED',revision=revision+1 WHERE id=$1",[binding]));
    await bump(()=>client.query("UPDATE group_bindings SET state='ACTIVE',revision=revision+1 WHERE id=$1",[binding]));
    await verifyRoutingTriggerAuthority(client,{tenant,foreign,user,instance,connection,binding,revision,rejects,bump});
    const routingDefinition={schemaVersion:1,name:"Synthetic",fallback:{zammadGroupId:"5"},supportGroupIds:["5"],sources:[],clients:[]};
    const beforeRoutingDraft=await revision();
    await client.query("INSERT INTO client_routing_versions(id,tenant_id,version,state,definition,snapshot_sha256,created_by) VALUES($1,$2,1,'DRAFT',$3,repeat('c',64),$4)",[routing,tenant,routingDefinition,user]);
    assert.equal(await revision(),beforeRoutingDraft);
    await bump(()=>client.query("UPDATE client_routing_versions SET state='ACTIVE',activated_by=$2,activated_actor_type='USER',activated_at=now(),revision=revision+1 WHERE id=$1",[routing,user]));
    await bump(()=>client.query("UPDATE client_routing_versions SET state='RETIRED',retired_by=$2,retired_actor_type='USER',retired_at=now(),revision=revision+1 WHERE id=$1",[routing,user]));
    const request={schema_version:1,action:"APPLY",tenant_id:tenant,instance_id:instance,revision:await revision(),desired_sha256:"d".repeat(64),expected_native_revision:0,manifest:{group_references:[],assignments:[],department_defaults:[],client_routing:null}};
    await client.query("UPDATE native_routing_projections SET attempted_request=$2,sync_state='OUTCOME_UNKNOWN',next_action=NULL,safe_retry=false WHERE tenant_id=$1",[tenant,request]);
    await bump(()=>client.query("UPDATE group_bindings SET zammad_group_id='6',revision=revision+1 WHERE id=$1",[binding]));
    let projection=(await client.query("SELECT * FROM native_routing_projections WHERE tenant_id=$1",[tenant])).rows[0];
    assert.equal(projection.sync_state,"OUTCOME_UNKNOWN");assert.equal(projection.next_action,"CHECK");assert.equal(projection.safe_retry,false);assert.deepEqual(projection.attempted_request,request);
    await bump(()=>client.query("UPDATE connections SET state='REVOKED' WHERE id=$1",[connection]));
    assert.deepEqual((await client.query("SELECT attempted_request FROM native_routing_projections WHERE tenant_id=$1",[tenant])).rows[0].attempted_request,request);
    await bump(()=>client.query("DELETE FROM group_bindings WHERE id=$1",[binding]));
    await bump(()=>client.query("DELETE FROM bot_assignments WHERE id=$1",[assignment]));
    await bump(()=>client.query("UPDATE bot_flow_versions SET state='RETIRED',retired_by=$2,retired_at=now(),revision=revision+1 WHERE id=$1",[version,user]));
    await client.query("SET LOCAL ROLE wasalx_app");
    assert.ok((await client.query("SELECT app.pending_native_routing_tenants() AS tenant_id")).rows.some(row=>row.tenant_id===tenant),"Runtime discovery finds durable intent without leaking configuration");
    assert.equal((await client.query("SELECT count(*)::int AS count FROM native_routing_projections WHERE tenant_id=$1",[foreign])).rows[0].count,0);
    await rejects(()=>client.query("SELECT app.queue_native_routing($1)",[foreign]),"42501");
    await rejects(()=>client.query("UPDATE native_routing_projections SET zammad_instance_id=$2 WHERE tenant_id=$1",[tenant,randomUUID()]),"55000");
    await rejects(()=>client.query("DELETE FROM native_routing_projections WHERE tenant_id=$1",[tenant]),"42501");
    await client.query("RESET ROLE");
    const triggers=(await client.query("SELECT tgname FROM pg_trigger WHERE tgname LIKE 'native_routing_%' AND NOT tgisinternal")).rows.map(row=>row.tgname);
    for(const name of ["group_binding","bot_assignment","flow_version","client_version","connection","instance"])assert.ok(triggers.includes(`native_routing_${name}`));
    return{native_routing_hooks:"passed",department_default_json_arrays:"passed",draft_isolation:"passed",unknown_supersession:"passed",tenant_instance_fences:"passed"};
  }finally{await client.query("ROLLBACK").catch(()=>{});await client.end();}
}

async function verifyRoutingTriggerAuthority(client,{tenant,foreign,user,instance,connection,binding,revision,rejects,bump}){
  await client.query("SAVEPOINT routing_trigger_authority");
  const context=async()=>(await client.query("SELECT COALESCE(current_setting('app.tenant_id',true),'') AS tenant,current_user,session_user")).rows[0];
  try{
    const functions=(await client.query(`SELECT p.proname,p.prosecdef,p.proconfig,r.rolname,r.rolsuper,r.rolcanlogin
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      WHERE p.oid IN ('app.queue_native_routing(uuid)'::regprocedure,'app.native_routing_configuration_changed()'::regprocedure)`)).rows;
    assert.equal(functions.find(row=>row.proname==='queue_native_routing').prosecdef,false);
    const trigger=functions.find(row=>row.proname==='native_routing_configuration_changed');
    assert.equal(trigger.prosecdef,true);assert.equal(trigger.rolname,'wasalx_tenant_admin_writer');
    assert.equal(trigger.rolsuper,false);assert.equal(trigger.rolcanlogin,false);
    assert.deepEqual([...trigger.proconfig].sort(),['row_security=off','search_path=pg_catalog, public, app, pg_temp'].sort());
    const privileges=(await client.query(`SELECT
      has_function_privilege('wasalx_app','app.native_routing_configuration_changed()','EXECUTE') app_trigger,
      has_column_privilege('wasalx_tenant_admin_writer','zammad_instances','id','SELECT') owner_id,
      has_column_privilege('wasalx_tenant_admin_writer','zammad_instances','tenant_id','SELECT') owner_tenant,
      has_column_privilege('wasalx_tenant_admin_writer','zammad_instances','service_secret_reference','SELECT') owner_secret`)).rows[0];
    assert.deepEqual(privileges,{app_trigger:false,owner_id:true,owner_tenant:true,owner_secret:false});
    for(const role of ['wasalx_provisioning_client','wasalx_provisioning_executor','wasalx_connector_worker','wasalx_meta_transition_executor']){
      assert.deepEqual((await client.query(`SELECT has_function_privilege($1,'app.queue_native_routing(uuid)','EXECUTE') helper,
        has_table_privilege($1,'native_routing_projections','INSERT') insert_projection,
        has_table_privilege($1,'native_routing_projections','UPDATE') update_projection`,[role])).rows[0],{helper:false,insert_projection:false,update_projection:false},`${role} gains no direct queue or projection authority`);
    }
    await client.query("SET LOCAL ROLE wasalx_app");
    await bump(()=>client.query("SELECT app.queue_native_routing($1)",[tenant]));
    await client.query("CREATE TEMP TABLE forged_native_routing(tenant_id uuid,state text) ON COMMIT DROP");
    await rejects(()=>client.query("CREATE TRIGGER forged_native_routing AFTER INSERT ON pg_temp.forged_native_routing FOR EACH ROW EXECUTE FUNCTION app.native_routing_configuration_changed()"),'42501');
    await client.query("RESET ROLE");
    // Even a bootstrap-installed trigger cannot turn an app-owned temp row into authority.
    await client.query("CREATE TRIGGER forged_native_routing AFTER INSERT ON pg_temp.forged_native_routing FOR EACH ROW EXECUTE FUNCTION app.native_routing_configuration_changed()");
    await client.query("SET LOCAL ROLE wasalx_app");
    await rejects(()=>client.query("INSERT INTO pg_temp.forged_native_routing VALUES($1,'ACTIVE')",[foreign]),'42501');
    await bump(()=>client.query("UPDATE group_bindings SET zammad_group_id='6',revision=revision+1 WHERE id=$1",[binding]));
    const routingDefinition={schemaVersion:1,name:'Synthetic trigger publication',fallback:{zammadGroupId:'5'},supportGroupIds:['5'],sources:[],clients:[]};
    const draft=(await client.query("SELECT * FROM app.create_client_routing_version($1,$2)",[routingDefinition,user])).rows[0];
    await bump(()=>client.query("SELECT * FROM app.activate_client_routing_version($1,$2,NULL,$3)",[draft.id,draft.revision,user]));
    await client.query("RESET ROLE");
    const foreignConnection=randomUUID();
    await client.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Foreign trigger scope','WAHA','GOWS','WORKING','secret://synthetic')",[foreignConnection,foreign]);
    for(const role of ['wasalx_connector_worker','wasalx_meta_transition_executor']){
      await client.query("SAVEPOINT routing_role_revoke");
      const beforeRevision=await revision();
      await client.query(`SET LOCAL ROLE ${role}`);
      assert.equal((await client.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper,false);
      const before=await context();
      assert.equal((await client.query("UPDATE connections SET state='REVOKED' WHERE id=$1 RETURNING id",[connection])).rowCount,1,`${role} retains its existing authorized source mutation`);
      assert.deepEqual(await context(),before,'Trigger restores the real caller role and tenant');
      assert.equal((await client.query("UPDATE connections SET state='REVOKED' WHERE id=$1 RETURNING id",[foreignConnection])).rowCount,0,'Foreign source rows stay inaccessible');
      await client.query("RESET ROLE");assert.ok(await revision()>beforeRevision,'Authorized revocation atomically queues native intent');
      await client.query("ROLLBACK TO SAVEPOINT routing_role_revoke");await client.query("RELEASE SAVEPOINT routing_role_revoke");
    }
    const beforeFailure=await context(),beforeRevision=await revision();
    await client.query("SAVEPOINT routing_trigger_failure");
    await client.query("REVOKE EXECUTE ON FUNCTION app.queue_native_routing(uuid) FROM wasalx_tenant_admin_writer");
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[foreign]);
    await assert.rejects(()=>client.query("UPDATE zammad_instances SET state='DEGRADED' WHERE id=$1",[instance]),error=>error.code==='42501');
    await client.query("ROLLBACK TO SAVEPOINT routing_trigger_failure");await client.query("RELEASE SAVEPOINT routing_trigger_failure");
    assert.deepEqual(await context(),beforeFailure);assert.equal(await revision(),beforeRevision,'A failed bridge cannot change desired intent');
    await verifyRoutingProvisioningCompletion(client);
  }finally{await client.query("ROLLBACK TO SAVEPOINT routing_trigger_authority");await client.query("RELEASE SAVEPOINT routing_trigger_authority");}
}

async function verifyRoutingProvisioningCompletion(client){
  const key=`native-routing-provision-${randomUUID()}`,lease=randomUUID();
  const release={packageVersion:'0.5.80',packageSha256:'a'.repeat(64),images:Object.fromEntries(

    ['zammad','configurator','nginx','redis','memcached'].map(name=>[name,`registry.example.invalid/${name}@sha256:${'b'.repeat(64)}`]))};
  const spec={deployment:{zammadVersion:'7.1.3',release}};
  await client.query("SET LOCAL ROLE wasalx_provisioning_client");
  const created=(await client.query("SELECT app.operator_create_tenant($1,$2,$3,$4,30,$5,$6,$7,$8,$9,$10) AS result",
    [key,'c'.repeat(64),'Synthetic routing provision',key,spec,`${key}-owner`,`${key}@example.invalid`,'Synthetic owner','synthetic-operator',key])).rows[0].result;
  await client.query("RESET ROLE");
  const tenant=created.tenant_id,base='https://routing-provision.example.invalid';
  const steps={identity:{},database:{database_reference:`postgresql://database.example.invalid/${tenant}`},
    search:{search_namespace:`wasalx_${tenant.replaceAll('-','')}`},storage:{storage_prefix:`tenants/${tenant}/`},
    secrets:{service_secret_reference:`secret://tenants/${tenant}/zammad/service`,privacy_secret_reference:`secret://tenants/${tenant}/zammad/privacy`},
    zammad:{zammad_base_url:base,runtime_image:release.images.zammad,package_version:release.packageVersion,package_sha256:release.packageSha256},
    package:{package_version:release.packageVersion,package_sha256:release.packageSha256},oidc:{},defaults:{}};
  // Earlier infrastructure stages are synthetic; health completion itself uses the real sealed runtime function.
  await client.query(`UPDATE provisioning_operations SET status='RUNNING',current_step='health',completed_steps=$2,step_results=$3,
    fencing_token=1,attempts=1,lease_id=$4,lease_expires_at=now()+interval '3 minutes' WHERE tenant_id=$1`,[tenant,JSON.stringify(Object.keys(steps)),JSON.stringify(steps),lease]);
  await client.query("SELECT set_config('app.tenant_id','',true)");
  await client.query("SET LOCAL ROLE wasalx_provisioning_client");
  assert.equal((await client.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper,false);
  assert.equal((await client.query("SELECT app.complete_tenant_provisioning_step($1,$2,1,'health',$3) AS changed",[tenant,lease,{zammad_base_url:base,healthy:true,isolation_verified:true}])).rows[0].changed,true);
  assert.equal((await client.query("SELECT COALESCE(current_setting('app.tenant_id',true),'') AS tenant")).rows[0].tenant,'','Provisioning does not inherit the trigger row scope');
  await client.query("RESET ROLE");
  assert.equal((await client.query("SELECT state FROM tenants WHERE id=$1",[tenant])).rows[0].state,'ACTIVE');
  assert.deepEqual((await client.query("SELECT applied_revision::int,next_action,attempted_request,last_checked_at FROM native_routing_projections WHERE tenant_id=$1",[tenant])).rows[0],{applied_revision:0,next_action:'CHECK',attempted_request:null,last_checked_at:null});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const adminUrl=process.env.DATABASE_ADMIN_URL;if(!adminUrl)throw new Error("Explicit isolated DATABASE_ADMIN_URL required");
  await migrate(fileURLToPath(new URL("../services/control-api/migrations/",import.meta.url)));
  process.stdout.write(`${JSON.stringify(await verifyNativeRouting(adminUrl))}\n`);
}
