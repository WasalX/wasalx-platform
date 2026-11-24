import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { englishPlatformMessages } from "../../lib/i18n/messages/en/platform.ts";
import { arabicPlatformMessages } from "../../lib/i18n/messages/ar/platform.ts";
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
test.use({ storageState: state ?? { cookies: [], origins: [] } });
const id = (n: number) => `64000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const plan = id(2), other = id(8), root = () => `/api/platform-console/operations/tenants/${tenant}/meta/account-transitions`;
function review(): MetaTransitionOperatorReview { return { id: plan, tenantId: tenant, name: "Transition account", revision: 3, requestedMode: "CUSTOMER", sourceCurrency: "USD", targetCurrency: "SAR", phase: "RESERVED", evidenceMode: "SIMULATED", reviewSha256: "a".repeat(64), connectionNames: ["اتصال المبيعات (Sales)"], connectionCount: 1, providerStatus: null, checkpoints: [], proof: { sourceScope: "CURRENT", targetAccess: "NONE", payment: "VERIFIED", renewedObserver: "ABSENT", prerequisiteApproval: "MISSING", targetReview: "MISSING" }, actions: { PREREQUISITES: true, TARGET: false, COMPLETION: false }, reasons: [], arrangements: [], originalGrant: null, pendingCommand: null }; }
type Write = { path: string; key: string; scope: string; action: MetaTransitionOperatorAction; body: MetaTransitionOperatorRequest };
function terminal(write: Write, disposition: "APPLIED" | "NO_EFFECT" = "APPLIED"): MetaTransitionOperatorResult { return { tenantId: tenant, planId: write.path.split("/account-transitions/")[1]!.split("/")[0]!, requestKey: write.key, action: write.action, request: structuredClone(write.body), state: disposition, commandReceiptId: id(10), approvalReceiptId: disposition === "APPLIED" ? id(11) : null, duplicate: false }; }
function admitted() { test.skip(!ready, "Requires root-supplied authenticated platform session and reused control-plane server"); }
async function setup(page: Page) {
  const errors: string[] = [], expected: Array<{ url: string; status: number }> = [], writes: Write[] = [], reads: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() !== "error") return; const index = expected.findIndex(item => item.url === message.location().url && message.text().includes(String(item.status))); if (index >= 0) expected.splice(index, 1); else errors.push(message.text()); });
  const gate: { wait: Promise<void> | null; entered: boolean } = { wait: null, entered: false };
  const listGate: { wait: Promise<void> | null; entered: boolean; omitSelected: boolean } = { wait: null, entered: false, omitSelected: false };
  const h = { current: review(), gate, listGate, writes, reads, errors, expected, deny: false, write: async (route: Route, value: Write) => { h.current.pendingCommand = terminal(value); h.current.actions[value.action] = false; h.current.revision++; h.current.reviewSha256 = "d".repeat(64); await route.fulfill({ json: h.current.pendingCommand }); } };
  await page.route(`**${root()}**`, async route => {
    const request = route.request(), target = new URL(request.url());
    expect(request.headers()["x-wasalx-platform-recovery-scope"]).toMatch(/^[a-f0-9]{64}$/u);
    if (request.method() === "GET") {
      reads.push(target.pathname + target.search);
      if (h.deny) { expected.push({ url: request.url(), status: 403 }); return route.fulfill({ status: 403, json: { error: "PRIVATE_AUTHORITY_DETAIL" } }); }
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
  await page.context().addCookies([{ name: "wasalx_locale", value: locale, url: new URL(url!).origin }]);
  const dialog = () => page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: text("title"), exact: true }) });
  const open = async (navigate = true) => { if (navigate) await page.goto(url!); const row = page.getByRole("row").filter({ has: page.getByText(tenantName, { exact: true }) }); await expect(row).toHaveCount(1); await row.getByRole("button", { name: text("open"), exact: true }).click(); await dialog().getByLabel(text("plan"), { exact: true }).selectOption(h.current.id); await expect(dialog().getByRole("heading", { name: h.current.name, exact: true })).toBeVisible(); };
  await open(); return { ...h, h, dialog, open };
}
async function prepare(page: Page, action: MetaTransitionOperatorAction) {
  const dialog = page.getByRole("dialog"); await dialog.getByLabel(text("reviewKind"), { exact: true }).selectOption(action);
  await dialog.getByLabel(text("evidence"), { exact: true }).fill("b".repeat(64));
  if (action === "PREREQUISITES") { const payment = dialog.getByLabel(text("sourcePayment"), { exact: true }); if (await payment.isEnabled()) await payment.selectOption("CARD"); }
  if (action === "TARGET") { await dialog.getByLabel(text("templates"), { exact: true }).fill("c".repeat(64)); await dialog.getByLabel(text("flows"), { exact: true }).fill("e".repeat(64)); }
  const checked = dialog.getByLabel(text("confirmEvidence"), { exact: true }); await checked.focus(); await page.keyboard.press("Space");
}
async function record(page: Page) { const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: text("review"), exact: true }).click(); const button = dialog.getByRole("button", { name: text("record"), exact: true }); await button.focus(); await page.keyboard.press("Enter"); }
async function screenshot(page: Page, info: TestInfo, label: string) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await info.attach(`transition-${label}-${locale}-${info.project.name}`, { body: await page.screenshot(), contentType: "image/png" }); }

test("operator records three explicit local reviews and independently selected managed target terms", async ({ page }, info) => {
  admitted(); const x = await setup(page), h = x.h;
  await prepare(page, "PREREQUISITES"); expect(h.writes).toHaveLength(0); await record(page); await expect(x.dialog().getByText(text("result.APPLIED"), { exact: true })).toBeVisible();
  await expect(x.dialog().getByLabel(text("reviewKind"), { exact: true }).locator('option[value="PREREQUISITES"]')).toHaveCount(0);
  expect(h.writes[0]!.body).toEqual({ expectedRevision: 3, expectedReviewSha256: "a".repeat(64), evidenceSha256: "b".repeat(64), confirmed: true, sourcePayment: "CARD" });
  for (const action of ["TARGET", "COMPLETION"] as const) {
    h.current.actions[action] = true; h.current.proof.targetAccess = "CLONE"; h.current.proof.renewedObserver = "CURRENT"; h.current.proof.prerequisiteApproval = "CURRENT"; if (action === "COMPLETION") h.current.proof.targetReview = "CURRENT";
    await x.dialog().getByRole("button", { name: text("refresh"), exact: true }).click(); await prepare(page, action); await record(page); await expect.poll(() => h.writes.length).toBe(action === "TARGET" ? 2 : 3); await expect(x.dialog().getByLabel(text("reviewKind"), { exact: true }).locator(`option[value="${action}"]`)).toHaveCount(0);
  }
  expect(h.writes[1]!.body.templateEvidenceSha256).toBe("c".repeat(64)); expect(h.writes[1]!.body.flowEvidenceSha256).toBe("e".repeat(64)); expect(Object.keys(h.writes[2]!.body).sort()).toEqual(["confirmed", "evidenceSha256", "expectedReviewSha256", "expectedRevision"]);
  // A distinct server-supplied managed plan is seeded for the separate grant form.
  await x.dialog().getByRole("button", { name: t("platform.actions.closeDialog"), exact: true }).click();
  h.current = { ...review(), id: id(30), name: "Managed transition", revision: 10, requestedMode: "WASALX_MANAGED", arrangements: [{ id: id(20), label: "Approved arrangement", expiresAt: "2099-01-01T00:00:00Z" }] };
  await x.open(false); await prepare(page, "PREREQUISITES");
  await x.dialog().getByLabel(text("arrangement"), { exact: true }).selectOption(id(20)); await x.dialog().getByLabel(text("receiver"), { exact: true }).fill("9"); await x.dialog().getByLabel(text("termsVersion"), { exact: true }).fill("2026.10"); await x.dialog().getByLabel(text("terms"), { exact: true }).fill("Approved target terms / الشروط المعتمدة");
  await x.dialog().getByRole("button", { name: text("review"), exact: true }).click(); await expect(x.dialog().getByRole("button", { name: text("record"), exact: true })).toHaveCount(0); expect(h.writes).toHaveLength(3);
  await x.dialog().getByLabel(text("acceptTerms"), { exact: true }).check(); await screenshot(page, info, "managed-form");
  for (const checkbox of await x.dialog().getByRole("checkbox").all()) { const box = await checkbox.boundingBox(); expect(box).not.toBeNull(); expect(box!.width).toBeLessThan(30); expect(box!.height).toBeLessThan(30); }
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]); await record(page); await expect.poll(() => h.writes.length).toBe(4); await expect(x.dialog().getByLabel(text("reviewKind"), { exact: true }).locator('option[value="PREREQUISITES"]')).toHaveCount(0);
  expect(h.writes[3]!.body.managed).toEqual({ arrangementVersionId: id(20), targetReceivingBusinessId: "9", targetTermsDocumentText: "Approved target terms / الشروط المعتمدة", targetTermsVersion: "2026.10" });
  h.current.originalGrant = { sourcePayment: "CARD", managed: h.writes[3]!.body.managed! }; h.current.actions.PREREQUISITES = true; h.current.revision++;
  await x.dialog().getByRole("button", { name: text("refresh"), exact: true }).click(); await prepare(page, "PREREQUISITES"); await expect(x.dialog().getByLabel(text("sourcePayment"), { exact: true })).toBeDisabled(); await expect(x.dialog().getByLabel(text("arrangement"), { exact: true })).toBeDisabled(); await expect(x.dialog().getByLabel(text("receiver"), { exact: true })).toHaveAttribute("readonly", "");
  const savedTerms = x.dialog().getByRole("textbox", { name: text("terms"), exact: true });
  await expect(savedTerms).toHaveAttribute("readonly", "");
  await expect(savedTerms).toHaveValue("Approved target terms / الشروط المعتمدة");
  expect(new Set(h.writes.map(write => write.key)).size).toBe(4); expect(h.expected).toEqual([]); expect(h.errors).toEqual([]);
});

test("operator lost-response recovery keeps exact intent through reload, mismatched proof and deliberate resolution", async ({ page }, info) => {
  admitted(); const x = await setup(page), h = x.h;
  h.write = async (route, write) => { h.current.revision++; h.current.reviewSha256 = "f".repeat(64); h.current.pendingCommand = { ...terminal(write), requestKey: id(99) }; h.expected.push({ url: route.request().url(), status: 502 }); await route.fulfill({ status: 502, json: { error: "PRIVATE_TRANSPORT_DETAIL" } }); };
  await prepare(page, "PREREQUISITES"); await record(page); await expect(x.dialog().getByText(text("held"), { exact: true })).toBeVisible(); expect(h.writes).toHaveLength(1); const original = structuredClone(h.writes[0]!);
  await expect(page.getByText("PRIVATE_TRANSPORT_DETAIL")).toHaveCount(0); await page.reload(); await x.open(false); await expect(x.dialog().getByText(text("held"), { exact: true })).toBeVisible();
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
  expect(h.expected).toEqual([]); expect(h.errors).toEqual([]);
});

test("operator authority loss removes loaded evidence and storage failure prevents approval dispatch", async ({ page }, info) => {
  admitted(); const x = await setup(page), h = x.h;
  await prepare(page, "PREREQUISITES");
  await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith("wasalx.meta.transition-review:")) throw new DOMException("Blocked", "QuotaExceededError"); return original.call(this, key, value); }; });
  await record(page); await expect(x.dialog().getByText(text("storage"), { exact: true })).toBeVisible(); expect(h.writes).toHaveLength(0);
  // Read-only refresh may restore visibility but never bypasses storage admission.
  await x.dialog().getByRole("button", { name: text("refresh"), exact: true }).click(); await expect(x.dialog().getByRole("button", { name: text("review"), exact: true })).toHaveCount(0);
  h.deny = true; await x.dialog().getByRole("button", { name: text("refresh"), exact: true }).click(); await expect(x.dialog().getByRole("heading", { name: "Transition account", exact: true })).toHaveCount(0); await expect(x.dialog().getByText("اتصال المبيعات (Sales)", { exact: true })).toHaveCount(0); await expect(page.getByText("PRIVATE_AUTHORITY_DETAIL")).toHaveCount(0); await expect(x.dialog().getByLabel(text("plan"), { exact: true }).locator("option")).toHaveCount(1);
  expect(h.writes).toHaveLength(0); await screenshot(page, info, "authority-loss"); expect(h.expected).toEqual([]); expect(h.errors).toEqual([]);
});

test("operator late review reads cannot cross a plan boundary; exact GET proof settles without replay", async ({ page }) => {
  admitted(); const x = await setup(page), h = x.h;
  let release = () => {}; h.gate.wait = new Promise<void>(resolve => { release = resolve; }); h.gate.entered = false;
  await x.dialog().getByRole("button", { name: text("refresh"), exact: true }).click(); await expect.poll(() => h.gate.entered).toBe(true);
  await x.dialog().getByLabel(text("plan"), { exact: true }).selectOption(other); await expect(x.dialog().getByRole("heading", { name: "Other plan", exact: true })).toBeVisible();
  release(); await expect(x.dialog().getByRole("heading", { name: "Transition account", exact: true })).toHaveCount(0); await expect(x.dialog().getByRole("button", { name: text("review"), exact: true })).toBeDisabled();
  await x.dialog().getByLabel(text("plan"), { exact: true }).selectOption(plan); await expect(x.dialog().getByRole("heading", { name: "Transition account", exact: true })).toBeVisible();
  h.write = async (route, write) => { h.current.pendingCommand = terminal(write); h.current.actions.PREREQUISITES = false; h.expected.push({ url: route.request().url(), status: 502 }); await route.fulfill({ status: 502, json: { error: "Private lost response" } }); };
  await prepare(page, "PREREQUISITES"); await record(page); await expect(x.dialog().getByText(text("result.APPLIED"), { exact: true })).toBeVisible(); await expect(x.dialog().getByText(text("held"), { exact: true })).toHaveCount(0);
  expect(h.writes).toHaveLength(1); expect(h.reads.some(value => value.endsWith(`?requestKey=${h.writes[0]!.key}`))).toBe(true); expect(h.expected).toEqual([]); expect(h.errors).toEqual([]);
});

test("pending plan-list reads exclude approval writes and removed reviews retain exact recoverable intent", async ({ page }, info) => {
  admitted(); const x = await setup(page), h = x.h;
  const refreshPlans = () => x.dialog().getByRole("button", { name: text("refreshList"), exact: true });
  const close = () => x.dialog().getByRole("button", { name: t("platform.actions.closeDialog"), exact: true });
  const choosePlan = () => x.dialog().getByLabel(text("plan"), { exact: true });
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
  await expect(close()).toBeEnabled(); await expect(refreshPlans()).toBeEnabled(); await expect(choosePlan()).toBeEnabled(); expect(h.writes).toHaveLength(0);
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
