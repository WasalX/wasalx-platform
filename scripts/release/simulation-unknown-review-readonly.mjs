import assert from'node:assert/strict';import{createHash}from'node:crypto';import{verifyOwnerEvidence,bindOwnerEvidenceRows}from'./simulation-owner-evidence.mjs';
const base='cases-deliveries/delivery-state-retry-and-unknown-outcome-recovery::unknown-outcome-never-auto-resends::';
export const testIds=['02','03'].map(x=>base+x);
const failure=e=>({classification:'requires-review',errorClass:e.name,messageSha256:createHash('sha256').update(String(e.message)).digest('hex')});
export async function unknownReviewReadOnlyStage(s,{namespace,inputs,config}){
 const f=inputs.reviewFixture,c=s.capabilities?.reviewFixture;assert.equal(f?.evidenceMode,'simulated');assert.equal(f.namespace,namespace);assert.equal(f.tenantId,s.tenantId);assert.equal(c?.fixture.reviewId,f.reviewId);assert.equal(c.fixture.deliveryId,f.deliveryId);await c.verifyReadOnly();
 const page=s.ownerPage,origin=s.portalOrigin,startedAt=new Date().toISOString(),mutations=[],proofs=[],selected=new Set(config?.selectedTestIds??testIds);await page.setViewportSize({width:1440,height:1000});await s.verifyOwner(page);const binding=await verifyOwnerEvidence(s);
 const detailResponse=await page.request.get(origin+'/api/deliveries/'+f.deliveryId);assert.equal(detailResponse.status(),200);const detail=await detailResponse.json();assert.equal(detail.id,f.deliveryId);assert.equal(detail.state,'OUTCOME_UNKNOWN');assert.equal(detail.outcome_review_id,f.reviewId);assert.deepEqual(detail.delivery_attempts.map(a=>a.id),f.attemptIds);
 const guard=route=>{const r=route.request();if(new URL(r.url()).origin===origin&&!['GET','HEAD','OPTIONS'].includes(r.method())){mutations.push({method:r.method(),path:new URL(r.url()).pathname});return route.abort();}return route.fallback();};await page.route('**/api/**',guard);
 const collect=async(index,fn)=>{let result='passed',proof;try{proof=await fn();}catch(e){result='failed';proof=failure(e);}await c.verifyReadOnly();const [row]=bindOwnerEvidenceRows([{testId:testIds[index],result,startedAt,finishedAt:new Date().toISOString(),contextId:'tenant_owner-en-desktop',proof}],binding);proofs.push(row);await s.checkpoint({phase:'unknown-reconciliation-route',...row});};
 try{
  if(selected.has(testIds[0]))await collect(0,async()=>{await page.goto(origin+'/app?view=deliveries&workspace=review&review='+f.reviewId);await page.getByRole('heading',{name:'Resolve the delivery outcome',exact:true}).waitFor();const original=page.locator('a[href="/app?view=deliveries&delivery='+f.deliveryId+'"]');assert.equal(await original.count(),1);await original.click();await page.locator('#delivery-detail-title').waitFor();await page.locator('.attempt-list').getByText('Attempt 1',{exact:true}).waitFor();const diagnostics=await observeUnknownDiagnostics(page,origin,f);return{...diagnostics,reviewId:f.reviewId,deliveryId:f.deliveryId,originalOperationAndAttemptVisible:true,noMutation:true};});
  if(selected.has(testIds[1]))await collect(1,async()=>{await page.goto(origin+'/app?view=deliveries&workspace=review&review='+f.reviewId);await page.getByRole('heading',{name:'Resolve the delivery outcome',exact:true}).waitFor();const record=page.getByRole('button',{name:'I verified — record as sent',exact:true});assert(await record.isEnabled());await record.click();const confirmation=page.getByRole('alertdialog',{name:'Record this message as sent?',exact:true});await confirmation.waitFor();await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();await confirmation.waitFor({state:'hidden'});return{reviewId:f.reviewId,deliveryId:f.deliveryId,separateConfirmation:true,cancelUnchanged:true,noMutation:true};});
 }finally{await page.unroute('**/api/**',guard);await s.verifyOwner(page);assert.equal(mutations.length,0,'Review-only scenario attempted mutation');await c.verifyReadOnly();await s.checkpoint({phase:'unknown-review-readonly-postcondition',reviewId:f.reviewId,mutations:0});}
 assert.equal(proofs.length,testIds.filter(id=>selected.has(id)).length);return{evidenceMode:'simulated',namespace,proofs};
}

// GET-only: the original attempt keeps its safe provider code and the copy stays provider-neutral.
export async function observeUnknownDiagnostics(page,origin,f){
 const response=await page.request.get(origin+'/api/deliveries/'+f.deliveryId);assert.equal(response.status(),200);const detail=await response.json();
 assert.equal(detail.id,f.deliveryId);assert.equal(detail.state,'OUTCOME_UNKNOWN');assert.equal(detail.attempts,1);assert.equal(detail.manual_retry_allowed,false);
 assert.deepEqual(detail.delivery_attempts.map(a=>a.id),f.attemptIds);assert.equal(detail.delivery_attempts.length,1);
 // The original attempt code is observed at fixture admission; an explicit null is a valid observation, an absent one is not.
 const code=detail.delivery_attempts[0].provider_code;assert(Object.hasOwn(f,'providerCode')&&(f.providerCode===null||/^[A-Za-z0-9_.:-]{1,128}$/.test(f.providerCode)),'Fixture provider code observation required');assert.equal(code,f.providerCode);
 const dialog=page.getByRole('dialog',{name:'Delivery timeline',exact:true});await dialog.waitFor();
 await dialog.locator('.attempt-list').getByText('Attempt 1',{exact:true}).waitFor();
 const text=await dialog.innerText();assert(text.includes('Destination'));assert(!text.includes('WhatsApp group'));
 return{providerCode:code,providerNeutralDestination:true,originalAttemptPreserved:true};
}
