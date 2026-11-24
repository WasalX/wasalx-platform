import {installMetaRoutingReadFixture} from "./meta-routing.fixture";
import AxeBuilder from '@axe-core/playwright';
import {createHash} from 'node:crypto';
import {expect,test,type Page,type Route} from '@playwright/test';
import {englishTenantMessages} from '../../lib/i18n/messages/en/tenant';
import {arabicTenantMessages} from '../../lib/i18n/messages/ar/tenant';
import type {MetaTransitionExecutionAction,MetaTransitionExecutionView,MetaTransitionPreviewPage,MetaTransitionPreviewView} from '../../packages/core/src/meta-account-transition-contract';
import type {MetaSignupAttemptView} from '../../lib/meta-signup-contract';

const connection='12000000-0000-4000-8000-000000000093',otherConnection='12000000-0000-4000-8000-000000000094';
const planId='33000000-0000-4000-8000-000000000093',operationId='44000000-0000-4000-8000-000000000093';
const digest='a'.repeat(64),intentKey=`wasalx:meta-transition:v1:${connection}:${planId}`;
const locale=()=>process.env.WASALX_E2E_LOCALE??'en';
const role=()=>process.env.WASALX_E2E_ROLE??'tenant_owner';
const copy=(key:string)=>((locale()==='ar'?arabicTenantMessages:englishTenantMessages) as Record<string,string>)[`tenant.connection.accountPreview.${key}`]!;
const section=(page:Page)=>page.locator('section[aria-labelledby^="account-preview-"]');
const button=(page:Page,action:string)=>section(page).getByRole('button',{name:copy(`execution.action.${action}`),exact:true});
function execution():MetaTransitionExecutionView{return {revision:1,state:'UNPREPARED',previewSha256:digest,requestedMode:'CUSTOMER',sourceCurrency:'USD',targetCurrency:'SAR',impactConnectionCount:1,terms:null,renewals:[],completionApprovalRequired:false,
  actions:{initiate:true,complete:false,observe:false,reconcile:false,cancel:true},reasons:[],providerStatus:null,history:[],observedAt:null,pendingAction:null};}

async function fixture(page:Page){
  let value:MetaTransitionPreviewView={id:planId,revision:2,state:'PREVIEW',requestedMode:'CUSTOMER',targetCurrency:'SAR',
    current:{declaredMode:'CUSTOMER',actualPayer:'UNVERIFIED',currency:'USD'},impact:{connections:[{id:connection,name:'Reviewed <account>'}],phoneInventory:'COMPLETE',externalPhoneCount:0,
      sourceTemplateCount:1,affectedFlowVersionCount:2,templateCompatibility:'NOT_ASSESSED'},reasons:[],observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+900_000).toISOString(),
    canRefresh:true,canCancel:true,canExecute:false,execution:execution()};
  const writes:Array<{action:string;body:Record<string,unknown>;key:string|null}>=[],pageErrors:string[]=[],consoleErrors:string[]=[];
  const resolutions:Array<{action:string;body:Record<string,unknown>;key:string|null}>=[];
  const previewWrites:Array<{action:'create'|'cancel';body:Record<string,unknown>;key:string|null}>=[];
  let prepare:MetaTransitionPreviewPage['prepare']={accountRevision:1,bindingRevision:2};
  const expectedErrors:Array<{url:string;text:string}>=[];
  const optionalAbortErrors:string[]=[],abortedRequests:string[]=[];
  let denied=false,delayRead=false,readStarted=false,releaseRead:(()=>void)|undefined;
  let handler:(route:Route,action:MetaTransitionExecutionAction,expectedRevision:number)=>Promise<void>=async(route,action,requestRevision)=>{
    value={...value,canRefresh:false,canCancel:false,execution:{...value.execution!,revision:requestRevision+1,state:action==='INITIATE'?'RESERVED':value.execution!.state,
      actions:{initiate:false,complete:false,observe:false,reconcile:false,cancel:false},pendingAction:{operationId,action,state:'QUEUED',requestRevision,requestKey:route.request().headers()['idempotency-key']!}}};
    await route.fulfill({status:202,json:{id:planId,operationId,duplicate:false}});
  };
  let resolveHandler:typeof handler=async(route,action,requestRevision)=>{
    const existing=value.execution!.pendingAction,pending=existing??{operationId,action,state:'CANCELLED' as const,requestRevision,requestKey:route.request().headers()['idempotency-key']!};
    if(!existing)value={...value,execution:{...value.execution!,revision:value.execution!.revision+1,pendingAction:pending}};
    await route.fulfill({status:200,json:{id:planId,operationId:pending.operationId,duplicate:true,pendingAction:pending}});
  };
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('console',message=>{if(message.type()!=='error')return;const index=expectedErrors.findIndex(item=>item.url===message.location().url&&item.text===message.text());
    if(index>=0){expectedErrors.splice(index,1);return;}
    const abortIndex=message.text()==='Failed to load resource: net::ERR_FAILED'?optionalAbortErrors.indexOf(message.location().url):-1;
    if(abortIndex>=0){optionalAbortErrors.splice(abortIndex,1);return;}
    consoleErrors.push(message.text());});
  await page.route('**/api/connections/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,id=path.split('/')[3];
    if(path.includes('/meta/account-transitions')){
      const suffix=path.split('/account-transitions')[1];
      if(request.method()==='GET'){
        if(denied){expectedErrors.push({url:request.url(),text:'Failed to load resource: the server responded with a status of 403 (Forbidden)'});return route.fulfill({status:403,json:{code:'FORBIDDEN'}});}
        const saved=structuredClone(value);
        if(delayRead){delayRead=false;readStarted=true;await new Promise<void>(resolve=>{releaseRead=resolve;});}
        return route.fulfill({json:id===otherConnection?{prepare:{accountRevision:1,bindingRevision:2},currentPlan:null}:suffix?saved:{prepare,currentPlan:saved}});
      }
      if(!suffix||suffix.endsWith('/cancel')){
        const body=request.postDataJSON() as Record<string,unknown>,key=request.headers()['idempotency-key']??null;
        expect(key).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu);
        if(!suffix){
          expect(prepare).not.toBeNull();expect(value.execution?.state==='RECONCILED_PAUSED'||value.state==='CANCELLED').toBe(true);
          expect(Object.keys(body).sort()).toEqual(['expectedAccountRevision','expectedBindingRevision','requestedMode','targetCurrency']);
          expect(body).toMatchObject({expectedAccountRevision:prepare!.accountRevision,expectedBindingRevision:prepare!.bindingRevision});
          previewWrites.push({action:'create',body,key});
          value={...value,id:'33000000-0000-4000-8000-000000000094',revision:1,state:'PENDING',requestedMode:body.requestedMode as MetaTransitionPreviewView['requestedMode'],
            targetCurrency:String(body.targetCurrency),current:{declaredMode:'CUSTOMER',actualPayer:'UNVERIFIED',currency:'SAR'},observedAt:null,expiresAt:null,
            canRefresh:false,canCancel:true,execution:{...execution(),revision:1,targetCurrency:String(body.targetCurrency),actions:{initiate:false,complete:false,observe:false,reconcile:false,cancel:true}}};
        }else{
          expect(suffix).toBe(`/${value.id}/cancel`);expect(body).toEqual({expectedRevision:value.revision});
          expect(value.execution?.actions.cancel??value.canCancel).toBe(true);
          previewWrites.push({action:'cancel',body,key});
          value={...value,revision:value.revision+1,state:'CANCELLED',canRefresh:false,canCancel:false,
            execution:{...value.execution!,revision:value.revision+1,actions:{initiate:false,complete:false,observe:false,reconcile:false,cancel:false}}};
        }
        return route.fulfill({status:202,json:{id:value.id,duplicate:false}});
      }
      const pieces=suffix.split('/'),resolve=pieces.at(-1)==='resolve',action=pieces.at(resolve?-2:-1)!;expect(['initiate','complete','observe','reconcile']).toContain(action);
      const body=request.postDataJSON() as Record<string,unknown>,key=request.headers()['idempotency-key']??null;
      expect(Object.keys(body).sort()).toEqual(['expectedPreviewSha256','expectedRevision']);
      if(resolve){const original=writes.find(write=>write.key===key);expect(original).toBeDefined();expect(original!.action).toBe(action);expect(body).toEqual(original!.body);
        resolutions.push({action,body,key});return resolveHandler(route,action.toUpperCase() as MetaTransitionExecutionAction,Number(body.expectedRevision));}
      expect(body).toEqual({expectedRevision:value.execution!.revision,expectedPreviewSha256:value.execution!.previewSha256});
      expect(key).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu);writes.push({action,body,key});
      return handler(route,action.toUpperCase() as MetaTransitionExecutionAction,Number(body.expectedRevision));
    }
    if(path.endsWith('/meta/billing-policy'))return route.fulfill({json:{enrolled:true,mode:'CUSTOMER',revision:1,sendReady:false,paymentMethod:'PRESENT',checkedAt:new Date().toISOString(),actualPayer:'UNVERIFIED',customerOwnership:'UNVERIFIED',managedAvailable:false,state:'SUCCEEDED'}});
    if(path===`/api/connections/${id}`&&[connection,otherConnection].includes(id))return route.fulfill({json:{id,name:'Transition account',provider:'META',state:'PAUSED',provider_session_state:'PAUSED',provider_state:'STOPPED',webhook_state:'PAUSED',latest_operation_type:'PAUSE',latest_operation_state:'SUCCEEDED',group_count:0}});
    return route.continue();
  });
  await installMetaRoutingReadFixture(page);
  const refresh=async()=>{await section(page).getByRole('button',{name:copy('checkStatus'),exact:true}).first().click();await expect(section(page).getByText(copy('loading'),{exact:true})).toHaveCount(0);};
  return {writes,resolutions,previewWrites,pageErrors,consoleErrors,expectedErrors,abortedRequests,refresh,get:()=>value,set:(next:MetaTransitionPreviewView)=>{value=next;},
    setPrepare:(next:MetaTransitionPreviewPage['prepare'])=>{prepare=next;},
    setResolveHandler:(next:typeof resolveHandler)=>{resolveHandler=next;},
    setHandler:(next:typeof handler)=>{handler=next;},deny:()=>{denied=true;},delay:()=>{delayRead=true;readStarted=false;},readStarted:()=>readStarted,release:()=>{releaseRead?.();releaseRead=undefined;},
    lost:async(route:Route)=>{
      const url=route.request().url();optionalAbortErrors.push(url);
      await route.abort('failed');abortedRequests.push(url);
    }};
}

test('Account change uses four deliberate actions and recovers the exact saved operation without replay',async({page},testInfo)=>{
  const f=await fixture(page);
  await page.goto(`/app?view=connections&connection=${connection}`);await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  await expect(section(page).getByRole('heading',{name:copy('execution.title'),exact:true})).toBeVisible();
  if(!['tenant_owner','tenant_admin'].includes(role())){
    for(const action of ['initiate','complete','observe','reconcile'])await expect(button(page,action)).toHaveCount(0);
    expect(f.writes).toHaveLength(0);return;
  }
  page.once('dialog',async dialog=>{expect(dialog.type()).toBe('confirm');expect(dialog.message()).toContain('\u2068USD\u2069');expect(dialog.message()).toContain('\u2068SAR\u2069');await dialog.dismiss();});
  await button(page,'initiate').click();expect(f.writes).toHaveLength(0);
  f.setHandler(async(route,action,requestRevision)=>{f.set({...f.get(),canCancel:false,canRefresh:false,execution:{...f.get().execution!,revision:2,state:'RESERVED',actions:{initiate:false,complete:false,observe:false,reconcile:false,cancel:false},pendingAction:{operationId,action,state:'QUEUED',requestRevision,requestKey:route.request().headers()['idempotency-key']!}}});await f.lost(route);});
  page.once('dialog',dialog=>dialog.accept());await button(page,'initiate').focus();await page.keyboard.press('Enter');
  await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toBeVisible();expect(f.writes).toHaveLength(1);
  await page.reload();await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toBeVisible();expect(f.writes).toHaveLength(1);
  await section(page).getByRole('button',{name:copy('execution.resolve'),exact:true}).click();
  await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toBeVisible();expect(f.resolutions).toHaveLength(1);expect(f.writes).toHaveLength(1);
  const pending=f.get().execution!.pendingAction!;
  f.set({...f.get(),execution:{...f.get().execution!,revision:3,pendingAction:{...pending,state:'SUCCEEDED',requestKey:'44000000-0000-4000-8000-000000000099'}}});
  await f.refresh();await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toBeVisible();expect(f.writes).toHaveLength(1); // Another tab's same-revision result is not this request.
  f.set({...f.get(),execution:{...f.get().execution!,revision:3,actions:{...f.get().execution!.actions,complete:true},pendingAction:{...pending,state:'SUCCEEDED',requestRevision:99}}});
  await f.refresh();await expect(button(page,'complete')).toBeDisabled();await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toBeVisible();
  f.set({...f.get(),execution:{...f.get().execution!,state:'INITIATED',providerStatus:'INITIATED',actions:{initiate:false,complete:false,observe:true,reconcile:false,cancel:false},
    history:[{stage:'INITIATE',outcome:'SUCCEEDED',attemptedAt:new Date().toISOString()}],pendingAction:{...pending,state:'SUCCEEDED'}}});
  await f.refresh();await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toHaveCount(0);await expect(button(page,'observe')).toBeEnabled();expect(f.writes).toHaveLength(1);
  f.setHandler(async(route,action,requestRevision)=>{
    const current=f.get().execution!,state=action==='OBSERVE'?'READY_TO_COMPLETE':action==='COMPLETE'?'PROVIDER_COMPLETED':'RECONCILED_PAUSED';
    const nextOperation=`44000000-0000-4000-8000-${String(requestRevision).padStart(12,'0')}`;
    if(action==='RECONCILE')f.setPrepare(null); // Reconciliation leaves the target held until separately activated.
    f.set({...f.get(),expiresAt:action==='OBSERVE'?new Date(Date.now()-60_000).toISOString():f.get().expiresAt,execution:{...current,revision:requestRevision+1,state,providerStatus:action==='OBSERVE'?'READY_TO_COMPLETE':'COMPLETED',observedAt:new Date().toISOString(),
      actions:{initiate:false,complete:action==='OBSERVE',observe:false,reconcile:action==='COMPLETE',cancel:false},
      history:action==='COMPLETE'?[...current.history,{stage:'COMPLETE',outcome:'SUCCEEDED',attemptedAt:new Date().toISOString()}]:current.history,
      pendingAction:{operationId:nextOperation,action,state:'SUCCEEDED',requestRevision,requestKey:route.request().headers()['idempotency-key']!}}});
    await route.fulfill({status:202,json:{id:planId,operationId:nextOperation,duplicate:false}});
  });
  await button(page,'observe').click();await expect(button(page,'complete')).toBeEnabled();expect(f.writes.map(w=>w.action)).toEqual(['initiate','observe']);
  await section(page).getByRole('heading',{name:copy('execution.title'),exact:true}).scrollIntoViewIfNeeded();
  await testInfo.attach('execution-ready',{body:await page.screenshot(),contentType:'image/png'});
  page.once('dialog',dialog=>dialog.accept());await button(page,'complete').click();await expect(button(page,'reconcile')).toBeEnabled();
  await button(page,'reconcile').click();await expect(section(page).getByText(copy('execution.state.RECONCILED_PAUSED'),{exact:true})).toBeVisible();
  await page.reload();await expect(section(page).getByText(copy('execution.state.RECONCILED_PAUSED'),{exact:true})).toBeVisible();
  expect(f.writes.map(w=>w.action)).toEqual(['initiate','observe','complete','reconcile']);expect(new Set(f.writes.map(w=>w.key)).size).toBe(4);
  expect(await page.evaluate(key=>sessionStorage.getItem(key),intentKey)).toBeNull();
  for(const action of ['initiate','complete','observe','reconcile'])await expect(button(page,action)).toBeDisabled();
  await expect(section(page).getByRole('button',{name:copy('cancel'),exact:true})).toBeDisabled();
  expect((await new AxeBuilder({page}).include('section[aria-labelledby^="account-preview-"]').analyze()).violations).toEqual([]);
  await button(page,'reconcile').scrollIntoViewIfNeeded();await testInfo.attach('execution-paused',{body:await page.screenshot(),contentType:'image/png'});
  expect((await section(page).boundingBox())!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(f.pageErrors).toEqual([]);expect(f.consoleErrors).toEqual([]);expect(f.expectedErrors).toEqual([]);
});

test('Account change holds malformed or uncorrelated results and clears inaccessible data without repeating effects',async({page})=>{
  test.skip(!['tenant_owner','tenant_admin'].includes(role()));
  const f=await fixture(page);
  await page.goto(`/app?view=connections&connection=${connection}`);await expect(button(page,'initiate')).toBeEnabled();
  // Storage denial must stop dispatch before a provider action is reserved.
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Object.defineProperty(window,'__restoreTransitionStorage',{value:()=>{Storage.prototype.setItem=original;},configurable:true});Storage.prototype.setItem=function(key,value){if(key.startsWith('wasalx:meta-transition:'))throw new DOMException('Blocked','SecurityError');return original.call(this,key,value);};});
  page.once('dialog',dialog=>dialog.accept());await button(page,'initiate').click();await expect(section(page).getByText(copy('execution.storageUnavailable'),{exact:true})).toBeVisible();expect(f.writes).toHaveLength(0);
  await page.evaluate(()=>{(window as unknown as {__restoreTransitionStorage:()=>void}).__restoreTransitionStorage();});await f.refresh();await expect(button(page,'initiate')).toBeEnabled();
  f.setHandler(async route=>{await route.fulfill({status:202,json:{id:planId,duplicate:false}});}); // Missing durable operation ID is not acceptance proof.
  page.once('dialog',dialog=>dialog.accept());await button(page,'initiate').click();await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toBeVisible();
  await f.refresh();await expect(button(page,'initiate')).toBeDisabled();expect(f.writes).toHaveLength(1);
  await page.reload();await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toBeVisible();expect(f.writes).toHaveLength(1);
  f.set({...f.get(),execution:{...f.get().execution!,revision:4,state:'HELD',reasons:['PROVIDER_OUTCOME_UNRESOLVED'],actions:{initiate:false,complete:false,observe:true,reconcile:false,cancel:false},
    history:[{stage:'INITIATE',outcome:'UNKNOWN',attemptedAt:new Date().toISOString()}],pendingAction:{operationId,action:'INITIATE',state:'FAILED_TERMINAL',requestRevision:1,requestKey:f.writes[0]!.key!}}});
  await f.refresh();await expect(section(page).getByText(copy('execution.reason.PROVIDER_OUTCOME_UNRESOLVED'),{exact:true})).toBeVisible();await expect(button(page,'initiate')).toBeDisabled();
  await expect(button(page,'observe')).toBeEnabled();expect(f.writes).toHaveLength(1);
  // A later GET denied by current authority clears the old account/history/action data.
  f.deny();await f.refresh();await expect(section(page).getByRole('alert')).toBeVisible();await expect(section(page).getByText('Reviewed <account>',{exact:true})).toHaveCount(0);
  for(const action of ['initiate','complete','observe','reconcile'])await expect(button(page,action)).toHaveCount(0);
  expect(f.writes).toHaveLength(1);expect(f.pageErrors).toEqual([]);expect(f.consoleErrors).toEqual([]);expect(f.expectedErrors).toEqual([]);
});

test('Managed account change requires acceptance of the exact target terms before confirmation',async({page},testInfo)=>{
  test.skip(!['tenant_owner','tenant_admin'].includes(role()));
  const f=await fixture(page),documentText='Terms for the reviewed target account.\nشروط الحساب المستهدف. <approval is text>';
  f.set({...f.get(),requestedMode:'WASALX_MANAGED',execution:{...f.get().execution!,requestedMode:'WASALX_MANAGED',terms:null}});
  await page.goto(`/app?view=connections&connection=${connection}`);
  await expect(section(page).getByText(copy('execution.terms.unavailable'),{exact:true})).toBeVisible();await expect(button(page,'initiate')).toBeDisabled();expect(f.writes).toHaveLength(0);
  const terms={documentText,documentSha256:createHash('sha256').update(documentText).digest('hex'),version:'2026-10.1'};
  f.set({...f.get(),execution:{...f.get().execution!,revision:2,terms}});await f.refresh();
  await expect(section(page).getByText(documentText,{exact:true})).toBeVisible();await expect(section(page).locator('approval')).toHaveCount(0);
  await expect(section(page).getByText(terms.documentSha256,{exact:true})).toHaveCount(0);await expect(button(page,'initiate')).toBeDisabled();
  const acceptance=section(page).getByRole('checkbox',{name:copy('execution.terms.accept'),exact:true});
  await acceptance.focus();await page.keyboard.press('Space');await expect(acceptance).toBeChecked();await expect(button(page,'initiate')).toBeEnabled();
  const geometry=await acceptance.boundingBox();expect(geometry!.width).toBeLessThanOrEqual(24);expect(geometry!.height).toBeLessThanOrEqual(24);
  page.once('dialog',dialog=>dialog.dismiss());await button(page,'initiate').click();expect(f.writes).toHaveLength(0);
  // A refreshed revision or changed document invalidates only the local acceptance, not the readable record.
  f.set({...f.get(),execution:{...f.get().execution!,revision:3}});await f.refresh();await expect(acceptance).not.toBeChecked();await expect(button(page,'initiate')).toBeDisabled();
  const revisedText=`${documentText}\nRevised target terms.`;
  await acceptance.check();f.set({...f.get(),execution:{...f.get().execution!,previewSha256:'c'.repeat(64),terms:{...terms,documentText:revisedText,documentSha256:createHash('sha256').update(revisedText).digest('hex'),version:'2026-10.2'}}});
  await f.refresh();await expect(acceptance).not.toBeChecked();await expect(button(page,'initiate')).toBeDisabled();
  await acceptance.check();await page.reload();await expect(acceptance).not.toBeChecked();await expect(button(page,'initiate')).toBeDisabled();expect(f.writes).toHaveLength(0);
  await acceptance.check();await section(page).getByText(copy('execution.terms.title'),{exact:true}).scrollIntoViewIfNeeded();
  await testInfo.attach('execution-target-terms',{body:await page.screenshot(),contentType:'image/png'});
  expect((await new AxeBuilder({page}).include('section[aria-labelledby^="account-preview-"]').analyze()).violations).toEqual([]);
  expect((await section(page).boundingBox())!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  page.once('dialog',dialog=>dialog.accept());await button(page,'initiate').click();await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toBeVisible();
  await expect.poll(()=>f.writes).toHaveLength(1);expect(f.writes[0]!.body).toEqual({expectedRevision:3,expectedPreviewSha256:'c'.repeat(64)});
  expect(f.pageErrors).toEqual([]);expect(f.consoleErrors).toEqual([]);expect(f.expectedErrors).toEqual([]);
});

test('An unadmitted request is resolved with its original key without repeating a provider action',async({page})=>{
  test.skip(!['tenant_owner','tenant_admin'].includes(role()));
  const f=await fixture(page);f.setHandler(async route=>{await f.lost(route);});
  await page.goto(`/app?view=connections&connection=${connection}`);await expect(button(page,'initiate')).toBeEnabled();
  page.once('dialog',dialog=>dialog.accept());await button(page,'initiate').click();await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toBeVisible();
  await page.reload();await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toBeVisible();expect(f.resolutions).toHaveLength(0);
  // Missing persisted request identity cannot release the held original request.
  f.setResolveHandler(async route=>{await route.fulfill({json:{id:planId,operationId,duplicate:true,pendingAction:{operationId,action:'INITIATE',state:'CANCELLED'}}});});
  await section(page).getByRole('button',{name:copy('execution.resolve'),exact:true}).click();
  await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toBeVisible();await expect(button(page,'initiate')).toBeDisabled();
  expect(f.resolutions).toHaveLength(1);expect(f.writes).toHaveLength(1);
  // The resolution response can itself be lost; an exact terminal GET is sufficient, never a resend.
  f.setResolveHandler(async(route,action,requestRevision)=>{f.set({...f.get(),execution:{...f.get().execution!,revision:2,pendingAction:{operationId,action,state:'CANCELLED',requestRevision,requestKey:route.request().headers()['idempotency-key']!}}});await f.lost(route);});
  await section(page).getByRole('button',{name:copy('execution.resolve'),exact:true}).click();await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toHaveCount(0);
  await expect(button(page,'initiate')).toBeEnabled();expect(f.resolutions).toHaveLength(2);expect(f.writes).toHaveLength(1);
  expect(f.resolutions.every(value=>value.key===f.writes[0]!.key&&JSON.stringify(value.body)===JSON.stringify(f.writes[0]!.body))).toBe(true);
  expect(await page.evaluate(key=>sessionStorage.getItem(key),intentKey)).toBeNull();
  await page.reload();await expect(button(page,'initiate')).toBeEnabled();expect(f.resolutions).toHaveLength(2);expect(f.writes).toHaveLength(1);
  expect(f.abortedRequests.map(url=>new URL(url).pathname.split('/').at(-1))).toEqual(['initiate','resolve']);
  expect(f.pageErrors).toEqual([]);expect(f.consoleErrors).toEqual([]);expect(f.expectedErrors).toEqual([]);
});

test('Account change read deadlines and scope changes cannot restore stale actions or clear a draft',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop'||locale()!=='en'||role()!=='tenant_owner');
  await page.clock.install();const f=await fixture(page);
  f.set({...f.get(),expiresAt:new Date(Date.now()-60_000).toISOString()});
  await page.goto(`/app?view=connections&connection=${connection}`);await expect(button(page,'initiate')).toBeDisabled();expect(f.writes).toHaveLength(0);
  f.set({...f.get(),expiresAt:null});await f.refresh();await expect(button(page,'initiate')).toBeDisabled();expect(f.writes).toHaveLength(0);
  f.set({...f.get(),expiresAt:new Date(Date.now()+900_000).toISOString()});await f.refresh();await expect(button(page,'initiate')).toBeEnabled();
  f.delay();await section(page).getByRole('button',{name:copy('checkStatus'),exact:true}).first().click();await expect.poll(f.readStarted).toBe(true);
  await page.clock.runFor(20_001);await expect(section(page).getByRole('alert')).toBeVisible();await expect(button(page,'initiate')).toBeDisabled();
  f.release();await f.refresh();await expect(button(page,'initiate')).toBeEnabled();expect(f.writes).toHaveLength(0);
  f.delay();await section(page).getByRole('button',{name:copy('checkStatus'),exact:true}).first().click();await expect.poll(f.readStarted).toBe(true);
  await page.evaluate(id=>{history.pushState({},'',`/app?view=connections&connection=${id}`);dispatchEvent(new PopStateEvent('popstate'));},otherConnection);
  await expect(section(page).getByText(copy('empty'),{exact:true})).toBeVisible();f.release();
  await expect(button(page,'initiate')).toHaveCount(0);await expect(section(page).getByText('Reviewed <account>',{exact:true})).toHaveCount(0);
  await section(page).getByLabel(copy('currency'),{exact:true}).fill('SAR');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.clock.runFor(100);
  await expect(section(page).getByLabel(copy('currency'),{exact:true})).toHaveValue('SAR');expect(f.writes).toHaveLength(0);
  expect(f.pageErrors).toEqual([]);expect(f.consoleErrors).toEqual([]);expect(f.expectedErrors).toEqual([]);
});


test('Reserved account change cancellation follows current execution authority without provider work',async({page},testInfo)=>{
  const f=await fixture(page);
  f.set({...f.get(),revision:6,canRefresh:false,canCancel:false,execution:{...execution(),revision:6,state:'RESERVED',
    actions:{initiate:false,complete:false,observe:false,reconcile:false,cancel:true},history:[],pendingAction:null}});
  f.setPrepare(null);
  await page.goto(`/app?view=connections&connection=${connection}`);
  await expect(section(page).getByText(copy('execution.state.RESERVED'),{exact:true})).toBeVisible();
  const cancel=section(page).getByRole('button',{name:copy('cancel'),exact:true});
  if(!['tenant_owner','tenant_admin'].includes(role())){
    await expect(cancel).toHaveCount(0);expect(f.previewWrites).toHaveLength(0);expect(f.writes).toHaveLength(0);return;
  }
  await expect(cancel).toBeEnabled();
  // Execution permission is authoritative even if a stale preview hint says yes.
  f.set({...f.get(),canCancel:true,execution:{...f.get().execution!,actions:{...f.get().execution!.actions,cancel:false}}});
  await f.refresh();await expect(cancel).toBeDisabled();expect(f.previewWrites).toHaveLength(0);
  f.set({...f.get(),canCancel:false,execution:{...f.get().execution!,actions:{...f.get().execution!.actions,cancel:true}}});
  await f.refresh();await expect(cancel).toBeEnabled();
  await cancel.focus();await page.keyboard.press('Enter');
  await expect(section(page).getByText(copy('state.CANCELLED'),{exact:true})).toBeVisible();
  expect(f.previewWrites).toHaveLength(1);expect(f.previewWrites[0]).toMatchObject({action:'cancel',body:{expectedRevision:6}});
  await page.reload();await expect(section(page).getByText(copy('state.CANCELLED'),{exact:true})).toBeVisible();
  await expect(cancel).toBeDisabled();expect(f.previewWrites).toHaveLength(1);expect(f.writes).toHaveLength(0);expect(f.resolutions).toHaveLength(0);
  await cancel.scrollIntoViewIfNeeded();await testInfo.attach('execution-reserved-cancel',{body:await page.screenshot(),contentType:'image/png'});
  expect(f.pageErrors).toEqual([]);expect(f.consoleErrors).toEqual([]);expect(f.expectedErrors).toEqual([]);
});

test('Reconciled account history allows a new preview only with current preparation and settled intent',async({page},testInfo)=>{
  const f=await fixture(page),history:MetaTransitionExecutionView['history']=[
    {stage:'INITIATE',outcome:'SUCCEEDED',attemptedAt:new Date(Date.now()-120_000).toISOString()},
    {stage:'COMPLETE',outcome:'SUCCEEDED',attemptedAt:new Date(Date.now()-60_000).toISOString()}];
  f.set({...f.get(),revision:12,state:'EXPIRED',canRefresh:false,canCancel:false,expiresAt:new Date(Date.now()-60_000).toISOString(),
    execution:{...execution(),revision:12,state:'RECONCILED_PAUSED',providerStatus:'COMPLETED',history,
      actions:{initiate:false,complete:false,observe:false,reconcile:false,cancel:false},pendingAction:null}});
  f.setPrepare(null);
  await page.goto(`/app?view=connections&connection=${connection}`);
  const historical=section(page).getByText(copy('execution.state.RECONCILED_PAUSED'),{exact:true}),prepareButton=section(page).getByRole('button',{name:copy('prepare'),exact:true});
  await expect(historical).toBeVisible();await expect(prepareButton).toHaveCount(0);
  // Models only the authoritative page after independent target activation, not activation itself.
  f.setPrepare({accountRevision:7,bindingRevision:9});await f.refresh();await expect(historical).toBeVisible();
  if(!['tenant_owner','tenant_admin'].includes(role())){
    await expect(prepareButton).toHaveCount(0);expect(f.previewWrites).toHaveLength(0);expect(f.writes).toHaveLength(0);return;
  }
  await section(page).getByLabel(copy('currency'),{exact:true}).fill('EUR');await expect(prepareButton).toBeEnabled();
  f.setPrepare(null);await f.refresh();await expect(prepareButton).toHaveCount(0);await expect(historical).toBeVisible();expect(f.previewWrites).toHaveLength(0);
  f.setPrepare({accountRevision:8,bindingRevision:10});await f.refresh();await expect(section(page).getByLabel(copy('currency'),{exact:true})).toHaveValue('EUR');
  const unresolved={schemaVersion:1,action:'RECONCILE',requestRevision:11,previewSha256:digest,key:'55000000-0000-4000-8000-000000000093',operationId:null};
  await page.evaluate(({key,intent})=>sessionStorage.setItem(key,JSON.stringify(intent)),{key:intentKey,intent:unresolved});
  await f.refresh();await expect(prepareButton).toBeDisabled();await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toBeVisible();expect(f.previewWrites).toHaveLength(0);
  f.set({...f.get(),execution:{...f.get().execution!,pendingAction:{operationId,requestKey:unresolved.key,action:'RECONCILE',state:'SUCCEEDED',requestRevision:11}}});
  await f.refresh();await expect(prepareButton).toBeEnabled();await expect(historical).toBeVisible();
  expect(await page.evaluate(key=>sessionStorage.getItem(key),intentKey)).toBeNull();
  await prepareButton.scrollIntoViewIfNeeded();await testInfo.attach('execution-next-preview',{body:await page.screenshot(),contentType:'image/png'});
  await prepareButton.focus();await page.keyboard.press('Enter');await expect(section(page).getByText(copy('state.PENDING'),{exact:true})).toBeVisible();
  expect(f.previewWrites).toHaveLength(1);expect(f.previewWrites[0]).toMatchObject({action:'create',body:{requestedMode:'CUSTOMER',targetCurrency:'EUR',expectedAccountRevision:8,expectedBindingRevision:10}});
  await page.reload();await expect(section(page).getByText(copy('state.PENDING'),{exact:true})).toBeVisible();
  expect(f.previewWrites).toHaveLength(1);expect(f.writes).toHaveLength(0);expect(f.resolutions).toHaveLength(0);
  expect(f.pageErrors).toEqual([]);expect(f.consoleErrors).toEqual([]);expect(f.expectedErrors).toEqual([]);
});


/** Mock SDK/HTTP only: the lost stage response does not prove a real secret write. */
async function readbackFixture(page:Page,f:Awaited<ReturnType<typeof fixture>>){
  const sdk={appId:'12345678',configId:'87654321',graphVersion:'v24.0'},challenge='R'.repeat(43);
  const choiceId='55000000-0000-4000-8000-000000000093';
  let current:MetaSignupAttemptView|null=null,sequence=0,lostExchange=false,lostSelect=false,staged=false;
  const calls:Array<{path:string;body:Record<string,unknown>}>=[],reads:string[]=[];
  const initial=():MetaSignupAttemptView=>({purpose:'TRANSITION_READBACK',targetTransitionId:planId,target:{connectionId:connection,name:'Source (حساب)',state:'PAUSED'},
    attemptId:`55000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`,revision:1,expiresAt:new Date(Date.now()+600_000).toISOString(),
    status:'AWAITING_AUTHORIZATION',nextAction:'AUTHORIZE',canCancel:true,canStartAgain:false,choices:[],readiness:{authorization:'PENDING',number:'UNKNOWN',subscription:'UNKNOWN',messaging:'UNKNOWN',payment:{requestedPayer:'CUSTOMER',status:'UNKNOWN',paymentMethodVerified:false}}});
  const selection=(view:MetaSignupAttemptView):MetaSignupAttemptView=>({...view,revision:view.revision+1,status:'SELECTION_REQUIRED',nextAction:'SELECT_NUMBER',selectionRevision:1,
    readiness:{...view.readiness,authorization:'VERIFIED'},choices:[{choiceId,mode:'STANDARD',numberState:'UNKNOWN',selectable:true,businessName:'Original business',accountName:'Source account',displayPhoneNumber:'12025550143'},
      {choiceId:'55000000-0000-4000-8000-000000000094',mode:'STANDARD',numberState:'ACTION_REQUIRED',selectable:false,businessName:'Other',accountName:'Different account',displayPhoneNumber:'12025550144'}]});
  await page.route('https://connect.facebook.net/en_US/sdk.js',route=>route.fulfill({contentType:'text/javascript',body:'window.readbackCallbacks=[];window.FB={init(){},login(callback){window.readbackCallbacks.push(callback);}};'}));
  await page.route('**/api/connections/meta/signup/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.split('/signup/')[1];
    if(request.method()==='GET'){
      reads.push(url.pathname+url.search);
      if(path==='capabilities')return route.fulfill({json:{enabled:true,payerModes:['CUSTOMER'],sdk}});
      if(path==='attempts'){
        expect([...url.searchParams.keys()].sort()).toEqual(['targetConnectionId','targetTransitionId']);
        expect(url.searchParams.get('targetConnectionId')).toBe(connection);expect(url.searchParams.get('targetTransitionId')).toBe(planId);
        return route.fulfill({json:{attempt:current}});
      }
      expect(path).toBe(`attempts/${current?.attemptId}`);return route.fulfill({json:current});
    }
    const body=request.postDataJSON() as Record<string,unknown>;calls.push({path,body});
    if(path==='attempts'){
      expect(Object.keys(body).sort()).toEqual(['idempotencyKey','name','payerMode','targetConnectionId','targetTransitionId']);
      expect(body).toMatchObject({payerMode:'CUSTOMER',targetConnectionId:connection,targetTransitionId:planId});
      current=initial();return route.fulfill({json:{...current,challenge,sdk}});
    }
    expect(current).not.toBeNull();expect(path.startsWith(`attempts/${current!.attemptId}/`)).toBe(true);
    if(path.endsWith('/exchange')){
      expect(body).toEqual({expectedRevision:current!.revision,challenge,code:'readback-code-once'});current=selection(current!);
      if(lostExchange){lostExchange=false;return f.lost(route);}
    }else if(path.endsWith('/select')){
      expect(body).toEqual({expectedRevision:current!.revision,selectionRevision:current!.selectionRevision,choiceId});
      expect(Object.hasOwn(body,'registrationPin')).toBe(false);
      if(lostSelect){lostSelect=false;staged=true;current={...current!,revision:current!.revision+1,connectionId:connection};return f.lost(route);}
      if(staged)staged=false; // Exact staged selection readback, not a fresh authorization.
      current={...current!,revision:current!.revision+1,status:'COMPLETED',nextAction:'DONE',outcome:'READBACK_ACCESS_RENEWED',connectionId:connection,canCancel:false,canStartAgain:false};
      f.set({...f.get(),execution:{...f.get().execution!,revision:f.get().execution!.revision+1,
        renewals:[{connectionId:connection,name:'Source (حساب)',access:'RENEWED',canPrepare:false}],completionApprovalRequired:true}});
    }else if(path.endsWith('/cancel'))current={...current!,revision:current!.revision+1,status:'CANCELLED',nextAction:'START_AGAIN',canCancel:false,canStartAgain:true};
    else throw Error('Unexpected renewal effect');
    return route.fulfill({json:current});
  });
  return {calls,reads,get:()=>current,set:(value:MetaSignupAttemptView|null)=>{current=value;},initial,selection,
    loseExchange:()=>{lostExchange=true;},loseSelect:()=>{lostSelect=true;},
    callback:(code:string|null)=>page.evaluate(value=>{const callbacks=(window as unknown as {readbackCallbacks:Array<(v:unknown)=>void>}).readbackCallbacks;
      callbacks.at(-1)!(value?{authResponse:{code:value}}:{});},code)};
}

// Four owner contexts: EN/AR desktop1440 and mobile390; one EN auditor negative.
// Root selects these finite contexts using the existing application config.
test('Account recovery renews exact source read access without replaying or approving migration',async({page},testInfo)=>{
 // Multiple reloads and recovery phases need a bounded scenario budget on shared CI runners.
 test.setTimeout(90_000);
  const f=await fixture(page),r=await readbackFixture(page,f);
  const messages=(locale()==='ar'?arabicTenantMessages:englishTenantMessages) as Record<string,string>;
  const text=(key:string)=>messages[`tenant.metaSignup.${key}`]!;
  const setup=()=>page.locator('section[aria-labelledby="meta-signup-heading"]');
  const sb=(key:string)=>setup().getByRole('button',{name:text(key),exact:true});
  const open=async()=>{await section(page).getByRole('button',{name:copy('execution.renewal.open'),exact:true}).click();await expect(setup().getByRole('heading',{name:text('readback.title'),exact:true})).toBeVisible();};
  const visit=async()=>{await page.goto(`/app?view=connections&connection=${connection}`);await expect(section(page).getByRole('heading',{name:copy('execution.title'),exact:true})).toBeVisible();};
  f.set({...f.get(),canRefresh:false,canCancel:false,execution:{...f.get().execution!,state:'HELD',actions:{initiate:false,complete:false,observe:false,reconcile:false,cancel:false},
    history:[{stage:'INITIATE',outcome:'SUCCEEDED',attemptedAt:new Date().toISOString()}],providerStatus:'INITIATED',
    renewals:[{connectionId:connection,name:'Source (حساب)',access:'ORIGINAL',canPrepare:true}],completionApprovalRequired:true}});
  await visit();
  if(!['tenant_owner','tenant_admin'].includes(role())){
    await expect(section(page).getByRole('button',{name:copy('execution.renewal.open'),exact:true})).toHaveCount(0);
    expect(r.calls).toHaveLength(0);expect(f.writes).toHaveLength(0);return;
  }
  const original={schemaVersion:1,action:'OBSERVE',requestRevision:4,previewSha256:digest,key:'44000000-0000-4000-8000-000000000095',operationId};
  await page.evaluate(({key,value})=>sessionStorage.setItem(key,JSON.stringify(value)),{key:intentKey,value:original});await f.refresh();
  await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toBeVisible();
  await open();await expect(sb('readback.prepare')).toBeEnabled();await sb('readback.prepare').focus();await page.keyboard.press('Enter');
  await sb('connect').click();await sb('cancel').click();await r.callback('late-code');
  expect(r.calls.filter(call=>call.path.endsWith('/exchange'))).toHaveLength(0);
  await sb('readback.prepare').click();await page.reload();await open();
  await expect(setup().getByText(text('resumeAuthorization'),{exact:true})).toBeVisible();await expect(sb('connect')).toHaveCount(0);
  await sb('cancel').click();await sb('readback.prepare').click();await sb('connect').click();r.loseExchange();await r.callback('readback-code-once');
  await expect(setup().getByRole('radio').first()).toBeEnabled();expect(r.calls.filter(call=>call.path.endsWith('/exchange'))).toHaveLength(1);
  await page.reload();await open();await expect(setup().getByRole('radio').first()).toBeEnabled();expect(r.calls.filter(call=>call.path.endsWith('/exchange'))).toHaveLength(1);
  await expect(setup().locator('input[type="password"]')).toHaveCount(0);await expect(setup().getByRole('radio').nth(1)).toBeDisabled();
  // A fresh source hold revokes continuation while keeping exact status/cancel reachable.
  f.set({...f.get(),execution:{...f.get().execution!,renewals:[{...f.get().execution!.renewals[0],canPrepare:false}]}});await f.refresh();
  await expect(setup().getByRole('radio').first()).toBeDisabled();await expect(sb('cancel')).toBeEnabled();
  f.set({...f.get(),execution:{...f.get().execution!,renewals:[{...f.get().execution!.renewals[0],canPrepare:true}]}});await f.refresh();
  await setup().getByRole('radio').first().check();r.loseSelect();await sb('readback.select').click();
  await expect.poll(()=>r.calls.filter(call=>call.path.endsWith('/select')).length).toBe(1);
  await expect(sb('readback.select')).toBeEnabled();await page.reload();await open();
  expect(r.calls.filter(call=>call.path.endsWith('/select'))).toHaveLength(1);await setup().getByRole('radio').first().check();
  await sb('readback.select').click();await expect(setup().getByText(text('readback.status.COMPLETED'),{exact:true})).toBeVisible();
  await expect(setup().locator('input[type="password"]')).toHaveCount(0);
  expect((await new AxeBuilder({page}).include('section[aria-labelledby="meta-signup-heading"]').analyze()).violations).toEqual([]);
  await setup().getByRole('heading').scrollIntoViewIfNeeded();await testInfo.attach('readback-renewed',{body:await page.screenshot(),contentType:'image/png'});
  await sb('readback.back').first().click();await expect(setup()).toHaveCount(0);
  await expect(section(page).getByText(copy('execution.renewal.approval'),{exact:true})).toBeVisible();await expect(button(page,'complete')).toBeDisabled();
  expect(JSON.parse((await page.evaluate(key=>sessionStorage.getItem(key),intentKey))!)).toEqual(original);
  expect(f.writes).toHaveLength(0);expect(f.resolutions).toHaveLength(0);
  await page.reload();await expect(button(page,'complete')).toBeDisabled();expect(f.writes).toHaveLength(0);
  // Purpose, exact original plan and exact source mismatches remain fail-closed.
  const saved=r.get()!;
  for(const change of [{purpose:'RECONNECT' as const},{targetTransitionId:'33000000-0000-4000-8000-000000000099'},
    {target:{...saved.target!,connectionId:otherConnection}}]){
    r.set({...saved,...change});await open();await expect(setup().getByText(text('scopeChanged'),{exact:true})).toBeVisible();
    await expect(sb('readback.select')).toHaveCount(0);await sb('readback.back').last().click();
  }
  r.set(saved);
  expect(r.calls.filter(call=>call.path==='attempts')).toHaveLength(3);
  expect(r.calls.filter(call=>call.path.endsWith('/exchange'))).toHaveLength(1);
  expect(r.calls.filter(call=>call.path.endsWith('/select'))).toHaveLength(2);
  expect(r.calls.every(call=>!Object.hasOwn(call.body,'registrationPin')&&!Object.hasOwn(call.body,'purpose')&&!Object.hasOwn(call.body,'approval'))).toBe(true);
  // A correlated terminal observation settles only that observation. Renewal itself did not.
  f.set({...f.get(),execution:{...f.get().execution!,revision:20,state:'READY_TO_COMPLETE',providerStatus:'READY_TO_COMPLETE',
    pendingAction:{operationId,requestKey:original.key,action:'OBSERVE',state:'SUCCEEDED',requestRevision:4}}});
  await f.refresh();await expect(section(page).getByText(copy('execution.heldRequest'),{exact:true})).toHaveCount(0);
  await expect(button(page,'complete')).toBeDisabled();expect(f.writes).toHaveLength(0);
  // Separate current approval is a server capability; the browser sends no approval/credential override.
  f.set({...f.get(),execution:{...f.get().execution!,revision:21,completionApprovalRequired:false,actions:{...f.get().execution!.actions,complete:true}}});
  await f.refresh();await expect(button(page,'complete')).toBeEnabled();expect(f.writes).toHaveLength(0);
  page.once('dialog',dialog=>dialog.dismiss());await button(page,'complete').click();expect(f.writes).toHaveLength(0);
  page.once('dialog',dialog=>dialog.accept());await button(page,'complete').click();
  await expect.poll(()=>f.writes.map(write=>write.action)).toEqual(['complete']);
  expect(Object.keys(f.writes[0].body).sort()).toEqual(['expectedPreviewSha256','expectedRevision']);
  expect(f.pageErrors).toEqual([]);expect(f.consoleErrors).toEqual([]);expect(f.expectedErrors).toEqual([]);
});
