import assert from 'node:assert/strict';
import {Client} from 'pg';
import {withFixtureTenant} from './meta-routing-fixture.mjs';

export async function verifyWahaRenewal({app,registry,admin,adminUrl}) {
  const tenantA='10000000-0000-4000-8000-000000000001';
  const tenantB='20000000-0000-4000-8000-000000000002';
  const sessions=(await admin.query(`SELECT * FROM provider_sessions
    WHERE connection_id IN ('12000000-0000-4000-8000-000000000001',
      '23000000-0000-4000-8000-000000000002') AND ownership_state='ACTIVE'
    ORDER BY tenant_id`)).rows;
  assert.equal(sessions.length,2);
  const [a,b]=sessions;
  const stable=row=>Object.fromEntries(Object.entries(row).filter(([key])=>
    !['assignment_lease_expires_at','updated_at'].includes(key)));
  const read=async()=> (await admin.query('SELECT * FROM provider_sessions WHERE id=ANY($1::uuid[]) ORDER BY tenant_id',[[a.id,b.id]])).rows;
  const renewal="SELECT app.renew_waha_worker_assignments('postgres-gows-a',interval '120 seconds') AS renewed";
  const lock=new Client({connectionString:adminUrl});
  await lock.connect();
  try {
    await withFixtureTenant(app,tenantB,()=>app.query(
      "SELECT * FROM app.acquire_waha_session_assignment($1,'GOWS',interval '5 minutes')",[b.id]));
    await withFixtureTenant(admin,tenantA,()=>admin.query(
      "UPDATE provider_sessions SET assignment_lease_expires_at=now()-interval '1 minute' WHERE id=$1",[a.id]));
    const before=await read();
    for (const context of ['',tenantB]) {
      await registry.query('BEGIN');
      try {
        await registry.query("SELECT set_config('app.tenant_id',$1,true)",[context]);
        assert.equal((await registry.query(renewal)).rows[0].renewed,'2');
        assert.equal((await registry.query("SELECT current_setting('app.tenant_id',true) AS tenant")).rows[0].tenant,context);
        const rows=(await registry.query(`SELECT app.renew_waha_worker_assignments('missing-worker') AS renewed`)).rows;
        assert.equal(rows[0].renewed,'0');
      } finally {await registry.query('ROLLBACK');}
    }
    assert.equal((await registry.query(renewal)).rows[0].renewed,'2');
    assert.ok(!(await registry.query("SELECT current_setting('app.tenant_id',true) AS tenant")).rows[0].tenant);
    const after=await read();
    assert.deepEqual(after.map(stable),before.map(stable));
    assert.ok(after.every(row=>new Date(row.assignment_lease_expires_at)>new Date()));
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM provider_sessions WHERE id=$1 FOR UPDATE',[a.id]);
    await registry.query('BEGIN');
    try {
      await registry.query("SET LOCAL statement_timeout='2s'");
      assert.equal((await registry.query(renewal)).rows[0].renewed,'1');
    } finally {await registry.query('ROLLBACK');await lock.query('ROLLBACK');}
    // A genuine PostgreSQL constraint failure after the first tenant's update
    // must roll back the entire renewal without leaking its tenant context.
    const failureBefore=await read();
    const secondById=[...failureBefore].sort((left,right)=>left.id.localeCompare(right.id))[1];
    await admin.query(`ALTER TABLE provider_sessions ADD CONSTRAINT waha_renewal_fixture_failure
      CHECK (id <> '${secondById.id}'::uuid OR assignment_lease_expires_at =
        '${new Date(secondById.assignment_lease_expires_at).toISOString()}'::timestamptz) NOT VALID`);
    await registry.query('BEGIN');
    try {
      await registry.query("SELECT set_config('app.tenant_id',$1,true)",[tenantB]);
      await registry.query('SAVEPOINT guarded_renewal');
      await assert.rejects(()=>registry.query(renewal),error=>error.code==='23514' && error.constraint==='waha_renewal_fixture_failure');
      await registry.query('ROLLBACK TO SAVEPOINT guarded_renewal');
      assert.equal((await registry.query("SELECT current_setting('app.tenant_id',true) AS tenant")).rows[0].tenant,tenantB);
      assert.deepEqual(await read(),failureBefore);
    } finally {
      await registry.query('ROLLBACK');
      await admin.query('ALTER TABLE provider_sessions DROP CONSTRAINT waha_renewal_fixture_failure');
    }
    await registry.query('BEGIN');
    await registry.query("SELECT set_config('app.tenant_id',$1,true)",[tenantA]);
    await registry.query('SAVEPOINT invalid_renewal');
    await assert.rejects(()=>registry.query("SELECT app.renew_waha_worker_assignments('postgres-gows-a',interval '1 second')"),error=>error.code==='22023');
    await registry.query('ROLLBACK TO SAVEPOINT invalid_renewal');
    assert.equal((await registry.query("SELECT current_setting('app.tenant_id',true) AS tenant")).rows[0].tenant,tenantA);
  } finally {
    await registry.query('ROLLBACK');
    await lock.query('ROLLBACK');await lock.end();
    await admin.query('ALTER TABLE provider_sessions DROP CONSTRAINT IF EXISTS waha_renewal_fixture_failure');
    for(const original of sessions) await withFixtureTenant(admin,original.tenant_id,()=>admin.query(`UPDATE provider_sessions
      SET waha_worker_id=$2,assignment_fencing_token=$3,assignment_lease_expires_at=$4,updated_at=$5,assigned_at=$6 WHERE id=$1`,
      [original.id,original.waha_worker_id,original.assignment_fencing_token,original.assignment_lease_expires_at,original.updated_at,original.assigned_at]));
    assert.deepEqual(await read(),sessions);
  }
}
