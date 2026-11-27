import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";
import { languageTag, supportedLocales, textDirection } from "../../lib/i18n/locales.ts";
import { englishTenantMessages as en } from "../../lib/i18n/messages/en/tenant.ts";
import { arabicTenantMessages as ar } from "../../lib/i18n/messages/ar/tenant.ts";
import type { MetaSignupAttemptView } from "../../lib/meta-signup-contract.ts";

const { entries } = JSON.parse(readFileSync("storybook-static/index.json", "utf8")) as {
  entries: Record<string, { type: "story" | "docs"; title: string }>;
};
const stories = Object.entries(entries).filter(([, entry]) => entry.type === "story");
assert(stories.length > 0, "Storybook's static index contains no stories");

const rtlBaselineStories = new Set([
  "design-system-foundation--light-tokens",
  "design-system-foundation--theme-parity",
  "product-platform-operations--arabic",
  "product-privacy-targets--arabic",
]);
for (const storyId of rtlBaselineStories) {
  assert(entries[storyId]?.type === "story", `Missing RTL baseline story: ${storyId}`);
}

const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectMetaSignupLayout(signup: Locator, viewport: "desktop" | "phone", readinessCount = 0) {
  const layout = await signup.evaluate(async section => {
    await document.fonts.ready;
    const prose = [...section.querySelectorAll("p")].map(paragraph => {
      // Measure one ch with the paragraph's actual font, including its fallback for the zero glyph.
      const ruler = document.createElement("span");
      ruler.style.cssText = "position:absolute;inline-size:1ch;visibility:hidden";
      paragraph.appendChild(ruler);
      const ch = ruler.getBoundingClientRect().width;
      ruler.remove();
      const { width, height } = paragraph.getBoundingClientRect();
      return { measure: width / ch, wraps: height > Number.parseFloat(getComputedStyle(paragraph).lineHeight) + 1 };
    });
    const pairs = [...section.querySelectorAll("dl > div")].map(row => {
      const label = row.querySelector("dt")!.getBoundingClientRect();
      const value = row.querySelector("dd")!.getBoundingClientRect();
      const { direction, columnGap } = getComputedStyle(row);
      const gap = direction === "rtl" ? label.left - value.right : value.left - label.right;
      return { gap, expectedGap: Number.parseFloat(columnGap), verticalOffset: Math.abs(label.top - value.top) };
    });
    return {
      prose, pairs,
      overflow: [document.documentElement, section, ...section.querySelectorAll("p, dl, dt, dd")]
        .some(element => element.scrollWidth > element.clientWidth + 1),
    };
  });
  expect(layout.overflow).toBe(false);
  expect(layout.prose.length).toBeGreaterThan(0);
  expect(layout.pairs).toHaveLength(readinessCount);
  for (const { measure } of layout.prose) expect(measure).toBeLessThanOrEqual(65);

  if (viewport === "phone") {
    expect(layout.prose.some(({ wraps }) => wraps)).toBe(true);
  } else {
    for (const { measure } of layout.prose) expect(measure).toBeGreaterThanOrEqual(45);
    for (const { gap, expectedGap, verticalOffset } of layout.pairs) {
      expect(Math.abs(gap - expectedGap)).toBeLessThanOrEqual(1);
      expect(verticalOffset).toBeLessThanOrEqual(1);
    }
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const locale of supportedLocales) {
    test.describe(`${theme} ${locale}`, () => {
      test.use({ colorScheme: theme, locale: languageTag(locale) });

      test.describe(() => {
        test.use({ locale: languageTag(locale === "ar" ? "en" : "ar") });
        for (const viewport of ["desktop", "phone"] as const) {
          test(`${viewport} Meta signup and number recovery are actionable`, async ({ page }, testInfo) => {
            const messages = locale === "ar" ? ar : en;
            const errors: string[] = [];
            page.on("pageerror", error => errors.push(error.message));
            if (viewport === "phone") await page.setViewportSize({ width: 390, height: 844 });
            await page.emulateMedia({ reducedMotion: "reduce" });
            await page.clock.setFixedTime(new Date("2026-10-17T16:00:00Z"));

            const sdk = { appId: "12345678", configId: "87654321", graphVersion: "v24.0" };
            const challenge = "S".repeat(43);
            const prepared: MetaSignupAttemptView = {
              purpose: "NEW_NUMBER", attemptId: "44000000-0000-4000-8000-000000000001", revision: 1,
              status: "AWAITING_AUTHORIZATION", nextAction: "AUTHORIZE", expiresAt: "2026-10-17T16:10:00Z",
              canCancel: true, canStartAgain: false, choices: [],
              readiness: { authorization: "PENDING", number: "PENDING", subscription: "PENDING", messaging: "UNKNOWN",
                payment: { requestedPayer: "CUSTOMER", status: "UNKNOWN", paymentMethodVerified: false } },
            };
            const recovery: MetaSignupAttemptView = {
              ...prepared, revision: 2, status: "OUTCOME_UNKNOWN", nextAction: "REVIEW_OUTCOME",
              reasonCode: "META_SIGNUP_CREDENTIAL_UNAVAILABLE", canCancel: false, canStartAgain: true,
            };
            let attempt: MetaSignupAttemptView | null = null;
            const discoveryBodies: unknown[] = [];
            const cancellationBodies: unknown[] = [];
            await page.route("https://connect.facebook.net/en_US/sdk.js", route => route.fulfill({
              contentType: "text/javascript",
              body: 'window.FB={init(){},login(callback){callback({authResponse:{code:"synthetic-code-once"}});}};',
            }));
            await page.route("**/api/connections/meta/signup/**", route => {
              const request = route.request();
              const path = new URL(request.url()).pathname.split("/signup/")[1];
              switch (`${request.method()} ${path}`) {
                case "GET capabilities": return route.fulfill({ json: { enabled: true, payerModes: ["CUSTOMER"], sdk } });
                case "GET attempts": return route.fulfill({ json: { attempt } });
                case `GET attempts/${prepared.attemptId}`: return route.fulfill({ json: attempt });
                case "POST attempts":
                  attempt = prepared;
                  return route.fulfill({ json: { ...attempt, challenge, sdk } });
                case `POST attempts/${prepared.attemptId}/exchange`:
                  attempt = recovery;
                  return route.fulfill({ json: attempt });
                case `POST attempts/${prepared.attemptId}/discover`:
                  discoveryBodies.push(request.postDataJSON());
                  if (discoveryBodies.length === 1) return route.abort();
                  attempt = { ...recovery, revision: 3, status: "NUMBER_REQUIRED", nextAction: "COMPLETE_META_SETUP",
                    reasonCode: "META_SIGNUP_NO_PHONE", canCancel: true, canStartAgain: false,
                    readiness: { ...recovery.readiness, authorization: "VERIFIED" } };
                  return route.fulfill({ json: attempt });
                case `POST attempts/${prepared.attemptId}/cancel`:
                  cancellationBodies.push(request.postDataJSON());
                  attempt = { ...prepared, revision: 4, status: "CANCELLED", nextAction: "START_AGAIN", canCancel: false, canStartAgain: true };
                  return route.fulfill({ json: attempt });
                default: return route.abort();
              }
            });

            const globals = `a11y.manual:!true;auditTheme:${theme};auditLocale:${locale}`;
            const response = await page.goto(`/iframe.html?${new URLSearchParams({ id: "product-meta-signup--english", viewMode: "story", globals })}`);
            expect(response?.ok()).toBe(true);
            expect(await page.evaluate(() => navigator.language.split("-")[0])).toBe(locale === "ar" ? "en" : "ar");
            const canvas = page.locator("#storybook-root > .wx-story-canvas");
            await expect(canvas).toHaveClass(new RegExp(`\\btheme-${theme}\\b`));
            const content = canvas.getByRole("main");
            await expect(content).toHaveAttribute("lang", locale);
            await expect(content).toHaveAttribute("dir", textDirection(locale));
            const signup = content.getByRole("region", { name: messages["tenant.metaSignup.title"], exact: true });
            const screenshot = async (state: "ready" | "recovery") => {
              await expectMetaSignupLayout(signup, viewport, state === "recovery" ? 5 : 0);
              return page.screenshot({ fullPage: true, animations: "disabled", caret: "hide", scale: "css" });
            };

            const prepare = signup.getByRole("button", { name: messages["tenant.metaSignup.prepare"], exact: true });
            await prepare.click();
            const connect = signup.getByRole("button", { name: messages["tenant.metaSignup.connect"], exact: true });
            await expect(connect).toBeEnabled();
            await expect(connect).toBeInViewport();
            const ready = await screenshot("ready");

            await connect.click();
            await expect(signup.getByText(messages["tenant.metaSignup.status.OUTCOME_UNKNOWN"], { exact: true })).toBeVisible();
            const numbersGuidance = signup.getByText(messages["tenant.metaSignup.recovery.checkNumbers"], { exact: true });
            const discover = signup.getByRole("button", { name: messages["tenant.metaSignup.discover"], exact: true });
            const refresh = signup.getByRole("button", { name: messages["tenant.metaSignup.refresh"], exact: true });
            const cancel = signup.getByRole("button", { name: messages["tenant.metaSignup.cancel"], exact: true });
            await expect(numbersGuidance).toBeVisible();
            await expect(discover).toBeEnabled();
            await expect(discover).toHaveClass(/\bprimary\b/u);
            if (viewport === "desktop") await expect(discover).toBeInViewport();
            await expect(discover).toHaveAccessibleDescription(messages["tenant.metaSignup.recovery.checkNumbers"]);
            await expect(prepare).toHaveClass(/\bsecondary\b/u);
            await expect(refresh).toHaveClass(/\bsecondary\b/u);
            await expect(cancel).toHaveCount(0);
            const recoverable = await screenshot("recovery");

            await discover.focus();
            await page.keyboard.press("Enter");
            await expect(signup.getByText(messages["tenant.metaSignup.recovery.checkStatus"], { exact: true })).toBeVisible();
            await expect(discover).toBeDisabled();
            await expect(refresh).toBeEnabled();
            await expect(refresh).toHaveClass(/\bprimary\b/u);
            await expect(refresh).toHaveAccessibleDescription(messages["tenant.metaSignup.recovery.checkStatus"]);
            const readback = page.waitForResponse(response => response.request().method() === "GET"
              && new URL(response.url()).pathname.endsWith("/attempts/" + prepared.attemptId));
            await refresh.focus();
            await page.keyboard.press("Enter");
            expect((await readback).ok()).toBe(true);
            await expect(numbersGuidance).toBeVisible();

            await discover.click();
            await expect(signup.getByText(messages["tenant.metaSignup.status.NUMBER_REQUIRED"], { exact: true })).toBeVisible();
            expect(discoveryBodies).toEqual([{ expectedRevision: recovery.revision }, { expectedRevision: recovery.revision }]);
            await expect(cancel).toBeEnabled();
            await cancel.focus();
            await page.keyboard.press("Enter");
            await expect(signup.getByText(messages["tenant.metaSignup.status.CANCELLED"], { exact: true })).toBeVisible();
            expect(cancellationBodies).toEqual([{ expectedRevision: 3 }]);
            expect(errors).toEqual([]);
            writeFileSync(testInfo.outputPath(`meta-signup-ready-${viewport}-${theme}-${locale}.png`), ready);
            writeFileSync(testInfo.outputPath(`meta-signup-recovery-${viewport}-${theme}-${locale}.png`), recoverable);
          });
        }
      });

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

          const screenshotOptions = {
            fullPage: true,
            animations: "disabled",
            caret: "hide",
            scale: "css",
          } as const;
          await page.screenshot({ ...screenshotOptions, path: testInfo.outputPath(storyId + ".png") });

          const { violations } = await new AxeBuilder({ page }).include("#storybook-root").withTags(wcagTags).analyze();
          const findings = violations.flatMap(violation =>
            violation.nodes.map(node => ({ rule: violation.id, target: node.target, detail: node.failureSummary })),
          );
          await expect(page.locator("body"), "Storybook reports a render failure").not.toHaveClass(/sb-show-(errordisplay|noproject|nopreview)/u);
          expect.soft(errors, "Uncaught errors during story render").toEqual([]);
          expect(findings, "Automated WCAG 2.2 AA violations").toEqual([]);
          if (locale === "ar" && rtlBaselineStories.has(storyId)) {
            await expect(page).toHaveScreenshot(`${storyId}-ar-${theme}.png`, {
              ...screenshotOptions,
              maxDiffPixels: 2,
            });
          }
        });
      }
    });
  }
}

// Synthetic browser fixtures only; never live Meta acceptance.
const arabicBrowser = test.extend({ locale: languageTag("ar") });
for (const theme of ["light", "dark"] as const) {
  for (const [viewport, initialLocale] of [["desktop", "en"], ["phone", "en"], ["desktop", "ar"], ["phone", "ar"]] as const) {
    const authorizationTest = initialLocale === "en" ? arabicBrowser : test;
    const fromArabic = initialLocale === "ar" ? " from Arabic" : "";
    authorizationTest(`a locale change keeps the Meta signup authorization running (${viewport}, ${theme})${fromArabic}`, async ({ page }, testInfo) => {
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
      const globals = `a11y.manual:!true;auditTheme:${theme};auditLocale:${initialLocale}`;
      await page.goto(`/iframe.html?${new URLSearchParams({ id: "product-meta-signup--english", viewMode: "story", globals })}`);
      const canvas = page.locator("#storybook-root > .wx-story-canvas");
      await expect(canvas).toHaveClass(new RegExp(`\\btheme-${theme}\\b`));
      const capturePending = async (locale: "en" | "ar") => {
        const content = canvas.getByRole("main");
        await expect(content).toHaveAttribute("lang", locale);
        await expect(content).toHaveAttribute("dir", textDirection(locale));
        const messages = locale === "ar" ? ar : en;
        await expect(content.getByRole("status")).toHaveText(messages["tenant.metaSignup.waiting"]);
        await expect(content.getByText(messages["tenant.metaSignup.status.AWAITING_AUTHORIZATION"], { exact: true })).toHaveCount(0);
        const continueInMeta = content.getByRole("button", { name: messages["tenant.metaSignup.connect"], exact: true });
        await expect(continueInMeta).toBeDisabled();
        await expect(continueInMeta).toHaveClass(/\bsecondary\b/u);
        await expect(content.getByRole("button", { name: messages["tenant.metaSignup.cancel"], exact: true })).toBeEnabled();
        await page.screenshot({
          path: testInfo.outputPath(`meta-signup-authorization-${viewport}-${theme}-${locale}.png`),
          fullPage: true,
          animations: "disabled",
          caret: "hide",
          scale: "css",
        });
        await expectMetaSignupLayout(content.getByRole("region", { name: (locale === "ar" ? ar : en)["tenant.metaSignup.title"], exact: true }), viewport);
      };

      const initial = initialLocale === "ar" ? ar : en;
      const otherLocale = initialLocale === "ar" ? "en" : "ar";
      expect(await page.evaluate(() => navigator.language.split("-")[0])).toBe(otherLocale);
      const content = canvas.getByRole("main");
      await expect(content).toHaveAttribute("lang", initialLocale);
      await content.getByRole("button", { name: initial["tenant.metaSignup.prepare"], exact: true }).click();
      const continueInMeta = content.getByRole("button", { name: initial["tenant.metaSignup.connect"], exact: true });
      const cancel = content.getByRole("button", { name: initial["tenant.metaSignup.cancel"], exact: true });
      await expect(content.getByRole("status")).toHaveText(initial["tenant.metaSignup.status.AWAITING_AUTHORIZATION"]);
      await expect(continueInMeta).toBeEnabled();
      await expect(continueInMeta).toHaveClass(/\bprimary\b/u);
      await expect(cancel).toBeEnabled();
      await page.screenshot({
        path: testInfo.outputPath(`meta-signup-authorization-ready-${viewport}-${theme}-${initialLocale}.png`),
        fullPage: true, animations: "disabled", caret: "hide", scale: "css",
      });

      await continueInMeta.focus();
      await page.keyboard.press("Enter");
      await capturePending(initialLocale);
      await expect(continueInMeta).toBeFocused();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await expect(cancel).toBeFocused();

      await page.getByRole("button", { name: "Synthetic locale change", exact: true }).click();
      // A restarted session would cancel the attempt, load again and fence the open popup callback.
      expect([...calls].sort()).toEqual(["GET attempts", "GET capabilities", "POST attempts"]);
      expect(await page.evaluate(() => (window as unknown as { metaSignupCallbacks: unknown[] }).metaSignupCallbacks.length)).toBe(1);
      await capturePending(otherLocale);

      await page.evaluate(() => (window as unknown as { metaSignupCallbacks: ((value: unknown) => void)[] }).metaSignupCallbacks[0]!({ authResponse: { code: "synthetic-code-once" } }));
      await expect.poll(() => calls.filter(call => call.endsWith("/exchange"))).toEqual([`POST attempts/${view.attemptId}/exchange`]);
      expect(errors).toEqual([]);
    });
  }
}
