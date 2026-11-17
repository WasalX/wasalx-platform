import assert from 'node:assert/strict';
import test from 'node:test';
import {metaTemplateContinuity,metaTemplateCopyEligible,metaTemplateSafetyMarker} from '../packages/core/dist/meta-template-continuity.js';
import {parseMetaTemplateInventoryItem} from '../packages/core/dist/meta-template-inventory.js';
import {metaTemplateCopyBody,parseMetaTemplateCopyResult} from '../services/connector-worker/dist/packages/connectors/src/meta-template-copy.js';
const item=(id,patch={})=>parseMetaTemplateInventoryItem(JSON.parse(JSON.stringify({id,name:'order_update',language:'en_US',status:'APPROVED',category:'UTILITY',parameter_format:'POSITIONAL',quality_score:{score:'GREEN'},components:[{type:'BODY',text:'Order {{1}} is ready.'}],...patch})));
const inventory=(id,items,complete=true)=>({accountId:id,items,complete});
const dependency={flowVersionId:'10000000-0000-4000-8000-000000000001',name:'order_update',language:'en_US',parameterCount:1};
test('Exact supported content survives different IDs/examples/quality; same name and count do not prove compatibility',()=>{
 const a=item('11'),b=item('22',{quality_score:{score:'UNKNOWN'},components:[{type:'BODY',text:'Order {{1}} is ready.',example:{body_text:[['A']]}}]});
 const compare=target=>metaTemplateContinuity(inventory('1',[a]),inventory('2',[target]),dependency);
 assert.equal(compare(b).ready,true);assert.equal(compare(item('22',{components:[{type:'BODY',text:'Pay {{1}} now.'}]})).reason,'CONTENT_CHANGED');
 for(const patch of [{category:'MARKETING'},{message_send_ttl_seconds:60}])assert.equal(compare(item('22',patch)).reason,'CONTENT_CHANGED');
 for(const patch of [{future_field:true},{parameter_format:'NAMED'},{parameter_format:undefined},{components:[{type:'BODY',text:'Order {{2}} is ready.'}]},
  {components:[{type:'HEADER',format:'TEXT',text:'Customer {{1}}'},{type:'BODY',text:'Order {{1}} is ready.'}]},
  {components:[{type:'BODY',text:'Order {{1}} is ready.'},{type:'BUTTONS',buttons:[{type:'FLOW',text:'Open',flow_id:'55'}]}]}])
  assert.equal(compare(item('22',patch)).reason,'UNSUPPORTED_DEFINITION');
 assert.equal(compare(item('22',{status:'PAUSED'})).reason,'TARGET_NOT_APPROVED');
 assert.equal(metaTemplateContinuity(inventory('1',[a]),inventory('2',[b],false),dependency).reason,'INVENTORY_INCOMPLETE');
 assert.equal(metaTemplateContinuity(inventory('1',[a]),inventory('2',[b,item('23')]),dependency).reason,'AMBIGUOUS_TEMPLATE');
 assert.equal(metaTemplateContinuity(inventory('1',[a]),inventory('2',[b]),{...dependency,parameterCount:2}).reason,'PARAMETERS_CHANGED');
});
test('Explicit and legacy automatic copy quality policies stay distinct',()=>{
 for(const score of ['GREEN','UNKNOWN','YELLOW','RED']){
  const value=item('11',{quality_score:{score}});
  assert.equal(metaTemplateCopyEligible(value,'EXPLICIT_COPY'),['GREEN','UNKNOWN'].includes(score));
  assert.equal(metaTemplateCopyEligible(value,'LEGACY_AUTOMATIC'),score==='GREEN');
 }
 assert.equal(metaTemplateCopyEligible(item('11',{status:'REJECTED'}),'EXPLICIT_COPY'),false);
});
test('Known-account signed template events invalidate narrowly, malformed identity holds the whole same account',()=>{
 for(const event of ['REJECTED','APPROVED','REINSTATED','FUTURE'])assert.deepEqual(metaTemplateSafetyMarker('message_template_status_update',{event,message_template_id:123}),{templateId:'123',scope:'TEMPLATE'});
 for(const value of [null,{},[],{message_template_id:'123'},{message_template_id:Number.MAX_SAFE_INTEGER+1}])
  assert.deepEqual(metaTemplateSafetyMarker('message_template_status_update',value),{templateId:null,scope:'ACCOUNT'});
 assert.deepEqual(metaTemplateSafetyMarker('message_template_components_update',{message_template_id:123}),{templateId:null,scope:'ACCOUNT'});
 assert.equal(metaTemplateSafetyMarker('messages',{}),null);
});
test('Bounded explicit copy preserves selection and response settlement never invents an ID mapping',()=>{
 assert.deepEqual(metaTemplateCopyBody({sourceAccountId:'1',targetAccountId:'2',templateIds:['11','12']}),{source_waba_id:'1',template_ids:['11','12']});
 for(const ids of [[],['11','11'],Array.from({length:501},(_,i)=>String(i+1))])assert.throws(()=>metaTemplateCopyBody({sourceAccountId:'1',targetAccountId:'2',templateIds:ids}));
 assert.throws(()=>metaTemplateCopyBody({sourceAccountId:'1',targetAccountId:'1',templateIds:['11']}));
 const result=parseMetaTemplateCopyResult({migrated_templates:['22'],failed_templates:{'12':'Private provider reason'}},['11','12']);
 assert.deepEqual(result,{migratedTemplateIds:['22'],failedSourceTemplateIds:['12'],completeResponse:true});
 assert.equal('mapping' in result,false);assert.equal(JSON.stringify(result).includes('Private'),false);
 for(const value of [{migrated_templates:['22'],failed_templates:[]},{migrated_templates:[],failed_templates:{}},
  {migrated_templates:['22','22'],failed_templates:{}},{migrated_templates:['22'],failed_templates:{'99':'Unknown selection'}}])
  assert.throws(()=>parseMetaTemplateCopyResult(value,['11','12']),error=>error.outcomeKnown===false);
});
