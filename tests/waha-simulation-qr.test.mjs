import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
import{createWahaSimulation}from'../scripts/contracts/waha-simulation-server.mjs';
test('installed QR/session response shapes with synthetic offline QR and owned dynamic session',async()=>{
 const qr=readFileSync('tests/fixtures/waha/synthetic-qr.png');let clock=1000;
 const server=createWahaSimulation({apiKey:'synthetic-api-key-long',session:'unused',groupId:'123@g.us',phone:'12025550102',version:'2026.7.2',initialExists:false,qrFixtures:[qr],now:()=>clock});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port,headers={'x-api-key':'synthetic-api-key-long',accept:'application/json'};
 const request=(path,method='GET',body)=>fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
 const path='/api/sessions/'+encodeURIComponent('wx_dynamic/session one');
 try{
 const created=await request('/api/sessions','POST',{name:'wx_dynamic/session one',start:false,config:{metadata:{purpose:'synthetic'}}});assert.equal(created.status,201);assert.equal((await created.json()).status,'STOPPED');
 for(const action of ['start','restart'])assert.equal((await request(path+'/'+action,'POST',{})).status,201);
 server.simulateState('SCAN_QR_CODE');const qrPath='/api/'+encodeURIComponent('wx_dynamic/session one')+'/auth/qr?format=image';
 const value=await(await request(qrPath)).json();assert.deepEqual(value,{mimetype:'image/png',data:qr.toString('base64')});
 clock+=60000;assert.equal((await request(qrPath)).status,409);assert.equal((await(await request(path)).json()).status,'FAILED');
 server.simulateState('WORKING');assert.equal((await request(qrPath)).status,409);
 const sent=await request('/api/sendText','POST',{session:'wx_dynamic/session one',chatId:'123@g.us',text:'Synthetic message'});assert.equal(sent.status,201);
 const message=await sent.json();
 for(const key of ['id','timestamp','from','fromMe','source','to','participant','body','hasMedia','mediaUrl','ack','ackName'])assert(Object.hasOwn(message,key));
 assert.equal(message.fromMe,true);assert.equal(message.source,'api');assert.equal(message.to,'123@g.us');assert.equal(message.participant,'12025550102@c.us');assert.equal(message.body,'Synthetic message');assert.equal(message.hasMedia,false);assert.equal(message.ack,0);assert.equal(message.ackName,'PENDING');assert.match(message.id,/^true_123@g\.us_[A-F0-9]{20}$/);
 assert.equal((await request(path+'/stop','POST',{})).status,201);assert.equal((await request(path+'/logout','POST',{})).status,201);
 assert.equal((await request(path,'DELETE')).status,200);assert.equal((await request(path)).status,404);
 }finally{await new Promise(r=>server.close(r));}
});
