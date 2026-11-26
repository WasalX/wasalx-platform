import { expect, test } from "@playwright/test";
import { languageTag, type Locale } from "../../lib/i18n/locales.ts";
import { getMessages } from "../../lib/i18n/messages/index.ts";
import { createTranslator } from "../../lib/i18n/translate.ts";

const requestsPath = "/api/privacy/requests";
const holdsPath = "/api/privacy/holds";
const receiptPath = "/api/privacy/receipt";
const readyExport = `${requestsPath}/72000000-0000-4000-8000-000000000001`;
const failedExport = `${requestsPath}/72000000-0000-4000-8000-000000000003`;
const createdAt = "2026-11-25T22:15:00.000Z";
const uuid = /^[0-9a-f-]{36}$/u;

export function registerPrivacySettingsJourneys(locale: Locale, role: string) {
  const t = createTranslator(getMessages(locale));
  const canRead = ["tenant_owner", "tenant_admin", "auditor"].includes(role);
  const canExport = ["tenant_owner", "tenant_admin"].includes(role);
  const owner = role === "tenant_owner";

  test.describe("Privacy and retention", () => {
    test.beforeEach(async ({ page }) => {
      await page.clock.setFixedTime(new Date("2026-11-26T12:00:00.000Z"));
    });

    test("lists requests and holds with role-appropriate privacy access", async ({ page }) => {
      let empty = true;
      for (const path of [requestsPath, holdsPath]) {
        await page.route(`**${path}`, route => empty && route.request().method() === "GET"
          ? route.fulfill({ json: [] })
          : route.fallback());
      }

      await page.goto("/app?view=settings");
      await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
      const tab = page.getByRole("tab", { name: t("tenant.settings.sections.privacy"), exact: true });
      if (!canRead) {
        await expect(tab).toHaveCount(0);
        for (const path of [requestsPath, holdsPath]) {
          expect((await page.request.get(path)).status()).toBe(403);
        }
        return;
      }

      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      await tab.click();
      const panel = page.getByRole("tabpanel", { name: t("tenant.settings.sections.privacy") });
      await expect(panel.getByText(t("tenant.privacy.requests.emptyTitle"), { exact: true })).toBeVisible();
      await expect(panel.getByText(t("tenant.privacy.holds.emptyTitle"), { exact: true })).toBeVisible();
      empty = false;
      await page.reload();
      await tab.click();
      await expect(panel.getByRole("heading", { name: t("tenant.privacy.requests.title") })).toBeVisible();
      await expect(panel.getByRole("heading", { name: t("tenant.privacy.holds.title") })).toBeVisible();
      await expect(panel.getByRole("table")).toHaveCount(2);
      await expect(panel.getByRole("button", { name: t("tenant.privacy.action.requestExport"), exact: true })).toHaveCount(canExport ? 1 : 0);
      await expect(panel.getByRole("button", { name: t("tenant.privacy.action.requestDeletion"), exact: true })).toHaveCount(owner ? 1 : 0);
      await expect(panel.getByRole("button", { name: t("tenant.privacy.action.createHold") })).toHaveCount(owner ? 1 : 0);
      await expect(panel.getByRole("button", { name: t("tenant.privacy.action.release"), exact: true })).toHaveCount(owner ? 1 : 0);
      if (!canExport) {
        await expect(panel.getByRole("button", { name: t("tenant.privacy.action.download"), exact: true })).toHaveCount(0);
        await expect(panel.getByRole("button", { name: t("tenant.privacy.action.retry"), exact: true })).toHaveCount(0);
        await expect(panel.getByText("ABC1234567", { exact: true })).toHaveCount(0);
        expect((await page.request.post(requestsPath, { data: { requestType: "EXPORT", scopeType: "TENANT" } })).status()).toBe(403);
        return;
      }

      await page.route(`**${readyExport}`, async route => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...await response.json(), created_at: createdAt } });
      });
      const readyRow = panel.getByRole("row").filter({ hasText: "ABC1234567" });
      await readyRow.getByRole("button", { name: t("tenant.privacy.action.inspect"), exact: true }).click();
      const detail = page.getByRole("dialog", { name: t("tenant.privacy.detail.title") });
      const localTime = await page.evaluate(({ timestamp, language }) =>
        new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Riyadh" })
          .format(new Date(timestamp)), { timestamp: createdAt, language: languageTag(locale) });
      await expect(detail.getByText(localTime, { exact: true })).toBeVisible();
      await detail.getByRole("button", { name: t("tenant.privacy.action.close"), exact: true }).click();

      const download = page.waitForResponse(response => new URL(response.url()).pathname === `${readyExport}/download`);
      await readyRow.getByRole("button", { name: t("tenant.privacy.action.download"), exact: true }).click();
      const signedLink = await download;
      expect(signedLink.status()).toBe(200);
      expect(await signedLink.json()).toEqual({ url: expect.stringMatching(/^https:\/\//u), expiresIn: 300 });
      await expect(panel.getByText(t("tenant.privacy.download.previewVerified"), { exact: true })).toBeVisible();

      // The shared fixture server survives both viewport cases. Give each a fresh retry acknowledgement.
      await page.route(`**${failedExport}/retry`, route =>
        route.fulfill({ status: 202, json: { id: failedExport.split("/").at(-1), state: "QUEUED", duplicate: false } }));
      const failedRow = panel.getByRole("row").filter({ hasText: "12025550100" });
      await failedRow.getByRole("button", { name: t("tenant.privacy.action.retry"), exact: true }).click();
      const retry = page.waitForRequest(request => new URL(request.url()).pathname === `${failedExport}/retry`);
      await page.getByRole("dialog").getByRole("button", { name: t("tenant.privacy.action.retryRequest"), exact: true }).click();
      const retried = await retry;
      expect(retried.method()).toBe("POST");
      expect(retried.headers()["idempotency-key"]).toMatch(uuid);
      expect(retried.postDataJSON()).toEqual({});
      await expect(panel.getByText(t("tenant.privacy.notice.requestRetried"), { exact: true })).toBeVisible();
      await expect(failedRow.getByRole("button", { name: t("tenant.privacy.action.retry"), exact: true })).toHaveCount(0);
    });

    if (owner) {
      test("rejects wrong deletion confirmation and blocks deletion under an active legal hold", async ({ page }, info) => {
        const reference = `PRIVACY-HOLD-${info.project.name}`;
        const reason = "Preserve synthetic case evidence";
        const submitted: unknown[] = [];
        page.on("request", request => {
          if (request.method() === "POST" && new URL(request.url()).pathname === requestsPath) {
            submitted.push(request.postDataJSON());
          }
        });

        await page.goto("/app?view=settings");
        await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
        await page.getByRole("tab", { name: t("tenant.settings.sections.privacy"), exact: true }).click();
        await page.getByRole("button", { name: t("tenant.privacy.action.createHold") }).click();
        const hold = page.getByRole("dialog", { name: t("tenant.privacy.holdDialog.title") });
        await hold.getByRole("combobox").selectOption("REFERENCE");
        await hold.locator("#privacy-hold-target").fill(reference);
        await hold.getByRole("textbox", { name: t("tenant.privacy.table.reason") }).fill(reason);
        await hold.getByRole("button", { name: t("tenant.privacy.action.createHold"), exact: true }).click();
        await expect(page.getByText(t("tenant.privacy.notice.holdCreated"), { exact: true })).toBeVisible();
        const holdRow = page.getByRole("row").filter({ hasText: reference });
        await expect(holdRow.getByText(reason, { exact: true })).toBeVisible();

        await page.getByRole("button", { name: t("tenant.privacy.action.requestDeletion"), exact: true }).click();
        const deletion = page.getByRole("dialog", { name: t("tenant.privacy.requestDialog.deleteTitle") });
        await deletion.locator("#privacy-request-target").fill(reference);
        const confirmation = deletion.getByRole("textbox", { name: t("tenant.privacy.requestDialog.confirmationAria", { phrase: "DELETE" }) });
        const submit = deletion.getByRole("button", { name: t("tenant.privacy.action.permanentDelete"), exact: true });
        await confirmation.fill("DELETE");
        await expect(submit).toBeEnabled();
        await confirmation.fill("DELETE ");
        await confirmation.press("Enter");
        await expect(submit).toBeDisabled();
        expect(submitted).toEqual([]);

        await confirmation.fill("DELETE");
        const blocked = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === requestsPath);
        await submit.click();
        expect((await blocked).status()).toBe(409);
        await expect(deletion.getByRole("alert")).toBeVisible();
        expect(submitted).toEqual([{ requestType: "DELETE", scopeType: "REFERENCE", scopeValue: reference, confirmation: "DELETE" }]);
        await deletion.getByRole("button", { name: t("tenant.privacy.action.cancel"), exact: true }).click();

        await holdRow.getByRole("button", { name: t("tenant.privacy.action.release"), exact: true }).click();
        const release = page.getByRole("dialog", { name: t("tenant.privacy.release.title") });
        await release.getByRole("button", { name: t("tenant.privacy.action.releaseHold"), exact: true }).click();
        await expect(page.getByText(t("tenant.privacy.notice.holdReleased"), { exact: true })).toBeVisible();
        await expect(holdRow.getByRole("button", { name: t("tenant.privacy.action.release"), exact: true })).toHaveCount(0);
        const requests = await (await page.request.get(requestsPath)).json() as { scope_value: string }[];
        expect(requests.filter(row => row.scope_value === reference)).toEqual([]);
      });
    }

    if (canExport) {
      test("recovers a lost export response with the original receipt and a single write", async ({ page }, info) => {
        const reference = `PRIVACY-EXPORT-${info.project.name}`;
        const submissions: { key: string; status: number; id: string }[] = [];
        await page.route(`**${requestsPath}`, async route => {
          if (route.request().method() !== "POST") return route.fallback();
          const response = await route.fetch();
          submissions.push({
            key: route.request().headers()["idempotency-key"],
            status: response.status(),
            id: (await response.json()).id,
          });
          await route.fulfill({ status: 502, json: { error: "Synthetic lost response" } });
        });

        await page.goto("/app?view=settings");
        await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
        const tab = page.getByRole("tab", { name: t("tenant.settings.sections.privacy"), exact: true });
        const exportButton = page.getByRole("button", { name: t("tenant.privacy.action.requestExport"), exact: true });
        const dialog = page.getByRole("dialog", { name: t("tenant.privacy.requestDialog.exportTitle") });
        await tab.click();
        await exportButton.click();
        await dialog.locator("#privacy-request-target").fill(reference);
        await dialog.getByRole("button", { name: t("tenant.privacy.action.requestExport"), exact: true }).click();
        await expect(dialog.getByRole("alert")).toBeVisible();
        expect(submissions).toEqual([{ key: expect.stringMatching(uuid), status: 202, id: expect.stringMatching(uuid) }]);

        await page.reload();
        await tab.click();
        await exportButton.click();
        await expect(dialog.getByRole("button", { name: t("tenant.privacy.action.requestExport"), exact: true })).toBeDisabled();
        const receipt = page.waitForResponse(response => new URL(response.url()).pathname === receiptPath);
        await dialog.getByRole("button", { name: t("tenant.privacy.recovery.check"), exact: true }).click();
        const recovered = await receipt;
        expect(recovered.request().method()).toBe("POST");
        expect(recovered.request().postDataJSON()).toEqual({ operationId: submissions[0].key, kind: "EXPORT", action: "LOOKUP" });
        expect(await recovered.json()).toEqual({ state: "APPLIED", id: submissions[0].id });
        await expect(dialog).toHaveCount(0);
        await expect(page.getByText(t("tenant.privacy.recovery.confirmed"), { exact: true })).toBeVisible();
        await expect(page.getByRole("row").filter({ hasText: reference })).toHaveCount(1);
        expect(submissions).toHaveLength(1);
      });
    }
  });
}
