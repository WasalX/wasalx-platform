import {installMetaRoutingReadFixture} from "./meta-routing.fixture";
import AxeBuilder from '@axe-core/playwright';
import {expect,type ConsoleMessage,type Page,type TestInfo} from '@playwright/test';
import type {MetaAddAccessActivationView} from '../../packages/core/src/meta-add-access-activation-contract';
import {englishTenantMessages} from '../../lib/i18n/messages/en/tenant';
import {arabicTenantMessages} from '../../lib/i18n/messages/ar/tenant';
type ExpectedFailure={url:string;status:403}|{url:string;error:'net::ERR_FAILED'};
const failures=new WeakMap<Page,ExpectedFailure[]>();
export function consumeExpectedActivationDenial(page:Page,message:ConsoleMessage){
 if(!message.text().startsWith('Failed to load resource:'))return false;const expected=failures.get(page);
 const i=expected?.findIndex(x=>x.url===message.location().url&&('status'in x
  ?new RegExp(`\\b${x.status}\\b`).test(message.text())
  :message.text()===`Failed to load resource: ${x.error}`))??-1;
 if(i<0)return false;expected!.splice(i,1);return true;
}
/** Local HTTP fixtures: receiving state and provider readbacks are simulated. */
export async function metaSavedActivationJourney(page:Page,locale:'en'|'ar',role:string,info:TestInfo){
 const copy:Readonly<Record<string,string>>=locale==='ar'?arabicTenantMessages:englishTenantMessages,t=(key:string)=>copy[key]!;
 const id='12000000-0000-4000-8000-000000000071',other='12000000-0000-4000-8000-000000000072',version='a'.repeat(64);
 let state='PAUSED',postMode:'ok'|'lost'|'reauth'='ok',wrong=false,holdRead=false,release:(()=>void)|undefined;
 const writes:{key:string|null;body:unknown}[]=[],problems:string[]=[],expected:ExpectedFailure[]=[];failures.set(page,expected);
 let view:MetaAddAccessActivationView={connectionId:id,applicable:true,readyToCheck:false,reason:'FUNDING_REQUIRED',contextVersion:null,operation:null,providerConfigurationReadback:false,conversationPermission:'SEPARATE_REQUIRED'};
 const ready=()=>{view={...view,readyToCheck:true,reason:'READY_TO_CHECK',contextVersion:version,operation:null};};
 page.on('pageerror',error=>problems.push(error.message));
 await page.route('**/api/connections/**',async route=>{
  const url=new URL(route.request().url());if(url.pathname===`/api/connections/${id}`)return route.fulfill({json:{id,name:'Saved access',provider:'META',state,provider_session_state:state,provider_state:'STOPPED',webhook_state:state==='WORKING'?'ACTIVE':'PAUSED',disclosure_version:null,group_count:0,latest_operation_type:'START',latest_operation_state:view.operation?.state??'SUCCEEDED'}});
  if(url.pathname===`/api/connections/${id}/meta/activation`){
   if(route.request().method()==='GET'){
    const captured={...view,...(wrong?{connectionId:other}:{})};if(holdRead){holdRead=false;await new Promise<void>(resolve=>{release=resolve;});}
    return route.fulfill({json:captured});
   }
   writes.push({key:route.request().headers()['idempotency-key']??null,body:route.request().postDataJSON()});
   expect(writes.at(-1)!.body).toEqual({expectedContextVersion:version});expect(writes.at(-1)!.key).toBeTruthy();
   if(postMode==='reauth'){expected.push({url:route.request().url(),status:403});return route.fulfill({status:403,json:{code:'REAUTHENTICATION_REQUIRED'}});}
   view={...view,readyToCheck:false,reason:'CONNECTION_BUSY',contextVersion:null,operation:{id:'75000000-0000-4000-8000-000000000071',state:'QUEUED',locallyActivated:false}};
   if(postMode==='lost'){expected.push({url:route.request().url(),error:'net::ERR_FAILED'});return route.abort('failed');}
   return route.fulfill({status:202,json:{id,state:'PAUSED',operation:{id:view.operation!.id,type:'START',state:'QUEUED',attempts:0,created_at:new Date().toISOString()},duplicate:false}});
  }
  if(url.pathname===`/api/connections/${id}/meta/capabilities`)return route.fulfill({json:{eligible:false,state:'CONSENT_REQUIRED',evidence:'local_policy',checkedAt:new Date().toISOString()}});
  return route.continue();
 });
 await installMetaRoutingReadFixture(page);
 const open=async()=>{await page.goto(`/app?view=connections&connection=${id}`,{waitUntil:"commit"});await expect(page.locator('[data-application-ready="true"]')).toBeVisible();return page.locator(`section[aria-labelledby="saved-access-${id}"]`);};
 let section=await open();const act=()=>section.getByRole('button',{name:t('tenant.metaActivation.activate'),exact:true}),refresh=()=>section.getByRole('button',{name:t('tenant.metaActivation.refresh'),exact:true});
 await expect(section.getByText(t('tenant.metaActivation.reason.FUNDING_REQUIRED'),{exact:true})).toBeVisible();
 if(!['tenant_owner','tenant_admin'].includes(role)){await expect(act()).toHaveCount(0);expect(writes).toHaveLength(0);expect(expected).toEqual([]);expect(problems).toEqual([]);return;}
 await expect(act()).toBeDisabled();ready();await refresh().click();await expect(act()).toBeEnabled();
 await act().scrollIntoViewIfNeeded();await info.attach('saved-access-ready-actions',{body:await page.screenshot(),contentType:'image/png'});
 postMode='reauth';await act().focus();await expect(act()).toBeFocused();await page.keyboard.press('Enter');await expect(section.getByRole('link',{name:t('tenant.connection.reauthenticate'),exact:true})).toBeVisible();expect(writes).toHaveLength(1);
 postMode='lost';await act().evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});
 await expect(section.getByText(t('tenant.metaActivation.checking'),{exact:true})).toBeVisible();expect(writes).toHaveLength(2);await expect(act()).toBeDisabled();
 view={...view,readyToCheck:false,reason:'PAUSE_REQUIRED',operation:{...view.operation!,state:'SUCCEEDED',locallyActivated:true}};state='WORKING';
 await refresh().click();await expect(section.getByText(t('tenant.metaActivation.completed'),{exact:true})).toBeVisible();await expect(section.getByRole('alert')).toHaveCount(0);
 section=await open();await expect(section.getByText(t('tenant.metaActivation.completed'),{exact:true})).toBeVisible();expect(writes).toHaveLength(2);
 await section.getByRole('heading',{name:t('tenant.metaActivation.title'),exact:true}).scrollIntoViewIfNeeded();await info.attach('saved-access-completed-top',{body:await page.screenshot(),contentType:'image/png'});
 await refresh().scrollIntoViewIfNeeded();await info.attach('saved-access-completed-actions',{body:await page.screenshot(),contentType:'image/png'});
 expect((await new AxeBuilder({page}).include(`section[aria-labelledby="saved-access-${id}"]`).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
 // Wrong-resource status never enables the action, and a late unmounted read
 // cannot overwrite the next connection's state or submit another command.
 state='PAUSED';ready();wrong=true;section=await open();await expect(section.getByRole('alert')).toBeVisible();await expect(act()).toBeDisabled();wrong=false;
 holdRead=true;const pending=refresh().click();await pending;await page.goto('/app?view=connections');release?.();release=undefined;
 section=await open();await expect(act()).toBeEnabled();expect(writes).toHaveLength(2);
 await expect.poll(()=>expected,{message:'Every deliberately induced activation failure must be consumed exactly once'}).toEqual([]);expect(problems).toEqual([]);
}
