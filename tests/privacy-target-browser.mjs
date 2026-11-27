// Synthetic browser proof only; native lookup policy and privacy execution require their own application-stack evidence.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { getMessages } from "../lib/i18n/messages/index.ts";

const base = process.env.WASALX_STORYBOOK_URL ?? "http://127.0.0.1:6227";
const output = process.env.WASALX_SYNTHETIC_UI_OUTPUT ?? "output/playwright/inbox";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.WASALX_VISUAL_BROWSER_PATH ? { executablePath: process.env.WASALX_VISUAL_BROWSER_PATH } : {}), headless: true });
try {
  for (const [locale, width] of [["en", 1440], ["ar", 390]]) {
    const t = key => getMessages(locale)[key];
    for (const kind of ["export", "hold", "delete"]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } }), page = await context.newPage();
      let stale = false, holdBlocked = false, deny = false, malformed = false, releaseOld, enteredOld, finishOld;
      const oldFinished = new Promise(resolve => { finishOld = resolve; });
      const mutations = [];
      await page.route("**/api/privacy/target", async route => {
        const input = route.request().postDataJSON();
        if (deny) return route.fulfill({ status: 403, json: { code: "FORBIDDEN" } });
        if (input.scopeValue === "99999") return route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
        const held = input.scopeValue === "1042" && enteredOld;
        if (held) { enteredOld(); await new Promise(resolve => { releaseOld = resolve; }); }
        const customer = input.scopeType === "ZAMMAD_USER";
        await route.fulfill({ status: 200, json: { scope_type: input.scopeType,
          display: customer ? "Synthetic customer · customer@example.invalid" : `#${input.scopeValue.replace(/^#/u, "")} · Delivery request`,
          selection_sha256: (customer ? "c" : input.scopeValue === "1042" ? "a" : "b").repeat(64) } }).catch(() => undefined);
        if (held) finishOld();
      });
      await page.route(/\/api\/privacy\/(holds|requests)$/u, route => {
        mutations.push(route.request().postDataJSON());
        return malformed ? route.fulfill({ status: 202, json: {} }) : stale ? route.fulfill({ status: 409, json: { code: "CONFLICT" } })
          : holdBlocked ? route.fulfill({ status: 409, json: { error: "An active legal hold blocks this deletion scope", code: "LEGAL_HOLD_ACTIVE" } })
          : route.fulfill({ status: kind === "hold" ? 201 : 202, json: { id: "10000000-0000-4000-8000-000000000001", state: kind === "hold" ? "ACTIVE" : "QUEUED" } });
      });
      await page.route("**/api/privacy/receipt", route => route.fulfill({ status: 200, json: malformed
        ? { state: "APPLIED", id: "10000000-0000-4000-8000-000000000001" }
        : { state: "NOT_APPLIED", terminal: true, effect: "NONE" } }));
      const story = kind === "export" ? locale === "ar" ? "arabic" : "english" : `${kind}-${locale === "ar" ? "arabic" : "english"}`;
      await page.goto(`${base}/iframe.html?id=product-privacy-targets--${story}&viewMode=story`);
      const dialog = page.getByRole("dialog"), scope = dialog.getByRole("combobox");
      const readback = dialog.locator(".privacy-target-readback");
      const submit = dialog.locator('button[type="submit"], .modal-actions button').last();
      await scope.selectOption("ZAMMAD_TICKET");
      const input = dialog.getByLabel(t("tenant.privacy.target.caseNumber"));
      if (kind === "hold") await dialog.getByLabel(t("tenant.privacy.table.reason")).fill("Synthetic preservation reason");
      const confirm = async () => { if (kind === "delete") await dialog.locator(".privacy-confirm-input input").fill("DELETE"); };
      await input.fill("#1042"); await confirm(); await expect(submit).toBeDisabled();
      const check = dialog.getByRole("button", { name: t("tenant.privacy.target.checkCase"), exact: true });
      const entered = new Promise(resolve => { enteredOld = resolve; });
      await check.click(); await entered;
      await input.fill("1043"); enteredOld = null;
      await check.click(); await expect(readback).toContainText("#1043");
      releaseOld(); await oldFinished; await page.evaluate(() => new Promise(requestAnimationFrame));
      await expect(readback).not.toContainText("#1042");
      await confirm();
      if (kind === "delete") { // A hold refusal names the hold and keeps the checked target.
        holdBlocked = true; await submit.click();
        await expect(dialog.getByRole("alert")).toContainText(t("tenant.privacy.error.holdBlocksDeletion"));
        await expect(dialog.getByRole("alert")).not.toContainText(t("tenant.privacy.target.stale"));
        await expect(readback).toContainText("#1043");
        holdBlocked = false;
        await dialog.getByRole("button", { name: t("tenant.privacy.recovery.cancel"), exact: true }).click();
        await expect(readback).toContainText("#1043"); await expect(submit).toBeEnabled();
      }
      stale = true; await submit.click();
      await expect(dialog.getByRole("alert")).toContainText(t("tenant.privacy.target.stale"));
      await expect(readback).toHaveCount(0); await expect(submit).toBeDisabled();
      await dialog.getByRole("button", { name: t("tenant.privacy.recovery.cancel"), exact: true }).click();
      await check.click(); await expect(readback).toContainText("#1043");
      deny = true; await check.click(); await expect(readback).toHaveCount(0); await expect(submit).toBeDisabled();
      deny = false; await input.fill("99999"); await check.click();
      await expect(dialog.getByRole("alert")).toContainText(t("tenant.privacy.target.notFound"));
      await input.fill("1043"); await check.click(); await expect(readback).toContainText("#1043");
      await scope.selectOption("ZAMMAD_USER");
      const email = dialog.getByLabel(t("tenant.privacy.target.customerEmail"));
      await expect(email).toHaveValue(""); await expect(readback).toHaveCount(0); await expect(submit).toBeDisabled();
      await email.fill("customer@example.invalid"); await dialog.getByRole("button", { name: t("tenant.privacy.target.checkCustomer"), exact: true }).click();
      await expect(readback).toContainText("Synthetic customer");
      await confirm();
      await email.focus(); await page.keyboard.press("Tab");
      assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true);
      const axe = await new AxeBuilder({ page }).include("dialog").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      assert.deepEqual(axe.violations.map(row => ({ id: row.id, nodes: row.nodes.map(node => node.target) })), []);
      assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
      if (locale === "ar") assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[dir="rtl"] *:not(code)')].filter(node => !["normal", "0px"].includes(getComputedStyle(node).letterSpacing)).map(node => node.className)), []);
      await page.screenshot({ path: `${output}/privacy-${kind}-${locale}.png`, fullPage: true });
      stale = false; malformed = true; await submit.click();
      await expect(dialog.getByRole("alert")).toContainText(t("tenant.privacy.recovery.unknown"));
      await expect(submit).toBeDisabled();
      const stored = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith("wasalx:privacy-submission:v1:")).map(([,value]) => JSON.parse(value)));
      assert.equal(stored.length, 1); assert.deepEqual(Object.keys(stored[0]).sort(), ["kind", "operationId"]);
      const count = mutations.length;
      await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
      await page.reload(); await expect(dialog).toHaveCount(1); await expect(submit).toBeDisabled();
      await dialog.getByRole("button", { name: t("tenant.privacy.recovery.check"), exact: true }).click();
      await expect(dialog).toHaveCount(0); assert.equal(mutations.length, count);
      await expect(page.getByRole("status")).toContainText(t("tenant.privacy.recovery.confirmed"));
      const body = mutations.at(-1);
      assert.equal(body.scopeType, "ZAMMAD_USER"); assert.equal(body.scopeValue, "customer@example.invalid"); assert.equal(body.selection_sha256, "c".repeat(64));
      assert.ok(!("internal_id" in body));
      await context.close();
    }
  }
  console.log("Synthetic privacy dialogs: EN desktop / AR mobile; stale lookup, denial, readback/hash, submit, keyboard and Axe checks passed.");
} finally { await browser.close(); }
