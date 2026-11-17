import assert from 'node:assert/strict';import test from 'node:test';
import {InboundRepository} from '../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js';
for(const failedAppend of [false,true])test('resolved ticket reuse '+(failedAppend?'fails closed on append failure':'starts current flow without search/create'),async()=>{
 let created=0,appended=0,inserted=0;const stop=Error('insert observed'),appendError=Error('native unavailable');
 const repo=new InboundRepository({connect:async()=>({release(){},query:async(sql,v=[])=>{
  if(sql.includes('FROM bot_conversations conversation'))return{rows:[]};
  if(sql.includes('SELECT assignment.flow_version_id'))return{rows:[{flow_version_id:'v2',start_node:'start',state:'ACTIVE'}]};
  if(sql.includes('SELECT zammad_ticket_id,zammad_ticket_number')){assert.deepEqual(v,['t','assignment','connection','12025550106@c.us']);return{rows:[{zammad_ticket_id:'42',zammad_ticket_number:'90042'}]};}
  if(sql.includes('INSERT INTO normalized_messages'))return{rows:[{id:'message'}],rowCount:1};
  if(sql.includes('INSERT INTO bot_conversations')){inserted++;assert.equal(v[3],'v2');assert.equal(v[7],'42');throw stop;}
  return{rows:[],rowCount:0};
 }})});
 await assert.rejects(repo.processDirectMessage({id:'event',tenantId:'t',connectionId:'connection'}, {assignmentId:'assignment'}, {messageId:'m',chatId:'12025550106@c.us',senderId:'12025550106@c.us',timestamp:new Date(),input:{type:'text',text:'return'},text:'return',fromMe:false},{id:7,login:'customer'},{create:async()=>{created++;throw Error('create forbidden');},append:async id=>{appended++;assert.equal(id,'42');if(failedAppend)throw appendError;return'article';}}),e=>e===(failedAppend?appendError:stop));
 assert.equal(created,0);assert.equal(appended,1);assert.equal(inserted,failedAppend?0:1);
});
