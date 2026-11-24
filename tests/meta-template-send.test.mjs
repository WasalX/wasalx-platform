import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyApprovedTicketTemplateSend, verifyMetaInheritedTemplateSend } from '../services/connector-worker/dist/services/connector-worker/src/meta-template-send.js';
import { buildMetaTemplateMapping } from '../packages/core/dist/meta-template-mapping.js';
import { parseMetaTemplateInventoryItem } from '../packages/core/dist/meta-template-inventory.js';

const id = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function inventory(accountId, templateId, text='Order {{1}} is ready.') {
  return {accountId,complete:true,items:[parseMetaTemplateInventoryItem({id:templateId,name:'order_update',language:'en_US',
    status:'APPROVED',category:'UTILITY',parameter_format:'POSITIONAL',quality_score:{score:'GREEN'},
    components:[{type:'BODY',text}]})]};
}
function fixture() {
  const target=inventory('222','444');
  const dependency={flowVersionId:id(1),name:'order_update',language:'en_US',parameterCount:1};
  const mapping=buildMetaTemplateMapping({source:inventory('111','333'),target,dependencies:[dependency],
    sourceSafetyRevision:1,targetSafetyRevision:3,metaFlowDependencyCount:0});
  const context={schemaVersion:1,claim:'INHERITED_TEMPLATE_SEND',contextSha256:'a'.repeat(64),transitionId:id(2),
    mappingOperationId:id(3),bindingId:id(4),bindingRevision:2,providerAccountId:'222',phoneId:'555',
    flowVersionId:id(1),targetSafetyRevision:3,mapping,template:{name:'order_update',languageCode:'en_US',parameterCount:1}};
  const job={id:id(5),tenantId:id(6),connectionId:id(7),provider:'meta',sessionId:'555',
    metaCredentialContext:{wabaId:'222'},template:{name:'order_update',languageCode:'en_US',bodyParameters:['42']}};
  const state={reads:0,contexts:0,after:null,inventory:target};
  const store={context:async()=>{state.contexts++;return structuredClone(state.contexts>1&&state.after!==null?state.after:context);}};
  const adapter={templatePreparationCalls:()=>({inventory:async account=>{assert.equal(account,'222');state.reads++;return state.inventory;}})};
  return {job,context,state,store,adapter,run:()=>verifyMetaInheritedTemplateSend(job,id(8),store,adapter)};
}

test('final template read pins original mapping and current target generation without rewriting the payload',async()=>{
  const f=fixture(),original=structuredClone(f.job),proof=await f.run();
  assert.equal(proof.targetTemplateId,'444');assert.equal(proof.mappingOperationId,id(3));
  assert.equal(proof.targetSafetyRevision,3);assert.equal(proof.semanticSha256,f.context.mapping.mappings[0].semanticSha256);
  assert.match(proof.inventoryResponseSha256,/^[a-f0-9]{64}$/u);assert.equal(f.state.reads,1);assert.equal(f.state.contexts,2);
  assert.deepEqual(f.job,original);
});

test('recreated, changed, paused and incomplete target templates never authorize inherited send',async()=>{
  for(const replacement of [inventory('222','999'),inventory('222','444','Different {{1}}.'),
    {...inventory('222','444'),complete:false},inventory('111','444')]) {
    const f=fixture();f.state.inventory=replacement;await assert.rejects(f.run,{code:'META_TEMPLATE_SEND_HELD'});
  }
  const f=fixture();f.state.inventory.items[0].status='PAUSED';await assert.rejects(f.run,{code:'META_TEMPLATE_SEND_HELD'});
});

test('signed invalidation or binding/mapping/lease drift across GET holds the original request',async()=>{
  for(const change of [{targetSafetyRevision:4},{bindingRevision:3},{mappingOperationId:id(30)},
    {contextSha256:'b'.repeat(64)}]) {
    const f=fixture();f.state.after={...f.context,...change};await assert.rejects(f.run,{code:'META_TEMPLATE_SEND_HELD'});
    assert.equal(f.state.reads,1);
  }
  const f=fixture();f.store.context=async()=>{if(f.state.contexts++)throw new Error('lease lost');return f.context;};
  await assert.rejects(f.run,/lease lost/u);assert.equal(f.state.reads,1);
});

test('same-name arbitrary flows and wrong original asset are rejected before inventory work',async()=>{
  for(const change of [{flowVersionId:id(99)},{phoneId:'666'},{providerAccountId:'777'}]) {
    const f=fixture();Object.assign(f.context,change);await assert.rejects(f.run,{code:'META_TEMPLATE_SEND_HELD'});
    assert.equal(f.state.reads,change.flowVersionId?1:0);
  }
});

test('only an authoritative non-inherited context skips the extra GET; unavailable SQL never becomes null',async()=>{
  const f=fixture();f.store.context=async()=>null;assert.equal(await f.run(),null);assert.equal(f.state.reads,0);
  f.store.context=async()=>{throw new Error('context unavailable');};await assert.rejects(f.run,/context unavailable/u);
  assert.equal(f.state.reads,0);
});


test('approved ticket template checks the current account before the simulated message dispatch', async () => {
  const { MetaGroupsAdapter } = await import('../services/connector-worker/dist/packages/connectors/src/meta.js');
  const { approvedTicketTemplate } = await import('../packages/core/dist/meta-template-continuity.js');
  const inv=inventory('222','444');
  const approved=approvedTicketTemplate(inv.items[0]);
  const job={provider:'meta',directOrigin:'HUMAN',recipientType:'DIRECT',metaCredentialContext:{wabaId:'222'},
    ticketTemplate:{id:approved.id,semanticSha256:approved.semanticSha256},
    template:{name:approved.name,languageCode:approved.language,bodyParameters:['42']}};
  const wire=[];
  const originalFetch=globalThis.fetch;
  let row=inv.items[0].definition;
  globalThis.fetch=async (url,init)=>{
    const path=new URL(url).pathname;
    if(path==='/v24.0/222/message_templates')return Response.json({data:[row]});
    assert.equal(path,'/v24.0/111/messages');
    wire.push(JSON.parse(init.body));
    return Response.json({messages:[{id:'simulated-delivery'}]});
  };
  try {
    const adapter=new MetaGroupsAdapter({accessToken:'synthetic-template-token',graphVersion:'v24.0',
      phoneNumberIdFor:()=> '111',baseUrl:'https://graph.example.test',
      beforeMessageSend:()=>verifyApprovedTicketTemplateSend(job,adapter)});
    const send=()=>adapter.send({connectionId:'synthetic',groupId:'12025550173',recipientType:'DIRECT',text:'order_update',
      idempotencyKey:'synthetic-ticket-template',template:job.template});
    await send();
    assert.equal(wire.length,1);
    assert.equal(wire[0].type,'template');
    assert.deepEqual(wire[0].template.components,[{type:'body',parameters:[{type:'text',text:'42'}]}]);
    row={...row,status:'PAUSED'};
    await assert.rejects(send,{code:'META_TEMPLATE_SEND_HELD'});
    row=inventory('222','444','Order {{1}} moved.').items[0].definition;
    await assert.rejects(send,{code:'META_TEMPLATE_SEND_HELD'});
    assert.equal(wire.length,1);
  } finally {
    globalThis.fetch=originalFetch;
  }
});
