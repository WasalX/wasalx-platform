import { expect, test, type Locator, type Page } from "@playwright/test";
import { getMessages } from "../../lib/i18n/messages";

export function registerOperationsScreenshots(locale: "en" | "ar") {
  const messages = getMessages(locale);
  const deliveryRow = (page: Page) => page.getByRole("row", { name: /Riyadh · Last mile/u });
  const screens = [
    {
      area: "workflow-automation",
      view: "automation",
      state: "edit",
      listReady: (page: Page) => page.locator("#bot-panel-flows .bot-version-list").getByRole("button", { name: /Customer care/u }),
      open: (page: Page) => page.getByRole("button", { name: messages["bot.flows.new"], exact: true }),
      detailReady: (page: Page) => page.getByLabel(messages["bot.canvas.minimap"], { exact: true }),
    },
    {
      area: "client-routing",
      view: "routing",
      state: "edit",
      listReady: (page: Page) => page.getByRole("region", { name: messages["routing.clients.tableLabel"], exact: true })
        .getByText("Acme Logistics", { exact: true }),
      open: (page: Page) => page.getByRole("button", { name: messages["routing.versions.new"], exact: true }),
      detailReady: (page: Page) => page.getByRole("heading", { name: messages["routing.editor.title"], exact: true }),
    },
    {
      area: "message-delivery",
      view: "deliveries",
      state: "detail",
      listReady: deliveryRow,
      open: (page: Page) => deliveryRow(page)
        .getByRole("button", { name: messages["tenant.deliveries.actions.inspect"], exact: true }),
      detailReady: (page: Page) => page.getByRole("dialog", { name: messages["tenant.deliveries.detail.title"], exact: true })
        .getByRole("heading", { name: messages["tenant.deliveries.detail.currentState"], exact: true }),
    },
  ];

  for (const screen of screens) {
    test(`Owner captures ${screen.area} in both themes`, async ({ page }, testInfo) => {
      const application = page.locator('[data-application-ready="true"]');
      for (const theme of ["dark", "light"] as const) {
        await page.goto(`/app?view=${screen.view}`);
        await expect(application).toHaveAttribute("data-locale", locale);
        if (theme === "light") {
          await page.getByRole("button", { name: messages["tenant.theme.switchLight"], exact: true }).click();
        }

        const capture = async (state: string, ready: Locator) => {
          await expect(ready).toBeVisible();
          await expect(application).toHaveCSS("color-scheme", theme);
          await page.screenshot({
            path: `output/playwright/workflow-routing-delivery/${screen.area}-${state}-${testInfo.project.name}-${theme}-${locale}.png`,
            fullPage: state !== "detail",
            animations: "disabled",
            caret: "hide",
            scale: "css",
          });
        };
        await capture("list", screen.listReady(page));
        await screen.open(page).click();
        await capture(screen.state, screen.detailReady(page));
      }
    });
  }
}
