import AxeBuilder from "@axe-core/playwright";
import { expect, type ConsoleMessage, type Page, type TestInfo } from "@playwright/test";
import type { MetaRoutingConfigurationDto, MetaThreadActionDto, MetaThreadControlCommand, MetaThreadRoutingDto } from "../../lib/meta-routing-contract";
import { englishTenantMessages } from "../../lib/i18n/messages/en/tenant";
import { arabicTenantMessages } from "../../lib/i18n/messages/ar/tenant";
import { formatList } from "../../lib/i18n/format";

const denials = new WeakMap<Page, { url: string; status: number }[]>();
/** A conservative read fixture for other local portal journeys; never accepts a write. */
export async function installMetaRoutingReadFixture(page: Page) {
  await page.route("**/api/connections/*/meta/routing", route => {
    if (route.request().method() !== "GET") return route.fallback();
    const value: MetaRoutingConfigurationDto = { sessionId: "33000000-0000-4000-8000-000000000070", configurationVersion: 0, reviewVersion: 0,
      readiness: "REVIEW_REQUIRED", declared: null, observed: null, providerConfigurationReadback: false, accountFundingProof: "SEPARATE_REQUIRED" };
    return route.fulfill({ json: value });
  });
}

export function consumeExpectedRoutingDenial(page: Page, message: ConsoleMessage) {
  if (!message.text().startsWith("Failed to load resource:")) return false;
  const pending = denials.get(page);
  const index = pending?.findIndex(item => item.url === message.location().url && new RegExp(`\\b${item.status}\\b`).test(message.text())) ?? -1;
  if (index < 0) return false;
  pending!.splice(index, 1); return true;
}

/** Local browser fixture only. The provider control result and account review are simulated. */
export async function metaRoutingJourney(page: Page, locale: "en" | "ar", role: string, testInfo: TestInfo) {
  const messages: Readonly<Record<string, string>> = locale === "ar" ? arabicTenantMessages : englishTenantMessages;
  const t = (key: string) => messages[`tenant.metaRouting.${key}`]!;
  const connectionId = "12000000-0000-4000-8000-000000000071", conversationId = "22000000-0000-4000-8000-000000000071";
  const canWrite = ["tenant_owner", "tenant_admin"].includes(role);
  const expected: { url: string; status: number }[] = []; denials.set(page, expected);
  const errors: string[] = [], writes: { key: string; body: MetaThreadControlCommand }[] = [], readKeys: (string | undefined)[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let declarations = 0, denied = false, loseResponse = true, malformedTerminal = false;
  let configuration: MetaRoutingConfigurationDto = { sessionId: "33000000-0000-4000-8000-000000000071", configurationVersion: 0, reviewVersion: 0,
    readiness: "LEGACY_COMPATIBILITY", declared: null, observed: null, providerConfigurationReadback: false, accountFundingProof: "SEPARATE_REQUIRED" };
  let view: MetaThreadRoutingDto = { connectionId, ownership: { allowed: false, epoch: 0, claim: "IDLE", reason: null, configurationVersion: 1, reviewVersion: 2 },
    actions: [], correlation: null, availability: { actions: canWrite ? ["take"] : [], passTargets: [], untargetedPass: false, admission: "ROUTING_SNAPSHOT_ONLY", currentnessRecheckedAtExecution: true },
    internalOwnershipUnchanged: true, reconciliation: "ORIGINAL_PROVIDER_EVIDENCE_REQUIRED" };
  const action = (body: MetaThreadControlCommand, state: MetaThreadActionDto["state"]): MetaThreadActionDto => ({ id: "44000000-0000-4000-8000-000000000071", action: body.action,
    targetRole: body.targetRole ?? null, state, requestId: state === "SUCCEEDED" ? "synthetic-meta-control-receipt" : null, reason: null, retryable: false });
  await page.route(`**/api/connections/${connectionId}**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/meta/routing")) {
      if (route.request().method() === "POST") {
        declarations++; expect(route.request().postDataJSON()).toEqual({ expectedVersion: 0, expectedSessionId: configuration.sessionId, fallback: "HOLD" });
        expect(route.request().headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/u);
        configuration = { ...configuration, configurationVersion: 1, readiness: "REVIEW_REQUIRED", declared: { fallback: "HOLD" } };
      }
      return route.fulfill({ json: configuration });
    }
    if (path.endsWith("/meta/coexistence")) return route.fulfill({ json: null });
    if (path.endsWith("/meta/capabilities")) return route.fulfill({ json: { eligible: false, state: "CONSENT_REQUIRED", evidence: "local_policy", checkedAt: new Date().toISOString() } });
    if (path === `/api/connections/${connectionId}`) return route.fulfill({ json: { id: connectionId, name: "Routing account", provider: "META", state: "PAUSED",
      phone_e164: "12025550143", provider_session_state: "PAUSED", provider_state: "STOPPED", webhook_state: "PAUSED", disclosure_version: null, group_count: 0 } });
    return route.continue();
  });
  await page.route("**/api/bot-flows/conversations?*", route => route.fulfill({ json: { items: [
    { id: conversationId, connection_id: connectionId, connection_provider: "META", connection_name: "Routing account", flow_name: "Service", version: 1,
      state: "HUMAN", zammad_ticket_number: "10471", last_activity_at: new Date().toISOString(), step_count: 1 },
    { id: "22000000-0000-4000-8000-000000000072", connection_id: "12000000-0000-4000-8000-000000000072", connection_provider: "WAHA", connection_name: "Other transport",
      flow_name: "Service", version: 1, state: "HUMAN", last_activity_at: new Date().toISOString(), step_count: 1 },
  ], next_cursor: null } }));
  await page.route(`**/api/bot-flows/conversations/${conversationId}/meta-thread-control`, async route => {
    const key = route.request().headers()["idempotency-key"];
    if (route.request().method() === "GET") { readKeys.push(key); return route.fulfill({ json: view }); }
    const body = route.request().postDataJSON() as MetaThreadControlCommand;
    writes.push({ key, body }); expect(key).toMatch(/^[0-9a-f-]{36}$/u);
    expect(Object.keys(body).sort()).toEqual((body.targetRole ? ["action", "targetRole", "expectedRoutingEpoch", "expectedConfigurationVersion", "expectedReviewVersion"] : ["action", "expectedRoutingEpoch", "expectedConfigurationVersion", "expectedReviewVersion"]).sort());
    if (denied) { expected.push({ url: route.request().url(), status: 403 }); return route.fulfill({ status: 403, json: { code: "MFA_REQUIRED" } }); }
    if (loseResponse) { loseResponse = false; return route.fulfill({ contentType: "application/json", body: "{" }); }
    if (malformedTerminal) {
      malformedTerminal = false;
      return route.fulfill({ json: { state: "SUCCEEDED", action: body.action, targetRole: body.targetRole ?? null } });
    }
    return route.fulfill({ json: action(body, "SUCCEEDED") });
  });
  await page.goto(`/app?view=connections&connection=${connectionId}`);
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  const section = page.locator('section[aria-labelledby="meta-routing-title"]');
  await expect(section.getByText(t("readiness.LEGACY_COMPATIBILITY"))).toBeVisible();
  if (canWrite) {
    await section.getByRole("button", { name: t("declare"), exact: true }).focus(); await page.keyboard.press("Enter");
    await expect(section.getByText(t("declared"), { exact: true })).toBeVisible(); expect(declarations).toBe(1);
  } else await expect(section.getByRole("button", { name: t("declare"), exact: true })).toHaveCount(0);
  configuration = { ...configuration, observed: { current: false, disposition: "REVOKED", observedAt: new Date().toISOString(), mode: "SIMULATED", scope: "PHONE_OVERRIDE", roles: ["escalation", "marketing"], targets: [], threadControlEnabled: true } };
  await section.getByRole("button", { name: t("refresh"), exact: true }).click();
  // Role lists use the active locale's list punctuation, never a fixed separator.
  await expect(section.getByText(formatList([t("role.escalation"), t("role.marketing")], locale), { exact: true })).toBeVisible();
  await expect(section.getByText(t("revoked"), { exact: true })).toBeVisible();
  await expect(section.getByText(t("mode.SIMULATED"), { exact: true })).toBeVisible();
  await testInfo.attach("routing-declaration", { body: await page.screenshot(), contentType: "image/png" });
  async function open() {
    await page.goto("/app?view=automation");
    await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
    await page.getByRole("tab", { name: locale === "ar" ? "المحادثات" : "Conversations", exact: true }).click();
    await expect(page.getByRole("button", { name: t("inspect"), exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: t("inspect"), exact: true }).focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: t("threadTitle"), exact: true });
    await expect(dialog.getByText(t("snapshot"))).toBeVisible(); return dialog;
  }
  let dialog = await open();
  if (!canWrite) { await expect(dialog.getByRole("button", { name: t("action.take"), exact: true })).toHaveCount(0); expect(writes).toEqual([]); return; }
  await dialog.getByRole("button", { name: t("action.take"), exact: true }).click();
  await expect(dialog.getByRole("button", { name: t("cancel"), exact: true })).toBeFocused();
  await testInfo.attach("routing-confirmation", { body: await page.screenshot(), contentType: "image/png" });
  expect((await new AxeBuilder({ page }).include('[aria-labelledby="meta-thread-title"]').withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await dialog.getByRole("button", { name: t("confirmAction"), exact: true }).click();
  await expect(dialog.getByText(t("outcomeHold"), { exact: true })).toBeVisible();
  await expect.poll(() => writes).toHaveLength(1);
  const original = writes[0];
  view = { ...view, correlation: { state: "ABSENT" } };
  dialog = await open(); expect(readKeys.at(-1)).toBe(original.key);
  await expect(dialog.getByRole("button", { name: t("action.take"), exact: true })).toHaveCount(0);
  for (const correlation of [
    { state: "MATCHED" as const, action: action(original.body, "SUCCEEDED"), command: { ...original.body, expectedReviewVersion: 99 } },
    { state: "MATCHED" as const, action: action(original.body, "OUTCOME_UNKNOWN"), command: original.body },
    { state: "MATCHED" as const, action: { state: "SUCCEEDED", action: original.body.action, targetRole: null } as MetaThreadActionDto, command: original.body },
    { state: "MATCHED" as const, action: { ...action(original.body, "SUCCEEDED"), requestId: null }, command: original.body },
  ]) {
    view = { ...view, correlation }; await dialog.getByRole("button", { name: t("refresh"), exact: true }).click();
    await expect(dialog.getByText(t("outcomeHold"), { exact: true })).toBeVisible(); expect(writes).toHaveLength(1);
  }
  view = { ...view, correlation: { state: "MATCHED", action: action(original.body, "SUCCEEDED"), command: original.body },
    ownership: { ...view.ownership, epoch: 1, allowed: true, claim: "OWN" }, availability: { ...view.availability, actions: ["pass", "release"], passTargets: ["customer_service"], untargetedPass: false } };
  await dialog.getByRole("button", { name: t("refresh"), exact: true }).click();
  await expect(dialog.getByText(t("outcomeHold"), { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: t("action.pass"), exact: true }).click();
  await expect(dialog.getByRole("button", { name: t("confirmAction"), exact: true })).toBeDisabled();
  await dialog.getByRole("combobox", { name: t("target"), exact: true }).selectOption("customer_service");
  await dialog.getByRole("button", { name: t("confirmAction"), exact: true }).click();
  await expect(dialog.getByText(t("actionState.SUCCEEDED"), { exact: true })).toBeVisible(); expect(writes).toHaveLength(2);
  expect(writes[1].body.targetRole).toBe("customer_service"); expect(writes[1].key).not.toBe(original.key);
  view = { ...view, correlation: null }; await dialog.getByRole("button", { name: t("refresh"), exact: true }).click();
  malformedTerminal = true;
  await dialog.getByRole("button", { name: t("action.release"), exact: true }).click();
  await dialog.getByRole("button", { name: t("confirmAction"), exact: true }).click();
  await expect(dialog.getByText(t("outcomeHold"), { exact: true })).toBeVisible();
  await expect.poll(() => writes).toHaveLength(3);
  view = { ...view, correlation: { state: "ABSENT" } };
  dialog = await open(); expect(readKeys.at(-1)).toBe(writes[2].key);
  await expect(dialog.getByText(t("outcomeHold"), { exact: true })).toBeVisible(); expect(writes).toHaveLength(3);
  await expect(dialog.getByRole("button", { name: t("action.release"), exact: true })).toHaveCount(0);
  view = { ...view, correlation: { state: "MATCHED", action: action(writes[2].body, "FAILED"), command: writes[2].body } };
  await dialog.getByRole("button", { name: t("refresh"), exact: true }).click();
  await expect(dialog.getByText(t("outcomeHold"), { exact: true })).toHaveCount(0);
  view = { ...view, correlation: null }; await dialog.getByRole("button", { name: t("refresh"), exact: true }).click();
  denied = true;
  await dialog.getByRole("button", { name: t("action.release"), exact: true }).click();
  await dialog.getByRole("button", { name: t("confirmAction"), exact: true }).click();
  await expect(dialog.getByText(t("outcomeHold"), { exact: true })).toBeVisible();
  await expect.poll(() => writes).toHaveLength(4);
  view = { ...view, correlation: { state: "ABSENT" } }; await dialog.getByRole("button", { name: t("refresh"), exact: true }).click();
  await expect(dialog.getByText(t("outcomeHold"), { exact: true })).toBeVisible(); expect(writes).toHaveLength(4);
  view = { ...view, correlation: { state: "MATCHED", action: action(writes[3].body, "FAILED"), command: writes[3].body } };
  await dialog.getByRole("button", { name: t("refresh"), exact: true }).click();
  await expect(dialog.getByText(t("outcomeHold"), { exact: true })).toHaveCount(0);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("blocked", "SecurityError"); }; });
  await dialog.getByRole("button", { name: t("action.release"), exact: true }).click();
  await dialog.getByRole("button", { name: t("confirmAction"), exact: true }).click();
  await expect(dialog.getByText(t("storageUnavailable"), { exact: true })).toBeVisible(); expect(writes).toHaveLength(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(expected).toEqual([]); expect(errors).toEqual([]);
}
