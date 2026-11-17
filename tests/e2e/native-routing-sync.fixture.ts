import { expect, type Page, type TestInfo } from "@playwright/test";
import type { DepartmentDefaultPolicy, NativeRoutingSyncCommand, NativeRoutingSyncStatus } from "../../packages/core/src/native-routing-contract.ts";
import { englishAutomationMessages } from "../../lib/i18n/messages/en/automation.ts";
import { arabicAutomationMessages } from "../../lib/i18n/messages/ar/automation.ts";
import type { BotFlowDefinition } from "../../packages/core/src/bot-flow.ts";

/** Provider-contract fixture only. The installed owner Chrome and native workspace are never used. */
export async function nativeRoutingSyncJourney(page: Page, testInfo: TestInfo, locale: "en" | "ar", role: string) {
  const messages: Readonly<Record<string, string>> = locale === "ar" ? arabicAutomationMessages : englishAutomationMessages;
  const t = (key: string) => messages[key]!;
  const canWrite = ["tenant_owner", "tenant_admin"].includes(role);
  const writes: NativeRoutingSyncCommand[] = [];
  let holdRead: { started: () => void; release: Promise<void> } | null = null;
  let status: NativeRoutingSyncStatus = {
    state: "SYNCED", desiredRevision: 1, appliedRevision: 1, desiredSha256: "a".repeat(64), observedSha256: "a".repeat(64),
    lastCheckedAt: "2026-10-16T10:00:00Z", errorCode: null, safeRetry: false, departmentDefaults: [],
  };
  const catalog = {
    instanceId: "10000000-0000-4000-8000-000000000001", fetchedAt: "2026-10-16T10:00:00Z", expiresAt: "2026-10-16T10:01:00Z",
    groups: [{ id: "5", name: "QA Finance", active: true, serviceIdentityCanCreate: true }, { id: "2", name: "QA Support", active: true, serviceIdentityCanCreate: true }],
    owners: [{ id: "7", name: "QA Finance Agent", active: true, groupIds: ["5"] }, { id: "8", name: "QA Finance Alternate", active: true, groupIds: ["5"] }, { id: "6", name: "QA Fallback", active: true, groupIds: ["2"] }], slas: [], calendars: [],
  };
  await page.route("**/api/zammad/routing-catalogs", route => route.fulfill({ json: catalog }));
  await page.route("**/api/zammad/routing-sync", async route => {
    if (route.request().method() === "GET" && holdRead) {
      const held = holdRead;
      holdRead = null;
      const previous = structuredClone(status);
      held.started();
      await held.release;
      await route.fulfill({ json: previous });
      return;
    }
    if (route.request().method() === "POST") {
      expect(canWrite).toBe(true);
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      const body = route.request().postDataJSON() as NativeRoutingSyncCommand;
      expect(body.expectedRevision).toBe(status.desiredRevision);
      writes.push(body);
      if (body.action === "SAVE_DEFAULTS") {
        status = { ...status, departmentDefaults: structuredClone(body.departmentDefaults), desiredRevision: status.desiredRevision + 1, state: "PENDING", safeRetry: true };
      } else if (body.action === "CHECK") {
        status = { ...status, appliedRevision: status.desiredRevision, observedSha256: status.desiredSha256, state: "SYNCED", safeRetry: false };
      } else {
        expect(status.state).toBe("FAILED");
        expect(status.safeRetry).toBe(true);
        status = { ...status, state: "APPLYING", safeRetry: false };
      }
    }
    await route.fulfill({ json: status });
  });
  await page.goto("/app?view=routing");
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
  const panel = page.getByRole("region", { name: t("nativeRouting.title"), exact: true });
  const refresh = panel.getByRole("button", { name: t("nativeRouting.refresh"), exact: true });
  await expect(panel.getByText(t("nativeRouting.state.SYNCED"), { exact: true })).toBeVisible();

  let releaseRead!: () => void;
  let readStarted!: () => void;
  const started = new Promise<void>(resolve => { readStarted = resolve; });
  holdRead = { started: readStarted, release: new Promise<void>(resolve => { releaseRead = resolve; }) };
  await refresh.click();
  await started;
  status = { ...status, state: "DRIFT", safeRetry: false };
  await refresh.click();
  await expect(panel.getByText(t("nativeRouting.state.DRIFT"), { exact: true })).toBeVisible();
  const staleResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/zammad/routing-sync" && response.request().method() === "GET");
  releaseRead();
  await (await staleResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(panel.getByText(t("nativeRouting.state.SYNCED"), { exact: true })).toHaveCount(0);

  for (const state of ["DRIFT", "OUTCOME_UNKNOWN", "FAILED"] as const) {
    status = { ...status, state, safeRetry: state !== "FAILED" };
    await refresh.click();
    await expect(panel.getByText(t(`nativeRouting.state.${state}`), { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: t("nativeRouting.retry"), exact: true })).toHaveCount(0);
    if (state === "OUTCOME_UNKNOWN" && canWrite) {
      await panel.getByRole("button", { name: t("nativeRouting.check"), exact: true }).click();
      await expect(panel.getByText(t("nativeRouting.state.SYNCED"), { exact: true })).toBeVisible();
      expect(writes.at(-1)!.action).toBe("CHECK");
    }
  }
  status = { ...status, state: "FAILED", safeRetry: true };
  await refresh.click();
  if (!canWrite) {
    await expect(panel.getByRole("button", { name: t("nativeRouting.defaults.edit"), exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: t("nativeRouting.check"), exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: t("nativeRouting.retry"), exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
    return;
  }
  await panel.getByRole("button", { name: t("nativeRouting.retry"), exact: true }).click();
  await expect(panel.getByText(t("nativeRouting.state.APPLYING"), { exact: true })).toBeVisible();
  expect(writes.filter(write => write.action === "RECONCILE")).toHaveLength(1);
  await panel.getByRole("button", { name: t("nativeRouting.check"), exact: true }).click();
  await expect(panel.getByText(t("nativeRouting.state.SYNCED"), { exact: true })).toBeVisible();

  const edit = () => panel.getByRole("button", { name: t("nativeRouting.defaults.edit"), exact: true }).click();
  const save = async () => {
    await panel.getByRole("button", { name: t("nativeRouting.defaults.save"), exact: true }).click();
    await expect(panel.getByRole("button", { name: t("nativeRouting.defaults.edit"), exact: true })).toBeVisible();
    await expect(panel.getByText(t("nativeRouting.state.PENDING"), { exact: true })).toBeVisible();
    await expect(panel.getByText(t("nativeRouting.state.SYNCED"), { exact: true })).toHaveCount(0);
  };
  await edit();
  await expect(panel.getByText(t("nativeRouting.defaults.empty"), { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: t("nativeRouting.defaults.add"), exact: true }).click();
  await expect(panel.getByRole("combobox", { name: t("nativeRouting.defaults.queue"), exact: true })).toHaveValue("");
  await expect(panel.getByRole("combobox", { name: t("nativeRouting.defaults.owner"), exact: true })).toHaveValue("");
  await panel.getByRole("combobox", { name: t("nativeRouting.defaults.queue"), exact: true }).selectOption("5");
  const owner = panel.getByRole("combobox", { name: t("nativeRouting.defaults.owner"), exact: true });
  await expect(owner.locator("option[value='6']")).toHaveCount(0);
  await owner.selectOption("7");
  await panel.getByRole("button", { name: t("nativeRouting.defaults.add"), exact: true }).click();
  const duplicate = panel.locator("fieldset").last();
  await duplicate.getByRole("combobox", { name: t("nativeRouting.defaults.queue"), exact: true }).selectOption("5");
  await duplicate.getByRole("combobox", { name: t("nativeRouting.defaults.owner"), exact: true }).selectOption("8");
  await expect(panel.getByText(t("nativeRouting.defaults.invalid"), { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: t("nativeRouting.defaults.save"), exact: true })).toBeDisabled();
  await duplicate.getByRole("button", { name: t("nativeRouting.defaults.remove"), exact: true }).click();
  const bounds = await panel.evaluate(element => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, controls: [...element.querySelectorAll("select")].map(select => { const box = select.getBoundingClientRect(); return { left: box.left, right: box.right }; }) }));
  expect(bounds.width).toBeLessThanOrEqual(bounds.viewport + 1);
  expect(bounds.controls.every(control => control.left >= 0 && control.right <= bounds.viewport + 1)).toBe(true);
  await testInfo.attach("native-routing-defaults", { body: await page.screenshot(), contentType: "image/png" });
  await save();
  const first = writes.find(write => write.action === "SAVE_DEFAULTS") as Extract<NativeRoutingSyncCommand, { action: "SAVE_DEFAULTS" }>;
  const savedId = first.departmentDefaults[0]!.id;
  expect(savedId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(first.departmentDefaults[0]).toEqual({ id: savedId, zammadGroupId: "5", zammadOwnerId: "7", enabled: true });
  await page.reload();
  await expect(panel.getByText("QA Finance Agent", { exact: true })).toBeVisible();
  await edit();
  status = { ...status, desiredRevision: status.desiredRevision + 1 };
  await refresh.click();
  await expect(panel.getByText(t("nativeRouting.defaults.stale"), { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: t("nativeRouting.defaults.save"), exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: t("automation.common.cancel"), exact: true }).click();
  await edit();
  await panel.getByRole("combobox", { name: t("nativeRouting.defaults.owner"), exact: true }).selectOption("8");
  await save();
  await edit();
  await panel.getByLabel(t("nativeRouting.defaults.enabled"), { exact: true }).uncheck();
  await save();
  await edit();
  await panel.getByRole("button", { name: t("nativeRouting.defaults.remove"), exact: true }).click();
  await save();
  const policies = writes.filter((write): write is Extract<NativeRoutingSyncCommand, { action: "SAVE_DEFAULTS" }> => write.action === "SAVE_DEFAULTS").map(write => write.departmentDefaults);
  expect(policies).toEqual([
    [{ id: savedId, zammadGroupId: "5", zammadOwnerId: "7", enabled: true }],
    [{ id: savedId, zammadGroupId: "5", zammadOwnerId: "8", enabled: true }],
    [{ id: savedId, zammadGroupId: "5", zammadOwnerId: "8", enabled: false }], [],
  ] satisfies DepartmentDefaultPolicy[][]);
  await page.goto("/app?view=automation");
  await page.getByRole("tab", { name: t("bot.tabs.assignments"), exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: t("nativeRouting.defaults.edit"), exact: true })).toHaveCount(0);
}

export async function fixedHandoffOwnerJourney(page: Page, testInfo: TestInfo, locale: "en" | "ar") {
  const messages: Readonly<Record<string, string>> = locale === "ar" ? arabicAutomationMessages : englishAutomationMessages;
  const t = (key: string) => messages[key]!;
  await page.route("**/api/zammad/routing-catalogs", route => route.fulfill({ json: {
    groups: [{ id: "5", name: "QA Finance", active: true, serviceIdentityCanCreate: true }, { id: "2", name: "QA Support", active: true, serviceIdentityCanCreate: true }],
    owners: [{ id: "7", name: "QA Finance Agent", active: true, groupIds: ["5"] }, { id: "6", name: "QA Fallback", active: true, groupIds: ["2"] }],
  } }));
  const writes: BotFlowDefinition[] = [];
  await page.route("**/api/bot-flows", async route => {
    if (route.request().method() === "POST") {
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      writes.push(route.request().postDataJSON() as BotFlowDefinition);
    }
    await route.continue();
  });
  await page.goto("/app?view=automation");
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  const panel = page.locator("#bot-panel-flows");
  const editor = page.locator("form.panel.bot-flow-editor");
  const target = editor.locator("#bot-node-handoff-target");
  const owner = editor.locator("#bot-node-handoff-owner");
  const group = editor.locator("#bot-node-handoff-group");
  const newFlow = () => panel.getByRole("button", { name: t("bot.flows.new"), exact: true }).click();
  await newFlow();
  await target.selectOption("FIXED");
  await group.selectOption("5");
  await expect(owner).toHaveValue("");
  await expect(owner.locator("option[value='6']")).toHaveCount(0);
  await owner.selectOption("7");
  await group.selectOption("2");
  await expect(owner).toHaveValue("7");
  await expect(editor.getByRole("alert").filter({ hasText: t("bot.node.unavailableOwner") })).toBeVisible();
  await group.selectOption("5");
  const name = `Fixed owner ${locale} ${testInfo.project.name}`;
  await editor.getByLabel(t("bot.editor.name"), { exact: true }).fill(name);
  await editor.getByRole("button", { name: t("bot.editor.save"), exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.nodes.find(node => node.type === "handoff")).toMatchObject({ target: "FIXED", zammadGroupId: "5", zammadOwnerId: "7" });
  await page.reload();
  await panel.locator(".bot-version-list button").filter({ has: page.getByText(name, { exact: true }) }).first().click();
  await panel.getByRole("button", { name: t("bot.flow.clone"), exact: true }).click();
  await expect(owner).toHaveValue("7");
  await owner.selectOption("");
  await editor.getByLabel(t("bot.editor.name"), { exact: true }).fill(`${name} omitted`);
  await editor.getByRole("button", { name: t("bot.editor.save"), exact: true }).click();
  await expect(editor).toHaveCount(0);
  // A clone uses its separate endpoint. Read the saved draft to verify omission
  // without activating it or touching the existing published flow.
  const catalog = await page.request.get("/api/bot-flows/catalog?limit=25");
  expect(catalog.ok()).toBe(true);
  const rows = await catalog.json() as { items: Array<{ flow_version_id: string; name: string }> };
  const saved = rows.items.find(row => row.name === `${name} omitted`);
  expect(saved).toBeDefined();
  const detail = await page.request.get(`/api/bot-flows/${saved!.flow_version_id}`);
  expect(detail.ok()).toBe(true);
  const definition = (await detail.json() as { definition: BotFlowDefinition }).definition;
  const handoff = definition.nodes.find(node => node.type === "handoff");
  expect(handoff).toMatchObject({ target: "FIXED", zammadGroupId: "5" });
  expect(handoff).not.toHaveProperty("zammadOwnerId");
}
