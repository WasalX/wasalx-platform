import { expect,type Page,type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { getMessages } from "../../lib/i18n/messages/index.ts";
import type { Locale } from "../../lib/i18n/locales.ts";

// UI fixture only. It does not prove an actual Meta callback or delete outcome.
export async function metaDeletionStatusJourney(page:Page,locale:Locale,testInfo:TestInfo) {
  const messages=getMessages(locale),code="a".repeat(64);let calls=0;
  const states=["SCOPE_REVIEW_REQUIRED","NEEDS_INFORMATION","HELD","REFUSED","UNAVAILABLE"] as const;
  await page.route("**/api/meta-deletion/status",async route=>{
    calls++;expect(route.request().method()).toBe("POST");expect(new URL(route.request().url()).search).toBe("");
    expect(route.request().postDataJSON()).toEqual({code});expect(route.request().headers().cookie).toBeUndefined();
    expect(route.request().url()).not.toContain(code);
    await route.fulfill({json:{state:states[Math.min(calls-1,states.length-1)],...(states[Math.min(calls-1,states.length-1)]==="REFUSED"?{refusalPolicyUrl:"https://policy.example.invalid/retention"}:{})},headers:{"cache-control":"no-store","referrer-policy":"no-referrer"}});
  });
  await page.goto(`/privacy/meta-deletion#${code}`);
  const root=page.getByRole("main");
  await expect(root.getByRole("heading",{name:messages["platform.deletion.state.SCOPE_REVIEW_REQUIRED"],exact:true})).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");expect(new URL(page.url()).search).toBe("");
  expect(calls).toBe(1); // Exactly one initial lookup after fragment removal.
  await expect(root.getByRole("group",{name:messages["common.locale.label"],exact:true})).toBeVisible();
  await expect(root.locator('fieldset button[aria-pressed="true"]')).toHaveCount(1);
  await expect(root).toHaveAttribute("dir",locale==="ar"?"rtl":"ltr");
  for(const state of states.slice(1)){
    await root.getByRole("button",{name:messages["platform.deletion.check"],exact:true}).click();
    await expect(root.getByRole("heading",{name:messages[`platform.deletion.state.${state}`],exact:true})).toBeVisible();
    if(state==="REFUSED")await expect(root.getByRole("link",{name:messages["platform.deletion.policy"],exact:true})).toHaveAttribute("href","https://policy.example.invalid/retention");
  }
  expect(await root.evaluate(element=>element.scrollWidth-element.clientWidth)).toBeLessThanOrEqual(1);
  const result=await new AxeBuilder({page}).include("main").withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();expect(result.violations).toEqual([]);
  await testInfo.attach(`meta-deletion-status-${locale}`,{body:await root.screenshot(),contentType:"image/png"});
  expect(calls).toBe(5);
}
