import test from 'node:test';
import assert from 'node:assert/strict';
import {createWahaSimulation} from '../scripts/contracts/waha-simulation-server.mjs';
import {WahaAdapter} from '../services/connector-worker/dist/packages/connectors/src/waha.js';
const options={apiKey:'synthetic-catalogue-test',session:'s',groupId:'120000000000000001@g.us',phone:'12025550103',version:'test'};
test('real adapter discovers both groups; additional discovery does not admit sends',async()=>{
 const extra='120000000000000002@g.us',server=createWahaSimulation({...options,additionalDiscoveryGroupIds:[extra]});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const baseUrl='http://127.0.0.1:'+server.address().port;
 try{const adapter=new WahaAdapter({baseUrl,apiKey:options.apiKey,sessionFor:()=>options.session});
 const result=await adapter.listGroups('connection');assert.equal(result.groups.length,2);
 const response=await fetch(baseUrl+'/api/s/groups?offset=1&limit=1',{headers:{'x-api-key':options.apiKey}});assert.equal((await response.json())[0].JID,extra);
 const send=await fetch(baseUrl+'/api/sendText',{method:'POST',headers:{'content-type':'application/json','x-api-key':options.apiKey},body:JSON.stringify({session:'s',chatId:extra,text:'must reject'})});assert.equal(send.status,400);
 }finally{await new Promise(r=>server.close(r));}
});
test('additional catalogue rejects malformed and duplicate identities',()=>{for(const ids of [[options.groupId],['bad'],['120000000000000002@g.us','120000000000000002@g.us']])assert.throws(()=>createWahaSimulation({...options,additionalDiscoveryGroupIds:ids}));});
