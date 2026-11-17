// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
import assert from 'node:assert/strict';

const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const jsonFile=value=>({name:'reviewed-synthetic-cost-input.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
const matches=(response,origin,path,method)=>new URL(response.url()).origin===origin&&new URL(response.url()).pathname===path&&response.request().method()===method;

/** The root driver supplies its real authenticated operator page, exact selected
 * tenant/account/period and reviewed SIMULATED P08/P10 fixture. No login, fixture
 * authority, provider request or source claim is created by this helper. */
export async function saveMetaCostTariffDraft({page,expectedOrigin,tenantId,definition,labels}){
 assert.equal(new URL(page.url()).origin,expectedOrigin);assert(uuid(tenantId));assert.equal(definition.tenantId,tenantId);
 assert.equal(definition.evidenceMode,'SIMULATED','No live financial authority is established by this helper');
 const section=page.getByRole('region',{name:labels.manage,exact:true}),path=`/api/platform-console/meta-costs/tenants/${tenantId}/tariffs`;
 await section.getByLabel(labels.rateFile,{exact:true}).setInputFiles(jsonFile(definition));
 for(const rate of definition.rates)await section.getByRole('table',{name:labels.preview,exact:true}).getByText(`${definition.currency} ${rate.unitPrice}`,{exact:true}).waitFor();
 const wait=page.waitForResponse(response=>matches(response,expectedOrigin,path,'POST'));
 await section.getByRole('button',{name:labels.saveDraft,exact:true}).focus();await page.keyboard.press('Enter');
 const response=await wait;assert(response.ok(),'Draft reservation failed');
 const request=response.request();assert(uuid(request.headers()['idempotency-key']));assert.deepEqual(request.postDataJSON(),{definition,supersedesId:null});
 const result=await response.json();assert(uuid(result.id));
 return{id:result.id,mode:'SIMULATED',claim:'ACTUAL_OPERATOR_UI_DRAFT_RESERVATION',externalAuthority:'NOT_QUALIFIED'};
}

/** A separate actual tenant acceptance must already bind this exact saved draft.
 * The helper verifies the real read projection and selects that accepted version;
 * it never seeds acceptance or invents an approved policy. */
export async function runMetaCostOperatorJourney({page,expectedOrigin,tenantId,accountId,tariffId,policyVersionId,labels}){
 assert.equal(new URL(page.url()).origin,expectedOrigin);for(const id of [tenantId,accountId,tariffId,policyVersionId])assert(uuid(id));
 const root=`/api/platform-console/meta-costs/tenants/${tenantId}`;
 const section=page.getByRole('region',{name:labels.manage,exact:true});
 const read=async()=>{const wait=page.waitForResponse(response=>matches(response,expectedOrigin,root,'GET'));await page.evaluate(()=>window.dispatchEvent(new Event('focus')));const response=await wait;assert(response.ok());const value=await response.json();assert.equal(value.accountId,accountId);assert.equal(value.complete,true);return value;};
 let snapshot=await read();const tariff=snapshot.tariffs.find(value=>value.id===tariffId);assert(tariff);assert.equal(tariff.state,'DRAFT');assert.equal(tariff.definition.evidenceMode,'SIMULATED');
 assert(tariff.accepted_policies.some(value=>value.id===policyVersionId),'Exact saved tariff lacks actual accepted policy');
 const accepted=section.getByLabel(labels.acceptance,{exact:true}).filter({has:page.locator(`option[value="${policyVersionId}"]`)});assert.equal(await accepted.count(),1);
 await accepted.selectOption(policyVersionId);
 const version=accepted.locator('..').locator('..');
 const activationPath=`${root}/tariffs/${tariffId}/activate`,activation=page.waitForResponse(response=>matches(response,expectedOrigin,activationPath,'POST'));
 await version.getByRole('button',{name:labels.activate,exact:true}).click();const activated=await activation;assert(activated.ok());
 assert.deepEqual(activated.request().postDataJSON(),{expectedDefinitionSha256:tariff.definition_sha256,policyVersionId});
 snapshot=await read();assert.equal(snapshot.tariffs.find(value=>value.id===tariffId)?.state,'ACTIVE');
 const group=section.getByRole('group',{name:labels.reassess,exact:true});await group.getByLabel(labels.basis,{exact:true}).selectOption('CUSTOMER_TARIFF');
 const eligible=snapshot.rows.filter(value=>value.purpose==='CUSTOMER_TARIFF'&&value.id!==null&&!value.evidenceRedacted&&value.evidenceMode==='SIMULATED');
 assert(eligible.length>100&&eligible.length<=200,'Fixture must provide two finite pages');
 assert.equal(new Set(eligible.map(value=>value.deliveredAt)).size,1,'Same-time fixtures prove that date narrowing is not the pagination oracle');
 let submitted=0;
 for(let pageIndex=0;pageIndex<2;pageIndex++){
  if(pageIndex){await group.getByRole('button',{name:labels.next,exact:true}).focus();await page.keyboard.press('Enter');}
  const batch=eligible.slice(pageIndex*100,(pageIndex+1)*100);assert(batch.length>0&&batch.length<=100);
  const checks=group.getByRole('checkbox');assert.equal(await checks.count(),batch.length+1);
  for(let i=0;i<batch.length;i++){const checkbox=checks.nth(i+1);if(i===0){await checkbox.focus();await page.keyboard.press('Space');}else await checkbox.check();}
  const path=`${root}/accounts/${accountId}/reassess`,wait=page.waitForResponse(response=>matches(response,expectedOrigin,path,'POST'));
  await group.getByRole('button',{name:labels.reassessSelected(batch.length),exact:true}).click();const response=await wait;assert(response.ok());
  const body=response.request().postDataJSON();assert.equal(body.purpose,'CUSTOMER_TARIFF');assert.equal(body.items.length,batch.length);
  assert.deepEqual(body.items,batch.map(value=>({deliveryId:value.deliveryId,expectedHeadId:value.id})));
  assert(uuid(response.request().headers()['idempotency-key']));submitted+=batch.length;
 }
 snapshot=await read();assert.equal(snapshot.accountId,accountId);
 return{mode:'SIMULATED',submitted,maximumBatch:100,pages:2,claim:'ACTUAL_OPERATOR_UI_ACCEPTED_ACTIVATION_AND_BOUNDED_REASSESSMENT',externalAuthority:'NOT_QUALIFIED'};
}

/** Deliberate controlled BROWSER response loss after route.fetch saw the real
 * server commit. This does not inject a BFF upstream-body failure. Installed
 * BFF fault injection remains a separate root-controlled prerequisite. */
export async function reconcileMetaCostOperatorAfterResponseLoss({page,expectedOrigin,actionPath,perform,changeScope,labels,verifyCommitted,verifyReadback}){
 assert.equal(new URL(page.url()).origin,expectedOrigin);assert(/^\/api\/platform-console\/meta-costs\/tenants\/[0-9a-f-]{36}\//iu.test(actionPath));
 const exact=expectedOrigin+actionPath;let calls=0,original,committed;
 const handler=async route=>{
  if(route.request().method()!=='POST')return route.continue();calls++;
  const request=route.request(),intent={path:new URL(request.url()).pathname,body:request.postData(),key:request.headers()['idempotency-key']};assert(uuid(intent.key));
  if(calls===1){original=intent;const response=await route.fetch();assert(response.ok());committed=await response.json();await verifyCommitted(committed);await route.abort('failed');}
  else{assert.equal(calls,2);assert.deepEqual(intent,original);await route.continue();}
 };
 await page.route(exact,handler);
 try{
  await perform();const reconcile=page.getByRole('button',{name:labels.reconcile,exact:true});await reconcile.waitFor();assert(committed);
  await changeScope();assert.equal(calls,1,'Changing the selected account/period must not dispatch a new action');
  const wait=page.waitForResponse(response=>matches(response,expectedOrigin,actionPath,'POST'));await reconcile.focus();await page.keyboard.press('Enter');
  const response=await wait;assert(response.ok());const recovered=await response.json();assert.equal(recovered.duplicate,true);assert.equal(calls,2);
  await verifyReadback({original:committed,recovered});
  return{mode:'SIMULATED',requestCount:2,originalIntentPreserved:true,claim:'ACTUAL_SERVER_COMMIT_WITH_CONTROLLED_BROWSER_RESPONSE_LOSS',bffUpstreamBodyFault:'NOT_EXERCISED',externalAuthority:'NOT_QUALIFIED'};
 }finally{await page.unroute(exact,handler);}
}
