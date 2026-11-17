import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createWahaSimulation} from '../scripts/contracts/waha-simulation-server.mjs';
const contract=JSON.parse(readFileSync('tests/fixtures/waha/installed-contract.json','utf8'));
// Bounded primitive checks for these retained DTOs, not a general schema validator.
function fields(name,value){
 const schema=contract.schemas[name];
 for(const key of schema.required){
  assert(Object.hasOwn(value,key),`${name}.${key} missing`);
  const property=schema.properties[key];
  if(['string','number','boolean'].includes(property.type))assert.equal(typeof value[key],property.type,`${name}.${key} type`);
  if(property.enum)assert(property.enum.includes(value[key]),`${name}.${key} enum`);
 }
}
async function fixture(run){
 let clock=1000;const key='synthetic-independent-contract-key',qr=readFileSync('tests/fixtures/waha/synthetic-qr.png');
 const server=createWahaSimulation({apiKey:key,session:'contract',groupId:'123@g.us',directChatIds:['12025550129@c.us'],phone:'12025550102',version:contract.providerVersion,qrFixtures:[qr],now:()=>clock});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const request=(path,method='GET',body)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'x-api-key':key,'content-type':'application/json',accept:'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 try{await run({server,request,qr,setClock:value=>{clock=value;}});}finally{await new Promise(resolve=>server.close(resolve));}
}
test('pinned primitive and enum checks reject corrupt required fields',()=>{
 assert.throws(()=>fields('SessionDTO',{name:1,status:'WORKING'}));
 assert.throws(()=>fields('SessionDTO',{name:'x',status:'INVENTED'}));
 assert.throws(()=>fields('Base64File',{mimetype:'image/png',data:null}));
});
test('group and direct text have pinned field types/enums and distinct participant/history identities',()=>fixture(async({request})=>{
 const ids=[];
 for(const chat of ['123@g.us','12025550129@c.us']){
  const response=await request('/api/sendText','POST',{session:'contract',chatId:chat,text:'contract '+chat});
  assert.equal(response.status,201);assert(Object.hasOwn(contract.paths['/api/sendText'].post.responses,'201'));
  const message=await response.json();fields('WAMessage',message);ids.push(message.id);
  assert.equal(message.to,chat);assert.equal(message.from,'12025550102@c.us');assert.equal(message.participant,chat.endsWith('@g.us')?'12025550102@c.us':'');
  assert.equal(message.source,'api');assert.equal(message.fromMe,true);assert.equal(message.body,'contract '+chat);assert.equal(message.timestamp,1);assert.equal(message.hasMedia,false);assert.equal(message.mediaUrl,'');assert.equal(message.ack,0);assert.equal(message.ackName,'PENDING');
  assert(message.id.startsWith('true_'+chat+'_'));
  const history=await(await request('/api/contract/chats/'+encodeURIComponent(chat)+'/messages')).json();assert.equal(history.length,1);assert.equal(history[0].id,message.id);
 }
 assert.notEqual(ids[0],ids[1]);
}));
test('finite QR expiry and explicit restart/delete retain honest lifecycle boundaries',()=>fixture(async({server,request,qr,setClock})=>{
 server.simulateState('SCAN_QR_CODE');
 const path='/api/contract/auth/qr?format=image';
 const value=await(await request(path)).json();fields('Base64File',value);assert.equal(value.mimetype,'image/png');assert.deepEqual(Buffer.from(value.data,'base64'),qr);
 setClock(60999);assert.equal((await request(path)).status,200);
 setClock(61000);assert.equal((await request(path)).status,409); // simulator policy; errors are not pinned by installed schema
 let dto=await(await request('/api/sessions/contract')).json();fields('SessionDTO',dto);assert.equal(dto.status,'FAILED');
 const restarted=await request('/api/sessions/contract/restart','POST',{});assert.equal(restarted.status,201);dto=await restarted.json();fields('SessionDTO',dto);assert.equal(dto.status,'STARTING');
 assert.equal((await request(path)).status,409); // restart is not implicit successful pairing
 assert.equal((await request('/api/sessions/contract','DELETE')).status,200);
 assert.equal((await request('/api/sessions/contract')).status,404);
 assert.equal((await request('/api/sendText','POST',{session:'contract',chatId:'123@g.us',text:'deleted'})).status,404);
}));
