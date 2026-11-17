import test from 'node:test';
import assert from 'node:assert/strict';
import {readReconnectCensus,assertReconnectCensus,pendingConnectionOperationPredicate} from '../scripts/release/simulation-reconnect-census.mjs';
test('census fences every nonterminal operation and retained leases',async()=>{
 const states=[...pendingConnectionOperationPredicate.matchAll(/'([A-Z_]+)'/g)].map(x=>x[1]);assert.deepEqual(states,['STAGED','QUEUED','RUNNING','FAILED_RETRYABLE']);assert.match(pendingConnectionOperationPredicate,/lease_id IS NOT NULL/);assert.match(pendingConnectionOperationPredicate,/lease_expires_at IS NOT NULL/);
 for(const row of [{state:'STAGED'},{state:'QUEUED'},{state:'RUNNING'},{state:'FAILED_RETRYABLE'},{state:'SUCCEEDED',leaseId:'retained'},{state:'CANCELLED',leaseExpiresAt:'2000-01-01'}]){
  let query;const sample=await readReconnectCensus({connectionId:'current',scoped:async sql=>{if(sql.includes('provider_sessions'))return[{id:'s'}];query=sql;return[{count:states.includes(row.state)||row.leaseId||row.leaseExpiresAt?1:0}];},platform:{request:async()=>[{workerKey:'simulation-lifecycle-gows',healthState:'HEALTHY',assignedSessions:1}]},run:async()=> 'consumer',project:'isolated',originalAssignments:[]});assert(query.includes(pendingConnectionOperationPredicate));assert.equal(sample.pendingOperations,1);assert.throws(()=>assertReconnectCensus(sample,sample));
 }
});
test('settled operation without retained lease permits identical reconnect census',()=>{const sample={sessions:[{id:'s'}],worker:{healthState:'HEALTHY',assignedSessions:1},consumerIds:['one'],pendingOperations:0,originalAssignments:[]};assert.equal(assertReconnectCensus(sample,structuredClone(sample)),true);});

import {observeLifecycleOperationResult} from '../scripts/release/simulation-lifecycle-operation-result.mjs';
test('operation display rejects durable mismatch before observing UI',async()=>{
 let ui=false;const detail={latest_operation_id:'o',latest_operation_type:'DISCONNECT',latest_operation_state:'SUCCEEDED',latest_operation_attempts:1};
 await assert.rejects(observeLifecycleOperationResult({connectionId:'c',read:async()=>detail,scoped:async()=>[{id:'o',connection_id:'c',operation_type:'DISCONNECT',state:'RUNNING',attempts:1}],page:{locator:()=>{ui=true;}}}));assert.equal(ui,false);
});
