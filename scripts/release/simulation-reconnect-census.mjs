import assert from 'node:assert/strict';
// STAGED is reserved work (migration0111), not safe quiescence. Retained/expired leases also fence changes.
export const pendingConnectionOperationPredicate="(state IN ('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE') OR lease_id IS NOT NULL OR lease_expires_at IS NOT NULL)";
export function assertReconnectCensus(before,after){
 for(const sample of [before,after]){assert.equal(sample.sessions.length,1,'Exactly one ACTIVE session');assert.equal(sample.worker.assignedSessions,1,'Exactly one spare assignment');assert.equal(sample.worker.healthState,'HEALTHY');assert.equal(sample.consumerIds.length,1,'Exactly one owned connector consumer container');assert.equal(sample.pendingOperations,0);}
 assert.deepEqual(after.sessions,before.sessions,'Restart preserves connection/session/worker identity');assert.deepEqual(after.consumerIds,before.consumerIds,'No replacement or duplicate consumer');assert.deepEqual(after.originalAssignments,before.originalAssignments,'Other connections unchanged');return true;
}
export async function readReconnectCensus({connectionId,scoped,platform,run,project,originalAssignments}){
 const sessions=await scoped("SELECT id,connection_id,opaque_session_id,waha_worker_id FROM provider_sessions WHERE connection_id=$1 AND ownership_state='ACTIVE' ORDER BY id",[connectionId]);
 const worker=(await platform.request('/platform/v1/waha-workers','GET')).find(w=>w.workerKey==='simulation-lifecycle-gows');
 const consumerIds=(await run('docker',['ps','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service=connector-worker','--format','{{.ID}}'])).trim().split(/\s+/).filter(Boolean).sort();
 const [ops]=await scoped(`SELECT count(*) AS count FROM connection_operations WHERE connection_id=$1 AND ${pendingConnectionOperationPredicate}`,[connectionId]);
 return{at:new Date().toISOString(),sessions,worker:{healthState:worker?.healthState,assignedSessions:worker?.assignedSessions},consumerIds,pendingOperations:Number(ops.count),originalAssignments};
}
