import { installMetaRoutingReadFixture } from "./meta-routing.fixture";
import AxeBuilder from '@axe-core/playwright';
import {expect,test} from '@playwright/test';
import {englishTenantMessages} from '../../lib/i18n/messages/en/tenant';
import {arabicTenantMessages} from '../../lib/i18n/messages/ar/tenant';
import {englishCommonMessages} from '../../lib/i18n/messages/en/common';
import {arabicCommonMessages} from '../../lib/i18n/messages/ar/common';
test('approved managed terms record intent without a funding or send-ready claim',async({page},testInfo)=>{
 // This scenario exercises several acknowledged and uncertain retries under the bounded CI CPU cap.
 test.setTimeout(90_000);
 const locale=process.env.WASALX_E2E_LOCALE??'en',role=process.env.WASALX_E2E_ROLE??'tenant_owner';
 const messages:Record<string,string>=locale==='ar'?{...arabicTenantMessages,...arabicCommonMessages}:{...englishTenantMessages,...englishCommonMessages};
 const t=(key:string)=>messages[key]!,id='12000000-0000-4000-8000-000000000081',choiceId='23000000-0000-4000-8000-000000000081';
 const choice={choiceId,kind:'OWN_SOLUTION_PARTNER_LINE',evidenceMode:'SIMULATED',expiresAt:'2099-01-01T00:00:00+00:00',documentSha256:'a'.repeat(64),documentText:'Bounded simulated payment terms: no live funding arrangement.'};
 const firstTariff='34000000-0000-4000-8000-000000000081',nextTariff='34000000-0000-4000-8000-000000000082';
 const offer={id:firstTariff,definitionSha256:'b'.repeat(64),documentSha256:choice.documentSha256,documentText:choice.documentText,evidenceMode:'SIMULATED',
  currency:'KWD',minorUnits:3,timezone:'Asia/Kuwait',effectiveFrom:'2099-01-01T00:00:01.123Z',effectiveTo:'2099-02-01T00:00:02.456Z',rounding:'LINE',product:'CLOUD_API',unit:'DELIVERED_MESSAGE',pricingModel:'PMP',policyFamily:'ORDINARY_BUSINESS_MESSAGING',
  rates:[{category:'utility',pricingType:'regular',billable:true,schedule:'ORDINARY',market:'KW',tier:'STANDARD',unitPrice:'0.005123'}]};
 let enableTariffs=false,uncertain=false,hideOffers=false;let acknowledgement:'invalid'|'wrong'|'empty'|null=null;let credentialRefreshes=0;
 let revision=1,selected=false,deny=true;const posts:Array<{key:string;body:unknown}>=[],errors:string[]=[],expected:Array<{url:string;status:number}>=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()!=='error')return;
  const i=expected.findIndex(e=>m.text().startsWith('Failed to load resource:')&&m.location().url===e.url&&new RegExp(`\\b${e.status}\\b`).test(m.text()));
  if(i>=0)expected.splice(i,1);else errors.push(m.text());});
 await page.route('**/api/connections/**',async route=>{
  const path=new URL(route.request().url()).pathname;if(!path.includes(id)){await route.continue();return;}
  if(path.endsWith('/meta/billing-policy')){
   if(route.request().method()==='GET'){const query=new URL(route.request().url()).searchParams;
    const page=enableTariffs&&query.has('tariffMode')&&!hideOffers?{items:[query.has('tariffAfter')?{...offer,id:nextTariff,definitionSha256:'c'.repeat(64)}:offer],nextAfter:query.has('tariffAfter')?null:firstTariff}:{items:[],nextAfter:null};
    await route.fulfill({json:{enrolled:true,mode:selected?'MANAGED':'CUSTOMER',revision,sendReady:false,paymentMethod:'NONE',checkedAt:null,actualPayer:'UNVERIFIED',customerOwnership:'UNVERIFIED',managedAvailable:true,managedChoices:[choice],state:'SUCCEEDED',...(query.has('tariffMode')?{tariffOffers:page}:{})}});return;}
   const body=route.request().postDataJSON();posts.push({key:route.request().headers()['idempotency-key'],body});
   if(deny){deny=false;revision++;expected.push({url:route.request().url(),status:409});await route.fulfill({status:409,json:{code:'CONFLICT'}});return;}
   if(body.tariffVersionId){
    expect(body.documentSha256).toBe(offer.documentSha256);expect(body.acceptedTerms).toBe(true);
    expect(body.tariffDefinitionSha256).toBe(body.tariffVersionId===nextTariff?'c'.repeat(64):offer.definitionSha256);
    if(uncertain){uncertain=false;hideOffers=true;revision++;expected.push({url:route.request().url(),status:503});await route.fulfill({status:503,json:{code:'UNAVAILABLE'}});return;}
    selected=body.mode==='MANAGED';revision++;
    const fault=acknowledgement;acknowledgement=null;
    if(fault==='invalid'||fault==='empty'){await route.fulfill({status:202,contentType:'application/json',body:fault==='invalid'?'{':''});return;}
    await route.fulfill({status:202,json:{requestedMode:fault==='wrong'?(body.mode==='CUSTOMER'?'MANAGED':'CUSTOMER'):body.mode,state:'HELD',sendReady:false,replay:hideOffers}});return;
   }
   expect(body).toEqual({mode:'MANAGED',expectedRevision:revision,choiceId,documentSha256:choice.documentSha256,acceptedTerms:true});
   selected=true;revision++;await route.fulfill({status:202,json:{requestedMode:'MANAGED',state:'HELD',sendReady:false,replay:false}});return;
  }
  if(path.endsWith('/meta/credentials')){expect(route.request().method()).toBe('POST');expect(route.request().postDataJSON()).toEqual({accessToken:'synthetic-policy-rotation-token'});credentialRefreshes++;await route.fulfill({status:202,json:{operation:{id:'synthetic-credential-refresh',state:'SUCCEEDED'}}});return;}
  if(path.endsWith('/meta/capabilities')){await route.fulfill({json:{eligible:false,state:'CONSENT_REQUIRED',evidence:'local_policy',checkedAt:new Date().toISOString()}});return;}
  if(path===`/api/connections/${id}`){await route.fulfill({json:{id,name:'Managed policy',provider:'META',state:'PAUSED',provider_session_state:'PAUSED',provider_state:'STOPPED',webhook_state:'PAUSED',disclosure_version:null,latest_operation_type:'PAUSE',latest_operation_state:'SUCCEEDED',last_heartbeat_at:new Date().toISOString(),group_count:0}});return;}
  await route.continue();
 });
  await installMetaRoutingReadFixture(page);
 await page.goto(`/app?view=connections&connection=${id}`);await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
 const policySelector=`section[aria-labelledby="payment-policy-${id}"]`;
 const section=page.locator(policySelector);
 await expect(section).toBeVisible();
 const select=section.getByRole('button',{name:t('tenant.connection.paymentPolicy.select'),exact:true});
 if(!['tenant_owner','tenant_admin'].includes(role)){
  await expect(section.getByRole('status')).toHaveText(t('tenant.connection.paymentPolicy.held'));
  await expect(select).toHaveCount(0);await expect(section.getByRole('combobox')).toHaveCount(0);expect(posts).toEqual([]);
 }
 else{
  await section.getByRole('combobox',{name:t('tenant.connection.paymentPolicy.managedChoice'),exact:true}).selectOption(choiceId);
  await section.getByText(t('tenant.connection.paymentPolicy.reviewTerms'),{exact:true}).click();await expect(section.getByText(choice.documentText,{exact:true})).toBeVisible();await expect(select).toBeDisabled();
  const accepted=section.getByRole('checkbox',{name:t('tenant.connection.paymentPolicy.acceptTerms'),exact:true});
  await accepted.focus();await page.keyboard.press('Space');await expect(accepted).toBeChecked();await select.click();
  await expect(section.getByRole('alert')).toContainText(t('common.errors.conflict'));
  await section.getByRole('button',{name:t('common.actions.retry'),exact:true}).click();await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(accepted).not.toBeChecked();await accepted.check();await select.click();await expect(section.getByText(t('tenant.connection.paymentPolicy.held'),{exact:true})).toBeVisible();
  expect(posts).toHaveLength(2);expect(posts[1].key).not.toBe(posts[0].key);expect(posts[1].body).toMatchObject({expectedRevision:2});
  await expect(accepted).toHaveCount(0);await expect(section.getByText(t('tenant.connection.paymentPolicy.ready'),{exact:true})).toHaveCount(0);
  // UI doubles are limited to presentation. Imported BFF and public app-role SQL
  // tests separately exercise the actual transport/acceptance contract.
  enableTariffs=true;
  await section.getByRole('combobox',{name:t('tenant.connection.paymentPolicy.managedChoice'),exact:true}).selectOption(choiceId);
  const rates=section.getByRole('combobox',{name:t('tenant.connection.paymentPolicy.rates'),exact:true});
  await rates.selectOption(firstTariff);await expect(section.getByRole('table')).toContainText('0.005123 KWD');await expect(section).toContainText('Asia/Kuwait');
  await expect(section.locator(`time[datetime="${offer.effectiveFrom}"]`)).toHaveText(offer.effectiveFrom);await expect(section.locator(`time[datetime="${offer.effectiveTo}"]`)).toHaveText(offer.effectiveTo);
  // Qualify the new disclosure while it exists; the final held state has no table.
  const rateRegion=section.getByRole('region',{name:t('tenant.connection.paymentPolicy.rateTable'),exact:true});
  await rateRegion.focus();await page.keyboard.press('Shift+Tab');await expect(rateRegion).not.toBeFocused();
  await page.keyboard.press('Tab');await expect(rateRegion).toBeFocused();
  await expect(rateRegion).not.toHaveCSS('outline-style','none');
  await expect.poll(async()=>rateRegion.evaluate(element=>Number.parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThan(0);
  const beforeScroll=await rateRegion.evaluate(element=>({left:element.scrollLeft,width:element.clientWidth,total:element.scrollWidth}));
  if(beforeScroll.total>beforeScroll.width+1){
   await page.keyboard.press(locale==='ar'?'ArrowLeft':'ArrowRight');
   await expect.poll(async()=>rateRegion.evaluate(element=>element.scrollLeft)).not.toBe(beforeScroll.left);
  }
  expect((await section.boundingBox())!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect((await new AxeBuilder({page}).include(policySelector).analyze()).violations).toEqual([]);
  // A tall modal scrolls independently; capture the visible table, not a clipped section.
  // Allow fractional border clipping at the native-dialog scroll edge.
  await rateRegion.scrollIntoViewIfNeeded();await expect(rateRegion).toBeInViewport({ratio:0.99});
  await testInfo.attach('public-tariff-visible',{body:await page.screenshot({fullPage:false}),contentType:'image/png'});
  await testInfo.attach('public-tariff-table',{body:await rateRegion.screenshot(),contentType:'image/png'});
  const consent=section.getByRole('checkbox',{name:t('tenant.connection.paymentPolicy.acceptRates'),exact:true});
  await expect(select).toBeDisabled();await consent.focus();await page.keyboard.press('Space');await expect(select).toBeEnabled();
  await section.getByRole('button',{name:t('tenant.connection.paymentPolicy.moreRates'),exact:true}).click();await expect(select).toBeDisabled();
  await rates.selectOption(nextTariff);await expect(consent).not.toBeChecked();await consent.check();uncertain=true;await select.click();
  await expect(section.getByRole('alert')).toContainText(t('common.errors.unavailable'));const original=posts.at(-1)!;
  await expect(rates).toBeDisabled();await section.getByRole('button',{name:t('common.actions.retry'),exact:true}).click();
  await expect(section.getByRole('table')).toContainText('0.005123 KWD');
  const pendingPosts=posts.length;
  await page.locator(`#meta-access-token-${id}`).fill('synthetic-policy-rotation-token');
  await page.getByRole('button',{name:t('tenant.connection.metaCredential.replace'),exact:true}).click();
  await expect.poll(()=>credentialRefreshes).toBe(1);await expect(consent).toBeChecked();await expect(rates).toBeDisabled();
  await expect(section.getByRole('table')).toContainText('0.005123 KWD');expect(posts).toHaveLength(pendingPosts);
  // Exercise the actual locale control, which reloads this document. Storage is
  // scoped to the authenticated actor/workspace/connection; recovery never sends.
  for(const targetLocale of [locale==='en'?'ar':'en',locale]){
   const currentMessages=targetLocale==='ar'?englishTenantMessages:arabicTenantMessages;
   const details=page.getByRole('dialog',{name:currentMessages['tenant.connection.detailsLabel'],exact:true});
   await details.getByRole('button',{name:currentMessages['tenant.connection.closeDetails'],exact:true}).click();
   await expect(details).toHaveCount(0);expect(posts).toHaveLength(pendingPosts);
   await page.locator('.top-locale-switcher button[aria-pressed="false"]').click();
   await expect(page.locator('html')).toHaveAttribute('lang',targetLocale);await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
   await page.goto(`/app?view=connections&connection=${id}`);
   await expect(page.locator('html')).toHaveAttribute('lang',targetLocale);await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
   await expect(section.getByRole('table')).toContainText('0.005123 KWD');
   await expect(section.locator(`time[datetime="${offer.effectiveFrom}"]`)).toHaveText(offer.effectiveFrom);
   await expect(section.locator(`time[datetime="${offer.effectiveTo}"]`)).toHaveText(offer.effectiveTo);
   expect(posts).toHaveLength(pendingPosts);
  }
  await expect(consent).toBeChecked();await expect(rates).toBeDisabled();await select.click();
  await expect(section.getByRole('table')).toHaveCount(0);expect(posts).toHaveLength(pendingPosts+1);expect(posts.at(-1)).toEqual(original);
  hideOffers=false;await section.getByRole('checkbox',{name:t('tenant.connection.paymentPolicy.customer'),exact:true}).check();
  await rates.selectOption(firstTariff);await expect(consent).not.toBeChecked();await consent.check();await select.click();
  expect(posts.at(-1)!.body).toMatchObject({mode:'CUSTOMER',tariffVersionId:firstTariff,tariffDefinitionSha256:offer.definitionSha256,documentSha256:offer.documentSha256,acceptedTerms:true});
  expect(Object.hasOwn(posts.at(-1)!.body as object,'choiceId')).toBe(false);
  // Successful headers are insufficient: malformed, empty, wrong-mode and
  // failed body reads all keep the original key/body/disclosure for explicit retry.
  for(const fault of ['invalid','empty','wrong','body-read'] as const){
   const customer=section.getByRole('checkbox',{name:t('tenant.connection.paymentPolicy.customer'),exact:true});
   // The prior request body does not prove its successful acknowledgement/reset.
   await expect(customer).not.toBeChecked();await expect(customer).toBeEnabled();await customer.check();
   await rates.selectOption(firstTariff);await consent.check();
   if(fault==='body-read')await page.evaluate(()=>{
    const prior=window.fetch;window.fetch=async(input,init)=>{
     const response=await prior(input,init);const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
     if(url.includes('/meta/billing-policy')&&init?.method==='POST'){
      window.fetch=prior;
      return new Response(new ReadableStream({start(controller){controller.error(new TypeError('Synthetic response body loss'));}}),{status:202,headers:{'content-type':'application/json'}});
     }return response;
    };
   });else acknowledgement=fault;
   await select.click();await expect(section.getByRole('alert')).toBeVisible();const retained=posts.at(-1)!,failedCount=posts.length;
   await expect(rates).toBeDisabled();await expect(consent).toBeChecked();await expect(section.getByRole('table')).toContainText('0.005123 KWD');
   await select.click();await expect(section.getByRole('alert')).toHaveCount(0);await expect(section.getByRole('table')).toHaveCount(0);
   expect(posts).toHaveLength(failedCount+1);expect(posts.at(-1)).toEqual(retained);
  }
  expect(await page.evaluate(connection=>Object.keys(sessionStorage).filter(key=>key.startsWith('wasalx.meta.payment-intent:')&&key.includes(connection)),id)).toEqual([]);


 }
 await expect(section).toBeVisible();
 expect((await new AxeBuilder({page}).include(policySelector).analyze()).violations).toEqual([]);
 const bounds=await section.boundingBox();expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
 await testInfo.attach('managed-policy-held',{body:await section.screenshot(),contentType:'image/png'});expect(errors).toEqual([]);expect(expected).toEqual([]);
});
