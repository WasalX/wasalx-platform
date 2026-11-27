// Actual component interaction with a synthetic bridge: exploratory UI evidence only.
// This never verifies SMTP/IMAP, a real provider, the native gateway or a release candidate.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { getMessages } from "../lib/i18n/messages/index.ts";
import { adminFixture, syntheticCredentials } from "./helpers/admin-bridge-fixture.mjs";
import { syntheticBrowserTrace } from "./helpers/synthetic-browser-trace.mjs";

const base = process.env.WASALX_STORYBOOK_URL ?? "http://127.0.0.1:6227";
const output = process.env.WASALX_SYNTHETIC_UI_OUTPUT ?? "output/playwright/admin";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.WASALX_VISUAL_BROWSER_PATH ? { executablePath: process.env.WASALX_VISUAL_BROWSER_PATH } : {}), headless: true });
const trace = syntheticBrowserTrace(browser, base, output);
const results = [];
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const story = (surface, locale) => `${base}/iframe.html?id=product-administration--${surface === "teams" ? "support-teams" : surface === "settings" ? "mailbox-settings" : "mailbox-administration"}-${locale === "ar" ? "arabic" : "english"}`;

async function setup(surface, locale, configure, viewport = { width: 1440, height: 1000 }) {
  const context = await trace.newContext({ viewport });
  const page = await context.newPage(), fixture = adminFixture();
  configure?.(fixture);
  await fixture.install(page);
  page.on("dialog", async dialog => { assert.ok(["confirm", "beforeunload"].includes(dialog.type())); await dialog.accept(); });
  const messages = getMessages(locale);
  const t = key => { assert.ok(typeof messages[key] === "string" && messages[key] !== key, `Missing actual locale key ${locale}:${key}`); return messages[key]; };
  const button = key => page.getByRole("button", { name: t(key), exact: true });
  const open = () => page.goto(story(surface, locale), { waitUntil: "networkidle" });
  await open();
  return { context, page, fixture, t, button, open, surface, locale };
}
async function assertFormContainment(test, viewport) {
  const result = await test.page.locator("main").evaluate(main => {
    const failures = [], visible = [];
    for (const element of main.querySelectorAll("fieldset, legend, label, input, select, textarea, button, small")) {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || !element.getClientRects().length) continue;
      if (rect.width <= 0 || rect.height <= 0) {
        failures.push({ tag: element.tagName, id: element.id, reason: "non-positive rendered geometry" });
        continue;
      }
      visible.push(element.tagName);
      const boundaries = [element.closest("form"), element.closest(".panel"), element.parentElement?.closest("fieldset")].filter(Boolean);
      const bounds = [{ left: 0, right: innerWidth }, ...boundaries.map(parent => parent.getBoundingClientRect())];
      if (bounds.some(bound => rect.left < bound.left - 1 || rect.right > bound.right + 1)) {
        failures.push({ tag: element.tagName, id: element.id, left: rect.left, right: rect.right });
      }
    }
    return { visible, failures };
  });
  assert.ok(result.visible.includes("FIELDSET") && result.visible.includes("INPUT"), "Actual populated administration form must be present");
  assert.deepEqual(result.failures, [], `${test.surface}/${test.locale}/${viewport}: controls/help must fit their form, fieldset, panel and viewport`);
}
async function captureAndAudit(test, state) {
  const { page, locale, surface } = test;
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("main")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
  const font = await page.locator("main").evaluate(element => getComputedStyle(element).fontFamily);
  assert.match(font, locale === "ar" ? /Noto Sans Arabic/u : /Geist/u);
  for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844], ["zoom-equivalent", 720, 500]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole("button").filter({ visible: true }).first().focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement !== document.body && document.activeElement.matches(":focus-visible")), true, `${surface}/${locale}/${name}: keyboard focus`);
    await page.screenshot({ path: `${output}/${surface}-${locale}-${state}-${name}.png`, fullPage: true });
    await assertFormContainment(test, name);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${surface}/${locale}/${name}: horizontal overflow`);
    const audit = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    assert.deepEqual(audit.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })), [], `${surface}/${locale}/${name}: accessibility findings`);
  }
  await page.setViewportSize({ width: 720, height: 500 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${surface}/${locale}: 200% equivalent viewport overflow`);
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function captureCoherence(test, state, { signature = false, unknown = false, mailboxAddress } = {}) {
  const { page, surface, locale } = test;
  for (const [size, width, height] of [["desktop",1440,1000],["mobile",390,844],["zoom-equivalent",720,500]]) {
    await page.setViewportSize({ width, height }); await page.evaluate(() => document.fonts.ready);
    if (mailboxAddress) await expect(page.locator(".mailbox-list").getByText(mailboxAddress, { exact: true })).toBeVisible();
    if (signature) { await page.keyboard.press("Tab"); await page.locator(".settings-form > label > textarea").focus(); }
    await page.screenshot({ path: `${output}/${surface}-${locale}-${state}-${size}.png`, fullPage: true });
    await assertFormContainment(test, size);
    const report = await page.locator("main").evaluate((main, { signature, unknown }) => {
      const errors = [], count = { lists: 0, checks: 0, signatures: 0, actions: 0 };
      const token = (property, name) => { const probe = document.createElement("span"); probe.style.setProperty(property, `var(${name})`); main.append(probe); const value = getComputedStyle(probe).getPropertyValue(property); probe.remove(); return value; };
      const contained = (child, parent) => { const a=child.getBoundingClientRect(),b=parent.getBoundingClientRect(); return a.width>0 && a.height>0 && a.left>=b.left-1 && a.right<=b.right+1; };
      for (const list of main.querySelectorAll(".mailbox-list")) {
        count.lists++; if (list.getAttribute("role")!=="list" || getComputedStyle(list).listStyleType!=="none" || !list.children.length) errors.push("mailbox list semantics/reset");
        for(const row of list.children) for(const child of row.children) if(!contained(child,row)||!contained(child,list)||child.scrollWidth>child.clientWidth+1)errors.push("mailbox row/button/status clipping");
      }
      for (const input of main.querySelectorAll('input[type="checkbox"]')) {
        if (!input.getClientRects().length) continue; count.checks++;
        const label=input.closest("label"),r=input.getBoundingClientRect(),s=getComputedStyle(input),l=getComputedStyle(label);
        if(r.width<12||r.width>24||r.height<12||r.height>24||!contained(input,label)||l.display!=="flex"||l.flexDirection!=="row"||label.getBoundingClientRect().height<43||s.accentColor!==token("color","--accent")) errors.push("native checkbox row/size/accent/target");
      }
      for(const textarea of main.querySelectorAll(".settings-form > label > textarea")) {
        count.signatures++;const s=getComputedStyle(textarea);
        if(s.backgroundColor!==token("background-color","--surface-2")||s.borderTopColor!==token("color","--border")||s.borderTopStyle!=="solid"||s.borderTopLeftRadius!==token("border-top-left-radius","--wx-radius-control")||s.paddingInlineStart!==token("padding-inline-start","--wx-space-3")||s.resize!=="vertical"||!contained(textarea,textarea.closest("label")))errors.push("signature token controls");
        if(signature && (document.activeElement!==textarea || !textarea.matches(":focus-visible") || s.outlineStyle!=="solid" || parseFloat(s.outlineWidth)<2))errors.push("signature keyboard focus");
      }
      for(const group of main.querySelectorAll(".settings-actions")) {
        count.actions++;if(getComputedStyle(group).flexWrap!=="wrap")errors.push("action wrapping contract");
        if(unknown && group.querySelectorAll("button").length!==4)errors.push("UNKNOWN must expose exactly four actions");
        for(const button of group.querySelectorAll("button")) if(!contained(button,group)||!contained(button,group.closest(".panel")))errors.push("action containment");
      }
      if(!count.lists || (signature&&(!count.signatures||!count.checks)) || (unknown&&!count.actions))errors.push("required populated state absent");
      return {errors,count};
    }, { signature, unknown });
    assert.deepEqual(report.errors, [], `${surface}/${locale}/${state}/${size}: selector coherence`);
  }
  await page.setViewportSize({ width:1440, height:1000 });
}
async function assertReauthBox(link) {
  await link.page().keyboard.press("Tab"); await link.focus();
  assert.equal(await link.evaluate(element => { const s=getComputedStyle(element),r=element.getBoundingClientRect(); return element.tagName==="A" && ["inline-flex","flex"].includes(s.display) && r.height>=34 && element.matches(":focus-visible"); }), true, "Reauthentication keeps link semantics with a real focusable button box");
}

async function assertPrivateStorage(test, key, allowedKeys) {
  const raw = await test.page.evaluate(key => sessionStorage.getItem(key), key);
  assert.ok(raw, "Recovery metadata is persisted before dispatch");
  const metadata = JSON.parse(raw);
  assert.deepEqual(Object.keys(metadata).sort(), allowedKeys.slice().sort());
  for (const value of Object.values(syntheticCredentials)) assert.ok(!raw.includes(value));
  assert.ok(!raw.includes("example.invalid") && !raw.includes("Synthetic") && !raw.includes("private"));
}
async function focusCheck(test, operation) {
  const response = test.page.waitForResponse(response => response.url().endsWith("/api/inbox") && response.request().postDataJSON()?.operation === operation);
  await test.page.evaluate(() => window.dispatchEvent(new Event("focus"))); await response;
}
async function startVerification(test, action = "mailboxes.verify") {
  await test.button(action).click();
  // Disabled Verify alone also means the write is still busy. Signature is enabled
  // only after the receipt and follow-up LIST/SHOW have settled with a clean draft.
  await expect(test.button("mailboxes.signature")).toBeEnabled();
  await expect(test.button("mailboxes.verify")).toBeDisabled();
  // Let the re-enabled refresh effect install its focus listener before the event.
  await test.page.evaluate(() => new Promise(requestAnimationFrame));
}
async function quotaFailure(page, prefix, action) {
  await page.evaluate(prefix => {
    const original = Storage.prototype.setItem;
    window.restoreAdminStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key, value) { if (key.startsWith(prefix)) throw new DOMException("Synthetic quota", "QuotaExceededError"); return original.call(this, key, value); };
  }, prefix);
  try { await action(); } finally { await page.evaluate(() => window.restoreAdminStorage()); }
}

async function teamsListRecovery(locale) {
  for (const [size, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]]) {
    const test = await setup("teams", locale, fixture => { fixture.control.failRead = "TEAM_LIST"; }, { width, height });
    const { page, fixture, t, button } = test;
    const empty = page.getByText(t("teamsAdmin.empty"), { exact: true });
    const choose = page.getByText(t("teamsAdmin.choose"), { exact: true });
    const team = page.getByRole("button", { name: /Synthetic customer support/u });
    const capture = async state => {
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: `${output}/teams-${locale}-list-${state}-${size}.png`, fullPage: true });
    };
    await expect(page.getByRole("alert")).toHaveText(t("teamsAdmin.listFailed"));
    await expect(button("common.actions.retry")).toBeEnabled();
    await expect(button("teamsAdmin.createTeam")).toHaveCount(0);
    await expect(empty).toHaveCount(0);
    await expect(choose).toHaveCount(0);
    assert.ok(await page.evaluate(() => { const alert = document.querySelector(".settings-feedback.error"); return alert.parentElement.getBoundingClientRect().bottom - alert.getBoundingClientRect().bottom >= 12; }), "the load-failure alert touches the bottom of its card");
    await capture("failed");

    await button("common.actions.retry").click();
    await expect(team).toBeVisible();
    await expect(choose).toBeVisible();
    await expect(button("teamsAdmin.createTeam")).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(empty).toHaveCount(0);
    await capture("retried-populated");

    fixture.teams.length = 0;
    await test.open();
    await expect(empty).toBeVisible();
    await expect(choose).toHaveCount(0);
    await expect(button("teamsAdmin.createTeam")).toBeEnabled();
    await expect(team).toHaveCount(0);
    await expect(button("common.actions.retry")).toHaveCount(0);
    await capture("empty");
    await trace.closeContext(test.context);
  }
}

async function teamsJourney(locale) {
  const test = await setup("teams", locale), { page, fixture, t, button } = test;
  const storageKey = "wasalx:team-operation:storybook:synthetic-admin-teams";
  try {
    await expect(page.getByRole("heading", { name: t("teamsAdmin.title"), exact: true })).toBeVisible();
    await button("teamsAdmin.createTeam").focus(); await page.keyboard.press("Enter");
    const name = page.getByLabel(t("teamsAdmin.name"), { exact: true }), note = page.getByLabel(t("teamsAdmin.note"), { exact: true });
    await name.focus(); await page.keyboard.type("Synthetic delivery team"); await page.keyboard.press("Tab"); await expect(note).toBeFocused();
    await note.fill("Synthetic private team description");
    await quotaFailure(page, "wasalx:team-operation:", async () => {
      await button("teamsAdmin.save").click(); await expect(page.getByRole("alert")).toContainText(t("teamsAdmin.storage")); assert.equal(fixture.writes.length, 0);
    });
    await expect(note).toHaveValue("Synthetic private team description");
    fixture.control.loseCommit = "TEAM_CREATE";
    await button("teamsAdmin.save").click(); await expect(button("teamsAdmin.check")).toBeVisible();
    await assertPrivateStorage(test, storageKey, ["kind", "operation_id"]);
    assert.equal(fixture.writes.filter(row => row.operation === "TEAM_CREATE").length, 1);
    await expect(button("teamsAdmin.check")).toBeEnabled();
    await page.reload({ waitUntil: "networkidle" }); await button("teamsAdmin.check").click();
    await expect(name).toHaveValue("Synthetic delivery team"); await expect(note).toHaveValue("Synthetic private team description");
    assert.equal(fixture.writes.filter(row => row.operation === "TEAM_CREATE").length, 1);
    await button("teamsAdmin.more").click(); await expect(page.getByRole("button", { name: /Synthetic delivery team/u })).toBeVisible();
    const member = page.getByRole("group", { name: "Synthetic agent", exact: true });
    await expect(member).toContainText(t("teamsAdmin.read"));
    await note.fill("Preserve private unsaved team description during grant save");
    await member.getByRole("checkbox", { name: t("teamsAdmin.create"), exact: true }).check();
    await member.getByRole("button", { name: t("teamsAdmin.saveAccess"), exact: true }).click();
    await expect(note).toHaveValue("Preserve private unsaved team description during grant save");
    await expect(member.getByRole("checkbox", { name: t("teamsAdmin.create"), exact: true })).toBeChecked();
    await button("teamsAdmin.moreMembers").click();
    await expect(page.getByRole("group", { name: "Synthetic inherited observer", exact: true }).getByRole("checkbox", { name: t("teamsAdmin.full"), exact: true })).toBeDisabled();
    fixture.control.reject = "TEAM_SAVE";
    await button("teamsAdmin.save").click(); await expect(button("teamsAdmin.check")).toBeVisible();
    await button("teamsAdmin.check").click(); await expect(button("teamsAdmin.check")).toBeVisible();
    await button("teamsAdmin.cancelMissing").click(); await expect(button("teamsAdmin.check")).toHaveCount(0);
    await expect(note).toHaveValue("Preserve private unsaved team description during grant save");
    await button("teamsAdmin.save").click(); await expect(page.getByRole("status")).toContainText(t("teamsAdmin.saved"));
    await expect(button("teamsAdmin.createTeam")).toBeEnabled();
    await page.reload({ waitUntil: "networkidle" }); await button("teamsAdmin.more").click();
    await page.getByRole("button", { name: /Synthetic delivery team/u }).click();
    await expect(note).toHaveValue("Preserve private unsaved team description during grant save");
    fixture.control.failRead = "TEAM_LIST"; await note.fill("Preserve draft during a temporary check failure"); await focusCheck(test, "TEAM_LIST");
    await expect(note).toHaveValue("Preserve draft during a temporary check failure");
    await button("teamsAdmin.save").click(); await expect(page.getByRole("status")).toContainText(t("teamsAdmin.saved"));
    await captureAndAudit(test, "saved");
    for(const checkbox of await page.getByRole("checkbox").all()) {
      const native = await checkbox.evaluate(input => { const label=input.closest("label"),r=input.getBoundingClientRect(); const probe=document.createElement("span");probe.style.color="var(--accent)";label.append(probe);const accent=getComputedStyle(probe).color;probe.remove();return r.width>=12&&r.width<=24&&r.height>=12&&r.height<=24&&label.getBoundingClientRect().height>=43&&getComputedStyle(input).accentColor===accent; });
      assert.equal(native,true,"Grant checkboxes retain native sizing and module-owned label targets");
    }
    // Reauthentication preserves the draft and uses the existing privileged entry point.
    await note.fill("Preserve draft during privileged reauthentication");
    await member.getByRole("checkbox", { name: t("teamsAdmin.change"), exact: true }).check(); fixture.control.reauth = "TEAM_GRANT_SAVE";
    await member.getByRole("button", { name: t("teamsAdmin.saveAccess"), exact: true }).click();
    await expect(note).toHaveValue("Preserve draft during privileged reauthentication");
    await expect(page.getByRole("link", { name: t("tenant.privacy.action.reauthenticate"), exact: true })).toHaveAttribute("href", /step_up=privileged/u);
    await assertReauthBox(page.getByRole("link", { name: t("tenant.privacy.action.reauthenticate"), exact: true }));
    // Native grant controls retain the module-owned 44px label layout.
    const grantStyle = await member.evaluate(fieldset => { const probe=document.createElement("span");probe.style.borderRadius="var(--wx-radius-control)";fieldset.append(probe);const radius=getComputedStyle(probe).borderTopLeftRadius;probe.remove();return {border:getComputedStyle(fieldset).borderTopStyle,radius:getComputedStyle(fieldset).borderTopLeftRadius,expectedRadius:radius}; });
    assert.equal(grantStyle.border, "solid"); assert.equal(grantStyle.radius,grantStyle.expectedRadius);
    await button("teamsAdmin.cancelMissing").click();
    await expect(page.getByRole("status").filter({ hasText: t("teamsAdmin.cancelled") })).toBeVisible();
    await expect(button("teamsAdmin.createTeam")).toBeEnabled();
    // Pending read after confirmed denial must never repopulate the old team's data.
    await page.reload({ waitUntil: "networkidle" });
    const held = fixture.hold("TEAM_SHOW", input => input.team_id === "2");
    await page.getByRole("button", { name: /Synthetic customer support/u }).click(); await expect.poll(() => fixture.control.gate).toBe(null);
    fixture.control.denied = true; await focusCheck(test, "TEAM_LIST");
    await expect(page.getByLabel(t("teamsAdmin.name"), { exact: true })).toHaveCount(0);
    const oldResponse = page.waitForResponse(response => response.request().postDataJSON()?.operation === "TEAM_SHOW"); held.release(); await oldResponse;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(page.getByLabel(t("teamsAdmin.name"), { exact: true })).toHaveCount(0);
    await expect(page.getByText("agent@example.invalid", { exact: true })).toHaveCount(0);
    assert.ok(!(await page.locator("body").innerText()).includes("SYNTHETIC_INTERNAL_FAILURE_MUST_NOT_RENDER"));
    fixture.control.denied = false; await button("common.actions.retry").click(); await expect(page.getByRole("button", { name: /Synthetic customer support/u })).toBeVisible();
    // Corrupt metadata remains present and blocks another UUID instead of being silently erased.
    await page.evaluate(key => sessionStorage.setItem(key, "{"), storageKey); await page.reload({ waitUntil: "networkidle" });
    await expect(button("teamsAdmin.createTeam")).toBeDisabled(); assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), "{");
    results.push({ surface: "teams", locale, mode: "simulated_bridge", evidence_scope: "exploratory_ui", status: "passed", writes: fixture.writes });
  } catch (failure) { results.push({ surface: "teams", locale, mode: "simulated_bridge", evidence_scope: "exploratory_ui", status: "failed", error_class: failure.name }); throw failure; }
  await trace.closeContext(test.context);
}

async function mailboxJourney(surface, locale) {
  const test = await setup(surface, locale), { page, fixture, t, button } = test;
  const storageKey = `wasalx:mailbox-operation:storybook:synthetic-admin-${surface}`;
  const label = key => key === "mailboxes.team" ? page.getByRole("combobox", { name: t(key), exact: true }) : page.getByLabel(t(key), { exact: true });
  const mailboxButton = email => page.getByRole("button", { name: new RegExp(`^${escaped(email)}\\s`) });
  try {
    await expect(page.getByRole("heading", { name: t("mailboxes.title"), exact: true })).toBeVisible();
    await mailboxButton("support@example.invalid").click();
    await expect(label("mailboxes.team")).toHaveValue("99");
    await expect(label("mailboxes.team").locator("option[value='99']")).toHaveText("Synthetic historical support");
    if (surface === "administration") { await button("teamsAdmin.more").click(); await expect(label("mailboxes.team").locator("option[value='9']")).toHaveText("Synthetic escalation"); }
    await button("mailboxes.create").focus(); await page.keyboard.press("Enter");
    await label("mailboxes.address").fill("qualification.delivery.mailbox.with.a.long.supported.name@example.invalid"); await label("mailboxes.name").fill("Synthetic delivery mailbox");
    await label("mailboxes.team").selectOption("2");
    for (const direction of ["inbound", "outbound"]) {
      const group = page.getByRole("group", { name: t(`mailboxes.${direction}`), exact: true });
      await group.getByLabel(t("mailboxes.host"), { exact: true }).fill(`${direction === "inbound" ? "imap" : "smtp"}.example.invalid`);
      await group.getByLabel(t("mailboxes.user"), { exact: true }).fill("qualification.delivery.mailbox.with.a.long.supported.name@example.invalid");
      await group.getByLabel(new RegExp(`^${escaped(t("mailboxes.password"))}`)).fill(syntheticCredentials[direction]);
    }
    fixture.control.loseCommit = "MAILBOX_CREATE";
    await button("mailboxes.saveDraft").click(); await expect(button("mailboxes.check")).toBeVisible();
    await assertPrivateStorage(test, storageKey, ["kind", "operation_id"]);
    for (const password of await page.locator('input[type="password"]').all()) await expect(password).toHaveValue("");
    assert.equal(fixture.writes.filter(row => row.operation === "MAILBOX_CREATE").length, 1);
    await expect(button("mailboxes.check")).toBeEnabled();
    await page.reload({ waitUntil: "networkidle" }); await button("mailboxes.check").click();
    await expect(label("mailboxes.address")).toHaveValue("qualification.delivery.mailbox.with.a.long.supported.name@example.invalid");
    await expect(button("mailboxes.activate")).toBeDisabled();
    await button("mailboxes.more").click(); await expect(mailboxButton("qualification.delivery.mailbox.with.a.long.supported.name@example.invalid")).toBeVisible();
    await captureCoherence(test, "long-list", { mailboxAddress: "qualification.delivery.mailbox.with.a.long.supported.name@example.invalid" });
    assert.equal(fixture.writes.filter(row => row.operation === "MAILBOX_CREATE").length, 1);
    await startVerification(test);
    await focusCheck(test, "MAILBOX_VERIFY_STATUS"); await expect(button("mailboxes.activate")).toBeEnabled();
    await button("mailboxes.activate").click(); await expect(button("mailboxes.pause")).toBeVisible();
    await expect(label("mailboxes.address")).toBeDisabled(); await button("mailboxes.pause").click();
    await expect(label("mailboxes.address")).toBeEnabled();
    await label("mailboxes.name").fill("Synthetic updated delivery mailbox with a long supported display name");
    await button("mailboxes.saveDraft").click(); await expect(button("mailboxes.activate")).toBeDisabled();
    await expect(page.getByRole("status").filter({ hasText: t("mailboxes.saved") })).toBeVisible();
    // Pause also shows Saved. Save draft is enabled again after the new operation settles.
    await expect(button("mailboxes.saveDraft")).toBeEnabled();
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), null, "Mailbox operation must settle before reload");
    await page.reload({ waitUntil: "networkidle" }); await button("mailboxes.more").click(); await mailboxButton("qualification.delivery.mailbox.with.a.long.supported.name@example.invalid").click();
    await expect(label("mailboxes.name")).toHaveValue("Synthetic updated delivery mailbox with a long supported display name");
    // Verification's unknown result is distinct from a lost operation response.
    fixture.control.verification = "UNKNOWN";
    await startVerification(test); await focusCheck(test, "MAILBOX_VERIFY_STATUS"); await expect(button("mailboxes.recheck")).toBeVisible();
    await expect(button("mailboxes.activate")).toBeDisabled();
    await captureCoherence(test, "verification-unknown", { unknown: true });
    fixture.control.verification = "VERIFIED";
    await startVerification(test, "mailboxes.recheck"); await focusCheck(test, "MAILBOX_VERIFY_STATUS"); await expect(button("mailboxes.activate")).toBeEnabled();
    await button("mailboxes.signature").click(); const signature = page.getByRole("textbox", { name: new RegExp(`^${escaped(t("mailboxes.signature"))}`) });
    await signature.fill("Synthetic plain team signature"); await expect(button("mailboxes.saveSignature")).toBeDisabled();
    await captureCoherence(test, "signature-unchecked", { signature: true });
    await page.getByRole("checkbox", { name: t("mailboxes.replaceFormatting"), exact: true }).check();
    await captureCoherence(test, "signature-replacement", { signature: true });
    fixture.control.loseCommit = "MAILBOX_SIGNATURE_SAVE";
    await button("mailboxes.saveSignature").click(); await expect(button("mailboxes.check")).toBeVisible();
    await assertPrivateStorage(test, storageKey, ["kind", "operation_id", "team_id"]);
    await expect(button("mailboxes.check")).toBeEnabled();
    await page.reload({ waitUntil: "networkidle" }); await button("mailboxes.check").click();
    await expect(signature).toHaveValue("Synthetic plain team signature"); await expect(label("mailboxes.address")).toHaveCount(0);
    await button("mailboxes.more").click(); await mailboxButton("qualification.delivery.mailbox.with.a.long.supported.name@example.invalid").click(); await button("mailboxes.signature").click();
    await expect(signature).toHaveValue("Synthetic plain team signature");
    fixture.control.failRead = "MAILBOX_LIST"; await label("mailboxes.name").fill("Private mailbox draft survives check outage"); await focusCheck(test, "MAILBOX_LIST");
    await expect(label("mailboxes.name")).toHaveValue("Private mailbox draft survives check outage");
    fixture.control.reject = "MAILBOX_SAVE";
    await button("mailboxes.saveDraft").click(); await expect(button("mailboxes.check")).toBeVisible();
    await button("mailboxes.check").click(); await expect(button("mailboxes.check")).toBeVisible();
    await button("mailboxes.cancelMissing").click(); await expect(button("mailboxes.check")).toHaveCount(0);
    await expect(label("mailboxes.name")).toHaveValue("Private mailbox draft survives check outage");
    await button("mailboxes.saveDraft").click(); await expect(page.getByRole("status").filter({ hasText: t("mailboxes.saved") })).toBeVisible();
    await expect(button("mailboxes.saveDraft")).toBeEnabled();
    await captureAndAudit(test, "paused");
    fixture.control.reauth = "MAILBOX_LIST"; await focusCheck(test, "MAILBOX_LIST");
    await assertReauthBox(page.getByRole("link", { name: t("tenant.privacy.action.reauthenticate"), exact: true }));
    // Initial setup prevents activation even with a previously verified configuration.
    fixture.mailboxes[0].verification = "VERIFIED"; fixture.mailboxes[0].verification_version = fixture.mailboxes[0].version;
    fixture.control.setupReady = false; fixture.control.canCreate = false;
    await page.reload({ waitUntil: "networkidle" }); await expect(button("mailboxes.create")).toBeDisabled();
    await expect(page.getByText(t("mailboxes.templateReview"), { exact: true })).toBeVisible();
    await mailboxButton("support@example.invalid").click(); await expect(button("mailboxes.activate")).toBeDisabled();
    fixture.control.setupReady = true; fixture.control.canCreate = true; await page.reload({ waitUntil: "networkidle" });
    await mailboxButton("support@example.invalid").click();
    // A stale signature response after a denial cannot restore an editor or private body.
    const held = fixture.hold("MAILBOX_SIGNATURE_SHOW"); await button("mailboxes.signature").click(); await expect.poll(() => fixture.control.gate).toBe(null);
    fixture.control.denied = true; await focusCheck(test, "MAILBOX_LIST");
    await expect(label("mailboxes.address")).toHaveCount(0);
    const oldResponse = page.waitForResponse(response => response.request().postDataJSON()?.operation === "MAILBOX_SIGNATURE_SHOW"); held.release(); await oldResponse;
    await page.evaluate(() => new Promise(requestAnimationFrame)); await expect(signature).toHaveCount(0);
    await expect(page.getByText("Synthetic legacy signature", { exact: true })).toHaveCount(0);
    for (const secret of Object.values(syntheticCredentials)) assert.ok(!(await page.locator("body").innerText()).includes(secret));
    assert.ok(!(await page.locator("body").innerText()).includes("SYNTHETIC_INTERNAL_FAILURE_MUST_NOT_RENDER"));
    fixture.control.denied = false; await button("common.actions.retry").first().click(); await expect(mailboxButton("support@example.invalid")).toBeVisible();
    await page.evaluate(key => sessionStorage.setItem(key, "{"), storageKey); await page.reload({ waitUntil: "networkidle" });
    await expect(button("mailboxes.create")).toBeDisabled(); assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), "{");
    results.push({ surface, locale, mode: "simulated_bridge", evidence_scope: "exploratory_ui", status: "passed", writes: fixture.writes });
  } catch (failure) { results.push({ surface, locale, mode: "simulated_bridge", evidence_scope: "exploratory_ui", status: "failed", error_class: failure.name }); throw failure; }
  await trace.closeContext(test.context);
}

try {
  for (const locale of ["en", "ar"]) {
    await teamsListRecovery(locale);
    await teamsJourney(locale);
    for (const surface of ["settings", "administration"]) await mailboxJourney(surface, locale);
  }
  console.log("Synthetic administration component journeys passed for both locales; provider/native qualification remains separate.");
} catch (error) {
  await trace.retainFailure();
  throw error;
} finally {
  await browser.close();
  await writeFile(`${output}/synthetic-ui-results.json`, JSON.stringify({ mode: "simulated_bridge", evidence_scope: "exploratory_ui", cases: results }, null, 2));
}
