import { installMetaRoutingReadFixture } from "./meta-routing.fixture";
import AxeBuilder from '@axe-core/playwright';
import {expect,test} from '@playwright/test';
import {englishTenantMessages} from '../../lib/i18n/messages/en/tenant';
import {arabicTenantMessages} from '../../lib/i18n/messages/ar/tenant';
import {englishCommonMessages} from '../../lib/i18n/messages/en/common';
import {arabicCommonMessages} from '../../lib/i18n/messages/ar/common';

test('Customer responsibility is explicit, funding readiness stays separate, stale requests cannot change another connection',async({page},testInfo)=>{
 const locale=process.env.WASALX_E2E_LOCALE??'en',role=process.env.WASALX_E2E_ROLE??'tenant_owner';
 const messages:Record<string,string>=locale==='ar'?{...arabicTenantMessages,...arabicCommonMessages}:{...englishTenantMessages,...englishCommonMessages};
 const t=(key:string)=>messages[key]!;
 const alpha='12000000-0000-4000-8000-000000000081',beta='12000000-0000-4000-8000-000000000082';
 let credentialRefreshes=0;
 const posts:Array<{id:string;key:string;body:unknown}>=[],problems:string[]=[],expectedFailures:Array<{url:string;status:number}>=[];
 page.on('pageerror',error=>problems.push(error.message));page.on('console',message=>{
  if(message.type()!=='error')return;const index=expectedFailures.findIndex(v=>message.text().startsWith('Failed to load resource:')&&message.location().url===v.url&&new RegExp(`\\b${v.status}\\b`).test(message.text()));
  if(index>=0)expectedFailures.splice(index,1);else problems.push(message.text());
 });
 const empty={enrolled:false,mode:null,revision:0,sendReady:false,paymentMethod:'UNAVAILABLE',checkedAt:null,actualPayer:'UNVERIFIED',customerOwnership:'UNVERIFIED',managedAvailable:false,state:null};
 const views:Record<string,unknown>={[alpha]:empty,[beta]:empty};let phase='fixture',denial=403,delay=false,release:(()=>void)|undefined;
 await page.route('**/api/connections/**',async route=>{
  const path=new URL(route.request().url()).pathname,id=path.split('/')[3];if(![alpha,beta].includes(id)){await route.continue();return;}
  if(path.endsWith('/meta/billing-policy')){
   if(phase==='fixture'){await route.continue();return;}
   if(route.request().method()==='GET'){await route.fulfill({json:views[id]});return;}
   posts.push({id,key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()});
   if(denial){const status=denial;denial=0;if(status===409)views[id]={...empty,revision:1};expectedFailures.push({url:route.request().url(),status});await route.fulfill({status,json:{code:status===403?'REAUTHENTICATION_REQUIRED':status===409?'CONFLICT':'UNAVAILABLE'}});return;}
   expect((route.request().postDataJSON() as {expectedRevision:number}).expectedRevision).toBe((views[id] as {revision:number}).revision);
   if(delay){delay=false;await new Promise<void>(resolve=>{release=resolve;});}
   views[id]={...empty,enrolled:true,mode:'CUSTOMER',revision:2,paymentMethod:'NONE',state:'SUCCEEDED'};
   await route.fulfill({status:202,json:{operation:{id:'12000000-0000-4000-8000-000000000091',type:'VERIFY_META_BILLING',state:'QUEUED'},duplicate:false}}).catch(()=>{});return;
  }
  if(path.endsWith('/meta/credentials')){expect(route.request().method()).toBe('POST');expect(route.request().postDataJSON()).toEqual({accessToken:'synthetic-policy-rotation-token'});credentialRefreshes++;await route.fulfill({status:202,json:{operation:{id:'synthetic-credential-refresh',state:'SUCCEEDED'}}});return;}
  if(path.endsWith('/meta/capabilities')){await route.fulfill({json:{eligible:false,state:'CONSENT_REQUIRED',evidence:'local_policy',checkedAt:new Date().toISOString()}});return;}
  if(path===`/api/connections/${id}`){await route.fulfill({json:{id,name:id===alpha?'Payment Alpha':'Payment Beta',provider:'META',state:'PAUSED',provider_session_state:'PAUSED',provider_state:'STOPPED',webhook_state:'PAUSED',disclosure_version:null,latest_operation_type:'PAUSE',latest_operation_state:'SUCCEEDED',last_heartbeat_at:new Date().toISOString(),group_count:0}});return;}
  await route.continue();
 });
  await installMetaRoutingReadFixture(page);
 await page.goto(`/app?view=connections&connection=${alpha}`);await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
 const section=page.locator('section').filter({has:page.getByRole('heading',{name:t('tenant.connection.paymentPolicy.title'),exact:true})});
 const select=section.getByRole('button',{name:t('tenant.connection.paymentPolicy.select'),exact:true});
 const checkbox=section.getByRole('checkbox',{name:t('tenant.connection.paymentPolicy.customer'),exact:true});
 await expect(section.getByText(t('tenant.connection.paymentPolicy.legacy'),{exact:true})).toBeVisible();
 await expect(section.getByText(t('tenant.connection.paymentPolicy.managed'),{exact:true})).toBeVisible();
 const fixture=await page.request.get(`/api/connections/${alpha}/meta/billing-policy`);expect(await fixture.json()).toEqual(empty);expect(fixture.headers()['cache-control']).toContain('no-store');
 if(!['tenant_owner','tenant_admin'].includes(role)){await expect(select).toHaveCount(0);await expect(checkbox).toHaveCount(0);expect(posts).toHaveLength(0);}
 else{
  await expect(checkbox).not.toBeChecked();await expect(select).toBeDisabled();
  await checkbox.focus();await page.keyboard.press('Space');await expect(checkbox).toBeChecked();
  expectedFailures.push({url:new URL(`/api/connections/${alpha}/meta/billing-policy`,page.url()).href,status:501});
  await expect(select).toBeEnabled();await select.focus();await expect(select).toBeFocused();
  await page.keyboard.press('Enter');await expect(section.getByRole('alert')).toContainText(t('common.errors.unavailable'));
  phase='simulated';await page.reload();await checkbox.check();await select.click();
  await expect(section.getByRole('alert')).toContainText(t('common.errors.reauthenticationRequired'));await expect(section.getByRole('link')).toHaveAttribute('href',/step_up=privileged/);
  denial=409;await select.click();await expect(section.getByRole('alert')).toContainText(t('common.errors.conflict'));expect(posts[0].key).toBe(posts[1].key);
  await section.getByRole('button',{name:t('common.actions.retry'),exact:true}).click();await expect(section.getByRole('alert')).toHaveCount(0);
  await select.click();await expect(section.getByText(t('tenant.connection.paymentPolicy.held'),{exact:true})).toBeVisible();
  expect(posts[2].key).not.toBe(posts[1].key);expect(posts[2].body).toMatchObject({expectedRevision:1});await expect(checkbox).not.toBeChecked();
  // An uncertain response retains its original idempotency identity; a known
  // revision rejection above starts a new deliberate identity instead.
  await checkbox.check();denial=503;await select.click();await expect(section.getByRole('alert')).toContainText(t('common.errors.unavailable'));
  const uncertain=posts.at(-1)!;await select.click();await expect(section.getByRole('alert')).toHaveCount(0);
  expect(posts.at(-1)!.key).toBe(uncertain.key);expect(posts.at(-1)!.body).toEqual(uncertain.body);
  views[alpha]={...empty,enrolled:true,mode:'CUSTOMER',revision:3,paymentMethod:'PRESENT',sendReady:true,state:'SUCCEEDED'};
  await page.reload();await expect(section.getByText(t('tenant.connection.paymentPolicy.ready'),{exact:true})).toBeVisible();
  await checkbox.check();const beforeCredentialRefresh=posts.length;
  await page.locator(`#meta-access-token-${alpha}`).fill('synthetic-policy-rotation-token');
  await page.getByRole('button',{name:t('tenant.connection.metaCredential.replace'),exact:true}).click();
  await expect(checkbox).not.toBeChecked();await expect(select).toBeDisabled();expect(credentialRefreshes).toBe(1);expect(posts).toHaveLength(beforeCredentialRefresh);
  await checkbox.check();delay=true;await select.click();await expect.poll(()=>Boolean(release)).toBe(true);
  await page.evaluate(id=>{history.pushState({},'',`/app?view=connections&connection=${id}`);dispatchEvent(new PopStateEvent('popstate'));},beta);
  await expect(section.getByText(t('tenant.connection.paymentPolicy.legacy'),{exact:true})).toBeVisible();release!();release=undefined;
  await expect(checkbox).not.toBeChecked();await expect(select).toBeDisabled();await checkbox.check();await select.click();
  await expect(section.getByText(t('tenant.connection.paymentPolicy.held'),{exact:true})).toBeVisible();expect(posts.at(-1)?.id).toBe(beta);expect(posts.at(-1)?.key).not.toBe(posts.at(-2)?.key);
  for(const post of posts){expect(post.body).toMatchObject({mode:'CUSTOMER'});expect(Object.keys(post.body as object).sort()).toEqual(['expectedRevision','mode']);}
 }
 const bounds=await section.boundingBox();expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
 expect((await new AxeBuilder({page}).include('section[aria-labelledby^="payment-policy-"]').analyze()).violations).toEqual([]);
 await testInfo.attach('customer-policy',{body:await section.screenshot(),contentType:'image/png'});expect(problems).toEqual([]);expect(expectedFailures).toEqual([]);
});
