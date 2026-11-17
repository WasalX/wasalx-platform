import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import { admitRoutingQuality } from '../scripts/release/simulation-routing-quality-stage.mjs';import{definitions}from'../scripts/release/simulation-routing-quality-definitions.mjs';
const make=()=>({session:{actorBinding:{userMatched:true,workspaceMatched:true},tenantId:'tenant',directCallbacks:{binding:{connectionId:'c'},providerRead(){}}},args:{namespace:'current',config:{contextId:'tenant_owner-en-desktop'},inputs:{group:{evidenceMode:'simulated',namespace:'current',tenantId:'tenant',connectionId:'c'},routingFive:{evidenceMode:'simulated',runId:'current',namespace:'current',tenantId:'tenant',draftId:'11111111-1111-4111-8111-111111111111',version:2}}}});
test('routing admits only same-run owned draft and actor',()=>{const{session,args}=make();assert.equal(admitRoutingQuality(session,args).version,2);for(const mutate of [x=>x.args.inputs.routingFive.namespace='old',x=>x.args.inputs.routingFive.draftId=undefined,x=>x.args.inputs.routingFive.version=0,x=>x.session.actorBinding.workspaceMatched=false,x=>x.args.config.contextId='tenant_owner-en-mobile',x=>x.session.directCallbacks.binding.connectionId='other']){const x=make();mutate(x);assert.throws(()=>admitRoutingQuality(x.session,x.args));}});
test('routing admits an explicitly retained draft without relabeling its source run',()=>{const{session,args}=make();Object.assign(args.inputs.routingFive,{runId:'fresh399-8117-v5-q06m',retainedFrom:'fresh399-8117-v5-q06m'});assert.equal(admitRoutingQuality(session,args).runId,'fresh399-8117-v5-q06m');args.inputs.routingFive.runId='other';assert.throws(()=>admitRoutingQuality(session,args));});

test('routing exact8 excludes workflow and retains guarded keyboard and safe evidence',()=>{assert.equal(definitions.length,8);assert.equal(new Set(definitions.map(x=>x.id)).size,8);assert(definitions.every(x=>x.id.startsWith('client-routing/')));const s=readFileSync(new URL('../scripts/release/simulation-routing-quality.mjs',import.meta.url),'utf8');assert(s.includes('qualityRequestObservers'));assert(s.includes('observerDiagnostics:e.observerDiagnostics??null'));assert(!s.includes('drainTimeoutMs:50_000'));assert(s.includes('route.fallback()'));assert(s.includes('x.id===routingDraft.draftId'));assert(s.includes('reachByTab(page,trigger)'));assert(s.includes("press('Shift+Tab')"));assert(!s.includes('trigger.focus()'));assert(!s.includes('message:e.message'));assert(!s.includes("view:'automation'"));});

test('routing timer and selector boundaries stay bounded',()=>{const s=readFileSync(new URL('../scripts/release/simulation-routing-quality.mjs',import.meta.url),'utf8');assert(s.includes('clearTimeout(seenTimeout)'));assert(s.includes("new RegExp('\\\\bVersion\\\\s+'+draft.version+'\\\\b')"));const stage=readFileSync(new URL('../scripts/release/simulation-routing-quality-stage.mjs',import.meta.url),'utf8');assert(stage.indexOf('await session.verifyOwner(session.ownerPage)')<stage.indexOf('const draft=await session.ownerPage.evaluate'));});






import {makeOwnedGetHandler} from '../scripts/release/simulation-owned-get-boundary.mjs';
test('source transport failure aborts only the exact owned read and cannot intercept writes',async()=>{
 let aborted=0,seen=0,fallback=0;const handler=makeOwnedGetHandler({origin:'https://owned.test',path:'/api/client-routing/sources',mode:'transport-error',onSeen:()=>seen++});
 for(const [method,url] of [['GET','https://owned.test/api/client-routing/sources'],['POST','https://owned.test/api/client-routing/sources'],['GET','https://foreign.test/api/client-routing/sources'],['GET','https://owned.test/api/client-routing/sources?extra=1']])await handler({request:()=>({method:()=>method,url:()=>url}),abort:async reason=>{assert.equal(reason,'failed');aborted++},fallback:async()=>fallback++});
 assert.deepEqual({aborted,seen,fallback},{aborted:1,seen:1,fallback:3});
});
