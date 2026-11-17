import { expect,test,type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { MetaCostUsageSnapshot } from "../../packages/core/src/meta-cost";
import { englishTenantMessages } from "../../lib/i18n/messages/en/tenant";
import { arabicTenantMessages } from "../../lib/i18n/messages/ar/tenant";

const role=process.env.WASALX_E2E_ROLE??"tenant_owner",locale=process.env.WASALX_E2E_LOCALE??"en";
const messages:Readonly<Record<string,string>>=locale==="ar"?arabicTenantMessages:englishTenantMessages;
const t=(key:string)=>messages[key]!;
const accountA="31000000-0000-4000-8000-000000000001",accountB="31000000-0000-4000-8000-000000000002";
function result(accountId:string,count=1):MetaCostUsageSnapshot{
  const raw=BigInt("12345678901234567890123456")*BigInt(count),rounded=BigInt("1234567890123456789012")*BigInt(count);
  const rawTotal=`${raw/BigInt(1000000)}.${String(raw%BigInt(1000000)).padStart(6,"0")}`,total=`${rounded/BigInt(100)}.${String(rounded%BigInt(100)).padStart(2,"0")}`;
  const rows=Array.from({length:count},(_,index)=>({id:`assessment-${index}`,deliveryId:`delivery-${index}`,accountId,purpose:"UPSTREAM_REFERENCE" as const,
    evidenceMode:"SIMULATED" as const,state:"ESTIMATED" as const,reason:"PROVISIONAL_RATE",delivered:true,reportedFree:false,
    deliveredAt:"2026-10-08T09:00:00.000Z",observedAt:"2026-10-08T09:00:00.000Z",tariffVersionId:"tariff-a",currency:"USD",minorUnits:2,rounding:"LINE" as const,
    unroundedAmount:"12345678901234567890.123456",amount:"12345678901234567890.12",evidenceRedacted:false,inputSha256:"a".repeat(64),receiptSetSha256:"b".repeat(64),admissionSha256:"c".repeat(64),admissionDigestFormat:"pg-jsonb-text-v1" as const,paymentMode:"CUSTOMER" as const,payerState:"UNVERIFIED" as const,timeBasis:"PROVIDER_DELIVERED_TIMESTAMP" as const}));
  return{complete:true,selectedCount:count,selectedSha256:"d".repeat(64),accountId,from:"2026-10-01T00:00:00.000Z",to:"2026-11-01T00:00:00.000Z",rows,
    totals:[{purpose:"UPSTREAM_REFERENCE",evidenceMode:"SIMULATED",currency:"USD",minorUnits:2,rounding:"LINE",tariffVersionId:"tariff-a",periodFrom:"2026-10-01T00:00:00.000Z",periodTo:"2026-11-01T00:00:00.000Z",quantity:count,unroundedAmount:rawTotal,amount:total,partialPeriod:false}],
    coverage:[{purpose:"UPSTREAM_REFERENCE",evidence_mode:"SIMULATED",effects:count,delivered:count,reported_free:0,estimated:count,unresolved:0}]};
}

// Mocked application rendering proves UX only. P08/P10 actual-stack fixtures own
// authority, signed receipt, SQL arithmetic and managed workflow qualification.
test("cost usage preserves exact money, role boundaries, account changes and complete exports",async({page},testInfo)=>{
  test.skip(testInfo.project.name==="tablet-820");
  let reads=0,failed=false,holdRetired=false,retiredRoute:Route|undefined;
  let notifyRetired:()=>void=()=>{};
  const retiredRequested=new Promise<void>(resolve=>{notifyRetired=resolve;});
  await page.route("**/api/meta-costs/**",async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith("/accounts"))return route.fulfill({json:[{id:accountA,names:["Customer service"]},{id:accountB,names:["Retired account"]}]});
    if(url.pathname.endsWith("/export")){expect(url.searchParams.get("accountId")).toBe(accountA);return route.fulfill({contentType:"text/csv; charset=utf-8",body:'"amount","currency"\r\n"12345678901234567890.12","USD"\r\n'});}
    if(url.pathname.endsWith("/statements"))return route.fulfill({json:[]});
    reads++;if(failed)return route.fulfill({status:409,json:{error:"PRIVATE_FAILURE_MUST_NOT_RENDER"}});
    const account=url.searchParams.get("accountId");
    if(account==="unattributed")return route.fulfill({json:{...result(accountA,0),accountId:null,totals:[],coverage:[]}});
    if(account===accountB){if(holdRetired){retiredRoute=route;notifyRetired();return;}return route.fulfill({json:{...result(accountB,0),totals:[],coverage:[]}});}
    return route.fulfill({json:result(accountA,101)});
  });
  await page.goto("/app?view=connections");await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  const summary=page.locator("summary").filter({hasText:t("cost.title")});
  if(!["tenant_owner","tenant_admin","auditor"].includes(role)){await expect(summary).toHaveCount(0);expect(reads).toBe(0);return;}
  await summary.click();await expect(page.getByText(t("cost.empty"),{exact:true})).toBeVisible();
  await page.getByRole("combobox",{name:t("cost.account"),exact:true}).selectOption(accountA);
  const cost=page.locator("details").filter({has:summary}).first();
  await expect(cost.getByText("USD 12345678901234567890.12",{exact:true}).first()).toBeVisible();
  await expect(cost.getByText(t("cost.mode.SIMULATED"),{exact:false}).first()).toBeVisible();
  await expect(cost.getByRole("row")).toHaveCount(101);
  await cost.getByRole("button",{name:t("cost.next"),exact:true}).click();await expect(cost.getByRole("row")).toHaveCount(2);
  const download=page.waitForEvent("download");await cost.getByRole("button",{name:t("cost.export"),exact:true}).click();expect((await download).suggestedFilename()).toBe("wasalx-meta-costs.csv");
  await page.getByRole("combobox",{name:t("cost.account"),exact:true}).selectOption(accountB);await expect(cost.getByText(t("cost.empty"),{exact:true})).toBeVisible();await expect(cost.getByText("USD 12345678901234567890.12",{exact:true})).toHaveCount(0);
  failed=true;await page.getByRole("combobox",{name:t("cost.account"),exact:true}).selectOption(accountA);await expect(cost.getByRole("alert")).toContainText(t("cost.failed"));await expect(page.getByText("PRIVATE_FAILURE_MUST_NOT_RENDER")).toHaveCount(0);
  failed=false;await cost.getByRole("button",{name:t("cost.retry"),exact:true}).click();await expect(cost.getByRole("table")).toBeVisible();
  // A delayed response from the previous account must not replace the current view.
  holdRetired=true;await page.getByRole("combobox",{name:t("cost.account"),exact:true}).selectOption(accountB);await retiredRequested;
  await expect(cost.getByRole("table")).toHaveCount(0);
  await expect(cost.getByRole("button",{name:t("cost.export"),exact:true})).toBeDisabled();
  await page.getByRole("combobox",{name:t("cost.account"),exact:true}).selectOption(accountA);await expect(cost.getByRole("table")).toBeVisible();
  await retiredRoute!.fulfill({json:{...result(accountB,0),totals:[],coverage:[]}});
  await expect(page.getByRole("combobox",{name:t("cost.account"),exact:true})).toHaveValue(accountA);
  await expect(cost.getByText("USD 12345678901234567890.12",{exact:true}).first()).toBeVisible();
  const tableScroll=cost.getByRole("region",{name:t("cost.tableCaption"),exact:true});
  await tableScroll.focus();await page.keyboard.press("Shift+Tab");await expect(tableScroll).not.toBeFocused();
  await page.keyboard.press("Tab");await expect(tableScroll).toBeFocused();
  await expect(tableScroll).toHaveCSS("outline-style","solid");await expect(tableScroll).toHaveCSS("outline-width","2px");
  const scroll=await tableScroll.evaluate(element=>({left:element.scrollLeft,max:element.scrollWidth-element.clientWidth,rtl:getComputedStyle(element).direction==="rtl"}));
  if(scroll.max>1){
   const key=scroll.rtl?(scroll.left>-scroll.max+1?"ArrowLeft":"ArrowRight"):(scroll.left<scroll.max-1?"ArrowRight":"ArrowLeft");
   await page.keyboard.press(key);
   await expect.poll(()=>tableScroll.evaluate(element=>element.scrollLeft)).not.toBe(scroll.left);
  }
  await testInfo.attach(`cost-table-keyboard-${locale}-${testInfo.project.name}`,{body:await page.screenshot(),contentType:"image/png"});
  expect((await new AxeBuilder({page}).include("details[open]").analyze()).violations).toEqual([]);
  await testInfo.attach(`meta-cost-${locale}-${testInfo.project.name}`,{body:await cost.screenshot(),contentType:"image/png"});
});
