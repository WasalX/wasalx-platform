import assert from 'node:assert/strict';
// Invoke inside existing verifyOwnedWorkRestoration transaction after inbox terminalization.
// Uses actual migrated table constraints; no stand-in schema, no committed fixture.
export async function verifyFutureConnectionOperations(client,options,observeOwnedRestoration){
 const {tenantId,connectionId}=options;
 const inserted=await client.query("INSERT INTO connection_operations(tenant_id,connection_id,operation_type,idempotency_key,state,available_at,requested_by_type,requested_by_id,request_id) VALUES($1,$2,'SYNC_GROUPS','restoration-future-check','QUEUED',now()+interval '1 day','SYSTEM','restoration-check','restoration-check') RETURNING id",[tenantId,connectionId]);
 const id=inserted.rows[0].id;
 for(const state of ['QUEUED','FAILED_RETRYABLE']){
  await client.query('UPDATE connection_operations SET state=$2 WHERE id=$1',[id,state]);
  await assert.rejects(observeOwnedRestoration(options),/Owned native\/action\/status work remains/);
 }
 await client.query("UPDATE connection_operations SET state='CANCELLED',completed_at=now() WHERE id=$1",[id]);
 await observeOwnedRestoration(options);
 return{passed:3,rollbackRequired:true};
}
