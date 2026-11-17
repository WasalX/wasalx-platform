// Run only from the repository's disposable PostgreSQL integration harness.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from 'pg';


export async function closeDesignationClient(client,errors){
 try{await client.query('ROLLBACK');}catch(e){errors.push(e);}finally{try{await client.end();}catch(e){errors.push(e);}}
}
export async function assertDesignationCleanup(client,ownedRows){
 for(const {tenant,table,ids} of ownedRows){
  assert(['group_bindings','whatsapp_groups','connections','rule_sets','rule_families'].includes(table));
  await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM '+table+' WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[tenant,ids])).rows[0].n,0,'Owned '+table+' rows remain');
 }
}

export function assertConflict(error) {
  assert.equal(error.code,'23505');
  assert.equal(error.constraint,'group_designated_binding_unique');
}

export async function insertMetaScopeConnection(client,id,tenant){
  await client.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Designation provider scope','META','CLOUD_API','PAUSED',$3)",[id,tenant,`secret://${tenant}/connections/${id}/meta`]);
}

export async function verifyGroupDesignation(admin,appUrl) {
  const tenant='10000000-0000-4000-8000-000000000001';
  const other='20000000-0000-4000-8000-000000000002';
  const rule='14000000-0000-4000-8000-000000000001';
  const cids=['12000000-0000-4000-8000-000000000001','12100000-0000-4000-8000-000000000002'];
  const tag=randomUUID(), external=tag+'@g.us';
  const bindings=Array.from({length:5},()=>randomUUID()), groups=Array.from({length:5},()=>randomUUID());
  const meta=randomUUID(),family=randomUUID(),otherRule=randomUUID();
  const clients=[new Client({connectionString:appUrl}),new Client({connectionString:appUrl})];
  const connected=[];let owned=false;let primary;
  const tx=async(c,t,fn)=>{await c.query('BEGIN');try{await c.query("SELECT set_config('app.tenant_id',$1,true)",[t]);await c.query("SET LOCAL statement_timeout='10s'");const value=await fn(c);await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK');throw e;}};
  const state=()=>tx(clients[0],tenant,async c=>(await c.query('SELECT * FROM group_bindings WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[tenant,bindings.slice(0,2)])).rows);
  const change=(c,id,value)=>c.query('UPDATE group_bindings SET state=$3 WHERE tenant_id=$1 AND id=$2 RETURNING id',[tenant,id,value]);
  try {
    // Fixed harness parents are admission requirements; never synthesize missing parents.
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM connections WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND provider=\'WAHA\'',[tenant,cids])).rows[0].n,2);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM tenants WHERE id=$1',[other])).rows[0].n,1);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM rule_sets WHERE tenant_id=$1 AND id=$2',[tenant,rule])).rows[0].n,1);
    await tx(admin,tenant,async c=>{
      await insertMetaScopeConnection(c,meta,tenant);
      for(let i=0;i<4;i++){
        await c.query('INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,$4,\'Designation fixture\')',[groups[i],tenant,i===3?meta:cids[i===1?1:0],i===2?tag+'fixture-0022@example.test':external]);
        await c.query("INSERT INTO group_bindings(id,tenant_id,whatsapp_group_id,rule_set_id,zammad_group_id,default_priority,assignment_mode,acknowledgement_template,agent_prefix,retention_days,state) VALUES($1,$2,$3,$4,'Operations','normal','zammad_auto','Case {{reference}}','Agent:',30,'PAUSED')",[bindings[i],tenant,groups[i],rule]);
      }
      // Admin switches only to the pre-existing second harness tenant.
      await c.query("SELECT set_config('app.tenant_id',$1,true)",[other]);
      await c.query('INSERT INTO rule_families(id,tenant_id,name) VALUES($1,$2,$3)',[family,other,'Designation '+tag]);
      await c.query("INSERT INTO rule_sets(id,tenant_id,family_id,name,version,state,snapshot_sha256) VALUES($1,$2,$3,$4,1,'DRAFT',encode(digest('[]','sha256'),'hex'))",[otherRule,other,family,'Designation '+tag]);
      await c.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,'23000000-0000-4000-8000-000000000002',$3,'Designation other tenant')",[groups[4],other,external]);
      await c.query("INSERT INTO group_bindings(id,tenant_id,whatsapp_group_id,rule_set_id,zammad_group_id,default_priority,assignment_mode,acknowledgement_template,agent_prefix,retention_days,state) VALUES($1,$2,$3,$4,'Operations','normal','zammad_auto','Case {{reference}}','Agent:',30,'PAUSED')",[bindings[4],other,groups[4],otherRule]);
    });owned=true;
    for(const c of clients){await c.connect();connected.push(c);}
    const pids=await Promise.all(clients.map(async c=>(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
    for(const c of clients){await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);await c.query("SET LOCAL statement_timeout='10s'");}
    assert.equal((await change(clients[0],bindings[0],'ACTIVE')).rowCount,1);
    // First transaction holds the actual unique-index conflict until overlap is proven.
    const pending=change(clients[1],bindings[1],'ACTIVE').then(()=>({unexpected:true}),e=>({code:e.code,constraint:e.constraint}));
    let overlap=false;
    for(let n=0;n<100;n++){
      const r=await admin.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked',[pids[0],pids[1]]);
      if(r.rows[0].blocked){overlap=true;break;}await delay(20);
    }
    if(!overlap){await clients[0].query('ROLLBACK');await pending;throw new Error('No observed PostgreSQL lock overlap');}
    await clients[0].query('COMMIT');assertConflict(await pending);await clients[1].query('ROLLBACK');
    const original=await state();
    assert.equal(original.find(r=>r.id===bindings[0]).state,'ACTIVE');
    assert.equal(original.find(r=>r.id===bindings[1]).state,'PAUSED');
    await assert.rejects(tx(clients[1],tenant,c=>change(c,bindings[1],'ACTIVE')),e=>{assertConflict(e);return true;});
    assert.deepEqual(await state(),original,'Rejected activation changed original binding');
    // Distinct physical group, provider, and tenant are independent unique-index scopes.
    await tx(clients[0],tenant,async c=>{for(const id of bindings.slice(2,4))assert.equal((await change(c,id,'ACTIVE')).rowCount,1);});
    await tx(clients[1],other,async c=>assert.equal((await c.query("UPDATE group_bindings SET state='ACTIVE' WHERE tenant_id=$1 AND id=$2 RETURNING id",[other,bindings[4]])).rowCount,1));
    await tx(clients[0],tenant,c=>change(c,bindings[0],'PAUSED'));
    assert((await state()).every(r=>r.state==='PAUSED'),'Unexpected automatic fallback');
    await tx(clients[0],tenant,c=>change(c,bindings[1],'ACTIVE'));
    const final=await state();assert.equal(final.filter(r=>r.state==='ACTIVE').length,1);assert.equal(final.find(r=>r.id===bindings[1]).state,'ACTIVE');
    for(const [t,ids] of [[tenant,bindings.slice(0,4)],[other,[bindings[4]]]])await tx(clients[0],t,async c=>{
      const rows=(await c.query('SELECT id,state FROM group_bindings WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[t,ids])).rows;
      assert.equal(rows.length,ids.length);
      assert.equal(rows.filter(r=>r.state==='ACTIVE').length,t===tenant?3:1);
      for(const table of ['case_correlations','delivery_outbox'])assert.equal((await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1 AND group_binding_id=ANY($2::uuid[])`,[t,ids])).rows[0].n,0,'Unexpected fixture effects');
    });
    const proof={mode:'simulated',scope:'postgresql-invariant-only',timestamp:new Date().toISOString(),lockOverlap:overlap,conflict:{code:'23505',constraint:'group_designated_binding_unique'},originalPreserved:true,independentScopes:['tenant','provider','group'],transition:['ACTIVE/PAUSED','PAUSED/PAUSED','PAUSED/ACTIVE'],testSuffixes:['reject-second','concurrent','scoped-transition']};
    return proof;
  }catch(e){primary=e;throw e;}finally{
    const errors=[];
    for(const c of connected)await closeDesignationClient(c,errors);
    try{await admin.query('ROLLBACK');if(owned)await tx(admin,tenant,async c=>{
      await c.query('DELETE FROM group_bindings WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[tenant,bindings.slice(0,4)]);
      await c.query('DELETE FROM whatsapp_groups WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[tenant,groups.slice(0,4)]);
      await c.query('DELETE FROM connections WHERE tenant_id=$1 AND id=$2',[tenant,meta]);
      await c.query("SELECT set_config('app.tenant_id',$1,true)",[other]);
      await c.query('DELETE FROM group_bindings WHERE tenant_id=$1 AND id=$2',[other,bindings[4]]);
      await c.query('DELETE FROM whatsapp_groups WHERE tenant_id=$1 AND id=$2',[other,groups[4]]);
      await c.query('DELETE FROM rule_sets WHERE tenant_id=$1 AND id=$2',[other,otherRule]);
      await c.query('DELETE FROM rule_families WHERE tenant_id=$1 AND id=$2',[other,family]);
      await assertDesignationCleanup(c,[
        {tenant,table:'group_bindings',ids:bindings.slice(0,4)},
        {tenant,table:'whatsapp_groups',ids:groups.slice(0,4)},
        {tenant,table:'connections',ids:[meta]},
        {tenant:other,table:'group_bindings',ids:[bindings[4]]},
        {tenant:other,table:'whatsapp_groups',ids:[groups[4]]},
        {tenant:other,table:'rule_sets',ids:[otherRule]},
        {tenant:other,table:'rule_families',ids:[family]},
      ]);
    });}catch(e){errors.push(e);}
    // eslint-disable-next-line no-unsafe-finally -- Preserve a primary failure; otherwise cleanup failure must prevent a PASS.
    if(errors.length){if(primary)primary.cleanupFailed=true;else throw new AggregateError(errors,'Designation fixture cleanup failed');}
  }
}
