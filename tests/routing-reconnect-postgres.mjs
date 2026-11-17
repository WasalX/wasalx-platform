import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';

export async function verifyRoutingReconnect(client) {
  const actor='10100000-0000-4000-8000-000000000001';
  const sha=()=>createHash('sha256').update(randomUUID()).digest('hex');
  const begin='SELECT * FROM app.begin_client_routing_credential($1,$2,$3,$4,$5,$6,$7,$8)';
  const complete='SELECT * FROM app.complete_client_routing_credential($1,$2)';
  for(const state of ['CONNECTING','REVOKED']) {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.tenant_id','10000000-0000-4000-8000-000000000001',true)");
      const original=(await client.query(begin,[actor,'HTTP_JSON','Reconnect fixture','HMAC',null,null,sha(),sha()])).rows[0];
      if(state==='REVOKED')await client.query('SELECT app.abort_client_routing_credential($1,$2)',[original.integration_id,actor]);
      const revision=state==='REVOKED'?2:1;
      const key=sha(),payload=sha();
      const args=[actor,'HTTP_JSON','Reconnect fixture','HMAC',original.integration_id,revision,key,payload];
      for(const invalidRevision of [null,revision+1]) {
        await client.query('SAVEPOINT stale');
        await assert.rejects(()=>client.query(begin,args.map((value,index)=>index===5?invalidRevision:value)),error=>error.code==='40001');
        await client.query('ROLLBACK TO SAVEPOINT stale');
      }
      const replacement=(await client.query(begin,args)).rows[0];
      assert.equal(replacement.duplicate,false);
      assert.notEqual(replacement.secret_reference,original.secret_reference);
      const replay=(await client.query(begin,args)).rows[0];
      assert.equal(replay.integration_id,replacement.integration_id);assert.equal(replay.duplicate,true);
      await client.query('SAVEPOINT conflicting_payload');
      await assert.rejects(()=>client.query(begin,args.map((value,index)=>index===7?sha():value)),error=>error.code==='40001');
      await client.query('ROLLBACK TO SAVEPOINT conflicting_payload');
      const connected=(await client.query(complete,[replacement.integration_id,actor])).rows[0];
      assert.equal(connected.changed,true);
      const old=(await client.query('SELECT state,revision,secret_reference FROM client_routing_integrations WHERE id=$1',[original.integration_id])).rows[0];
      assert.equal(old.state,'REVOKED');assert.equal(Number(old.revision),revision+1);
      assert.equal(old.secret_reference,original.secret_reference);
      assert.equal((await client.query(complete,[replacement.integration_id,actor])).rows[0].changed,false);
    } finally {await client.query('ROLLBACK');}
  }
}
