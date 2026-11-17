import test from'node:test';import assert from'node:assert/strict';import{EventEmitter}from'node:events';import{rulePreviewResults,observeRulePreviewRequests,rulePreviewPreSubmitDiagnostic,rulePreviewEvaluator}from'../scripts/release/simulation-rule-preview.mjs';
const at='2026-09-13T00:00:00Z',rows=(a,b,c,d)=>[{result:a},{result:b},{result:c},{result:d}];
test('rule preview maps customer, team, and unresolved sender comparisons to the policy leaf',()=>{assert.deepEqual(rulePreviewResults(rows('passed','passed','passed','passed'),at).map(x=>x.result),['passed','passed']);assert.deepEqual(rulePreviewResults(rows('passed','passed','passed','failed'),at).map(x=>x.result),['failed','passed']);assert.deepEqual(rulePreviewResults(rows('passed','failed','passed','passed'),at).map(x=>x.result),['passed','failed']);assert.deepEqual(rulePreviewResults(rows('blocked','passed','passed','passed'),at).map(x=>x.result),['blocked','blocked']);});
test('pre-submit diagnostics retain step and bounded request/UI state without URL or content',async()=>{
 const page=new EventEmitter(),origin='http://127.0.0.1:43687';
 page.evaluate=async()=>({readyState:'interactive',appReady:true,senderPresent:true});
 page.locator=selector=>{assert.equal(selector,'#rule-test-sample');return{count:async()=>1}};page.getByRole=()=>({count:async()=>1});page.url=()=>origin+'/app?view=rules&private=omitted';
 const observer=observeRulePreviewRequests(page,origin),request=(path,method='GET')=>({url:()=>origin+path,method:()=>method});
 const doc=request('/app?view=rules'),api=request('/api/workspaces'),post=request('/api/rules/test','POST');
 page.emit('request',doc);page.emit('response',{request:()=>doc,status:()=>200});page.emit('requestfinished',doc);
 page.emit('request',api);page.emit('response',{request:()=>api,status:()=>503});page.emit('requestfailed',api);page.emit('request',post);
 const result=await rulePreviewPreSubmitDiagnostic(page,{step:'select-sender',stepStartedAt:Date.now(),navigationStatus:200,requestLifecycle:observer.snapshot()});observer.close();
 assert.equal(typeof result.stepDurationMs,'number');delete result.stepDurationMs;assert.deepEqual(result,{step:'select-sender',navigationStatus:200,requestLifecycle:{documentRequests:1,documentFinished:1,documentFailed:0,documentResponseStatus:200,apiRequests:1,apiFailed:1,apiErrorResponses:1,previewPosts:1},ui:{readyState:'interactive',appReady:true,senderPresent:true,sampleCount:1,buttonCount:1,onRulesView:true}});
 assert.equal(JSON.stringify(result).includes('private=omitted'),false);assert.equal(page.listenerCount('request'),0);
 const unavailable=await rulePreviewPreSubmitDiagnostic({evaluate:async()=>{throw Error('private page content');}},{step:'navigate-rules',stepStartedAt:Date.now(),navigationStatus:null,requestLifecycle:observer.snapshot()});
 assert.deepEqual(unavailable.uiUnavailable,true);assert.equal(JSON.stringify(unavailable).includes('private page content'),false);
});

test('worker parity runs against the packaged connector-worker matcher',()=>{const control='a'.repeat(64),worker='b'.repeat(64);assert.equal(rulePreviewEvaluator({'control-api':{Id:control},'connector-worker':{Id:worker}}),worker);assert.throws(()=>rulePreviewEvaluator({'control-api':{Id:control}}),/connector-worker/);});
