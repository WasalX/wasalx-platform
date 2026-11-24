import { expect, type Page, type TestInfo } from "@playwright/test";

export async function captureTenantDesign(
  page: Page, testInfo: TestInfo, locale: "en" | "ar", open: (page: Page, view: string) => Promise<void>,
) {
  await open(page, "overview");
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => localStorage.setItem("wasalx.theme", value), theme);
    for (const view of ["overview", "inbox", "cases", "settings", "groups"]) {
      await open(page, view);
      await expect(page.locator('[data-application-ready="true"]')).toHaveClass(`theme-${theme}`);
      const screen = view === "overview" ? "shell" : view;
      await testInfo.attach(`${screen}-${locale}-${testInfo.project.name}-${theme}`, {
        body: await page.screenshot({ animations: "disabled" }), contentType: "image/png",
      });
    }
  }
}
