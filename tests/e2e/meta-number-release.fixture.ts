import AxeBuilder from '@axe-core/playwright';
import {expect,type ConsoleMessage,type Page,type TestInfo} from '@playwright/test';
import {installMetaRoutingReadFixture} from './meta-routing.fixture';
import {englishTenantMessages} from '../../lib/i18n/messages/en/tenant';
import {arabicTenantMessages} from '../../lib/i18n/messages/ar/tenant';
import type {NumberReleaseView} from '../../lib/meta-number-release-intent';
import type {MetaAddAccessActivationView} from '../../packages/core/src/meta-add-access-activation-contract';

const failures=new WeakMap<Page,{url:string;status:number}[]>();
export function consumeExpectedNumberReleaseDenial(page:Page,message:ConsoleMessage){
  if(!message.text().startsWith('Failed to load resource:'))return false;
  const expected=failures.get(page),index=expected?.findIndex(item=>item.url===message.location().url&&new RegExp(`\\b${item.status}\\b`).test(message.text()))??-1;
  if(index<0)return false;expected!.splice(index,1);return true;
}
/** Local HTTP fixtures only: no number reservation, provider account or live release is modified. */
export async function metaNumberReleaseJourney(page:Page,locale:'en'|'ar',role:string,info:TestInfo){
  const copy:Readonly<Record<string,string>>=locale==='ar'?arabicTenantMessages:englishTenantMessages,t=(key:string)=>copy[`tenant.metaNumberRelease.${key}`]!;
  const id='12000000-0000-4000-8000-000000000071',routeId='79000000-0000-4000-8000-000000000004',operationId='79000000-0000-4000-8000-000000000005',releaseId='79000000-0000-4000-8000-000000000007';
  const binding={routeId,phoneNumberId:'1234567890',disconnectOperationId:operationId};
  let view:NumberReleaseView={...binding,disconnectOperationId:null,releaseId:null,state:'REVOKED',reconnectRequiresNewConnection:true};
  let mode:'reauth'|'forbidden'|'notReady'|'malformed'|'success'|'lostApplied'|'receiptMismatch'|'receiptMismatchAgain'='reauth',badView=false,hold=false,releaseRead:(()=>void)|undefined;
  const writes:{key:string;body:unknown}[]=[],expected:{url:string;status:number}[]=[],errors:string[]=[];failures.set(page,expected);
  let savedAccessReads=0;
  const savedAccess:MetaAddAccessActivationView={connectionId:id,applicable:true,readyToCheck:false,reason:'PAUSE_REQUIRED',contextVersion:null,operation:{id:'79000000-0000-4000-8000-000000000009',state:'SUCCEEDED',locallyActivated:true},providerConfigurationReadback:false,conversationPermission:'SEPARATE_REQUIRED'};
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/connections/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path===`/api/connections/${id}`)return route.fulfill({json:{id,name:'Release review',provider:'META',state:'REVOKED',provider_session_state:'STOPPED',provider_state:'STOPPED',webhook_state:'PAUSED',disclosure_version:null,group_count:0,latest_operation_type:'DISCONNECT',latest_operation_state:view.disconnectOperationId?'SUCCEEDED':'RUNNING'}});
    if(path===`/api/connections/${id}/meta/activation`){expect(route.request().method()).toBe('GET');savedAccessReads++;return route.fulfill({json:savedAccess});}
    if(path===`/api/connections/${id}/meta/number-release`){
      if(route.request().method()==='GET'){
        const captured=badView?{...view,phoneNumberId:'<private>'}:{...view};if(hold){hold=false;await new Promise<void>(resolve=>{releaseRead=resolve;});}
        return route.fulfill({json:captured});
      }
      writes.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()});
      expect(writes.at(-1)!.key).toMatch(/^[0-9a-f-]{36}$/u);expect(writes.at(-1)!.body).toEqual(binding);
      if(['reauth','forbidden','notReady'].includes(mode)){
        const status=mode==='notReady'?409:403,code=mode==='reauth'?'REAUTHENTICATION_REQUIRED':mode==='forbidden'?'META_NUMBER_RELEASE_FORBIDDEN':'META_NUMBER_RELEASE_NOT_READY';
        expected.push({url:route.request().url(),status});return route.fulfill({status,json:{code,message:'PRIVATE_PROVIDER_MESSAGE'}});
      }
      if(mode==='malformed')return route.fulfill({json:{id:releaseId,released:true,duplicate:'false',reconnectRequiresNewConnection:true}});
      view={...view,releaseId:mode.startsWith('receiptMismatch')?'79000000-0000-4000-8000-000000000008':releaseId};
      if(mode==='lostApplied')return route.fulfill({body:'{',contentType:'application/json'});
      return route.fulfill({json:{id:mode==='receiptMismatchAgain'?view.releaseId:releaseId,released:true,duplicate:false,reconnectRequiresNewConnection:true}});
    }
    if(path.endsWith('/meta/capabilities'))return route.fulfill({json:{eligible:false,state:'CONSENT_REQUIRED',evidence:'local_policy',checkedAt:new Date().toISOString()}});
    return route.continue();
  });
  await installMetaRoutingReadFixture(page);
  const open=async()=>{await page.goto(`/app?view=connections&connection=${id}`,{waitUntil:"commit"});await expect(page.locator('[data-application-ready="true"]')).toBeVisible();return page.locator(`section[aria-labelledby="number-release-${id}"]`);};
  let section=await open();const act=()=>section.getByRole('button',{name:t('action'),exact:true}),refresh=()=>section.getByRole('button',{name:t('refresh'),exact:true});
  const dialog=()=>page.getByRole('dialog',{name:t('confirmTitle'),exact:true}),confirm=()=>dialog().getByRole('button',{name:t('action'),exact:true});
  const retiredAccess=async()=>{
    const saved=page.locator(`section[aria-labelledby="saved-access-${id}"]`);
    await expect(saved.getByText(copy['tenant.metaActivation.completed'],{exact:true})).toBeVisible();
    await expect.soft(page.getByRole('heading',{name:copy['tenant.metaSignup.reconnect.title'],exact:true})).toHaveCount(0,{timeout:500});
    await expect.soft(page.getByRole('button',{name:copy['tenant.connection.metaCredential.replace'],exact:true})).toHaveCount(0,{timeout:500});
    await expect.soft(saved.getByText(copy['tenant.metaActivation.reason.PAUSE_REQUIRED'],{exact:true})).toHaveCount(0,{timeout:500});
    await expect.soft(saved.getByRole('button',{name:copy['tenant.metaActivation.activate'],exact:true})).toHaveCount(0,{timeout:500});
    await expect.soft(saved.getByText(copy['tenant.connection.guidance.revoked.body'],{exact:true})).toBeVisible({timeout:500});
    const before=savedAccessReads;await saved.getByRole('button',{name:copy['tenant.metaActivation.refresh'],exact:true}).click();await expect.poll(()=>savedAccessReads).toBeGreaterThan(before);
    await expect(saved.getByText(copy['tenant.metaActivation.completed'],{exact:true})).toBeVisible();
  };
  await retiredAccess();
  await info.attach('retired-meta-saved-history',{body:await page.screenshot(),contentType:'image/png'});
  if(!['tenant_owner','tenant_admin'].includes(role)){await expect(section).toHaveCount(0);expect(writes).toEqual([]);return;}
  await expect(section.getByText(t('disconnectPending'),{exact:true})).toBeVisible();await expect(act()).toBeDisabled();view={...view,disconnectOperationId:operationId};await refresh().click();await expect(act()).toBeEnabled();
  await expect(section.getByRole('heading',{name:t('title'),exact:true})).toBeInViewport();
  await act().click();await expect(dialog().getByRole('button',{name:t('cancel'),exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(dialog()).toHaveCount(0);await expect(act()).toBeFocused();expect(writes).toHaveLength(0);
  await act().click();await info.attach('release-number-confirmation',{body:await page.screenshot(),contentType:'image/png'});
  const bounds=await dialog().locator('.modal').boundingBox(),viewport=page.viewportSize()!;expect(bounds).not.toBeNull();expect(bounds!.x).toBeGreaterThanOrEqual(19);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(viewport.width-19);
  expect((await new AxeBuilder({page}).include('dialog').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await confirm().click();await expect(dialog().getByRole('link',{name:copy['tenant.connection.reauthenticate'],exact:true})).toHaveAttribute('href',`/auth/login?step_up=privileged&return_to=${encodeURIComponent(`/app?view=connections&connection=${id}`)}`);await expect(confirm()).toBeDisabled();
  section=await open();expect(writes).toHaveLength(1);mode='forbidden';await act().click();await confirm().click();await expect(dialog().getByText(t('error.forbidden'),{exact:true})).toBeVisible();await expect(dialog().getByRole('link')).toHaveCount(0);await expect(confirm()).toBeDisabled();
  mode='notReady';await dialog().getByRole('button',{name:t('refresh'),exact:true}).click();await confirm().click();await expect(dialog().getByText(t('error.notReady'),{exact:true})).toBeVisible();await expect(confirm()).toBeDisabled();
  mode='malformed';await dialog().getByRole('button',{name:t('refresh'),exact:true}).click();await expect(confirm()).toBeEnabled();await confirm().evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});
  await expect(dialog().getByText(t('error.unknown'),{exact:true})).toBeVisible();expect(writes).toHaveLength(4);const original=writes[3];
  await expect(dialog().getByRole('button',{name:t('close'),exact:true})).toBeVisible();await expect(dialog().getByRole('button',{name:t('cancel'),exact:true})).toHaveCount(0);
  section=await open();await expect(section.getByText(t('error.unknown'),{exact:true})).toBeVisible();expect(writes).toHaveLength(4);
  const storageKey=await page.evaluate(()=>Object.keys(sessionStorage).find(key=>key.startsWith('wasalx.meta.number-release:'))!);expect(storageKey).toBeTruthy();
  // A changed binding must retain the uncertain original instead of silently creating another command.
  view={...view,routeId:'79000000-0000-4000-8000-000000000099',releaseId};await refresh().click();await expect(section.getByText(t('bindingChanged'),{exact:true})).toBeVisible();await expect(act()).toBeDisabled();expect(writes).toHaveLength(4);
  section=await open();await expect(section.getByText(t('bindingChanged'),{exact:true})).toBeVisible();await expect(section.getByText(t('released'),{exact:true})).toHaveCount(0);
  view={...view,routeId,releaseId:null};await refresh().click();await act().click();mode='forbidden';await dialog().getByRole('button',{name:t('retry'),exact:true}).click();
  await expect(dialog().getByText(t('error.forbidden'),{exact:true})).toBeVisible();section=await open();await expect(section.getByText(t('error.unknown'),{exact:true})).toBeVisible();expect(writes).toHaveLength(5);expect(writes[4]).toEqual(original);
  await act().click();mode='success';await dialog().getByRole('button',{name:t('retry'),exact:true}).click();
  await expect(section.getByText(t('released'),{exact:true})).toBeVisible();await expect(dialog()).toHaveCount(0);await expect(refresh()).toBeFocused();expect(writes).toHaveLength(6);expect(writes[5]).toEqual(original);
  await retiredAccess();
  await refresh().scrollIntoViewIfNeeded();await info.attach('release-number-completed',{body:await page.screenshot(),contentType:'image/png'});
  expect((await new AxeBuilder({page}).include(`section[aria-labelledby="number-release-${id}"]`).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  // A contradictory receipt remains held through normal reads and reload, preserving its known ACK.
  view={...view,releaseId:null};section=await open();mode='receiptMismatch';await act().click();await confirm().click();await expect(dialog().getByText(t('bindingChanged'),{exact:true})).toBeVisible();
  section=await open();await expect(section.getByText(t('bindingChanged'),{exact:true})).toBeVisible();await expect(section.getByText(t('released'),{exact:true})).toHaveCount(0);expect(writes).toHaveLength(7);
  view={...view,releaseId:null};await refresh().click();await act().click();mode='receiptMismatchAgain';await dialog().getByRole('button',{name:t('retry'),exact:true}).click();await expect(dialog().getByText(t('bindingChanged'),{exact:true})).toBeVisible();
  section=await open();await expect(section.getByText(t('bindingChanged'),{exact:true})).toBeVisible();expect(writes).toHaveLength(8);expect(writes[7]).toEqual(writes[6]);expect(await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)!).acknowledgmentId,storageKey)).toBe(releaseId);
  view={...view,releaseId};await refresh().click();await expect(section.getByText(t('released'),{exact:true})).toBeVisible();
  // A lost acknowledgement with an applied result settles by readback without another write.
  view={...view,releaseId:null};section=await open();mode='lostApplied';await act().click();await confirm().click();await expect(section.getByText(t('released'),{exact:true})).toBeVisible();expect(writes).toHaveLength(9);
  // Invalid status and late unmounted reads never enable a mutation on another screen.
  view={...view,releaseId:null};badView=true;section=await open();await expect(section.getByText(t('error.unavailable'),{exact:true})).toBeVisible();await expect(act()).toBeDisabled();badView=false;
  await refresh().click();await expect(act()).toBeEnabled();hold=true;await refresh().click();await expect.poll(()=>Boolean(releaseRead)).toBe(true);await page.goto('/app?view=connections');releaseRead?.();releaseRead=undefined;
  section=await open();await expect(act()).toBeEnabled();expect(writes).toHaveLength(9);
  await page.evaluate(key=>sessionStorage.setItem(key,'{'),storageKey);section=await open();await expect(section.getByText(t('storage'),{exact:true})).toBeVisible();await expect(act()).toBeDisabled();expect(writes).toHaveLength(9);
  await page.evaluate(key=>sessionStorage.removeItem(key),storageKey);section=await open();await expect(act()).toBeEnabled();
  // Failure to clear an already confirmed receipt does not disguise the saved release or permit a new write.
  await page.evaluate(()=>{const original=Storage.prototype.removeItem;Storage.prototype.removeItem=function(key){if(key.startsWith('wasalx.meta.number-release:'))throw new DOMException('Blocked','SecurityError');return original.call(this,key);};});
  mode='success';await act().click();await confirm().click();await expect(section.getByText(t('released'),{exact:true})).toBeVisible();expect(writes).toHaveLength(10);
  section=await open();await expect(section.getByText(t('released'),{exact:true})).toBeVisible();expect(writes).toHaveLength(10);
  view={...view,releaseId:null};section=await open();await expect(act()).toBeEnabled();
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('wasalx.meta.number-release:'))throw new DOMException('Blocked','SecurityError');return original.call(this,key,value);};});
  await act().click();await confirm().click();await expect(dialog().getByText(t('storage'),{exact:true})).toBeVisible();await expect(confirm()).toBeDisabled();expect(writes).toHaveLength(10);
  await expect(page.getByText('PRIVATE_PROVIDER_MESSAGE',{exact:true})).toHaveCount(0);
  await expect.poll(()=>expected,{message:'Each induced number-release HTTP error must be consumed exactly once'}).toEqual([]);expect(errors).toEqual([]);
}
