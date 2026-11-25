import { installMetaRoutingReadFixture } from "./meta-routing.fixture";
import AxeBuilder from "@axe-core/playwright";
import {expect,test} from "@playwright/test";
import {englishTenantMessages} from "../../lib/i18n/messages/en/tenant";
import {arabicTenantMessages} from "../../lib/i18n/messages/ar/tenant";
import {englishCommonMessages} from "../../lib/i18n/messages/en/common";
import {arabicCommonMessages} from "../../lib/i18n/messages/ar/common";

test("Meta payment diagnostics preserve access boundaries and show only observed setup",async({page},testInfo)=>{
 const locale=process.env.WASALX_E2E_LOCALE??"en",role=process.env.WASALX_E2E_ROLE??"tenant_owner";
 const messages:Record<string,string>=locale==="ar"?{...arabicTenantMessages,...arabicCommonMessages}:{...englishTenantMessages,...englishCommonMessages};
 const t=(key:string)=>messages[key]!;
 const alpha="12000000-0000-4000-8000-000000000081",beta="12000000-0000-4000-8000-000000000082";
 const posts:Array<{id:string;key:string;body:unknown}>=[],problems:string[]=[];
 const expectedFailures:Array<{url:string;status:number}>=[];
 const expectFailure=(id:string,status:number)=>expectedFailures.push({url:new URL(`/api/connections/${id}/meta/billing-diagnostic`,page.url()).href,status});
 page.on("pageerror",error=>problems.push(error.message));
 page.on("console",message=>{if(message.type()!=="error")return;
  const index=expectedFailures.findIndex(expected=>message.text().startsWith("Failed to load resource:")
   &&message.location().url===expected.url&&new RegExp(`\\b${expected.status}\\b`).test(message.text()));
  if(index>=0){expectedFailures.splice(index,1);return;}
  problems.push(message.text());});
 const diagnostic=(paymentMethod:string,reason="OBSERVED")=>({schemaVersion:1,paymentMethod,accountOwner:paymentMethod==="PRESENT"?"REPORTED":"UNAVAILABLE",
  actualPayer:"UNVERIFIED",customerOwnership:"UNVERIFIED",cardVerified:false,checkedAt:"2026-10-07T12:00:00.000Z",reason});
 const views:Record<string,unknown>={},receipts=new Map<string,unknown>();let fixturePhase=true,revision=0,release:(()=>void)|undefined,delay=false,deny=locale==="en";
 await page.route("**/api/connections/**",async route=>{
  const path=new URL(route.request().url()).pathname,id=path.split('/')[3];
  if(![alpha,beta].includes(id)){await route.continue();return;}
  if(path.endsWith('/meta/billing-diagnostic')){
   if(fixturePhase){await route.continue();return;}
   if(route.request().method()==="POST"){
   posts.push({id,key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()});
    if(deny){deny=false;expectFailure(id,403);await route.fulfill({status:403,json:{code:'REAUTHENTICATION_REQUIRED'}});return;}
    const admittedRevision=revision,key=posts.at(-1)!.key;
    if(delay){delay=false;await new Promise<void>(resolve=>{release=resolve;});}
    if(!receipts.has(key))receipts.set(key,{operationId:`diagnostic-${posts.length}`,state:'SUCCEEDED',current:admittedRevision===revision,
      diagnostic:admittedRevision===revision?diagnostic(id===alpha?'PRESENT':'NONE'):diagnostic('UNAVAILABLE','BINDING_CHANGED')});
    views[id]=receipts.get(key);
    await route.fulfill({status:202,json:{operation:{id:`diagnostic-${posts.length}`,state:'QUEUED'}}}).catch(()=>{});
   }else await route.fulfill({json:views[id]??{operationId:null,state:null,current:false,diagnostic:null}});
  }else if(path.endsWith('/meta/credentials')){
   revision++;
   views[id]={operationId:'old-diagnostic',state:'SUCCEEDED',current:false,diagnostic:diagnostic('UNAVAILABLE','BINDING_CHANGED')};
   await route.fulfill({status:202,json:{operation:{id:'rotation-fixture',state:'SUCCEEDED'}}});
  }else if(path.endsWith('/meta/capabilities'))await route.fulfill({json:{eligible:false,state:'CONSENT_REQUIRED',evidence:'local_policy',checkedAt:new Date().toISOString()}});
  else if(path===`/api/connections/${id}`)await route.fulfill({json:{id,name:id===alpha?'Payment Alpha':'Payment Beta',provider:'META',state:'PAUSED',provider_session_state:'PAUSED',provider_state:'STOPPED',webhook_state:'PAUSED',disclosure_version:null,
   latest_operation_type:'PAUSE',latest_operation_state:'SUCCEEDED',last_heartbeat_at:new Date().toISOString(),group_count:0}});
  else await route.continue();
 });
  await installMetaRoutingReadFixture(page);
 await page.goto(`/app?view=connections&connection=${alpha}`);
 await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
 const section=page.locator('section').filter({has:page.getByRole('heading',{name:t('tenant.connection.payment.title'),exact:true})});
 const check=section.getByRole('button',{name:t('tenant.connection.payment.check'),exact:true});
 await expect(section.getByText(t('tenant.connection.payment.empty'),{exact:true})).toBeVisible();
 const fixtureRead=await page.request.get(`/api/connections/${alpha}/meta/billing-diagnostic`);
 expect(fixtureRead.status()).toBe(200);expect(await fixtureRead.json()).toEqual({operationId:null,state:null,diagnostic:null,current:false});
 expect(fixtureRead.headers()['cache-control']).toContain('no-store');
 await expect(section.getByText(t('tenant.connection.payment.limits'),{exact:true})).toBeVisible();
 if(!['tenant_owner','tenant_admin'].includes(role)){
  await expect(check).toHaveCount(0);expect(posts).toHaveLength(0);
 }else{
  expectFailure(alpha,501);
  const unavailable=page.waitForResponse(response=>response.url().endsWith('/meta/billing-diagnostic')&&response.request().method()==='POST');
  await check.focus();await page.keyboard.press('Enter');expect((await unavailable).status(),'Fixture mode never admits diagnostic provider work').toBe(501);
  await expect(section.getByRole('alert')).toContainText(t('common.errors.unavailable'));
  fixturePhase=false;await page.reload();await expect(check).toBeEnabled();
  await check.click();
  if(locale==='en'){
   await expect(section.getByRole('alert')).toContainText(t('common.errors.reauthenticationRequired'));
   await expect(section.getByRole('link',{name:t('tenant.connection.reauthenticate'),exact:true})).toHaveAttribute('href',/step_up=privileged/);
   await expect(check).toBeEnabled();await check.click();expect(posts[0].key,'Denied retry retains the intent key').toBe(posts[1].key);
  }
  await expect(section.getByText(t('tenant.connection.payment.present'),{exact:true})).toBeVisible();
  await expect(section.locator('time')).toHaveAttribute('datetime','2026-10-07T12:00:00.000Z');
  await page.reload();await expect(section.getByText(t('tenant.connection.payment.present'),{exact:true})).toBeVisible();
  const count=posts.length;delay=true;await check.click();await expect.poll(()=>Boolean(release)).toBe(true);
  await page.locator(`#meta-access-token-${alpha}`).fill('synthetic-browser-rotation-token');
  await page.getByRole('button',{name:t('tenant.connection.metaCredential.replace'),exact:true}).click();
  await expect(section.getByText(t('tenant.connection.payment.held'),{exact:true})).toBeVisible();
  await expect(check).toBeEnabled();release!();release=undefined;
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(check).toBeEnabled();await check.click();
  await expect(section.getByText(t('tenant.connection.payment.held'),{exact:true})).toBeVisible();
  expect(posts[count].key,'Refresh interruption retains same-connection idempotency').toBe(posts[count+1].key);
  await check.click();await expect(section.getByText(t('tenant.connection.payment.present'),{exact:true})).toBeVisible();
  expect(posts[count+2].key,'Only a new explicit check observes the updated credential').not.toBe(posts[count+1].key);
  delay=true;await check.click();await expect.poll(()=>Boolean(release)).toBe(true);
  await page.evaluate(id=>{history.pushState({},'',`/app?view=connections&connection=${id}`);dispatchEvent(new PopStateEvent('popstate'));},beta);
  await expect(section.getByText(t('tenant.connection.payment.empty'),{exact:true})).toBeVisible();
  release!();release=undefined;await check.click();
  await expect(section.getByText(t('tenant.connection.payment.none'),{exact:true})).toBeVisible();
  expect(posts.at(-1)?.id).toBe(beta);expect(posts.at(-1)?.key).not.toBe(posts.at(-2)?.key);
  for(const post of posts){expect(post.body).toEqual({});expect(post.key).toBeTruthy();}
 }
 const bounds=await section.boundingBox();expect(bounds).not.toBeNull();expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
 const axe=await new AxeBuilder({page}).include('section[aria-labelledby="meta-payment-title"]').analyze();expect(axe.violations).toEqual([]);
 await testInfo.attach('meta-payment-diagnostic',{body:await section.screenshot(),contentType:'image/png'});
 expect(problems).toEqual([]);
 expect(expectedFailures).toEqual([]);
});
