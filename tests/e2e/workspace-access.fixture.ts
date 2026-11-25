import AxeBuilder from "@axe-core/playwright";
import { expect, type ConsoleMessage, type Page, type TestInfo } from "@playwright/test";
import { englishTenantMessages } from "../../lib/i18n/messages/en/tenant.ts";
import { arabicTenantMessages } from "../../lib/i18n/messages/ar/tenant.ts";
import { englishAutomationMessages } from "../../lib/i18n/messages/en/automation.ts";
import { arabicAutomationMessages } from "../../lib/i18n/messages/ar/automation.ts";
import { formatNumber } from "../../lib/i18n/format.ts";
import type { NativeAccountObservation, TeamAccessData } from "../../lib/control-plane-data.ts";

const expectedObservationFailures = new WeakMap<Page, string[]>();
export function consumeExpectedObservationFailure(page: Page, message: ConsoleMessage) {
  if (!message.text().startsWith("Failed to load resource:") || !/\b503\b/u.test(message.text())) return false;
  const failures = expectedObservationFailures.get(page);
  const index = failures?.indexOf(message.location().url) ?? -1;
  if (index < 0) return false;
  failures!.splice(index, 1);
  return true;
}

export async function accountObservationJourney(page: Page, testInfo: TestInfo, locale: "en" | "ar") {
  const messages: Readonly<Record<string, string>> = locale === "ar" ? arabicTenantMessages : englishTenantMessages;
  const t = (key: string) => messages[key]!;
  const userId = "32000000-0000-4000-8000-000000000005";
  let observation: NativeAccountObservation | undefined = { state: "VERIFIED", checkedAt: "2026-10-16T10:00:00Z", revision: 7, nativeUserId: "21" };
  let sourceMemberState = "ACTIVE";
  let failWorkspace = false;
  let hold: { started: () => void; release: Promise<void> } | null = null;
  const writes: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/team") && !["GET", "HEAD"].includes(request.method())) writes.push(request.method()); });
  await page.route("**/api/team", async route => {
    const response = await route.fetch();
    const data = await response.json() as TeamAccessData;
    const member = data.members.find(row => row.user_id === userId)!;
    expect(member.state).toBe("ACTIVE");
    member.state = sourceMemberState;
    member.nativeObservation = observation;
    await route.fulfill({ response, json: data });
  });
  const snapshot = () => ({ enabled: true, members: [{ user_id: userId, revision: observation?.revision ?? 7, applied_revision: observation?.revision ?? 7, native_user_id: "21", member_state: sourceMemberState, sync_state: "READY", nativeObservation: observation }] });
  await page.route("**/api/team/workspace-access", async route => {
    expect(route.request().method()).toBe("GET");
    if (failWorkspace) {
      const failures = expectedObservationFailures.get(page) ?? [];
      failures.push(route.request().url()); expectedObservationFailures.set(page, failures);
      await route.fulfill({ status: 503, json: { code: "SERVICE_UNAVAILABLE" } });
      return;
    }
    const previous = structuredClone(snapshot());
    if (hold) { const held = hold; hold = null; held.started(); await held.release; }
    await route.fulfill({ json: previous });
  });
  await page.goto("/app?view=team");
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  const workspace = page.getByRole("region", { name: t("tenant.workspaceAccess.title"), exact: true });
  const member = page.locator(".team-panel tbody tr").filter({ hasText: "amal@northstar.example" });
  const workspaceMember = workspace.locator(".team-invite").filter({ hasText: "amal@northstar.example" });
  const verify = async (state: NativeAccountObservation["state"]) => {
    await expect(member.locator("[data-native-observation]")).toHaveAttribute("data-native-observation", state);
    await expect(workspaceMember.locator("[data-native-observation]")).toHaveAttribute("data-native-observation", state);
    await expect(workspace.getByRole("button", { name: t("tenant.workspaceAccess.review"), exact: true })).toHaveCount(0);
    await expect(member.locator(".status")).toHaveCount(1);
  };
  await verify("VERIFIED");
  const sourceState = await member.locator(".status").innerText();
  for (const state of ["DRIFT", "UNAVAILABLE", "UNVERIFIED"] as const) {
    observation = { state, checkedAt: state === "DRIFT" ? "2026-10-16T10:01:00Z" : null, revision: 7, nativeUserId: "21" };
    await page.reload();
    await verify(state);
    await expect(member.locator(".status")).toHaveText(sourceState);
    await expect(workspace).toContainText(t("tenant.workspaceAccess.state.READY"));
  }
  observation = undefined;
  await page.reload();
  await verify("UNVERIFIED");
  observation = { state: "VERIFIED", checkedAt: "2026-10-16T10:02:00Z", revision: 7, nativeUserId: "21" };
  await page.reload();
  await verify("VERIFIED");
  // The older successful status response must not replace a later drift result.
  let started!: () => void; let release!: () => void;
  const readStarted = new Promise<void>(resolve => { started = resolve; });
  hold = { started, release: new Promise<void>(resolve => { release = resolve; }) };
  const reload = workspace.getByRole("button", { name: t("tenant.team.actions.reload"), exact: true });
  await reload.click(); await readStarted;
  observation = { ...observation, state: "DRIFT" };
  await reload.click();
  await verify("DRIFT");
  const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/team/workspace-access");
  release(); await (await lateResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await verify("DRIFT");
  failWorkspace = true;
  await reload.click();
  await verify("UNAVAILABLE");
  failWorkspace = false;
  await reload.click();
  await verify("DRIFT");
  // A new native revision for suspended Source membership must not turn the stale ACTIVE Team row green.
  sourceMemberState = "SUSPENDED";
  observation = { ...observation, state: "VERIFIED", revision: 8 };
  await reload.click();
  await expect(workspaceMember.locator("[data-native-observation]")).toHaveAttribute("data-native-observation", "VERIFIED");
  await expect(member.locator("[data-native-observation]")).toHaveAttribute("data-native-observation", "UNVERIFIED");
  await expect(member.locator(".status")).toHaveText(sourceState);
  await page.reload();
  await verify("VERIFIED");
  await expect(member.locator(".status")).not.toHaveText(sourceState);
  expect(writes).toEqual([]);
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
  await testInfo.attach("account-observation-warning", { body: await page.screenshot(), contentType: "image/png" });
}

/** Local portal UI contract; no external identity, invitation or ticket effects. */
export async function workspaceAccessJourney(page: Page, testInfo: TestInfo, locale: "en" | "ar", owner: boolean) {
  const messages: Readonly<Record<string, string>> = locale === "ar"
    ? { ...arabicTenantMessages, ...arabicAutomationMessages }
    : { ...englishTenantMessages, ...englishAutomationMessages };
  const t = (key: string) => messages[key]!;
  const member = { user_id: "32000000-0000-4000-8000-000000000005", revision: 1, applied_revision: 0, native_user_id: null as string | null, member_state: "ACTIVE", sync_state: "ADOPTION_REQUIRED", nativeObservation: undefined as NativeAccountObservation | undefined };
  let enabled = false;
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/team/workspace-access*", async route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      writes.push(body);
      if (body.action === "enable") enabled = true;
      else {
        expect(body).toMatchObject({ action: "reconcile", userId: member.user_id, expectedRevision: member.revision });
        if (member.sync_state === "ADOPTION_REQUIRED") expect(body.adoptUserId).toBe("21");
        else expect(body.prerequisiteChange).toBe("Service connection verified");
        member.sync_state = "READY";
        member.revision += 1;
        member.applied_revision = member.revision;
        member.native_user_id = "21";
        member.nativeObservation = { state: "VERIFIED", checkedAt: "2026-10-16T10:00:00Z", revision: member.revision, nativeUserId: "21" };
      }
      await route.fulfill({ json: {} });
    } else if (new URL(route.request().url()).searchParams.has("userId")) {
      await route.fulfill({ json: { candidates: [{ id: "21", name: "Amal Rahman", email: "amal@northstar.example", active: true }] } });
    } else await route.fulfill({ json: { enabled, members: enabled ? [member] : [] } });
  });
  await page.goto("/app?view=team");
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  const section = page.getByRole("region", { name: t("tenant.workspaceAccess.title"), exact: true });
  await expect(section).toContainText(t("tenant.workspaceAccess.onboarding"));
  await expect(section).toContainText(t("tenant.workspaceAccess.disabled"));
  const enable = section.getByRole("button", { name: t("tenant.workspaceAccess.enable"), exact: true });
  if (!owner) {
    await expect(enable).toHaveCount(0);
    await expect(section).toContainText(t("tenant.workspaceAccess.ownerOnly"));
    enabled = true;
    await section.getByRole("button", { name: t("tenant.team.actions.reload"), exact: true }).click();
    await expect(section).toContainText(t("tenant.workspaceAccess.state.ADOPTION_REQUIRED"));
    await expect(section.getByRole("button", { name: t("tenant.workspaceAccess.review") })).toHaveCount(0);
    expect(writes).toEqual([]);
    return;
  }
  await enable.click();
  let dialog = page.getByRole("dialog", { name: t("tenant.workspaceAccess.enable"), exact: true });
  await expect(dialog.getByRole("button", { name: t("tenant.workspaceAccess.apply") })).toBeDisabled();
  await expect(dialog).toContainText("Amal Rahman");
  await page.keyboard.press("Escape");
  await expect(enable).toBeFocused();
  expect(writes).toEqual([]);
  await enable.click();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: t("tenant.workspaceAccess.apply") }).click();
  await expect(section).toContainText(t("tenant.workspaceAccess.enabled"));
  await expect(section).toContainText(t("tenant.workspaceAccess.state.ADOPTION_REQUIRED"));
  await section.getByRole("button", { name: t("tenant.workspaceAccess.review") }).click();
  dialog = page.getByRole("dialog", { name: t("tenant.workspaceAccess.review"), exact: true });
  await expect(dialog.getByRole("combobox")).toContainText("Amal Rahman");
  await dialog.getByRole("checkbox").check();
  await expect(dialog.getByRole("button", { name: t("tenant.workspaceAccess.apply") })).toBeDisabled();
  await dialog.getByRole("combobox").selectOption("21");
  const consentBounds = await dialog.getByRole("checkbox").boundingBox();
  expect(consentBounds?.width).toBeLessThanOrEqual(24);
  const dialogBounds = await dialog.locator(".workspace-access-dialog").boundingBox();
  const guidanceBounds = await dialog.locator(".workspace-access-dialog > p").boundingBox();
  expect(guidanceBounds!.x).toBeGreaterThan(dialogBounds!.x + 12);
  expect(guidanceBounds!.x + guidanceBounds!.width).toBeLessThan(dialogBounds!.x + dialogBounds!.width - 12);
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(accessibility.violations.map(({ id }) => id)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`workspace-adoption-${locale}.png`), fullPage: true });
  await dialog.getByRole("button", { name: t("tenant.workspaceAccess.apply") }).click();
  await expect(section).toContainText(t("tenant.workspaceAccess.state.READY"));
  await expect(section).toContainText(t("tenant.workspaceAccess.observation.VERIFIED"));
  await page.reload();
  await expect(section).toContainText(t("tenant.workspaceAccess.state.READY"));
  expect(writes).toHaveLength(2);
  member.sync_state = "UNAVAILABLE";
  await section.getByRole("button", { name: t("tenant.team.actions.reload"), exact: true }).click();
  await expect(section).toContainText(t("tenant.workspaceAccess.state.UNAVAILABLE"));
  expect(writes).toHaveLength(2);
  await section.getByRole("button", { name: t("tenant.workspaceAccess.review") }).click();
  await dialog.getByRole("textbox").fill("Service connection verified");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: t("tenant.workspaceAccess.apply") }).click();
  await expect(section).toContainText(t("tenant.workspaceAccess.state.READY"));
  expect(writes).toHaveLength(3);
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
  const readyMember = section.locator(".team-invite").filter({ hasText: "Amal Rahman" });
  const memberName = await readyMember.getByText("Amal Rahman", { exact: true }).boundingBox();
  const memberEmail = readyMember.getByText("amal@northstar.example", { exact: true });
  await expect(memberEmail).toHaveCSS("direction", "ltr");
  const emailBounds = await memberEmail.boundingBox();
  expect(memberName).not.toBeNull();
  expect(emailBounds).not.toBeNull();
  const nameEdge = locale === "ar" ? memberName!.x + memberName!.width : memberName!.x;
  const emailEdge = locale === "ar" ? emailBounds!.x + emailBounds!.width : emailBounds!.x;
  expect(Math.abs(nameEdge - emailEdge)).toBeLessThanOrEqual(1);
  const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  expect(width.document).toBeLessThanOrEqual(width.viewport);
  const application = page.locator('[data-application-ready="true"]');
  const capture = (theme: "light" | "dark") => section.screenshot({
    path: `output/playwright/workspace-invitation/workspace-access-ready-${testInfo.project.name}-${theme}-${locale}.png`,
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });
  await expect(application).toHaveClass("theme-dark");
  const dark = await capture("dark");
  await testInfo.attach(`workspace-access-${locale}`, { body: dark, contentType: "image/png" });
  await page.getByRole("button", { name: t("tenant.theme.switchLight"), exact: true }).click();
  await expect(application).toHaveClass("theme-light");
  await capture("light");
}

export async function supportScopeJourney(page: Page, testInfo: TestInfo, locale: "en" | "ar") {
  const messages: Readonly<Record<string, string>> = locale === "ar" ? arabicAutomationMessages : englishAutomationMessages;
  const t = (key: string) => messages[key]!;
  // Read the actual fixture server responses through the supported request
  // interceptor; the browser response-body reader can remain pending on Windows.
  let savedVersion: { id: string; version: number } | undefined;
  let simulatedResult: { status: string } | undefined;
  let queueUnavailable = false;
  await page.route("**/api/zammad/routing-catalogs", async route => {
    const response = await route.fetch();
    const catalog = await response.json() as { groups: Array<{ id: string; active: boolean; serviceIdentityCanCreate: boolean }> };
    if (queueUnavailable) catalog.groups = catalog.groups.map(group => group.id === "2"
      ? { ...group, active: false, serviceIdentityCanCreate: false } : group);
    await route.fulfill({ response, json: catalog });
  });
  const detailUrl = /\/api\/client-routing\/[0-9a-f-]{36}$/u;
  let releaseDetail!: () => void;
  const detailGate = new Promise<void>(resolve => { releaseDetail = resolve; });
  const detailRequest = page.waitForRequest(request => detailUrl.test(new URL(request.url()).pathname));
  await page.route(detailUrl, async route => {
    const response = await route.fetch();
    await detailGate;
    await route.fulfill({ response });
  });
  await page.route("**/api/client-routing", async route => {
    const response = await route.fetch();
    if (route.request().method() === "POST") savedVersion = await response.json();
    await route.fulfill({ response });
  });
  await page.route("**/api/client-routing/simulate", async route => {
    const response = await route.fetch();
    simulatedResult = await response.json();
    await route.fulfill({ response });
  });
  await page.goto("/app?view=routing");
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  await detailRequest;
  const newDraft = page.getByRole("button", { name: t("routing.versions.new"), exact: true });
  try { await expect(newDraft).toBeDisabled(); }
  finally { releaseDetail(); }
  const rawDefinition = page.locator(".routing-detail .routing-raw pre");
  await expect(rawDefinition).toContainText('"supportGroupIds"');
  const originalDefinition = await rawDefinition.textContent();
  queueUnavailable = true;
  await page.reload();
  const availability = page.locator('.routing-detail [role="status"]').filter({ hasText: t("routing.availability.title") });
  await expect(availability).toContainText("Riyadh Operations");
  await expect(availability).toContainText(t("routing.availability.inactive"));
  await expect(availability).toContainText(t("routing.availability.noServiceAccess"));
  expect(await rawDefinition.textContent()).toBe(originalDefinition);
  expect(savedVersion).toBeUndefined();
  queueUnavailable = false;
  await page.reload();
  await expect(rawDefinition).toContainText('"supportGroupIds"');
  await expect(availability).toHaveCount(0);
  expect(await rawDefinition.textContent()).toBe(originalDefinition);
  await newDraft.click();
  const editor = page.locator("form.routing-editor");
  // A new draft carries the active version's support queues forward and says so.
  await expect(editor.getByText(t("routing.editor.supportFromActive"), { exact: true })).toBeVisible();
  const name = `Support scope ${locale} ${testInfo.project.name}`;
  await editor.getByLabel(t("routing.editor.versionName"), { exact: true }).fill(name);
  await editor.getByRole("combobox", { name: t("routing.editor.fallbackTeam"), exact: true }).selectOption("2");
  const scope = editor.getByRole("group", { name: t("routing.editor.supportEntries"), exact: true });
  await scope.getByRole("checkbox", { name: "Riyadh Operations", exact: true }).uncheck();
  await expect(scope.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await scope.getByRole("checkbox", { name: "Riyadh Operations", exact: true }).check();
  const supportCheckbox = scope.getByRole("checkbox", { name: "Riyadh Operations", exact: true });
  await supportCheckbox.focus();
  await expect(supportCheckbox).toBeFocused();
  await page.keyboard.press("Space");
  await expect(supportCheckbox).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(supportCheckbox).toBeChecked();
  const supportLayout = await supportCheckbox.evaluate(input => {
    const label = input.closest("label")!;
    const text = [...label.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
    if (!text) throw new Error("Support queue label text is missing");
    const range = document.createRange();
    range.selectNodeContents(text);
    return { control: input.getBoundingClientRect().toJSON(), label: label.getBoundingClientRect().toJSON(), text: range.getBoundingClientRect().toJSON() };
  });
  expect(supportLayout.control.width).toBeLessThanOrEqual(24);
  expect(supportLayout.control.height).toBeLessThanOrEqual(24);
  expect(supportLayout.control.width).toBeGreaterThanOrEqual(16);
  expect(supportLayout.control.height).toBeGreaterThanOrEqual(16);
  expect(supportLayout.label.height).toBeGreaterThanOrEqual(44);
  expect(Math.abs(supportLayout.control.y + supportLayout.control.height / 2 - supportLayout.text.y - supportLayout.text.height / 2)).toBeLessThanOrEqual(4);
  const labelGap = locale === "ar" ? supportLayout.control.x - supportLayout.text.right : supportLayout.text.x - supportLayout.control.right;
  expect(labelGap).toBeGreaterThanOrEqual(4);
  expect(labelGap).toBeLessThanOrEqual(16);

  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(accessibility.violations.map(({ id }) => id)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`support-scope-${locale}.png`), fullPage: true });
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/client-routing" && response.request().method() === "POST");
  await editor.getByRole("button", { name: t("routing.editor.create"), exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON().supportGroupIds).toEqual(["2"]);
  expect(savedVersion).toBeDefined();
  await expect(editor).toHaveCount(0);
  const selected = page.locator(".bot-version-list button").filter({ has: page.getByText(t("routing.versions.version").replace("{version}", formatNumber(savedVersion!.version, locale)), { exact: true }) });
  await selected.click();
  const simulator = page.locator("form.routing-simulator");
  await simulator.getByRole("combobox", { name: t("routing.simulator.entryGroup"), exact: true }).selectOption("3");
  const simulated = page.waitForResponse(response => new URL(response.url()).pathname === "/api/client-routing/simulate");
  await simulator.getByRole("button", { name: t("routing.simulator.test"), exact: true }).click();
  const simulation = await simulated;
  expect(simulation.request().postDataJSON()).toMatchObject({ versionId: savedVersion!.id, match: { entryGroupId: "3" } });
  expect(simulatedResult).toMatchObject({ status: "DEPARTMENT" });
  await expect(simulator).toContainText(t("routing.simulator.department"));
  await expect(simulator).not.toContainText(t("routing.simulator.conflict"));
  await expect(simulator).not.toContainText("Review: .");
  await simulator.screenshot({ path: testInfo.outputPath(`department-result-${locale}.png`) });
}
