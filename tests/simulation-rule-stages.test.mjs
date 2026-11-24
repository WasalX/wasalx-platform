import test from 'node:test';import assert from 'node:assert/strict';
import {admitRuleVersions,ruleEchoStage} from '../scripts/release/simulation-rule-stages.mjs';
import {clonePolicyVersionThroughPortal} from '../scripts/release/simulation-rule-versions.mjs';
const session={actorBinding:{userMatched:true,workspaceMatched:true},model:{name:'wasalx-simulation-test'},tenantId:'tenant',ownerPage:{},portalOrigin:'http://127.0.0.1:3000',scoped(){throw Error('Effect forbidden');},checkpoint(){throw Error('Effect forbidden');}};
const args={namespace:'fresh1',inputs:{group:{evidenceMode:'simulated',namespace:'fresh1',tenantId:'tenant',connectionId:'connection',groupId:'group',ruleSetId:'source'}}};
test('rule stages require current namespace and tenant before any effects',()=>{
 assert.equal(admitRuleVersions(session,args).connectionId,'connection');
 assert.throws(()=>admitRuleVersions(session,{...args,namespace:'old'}));
 assert.throws(()=>admitRuleVersions({...session,tenantId:'other'},args));
 assert.throws(()=>admitRuleVersions(session,{...args,inputs:{}}));
});
test('echo missing admitted provider capabilities fails before dispatch',async()=>{
 await assert.rejects(()=>ruleEchoStage(session,args));
});

test('existing-family policy authoring selects the portal control and validates its clone request',async()=>{
 const source={id:'13000000-0000-4000-8000-000000000001',rules:[{name:'Policy rule',matcherOptions:{digitLength:10,teamSenderPolicy:'exclude'}}]},path='/api/rule-sets/13000000-0000-4000-8000-000000000001/clone';let selected,clicks=0,duplicate=false;
 const request={url:()=>`http://portal.test${path}`,method:()=> 'POST',headers:()=>({'idempotency-key':'12345678-1234-4234-9234-123456789abc'}),postDataJSON:()=>({rules:[{name:'Policy rule',matcherOptions:{digitLength:10,teamSenderPolicy:'include'}}]})};
 const response={url:request.url,request:()=>request,status:()=>200,json:async()=>{if(duplicate)requestListener(request);return{resultId:'23000000-0000-4000-8000-000000000001'};}};
 let requestListener;const select={selectOption:async value=>{selected=value},inputValue:async()=>selected},row={locator:()=>({filter:()=>({locator:()=>select})}),getByRole:()=>({click:async()=>{clicks++;requestListener(request)}})};
 const page={on:(_event,listener)=>{requestListener=listener},off:()=>{requestListener=undefined},waitForRequest:async predicate=>{assert(predicate(request));return request},waitForResponse:async predicate=>{assert(predicate(response));return response}};
 const result=await clonePolicyVersionThroughPortal({page,row,source,policy:'include'});assert.equal(selected,'include');assert.equal(clicks,1);assert.equal(result.draftId,'23000000-0000-4000-8000-000000000001');assert.match(result.operationKeySha256,/^[a-f0-9]{64}$/u);assert.equal(result.requestCount,1);
 duplicate=true;await assert.rejects(()=>clonePolicyVersionThroughPortal({page,row,source,policy:'include'}),/dispatched more than once/u);
});
