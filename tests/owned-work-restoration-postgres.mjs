import {verifyFutureConnectionOperations} from './restoration-operation-postgres-check.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {observeOwnedRestoration,restoreObservedConfiguration} from '../scripts/release/owned-work-restoration.mjs';
export async function verifyOwnedWorkRestoration(client, appUrl) {
const role=decodeURIComponent(new URL(appUrl).username);assert(role);
const quotedRole='"'+role.replaceAll('"','""')+'"';
const tenantId='10000000-0000-4000-8000-000000000001',connectionId=randomUUID(),eventId=randomUUID();let checks=0;
try{
 await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
 await client.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Owned restoration regression','WAHA','GOWS','PAUSED',$3)",[connectionId,tenantId,`secret://${tenantId}/connections/${connectionId}/waha`]);
 const inboxId=(await client.query("INSERT INTO event_inbox(tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,available_at) VALUES($1,$2,'WAHA',$3,'message.any','{}',$4,'FAILED_RETRYABLE',now()+interval '1 day') RETURNING id",[tenantId,connectionId,eventId,'a'.repeat(64)])).rows[0].id;
 const scoped=async(q,args)=>{await client.query('SET LOCAL ROLE '+quotedRole);try{return(await client.query(q,args)).rows}finally{await client.query('RESET ROLE')}};
 const registry={closed:true,entries:()=>[{kind:'inbound',eventId}]};
 const options={scoped,tenantId,connectionId,registry,originalUnknowns:[]};let restores=0;
 await assert.rejects(restoreObservedConfiguration({...options,checkpoint:async()=>{},restore:async()=>restores++}));assert.equal(restores,0);checks++;
 for(const status of ['PROCESSED','DUPLICATE','FAILED_TERMINAL','QUARANTINED']){
  await client.query('UPDATE event_inbox SET status=$2,processed_at=now(),lease_id=NULL,lease_expires_at=NULL WHERE id=$1',[inboxId,status]);
  const observed=await observeOwnedRestoration(options);assert.equal(observed.inbox[0].status,status);checks++;
 }
 checks+=(await verifyFutureConnectionOperations(client,options,observeOwnedRestoration)).passed;
 await restoreObservedConfiguration({...options,checkpoint:async()=>{},restore:async()=>restores++});assert.equal(restores,1);checks++;
 await assert.rejects(observeOwnedRestoration({...options,registry:{closed:true,entries:()=>[{kind:'inbound',eventId:'absent'}]}}));checks++;
 await assert.rejects(observeOwnedRestoration({...options,registry:{closed:true,entries:()=>[{kind:'native-action',articleId:1}]}}));checks++;
}finally{await client.query('ROLLBACK');const remaining=(await client.query('SELECT count(*)::int n FROM connections WHERE id=$1',[connectionId])).rows[0].n;assert.equal(remaining,0);}
return {passed:checks,failed:0,rollback:true};
}
