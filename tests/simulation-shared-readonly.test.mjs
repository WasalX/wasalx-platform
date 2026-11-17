import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {admitSharedReadonly} from '../scripts/release/simulation-shared-readonly-stage.mjs';import {definitions} from '../scripts/release/simulation-shared-readonly-definitions.mjs';import {waitForSharedQualityReady} from '../scripts/release/simulation-shared-readonly.mjs';
import {runCasesWorkflowQuality} from '../scripts/release/simulation-shared-readonly.mjs';
const session={tenantId:'t',actorBinding:{userMatched:true,workspaceMatched:true},directCallbacks:{providerRead(){},binding:{connectionId:'c'}},metaCallbacks:{providerRead(){},binding:{connectionId:'meta'}}},args={namespace:'n',inputs:{group:{namespace:'n',evidenceMode:'simulated',tenantId:'t',ticketId:1,connectionId:'c'},directFlow:{evidenceMode:'simulated',fixtures:{tenantId:'t',connectionId:'c'}},metaDeliveries:{evidenceMode:'simulated',tenantId:'t',connectionId:'meta',producer:{namespace:'n'}}},config:{contextId:'tenant_owner-en-desktop',testIds:definitions.map(d=>d.id)}};
test('exact current definition selection admits only implemented owner desktop checks',()=>{assert.equal(admitSharedReadonly(session,args).length,13);assert.throws(()=>admitSharedReadonly(session,{...args,config:{...args.config,testIds:['invented']}}));assert.throws(()=>admitSharedReadonly(session,{...args,config:{...args.config,contextId:'tenant_agent-en-desktop'}}));assert.throws(()=>admitSharedReadonly(session,{...args,inputs:{...args.inputs,group:{...args.inputs.group,tenantId:'wrong'}}}));});
test('promoted leaf excludes unimplemented actions and guards no-render console/network claims',()=>{const s=readFileSync(new URL('../scripts/release/simulation-shared-readonly.mjs',import.meta.url),'utf8');assert(!s.includes("for(const mode"));assert(!s.includes('Review activation'));assert(s.includes("!renderComplete?'blocked':counters.consoleErrors"));assert(s.includes("!renderComplete?'blocked':counters.failedRequests"));assert(s.includes("mutationRequests.length,0"));});

test('declared Meta producer must match installed callback before read-only stage',()=>{assert.throws(()=>admitSharedReadonly(session,{...args,inputs:{...args.inputs,metaDeliveries:undefined}}));assert.throws(()=>admitSharedReadonly(session,{...args,inputs:{...args.inputs,metaDeliveries:{...args.inputs.metaDeliveries,connectionId:'wrong'}}}));});


test('read-only review readiness accepts the exact populated or empty surface',async()=>{
 const seen=[];const locator=name=>({first(){return this},or(other){seen.push(['or',name,other.name]);return this},async waitFor(options){seen.push(['waitFor',name,options])},name});
 const page={locator:selector=>locator(selector),getByText:(text,options)=>{assert.deepEqual(options,{exact:true});return locator(text)}};
 await waitForSharedQualityReady(page,{ready:'.review-table',empty:'Review queue is clear'});
 assert.deepEqual(seen,[['or','.review-table','Review queue is clear'],['waitFor','.review-table',{state:'visible'}]]);
});

test('unselected reload prerequisite preserves safe failure provenance for blocked checks',async()=>{
 const listeners=new Map(),prefix='cases-deliveries/case-filter-generation-and-detach',rows=[];
 const locator={first(){return this},or(){return this},async waitFor(){throw Error('PRIVATE_READY_DETAIL')}};
 const request={url:()=> 'http://owned/_next/static/chunks/app.js?secret=PRIVATE',method:()=> 'GET',failure:()=>({errorText:'net::ERR_CONNECTION_RESET'})};
 const page={setViewportSize:async()=>{},viewportSize:()=>({width:1440,height:1000}),setDefaultTimeout(){},setDefaultNavigationTimeout(){},route:async()=>{},unroute:async()=>{},locator:()=>locator,getByText:()=>locator,on:(name,fn)=>listeners.set(name,fn),off:name=>listeners.delete(name),async goto(){listeners.get('request')(request);listeners.get('requestfailed')(request)}};
 const result=await runCasesWorkflowQuality({page,origin:'http://owned',checkpoint:async row=>rows.push(row),providerRead:async()=>({receipts:[]}),testDefinitions:['console','network'].map(suffix=>({id:prefix+'::ui-quality::'+suffix}))});
 assert.deepEqual(result.results.map(row=>row.result),['blocked','blocked']);
 const proof=result.results[0].proof;
 assert.equal(proof.reloadPrerequisite.phase,'normal-ready');assert.equal(proof.reloadPrerequisite.errorClass,'Error');assert.match(proof.reloadPrerequisite.messageSha256,/^[a-f0-9]{64}$/);
 assert.equal(proof.failedRequests[0].errorCode,'net::ERR_CONNECTION_RESET');assert.equal(proof.failedRequests[0].classification,'unclassified request failure');
 assert(!JSON.stringify(rows).includes('PRIVATE'));assert.equal(listeners.size,0);
});
