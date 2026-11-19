import assert from 'node:assert/strict';
export function assertBootstrapIdle(census,worker){
 for(const key of ['connections','sessions','operations','effects','leases'])assert.equal(Number(census[key]),0,'Fresh bootstrap requires zero '+key);
 assert.equal(worker.workerKey,'simulation-lifecycle-gows');assert.equal(worker.engine,'GOWS');assert.equal(worker.assignedSessions,0);assert.equal(worker.lifecycleState,'ACTIVE');assert.equal(worker.rolloutMode,'STABLE');assert.equal(worker.healthState,'HEALTHY');
}
export async function disableFreshSpare({request,census,audit,operatorSubject,checkpoint}){
 const workers=await request('waha-workers'),worker=workers.find(w=>w.workerKey==='simulation-lifecycle-gows');assert(worker);
 assertBootstrapIdle(await census(),worker);const before=await audit(worker.workerKey,worker.version);assert.deepEqual(before.assignments,[]);assert.deepEqual(before.modeEvents,[]);
 const reason='Fresh isolated lifecycle spare initialization';
 await checkpoint({phase:'lifecycle-bootstrap-disable-intent',workerKey:worker.workerKey,version:worker.version});
 await request('waha-workers/'+worker.workerKey+'/mode','PATCH',{version:worker.version,lifecycleState:'DISABLED',rolloutMode:'STABLE',reason});
 const after=(await request('waha-workers')).find(w=>w.workerKey===worker.workerKey);assert.equal(after.lifecycleState,'DISABLED');assert.equal(after.assignedSessions,0);
 const proof=await audit(worker.workerKey,worker.version);assert.equal(proof.configurationDigest,before.configurationDigest);assert.deepEqual(proof.assignments,[]);assert.equal(proof.modeEvents.length,1);assert.equal(proof.modeEvents[0].actorId,operatorSubject);assert.equal(proof.modeEvents[0].reason,reason);assert.equal(proof.modeEvents[0].lifecycleState,'DISABLED');
 const settled=await census();for(const value of Object.values(settled))assert.equal(Number(value),0);
 const result={evidenceMode:'simulated',workerKey:worker.workerKey,lifecycleState:'DISABLED',version:after.version,auditEventId:proof.modeEvents[0].id,configurationDigest:proof.configurationDigest};await checkpoint({phase:'lifecycle-bootstrap-disabled',...result});return result;
}
