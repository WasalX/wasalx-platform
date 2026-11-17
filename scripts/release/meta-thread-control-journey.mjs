// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
import assert from 'node:assert/strict';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const match=(response,origin,path,method)=>new URL(response.url()).origin===origin&&new URL(response.url()).pathname===path&&response.request().method()===method;

/** Existing authenticated owner Page plus fixed actual-stack adapters. No login,
 * SQL ownership setter, provider query endpoint, resend or new scheduler. */
export async function runMetaThreadControlJourney({page,origin,tenantId,connectionId,conversationId,ticketNumber,recipient,mode,labels,
 assertAdmission,verifyOwner,providerControl,observe,checkpoint,poll}){
 assert(['known-and-browser-loss','provider-unknown','malformed-rejection'].includes(mode));
 for(const id of [tenantId,connectionId,conversationId])assert(uuid(id));assert.equal(new URL(page.url()).origin,origin);
 const path=`/api/bot-flows/conversations/${conversationId}/meta-thread-control`,storageKey=`wasalx.meta.thread-hold:${tenantId}:${conversationId}`;
 const admit=async()=>{await assertAdmission();await verifyOwner();};
 const read=async(key)=>page.evaluate(async({path,key})=>{const response=await fetch(path,{credentials:'same-origin',cache:'no-store',redirect:'error',
  headers:key?{'idempotency-key':key}:{},signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('Thread read unavailable');return response.json();},{path,key});
 const open=async()=>{
  await page.goto(origin+'/app?view=automation',{waitUntil:'domcontentloaded'});await admit();
  await page.locator('[data-application-ready="true"]').waitFor({state:'visible',timeout:20000});
  await page.getByRole('tab',{name:labels.conversations,exact:true}).click();
  const row=page.locator('.bot-conversation-list > article').filter({hasText:String(ticketNumber)});
  // The manifest's exact conversation/ticket is checked by the real GET below;
  // duplicate display matches are denied instead of selecting the first one.
  assert.equal(await row.count(),1,'Owned conversation row is unavailable or ambiguous');
  const reading=page.waitForResponse(response=>match(response,origin,path,'GET'),{timeout:25000});
  await row.getByRole('button',{name:labels.inspect,exact:true}).click();const response=await reading;assert(response.ok());
  const view=await response.json();assert.equal(view.connectionId,connectionId);
  return page.getByRole('dialog',{name:labels.threadTitle,exact:true});
 };
 await admit();const before=await observe();assert.equal(before.unresolvedActions,0);assert.equal(before.claim,'OWN');
 const providerBefore=await providerControl('GET','/routing');assert.equal(providerBefore.evidenceClass,'simulated-thread-control');assert.equal(providerBefore.owners[recipient],'OWN');
 assert(providerBefore.fixture.roles.includes('escalation')&&providerBefore.fixture.targets.includes('ai_agent'));
 const internal=before.internal;
 let dialog=await open(),postCount=0;
 const count=request=>{if(new URL(request.url()).origin===origin&&new URL(request.url()).pathname===path&&request.method()==='POST')postCount++;};page.on('request',count);
 const safe=async()=>{const facts=await observe();assert.deepEqual(facts.internal,internal,'External routing changed WasalX handoff/assignment/pause state');return facts;};
 const execute=async(action,{target,loseBrowserResponse=false,expected='SUCCEEDED'}={})=>{
  await admit();const refresh=page.waitForResponse(response=>match(response,origin,path,'GET'),{timeout:25000});
  await dialog.getByRole('button',{name:labels.refresh,exact:true}).click();const refreshed=await refresh;assert(refreshed.ok());
  const snapshot=await refreshed.json();assert(snapshot.availability.actions.includes(action));
  const body={action,...(target?{targetRole:target}:{}),expectedRoutingEpoch:snapshot.ownership.epoch,
   expectedConfigurationVersion:snapshot.ownership.configurationVersion,expectedReviewVersion:snapshot.ownership.reviewVersion};
  const countBefore=postCount;let intercepted;
  const fault=async route=>{if(route.request().method()!=='POST'){await route.continue();return;}assert.equal(intercepted,undefined,'Unexpected replay');
   const response=await route.fetch();assert(response.ok());intercepted={key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON(),result:await response.json()};
   await route.abort('failed');};
  if(loseBrowserResponse)await page.route(origin+path,fault);
  const responseWait=loseBrowserResponse?null:page.waitForResponse(response=>match(response,origin,path,'POST'),{timeout:25000});
  const original=page.waitForRequest(request=>new URL(request.url()).origin===origin&&new URL(request.url()).pathname===path&&request.method()==='POST',{timeout:25000});
  try{
   await dialog.getByRole('button',{name:labels.actions[action],exact:true}).click();
   if(target)await dialog.getByLabel(labels.target,{exact:true}).selectOption(target);
   await checkpoint({phase:'intent',step:'thread-'+action,conversationId,expectedRoutingEpoch:body.expectedRoutingEpoch});
   await dialog.getByRole('button',{name:labels.confirm,exact:true}).focus();await page.keyboard.press('Enter');
   const request=await original,key=request.headers()['idempotency-key'];assert(uuid(key));assert.deepEqual(request.postDataJSON(),body);
   await checkpoint({phase:'thread-original-intent',conversationId,key,command:body});
   let result;
   if(responseWait){const response=await responseWait;assert(response.ok(),'Control outcome unavailable; do not replay');result=await response.json();}
   else{await dialog.getByText(labels.outcomeHold,{exact:true}).waitFor({state:'visible',timeout:25000});assert(intercepted);assert.equal(intercepted.key,key);assert.deepEqual(intercepted.body,body);result=intercepted.result;}
   assert.equal(result.state,expected);assert.equal(result.action,action);assert.equal(result.targetRole,target??null);assert.equal(result.retryable,false);assert(uuid(result.id));
   if(expected==='SUCCEEDED')assert(typeof result.requestId==='string'&&result.requestId.length>0);
   const correlated=await read(key);assert.equal(correlated.correlation?.state,'MATCHED');assert.deepEqual(correlated.correlation.command,body);assert.deepEqual(correlated.correlation.action,result);
   const facts=await safe();assert.equal(facts.actions.filter(a=>a.id===result.id&&a.idempotency_key===key).length,1);
   const provider=await providerControl('GET','/routing');const attempted=provider.attempts.filter(a=>a.body.metadata===result.id);assert.equal(attempted.length,1,'Provider request must be one-shot');
   assert.equal(attempted[0].body.action,action);assert.equal(attempted[0].body.to??attempted[0].body.recipient,recipient);
   if(expected==='SUCCEEDED')assert.equal(provider.receipts.filter(r=>r.requestId===result.requestId&&r.body.metadata===result.id).length,1);
   if(loseBrowserResponse){
    assert(await page.evaluate(key=>sessionStorage.getItem(key)!==null,storageKey),'Actual transport loss must preserve local original intent');
    dialog=await open();await poll(()=>page.evaluate(key=>sessionStorage.getItem(key),storageKey),value=>value===null);
    assert.equal((await read(key)).correlation.action.state,'SUCCEEDED');assert.equal(postCount,countBefore+1,'Reload/readback must not resend');
   }else if(expected==='OUTCOME_UNKNOWN'){
    assert(await page.evaluate(key=>sessionStorage.getItem(key)!==null,storageKey));
    dialog=await open();assert(await page.evaluate(key=>sessionStorage.getItem(key)!==null,storageKey));
    await dialog.getByRole('button',{name:labels.refresh,exact:true}).click();
    assert.equal((await read(key)).correlation.action.state,'OUTCOME_UNKNOWN');assert.equal(postCount,countBefore+1);
    for(const name of Object.values(labels.actions))assert.equal(await dialog.getByRole('button',{name,exact:true}).count(),0);
    assert.deepEqual(await providerControl('GET','/routing'),provider,'Read-only recovery cannot replay or settle private acceptance');
   }
   await checkpoint({phase:'thread-original-readback',conversationId,actionId:result.id,state:result.state,key,providerAttempts:1,automaticReplayObserved:false});
   return{result,key,body,provider};
  }finally{if(loseBrowserResponse)await page.unroute(origin+path,fault);}
 };
 try{
  if(mode==='known-and-browser-loss'){
   await execute('release');assert.equal((await read()).ownership.claim,'IDLE');
   await execute('take');assert.equal((await read()).ownership.claim,'OWN');
   await execute('pass',{target:'ai_agent'});assert.equal((await read()).ownership.claim,'STANDBY');
   await execute('take');assert.equal((await read()).ownership.claim,'OWN');
   await providerControl('POST','/routing/fault',{id:'known-reject-'+conversationId,action:'release',recipient,mode:'reject'});
   await execute('release',{expected:'FAILED'});assert.equal((await read()).ownership.claim,'OWN');
   await execute('release',{loseBrowserResponse:true});assert.equal((await read()).ownership.claim,'IDLE');
   await execute('take');assert.equal((await read()).ownership.claim,'OWN');
  }else{
   await providerControl('POST','/routing/fault',{id:mode+'-'+conversationId,action:'release',recipient,
    mode:mode==='provider-unknown'?'disconnect-after-acceptance':'malformed-rejection'});
   const unknown=await execute('release',{expected:'OUTCOME_UNKNOWN'});
   const receipts=unknown.provider.receipts.filter(r=>r.body.metadata===unknown.result.id);
   assert.equal(receipts.length,mode==='provider-unknown'?1:0);
   assert.equal((await read()).ownership.allowed,false);assert.equal((await safe()).unresolvedActions,1);
  }
  await safe();let explicitlyResumed=false;
  if(mode==='known-and-browser-loss'){
   const original=await safe();assert.equal(original.internal.state,'HUMAN');assert.equal((await read()).ownership.claim,'OWN');
   const provider=await providerControl('GET','/routing');await dialog.getByRole('button',{name:labels.close,exact:true}).last().click();
   const row=page.locator('.bot-conversation-list > article').filter({hasText:String(ticketNumber)});assert.equal(await row.count(),1);
   await row.getByRole('button',{name:labels.resume,exact:true}).click();
   const confirm=page.getByRole('dialog',{name:labels.resumeTitle,exact:true}),commandPath=`/api/bot-flows/conversations/${conversationId}/command`;
   await admit();await checkpoint({phase:'intent',step:'explicit-resume-bot',conversationId});
   const pending=page.waitForResponse(response=>match(response,origin,commandPath,'POST'),{timeout:25000});
   await confirm.getByRole('button',{name:labels.resume,exact:true}).click();const response=await pending;assert(response.ok());
   assert.deepEqual(response.request().postDataJSON(),{action:'RESUME_BOT',expectedFencingToken:original.fencingToken});
   const result=await response.json();assert.equal(result.state,'BOT');assert.equal(result.command,'RESUME_BOT');
   const resumed=await observe();assert.equal(resumed.internal.state,'BOT');assert.equal(resumed.resumedCount,original.resumedCount+1);
   assert.equal(resumed.fencingToken,original.fencingToken+1);assert.equal(resumed.claim,'OWN');
   assert.deepEqual({...resumed.internal,state:'HUMAN'},original.internal,'Explicit local resume must not alter native assignment or routing');
   assert.deepEqual(await providerControl('GET','/routing'),provider,'There is no provider resume request');explicitlyResumed=true;
  }
  return{evidenceMode:'simulated',mode,connectionId,conversationId,actualControlPosts:postCount,
   automaticReplayObserved:false,externalControlsPreservedInternalOwnership:true,explicitlyResumed,retainedUnknown:mode!=='known-and-browser-loss',liveProviderEvidence:false};
 }finally{page.off('request',count);}
}
