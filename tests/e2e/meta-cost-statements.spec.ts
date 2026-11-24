import {expect,test,type Route,type Download} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {englishTenantMessages} from '../../lib/i18n/messages/en/tenant';
import {arabicTenantMessages} from '../../lib/i18n/messages/ar/tenant';

const role=process.env.WASALX_E2E_ROLE??'tenant_owner',locale=process.env.WASALX_E2E_LOCALE??'en';
const messages:Readonly<Record<string,string>>=locale==='ar'?arabicTenantMessages:englishTenantMessages,t=(key:string)=>messages[key]!;
const accountA='31000000-0000-4000-8000-000000000001',accountB='31000000-0000-4000-8000-000000000002',id='31000000-0000-4000-8000-000000000003';
const statement={id,purpose:'UPSTREAM_CHARGE',basisKind:'UPSTREAM_SOURCE',evidenceMode:'SIMULATED',currency:'USD',periodFrom:'2026-10-01T00:00:00.000Z',periodTo:'2026-11-01T00:00:00.000Z',
 amount:'12345678901234567890.12',quantity:null,coverage:'ACCOUNT_PERIOD_SOURCE_CONFIRMED',publishedAt:'2026-11-02T00:00:00.000Z',predecessorId:'31000000-0000-4000-8000-000000000004',superseded:false,publicationSha256:'a'.repeat(64),sourceAvailability:'RETAINED_RESTRICTED'};
const adjustments=[{statementVersionId:'31000000-0000-4000-8000-000000000005',amount:'-0.123456789012',treatment:'INCLUDED_IN_REPLACEMENT'},
 {statementVersionId:'31000000-0000-4000-8000-000000000006',amount:'0.987654321098',treatment:'EXCLUDED_FROM_REPLACEMENT'}];
const publication={quantity:null,estimatedAmount:'12345678901234567890.111111111111',difference:'0.008888888889',adjustments,upstreamPublications:[]};
const csv='\uFEFF"rowType","id","amount","estimatedAmount","difference","adjustmentAmount","adjustmentTreatment"\r\n'+
 `"STATEMENT","${id}","${statement.amount}","${publication.estimatedAmount}","${publication.difference}","",""\r\n`+
 adjustments.map(x=>`"ADJUSTMENT","${id}","","","","${x.amount}","${x.treatment}"\r\n`).join('');
async function downloadText(download:Download){const stream=await download.createReadStream();expect(stream).not.toBeNull();const chunks:Buffer[]=[];for await(const chunk of stream!)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks).toString('utf8');}

// Mocked data proves the mounted tenant UI and actual downloaded bytes only.
// Real publication, calculation, CSV controller and role enforcement have
// separate API/actual-stack oracles; this is never financial/live authority.
test('published statement history preserves exact amounts, unknown quantity and stale-account fences',async({page},testInfo)=>{
 test.skip(testInfo.project.name==='tablet-820');
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 let statementReads=0,oldRoute:Route|undefined,holdOld=false,initial:Route|undefined,detailRoute:Route|undefined,delayDetail=false;
 let usageModule:Route|undefined;
 await page.route(/\/MetaCostUsage-[^/]+\.js$/,route=>{usageModule=route;});
 await page.route('**/api/meta-costs/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname.endsWith('/accounts'))return route.fulfill({json:[{id:accountA,names:['Customer service']},{id:accountB,names:['Other account']}]});
  if(url.pathname.endsWith('/statement-export'))return route.fulfill({contentType:'text/csv; charset=utf-8',body:csv});
  if(url.pathname.endsWith(`/statements/${id}`)){if(delayDetail){detailRoute=route;return;}return route.fulfill({json:{id,statement:publication}});}
  if(url.pathname.endsWith('/statements')){
   statementReads++;if(url.searchParams.get('accountId')===accountB){if(holdOld){oldRoute=route;return;}return route.fulfill({json:[]});}
   if(!initial&&statementReads===1){initial=route;return;}return route.fulfill({json:[statement]});
  }
  return route.fulfill({json:{complete:true,selectedCount:0,selectedSha256:'b'.repeat(64),accountId:url.searchParams.get('accountId'),from:statement.periodFrom,to:statement.periodTo,rows:[],totals:[],coverage:[]}});
 });
 await page.goto('/app?view=connections');await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
 const summary=page.locator('summary').filter({hasText:t('cost.title')});
 if(!['tenant_owner','tenant_admin','auditor'].includes(role)){await expect(summary).toHaveCount(0);expect(statementReads).toBe(0);expect(errors).toEqual([]);return;}
 const disclosure=page.locator('details').filter({has:summary});
 // Keep the lazy panel pending while the operator uses the disclosure.
 await expect.poll(()=>Boolean(usageModule)).toBe(true);
 await expect(summary).toBeVisible();await summary.focus();await expect(summary).toBeFocused();
 await page.keyboard.press('Enter');await expect(disclosure).toHaveJSProperty('open',true);
 await expect(disclosure.getByRole('status')).toHaveText(t('tenant.loading.section'));
 await usageModule!.continue();
 const accounts=disclosure.getByRole('combobox',{name:t('cost.account'),exact:true});
 await expect(accounts).toBeVisible();await expect(summary).toBeFocused();await accounts.selectOption(accountA);
 const panel=page.getByRole('region',{name:t('cost.statement.title'),exact:true});
 await expect.poll(()=>Boolean(initial)).toBe(true);await expect(panel.getByRole('status')).toContainText(t('cost.loading'));expect(errors).toEqual([]);
 await initial!.fulfill({json:[]});await expect(panel.getByText(t('cost.statement.empty'),{exact:true})).toBeVisible();
 await page.getByRole('combobox',{name:t('cost.account'),exact:true}).selectOption(accountB);await expect(panel.getByText(t('cost.statement.empty'),{exact:true})).toBeVisible();
 await page.getByRole('combobox',{name:t('cost.account'),exact:true}).selectOption(accountA);await expect(panel.getByText('USD '+statement.amount,{exact:true})).toBeVisible();
 await panel.getByRole('button',{name:t('cost.statement.details'),exact:true}).focus();await page.keyboard.press('Enter');
 const detail=panel.getByRole('region',{name:t('cost.statement.details'),exact:true});
 await expect(detail.getByText(t('cost.statement.quantityUnknown'),{exact:false})).toBeVisible();
 await expect(detail.getByText('USD '+publication.estimatedAmount,{exact:true})).toBeVisible();
 await expect(detail.getByText('USD '+publication.difference,{exact:true})).toBeVisible();
 await expect(detail.getByText('USD '+publication.estimatedAmount,{exact:true})).toHaveAttribute('dir','ltr');
 for(const item of adjustments){const row=detail.getByRole('row').filter({hasText:'USD '+item.amount});await expect(row).toContainText(t(`cost.statement.treatment.${item.treatment}`));}
 await expect(detail.getByText(t('cost.statement.source.RETAINED_RESTRICTED'),{exact:true})).toBeVisible();
 for(const raw of [id,statement.predecessorId,...adjustments.map(x=>x.statementVersionId)])await expect(panel.getByText(raw,{exact:false})).toHaveCount(0);
 for(const key of ["cost.statement.history","cost.statement.adjustments"]){
  const tableScroll=panel.getByRole("region",{name:t(key),exact:true});
  await tableScroll.focus();await page.keyboard.press("Shift+Tab");await expect(tableScroll).not.toBeFocused();
  await page.keyboard.press("Tab");await expect(tableScroll).toBeFocused();
  await expect(tableScroll).toHaveCSS("outline-style","solid");await expect(tableScroll).toHaveCSS("outline-width","2px");
  const scroll=await tableScroll.evaluate(element=>({left:element.scrollLeft,max:element.scrollWidth-element.clientWidth,rtl:getComputedStyle(element).direction==="rtl"}));
  if(scroll.max>1){
   const key=scroll.rtl?(scroll.left>-scroll.max+1?"ArrowLeft":"ArrowRight"):(scroll.left<scroll.max-1?"ArrowRight":"ArrowLeft");
   await page.keyboard.press(key);
   await expect.poll(()=>tableScroll.evaluate(element=>element.scrollLeft)).not.toBe(scroll.left);
  }
  await testInfo.attach(`statement-table-keyboard-${key}-${locale}-${testInfo.project.name}`,{body:await page.screenshot(),contentType:"image/png"});
 }
 expect((await new AxeBuilder({page}).include("details[open]").analyze()).violations).toEqual([]);
 const downloaded=page.waitForEvent('download');await panel.getByRole('button',{name:t('cost.statement.export'),exact:true}).click();
 const file=await downloaded;expect(file.suggestedFilename()).toBe('wasalx-cost-statements.csv');expect(await downloadText(file)).toBe(csv);
 await detail.scrollIntoViewIfNeeded();await testInfo.attach(`statement-breakdown-${locale}-${testInfo.project.name}`,{body:await page.screenshot(),contentType:'image/png'});
 await detail.getByRole('button',{name:t('cost.statement.closeDetails'),exact:true}).focus();await page.keyboard.press('Enter');await expect(detail).toHaveCount(0);expect(errors).toEqual([]);
 // A late detail cannot restore a closed/superseded account selection.
 delayDetail=true;await panel.getByRole('button',{name:t('cost.statement.details'),exact:true}).click();await expect.poll(()=>Boolean(detailRoute)).toBe(true);
 await detail.getByRole('button',{name:t('cost.statement.closeDetails'),exact:true}).click();
 holdOld=true;await page.getByRole('combobox',{name:t('cost.account'),exact:true}).selectOption(accountB);await expect.poll(()=>Boolean(oldRoute)).toBe(true);
 await expect(panel.getByText('USD '+statement.amount,{exact:true})).toHaveCount(0);await expect(panel.getByRole('button',{name:t('cost.statement.export'),exact:true})).toBeDisabled();
 await detailRoute!.fulfill({json:{id,statement:{...publication,estimatedAmount:'999.000000000001'}}});await expect(panel.getByText('USD 999.000000000001',{exact:true})).toHaveCount(0);
 await page.getByRole('combobox',{name:t('cost.account'),exact:true}).selectOption(accountA);await expect(panel.getByText('USD '+statement.amount,{exact:true})).toBeVisible();
 await oldRoute!.fulfill({json:[]});await expect(panel.getByText('USD '+statement.amount,{exact:true})).toBeVisible();
 delayDetail=false;
 await page.getByLabel(t('cost.from'),{exact:true}).fill('2026-09-01T00:00');await expect(panel.getByRole('region',{name:t('cost.statement.details'),exact:true})).toHaveCount(0);
 expect(errors).toEqual([]);expect((await new AxeBuilder({page}).include('details[open]').analyze()).violations).toEqual([]);
 await testInfo.attach(`statement-history-${locale}-${testInfo.project.name}`,{body:await page.screenshot(),contentType:'image/png'});
});
