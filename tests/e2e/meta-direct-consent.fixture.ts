import AxeBuilder from "@axe-core/playwright";
import { expect, type ConsoleMessage, type Page, type Request, type TestInfo } from "@playwright/test";
import { englishTenantMessages } from "../../lib/i18n/messages/en/tenant.ts";
import { arabicTenantMessages } from "../../lib/i18n/messages/ar/tenant.ts";
import { englishCommonMessages } from "../../lib/i18n/messages/en/common.ts";
import { arabicCommonMessages } from "../../lib/i18n/messages/ar/common.ts";

const expectedDirectSetupFailures = new WeakMap<Page, { url: string; status: number }[]>();
export function consumeExpectedDirectSetupDenial(page: Page, message: ConsoleMessage) {
  if (!message.text().startsWith("Failed to load resource:")) return false;
  const failures = expectedDirectSetupFailures.get(page);
  const index = failures?.findIndex(expected => expected.url === message.location().url
    && new RegExp(`\\b${expected.status}\\b`).test(message.text())) ?? -1;
  if (index < 0) return false;
  failures!.splice(index, 1); return true;
}

/** Portal fixture responses only: this is browser behavior, never live Meta proof. */
export async function metaDirectConsentJourney(page: Page, locale: "en" | "ar", role: string, testInfo: TestInfo) {
  const messages: Readonly<Record<string, string>> = locale === "ar" ? arabicTenantMessages : englishTenantMessages;
  const t = (key: string) => messages[key]!;
  const common = locale === "ar" ? arabicCommonMessages : englishCommonMessages;
  const expectedFailures: { url: string; status: number }[] = [];
  expectedDirectSetupFailures.set(page, expectedFailures);
  const rawFailure = "private provider details must never appear";
  await page.route("**/api/connections/meta/signup/**", route => route.fulfill({ json: route.request().url().endsWith("/capabilities")
    ? { enabled: false, payerModes: ["CUSTOMER"] } : { attempt: null } }));
  const firstId = "12000000-0000-4000-8000-000000000061";
  const secondId = "12000000-0000-4000-8000-000000000062";
  let accepted = false;
  const creates: Record<string, unknown>[] = [];
  const createKeys: string[] = [];
  let successfulCreates = 0;
  const syncs: { id: string; key: string; body: Record<string, unknown> }[] = [];
  let releaseOldCapability: (() => void) | undefined;
  let oldCapabilityRequest: Request | undefined;
  let oldCapabilitySettled = false;
  let delayed = false;
  const staleCapability = { eligible: false, state: "CONSENT_REQUIRED", evidence: "local_policy", checkedAt: new Date().toISOString() };
  await page.route("**/api/connections", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    const input = route.request().postDataJSON();
    creates.push(input);
    const key = route.request().headers()["idempotency-key"];
    expect(key).toBeTruthy();
    createKeys.push(key);
    expect(creates.length).toBeLessThanOrEqual(3);
    expect(input).not.toHaveProperty("eligibilityAccepted");
    expect(input).not.toHaveProperty("eligibilityVersion");
    if (creates.length <= 2) {
      const status = creates.length === 1 ? 409 : 503;
      expectedFailures.push({ url: route.request().url(), status });
      await route.fulfill({ status, json: { ...(status === 409 ? { code: "META_SIGNUP_ASSET_CONFLICT" } : {}), message: rawFailure } });
      return;
    }
    successfulCreates++;
    await route.fulfill({ status: 202, json: { id: firstId, state: "PROVISIONING", operation: { state: "QUEUED" } } });
  });
  await page.route("**/api/connections/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const id = path.split("/")[3];
    if (![firstId, secondId].includes(id)) { await route.fallback(); return; }
    if (path.endsWith("/groups/sync")) {
      syncs.push({ id, key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
      accepted = true;
      await route.fulfill({ status: 202, json: { operation: { type: "SYNC_GROUPS", state: "QUEUED" } } });
    } else if (path.endsWith("/meta/capabilities")) {
      if (id === firstId && !delayed) {
        delayed = true;
        oldCapabilityRequest = route.request();
        await new Promise<void>(resolve => { releaseOldCapability = resolve; });
        try { await route.fulfill({ json: staleCapability }); }
        catch (error) {
          if (route.request().failure()?.errorText !== "net::ERR_ABORTED" ||
              !/cancel|closed|disposed|invalid interception/iu.test(String(error))) throw error;
        }
        oldCapabilitySettled = true;
      } else {
        await route.fulfill({ json: id === firstId && accepted ? {
          eligible: true, state: "AVAILABLE", evidence: "provider_probe", checkedAt: new Date().toISOString(),
          constraints: { maxParticipants: 8 }, documentationUrl: "https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/",
        } : staleCapability });
      }
    } else if (path === `/api/connections/${id}`) {
      await route.fulfill({ json: { id, name: id === firstId ? "Direct Alpha" : "Direct Beta", provider: "META",
        state: "WORKING", provider_session_state: "WORKING", provider_state: "AVAILABLE", webhook_state: "ACTIVE",
        last_heartbeat_at: new Date().toISOString(), disclosure_version: id === firstId && accepted ? "2026-08-09" : null,
        latest_operation_id: id === firstId ? "44000000-0000-4000-8000-000000000061" : "44000000-0000-4000-8000-000000000062",
        latest_operation_type: "PROVISION", latest_operation_state: "SUCCEEDED", latest_operation_attempts: 1,
        latest_operation_created_at: "2026-10-09T00:00:00.000Z", group_count: 0 } });
    } else { await route.fallback(); }
  });
  await page.goto("/app?view=connections");
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  const connect = page.getByRole("button", { name: t("tenant.connections.connect"), exact: true });
  if (!["tenant_owner", "tenant_admin"].includes(role)) {
    await expect(connect).toHaveCount(0);
    expect(creates).toHaveLength(0);
    return;
  }
  await connect.click();
  const dialog = page.getByRole("dialog", { name: t("tenant.setup.ariaLabel") });
  const metaProvider = dialog.getByRole("radio", { name: new RegExp(t("tenant.setup.providers.metaTitle")) });
  await dialog.getByText(t("tenant.setup.providers.metaTitle"), { exact: true }).click();
  await expect(metaProvider).toBeChecked();
  await dialog.getByLabel(t("tenant.setup.name.label")).fill("Direct Alpha");
  await dialog.getByRole("button", { name: t("tenant.setup.actions.continue"), exact: true }).click();
  await dialog.getByRole("button", { name: t("tenant.metaSignup.manual"), exact: true }).click();
  const optional = dialog.getByRole("checkbox", { name: t("tenant.setup.review.metaGroupsAccept") });
  await expect(optional).not.toBeChecked();
  await dialog.getByLabel(t("tenant.setup.meta.phoneId"), { exact: true }).fill("123456789");
  await dialog.getByLabel(t("tenant.setup.meta.wabaId"), { exact: true }).fill("987654321");
  await dialog.getByLabel(t("tenant.setup.meta.token")).fill("synthetic-browser-token-not-a-credential");
  await dialog.getByRole("button", { name: t("tenant.setup.actions.continue"), exact: true }).click();
  for (const [index, status] of [409, 503].entries()) {
    await dialog.getByRole("button", { name: t("tenant.setup.actions.start"), exact: true }).click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toBeInViewport();
    await expect(alert).not.toContainText(rawFailure);
    await expect(alert).not.toContainText("META_SIGNUP_ASSET_CONFLICT");
    if (status === 409) {
      await expect(alert.getByText(t("tenant.metaSignup.reason.META_SIGNUP_ASSET_CONFLICT"), { exact: true })).toBeVisible();
      await expect(alert).not.toContainText(common["common.errors.conflict"]);
      await expect(alert).not.toContainText(t("tenant.setup.errors.retry"));
      await expect(alert).not.toContainText(t("tenant.setup.errors.reenterToken"));
      await testInfo.attach("manual-meta-asset-conflict", { body: await page.screenshot(), contentType: "image/png" });
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    } else {
      await expect(alert).toContainText(common["common.errors.unavailable"]);
      await expect(alert).toContainText(t("tenant.setup.errors.retry"));
      await expect(alert).toContainText(t("tenant.setup.errors.reenterToken"));
    }
    expect(creates).toHaveLength(index + 1);
    expect(successfulCreates).toBe(0);
    await expect(dialog.getByRole("button", { name: t("tenant.setup.actions.view"), exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: t("tenant.setup.actions.back"), exact: true }).click();
    await expect(dialog.getByLabel(t("tenant.setup.meta.phoneId"), { exact: true })).toHaveValue("123456789");
    await expect(dialog.getByLabel(t("tenant.setup.meta.wabaId"), { exact: true })).toHaveValue("987654321");
    const token = dialog.getByLabel(t("tenant.setup.meta.token"));
    await expect(token).toHaveValue("");
    await expect(dialog.getByRole("button", { name: t("tenant.setup.actions.continue"), exact: true })).toBeDisabled();
    await token.fill("synthetic-browser-token-not-a-credential");
    await dialog.getByRole("button", { name: t("tenant.setup.actions.continue"), exact: true }).click();
  }
  await dialog.getByRole("button", { name: t("tenant.setup.actions.start"), exact: true }).click();
  await dialog.getByRole("button", { name: t("tenant.setup.actions.view"), exact: true }).click();
  expect(creates).toHaveLength(3);
  expect(successfulCreates).toBe(1);
  expect(createKeys).toHaveLength(3);
  expect(new Set(createKeys).size).toBe(1);
  for (const body of creates) expect(body).toEqual(creates[0]);
  await expect.poll(() => expectedFailures.length).toBe(0);
  await expect.poll(() => Boolean(releaseOldCapability)).toBe(true);
  const optIn = page.getByRole("checkbox", { name: t("tenant.setup.review.metaGroupsAccept") });
  const sync = page.getByRole("button", { name: t("tenant.connection.lifecycle.action.sync"), exact: true });
  await expect(sync).toBeDisabled();
  await optIn.check();
  // Refresh replaces this exact held request; an aborted fetch has no response.
  const oldRequest = oldCapabilityRequest;
  expect(oldRequest).toBeDefined();
  const oldAborted = page.waitForEvent("requestfailed", { predicate: request => request === oldRequest });
  await sync.click();
  expect((await oldAborted).failure()?.errorText).toBe("net::ERR_ABORTED");
  const subject = page.getByLabel(t("tenant.connection.officialGroups.subject"), { exact: true });
  await expect(subject).toBeVisible();
  releaseOldCapability!();
  await expect.poll(() => oldCapabilitySettled).toBe(true);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(subject).toBeVisible();
  expect(syncs).toHaveLength(1);
  expect(syncs[0]).toMatchObject({ id: firstId, body: { eligibilityAccepted: true, eligibilityVersion: "2026-08-09" } });
  expect(syncs[0].key).toBeTruthy();

  // Browser history changes connection identity without reloading the application.
  const navigate = async (id: string) => page.evaluate(value => {
    history.pushState({}, "", `/app?view=connections&connection=${value}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, id);
  await navigate(secondId);
  await expect(optIn).not.toBeChecked();
  await optIn.check();
  page.once("dialog", dialog => dialog.accept());
  await navigate(firstId);
  await expect(subject).toBeVisible();
  await page.goBack();
  await expect(optIn).not.toBeChecked();
  await expect(sync).toBeDisabled();
  expect(syncs).toHaveLength(1);
  const latestOperation = page.locator('[aria-labelledby="latest-operation-title"]');
  await expect(latestOperation.locator(".connection-detail-operation")).toBeVisible();
  await expect(latestOperation.getByText(t("tenant.connection.latestOperation.emptyTitle"), { exact: true })).toHaveCount(0);

  // Include disabled actions: coarse-pointer minimum sizing must not shrink
  // their actual text outside the button, card or viewport in either locale.
  const headerButtons = page.locator(".connection-detail-section-head > .button").filter({ visible: true });
  expect(await headerButtons.count()).toBeGreaterThanOrEqual(2);
  for (const button of await headerButtons.all()) {
    await button.scrollIntoViewIfNeeded();
    const layout = await button.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return {
        label: element.textContent,
        button: element.getBoundingClientRect().toJSON(),
        card: element.closest("section")!.getBoundingClientRect().toJSON(),
        text: [...range.getClientRects()].filter(rect => rect.width && rect.height).map(rect => rect.toJSON()),
        overflow: element.scrollWidth - element.clientWidth,
        viewport: { width: innerWidth, height: innerHeight },
        coarse: matchMedia("(any-pointer: coarse)").matches,
      };
    });
    expect(layout.text.length, layout.label ?? "header action text").toBeGreaterThan(0);
    expect(layout.overflow, layout.label ?? "header action overflow").toBeLessThanOrEqual(1);
    for (const text of layout.text) {
      expect(text.left).toBeGreaterThanOrEqual(layout.button.left - 1);
      expect(text.right).toBeLessThanOrEqual(layout.button.right + 1);
      expect(text.top).toBeGreaterThanOrEqual(layout.button.top - 1);
      expect(text.bottom).toBeLessThanOrEqual(layout.button.bottom + 1);
    }
    expect(layout.button.left).toBeGreaterThanOrEqual(Math.max(0, layout.card.left) - 1);
    expect(layout.button.right).toBeLessThanOrEqual(Math.min(layout.viewport.width, layout.card.right) + 1);
    expect(layout.button.top).toBeGreaterThanOrEqual(Math.max(0, layout.card.top) - 1);
    expect(layout.button.bottom).toBeLessThanOrEqual(Math.min(layout.viewport.height, layout.card.bottom) + 1);
    if (layout.coarse) {
      expect(layout.button.width).toBeGreaterThanOrEqual(44);
      expect(layout.button.height).toBeGreaterThanOrEqual(44);
    }
  }
  await page.getByRole("button", { name: t("tenant.connection.disconnect.open"), exact: true }).scrollIntoViewIfNeeded();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
}
