import assert from 'node:assert/strict';
import {restorationVersion} from './simulation-worker-restoration-policy.mjs';
// Inject the existing authenticated platform request, durable checkpoint and readonly census.
// No private provider controls are run until ordinary acquisition has selected the sole eligible worker.
export async function withLifecycleWorkerGuard({workerKey,request,census,checkpoint,scenario,audit,runId,operatorSubject}) {
 assert.match(runId,/^[a-z0-9-]{3,60}$/);assert(operatorSubject&&typeof audit==='function','Audited restoration prerequisites required');
 const reason='Owned isolated lifecycle guard '+runId;
 const list=()=>request('/platform/v1/waha-workers','GET');
 const mode=(w,state,version)=>({version,lifecycleState:state,rolloutMode:w.rolloutMode,...(w.rolloutMode==='CANARY'?{canarySessionLimit:w.canarySessionLimit}:{}),reason});
 const clean=async()=>{const c=await census();assert.equal(c.activeLeases,0);assert.equal(c.pendingEffects,0);assert.equal(c.pendingConnectionOperations,0);assert.equal(c.lanesPaused,true);return c;};
 const original=await list(), target=original.find(w=>w.workerKey===workerKey);assert(target&&target.engine==='GOWS'&&target.lifecycleState==='ACTIVE'&&target.healthState==='HEALTHY'&&target.assignedSessions===0&&target.capacity===1);
 const old=original.filter(w=>w.engine==='GOWS'&&w.workerKey!==workerKey&&w.lifecycleState==='ACTIVE');
 const pre=await clean();await checkpoint({phase:'worker-guard-preimage',workers:original,census:pre});
 const changed=[];let result,failure;
 const preimages=new Map();for(const w of old){const a=await audit(w.workerKey,w.version);assert.match(a.configurationDigest,/^[a-f0-9]{64}$/);assert(Array.isArray(a.assignments));assert(a.version>=w.version);assert.equal(a.modeEvents.length,0,'Policy changed during preimage');preimages.set(w.workerKey,a);await checkpoint({phase:'worker-private-preimage',workerKey:w.workerKey,version:w.version,...a});}
 const ownedEvent=(events,w,state)=>{assert.equal(events.length,1,'Foreign or ABA mode action');const e=events[0];assert.equal(e.actorId,operatorSubject);assert.equal(e.actorType,'PLATFORM_OPERATOR');assert.equal(e.reason,reason);assert.equal(e.workerKey,w.workerKey);assert.equal(e.lifecycleState,state);assert.equal(e.rolloutMode,w.rolloutMode);assert.equal(e.canarySessionLimit??null,w.canarySessionLimit??null);return e;};
 try {
  for(const w of old){
   await checkpoint({phase:'worker-drain-intent',workerKey:w.workerKey,version:w.version});
   // Register intent before request so an uncertain response is reconciled in finally.
   changed.push(w);
   await request('/platform/v1/waha-workers/'+encodeURIComponent(w.workerKey)+'/mode','PATCH',mode(w,'DRAINING',w.version));
   const receipt=ownedEvent((await audit(w.workerKey,w.version)).modeEvents,w,'DRAINING');await checkpoint({phase:'worker-drained',receipt});
  }
  const guarded=await list();assert.deepEqual(guarded.filter(w=>w.engine==='GOWS'&&w.lifecycleState==='ACTIVE').map(w=>w.workerKey),[workerKey]);
  await clean();await checkpoint({phase:'worker-selection-admitted',workerKey});
  result=await scenario({workerKey,assertAssignment:actual=>assert.equal(actual,workerKey)});
 } catch(e){failure=e;const status=String(e?.name==='AssertionError'?e.actual??'':e?.message??'').match(/: HTTP (\d{3});/);try{await checkpoint({phase:'lifecycle-guard-failure',diagnostic:{name:['Error','AssertionError','TimeoutError'].includes(e?.name)?e.name:'Error',httpStatus:status?Number(status[1]):null}});}catch(recordError){failure=new AggregateError([e,recordError],'Failure receipt unavailable; restore still required');}}
 const restoreErrors=[];
 for(const w of changed.reverse())try{
  const current=(await list()).find(x=>x.workerKey===w.workerKey);assert(current,'Original worker missing');
  const before=preimages.get(w.workerKey),now=await audit(w.workerKey,w.version);
  // Current version must match the same audit snapshot; telemetry racing this read fails closed.
  assert.equal(now.version,current.version,'Worker advanced during restoration read');
  const ownedDrain=now.modeEvents.length?ownedEvent(now.modeEvents,w,'DRAINING'):undefined;
  const version=restorationVersion({before:w,current,configurationBefore:before.configurationDigest,configurationCurrent:now.configurationDigest,assignmentsBefore:before.assignments,assignmentsCurrent:now.assignments,modeEvents:now.modeEvents,ownedDrain});
  if(version===null)continue;
  await checkpoint({phase:'worker-restore-intent',workerKey:w.workerKey,version,ownedDrain});
  await request('/platform/v1/waha-workers/'+encodeURIComponent(w.workerKey)+'/mode','PATCH',mode(w,w.lifecycleState,version));
  const restored=(await list()).find(x=>x.workerKey===w.workerKey);assert.equal(restored.lifecycleState,w.lifecycleState);
  const after=await audit(w.workerKey,version);const receipt=ownedEvent(after.modeEvents,w,w.lifecycleState);
  assert.equal(after.configurationDigest,before.configurationDigest);assert.deepEqual(after.assignments,before.assignments);
  await checkpoint({phase:'worker-restored',workerKey:w.workerKey,receipt});
 }catch(e){restoreErrors.push(e);try{await checkpoint({phase:'worker-restoration-blocked',workerKey:w.workerKey,category:e?.name==='AssertionError'?'audit-or-configuration-drift':'request-or-readback-uncertain'});}catch(recordError){restoreErrors.push(recordError);}}
 const post=await census();assert.deepEqual(post.originalAssignments,pre.originalAssignments);await checkpoint({phase:'worker-guard-finished',restorationFailures:restoreErrors.length});
 if(failure||restoreErrors.length)throw new AggregateError([...(failure?[failure]:[]),...restoreErrors],'Lifecycle guard requires reconciliation; no automatic action replay');
 return result;
}
