import test from 'node:test';import assert from 'node:assert/strict';
import {assertReloadedExecution,directDerivedIds,restrictedExecutionResults,observeRetainedExecution} from '../scripts/release/simulation-direct-derived.mjs';
test('reload requires same unique execution identity and result',()=>{
 const before={items:[{id:'event',kind:'FLOW_ADVANCED',from:'hello',to:'handoff'}]};
 assertReloadedExecution(before,structuredClone(before),'event');
 assert.throws(()=>assertReloadedExecution(before,{items:[{...before.items[0],id:'other'}]},'event'));
 assert.throws(()=>assertReloadedExecution(before,{items:[{...before.items[0],to:'wrong'}]},'event'));
 assert.throws(()=>assertReloadedExecution(before,{items:[before.items[0],before.items[0]]},'event'));
});
test('restricted execution observations retain their four actual role contexts',()=>{
 const observations=['tenant_admin','supervisor','auditor','agent'].map(role=>({role,actorRef:'actor',tenantId:'tenant',actorVerified:true,noProviderReplay:true,conversationId:'conversation',executionId:'execution',eventIds:['execution'],actualViewport:{width:1440,height:1000},startedAt:'2026-09-19T12:00:00.000Z',finishedAt:'2026-09-19T12:00:01.000Z'}));
 const rows=restrictedExecutionResults(observations);assert.equal(rows.length,4);assert.deepEqual(rows.map(row=>row.contextId).sort(),['agent-en-desktop','auditor-en-desktop','supervisor-en-desktop','tenant_admin-en-desktop']);assert(rows.every(row=>row.testId===directDerivedIds[1]&&row.proof.noProviderReplay));
 assert.throws(()=>restrictedExecutionResults(observations.filter(row=>row.role!=='tenant_admin')));
 for(const invalid of [{noProviderReplay:false},{tenantId:null},{eventIds:[]},{eventIds:['execution','execution']}])assert.throws(()=>restrictedExecutionResults(observations.map((row,index)=>index===0?{...row,...invalid}:row)));
});
test('retained execution observer is GET-only, finds the exact conversation row and binds the actual actor',async()=>{
 const origin='https://portal.test',viewport={width:1440,height:1000},calls=[];let routeHandler,size,actorChecks=0;
 const target={id:'conv',flow_name:'Synthetic flow',zammad_ticket_number:'1042',version:3},events={items:[{id:'other'},{id:'exec'}]};
 const leaf={waitFor:async()=>{},first(){return this},count:async()=>events.items.length};
 const button={click:async()=>{calls.push('open');await routeHandler({request:()=>({url:()=>origin+'/api/bot-flows/conversations/conv/command',method:()=>'POST'}),abort:async()=>calls.push('aborted'),fallback:async()=>{}});}};
 const row={filter(){return this},count:async()=>1,isVisible:async()=>true,getByRole:(role,options)=>{assert.deepEqual([role,options],['button',{name:'View execution history',exact:true}]);return button;}};
 const dialog={locator:()=>leaf,getByRole:(role,options)=>{assert.deepEqual(options,{name:'Close execution history',exact:true});return{click:async()=>calls.push('close')};}};
 const page={setViewportSize:async v=>{size=v;},viewportSize:()=>size,route:async(_,f)=>{routeHandler=f;},unroute:async()=>calls.push('unroute'),goto:async url=>calls.push(url),
  getByRole:(role,options)=>role==='tab'?(assert.deepEqual(options,{name:'Conversations',exact:true}),{click:async()=>{}}):dialog,locator:selector=>selector==='.bot-conversations'?leaf:row,
  evaluate:async()=>({items:[target]}),waitForResponse:async()=>({status:()=>200,json:async()=>events})};
 const verifyActor=async()=>{actorChecks++;return{userMatched:true,workspaceMatched:true,actorRef:'sha256:'+'a'.repeat(64),tenantRef:'sha256:'+'b'.repeat(64),verifiedContext:{role:'auditor'}};};
 await assert.rejects(observeRetainedExecution({page,origin,conversationId:'conv',executionId:'exec',verifyActor}),/deepStrictEqual|Expected values/);
 assert(calls.includes('aborted')&&calls.at(-1)==='unroute','Mutation attempts are aborted and fail the observation');
 button.click=async()=>calls.push('open');const result=await observeRetainedExecution({page,origin,conversationId:'conv',executionId:'exec',verifyActor});
 assert.deepEqual(result.actualViewport,viewport);assert.deepEqual(result.eventIds,['other','exec']);assert.equal(result.noProviderReplay,true);assert.equal(result.version,3);assert.equal(actorChecks,4);
 await assert.rejects(observeRetainedExecution({page,origin,conversationId:'missing',executionId:'exec',verifyActor}),/missing from bounded catalog/);
});
