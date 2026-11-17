import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createWahaSimulation} from '../scripts/contracts/waha-simulation-server.mjs';

const contract=JSON.parse(readFileSync(new URL('./fixtures/waha/installed-contract.json',import.meta.url)));

test('simulated text success matches the installed response status and required message fields',async()=>{
  const apiKey='synthetic-contract-check-key';
  const server=createWahaSimulation({apiKey,session:'contract',groupId:'123@g.us',phone:'12025550102',version:contract.providerVersion});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/sendText',{
      method:'POST',headers:{'x-api-key':apiKey,'content-type':'application/json'},
      body:JSON.stringify({session:'contract',chatId:'123@g.us',text:'synthetic contract message'}),
    });
    const responses=contract.paths['/api/sendText'].post.responses;
    assert(Object.hasOwn(responses,String(response.status)),'Status absent from installed success contract');
    const body=await response.json();
    for(const key of contract.schemas.WAMessage.required)assert(Object.hasOwn(body,key),'Missing installed message field: '+key);
    assert.equal(body.body,'synthetic contract message');
    assert.equal(body.to,'123@g.us');
    assert.equal(body.fromMe,true);
    assert.equal(body.hasMedia,false);
    assert.equal(typeof body.id,'string');
    assert.equal(typeof body.timestamp,'number');
  }finally{await new Promise(resolve=>server.close(resolve));}
});
