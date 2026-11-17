import test from 'node:test';
import assert from 'node:assert/strict';
import {createWahaSimulation} from '../scripts/contracts/waha-simulation-server.mjs';
import {WahaAdapter} from '../services/connector-worker/dist/packages/connectors/src/waha.js';

// Interoperability evidence only; installed-contract tests validate the simulator separately.
test('actual WAHA adapter sends group and direct text through the simulator HTTP boundary',async()=>{
 const apiKey='synthetic-adapter-test-key',groupId='123@g.us',direct='12025550120@c.us';
 const server=createWahaSimulation({apiKey,session:'adapter-test',groupId,phone:'12025550102',version:'2026.7.2',directChatIds:[direct]});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const baseUrl='http://127.0.0.1:'+server.address().port;
 const adapter=new WahaAdapter({baseUrl,apiKey,sessionFor:()=> 'adapter-test'});
 try {
  const ids=[];
  for(const [target,recipientType] of [[groupId,'GROUP'],[direct,'DIRECT']]){
   const result=await adapter.send({connectionId:'synthetic-connection',groupId:target,recipientType,text:'synthetic message',idempotencyKey:'synthetic-'+recipientType});
   assert.equal(result.state,'SENT');ids.push(result.externalMessageId);
  }
  assert.notEqual(ids[0],ids[1]);
  const receipt=await(await fetch(baseUrl+'/__simulation/receipts',{headers:{'x-api-key':apiKey}})).json();
  assert.deepEqual(receipt.receipts.map(r=>r.id),ids);
  assert.equal(receipt.receivedSends,2);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
