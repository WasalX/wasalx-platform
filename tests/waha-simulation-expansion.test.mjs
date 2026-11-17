// Independent HTTP contract shape checks; no WasalX adapter imports.
// Sources: https://waha.devlike.pro/docs/how-to/sessions/ and /docs/how-to/chats/
// Read 2026-09-11. Version-specific conformance remains pending pinned swagger review.
import test from 'node:test';import assert from 'node:assert/strict';
import {createWahaSimulation} from '../scripts/contracts/waha-simulation-server.mjs';
test('encoded session routes and chat pagination reject mismatched targets',async()=>{
 const apiKey='synthetic-key-for-routing',session='tenant/session one';
 const server=createWahaSimulation({apiKey,session,groupId:'123@g.us',phone:'12025550102',version:'test'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const get=path=>fetch(base+path,{headers:{'x-api-key':apiKey}});
 try {
  const encoded=encodeURIComponent(session);
  assert.equal((await (await get('/api/sessions/'+encoded)).json()).name,session);
  assert.equal((await get('/api/sessions/other')).status,404);
  const messages='/api/'+encoded+'/chats/'+encodeURIComponent('123@g.us')+'/messages';
  assert.deepEqual(await (await get(messages)).json(),[]);
  for(const query of ['?offset=-1','?limit=101','?limit=NaN'])assert.equal((await get(messages+query)).status,400);
  assert.equal((await get('/api/'+encoded+'/chats/'+encodeURIComponent('999@g.us')+'/messages')).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('lifecycle states fence sends; group/direct history isolates chats; disconnect records reception only',async()=>{
 const apiKey='simulation-key-long-enough',server=createWahaSimulation({apiKey,session:'s',groupId:'123@g.us',phone:'12025550102',version:'test',initialState:'STOPPED',directChatIds:['12025550120@c.us'],outcomes:['disconnect-before-acceptance','success','success']});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port,headers={'x-api-key':apiKey};
 const request=(p,body)=>fetch(base+p,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});
 const send=chatId=>request('/api/sendText',{session:'s',chatId,text:'synthetic body'});
 try{
 assert.equal((await send('123@g.us')).status,409);
 assert.equal((await(await request('/api/sessions/s/start',{})).json()).status,'STARTING');
 for(const state of ['SCAN_QR_CODE','FAILED']){server.simulateState(state);assert.equal((await(await request('/api/sessions/s')).json()).status,state);assert.equal((await send('123@g.us')).status,409);}
 server.simulateState('WORKING');await assert.rejects(()=>send('123@g.us'));
 let receipt=await(await request('/__simulation/receipts')).json();assert.equal(receipt.receivedSends,1);assert.equal(receipt.receipts.length,0);
 assert.equal((await send('123@g.us')).status,201);assert.equal((await send('12025550120@c.us')).status,201);
 for(const chat of ['123@g.us','12025550120@c.us']){const history=await(await request('/api/s/chats/'+encodeURIComponent(chat)+'/messages')).json();assert.equal(history.length,1);assert.equal(history[0].to,chat);assert.equal(history[0].source,'api');}
 assert.equal((await send('12025550121@c.us')).status,400);
 assert.equal((await request('/api/sessions/s/logout',{})).status,201);
 assert.equal((await(await request('/api/sessions/s/stop',{})).json()).status,'STOPPED');
 assert.throws(()=>server.simulateState('BOGUS'));
 }finally{await new Promise(r=>server.close(r));}
});
