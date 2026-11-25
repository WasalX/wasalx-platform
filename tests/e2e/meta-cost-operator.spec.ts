import {expect,test,type Page,type Route,type Locator} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {englishTenantMessages} from '../../lib/i18n/messages/en/tenant';
import {arabicTenantMessages} from '../../lib/i18n/messages/ar/tenant';
import {englishPlatformMessages} from '../../lib/i18n/messages/en/platform';
import {arabicPlatformMessages} from '../../lib/i18n/messages/ar/platform';
import {createTranslator} from '../../lib/i18n/translate';
import {formatNumber} from '../../lib/i18n/format';
import type {MetaCostTariffInput,MetaCostSelectorEvidence} from '../../packages/core/src/meta-cost';

// Existing Playwright runner, genuine operator session, real mounted components.
// Only cost/metering responses below are mocked. Missing root-supplied platform
// access is SKIP, never a tenant-fixture substitute or an authenticated PASS.
const locale=process.env.WASALX_E2E_LOCALE==='ar'?'ar':'en';
const t=createTranslator<Readonly<Record<string,string>>>({...(locale==='ar'?arabicTenantMessages:englishTenantMessages),...(locale==='ar'?arabicPlatformMessages:englishPlatformMessages)});
const state=process.env.WASALX_E2E_PLATFORM_STORAGE_STATE,platformUrl=process.env.WASALX_E2E_PLATFORM_URL;
const tenant=process.env.WASALX_E2E_PLATFORM_TENANT_ID??'',tenantName=process.env.WASALX_E2E_PLATFORM_TENANT_NAME??'';
const ready=Boolean(state&&platformUrl&&tenantName&&/^[0-9a-f-]{36}$/u.test(tenant)&&process.env.WASALX_E2E_REUSE_SERVER==='1');
test.use({storageState:state??{cookies:[],origins:[]}});
const uuid=(n:number)=>`31000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const account=uuid(1),otherAccount=uuid(2),tariffId=uuid(3),statementId=uuid(4),policyA=uuid(5),policyB=uuid(6),terms=uuid(7);
const from='2026-10-01T00:00:00.000Z',to='2026-11-01T00:00:00.000Z';
const root=()=>`/api/platform-console/meta-costs/tenants/${tenant}`;
const file=(value:unknown,name='current.json')=>({name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
const tariff=():MetaCostTariffInput=>({tenantId:tenant,accountId:account,purpose:'CUSTOMER_TARIFF',evidenceMode:'SIMULATED',sourceSha256:'a'.repeat(64),currency:'USD',minorUnits:2,timezone:'UTC',effectiveFrom:from,effectiveTo:to,rounding:'LINE',product:'CLOUD_API',unit:'DELIVERED_MESSAGE',pricingModel:'PMP',policyFamily:'ORDINARY_BUSINESS_MESSAGING',commercialTermsVersionId:terms,rates:[{category:'utility',pricingType:'regular',billable:true,schedule:'ORDINARY',market:'SA',tier:'ALL',unitPrice:'0.123456789012'}]});
const selector:MetaCostSelectorEvidence={sourceSha256:'b'.repeat(64),evidenceMode:'SIMULATED',product:'CLOUD_API',unit:'DELIVERED_MESSAGE',policyFamily:'ORDINARY_BUSINESS_MESSAGING',market:'SA',marketBasis:'AUTHORITATIVE_EFFECT_MARKET',schedule:'ORDINARY',applicabilityFrom:from,applicabilityTo:to,tier:'ALL',tierBasis:'APPROVED_PROVISIONAL_REFERENCE',timeBasis:'PROVIDER_DELIVERED_TIMESTAMP'};
type Write={path:string;key:string;body:Record<string,unknown>};
type Tariff={id:string;state:string;definition:MetaCostTariffInput;definition_sha256:string;supersedes_id:null;created_at:string;accepted_policies:Array<{id:string;createdAt:string}>};
function row(n:number){return{id:uuid(1000+n),deliveryId:uuid(2000+n),accountId:account,purpose:'UPSTREAM_REFERENCE',evidenceMode:'SIMULATED',state:'ESTIMATED',reason:'PROVISIONAL_RATE',delivered:true,reportedFree:false,deliveredAt:'2026-10-08T09:00:00.000Z',observedAt:'2026-10-08T09:00:00.000Z',tariffVersionId:null,currency:'USD',minorUnits:2,rounding:'LINE',unroundedAmount:'0.123456789012',amount:'0.12',evidenceRedacted:false,inputSha256:'c'.repeat(64),receiptSetSha256:'d'.repeat(64),admissionSha256:'e'.repeat(64),admissionDigestFormat:'pg-jsonb-text-v1',paymentMode:'CUSTOMER',payerState:'UNVERIFIED',timeBasis:'PROVIDER_DELIVERED_TIMESTAMP'};}
const description=()=>({schemaVersion:1,basisKind:'CUSTOMER_TARIFF_DERIVATION',accountId:account,policyVersionId:policyA,commercialTermsVersionId:terms,periodFrom:from,periodTo:to,timezone:'UTC',currency:'USD',minorUnits:2,tariffVersionId:tariffId,upstreamStatementVersionIds:[uuid(8)]});
function statementDetail(){return{id:statementId,version:3,state:'SOURCE_READY',purpose:'CUSTOMER_CHARGE',evidenceMode:'SIMULATED',currency:'USD',periodFrom:from,periodTo:to,sourceState:'NONE',description:description(),inputSha256:'f'.repeat(64),originalSha256:null,originalByteSize:null,originalMime:null,writeAttemptId:uuid(9),writeDisposition:'UNKNOWN',scanSha256:null,currentHeadId:null,priorAdjustments:[],verificationSha256:null,previewSha256:null,preview:null,publication:null,privacyReviews:[]};}
async function setup(page:Page){
 const errors:string[]=[],expected:Array<{url:string;status:number}>=[];page.on('pageerror',error=>errors.push(error.message));
 page.on('console',message=>{if(message.type()!=='error')return;const i=expected.findIndex(x=>x.url===message.location().url&&message.text().includes(String(x.status)));if(i>=0)expected.splice(i,1);else errors.push(message.text());});
 const rows=Array.from({length:101},(_,i)=>row(i)),tariffs:Tariff[]=[],writes:Write[]=[];
 let onWrite:(route:Route,write:Write)=>Promise<void>=async route=>{await route.fulfill({json:{ok:true}});};
 await page.route(`**/api/platform-console/metering/tenants/${tenant}`,route=>route.fulfill({json:{tenant:{id:tenant,name:tenantName},from,to,usage:[],quotas:[]}}));
 await page.route(url=>url.pathname===root()||url.pathname.startsWith(root()+"/"),async route=>{
  const url=new URL(route.request().url());
  if(route.request().method()!=='GET'){
   const write={path:url.pathname,key:route.request().headers()['idempotency-key']??'',body:route.request().postDataJSON() as Record<string,unknown>};
   expect(write.key).toMatch(/^[0-9a-f-]{36}$/u);writes.push(write);return onWrite(route,write);
  }
  if(url.pathname===`${root()}/statements`)return route.fulfill({json:{statements:url.searchParams.get('accountId')===account?[statementDetail()]:[]}});
  if(url.pathname===`${root()}/statements/${statementId}`)return route.fulfill({json:statementDetail()});
  if(url.pathname!==root())throw Error('Unexpected mocked cost path');
  const selected=url.searchParams.get('accountId');return route.fulfill({json:{complete:true,selectedCount:selected===account?rows.length:0,selectedSha256:'1'.repeat(64),accountId:selected==='unattributed'?null:selected,from:url.searchParams.get('from'),to:url.searchParams.get('to'),rows:selected===account?rows:[],totals:[],coverage:[],tariffs:selected===account?tariffs:[],accounts:[{id:account,names:['Cost account']},{id:otherAccount,names:['Other cost account']}]}});
 });
 const origin=new URL(platformUrl!).origin;
 await page.context().addCookies([{name:'wasalx_locale',value:locale,url:origin}]);
 await page.goto(platformUrl!);
 const tenantRow=page.getByRole('row').filter({has:page.getByText(tenantName,{exact:true})});await expect(tenantRow).toHaveCount(1);
 await tenantRow.getByRole('button',{name:t('platform.navigation.usage'),exact:true}).click();
 const dialog=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:tenantName,exact:true})});await expect(dialog).toBeVisible();
 await dialog.getByRole('combobox',{name:t('cost.account'),exact:true}).selectOption(account);
 await dialog.getByLabel(t('cost.from'),{exact:true}).fill(from.slice(0,16));await dialog.getByLabel(t('cost.to'),{exact:true}).fill(to.slice(0,16));
 const management=dialog.getByRole('region',{name:t('cost.manage.title'),exact:true});await expect(management).toBeVisible();
 const statement=dialog.getByRole('region',{name:t('cost.statement.manage'),exact:true});
 return{dialog,management,statement,rows,tariffs,writes,errors,expected,setWrite:(fn:typeof onWrite)=>{onWrite=fn;}};
}
async function enabled(locator:Locator){return await locator.count()>0&&await locator.isEnabled();}
async function keyboardClick(page:Page,locator:Locator){await locator.focus();await page.keyboard.press('Enter');}

test('operator cost drafts, accepted activation and every bounded reassessment page remain reachable',async({page},info)=>{
 test.skip(!ready,'Requires root-supplied authenticated platform session and reused control-plane server');
 const h=await setup(page);const reassess=h.management.getByRole('group',{name:t('cost.manage.reassess'),exact:true});
 await expect(h.dialog.getByRole('navigation',{name:t('cost.pages'),exact:true})).toHaveCount(1);
 await expect(reassess.getByRole('navigation',{name:t('cost.manage.reassessPages'),exact:true})).toBeVisible();
 h.setWrite(async(route,write)=>{
  if(write.path===`${root()}/tariffs`){expect(write.body).toEqual({definition:tariff(),supersedesId:null});h.tariffs.push({id:tariffId,state:'DRAFT',definition:tariff(),definition_sha256:'2'.repeat(64),supersedes_id:null,created_at:from,accepted_policies:[{id:policyA,createdAt:from},{id:policyB,createdAt:to}]});}
  else if(write.path.endsWith('/activate')){expect(write.body).toEqual({expectedDefinitionSha256:'2'.repeat(64),policyVersionId:policyB});h.tariffs[0]!.state='ACTIVE';}
  await route.fulfill({json:{ok:true}});
 });
 await h.management.getByLabel(t('cost.manage.rateFile'),{exact:true}).setInputFiles(file(tariff()));
 await expect(h.management.getByRole('table',{name:t('cost.manage.preview'),exact:true})).toContainText('USD 0.123456789012');
 const tableScroll=h.management.getByRole("region",{name:t("cost.manage.preview"),exact:true});
 await tableScroll.focus();await page.keyboard.press("Shift+Tab");await expect(tableScroll).not.toBeFocused();
 await page.keyboard.press("Tab");await expect(tableScroll).toBeFocused();
 await expect(tableScroll).toHaveCSS("outline-style","solid");await expect(tableScroll).toHaveCSS("outline-width","2px");
 const scroll=await tableScroll.evaluate(element=>({left:element.scrollLeft,max:element.scrollWidth-element.clientWidth,rtl:getComputedStyle(element).direction==="rtl"}));
 if(scroll.max>1){
  const key=scroll.rtl?(scroll.left>-scroll.max+1?"ArrowLeft":"ArrowRight"):(scroll.left<scroll.max-1?"ArrowRight":"ArrowLeft");
  await page.keyboard.press(key);
  await expect.poll(()=>tableScroll.evaluate(element=>element.scrollLeft)).not.toBe(scroll.left);
 }
 await info.attach(`cost-preview-keyboard-${locale}-${info.project.name}`,{body:await page.screenshot(),contentType:"image/png"});
 expect((await new AxeBuilder({page}).include("dialog[open]").analyze()).violations).toEqual([]);
 expect(h.writes).toHaveLength(0);await keyboardClick(page,h.management.getByRole('button',{name:t('cost.manage.saveDraft'),exact:true}));
 const activation=h.management.getByRole('button',{name:t('cost.manage.activate'),exact:true});await expect(activation).toBeDisabled();
 await h.management.getByRole('combobox',{name:t('cost.manage.acceptance'),exact:true}).selectOption(policyB);await keyboardClick(page,activation);await expect(activation).toHaveCount(0);
 const checks=()=>reassess.getByRole('checkbox');
 const selectedButton=()=>reassess.getByRole('button',{name:new RegExp(t('cost.manage.reassessSelected',{count:'\\d+'}).replace('\\d+','.+'))});
 // First page: 100 effects, plus the explicit withdraw checkbox outside selection.
 const effectChecks=reassess.getByRole('checkbox');
 expect(await checks().count()).toBe(101);
 for(let i=1;i<=100;i++)await effectChecks.nth(i).check();
 await selectedButton().click();await expect.poll(()=>h.writes.length).toBe(3);
 const firstItems=h.writes[2]!.body.items as Array<Record<string,unknown>>;expect(firstItems).toHaveLength(100);expect(firstItems.every(x=>!Object.hasOwn(x,'selectorEvidence'))).toBe(true);
 await keyboardClick(page,reassess.getByRole('button',{name:t('cost.next'),exact:true}));
 const last=reassess.getByRole('checkbox').last();await expect(last).toHaveAccessibleName(new RegExp(t('cost.manage.message',{count:formatNumber(101,locale)})));
 await last.focus();await page.keyboard.press('Space');await h.management.getByLabel(t('cost.manage.selectorFile'),{exact:true}).setInputFiles(file(selector));await selectedButton().click();await expect.poll(()=>h.writes.length).toBe(4);
 expect(h.writes[3]!.body.items).toEqual([{deliveryId:h.rows[100]!.deliveryId,expectedHeadId:h.rows[100]!.id,selectorEvidence:selector}]);
 await last.check();await reassess.getByLabel(t('cost.manage.clearSelector'),{exact:true}).check();await selectedButton().click();await expect.poll(()=>h.writes.length).toBe(5);
 expect(h.writes[4]!.body.items).toEqual([{deliveryId:h.rows[100]!.deliveryId,expectedHeadId:h.rows[100]!.id,selectorEvidence:null}]);
 await reassess.getByRole('button',{name:t('cost.previous'),exact:true}).click();await effectChecks.nth(1).check();await effectChecks.nth(2).check();
 const unchanged=h.rows[1]!.id;h.rows[0]!.id=uuid(8000);
 const refresh=page.waitForResponse(r=>new URL(r.url()).pathname===root()&&r.request().method()==='GET');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await refresh;
 await expect(effectChecks.nth(1)).not.toBeChecked();await expect(effectChecks.nth(2)).toBeChecked();
 let rejected=false;h.setWrite(async(route,write)=>{expect((write.body.items as Array<{expectedHeadId:string}>)[0]!.expectedHeadId).toBe(unchanged);rejected=true;h.expected.push({url:route.request().url(),status:409});await route.fulfill({status:409,json:{error:'PRIVATE_HEAD_CONFLICT'}});});
 await selectedButton().click();await expect(h.dialog.getByRole('alert')).toContainText(t('cost.manage.failed'));expect(rejected).toBe(true);await expect(page.getByText('PRIVATE_HEAD_CONFLICT')).toHaveCount(0);
 expect(h.writes.filter(x=>x.path.endsWith('/reassess')).every(x=>(x.body.items as unknown[]).length<=100)).toBe(true);
 expect((await new AxeBuilder({page}).include("dialog[open]").analyze()).violations).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
 await info.attach(`cost-operator-${locale}-${info.project.name}`,{body:await page.screenshot(),contentType:'image/png'});expect(h.expected).toEqual([]);expect(h.errors).toEqual([]);
});

test('statement file replacements invalidate all four imported actions and stale read completions',async({page},info)=>{
 test.skip(!ready,'Requires root-supplied authenticated platform session and reused control-plane server');test.setTimeout(90_000);
 await page.addInitScript(()=>{const original=File.prototype.text;const controls={release:undefined as undefined|(()=>void),finished:false};Object.assign(window,{costFileRead:controls});File.prototype.text=function(){if(this.name!=='delayed.json')return original.call(this);return new Promise(resolve=>{controls.finished=false;controls.release=()=>{void original.call(this).then(value=>{resolve(value);controls.finished=true;});};});};});
 const h=await setup(page);
 await test.step('Select statement version',()=>h.statement.getByRole('combobox',{name:t('cost.statement.version'),exact:true}).selectOption(statementId));
 await expect(h.statement.getByRole('button',{name:t('cost.statement.recordReview'),exact:true})).toBeDisabled();
 await h.statement.locator('summary').filter({hasText:t('cost.statement.retention')}).click();await h.statement.locator('summary').filter({hasText:t('cost.statement.recovery')}).click();
 const review={expectedVersion:3,expectedInputSha256:'f'.repeat(64),expectedCurrentHeadId:null,reviewSha256:'3'.repeat(64),subjectCoverage:'VERIFIED_NO_SUBJECT_DATA',subjectRefs:[],priorAdjustments:[],originalSha256:null};
 const retention={expectedVersion:1,sourceDays:2,recordDays:10,basisSha256:'4'.repeat(64),policyVersionId:policyA,commercialTermsVersionId:terms};
 const recovery={expectedVersion:3,originalSha256:null,writeAttemptId:uuid(9),scanSha256:null,outcome:'UNKNOWN',terminalDispositionEvidenceSha256:null};
 const kinds=[{input:'descriptionFile',action:'reserve',valid:description()},{input:'reviewFile',action:'recordReview',valid:review},{input:'recoveryFile',action:'recordDisposition',valid:recovery},{input:'retentionFile',action:'approveRetention',valid:retention}];
 for(const item of kinds){
  const input=h.statement.getByLabel(t(`cost.statement.${item.input}`),{exact:true}),action=h.statement.getByRole('button',{name:t(`cost.statement.${item.action}`),exact:true});
  const valid=async()=>{await input.setInputFiles(file(item.valid));if(item.input==='reviewFile')await h.statement.getByLabel(t('cost.statement.confirmReview'),{exact:true}).check();await expect.poll(()=>enabled(action)).toBe(true);};
  for(const invalid of [{name:'malformed.json',mimeType:'application/json',buffer:Buffer.from('{')},file([],'shape.json'),{name:'oversized.json',mimeType:'application/json',buffer:Buffer.alloc(524_289,32)}]){
   await valid();await input.setInputFiles(invalid);await expect.poll(()=>enabled(action)).toBe(false);await expect(h.statement.getByLabel(t('cost.statement.confirmReview'),{exact:true})).not.toBeChecked();expect(h.writes).toHaveLength(0);
  }
  await valid();await input.setInputFiles(file(item.valid,'delayed.json'));
  await expect.poll(()=>page.evaluate(()=>Boolean((window as unknown as {costFileRead:{release?:()=>void}}).costFileRead.release))).toBe(true);
  await input.setInputFiles(file([],'new-invalid.json'));await page.evaluate(()=>{const c=(window as unknown as {costFileRead:{release?:()=>void}}).costFileRead;c.release?.();c.release=undefined;});
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {costFileRead:{finished:boolean}}).costFileRead.finished)).toBe(true);
  await expect.poll(()=>enabled(action)).toBe(false);expect(h.writes).toHaveLength(0);
 }
 // Syntactically valid wrong-binding review/recovery cannot submit either.
 await h.statement.getByLabel(t('cost.statement.reviewFile'),{exact:true}).setInputFiles(file({...review,expectedInputSha256:'5'.repeat(64)}));await h.statement.getByLabel(t('cost.statement.confirmReview'),{exact:true}).check();await expect(h.statement.getByRole('button',{name:t('cost.statement.recordReview'),exact:true})).toBeDisabled();
 await h.statement.getByLabel(t('cost.statement.recoveryFile'),{exact:true}).setInputFiles(file({...recovery,expectedVersion:4}));await expect(h.statement.getByRole('button',{name:t('cost.statement.recordDisposition'),exact:true})).toBeDisabled();
 await h.statement.getByLabel(t('cost.statement.descriptionFile'),{exact:true}).setInputFiles(file({...description(),accountId:otherAccount}));await expect(h.statement.getByRole('button',{name:t('cost.statement.reserve'),exact:true})).toHaveCount(0);
 // Retention authority is server-owned. UI scope change invalidates its imported
 // action; a syntactically valid foreign policy is not declared client-verified.
 await h.statement.getByLabel(t('cost.statement.retentionFile'),{exact:true}).setInputFiles(file(retention));await expect(h.statement.getByRole('button',{name:t('cost.statement.approveRetention'),exact:true})).toBeEnabled();
 await h.dialog.getByLabel(t('cost.from'),{exact:true}).fill('2026-09-01T00:00');await expect(h.statement.getByRole('button',{name:t('cost.statement.approveRetention'),exact:true})).toHaveCount(0);
 expect(h.writes).toHaveLength(0);expect(h.errors).toEqual([]);await info.attach(`cost-imports-${locale}-${info.project.name}`,{body:await page.screenshot(),contentType:'image/png'});
});

for(const kind of ['tariff','statement'] as const)test(`operator ${kind} uncertainty retains the original parent path body and key across scope changes`,async({page})=>{
 test.skip(!ready,'Requires root-supplied authenticated platform session and reused control-plane server');
 const h=await setup(page);let original:Write|undefined;
 h.setWrite(async(route,write)=>{if(!original){original=structuredClone(write);h.expected.push({url:route.request().url(),status:502});return route.fulfill({status:502,json:{error:'Platform response is unavailable; reconcile the original operation'}});}expect(write).toEqual(original);await route.fulfill({json:{duplicate:true,id:kind==='tariff'?tariffId:statementId}});});
 if(kind==='tariff'){await h.management.getByLabel(t('cost.manage.rateFile'),{exact:true}).setInputFiles(file(tariff()));await h.management.getByRole('button',{name:t('cost.manage.saveDraft'),exact:true}).click();}
 else{await h.statement.getByLabel(t('cost.statement.descriptionFile'),{exact:true}).setInputFiles(file(description()));await h.statement.getByRole('button',{name:t('cost.statement.reserve'),exact:true}).click();}
 const reconcile=h.dialog.getByRole('button',{name:t('cost.manage.reconcile'),exact:true});await expect(reconcile).toBeVisible();expect(h.writes).toHaveLength(1);
 await h.dialog.getByRole('combobox',{name:t('cost.account'),exact:true}).selectOption(otherAccount);await h.dialog.getByLabel(t('cost.from'),{exact:true}).fill('2026-09-01T00:00');
 await expect(h.dialog.getByLabel(t('cost.manage.rateFile'),{exact:true})).toBeDisabled();expect(h.writes).toHaveLength(1);
 await keyboardClick(page,reconcile);await expect(reconcile).toHaveCount(0);expect(h.writes).toHaveLength(2);expect(h.writes[1]).toEqual(h.writes[0]);
 expect(original?.path).toBe(`${root()}/${kind==='tariff'?'tariffs':'statements'}`);expect(original?.body).toEqual(kind==='tariff'?{definition:tariff(),supersedesId:null}:description());expect(h.expected).toEqual([]);expect(h.errors).toEqual([]);
});

test('operator tariff and selector replacement reads never submit stale imported input',async({page})=>{
 test.skip(!ready,'Requires root-supplied authenticated platform session and reused control-plane server');test.setTimeout(90_000);
 await page.addInitScript(()=>{const original=File.prototype.text;const controls={release:undefined as undefined|(()=>void),finished:false};Object.assign(window,{costImportRead:controls});
  File.prototype.text=function(){if(this.name!=='delayed.json')return original.call(this);return new Promise(resolve=>{controls.finished=false;controls.release=()=>{void original.call(this).then(value=>{resolve(value);controls.finished=true;});};});};});
 const h=await setup(page),reassess=h.management.getByRole('group',{name:t('cost.manage.reassess'),exact:true});
 for(const kind of ['tariff','selector'] as const){
  const input=h.management.getByLabel(t(kind==='tariff'?'cost.manage.rateFile':'cost.manage.selectorFile'),{exact:true});
  const action=()=>kind==='tariff'?h.management.getByRole('button',{name:t('cost.manage.saveDraft'),exact:true}):reassess.getByRole('button',{name:t('cost.manage.reassessSelected',{count:formatNumber(1,locale)}),exact:true});
  const a=kind==='tariff'?tariff():selector,b=kind==='tariff'?{...tariff(),sourceSha256:'9'.repeat(64),rates:[{...tariff().rates[0]!,unitPrice:'0.222222222222'}]}:{...selector,sourceSha256:'9'.repeat(64),market:'AE'};
  if(kind==='selector')await reassess.getByRole('checkbox').nth(1).check();
  const valid=async()=>{await input.setInputFiles(file(a));await expect.poll(()=>enabled(action())).toBe(true);};
  const before=h.writes.length;
  for(const invalid of [{name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{')},{name:'oversized.json',mimeType:'application/json',buffer:Buffer.alloc(65537,32)}]){
   await valid();await input.setInputFiles(invalid);await expect.poll(()=>enabled(action())).toBe(false);expect(h.writes).toHaveLength(before);
  }
  await valid();await input.setInputFiles([]);await expect.poll(()=>enabled(action())).toBe(false);expect(h.writes).toHaveLength(before);
  await valid();await input.setInputFiles(file(b,'delayed.json'));
  await expect.poll(()=>page.evaluate(()=>Boolean((window as unknown as {costImportRead:{release?:()=>void}}).costImportRead.release))).toBe(true);
  await expect.poll(()=>enabled(action())).toBe(false);expect(h.writes).toHaveLength(before);
  await input.setInputFiles({name:'new-invalid.json',mimeType:'application/json',buffer:Buffer.from('{')});
  await page.evaluate(()=>{const c=(window as unknown as {costImportRead:{release?:()=>void}}).costImportRead;c.release?.();c.release=undefined;});
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {costImportRead:{finished:boolean}}).costImportRead.finished)).toBe(true);
  await expect.poll(()=>enabled(action())).toBe(false);expect(h.writes).toHaveLength(before);
  // An older delayed A cannot overwrite current valid B or its feedback.
  await input.setInputFiles(file(a,'delayed.json'));
  await expect.poll(()=>page.evaluate(()=>Boolean((window as unknown as {costImportRead:{release?:()=>void}}).costImportRead.release))).toBe(true);
  await input.setInputFiles(file(b));await expect.poll(()=>enabled(action())).toBe(true);
  await page.evaluate(()=>{const c=(window as unknown as {costImportRead:{release?:()=>void}}).costImportRead;c.release?.();c.release=undefined;});
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {costImportRead:{finished:boolean}}).costImportRead.finished)).toBe(true);
  await action().click();await expect.poll(()=>h.writes.length).toBe(before+1);
  expect(kind==='tariff'?h.writes.at(-1)!.body.definition:(h.writes.at(-1)!.body.items as Array<{selectorEvidence:unknown}>)[0]!.selectorEvidence).toEqual(b);
 }
 expect(h.errors).toEqual([]);expect(h.expected).toEqual([]);
});
