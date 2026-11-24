import AxeBuilder from "@axe-core/playwright";
import { expect, type ConsoleMessage, type Page, type TestInfo } from "@playwright/test";
import type { MetaSignupAttemptView } from "../../lib/meta-signup-contract";
import { uiErrorMessage } from "../../lib/ui-error";
import { englishTenantMessages } from "../../lib/i18n/messages/en/tenant.ts";
import { arabicTenantMessages } from "../../lib/i18n/messages/ar/tenant.ts";

const expectedDenials = new WeakMap<Page, { url: string; status: 403 | 409 }[]>();
export function consumeExpectedSignupDenial(page: Page, message: ConsoleMessage) {
  if (!message.text().startsWith("Failed to load resource:")) return false;
  const expected = expectedDenials.get(page);
  const index = expected?.findIndex(item => item.url === message.location().url
    && message.text().includes(`status of ${item.status} `)) ?? -1;
  if (index < 0) return false;
  expected!.splice(index, 1);
  return true;
}

/** Deliberately mocked provider/browser responses; never live Meta acceptance. */
export async function metaSignupJourney(page: Page, locale: "en" | "ar", role: string, testInfo: TestInfo) {
  const denials: { url: string; status: 403 | 409 }[] = [];
  expectedDenials.set(page, denials);
  const messages: Readonly<Record<string, string>> = locale === "ar" ? arabicTenantMessages : englishTenantMessages;
  const t = (key: string) => messages[key]!;
  const sdk = { appId: "12345678", configId: "87654321", graphVersion: "v24.0" };
  const challenge = "S".repeat(43);
  const verifiedChoice = "55000000-0000-4000-8000-000000000001";
  const unverifiedChoice = "55000000-0000-4000-8000-000000000002";
  let stagedResume: { pinRequired: boolean } | null = null;
  let capabilityError: string | null = null;
  let mutationError: string | null = null;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let current: MetaSignupAttemptView | null = null;
  let attemptSequence = 0;
  const initial = (): MetaSignupAttemptView => ({ purpose: "NEW_NUMBER", attemptId: `44000000-0000-4000-8000-${String(++attemptSequence).padStart(12, "0")}`, revision: 1,
    status: "AWAITING_AUTHORIZATION", nextAction: "AUTHORIZE", expiresAt: new Date(Date.now() + 600_000).toISOString(),
    canCancel: true, canStartAgain: false, choices: [], readiness: { authorization: "PENDING", number: "PENDING",
      subscription: "PENDING", messaging: "UNKNOWN", payment: { requestedPayer: "CUSTOMER", status: "UNKNOWN", paymentMethodVerified: false } } });
  await page.route("https://connect.facebook.net/en_US/sdk.js", route => route.fulfill({ contentType: "text/javascript", body:
    "window.metaSignupCallbacks=[];window.FB={init(){},login(callback){window.metaSignupCallbacks.push(callback);}};" }));
  await page.route("**/api/connections/meta/signup/**", async route => {
    const deny = (status: 403 | 409, code: string) => {
      denials.push({ url: route.request().url(), status });
      return route.fulfill({ status, json: { code, message: "RAW_PROVIDER_DETAIL_MUST_NOT_RENDER" } });
    };
    const path = new URL(route.request().url()).pathname.split("/signup/")[1];
    if (route.request().method() === "GET") {
      if (path === "capabilities" && capabilityError) return deny(403, capabilityError);
      return route.fulfill({ json: path === "capabilities" ? { enabled: true, payerModes: ["CUSTOMER"], sdk }
        : path === "attempts" ? { attempt: current } : current });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.push({ path, body });
    if (path === "attempts") {
      if (mutationError) {
        const code = mutationError; mutationError = null;
        return deny(403, code);
      }
      current = initial();
      return route.fulfill({ json: { ...current, challenge, sdk } });
    }
    if (path.endsWith("/exchange")) {
      expect(body).toMatchObject({ expectedRevision: 1, challenge, code: "synthetic-code-once" });
      current = { ...current!, revision: 4, status: "SELECTION_REQUIRED", nextAction: "SELECT_NUMBER", selectionRevision: 1,
        readiness: { ...current!.readiness, authorization: "VERIFIED", payment: { requestedPayer: "CUSTOMER", status: "MANAGED_IN_META", paymentMethodVerified: false } },
        choices: [{ choiceId: verifiedChoice, businessName: "Synthetic Company", accountName: "Customer service",
          displayPhoneNumber: "12025550143", verifiedName: "Service", mode: "STANDARD", numberState: "REGISTRATION_REQUIRED", selectable: true },
        { choiceId: unverifiedChoice, businessName: "Synthetic Company", accountName: "Other number", displayPhoneNumber: "12025550144",
          mode: "UNKNOWN", numberState: "UNKNOWN", selectable: false, reasonCode: "META_SIGNUP_MODE_UNKNOWN" }] };
    } else if (path.endsWith("/cancel")) {
      current = { ...current!, revision: current!.revision + 1, status: "CANCELLED", nextAction: "START_AGAIN", canCancel: false, canStartAgain: true };
    } else if (path.endsWith("/discover")) {
      current = { ...current!, revision: current!.revision + 1, status: "NUMBER_REQUIRED", nextAction: "COMPLETE_META_SETUP", reasonCode: "META_SIGNUP_NO_PHONE" };
    } else if (path.endsWith("/select")) {
      if (stagedResume) {
        expect(body).toMatchObject({ choiceId: verifiedChoice, expectedRevision: current!.revision, selectionRevision: current!.selectionRevision });
        if (stagedResume.pinRequired && body.registrationPin === undefined) {
          return deny(409, "META_SIGNUP_CREDENTIAL_UNAVAILABLE");
        }
        expect(body.registrationPin).toBe(stagedResume.pinRequired ? "482916" : undefined);
        current = { ...current!, revision: current!.revision + 1, status: "COMPLETED", nextAction: "DONE", canStartAgain: true,
          readiness: { ...current!.readiness, number: "REGISTERED", subscription: "CONFIRMED", messaging: "AVAILABLE" } };
        stagedResume = null;
        return route.fulfill({ json: current });
      }
      expect(body).toMatchObject({ choiceId: verifiedChoice, registrationPin: "482916", expectedRevision: 4, selectionRevision: 1 });
      current = { ...current!, revision: 6, status: "COMPLETED", nextAction: "DONE", canCancel: false, canStartAgain: true, choices: [],
        connectionId: "44000000-0000-4000-8000-000000000099", readiness: { ...current!.readiness, number: "REGISTERED", subscription: "CONFIRMED", messaging: "AVAILABLE" } };
      // The provider result is durable, but the browser receives no usable result.
      return route.fulfill({ contentType: "application/json", body: "{" });
    }
    return route.fulfill({ json: current });
  });
  const open = async () => {
    await page.goto("/app?view=connections", { waitUntil: "commit" });
    await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
    const connect = page.getByRole("button", { name: t("tenant.connections.connect"), exact: true });
    if (!["tenant_owner", "tenant_admin"].includes(role)) { await expect(connect).toHaveCount(0); return null; }
    await connect.click();
    const dialog = page.getByRole("dialog", { name: t("tenant.setup.ariaLabel") });
    await dialog.getByLabel(t("tenant.setup.name.label")).fill("x".repeat(101));
    await dialog.getByText(t("tenant.setup.providers.metaTitle"), { exact: true }).click();
    await expect(dialog.getByLabel(t("tenant.setup.name.label"))).toHaveAttribute("maxlength", "100");
    await expect(dialog.getByRole("button", { name: t("tenant.setup.actions.continue"), exact: true })).toBeDisabled();
    await expect(dialog.getByText(t("tenant.metaSignup.nameHelp"), { exact: true })).toBeVisible();
    await dialog.getByLabel(t("tenant.setup.name.label")).fill("Customer service");
    await dialog.getByRole("button", { name: t("tenant.setup.actions.continue"), exact: true }).click();
    return dialog;
  };
  let dialog = await open();
  if (!dialog) return;
  await expect(dialog.getByRole("button", { name: t("tenant.metaSignup.prepare"), exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: t("tenant.metaSignup.prepare"), exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(dialog.getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true })).toBeVisible();
  expect(calls.filter(call => call.path === "attempts")).toHaveLength(1);
  await dialog.getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { origin: "https://www.facebook.com", data: { type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: "untrusted" } } })));
  expect(calls.filter(call => call.path.endsWith("/exchange"))).toHaveLength(0);
  await page.evaluate(() => {
    const callbacks = (window as unknown as { metaSignupCallbacks: ((value: unknown) => void)[] }).metaSignupCallbacks;
    if (callbacks.length !== 1) throw new Error("Duplicate SDK invocation");
    callbacks[0]({ authResponse: { code: "synthetic-code-once" } });
    callbacks[0]({ authResponse: { code: "duplicate-code" } });
  });
  await expect(dialog.getByRole("radio", { name: /12025550143/u })).toBeVisible();
  await expect(dialog.getByRole("button", { name: t("tenant.metaSignup.select"), exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: /12025550144/u })).toBeDisabled();
  await dialog.getByRole("radio", { name: /12025550143/u }).focus();
  await page.keyboard.press("Space");
  const select = dialog.getByRole("button", { name: t("tenant.metaSignup.select"), exact: true });
  await expect(select).toBeDisabled();
  await dialog.getByLabel(t("tenant.metaSignup.pin"), { exact: true }).fill("482916");
  await expect(select).toBeEnabled();
  await page.keyboard.press("Tab");
  await expect(select).toBeFocused();
  expect((await new AxeBuilder({ page }).include("dialog").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("signup-selection.png") });
  await select.click();
  await expect(dialog.getByRole("button", { name: t("tenant.metaSignup.refresh"), exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: t("tenant.metaSignup.refresh"), exact: true }).click();
  await expect(dialog.getByText(t("tenant.metaSignup.status.COMPLETED"), { exact: true })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByText(t("tenant.metaSignup.billing"), { exact: true })).toBeVisible();
  await expect(dialog.getByText(t("tenant.metaSignup.ownership"), { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("signup-completion.png") });
  expect(calls.filter(call => call.path.endsWith("/exchange"))).toHaveLength(1);
  expect(calls.filter(call => call.path.endsWith("/select"))).toHaveLength(1);
  const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
  expect(storage).not.toMatch(/synthetic-code|482916/u);
  expect(storage).not.toContain(challenge);

  // Reload resumes authoritative completion without a new popup or exchange.
  dialog = await open();
  await expect(dialog!.getByText(t("tenant.metaSignup.status.COMPLETED"), { exact: true })).toBeVisible();
  expect(calls.filter(call => call.path === "attempts")).toHaveLength(1);

  // A bound STAGED operation resumes the same number; it cannot rediscover assets.
  for (const pinRequired of [false, true]) {
    const prepared = initial();
    current = { ...prepared, revision: 5, status: "SELECTION_REQUIRED", nextAction: "SELECT_NUMBER", selectionRevision: 1,
      canCancel: false, canStartAgain: false, reasonCode: "META_SIGNUP_CREDENTIAL_UNAVAILABLE",
      connectionId: "44000000-0000-4000-8000-000000000098", operationId: "66000000-0000-4000-8000-000000000001",
      readiness: { ...prepared.readiness, authorization: "VERIFIED", number: "REGISTRATION_REQUIRED" },
      choices: [{ choiceId: verifiedChoice, businessName: "Synthetic Company", accountName: "Customer service",
        displayPhoneNumber: "12025550143", mode: "STANDARD", numberState: "REGISTRATION_REQUIRED", selectable: true }] };
    stagedResume = { pinRequired };
    dialog = await open();
    await expect(dialog!.getByRole("button", { name: t("tenant.metaSignup.discover"), exact: true })).toHaveCount(0);
    await dialog!.getByRole("radio", { name: /12025550143/u }).check();
    await expect(dialog!.getByText(t("tenant.metaSignup.pinResumeHelp"), { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`signup-resume-${pinRequired ? "original-pin" : "saved-pin"}.png`) });
    const resume = dialog!.getByRole("button", { name: t("tenant.metaSignup.resumeSelect"), exact: true });
    const input = dialog!.getByLabel(t("tenant.metaSignup.pin"), { exact: true });
    await expect(input).toHaveValue(""); await expect(resume).toBeEnabled();
    if (pinRequired) {
      await resume.click();
      await dialog!.getByRole("button", { name: t("tenant.metaSignup.refresh"), exact: true }).click();
      await input.fill("12"); await expect(resume).toBeDisabled();
      await input.fill("482916"); await expect(resume).toBeEnabled();
    }
    await resume.click();
    await expect(dialog!.getByText(t("tenant.metaSignup.status.COMPLETED"), { exact: true })).toBeVisible();
  }

  // Exact credential recovery discovers server-owned state without replaying a code.
  current = { ...initial(), status: "OUTCOME_UNKNOWN", nextAction: "REVIEW_OUTCOME", reasonCode: "META_SIGNUP_CREDENTIAL_UNAVAILABLE" };
  dialog = await open();
  await dialog!.getByRole("button", { name: t("tenant.metaSignup.discover"), exact: true }).click();
  await expect(dialog!.getByText(t("tenant.metaSignup.status.NUMBER_REQUIRED"), { exact: true })).toBeVisible();
  expect(calls.filter(call => call.path.endsWith("/discover"))).toHaveLength(1);
  expect(calls.filter(call => call.path.endsWith("/exchange"))).toHaveLength(1);

  // An awaiting attempt has no recoverable browser challenge after reload.
  current = initial();
  dialog = await open();
  await expect(dialog!.getByText(t("tenant.metaSignup.resumeAuthorization"), { exact: true })).toBeVisible();
  await expect(dialog!.getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true })).toHaveCount(0);
  await dialog!.getByRole("button", { name: t("tenant.metaSignup.cancel"), exact: true }).click();
  await dialog!.getByRole("button", { name: t("tenant.metaSignup.prepare"), exact: true }).click();
  await dialog!.getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true }).click();
  await dialog!.getByRole("button", { name: t("tenant.metaSignup.cancel"), exact: true }).click();
  await expect(dialog!.getByText(t("tenant.metaSignup.status.CANCELLED"), { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { metaSignupCallbacks: ((value: unknown) => void)[] }).metaSignupCallbacks.at(-1)!({ authResponse: { code: "late-code" } }));
  expect(calls.filter(call => call.path.endsWith("/exchange"))).toHaveLength(1);

  // Closing the owning form also invalidates an outstanding SDK invocation.
  await dialog!.getByRole("button", { name: t("tenant.metaSignup.prepare"), exact: true }).click();
  await dialog!.getByRole("button", { name: t("tenant.metaSignup.connect"), exact: true }).click();
  const cancellations = calls.filter(call => call.path.endsWith("/cancel")).length;
  await dialog!.getByRole("button", { name: t("tenant.setup.actions.close"), exact: true }).click();
  await dialog!.getByRole("button", { name: t("tenant.dialog.discard.confirm"), exact: true }).click();
  await expect(dialog!).toHaveCount(0);
  await expect(page.getByRole("button", { name: t("tenant.connections.connect"), exact: true })).toBeFocused();
  await expect.poll(() => calls.filter(call => call.path.endsWith("/cancel")).length).toBe(cancellations + 1);
  await page.evaluate(() => (window as unknown as { metaSignupCallbacks: ((value: unknown) => void)[] }).metaSignupCallbacks.at(-1)!({ authResponse: { code: "late-after-close" } }));
  expect(calls.filter(call => call.path.endsWith("/exchange"))).toHaveLength(1);

  // Privileged reauthentication is actionable for both mutations and initial reads.
  dialog = await open();
  mutationError = "REAUTHENTICATION_REQUIRED";
  await dialog!.getByRole("button", { name: t("tenant.metaSignup.prepare"), exact: true }).click();
  await expect(dialog!.getByRole("alert")).toHaveText(uiErrorMessage(locale, "REAUTHENTICATION_REQUIRED"));
  await expect(dialog!).not.toContainText("RAW_PROVIDER_DETAIL_MUST_NOT_RENDER");
  capabilityError = "REAUTHENTICATION_REQUIRED";
  dialog = await open();
  await expect(dialog!.getByRole("alert")).toHaveText(uiErrorMessage(locale, "REAUTHENTICATION_REQUIRED"));
  await expect(dialog!).not.toContainText("RAW_PROVIDER_DETAIL_MUST_NOT_RENDER");
  await expect.poll(() => denials.length).toBe(0);
}
