import { installWorkspaceReadFixture } from "./workspace-read.fixture";
import { auditWorkspaceJourney } from "./audit-workspace.fixture";
import { consumeExpectedPrivacyResponse, registerPrivacySettingsJourneys } from "./privacy-settings.fixture";
import { consumeExpectedLegacyDenial, metaLegacyMigrationJourney } from "./meta-legacy-migration.fixture";
import { consumeExpectedRoutingDenial, installMetaRoutingReadFixture, metaRoutingJourney } from "./meta-routing.fixture";
import { consumeExpectedCoexistenceDenial, metaCoexistenceJourney } from "./meta-coexistence.fixture";
import { consumeExpectedTemplateDenial, metaTemplatePreparationJourney } from "./meta-template-preparation.fixture";
import { consumeExpectedAddAccessDenial, metaAddAccessJourney } from "./meta-add-access.fixture";
import {consumeExpectedActivationDenial,metaSavedActivationJourney} from "./meta-saved-activation.fixture";
import {consumeExpectedNumberReleaseDenial,metaNumberReleaseJourney} from "./meta-number-release.fixture";
import { consumeExpectedReconnectDenial, metaReconnectJourney } from "./meta-reconnect.fixture";
import { metaDeletionStatusJourney } from "./meta-deletion.fixture";
import { keepOpenPolicyJourney } from "./keep-open-policy.fixture";
import { handoffRetryJourney } from "./handoff-retry.fixture";
import { fixedHandoffOwnerJourney, nativeRoutingSyncJourney } from "./native-routing-sync.fixture";
import { accountObservationJourney, consumeExpectedObservationFailure, workspaceAccessJourney, supportScopeJourney } from "./workspace-access.fixture";
import { consumeExpectedDirectSetupDenial, metaDirectConsentJourney } from "./meta-direct-consent.fixture";
import { consumeExpectedSignupDenial, metaSignupJourney } from "./meta-signup.fixture";
import { ticketEventWorkflowJourney } from "./ticket-event-workflows.fixture";
import { registerOperationsScreenshots } from "./operations-screenshots.fixture";
import type { TeamAccessData } from "../../lib/control-plane-data";
import { expectAxeClean } from "../helpers/axe";
import { captureTenantDesign, verifyRuleModalLabels } from "./design-evidence.fixture";
import { expect, test, type Page } from "@playwright/test";

const role = process.env.WASALX_E2E_ROLE ?? "tenant_owner";
registerPrivacySettingsJourneys("en", role);
if (role === "tenant_owner") registerOperationsScreenshots("en");
test("Audit uses localized workspace actions and truthful actors with permitted CSV export", { tag: "@tablet" }, async ({ page }, testInfo) => {
  await auditWorkspaceJourney(page, "en", role, testInfo);
});
test("retryable human handoff has a fenced operator retry without resume or close", async ({ page }) => {
  await handoffRetryJourney(page, "en", role);
});

test("native routing sync keeps explicit queue policies separate from native readback", async ({ page }, testInfo) => {
  await nativeRoutingSyncJourney(page, testInfo, "en", role);
});
test("fixed handoff agent selection preserves explicit and omitted immutable draft behavior", async ({ page }, testInfo) => {
  test.skip(role !== "tenant_owner");
  await fixedHandoffOwnerJourney(page, testInfo, "en");
});
(role !== "agent" ? test : test.skip)("linked account observations warn without changing Source membership", async ({ page }, testInfo) => {
  await accountObservationJourney(page, testInfo, "en");
});

test("Meta saved access enables receiving only after current checks", async ({page},testInfo)=>{
 await metaSavedActivationJourney(page,"en",role,testInfo);
});

test("Meta number release preserves reservation review and exact uncertain recovery",async({page},testInfo)=>{
 await metaNumberReleaseJourney(page,'en',role,testInfo);
});

test("Meta existing-number access stays paused and recovers without registration or replay", async ({ page }, testInfo) => {
  await metaAddAccessJourney(page, "en", role, testInfo);
});

test("Meta external routing preserves exact lost-response recovery and separate bot state", async ({ page }, testInfo) => {
  await metaRoutingJourney(page, "en", role, testInfo);
});

test("Meta Business app consent and inert imports preserve unknown and stopped states", async ({ page }, testInfo) => {
  await metaCoexistenceJourney(page, "en", role, testInfo);
});

test("Meta legacy move retains original requests, one-use access and paused completion", async ({ page }, testInfo) => {
  test.skip(!["tenant_owner", "tenant_admin"].includes(role) && testInfo.project.name !== "desktop");
  await metaLegacyMigrationJourney(page, "en", role, testInfo);
});

test("Meta template preparation retains original requests and never grants number transfer", async ({ page }, testInfo) => {
  test.skip(!["tenant_owner", "tenant_admin"].includes(role) && testInfo.project.name !== "desktop");
  await metaTemplatePreparationJourney(page, "en", role, testInfo);
});



test("Meta reconnect renews exact paused access without activating the connection", async ({ page }, testInfo) => {
  await metaReconnectJourney(page, "en", role, testInfo);
});



test("Meta signup keeps callback, selection and recovery bound to the active attempt", async ({ page }, testInfo) => {
  await metaSignupJourney(page, "en", role, testInfo);
});

(role !== "agent" ? test : test.skip)("workspace membership linking preserves explicit review and access boundaries", async ({ page }, testInfo) => {
  await workspaceAccessJourney(page, testInfo, "en", role === "tenant_owner");
});
(role === "tenant_owner" ? test : test.skip)("support scope preserves department assignment", async ({ page }, testInfo) => {
  await supportScopeJourney(page, testInfo, "en");
});
test("Meta direct setup and later Groups consent remain independent", async ({ page }, testInfo) => {
  await metaDirectConsentJourney(page, "en", role, testInfo);
});

const personas: Record<string, { name: string; label: string }> = {
  tenant_owner: { name: "Maya Al-Salem", label: "Tenant owner" },
  tenant_admin: { name: "Omar Haddad", label: "Tenant administrator" },
  supervisor: { name: "Sara Khan", label: "Supervisor" },
  agent: { name: "Amal Rahman", label: "Agent" },
  auditor: { name: "Faisal Noor", label: "Auditor" },
};

const titles: Record<string, string> = {
  overview: "Operational overview",
  inbox: "Inbox",
  connections: "Connections",
  groups: "Managed groups",
  rules: "Identifier rules",
  automation: "Workflows",
  plugins: "Plugins",
  routing: "Client routing",
  cases: "Cases",
  deliveries: "Message delivery",
  team: "Team & access",
  support: "Support access",
  audit: "Audit trail",
  settings: "Workspace settings",
};

const navigationByRole: Record<string, string[]> = {
  tenant_owner: ["Overview", "Inbox", "Connections", "Groups", "Rules", "Workflows", "Plugins", "Client routing", "Cases", "Deliveries", "Team & access", "Support access", "Audit", "Settings"],
  tenant_admin: ["Overview", "Inbox", "Connections", "Groups", "Rules", "Workflows", "Plugins", "Client routing", "Cases", "Deliveries", "Team & access", "Support access", "Audit", "Settings"],
  supervisor: ["Overview", "Inbox", "Connections", "Groups", "Rules", "Workflows", "Plugins", "Client routing", "Cases", "Deliveries", "Team & access", "Audit", "Settings"],
  agent: ["Overview", "Inbox", "Connections", "Groups", "Rules", "Workflows", "Plugins", "Client routing", "Deliveries"],
  auditor: ["Overview", "Connections", "Groups", "Rules", "Workflows", "Plugins", "Client routing", "Cases", "Deliveries", "Team & access", "Support access", "Audit", "Settings"],
};

const viewForNavigation: Record<string, string> = {
  Overview: "overview",
  Inbox: "inbox",
  Connections: "connections",
  Groups: "groups",
  Rules: "rules",
  Workflows: "automation",
  Plugins: "plugins",
  "Client routing": "routing",
  Cases: "cases",
  Deliveries: "deliveries",
  "Team & access": "team",
  "Support access": "support",
  Audit: "audit",
  Settings: "settings",
};

const pageProblems = new WeakMap<Page, string[]>();
const expectedNetworkErrors = new WeakMap<Page, RegExp[]>();
(role === "tenant_owner" ? test : test.skip)("alpha repair union renders truthful case team and paused summaries", async ({ page }, testInfo) => {
  test.skip(!["desktop", "mobile-390"].includes(testInfo.project.name));
  let linked = false;
  await page.route("**/api/cases*", async route => {
    const response = await route.fetch();
    const rows = await response.json() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(1);
    const ended = { ...rows[0], state: "DETACHED", detached_at: new Date(Date.now() + 120_000).toISOString(), predecessor_correlation_id: null, replaced_by_correlation_id: linked ? rows[1].id : null };
    const current = { ...rows[1], state: "OPEN", predecessor_correlation_id: linked ? rows[0].id : null, replaced_by_correlation_id: null };
    await route.fulfill({ response, json: [ended, current] });
  });
  await open(page, "cases");
  const past = page.getByText("Past links", { exact: true }).locator("..");
  await expect(past.locator("strong")).toHaveText("1");
  await expect(page.getByText("Link ended now", { exact: true })).toBeVisible();
  linked = true;
  await page.reload();
  await expect(past.locator("strong")).toHaveText("1");

  await page.route("**/api/team", async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.capabilities.can_invite = false;
    data.invitations = [];
    await route.fulfill({ response, json: data });
  });
  await open(page, "team");
  const pending = page.locator(".team-summary > div").filter({ has: page.getByText("Pending invitations", { exact: true }) });
  await expect(pending).toContainText("Invitation details are restricted");
  await expect(pending.locator("strong")).not.toHaveText("0");
  await expect(pending).not.toContainText("No invitations waiting");

  await page.route("**/api/dashboard", async route => {
    const response = await route.fetch();
    const data = await response.json();
    const row = data.data.connections.find((item: Record<string, unknown>) => item.id === "12000000-0000-4000-8000-000000000001");
    expect(row).toBeTruthy();
    Object.assign(row, { state: "PAUSED", provider_state: "STOPPED", provider_session_state: "STOPPED", action_reason: "The connection is paused." });
    await route.fulfill({ response, json: data });
  });
  await open(page, "connections");
  const refreshed = page.waitForResponse(response => response.url().endsWith("/api/dashboard"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await refreshed;
  const paused = page.getByRole("row", { name: /Operations line/u });
  await expect(paused).toContainText("Paused");
  await expect(paused).not.toContainText("Attention needed");
  await expect(page.getByRole("row", { name: /Returns desk/u })).toContainText("Action required");
});

(role === "tenant_owner" ? test : test.skip)("alpha repair union clones one rule draft after an uncertain response", async ({ page }, testInfo) => {
  test.skip(!["desktop", "mobile-390"].includes(testInfo.project.name));
  await open(page, "rules");
  await page.getByRole("button", { name: "Compare versions", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Compare, activate, or roll back" });
  const original = dialog.locator(".rule-version-list > article").first();
  await expect(original.getByRole("button", { name: "New draft version", exact: true })).toBeEnabled();
  const before = await dialog.locator(".rule-version-list > article").count();
  const keys: string[] = [];
  const results: Array<{ resultId: string; duplicate: boolean }> = [];
  expectNetworkFailure(page, /\/api\/rule-sets\/[^/]+\/clone$/u);
  await page.route("**/api/rule-sets/*/clone", async route => {
    keys.push(route.request().headers()["idempotency-key"]);
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    results.push(await response.json());
    if (keys.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  await original.getByRole("button", { name: "New draft version", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await original.getByRole("button", { name: "New draft version", exact: true }).click();
  await expect(dialog.locator(".rule-version-list > article")).toHaveCount(before + 1);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(results[1].resultId).toBe(results[0].resultId);
  expect(results[1].duplicate).toBe(true);
  await expect(dialog.getByRole("combobox", { name: "From", exact: true })).toHaveValue(results[0].resultId);
  await expect(dialog.locator(".rule-version-list > article").filter({ hasText: "Draft" }).getByRole("button", { name: "Activate…", exact: true }).last()).toBeVisible();
});

(role === "tenant_owner" ? test : test.skip)("alpha repair union loads pinned execution detail and fences stale same-target requests", async ({ page }, testInfo) => {
  test.skip(!["desktop", "mobile-390"].includes(testInfo.project.name));
  await open(page, "automation");
  await page.getByRole("tab", { name: "Conversations", exact: true }).click();
  const opener = page.getByRole("article").filter({ hasText: /Support case.*#10421/u }).getByRole("button", { name: "View execution history" });
  // Existing fixture: conversation850...001 is pinned to flow820...001;
  // definition nodes welcome/location/handoff are real fixture schema nodes.
  const endpoint = "**/api/bot-flows/82000000-0000-4000-8000-000000000001";
  let mode: "fail" | "hold" | "pass" = "fail";
  const releases: Array<() => void> = [];
  let requests = 0;
  expectNetworkFailure(page, /\/api\/bot-flows\/82000000-0000-4000-8000-000000000001$/u);
  await page.route(endpoint, async route => {
    requests += 1;
    const currentMode = mode;
    if (currentMode === "fail") {
      await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
      return;
    }
    const response = await route.fetch();
    if (currentMode === "hold") await new Promise<void>(resolve => releases.push(resolve));
    // Closing the viewer intentionally cancels its fetch; fulfilling that
    // cancelled request can fail in Playwright and must not mask other errors.
    try { await route.fulfill({ response }); }
    catch (error) { if (!/cancel|closed|disposed|invalid interception/iu.test(String(error))) throw error; }
  });
  const dialog = page.getByRole("dialog", { name: /Execution history.*#10421/u });
  await opener.click();
  await expect(dialog.getByRole("alert")).toContainText("Execution history could not be loaded");
  mode = "pass";
  await dialog.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(dialog).toContainText("Request location");
  await expect(dialog).not.toContainText("Unavailable workflow step");
  await page.keyboard.press("Escape");
  mode = "hold";
  const before = requests;
  await opener.click();
  await expect.poll(() => releases.length).toBe(1);
  await expect(dialog.locator('[aria-busy="true"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await opener.click();
  await expect.poll(() => releases.length).toBe(2);
  releases[0]();
  await expect(dialog.locator('[aria-busy="true"]')).toBeVisible();
  releases[1]();
  await expect(dialog).toContainText("Request location");
  await expect(dialog.locator('[aria-busy="true"]')).toHaveCount(0);
  expect(requests - before).toBe(2);
});

test.beforeEach(async ({ page }) => {
  await installMetaRoutingReadFixture(page);
  await installWorkspaceReadFixture(page, role);
  const problems: string[] = [];
  pageProblems.set(page, problems);
  expectedNetworkErrors.set(page, []);
  page.on("console", (message) => {
    if (message.type() === "error") {
      if (consumeExpectedNumberReleaseDenial(page, message) || consumeExpectedPrivacyResponse(page, message) || consumeExpectedActivationDenial(page, message) || consumeExpectedDirectSetupDenial(page, message) || consumeExpectedSignupDenial(page, message) || consumeExpectedReconnectDenial(page, message) || consumeExpectedCoexistenceDenial(page, message) || consumeExpectedAddAccessDenial(page, message) || consumeExpectedRoutingDenial(page, message) || consumeExpectedTemplateDenial(page, message) || consumeExpectedLegacyDenial(page, message) || consumeExpectedObservationFailure(page, message)) return;
      const location = message.location().url;
      if (
        message.text().startsWith("Failed to load resource:") &&
        expectedNetworkErrors.get(page)?.some((pattern) => pattern.test(location))
      ) return;
      problems.push(`console: ${message.text()}${location ? ` · ${location}` : ""}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  expect(pageProblems.get(page) ?? [], "the browser must not emit console errors or uncaught exceptions").toEqual([]);
});

async function open(page: Page, view = "overview") {
  await page.goto(view === "overview" ? "/app" : `/app?view=${view}`);
  await expect(page.getByRole("heading", { level: 1, name: titles[view] })).toBeVisible();
  // SSR can paint before React installs event delegation. The application
  // readiness marker is set by the first client effect and is not blocked by
  // vinext optimization and prefetch traffic.
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  await expect(page).toHaveTitle(`${titles[view]} · WasalX`);
}

if (role === "tenant_owner") {
  test("owner captures tenant surfaces in light and dark", async ({ page }, testInfo) => {
    await captureTenantDesign(page, testInfo, "en", open);
  });
  test("rule modal labels every visible field", async ({ page }, testInfo) => {
    await open(page, "rules");
    await verifyRuleModalLabels(page, testInfo, "en");
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function navigationLink(page: Page, name: string) {
  return page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: new RegExp(`${escapeRegExp(name)}(?:\\s+\\d+)?$`, "u") });
}

async function navigateFromSidebar(page: Page, name: string, projectName: string) {
  if (projectName === "mobile-390") {
    const menu = page.getByRole("button", { name: "Menu" });
    if (await menu.getAttribute("aria-expanded") === "false") await menu.click();
  }
  await navigationLink(page, name).click();
}

function expectNetworkFailure(page: Page, pattern: RegExp) {
  expectedNetworkErrors.get(page)?.push(pattern);
}

(role === "tenant_owner" ? test : test.skip)("routing source failures use safe feedback and recover without mutations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  expectNetworkFailure(page, /\/api\/client-routing\/sources$/u);
  const mutations: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/client-routing") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) mutations.push(request.method());
  });
  await open(page, "routing");
  await expect(page.getByText("Version 8", { exact: true })).toBeVisible();
  await expect(page.locator(".bot-version-list button.selected .status")).toHaveText("Active");
  for (const mode of ["transport", "invalid-json"] as const) {
    let intercepted = 0;
    await page.route("**/api/client-routing/sources", async route => {
      expect(route.request().method()).toBe("GET");
      intercepted++;
      if (mode === "transport") await route.abort("failed");
      else await route.fulfill({ status: 200, contentType: "application/json", body: "PRIVATE_TEST_SENTINEL" });
    });
    await page.reload();
    const alert = page.locator(".routing-source-error[role=alert]");
    await expect(alert.locator("span")).toHaveText(mode === "transport" ? "Check your connection and try again." : "Connector status is unavailable.");
    expect(intercepted).toBeGreaterThan(0);
    await expect(page.getByText("Acme Logistics", { exact: true })).toBeVisible();
    await page.unroute("**/api/client-routing/sources");
    await alert.getByRole("button").click();
    await expect(alert).toHaveCount(0);
    await expect(page.getByText("Version 8", { exact: true })).toBeVisible();
  }
  expect(mutations).toEqual([]);
});


test("role navigation, history, titles, profile, and persisted theme behave as one application", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop owns the exhaustive navigation transaction");
  await open(page);

  const persona = personas[role];
  await expect(page.locator(".profile")).toContainText(persona.name);
  await expect(page.locator(".profile")).toContainText(persona.label);
  await expect(page.locator(".workspace-switcher")).toHaveAttribute("role", "group");
  await expect(page.locator(".profile")).toHaveAttribute("role", "group");
  const sidebarPin = page.getByRole("button", { name: "Pin sidebar open" });
  await expect(sidebarPin).toHaveAttribute("aria-pressed", "false");
  await sidebarPin.click();
  await expect(page.getByRole("button", { name: "Use automatic sidebar" })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: "Use automatic sidebar" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Use automatic sidebar" }).click();
  await expect(page.getByRole("button", { name: "Pin sidebar open" })).toHaveAttribute("aria-pressed", "false");

  const primary = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(primary.getByRole("link")).toHaveCount(navigationByRole[role].length);
  for (const name of navigationByRole[role]) {
    await expect(navigationLink(page, name)).toBeVisible();
  }

  for (const name of navigationByRole[role]) {
    const view = viewForNavigation[name];
    await navigationLink(page, name).click();
    await expect(page.getByRole("heading", { level: 1, name: titles[view] })).toBeVisible();
    await expect(page).toHaveTitle(`${titles[view]} · WasalX`);
    await expect(page).toHaveURL(view === "overview" ? /^http:\/\/localhost:\d+\/app\/?$/u : new RegExp(`[?&]view=${view}(?:&|$)`, "u"));
  }

  await navigationLink(page, "Overview").click();
  const workingConnections = page.getByRole("button", { name: /Working connections/u });
  await expect(workingConnections).toContainText("1 / 2");
  let readinessRefreshes = 0;
  await page.route("**/api/dashboard", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { data: { connections: Array<Record<string, unknown>> } };
    readinessRefreshes += 1;
    Object.assign(body.data.connections[1], {
      state: "WORKING",
      provider: "META",
      provider_session_state: "WORKING",
      provider_state: readinessRefreshes > 1 ? "AVAILABLE" : "UNAVAILABLE",
      webhook_state: "ACTIVE",
      last_heartbeat_at: new Date().toISOString(),
      last_provider_event_at: readinessRefreshes > 1 ? new Date().toISOString() : null,
      last_processed_provider_message_at: readinessRefreshes > 1 ? new Date().toISOString() : null,
      meta_routing_configuration_ready: true,
      webhook_admission_opened_at: new Date(Date.now() - 1_000).toISOString(),
    });
    await route.fulfill({ response, json: body });
  });
  const dashboardRefresh = page.waitForResponse((response) => response.url().endsWith("/api/dashboard"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await dashboardRefresh;
  await expect(workingConnections).toContainText("1 / 2");
  const recoveredDashboardRefresh = page.waitForResponse((response) => response.url().endsWith("/api/dashboard"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await recoveredDashboardRefresh;
  await expect(workingConnections).toContainText("2 / 2");
  await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/app\/?$/u);
  await expect(page).toHaveTitle("Operational overview · WasalX");
  await navigationLink(page, "Connections").click();
  await navigationLink(page, "Groups").click();
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
  await expect(page).toHaveTitle("Connections · WasalX");

  const themeButton = page.getByRole("button", { name: /Switch to (light|dark) theme/u });
  const initialThemeLabel = await themeButton.getAttribute("aria-label");
  await themeButton.click();
  await expect(themeButton).not.toHaveAttribute("aria-label", initialThemeLabel ?? "");
  const persistedThemeLabel = await themeButton.getAttribute("aria-label");
  await page.reload();
  await expect(page.getByRole("button", { name: persistedThemeLabel ?? "" })).toBeVisible();

  await navigationLink(page, "Connections").click();
  await page.keyboard.press("Meta+K");
  await expect(page.getByLabel("Search numbers or connection methods")).toBeFocused();
  await expect(page.getByRole("heading", { level: 2, name: "Messaging connections" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Data services" })).toBeVisible();
  await page.getByLabel("Filter connections by state").selectOption("ACTION_REQUIRED");
  await expect(page.getByRole("row", { name: /Returns desk/u })).toBeVisible();
  await expect(page.getByRole("row", { name: /Operations line/u })).toHaveCount(0);

  await expectAxeClean(page);
});

test("data-service connections remain truthful, recoverable, and draft-safe", async ({ page }, testInfo) => {
  const canWrite = ["tenant_owner", "tenant_admin"].includes(role);
  const pendingKey = "wasalx:pending-data-connection";
  const connectedId = "87000000-0000-4000-8000-000000000010";
  let listRequests = 0;
  const integrations:Array<Record<string,unknown>> = canWrite ? [
    { id: connectedId, provider: "NOTION", display_name: "مستودع Northstar", binding_reference: "secret://configured", state: "CONNECTED", revision: 2 },
    { id: "87000000-0000-4000-8000-000000000011", provider: "NOTION", display_name: "Finance review", binding_reference: null, state: "CONNECTING", revision: 1 },
    { id: "87000000-0000-4000-8000-000000000012", provider: "NOTION", display_name: "Archived workspace", binding_reference: null, state: "REVOKED", revision: 1 },
  ] : [];
  await page.route("**/api/client-routing/integrations", async (route) => {
    listRequests += 1;
    await route.fulfill({ json: integrations });
  });
  if (canWrite) {
    await page.addInitScript(({ key, id }) => window.sessionStorage.setItem(key, id), { key: pendingKey, id: connectedId });
  }
  await page.goto(canWrite ? "/app?view=connections&routingIntegration=refresh" : "/app?view=connections");
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Data services" })).toBeVisible();

  if (canWrite) {
    await expect(page.locator("ul.data-connection-list")).toBeVisible();
    await expect(page.getByText("Data workspace connected. It is now available to Plugins and Client routing.", { exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/routingIntegration/u);
    await expect(page.getByText("Connecting", { exact: true })).toBeVisible();
    await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
    await expect(page.locator(".data-connection-list bdi").first()).toHaveText("مستودع Northstar");
    await expect(page.getByRole("button", { name: "Connect Finance review again" })).toBeVisible();
  } else {
    await expect(page.getByText("No data services are connected. Ask a workspace administrator to connect one.", { exact: true })).toBeVisible();
    await expect(page.getByText("Read only", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect Notion" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Connect .* again/u })).toHaveCount(0);
  }

  if(canWrite){
    const zohoId="87000000-0000-4000-8000-000000000014";
    await page.route("**/api/client-routing/integrations/credential",async route=>{const input=route.request().postDataJSON() as Record<string,unknown>;expect(input.provider).toBe("ZOHO");expect(input.authScheme).toBe("BEARER");expect(input).not.toHaveProperty("secretReference");integrations.push({id:zohoId,provider:"ZOHO",display_name:String(input.displayName),auth_scheme:"BEARER",binding_reference:"secret://configured/zoho",state:"CONNECTED",revision:2,source_id:null});await route.fulfill({status:201,json:{integrationId:zohoId,provider:"ZOHO",displayName:input.displayName,authScheme:"BEARER",bindingReference:"secret://configured/zoho",revision:2,duplicate:false}})});
    await page.getByRole("button",{name:"Add Zoho"}).click();
    await expect(page.getByRole("heading",{name:"Connect Zoho"})).toBeVisible();
    await page.getByLabel("Connection name").fill("Operations CRM");
    const token=page.getByLabel("Access token");await expect(token).toHaveAttribute("type","password");await expect(token).toHaveAttribute("autocomplete","new-password");await token.fill("fixture-zoho-token-value");
    await page.getByRole("button",{name:"Save connection"}).click();
    await expect(page.getByText("Data service connected. Choose it by name in a routing source.",{exact:true})).toBeVisible();
    await expect(page.getByText("Operations CRM",{exact:true})).toBeVisible();
    await expect(page.getByText("Choose this connection in a routing draft and activate it before testing.",{exact:true})).toBeVisible();
  }

  const requestsBeforeRefresh = listRequests;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect.poll(() => listRequests).toBeGreaterThan(requestsBeforeRefresh);

  if (canWrite) {
    await page.route("**/api/client-routing/integrations/notion/start", async (route) => {
      await route.fulfill({ json: {
        authorizationUrl: "/app?view=connections&routingIntegration=failed",
        integrationId: "87000000-0000-4000-8000-000000000013",
      } });
    });
    await page.getByRole("button", { name: "Connect Finance review again" }).click();
    await expect(page.getByText("The connection did not finish. Review its status below, then start again.", { exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/routingIntegration/u);
    expect(await page.evaluate((key) => window.sessionStorage.getItem(key), pendingKey)).toBeNull();
  }

  if (testInfo.project.name === "mobile-390") {
    await page.locator("html").evaluate((element) => { element.style.fontSize = "200%"; });
    const overflow = await page.locator(".data-connections").evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow, "data services must remain bounded at narrow 200% zoom").toBeLessThanOrEqual(1);
  }
  await expectAxeClean(page);
});

(role === "tenant_owner" ? test : test.skip)("connection catalog reports durable provider readiness instead of an optimistic database state", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/dashboard", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { data: { connections: Array<Record<string, unknown>> } };
    const connection = body.data.connections.find((row) => row.id === "12000000-0000-4000-8000-000000000001");
    if (!connection) throw new Error("Operations connection fixture is missing");
    Object.assign(connection, {
      state: "WORKING",
      provider_session_state: "WORKING",
      provider_state: "STARTING",
      webhook_state: "ACTIVE",
      onboarding_working_at: null,
      last_heartbeat_at: new Date().toISOString(),
      last_provider_event_at: new Date().toISOString(),
    });
    await route.fulfill({ response, json: body });
  });
  await open(page, "connections");
  const refresh = page.waitForResponse((response) => response.url().endsWith("/api/dashboard"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await refresh;
  const row = page.getByRole("row", { name: /Operations line/u });
  await expect(row).toContainText("Connecting");
  await page.getByLabel("Filter connections by state").selectOption("CONNECTING");
  await expect(row).toBeVisible();
});

test("WAHA group messaging policy follows settings permissions and preserves retry intent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  let reads = 0;
  const mutationKeys: string[] = [];
  let patchAttempts = 0;
  const policy = {
    connection_id: "12000000-0000-4000-8000-000000000001",
    enabled: true,
    inbound_response_only: true,
    allow_human_group_workspace_initiation: false,
    response_window_seconds: 86_400,
    connection_capacity: 3,
    connection_refill_tokens: 1,
    connection_refill_seconds: 30,
    number_capacity: 5,
    number_refill_tokens: 1,
    number_refill_seconds: 30,
    minimum_spacing_seconds: 5,
    version: 1,
  };
  await page.route("**/api/waha-outbound-safety", async (route) => {
    if (route.request().method() === "GET") {
      reads += 1;
      await route.fulfill({ json: { policies: [policy] } });
      return;
    }
    patchAttempts += 1;
    mutationKeys.push(route.request().headers()["idempotency-key"] ?? "");
    if (patchAttempts === 1) {
      await route.fulfill({ status: 503, json: { error: "Policy update could not be confirmed." } });
      return;
    }
    const input = route.request().postDataJSON() as { allowHumanGroupWorkspaceInitiation: boolean };
    await route.fulfill({ json: { ...policy, allow_human_group_workspace_initiation: input.allowHumanGroupWorkspaceInitiation, version: 2 } });
  });
  if (role === "tenant_owner") expectNetworkFailure(page, /\/api\/waha-outbound-safety$/u);

  await open(page, "connections");
  await page.getByRole("button", { name: "View Operations line connection details" }).click();
  const dialog = page.getByRole("dialog", { name: "Connection details" });
  const policyRegion = dialog.getByRole("region", { name: "Group messaging" });

  if (role === "agent") {
    await expect(policyRegion).toHaveCount(0);
    expect(reads).toBe(0);
    return;
  }

  await expect(policyRegion).toBeVisible();
  const toggle = policyRegion.getByRole("button", { name: "Allow agents to start group messages" });
  if (role !== "tenant_owner") {
    await expect(toggle).toBeDisabled();
    await expect(policyRegion).toContainText("Your workspace role can view this policy but cannot change it.");
    expect(patchAttempts).toBe(0);
    return;
  }

  await toggle.click();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const reason = policyRegion.getByLabel("Reason for this change");
  await page.keyboard.press("Tab");
  await expect(reason).toBeFocused();
  await reason.fill("Approved group operations");
  await policyRegion.getByRole("button", { name: "Save changes" }).click();
  await expect(policyRegion.getByRole("alert")).toContainText("This service is temporarily unavailable.");
  await policyRegion.getByRole("button", { name: "Save changes" }).click();
  await expect(policyRegion.getByRole("status")).toContainText("Group messaging policy saved.");
  await expect(toggle).toBeFocused();
  expect(mutationKeys).toHaveLength(2);
  expect(mutationKeys[0]).toBeTruthy();
  expect(mutationKeys[1]).toBe(mutationKeys[0]);
});

(role === "tenant_owner" ? test : test.skip)("data-service privileged step-up returns to the originating Connections page", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one writable desktop role owns step-up routing");
  await page.route("**/api/client-routing/integrations", async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.route("**/api/client-routing/integrations/credential", async (route) => {
    await route.fulfill({ status: 403, json: { code: "REAUTHENTICATION_REQUIRED" } });
  });
  expectNetworkFailure(page, /\/api\/client-routing\/integrations\/credential$/u);

  await open(page, "connections");
  await page.getByRole("button", { name: "Add Zoho" }).click();
  await page.getByLabel("Connection name").fill("Step-up CRM");
  await page.getByLabel("Access token").fill("fixture-step-up-token");
  await page.getByRole("button", { name: "Save connection" }).click();

  const verify = page.getByRole("link", { name: "Verify identity" });
  await expect(verify).toBeVisible();
  await expect(verify).toHaveAttribute("href", "/auth/login?step_up=privileged&return_to=%2Fapp%3Fview%3Dconnections");
});

(["tenant_owner", "tenant_admin"].includes(role) ? test : test.skip)("the newest data-service refresh wins when an older refresh is still running", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  let requestCount = 0;
  let releaseSlowResponse: () => void = () => {};
  const slowResponse = new Promise<void>((resolve) => { releaseSlowResponse = resolve; });
  let markSlowStarted: () => void = () => {};
  const slowStarted = new Promise<void>((resolve) => { markSlowStarted = resolve; });
  await page.route("**/api/client-routing/integrations", async (route) => {
    requestCount += 1;
    if (requestCount === 2) {
      markSlowStarted();
      await slowResponse;
      await route.fulfill({ json: [{
        id: "87000000-0000-4000-8000-000000000021",
        provider: "NOTION",
        display_name: "Stale workspace",
        binding_reference: "secret://configured",
        state: "CONNECTED",
        revision: 1,
      }] }).catch(() => undefined);
      return;
    }
    const displayName = requestCount >= 3 ? "Newest workspace" : "Initial workspace";
    await route.fulfill({ json: [{
      id: "87000000-0000-4000-8000-000000000020",
      provider: "NOTION",
      display_name: displayName,
      binding_reference: "secret://configured",
      state: "CONNECTED",
      revision: requestCount,
    }] });
  });
  await open(page, "connections");
  await expect(page.getByText("Initial workspace", { exact: true })).toBeVisible();

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await slowStarted;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("Newest workspace", { exact: true })).toBeVisible();
  releaseSlowResponse();
  await expect.poll(() => requestCount).toBeGreaterThanOrEqual(3);
  await expect(page.getByText("Stale workspace", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Newest workspace", { exact: true })).toBeVisible();
  await expect(page.getByText("Connection status could not be refreshed. Try again.", { exact: true })).toHaveCount(0);
  await expectAxeClean(page);
});

(["tenant_owner", "tenant_admin"].includes(role) ? test : test.skip)("plugin connection management preserves the unsaved action draft", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await open(page, "plugins");
  await page.getByRole("button", { name: "Configure action" }).click();
  const actionForm = page.locator(".bot-action-form");
  const operatorName = actionForm.getByLabel("Operator name");
  await operatorName.fill("Unsaved customer update");
  const manageConnections = actionForm.getByRole("link", { name: /Manage data connections/u });
  await expect(manageConnections).toHaveAttribute("target", "_blank");
  await expect(manageConnections).toHaveAttribute("rel", "noopener noreferrer");
  const popupPromise = page.waitForEvent("popup");
  await manageConnections.click();
  const connectionsPage = await popupPromise;
  await expect(connectionsPage).toHaveURL(/\/app\?view=connections/u);
  await connectionsPage.close();
  await expect(operatorName).toHaveValue("Unsaved customer update");
  await expect(actionForm.getByRole("heading", { name: "Configure action" })).toBeVisible();
  await expectAxeClean(page);
});

(["tenant_owner", "tenant_admin"].includes(role) ? test : test.skip)("plugin privileged verification preserves the in-memory draft and retries safely", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const action = {
    id: "83000000-0000-4000-8000-000000000099",
    action_key: "logistics.lookup",
    name: "Shipment lookup",
    kind: "HTTP_JSON",
    endpoint_url: "https://example.com/shipments",
    http_method: "GET",
    auth_scheme: "BEARER",
    secret_reference: null,
    headers: {},
    response_mapping: {},
    timeout_ms: 5_000,
    max_response_bytes: 262_144,
    state: "PAUSED",
    revision: 1,
  };
  const credentialKeys: string[] = [];
  let credentialAttempt = 0;
  await page.route("**/api/bot-flows/actions/catalog?*", async (route) => route.fulfill({ json: { items: [action], next_cursor: null } }));
  await page.route("**/api/bot-flows/actions/logistics.lookup", async (route) => route.fulfill({ json: action }));
  await page.route("**/api/bot-flows/actions/logistics.lookup/revisions", async (route) => route.fulfill({ json: [{ ...action, active: true }] }));
  await page.route("**/api/bot-flows/actions", async (route) => route.fulfill({ json: { ...action, revision: 2 } }));
  await page.route("**/api/bot-flows/actions/credential", async (route) => {
    credentialAttempt += 1;
    credentialKeys.push(route.request().headers()["idempotency-key"] ?? "");
    if (credentialAttempt === 1) {
      await route.fulfill({ status: 403, json: { code: "REAUTHENTICATION_REQUIRED" } });
      return;
    }
    await route.fulfill({ json: { secretReference: "secret://tenants/test/bot-actions/logistics.lookup/credentials/staged" } });
  });
  await page.route("**/auth/login?**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Verified</title><p>Identity verified</p>" });
  });

  await open(page, "plugins");
  await page.getByRole("button", { name: "Configure action" }).click();
  const form = page.locator(".bot-action-form");
  const name = form.getByLabel("Operator name");
  const credential = form.locator("#bot-action-credential");
  const secret = "live-test-credential-12345";
  await name.fill("Unsaved shipment lookup");
  await credential.fill(secret);
  expectNetworkFailure(page, /\/api\/bot-flows\/actions\/credential$/u);
  await form.getByRole("button", { name: "Save action" }).click();

  await expect(form.getByRole("alert")).toContainText("Reauthenticate to continue.");
  const verify = form.getByRole("link", { name: /Verify identity/u });
  await expect(verify).toHaveAttribute("target", "_blank");
  await expect(verify).toHaveAttribute("rel", "noopener noreferrer");
  await expect(verify).toHaveAttribute("href", "/auth/login?step_up=privileged&return_to=%2Fapp%3Fview%3Dplugins");
  const popupPromise = page.waitForEvent("popup");
  await verify.click();
  const verificationPage = await popupPromise;
  await verificationPage.close();
  await expect(name).toHaveValue("Unsaved shipment lookup");
  await expect(credential).toHaveValue(secret);
  const browserStorage = await page.evaluate(() => {
    const values = (storage: Storage) => Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index) ?? "") ?? "");
    return [...values(window.localStorage), ...values(window.sessionStorage)];
  });
  expect(browserStorage.join("\n")).not.toContain(secret);

  await form.getByRole("button", { name: "Save action" }).click();
  await expect(page.getByText("The external action configuration was saved.")).toBeVisible();
  expect(credentialKeys).toHaveLength(2);
  expect(credentialKeys[1]).toBe(credentialKeys[0]);
  await expectAxeClean(page);
});

(["tenant_owner", "tenant_admin"].includes(role) ? test : test.skip)("plugin qualification keeps polling when completion takes longer than thirty seconds", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.clock.install();
  const action = {
    id: "83000000-0000-4000-8000-000000000098",
    action_key: "logistics.lookup",
    name: "Shipment lookup",
    kind: "HTTP_JSON",
    endpoint_url: "https://example.com/shipments",
    http_method: "GET",
    auth_scheme: "NONE",
    secret_reference: null,
    headers: {},
    response_mapping: {},
    timeout_ms: 5_000,
    max_response_bytes: 262_144,
    state: "ACTIVE",
    revision: 1,
    active_action_revision: 1,
    qualification_supported: true,
    capabilities: { retry_semantics: "REPLAY_SAFE" },
  };
  let statusChecks = 0;
  await page.route("**/api/bot-flows/actions/catalog?*", async (route) => route.fulfill({ json: { items: [action], next_cursor: null } }));
  await page.route("**/api/bot-flows/actions/logistics.lookup", async (route) => route.fulfill({ json: action }));
  await page.route("**/api/bot-flows/actions/logistics.lookup/revisions", async (route) => route.fulfill({ json: [{ ...action, active: true }] }));
  await page.route("**/api/bot-flows/actions/*/qualifications", async (route) => {
    await route.fulfill({ json: { qualificationId: "qualification-after-thirty", state: "QUEUED", outcome: null } });
  });
  await page.route("**/api/bot-flows/actions/*/qualifications/*", async (route) => {
    statusChecks += 1;
    await route.fulfill({ json: statusChecks > 30
      ? { qualificationId: "qualification-after-thirty", state: "SUCCEEDED", outcome: "SUCCESS" }
      : { qualificationId: "qualification-after-thirty", state: "RUNNING", outcome: null } });
  });

  await open(page, "plugins");
  await page.getByRole("button", { name: "Configure action" }).click();
  const form = page.locator(".bot-action-form");
  await form.getByRole("button", { name: "Run check" }).click();
  await expect(form.getByRole("button", { name: "Running…" })).toBeDisabled();
  for (let second = 0; second < 32 && statusChecks <= 30; second += 1) {
    const previousChecks = statusChecks;
    await page.clock.runFor(1_000);
    await expect.poll(() => statusChecks).toBeGreaterThan(previousChecks);
  }
  await expect(form.getByText("The action completed successfully.", { exact: true })).toBeVisible();
  expect(statusChecks).toBeGreaterThan(30);
  await expectAxeClean(page);
});

(role === "tenant_owner" ? test : test.skip)("mobile workflow controls keep usable touch targets", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390");
  await open(page, "automation");
  expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(true);
  await page.getByRole("tab", { name: "Flows", exact: true }).click();
    const assertTargets = async (selector: string, minimumHeight: number, minimumWidth = 0) => {
      const controls = page.locator(selector).filter({ visible: true });
      await expect(controls.first()).toBeVisible();
      expect(await controls.count()).toBeGreaterThan(0);
    for (const control of await controls.all()) {
      const bounds = await control.boundingBox();
      expect(bounds?.height, (await control.textContent()) ?? undefined).toBeGreaterThanOrEqual(minimumHeight);
      expect(bounds?.width).toBeGreaterThanOrEqual(minimumWidth);
    }
  };
  await assertTargets(".top-locale-switcher .wx-button", 44);
  await assertTargets(".bot-starter select", 48);
  await assertTargets(".bot-automation .button.small", 48);
  await page.getByRole("button", { name: "New flow", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Flow draft" })).toBeVisible();
  await assertTargets(".bot-automation .button.small", 48);
  await assertTargets(".workflow-graph .react-flow__controls-button", 48, 44);
  await page.getByRole("button", { name: "Close editor", exact: true }).click();
  await page.getByRole("tab", { name: "Numbers & handoff", exact: true }).click();
  await assertTargets(".bot-assignment-list .button.small", 48);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("mobile and tablet navigation keep content bounded and role-appropriate", { tag: "@tablet" }, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "responsive projects own this transaction");
  await open(page);
  const viewport = testInfo.project.name === "mobile-390" ? 390 : 820;
  expect(await page.evaluate(() => window.innerWidth)).toBe(viewport);

  const primary = page.getByRole("navigation", { name: "Primary navigation" });
  const target = role === "agent" ? "Deliveries" : role === "auditor" ? "Settings" : "Groups";
  if (testInfo.project.name === "mobile-390") {
    await expect(primary.getByRole("link")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Menu" }).click();
    const closeMenu = page.getByRole("button", { name: "Close menu" });
    await closeMenu.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(closeMenu).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Menu" })).toBeFocused();
    await page.getByRole("button", { name: "Menu" }).click();
  }
  await expect(primary.getByRole("link")).toHaveCount(navigationByRole[role].length);
  await navigationLink(page, target).click();
  await expect(page.getByRole("heading", { level: 1, name: titles[viewForNavigation[target]] })).toBeVisible();

  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    root: document.documentElement.scrollWidth,
    main: document.querySelector("main")?.getBoundingClientRect().toJSON(),
  }));
  expect(geometry.root).toBeLessThanOrEqual(geometry.viewport);
  expect(Number(geometry.main?.width ?? 0)).toBeLessThanOrEqual(viewport);
  const pin = page.getByRole("button", { name: "Pin sidebar open" });
  if (testInfo.project.name === "tablet-820") {
    await expect(pin).toBeVisible();
    expect(await page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().width)).toBe(72);
    await pin.click();
    expect(await page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(150);
    await page.getByRole("button", { name: "Use automatic sidebar" }).click();
    expect(await page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().width)).toBe(72);

    const inbox = navigationLink(page, "Inbox");
    if (role === "auditor") {
      await expect(inbox).toHaveCount(0);
    } else {
      await page.route("**/api/inbox", async (route) => {
        expect(route.request().method()).toBe("POST");
        expect(route.request().postDataJSON()).toEqual({ operation: "LIST", input: { limit: 50, state: "open" } });
        await route.fulfill({ json: { items: [], next_cursor: null } });
      });
      await inbox.click();
      await expect(page.getByRole("heading", { level: 1, name: titles.inbox })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Conversation workspace" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "No conversations here" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport);
    }
  } else {
    await expect(pin).toBeHidden();
    await expect(primary.getByRole("link")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Menu" }).click();
    await expect(navigationLink(page, "Overview").locator(".nav-label")).toBeVisible();
  }
  await expectAxeClean(page);
});

(role === "tenant_owner" ? test : test.skip)("mobile loading and delivery drawers expose state without clipping at large text", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390");
  let releaseCatalog = () => {};
  const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  await page.route("**/api/bot-flows/catalog?limit=25", async (route) => {
    await catalogGate;
    await route.continue();
  });
  await page.goto("/app?view=automation");
  const loading = page.locator('.bot-loading[aria-busy="true"]');
  await expect(loading.getByRole("status", { name: "Loading workflows" })).toHaveText("Loading workflows");
  await expect(loading.getByRole("status")).not.toHaveAttribute("aria-busy");
  await expect(loading.locator('[aria-hidden="true"]')).toHaveCount(3);
  releaseCatalog();
  await expect(page.getByRole("heading", { level: 1, name: "Workflows" })).toBeVisible();

  await open(page, "deliveries");
  await page.locator("html").evaluate((element) => { element.style.fontSize = "200%"; });
  await page.route("**/api/deliveries/*", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const detail = await response.json();
    await route.fulfill({ response, json: { ...detail, delivery_attempts: Array.from({ length: 8 }, (_, index) => ({
      ...detail.delivery_attempts[0], id: `fixture-attempt-${index + 1}`, attempt_number: index + 1,
    })) } });
  });
  await page.getByRole("button", { name: "Inspect" }).first().click();
  const drawer = page.getByRole("dialog", { name: "Delivery timeline" });
  const body = drawer.getByRole("region", { name: "Delivery timeline", exact: true });
  await expect(body).toBeVisible();
  const geometry = await body.evaluate((element) => ({
    clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  const close = drawer.getByRole("button", { name: "Close delivery details" });
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(body).toBeFocused();
  const top = await body.evaluate((element) => element.scrollTop);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(top);
  await page.keyboard.press("End");
  await expect(body.locator(":scope > section").last()).toBeInViewport();
  await testInfo.attach("delivery-timeline-keyboard", { body: await page.screenshot(), contentType: "image/png" });
  await expectAxeClean(page);
});

test("one-to-one bot configuration, simulation, handoff, and role boundaries stay usable", async ({ page }, testInfo) => {
  const clonedFlowVersions = new Map<number, string>();
  const saveClonedVersion = async (expectedVersion: number) => {
    const pending = page.waitForResponse(response => response.request().method() === "POST" && /^\/api\/bot-flows\/[^/]+\/clone$/u.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "Save as new draft" }).click();
    const response = await pending;
    expect(response.ok()).toBe(true);
    const created = await response.json() as { id: string; version: number };
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
    expect(created.version).toBe(expectedVersion);
    clonedFlowVersions.set(expectedVersion, created.id);
  };
  await page.route("**/api/bot-flows/ticket-events", async route => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({ json: { bindings: [], groups: [], members: [] } });
  });
  await open(page, "automation");
  const canWrite = ["tenant_owner", "tenant_admin"].includes(role);

  await expect(page.getByRole("region", { name: "Workflow summary" })).toContainText("active flows");
  const flowsTab=page.getByRole("tab",{name:"Flows",exact:true});
  const ticketWorkflowsTab=page.getByRole("tab",{name:"Ticket workflows",exact:true});
  const conversationsTab=page.getByRole("tab",{name:"Conversations",exact:true});
  const directEditor = page.locator("form.panel.bot-flow-editor:has(#bot-flow-editor-title)");
  await flowsTab.focus();
  await flowsTab.press("ArrowRight");
  await expect(ticketWorkflowsTab).toBeFocused();
  await expect(ticketWorkflowsTab).toHaveAttribute("aria-selected","true");
  await expect(page.locator("#bot-panel-ticket-events")).toBeVisible();
  await ticketWorkflowsTab.press("ArrowRight");
  await expect(conversationsTab).toBeFocused();
  await expect(conversationsTab).toHaveAttribute("aria-selected","true");
  await expect(page.getByRole("heading",{name:"Direct conversations"})).toBeVisible();
  const humanConversation=page.getByRole("article").filter({hasText:/Support case.*#10421/u});
  const unknownConversation=page.getByRole("article").filter({hasText:/Support case.*#10422/u});
  await expect(humanConversation).toBeVisible();
  await expect(unknownConversation).toContainText("The external action outcome is unknown");
  await expect(unknownConversation).not.toContainText("The order system may have accepted the request, but its response was not received.");
  const executionHistory=humanConversation.getByRole("button",{name:"View execution history"});
  await executionHistory.click();
  const executionDialog=page.getByRole("dialog",{name:/Execution history.*#10421/u});
  await expect(executionDialog).toContainText("Retained, read-only workflow evidence");
  await expect(executionDialog).toContainText("Handoff requested");
  await expect(executionDialog).toContainText("External action succeeded");
  await expect(executionDialog).toContainText("External action failed");
  await expect(executionDialog).toContainText("External action retry requested");
  await expect(executionDialog).toContainText("Request location");
  await expect(executionDialog).not.toContainText("zammad_ticket");
  await page.keyboard.press("Escape");
  await expect(executionDialog).toBeHidden();
  await expect(executionHistory).toBeFocused();
  if(role==="auditor"){await expect(page.getByRole("button",{name:"Resume bot"})).toHaveCount(0);await expect(page.getByRole("button",{name:"Retry external action"})).toHaveCount(0)}
  else {
    await humanConversation.getByRole("button",{name:"Resume bot"}).click();
    await expect(page.getByRole("heading",{name:"Resume bot automation?"})).toBeVisible();
    await expect(page.getByRole("button",{name:"Cancel"})).toBeFocused();
    await page.getByRole("button",{name:"Cancel"}).click();
    await expect(humanConversation.getByRole("button",{name:"Resume bot"})).toBeFocused();
    await humanConversation.getByRole("button",{name:"Close conversation"}).click();
    await expect(page.getByRole("heading",{name:"Close this conversation?"})).toBeVisible();
    await page.getByRole("button",{name:"Cancel"}).click();
    await expect(humanConversation.getByRole("button",{name:"Close conversation"})).toBeFocused();
    await unknownConversation.getByRole("button",{name:"Retry external action"}).click();
    await expect(page.getByRole("heading",{name:"Retry this uncertain external action?"})).toBeVisible();
    await expect(page.getByRole("button",{name:"Cancel"})).toBeFocused();
    await page.getByRole("button",{name:"Cancel"}).click();
    await expect(unknownConversation.getByRole("button",{name:"Retry external action"})).toBeFocused();
    await unknownConversation.getByRole("button",{name:"Hand off to person"}).click();
    await expect(page.getByRole("heading",{name:"Hand this conversation to a person?"})).toBeVisible();
    await expect(page.getByRole("button",{name:"Cancel"})).toBeFocused();
    await page.getByRole("button",{name:"Cancel"}).click();
    await expect(unknownConversation.getByRole("button",{name:"Hand off to person"})).toBeFocused();
  }
  await conversationsTab.press("ArrowLeft");
  await expect(ticketWorkflowsTab).toBeFocused();
  await expect(ticketWorkflowsTab).toHaveAttribute("aria-selected","true");
  await expect(page.locator("#bot-panel-ticket-events")).toBeVisible();
  await ticketWorkflowsTab.press("ArrowLeft");
  await expect(flowsTab).toBeFocused();
  await expect(flowsTab).toHaveAttribute("aria-selected","true");
  await expect(page.locator("#bot-panel-ticket-events")).toBeHidden();
  await expect(page.getByRole("heading", { name: /Customer care · version 1/u })).toBeVisible();
  await expect(page.getByText("Linked-device connection")).toBeVisible();
  if(canWrite){
    if(testInfo.project.name==="desktop"){
      const mediaAssetId="64700000-0000-4000-8000-000000000099";
      let mediaReady=false;
      expectNetworkFailure(page,/\/api\/bot-flows\/media-assets/u);
      await page.route("**/api/bot-flows/media-assets*",async route=>{
        if(route.request().method()==="GET"){
          await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(mediaReady?[{id:mediaAssetId,filename:"operator-proof.png",mime_type:"image/png",byte_size:8,state:"READY"}]:[])});
          return;
        }
        if(route.request().headers()["content-type"]!=="image/png"){
          await route.fulfill({status:422,contentType:"application/json",body:JSON.stringify({error:"Choose a supported image, document, audio file, or MP4 video."})});
          return;
        }
        expect(route.request().headers()["x-content-sha256"]).toMatch(/^[0-9a-f]{64}$/u);
        mediaReady=true;
        await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:mediaAssetId,state:"READY"})});
      });
      await page.getByRole("button",{name:"Clone as draft"}).click();
      await expect(page.getByLabel("Show one execution on the canvas")).toHaveValue("85000000-0000-4000-8000-000000000001");
      await expect(page.locator(".workflow-node-overlay").filter({hasText:"Hand off to a person"})).toHaveText("Hand off to a person");
      await page.getByLabel("New step type").selectOption("send_media");
      await page.getByRole("button",{name:"Add step"}).click();
      const mediaNode=directEditor.locator(".bot-node-card").filter({hasText:"Send media"}).last();
      const mediaNodeId=(await mediaNode.getAttribute("id"))?.replace(/^bot-node-/u,"");
      expect(mediaNodeId).toBeTruthy();
      const locationNode=directEditor.locator('.bot-node-card:has(select[id$="-type"] option[value="request_location"]:checked)');
      await expect(locationNode).toHaveCount(1);
      await locationNode.getByLabel("Next step").selectOption(mediaNodeId!);
      await expect(mediaNode.getByLabel("Saved media")).toHaveValue("");
      await mediaNode.getByLabel("Add a file").setInputFiles({name:"blocked.exe",mimeType:"application/x-msdownload",buffer:Buffer.from("blocked")});
      await expect(mediaNode.getByRole("alert")).toHaveText("Check the information and try again.");
      await mediaNode.getByLabel("Add a file").setInputFiles({name:"operator-proof.png",mimeType:"image/png",buffer:Buffer.from([137,80,78,71,13,10,26,10])});
      await expect(mediaNode.getByLabel("Saved media")).toHaveValue(mediaAssetId);
      await mediaNode.getByLabel("Caption (optional)").fill("Shipment {{message.text}}");
      await saveClonedVersion(2);
      await page.getByRole("button",{name:/Customer care.*Version 2/u}).click();
      await expect(page.getByRole("heading",{name:"Version comparison"})).toBeVisible();
      await expect(page.getByLabel("Compare with")).toHaveValue("82000000-0000-4000-8000-000000000001");
      await expect(page.getByText("1 added · 0 removed · 1 changed", { exact: true })).toBeVisible();
      await page.getByRole("button",{name:"Review activation"}).click();
      await expect(page.getByRole("heading",{name:"Activate version 2?"})).toBeVisible();
      await page.getByRole("button",{name:"Activate version"}).click();
      await expect(page.locator('.bot-feedback[role="status"]')).toContainText("version is active");
      await page.getByRole("button",{name:/Customer care.*Version 1/u}).click();
      await page.getByRole("button",{name:"Restore as draft"}).click();
      await saveClonedVersion(3);
      await page.getByRole("button",{name:/Customer care.*Version 3/u}).click();
      await page.getByRole("button",{name:"Review activation"}).click();
      await page.getByRole("button",{name:"Activate version"}).click();
      await expect(page.locator('.bot-feedback[role="status"]')).toContainText("version is active");
    }
    const newFlowButton = page.getByRole("button",{name:"New flow"});
    await newFlowButton.click();
    await expect(page.getByRole("heading",{name:"Flow draft"})).toBeFocused();
    await expect(page.getByLabel("Flow definition")).toHaveCount(0);
    const workflowCanvas = page.getByRole("region", { name: "Interactive workflow graph" });
    await expect(workflowCanvas).toBeVisible();
    await expect(workflowCanvas.getByLabel("Workflow minimap")).toBeVisible();
    const firstCanvasNode = workflowCanvas.getByRole("button", { name: /^Edit .+ node$/u }).first();
    const secondCanvasNode = workflowCanvas.getByRole("button", { name: /^Edit .+ node$/u }).nth(1);
    await firstCanvasNode.focus();
    const firstPosition = await firstCanvasNode.boundingBox();
    const secondPosition = await secondCanvasNode.boundingBox();
    await firstCanvasNode.press("Enter");
    await expect(firstCanvasNode).toHaveClass(/selected/u);
    await page.keyboard.down("ControlOrMeta");
    await secondCanvasNode.focus();
    await secondCanvasNode.press("Enter");
    await page.keyboard.up("ControlOrMeta");
    await expect(firstCanvasNode).toHaveClass(/selected/u);
    await expect(secondCanvasNode).toHaveClass(/selected/u);
    await secondCanvasNode.press("ArrowRight");
    const movedPosition = await firstCanvasNode.boundingBox();
    const secondMovedPosition = await secondCanvasNode.boundingBox();
    expect(movedPosition?.x).toBeGreaterThan(firstPosition?.x ?? 0);
    expect(secondMovedPosition?.x).toBeGreaterThan(secondPosition?.x ?? 0);
    const movedTransforms = await Promise.all([firstCanvasNode,secondCanvasNode].map(node=>node.evaluate(element=>(element as HTMLElement).style.transform)));
    await page.getByLabel("Flow name").fill("Recovered operator draft");
    await expect(page.getByText("Recovery copy saved on this device", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
    await page.getByRole("button",{name:"New flow"}).click();
    await expect(page.getByText("Unsaved workflow changes were recovered on this device.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Flow name")).toHaveValue("Recovered operator draft");
    await expect(page.getByLabel("Handoff destination")).toHaveValue("CLIENT_PRIMARY");
    const recoveredCanvasNodes = page.getByRole("region", { name: "Interactive workflow graph" }).getByRole("button", { name: /^Edit .+ node$/u });
    await expect(recoveredCanvasNodes).toHaveCount(3);
    expect(await Promise.all([recoveredCanvasNodes.nth(0),recoveredCanvasNodes.nth(1)].map(node=>node.evaluate(element=>(element as HTMLElement).style.transform)))).toEqual(movedTransforms);
    const nodeTypes = await page.getByLabel("New step type").locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(nodeTypes).toEqual(["send_text", "send_media", "choice", "request_location", "send_location", "send_template", "action", "handoff", "end"]);
    await page.getByLabel("Handoff destination").selectOption("FIXED");
    const fixedSupportTeam = page.locator('select[id$="-group"]');
    await expect(fixedSupportTeam).toHaveValue("2");
    await expect(fixedSupportTeam.locator("option:checked")).toHaveText("Riyadh Operations");
    await page.getByLabel("Handoff destination").selectOption("CLIENT_ESCALATION");
    await expect(fixedSupportTeam).toHaveCount(0);
    await page.getByLabel("Handoff destination").selectOption("CLIENT_PRIMARY");
    await page.getByLabel("Editing direction").selectOption("rtl");
    await page.getByLabel("Flow name").fill("دعم العملاء");
    await page.getByLabel("Question").fill("كيف يمكننا مساعدتك؟");
    await expect(directEditor.locator(".bot-editor-layout")).toHaveAttribute("dir","rtl");
    await page.getByRole("button",{name:"Add step"}).click();
    await expect(directEditor.locator(".bot-node-card")).toHaveCount(4);
    await expect(page.getByText("Draft needs attention.")).toBeVisible();
    await page.getByRole("button",{name:"Close editor"}).click();
    await expect(page.getByRole("heading", { name: "Discard draft changes?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Keep editing" })).toBeFocused();
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(newFlowButton).toBeFocused();
  }
  await page.getByLabel("Example values").fill("{");
  await page.getByRole("button", { name: "Start simulation" }).click();
  await expect(page.getByLabel("Example values")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Check the example values. Keep the format of the starting example: each name and value in quotes, separated by commas.", { exact: true })).toBeVisible();
  await page.getByLabel("Example values").fill("{}");
  await page.getByRole("button", { name: "Start simulation" }).click();
  await page.getByRole("button", { name: "Share my location" }).click();
  await page.getByRole("button", { name: "Share example Riyadh location" }).click();
  await expect(page.locator(".bot-transcript")).toContainText("A person will join shortly.");

  if (canWrite) {
    await page.getByLabel("Starter").selectOption("lookup");
    await page.getByRole("button", { name: "New flow" }).click();
    await expect(page.getByLabel("Handoff destination")).toHaveValue("CLIENT_ESCALATION");
    await page.getByRole("button", { name: "Save as new draft" }).click();
    await page.getByRole("button", { name: /Order lookup/u }).last().click();
    await expect(page.getByLabel("Example values")).toHaveValue('{"message.text":"ORD-42","action.status":"shipped"}');
    await page.getByRole("button", { name: "Start simulation" }).click();
    await page.getByRole("button", { name: "Simulate failure" }).click();
    await expect(page.locator(".bot-transcript")).toContainText("We could not retrieve the order. A person will help.");
  }

  await page.getByRole("tab", { name: "Numbers & handoff" }).click();
  await expect(page.getByRole("heading", { name: "Assigned numbers" })).toBeVisible();
  await expect(page.getByText("Support team: Riyadh Operations")).toBeVisible();

  await navigateFromSidebar(page, "Plugins", testInfo.project.name);
  await expect(page.getByRole("heading", { level: 1, name: "Plugins" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Plugin catalog" })).toBeVisible();
  await expect(page.getByText("Create Notion case")).toBeVisible();

  await navigateFromSidebar(page, "Client routing", testInfo.project.name);
  await expect(page.getByRole("heading", { level: 1, name: "Client routing" })).toBeVisible();
  await expect(page.getByRole("heading",{name:"Configuration sources"})).toBeVisible();
  await expect(page.getByText("Notion client directory",{exact:true})).toBeVisible();
  await expect(page.getByText("Last complete pull",{exact:true})).toBeVisible();
  await expect(page.getByText("Version 8",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Copy webhook endpoint"})).toHaveCount(canWrite?1:0);
  await expect(page.getByText("Acme Logistics",{exact:true})).toBeVisible();
  await expect(page.getByRole("region",{name:"Client routing table"})).toBeVisible();
  await page.getByLabel("Search clients and match values").fill("missing-client");
  await expect(page.getByText("No matching clients")).toBeVisible();
  await page.getByLabel("Search clients and match values").fill("");
  await page.getByLabel("Email").fill("operator@acme.example");
  await page.getByRole("combobox",{name:"Initial queue",exact:true}).selectOption("2");
  await page.getByRole("button",{name:"Test route"}).click();
  await expect(page.locator(".routing-result")).toContainText("Matched Acme Logistics");
  if(canWrite&&testInfo.project.name==="desktop"){
    await page.getByRole("button",{name:"New draft"}).click();
    await expect(page.getByRole("heading",{name:"Create routing draft"})).toBeFocused();
    await expect(page.getByRole("group",{name:"Configuration sources"})).toBeVisible();
    await expect(page.getByRole("group",{name:"Clients and ownership"})).toBeVisible();
    await expect(page.getByLabel("Connector").first()).toHaveValue("MANUAL");
    await page.getByRole("button",{name:"Add source"}).click();
    const connector=page.getByLabel("Connector").last();
    const sourceCard=connector.locator("xpath=ancestor::article");
    expect(await connector.locator("option").evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value))).toEqual(["MANUAL","NOTION","ZOHO","HTTP_JSON"]);
    await connector.selectOption("NOTION");
    await expect(sourceCard.getByLabel("Notion data source query URL")).toBeVisible();
    await expect(sourceCard.getByLabel("Connected Notion workspace")).not.toHaveValue("");
    await sourceCard.getByLabel("Sync mode").selectOption("HYBRID");
    await expect(sourceCard.getByLabel("Refresh interval (minutes)")).toHaveValue("60");
    await connector.selectOption("ZOHO");
    await expect(sourceCard.getByLabel("Zoho CRM v8 module URL")).toBeVisible();
    await expect(sourceCard.getByLabel("Connected data service")).toHaveValue("");
    await connector.selectOption("HTTP_JSON");
    await expect(sourceCard.getByLabel("HTTPS endpoint")).toBeVisible();
    await connector.selectOption("MANUAL");
    await page.getByRole("button",{name:"Remove source"}).last().click();
    const clientCard=page.getByRole("group",{name:"Clients and ownership"}).getByLabel("Client ID").first().locator("xpath=ancestor::article");
    await expect(clientCard.getByLabel("Client name")).toHaveValue("Acme Logistics");
    await expect(clientCard.getByLabel("Support team")).not.toHaveValue("");
    await expect(clientCard.getByLabel("Escalation group")).not.toHaveValue("");
    expect(await clientCard.getByLabel("Type").first().locator("option").evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value))).toEqual(["DOMAIN","EMAIL","CLIENT_IDENTIFIER","WHATSAPP_GROUP"]);
    await clientCard.getByRole("button",{name:"Add match value"}).click();
    const matcher=clientCard.locator(".routing-matcher-row").last();
    await matcher.getByLabel("Type").selectOption("WHATSAPP_GROUP");
    await expect(matcher.getByLabel("Connection")).toBeVisible();
    expect(await matcher.getByLabel("Connection").locator("option").count()).toBeGreaterThan(1);
    await matcher.getByRole("button",{name:"Remove match"}).click();
    await expect(page.getByText("Advanced: edit as text")).toBeVisible();
    await page.getByText("Advanced: edit as text").click();
    await expect(page.getByLabel("Routing settings as text")).toBeVisible();
    // Use the existing request interceptor to read the actual server body;
    // the browser Response.body reader can remain pending after a successful save.
    let createdRouting: { id: string; version: number } | undefined;
    await page.route("**/api/client-routing", async route => {
      const response = await route.fetch();
      if (route.request().method() === "POST" && response.status() === 201) createdRouting = await response.json();
      await route.fulfill({ response });
    });
    const createdRoutingResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/client-routing" && response.request().method() === "POST" && response.status() === 201);
    await page.getByRole("button",{name:"Create draft"}).click();
    await createdRoutingResponse;
    expect(createdRouting).toBeDefined();
    if (!createdRouting) throw new Error("The created routing draft identity is missing");
    await expect(page.getByText("Routing draft created. Review it, then activate it.")).toBeVisible();
    await page.getByRole("button",{name:new RegExp(`^Version ${createdRouting.version} Created `,"u")}).click();
    await page.getByRole("button",{name:"Review activation"}).click();
    await expect(page.getByRole("heading",{name:`Activate routing version ${createdRouting.version}?`})).toBeVisible();
    await expect(page.getByRole("button",{name:"Cancel"})).toBeFocused();
    await page.getByRole("button",{name:"Cancel"}).click();
    await expect(page.getByRole("button",{name:"Review activation"})).toBeFocused();
    await page.getByRole("button",{name:"Review activation"}).click();
    const activatedRoutingResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/client-routing/${createdRouting!.id}/activate` && response.request().method() === "POST" && response.ok());
    await page.getByRole("button",{name:"Activate routing"}).click();
    await activatedRoutingResponse;
    await expect(page.getByText("Routing version activated in WasalX. Check the ticket routing sync status below.")).toBeVisible();
  }
  await navigateFromSidebar(page, "Plugins", testInfo.project.name);

  if (canWrite) {
    await expect(page.getByRole("button", { name: "New plugin action" })).toBeVisible();
    if (testInfo.project.name === "desktop") {
      await page.getByRole("button", { name: "Configure action" }).click();
      await expect(page.getByRole("heading", { name: "Configure action" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("heading", { name: "Configure action" })).toHaveCount(0);
      await page.getByRole("button", { name: "Configure action" }).click();
      await expect(page.getByLabel("Fixed HTTPS endpoint")).toHaveValue("https://api.notion.com/v1/pages");
      await expect(page.getByLabel("Request timeout (milliseconds)")).toHaveValue("5000");
      await expect(page.getByLabel("Maximum response size (bytes)")).toHaveValue("262144");
      const actionForm = page.locator(".bot-action-form");
      await actionForm.getByLabel("Connected account").selectOption({ label: "Northstar workspace" });
      await expect(actionForm.getByLabel("Credential", { exact: true })).toHaveCount(0);
      await expect(actionForm.getByText("Uses the same secure connection for routing and workflow actions. No credential is copied.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      const discardActionChanges = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
      await expect(discardActionChanges).toBeVisible();
      await expect(discardActionChanges.getByRole("button", { name: "Keep editing" })).toBeFocused();
      await discardActionChanges.getByRole("button", { name: "Discard changes" }).click();
      await expect(page.getByRole("heading", { name: "Configure action" })).toHaveCount(0);
      await navigateFromSidebar(page, "Workflows", testInfo.project.name);
      await page.getByRole("tab", { name: "Numbers & handoff" }).click();
      await expect(page.locator("#bot-assignment-zammad")).toHaveValue("2");
      await expect(page.locator("#bot-assignment-zammad option:checked")).toHaveText("Riyadh Operations");
      await page.getByRole("button", { name: "Pause" }).click();
      await expect(page.getByRole("heading", { name: /^Pause ·/u })).toBeVisible();
      await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
      await page.getByRole("dialog").getByRole("button", { name: "Pause" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Direct bot intake is paused for this number." })).toBeVisible();
      await page.getByRole("button", { name: "Resume" }).click();
      await expect(page.getByRole("heading", { name: /^Resume ·/u })).toBeVisible();
      await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
      await page.getByRole("dialog").getByRole("button", { name: "Resume" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Direct bot intake is active for this number." })).toBeVisible();
      await page.reload();
      await open(page,"audit");
      const auditResponse = await page.request.get("/api/audit");
      expect(auditResponse.ok()).toBe(true);
      const auditRows = await auditResponse.json() as Array<{ id: string; action: string; target: string; detail: string }>;
      // Other flow families can legitimately share these summaries. Keep exact
      // event identity/uniqueness checks and verify every matching rendered row.
      for (const expected of [
        { action: "bot_flow.cloned", target: clonedFlowVersions.get(2), detail: "Cloned bot flow version 1 into immutable version 2" },
        { action: "bot_flow.cloned", target: clonedFlowVersions.get(3), detail: "Cloned bot flow version 1 into immutable version 3" },
        { action: "bot_flow.activated", target: clonedFlowVersions.get(3), detail: "Activated bot flow version 3; retired version 2" },
      ]) {
        expect(expected.target).toBeDefined();
        const ownEvents = auditRows.filter(row => row.action === expected.action && row.target === expected.target);
        expect(ownEvents).toHaveLength(1);
        expect(ownEvents[0].detail).toBe(expected.detail);
        const matchingRows = auditRows.filter(row => row.detail === expected.detail);
        expect(new Set(matchingRows.map(row => row.id)).size).toBe(matchingRows.length);
        const rendered = page.getByText(expected.detail, { exact: true });
        await expect(rendered).toHaveCount(matchingRows.length);
        for (const row of await rendered.all()) await expect(row).toBeVisible();
      }
    }
  } else {
    await expect(page.getByText("Read only", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New plugin action" })).toHaveCount(0);
  }

  const geometry = await page.evaluate(() => ({ viewport: window.innerWidth, root: document.documentElement.scrollWidth }));
  expect(geometry.root).toBeLessThanOrEqual(geometry.viewport);
  await expectAxeClean(page);
});

(["tenant_owner", "tenant_admin"].includes(role) ? test : test.skip)("mobile configurators retain a bounded accessible connection action", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390");
  await open(page);
  await navigateFromSidebar(page, "Connections", testInfo.project.name);
  await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();

  const opener = page.getByRole("button", { name: "Connect number", exact: true });
  await expect(opener).toBeVisible();
  await expect(opener).toHaveAttribute("title", "Connect number");
  const geometry = await opener.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      root: document.documentElement.scrollWidth,
      left: bounds.left,
      right: bounds.right,
      width: bounds.width,
      height: bounds.height,
    };
  });
  expect(geometry.root).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.width).toBe(44);
  expect(geometry.height).toBe(44);

  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Connect a WhatsApp number" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Connect a WhatsApp number" })).toBeFocused();
  await expectAxeClean(page);
  await dialog.getByRole("button", { name: "Close connection setup" }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

(role === "tenant_owner" ? test : test.skip)("owner onboarding is keyboard-contained and recovers an idempotent failed request", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await open(page);
  const opener = page.getByRole("button", { name: /Connect number/u });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Connect a WhatsApp number" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Connect a WhatsApp number" })).toBeFocused();
  await expectAxeClean(page);

  const continueButton = dialog.getByRole("button", { name: "Continue", exact: true });
  await page.keyboard.press("Shift+Tab");
  await expect(continueButton).toBeFocused();
  await continueButton.focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close connection setup" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(continueButton).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  let failOnce = true;
  let holdDashboard = false;
  let releaseDashboard = () => {};
  let markDashboardPending = () => {};
  const dashboardRelease = new Promise<void>((resolve) => { releaseDashboard = resolve; });
  const dashboardPending = new Promise<void>((resolve) => { markDashboardPending = () => resolve(); });
  await page.route("**/api/dashboard", async (route) => {
    if (!holdDashboard) {
      await route.continue();
      return;
    }
    markDashboardPending();
    await dashboardRelease;
    await route.continue();
  });
  expectNetworkFailure(page, /\/api\/connections$/u);
  await page.route("**/api/connections", async (route) => {
    if (route.request().method() === "POST" && failOnce) {
      failOnce = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "The fixture worker is temporarily unavailable." }) });
      return;
    }
    await route.continue();
  });

  await opener.click();
  await page.getByLabel("Connection name").fill("E2E recovery line");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel(/I understand these constraints/u).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review and start setup" })).toBeVisible();
  await page.getByRole("button", { name: "Start setup" }).click();
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
  holdDashboard = true;
  await page.getByRole("button", { name: "Start setup" }).click();
  await expect(page.getByRole("heading", { name: "Connection setup started" })).toBeVisible();
  await dashboardPending;
  const viewConnection = page.getByRole("button", { name: "View connection" });
  try {
    await expect(viewConnection).toBeEnabled();
    await viewConnection.click();
    await expect(page.getByRole("heading", { name: "E2E recovery line" })).toBeVisible();
  } finally {
    releaseDashboard();
  }
  await page.getByRole("button", { name: "Close connection details" }).click();
});

(role === "tenant_owner" ? test : test.skip)("QR freshness is timed, expired safely, and hidden when the portal session expires", async ({ page }) => {

  const detailPath = /\/api\/connections\/12000000-0000-4000-8000-000000000002$/u;
  const qrPath = /\/api\/connections\/12000000-0000-4000-8000-000000000002\/auth\/qr$/u;
  const scanCompletePath = /\/api\/connections\/12000000-0000-4000-8000-000000000002\/auth\/scan-complete$/u;
  const now = Date.now();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  let qrRequest = 0;
  let scanRecorded = false;
  expectNetworkFailure(page, qrPath);
  await page.route(detailPath, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "12000000-0000-4000-8000-000000000002",
        name: "Returns desk",
        phone: "12025550101",
        provider: "WAHA",
        state: "AWAITING_AUTH",
        group_count: 2,
        last_heartbeat_at: new Date(now).toISOString(),
        last_provider_event_at: new Date(now).toISOString(),
        provider_session_state: "AWAITING_AUTH",
        provider_state: "SCAN_QR_CODE",
        worker_id: "wasalx-local-gows",
        webhook_state: "ACTIVE",
        latest_operation_id: "operation-ready",
        latest_operation_type: "RESTART",
        latest_operation_state: "SUCCEEDED",
        latest_operation_attempts: 1,
        latest_operation_created_at: new Date(now).toISOString(),
        onboarding_qr_ready_at: new Date(now).toISOString(),
        onboarding_authorization_method: "QR",
        onboarding_scan_acknowledged_at: scanRecorded ? new Date().toISOString() : null,
        onboarding_scan_completed_at: null,
      }),
    });
  });
  await page.route(scanCompletePath, async (route) => {
    scanRecorded = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recordedAt: new Date().toISOString(),
        acknowledgedAt: new Date().toISOString(),
        providerWorkingAt: null,
        timingEligible: false,
        lateAcknowledgement: false,
        duplicate: false,
      }),
    });
  });
  await page.route(qrPath, async (route) => {
    qrRequest += 1;
    if (qrRequest >= 4) {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Sign in is required" }) });
      return;
    }
    const expired = qrRequest === 2;
    // Anchor freshness to the intercepted provider response, not test startup:
    // a cold fixture compiler can legitimately consume tens of seconds first.
    const responseNow = Date.now();
    const issuedAt = new Date(expired ? responseNow - 25_000 : responseNow).toISOString();
    const expiresAt = new Date(expired ? responseNow - 5_000 : responseNow + 60_000).toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        imageDataUrl: expired ? null : `data:image/png;base64,${png}`,
        providerState: "SCAN_QR_CODE",
        issuedAt,
        expiresAt,
        sequence: 2,
        expired,
      }),
    });
  });

  await open(page, "connections");
  await page.getByRole("button", { name: "View Returns desk connection details" }).click();
  const dialog = page.getByRole("dialog", { name: "Connection details" });
  await expect(dialog.getByRole("heading", { name: "Returns desk" })).toBeVisible();
  await expect(dialog.getByText("Last WhatsApp update", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "QR code for authorizing this WhatsApp connection" })).toBeVisible();
  const expandQr = dialog.getByRole("button", { name: "Expand QR code" });
  await expect(expandQr).toHaveAttribute("aria-expanded", "false");
  await expandQr.click();
  const reduceQr = dialog.getByRole("button", { name: "Reduce QR code" });
  await expect(reduceQr).toHaveAttribute("aria-expanded", "true");
  await reduceQr.click();
  expect(qrRequest).toBe(1);
  await expect(dialog.getByText("Code 2 of 6")).toBeVisible();
  await expect(dialog.getByText(/Valid for 0:/u)).toBeVisible();
  await dialog.getByRole("button", { name: "I finished scanning" }).click();
  await expect(dialog.getByRole("button", { name: "Scan acknowledged" })).toBeDisabled();

  await dialog.getByRole("button", { name: "Refresh QR code" }).click();
  await expect(dialog.getByText("QR code expired", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "QR code for authorizing this WhatsApp connection" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Restart QR authorization" })).toBeVisible();
  await expectAxeClean(page);

  // Background refresh must update the existing QR notice, not retain the
  // prior expired/not-ready message alongside a fresh provider QR.
  await expect(dialog.getByText(/^QR code refreshed\. It expires at /u)).toBeVisible();
  await expect(dialog.getByText("A fresh QR code is not ready yet. WasalX will keep checking automatically.")).toHaveCount(0);
  await expect(dialog.getByRole("img", { name: "QR code for authorizing this WhatsApp connection" })).toBeVisible();
  await dialog.getByRole("button", { name: "Refresh QR code" }).click();
  // A 401 must erase the image and surface sign-in recovery.
  await expect(page.getByRole("heading", { name: "Your session has ended" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", /\/auth\/login\?return_to=/u);
  await expect(dialog).toHaveCount(0);
});

(role === "tenant_owner" ? test : test.skip)("connection lifecycle polling reconciles stale provider health and surfaces QR automatically", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  test.setTimeout(20_000);
  const now = new Date().toISOString();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  let detailRequests = 0;
  let qrRequests = 0;
  let releaseSlowDetail = () => {};
  const slowDetail = new Promise<void>((resolve) => { releaseSlowDetail = resolve; });
  await page.route(/\/api\/connections\/12000000-0000-4000-8000-000000000002$/u, async (route) => {
    detailRequests += 1;
    const authorizationReady = detailRequests >= 2;
    if (!authorizationReady) await slowDetail;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "12000000-0000-4000-8000-000000000002",
        name: "Returns desk",
        provider: "WAHA",
        engine: "GOWS",
        state: authorizationReady ? "AWAITING_AUTH" : "CONNECTING",
        provider_session_state: authorizationReady ? "AWAITING_AUTH" : "FAILED",
        provider_state: authorizationReady ? "SCAN_QR_CODE" : "FAILED",
        group_count: 0,
        webhook_state: "ACTIVE",
        latest_operation_type: "RESTART",
        latest_operation_state: authorizationReady ? "SUCCEEDED" : "RUNNING",
        onboarding_qr_ready_at: authorizationReady ? now : null,
        onboarding_authorization_method: authorizationReady ? "QR" : null,
      }),
    });
    if (authorizationReady) releaseSlowDetail();
  });
  expectNetworkFailure(page, /\/api\/connections\/12000000-0000-4000-8000-000000000002\/auth\/qr$/u);
  await page.route(/\/api\/connections\/12000000-0000-4000-8000-000000000002\/auth\/qr$/u, async (route) => {
    qrRequests += 1;
    if (qrRequests === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary QR failure" }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        imageDataUrl: `data:image/png;base64,${png}`,
        providerState: "SCAN_QR_CODE",
        issuedAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        sequence: 1,
        expired: false,
      }),
    });
  });

  await open(page, "connections");
  await page.getByRole("button", { name: "View Returns desk connection details" }).click();
  const dialog = page.getByRole("dialog", { name: "Connection details" });
  await expect(dialog.getByText("Needs attention", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("img", { name: "QR code for authorizing this WhatsApp connection" })).toBeVisible({ timeout: 8_000 });
  expect(detailRequests).toBeGreaterThanOrEqual(2);
  expect(qrRequests).toBe(2);
  await expect(dialog.getByRole("heading", { name: "Connecting to WhatsApp" })).toHaveCount(0);
  await expectAxeClean(page);
});

(role === "tenant_owner" ? test : test.skip)("an expired session replaces initial connection loading with sign-in recovery", async ({ page }) => {

  const detailPath = /\/api\/connections\/12000000-0000-4000-8000-000000000002$/u;
  expectNetworkFailure(page, detailPath);
  await page.route(detailPath, async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "The portal session is invalid or expired" }),
    });
  });

  await open(page, "connections");
  await page.getByRole("button", { name: "View Returns desk connection details" }).click();
  await expect(page.getByRole("heading", { name: "Your session has ended" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", /\/auth\/login\?return_to=/u);
  await expect(page.getByRole("dialog", { name: "Connection details" })).toHaveCount(0);
  await expect(page.getByText("Loading connection state…")).toHaveCount(0);
  await expectAxeClean(page);
});

(role === "tenant_owner" ? test : test.skip)("a working WhatsApp connection still accepts a late scan acknowledgement", async ({ page }) => {

  const now = new Date();
  const workingAt = new Date(now.getTime() - 30_000).toISOString();
  let acknowledgedAt: string | null = null;
  await page.route(/\/api\/connections\/12000000-0000-4000-8000-000000000002$/u, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "12000000-0000-4000-8000-000000000002",
        name: "Returns desk",
        phone: "12025550101",
        provider: "WAHA",
        state: "WORKING",
        group_count: 2,
        last_heartbeat_at: now.toISOString(),
        last_provider_event_at: workingAt,
        provider_session_state: "WORKING",
        provider_state: "WORKING",
        worker_id: "wasalx-local-gows",
        worker_ready: true,
        webhook_state: "ACTIVE",
        onboarding_qr_ready_at: new Date(now.getTime() - 90_000).toISOString(),
        onboarding_authorization_method: "QR",
        onboarding_scan_acknowledged_at: acknowledgedAt,
        onboarding_scan_completed_at: null,
        onboarding_working_at: workingAt,
        onboarding_timing_eligible: false,
        onboarding_late_acknowledgement: Boolean(acknowledgedAt),
      }),
    });
  });
  await page.route(/\/api\/connections\/12000000-0000-4000-8000-000000000002\/auth\/scan-complete$/u, async (route) => {
    acknowledgedAt = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recordedAt: acknowledgedAt,
        acknowledgedAt,
        scanCompletedAt: null,
        providerWorkingAt: workingAt,
        timingEligible: false,
        lateAcknowledgement: true,
        duplicate: false,
      }),
    });
  });

  await open(page, "connections");
  await page.getByRole("button", { name: "View Returns desk connection details" }).click();
  const dialog = page.getByRole("dialog", { name: "Connection details" });
  await expect(dialog.getByRole("heading", { name: "Connected" })).toBeVisible();
  await dialog.getByRole("button", { name: "I finished scanning" }).click();
  await expect(dialog.getByText("Scan acknowledged. WhatsApp is connected.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "I finished scanning" })).toHaveCount(0);
  await expect(dialog.getByText("The completed scan has been recorded.")).toBeVisible();
  await expectAxeClean(page);
});

(role === "tenant_owner" ? test : test.skip)("a pairing-code connection never asks for QR scan acknowledgement", async ({ page }) => {

  const now = new Date().toISOString();
  await page.route(/\/api\/connections\/12000000-0000-4000-8000-000000000002$/u, async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      id: "12000000-0000-4000-8000-000000000002", name: "Returns desk", provider: "WAHA", state: "WORKING",
      provider_session_state: "WORKING", provider_state: "WORKING",
      worker_ready: true,
      onboarding_qr_ready_at: now, onboarding_authorization_method: "PAIRING_CODE",
      onboarding_scan_acknowledged_at: null, onboarding_scan_completed_at: null,
      onboarding_working_at: now, group_count: 0, webhook_state: "ACTIVE",
    }),
  }));
  await open(page, "connections");
  await page.getByRole("button", { name: "View Returns desk connection details" }).click();
  const dialog = page.getByRole("dialog", { name: "Connection details" });
  await expect(dialog.getByText("WhatsApp authorization")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "I finished scanning" })).toHaveCount(0);
  await expectAxeClean(page);
});

(role === "tenant_owner" ? test : test.skip)("an ambiguous pairing-code outcome stays visible after the provider state changes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  let failed = false;
  await page.route(/\/api\/connections\/12000000-0000-4000-8000-000000000002$/u, async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      id: "12000000-0000-4000-8000-000000000002", name: "Returns desk", provider: "WAHA", engine: "GOWS",
      state: failed ? "FAILED" : "AWAITING_AUTH", provider_session_state: failed ? "FAILED" : "AWAITING_AUTH",
      provider_state: failed ? "FAILED" : "SCAN_QR_CODE", group_count: 0, webhook_state: "ACTIVE",
    }),
  }));
  const safeError = "WhatsApp accepted the request, but WasalX could not finalize its status. Refresh the connection before trying again.";
  await page.route(/\/api\/connections\/12000000-0000-4000-8000-000000000002\/auth\/pairing-code$/u, async (route) => {
    failed = true;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: safeError }) });
  });
  expectNetworkFailure(page, /\/api\/connections\/12000000-0000-4000-8000-000000000002\/auth\/pairing-code$/u);

  await open(page, "connections");
  await page.getByRole("button", { name: "View Returns desk connection details" }).click();
  const dialog = page.getByRole("dialog", { name: "Connection details" });
  await dialog.getByRole("button", { name: "Use a pairing code instead" }).click();
  const phone = dialog.getByRole("textbox", { name: "WhatsApp number" });
  await phone.fill("+12025550131");
  await dialog.getByRole("button", { name: "Request pairing code" }).click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText("This service is temporarily unavailable.");
  await expect(alert.getByRole("button", { name: "Retry same request" })).toBeVisible();
  await phone.fill("");
  await expect(dialog.locator(".connection-detail-shell")).not.toHaveAttribute("data-unsaved");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(dialog.getByRole("heading", { name: "Connection failed" })).toBeVisible();
  await expect(alert).toContainText("This service is temporarily unavailable.");
  await expect(alert.getByRole("button", { name: "Retry same request" })).toBeVisible();
  await expectAxeClean(page);
});

test("duplicate cleanup reconciles the connection list immediately on close", async ({ page }) => {
  await page.route(/\/api\/connections\/12000000-0000-4000-8000-000000000002$/u, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "12000000-0000-4000-8000-000000000002",
        name: "Returns desk",
        phone: "Pending verification",
        provider: "WAHA",
        engine: "GOWS",
        state: "REVOKED",
        group_count: 0,
        last_provider_event_at: new Date().toISOString(),
        action_reason: "This WhatsApp account is already connected in this workspace. The duplicate linked session was removed.",
        webhook_state: "REVOKED",
        latest_operation_type: "DISCONNECT",
        latest_operation_state: "SUCCEEDED",
        latest_operation_attempts: 1,
      }),
    });
  });

  await open(page, "connections");
  const opener = page.getByRole("button", { name: "View Returns desk connection details" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Connection details" });
  await expect(dialog.getByRole("heading", { name: "Duplicate connection removed" })).toBeVisible();
  await expect(dialog.getByText("Recovery controls are disabled for this rejected duplicate.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(page.getByRole("row", { name: /Returns desk.*Revoked.*extra linked connection was removed/u })).toBeVisible();
  await expect(navigationLink(page, "Connections").locator("em")).toHaveCount(0);
  await page.getByRole("button", { name: /operational notification/u }).click();
  const notifications = page.getByRole("region", { name: "Operational notifications" });
  await expect(notifications).not.toContainText("Returns desk");
  await notifications.getByRole("button", { name: "Close", exact: true }).click();
  await expect(notifications).toBeHidden();
  await expectAxeClean(page);
});

(role === "tenant_owner" ? test : test.skip)("owner configures a group and validates normalized identifiers", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");

  await open(page, "groups");
  await page.getByRole("button", { name: "Configure Riyadh · Last mile" }).click();
  await expect(page.getByRole("heading", { name: /Riyadh · Last mile/u })).toBeVisible();
  await page.getByLabel("Group state").selectOption("DRAFT");
  await page.getByLabel("Agent reply label").fill("E2E Support");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator(".toast")).toContainText("Group configuration saved");

  await open(page, "rules");
  await page.getByLabel("Sample WhatsApp message").fill("Shipment ١٢٣٤٥٦٧٨٩٠ and case ABC1234567");
  await page.getByRole("button", { name: "Run test" }).click();
  await expect(page.locator(".test-result")).toContainText("1234567890");
  await expect(page.locator(".test-result")).toContainText("ABC1234567");
  await page.getByLabel("Sample WhatsApp message").fill(Array.from({ length: 21 }, (_, index) => String(1_000_000_000 + index)).join(" "));
  await page.getByRole("button", { name: "Run test" }).click();
  await expect(page.locator(".test-result")).toContainText("Would be held for review because it exceeds the group limit of 20.");
  await page.getByRole("button", { name: "Inspect Ten-digit shipment ID" }).click();
  await page.keyboard.press("Escape");
});

(role === "tenant_owner" ? test : test.skip)("unknown group member counts remain distinct from known counts in both locales", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const withCounts = (rows: Array<Record<string, unknown>>) => {
    expect(rows.length).toBeGreaterThanOrEqual(2);
    return rows.slice(0, 2).map((row, index) => ({ ...row, name: "Count provenance", members: index === 0 ? null : 7 }));
  };
  await page.route("**/api/dashboard", async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.data.groups = withCounts(data.data.groups);
    await route.fulfill({ response, json: data });
  });
  const refreshCounts = async () => {
    const refreshed = page.waitForResponse(response => response.url().endsWith("/api/dashboard"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await refreshed;
  };
  await open(page, "groups");
  for (const language of ["en", "ar"] as const) {
    if (language === "ar") {
      await page.getByRole("button", { name: "العربية" }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", "ar");
      await page.locator("nav").getByRole("link", { name: "المجموعات", exact: true }).click();
    }
    await refreshCounts();
    await expect(page.getByTitle(language === "en" ? "Count not available from WhatsApp" : "عدد الأعضاء غير متاح من واتساب", { exact: true })).toHaveText("—");
    await expect(page.getByRole("cell", { name: language === "en" ? "7" : "٧", exact: true })).toBeVisible();
    // Client navigation preserves the refreshed fixture; a full SSR reload would restore its original groups.
    await page.locator("nav").getByRole("link", { name: language === "en" ? "Rules" : "القواعد", exact: true }).click();
    await expect(page.locator("select option").filter({ hasText: language === "en" ? /Count provenance.*Members: —/u : /Count provenance.*الأعضاء: —/u })).toHaveCount(1);
    await expect(page.locator("select option").filter({ hasText: language === "en" ? /Count provenance.*7 members/u : /Count provenance.*٧ عضوًا/u })).toHaveCount(1);
  }
});

(role === "tenant_owner" ? test : test.skip)("owner enables bounded group history and grants agent access", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");

  await open(page, "groups");
  await page.getByRole("button", { name: "Configure Riyadh · Last mile" }).click();
  const dialog = page.getByRole("dialog", { name: "Riyadh · Last mile" });
  const history = dialog.getByRole("region", { name: "Agent group history" });
  await expect(history).toBeVisible();
  await expect(history).toContainText("Earlier messages are never imported.");

  const capture = history.getByRole("checkbox", { name: "Capture new group messages" });
  if (!(await capture.isChecked())) await capture.check();
  const retention = history.getByLabel("History retention in days");
  const originalRetention = await retention.inputValue();
  await retention.fill("0");
  await expect(history).toContainText("Retention must be between 1 and 3,650 days.");
  await expect(history.getByRole("button", { name: "Save history settings" })).toBeDisabled();
  await retention.fill(originalRetention === "120" ? "121" : "120");
  await history.getByRole("button", { name: "Save history settings" }).click();
  await expect(history.getByRole("status")).toContainText("Group history settings saved.");

  const grants = history.locator(".group-history-grants");
  if (!(await grants.getByText("Riyadh Operations", { exact: true }).isVisible())) {
    const team = history.getByRole("combobox", { name: "Support team" });
    await team.fill("Riyadh");
    await history.getByRole("option", { name: /Riyadh Operations/u }).click();
    await history.getByRole("button", { name: "Add access" }).click();
  }
  await expect(grants.getByText("Riyadh Operations", { exact: true })).toBeVisible();
  await expect(history).toContainText("Ticket access does not automatically grant group history access.");
  await expectAxeClean(page);

  await page.keyboard.press("Escape");
  await open(page, "settings");
  await page.getByRole("tab", { name: "Group history" }).click();
  await expect(page.getByRole("heading", { name: "Group history defaults" })).toBeVisible();
  await expect(page.getByText("Messages received before capture is enabled are not imported or presented as history.")).toBeVisible();
  await expect(page.getByLabel("Default retention in days")).toHaveValue("90");
  await expectAxeClean(page);
  await page.getByRole("button", { name: "العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.getByRole("heading", { name: "إعدادات سجل المجموعات" })).toBeVisible();
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "Group history defaults" })).toBeVisible();
});

(role === "tenant_owner" ? test : test.skip)("owner inspects delivery receipts and bounded review evidence", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");

  await open(page, "deliveries");
  await page.getByRole("button", { name: "Inspect" }).first().click();
  await expect(page.getByRole("heading", { name: "Delivery timeline" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Current delivery state" })).toBeVisible();
  await page.getByRole("button", { name: "Close delivery details" }).click();
  await page.getByRole("button", { name: "Operator review" }).click();
  await expect(page.getByText("Manual review queue")).toBeVisible();
  const identifierReview = page.getByRole("row", { name: /Identifier limit exceeded/iu });
  await identifierReview.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Identifier limit exceeded/iu })).toBeVisible();
  await page.getByRole("button", { name: "Close review item" }).click();
});

(role === "tenant_owner" ? test : test.skip)("closed reviews show their disposition while retaining the original reason", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  for (const [state, heading] of [["RESOLVED", "Review resolved"], ["DISCARDED", "Review dismissed"]]) {
    const review = { id: "33333333-3333-4333-8333-333333333333", state, version: 2,
      reason_code: "PROVIDER_OUTCOME_UNKNOWN", source_kind: "OUTBOUND", delivery_id: "44444444-4444-4444-8444-444444444444",
      created_at: new Date().toISOString(), safe_metadata: {} };
    await page.route("**/api/reviews", route => route.fulfill({ json: [review] }));
    await page.route(`**/api/reviews/${review.id}`, route => route.fulfill({ json: review }));
    await open(page, "deliveries");
    await page.getByRole("button", { name: "Operator review", exact: true }).click();
    await page.getByRole("row").filter({ hasText: heading }).getByRole("button", { name: "Review", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: heading, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("This review is closed. Original reason: Delivery outcome unknown.", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "I verified delivery", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Close review item", exact: true }).click();
    await page.unroute("**/api/reviews");
    await page.unroute(`**/api/reviews/${review.id}`);
  }
});

(role === "tenant_owner" ? test : test.skip)("unknown outcomes require separate completion confirmation and retain request identity", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  expectedNetworkErrors.set(page, [/\/api\/reviews\/(?:33333333-3333-4333-8333-333333333333|44444444-4444-4444-8444-444444444444)\/resolve$/u]);
  for (const item of [
    { reason: "Delivery outcome unknown", action: "I verified — record as sent", title: "Record this message as sent?", code: "DELIVERY_CONFIRMED_SENT", confirmation: "SENT" },
    { reason: "External action outcome unknown", action: "I verified — record as completed", title: "Record this action as completed?", code: "ACTION_ALREADY_COMPLETED", confirmation: undefined },
  ]) {
    const requests: Array<{ key: string | undefined; body: Record<string, unknown> }> = [];
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/reviews/*/resolve", async route => {
      requests.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
      await held;
      if (requests.length === 1) await route.abort("failed");
      else await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await open(page, "deliveries");
    await page.getByRole("button", { name: "Operator review", exact: true }).click();
    await page.getByRole("row").filter({ hasText: item.reason }).getByRole("button", { name: "Review", exact: true }).click();
    const trigger = page.getByRole("button", { name: item.action, exact: true });
    await trigger.click();
    const confirmation = page.getByRole("alertdialog", { name: item.title, exact: true });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    expect(requests).toHaveLength(0);
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(requests).toHaveLength(0);
    await trigger.click();
    const confirm = confirmation.getByRole("button", { name: item.action, exact: true });
    await confirm.click();
    await expect.poll(() => requests.length).toBe(1);
    await expect(confirmation.getByRole("button", { name: "Recording…", exact: true })).toBeDisabled();
    expect(requests[0].body).toMatchObject({ expectedVersion: 1, resolutionCode: item.code });
    expect(requests[0].body.confirmation).toBe(item.confirmation);
    release();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].key).toBe(requests[0].key);
    expect(requests[0].key).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(confirmation).toBeHidden();
    await expect(page.getByRole("button", { name: "Close review item", exact: true })).toBeHidden();
    await page.unroute("**/api/reviews/*/resolve");
  }
});

(role === "tenant_owner" ? test : test.skip)("delivery retry blocks overlapping clicks and reuses the uncertain request key", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  expectedNetworkErrors.set(page, [/\/api\/deliveries\/16000000-0000-4000-8000-000000000003\/retry$/u]);
  const keys: Array<string | undefined> = [];
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/deliveries/*/retry", async route => {
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length === 1) { await held; await route.abort("failed"); }
    else await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await open(page, "deliveries");
  const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Retry", exact: true }) }).first();
  await row.getByRole("button", { name: "Retry", exact: true }).click();
  const pending = page.getByRole("button", { name: "Scheduling retry…", exact: true });
  await expect(pending).toBeDisabled();
  await expect.poll(() => keys.length).toBe(1);
  await pending.evaluate(button => (button as HTMLButtonElement).click());
  expect(keys).toHaveLength(1);
  release();
  await expect(page.getByRole("button", { name: "Retry same request", exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
  await expect(page.getByRole("status")).toContainText("Delivery scheduled for another attempt.");
  await row.getByRole("button", { name: "Retry", exact: true }).click();
  expect(keys).toHaveLength(2);
});

(role === "tenant_owner" ? test : test.skip)("an open delivery timeline refreshes quietly while the operator is reading", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  let requests = 0;
  let releaseRefresh = () => {};
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  await page.route(/\/api\/deliveries\/16000000-0000-4000-8000-000000000003$/u, async (route) => {
    requests += 1;
    const response = await route.fetch();
    const body = await response.json() as Record<string, unknown>;
    if (requests === 2) await refreshGate;
    await route.fulfill({
      response,
      json: {
        ...body,
        state: "QUEUED",
        hold_reason: "waiting_for_inbound",
        available_at: new Date(Date.now() + (requests === 1 ? 180_000 : 540_000)).toISOString(),
      },
    });
  });

  await page.goto("/app?view=deliveries&delivery=16000000-0000-4000-8000-000000000003");
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "Delivery timeline" });
  await expect(dialog.getByText("Next automatic check:", { exact: true })).toBeVisible();
  await expect(dialog.getByText("in 3 minutes", { exact: true })).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => requests).toBe(2);
  await expect(dialog.getByText("Loading delivery evidence…", { exact: true })).toHaveCount(0);
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/deliveries/16000000-0000-4000-8000-000000000003"));
  releaseRefresh();
  await refreshed;
  await expect(dialog.getByText("in 9 minutes", { exact: true })).toBeVisible();
});

(role === "tenant_owner" ? test : test.skip)("typed case and delivery links preserve context and open the exact operational record", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");

  // A selected friendly ticket must resolve to a distinct native ID; never
  // treat a case number as an article or ticket database identifier.
  const selectedTicket = { id: "382", number: "10382", title: "Riyadh delivery support", updated_at: "2026-10-17T10:00:00.000Z",
    state: "open", closed: false, team: "Riyadh Operations", team_id: "28", owner: null, owner_id: "1", customer: "Riyadh customer", channel: "whatsapp" };
  const selectedArticle = { id: "9082", body: "Source message for case 10382", body_complete: true, body_sha256: "d5796b138b95caa7fe18a6e789f7ea2f111a066e747bed3b266342b40bd83f94", total_characters: 29,
    internal: false, author: "Riyadh customer", sender: "Customer", created_at: "2026-10-17T10:00:00.000Z", attachments: [] };
  const inboxReads: Array<{ operation: string; input: Record<string, unknown> }> = [];
  await page.route("**/api/inbox", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    let payload: unknown;
    try { payload = route.request().postDataJSON(); } catch { return route.fallback(); }
    const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
    if (!plain(payload) || Object.keys(payload).sort().join(",") !== "input,operation" || typeof payload.operation !== "string" || !plain(payload.input)) return route.fallback();
    const { operation, input } = payload;
    const exact = (value: Record<string, unknown>) => JSON.stringify(Object.entries(input).sort()) === JSON.stringify(Object.entries(value).sort());
    let result: unknown;
    if (operation === "CHECK" && exact({})) result = { allowed: true };
    else if (operation === "LIST" && exact({ limit: 50, state: "open" })) result = { items: [], next_cursor: null };
    else if (operation === "LIST" && exact({ ticket_number: selectedTicket.number, limit: 1 })) result = { items: [selectedTicket], next_cursor: null };
    else if (operation === "SHOW" && exact({ ticket_id: selectedTicket.id })) result = { ...selectedTicket, teams: [{ id: selectedTicket.team_id, name: selectedTicket.team }], owner_team_id: selectedTicket.team_id,
      can_update: false, can_reply: false, owners: [], states: [{ id: "2", name: "open", closed: false }],
      upload_constraints: { accepted: null, maximum_file_bytes: 1048576, maximum_files: 1, maximum_total_bytes: 1048576 } };
    else if (operation === "ARTICLES" && exact({ ticket_id: selectedTicket.id, limit: 50 })) result = { items: [selectedArticle], next_cursor: null };
    else return route.fallback();
    inboxReads.push({ operation, input });
    await route.fulfill({ status: 200, json: result });
  });

  await page.goto("/app?view=cases&ticket=10382");
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Cases" })).toBeVisible();
  await expect(page.getByLabel("Search linked cases")).toHaveValue("10382");
  await expect(page.getByRole("status")).toContainText(/showing the link for support case.*#10382/iu);
  await expect(page.getByRole("row", { name: /1234567890.*10382/u })).toBeVisible();
  await expect(page).toHaveURL(/[?&]view=cases(?:&|$).*ticket=10382/u);

  await page.evaluate(() => {
    window.history.pushState({ wasalxView: "cases" }, "", "/app?view=cases&ticket=10381");
    window.dispatchEvent(new PopStateEvent("popstate", { state: { wasalxView: "cases" } }));
  });
  await expect(page.getByLabel("Search linked cases")).toHaveValue("10381");
  await expect(page.getByRole("status")).toContainText(/showing the link for support case.*#10381/iu);
  await expect(page.getByRole("row", { name: /ABC1234567.*10381/u })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("Search linked cases")).toHaveValue("10382");
  await expect(page.getByRole("row", { name: /1234567890.*10382/u })).toBeVisible();

  await open(page, "deliveries");
  await page.getByRole("button", { name: "Open case #10382" }).click();
  await expect(page).toHaveURL(/[?&]view=inbox(?:&|$).*ticket=10382/u);
  await expect(page.getByRole("heading", { level: 2, name: selectedTicket.title, exact: true })).toBeVisible();
  await expect(page.locator('[data-article-id="9082"]')).toContainText(selectedArticle.body);
  expect(inboxReads).toEqual(expect.arrayContaining([
    { operation: "LIST", input: { ticket_number: "10382", limit: 1 } },
    { operation: "SHOW", input: { ticket_id: "382" } },
    { operation: "ARTICLES", input: { ticket_id: "382", limit: 50 } },
  ]));
  await expectAxeClean(page);
  await page.goBack();
  await expect(page).toHaveURL(/[?&]view=deliveries(?:&|$)/u);
  await expect(page.getByRole("heading", { level: 1, name: "Message delivery" })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/[?&]view=inbox(?:&|$).*ticket=10382/u);
  await expect(page.getByRole("heading", { level: 2, name: selectedTicket.title, exact: true })).toBeVisible();
  await expect(page.locator('[data-article-id="9082"]')).toContainText(selectedArticle.body);

  await page.goto("/app?view=deliveries&delivery=16000000-0000-4000-8000-000000000003");
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Delivery timeline" })).toBeVisible();
  await page.getByRole("button", { name: "Close delivery details" }).click();
  await expect(page).toHaveURL(/[?&]view=deliveries(?:&|$)/u);
  await expect(page).not.toHaveURL(/[?&]delivery=/u);

  await open(page);
  await page.getByRole("button", { name: /Needs attention/u }).click();
  await expect(page).toHaveURL(/[?&]view=deliveries(?:&|$).*delivery=16000000-0000-4000-8000-000000000002/u);
  await expect(page.getByRole("heading", { name: "Delivery timeline" })).toBeVisible();
  await expectAxeClean(page);
});

(role === "tenant_owner" ? test : test.skip)("a rejected mutation is announced and retries the same request safely", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await open(page, "groups");
  let rejectOnce = true;
  expectNetworkFailure(page, /\/api\/groups\/grp_riyadh\/toggle$/u);
  await page.route("**/api/groups/grp_riyadh/toggle", async (route) => {
    if (route.request().method() === "POST" && rejectOnce) {
      rejectOnce = false;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  const toggle = page.getByRole("button", {
    name: /^(?:Pause|Activate) Riyadh · Last mile$/u,
  });
  const wasActive = (await toggle.getAttribute("aria-pressed")) === "true";
  await toggle.click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Check your connection and try again.");
  await alert.getByRole("button", { name: "Retry same request" }).click();
  await expect(page.getByRole("status")).toContainText(
    wasActive ? "Group automation paused" : "Group automation activated",
  );
  await expect(page.getByRole("button", {
    name: `${wasActive ? "Activate" : "Pause"} Riyadh · Last mile`,
  })).toBeVisible();
});

(role === "tenant_owner" ? test : test.skip)("settings protect unsaved work during in-app navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await open(page, "settings");
  const workspaceName = page.getByLabel("Workspace name", { exact: true });
  await workspaceName.fill("Northstar Logistics draft");

  const stayClick = navigationLink(page, "Overview").click();
  const stay = await page.waitForEvent("dialog");
  expect(stay.type()).toBe("confirm");
  expect(stay.message()).toContain("unsaved changes");
  await stay.dismiss();
  await stayClick;
  await expect(page).toHaveURL(/[?&]view=settings(?:&|$)/u);
  await expect(workspaceName).toHaveValue("Northstar Logistics draft");

  const leaveClick = navigationLink(page, "Overview").click();
  const leave = await page.waitForEvent("dialog");
  await leave.accept();
  await leaveClick;
  await expect(page).toHaveURL(/\/app$/u);
  await expect(page.getByRole("heading", { level: 1, name: "Operational overview" })).toBeVisible();
});

(role === "tenant_owner" ? test : test.skip)("owner completes team, support, privacy, and audit governance workflows", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");

  await open(page, "team");
  await expect(page.getByRole("region", { name: "Team access summary" })).toContainText("Tenant owner");
  await page.getByRole("button", { name: /Invite member/u }).click();
  await page.getByLabel("Email address").fill(`e2e.operator+retry-${testInfo.retry}@example.test`);
  await page.getByLabel("Display name").fill("E2E Operator");
  await page.getByRole("button", { name: "Send invitation" }).click();
  const invitationFeedback = page.locator(".team-feedback[role=\"status\"]");
  await expect(invitationFeedback).toBeVisible();
  await expect(invitationFeedback).toContainText("Invitation scheduled.");

  await open(page, "support");
  await page.getByRole("button", { name: "Review" }).first().click();
  await expect(page.getByRole("button", { name: "Approve metadata access…" })).toBeVisible();
  await page.getByRole("button", { name: "Close support access" }).click();

  await open(page, "settings");
  await page.getByRole("tab", { name: "Privacy & retention" }).click();
  await expect(page.getByRole("heading", { name: "Retention and deletion policy" })).toBeVisible();
  await page.getByRole("button", { name: "العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "Retention and deletion policy" })).toBeVisible();
  await page.getByRole("button", { name: "Request export" }).click();
  const exportDialog = page.getByRole("dialog", { name: "Request export" });
  await exportDialog.getByLabel("Exact scope value").fill("ABC1234567");
  await exportDialog.getByRole("button", { name: "Request export", exact: true }).click();
  const exportFeedback = page.locator(".privacy-settings .privacy-feedback[role=\"status\"]");
  await expect(exportFeedback).toBeVisible();
  await expect(exportFeedback).toContainText("Export request submitted for protected processing.");

  await open(page, "audit");
  await page.getByRole("button", { name: "Export CSV…" }).click();
  await expect(page.getByRole("heading", { name: "Download a redacted CSV" })).toBeVisible();
  await page.keyboard.press("Escape");
});

(role === "tenant_admin" ? test : test.skip)("tenant administrator can configure operations but not owner-only policy or support decisions", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await open(page, "groups");
  await expect(page.getByRole("button", { name: "Configure Riyadh · Last mile" })).toBeVisible();
  await open(page, "rules");
  await expect(page.getByRole("button", { name: /New rule/u })).toBeVisible();
  await open(page, "team");
  await expect(page.getByRole("button", { name: /Invite member/u })).toBeVisible();
  await open(page, "support");
  await page.getByRole("button", { name: "Review" }).first().click();
  await expect(page.getByText("Read-only access")).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve metadata access/u })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await open(page, "settings");
  await expect(page.getByText("Read-only policy view")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
});

(role === "supervisor" ? test : test.skip)("supervisor handles case and delivery recovery while administration remains read-only", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await open(page, "cases");
  const detach = page.getByRole("button", { name: /Prepare the next case for/ }).first();
  await detach.click();
  await expect(page.getByRole("alertdialog", { name: "Prepare the next case?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expectAxeClean(page);
  await page.keyboard.press("Escape");
  await expect(detach).toBeFocused();
  await open(page, "deliveries");
  await page.getByRole("button", { name: "Needs attention" }).click();
  const retry = page.getByRole("button", { name: "Retry", exact: true }).first();
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.getByRole("status")).toContainText("Delivery scheduled for another attempt.");
  await open(page, "team");
  await expect(page.getByText("Read-only access")).toBeVisible();
  await page.evaluate(() => window.sessionStorage.setItem("wasalx:settings-section", "privacy"));
  await open(page, "settings");
  await expect(page.getByRole("tab", { name: "Privacy & retention" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Workspace profile" })).toBeVisible();
  await expect(page.getByText("Read-only policy view")).toBeVisible();
});

(role === "agent" ? test : test.skip)("agent sees operational queues without tenant administration, review, or retry controls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await open(page, "deliveries");
  await expect(page.getByRole("button", { name: "Operator review" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reveal…" }).first()).toBeVisible();
  await open(page, "groups");
  await expect(page.getByRole("button", { name: "View Riyadh · Last mile" })).toBeVisible();
  await page.goto("/app?view=settings");
  await expect(page.getByRole("heading", { level: 1, name: "Operational overview" })).toBeVisible();
  await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/app\/?$/u);
});

(role === "auditor" ? test : test.skip)("auditor receives redacted evidence and read-only governance controls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await open(page, "deliveries");
  await expect(page.getByText("Message content redacted").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Reveal…" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Operator review" }).click();
  await expect(page.getByText("Manual review queue")).toBeVisible();
  const identifierReview = page.getByRole("row", { name: /Identifier limit exceeded/iu });
  await identifierReview.getByRole("button", { name: "Review" }).click();
  const reviewDialog = page.getByRole("dialog", { name: /Identifier limit exceeded/iu });
  await expect(reviewDialog).toBeVisible();
  await expect(reviewDialog.getByText("Read-only review")).toBeVisible();
  await page.keyboard.press("Escape");
  await open(page, "settings");
  await page.getByRole("tab", { name: "Privacy & retention" }).click();
  await expect(page.getByText("Auditors can review this policy and its evidence but cannot change it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save policy" })).toBeDisabled();
  await open(page, "audit");
  await expect(page.getByRole("button", { name: "Export CSV…" })).toBeVisible();
});

// #540: the privacy panel must reflow at 390 and 320 px (WCAG 2.2 reflow) in both directions.
(role === "tenant_owner" ? test : test.skip)("privacy panel fits narrow viewports and reaches every action", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390");
  await open(page, "settings");
  await page.getByRole("tab", { name: "Privacy & retention" }).click();
  const panel = page.getByRole("tabpanel");
  for (const language of ["English", "العربية"]) {
    if (language !== "English") {
      await page.getByRole("button", { name: language }).click();
      // #569: the switch reloads the document; wait for the Arabic one before reading the panel.
      await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    }
    await expect(panel.getByRole("table")).toHaveCount(2);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const box = await panel.boundingBox();
      expect(box, `privacy panel at ${width} px in ${language}`).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      for (const action of await panel.getByRole("button").all()) {
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeInViewport();
      }
    }
  }
});

(role === "tenant_owner" ? test : test.skip)("async page failure exposes a plain-language recovery action", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  let failOnce = true;
  expectNetworkFailure(page, /\/api\/support-access$/u);
  await page.route("**/api/support-access", async (route) => {
    if (route.request().method() === "GET" && failOnce) {
      failOnce = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Support evidence is temporarily unavailable." }) });
      return;
    }
    await route.continue();
  });
  await open(page, "support");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Support requests unavailable");
  await expect(alert).toContainText("temporarily unavailable");
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Access requests" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review" }).first()).toBeVisible();
});

(role === "tenant_owner" ? test : test.skip)("disconnect confirmation focuses input and Cancel restores trigger without relaxing typed gate", async ({ page }) => {
  const writes: string[] = [];
  await page.route("**/api/connections/*/disconnect", async route => {
    writes.push(route.request().method());
    await route.abort("blockedbyclient");
  });
  await open(page, "connections");
  await page.getByRole("button", { name: "View Operations line connection details", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connection details", exact: true });
  const trigger = dialog.getByRole("button", { name: "Disconnect", exact: true });
  await expect(trigger).toBeEnabled();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const panel = dialog.locator(".connection-detail-disconnect");
  const input = panel.getByRole("textbox");
  const confirm = panel.getByRole("button", { name: "Disconnect WhatsApp", exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await expect(confirm).toBeDisabled();
  for (const invalid of ["disconnect", "DISCONNEC", " DISCONNECT", "DISCONNECT "]) {
    await input.fill(invalid);
    await expect(confirm).toBeDisabled();
  }
  await input.fill("DISCONNECT");
  await expect(confirm).toBeEnabled();
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await expect(confirm).toBeDisabled();
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();
  expect(writes).toEqual([]);
});

// Append to tests/e2e/application.spec.ts. Existing role/open/expect/test only.
(role === "tenant_owner" ? test : test.skip)("tablet group grant controls and save footer remain unobstructed", { tag: ["@tablet", "@tablet-only"] }, async ({ page }) => {
  const mutations: string[] = [];
  await page.route("**/api/group-workspace/groups/*", async route => {
    if (route.request().method() !== "GET") {
      mutations.push(route.request().method());
      await route.abort("blockedbyclient");
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    expect(Array.isArray(body.grants)).toBe(true);
    // Deterministic scroll pressure at the existing fixture API boundary.
    // These grants are display fixtures; no grant is created or removed.
    await route.fulfill({ response, json: { ...body, visibility: "RESTRICTED", grants: Array.from({ length: 20 }, (_, i) => ({
      id: `99000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      subject_type: "TEAM", subject_external_id: "1"
    })) } });
  });
  await open(page, "groups");
  await page.getByRole("button", { name: "Configure Riyadh · Last mile", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Riyadh · Last mile", exact: true });
  const history = dialog.getByRole("region", { name: "Agent group history", exact: true });
  const picker = history.getByRole("combobox", { name: "Support team", exact: true });
  await expect(picker).toBeEnabled();
  await picker.scrollIntoViewIfNeeded();
  await picker.click({ trial: true });
  await picker.click();
  await expect(picker).toBeFocused();
  const lastGrant = history.locator(".group-history-grants > div").last();
  await expect(history.locator(".group-history-grants > div")).toHaveCount(20);
  const remove = lastGrant.getByRole("button", { name: /^Remove: /u });
  await remove.scrollIntoViewIfNeeded();
  await remove.click({ trial: true });
  const footer = dialog.locator(".group-drawer-footer");
  const save = footer.locator('button[type="submit"]');
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeVisible();
  expect(await save.evaluate(element => {
    const r = element.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return y >= 0 && y < innerHeight && x >= 0 && x < innerWidth && !!hit && (hit === element || element.contains(hit));
  })).toBe(true);
  await footer.getByRole("button", { name: "Close", exact: true }).click({ trial: true });
  expect(mutations).toEqual([]);
});

// Append to tests/e2e/application.spec.ts; existing fixture/open()/role only.
(role === "tenant_owner" ? test : test.skip)("member number validation explains invalid and normalized duplicate numbers without PATCH", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await open(page, "team");
  const readTeam = () => page.evaluate(async () => {
    const response = await fetch("/api/team", { cache: "no-store" });
    if (!response.ok) throw new Error("Team fixture readback failed");
    return response.json() as Promise<TeamAccessData>;
  });
  const before = await readTeam();
  const member = before.members.find(row => row.role !== "tenant_owner" && !row.is_current_user);
  expect(member).toBeTruthy();
  if (!member) throw new Error("Non-owner fixture member missing");
  const storedNumbers = member.whatsapp_numbers ?? [];
  if (!Array.isArray(storedNumbers) || !storedNumbers.every(value => typeof value === "string") || typeof member.display_name !== "string") throw new Error("Invalid team fixture shape");
  const originalNumbers = storedNumbers.join("\n");
  const patches: string[] = [];
  await page.route("**/api/team/members/*", async route => {
    if (route.request().method() === "PATCH") {
      patches.push(new URL(route.request().url()).pathname);
      await route.abort("blockedbyclient");
    } else await route.continue();
  });
  const row = page.getByRole("row").filter({ has: page.getByText(member.display_name, { exact: true }) });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Manage", exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ has: page.locator("#member-whatsapp") });
  const numbers = dialog.locator("#member-whatsapp");
  const save = dialog.getByRole("button", { name: "Save access", exact: true });
  await expect(numbers).toHaveValue(originalNumbers);
  await numbers.fill("not-a-number");
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText("WhatsApp numbers: enter each number in international format, starting with + and the country code.");
  expect(patches).toEqual([]);
  await numbers.fill("+12025550142\n+1 (202) 555-0142");
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText("WhatsApp numbers: remove repeated numbers, including differently formatted copies.");
  await expect(dialog.getByRole("alert")).not.toContainText("international format");
  expect(patches).toEqual([]);
  const after = await readTeam();
  expect(after.members.find(entry => entry.id === member.id)).toEqual(member);
  await numbers.fill(originalNumbers);
  await expect(save).toBeDisabled();
});

(role === "tenant_owner" ? test : test.skip)("ticket event workflows edit publish and bind with pinned versions", async ({ page }, testInfo) => {
  test.skip(!["desktop","mobile-390"].includes(testInfo.project.name));
  await ticketEventWorkflowJourney(page, testInfo, "en");
});


(role === "tenant_owner" ? test : test.skip)("keep-open bot policy preserves legacy and immutable draft settings", async ({ page }, testInfo) => {
  test.skip(!["desktop", "mobile-390"].includes(testInfo.project.name));
  await keepOpenPolicyJourney(page, testInfo, "en");
});
test("en deletion receipt status stays truthful and out of URL queries", async ({ page }, testInfo) => {
  test.skip(role !== "tenant_owner");
  await metaDeletionStatusJourney(page, "en", testInfo);
});
