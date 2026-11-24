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
      nodes: nodes.map(({ target, html, any }) => {
        const size = id === "target-size" ? any.find((check) => check.id === "target-size")?.data : undefined;
        return { target, html, ...(size && { box: { width: size.width, height: size.height } }) };
      }),
    })),
    "axe must find no WCAG A/AA violations",
  ).toEqual([]);
}
