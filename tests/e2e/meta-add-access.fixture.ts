import AxeBuilder from "@axe-core/playwright";
import { expect, type ConsoleMessage, type Page, type TestInfo } from "@playwright/test";
import type { MetaSignupAttemptView } from "../../lib/meta-signup-contract";
import { englishTenantMessages } from "../../lib/i18n/messages/en/tenant";
import { arabicTenantMessages } from "../../lib/i18n/messages/ar/tenant";
import { installRequestDeadlineClock } from "./request-deadline-clock.fixture";

const expectedAddAccessFailures = new WeakMap<Page, { url: string; status: number }[]>();
export function consumeExpectedAddAccessDenial(page: Page, message: ConsoleMessage) {
  if (!message.text().startsWith("Failed to load resource:")) return false;
  const failures = expectedAddAccessFailures.get(page);
  const index = failures?.findIndex(item => item.url === message.location().url && new RegExp(`\\b${item.status}\\b`).test(message.text())) ?? -1;
  if (index < 0) return false;
  failures!.splice(index, 1); return true;
}

/** Local mocked HTTP/SDK browser behavior. No real access grant, migration or provider action. */
export async function metaAddAccessJourney(page: Page, locale: "en" | "ar", role: string, testInfo: TestInfo) {
  const advancePastRequestDeadline = await installRequestDeadlineClock(page);
  const copy: Readonly<Record<string, string>> = locale === "ar" ? arabicTenantMessages : englishTenantMessages;
  const t = (key: string) => copy[key]!;
  const alpha = "12000000-0000-4000-8000-000000000091", prior = "12000000-0000-4000-8000-000000000092";
  const choiceId = "55000000-0000-4000-8000-000000000091";
  const challenge = "A".repeat(43), sdk = { appId: "12345678", configId: "87654321", graphVersion: "v24.0" };
  const writes: { path: string; body: Record<string, unknown> }[] = [], reads: string[] = [], problems: string[] = [];
  const failures: { url: string; status: number }[] = []; expectedAddAccessFailures.set(page, failures);
  const attempts = new Map<string, MetaSignupAttemptView>();
  const latest = new Map<string, MetaSignupAttemptView | null>([["NEW_NUMBER", null], ["ADD_ACCESS", null]]);
  let sequence = 0, loseSelect = false, wrongPurpose = false, delayLatest = false, cancelUnavailable = false;
  const pendingLatest: { release?: () => void } = {};
  const releasePendingLatest = () => { pendingLatest.release?.(); delete pendingLatest.release; };
  const save = (view: MetaSignupAttemptView) => { attempts.set(view.attemptId, view); latest.set(view.purpose, view); return view; };
  const initial = (purpose: "NEW_NUMBER" | "ADD_ACCESS"): MetaSignupAttemptView => ({ purpose,
    attemptId: `44000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`, revision: 1,
    expiresAt: new Date(Date.now() + 600_000).toISOString(), status: "AWAITING_AUTHORIZATION", nextAction: "AUTHORIZE",
    canCancel: true, canStartAgain: false, choices: [], readiness: { authorization: "PENDING", number: "UNKNOWN",
      subscription: "UNKNOWN", messaging: "UNKNOWN", payment: { requestedPayer: "CUSTOMER", status: "UNKNOWN", paymentMethodVerified: false } } });
  const selection = (view: MetaSignupAttemptView): MetaSignupAttemptView => ({ ...view, revision: 3, status: "SELECTION_REQUIRED", nextAction: "SELECT_NUMBER", selectionRevision: 1,
    readiness: { ...view.readiness, authorization: "VERIFIED", number: "REGISTERED" }, choices: [
      { choiceId, businessName: "Managed portfolio", accountName: "Existing Cloud Account", displayPhoneNumber: "12025550145", mode: "STANDARD", numberState: "REGISTERED", selectable: true },
      { choiceId: "55000000-0000-4000-8000-000000000092", businessName: "Managed portfolio", accountName: "Unregistered number", displayPhoneNumber: "12025550146", mode: "STANDARD", numberState: "REGISTRATION_REQUIRED", selectable: true },
      { choiceId: "55000000-0000-4000-8000-000000000093", businessName: "Managed portfolio", accountName: "Business App number", displayPhoneNumber: "12025550147", mode: "COEXISTENCE", numberState: "REGISTERED", selectable: true },
      { choiceId: "55000000-0000-4000-8000-000000000094", businessName: "Managed portfolio", accountName: "Already connected", displayPhoneNumber: "12025550148", mode: "STANDARD", numberState: "REGISTERED", selectable: false,
        reasonCode: "META_SIGNUP_ASSET_CONFLICT", existingConnection: { connectionId: prior, name: "Prior <name>" } },
      { choiceId: "55000000-0000-4000-8000-000000000095", businessName: "Managed portfolio", accountName: "Unavailable choice", displayPhoneNumber: "12025550149", mode: "UNKNOWN", numberState: "UNKNOWN", selectable: false, reasonCode: "META_SIGNUP_ASSET_CONFLICT" },
    ] });
  const completed = (view: MetaSignupAttemptView): MetaSignupAttemptView => ({ ...view, revision: view.revision + 1, status: "COMPLETED", nextAction: "DONE",
    outcome: "ACCESS_ADDED_PAUSED", connectionId: alpha, operationId: "77000000-0000-4000-8000-000000000091", canCancel: false, canStartAgain: true });
  page.on("pageerror", error => problems.push(error.message));
  await page.route("https://connect.facebook.net/en_US/sdk.js", route => route.fulfill({ contentType: "text/javascript", body:
    "window.addAccessCallbacks=[];window.FB={init(){},login(callback){window.addAccessCallbacks.push(callback);}};" }));
  await page.route("**/api/connections/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/meta/signup/")) {
      const path = url.pathname.split("/signup/")[1];
      if (route.request().method() === "GET") {
        reads.push(path + url.search);
        if (path === "capabilities") return route.fulfill({ json: { enabled: true, payerModes: ["CUSTOMER"], sdk } });
        if (path === "attempts") {
          expect(url.searchParams.has("targetConnectionId")).toBe(false);
          const purpose = url.searchParams.get("purpose") ?? "NEW_NUMBER";
          const captured = wrongPurpose && purpose === "ADD_ACCESS" ? initial("NEW_NUMBER") : latest.get(purpose) ?? null;
          if (delayLatest && purpose === "ADD_ACCESS") { delayLatest = false; await new Promise<void>(resolve => { pendingLatest.release = resolve; }); }
          return route.fulfill({ json: { attempt: captured } });
        }
        return route.fulfill({ json: attempts.get(path.split("/")[1]) });
      }
      const body = route.request().postDataJSON() as Record<string, unknown>; writes.push({ path, body });
      if (path === "attempts") {
        expect(body).not.toHaveProperty("targetConnectionId"); expect(body.payerMode).toBe("CUSTOMER");
        const view = save(initial(body.purpose === "ADD_ACCESS" ? "ADD_ACCESS" : "NEW_NUMBER"));
        return route.fulfill({ json: { ...view, sdk, challenge } });
      }
      const view = attempts.get(path.split("/")[1])!; expect(view).toBeTruthy();
      if (path.endsWith("/exchange")) {
        expect(body).toEqual({ expectedRevision: view.revision, challenge, code: "add-access-code" });
        expect(view.purpose).toBe("ADD_ACCESS"); return route.fulfill({ json: save(selection(view)) });
      }
      if (path.endsWith("/select")) {
        expect(body).toEqual({ expectedRevision: view.revision, selectionRevision: view.selectionRevision, choiceId });
        expect(Object.hasOwn(body, "registrationPin")).toBe(false); expect(view.purpose).toBe("ADD_ACCESS");
        const next = save(completed(view));
        if (loseSelect) { loseSelect = false; return route.fulfill({ contentType: "application/json", body: "{" }); }
        return route.fulfill({ json: next });
      }
      if (path.endsWith("/cancel")) {
        if (cancelUnavailable) {
          cancelUnavailable = false; failures.push({ url: route.request().url(), status: 503 });
          return route.fulfill({ status: 503, json: { code: "SERVICE_UNAVAILABLE" } });
        }
        return route.fulfill({ json: save({ ...view, revision: view.revision + 1, status: "CANCELLED", nextAction: "START_AGAIN", canCancel: false, canStartAgain: true }) });
      }
      throw new Error("Unexpected add-access write");
    }
    const id = url.pathname.split("/")[3]; if (![alpha, prior].includes(id)) return route.fallback();
    if (url.pathname === `/api/connections/${id}`) return route.fulfill({ json: { id, name: id === prior ? "Prior <name>" : "Existing Access",
      provider: "META", state: "PAUSED", provider_session_state: "PAUSED", provider_state: "STOPPED", webhook_state: "PAUSED", phone_e164: "12025550145",
      disclosure_version: null, latest_operation_type: "CONNECT_META", latest_operation_state: "SUCCEEDED", group_count: 0 } });
    if (url.pathname.endsWith("/meta/capabilities")) return route.fulfill({ json: { eligible: false, state: "CONSENT_REQUIRED", evidence: "local_policy", checkedAt: new Date().toISOString() } });
    if (url.pathname.endsWith("/start")) {
      writes.push({ path: url.pathname, body: route.request().postDataJSON() }); failures.push({ url: route.request().url(), status: 409 });
      return route.fulfill({ status: 409, json: { code: "META_SIGNUP_ADD_ACCESS_ACTIVATION_REQUIRED" } });
    }
    return route.fallback();
  });
  const section = () => page.locator('section[aria-labelledby="meta-signup-heading"]');
  const open = async (purpose: "NEW_NUMBER" | "ADD_ACCESS" = "ADD_ACCESS") => {
    await page.goto("/app?view=connections"); await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
    const connect = page.getByRole("button", { name: t("tenant.connections.connect"), exact: true });
    if (!["tenant_owner", "tenant_admin"].includes(role)) { await expect(connect).toHaveCount(0); return; }
    await connect.click();
    const dialog = page.getByRole("dialog", { name: t("tenant.setup.ariaLabel") });
    await dialog.getByLabel(t("tenant.setup.name.label")).fill("Existing Access");
    await dialog.getByText(t("tenant.setup.providers.metaTitle"), { exact: true }).click();
    await dialog.getByRole("button", { name: t("tenant.setup.actions.continue"), exact: true }).click();
    await dialog.getByRole("radio", { name: t(`tenant.metaSignup.addAccess.purpose.${purpose}`), exact: true }).check();
  };
  const emit = async (code: string) => page.evaluate(value => (window as unknown as { addAccessCallbacks: ((value: unknown) => void)[] }).addAccessCallbacks.at(-1)!({ authResponse: { code: value } }), code);
  await open("NEW_NUMBER");
  if (!["tenant_owner", "tenant_admin"].includes(role)) { expect(reads).toEqual([]); expect(writes).toEqual([]); return; }
  await section().getByRole("button", { name: t("tenant.metaSignup.prepare"), exact: true }).click();
  await section().getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true }).click();
  await page.getByRole("radio", { name: t("tenant.metaSignup.addAccess.purpose.ADD_ACCESS"), exact: true }).check();
  await expect(section().getByRole("heading", { name: t("tenant.metaSignup.addAccess.title"), exact: true })).toBeVisible();
  await emit("late-new-number-code"); expect(writes.filter(item => item.path.endsWith("/exchange"))).toHaveLength(0);
  const prepare = section().getByRole("button", { name: t("tenant.metaSignup.addAccess.prepare"), exact: true });
  await expect(prepare).toBeEnabled();
  await prepare.focus(); await page.keyboard.press("Enter");
  await section().getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true }).click(); await emit("add-access-code");
  await expect(section().getByRole("radio", { name: /12025550145/u })).not.toBeChecked();
  for (const number of ["12025550146", "12025550147", "12025550148", "12025550149"]) await expect(section().getByRole("radio", { name: new RegExp(number) })).toBeDisabled();
  await expect(section().locator('input[type="password"]')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include('section[aria-labelledby="meta-signup-heading"]').analyze()).violations).toEqual([]);
  const reviewExisting = t("tenant.metaSignup.addAccess.reviewExisting").replace("{name}", "\u2068Prior <name>\u2069");
  const reviewExistingButton = section().getByRole("button", { name: reviewExisting, exact: true });
  await expect(reviewExistingButton).toHaveText(reviewExisting);
  await reviewExistingButton.click();
  await expect(page).toHaveURL(new RegExp(`connection=${prior}`)); expect(writes.filter(item => item.path.endsWith("/select"))).toHaveLength(0);
  await open(); await section().getByRole("radio", { name: /12025550145/u }).check();
  await section().getByRole("heading").scrollIntoViewIfNeeded();
  await testInfo.attach("add-access-selection-top", { body: await page.screenshot(), contentType: "image/png" });
  await section().getByRole("button", { name: t("tenant.metaSignup.addAccess.select"), exact: true }).scrollIntoViewIfNeeded();
  await testInfo.attach("add-access-selection-actions", { body: await page.screenshot(), contentType: "image/png" });
  loseSelect = true;
  await section().getByRole("button", { name: t("tenant.metaSignup.addAccess.select"), exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(section().getByText(t("tenant.metaSignup.checking"), { exact: true })).toBeVisible();
  await open(); // Latest is scoped by ADD_ACCESS; no new grant, selection or activation.
  await expect(section().getByText(t("tenant.metaSignup.addAccess.status.COMPLETED"), { exact: true })).toBeVisible();
  expect(writes.filter(item => item.path.endsWith("/select"))).toHaveLength(1);
  expect(writes.filter(item => item.path.endsWith("/exchange"))).toHaveLength(1);
  await section().getByRole("heading").scrollIntoViewIfNeeded();
  await testInfo.attach("add-access-paused-completion", { body: await page.screenshot(), contentType: "image/png" });
  await section().getByRole("button", { name: t("tenant.metaSignup.view"), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`connection=${alpha}`));
  await page.getByRole("button", { name: t("tenant.connection.lifecycle.action.start"), exact: true }).click();
  await expect(page.getByText(t("tenant.metaSignup.reason.META_SIGNUP_ADD_ACCESS_ACTIVATION_REQUIRED"), { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: t("tenant.actions.retrySameRequest"), exact: true })).toHaveCount(0);
  expect(writes.filter(item => item.path.endsWith("/start"))).toHaveLength(1);

  // Bound stage recovery stays exact and offers no number registration or re-discovery.
  const staged = { ...selection(initial("ADD_ACCESS")), connectionId: alpha, operationId: "77000000-0000-4000-8000-000000000092",
    reasonCode: "META_SIGNUP_CREDENTIAL_UNAVAILABLE" as const };
  staged.choices = staged.choices.slice(0, 1); save(staged);
  await open(); await section().getByRole("radio", { name: /12025550145/u }).check();
  await expect(section().locator('input[type="password"]')).toHaveCount(0);
  await expect(section().getByRole("button", { name: t("tenant.metaSignup.discover"), exact: true })).toHaveCount(0);
  await section().getByRole("button", { name: t("tenant.metaSignup.addAccess.select"), exact: true }).click();
  await expect(section().getByText(t("tenant.metaSignup.addAccess.status.COMPLETED"), { exact: true })).toBeVisible();
  const changedStage = save({ ...staged, attemptId: initial("ADD_ACCESS").attemptId, revision: 5, status: "ACTION_REQUIRED", nextAction: "REVIEW_OUTCOME", canCancel: false,
    reasonCode: "META_SIGNUP_ADD_ACCESS_STAGE_CHANGED", choices: staged.choices.map(choice => ({ ...choice, selectable: false })) });
  await open(); await expect(section().getByRole("radio", { name: /12025550145/u })).toBeDisabled();
  const cancellationCountBeforeStale = writes.filter(item => item.path.endsWith("/cancel")).length;
  await expect(section().getByText(t("tenant.metaSignup.reason.META_SIGNUP_ADD_ACCESS_STAGE_CHANGED"), { exact: true })).toBeVisible();
  await expect(section().getByRole("button", { name: t("tenant.metaSignup.cancel"), exact: true })).toHaveCount(0);
  await expect(section().getByRole("button", { name: t("tenant.metaSignup.view"), exact: true })).toBeEnabled();
  await expect(section().getByRole("button", { name: t("tenant.metaSignup.addAccess.select"), exact: true })).toHaveCount(0);
  expect(writes.filter(item => item.path.endsWith("/cancel")).length).toBe(cancellationCountBeforeStale);
  // A different exact-current stage permits cancellation. Lost readback remains
  // uncertain until its own authoritative terminal result; stale binding stays held.
  const currentStage = save({ ...staged, attemptId: initial("ADD_ACCESS").attemptId, revision: 5 });
  await open();
  cancelUnavailable = true;
  await section().getByRole("button", { name: t("tenant.metaSignup.cancel"), exact: true }).click();
  await expect(section().getByText(t("tenant.metaSignup.checking"), { exact: true })).toBeVisible();
  await expect(section().getByRole("button", { name: t("tenant.metaSignup.addAccess.select"), exact: true })).toHaveCount(0);
  const cancellationCount = writes.filter(item => item.path.endsWith("/cancel")).length;
  // Independent synthetic readback now has a terminal cancellation; no cancel retry is issued.
  save({ ...currentStage, revision: 6, status: "CANCELLED", nextAction: "START_AGAIN", canCancel: false, canStartAgain: true });
  await open(); await expect(section().getByText(t("tenant.metaSignup.status.CANCELLED"), { exact: true })).toBeVisible();
  expect(writes.filter(item => item.path.endsWith("/cancel")).length).toBe(cancellationCount);
  expect(attempts.get(changedStage.attemptId)?.status).toBe("ACTION_REQUIRED");

  wrongPurpose = true; await open();
  await expect(section().getByText(t("tenant.metaSignup.scopeChanged"), { exact: true })).toBeVisible();
  await expect(section().getByRole("button", { name: t("tenant.metaSignup.addAccess.prepare"), exact: true })).toHaveCount(0);
  wrongPurpose = false; delayLatest = true;
  await open(); await expect.poll(() => Boolean(pendingLatest.release)).toBe(true);
  await page.getByRole("radio", { name: t("tenant.metaSignup.addAccess.purpose.NEW_NUMBER"), exact: true }).check();
  releasePendingLatest();
  await expect(section().getByRole("heading", { name: t("tenant.metaSignup.title"), exact: true })).toBeVisible();
  await expect(section().getByText(t("tenant.metaSignup.addAccess.status.COMPLETED"), { exact: true })).toHaveCount(0);
  delayLatest = true;
  await page.getByRole("radio", { name: t("tenant.metaSignup.addAccess.purpose.ADD_ACCESS"), exact: true }).check();
  await expect.poll(() => Boolean(pendingLatest.release)).toBe(true);
  const deadlineAlert = section().getByRole("alert");
  await expect(deadlineAlert).toHaveCount(0);
  await advancePastRequestDeadline();
  await expect(deadlineAlert).toBeVisible();
  await expect(section()).toHaveAttribute("aria-busy", "false");
  releasePendingLatest();
  await section().getByRole("button", { name: t("tenant.setup.actions.back"), exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: t("tenant.setup.actions.continue"), exact: true }).click();
  await expect(prepare).toBeEnabled();
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes("add-access-code"))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(writes.filter(item => item.path.endsWith("/select"))).toHaveLength(2);
  expect(problems).toEqual([]); expect(failures).toEqual([]);
}
