import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export async function expectAxeClean(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations.map(({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      nodes: nodes.map(({ target, html, any }) => ({
        target,
        html,
        any: any.map(({ id, data }) => ({ id, data })),
      })),
    })),
    "axe must find no WCAG A/AA violations",
  ).toEqual([]);
}
