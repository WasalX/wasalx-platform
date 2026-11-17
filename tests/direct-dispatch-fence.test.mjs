import assert from 'node:assert/strict';import test from 'node:test';
import {createDirectDispatchFence} from '../scripts/release/direct-dispatch-fence.mjs';
test('durable registration precedes network; same-byte replay retains one registered event',async()=>{
 const seen=[];const fence=createDirectDispatchFence({checkpoint:async e=>seen.push(e.phase),control:async()=>{assert.equal(seen[0],'owned-ingress-registered');seen.push('network');},observe:async r=>{assert(r.closed);return r.entries();}});
 const c={action:'inbound',input:{eventId:'e',text:'x'}};await fence.control(c);await fence.control(c);assert.equal((await fence.drain()).length,1);
 await assert.rejects(fence.control({action:'inbound',input:{eventId:'e',text:'changed'}}),/Changed replay/);
});
test('drain fences concurrent submission and submission fences observation',async()=>{
 let release;const wait=new Promise(r=>release=r);const fence=createDirectDispatchFence({checkpoint:async()=>{},control:async()=>wait,observe:async()=>wait});
 const pending=fence.control({action:'inbound',input:{eventId:'e'}});await assert.rejects(fence.drain(),/active/);release();await pending;
 let finish;const second=createDirectDispatchFence({checkpoint:async()=>{},control:async()=>assert.fail(),observe:async()=>new Promise(r=>finish=r)});
 const observing=second.drain();await new Promise(r=>setImmediate(r));await assert.rejects(second.control({action:'inbound',input:{eventId:'f'}}),/active/);finish();await observing;
});
test('ambiguous transport keeps registered event for reconciliation',async()=>{
 const fence=createDirectDispatchFence({checkpoint:async()=>{},control:async()=>{throw Error('timeout');},observe:async r=>r.entries()});
 await assert.rejects(fence.control({action:'inbound',input:{eventId:'uncertain'}}),/timeout/);assert.deepEqual(await fence.drain(),[{kind:'inbound',eventId:'uncertain'}]);
});

test('failed settlement permits one fresh readback but never another wait or dispatch',async()=>{
 const primary=Error('deadline'),modes=[];const fence=createDirectDispatchFence({checkpoint:async()=>{},control:async()=>assert.fail('no dispatch'),observe:async(_registry,{readbackOnly})=>{modes.push(readbackOnly);if(!readbackOnly)throw primary;return{settled:true};}});
 await assert.rejects(fence.drain(),e=>e===primary);
 await assert.rejects(fence.drain(),e=>e===primary);
 await assert.rejects(fence.drain(),e=>e===primary);
 await assert.rejects(fence.control({action:'inbound',input:{eventId:'x'}}),/requires reconciliation/);
 assert.deepEqual(modes,[false,true]);
});

test('failed fresh readback preserves primary and reconciliation failure',async()=>{
 const primary=Error('deadline'),unknown=Error('unknown'),modes=[];
 const fence=createDirectDispatchFence({checkpoint:async()=>{},control:async()=>assert.fail(),observe:async(_r,{readbackOnly})=>{modes.push(readbackOnly);throw readbackOnly?unknown:primary;}});
 await assert.rejects(fence.drain(),e=>e===primary);
 await assert.rejects(fence.drain(),e=>e instanceof AggregateError&&e.errors[0]===primary&&e.errors[1]===unknown);
 await assert.rejects(fence.drain(),e=>e===primary);assert.deepEqual(modes,[false,true]);
});

import{createOwnedIntentRegistry}from'../scripts/release/owned-intent-registry.mjs';
test('shared reprocess registry records exact accepted UUID, rejects duplicates and closes before observation',async()=>{
 const checkpoints=[],id='11111111-2222-4333-8444-555555555555',registry=createOwnedIntentRegistry(async row=>checkpoints.push(row));
 await registry.register({kind:'inbound',eventId:'original'});await registry.register({kind:'reprocess',inboxId:id});
 assert.equal(checkpoints[1].phase,'owned-reprocess-registered');assert.deepEqual(registry.entries(),[{kind:'inbound',eventId:'original'},{kind:'reprocess',inboxId:id}]);
 await assert.rejects(()=>registry.register({kind:'reprocess',inboxId:id}),/Duplicate/);
 for(const entry of[{kind:'reprocess',inboxId:'review-or-provider-event'},{kind:'reprocess'},{kind:'native-action',inboxId:id}])await assert.rejects(()=>registry.register(entry));
 registry.close();assert.equal(registry.closed,true);await assert.rejects(()=>registry.register({kind:'reprocess',inboxId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'}),/closed/);
});
