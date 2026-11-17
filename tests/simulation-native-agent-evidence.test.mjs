import{readFileSync}from'node:fs';import{runInNewContext}from'node:vm';
import test from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';
import{captureNativeAgentEvidence,nativeAgentBinding,bindNativeAgentResult,ensureNativeAgent,observeNativeLogin}from'../scripts/release/simulation-native-agent.mjs';
import{collectNativeBusinessContexts}from'../scripts/release/simulation-native-business-contexts.mjs';
const actor={id:4,roles:[2],locale:'en-US'},viewport={width:390,height:844},digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
test('native failed requests retain bounded resource diagnostics without private URLs',async()=>{
 const listeners=new Map(),privatePath='/assets/PRIVATE_CANARY.js',page={on:(name,fn)=>listeners.set(name,fn),off:name=>listeners.delete(name),url:()=> 'http://native.test/desktop/login',evaluate:async()=> 'complete',getByRole:()=>({count:async()=>0,isVisible:async()=>false}),locator:()=>({count:async()=>0})};
 const observer=observeNativeLogin(page),request={failure:()=>({errorText:'net::ERR_NETWORK_CHANGED'}),url:()=> 'http://native.test'+privatePath+'?token=PRIVATE_CANARY',method:()=> 'GET',resourceType:()=> 'script'};
 for(let i=0;i<12;i++)listeners.get('requestfailed')(request);
 const result=await observer.snapshot('username-actionable');observer.stop();assert.equal(listeners.size,0);assert.equal(result.requestFailures.length,10);assert.equal(result.requestFailureCodes.length,10);
 const proof=result.requestFailures[0];assert.equal(proof.code,'net::ERR_NETWORK_CHANGED');assert.equal(proof.method,'GET');assert.equal(proof.resourceType,'script');assert.equal(proof.sameOrigin,true);assert.equal(proof.pathSha256,createHash('sha256').update(privatePath).digest('hex'));assert(Number.isFinite(Date.parse(proof.recordedAt)));assert(!JSON.stringify(result).includes('PRIVATE_CANARY'));assert(!JSON.stringify(result).includes('native.test'));
});
test('native binding captures current dedicated agent and actual page viewport; admin and drift fail closed',async()=>{
 let read=0,current=actor,size=viewport;const page={evaluate:async()=>{read++;return current},viewportSize:()=>size};
 const proof=await captureNativeAgentEvidence(page,4,'tenant');assert.equal(read,1);assert.equal(proof.actorRef,digest('zammad:4'));assert.equal(proof.tenantRef,digest('tenant'));assert.deepEqual(proof.actualViewport,viewport);assert.deepEqual(proof.verifiedContext.nativeActor,actor);
 const raw={testId:'one',contextId:'zammad_agent-en-mobile',result:'failed',proof:{errorHash:'x'}};const row=bindNativeAgentResult(raw,proof);assert.equal(row.result,'failed');assert.equal(row.proof.errorHash,'x');assert.equal(row.proof.actorVerified,true);assert.equal(raw.proof.actorVerified,undefined);
 assert.throws(()=>bindNativeAgentResult({...raw,actualViewport:{width:1440,height:1000}},proof),/viewport drift/);
 assert.throws(()=>bindNativeAgentResult(raw,{...proof,verifiedContext:{...proof.verifiedContext,nativeActor:{...actor,roles:[1,2]}}}),/admin role/);
 for(const bad of[{...actor,roles:[1,2]},{...actor,id:9},{...actor,locale:'ar'}]){current=bad;await assert.rejects(captureNativeAgentEvidence(page,4,'tenant'));}
 assert.throws(()=>nativeAgentBinding(actor,null,'tenant'));assert.throws(()=>nativeAgentBinding(actor,viewport,''));
});
test('business collector binds actual observation before checkpoint without replacing a failure or hiding viewport drift',async()=>{
 const context={contextId:'zammad_agent-en-mobile',surface:'mobile',viewport},events=[],binding=nativeAgentBinding(actor,viewport,'tenant');
 const results=await collectNativeBusinessContexts({contexts:[context],testIds:['one'],observe:async()=>{events.push('observe');throw Error('private selector')},verifyContext:async()=>{events.push('verify');return binding},checkpoint:async row=>{events.push('record');assert.equal(row.actorRef,binding.actorRef)},phase:'native'});
 assert.deepEqual(events,['observe','verify','record']);assert.equal(results[0].result,'failed');assert(!JSON.stringify(results).includes('private selector'));assert.equal(results[0].proof.actorVerified,true);
 await assert.rejects(collectNativeBusinessContexts({contexts:[context],testIds:['one'],observe:async()=>({one:{}}),verifyContext:async()=>nativeAgentBinding(actor,{width:1440,height:1000},'tenant'),checkpoint:async row=>assert.equal(row.verifiedContext,undefined,'must not persist a qualified mismatched pass'),phase:'native'}));
});

test('current collector completion window includes the actual identity readback',async()=>{
 const context={contextId:'zammad_agent-en-mobile',surface:'mobile',viewport};let verifiedAt;
 const rows=await collectNativeBusinessContexts({contexts:[context],testIds:['one'],observe:async()=>({one:{uiObserved:true}}),verifyContext:async()=>{await new Promise(resolve=>setTimeout(resolve,12));verifiedAt=new Date().toISOString();return nativeAgentBinding(actor,viewport,'tenant')},checkpoint:async()=>{},phase:'native'});
 assert(Date.parse(rows[0].finishedAt)>=Date.parse(verifiedAt));assert(Date.parse(rows[0].startedAt)<=Date.parse(verifiedAt));
});

test('lost identity preserves the original failed assertion as unqualified evidence before stopping',async()=>{
 const seen=[],context={contextId:'zammad_agent-en-mobile',surface:'mobile',viewport};
 await assert.rejects(collectNativeBusinessContexts({contexts:[context],testIds:['one'],observe:async()=>{throw Error('private UI failure')},verifyContext:async()=>{throw Error('private actor failure')},checkpoint:async row=>seen.push(row),phase:'native'}),/private actor failure/);
 assert.equal(seen.length,1);assert.equal(seen[0].result,'failed');assert.equal(seen[0].verifiedContext,undefined);assert.equal(seen[0].proof.reason,'Native UI assertion failed');assert(seen[0].proof.actorBindingFailure);assert(!JSON.stringify(seen).includes('private'));
});

test('actual quality record boundaries retain original failure when identity disappears without a duplicate retry',async()=>{
 for(const [file,end]of[['simulation-native-email-quality.mjs',' const requestFailures=']])for(const lost of[false,true]){
  const source=readFileSync(new URL('../scripts/release/'+file,import.meta.url),'utf8'),start=source.indexOf(' const record='),stop=source.indexOf(end,start),rows=[];assert(start>=0&&stop>start);let reads=0;
  const page={evaluate:async()=>{reads++;return{...actor,roles:lost?[1,2]:[2]}},viewportSize:()=>viewport},prefix='native-test',testDefinitions=[{id:prefix+'::ui-quality::reload'}],context={contextId:'zammad_agent-en-mobile',viewport,surface:'mobile'};
  const record=runInNewContext(source.slice(start,stop)+';record',{captureNativeAgentEvidence,bindNativeAgentResult,assert,createHash,page,expectedActorId:4,tenantId:'tenant',viewport,context,contextId:context.contextId,surface:'mobile',prefixes:[prefix],results:[],testDefinitions,ticketId:1,articleId:2,checkpoint:async row=>rows.push(row),digest:value=>createHash('sha256').update(String(value)).digest('hex')});
  const call=()=>record('reload','failed',{errorClass:'TimeoutError',errorHash:'original'},new Date().toISOString());if(lost)await assert.rejects(call());else await call();
  assert.equal(reads,1);assert.equal(rows.length,1);assert.equal(rows[0].result,'failed');assert.equal(rows[0].proof.errorHash,'original');assert.equal(Boolean(rows[0].verifiedContext),!lost);assert.equal(rows[0].proof.actorVerified,lost?undefined:true);if(lost)assert(rows[0].proof.actorBindingFailure);
 }
});





test('native username timeout retains safe phase, original error and closes owned context',async()=>{
 const canary='PRIVATE_CANARY',events=[],failure=Object.assign(Error(canary),{name:'TimeoutError'}),listeners=new Map();
 const page={on(name,fn){listeners.set(name,fn)},off(name){listeners.delete(name)},url(){return'http://native.test/desktop/login?secret='+canary},setDefaultTimeout(){},setDefaultNavigationTimeout(){},async goto(){},getByRole(_,{name}){return{async fill(){events.push(name);throw failure},async count(){return 0},async isVisible(){return false}}},locator(){return{async count(){return 0}}},async evaluate(){return'complete'}};
 const context={async newPage(){return page},async close(){events.push('close')}};
 const checkpoints=[];const session={capabilities:{},model:{services:{'zammad-runtime-bootstrap':{environment:{WASALX_ZAMMAD_AGENT_EMAIL:'private@example.test',WASALX_ZAMMAD_AGENT_PASSWORD:canary}}}},nativePage:{async evaluate(){return 4}},browser:{async newContext(){return context}},contexts:[],nativeOrigin:'http://native.test',checkpoint:async x=>checkpoints.push(x)};
 await assert.rejects(ensureNativeAgent(session),error=>error===failure);assert.deepEqual(events,['Username / Email','close']);assert.equal(session.contexts.length,0);assert.equal(listeners.size,0);
 const receipt=checkpoints.find(x=>x.phase==='native-agent-login-diagnostic');assert.equal(receipt.path,'/desktop/login');assert.equal(receipt.diagnosticPhase,'native-agent-username-actionable');assert.equal(receipt.usernameCount,0);assert(!JSON.stringify(receipt).includes(canary));assert(!JSON.stringify(receipt).includes('private@example.test'));
});

test('scoped native navigation diagnostics keep only document/static failures and no URL values',async()=>{
 const listeners=new Map(),secret='PRIVATE_NAV_CANARY',page={on:(name,fn)=>listeners.set(name,fn),off:name=>listeners.delete(name),url:()=> 'http://native.test/desktop/tickets/8?secret='+secret,evaluate:async()=> 'complete',getByRole:()=>({count:async()=>0,isVisible:async()=>false}),locator:()=>({count:async()=>0})};
 const observer=observeNativeLogin(page,{resourceTypes:['document','script','stylesheet']});
 const request=type=>({failure:()=>({errorText:'net::ERR_NETWORK_CHANGED'}),url:()=> 'http://native.test/assets/'+secret+'.js?token='+secret,method:()=> 'GET',resourceType:()=>type});
 listeners.get('requestfailed')(request('xhr'));listeners.get('requestfailed')(request('script'));
 const proof=await observer.snapshot('loading-normal-action');observer.stop();
 assert.equal(proof.requestFailures.length,1);assert.equal(proof.requestFailures[0].resourceType,'script');assert.equal(proof.requestFailures[0].code,'net::ERR_NETWORK_CHANGED');assert(!JSON.stringify(proof).includes(secret));assert.equal(listeners.size,0);
});
