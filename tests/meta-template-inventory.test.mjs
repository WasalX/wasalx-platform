import assert from 'node:assert/strict';
import test from 'node:test';
import {MetaGroupsAdapter} from '../services/connector-worker/dist/packages/connectors/src/meta.js';
import {parseMetaTemplateInventoryItem} from '../packages/core/dist/meta-template-inventory.js';
import {readMetaTemplateInventory,META_TEMPLATE_INVENTORY_FIELDS} from '../services/connector-worker/dist/packages/connectors/src/meta-template-read.js';
import {metaTransitionObservation,publicMetaTransitionObservation} from '../packages/core/dist/meta-account-transition-observation.js';

const template=(id='12',overrides={})=>({id,name:'order_update',language:'en_US',status:'APPROVED',category:'UTILITY',
  parameter_format:'POSITIONAL',quality_score:{score:'GREEN'},components:[{type:'BODY',text:'Order {{1}} is ready.'}],...overrides});

test('Pinned v24 inventory retains semantic options and unknown components without asserting compatibility',()=>{
  const value=template('12',{message_send_ttl_seconds:3600,components:[{type:'BODY',text:'Order {{1}} is ready.'},
    {type:'BUTTONS',buttons:[{type:'FLOW',text:'Details',flow_id:'55',flow_action:'navigate',navigate_screen:'DETAILS'}]}],
    future_field:{meaningful:'retained'}});
  const parsed=parseMetaTemplateInventoryItem(value);
  assert.equal(parsed.parameterFormat,'POSITIONAL');assert.equal(parsed.qualityScore,'GREEN');
  assert.deepEqual(parsed.definition,value);assert.equal('compatible' in parsed,false);
  value.components[0].text='changed after read';assert.equal(parsed.definition.components[0].text,'Order {{1}} is ready.');
  const missing=template();delete missing.parameter_format;delete missing.quality_score;
  assert.equal(parseMetaTemplateInventoryItem(missing).parameterFormat,null);
  assert.equal(parseMetaTemplateInventoryItem(missing).qualityScore,null);
  for(const status of ['ARCHIVED','DELETED','DISABLED','IN_APPEAL','LIMIT_EXCEEDED','PAUSED','PENDING','PENDING_DELETION','REJECTED'])
    assert.equal(parseMetaTemplateInventoryItem(template('12',{status})).status,status);
  assert.equal(parseMetaTemplateInventoryItem(template('12',{parameter_format:'NAMED',quality_score:{score:'UNKNOWN'}})).qualityScore,'UNKNOWN');
});

test('Malformed or unbounded template identity, status, quality and JSON remain incomplete evidence',()=>{
  const cyclic={};cyclic.self=cyclic;
  for(const value of [null,[],template(12),template('12',{name:'Bad name'}),template('12',{language:'../en'}),
    template('12',{status:'NEW_UNDOCUMENTED'}),template('12',{category:'OTHER'}),template('12',{parameter_format:null}),
    template('12',{quality_score:{}}),template('12',{quality_score:{score:'FUTURE'}}),template('12',{components:undefined}),
    template('12',{components:[{type:2}]}),template('12',{components:[{type:'BODY',text:'x'.repeat(32769)}]}),
    template('12',{components:[{type:'BODY',text:'x'.repeat(32768)},{type:'HEADER',text:'y'.repeat(32768)}]}),
    template('12',{future_field:cyclic}),template('12',{future_field:Number.NaN})])assert.equal(parseMetaTemplateInventoryItem(value),null);
});

test('Template pages use only the exact account edge and bounded cursor, preserving all statuses',async()=>{
  const calls=[];
  const result=await readMetaTemplateInventory('123',async(path,query)=>{
    calls.push({path,query});
    return query.after?{data:[template('13',{language:'ar',status:'PAUSED'})]}:
      {data:[template()],paging:{next:'https://foreign.invalid/?access_token=do-not-follow',cursors:{after:'next'}}};
  });
  assert.equal(result.complete,true);assert.equal(result.accountId,'123');assert.equal(result.items.length,2);
  assert.deepEqual(calls,[{path:'/123/message_templates',query:{fields:META_TEMPLATE_INVENTORY_FIELDS,limit:'100'}},
    {path:'/123/message_templates',query:{fields:META_TEMPLATE_INVENTORY_FIELDS,limit:'100',after:'next'}}]);
  assert.equal(JSON.stringify(result).includes('do-not-follow'),false);
  await assert.rejects(()=>readMetaTemplateInventory('../123',async()=>assert.fail('No request')),/ACCOUNT_INVALID/);
  const empty=await readMetaTemplateInventory('123',async()=>({data:[],paging:{cursors:{after:'end'}}}));
  assert.deepEqual(empty,{accountId:'123',items:[],complete:true});
});

test('Duplicate, partial, cursor-loop, page/item/byte bounds and request denial never become complete',async()=>{
  for(const response of [{}, {data:null}, {data:[template(),template()]},
    {data:[template(),template('13')]}, {data:[template(),template('13',{name:'different',components:undefined})]},
    {data:[],paging:[]}, {data:[],paging:{next:'next',cursors:{after:''}}},
    {data:[],paging:{next:42,cursors:{after:'next'}}},
    {data:Array.from({length:101},(_,i)=>template(String(i+1),{name:'t_'+i}))}]) {
    assert.equal((await readMetaTemplateInventory('123',async()=>response)).complete,false);
  }
  let calls=0;
  const loop=await readMetaTemplateInventory('123',async()=>({data:[template(String(++calls),{name:'t_'+calls})],paging:{next:'next',cursors:{after:'same'}}}));
  assert.equal(loop.complete,false);assert.equal(calls,2);
  calls=0;
  const bounded=await readMetaTemplateInventory('123',async()=>({data:[template(String(++calls),{name:'t_'+calls})],paging:{next:'next',cursors:{after:String(calls)}}}));
  assert.equal(bounded.complete,false);assert.equal(calls,20);
  calls=0;
  const bytes=await readMetaTemplateInventory('123',async()=>({data:Array.from({length:100},()=>
    template(String(++calls),{name:'t_'+calls,components:[{type:'BODY',text:'x'.repeat(30000)}]})),paging:{next:'next',cursors:{after:String(calls)}}}));
  assert.equal(bytes.complete,false);assert.ok(bytes.items.length<200);
  let reads=0;
  await assert.rejects(()=>readMetaTemplateInventory('123',async()=>{reads++;throw new Error('PRIVATE_PROVIDER_DENIED');}),/PRIVATE_PROVIDER_DENIED/);
  assert.equal(reads,1,'read errors propagate to existing safe worker classification, with no automatic retry');
});

test('Preview consumes only complete source count, includes native Meta Flow dependencies and exposes no template content',()=>{
  const request={requestedMode:'CUSTOMER',targetCurrency:'SAR',expectedAccountRevision:1,expectedBindingRevision:1};
  // This is a pure observation projection fixture, not account or provider authority.
  const context={providerAccountId:'123',phoneIds:['456'],scope:[],declaredMode:'CUSTOMER',
    templateDependencies:[{flowVersionId:'template-flow'}],metaFlowDependencies:[{flowVersionId:'hosted-flow'}]};
  const inventory={sourceAccountId:'123',currency:'USD',phoneIds:['456'],phonesComplete:true,templatesComplete:true,
    templates:[parseMetaTemplateInventoryItem(template())]};
  const observation=metaTransitionObservation(request,context,inventory,new Date('2026-10-08T00:00:00Z'));
  assert.equal(observation.impact.sourceTemplateCount,1);assert.equal(observation.impact.affectedFlowVersionCount,2);
  assert.equal(observation.impact.templateCompatibility,'NOT_ASSESSED');assert.equal(observation.canExecute,false);
  assert.equal(observation.reasons.includes('TEMPLATE_INVENTORY_INCOMPLETE'),false);
  assert.ok(observation.reasons.includes('ACCOUNT_VARIANT_UNVERIFIED'));
  const publicValue=publicMetaTransitionObservation({...observation,templates:inventory.templates,providerToken:'private'});
  assert.deepEqual(publicValue,observation);assert.equal(JSON.stringify(publicValue).includes('Order'),false);
  for(const invalid of [{...inventory,sourceAccountId:'999'},{...inventory,templatesComplete:false},{...inventory,templates:undefined}]) {
    const held=metaTransitionObservation(request,context,invalid);assert.equal(held.impact.sourceTemplateCount,null);
    assert.ok(held.reasons.includes('TEMPLATE_INVENTORY_INCOMPLETE'));
  }
});


test('Source and target inventories stay on their exact separate account edges',async()=>{
  const calls=[];
  const request=async(path,query)=>{
    calls.push({path,query});
    if(path==='/123/message_templates')return{data:[template('12')]};
    if(path==='/789/message_templates')return{data:[template('13',{name:'target_only',language:'ar'})]};
    assert.fail('No inferred account or arbitrary edge');
  };
  const source=await readMetaTemplateInventory('123',request),target=await readMetaTemplateInventory('789',request);
  assert.equal(source.complete,true);assert.equal(target.complete,true);
  assert.equal(source.accountId,'123');assert.equal(target.accountId,'789');
  assert.deepEqual(source.items.map(item=>item.name),['order_update']);
  assert.deepEqual(target.items.map(item=>item.name),['target_only']);
  assert.deepEqual(calls.map(call=>call.path),['/123/message_templates','/789/message_templates']);
  assert.ok(calls.every(call=>call.query.fields===META_TEMPLATE_INVENTORY_FIELDS&&call.query.limit==='100'));
  assert.equal(Object.hasOwn(target,'compatible'),false,'Independent reads never grant copy or compatibility');
});


test('Production adapter reads a separate target template edge with every request guarded',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let guards=0;const requests=[];
  globalThis.fetch=async(raw,init)=>{
    const url=new URL(raw);requests.push({origin:url.origin,path:url.pathname,method:init.method});
    if(url.pathname==='/v24.0/789')return Response.json({id:'789',currency:'SAR'});
    if(url.pathname==='/v24.0/789/phone_numbers')return Response.json({data:[]});
    if(url.pathname==='/v24.0/789/message_templates')return Response.json({data:[template('99',{name:'target_only',language:'ar'})]});
    assert.fail('Target read must never fall back to the source account');
  };
  const adapter=new MetaGroupsAdapter({accessToken:'synthetic-target-reader-token',graphVersion:'v24.0',phoneNumberIdFor:()=> '456',beforeRequest:async()=>{guards++;}});
  const result=await adapter.transitionPreviewInventory('789');
  assert.equal(result.sourceAccountId,'789');assert.equal(result.templatesComplete,true);
  assert.deepEqual(result.templates.map(item=>item.name),['target_only']);
  assert.equal(guards,3);assert.ok(requests.every(row=>row.origin==='https://graph.facebook.com'&&row.method==='GET'));
  assert.deepEqual(requests.map(row=>row.path),['/v24.0/789','/v24.0/789/phone_numbers','/v24.0/789/message_templates']);
  assert.equal(JSON.stringify(result).includes('synthetic-target-reader-token'),false);
});
