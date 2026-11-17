import AxeBuilder from "@axe-core/playwright";
import { expect, type ConsoleMessage, type Page, type TestInfo } from "@playwright/test";
import type { MetaSignupAttemptView } from "../../lib/meta-signup-contract";
import type { MetaCoexistenceSummary } from "../../lib/meta-coexistence-contract";
import { englishTenantMessages } from "../../lib/i18n/messages/en/tenant";
import { arabicTenantMessages } from "../../lib/i18n/messages/ar/tenant";

const expectedCoexistenceFailures = new WeakMap<Page, { url: string; status: number }[]>();
export function consumeExpectedCoexistenceDenial(page: Page, message: ConsoleMessage) {
  if (!message.text().startsWith("Failed to load resource:")) return false;
  const failures = expectedCoexistenceFailures.get(page);
  const index = failures?.findIndex(expected => expected.url === message.location().url
    && new RegExp(`\\b${expected.status}\\b`).test(message.text())) ?? -1;
  if (index < 0) return false;
  failures!.splice(index, 1); return true;
}

/** Mocked HTTP/SDK browser behavior only. No real Meta authorization or import proof. */
export async function metaCoexistenceJourney(page: Page, locale: "en" | "ar", role: string, testInfo: TestInfo) {
  testInfo.setTimeout(testInfo.timeout + 25_000); // Exercise the actual 15-second first-read deadline once.
  const copy: Readonly<Record<string, string>> = locale === "ar" ? arabicTenantMessages : englishTenantMessages;
  const t = (key: string) => copy[key]!;
  // Pin the operator intent independently of the dictionary: reverting to a
  // new-number-only registration label must make this composed journey fail.
  const setupIntentLabel = locale === "ar"
    ? "إعداد رقم جديد في Cloud API أو رقم مؤهل من تطبيق واتساب للأعمال"
    : "Set up a new Cloud API number or an eligible WhatsApp Business app number";
  const alpha = "12000000-0000-4000-8000-000000000061", beta = "12000000-0000-4000-8000-000000000062";
  const unknownConnection = "12000000-0000-4000-8000-000000000063";
  const threadId = "a".repeat(64), secondThread = "b".repeat(64);
  const sdk = { appId: "12345678", configId: "87654321", graphVersion: "v24.0" };
  const appSdk = { ...sdk, configId: "98765432", variant: "BUSINESS_APP", extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" } };
  const challenge = "C".repeat(43);
  const writes: { path: string; body: Record<string, unknown> }[] = [], reads: string[] = [], problems: string[] = [];
  const expectedFailures: { url: string; status: number }[] = [];
  expectedCoexistenceFailures.set(page, expectedFailures);
  let enabled = false, current: MetaSignupAttemptView | null = null, sequence = 0, loseStop = false;
  const pendingMessages: { release?: () => void } = {};
  const releasePendingMessages = () => { pendingMessages.release?.(); delete pendingMessages.release; };
  const pendingSummary: { release?: () => void } = {}, pendingStop: { release?: () => void } = {};
  let summaryStatus = 200, stallSummary = false, delayStop = false;
  let stoppedResult: MetaCoexistenceSummary | null = null;
  let delayMessages = false;
  let summary: MetaCoexistenceSummary = { revision: 1, consent: { history: true, contacts: true, echoes: true },
    contactsRequest: "QUEUED", historyRequest: "QUEUED", historyObservation: "WAITING", windowEvidence: "UNKNOWN",
    providerProgress: null, processedChunks: 0, messageCount: 0, contactCount: 0, lastActivityAt: null, holdReason: null };
  // Separate persisted context: terminal request uncertainty never becomes an accepted retry.
  const unknownSummary: MetaCoexistenceSummary = { revision: 1, consent: { history: true, contacts: true, echoes: true },
    contactsRequest: "UNKNOWN", historyRequest: "HELD_CONTACTS_UNKNOWN", historyObservation: "WAITING", windowEvidence: "UNKNOWN",
    providerProgress: null, processedChunks: 0, messageCount: 0, contactCount: 0, lastActivityAt: null, holdReason: null };
  page.on("pageerror", failure => problems.push(failure.message));
  await page.route("https://connect.facebook.net/en_US/sdk.js", route => route.fulfill({ contentType: "text/javascript", body:
    "window.coexistenceCallbacks=[];window.coexistenceOptions=[];window.FB={init(){},login(callback,options){window.coexistenceCallbacks.push(callback);window.coexistenceOptions.push(options);}};" }));
  await page.route("**/api/connections/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const body = route.request().method() === "POST" ? route.request().postDataJSON() as Record<string, unknown> : undefined;
    if (path.includes("/meta/signup/")) {
      const suffix = path.split("/signup/")[1];
      if (!body) return route.fulfill({ json: suffix === "capabilities" ? { enabled: true, payerModes: ["CUSTOMER"], sdk, businessAppEnabled: enabled }
        : suffix === "attempts" ? { attempt: current } : current });
      writes.push({ path: suffix, body });
      if (suffix === "attempts") {
        expect(body).toMatchObject({ payerMode: "CUSTOMER", variant: "BUSINESS_APP", coexistenceConsent: { version: "2026-10-07", history: true, contacts: true, echoes: true } });
        expect(body).not.toHaveProperty("targetConnectionId");
        expect(body.purpose ?? "NEW_NUMBER").toBe("NEW_NUMBER");
        current = { purpose: "NEW_NUMBER", variant: "BUSINESS_APP", coexistenceConsent: { version: "2026-10-07", history: true, contacts: true, echoes: true },
          attemptId: `44000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`, revision: 1, status: "AWAITING_AUTHORIZATION", nextAction: "AUTHORIZE",
          expiresAt: new Date(Date.now() + 600_000).toISOString(), canCancel: true, canStartAgain: false, choices: [],
          readiness: { authorization: "PENDING", number: "UNKNOWN", subscription: "UNKNOWN", messaging: "UNKNOWN",
            payment: { requestedPayer: "CUSTOMER", status: "UNKNOWN", paymentMethodVerified: false } } };
        return route.fulfill({ json: { ...current, sdk: appSdk, challenge } });
      }
      if (suffix.endsWith("/session-log")) {
        expect(body).toMatchObject({ challenge, event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", sourceOrigin: "https://www.facebook.com", sessionInfoVersion: "3" });
        expect(body.traceSha256).toMatch(/^[0-9a-f]{64}$/u); expect(body).not.toHaveProperty("data"); expect(body).not.toHaveProperty("code");
        return route.fulfill({ json: { recorded: true } });
      }
      if (suffix.endsWith("/exchange")) {
        expect(body).toMatchObject({ challenge, code: "business-app-code", expectedRevision: 1 });
        current = { ...current!, revision: 3, status: "SELECTION_REQUIRED", nextAction: "SELECT_NUMBER", selectionRevision: 1,
          readiness: { ...current!.readiness, authorization: "VERIFIED" }, choices: [
            { choiceId: "55000000-0000-4000-8000-000000000061", businessName: "Synthetic Portfolio", accountName: "Business App Account", displayPhoneNumber: "12025550150", mode: "COEXISTENCE", numberState: "REGISTERED", selectable: true },
            { choiceId: "55000000-0000-4000-8000-000000000062", businessName: "Synthetic Portfolio", accountName: "Standard Account", displayPhoneNumber: "12025550151", mode: "STANDARD", numberState: "REGISTRATION_REQUIRED", selectable: true },
          ] };
      } else if (suffix.endsWith("/select")) {
        expect(body).not.toHaveProperty("registrationPin");
        expect(body.choiceId).toBe("55000000-0000-4000-8000-000000000061");
        current = { ...current!, revision: 4, status: "COMPLETED", nextAction: "DONE", connectionId: alpha, canCancel: false, canStartAgain: true,
          readiness: { ...current!.readiness, number: "REGISTERED", subscription: "CONFIRMED", messaging: "AVAILABLE" } };
      } else if (suffix.endsWith("/cancel")) current = { ...current!, revision: current!.revision + 1, status: "CANCELLED", nextAction: "START_AGAIN", canCancel: false, canStartAgain: true };
      else throw new Error("Unexpected coexistence signup write");
      return route.fulfill({ json: current });
    }
    const id = path.split("/")[3];
    if (![alpha, beta, unknownConnection].includes(id)) return route.fallback();
    if (path === `/api/connections/${id}`) return route.fulfill({ json: { id, name: id === alpha ? "Business App Import" : id === unknownConnection ? "Unknown Business App Import" : "Ordinary Meta",
      provider: "META", state: "PAUSED", phone_e164: id === unknownConnection ? "12025550152" : "12025550150", provider_session_state: "PAUSED", provider_state: "STOPPED", webhook_state: "PAUSED",
      disclosure_version: null, latest_operation_type: "PAUSE", latest_operation_state: "SUCCEEDED", group_count: 0 } });
    if (path.endsWith("/meta/capabilities")) return route.fulfill({ json: { eligible: false, state: "CONSENT_REQUIRED", evidence: "local_policy", checkedAt: new Date().toISOString() } });
    if (!path.includes("/meta/coexistence")) return route.fallback();
    reads.push(path + url.search);
    if (path.endsWith("/consent")) {
      writes.push({ path, body: body! });
      expect(body).toEqual({ expectedRevision: summary.revision, history: false, contacts: false, echoes: false });
      if (delayStop) { delayStop = false; await new Promise<void>(resolve => { pendingStop.release = resolve; }); }
      stoppedResult = { ...summary, revision: summary.revision + 1, consent: { history: false, contacts: false, echoes: false }, holdReason: "STOPPED" };
      if (loseStop) { loseStop = false; return route.fulfill({ contentType: "application/json", body: "{" }); }
      summary = stoppedResult;
      return route.fulfill({ json: summary });
    }
    if (path.endsWith("/coexistence")) {
      if (stallSummary) { stallSummary = false; await new Promise<void>(resolve => { pendingSummary.release = resolve; }); }
      if (summaryStatus !== 200) {
        expectedFailures.push({ url: route.request().url(), status: summaryStatus });
        return route.fulfill({ status: summaryStatus, json: { code: summaryStatus === 401 ? "UNAUTHENTICATED" : summaryStatus === 403 ? "FORBIDDEN" : "SERVICE_UNAVAILABLE" } });
      }
      return route.fulfill({ json: id === alpha ? summary : id === unknownConnection ? unknownSummary : null });
    }
    if (path.endsWith("/contacts")) return route.fulfill({ json: { items: url.searchParams.has("cursor")
      ? [{ threadId: secondThread, phone: "12025550153", name: null, removed: true, lastChangedAt: "2026-10-07T08:00:00Z" }]
      : [{ threadId, phone: "12025550154", name: "عميل Example", removed: false, lastChangedAt: "2026-10-07T08:00:00Z" }],
      nextCursor: url.searchParams.has("cursor") ? null : "YQ" } });
    if (path.endsWith("/messages")) {
      if (delayMessages) { delayMessages = false; await new Promise<void>(resolve => { pendingMessages.release = resolve; }); }
      return route.fulfill({ json: { items: [{ id: "66000000-0000-4000-8000-000000000061", threadId, direction: "INBOUND", source: "HISTORY",
        timestamp: "2026-10-07T08:00:00Z", type: "text", text: "<img src=x onerror=alert(1)> عميل Example", media: "NOT_APPLICABLE" },
      { id: "66000000-0000-4000-8000-000000000062", threadId, direction: "OUTBOUND", source: "ECHO", timestamp: "2026-10-07T08:01:00Z",
        type: "media_placeholder", text: null, media: "PLACEHOLDER" }], nextCursor: null } });
    }
    throw new Error("Unexpected import route");
  });
  const openSignup = async () => {
    await page.goto("/app?view=connections"); await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
    await page.getByRole("button", { name: t("tenant.connections.connect"), exact: true }).click();
    const dialog = page.getByRole("dialog", { name: t("tenant.setup.ariaLabel") });
    await dialog.getByLabel(t("tenant.setup.name.label")).fill("Business App Import");
    await dialog.getByText(t("tenant.setup.providers.metaTitle"), { exact: true }).click();
    await dialog.getByRole("button", { name: t("tenant.setup.actions.continue"), exact: true }).click();
    const setupIntent = dialog.getByRole("radio", { name: setupIntentLabel, exact: true });
    await expect(setupIntent).toBeVisible(); await setupIntent.check();
    return dialog;
  };
  const region = () => page.locator('section[aria-labelledby="meta-coexistence-title"]');
  const refreshVisible = async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  if (!["tenant_owner", "tenant_admin"].includes(role)) {
    await page.goto(`/app?view=connections&connection=${alpha}`); await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
    await expect(region()).toHaveCount(0); expect(reads).toEqual([]); expect(writes).toEqual([]); return;
  }
  let dialog = await openSignup();
  await expect(dialog.getByRole("button", { name: t("tenant.metaSignup.prepare"), exact: true })).toBeEnabled();
  await expect(dialog.getByRole("radio", { name: setupIntentLabel, exact: true })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: t("tenant.metaCoexistence.signup.BUSINESS_APP"), exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
  enabled = true; dialog = await openSignup();
  await expect(dialog.getByRole("radio", { name: t("tenant.metaCoexistence.signup.BUSINESS_APP"), exact: true })).toBeVisible();
  await dialog.getByRole("radio", { name: t("tenant.metaSignup.addAccess.purpose.ADD_ACCESS"), exact: true }).check();
  await expect(dialog.getByRole("heading", { name: t("tenant.metaSignup.addAccess.title"), exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: t("tenant.metaSignup.addAccess.prepare"), exact: true })).toBeEnabled();
  await expect(dialog.getByRole("radio", { name: t("tenant.metaCoexistence.signup.BUSINESS_APP"), exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel(t("tenant.metaCoexistence.signup.echoes"), { exact: true })).toHaveCount(0);
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  await dialog.getByRole("radio", { name: setupIntentLabel, exact: true }).check();
  await expect(dialog.getByRole("radio", { name: t("tenant.metaCoexistence.signup.STANDARD"), exact: true })).toBeChecked();
  const businessAppChoice = dialog.getByRole("radio", { name: t("tenant.metaCoexistence.signup.BUSINESS_APP"), exact: true });
  await expect(businessAppChoice).toBeVisible(); await businessAppChoice.focus(); await page.keyboard.press("Space");
  await expect(businessAppChoice).toBeChecked(); expect(writes).toEqual([]);
  const prepare = dialog.getByRole("button", { name: t("tenant.metaSignup.prepare"), exact: true });
  await expect(prepare).toBeDisabled();
  await dialog.getByLabel(t("tenant.metaCoexistence.signup.history"), { exact: true }).check();
  await expect(dialog.getByLabel(t("tenant.metaCoexistence.signup.contacts"), { exact: true })).not.toBeChecked();
  await dialog.getByLabel(t("tenant.metaCoexistence.signup.contacts"), { exact: true }).check();
  await dialog.getByLabel(t("tenant.metaCoexistence.signup.echoes"), { exact: true }).check();
  await prepare.focus(); await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true }).click();
  await dialog.getByRole("button", { name: t("tenant.metaSignup.cancel"), exact: true }).click();
  await expect(prepare).toBeEnabled();
  await page.evaluate(() => (window as unknown as { coexistenceCallbacks: ((value: unknown) => void)[] }).coexistenceCallbacks.at(-1)!({ authResponse: { code: "cancelled-code" } }));
  expect(writes.filter(write => write.path.endsWith("/exchange"))).toHaveLength(0);
  await prepare.click();
  await dialog.getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { coexistenceOptions: unknown[] }).coexistenceOptions.at(-1))).toMatchObject({ config_id: appSdk.configId, extras: appSdk.extras });
  const event = { type: "WA_EMBEDDED_SIGNUP", version: 3, event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", data: { waba_id: "12345678" } };
  await page.evaluate(value => { window.dispatchEvent(new MessageEvent("message", { origin: "https://www.facebook.com", source: window, data: value })); }, event);
  expect(writes.filter(write => write.path.endsWith("/session-log"))).toHaveLength(0);
  await page.evaluate(value => {
    const frame = document.createElement("iframe"); frame.hidden = true; document.body.appendChild(frame);
    window.dispatchEvent(new MessageEvent("message", { origin: "https://www.facebook.com", source: frame.contentWindow, data: value })); frame.remove();
  }, event);
  await expect.poll(() => writes.filter(write => write.path.endsWith("/session-log")).length).toBe(1);
  expect(writes.filter(write => write.path.endsWith("/exchange"))).toHaveLength(0);
  await page.evaluate(() => (window as unknown as { coexistenceCallbacks: ((value: unknown) => void)[] }).coexistenceCallbacks.at(-1)!({ authResponse: { code: "business-app-code" } }));
  await expect(dialog.getByRole("radio", { name: /12025550151/u })).toBeDisabled();
  dialog = await openSignup(); // Authenticated discovery resumes without a saved challenge or SDK replay.
  expect(writes.filter(write => write.path.endsWith("/exchange"))).toHaveLength(1);
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  await dialog.getByRole("radio", { name: /12025550150/u }).check();
  await dialog.getByRole("heading", { name: t("tenant.metaSignup.title"), exact: true }).scrollIntoViewIfNeeded();
  await testInfo.attach("coexistence-consent-selection-top", { body: await page.screenshot(), contentType: "image/png" });
  await dialog.getByRole("button", { name: t("tenant.metaSignup.select"), exact: true }).scrollIntoViewIfNeeded();
  await testInfo.attach("coexistence-consent-selection-actions", { body: await page.screenshot(), contentType: "image/png" });
  await dialog.getByRole("button", { name: t("tenant.metaSignup.select"), exact: true }).click();
  await dialog.getByRole("button", { name: t("tenant.metaSignup.view"), exact: true }).click();
  await expect(region().getByText(t("tenant.metaCoexistence.request.QUEUED"), { exact: true })).toHaveCount(2);
  await expect(region().getByText(t("tenant.metaCoexistence.observation.PROVIDER_FINISHED"), { exact: true })).toHaveCount(0);
  const progressWrites = writes.length;
  summary = { ...summary, revision: 2, contactsRequest: "CLAIMED" };
  await refreshVisible();
  await expect(region().getByText(t("tenant.metaCoexistence.request.CLAIMED"), { exact: true })).toBeVisible();
  await expect(region().getByText(t("tenant.metaCoexistence.request.QUEUED"), { exact: true })).toBeVisible();
  summary = { ...summary, revision: 3, contactsRequest: "ACCEPTED", historyRequest: "CLAIMED" };
  await refreshVisible();
  await expect(region().getByText(t("tenant.metaCoexistence.request.ACCEPTED"), { exact: true })).toBeVisible();
  await expect(region().getByText(t("tenant.metaCoexistence.request.CLAIMED"), { exact: true })).toBeVisible();
  await expect(region().getByText(t("tenant.metaCoexistence.observation.PROVIDER_FINISHED"), { exact: true })).toHaveCount(0);
  expect(writes).toHaveLength(progressWrites);
  summary = { ...summary, revision: 4, contactsRequest: "ACCEPTED", historyRequest: "ACCEPTED", historyObservation: "PROVIDER_FINISHED",
    providerProgress: 100, messageCount: 2, contactCount: 1, processedChunks: 1, lastActivityAt: "2026-10-07T08:00:00Z" };
  await refreshVisible(); // Operational progress arrives without a manual refresh or any POST.
  await expect(region().getByText(t("tenant.metaCoexistence.observation.PROVIDER_FINISHED"), { exact: true })).toBeVisible();
  expect(writes).toHaveLength(progressWrites);
  await region().getByRole("button", { name: t("tenant.metaCoexistence.view"), exact: true }).click();
  await region().getByRole("button", { name: t("tenant.metaCoexistence.more"), exact: true }).click();
  await expect(region().getByText(t("tenant.metaCoexistence.removed"), { exact: true })).toBeVisible();
  await region().getByRole("button", { name: /عميل Example/u }).click();
  await expect(region().getByText("<img src=x onerror=alert(1)> عميل Example", { exact: true })).toBeVisible();
  await expect(region().locator("img,a[download],textarea")).toHaveCount(0);
  await expect(region().getByText(t("tenant.metaCoexistence.mediaPlaceholder"), { exact: true })).toBeVisible();
  const summaryReads = () => reads.filter(path => path.endsWith("/coexistence")).length;
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  const hiddenReads = summaryReads();
  summary = { ...summary, revision: 5, processedChunks: 2 };
  await refreshVisible(); expect(summaryReads()).toBe(hiddenReads);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(summaryReads).toBeGreaterThan(hiddenReads);
  await expect(region().getByText("<img src=x onerror=alert(1)> عميل Example", { exact: true })).toBeVisible();
  summaryStatus = 503; await refreshVisible(); await expect(region().getByRole("alert")).toBeVisible();
  await expect(region().getByText("<img src=x onerror=alert(1)> عميل Example", { exact: true })).toBeVisible();
  summaryStatus = 200; await refreshVisible(); await expect(region().getByRole("alert")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include('section[aria-labelledby="meta-coexistence-title"]').analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await region().getByRole("heading", { name: "عميل Example", exact: true }).scrollIntoViewIfNeeded();
  await testInfo.attach("coexistence-inert-thread", { body: await page.screenshot(), contentType: "image/png" });
  await region().getByRole("button", { name: t("tenant.metaCoexistence.back"), exact: true }).click();
  await expect(region().getByRole("heading", { name: t("tenant.metaCoexistence.conversations"), exact: true })).toBeFocused();
  delayMessages = true;
  await region().getByRole("button", { name: /عميل Example/u }).click();
  await expect.poll(() => Boolean(pendingMessages.release)).toBe(true);
  await region().getByRole("button", { name: t("tenant.metaCoexistence.back"), exact: true }).click();
  releasePendingMessages();
  await expect(region().getByText(t("tenant.metaCoexistence.readOnly"), { exact: true })).toHaveCount(0);
  // A denied summary fences a content read that was already in flight.
  delayMessages = true;
  await region().getByRole("button", { name: /عميل Example/u }).click();
  await expect.poll(() => Boolean(pendingMessages.release)).toBe(true);
  summaryStatus = 403; await refreshVisible(); await expect(region().getByRole("alert")).toBeVisible();
  await expect(region().getByText("عميل Example", { exact: true })).toHaveCount(0);
  await expect(region().getByRole("button", { name: t("tenant.metaCoexistence.view"), exact: true })).toHaveCount(0);
  await expect(region().getByRole("button", { name: t("tenant.metaCoexistence.stop"), exact: true })).toHaveCount(0);
  releasePendingMessages();
  await expect(region().getByText("<img src=x onerror=alert(1)> عميل Example", { exact: true })).toHaveCount(0);
  summaryStatus = 200;
  await region().getByRole("button", { name: t("tenant.metaCoexistence.refresh"), exact: true }).click();
  await region().getByRole("button", { name: t("tenant.metaCoexistence.view"), exact: true }).click();
  await region().getByRole("button", { name: /عميل Example/u }).click();
  await expect(region().getByText("<img src=x onerror=alert(1)> عميل Example", { exact: true })).toBeVisible();
  const writesBeforeExpiry = writes.length;
  summaryStatus = 401; await refreshVisible();
  // Same-origin 401 replaces the entire shell; it cannot leave a child alert or data visible.
  const expiredHeading = page.getByRole("heading", { name: t("tenant.session.expiredTitle"), exact: true });
  await expect(expiredHeading).toBeVisible(); await expect(expiredHeading).toBeFocused();
  const returnTo = `/app?view=connections&connection=${alpha}`;
  await expect(page.getByRole("link", { name: t("tenant.session.signIn"), exact: true }))
    .toHaveAttribute("href", `/auth/login?return_to=${encodeURIComponent(returnTo)}`);
  await expect(region()).toHaveCount(0);
  await expect(page.locator('[data-application-ready="true"]')).toHaveCount(0);
  await expect(page.getByText("<img src=x onerror=alert(1)> عميل Example", { exact: true })).toHaveCount(0);
  expect(writes).toHaveLength(writesBeforeExpiry);
  // Restored mock responses alone do not revive an expired session or dispatch reads/writes.
  summaryStatus = 200;
  const readsWhileExpired = summaryReads(); await refreshVisible();
  await expect(expiredHeading).toBeVisible(); expect(summaryReads()).toBe(readsWhileExpired);
  expect(writes).toHaveLength(writesBeforeExpiry);
  // Explicitly reopen the mocked authenticated document; this is not real sign-in evidence.
  await page.reload(); await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  await expect(expiredHeading).toHaveCount(0);
  await expect(region().getByRole("button", { name: t("tenant.metaCoexistence.view"), exact: true })).toBeEnabled();
  expect(writes).toHaveLength(writesBeforeExpiry);
  loseStop = true; delayStop = true;
  await region().getByLabel(t("tenant.metaCoexistence.stopConfirm"), { exact: true }).check();
  await region().getByRole("button", { name: t("tenant.metaCoexistence.stop"), exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => Boolean(pendingStop.release)).toBe(true);
  const stoppingReads = summaryReads(); await refreshVisible(); expect(summaryReads()).toBe(stoppingReads);
  pendingStop.release?.(); delete pendingStop.release;
  await expect(region().getByText(t("tenant.metaCoexistence.checkSaved"), { exact: true })).toBeVisible();
  await region().getByRole("button", { name: t("tenant.metaCoexistence.refresh"), exact: true }).click();
  await expect(region().getByText(t("tenant.metaCoexistence.checkSaved"), { exact: true })).toBeVisible();
  await expect(region().getByRole("button", { name: t("tenant.metaCoexistence.stop"), exact: true })).toBeDisabled();
  expect(writes.filter(write => write.path.endsWith("/consent"))).toHaveLength(1);
  summary = stoppedResult!;
  await region().getByRole("button", { name: t("tenant.metaCoexistence.refresh"), exact: true }).click();
  await expect(region().getByText(t("tenant.metaCoexistence.hold.STOPPED"), { exact: true })).toBeVisible();
  expect(writes.filter(write => write.path.endsWith("/consent"))).toHaveLength(1);
  await page.reload(); await expect(region().getByText(t("tenant.metaCoexistence.hold.STOPPED"), { exact: true })).toBeVisible();
  await region().getByRole("heading", { name: t("tenant.metaCoexistence.title"), exact: true }).scrollIntoViewIfNeeded();
  await testInfo.attach("coexistence-stopped", { body: await page.screenshot(), contentType: "image/png" });
  stallSummary = true;
  await page.reload(); await expect.poll(() => Boolean(pendingSummary.release)).toBe(true);
  await expect(region().getByRole("alert")).toBeVisible({ timeout: 20_000 });
  pendingSummary.release?.(); delete pendingSummary.release;
  await region().getByRole("button", { name: t("tenant.metaCoexistence.refresh"), exact: true }).click();
  await expect(region().getByText(t("tenant.metaCoexistence.hold.STOPPED"), { exact: true })).toBeVisible();
  // A different persisted context stays UNKNOWN/HELD on readback; no SDK, import or stop replay.
  const writesBeforeUnknown = writes.length;
  await page.goto(`/app?view=connections&connection=${unknownConnection}`);
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  const expectUnknownHeld = async () => {
    await expect(region().getByText(t("tenant.metaCoexistence.request.UNKNOWN"), { exact: true })).toBeVisible();
    await expect(region().getByText(t("tenant.metaCoexistence.request.HELD_CONTACTS_UNKNOWN"), { exact: true })).toBeVisible();
    await expect(region().getByText(t("tenant.metaCoexistence.request.ACCEPTED"), { exact: true })).toHaveCount(0);
    await expect(region().getByText(t("tenant.metaCoexistence.observation.PROVIDER_FINISHED"), { exact: true })).toHaveCount(0);
    await expect(region().getByText(t("tenant.metaCoexistence.hold.STOPPED"), { exact: true })).toHaveCount(0);
    expect(writes).toHaveLength(writesBeforeUnknown);
  };
  await expectUnknownHeld();
  const unknownReads = () => reads.filter(path => path === `/api/connections/${unknownConnection}/meta/coexistence`).length;
  const beforeFocus = unknownReads();
  await refreshVisible(); await expect.poll(unknownReads).toBeGreaterThan(beforeFocus);
  await expectUnknownHeld();
  await region().getByRole("button", { name: t("tenant.metaCoexistence.refresh"), exact: true }).click();
  await expect(region()).toHaveAttribute("aria-busy", "false");
  await expectUnknownHeld();
  await page.reload(); await expectUnknownHeld();
  await page.goto(`/app?view=connections&connection=${beta}`); await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  await expect(region()).toHaveCount(0);
  expect(writes.filter(write => write.path.endsWith("/exchange"))).toHaveLength(1);
  expect(writes.filter(write => write.path.endsWith("/select"))).toHaveLength(1);
  expect(problems).toEqual([]);
  expect(expectedFailures).toEqual([]);
}
