import test from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {createHmac} from 'node:crypto';import {readFileSync} from 'node:fs';
import {createWahaSimulation} from '../scripts/contracts/waha-simulation-server.mjs';
import {dispatchSimulationControl} from '../scripts/contracts/waha-simulation-control.mjs';
const contract=JSON.parse(readFileSync(new URL('./fixtures/waha/installed-contract.json',import.meta.url)));
test('five signed status events match installed shape; stable replay and nonworking send denial',async()=>{
 const received=[];const receiver=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);received.push({bytes:Buffer.concat(chunks),headers:req.headers});res.writeHead(202);res.end();});
 await new Promise(r=>receiver.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${receiver.address().port}/hook`;
 let clock=Date.parse('2026-09-11T12:00:00Z');
 const server=createWahaSimulation({apiKey:'synthetic-api-key',session:'wx_synthetic',groupId:'123@g.us',phone:'12025550103',version:'2026.7.2',initialExists:false,webhookDestinations:[url],now:()=>clock});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  assert.equal((await fetch(base+'/api/sessions',{method:'POST',headers:{'x-api-key':'synthetic-api-key'},body:JSON.stringify({name:'wx_synthetic',config:{webhooks:[{url,events:['session.status'],hmac:{key:'synthetic-status-hmac'}}]}})})).status,201);
  for(const [i,status] of ['STARTING','SCAN_QR_CODE','WORKING','STOPPED','FAILED'].entries()){
   const eventId=`evt_0${i}aaaaaaaaaaaaaaaaaaaaaaaa`;
   const command={action:'session-status',input:{eventId,status}};
   await dispatchSimulationControl(server,command);const first=received.at(-1);clock+=1000;
   await dispatchSimulationControl(server,command);assert(first.bytes.equals(received.at(-1).bytes));
   assert.equal(first.headers['x-webhook-hmac'],createHmac('sha512','synthetic-status-hmac').update(first.bytes).digest('hex'));
   const body=JSON.parse(first.bytes);for(const key of contract.schemas.WAHAWebhookSessionStatus.required)assert(Object.hasOwn(body,key));
   for(const key of contract.schemas.WASessionStatusBody.required)assert(Object.hasOwn(body.payload,key));
   assert.equal(body.payload.name,'wx_synthetic');assert.equal(body.payload.status,status);assert.equal(body.payload.statuses[0].timestamp,body.timestamp);
   assert.equal(body.me===null,status!=='WORKING');
   await verifyNormalizer(body,status,eventId);
   if(status!=='WORKING'){
    await assert.rejects(server.emitInbound({eventId:'evt_09aaaaaaaaaaaaaaaaaaaaaaaa',messageId:'x',chatId:'123@g.us',participant:'12025550106@c.us',text:'blocked'}));
    const response=await fetch(base+'/api/sendText',{method:'POST',headers:{'x-api-key':'synthetic-api-key'},body:JSON.stringify({session:'wx_synthetic',chatId:'123@g.us',text:'blocked'})});assert(response.status>=400);
   }
  }
 }finally{server.closeAllConnections();receiver.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>receiver.close(r))]);}
});
async function verifyNormalizer(body,status,eventId){
 const {InboundProcessor}=await import('../services/connector-worker/dist/services/connector-worker/src/inbound-processor.js');
 const observations=[];const event={id:'inbox',tenantId:'tenant',connectionId:'connection',provider:'waha',providerEventId:eventId,eventType:'session.status',attempts:1,payload:body};
 const repository={claim:async()=>[event],wahaIdentityContext:async()=>({opaqueSessionId:'wx_synthetic',wahaWorkerId:'worker',baseUrl:'http://waha-test.internal:3000',secretReference:'secret://waha-admin'}),applyProviderStatus:async(_e,o)=>{observations.push(o);return 'APPLIED';},complete:async(_e,_l,s)=>assert.equal(s,'PROCESSED'),fail:async()=>{throw Error('Actual worker rejected status fixture');}};
 const savedFetch=globalThis.fetch;try{if(status==='WORKING')globalThis.fetch=async()=>Response.json({id:'12025550103@c.us'});await new InboundProcessor(repository,{resolve:async()=>({apiKey:'synthetic-api-key'})}).drainTenant('tenant');}finally{globalThis.fetch=savedFetch;}
 assert.equal(observations[0].providerState,status);assert.equal(observations[0].opaqueSessionId,'wx_synthetic');assert.equal(observations[0].observedAt,new Date(body.timestamp).toISOString());
}
