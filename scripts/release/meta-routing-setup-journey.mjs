// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
import assert from 'node:assert/strict';

// The existing form represents minutes. Wait for a real representable instant
// after this declaration; never change its timestamp or enter a future instant.
export async function captureRoutingObservation({declaredAt,observe,assertAdmission,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 const declared=Date.parse(declaredAt);assert(Number.isFinite(declared)&&declared>0&&declared<=now());
 const boundary=Math.ceil(declared/60000)*60000;
 if(now()<boundary){const delay=boundary-now();assert(delay<=60000);await sleep(delay);}
 await assertAdmission();const instant=now();assert(instant>=boundary);
 const observation=await observe();const observedAt=new Date(Math.floor(instant/60000)*60000).toISOString();
 assert(Date.parse(observedAt)>=declared&&Date.parse(observedAt)<=now());
 return{...observation,observedAt};
}

const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const matches=(response,origin,path,method)=>new URL(response.url()).origin===origin&&new URL(response.url()).pathname===path&&response.request().method()===method;
const read=async(page,origin,path)=>{
 assert.equal(new URL(page.url()).origin,origin);
 return page.evaluate(async path=>{
  const response=await fetch(path,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('Routing read unavailable');return response.json();
 },path);
};

// Existing owner API only, on the admitted fresh synthetic connection. A fixed
// handoff-only flow makes internal noninterference observable without sending.
export async function prepareRoutingHandoff({request,assertAdmission,connectionId,nativeGroupId,namespace}){
 assert(uuid(connectionId));assert(/^[1-9][0-9]*$/u.test(String(nativeGroupId)));assert(/^[A-Za-z0-9_-]{1,80}$/u.test(namespace));
 await assertAdmission();const existing=await request('/api/bot-flows/assignments');
 assert.equal(existing.filter(row=>row.connection_id===connectionId).length,0,'Never overwrite an existing assignment');
 await assertAdmission();const flow=await request('/api/bot-flows','POST',{schemaVersion:1,name:'Routing handoff '+namespace,start:'handoff',maxSteps:3,
  nodes:[{id:'handoff',type:'handoff',target:'CLIENT_PRIMARY',priority:'2 normal'}]},'routing-flow');
 assert(uuid(flow.id)&&uuid(flow.familyId));
 await assertAdmission();await request('/api/bot-flows/'+flow.id+'/activate','POST',{expectedRevision:Number(flow.revision),expectedActiveFlowVersionId:null},'routing-flow-activate');
 await assertAdmission();const assignment=await request('/api/bot-flows/assignments','POST',{connectionId,familyId:flow.familyId,
  zammadGroupId:String(nativeGroupId),agentPrefix:'Agent',agentIdentityPlacement:'OFF'},'routing-assignment');
 const rows=(await request('/api/bot-flows/assignments')).filter(row=>row.connection_id===connectionId);
 assert.equal(rows.length,1);assert.equal(rows[0].id,assignment.assignmentId);assert.equal(rows[0].flow_version_id,flow.id);
 assert.equal(rows[0].state,'ACTIVE');assert.equal(String(rows[0].zammad_group_id),String(nativeGroupId));return assignment;
}

/** Already authenticated, separately owned tenant/platform pages only. This helper
 * does not log in, create actors, alter routing in SQL, or manufacture provider UI
 * proof. Root supplies the admitted synthetic observation and private runtime
 * checks. No fixture interception, retry, browser launch or CLI autorun. */
export async function runAuthenticatedMetaRoutingSetup({ownerPage,operatorPage,origin,tenantId,tenantName,connectionId,sessionId,
 expectedRuntime,phoneNumberId,accountId,captureObservation,labels,assertAdmission,verifyOwner,verifyOperator,readPersisted,checkpoint}){
 for(const id of [tenantId,connectionId,sessionId])assert(uuid(id));
 assert.notEqual(ownerPage.context(),operatorPage.context(),'Tenant and platform sessions must remain separate');
 assert.equal(expectedRuntime.mode,'SIMULATED','This helper does not attest live Meta settings');
 assert.match(expectedRuntime.simulationBindingSha256,/^[a-f0-9]{64}$/u);
 for(const callback of [assertAdmission,verifyOwner,verifyOperator,readPersisted,checkpoint,captureObservation])assert.equal(typeof callback,'function');
 const current=async()=>{await assertAdmission();await verifyOwner();await verifyOperator();};
 await current();
 const tenantPath=`/api/connections/${connectionId}/meta/routing`;
 const operatorPath=`/api/platform-console/operations/tenants/${tenantId}/connections/${connectionId}/meta-routing-review`;
 const before=await read(ownerPage,origin,tenantPath);
 assert.equal(before.sessionId,sessionId);assert.equal(before.configurationVersion,0);assert.equal(before.reviewVersion,0);
 assert.equal(before.declared,null);assert.equal(before.observed,null);
 assert.equal(before.readiness,'REVIEW_REQUIRED','Fresh enrolled asset must not use legacy compatibility');
 await ownerPage.goto(origin+'/app?view=connections&connection='+connectionId,{waitUntil:'domcontentloaded'});
 const section=ownerPage.locator('section[aria-labelledby="meta-routing-title"]');await section.waitFor({state:'visible',timeout:20000});
 await current();await checkpoint({phase:'intent',step:'routing-declaration',connectionId});
 const declaredWait=ownerPage.waitForResponse(response=>matches(response,origin,tenantPath,'POST'),{timeout:25000});
 await section.getByRole('button',{name:labels.declare,exact:true}).focus();await ownerPage.keyboard.press('Enter');
 const declaredResponse=await declaredWait;assert(declaredResponse.ok(),'Declaration unconfirmed; read original state, never resubmit');
 const declarationKey=declaredResponse.request().headers()['idempotency-key'];assert(uuid(declarationKey));
 assert.deepEqual(declaredResponse.request().postDataJSON(),{expectedVersion:0,expectedSessionId:sessionId,fallback:'HOLD'});
 const declared=await declaredResponse.json();assert.equal(declared.sessionId,sessionId);assert.equal(declared.configurationVersion,1);
 assert.equal(declared.readiness,'REVIEW_REQUIRED');assert.deepEqual(declared.declared,{fallback:'HOLD'});
 await checkpoint({phase:'accepted',step:'routing-declaration',connectionId,key:declarationKey,configurationVersion:1});

 await operatorPage.goto(origin+'/platform',{waitUntil:'domcontentloaded'});await current();
 await operatorPage.getByRole('textbox',{name:labels.searchTenants,exact:true}).fill(tenantName);
 const row=operatorPage.locator('#tenants tbody tr').filter({has:operatorPage.getByText(tenantName,{exact:true})});
 await row.waitFor({state:'visible',timeout:20000});assert.equal(await row.count(),1,'Workspace display name is ambiguous');
 await row.getByRole('button',{name:labels.openReview,exact:true}).click();
 const dialog=operatorPage.getByRole('dialog').filter({has:operatorPage.getByRole('heading',{name:labels.reviewTitle,exact:true})});
 await dialog.getByLabel(labels.connectionReference,{exact:true}).fill(connectionId);
 const resolvedWait=operatorPage.waitForResponse(response=>matches(response,origin,operatorPath,'GET'),{timeout:25000});
 await dialog.getByRole('button',{name:labels.resolve,exact:true}).click();
 const resolvedResponse=await resolvedWait;assert(resolvedResponse.ok());const resolved=await resolvedResponse.json();
 assert.equal(resolved.connectionId,connectionId);assert.equal(resolved.sessionId,sessionId);
 assert.equal(resolved.phoneNumberId,phoneNumberId);assert.equal(resolved.accountId,accountId);
 assert.equal(resolved.declaration.version,1);assert.equal(resolved.review,null);
 const input=await captureObservation({declaredAt:resolved.declaration.declaredAt});
 assert.equal(input.disposition,'REVIEWED');assert.equal(input.personallyObserved,true);
 assert.match(input.evidenceSha256,/^[a-f0-9]{64}$/u);assert.match(input.evidenceReference,/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u);
 assert.equal(new Date(input.observedAt).toISOString(),input.observedAt);assert(Date.parse(input.observedAt)>0&&Date.parse(input.observedAt)<=Date.now());
 // datetime-local defaults to minute precision. Bind the exact represented instant.
 assert.equal(Date.parse(input.observedAt)%60000,0);
 assert(Date.parse(input.observedAt)>=Date.parse(resolved.declaration.declaredAt));
 const localTime=await operatorPage.evaluate(iso=>{const d=new Date(iso),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;},input.observedAt);
 await dialog.locator('select[name="disposition"]').selectOption(input.disposition);
 await dialog.locator('input[name="observedAt"]').fill(localTime);
 await dialog.locator('select[name="scope"]').selectOption(input.scope);
 for(const group of ['roles','targets','fields'])for(const value of input[group])await dialog.locator(`input[name="${group}"][value="${value}"]`).check();
 for(const name of ['termsAccepted','threadControlEnabled','personallyObserved'])await dialog.locator(`input[name="${name}"]`).setChecked(input[name]);
 await dialog.locator('input[name="evidenceReference"]').fill(input.evidenceReference);
 await dialog.locator('input[name="evidenceSha256"]').fill(input.evidenceSha256);
 await current();await checkpoint({phase:'intent',step:'routing-observation',connectionId,configurationVersion:1});
 const reviewWait=operatorPage.waitForResponse(response=>matches(response,origin,operatorPath,'POST'),{timeout:25000});
 await dialog.getByRole('button',{name:labels.saveReview,exact:true}).focus();await operatorPage.keyboard.press('Enter');
 const reviewResponse=await reviewWait;assert(reviewResponse.ok(),'Observation unconfirmed; read original state, never resubmit');
 const reviewKey=reviewResponse.request().headers()['idempotency-key'];assert(uuid(reviewKey));
 assert.deepEqual(reviewResponse.request().postDataJSON(),{...input,expectedSessionId:sessionId,expectedConfigurationVersion:1,expectedReviewVersion:0});
 const saved=await reviewResponse.json();assert(uuid(saved.id));assert.equal(saved.version,1);assert.equal(saved.disposition,'REVIEWED');assert.equal(saved.duplicate,false);
 const observed=await read(operatorPage,origin,operatorPath);assert.equal(observed.review.id,saved.id);assert.deepEqual(observed.review.runtime,expectedRuntime);
 assert.deepEqual(observed.review.observation,input);
 const ready=await read(ownerPage,origin,tenantPath);assert.equal(ready.sessionId,sessionId);assert.equal(ready.configurationVersion,1);assert.equal(ready.reviewVersion,1);
 assert.equal(ready.readiness,'OBSERVED_AWAITING_THREAD');assert.equal(ready.observed.current,true);assert.equal(ready.observed.mode,'SIMULATED');
 assert.equal(ready.providerConfigurationReadback,false);assert.equal(ready.accountFundingProof,'SEPARATE_REQUIRED');
 // The real adapter checks declaration actor, independent platform subject/audit,
 // session/config/runtime, and zero OWN/effects before any primary callback.
 await readPersisted({tenantId,connectionId,sessionId,configurationVersion:1,reviewVersion:1,reviewId:saved.id,
  declarationKey,reviewKey,observation:input,expectedRuntime,requireNoOwnership:true});
 await ownerPage.reload({waitUntil:'domcontentloaded'});
 await section.getByText(labels.reviewedReadiness,{exact:true}).waitFor({state:'visible',timeout:20000});
 await section.getByText(labels.simulated,{exact:true}).waitFor({state:'visible',timeout:20000});
 const receipt={schemaVersion:1,evidenceMode:'simulated',tenantId,connectionId,sessionId,phoneNumberId,accountId,configurationVersion:1,reviewVersion:1,
  reviewId:saved.id,observationSha256:input.evidenceSha256,runtime:expectedRuntime,claim:'OBSERVED_AWAITING_THREAD',
  providerConfigurationReadback:false,accountFundingProof:'SEPARATE_REQUIRED',ownershipGranted:false};
 await checkpoint({phase:'routing-setup-readback',...receipt});return receipt;
}

/** Calls the existing admitted raw-body/HMAC producer exactly once, then demands
 * persisted ordinary evidence. Adapter implementations are fixed in the manifest;
 * a callback double can test orchestration only, never qualify this journey. */
export async function proveSignedMetaPrimaryRouting({setup,messageId,rawSha256,payloadSha256,dispatchPrimary,readPrimary,poll,checkpoint,assertAdmission}){
 assert.equal(setup.evidenceMode,'simulated');assert.equal(setup.claim,'OBSERVED_AWAITING_THREAD');assert.equal(setup.ownershipGranted,false);
 assert(typeof messageId==='string'&&messageId.startsWith('wamid.synthetic.'));
 for(const value of [rawSha256,payloadSha256])assert.match(value,/^[a-f0-9]{64}$/u);
 await assertAdmission();await checkpoint({phase:'intent',step:'routing-primary',connectionId:setup.connectionId,messageId});
 const receipt=await dispatchPrimary({setup,messageId});assert.equal(receipt.status,200);
 assert.deepEqual(receipt.receipt,{accepted:true,count:1,duplicates:0,unrouted:0});
 const state=await poll(()=>readPrimary({setup,messageId}),row=>row?.ordinarySourceProcessed===true);
 assert.equal(state.tenantId,setup.tenantId);assert.equal(state.messageId,messageId);assert.equal(state.rawSha256,rawSha256);
 assert.equal(state.payloadSha256,payloadSha256);assert.equal(state.nativeCompleted,true);
 assert.equal(state.connectionId,setup.connectionId);assert.equal(state.sessionId,setup.sessionId);
 assert.equal(state.configurationVersion,setup.configurationVersion);assert.equal(state.reviewVersion,setup.reviewVersion);
 assert.equal(state.category,'PRIMARY_MESSAGE');assert.equal(state.claim,'OWN');assert.equal(state.allowed,true);
 assert(Number.isSafeInteger(state.epoch)&&state.epoch>0);assert(uuid(state.participantId));assert(uuid(state.sourceEventId));
 assert.equal(state.ordinaryNormalizedCount,1);assert.equal(state.nativeSourceLinkCount,1);
 assert.equal(state.aliasSourceEventId,state.sourceEventId);assert.equal(state.ownershipSourceEventId,state.sourceEventId);
 assert.equal(state.importAuthorityUsed,false);assert.equal(state.internalControlMutatedByRouting,false);
 await checkpoint({phase:'routing-primary-readback',connectionId:setup.connectionId,messageId,sourceEventId:state.sourceEventId,epoch:state.epoch});
 return{...setup,claim:'OWN',sourceEventId:state.sourceEventId,epoch:state.epoch,participantId:state.participantId,
  ownershipGranted:true,authoritySource:'SIGNED_ORDINARY_MESSAGE',liveProviderEvidence:false};
}
