import { installWorkspaceReadFixture } from "./workspace-read.fixture";
import { auditWorkspaceJourney } from "./audit-workspace.fixture";
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
import { expectAxeClean } from "../helpers/axe";
import { expect, test, type Page } from "@playwright/test";
import { arabicMessages } from "../../lib/i18n/messages/ar/index.ts";

const role = process.env.WASALX_E2E_ROLE ?? "tenant_owner";
test("Audit uses localized workspace actions and truthful actors with permitted CSV export", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "tablet-820");
  await auditWorkspaceJourney(page, "ar", role, testInfo);
});
test("retryable human handoff has a fenced operator retry without resume or close", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "tablet-820");
  await handoffRetryJourney(page, "ar", role);
});

test("Arabic native routing sync keeps explicit queue policies separate from native readback", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(testInfo.project.name === "tablet-820");
  await nativeRoutingSyncJourney(page, testInfo, "ar", role);
});
test("Arabic fixed handoff agent selection preserves explicit and omitted immutable draft behavior", async ({ page }, testInfo) => {
  test.skip(role !== "tenant_owner" || testInfo.project.name === "tablet-820");
  test.setTimeout(90_000);
  await fixedHandoffOwnerJourney(page, testInfo, "ar");
});
(role !== "agent" ? test : test.skip)("Arabic linked account observations warn without changing Source membership", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "tablet-820");
  test.setTimeout(90_000);
  await accountObservationJourney(page, testInfo, "ar");
});

test("Meta saved access enables receiving only after current checks", async ({page},testInfo)=>{
 test.setTimeout(90_000);test.skip(testInfo.project.name==="tablet-820");
 await metaSavedActivationJourney(page,"ar",role,testInfo);
});

test("Meta number release preserves reservation review and exact uncertain recovery",async({page},testInfo)=>{
 test.setTimeout(120_000);test.skip(testInfo.project.name==='tablet-820');
 await metaNumberReleaseJourney(page,'ar',role,testInfo);
});

test("Meta existing-number access stays paused and recovers without registration or replay", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  test.skip(testInfo.project.name === "tablet-820");
  await metaAddAccessJourney(page, "ar", role, testInfo);
});

test("Arabic Meta external routing preserves exact lost-response recovery and separate bot state", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  test.skip(testInfo.project.name === "tablet-820");
  await metaRoutingJourney(page, "ar", role, testInfo);
});

test("Meta Business app consent and inert imports preserve unknown and stopped states", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  test.skip(testInfo.project.name === "tablet-820");
  await metaCoexistenceJourney(page, "ar", role, testInfo);
});

test("Meta legacy move retains original requests, one-use access and paused completion", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  test.skip(testInfo.project.name === "tablet-820");
  test.skip(!["tenant_owner", "tenant_admin"].includes(role));
  await metaLegacyMigrationJourney(page, "ar", role, testInfo);
});

test("Meta template preparation retains original requests and never grants number transfer", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  test.skip(testInfo.project.name === "tablet-820");
  test.skip(!["tenant_owner", "tenant_admin"].includes(role));
  await metaTemplatePreparationJourney(page, "ar", role, testInfo);
});



test("Meta reconnect renews exact paused access without activating the connection", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  test.skip(testInfo.project.name === "tablet-820");
  await metaReconnectJourney(page, "ar", role, testInfo);
});



test("Arabic Meta signup keeps callback, selection and recovery bound to the active attempt", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(testInfo.project.name === "tablet-820");
  await metaSignupJourney(page, "ar", role, testInfo);
});

(role !== "agent" ? test : test.skip)("workspace membership linking preserves explicit review and access boundaries", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "tablet-820");
  await workspaceAccessJourney(page, testInfo, "ar", role === "tenant_owner");
});
(role === "tenant_owner" ? test : test.skip)("support scope preserves department assignment", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "tablet-820");
  await supportScopeJourney(page, testInfo, "ar");
});
test("Arabic Meta direct setup and later Groups consent remain independent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "tablet-820");
  await metaDirectConsentJourney(page, "ar", role, testInfo);
});
const viewsByRole: Record<string, string[]> = {
  tenant_owner: ["overview", "inbox", "connections", "groups", "rules", "automation", "plugins", "routing", "cases", "deliveries", "team", "support", "audit", "settings"],
  tenant_admin: ["overview", "inbox", "connections", "groups", "rules", "automation", "plugins", "routing", "cases", "deliveries", "team", "support", "audit", "settings"],
  supervisor: ["overview", "inbox", "connections", "groups", "rules", "automation", "plugins", "routing", "cases", "deliveries", "team", "audit", "settings"],
  agent: ["overview", "inbox", "connections", "groups", "rules", "automation", "plugins", "routing", "deliveries"],
  auditor: ["overview", "connections", "groups", "rules", "automation", "plugins", "routing", "cases", "deliveries", "team", "support", "audit", "settings"],
};
const titleKey: Record<string, keyof typeof arabicMessages> = {
  overview: "tenant.title.overview",
  inbox: "inbox.title",
  connections: "tenant.title.connections",
  groups: "tenant.title.groups",
  rules: "tenant.title.rules",
  automation: "tenant.title.automation",
  plugins: "tenant.title.plugins",
  routing: "tenant.title.routing",
  cases: "tenant.title.cases",
  deliveries: "tenant.title.deliveries",
  team: "tenant.title.team",
  support: "tenant.title.support",
  audit: "tenant.title.audit",
  settings: "tenant.title.settings",
};

const problems = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  await installMetaRoutingReadFixture(page);
  await installWorkspaceReadFixture(page, role);
  const observed: string[] = [];
  problems.set(page, observed);
  page.on("console", (message) => {
    if (message.type() === "error" && !consumeExpectedNumberReleaseDenial(page, message) && !consumeExpectedActivationDenial(page, message) && !consumeExpectedDirectSetupDenial(page, message) && !consumeExpectedSignupDenial(page, message) && !consumeExpectedReconnectDenial(page, message) && !consumeExpectedCoexistenceDenial(page, message) && !consumeExpectedAddAccessDenial(page, message) && !consumeExpectedRoutingDenial(page, message) && !consumeExpectedTemplateDenial(page, message) && !consumeExpectedLegacyDenial(page, message) && !consumeExpectedObservationFailure(page, message)) observed.push(message.text());
  });
  page.on("pageerror", (error) => observed.push(error.message));
});
test.afterEach(async ({ page }) => expect(problems.get(page) ?? []).toEqual([]));

async function open(page: Page, view: string) {
  await page.goto(view === "overview" ? "/app" : `/app?view=${view}`);
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  const title = arabicMessages[titleKey[view]];
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page).toHaveTitle(`${title} · WasalX`);
}

test("all authorized tenant routes render public Arabic copy and RTL", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop owns the exhaustive Arabic route pass");
  test.setTimeout(90_000);
  for (const view of viewsByRole[role]) await open(page, view);
  await expect(page.getByRole("navigation", { name: arabicMessages["tenant.navigation.primary"] })).toBeVisible();
  await expect(page.locator(".workspace-switcher")).not.toContainText(/Managed|Standard/u);
  await expectAxeClean(page);
});

test("Arabic mobile and tablet layouts remain bounded with tenant context visible", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "responsive projects own this pass");
  await open(page, role === "agent" ? "deliveries" : "settings");
  await expect(page.locator(".workspace-switcher")).toBeVisible();
  await expect(page.locator(".environment")).toBeVisible();
  const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  expect(width.document).toBeLessThanOrEqual(width.viewport);
  await expectAxeClean(page);
});

test("Arabic data-service connections keep recovery and read-only states clear", async ({ page }, testInfo) => {
  const canWrite = ["tenant_owner", "tenant_admin"].includes(role);
  const integrations = canWrite ? [
    { id: "87000000-0000-4000-8000-000000000020", provider: "NOTION", display_name: "Northstar المالية", binding_reference: "secret://configured", state: "CONNECTED", revision: 2 },
    { id: "87000000-0000-4000-8000-000000000021", provider: "NOTION", display_name: "مراجعة العمليات", binding_reference: null, state: "CONNECTING", revision: 1 },
    { id: "87000000-0000-4000-8000-000000000022", provider: "NOTION", display_name: "مساحة مؤرشفة", binding_reference: null, state: "REVOKED", revision: 1 },
  ] : [];
  await page.route("**/api/client-routing/integrations", async (route) => {
    await route.fulfill({ json: integrations });
  });
  await open(page, "connections");
  await expect(page.getByRole("heading", { level: 2, name: arabicMessages["routing.integrations.title"] })).toBeVisible();
  if (canWrite) {
    await expect(page.locator("ul.data-connection-list")).toBeVisible();
    await expect(page.locator(".data-connection-list bdi").first()).toHaveText("Northstar المالية");
    await expect(page.getByText(arabicMessages["tenant.status.connecting"], { exact: true })).toBeVisible();
    await expect(page.getByText(arabicMessages["tenant.status.revoked"], { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "إعادة ربط مراجعة العمليات" })).toBeVisible();
  } else {
    await expect(page.getByText(arabicMessages["routing.integrations.emptyReadOnly"], { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: arabicMessages["routing.integrations.connectNotion"] })).toHaveCount(0);
  }
  if (testInfo.project.name === "mobile-390") {
    await page.locator("html").evaluate((element) => { element.style.fontSize = "200%"; });
    const overflow = await page.locator(".data-connections").evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow, "Arabic data services must remain bounded at narrow 200% zoom").toBeLessThanOrEqual(1);
  }
  await expectAxeClean(page);
});

test("Arabic modal focus, cancellation, and bidi values stay isolated", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop" || role === "auditor", "one writable desktop role owns modal semantics");
  await open(page, "automation");
  await page.getByRole("tab", { name: arabicMessages["bot.tabs.conversations"] }).click();
  const conversation = page.getByRole("article").filter({ hasText: /#10421/u });
  const historyButton = conversation.getByRole("button", { name: arabicMessages["bot.conversations.viewExecution"] });
  await historyButton.click();
  const history = page.getByRole("dialog", { name: /10421/u });
  await expect(history).toContainText(arabicMessages["bot.events.actionSucceeded"]);
  await expect(history).toContainText(arabicMessages["bot.events.actionFailed"]);
  await expect(history).toContainText(arabicMessages["bot.events.actionRetryRequested"]);
  await expect(history).toContainText(arabicMessages["bot.node.title.requestLocation"]);
  await history.getByRole("button", { name: arabicMessages["bot.conversations.closeExecution"] }).click();
  await expect(historyButton).toBeFocused();
  const resume = page.getByRole("button", { name: arabicMessages["bot.command.resume"] }).first();
  await resume.click();
  await expect(page.getByRole("button", { name: arabicMessages["automation.common.cancel"] })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(resume).toBeFocused();
  await expect(page.locator("bdi").first()).toBeVisible();
});

test("generic configuration dialogs remain centered in RTL on desktop and mobile", async ({ page }, testInfo) => {
  test.skip(
    !["tenant_owner", "tenant_admin"].includes(role) || testInfo.project.name === "tablet-820",
    "writable desktop and mobile projects own modal geometry",
  );
  await open(page, "connections");
  await page.getByRole("button", { name: arabicMessages["tenant.connections.connect"], exact: true }).click();
  const dialog = page.getByRole("dialog", { name: arabicMessages["tenant.setup.ariaLabel"] });
  await expect(dialog).toBeVisible();
  const geometry = await dialog.locator(":scope > .modal").evaluate((surface) => {
    const bounds = surface.getBoundingClientRect();
    return {
      horizontalOffset: Math.abs(bounds.left + bounds.width / 2 - window.innerWidth / 2),
      verticalOffset: Math.abs(bounds.top + bounds.height / 2 - window.innerHeight / 2),
    };
  });
  expect(geometry.horizontalOffset).toBeLessThanOrEqual(2);
  expect(geometry.verticalOffset).toBeLessThanOrEqual(2);
  await dialog.getByRole("button", { name: arabicMessages["tenant.setup.actions.close"] }).click();
  await expect(dialog).toBeHidden();
});

test("tall configuration dialog actions remain visible at short height and 200% zoom in RTL", async ({ page }, testInfo) => {
  test.skip(
    role !== "tenant_owner" || testInfo.project.name !== "desktop",
    "one writable desktop role owns short-height modal geometry",
  );
  await page.setViewportSize({ width: 842, height: 520 });
  await open(page, "connections");
  await page.locator("html").evaluate((element) => { element.style.fontSize = "200%"; });
  await page.getByRole("button", { name: arabicMessages["tenant.connections.connect"], exact: true }).click();
  const dialog = page.getByRole("dialog", { name: arabicMessages["tenant.setup.ariaLabel"] });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: arabicMessages["tenant.setup.actions.continue"], exact: true })).toBeVisible();
  const geometry = await dialog.locator(":scope > .modal").evaluate((surface) => {
    const footer = surface.querySelector<HTMLElement>(":scope > .modal-actions");
    if (!footer) throw new Error("The modal action footer is missing.");
    const surfaceBounds = surface.getBoundingClientRect();
    const footerBounds = footer.getBoundingClientRect();
    return {
      contentOverflows: surface.scrollHeight > surface.clientHeight,
      footerTop: footerBounds.top,
      footerBottom: footerBounds.bottom,
      surfaceTop: surfaceBounds.top,
      surfaceBottom: surfaceBounds.bottom,
      viewportBottom: window.innerHeight,
    };
  });
  expect(geometry.contentOverflows, "the regression viewport must exercise a tall modal").toBe(true);
  expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.surfaceTop - 1);
  expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.surfaceBottom + 1);
  expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.viewportBottom);
});

(role === "tenant_owner" ? test : test.skip)("ticket event workflows edit publish and bind with pinned versions", async ({ page }, testInfo) => {
  test.skip(!["desktop", "mobile-390"].includes(testInfo.project.name));
  test.setTimeout(90_000);
  await ticketEventWorkflowJourney(page, testInfo, "ar");
});


(role === "tenant_owner" ? test : test.skip)("keep-open bot policy preserves legacy and immutable draft settings", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390");
  test.setTimeout(120_000);
  await keepOpenPolicyJourney(page, testInfo, "ar");
});
test("ar deletion receipt status stays truthful and out of URL queries", async ({ page }, testInfo) => {
  test.skip(role !== "tenant_owner" || testInfo.project.name === "tablet-820");
  await metaDeletionStatusJourney(page, "ar", testInfo);
});
