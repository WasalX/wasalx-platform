import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { languageTag, supportedLocales, textDirection } from "../../lib/i18n/locales.ts";
import { englishTenantMessages as en } from "../../lib/i18n/messages/en/tenant.ts";
import { arabicTenantMessages as ar } from "../../lib/i18n/messages/ar/tenant.ts";

const { entries } = JSON.parse(readFileSync("storybook-static/index.json", "utf8")) as {
  entries: Record<string, { type: "story" | "docs"; title: string }>;
};
const stories = Object.entries(entries).filter(([, entry]) => entry.type === "story");
assert(stories.length > 0, "Storybook's static index contains no stories");

const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

for (const theme of ["light", "dark"] as const) {
  for (const locale of supportedLocales) {
    test.describe(`${theme} ${locale}`, () => {
      test.use({ colorScheme: theme, locale: languageTag(locale) });

      for (const [storyId, entry] of stories) {
        test(storyId, async ({ page }, testInfo) => {
          const errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.clock.setFixedTime(new Date("2026-10-17T16:00:00Z"));
          const globals = `a11y.manual:!true;auditTheme:${theme};auditLocale:${locale}`;
          const response = await page.goto(`/iframe.html?${new URLSearchParams({ id: storyId, viewMode: "story", globals })}`);
          expect(response?.ok(), "Storybook iframe responds successfully").toBe(true);

          const canvas = page.locator("#storybook-root > .wx-story-canvas");
          await expect(canvas.locator(":scope > *").first()).toBeVisible();
          await expect(canvas).toHaveClass(new RegExp(`\\btheme-${theme}\\b`));
          await expect(canvas).toHaveAttribute("dir", textDirection(locale));
          if (entry.title.startsWith("Product/")) {
            await expect(canvas).toHaveAttribute("lang", locale);
            const content = canvas.locator(`[lang="${locale}"][dir="${textDirection(locale)}"]`).first();
            await expect(content).toBeVisible();
            if (storyId.startsWith("product-platform-operations--")) {
              await expect(content).toHaveClass(new RegExp(`\\btheme-${theme}\\b`));
            }
          }

          await page.screenshot({
            path: testInfo.outputPath(storyId + ".png"),
            fullPage: true,
            animations: "disabled",
            caret: "hide",
            scale: "css",
          });

          const { violations } = await new AxeBuilder({ page }).include("#storybook-root").withTags(wcagTags).analyze();
          const findings = violations.flatMap(violation =>
            violation.nodes.map(node => ({ rule: violation.id, target: node.target, detail: node.failureSummary })),
          );
          await expect(page.locator("body"), "Storybook reports a render failure").not.toHaveClass(/sb-show-(errordisplay|noproject|nopreview)/u);
          expect.soft(errors, "Uncaught errors during story render").toEqual([]);
          expect(findings, "Automated WCAG 2.2 AA violations").toEqual([]);
        });
      }
    });
  }
}

// Synthetic browser fixtures only; never live Meta acceptance.
for (const theme of ["light", "dark"] as const) {
  for (const viewport of ["desktop", "phone"] as const) {
    test(`a locale change keeps the Meta signup authorization running (${viewport}, ${theme})`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      if (viewport === "phone") await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.clock.setFixedTime(new Date("2026-10-17T16:00:00Z"));
      const sdk = { appId: "12345678", configId: "87654321", graphVersion: "v24.0" };
      const view = { purpose: "NEW_NUMBER", attemptId: "44000000-0000-4000-8000-000000000001", revision: 1, status: "AWAITING_AUTHORIZATION",
        nextAction: "AUTHORIZE", expiresAt: "2026-10-17T16:10:00Z", canCancel: true, canStartAgain: false, choices: [],
        readiness: { authorization: "PENDING", number: "PENDING", subscription: "PENDING", messaging: "UNKNOWN",
          payment: { requestedPayer: "CUSTOMER", status: "UNKNOWN", paymentMethodVerified: false } } };
      let started = false;
      const calls: string[] = [];
      await page.route("https://connect.facebook.net/en_US/sdk.js", route => route.fulfill({ contentType: "text/javascript", body:
        "window.metaSignupCallbacks=[];window.FB={init(){},login(callback){window.metaSignupCallbacks.push(callback);}};" }));
      await page.route("**/api/connections/meta/signup/**", route => {
        const path = new URL(route.request().url()).pathname.split("/signup/")[1];
        calls.push(`${route.request().method()} ${path}`);
        if (path === "capabilities") return route.fulfill({ json: { enabled: true, payerModes: ["CUSTOMER"], sdk } });
        if (route.request().method() === "GET") return route.fulfill({ json: path === "attempts" ? { attempt: started ? view : null } : view });
        if (path === "attempts") { started = true; return route.fulfill({ json: { ...view, challenge: "S".repeat(43), sdk } }); }
        return route.fulfill({ json: view });
      });
      const globals = `a11y.manual:!true;auditTheme:${theme};auditLocale:en`;
      await page.goto(`/iframe.html?${new URLSearchParams({ id: "product-meta-signup--english", viewMode: "story", globals })}`);
      const canvas = page.locator("#storybook-root > .wx-story-canvas");
      await expect(canvas).toHaveClass(new RegExp(`\\btheme-${theme}\\b`));
      const capturePending = async (locale: "en" | "ar") => {
        const content = canvas.getByRole("main");
        await expect(content).toHaveAttribute("lang", locale);
        await expect(content).toHaveAttribute("dir", textDirection(locale));
        await page.screenshot({
          path: testInfo.outputPath(`meta-signup-authorization-${viewport}-${theme}-${locale}.png`),
          fullPage: true,
          animations: "disabled",
          caret: "hide",
          scale: "css",
        });
      };

      await page.getByRole("button", { name: en["tenant.metaSignup.prepare"], exact: true }).click();
      await page.getByRole("button", { name: en["tenant.metaSignup.connect"], exact: true }).click();
      await expect(page.getByText(en["tenant.metaSignup.waiting"], { exact: true })).toBeVisible();
      await capturePending("en");

      await page.getByRole("button", { name: "Synthetic locale change", exact: true }).click();
      await expect(page.getByText(ar["tenant.metaSignup.waiting"], { exact: true })).toBeVisible();
      // A restarted session would cancel the attempt, load again and fence the open popup callback.
      expect([...calls].sort()).toEqual(["GET attempts", "GET capabilities", "POST attempts"]);
      expect(await page.evaluate(() => (window as unknown as { metaSignupCallbacks: unknown[] }).metaSignupCallbacks.length)).toBe(1);
      await capturePending("ar");

      await page.evaluate(() => (window as unknown as { metaSignupCallbacks: ((value: unknown) => void)[] }).metaSignupCallbacks[0]!({ authResponse: { code: "synthetic-code-once" } }));
      await expect.poll(() => calls.filter(call => call.endsWith("/exchange"))).toEqual([`POST attempts/${view.attemptId}/exchange`]);
      expect(errors).toEqual([]);
    });
  }
}
