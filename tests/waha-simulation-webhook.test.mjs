import test from 'node:test';import assert from 'node:assert/strict';import{createServer}from'node:http';import{createHmac}from'node:crypto';import{createWahaSimulation}from'../scripts/contracts/waha-simulation-server.mjs';
test('raw HMAC, replay bytes, subscription ACK, isolated allowlist and delivery outcomes',{timeout:10000},async()=>{
 const received=[];let status=202,clock=1000;
 const receiver=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);received.push({bytes:Buffer.concat(chunks),headers:req.headers});res.writeHead(status);res.end();});
 await new Promise(r=>receiver.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+receiver.address().port+'/hook';
 const server=createWahaSimulation({apiKey:'synthetic-key-long',session:'s',groupId:'123@g.us',phone:'12025550102',version:'2026.7.2',initialExists:false,webhookDestinations:[url],now:()=>clock});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
 const created=await fetch(base+'/api/sessions',{method:'POST',headers:{'x-api-key':'synthetic-key-long'},body:JSON.stringify({name:'s',config:{metadata:{connectionId:'synthetic-connection'},webhooks:[{url,events:['message','message.ack.group'],hmac:{key:'synthetic-hmac-long'}}]}})});assert.equal(created.status,201);assert.equal((await created.json()).name,'s');server.simulateState('WORKING');
 const input={eventId:'evt_01aaaaaaaaaaaaaaaaaaaaaaaa',messageId:'false_123@g.us_ABC',chatId:'123@g.us',participant:'12025550120@c.us',text:'synthetic'};
 const first=await server.emitInbound(input);clock+=1000;const replay=await server.emitInbound(input);assert.equal(first.bodySha256,replay.bodySha256);assert(received[0].bytes.equals(received[1].bytes));assert.equal(received[0].headers['x-webhook-hmac'],createHmac('sha512','synthetic-hmac-long').update(received[0].bytes).digest('hex'));assert.equal(first.results[0].status,202);assert.equal(JSON.parse(received[0].bytes).metadata.connectionId,'synthetic-connection');
 status=503;assert.equal((await server.emitAck({...input,eventId:'evt_02aaaaaaaaaaaaaaaaaaaaaaaa',ack:3})).results[0].status,503);assert.equal(JSON.parse(received.at(-1).bytes).event,'message.ack.group');
 assert.equal(received.length,3);
 assert.throws(()=>createWahaSimulation({apiKey:'synthetic-key-long',session:'s',groupId:'123@g.us',phone:'12025550102',version:'x',webhookDestinations:['https://example.com/hook']}));
 }finally{receiver.closeAllConnections();server.closeAllConnections();await Promise.all([new Promise(r=>receiver.close(r)),new Promise(r=>server.close(r))]);}
});

test('webhook timeout aborts real transport after the receiver accepts one request',{timeout:10000},async()=>{
 let requests=0;
 const receiver=createServer(async(req)=>{for await(const chunk of req)assert(chunk.length>0);requests++;});
 await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${receiver.address().port}/hook`;
 const server=createWahaSimulation({apiKey:'synthetic-key-long',session:'s',groupId:'123@g.us',phone:'12025550102',version:'2026.7.2',initialExists:false,webhookDestinations:[url]});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const created=await fetch(`http://127.0.0.1:${server.address().port}/api/sessions`,{method:'POST',headers:{'x-api-key':'synthetic-key-long'},body:JSON.stringify({name:'s',config:{webhooks:[{url,events:['message.ack.group'],hmac:{key:'synthetic-hmac-long'}}]}})});assert.equal(created.status,201);assert.equal((await created.json()).name,'s');server.simulateState('WORKING');
  const result=await server.emitAck({eventId:'evt_03aaaaaaaaaaaaaaaaaaaaaaaa',messageId:'false_123@g.us_ABC',chatId:'123@g.us',participant:'12025550120@c.us',ack:2});
  assert.deepEqual(result.results,[{status:null,outcome:'timeout'}]);assert.equal(requests,1);
 }finally{server.closeAllConnections();receiver.closeAllConnections();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>receiver.close(resolve))]);}
});

test('isolated webhook mapping rejects external and malformed destinations before network access',async()=>{
 const originalFetch=globalThis.fetch,calls=[];
 const token='a'.repeat(32),good='https://simulation.invalid/webhooks/waha/'+token;
 try{
  for(const [url,enabled,accepted] of [[good,true,true],[good,false,false],['https://example.com/webhooks/waha/'+token,true,false],[good+'?redirect=x',true,false],[good+'#x',true,false],['https://user@simulation.invalid/webhooks/waha/'+token,true,false],['https://simulation.invalid/webhooks/waha/short',true,false]]){
   globalThis.fetch=originalFetch;
   const server=createWahaSimulation({apiKey:'synthetic-key-long',session:'s',groupId:'123@g.us',phone:'12025550102',version:'2026.7.2',initialExists:false,isolatedWebhookMapping:enabled});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));
   try{
    await originalFetch('http://127.0.0.1:'+server.address().port+'/api/sessions',{method:'POST',headers:{'x-api-key':'synthetic-key-long'},body:JSON.stringify({name:'s',config:{webhooks:[{url,events:['message'],hmac:{key:'synthetic-hmac-long'}}]}})});
    server.simulateState('WORKING');globalThis.fetch=async(destination)=>{calls.push(destination);return new Response(null,{status:202});};
    const input={eventId:'evt_01aaaaaaaaaaaaaaaaaaaaaaaa',messageId:'false_123@g.us_ABC',chatId:'123@g.us',participant:'12025550120@c.us',text:'synthetic'};
    const before=calls.length;
    if(accepted){assert.equal((await server.emitInbound(input)).results[0].status,202);assert.equal(calls.at(-1),'http://control-api:3001/webhooks/waha/'+token);}
    else{await assert.rejects(server.emitInbound(input));assert.equal(calls.length,before);}
   }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
  }
 }finally{globalThis.fetch=originalFetch;}
});

import{WahaAdapter}from'../services/connector-worker/dist/packages/connectors/src/waha.js';
test('quoted simulator inbound passes through the actual WahaAdapter and retains byte-exact signed replay',async()=>{
 const received=[];const receiver=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);received.push({bytes:Buffer.concat(chunks),headers:req.headers});res.writeHead(202);res.end();});await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+receiver.address().port+'/hook';const server=createWahaSimulation({apiKey:'synthetic-api-key',session:'fixture',groupId:'123@g.us',phone:'12025550103',version:'2026.7.2',initialExists:false,webhookDestinations:[url]});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port,adapter=new WahaAdapter({baseUrl:base,apiKey:'synthetic-api-key'});
 try{
  assert.equal((await fetch(base+'/api/sessions',{method:'POST',headers:{'x-api-key':'synthetic-api-key'},body:JSON.stringify({name:'fixture',config:{webhooks:[{url,events:['message'],hmac:{key:'synthetic-quote-hmac'}}]}})})).status,201);server.simulateState('WORKING');
  const input={eventId:'evt_01aaaaaaaaaaaaaaaaaaaaaaaa',messageId:'false_123@fixture-0039@example.test',chatId:'123@g.us',participant:'12025550106@c.us',text:'/close',quotedMessageId:'false_123@fixture-0040@example.test'};
  const first=await server.emitInbound(input);const normalized=await adapter.normalizeWebhook('connection-fixture',JSON.parse(received[0].bytes),new Headers(received[0].headers));assert(normalized);assert.equal(normalized.quotedMessageId,input.quotedMessageId);assert.equal(normalized.messageId,input.messageId);assert.equal(normalized.text,'/close');assert.equal(normalized.fromApi,false);
  const replay=await server.emitInbound(input);assert.equal(first.bodySha256,replay.bodySha256);assert(received[0].bytes.equals(received[1].bytes));assert.equal(received[0].headers['x-webhook-hmac'],createHmac('sha512','synthetic-quote-hmac').update(received[0].bytes).digest('hex'));
  const before=received.length;await assert.rejects(async()=>server.emitInbound({...input,quotedMessageId:'false_123@fixture-0041@example.test'}));for(const quotedMessageId of ['', 'bad\u0000quote', 'x'.repeat(513)])await assert.rejects(async()=>server.emitInbound({...input,eventId:'evt_02aaaaaaaaaaaaaaaaaaaaaaaa',quotedMessageId}));assert.equal(received.length,before);
 }finally{server.closeAllConnections();receiver.closeAllConnections();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>receiver.close(resolve))]);}
});
