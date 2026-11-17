// Isolated simulated-provider scenario; not live qualification evidence.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {seedSyntheticGroup} from './seed-simulation-group.mjs';
import {callSimulationControl} from '../contracts/waha-simulation-control.mjs';

export function simulationEventId(runId) {
  const alphabet='0123456789abcdefghjkmnpqrstvwxyz';
  const digest=createHash('sha256').update(`first-group:${runId}`).digest();
  return 'evt_'+Array.from(digest.subarray(0,26),byte=>alphabet[byte&31]).join('');
}
export function assertTerminalInbox(rows) {
  assert.equal(rows.length,1,'Exactly one retained ingress identity required');
  assert.equal(rows[0].status,'PROCESSED');
  assert.equal(rows[0].lease_id,null);
  assert(rows[0].processed_at,'Durable terminal timestamp required');
}
export function assertIngressReceipts(emission, duplicate, inboxId) {
  assert.match(inboxId,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  assert(emission.results.length>0,'At least one ingress destination required');
  for(const result of emission.results) {
    assert(result.status>=200 && result.status<300);
    assert.deepEqual(result.receipt,{accepted:true,duplicate,event_id:inboxId});
  }
}

// API/native readback is supporting evidence, never a browser test PASS.
export function classifyNativeGroupProof(proof,{ticketId,marker}){
  if(proof==null)return 'blocked';
  assert.equal(proof.evidenceMode,'simulated');assert.equal(proof.surface,'browser');
  assert.equal(proof.authenticated,true);assert.equal(proof.visible,true);
  assert.equal(String(proof.ticketId),String(ticketId));assert.equal(proof.marker,marker);
  assert.deepEqual(proof.viewport,{width:1440,height:1000});
  assert(typeof proof.screenshotPath==='string'&&proof.screenshotPath.length>0);
  return 'passed';
}
