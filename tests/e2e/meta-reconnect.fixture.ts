import AxeBuilder from "@axe-core/playwright";
import { expect, type ConsoleMessage, type Page, type TestInfo } from "@playwright/test";
import type { MetaSignupAttemptView } from "../../lib/meta-signup-contract";
import type { NumberReleaseView } from "../../lib/meta-number-release-intent";
import { englishTenantMessages } from "../../lib/i18n/messages/en/tenant";
import { arabicTenantMessages } from "../../lib/i18n/messages/ar/tenant";

const expectedReconnectFailures = new WeakMap<Page, { url: string; status: number }[]>();
export function consumeExpectedReconnectDenial(page: Page, message: ConsoleMessage) {
  if (!message.text().startsWith("Failed to load resource:")) return false;
  const failures = expectedReconnectFailures.get(page);
  const index = failures?.findIndex(expected => expected.url === message.location().url
    && new RegExp(`\\b${expected.status}\\b`).test(message.text())) ?? -1;
  if (index < 0) return false;
  failures!.splice(index, 1); return true;
}

/** Browser fixtures only: no actual Graph authorization or connection rotation. */
export async function metaReconnectJourney(page: Page, locale: "en" | "ar", role: string, testInfo: TestInfo) {
  const messages: Readonly<Record<string, string>> = locale === "ar" ? arabicTenantMessages : englishTenantMessages;
  const t = (key: string) => messages[key]!;
  const alpha = "12000000-0000-4000-8000-000000000081";
  const beta = "12000000-0000-4000-8000-000000000082";
  const choiceId = "55000000-0000-4000-8000-000000000081";
  const sdk = { appId: "12345678", configId: "87654321", graphVersion: "v24.0" };
  const challenge = "R".repeat(43);
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const reads: string[] = [], problems: string[] = [];
  const expectedFailures: { url: string; status: number }[] = [];
  expectedReconnectFailures.set(page, expectedFailures);
  const views = new Map<string, MetaSignupAttemptView | null>();
  const attempts = new Map<string, MetaSignupAttemptView>();
  const setView = (id: string, view: MetaSignupAttemptView | null) => {
    views.set(id, view); if (view) attempts.set(view.attemptId, view);
  };
  let sequence = 0, lifecycle = "PAUSED", operationType = "PAUSE", operationState = "SUCCEEDED";
  let loseSelect = false, unavailable = false, cancelUnknown = false;
  let targetMode: "STANDARD" | "COEXISTENCE" = "STANDARD";
  const initial = (id = alpha): MetaSignupAttemptView => ({ purpose: "RECONNECT",
    target: { connectionId: id, name: id === alpha ? "Access Alpha" : "Access Beta", state: "PAUSED", mode: targetMode },
    attemptId: `44000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    revision: 1, expiresAt: new Date(Date.now() + 600_000).toISOString(), status: "AWAITING_AUTHORIZATION",
    nextAction: "AUTHORIZE", canCancel: true, canStartAgain: false, choices: [], readiness: {
      authorization: "PENDING", number: "UNKNOWN", subscription: "UNKNOWN", messaging: "UNKNOWN",
      payment: { requestedPayer: "CUSTOMER", status: "UNKNOWN", paymentMethodVerified: false } } });
  const selection = (view: MetaSignupAttemptView): MetaSignupAttemptView => ({ ...view, revision: 3,
    status: "SELECTION_REQUIRED", nextAction: "SELECT_NUMBER", selectionRevision: 1,
    readiness: { ...view.readiness, authorization: "VERIFIED" },
    choices: [{ choiceId, businessName: "Synthetic Portfolio", accountName: "Exact Existing Account",
      verifiedName: "Service Name", displayPhoneNumber: "12025550143", mode: view.target?.mode ?? "STANDARD", numberState: "REGISTERED", selectable: true },
    { choiceId: "55000000-0000-4000-8000-000000000082", businessName: "Synthetic Portfolio", accountName: "Different Account",
      displayPhoneNumber: "12025550144", mode: "STANDARD", numberState: "REGISTERED", selectable: false,
      reasonCode: "META_SIGNUP_RECONNECT_TARGET_CHANGED" }] });
  const callback = (code: string | null) => page.evaluate(value => {
    const callbacks = (window as unknown as { metaReconnectCallbacks: ((response: unknown) => void)[] }).metaReconnectCallbacks;
    callbacks.at(-1)!(value ? { authResponse: { code: value } } : {});
  }, code);
  await page.clock.install();
  page.on("pageerror", error => problems.push(error.message));
  await page.route("https://connect.facebook.net/en_US/sdk.js", route => route.fulfill({ contentType: "text/javascript",
    body: "window.metaReconnectCallbacks=[];window.metaReconnectSdkLaunches=[];window.FB={init(){},login(callback,options){window.metaReconnectCallbacks.push(callback);window.metaReconnectSdkLaunches.push(options);}};" }));
  await page.route("**/api/connections/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/meta/signup/")) {
      const path = url.pathname.split("/signup/")[1];
      if (route.request().method() === "GET") {
        reads.push(url.pathname + url.search);
        if (path === "capabilities") return route.fulfill({ json: { enabled: !unavailable, payerModes: ["CUSTOMER"], ...(unavailable ? {} : { sdk }) } });
        if (path === "attempts") return route.fulfill({ json: { attempt: views.get(url.searchParams.get("targetConnectionId") ?? "new") ?? null } });
        return route.fulfill({ json: attempts.get(path.split("/")[1]) ?? null });
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      writes.push({ path, body });
      if (path === "attempts") {
        expect([alpha, beta]).toContain(body.targetConnectionId);
        expect(body.payerMode).toBe("CUSTOMER");
        expect(Object.hasOwn(body, "variant")).toBe(false); expect(Object.hasOwn(body, "coexistenceConsent")).toBe(false);
        const view = initial(String(body.targetConnectionId)); setView(view.target!.connectionId, view);
        return route.fulfill({ json: { ...view, challenge, sdk } });
      }
      const view = attempts.get(path.split("/")[1])!;
      expect(view).toBeTruthy();
      let next: MetaSignupAttemptView = view;
      if (path.endsWith("/exchange")) {
        expect(body).toEqual({ expectedRevision: view.revision, challenge, code: "reconnect-code-once" });
        next = selection(view);
      } else if (path.endsWith("/select")) {
        expect(body).toEqual({ expectedRevision: view.revision, selectionRevision: view.selectionRevision, choiceId });
        expect(Object.hasOwn(body, "registrationPin")).toBe(false);
        next = { ...view, revision: view.revision + 1, status: "COMPLETED", nextAction: "DONE", canCancel: false,
          canStartAgain: true, outcome: "ACCESS_RENEWED_PAUSED", connectionId: view.target!.connectionId };
      } else if (path.endsWith("/cancel")) {
        expect(body).toEqual({ expectedRevision: view.revision });
        if (cancelUnknown) {
          cancelUnknown = false; expectedFailures.push({ url: route.request().url(), status: 503 });
          return route.fulfill({ status: 503, json: { code: "SERVICE_UNAVAILABLE" } });
        }
        next = { ...view, revision: view.revision + 1, status: "CANCELLED", nextAction: "START_AGAIN", canCancel: false, canStartAgain: true };
      } else throw new Error("Unexpected reconnect mutation");
      attempts.set(view.attemptId, next);
      if (views.get(view.target!.connectionId)?.attemptId === view.attemptId) views.set(view.target!.connectionId, next);
      if (path.endsWith("/select") && loseSelect) {
        loseSelect = false; return route.fulfill({ contentType: "application/json", body: "{" });
      }
      return route.fulfill({ json: next });
    }
    const id = url.pathname.split("/")[3];
    if (![alpha, beta].includes(id)) return route.fallback();
    if (url.pathname === `/api/connections/${id}`) return route.fulfill({ json: { id,
      name: id === alpha ? "Access Alpha" : "Access Beta", provider: "META", state: lifecycle,
      phone_e164: "12025550143", provider_session_state: "PAUSED", provider_state: "STOPPED", webhook_state: "PAUSED",
      disclosure_version: null, latest_operation_type: operationType, latest_operation_state: operationState, group_count: 0 } });
    if (url.pathname.endsWith("/meta/capabilities")) return route.fulfill({ json: { eligible: false, state: "CONSENT_REQUIRED",
      evidence: "local_policy", checkedAt: new Date().toISOString() } });
    if (url.pathname === `/api/connections/${id}/meta/number-release`) {
      expect(lifecycle).toBe("REVOKED");
      expect(route.request().method()).toBe("GET");
      const release: NumberReleaseView = { routeId: "79000000-0000-4000-8000-000000000081", phoneNumberId: "1234567890",
        disconnectOperationId: null, releaseId: null, state: "REVOKED", reconnectRequiresNewConnection: true };
      return route.fulfill({ json: release });
    }
    if (lifecycle === "REVOKED" && url.pathname.endsWith("/meta/activation")) {
      expect(route.request().method()).toBe("GET");
      return route.fulfill({ json: { connectionId: id, applicable: true, readyToCheck: false, reason: "PAUSE_REQUIRED",
        contextVersion: null, operation: { id: "75000000-0000-4000-8000-000000000081", state: "SUCCEEDED", locallyActivated: true },
        providerConfigurationReadback: false, conversationPermission: "SEPARATE_REQUIRED" } });
    }
    return route.fallback();
  });
  const openEditor = async () => {
    const button = page.getByRole("button", { name: t("tenant.metaSignup.reconnect.open"), exact: true });
    if (!["tenant_owner", "tenant_admin"].includes(role)) {
      await expect(page.getByRole("heading", { name: "Access Alpha", exact: true })).toBeVisible();
      await expect(button).toHaveCount(0);
      await expect(page.getByRole("button", { name: t("tenant.connection.metaCredential.replace"), exact: true })).toHaveCount(0);
      return null;
    }
    await expect(page.getByRole("button", { name: t("tenant.connection.metaCredential.replace"), exact: true })).toBeDisabled();
    await button.focus(); await page.keyboard.press("Enter");
    return page.locator('section[aria-labelledby="meta-signup-heading"]');
  };
  const open = async () => {
    await page.goto(`/app?view=connections&connection=${alpha}`, { waitUntil: "commit" });
    await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
    return openEditor();
  };
  const navigate = (connection: string | null) => page.evaluate(id => {
    history.pushState({}, "", id ? `/app?view=connections&connection=${id}` : "/app?view=connections");
    dispatchEvent(new PopStateEvent("popstate"));
  }, connection);
  const reopen = async () => {
    // These fixture states need a fresh drawer. The explicit reload cases still open a new document.
    await navigate(null);
    await expect(page.getByRole("dialog", { name: t("tenant.connection.detailsLabel"), exact: true })).toHaveCount(0);
    await navigate(alpha);
    return openEditor();
  };
  let section = await open();
  async function capture(name: string, actionKey: string) {
    if (page.viewportSize()!.width > 400) {
      await testInfo.attach(name, { body: await section!.screenshot(), contentType: "image/png" });
      return;
    }
    // The inline section can exceed its modal scroll viewport. Capture the
    // operator-visible viewport at the heading and actions, never outside it.
    await section!.getByRole("heading", { name: t("tenant.metaSignup.reconnect.title"), exact: true }).scrollIntoViewIfNeeded();
    await testInfo.attach(`${name}-top`, { body: await page.screenshot(), contentType: "image/png" });
    await section!.getByRole("button", { name: t(actionKey), exact: true }).scrollIntoViewIfNeeded();
    await testInfo.attach(`${name}-actions`, { body: await page.screenshot(), contentType: "image/png" });
  }
  if (!section) { expect(writes).toEqual([]); expect(reads).toEqual([]); expect(problems).toEqual([]); return; }
  await expect(section.getByRole("heading", { name: t("tenant.metaSignup.reconnect.title"), exact: true })).toBeFocused();
  await expect(section.getByText("Access Alpha", { exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: t("tenant.metaSignup.manual"), exact: true })).toHaveCount(0);
  await section.getByRole("button", { name: t("tenant.metaSignup.reconnect.prepare"), exact: true }).click();
  await section.getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true }).click();
  await callback("reconnect-code-once");
  await expect(section.getByText("Exact Existing Account", { exact: true })).toBeVisible();
  await expect(section.getByRole("radio", { name: /12025550143/u })).not.toBeChecked();
  await expect(section.getByRole("radio", { name: /12025550144/u })).toBeDisabled();
  await expect(section.locator('input[type="password"]')).toHaveCount(0);
  await section.getByRole("radio", { name: /12025550143/u }).check();
  await capture("reconnect-exact-preview", "tenant.metaSignup.reconnect.select");
  loseSelect = true;
  await section.getByRole("button", { name: t("tenant.metaSignup.reconnect.select"), exact: true }).click();
  await section.getByRole("button", { name: t("tenant.metaSignup.refresh"), exact: true }).click();
  await expect(section.getByText(t("tenant.metaSignup.reconnect.status.COMPLETED"), { exact: true })).toBeVisible();
  expect(writes.filter(write => write.path.endsWith("/select"))).toHaveLength(1);
  await expect(section.getByText(t("tenant.metaSignup.workflow"), { exact: true })).toHaveCount(0);
  expect(await section.getByText(t("tenant.metaSignup.value.UNKNOWN"), { exact: true }).count()).toBe(4);
  await capture("reconnect-paused-completion", "tenant.metaSignup.view");
  section = await open();
  await expect(section!.getByText(t("tenant.metaSignup.reconnect.status.COMPLETED"), { exact: true })).toBeVisible();
  expect(writes.filter(write => write.path.endsWith("/exchange"))).toHaveLength(1);
  expect(writes.filter(write => write.path === "attempts")).toHaveLength(1);
  await section!.getByRole("button", { name: t("tenant.metaSignup.view"), exact: true }).click();
  await expect(page.getByRole("button", { name: t("tenant.metaSignup.reconnect.open"), exact: true })).toBeFocused();

  // Existing Business App renewal uses auth-only SDK and never asks for new import consent.
  targetMode = "COEXISTENCE"; setView(alpha, null); section = await reopen();
  await section!.getByRole("button", { name: t("tenant.metaSignup.reconnect.prepare"), exact: true }).click();
  await section!.getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true }).click();
  const launch = await page.evaluate(() => (window as unknown as { metaReconnectSdkLaunches: Record<string, unknown>[] }).metaReconnectSdkLaunches.at(-1)!);
  expect(launch.config_id).toBe(sdk.configId); expect(launch.extras).toEqual({ setup: {} });
  await callback("reconnect-code-once");
  await expect(section!.getByRole("checkbox")).toHaveCount(0); await expect(section!.locator('input[type="password"]')).toHaveCount(0);
  await section!.getByRole("radio", { name: /12025550143/u }).check();
  await section!.getByRole("button", { name: t("tenant.metaSignup.reconnect.select"), exact: true }).click();
  await expect(section!.getByText(t("tenant.metaSignup.reconnect.status.COMPLETED"), { exact: true })).toBeVisible();
  const coexWrites = writes.length; section = await open();
  await expect(section!.getByText(t("tenant.metaSignup.reconnect.status.COMPLETED"), { exact: true })).toBeVisible();
  expect(writes).toHaveLength(coexWrites); targetMode = "STANDARD";

  // Bound-stage recovery remains token-only and can explicitly cancel without an implicit retry.
  for (const action of ["select", "cancel"] as const) {
    operationType = "ROTATE_META_CREDENTIAL"; operationState = "STAGED";
    const staged = { ...selection(initial()), revision: 5, connectionId: alpha,
      operationId: "66000000-0000-4000-8000-000000000081", reasonCode: "META_SIGNUP_CREDENTIAL_UNAVAILABLE" as const };
    setView(alpha, staged); section = await reopen();
    await expect(section!.getByRole("button", { name: t("tenant.metaSignup.discover"), exact: true })).toHaveCount(0);
    await expect(section!.locator('input[type="password"]')).toHaveCount(0);
    if (action === "select") {
      await section!.getByRole("radio", { name: /12025550143/u }).check();
      await section!.getByRole("button", { name: t("tenant.metaSignup.reconnect.select"), exact: true }).click();
      await expect(section!.getByText(t("tenant.metaSignup.reconnect.status.COMPLETED"), { exact: true })).toBeVisible();
    } else {
      cancelUnknown = true;
      const cancellations = writes.filter(write => write.path.endsWith("/cancel")).length;
      await section!.getByRole("button", { name: t("tenant.metaSignup.cancel"), exact: true }).click();
      await section!.getByRole("button", { name: t("tenant.metaSignup.refresh"), exact: true }).click();
      await expect(section!.getByText(t("tenant.metaSignup.reconnect.status.SELECTION_REQUIRED"), { exact: true })).toBeVisible();
      expect(writes.filter(write => write.path.endsWith("/cancel"))).toHaveLength(cancellations + 1);
      await section!.getByRole("button", { name: t("tenant.metaSignup.cancel"), exact: true }).click();
      await expect(section!.getByText(t("tenant.metaSignup.status.CANCELLED"), { exact: true })).toBeVisible();
    }
  }
  // A stale held stage can still be reviewed and cancelled after local state drift.
  lifecycle = "ACTION_REQUIRED";
  const staleStage = { ...selection(initial()), connectionId: alpha, operationId: "66000000-0000-4000-8000-000000000082",
    status: "ACTION_REQUIRED" as const, nextAction: "REVIEW_OUTCOME" as const, reasonCode: "META_SIGNUP_RECONNECT_TARGET_CHANGED" as const };
  staleStage.choices = staleStage.choices.map(choice => ({ ...choice, selectable: false }));
  setView(alpha, staleStage); section = await reopen();
  await expect(section!.getByRole("radio", { name: /12025550143/u })).toBeDisabled();
  await section!.getByRole("button", { name: t("tenant.metaSignup.cancel"), exact: true }).click();
  await expect(section!.getByText(t("tenant.metaSignup.status.CANCELLED"), { exact: true })).toBeVisible();
  await expect(section!.getByRole("button", { name: t("tenant.metaSignup.reconnect.prepare"), exact: true })).toBeDisabled();
  lifecycle = "PAUSED"; operationType = "PAUSE"; operationState = "SUCCEEDED";
  // A resumed awaiting attempt has no browser challenge; closing or cancelling fences late callbacks.
  setView(alpha, initial()); section = await open();
  await expect(section!.getByText(t("tenant.metaSignup.resumeAuthorization"), { exact: true })).toBeVisible();
  await expect(section!.getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true })).toHaveCount(0);
  await section!.getByRole("button", { name: t("tenant.metaSignup.cancel"), exact: true }).click();
  await section!.getByRole("button", { name: t("tenant.metaSignup.reconnect.prepare"), exact: true }).click();
  await section!.getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true }).click();
  await callback(null);
  await expect(section!.getByText(t("tenant.metaSignup.popupIncomplete"), { exact: true })).toBeVisible();
  await section!.getByRole("button", { name: t("tenant.metaSignup.cancel"), exact: true }).click();
  await section!.getByRole("button", { name: t("tenant.metaSignup.reconnect.prepare"), exact: true }).click();
  await section!.getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true }).click();
  const exchanges = writes.filter(write => write.path.endsWith("/exchange")).length;
  await section!.getByRole("button", { name: t("tenant.metaSignup.reconnect.back"), exact: true }).click();
  await expect(section!).toHaveCount(0); await callback("late-after-close");
  expect(writes.filter(write => write.path.endsWith("/exchange"))).toHaveLength(exchanges);

  // Navigation to a different connection invalidates the earlier popup callback.
  setView(alpha, null); section = await reopen();
  await section!.getByRole("button", { name: t("tenant.metaSignup.reconnect.prepare"), exact: true }).click();
  await section!.getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true }).click();
  await navigate(beta);
  await expect(section!).toHaveCount(0); await callback("late-after-navigation");
  expect(writes.filter(write => write.path.endsWith("/exchange"))).toHaveLength(exchanges);
  await page.getByRole("button", { name: t("tenant.metaSignup.reconnect.open"), exact: true }).click();
  await expect(page.locator('#meta-signup-heading').locator('..').getByText("Access Beta", { exact: true })).toBeVisible();

  // Even an actor-readable view from another target/purpose is never accepted by this surface.
  for (const wrong of [initial(beta), { ...initial(), purpose: "NEW_NUMBER" as const, target: undefined }]) {
    setView(alpha, wrong); section = await reopen();
    await expect(section!.getByText(t("tenant.metaSignup.scopeChanged"), { exact: true })).toBeVisible();
    await expect(section!.getByRole("button", { name: t("tenant.metaSignup.reconnect.prepare"), exact: true })).toHaveCount(0);
    await expect(section!.getByRole("radio")).toHaveCount(0);
  }
  // Unknown outcomes never resubmit authorization or rotation; status remains the only recovery action.
  setView(alpha, { ...initial(), status: "OUTCOME_UNKNOWN", nextAction: "REVIEW_OUTCOME", canCancel: false,
    reasonCode: "META_SIGNUP_EXCHANGE_UNKNOWN" }); section = await reopen();
  await expect(section!.getByText(t("tenant.metaSignup.status.OUTCOME_UNKNOWN"), { exact: true })).toBeVisible();
  await expect(section!.getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true })).toHaveCount(0);
  await expect(section!.getByRole("button", { name: t("tenant.metaSignup.reconnect.select"), exact: true })).toHaveCount(0);
  await expect(section!.getByRole("button", { name: t("tenant.metaSignup.reconnect.prepare"), exact: true })).toHaveCount(0);

  // Server holds are displayed honestly; a capability outage cannot create a new setup.
  setView(alpha, { ...initial(), status: "ACTION_REQUIRED", nextAction: "REVIEW_OUTCOME", canCancel: false,
    reasonCode: "META_SIGNUP_RECONNECT_TARGET_CHANGED" }); section = await reopen();
  await expect(section!.getByText(t("tenant.metaSignup.reason.META_SIGNUP_RECONNECT_TARGET_CHANGED"), { exact: true })).toBeVisible();
  const changedMode = selection(initial());
  changedMode.choices[0].mode = "UNKNOWN"; changedMode.choices[0].numberState = "UNKNOWN";
  setView(alpha, changedMode); section = await reopen();
  await expect(section!.getByRole("radio", { name: /12025550143/u })).toBeDisabled();
  await expect(section!.locator('input[type="password"]')).toHaveCount(0);
  unavailable = true; setView(alpha, null); section = await reopen();
  await expect(section!.getByRole("button", { name: t("tenant.metaSignup.reconnect.prepare"), exact: true })).toHaveCount(0);
  const bounds = await section!.boundingBox(); expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const axe = await new AxeBuilder({ page }).include('section[aria-labelledby="meta-signup-heading"]').analyze();
  expect(axe.violations).toEqual([]);
  // Retirement closes only the local editor: saved history stays readable, and
  // neither an awaiting popup nor an unknown outcome is implicitly cancelled.
  unavailable = false;
  for (const status of ["AWAITING_AUTHORIZATION", "OUTCOME_UNKNOWN"] as const) {
    lifecycle = "PAUSED";
    setView(alpha, status === "AWAITING_AUTHORIZATION" ? null : { ...initial(), status, nextAction: "REVIEW_OUTCOME",
      canCancel: false, reasonCode: "META_SIGNUP_EXCHANGE_UNKNOWN" });
    section = await reopen();
    if (status === "AWAITING_AUTHORIZATION") {
      await section!.getByRole("button", { name: t("tenant.metaSignup.reconnect.prepare"), exact: true }).click();
      await section!.getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true }).click();
    } else await expect(section!.getByText(t("tenant.metaSignup.status.OUTCOME_UNKNOWN"), { exact: true })).toBeVisible();
    const durableAttempt = views.get(alpha), beforeRetirement = writes.length;
    lifecycle = "REVOKED";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.clock.runFor(32);
    const history = page.locator(`section[aria-labelledby="saved-access-${alpha}"]`);
    await expect(section!).toHaveCount(0);
    await expect(history.getByText(t("tenant.metaActivation.completed"), { exact: true })).toBeVisible();
    await expect(history.getByText(t("tenant.connection.guidance.revoked.body"), { exact: true })).toBeVisible();
    await expect(history.getByRole("button", { name: t("tenant.metaActivation.activate"), exact: true })).toHaveCount(0);
    await expect(history.getByText(t("tenant.metaActivation.reason.PAUSE_REQUIRED"), { exact: true })).toHaveCount(0);
    const release = page.locator(`section[aria-labelledby="number-release-${alpha}"]`);
    await expect(release.getByText(t("tenant.metaNumberRelease.disconnectPending"), { exact: true })).toBeVisible();
    await expect(release.getByRole("button", { name: t("tenant.metaNumberRelease.action"), exact: true })).toBeDisabled();
    await history.getByRole("button", { name: t("tenant.metaActivation.refresh"), exact: true }).click();
    if (status === "AWAITING_AUTHORIZATION") await callback("late-after-retirement");
    expect(views.get(alpha)).toEqual(durableAttempt);
    expect(writes).toHaveLength(beforeRetirement);
    await expect(page.locator('.connection-detail-shell')).not.toHaveAttribute("data-unsaved");
    await page.getByRole("button", { name: t("tenant.connection.closeDetails"), exact: true }).click();
    await expect(page.getByRole("dialog", { name: t("tenant.connection.detailsLabel"), exact: true })).toHaveCount(0);
  }
  lifecycle = "WORKING";
  await page.goto(`/app?view=connections&connection=${alpha}`, { waitUntil: "commit" });
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  await expect(page.getByRole("button", { name: t("tenant.connection.metaCredential.replace"), exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: t("tenant.metaSignup.reconnect.open"), exact: true })).toHaveCount(0);
  expect(reads.filter(path => path.endsWith("/attempts?targetConnectionId=" + alpha)).length).toBeGreaterThan(0);
  expect(reads.some(path => path.endsWith("/signup/attempts"))).toBe(false);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toContain(challenge); expect(storage).not.toMatch(/reconnect-code-once|late-after-close|late-after-navigation|late-after-retirement/u);
  expect(expectedFailures).toEqual([]);
  expect(problems).toEqual([]);
}
