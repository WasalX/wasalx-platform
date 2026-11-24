import { expect, type Page, type TestInfo } from "@playwright/test";
import { getMessages } from "../../lib/i18n/messages";

export async function captureTenantDesign(
  page: Page, testInfo: TestInfo, locale: "en" | "ar", open: (page: Page, view: string) => Promise<void>,
) {
  const messages = getMessages(locale);
  const ready = {
    inbox: page.getByRole("heading", { name: messages["inbox.empty"], exact: true }),
    cases: page.getByRole("row", { name: /1234567890.*10382/u }),
    settings: page.getByRole("tabpanel", { name: messages["tenant.settings.sections.general"], exact: true }),
    groups: page.getByRole("row").filter({ has: page.getByText("Riyadh \u00b7 Last mile", { exact: true }) }),
  };
  await open(page, "overview");
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => localStorage.setItem("wasalx.theme", value), theme);
    for (const view of ["overview", "inbox", "cases", "settings", "groups"] as const) {
      await open(page, view);
      if (view !== "overview") await expect(ready[view]).toBeVisible();
      if (view === "settings") {
        await expect(ready.settings.getByRole("textbox", { name: messages["tenant.settings.general.name"], exact: true })).toHaveValue("Northstar Logistics");
        await expect(page.getByText(messages["mailboxes.empty"], { exact: true })).toBeVisible();
      }
      await expect(page.locator('[data-application-ready="true"]')).toHaveClass(`theme-${theme}`);
      const screen = view === "overview" ? "shell" : view;
      await testInfo.attach(`${screen}-${locale}-${testInfo.project.name}-${theme}`, {
        body: await page.screenshot({ animations: "disabled" }), contentType: "image/png",
      });
    }
  }
}

export async function verifyRuleModalLabels(page: Page, testInfo: TestInfo, locale: "en" | "ar") {
  const messages: Readonly<Record<string, string>> = getMessages(locale);
  const t = (key: string) => messages[`tenant.rules.${key}`]!;
  await page.getByRole("button", { name: t("new") }).first().click();
  const dialog = page.getByRole("dialog", { name: t("modal.title"), exact: true });
  await expect(dialog).toHaveCSS("direction", locale === "ar" ? "rtl" : "ltr");
  for (const label of ["modal.name", "modal.matcherType", "teamPolicy", "modal.digitLength", "modal.representativeMessage"]) {
    await expect(dialog.getByLabel(t(label))).toBeVisible();
  }
  const matcher = dialog.getByRole("combobox", { name: t("modal.matcherType"), exact: true });
  await matcher.selectOption("prefix_length");
  await expect(dialog.getByRole("textbox", { name: t("modal.prefix"), exact: true })).toBeVisible();
  await matcher.selectOption("advanced");
  await expect(dialog.getByRole("textbox", { name: t("modal.safeExpression") })).toBeVisible();
  await dialog.getByRole("checkbox", { name: t("command.enable") }).check();
  await expect(dialog.getByRole("combobox", { name: t("command.action") })).toBeVisible();
  for (const label of ["modal.literalPattern", "command.inputKey", "command.inputValue", "command.successReply", "command.failureReply"]) {
    await expect(dialog.getByLabel(t(label))).toBeVisible();
  }
  await testInfo.attach(`rule-modal-${locale}-${testInfo.project.name}`, {
    body: await page.screenshot({ animations: "disabled" }), contentType: "image/png",
  });
}
