import test from 'node:test';import assert from 'node:assert/strict';
import {runMetaChoiceLocation,metaInput} from '../scripts/release/simulation-meta-choice-events.mjs';
import {metaReaders} from '../scripts/release/simulation-meta-choice-readers.mjs';
test('choice/location emits three durable fenced inputs and byte-identical duplicate',async()=>{
 const calls=[],saved=new Map();let posts=0;
 const result=await runMetaChoiceLocation({binding:{wabaId:'waba',phoneId:'phone',customer:'123456789'},secret:'private-test-secret',runId:'run-choices',now:()=>1000,assertIsolatedRuntime:async()=>{},checkpoint:async()=>{},persistInbound:async({messageId,bytes})=>saved.set(messageId,Buffer.from(bytes)),postRaw:async(path,bytes)=>{const id=JSON.parse(bytes).entry[0].changes[0].value.messages[0].id;assert.deepEqual(saved.get(id),bytes);calls.push(Buffer.from(bytes));return{status:200,receipt:++posts===4?{duplicates:1}:{count:1}};},readProcessed:async id=>({terminal:true,messageCount:1,currentNodeId:id.endsWith('.choice')?'location':'handoff'}),readPrompt:async()=>({state:'SENT',externalMessageId:'prompt',choiceId:'landmark',title:'Landmark'}),readLocation:async()=>({coordinates:{latitude:24.7136,longitude:46.6753},nativeArticleCount:1}),expectedChoiceNodeId:'location'});
 assert.equal(saved.size,3);assert.equal(calls.length,4);assert.deepEqual(calls[2],calls[3]);assert.equal(result.evidenceMode,'simulated');
});
test('invalid location rejected before serialization',()=>assert.throws(()=>metaInput({wabaId:'w',phoneId:'p',customer:'c',id:'id',timestamp:1,kind:'location',location:{latitude:91,longitude:0}})));
test('location readback uses persisted conversation variables and native article, not absent provider metadata',async()=>{
 const reader=metaReaders({tenantId:'t',connectionId:'c',scoped:async sql=>sql.includes('c.variables')?[{variables:{'message.location.latitude':'24.7136','message.location.longitude':'46.6753'}}]:[{inbox_id:'i',zammad_ticket_id:10,zammad_article_id:20,provider_metadata:{}}],nativeArticleRead:async()=>({id:20,body:'Coordinates: 24.7136, 46.6753'})});
 assert.deepEqual((await reader.readLocation('event')).coordinates,{latitude:24.7136,longitude:46.6753});
});
