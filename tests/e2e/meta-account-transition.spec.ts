import { installMetaRoutingReadFixture } from "./meta-routing.fixture";
import AxeBuilder from '@axe-core/playwright';
import {expect,test} from '@playwright/test';
import {englishTenantMessages} from '../../lib/i18n/messages/en/tenant';
import {arabicTenantMessages} from '../../lib/i18n/messages/ar/tenant';
import type {MetaTransitionPreviewView} from '../../packages/core/src/meta-account-transition-contract';

test('Account preview preserves both payer intentions, recovers saved reads and never exposes an apply action',async({page},testInfo)=>{
  test.skip(testInfo.project.name==='tablet-820');
  const locale=process.env.WASALX_E2E_LOCALE??'en',role=process.env.WASALX_E2E_ROLE??'tenant_owner';
  const copy:Record<string,string>=locale==='ar'?arabicTenantMessages:englishTenantMessages;
  const t=(key:string)=>copy[`tenant.connection.accountPreview.${key}`]!;
  const connection='12000000-0000-4000-8000-000000000091',beta='12000000-0000-4000-8000-000000000092';
  const plans=new Map<string,MetaTransitionPreviewView>(),writes:Array<{path:string;body:Record<string,unknown>}>=[];
  let current:string|null=null,loseResponse=false,sequence=0;
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/connections/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname,id=path.split('/')[3];
    if(path.includes('/meta/account-transitions')){
      const suffix=path.split('/account-transitions')[1];
      if(route.request().method()==='GET')return route.fulfill({json:suffix?plans.get(suffix.slice(1)):{prepare:{accountRevision:1,bindingRevision:2},currentPlan:id===connection&&current?plans.get(current):null}});
      const body=route.request().postDataJSON();writes.push({path,body});
      if(!suffix){
        expect(Object.keys(body).sort()).toEqual(['expectedAccountRevision','expectedBindingRevision','requestedMode','targetCurrency']);
        const planId=`33000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
        const plan:MetaTransitionPreviewView={id:planId,revision:2,state:'BLOCKED',requestedMode:body.requestedMode,targetCurrency:body.targetCurrency,
          current:{declaredMode:'CUSTOMER',actualPayer:'UNVERIFIED',currency:'USD'},impact:{connections:[{id:connection,name:'Prior <account>'}],
            phoneInventory:'COMPLETE',externalPhoneCount:1,sourceTemplateCount:body.requestedMode==='CUSTOMER'?3:null,affectedFlowVersionCount:2,templateCompatibility:'NOT_ASSESSED'},
          reasons:['EXTERNAL_PHONE_IMPACT',...(body.requestedMode==='WASALX_MANAGED'?['TEMPLATE_INVENTORY_INCOMPLETE' as const,'MANAGED_ARRANGEMENT_UNAVAILABLE' as const]:[])],
          observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+900_000).toISOString(),canRefresh:true,canCancel:true,canExecute:false};
        plans.set(planId,plan);current=planId;return route.fulfill({status:202,json:{id:planId,duplicate:false}});
      }
      const [planId,action]=suffix.slice(1).split('/'),plan=plans.get(planId)!;expect(body).toEqual({expectedRevision:plan.revision});
      if(action==='cancel'){plans.set(planId,{...plan,revision:plan.revision+1,state:'CANCELLED',canRefresh:false,canCancel:false});current=null;}
      else{expect(action).toBe('refresh');plans.set(planId,{...plan,revision:plan.revision+1});}
      if(loseResponse){loseResponse=false;await route.abort('failed');return;}
      return route.fulfill({json:{id:planId,duplicate:false}});
    }
    if(path.endsWith('/meta/billing-policy'))return route.fulfill({json:{enrolled:true,mode:'CUSTOMER',revision:1,sendReady:true,paymentMethod:'PRESENT',checkedAt:new Date().toISOString(),actualPayer:'UNVERIFIED',customerOwnership:'UNVERIFIED',managedAvailable:false,state:'SUCCEEDED'}});
    if(path===`/api/connections/${id}`&&[connection,beta].includes(id))return route.fulfill({json:{id,name:id===connection?'Preview account':'Other account',provider:'META',state:'PAUSED',provider_session_state:'PAUSED',provider_state:'STOPPED',webhook_state:'PAUSED',latest_operation_type:'PAUSE',latest_operation_state:'SUCCEEDED',group_count:0}});
    return route.continue();
  });
  await installMetaRoutingReadFixture(page);
  await page.goto(`/app?view=connections&connection=${connection}`);await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  const section=page.locator('section[aria-labelledby^="account-preview-"]');await expect(section.getByRole('heading',{name:t('title'),exact:true})).toBeVisible();
  if(!['tenant_owner','tenant_admin'].includes(role)){
    await expect(section.getByRole('button',{name:t('prepare'),exact:true})).toHaveCount(0);expect(writes).toHaveLength(0);
  }else{
    await section.getByLabel(t('currency'),{exact:true}).fill('SAR');await section.getByRole('button',{name:t('prepare'),exact:true}).click();
    await expect(section.getByText(t('state.BLOCKED'),{exact:true})).toBeVisible();
    await expect(section.locator('bdi').filter({hasText:'Prior <account>'})).toHaveText('Prior <account>');
    await page.reload();
    const templateCount=section.getByText(t('sourceTemplates'),{exact:true}).locator('xpath=following-sibling::dd[1]');
    const flowCount=section.getByText(t('affectedFlows'),{exact:true}).locator('xpath=following-sibling::dd[1]');
    await expect(templateCount).toHaveText('3');await expect(flowCount).toHaveText('2');
    await expect(section.getByText(t('compatibilityNotAssessed'),{exact:true})).toBeVisible();
    loseResponse=true;await section.getByRole('button',{name:t('refresh'),exact:true}).click();await expect(section.getByRole('alert')).toBeVisible();
    const lostCount=writes.length;await section.getByRole('button',{name:t('checkStatus'),exact:true}).click();
    await expect(section.getByRole('alert')).toHaveCount(0);expect(writes).toHaveLength(lostCount);
    await section.getByRole('button',{name:t('cancel'),exact:true}).click();await expect(section.getByText(t('state.CANCELLED'),{exact:true})).toBeVisible();
    await section.getByRole('combobox',{name:t('payer'),exact:true}).selectOption('WASALX_MANAGED');await section.getByLabel(t('currency'),{exact:true}).fill('EUR');
    await section.getByRole('button',{name:t('prepare'),exact:true}).click();await expect(section.getByText(t('reason.MANAGED_ARRANGEMENT_UNAVAILABLE'),{exact:true})).toBeVisible();
    expect(writes.at(-1)?.body).toMatchObject({requestedMode:'WASALX_MANAGED',targetCurrency:'EUR'});
    await expect(templateCount).toHaveText(t('unknown'));await expect(flowCount).toHaveText('2');
    await expect(section.getByText(t('compatibilityNotAssessed'),{exact:true})).toBeVisible();
    const count=writes.length;await page.evaluate(id=>{history.pushState({},'',`/app?view=connections&connection=${id}`);dispatchEvent(new PopStateEvent('popstate'));},beta);
    await expect(section.getByText(t('empty'),{exact:true})).toBeVisible();await expect(section.getByLabel(t('currency'),{exact:true})).toHaveValue('');expect(writes).toHaveLength(count);
    await page.goto(`/app?view=connections&connection=${connection}`);await expect(section.getByText(t('state.BLOCKED'),{exact:true})).toBeVisible();
  }
  expect(writes.every(write=>write.path.includes('/account-transitions')&&!/resume|execute|register|start/u.test(write.path))).toBe(true);
  expect((await new AxeBuilder({page}).include('section[aria-labelledby^="account-preview-"]').analyze()).violations).toEqual([]);
  await section.getByRole('heading',{name:t('title'),exact:true}).scrollIntoViewIfNeeded();
  await testInfo.attach('preview-top',{body:await page.screenshot(),contentType:'image/png'});
  const buttons=section.getByRole('button');if(await buttons.count()){await buttons.last().scrollIntoViewIfNeeded();await testInfo.attach('preview-actions',{body:await page.screenshot(),contentType:'image/png'});}
  expect((await section.boundingBox())!.width).toBeLessThanOrEqual(page.viewportSize()!.width);expect(errors).toEqual([]);
});
