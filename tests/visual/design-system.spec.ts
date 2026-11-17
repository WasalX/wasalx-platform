import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { getMessages } from "../../lib/i18n/messages/index.ts";
import { expect, test } from "@playwright/test";

const visualStories = [
  "design-system-foundation--light-tokens",
  "design-system-foundation--dark-tokens",
  "design-system-foundation--theme-parity",
  "design-system-controls--control-states-light",
  "design-system-controls--control-states-dark",
  "design-system-operational-states--state-matrix-light",
  "design-system-operational-states--state-matrix-dark",
] as const;

// Playwright owns these Axe scans; keep Storybook's automatic scanner out of the same page.
for (const storyId of visualStories) {
  test(`${storyId} is accessible and visually stable`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${storyId}&viewMode=story&globals=a11y.manual:!true`, { waitUntil: "networkidle" });
    const root = page.locator("#storybook-root");
    await expect(root).toBeVisible({ timeout: 15_000 });
    await expect(root).not.toContainText("The component failed to render properly");
    const loadedFonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return {
        families: [...document.fonts]
          .filter((font) => font.status === "loaded")
          .map((font) => font.family.replaceAll('"', "")),
        mono: document.fonts.check('12px "Geist Mono"'),
        sans: document.fonts.check('12px "Geist Sans"'),
      };
    });
    expect(loadedFonts.sans).toBe(true);
    expect(loadedFonts.mono).toBe(true);
    expect(loadedFonts.families).toContain("Geist Sans");
    expect(loadedFonts.families).toContain("Geist Mono");

    const accessibility = await new AxeBuilder({ page })
      .include("#storybook-root")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const violationSummary = accessibility.violations.flatMap((violation) =>
      violation.nodes.map((node) => ({
        help: violation.help,
        id: violation.id,
        target: node.target,
        detail: node.failureSummary,
      })),
    );
    expect(violationSummary, JSON.stringify(violationSummary, null, 2)).toEqual([]);

    await expect(root).toHaveScreenshot(`${storyId}.png`, {
      animations: "disabled",
      caret: "hide",
      maxDiffPixels: 2,
      scale: "css",
    });
  });
}

test("platform operations story provides a keyboard-safe responsive browser lane", async ({ page }) => {
  await page.goto("/iframe.html?id=product-platform-operations--dark&viewMode=story&globals=a11y.manual:!true", { waitUntil: "networkidle" });
  const root = page.locator("#storybook-root");
  await expect(root.getByRole("heading", { level: 1, name: "Operational control, without tenant data exposure." })).toBeVisible();
  await expect(root.getByRole("region", { name: "Workspace operations table" })).toBeVisible();

  const newWorkspace = root.getByRole("button", { name: "New workspace" });
  await newWorkspace.click();
  const dialog = root.getByRole("dialog", { name: "Provision a workspace" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(newWorkspace).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await root.getByRole("button", { name: "Open navigation" }).click();
  await expect(root.getByRole("button", { name: "Close navigation" })).toHaveAttribute("aria-expanded", "true");
  const overflow = await root.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow, "platform operations must not overflow the mobile viewport").toBeLessThanOrEqual(1);

  const accessibility = await new AxeBuilder({ page })
    .include("#storybook-root")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations, JSON.stringify(accessibility.violations, null, 2)).toEqual([]);
});
for (const locale of ["en", "ar"] as const) for (const width of [1216, 390]) {
  test(`deletion review preserves the same intent after response loss (${locale}, ${width})`, async ({ page }, testInfo) => {
    const messages=getMessages(locale),id="10000000-0000-4000-8000-000000000001";
    let state="SCOPE_REVIEW_REQUIRED",version=1,posts=0,firstKey="",firstBody:unknown;
    await page.route("**/api/platform-console/meta-deletion**",async route=>{
      const request=route.request();
      if(request.method()==="GET")return route.fulfill({json:{refusalAvailable:false,items:[{id,state,version,receivedAt:"2026-10-08T00:00:00Z",expiresAt:"2026-11-07T00:00:00Z"}]}});
      posts++;expect(request.headers()["x-wasalx-platform-csrf"]).toBe("storybook-platform-csrf");
      const body=request.postDataJSON();expect(body.evidenceSha256).toBe(createHash("sha256").update("Synthetic reviewed scope evidence").digest("hex"));
      expect(Object.keys(body).sort()).toEqual(["evidenceSha256","expectedVersion","reason","state"]);
      if(posts===1){firstKey=request.headers()["idempotency-key"];firstBody=body;state="NEEDS_INFORMATION";version=2;return route.abort("failed");}
      expect(request.headers()["idempotency-key"]).toBe(firstKey);expect(body).toEqual(firstBody);
      return route.fulfill({json:{id,state,version}});
    });
    await page.setViewportSize({width,height:844});
    await page.goto(`/iframe.html?id=product-platform-operations--${locale==="ar"?"arabic":"dark"}&viewMode=story&globals=a11y.manual:!true`);
    const root=page.locator("#meta-deletion");await root.getByRole("button",{name:messages["platform.deletion.refresh"],exact:true}).click();
    await root.getByRole("button",{name:messages["platform.deletion.review"],exact:true}).click();
    // Playwright follows the enclosing label to its enabled select for toBeDisabled.
    await expect(root.getByRole("option",{name:messages["platform.deletion.state.REFUSED"],exact:true})).toHaveJSProperty("disabled",true);
    const disposition=root.getByRole("combobox",{name:messages["platform.deletion.disposition"],exact:true});
    await expect(disposition).toHaveValue("NEEDS_INFORMATION");
    await disposition.focus();await disposition.press("End");
    await expect(disposition).toHaveValue("HELD");
    await disposition.press("Home");
    await expect(disposition).toHaveValue("NEEDS_INFORMATION");
    await root.locator('input[type="file"]').setInputFiles({name:"scope-review.txt",mimeType:"text/plain",buffer:Buffer.from("Synthetic reviewed scope evidence")});
    await root.getByRole("button",{name:messages["platform.deletion.saveReview"],exact:true}).click();
    await expect(root.getByRole("alert")).toBeVisible();await expect(root.locator('input[type="file"]')).toBeDisabled();
    await root.getByRole("button",{name:messages["platform.deletion.retry"],exact:true}).click();
    await expect(root).toContainText(messages["platform.deletion.state.NEEDS_INFORMATION"]);await expect.poll(()=>posts).toBe(2);
    expect(await root.evaluate(element=>element.scrollWidth-element.clientWidth)).toBeLessThanOrEqual(1);
    const accessibility=await new AxeBuilder({page}).include("#meta-deletion").withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();expect(accessibility.violations).toEqual([]);
    const screenshot = await root.screenshot({ path: `output/playwright/inbox/synthetic/deletion-review-${locale}-${width}.png` });
    await testInfo.attach(`deletion-review-${locale}-${width}`,{body:screenshot,contentType:"image/png"});
  });
}
