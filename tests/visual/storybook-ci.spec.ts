import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { languageTag, supportedLocales, textDirection } from "../../lib/i18n/locales.ts";

const { entries } = JSON.parse(readFileSync("storybook-static/index.json", "utf8")) as {
  entries: Record<string, { type: "story" | "docs"; title: string }>;
};
const stories = Object.entries(entries).filter(([, entry]) => entry.type === "story");
assert(stories.length > 0, "Storybook's static index contains no stories");

const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

for (const theme of ["light", "dark"] as const) {
  for (const locale of supportedLocales) {
    test.describe(`${theme} ${locale}`, () => {
      test.use({ colorScheme: theme, locale: languageTag(locale), reducedMotion: "reduce" });

      for (const [storyId, entry] of stories) {
        test(storyId, async ({ page }, testInfo) => {
          const errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
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
