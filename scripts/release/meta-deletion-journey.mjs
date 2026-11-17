// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
import {isDeepStrictEqual} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {deletionRequire,deletionSafe} from './meta-deletion-dev-fixture.mjs';

// Value-free assertions: Playwright/SQL private values never become error props.
const assert=(value)=>deletionRequire(value,'JOURNEY_CONTRACT');
assert.equal=(a,b)=>assert(Object.is(a,b));assert.notEqual=(a,b)=>assert(!Object.is(a,b));
assert.deepEqual=(a,b)=>assert(isDeepStrictEqual(a,b));assert.match=(a,b)=>assert(typeof a==='string'&&b.test(a));

const sha=value=>createHash('sha256').update(value).digest('hex');
const hex=value=>typeof value==='string'&&/^[0-9a-f]{64}$/u.test(value);
const matches=(response,origin,path,method)=>new URL(response.url()).origin===origin&&new URL(response.url()).pathname===path&&response.request().method()===method;
export function validateMetaDeletionPages(input){try{return validatePageFields(input);}catch{throw Error('P11 PAGE_SCOPE');}}
function validatePageFields({platformPage,publicPage,origin,statusOrigin,refusalPolicyUrl}){
 for(const value of [origin,statusOrigin,refusalPolicyUrl]){const url=new URL(value);assert(!url.username&&!url.password&&!url.search&&!url.hash);}
 assert.equal(new URL(origin).origin,origin);assert(new URL(origin).protocol==='https:'||new URL(origin).protocol==='http:'&&new URL(origin).hostname==='127.0.0.1','Use exact admitted HTTPS or owned loopback forwarding');
 assert.equal(new URL(statusOrigin).protocol,'https:');assert.equal(new URL(statusOrigin).origin,statusOrigin);assert.equal(new URL(statusOrigin).pathname,'/');assert.equal(new URL(refusalPolicyUrl).protocol,'https:');
 assert.equal(new URL(platformPage.url()).origin,origin);assert.equal(new URL(publicPage.url()).origin,origin);
 assert.notEqual(platformPage.context(),publicPage.context(),'Separate admitted platform and cookie-free public contexts required');
}

/** Existing admitted Page handles only. Root verifies exact DEV source/images,
 * admission lease and fresh separate platform MFA before each mutation. No auth
 * bootstrap, storage export, server, mocked success or provider call is added.
 */
export async function runMetaDeletionDevJourney(input){return deletionSafe(()=>journey(input),'JOURNEY_STOPPED_NO_REPLAY');}
async function journey({platformPage,publicPage,origin,statusOrigin,refusalPolicyUrl,fixture,labels,verifyPlatform,admit,lease,capture,checkpoint}){
 validateMetaDeletionPages({platformPage,publicPage,origin,statusOrigin,refusalPolicyUrl});
 for(const value of [verifyPlatform,admit,lease,capture,checkpoint])assert.equal(typeof value,'function');
 assert(!['DEBUG','PWDEBUG','DEBUG_FILE','PW_TEST_TRACE_VIEWER','PW_TRACE_DIR'].some(key=>process.env[key]),'No traces or authentication/capability logging');
 const verify=async()=>{await admit();assert.equal(await verifyPlatform(platformPage),true,'Current separate platform actor/MFA verification failed');assert.equal(new URL(platformPage.url()).origin,origin);await lease();return{origin,verifiedAt:Date.now()};};
 const atBoundary=async binding=>{await lease();assert(binding.origin===origin&&new URL(platformPage.url()).origin===origin&&Date.now()-binding.verifiedAt>=0&&Date.now()-binding.verifiedAt<2000);};
 await verify();assert(!(await publicPage.context().cookies(origin)).some(cookie=>['wasalx_platform_session','__Host-wasalx_platform_session','wasalx_session','__Host-wasalx_session'].includes(cookie.name)),'Public context must carry neither platform nor tenant session');
 let phase='callback';const observations=[];
 try{
  const received=await fixture.dispatch('valid');assert.equal(received.status,200);const callback=received.body;
  assert(hex(callback.confirmation_code));const locator=callback.confirmation_code,url=new URL(callback.url);
  assert.equal(url.origin,statusOrigin);assert.equal(url.pathname,'/privacy/meta-deletion');assert.equal(url.search,'');assert.equal(url.hash,'#'+locator);
  const initial=await fixture.observe();assert(initial);assert.equal(initial.locator,locator);assert.equal(initial.state,'SCOPE_REVIEW_REQUIRED');assert.equal(Number(initial.version),1);
  const id=initial.id;assert.match(id,/^[0-9a-f-]{36}$/u);
  const section=platformPage.locator('#meta-deletion'),lookupPath='/api/platform-console/meta-deletion/lookup',reviewPath=`/api/platform-console/meta-deletion/${id}/review`;
  const showPublic=async(state,tag)=>{
   await admit();await publicPage.goto(origin+'/privacy/meta-deletion#'+locator);const main=publicPage.getByRole('main');
   await main.getByRole('heading',{name:labels.states[state],exact:true}).waitFor();assert.equal(new URL(publicPage.url()).hash,'');assert.equal(new URL(publicPage.url()).search,'');
   if(state==='REFUSED')assert.equal(await main.getByRole('link',{name:labels.policy,exact:true}).getAttribute('href'),refusalPolicyUrl);
   assert((await main.innerText()).includes(labels.states[state]));assert(!(await main.innerText()).includes(locator));
   await capture({page:publicPage,scope:main,tag,mask:[main.getByLabel(labels.code,{exact:true})]});
  };
  await showPublic('SCOPE_REVIEW_REQUIRED','p11-scope-review-required');
  phase='platform-lookup';await verify();await platformPage.goto(origin+'/platform#meta-deletion');await verify();
  const lookup=async()=>{await verify();await section.getByLabel(labels.code,{exact:true}).fill(locator);
   const wait=platformPage.waitForResponse(response=>matches(response,origin,lookupPath,'POST'));
   await section.getByRole('button',{name:labels.find,exact:true}).click();const response=await wait;assert(response.ok());
   assert.deepEqual(response.request().postDataJSON(),{code:locator});assert(!response.request().headers()['x-wasalx-tenant-id']);const page=await response.json();assert.equal(page.refusalAvailable,true);assert.equal(page.items.length,1);assert.equal(page.items[0].id,id);return page.items[0];};
  await lookup();
  // Unauthenticated public page cannot borrow the operator's cookie or CSRF.
  const unauthorized=await publicPage.evaluate(async({path,code})=>{const response=await fetch(path,{method:'POST',credentials:'omit',headers:{'content-type':'application/json'},body:JSON.stringify({code}),redirect:'error'});return response.status;},{path:lookupPath,code:locator});assert.equal(unauthorized,401);
  const evidence=Buffer.from(JSON.stringify({mode:'SYNTHETIC_DEV_SCOPE_REVIEW',namespace:fixture.namespace,fixtureSha256:fixture.fixtureSha256,authority:'NO_HUMAN_SUBJECT_TO_TENANT_MAPPING',claim:'This fixture does not prove legal retention or deletion completion'}));
  const evidenceSha256=sha(evidence);let version=1,lastIntent;
  const select=async state=>{await verify();await section.getByRole('button',{name:labels.review,exact:true}).click();await section.getByLabel(labels.disposition,{exact:true}).selectOption(state);
   await section.getByLabel(labels.evidence,{exact:true}).setInputFiles({name:'synthetic-p11-scope-review.json',mimeType:'application/json',buffer:evidence});};
  const submit=async(state,loss=false)=>{
   await select(state);let verifiedBinding=await verify();
   const owned=createDeletionReviewRoute({origin,path:reviewPath,version,state,evidenceSha256,loss,verify:()=>atBoundary(verifiedBinding),observe:fixture.reviewObserve,onIntent:intent=>{lastIntent=intent;}}),handler=owned.handler;
   await platformPage.route(origin+reviewPath,handler);
   try{
    const responseWait=loss?null:platformPage.waitForResponse(response=>matches(response,origin,reviewPath,'POST'));
    await section.getByRole('button',{name:labels.saveReview,exact:true}).focus();await atBoundary(verifiedBinding);await platformPage.keyboard.press('Enter');
    let response;if(loss){await owned.waitFirst();await section.getByRole('alert').filter({hasText:labels.reviewFailed}).waitFor();
     await platformPage.waitForFunction(text=>[...document.querySelectorAll('#meta-deletion button')].some(b=>b.textContent===text&&!b.disabled),labels.retry,{timeout:10000});
     const wait=platformPage.waitForResponse(value=>matches(value,origin,reviewPath,'POST'));verifiedBinding=await verify();await atBoundary(verifiedBinding);await section.getByRole('button',{name:labels.retry,exact:true}).click();response=await wait;}
    else{response=await responseWait;await owned.waitFirst();}
    assert(response.ok());const result=await response.json();assert.equal(result.id,id);assert.equal(result.state,state);assert.equal(Number(result.version),version+1);
    await owned.finish();if(loss){assert.deepEqual(result,owned.committed);assert.equal(owned.calls,2);}else assert.equal(owned.calls,1);
    version++;const row=await fixture.observe();assert.equal(row.state,state);assert.equal(Number(row.version),version);assert.equal(row.operation_count,version-1);assert.equal(row.review_audit_count,version-1);
    await capture({page:platformPage,scope:section,tag:'p11-review-'+state.toLowerCase(),mask:[section.getByLabel(labels.code,{exact:true})]});
    observations.push({state,version,requestCount:owned.calls,browserResponseLoss:loss,bffUpstreamBodyFault:false});
   }finally{await owned.cleanup(()=>platformPage.unroute(origin+reviewPath,handler));}
  };
  phase='needs-information';await submit('NEEDS_INFORMATION');await showPublic('NEEDS_INFORMATION','p11-needs-information');await lookup();
  phase='held-lost-response';await submit('HELD',true);await showPublic('HELD','p11-held');
  // A real stale review gets 409 and no second operation/audit. The CSRF value
  // comes only from the immediately preceding real UI request and stays memory-only.
  phase='stale-cas';const staleBinding=await verify();await atBoundary(staleBinding);const stale=await platformPage.evaluate(async({path,key,csrf,body})=>{const response=await fetch(path,{method:'POST',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'content-type':'application/json','idempotency-key':key,'x-wasalx-platform-csrf':csrf},body:JSON.stringify(body)});return response.status;},{path:reviewPath,key:randomUUID(),csrf:lastIntent.csrf,body:{...lastIntent.body,expectedVersion:1}});assert.equal(stale,409);
  const unchanged=await fixture.observe();assert.equal(Number(unchanged.version),version);assert.equal(unchanged.operation_count,version-1);
  phase='refused';await lookup();await submit('REFUSED');await showPublic('REFUSED','p11-refused');
  phase='callback-exact-replay';const replay=await fixture.dispatch('duplicate');assert.equal(replay.status,200);assert.deepEqual(replay.body,callback);
  const negativeBaseline=structuredClone(await fixture.observe());await fixture.verifyNegatives(negativeBaseline);
  phase='negative-wire';for(const kind of ['invalid-signature','wrong-mime','malformed','old-new']){const denied=await fixture.dispatch(kind);assert.equal(denied.status,400);await fixture.verifyNegatives(negativeBaseline);}
  await fixture.verifyNoEffects();await checkpoint({phase:'p11-dev-journey-observed',namespace:fixture.namespace,receiptId:id,fixtureSha256:fixture.fixtureSha256,locatorSha256:sha(locator),observations});
  return{evidenceMode:'simulated',providerMode:'SIGNED_SYNTHETIC_CALLBACK',runtimeSurface:'INSTALLED_DEV',namespace:fixture.namespace,receiptId:id,fixtureSha256:fixture.fixtureSha256,locatorSha256:sha(locator),observations,
   claims:['Actual installed signed synthetic callback and explicit duplicate','Actual separate operator review/CAS plus browser response loss after server commit','Actual public status and immutable policy link, no automatic tenant deletion'],
   notProven:['Real Meta delivery/registered HTTPS/MIME/retry/secret rotation','Lawful policy or human ASID grant association','Elapsed status expiry/minimization: reuse exact-source canonical evidence, never clock override DEV','BFF upstream-body fault or whole P11/goal completion']};
 }catch{await checkpoint({phase:'p11-dev-journey-stopped',stage:phase,namespace:fixture.namespace});throw Error('P11 DEV journey stopped; preserve original intent/outcomes and reconcile readonly before any next action');}
}

// One owned intercepted review, including handler completion and cleanup. Not a
// general transport helper; no retry is admitted until known commit + abort.
export function createDeletionReviewRoute({origin,path,version,state,evidenceSha256,loss,verify,observe,onIntent}){
 let calls=0,original,committed,failed=false,cancelled=false,resolveFirst,rejectFirst;
 const first=new Promise((resolve,reject)=>{resolveFirst=resolve;rejectFirst=reject;});first.catch(()=>{});
 const tasks=new Set(),paused=new Set();let deadline;
 const stopped=()=>Error('P11 REVIEW_HANDLER_STOPPED_NO_REPLAY');
 const cancel=()=>{cancelled=true;failed=true;rejectFirst(stopped());};
 const current=()=>{if(cancelled||Date.now()>=deadline)throw stopped();};
 // Route.abort/continue have no Playwright deadline. Bound the entire owned
 // operation, keep late rejection observed, and never undo cancellation.
 const bounded=async(work,ms,quiet=false)=>{let timer;
  const pending=Promise.resolve().then(work);pending.catch(()=>{});
  try{return await Promise.race([pending,new Promise((resolve,reject)=>{timer=setTimeout(()=>{cancel();if(quiet)resolve();else reject(stopped());},Math.max(1,ms));})]);}
  finally{clearTimeout(timer);}
 };
 const remaining=()=>Math.max(1,(deadline??Date.now())-Date.now());
 const handler=route=>{
  const task=(async()=>{let settled=false;paused.add(route);try{
   if(cancelled)throw stopped();deadline=Date.now()+8000;
   current();calls++;const request=route.request(),url=new URL(request.url());assert(url.origin===origin&&url.pathname===path&&!url.search&&!url.hash&&request.method()==='POST');
   const intent={path,key:request.headers()['idempotency-key'],body:request.postDataJSON()};assert.match(intent.key,/^[0-9a-f-]{36}$/u);
   assert.deepEqual(intent.body,{expectedVersion:version,state,reason:state==='REFUSED'?'LAWFUL_RETENTION':state==='HELD'?'OUTCOME_UNRESOLVED':'SCOPE_EVIDENCE_REQUIRED',evidenceSha256});
   assert(!request.headers()['x-wasalx-tenant-id']&&request.headers()['x-wasalx-platform-csrf']);
   if(calls===1){original=intent;onIntent({...intent,csrf:request.headers()['x-wasalx-platform-csrf']});}
   else assert(loss&&calls===2&&isDeepStrictEqual(intent,original));
   // Heavy runtime/JWT verification occurred before UI submission. This is the
   // finite prepared binding and local lease only; cancellation is rechecked
   // immediately after it, before either independent fetch or continuation.
   await verify();current();
   if(loss&&calls===1){
    const response=await route.fetch({maxRedirects:0,maxRetries:0,timeout:Math.max(1,deadline-Date.now())});current();assert(response.url()===origin+path&&response.status()===200);
    committed=await response.json();current();const row=await observe();current();assert(Number(row.version)===version+1&&row.state===state);
    await bounded(()=>route.abort('failed'),remaining());settled=true;resolveFirst();return;
   }
   await bounded(()=>{current();return route.continue();},remaining());settled=true;if(calls===1)resolveFirst();
  }catch{cancel();if(!settled)void Promise.resolve().then(()=>route.abort('failed')).catch(()=>{});settled=true;rejectFirst(stopped());
  }finally{paused.delete(route);}})();tasks.add(task);void task.then(()=>tasks.delete(task),()=>tasks.delete(task));return task;
 };
 return{handler,get calls(){return calls;},get committed(){return committed;},
  async waitFirst(){let timer;try{await Promise.race([first,new Promise((_,reject)=>{timer=setTimeout(()=>{cancel();reject(Error('P11 REVIEW_HANDLER_TIMEOUT_NO_REPLAY'));},8000);})]);}finally{clearTimeout(timer);}},
  async finish(){assert(!failed&&!cancelled);await bounded(()=>Promise.all([...tasks]),remaining());assert(!failed&&!cancelled);},
  async cleanup(unroute=async()=>{}){cancel();
   // Abort, task settlement and owned unroute all start inside one 500ms race.
   // Late protocol acknowledgements cannot dispatch or authorize a retry.
   await bounded(()=>Promise.allSettled([
    ...[...paused].map(route=>Promise.resolve().then(()=>route.abort('failed'))),
    ...tasks,Promise.resolve().then(unroute),
   ]),500,true);}};
}
