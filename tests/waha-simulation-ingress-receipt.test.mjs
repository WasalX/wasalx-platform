import test from 'node:test';import assert from 'node:assert/strict';import{createServer}from'node:http';import{createWahaSimulation}from'../scripts/contracts/waha-simulation-server.mjs';
test('ingress receipts retain only typed acknowledgement and preserve HTTP status without valid body',async()=>{
 const id='11111111-2222-4333-8444-555555555555';let body,type='application/json',hang=false;
 const receiver=createServer((req,res)=>{req.resume();res.writeHead(202,{'content-type':type});if(hang){res.flushHeaders();return;}res.end(body);});
 await new Promise(r=>receiver.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${receiver.address().port}/hook`;
 const server=createWahaSimulation({apiKey:'synthetic-key-long',session:'s',groupId:'123@g.us',phone:'12025550102',version:'2026.7.2',initialExists:false,webhookDestinations:[url]});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
 await fetch(`http://127.0.0.1:${server.address().port}/api/sessions`,{method:'POST',headers:{'x-api-key':'synthetic-key-long'},body:JSON.stringify({name:'s',config:{webhooks:[{url,events:['message'],hmac:{key:'synthetic-hmac-long'}}]}})});server.simulateState('WORKING');
 const input={eventId:'evt_01aaaaaaaaaaaaaaaaaaaaaaaa',messageId:'false_123@g.us_ABC',chatId:'123@g.us',participant:'12025550120@c.us',text:'synthetic'};
 for(const duplicate of [false,true]){body=JSON.stringify({accepted:true,duplicate,event_id:id,secret:'must-not-retain'});const result=(await server.emitInbound(input)).results[0];assert.deepEqual(result,{status:202,outcome:'http-response',receipt:{accepted:true,duplicate,event_id:id}});}
 for(const invalid of ['{','null',JSON.stringify({accepted:'true',duplicate:false,event_id:id}),JSON.stringify({accepted:true,duplicate:false,event_id:'bad'}),'x'.repeat(4097)]){body=invalid;assert.deepEqual((await server.emitInbound(input)).results[0],{status:202,outcome:'http-response'});}
 type='text/plain';body=JSON.stringify({accepted:true,duplicate:true,event_id:id});assert.equal((await server.emitInbound(input)).results[0].receipt,undefined);
 type='application/json';hang=true;assert.deepEqual((await server.emitInbound(input)).results[0],{status:202,outcome:'http-response'});
 }finally{server.closeAllConnections();receiver.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>receiver.close(r))]);}
});
