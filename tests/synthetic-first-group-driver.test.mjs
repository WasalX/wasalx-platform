import test from 'node:test';
import assert from 'node:assert/strict';
import {simulationEventId,assertTerminalInbox,assertIngressReceipts,classifyNativeGroupProof} from '../scripts/release/synthetic-first-group-driver.mjs';
test('event IDs satisfy installed simulator Crockford contract deterministically',()=>{
  for(const run of ['first','a-b_12','20260911']) assert.match(simulationEventId(run),/^evt_[0-9a-hjkmnp-tv-z]{26}$/);
  assert.equal(simulationEventId('first'),simulationEventId('first'));
  assert.notEqual(simulationEventId('first'),simulationEventId('second'));
});
test('terminal evidence rejects queued, leased, absent and multiple ingress rows',()=>{
  const terminal={id:'inbox',status:'PROCESSED',lease_id:null,processed_at:'2026-09-11T00:00:00Z'};
  assert.doesNotThrow(()=>assertTerminalInbox([terminal]));
  for(const rows of [[],[terminal,terminal],[{...terminal,status:'QUEUED'}],[{...terminal,lease_id:'lease'}],[{...terminal,processed_at:null}]]) assert.throws(()=>assertTerminalInbox(rows));
});
test('ingress first/replay receipts must bind the durable inbox and duplicate outcome',()=>{
  const id='10100000-0000-4000-8000-000000000001';
  const receipt=duplicate=>({results:[{status:200,receipt:{accepted:true,duplicate,event_id:id}}]});
  assert.doesNotThrow(()=>assertIngressReceipts(receipt(false),false,id));
  assert.doesNotThrow(()=>assertIngressReceipts(receipt(true),true,id));
  assert.throws(()=>assertIngressReceipts(receipt(false),true,id));
  assert.throws(()=>assertIngressReceipts(receipt(true),false,id));
  assert.throws(()=>assertIngressReceipts(receipt(true),true,'10100000-0000-4000-8000-000000000002'));
  assert.throws(()=>assertIngressReceipts({results:[{status:200}]},true,id));
  assert.throws(()=>assertIngressReceipts({results:[]},true,id));
});

test('native API proof never substitutes for actual authenticated browser proof',()=>{
 const expected={ticketId:12,marker:'Synthetic admitted marker'};
 assert.equal(classifyNativeGroupProof(null,expected),'blocked');
 const proof={evidenceMode:'simulated',surface:'browser',authenticated:true,visible:true,...expected,viewport:{width:1440,height:1000},screenshotPath:'/owned/proof.png'};
 assert.equal(classifyNativeGroupProof(proof,expected),'passed');
 for(const changed of [{surface:'api'},{authenticated:false},{visible:false},{ticketId:13},{marker:'other'},{viewport:{width:390,height:844}},{screenshotPath:''}])assert.throws(()=>classifyNativeGroupProof({...proof,...changed},expected));
});
