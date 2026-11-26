import { expect, test, type Page, type Request, type Route, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { englishPlatformMessages } from "../../lib/i18n/messages/en/platform.ts";
import { arabicPlatformMessages } from "../../lib/i18n/messages/ar/platform.ts";
import { formatDateTime } from "../../lib/i18n/format.ts";
import { createTranslator } from "../../lib/i18n/translate.ts";
import type { MetaTransitionOperatorReview, MetaTransitionOperatorResult, MetaTransitionOperatorRequest, MetaTransitionOperatorAction } from "../../packages/core/src/meta-transition-operator-contract.ts";

// Existing runner + real root-supplied operator session. Only transition APIs
// are mocked. Missing authentication/server prerequisites are explicit SKIP.
const locale = process.env.WASALX_E2E_LOCALE === "ar" ? "ar" : "en";
const t = createTranslator<Readonly<Record<string, string>>>(locale === "ar" ? arabicPlatformMessages : englishPlatformMessages);
const text = (key: string) => t(`platform.metaTransition.${key}`);
const state = process.env.WASALX_E2E_PLATFORM_STORAGE_STATE, url = process.env.WASALX_E2E_PLATFORM_URL;
const tenant = process.env.WASALX_E2E_PLATFORM_TENANT_ID ?? "", tenantName = process.env.WASALX_E2E_PLATFORM_TENANT_NAME ?? "";
const ready = Boolean(state && url && tenantName && /^[0-9a-f-]{36}$/u.test(tenant) && process.env.WASALX_E2E_REUSE_SERVER === "1");
const browserLocale = locale === "ar" ? "en-US" : "ar-SA";
test.use({ locale: browserLocale, storageState: state ?? { cookies: [], origins: [] } });
const id = (n: number) => `64000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const plan = id(2), other = id(8), root = () => `/api/platform-console/operations/tenants/${tenant}/meta/account-transitions`;
function review(): MetaTransitionOperatorReview { return { id: plan, tenantId: tenant, name: "Transition account", revision: 3, requestedMode: "CUSTOMER", sourceCurrency: "USD", targetCurrency: "SAR", phase: "RESERVED", evidenceMode: "SIMULATED", reviewSha256: "a".repeat(64), connectionNames: ["اتصال المبيعات (Sales)"], connectionCount: 1, providerStatus: null, checkpoints: [], proof: { sourceScope: "CURRENT", targetAccess: "NONE", payment: "VERIFIED", renewedObserver: "ABSENT", prerequisiteApproval: "MISSING", targetReview: "MISSING" }, actions: { PREREQUISITES: true, TARGET: false, COMPLETION: false }, reasons: [], arrangements: [], originalGrant: null, pendingCommand: null }; }
type Write = { path: string; key: string; scope: string; action: MetaTransitionOperatorAction; body: MetaTransitionOperatorRequest };
function terminal(write: Write, disposition: "APPLIED" | "NO_EFFECT" = "APPLIED"): MetaTransitionOperatorResult { return { tenantId: tenant, planId: write.path.split("/account-transitions/")[1]!.split("/")[0]!, requestKey: write.key, action: write.action, request: structuredClone(write.body), state: disposition, commandReceiptId: id(10), approvalReceiptId: disposition === "APPLIED" ? id(11) : null, duplicate: false }; }
function admitted() { test.skip(!ready, "Requires root-supplied authenticated platform session and reused control-plane server"); }
function observeOperatorCount(name: string, value: number) {
  test.info().annotations.push({ type: "wasalx-operator:" + name, description: String(value) });
}
async function setup(page: Page) {
  const errors: string[] = [], expected: Array<{ url: string; status: number }> = [], writes: Write[] = [], reads: string[] = [];
  const lostResponse = { request: undefined as Request | undefined, consoleMatches: 0 };
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    const index = expected.findIndex(item => item.url === message.location().url && message.text().includes(String(item.status)));
    if (index >= 0) {
      expected.splice(index, 1);
      return;
    }
    if (lostResponse.consoleMatches === 0 && lostResponse.request?.url() === message.location().url &&
        /^Failed to load resource: the server responded with a status of 502(?: \([^\r\n]*\))?$/u.test(message.text())) {
      lostResponse.consoleMatches++;
      return;
    }
    errors.push(message.text());
  });
  const gate: { wait: Promise<void> | null; entered: boolean } = { wait: null, entered: false };
  const listGate: { wait: Promise<void> | null; entered: boolean; omitSelected: boolean } = { wait: null, entered: false, omitSelected: false };
  const h = { current: review(), gate, listGate, writes, reads, errors, expected, lostResponse, deny: false, deniedReads: 0, write: async (route: Route, value: Write) => { h.current.pendingCommand = terminal(value); h.current.actions[value.action] = false; h.current.revision++; h.current.reviewSha256 = "d".repeat(64); await route.fulfill({ json: h.current.pendingCommand }); } };
  await page.route(target => target.pathname === root() || target.pathname.startsWith(root() + "/"), async route => {
    const request = route.request(), target = new URL(request.url());
    expect(request.headers()["x-wasalx-platform-recovery-scope"]).toMatch(/^[a-f0-9]{64}$/u);
    if (request.method() === "GET") {
      reads.push(target.pathname + target.search);
      if (h.deny) {
        expected.push({ url: request.url(), status: 403 });
        await route.fulfill({ status: 403, json: { error: "PRIVATE_AUTHORITY_DETAIL" } });
        h.deniedReads++;
        return;
      }
      if (target.pathname === root()) {
        const capturedPlans = structuredClone([...(listGate.omitSelected ? [] : [h.current]), { ...review(), id: other, name: "Other plan" }]);
        if (listGate.wait) { const wait = listGate.wait; listGate.wait = null; listGate.entered = true; await wait; }
        return route.fulfill({ json: { tenantId: tenant, plans: capturedPlans } });
      }
      const captured = structuredClone(h.current);
      if (!target.pathname.includes(other) && gate.wait) { const wait = gate.wait; gate.wait = null; gate.entered = true; await wait; }
      return route.fulfill({ json: target.pathname.includes(other) ? { ...review(), id: other, name: "Other plan", actions: { PREREQUISITES: false, TARGET: false, COMPLETION: false }, reasons: ["PLAN_CLOSED"] } : captured });
    }
    const segments = target.pathname.split("/"), action = (segments.at(-1) === "resolve" ? segments.at(-2)! : segments.at(-1)!).toUpperCase() as MetaTransitionOperatorAction;
    const value = { path: target.pathname, key: request.headers()["idempotency-key"] ?? "", scope: request.headers()["x-wasalx-platform-recovery-scope"] ?? "", action, body: request.postDataJSON() as MetaTransitionOperatorRequest };
    expect(value.key).toMatch(/^[0-9a-f-]{36}$/u); writes.push(structuredClone(value)); await h.write(route, value);
  });
  const origin = new URL(url!).origin;
  const localeCookies = [{ name: "wasalx_locale", value: locale, url: origin }];
  if (origin.startsWith("https:")) localeCookies.push({ name: "__Host-wasalx_locale", value: locale, url: origin });
  await page.context().addCookies(localeCookies);
  const dialog = () => page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: text("title"), exact: true }) });
  const open = async (navigate = true) => {
    if (navigate) await test.step("Navigate to platform tenants", () => page.goto(url!));
    const row = page.getByRole("row").filter({ has: page.getByText(tenantName, { exact: true }) });
    await test.step("Find tenant row", () => expect(row).toHaveCount(1));
    await test.step("Open transition dialog", async () => {
      await row.getByRole("button", { name: text("open"), exact: true }).click();
      await expect(dialog()).toBeVisible();
    });
    await test.step("Select transition plan", () => dialog().getByRole("combobox", { name: text("plan"), exact: true }).selectOption(h.current.id));
    await test.step("Read transition review", () => expect(dialog().getByRole("heading", { name: h.current.name, exact: true })).toBeVisible());
  };
  await open(); return { ...h, h, dialog, open };
}
async function prepare(page: Page, action: MetaTransitionOperatorAction) {
  const dialog = page.getByRole("dialog");
  await test.step(`Select ${action} review`, () => dialog.getByRole("combobox", { name: text("reviewKind"), exact: true }).selectOption(action));
  await dialog.getByLabel(text("evidence"), { exact: true }).fill("b".repeat(64));
  if (action === "PREREQUISITES") { const payment = dialog.getByRole("combobox", { name: text("sourcePayment"), exact: true }); if (await payment.isEnabled()) await payment.selectOption("CARD"); }
  if (action === "TARGET") { await dialog.getByLabel(text("templates"), { exact: true }).fill("c".repeat(64)); await dialog.getByLabel(text("flows"), { exact: true }).fill("e".repeat(64)); }
  const checked = dialog.getByLabel(text("confirmEvidence"), { exact: true }); await checked.focus(); await page.keyboard.press("Space");
}
async function record(page: Page) { const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: text("review"), exact: true }).click(); const button = dialog.getByRole("button", { name: text("record"), exact: true }); await button.focus(); await page.keyboard.press("Enter"); }
async function screenshot(page: Page, info: TestInfo, label: string) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await info.attach(`transition-${label}-${locale}-${info.project.name}`, { body: await page.screenshot(), contentType: "image/png" }); }

test("operator records three explicit local reviews and independently selected managed target terms", async ({ page }, info) => {
  admitted(); const x = await setup(page), h = x.h;
  await prepare(page, "PREREQUISITES"); expect(h.writes).toHaveLength(0); await record(page); await expect(x.dialog().getByText(text("result.APPLIED"), { exact: true })).toBeVisible();
  await expect(x.dialog().getByRole("combobox", { name: text("reviewKind"), exact: true }).locator('option[value="PREREQUISITES"]')).toHaveCount(0);
  expect(h.writes[0]!.body).toEqual({ expectedRevision: 3, expectedReviewSha256: "a".repeat(64), evidenceSha256: "b".repeat(64), confirmed: true, sourcePayment: "CARD" });
  for (const action of ["TARGET", "COMPLETION"] as const) {
    h.current.actions[action] = true; h.current.proof.targetAccess = "CLONE"; h.current.proof.renewedObserver = "CURRENT"; h.current.proof.prerequisiteApproval = "CURRENT"; if (action === "COMPLETION") h.current.proof.targetReview = "CURRENT";
    await x.dialog().getByRole("button", { name: text("refresh"), exact: true }).click(); await prepare(page, action); await record(page); await expect.poll(() => h.writes.length).toBe(action === "TARGET" ? 2 : 3); await expect(x.dialog().getByRole("combobox", { name: text("reviewKind"), exact: true }).locator(`option[value="${action}"]`)).toHaveCount(0);
  }
  expect(h.writes[1]!.body.templateEvidenceSha256).toBe("c".repeat(64)); expect(h.writes[1]!.body.flowEvidenceSha256).toBe("e".repeat(64)); expect(Object.keys(h.writes[2]!.body).sort()).toEqual(["confirmed", "evidenceSha256", "expectedReviewSha256", "expectedRevision"]);
  // A distinct server-supplied managed plan is seeded for the separate grant form.
  await x.dialog().getByRole("button", { name: t("platform.actions.closeDialog"), exact: true }).click();
  const morning = { id: id(20), label: "Approved arrangement", expiresAt: "2099-01-01T00:00:00Z" };
  const evening = { ...morning, id: id(21), expiresAt: "2099-01-01T12:00:00Z" };
  h.current = { ...review(), id: id(30), name: "Managed transition", revision: 10, requestedMode: "WASALX_MANAGED", arrangements: [morning, evening] };
  const dialog = x.dialog();
  const arrangement = dialog.getByRole("combobox", { name: text("arrangement"), exact: true });
  const expiry = dialog.locator("time");
  for (const [theme, themeLabel] of [["light", "useLightLabel"], ["dark", "useDarkLabel"]] as const) {
    await test.step(`Read closed arrangement expiry in ${theme} theme`, async () => {
      const toggleTheme = page.getByRole("button", { name: t(`platform.theme.${themeLabel}`), exact: true });
      if (await toggleTheme.count()) await toggleTheme.click();
      await x.open(false);
      await expect(page.locator(`.theme-${theme} dialog[open]`)).toBeVisible();
      await prepare(page, "PREREQUISITES");
      await expect(arrangement).toHaveValue("");
      await expect(arrangement).toHaveJSProperty("required", true);
      await expect(expiry).toHaveCount(0);
      await dialog.getByRole("combobox", { name: text("sourcePayment"), exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(arrangement).toBeFocused();
      for (const [option, period] of [[evening, locale === "ar" ? "م" : "PM"], [morning, locale === "ar" ? "ص" : "AM"]] as const) {
        await arrangement.selectOption(option.id);
        const formatted = formatDateTime(option.expiresAt, locale);
        expect(formatted.endsWith(period)).toBe(true);
        await expect(expiry).toHaveText(formatted);
        await expiry.scrollIntoViewIfNeeded();
        await expect(expiry).toBeInViewport({ ratio: 1 });
        expect(await expiry.evaluate(element => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const { left, right } = element.parentElement!.getBoundingClientRect();
          const fragments = Array.from(range.getClientRects()).filter(rect => rect.width > 0);
          return fragments.length > 0 && fragments.every(rect => rect.left >= left - 1 && rect.right <= right + 1);
        })).toBe(true);
      }
      await expect(arrangement).toBeInViewport({ ratio: 1 });
      await screenshot(page, info, `arrangement-expiry-${theme}`);
      if (theme === "light") {
        await arrangement.selectOption("");
        await expect(expiry).toHaveCount(0);
        await dialog.getByRole("button", { name: t("platform.actions.closeDialog"), exact: true }).click();
      }
    });
  }
  await dialog.getByLabel(text("receiver"), { exact: true }).fill("9"); await dialog.getByLabel(text("termsVersion"), { exact: true }).fill("2026.10"); await dialog.getByLabel(text("terms"), { exact: true }).fill("Approved target terms / الشروط المعتمدة");
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  expect(await page.evaluate(() => navigator.language)).toBe(browserLocale);

  const reviewApproval = dialog.getByRole("button", { name: text("review"), exact: true });
  const recordApproval = dialog.getByRole("button", { name: text("record"), exact: true });
  const termsConfirmation = dialog.getByRole("checkbox", { name: text("acceptTerms"), exact: true });
  const evidenceConfirmation = dialog.getByRole("checkbox", { name: text("confirmEvidence"), exact: true });
  const evidence = dialog.getByLabel(text("evidence"), { exact: true });
  const alert = dialog.getByRole("alert").filter({ hasText: /\S/u });
  await test.step("Validate required evidence field", async () => {
    await evidenceConfirmation.uncheck();
    await evidence.fill("");
    await reviewApproval.press("Enter");
    await expect(evidence).toBeFocused();
    await expect(alert).toHaveCount(0);
    await expect(recordApproval).toHaveCount(0);
    expect(h.writes).toHaveLength(3);
    await evidence.fill("b".repeat(64));
  });

  for (const [checkbox, message] of [[termsConfirmation, "acceptTermsRequired"], [evidenceConfirmation, "confirmEvidenceRequired"]] as const) {
    await test.step(`Validate and recover ${message}`, async () => {
      await reviewApproval.press("Enter");
      await expect(checkbox).toBeFocused();
      await expect(checkbox).toHaveAttribute("aria-invalid", "true");
      await expect(checkbox).toHaveAccessibleDescription(text(message));
      await expect(alert).toHaveText(text(message));
      await expect(alert).toBeInViewport();
      await expect(recordApproval).toHaveCount(0);
      expect(h.writes).toHaveLength(3);
      await screenshot(page, info, message);

      await page.keyboard.press("Space");
      await expect(checkbox).toBeChecked();
      await expect(checkbox).toHaveAccessibleDescription("");
      await expect(alert).toHaveCount(0);
    });
  }
  await screenshot(page, info, "managed-form");
  for (const checkbox of await x.dialog().getByRole("checkbox").all()) { const box = await checkbox.boundingBox(); expect(box).not.toBeNull(); expect(box!.width).toBeLessThan(30); expect(box!.height).toBeLessThan(30); }
  await test.step("Audit open transition dialog", async () => {
    expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  });
  await test.step("Record managed approval", async () => {
    await record(page);
    await expect.poll(() => h.writes.length).toBe(4);
    await expect(x.dialog().getByRole("combobox", { name: text("reviewKind"), exact: true }).locator('option[value="PREREQUISITES"]')).toHaveCount(0);
    expect(h.writes[3]!.body.managed).toEqual({ arrangementVersionId: id(20), targetReceivingBusinessId: "9", targetTermsDocumentText: "Approved target terms / الشروط المعتمدة", targetTermsVersion: "2026.10" });
  });
  await test.step("Read back saved approval terms", async () => {
    h.current.originalGrant = { sourcePayment: "CARD", managed: h.writes[3]!.body.managed! }; h.current.actions.PREREQUISITES = true; h.current.revision++;
    await x.dialog().getByRole("button", { name: text("refresh"), exact: true }).click(); await prepare(page, "PREREQUISITES"); await expect(x.dialog().getByRole("combobox", { name: text("sourcePayment"), exact: true })).toBeDisabled(); await expect(x.dialog().getByRole("combobox", { name: text("arrangement"), exact: true })).toBeDisabled(); await expect(x.dialog().getByLabel(text("receiver"), { exact: true })).toHaveAttribute("readonly", "");
    const savedTerms = x.dialog().getByRole("textbox", { name: text("terms"), exact: true });
    await expect(savedTerms).toHaveAttribute("readonly", "");
    await expect(savedTerms).toHaveValue("Approved target terms / الشروط المعتمدة");
    await expect(expiry).toHaveCount(0);
  });
  expect(new Set(h.writes.map(write => write.key)).size).toBe(4); expect(h.expected).toEqual([]); expect(h.errors).toEqual([]);
});

test("operator lost-response recovery keeps exact intent through reload, mismatched proof and deliberate resolution", async ({ page }, info) => {
  admitted(); const x = await setup(page), h = x.h;
  const responseBody = { error: "PRIVATE_TRANSPORT_DETAIL" };
  h.write = async (route, write) => {
    h.current.revision++;
    h.current.reviewSha256 = "f".repeat(64);
    h.current.pendingCommand = { ...terminal(write), requestKey: id(99) };
    h.lostResponse.request = route.request();
    await route.fulfill({ status: 502, json: responseBody });
  };
  await prepare(page, "PREREQUISITES");
  await test.step("Verify lost transition response", async () => {
    const [response] = await Promise.all([
      page.waitForResponse(candidate => candidate.request() === h.lostResponse.request),
      record(page),
    ]);
    expect(response.request().method()).toBe("POST");
    expect(response.url()).toBe(new URL(`${root()}/${plan}/review/prerequisites`, page.url()).href);
    expect(response.status()).toBe(502);
    expect(await response.json()).toEqual(responseBody);
    observeOperatorCount("lostResponseStatus", response.status());
  });
  await expect(x.dialog().getByText(text("held"), { exact: true })).toBeVisible(); expect(h.writes).toHaveLength(1); const original = structuredClone(h.writes[0]!);
  await expect(page.getByText(responseBody.error)).toHaveCount(0); await page.reload(); await x.open(false); await expect(x.dialog().getByText(text("held"), { exact: true })).toBeVisible();
  expect(h.reads.some(path => path.endsWith(`?requestKey=${original.key}`))).toBe(true); expect(h.writes).toHaveLength(1);
  // Even same-key terminal state without an approval receipt cannot release it.
  h.current.pendingCommand = { ...terminal(original), approvalReceiptId: null };
  await x.dialog().getByRole("button", { name: text("refresh"), exact: true }).click(); await expect(x.dialog().getByText(text("held"), { exact: true })).toBeVisible();
  await screenshot(page, info, "held-original");
  h.write = async (route, write) => { expect(write.path).toBe(original.path + "/resolve"); expect(write.key).toBe(original.key); expect(write.scope).toBe(original.scope); expect(write.body).toEqual(original.body); h.current.pendingCommand = terminal(original, "NO_EFFECT"); await route.fulfill({ json: h.current.pendingCommand }); };
  await x.dialog().getByRole("button", { name: text("resolve"), exact: true }).click(); await expect(x.dialog().getByText(text("held"), { exact: true })).toHaveCount(0); await expect(x.dialog().getByText(text("result.NO_EFFECT"), { exact: true })).toBeVisible(); expect(h.writes).toHaveLength(2);
  // Another operator's storage remains untouched and cannot become this page's intent.
  await page.evaluate(({ original, tenant, plan }) => { sessionStorage.setItem(`wasalx.meta.transition-review:${"0".repeat(64)}:${tenant}:${plan}`, JSON.stringify({ scope: "0".repeat(64), tenantId: tenant, planId: plan, key: original.key, action: original.action, request: original.body })); }, { original, tenant, plan });
  await page.reload(); await x.open(false); await expect(x.dialog().getByText(text("held"), { exact: true })).toHaveCount(0); expect(h.writes).toHaveLength(2); expect(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith(`wasalx.meta.transition-review:${"0".repeat(64)}:`)))).toBe(true);
  await test.step("Check transition console", () => {
    observeOperatorCount("pendingExpectedConsole", h.expected.length);
    observeOperatorCount("matchedLostResponseConsole", h.lostResponse.consoleMatches);
    observeOperatorCount("unexpectedConsole", h.errors.length);
    expect(h.expected).toEqual([]);
    expect(h.errors).toEqual([]);
  });
});

test("operator authority loss removes loaded evidence and storage failure prevents approval dispatch", async ({ page }, info) => {
  admitted(); const x = await setup(page), h = x.h;
  await prepare(page, "PREREQUISITES");
  await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith("wasalx.meta.transition-review:")) throw new DOMException("Blocked", "QuotaExceededError"); return original.call(this, key, value); }; });
  await record(page); await expect(x.dialog().getByText(text("storage"), { exact: true })).toBeVisible(); expect(h.writes).toHaveLength(0);
  // Read-only refresh may restore visibility but never bypasses storage admission.
  await x.dialog().getByRole("button", { name: text("refresh"), exact: true }).click(); await expect(x.dialog().getByRole("button", { name: text("review"), exact: true })).toHaveCount(0);
  h.deny = true;
  await test.step("Check revoked transition authority", async () => {
    const options = x.dialog().getByRole("combobox", { name: text("plan"), exact: true }).locator("option");
    try {
      await x.dialog().getByRole("button", { name: text("refresh"), exact: true }).click();
      await expect(x.dialog().getByRole("heading", { name: "Transition account", exact: true })).toHaveCount(0);
      await expect(x.dialog().getByText("اتصال المبيعات (Sales)", { exact: true })).toHaveCount(0);
      await expect(page.getByText("PRIVATE_AUTHORITY_DETAIL")).toHaveCount(0);
      await expect(options).toHaveCount(1);
    } finally {
      observeOperatorCount("deniedReads", h.deniedReads);
      if (h.deniedReads) observeOperatorCount("authorityStatus", 403);
      const count = await options.count().catch(() => null);
      if (count !== null) observeOperatorCount("authorityPlanOptions", count);
    }
  });
  expect(h.writes).toHaveLength(0); await screenshot(page, info, "authority-loss"); expect(h.expected).toEqual([]); expect(h.errors).toEqual([]);
});

test("operator late review reads cannot cross a plan boundary; exact GET proof settles without replay", async ({ page }) => {
  admitted(); const x = await setup(page), h = x.h;
  let release = () => {}; h.gate.wait = new Promise<void>(resolve => { release = resolve; }); h.gate.entered = false;
  await x.dialog().getByRole("button", { name: text("refresh"), exact: true }).click(); await expect.poll(() => h.gate.entered).toBe(true);
  await test.step("Select alternate plan while review is held", async () => {
    await x.dialog().getByRole("combobox", { name: text("plan"), exact: true }).selectOption(other);
    await expect(x.dialog().getByRole("heading", { name: "Other plan", exact: true })).toBeVisible();
  });
  await test.step("Check controls after late review", async () => {
    const buttons = x.dialog().getByRole("button", { name: text("review"), exact: true });
    release();
    try {
      await expect(x.dialog().getByRole("heading", { name: "Transition account", exact: true })).toHaveCount(0);
      await expect(buttons).toBeDisabled();
    } finally {
      observeOperatorCount("transitionReads", h.reads.length);
      const count = await buttons.count().catch(() => null);
      if (count !== null) observeOperatorCount("lateReviewButtons", count);
    }
  });
  await x.dialog().getByRole("combobox", { name: text("plan"), exact: true }).selectOption(plan); await expect(x.dialog().getByRole("heading", { name: "Transition account", exact: true })).toBeVisible();
  h.write = async (route, write) => { h.current.pendingCommand = terminal(write); h.current.actions.PREREQUISITES = false; h.expected.push({ url: route.request().url(), status: 502 }); await route.fulfill({ status: 502, json: { error: "Private lost response" } }); };
  await prepare(page, "PREREQUISITES"); await record(page); await expect(x.dialog().getByText(text("result.APPLIED"), { exact: true })).toBeVisible(); await expect(x.dialog().getByText(text("held"), { exact: true })).toHaveCount(0);
  expect(h.writes).toHaveLength(1); expect(h.reads.some(value => value.endsWith(`?requestKey=${h.writes[0]!.key}`))).toBe(true); expect(h.expected).toEqual([]); expect(h.errors).toEqual([]);
});

test("pending plan-list reads exclude approval writes and removed reviews retain exact recoverable intent", async ({ page }, info) => {
  admitted(); const x = await setup(page), h = x.h;
  const refreshPlans = () => x.dialog().getByRole("button", { name: text("refreshList"), exact: true });
  const close = () => x.dialog().getByRole("button", { name: t("platform.actions.closeDialog"), exact: true });
  const choosePlan = () => x.dialog().getByRole("combobox", { name: text("plan"), exact: true });
  await prepare(page, "PREREQUISITES");
  const reviewApproval = () => x.dialog().getByRole("button", { name: text("review"), exact: true }); await expect(reviewApproval()).toBeEnabled();
  let releaseList = () => {}; h.listGate.wait = new Promise<void>(resolve => { releaseList = resolve; }); h.listGate.entered = false; h.listGate.omitSelected = true;
  await refreshPlans().click(); await expect.poll(() => h.listGate.entered).toBe(true);
  // Start the native list action before inline confirmation makes its siblings
  // inert. The loaded form stayed enabled on v1 during this independent GET.
  await expect(reviewApproval()).toBeDisabled();
  await expect(x.dialog().getByLabel(text("evidence"), { exact: true })).toBeDisabled();
  await expect(x.dialog().getByRole("button", { name: text("record"), exact: true })).toHaveCount(0); expect(h.writes).toHaveLength(0);
  releaseList(); await expect(x.dialog().getByRole("heading", { name: "Transition account", exact: true })).toHaveCount(0);
  await test.step("Check controls after pending plan removal", async () => {
    try {
      await expect(close()).toBeEnabled();
      await expect(refreshPlans()).toBeEnabled();
      await expect(choosePlan()).toBeEnabled();
      expect(h.writes).toHaveLength(0);
    } finally {
      observeOperatorCount("transitionReads", h.reads.length);
      observeOperatorCount("transitionWrites", h.writes.length);
      const count = await choosePlan().locator("option").count().catch(() => null);
      if (count !== null) observeOperatorCount("remainingPlanOptions", count);
    }
  });
  h.listGate.omitSelected = false; await refreshPlans().click(); await expect(choosePlan().locator(`option[value="${plan}"]`)).toHaveCount(1); await choosePlan().selectOption(plan);
  await expect(x.dialog().getByRole("heading", { name: "Transition account", exact: true })).toBeVisible(); await prepare(page, "PREREQUISITES");
  let releaseWrite = () => {}; const writePending = new Promise<void>(resolve => { releaseWrite = resolve; });
  h.write = async (route) => { await writePending; h.expected.push({ url: route.request().url(), status: 502 }); await route.fulfill({ status: 502, json: { error: "Private uncertain approval" } }); };
  await record(page); await expect.poll(() => h.writes.length).toBe(1); const original = structuredClone(h.writes[0]!);
  await expect(refreshPlans()).toBeDisabled(); await expect(choosePlan()).toBeDisabled(); await expect(close()).toBeDisabled();
  const retained = async () => page.evaluate(({ scope, tenant, plan }) => sessionStorage.getItem(`wasalx.meta.transition-review:${scope}:${tenant}:${plan}`), { scope: original.scope, tenant, plan });
  const raw = await retained(); expect(raw).not.toBeNull(); expect(JSON.parse(raw!).key).toBe(original.key); expect(JSON.parse(raw!).request).toEqual(original.body);
  releaseWrite(); await expect(refreshPlans()).toBeEnabled(); await expect(close()).toBeEnabled(); await expect(x.dialog().getByText(text("held"), { exact: true })).toBeVisible();
  h.listGate.omitSelected = true; await refreshPlans().click(); await expect(x.dialog().getByRole("heading", { name: "Transition account", exact: true })).toHaveCount(0);
  expect(await retained()).toBe(raw); expect(h.writes).toHaveLength(1); await expect(close()).toBeEnabled(); await expect(refreshPlans()).toBeEnabled();
  await close().click(); h.listGate.omitSelected = false; await x.open(false); await expect(x.dialog().getByText(text("held"), { exact: true })).toBeVisible();
  expect(h.writes).toHaveLength(1); expect(await retained()).toBe(raw);
  h.write = async (route, write) => { expect(write.path).toBe(original.path + "/resolve"); expect(write.key).toBe(original.key); expect(write.body).toEqual(original.body); h.current.pendingCommand = terminal(original, "NO_EFFECT"); await route.fulfill({ json: h.current.pendingCommand }); };
  await x.dialog().getByRole("button", { name: text("resolve"), exact: true }).click(); await expect(x.dialog().getByText(text("result.NO_EFFECT"), { exact: true })).toBeVisible();
  await expect(refreshPlans()).toBeEnabled(); await expect(close()).toBeEnabled(); expect(h.writes).toHaveLength(2); expect(await retained()).toBeNull();
  await screenshot(page, info, "list-write-recovery"); expect(h.expected).toEqual([]); expect(h.errors).toEqual([]);
});
