// Exploratory owner UI using synthetic identity receipts. No native/provider acceptance.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { getMessages } from "../lib/i18n/messages/index.ts";
const output = process.env.WASALX_SYNTHETIC_UI_OUTPUT ?? "output/playwright/service-access";
const base = process.env.WASALX_STORYBOOK_URL ?? "http://127.0.0.1:6227";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.WASALX_VISUAL_BROWSER_PATH ? { executablePath: process.env.WASALX_VISUAL_BROWSER_PATH } : {}), headless: true });

async function captureReview(page, dialog, locale, state, disabled = false, theme) {
  if (theme) await expect(page.locator("#storybook-root > .wx-story-canvas")).toHaveClass(new RegExp(`\\btheme-${theme}\\b`, "u"));
  const captureState = theme === "dark" ? `${state}-dark` : state;
  for (const [size,width,height] of [["desktop",1440,1000],["mobile",390,844],["zoom-equivalent",720,500]]) {
    await page.setViewportSize({width,height}); await page.evaluate(()=>document.fonts.ready);
    const check=dialog.getByRole("checkbox").last(); if (!disabled) { await page.keyboard.press("Tab"); await check.focus(); }
    await page.screenshot({path:`${output}/service-access-${locale}-${captureState}-${size}.png`,fullPage:true,animations:"disabled"});
    const result=await dialog.evaluate((root, disabled)=>{
      const errors=[],box=root.querySelector(".modal")??root,r=box.getBoundingClientRect();
      if (r.width > 520 || r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight || box.scrollWidth > box.clientWidth + 1) errors.push(`dialog outer size or overflow (${r.width}px wide)`);
      const probe=document.createElement("span");probe.style.color="var(--accent)";box.append(probe);const accent=getComputedStyle(probe).color;probe.remove();
      for(const input of box.querySelectorAll('input[type="checkbox"]')) {
        const label=input.closest("label"),a=input.getBoundingClientRect(),b=label.getBoundingClientRect(),s=getComputedStyle(input),l=getComputedStyle(label);
        if(a.width<12||a.width>24||a.height<12||a.height>24||a.left<b.left-1||a.right>b.right+1||b.height<43||l.display!=="flex"||l.flexDirection!=="row"||s.accentColor!==accent||parseFloat(s.paddingInlineStart)!==0)errors.push("checkbox native size/row/token/target");
      }
      for (const element of box.querySelectorAll("label,button,p")) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.left < r.left - 1 || rect.right > r.right + 1 || rect.left < 0 || rect.right > innerWidth + 1) errors.push("dialog control/copy containment");
        if (element.scrollWidth > element.clientWidth + 1) errors.push("dialog copy does not fit its control");
      }
      for (const action of box.querySelectorAll(".modal-actions button")) {
        const rect = action.getBoundingClientRect();
        if (rect.top < r.top || rect.bottom > r.bottom) errors.push("dialog action clipped vertically");
      }
      const focused=document.activeElement,s=getComputedStyle(focused);
      if(!disabled && (!focused.matches(":focus-visible")||s.outlineStyle!=="solid"||parseFloat(s.outlineWidth)<2))errors.push("checkbox focus-visible");
      if(disabled && [...box.querySelectorAll('input[type="checkbox"]')].some(input=>!input.disabled))errors.push("busy checkboxes must stay disabled");
      return {errors,checks:box.querySelectorAll('input[type="checkbox"]').length};
    }, disabled);
    assert.ok(result.checks>0);assert.deepEqual(result.errors,[],`${locale}/${captureState}/${size}: open service dialog coherence`);
    if(!disabled){const audit=await new AxeBuilder({page}).include("dialog[open]").withTags(["wcag2a","wcag2aa","wcag21aa"]).analyze();assert.deepEqual(audit.violations,[],`${locale}/${captureState}/${size}: open dialog accessibility`);}
  }
  if (theme) {
    await page.setViewportSize({ width: 390, height: 220 });
    const scrolled = await dialog.locator(".modal").evaluate(box => {
      const bounds = box.getBoundingClientRect();
      const actions = [...box.querySelectorAll(".modal-actions button")];
      const actionsFit = () => actions.every(action => {
        const rect = action.getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      });
      box.scrollTop = 0;
      const initiallyVisible = actionsFit();
      box.scrollTop = box.scrollHeight;
      return { initiallyVisible, scrolled: box.scrollTop > 0, stillVisible: actionsFit() };
    });
    assert.deepEqual(scrolled, { initiallyVisible: true, scrolled: true, stillVisible: true }, `${locale}/${theme}: short phone scroll and action visibility`);
  }
  await page.setViewportSize({width:1440,height:1000});
}

const results = [];
const storageKey = "wasalx:identity-operation:storybook:synthetic-service-access";
try {
  for (const locale of ["en", "ar"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(), messages = getMessages(locale);
    const t = key => { assert.equal(typeof messages[key], "string"); return messages[key]; };
    const button = key => page.getByRole("button", { name: t(key), exact: true });
    const state = { mode: "LEGACY", phase: "UNCONFIGURED", portal_ready: false, access_required: false, status_version: "1", operation_id: null, can_initialize: false, can_prepare: true, can_bind: false, can_complete: false, legacy_retirement_ready: false,
      legacy_member: { name: "Synthetic earlier service", email: "earlier-service@example.invalid" }, groups: [{ id: "2", name: "Synthetic customer support operations team with a long supported display name", active: true, enabled: false, version: "1" }], groups_next_cursor: "2" };
    const secondTeam = { id: "3", name: "Synthetic accounts", active: true, enabled: false, version: "1" };
    const receipts = new Map(), writes = [], reads = [];
    let lose = false, reject = null, denied = false, holdGrant = null, dropGrant = false;
    const bridge = async route => {
      const { operation, input } = route.request().postDataJSON();
      if (operation === "TEAM_LIST") { await route.fulfill({ status: 403, json: { code: "FORBIDDEN", error: "SYNTHETIC_PRIVATE_ERROR" } }); return; }
      if (denied || reject === operation) { const code = denied ? "FORBIDDEN" : "REAUTHENTICATION_REQUIRED"; reject = null; await route.fulfill({ status: 403, json: { code, error: "SYNTHETIC_PRIVATE_ERROR" } }); return; }
      if (operation === "IDENTITY_GRANT" && dropGrant) { dropGrant = false; await route.abort("failed"); return; }
      if (operation === "IDENTITY_STATUS") { reads.push(operation); await route.fulfill({ json: { ...state, groups: input.teams_after ? [secondTeam] : state.groups, groups_next_cursor: input.teams_after ? null : state.groups_next_cursor } }); return; }
      if (operation === "IDENTITY_RECEIPT") {
        reads.push(operation); let result = receipts.get(input.request_id);
        if (!result && input.action === "CANCEL_IF_UNADMITTED") { result = { state: "NOT_APPLIED", terminal: true }; receipts.set(input.request_id, result); }
        await route.fulfill({ json: result ?? { state: "UNKNOWN", terminal: false } }); return;
      }
      if (receipts.has(input.request_id)) { await route.fulfill({ json: receipts.get(input.request_id) }); return; }
      assert.equal(typeof input.request_id, "string");
      if (operation === "IDENTITY_INITIALIZE") {
        assert.equal(input.expected_status_version, state.status_version); assert.equal(Object.hasOwn(input, "operation_id"), false); assert.ok(state.can_initialize);
        state.can_initialize = false; state.access_required = false; state.phase = "BOUND"; state.portal_ready = true; state.status_version = String(Number(state.status_version) + 1);
      } else if (operation === "IDENTITY_GRANT") {
        const team = input.team_id === "2" ? state.groups[0] : secondTeam; assert.equal(input.expected_version, team.version); team.enabled = input.enabled; team.version = String(Number(team.version) + 1);
      } else {
        assert.equal(input.expected_status_version, state.status_version);
        if (operation === "IDENTITY_PREPARE") { state.operation_id = input.operation_id; state.phase = "PREPARED"; state.can_prepare = false; state.can_bind = true; }
        else { assert.equal(input.operation_id, state.operation_id); if (operation === "IDENTITY_BIND") { state.phase = "BOUND"; state.can_bind = false; state.can_complete = true; } else { assert.equal(operation, "IDENTITY_COMPLETE"); assert.ok(state.legacy_retirement_ready && input.retire_legacy === true); state.phase = "COMPLETE"; state.can_complete = false; state.portal_ready = true; } }
        state.status_version = String(Number(state.status_version) + 1);
      }
      const result = { state: "APPLIED", terminal: true }; receipts.set(input.request_id, result); writes.push({ operation, request_id: input.request_id });
      if (operation === "IDENTITY_GRANT" && holdGrant) await holdGrant;
      if (lose) { lose = false; await route.abort("failed"); return; } await route.fulfill({ json: result });
    };
    await page.route("**/api/inbox", bridge);
    const open = (theme = "light") => page.goto(`${base}/iframe.html?${new URLSearchParams({
      id: `product-service-access--${locale === "ar" ? "arabic" : "english"}`, viewMode: "story", globals: `auditTheme:${theme}`,
    })}`, { waitUntil: "networkidle" });
    const dialog = page.getByRole("dialog");
    const applying = dialog.getByRole("status").filter({ hasText: t("serviceAccess.applyingGrant") });
    const recoveryText = dialog.getByRole("status").filter({ hasText: t("serviceAccess.unknown") });
    const recoveryCheck = dialog.getByRole("button", { name: t("serviceAccess.check"), exact: true });
    const recoveryCancel = dialog.getByRole("button", { name: t("serviceAccess.cancelMissing"), exact: true });
    const approve = async () => { await dialog.getByRole("checkbox", { name: t("serviceAccess.confirm"), exact: true }).check(); await dialog.getByRole("button", { name: t("serviceAccess.apply"), exact: true }).click(); };
    const reload = async () => { const response = page.waitForResponse(response => response.request().postDataJSON()?.operation === "IDENTITY_STATUS"); await button("common.actions.refresh").click(); await response; };
    try {
      const prepare = button("serviceAccess.prepare");
      const cancel = dialog.getByRole("button", { name: t("tenant.team.actions.cancel"), exact: true });
      await open("dark");
      await prepare.focus(); await page.keyboard.press("Enter");
      await expect(cancel).toBeFocused();
      await dialog.getByRole("checkbox", { name: t("serviceAccess.confirm"), exact: true }).check();
      await captureReview(page, dialog, locale, "consent-checked", false, "dark");
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(prepare).toBeFocused();

      await open(); await expect(page.getByText(t("serviceAccess.notGranted"), { exact: true })).toBeVisible(); await expect(page.getByText("Synthetic earlier service", { exact: true })).toBeVisible(); assert.equal(writes.length, 0);
      for(const [size,width,height] of [["desktop",1440,1000],["mobile",390,844],["zoom-equivalent",720,500]]) {
        await page.setViewportSize({width,height}); await page.screenshot({path:`${output}/service-access-${locale}-legacy-summary-${size}.png`,fullPage:true});
        assert.equal(await page.locator(".settings-summary").evaluate(element=>{const s=getComputedStyle(element),r=element.getBoundingClientRect();return s.display==="grid"&&[...element.children].every(child=>{const c=child.getBoundingClientRect();return c.left>=r.left-1&&c.right<=r.right+1&&child.scrollWidth<=child.clientWidth+1;});}),true,"Long service summary remains bounded and stacked");
        for(const action of await page.locator(".settings-actions > button").all())assert.equal(await action.evaluate(button=>{const a=button.getBoundingClientRect(),b=button.parentElement.getBoundingClientRect();return a.left>=b.left-1&&a.right<=b.right+1;}),true);
      }
      await page.setViewportSize({width:1440,height:1000});
      await prepare.focus(); await page.keyboard.press("Enter"); await expect(cancel).toBeFocused(); await expect(dialog.getByRole("button", { name: t("serviceAccess.apply"), exact: true })).toBeDisabled();
      await captureReview(page, dialog, locale, "consent-unchecked");
      await dialog.getByRole("checkbox", { name: t("serviceAccess.confirm"), exact: true }).check();
      await captureReview(page, dialog, locale, "consent-checked", false, "light");
      lose = true; await approve(); await expect(dialog.getByRole("button", { name: t("serviceAccess.check"), exact: true })).toBeVisible();
      const stored = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), storageKey); assert.deepEqual(Object.keys(stored).sort(), ["kind", "request_id"]);
      assert.equal(writes.length, 1); await page.reload({ waitUntil: "networkidle" }); await button("serviceAccess.check").click(); await expect(button("serviceAccess.bind")).toBeVisible(); assert.equal(writes.length, 1);
      await button("serviceAccess.reviewGrant").click(); await expect(dialog.getByRole("checkbox", { name: t("serviceAccess.fullTeamAccess"), exact: true })).not.toBeChecked();
      await captureReview(page, dialog, locale, "grant-unchecked");
      await dialog.getByRole("checkbox", { name: t("serviceAccess.fullTeamAccess"), exact: true }).check();
      await captureReview(page, dialog, locale, "grant-checked");
      let releaseGrant; holdGrant=new Promise(resolve=>{releaseGrant=resolve;});
      try {
        const grantRequest = page.waitForRequest(request => request.url().endsWith("/api/inbox") && request.postDataJSON()?.operation === "IDENTITY_GRANT");
        await approve();
        const { input } = (await grantRequest).postDataJSON();
        assert.equal(input.expected_version, "1");
        assert.deepEqual(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), storageKey), {
          request_id: input.request_id, kind: "IDENTITY_GRANT", team_id: input.team_id,
        });
        await expect(applying).toBeVisible();
        await expect(recoveryText).toHaveCount(0);
        await expect(recoveryCheck).toHaveCount(0);
        await expect(recoveryCancel).toHaveCount(0);
        for (const control of await dialog.getByRole("button").all()) await expect(control).toBeDisabled();
        await captureReview(page, dialog, locale, "grant-busy", true);
      } finally { holdGrant=null; releaseGrant(); }
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText(t("serviceAccess.granted"), { exact: true })).toBeVisible();
      for (const [size, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]]) {
        await page.setViewportSize({ width, height });
        await page.screenshot({ path: `${output}/service-access-${locale}-grant-success-${size}.png`, fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await button("serviceAccess.bind").click(); await approve(); await expect(button("serviceAccess.complete")).toBeDisabled(); await expect(page.getByText(t("serviceAccess.removeLegacyFirst"), { exact: true })).toBeVisible();
      assert.equal(writes.filter(row => row.operation === "IDENTITY_COMPLETE").length, 0);
      state.legacy_retirement_ready = true; await reload(); await button("serviceAccess.complete").click(); await approve(); await expect(page.getByText(t("serviceAccess.ready"), { exact: true })).toBeVisible();
      await button("serviceAccess.more").click(); await page.getByRole("button", { name: "Synthetic selection change", exact: true }).click(); await expect(page.getByText("Synthetic accounts", { exact: true })).toBeVisible();
      await button("serviceAccess.reviewGrant").click();
      await dialog.getByRole("checkbox", { name: t("serviceAccess.fullTeamAccess"), exact: true }).check();
      dropGrant = true; await approve();
      await expect(recoveryText).toBeVisible();
      await expect(applying).toHaveCount(0);
      await expect(recoveryCheck).toBeEnabled();
      await expect(recoveryCancel).toBeEnabled();
      await captureReview(page, dialog, locale, "grant-unknown", true);
      await recoveryCheck.click();
      await expect(recoveryCancel).toBeEnabled();
      await recoveryCancel.click();
      await expect(dialog).toHaveCount(0);
      await button("serviceAccess.more").click();
      await expect(page.getByText(t("serviceAccess.notGranted"), { exact: true })).toBeVisible();

      await button("serviceAccess.reviewGrant").click(); await dialog.getByRole("checkbox", { name: t("serviceAccess.fullTeamAccess"), exact: true }).check(); reject = "IDENTITY_GRANT"; await approve();
      await expect(dialog.getByRole("link", { name: t("tenant.privacy.action.reauthenticate"), exact: true })).toBeVisible(); await expect(dialog.getByRole("checkbox", { name: t("serviceAccess.fullTeamAccess"), exact: true })).toBeChecked();
      const reauthLink=dialog.getByRole("link", { name:t("tenant.privacy.action.reauthenticate"),exact:true }); await page.keyboard.press("Tab"); await reauthLink.focus();
      assert.equal(await reauthLink.evaluate(link=>["inline-flex","flex"].includes(getComputedStyle(link).display)&&link.getBoundingClientRect().height>=34&&link.matches(":focus-visible")),true);
      await dialog.getByRole("button", { name: t("serviceAccess.check"), exact: true }).click(); await expect(dialog).toBeVisible(); await dialog.getByRole("button", { name: t("serviceAccess.cancelMissing"), exact: true }).click(); await expect(dialog).toHaveCount(0);
      assert.equal(writes.filter(row => row.operation === "IDENTITY_GRANT").length, 1);
      // Fresh initialization has no synthetic finish/retirement operation.
      state.mode = "FRESH"; state.phase = "BOUND"; state.portal_ready = false; state.can_complete = false; await reload(); await expect(page.getByText(t("serviceAccess.fresh"), { exact: true })).toBeVisible(); await expect(button("serviceAccess.complete")).toHaveCount(0); await expect(button("serviceAccess.initialize")).toHaveCount(0);
      state.portal_ready = true; await reload();
      for (const [size, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]]) {
        await page.setViewportSize({ width, height }); await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: `${output}/service-access-${locale}-${size}.png`, fullPage: true });
        // Reload returns the first authoritative page; selected team 3 is no longer present.
        await expect(page.getByText(t("serviceAccess.teamUnavailable"), { exact: true })).toBeVisible();
        await expect(page.locator(".settings-summary")).toHaveCount(0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        const audit = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); assert.deepEqual(audit.violations, []);
        await button("common.actions.refresh").focus(); await page.keyboard.press("Tab"); assert.equal(await page.evaluate(() => document.activeElement.matches(":focus-visible")), true);
      }
      denied = true; await reload(); await expect(button("serviceAccess.reviewGrant")).toHaveCount(0); assert.ok(!(await page.locator("body").innerText()).includes("SYNTHETIC_PRIVATE_ERROR"));
      denied = false; await reload();
      await page.evaluate(key => sessionStorage.setItem(key, "{"), storageKey); await page.reload({ waitUntil: "networkidle" }); await expect(button("serviceAccess.reviewGrant")).toBeDisabled(); assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), "{");
      // Actual SupportTeams parent is denied while the independently owned service panel remains reachable.
      const protectedPage = await context.newPage(); await protectedPage.route("**/api/inbox", bridge);
      Object.assign(state, { mode: "FRESH", phase: "UNCONFIGURED", portal_ready: false, access_required: true, can_initialize: true, can_prepare: false, can_bind: false, can_complete: false, legacy_member: null });
      state.groups[0].enabled = false; secondTeam.enabled = false;
      await protectedPage.goto(`${base}/iframe.html?id=product-service-access--protected-owner-${locale === "ar" ? "arabic" : "english"}`, { waitUntil: "networkidle" });
      await expect(protectedPage.getByRole("button", { name: t("teamsAdmin.createTeam"), exact: true })).toBeDisabled();
      const service = protectedPage.getByRole("region", { name: t("serviceAccess.title"), exact: true });
      await expect(service.getByRole("button", { name: t("serviceAccess.initialize"), exact: true })).toBeEnabled(); assert.equal(writes.filter(row => row.operation === "IDENTITY_INITIALIZE").length, 0);
      await service.getByRole("button", { name: t("serviceAccess.initialize"), exact: true }).click();
      const protectedDialog = protectedPage.getByRole("dialog"); await protectedDialog.getByRole("checkbox", { name: t("serviceAccess.confirm"), exact: true }).check();
      lose = true; await protectedDialog.getByRole("button", { name: t("serviceAccess.apply"), exact: true }).click();
      await expect(protectedDialog.getByRole("button", { name: t("serviceAccess.check"), exact: true })).toBeVisible();
      const initializeRecovery = await protectedPage.evaluate(() => JSON.parse(sessionStorage.getItem("wasalx:identity-operation:storybook:synthetic-protected-owner")));
      assert.deepEqual(Object.keys(initializeRecovery).sort(), ["kind", "request_id"]); assert.equal(initializeRecovery.kind, "IDENTITY_INITIALIZE");
      await protectedPage.reload({ waitUntil: "networkidle" });
      const recovery = protectedPage.getByRole("region", { name: t("serviceAccess.title"), exact: true });
      // Expired privileged admission during passive recovery preserves the exact original intent.
      reject = "IDENTITY_RECEIPT";
      const expiredLookup = protectedPage.waitForRequest(request => request.url().endsWith("/api/inbox") && request.postDataJSON()?.operation === "IDENTITY_RECEIPT");
      await recovery.getByRole("button", { name: t("serviceAccess.check"), exact: true }).click();
      assert.deepEqual((await expiredLookup).postDataJSON().input, { ...initializeRecovery, action: "LOOKUP" });
      await expect(recovery.getByRole("link", { name: t("tenant.privacy.action.reauthenticate"), exact: true })).toHaveAttribute("href", "/auth/login?step_up=privileged&return_to=%2Fapp%3Fview%3Dteam");
      assert.deepEqual(await protectedPage.evaluate(() => JSON.parse(sessionStorage.getItem("wasalx:identity-operation:storybook:synthetic-protected-owner"))), initializeRecovery);
      assert.equal(writes.filter(row => row.operation === "IDENTITY_INITIALIZE").length, 1);
      await expect(recovery.getByRole("button", { name: t("serviceAccess.check"), exact: true })).toBeEnabled();
      // Fresh authoritative admission settles the same receipt; the original initialization is never resent.
      const validLookup = protectedPage.waitForRequest(request => request.url().endsWith("/api/inbox") && request.postDataJSON()?.operation === "IDENTITY_RECEIPT");
      await recovery.getByRole("button", { name: t("serviceAccess.check"), exact: true }).click();
      assert.deepEqual((await validLookup).postDataJSON().input, { ...initializeRecovery, action: "LOOKUP" });
      await expect(recovery.getByRole("button", { name: t("serviceAccess.check"), exact: true })).toHaveCount(0);
      assert.equal(await protectedPage.evaluate(() => sessionStorage.getItem("wasalx:identity-operation:storybook:synthetic-protected-owner")), null);
      await expect(recovery.getByRole("link", { name: t("tenant.privacy.action.reauthenticate"), exact: true })).toHaveCount(0);
      await expect(protectedPage.getByText(t("serviceAccess.ready"), { exact: true })).toBeVisible(); assert.equal(writes.filter(row => row.operation === "IDENTITY_INITIALIZE").length, 1);
      assert.equal(state.groups.some(team => team.enabled) || secondTeam.enabled, false);
      await expect(protectedPage.getByRole("button", { name: t("serviceAccess.complete"), exact: true })).toHaveCount(0);
      await protectedPage.close();
      results.push({ locale, status: "passed", writes: writes.length, reads: reads.length });
    } catch (failure) { results.push({ locale, status: "failed", error_class: failure.name }); throw failure; }
    finally { await context.close(); }
  }
} finally { await writeFile(`${output}/synthetic-ui-results.json`, JSON.stringify({ mode: "simulated_bridge", evidence_scope: "exploratory_ui", cases: results }, null, 2)); await browser.close(); }
