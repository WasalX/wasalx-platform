import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {createHmac} from 'node:crypto';import {readFileSync} from 'node:fs';
import {createWahaSimulation} from '../scripts/contracts/waha-simulation-server.mjs';
import {WahaAdapter} from '../services/connector-worker/dist/packages/connectors/src/waha.js';
const contract=JSON.parse(readFileSync(new URL('./fixtures/waha/mutation-contract-subset.json',import.meta.url)));
test('installed mutation shapes normalize; signed HTTP replay is byte exact; invalid and stopped events fail closed',async()=>{
 const received=[];const receiver=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);received.push({bytes:Buffer.concat(chunks),headers:req.headers});res.writeHead(202);res.end();});
 await new Promise(r=>receiver.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${receiver.address().port}/hook`;let clock=1789128000000;
 const server=createWahaSimulation({apiKey:'synthetic-api-key',session:'wx_synthetic',groupId:'123@g.us',phone:'12025550103',version:'2026.7.2',initialExists:false,webhookDestinations:[url],now:()=>clock});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;const adapter=new WahaAdapter({baseUrl:base,apiKey:'synthetic-api-key'});
 const common={chatId:'123@g.us',participant:'12025550106@c.us',targetMessageId:'false_123@g.us_TARGET'};
 try{
 assert.equal((await fetch(base+'/api/sessions',{method:'POST',headers:{'x-api-key':'synthetic-api-key'},body:JSON.stringify({name:'wx_synthetic',config:{webhooks:[{url,events:['message.edited','message.revoked','message.reaction'],hmac:{key:'synthetic-mutation-hmac'}}]}})})).status,201);server.simulateState('WORKING');
 for(const [i,kind] of ['edited','revoked','reaction','reaction'].entries()){
  const input={...common,eventId:`evt_0${i}aaaaaaaaaaaaaaaaaaaaaaaa`,messageId:`false_123@g.us_ACTION${i}`,kind,text:kind==='edited'?'Edited fixture':i===2?'=���':''};
  await server.emitMutation(input);const first=received.at(-1);clock+=5000;await server.emitMutation(input);assert(first.bytes.equals(received.at(-1).bytes));
  assert.equal(first.headers['x-webhook-hmac'],createHmac('sha512','synthetic-mutation-hmac').update(first.bytes).digest('hex'));
  const body=JSON.parse(first.bytes);const envelope=kind==='edited'?'WAHAWebhookMessageEdited':kind==='revoked'?'WAHAWebhookMessageRevoked':'WAHAWebhookMessageReaction';
  for(const key of contract.schemas[envelope].required)assert(Object.hasOwn(body,key),key);
  const payloadSchema=kind==='edited'?'WAMessageEditedBody':kind==='revoked'?'WAMessageRevokedBody':'WAMessageReaction';for(const key of contract.schemas[payloadSchema].required??[])assert(Object.hasOwn(body.payload,key),key);
  const normalized=kind==='reaction'?await adapter.normalizeWebhook('connection',body,new Headers()):await adapter.normalizeMutationWebhook('connection',body,new Headers());assert(normalized,kind);
  if(kind==='reaction'){assert.equal(normalized.eventKind,'REACTION');assert.equal(normalized.quotedMessageId,common.targetMessageId);}else{assert.equal(normalized.kind,kind.toUpperCase());assert(normalized.targetMessageIdCandidates.includes(common.targetMessageId));}
  await assert.rejects(async()=>server.emitMutation({...input,text:'different',targetMessageId:'false_123@g.us_OTHER'}));
 }
 const valid={...common,eventId:'evt_09aaaaaaaaaaaaaaaaaaaaaaaa',messageId:'false_123@g.us_VALID',kind:'edited',text:'ok'};
 for(const change of [{eventId:'invalid'},{messageId:'malformed'},{participant:'invalid'},{text:'bad\u0000text'},{targetMessageId:'false_999@g.us_OTHER'},{text:'x'.repeat(4097)},{kind:'reaction',text:'bad reaction'},{kind:'reaction',text:'x'.repeat(17)}])await assert.rejects(async()=>server.emitMutation({...valid,...change}));
 const count=received.length;for(const state of ['STOPPED','STARTING','SCAN_QR_CODE','FAILED']){server.simulateState(state);await assert.rejects(async()=>server.emitMutation(valid));}assert.equal(received.length,count);
 }finally{server.closeAllConnections();receiver.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>receiver.close(r))]);}
});
