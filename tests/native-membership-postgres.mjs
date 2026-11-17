import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { migrate } from "../services/control-api/dist/migrate.js";
import { NativeMembershipService } from "../services/control-api/dist/native-membership.service.js";

// Reuse the release gate's migrated isolated database. The CLI is only for a
// fresh, explicitly supplied local test database; never production discovery.
export async function verifyNativeMembership(adminUrl) {
  const clients = [new Client({connectionString:adminUrl}),new Client({connectionString:adminUrl}),new Client({connectionString:adminUrl})];
  await Promise.all(clients.map(client=>client.connect()));
  const [admin,owner,racer]=clients;
  const begin=async(client,tenantId,app=false)=>{await client.query("BEGIN");await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);if(app)await client.query("SET LOCAL ROLE wasalx_app");};
  const fixture=async()=>{
    const tenantId=randomUUID(),ownerId=randomUUID(),memberId=randomUUID();
    await admin.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Membership test',$2,'ACTIVE')",[tenantId,`membership-${tenantId}`]);
    for(const id of [ownerId,memberId])await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Synthetic member')",[id,`subject-${id}`,`${id}@example.invalid`]);
    await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner'),($1,$3,'agent')",[tenantId,ownerId,memberId]);
    return {tenantId,ownerId,memberId};
  };
  const waitBlocked=async(pid)=>{
    for(let index=0;index<100;index++){
      if((await admin.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",[pid])).rows[0].blocked)return;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.fail("Concurrent operation did not reach the shared serialization lock");
  };
  const row=async(f)=> (await admin.query("SELECT role,member_state,revision::int,sync_state FROM native_membership_projections WHERE tenant_id=$1 AND user_id=$2",[f.tenantId,f.memberId])).rows[0];
  try {
    const f=await fixture();
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM native_membership_projections WHERE tenant_id=$1",[f.tenantId])).rows[0].count,0);
    await begin(owner,f.tenantId,true);
    await assert.rejects(()=>owner.query("UPDATE tenant_settings SET native_membership_sync_enabled=true WHERE tenant_id=$1",[f.tenantId]),{code:"42501"});
    await owner.query("ROLLBACK");
    await begin(owner,f.tenantId,true);
    await assert.rejects(()=>owner.query("SELECT app.enable_native_membership_sync($1)",[f.memberId]),{code:"42501"});
    await owner.query("ROLLBACK");
    // Enable snapshots first; role update started before commit must see enabled.
    await begin(owner,f.tenantId,true);
    await owner.query("SELECT app.enable_native_membership_sync($1)",[f.ownerId]);
    const racerPid=(await racer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const change=racer.query("UPDATE tenant_memberships SET role='supervisor' WHERE tenant_id=$1 AND user_id=$2",[f.tenantId,f.memberId]);
    await waitBlocked(racerPid);
    await owner.query("COMMIT");await change;
    assert.deepEqual(await row(f),{role:"supervisor",member_state:"ACTIVE",revision:2,sync_state:"PENDING"});
    // Invoke the actual emitted selector as wasalx_app: no native HTTP or credentials.
    // A privileged fixture client owns setup only; the service queries execute under the real app role.
    const instanceId=randomUUID(),instanceSecret=`secret://tenants/${f.tenantId}/zammad/service`;
    await admin.query(`INSERT INTO public.zammad_instances(id,tenant_id,base_url,version,state,database_reference,search_namespace,storage_prefix,service_secret_reference,privacy_secret_reference)
      VALUES($1,$2,'https://native.invalid','6.5.0','WORKING','fixture://native-membership',$3,$3,$4,$5)`,
      [instanceId,f.tenantId,`membership-${f.tenantId}`,instanceSecret,`secret://tenants/${f.tenantId}/zammad/privacy`]);
    const nativeRow=(await admin.query('SELECT * FROM public.native_membership_projections WHERE tenant_id=$1 AND user_id=$2',[f.tenantId,f.memberId])).rows[0];
    const instanceDatabase={withTenant:async(tenantId,work)=>{
      await begin(owner,tenantId,true);
      try{const result=await work(owner);await owner.query('COMMIT');return result;}
      catch(error){await owner.query('ROLLBACK');throw error;}
    }};
    const nativeService=new NativeMembershipService(instanceDatabase,{resolveCredentials:async()=>{assert.fail('Instance admission must not resolve credentials');}});
    // TypeScript private is an ordinary emitted method: exercise its real SQL, not a copied query.
    await begin(owner,f.tenantId,true);
    assert.equal((await owner.query("SELECT current_user AS role,has_any_column_privilege(current_user,'public.tenants','UPDATE') AS tenant_update")).rows[0].role,'wasalx_app');
    assert.equal((await owner.query("SELECT has_any_column_privilege(current_user,'public.tenants','UPDATE') AS tenant_update")).rows[0].tenant_update,false);
    assert.deepEqual(await nativeService.instance(nativeRow,owner),{id:instanceId,base_url:'https://native.invalid',service_secret_reference:instanceSecret});
    // The helper's tenant SHARE lock survives until the enclosing transaction commits.
    const suspend=racer.query("UPDATE public.tenants SET state='SUSPENDED' WHERE id=$1",[f.tenantId]);
    await waitBlocked(racerPid);await owner.query('COMMIT');await suspend;
    await begin(owner,f.tenantId,true);assert.equal(await nativeService.instance(nativeRow,owner),undefined);await owner.query('COMMIT');
    await admin.query("UPDATE public.tenants SET state='ACTIVE' WHERE id=$1",[f.tenantId]);
    const foreign=await fixture();
    await begin(owner,foreign.tenantId,true);assert.equal(await nativeService.instance(nativeRow,owner),undefined);await owner.query('COMMIT');
    await begin(owner,f.tenantId,true);assert.equal(await nativeService.instance({...nativeRow,zammad_instance_id:randomUUID()},owner),undefined);await owner.query('COMMIT');
    await admin.query("UPDATE public.zammad_instances SET state='PAUSED' WHERE id=$1",[instanceId]);
    assert.equal(await nativeService.instance(nativeRow),undefined);
    await admin.query("UPDATE public.zammad_instances SET state='WORKING' WHERE id=$1",[instanceId]);
    assert.deepEqual(await nativeService.instance(nativeRow),{id:instanceId,base_url:'https://native.invalid',service_secret_reference:instanceSecret},'Standalone lookup wraps helper and read in the same application transaction');
    assert.deepEqual(await row(f),{role:'supervisor',member_state:'ACTIVE',revision:2,sync_state:'PENDING'},'Read-only instance admission does not mutate or settle pending effects');


    // Membership mutation first; opt-in must backfill its committed final state.
    const reverse=await fixture();
    await begin(racer,reverse.tenantId);
    await racer.query("UPDATE tenant_memberships SET role='auditor' WHERE tenant_id=$1 AND user_id=$2",[reverse.tenantId,reverse.memberId]);
    await begin(owner,reverse.tenantId,true);
    const ownerPid=(await owner.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const enable=owner.query("SELECT app.enable_native_membership_sync($1)",[reverse.ownerId]);
    await waitBlocked(ownerPid);await racer.query("COMMIT");await enable;await owner.query("COMMIT");
    assert.deepEqual(await row(reverse),{role:"auditor",member_state:"ACTIVE",revision:1,sync_state:"PENDING"});

    const suspended=await fixture();
    await admin.query("UPDATE tenant_memberships SET state='SUSPENDED' WHERE tenant_id=$1 AND user_id=$2",[suspended.tenantId,suspended.memberId]);
    await begin(owner,suspended.tenantId,true);await owner.query("SELECT app.enable_native_membership_sync($1)",[suspended.ownerId]);await owner.query("COMMIT");
    assert.deepEqual(await row(suspended),{role:"agent",member_state:"SUSPENDED",revision:1,sync_state:"PENDING"});

    for(const operation of ["insert","remove"]){
      const next=await fixture();
      if(operation==="insert")await admin.query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2",[next.tenantId,next.memberId]);
      await begin(owner,next.tenantId,true);await owner.query("SELECT app.enable_native_membership_sync($1)",[next.ownerId]);
      const pending=racer.query(operation==="insert"?"INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')":"DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2",[next.tenantId,next.memberId]);
      await waitBlocked(racerPid);await owner.query("COMMIT");await pending;
      assert.equal((await row(next)).member_state,operation==="insert"?"ACTIVE":"REMOVED");
    }

    await admin.query("UPDATE tenant_memberships SET state='SUSPENDED' WHERE tenant_id=$1 AND user_id=$2",[f.tenantId,f.memberId]);
    assert.equal((await row(f)).revision,3);
    await admin.query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2",[f.tenantId,f.memberId]);
    assert.equal((await row(f)).member_state,"REMOVED");
    await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')",[f.tenantId,f.memberId]);
    assert.deepEqual(await row(f),{role:"agent",member_state:"ACTIVE",revision:5,sync_state:"PENDING"});
    await admin.query("UPDATE native_membership_projections SET native_user_id='12',applied_revision=revision,sync_state='READY' WHERE tenant_id=$1 AND user_id=$2",[f.tenantId,f.memberId]);
    for(const sql of ["native_user_id='13'","oidc_subject='different'","email='different@example.invalid'","revision=revision-1"]){
      await assert.rejects(()=>admin.query(`UPDATE native_membership_projections SET ${sql} WHERE tenant_id=$1 AND user_id=$2`,[f.tenantId,f.memberId]),{code:"55000"});
    }
    const syncColumns=["zammad_instance_id","native_user_id","requested_native_user_id","revision","applied_revision","sync_state","updated_at"];
    // Effective privileges include role inheritance, table-level and PUBLIC grants.
    for(const role of ["wasalx_app","wasalx_runtime"]){
      const privileges=(await admin.query(`SELECT has_any_column_privilege($1,'native_membership_projections','INSERT') AS insert_any,
        has_table_privilege($1,'native_membership_projections','DELETE') AS delete_any,
        has_table_privilege($1,'native_membership_projections','UPDATE') AS update_all`,[role])).rows[0];
      assert.deepEqual(privileges,{insert_any:false,delete_any:false,update_all:false});
      const columns=(await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public'
        AND table_name='native_membership_projections' AND has_column_privilege($1,'native_membership_projections',column_name,'UPDATE') ORDER BY column_name`,[role])).rows.map(record=>record.column_name);
      assert.deepEqual(columns,[...syncColumns].sort());
    }
    for(const subject of [f.ownerId,reverse.memberId]){
      await begin(owner,f.tenantId,true);
      await assert.rejects(()=>owner.query(`INSERT INTO native_membership_projections(tenant_id,user_id,oidc_subject,email,display_name,role,member_state)
        VALUES($1,$2,'forged','forged@example.invalid','Forged','tenant_owner','ACTIVE')`,[f.tenantId,subject]),{code:"42501"});
      await owner.query("ROLLBACK");
    }
    for(const sql of ["tenant_id=tenant_id","user_id=user_id","oidc_subject=oidc_subject","email=email","display_name=display_name","role='tenant_owner'","member_state='REMOVED'"]){
      await begin(owner,f.tenantId,true);
      await assert.rejects(()=>owner.query(`UPDATE native_membership_projections SET ${sql} WHERE tenant_id=$1 AND user_id=$2`,[f.tenantId,f.memberId]),{code:"42501"});
      await owner.query("ROLLBACK");
    }
    await begin(owner,f.tenantId,true);
    await owner.query(`UPDATE native_membership_projections SET zammad_instance_id=zammad_instance_id,native_user_id='12',requested_native_user_id='12',
      revision=revision+1,applied_revision=revision,sync_state='PENDING',updated_at=now() WHERE tenant_id=$1 AND user_id=$2`,[f.tenantId,f.memberId]);
    await owner.query("UPDATE native_membership_projections SET applied_revision=revision,sync_state='READY' WHERE tenant_id=$1 AND user_id=$2",[f.tenantId,f.memberId]);
    await owner.query("COMMIT");
    await begin(owner,f.tenantId,true);
    await assert.rejects(()=>owner.query("UPDATE native_membership_projections SET native_user_id='13' WHERE tenant_id=$1 AND user_id=$2",[f.tenantId,f.memberId]),{code:"55000"});
    await owner.query("ROLLBACK");
    await begin(owner,f.tenantId,true);
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM native_membership_projections WHERE tenant_id=$1",[reverse.tenantId])).rows[0].count,0);
    await assert.rejects(()=>owner.query("DELETE FROM native_membership_projections WHERE tenant_id=$1",[f.tenantId]),{code:"42501"});await owner.query("ROLLBACK");
    await admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1",[reverse.tenantId]);
    await begin(owner,reverse.tenantId,true);
    await assert.rejects(()=>owner.query("SELECT app.enable_native_membership_sync($1)",[reverse.ownerId]),{code:"42501"});await owner.query("ROLLBACK");
    return {membership_lifecycle:"passed",enable_concurrency:"passed",immutable_binding:"passed",tenant_isolation:"passed",projection_privileges:"passed",instance_app_admission:"passed"};
  } finally {
    await Promise.all(clients.map(async client=>{await client.query("ROLLBACK").catch(()=>{});await client.end();}));
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const adminUrl=process.env.DATABASE_ADMIN_URL;
  if(!adminUrl)throw new Error("Explicit isolated DATABASE_ADMIN_URL is required");
  await migrate(fileURLToPath(new URL("../services/control-api/migrations/",import.meta.url)));
  process.stdout.write(`${JSON.stringify(await verifyNativeMembership(adminUrl))}\n`);
}
