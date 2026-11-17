import test from 'node:test';import assert from 'node:assert/strict';
import {createWahaSimulation} from '../scripts/contracts/waha-simulation-server.mjs';
test('provider simulation retains duplicate sends and unknown accepted outcomes',async()=>{
 const apiKey='synthetic-test-key-only',server=createWahaSimulation({apiKey,session:'s',groupId:'123@g.us',phone:'12025550102',version:'test',outcomes:['rate-limit','disconnect-before-acceptance','disconnect-after-acceptance','success']});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port,headers={'x-api-key':apiKey};
 const send=()=>fetch(base+'/api/sendText',{method:'POST',headers,body:JSON.stringify({session:'s',chatId:'123@g.us',text:'1234567890'})});
 try {
  assert.equal((await fetch(base+'/api/server/version')).status,401);
  assert.equal((await send()).status,429);await assert.rejects(send);await assert.rejects(send);assert.equal((await send()).status,201);
  const receipt=await(await fetch(base+'/__simulation/receipts',{headers})).json();assert.equal(receipt.receipts.length,2);assert.equal(receipt.receipts[0].textSha256,receipt.receipts[1].textSha256);assert(!JSON.stringify(receipt).includes('1234567890'));
  assert.equal((await fetch(base+'/api/unimplemented',{headers})).status,404);
 }finally{await new Promise(r=>server.close(r));}
});

test('provider simulation emits the installed WAHA session-conflict contract',async()=>{
 const apiKey='synthetic-conflict-key',session='owned-session',server=createWahaSimulation({apiKey,session,groupId:'123@g.us',phone:'12025550102',version:'test'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{const response=await fetch(base+'/api/sessions',{method:'POST',headers:{'x-api-key':apiKey,'content-type':'application/json'},body:JSON.stringify({name:session})});assert.equal(response.status,422);assert.deepEqual(await response.json(),{statusCode:422,message:'Session already exists',error:'Unprocessable Entity'});}
 finally{await new Promise(resolve=>server.close(resolve));}
});
