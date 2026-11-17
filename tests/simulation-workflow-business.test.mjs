import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
import {admitWorkflowViews,selectWorkflowVersion} from '../scripts/release/simulation-workflow-views.mjs';
import {normalizeWorkflowDetail,workflowLifecycleStage,boundedUiMutation} from '../scripts/release/simulation-workflow-lifecycle.mjs';
test('workflow lifecycle uses the exact review guard when present and propagates admission failures',async()=>{
 for(const retained of [false,true]){
  const calls=[],failure=Error('admission refused'),session={tenantId:'tenant',ownerPage:{setViewportSize:async()=>{}},verifyOwner:async()=>({userMatched:true,workspaceMatched:true}),directCallbacks:{drainEffects:async()=>{calls.push('ordinary');throw failure;}}};
  if(retained)session.capabilities={reviewFixture:{verifyReadOnly:async()=>{calls.push('review');throw failure;}}};
  await assert.rejects(workflowLifecycleStage(session,{namespace:'run',inputs:{workflowDraft:{evidenceMode:'simulated',namespace:'run',tenantId:'tenant'},workflowViews:{}}}),error=>error===failure);
  assert.deepEqual(calls,[retained?'review':'ordinary']);
 }
});
test('workflow reads use actual snake-case API identity, not missing create-receipt fields',()=>{
 assert.deepEqual(normalizeWorkflowDetail({flow_version_id:'v',family_id:'f',state:'DRAFT'},'v'),{flow_version_id:'v',family_id:'f',state:'DRAFT',id:'v',familyId:'f'});
 assert.throws(()=>normalizeWorkflowDetail({id:'v',familyId:'f'},'v'));
 assert.throws(()=>normalizeWorkflowDetail({flow_version_id:'other',family_id:'f'},'v'));
});
test('workflow views require current draft and actual restricted capability binding',()=>{
 const session={tenantId:'t',actorBinding:{userMatched:true,workspaceMatched:true},verifyOwner(){},capabilities:{secondActor:{memberId:'m',page:{}}}};
 const args={namespace:'run',inputs:{workflowDraft:{evidenceMode:'simulated',namespace:'run',tenantId:'t',draftVersionId:'draft',sourceId:'source'},secondActor:{namespace:'run',tenantId:'t',role:'agent',memberId:'m'}}};
 assert.equal(admitWorkflowViews(session,args).draftVersionId,'draft');
 assert.throws(()=>admitWorkflowViews(session,{...args,namespace:'old'}));
 assert.throws(()=>admitWorkflowViews({...session,capabilities:{secondActor:{memberId:'other',page:{}}}},args));
});

test('workflow selection waits for the exact asynchronous catalog card before counting and opening it',async()=>{
 const calls=[],detail={waitFor:async()=>calls.push('detail-ready')},card={filter(options){assert.equal(options.has.scope,'page');return this},waitFor:async options=>{assert.deepEqual(options,{state:'visible'});calls.push('card-visible')},count:async()=>{calls.push('card-count');return 1},click:async()=>calls.push('card-click')},panel={getByRole:(role)=>{assert.equal(role,'button');return card},locator:(selector,options)=>{if(selector==='.bot-flow-detail')return detail;assert(['b','small'].includes(selector));if(selector==='b')assert.equal(options.hasText,'Owned draft');else assert(options.hasText.test('Version 7 · Draft'));return{selector}}},page={setViewportSize:async value=>calls.push(['viewport',value]),goto:async value=>calls.push(['goto',value]),locator:(selector,options)=>{if(selector==='#bot-panel-flows')return panel;assert(['b','small'].includes(selector));if(selector==='b')assert.equal(options.hasText,'Owned draft');else assert(options.hasText.test('Version 7 · Draft'));return{selector,scope:'page'}}};
 await selectWorkflowVersion(page,'https://portal.test',{name:'Owned draft',version:7});assert.deepEqual(calls,[['viewport',{width:1440,height:1000}],['goto','https://portal.test/app?view=automation'],'card-visible','card-count','card-click','detail-ready']);
});
test('restricted workflow proof excludes raw and edit surfaces without rejecting the read-only simulator',()=>{const source=readFileSync(new URL('../scripts/release/simulation-workflow-views.mjs',import.meta.url),'utf8');assert(source.includes('.routing-raw,.bot-heading-actions,[role="region"][aria-label="Interactive workflow graph"]'));assert(!source.includes("panel.locator('pre,textarea,input')"));});

test('workflow selection tags the exact failed operation without exposing page text',async()=>{
 for(const broken of ['viewport','navigate','card-visible','card-count','card-click','detail-visible']){
  const fail=phase=>{if(phase===broken)throw Error('PRIVATE page text');};
  const card={filter(){return this},waitFor:async()=>fail('card-visible'),count:async()=>{fail('card-count');return 1},click:async()=>fail('card-click')};
  const panel={getByRole:()=>card,locator:selector=>selector==='.bot-flow-detail'?{waitFor:async()=>fail('detail-visible')}:{}};const page={setViewportSize:async()=>fail('viewport'),goto:async()=>fail('navigate'),locator:selector=>selector==='#bot-panel-flows'?panel:{scope:'page'}};
  await assert.rejects(selectWorkflowVersion(page,'https://portal.test',{name:'Draft',version:1}),error=>error.qualificationOperation==='workflow-select-'+broken);
 }
});
test('bounded UI mutation reports reconciliation and fails when neither response nor durable effect settles',async()=>{
 const response=(status=201)=>({url:()=>'https://portal.test/api/x',request:()=>({method:()=> 'POST'}),status:()=>status,json:async()=>({id:'new'})});
 const page=wait=>({waitForResponse:async()=>wait()});
 assert.deepEqual(await boundedUiMutation({page:page(async()=>response()),path:'/api/x',expectedStatus:201,trigger:async()=>{},reconcile:async()=>assert.fail('No reconcile on settled response')}),{value:undefined,reconciled:false});
 const lost=await boundedUiMutation({page:page(async()=>{throw Error('response lost')}),path:'/api/x',expectedStatus:201,trigger:async()=>{},reconcile:async()=>({id:'durable'})});assert.deepEqual(lost,{value:{id:'durable'},reconciled:true});
 await assert.rejects(boundedUiMutation({page:page(async()=>response(500)),path:'/api/x',expectedStatus:201,trigger:async()=>{},reconcile:async()=>null}),AggregateError);
 await assert.rejects(boundedUiMutation({page:page(()=>new Promise(()=>{})),path:'/api/x',expectedStatus:201,trigger:async()=>{},reconcile:async()=>null,timeoutMs:20}),/UI mutation outcome is uncertain/);
});

import {workflowViewPlan,workflowWaveRows,workflowViewIds} from '../scripts/release/simulation-workflow-views.mjs';
import {validateAdminWorkflowReadback,workflowLifecycleIds} from '../scripts/release/simulation-workflow-lifecycle.mjs';
test('workflow view plan observes only allocated desktop roles allowed for each view',()=>{
 assert.deepEqual(workflowViewPlan(workflowViewIds,undefined),{owner:[0,1],agent:[2],wave:[]});
 const checks=[[0,'tenant_owner'],[0,'tenant_admin'],[1,'tenant_admin'],[2,'agent'],[2,'auditor'],[2,'supervisor'],[2,'tenant_admin'],[1,'agent'],[0,'tenant_owner-en-tablet']].map(([index,role])=>({testId:workflowViewIds[index],contextId:role.includes('-')?role:role+'-en-desktop'}));
 assert.deepEqual(workflowViewPlan(workflowViewIds,checks),{owner:[0],agent:[2],wave:[{role:'tenant_admin',indexes:[0,1]},{role:'supervisor',indexes:[2]},{role:'auditor',indexes:[2]}]});
 assert.deepEqual(workflowViewPlan([workflowViewIds[2]],checks).wave.map(entry=>entry.role),['supervisor','auditor']);
});
test('a role whose observer failed yields failed rows for its planned tests, never omitted or passed',()=>{
 const observed={testId:workflowViewIds[2],result:'passed',contextId:'supervisor-en-desktop'};
 const wave={proofs:[{role:'supervisor',observation:[observed]},{role:'auditor',passed:false,stage:'role-observer',startedAt:'a',finishedAt:'b',actorRef:'sha256:x',tenantRef:'sha256:y',failure:{errorClass:'Error',messageSha256:'f'.repeat(64)}}]};
 const rows=workflowWaveRows(wave,[{role:'supervisor',indexes:[2]},{role:'auditor',indexes:[2]}],index=>workflowViewIds[index]);
 assert.deepEqual(rows[0],observed);assert.deepEqual([rows[1].result,rows[1].contextId,rows[1].proof.stage,rows[1].proof.messageSha256],['failed','auditor-en-desktop','role-observer','f'.repeat(64)]);
 assert.throws(()=>workflowWaveRows({proofs:[]},[{role:'tenant_admin',indexes:[0]}],index=>workflowViewIds[index]),/proof missing/);
});
test('admin lifecycle read-back requires exact retired/active family history and unchanged paused assignments',()=>{
 const definition={nodes:[{id:'a'}]},revised={nodes:[{id:'b'}]},row=(id,state,def)=>({flow_version_id:id,family_id:'f',state,definition:def}),args=()=>({old:row('1','RETIRED',definition),intervening:row('2','RETIRED',revised),current:row('3','ACTIVE',definition),firstId:'1',secondId:'2',restoredId:'3',familyId:'f',originalDefinition:definition,interveningDefinition:revised,priorAssignments:[{id:'x',state:'PAUSED'}],actualAssignments:[{id:'x',state:'PAUSED'}]});
 assert.equal(validateAdminWorkflowReadback(args()),true);
 for(const change of [a=>a.current.state='RETIRED',a=>a.old.definition=revised,a=>a.intervening.family_id='g',a=>a.actualAssignments=[{id:'x',state:'ACTIVE'}],a=>a.restoredId='9'])assert.throws(()=>{const a=args();change(a);validateAdminWorkflowReadback(a);});
 const source=readFileSync(new URL('../scripts/release/simulation-workflow-lifecycle.mjs',import.meta.url),'utf8');assert(source.includes("check.contextId==='tenant_admin-en-desktop'"));assert(source.includes('if(adminIndexes.length)'));assert.equal(workflowLifecycleIds.length,3);
});
import {guardedWorkflowRead} from '../scripts/release/simulation-workflow-views.mjs';
test('guarded workflow read aborts and fails on any mutation and always unroutes',async()=>{
 const make=method=>{let handler,unrouted=0,aborted=0;const page={route:async(_,f)=>{handler=f;},unroute:async()=>{unrouted++;}};const fire=()=>handler({request:()=>({url:()=>'https://portal.test/api/x',method:()=>method}),abort:async()=>{aborted++;},fallback:async()=>{}});return{page,fire,counts:()=>({unrouted,aborted})};};
 const read=make('GET');assert.equal(await guardedWorkflowRead({portalOrigin:'https://portal.test'},read.page,async()=>{await read.fire();return 'ok';}),'ok');assert.deepEqual(read.counts(),{unrouted:1,aborted:0});
 const write=make('POST');await assert.rejects(guardedWorkflowRead({portalOrigin:'https://portal.test'},write.page,async()=>{await write.fire();return 'ok';}));assert.deepEqual(write.counts(),{unrouted:1,aborted:1});
});
