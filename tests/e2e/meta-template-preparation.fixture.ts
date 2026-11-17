import AxeBuilder from '@axe-core/playwright';
import { expect, type ConsoleMessage, type Page, type TestInfo } from '@playwright/test';
import type { MetaTemplatePreparationView, MetaTemplatePreparationRequest } from '../../packages/core/src/meta-template-preparation-contract';
import { englishTenantMessages } from '../../lib/i18n/messages/en/tenant';
import { arabicTenantMessages } from '../../lib/i18n/messages/ar/tenant';

const expectedDenials = new WeakMap<Page, { url: string; status: number }[]>();
export function consumeExpectedTemplateDenial(page: Page, message: ConsoleMessage) {
  if (!message.text().startsWith('Failed to load resource:')) return false;
  const list = expectedDenials.get(page), at = list?.findIndex(value => value.url === message.location().url && new RegExp(`\\b${value.status}\\b`).test(message.text())) ?? -1;
  if (at < 0) return false;
  list!.splice(at, 1); return true;
}

/** Mock HTTP browser behavior only; no actual Meta, installed stack or migration proof. */
export async function metaTemplatePreparationJourney(page: Page, locale: 'en' | 'ar', role: string, info: TestInfo) {
  await page.clock.install();
  const messages: Readonly<Record<string, string>> = locale === 'ar' ? arabicTenantMessages : englishTenantMessages;
  const t = (key: string) => messages[`tenant.metaTemplates.${key}`]!;
  const id = (n: number) => `65000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let source = id(1), base = `/api/connections/${source}/meta/template-preparations`;
  const target = id(8), eligible = id(6);
  const writable = ['tenant_owner', 'tenant_admin'].includes(role);
  let unknownCopy = false, cancelOutcome: 'LOST' | 'DRIFT' | 'APPLY' = 'LOST';
  let plan: MetaTemplatePreparationView | null = null, sequence = 20, prepareAdmission = false, forbidden = false, unsupported = false, delay = false;
  const currentPlan = (): MetaTemplatePreparationView => { if (!plan) throw new Error('Missing synthetic plan'); return plan; };
  const deferred: { release?: () => void } = {};
  const release = () => { deferred.release?.(); delete deferred.release; };
  const writes: { sourceId: string; suffix: string; key: string; body: Record<string, unknown> }[] = [];
  const originalCreates = new Map<string, { body: MetaTemplatePreparationRequest; plan: MetaTemplatePreparationView | null; operationId: string }>();
  const denials: { url: string; status: number }[] = []; expectedDenials.set(page, denials);
  const choices = () => [
    { id: eligible, name: 'order_update_طلب', language: 'ar', selectable: true, compatibility: 'MISSING' as const },
    { id: id(7), name: 'same_name', language: 'en_US', selectable: false, compatibility: 'DIFFERENT' as const },
    { id: id(9), name: 'unsupported_media', language: 'en_US', selectable: false, compatibility: 'UNSUPPORTED' as const },
  ];
  const observed = (key: string): MetaTemplatePreparationView => ({ id: id(++sequence), revision: 3, sourceConnection: { id: source, name: 'Source / المصدر' }, targetConnection: { id: target, name: 'Target (المستهدف)' },
    state: 'HELD', observationSha256: 'a'.repeat(64), observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
    choices: choices().map(choice => ({ ...choice, selectable: false })), reasons: ['INVENTORY_INCOMPLETE'], actions: { observe: writable, copy: false, reconcile: false, cancel: writable },
    originalCopy: null, canCutOver: false, pendingAction: { operationId: id(++sequence), requestKey: key, action: 'OBSERVE', requestRevision: 1, state: 'SUCCEEDED' } });
  if (!writable) { plan = observed(id(3)); plan.state = 'REVIEW'; plan.choices = choices(); plan.reasons = []; plan.actions = { observe: false, copy: false, reconcile: false, cancel: false }; }
  await page.route('**/api/connections/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/connections/${source}`) return route.fulfill({ json: { id: source, name: 'Source / المصدر', provider: 'META', state: 'PAUSED', provider_session_state: 'PAUSED', group_count: 0, latest_operation_type: 'PROVISION', latest_operation_state: 'SUCCEEDED' } });
    if (!url.pathname.startsWith(base)) return route.fallback();
    const suffix = url.pathname.slice(base.length), request = route.request();
    expect(request.headers()['x-wasalx-template-actor']).toBeTruthy(); expect(request.headers()['x-wasalx-template-workspace']).toBeTruthy();
    if (request.method() === 'GET') {
      const status = forbidden ? 403 : unsupported ? 501 : 200;
      if (status !== 200) { denials.push({ url: request.url(), status }); return route.fulfill({ status, json: { code: status === 403 ? 'META_TEMPLATE_CONTEXT_CHANGED' : 'META_TEMPLATE_UNAVAILABLE' } }); }
      const snapshot = structuredClone(suffix ? plan : { prepare: writable ? { accountRevision: 2, bindingRevision: 3, targets: [{ id: target, name: 'Target (المستهدف)' }] } : null, currentPlan: plan });
      if (delay) { delay = false; await new Promise<void>(resolve => { deferred.release = resolve; }); }
      return route.fulfill({ json: snapshot });
    }
    const key = request.headers()['idempotency-key']!, body = request.postDataJSON(); writes.push({ sourceId: source, suffix, key, body });
    expect(writable).toBe(true); expect(key).toMatch(/^[a-f0-9-]{36}$/iu);
    if (suffix === '') {
      expect(body).toEqual({ targetConnectionId: target, expectedAccountRevision: 2, expectedBindingRevision: 3 });
      expect(originalCreates.has(key), 'new CREATE must never replay its original key').toBe(false);
      if (prepareAdmission) plan = observed(key);
      originalCreates.set(key, { body, plan: plan && structuredClone(plan), operationId: plan?.pendingAction?.operationId ?? id(++sequence) });
      return route.fulfill({ contentType: 'application/json', body: '{' }); // Lose original response, not the local intent.
    }
    if (suffix === '/resolve') {
      const original = originalCreates.get(key)!; expect(original).toBeTruthy(); expect(body).toEqual(original.body);
      return route.fulfill({ json: { requestKey: key, request: original.body, operationId: original.operationId, duplicate: true,
        ...(original.plan ? { state: 'ADMITTED', id: original.plan.id, pendingAction: original.plan.pendingAction } : { state: 'NO_EFFECT', id: null, pendingAction: null }) } });
    }
    expect(plan).not.toBeNull(); expect(suffix.startsWith(`/${currentPlan().id}/`)).toBe(true);
    if (suffix.endsWith('/copy/resolve')) {
      const originals = writes.filter(write => write.sourceId === source && write.suffix === `/${currentPlan().id}/copy` && write.key === key);
      expect(originals).toHaveLength(1);
      const copy = originals[0]!;
      expect(copy.sourceId).toBe(id(11)); expect(key).toBe(copy.key); expect(body).toEqual(copy.body);
      expect(currentPlan().originalCopy?.outcome).toBe('UNKNOWN');
      expect(currentPlan().pendingAction?.action).toBe('COPY');
      return route.fulfill({ json: { id: currentPlan().id, operationId: currentPlan().pendingAction!.operationId, duplicate: true, pendingAction: currentPlan().pendingAction } });
    }
    if (suffix.endsWith('/reconcile/resolve')) {
      const originals = writes.filter(write => write.sourceId === source && write.suffix === `/${currentPlan().id}/reconcile` && write.key === key);
      expect(originals).toHaveLength(1); expect(body).toEqual(originals[0]!.body);
      expect(currentPlan().pendingAction?.requestKey).toBe(key); expect(currentPlan().pendingAction?.action).toBe('RECONCILE');
      expect(currentPlan().pendingAction?.requestRevision).toBe(body.expectedRevision);
      expect(currentPlan().pendingAction?.state).toBe('RUNNING');
      return route.fulfill({ json: { id: currentPlan().id, operationId: currentPlan().pendingAction!.operationId, duplicate: true, pendingAction: currentPlan().pendingAction } });
    }
    expect(body.expectedRevision).toBe(currentPlan().revision);
    if (suffix.endsWith('/reconcile')) {
      expect(body).toEqual({ expectedRevision: currentPlan().revision, expectedObservationSha256: currentPlan().observationSha256 });
      expect(currentPlan().originalCopy?.outcome).toBe('SUCCEEDED');
      const expected = currentPlan().revision;
      plan = { ...currentPlan(), revision: expected + 1, state: 'REVIEW', actions: { observe: false, copy: false, reconcile: false, cancel: false },
        pendingAction: { operationId: id(++sequence), requestKey: key, requestRevision: expected, action: 'RECONCILE', state: 'RUNNING' } };
      return route.fulfill({ json: { id: plan.id, operationId: plan.pendingAction!.operationId, duplicate: false, pendingAction: plan.pendingAction } });
    }
    if (suffix.endsWith('/observe')) {
      expect(body).toEqual({ expectedRevision: currentPlan().revision, expectedObservationSha256: currentPlan().observationSha256 });
      const expected = currentPlan().revision; plan = { ...currentPlan(), revision: expected + 2, state: 'REVIEW', observationSha256: 'b'.repeat(64), choices: choices(), reasons: [], actions: { observe: true, copy: true, reconcile: true, cancel: true },
        pendingAction: { operationId: id(++sequence), requestKey: key, requestRevision: expected, action: 'OBSERVE', state: 'SUCCEEDED' } };
      return route.fulfill({ json: { id: plan.id, operationId: plan.pendingAction!.operationId, duplicate: false, pendingAction: plan.pendingAction } });
    }
    if (suffix.endsWith('/cancel')) {
      expect(Object.keys(body)).toEqual(['expectedRevision']);
      if (cancelOutcome === 'LOST') { cancelOutcome = 'APPLY'; return route.fulfill({ contentType: 'application/json', body: '{' }); }
      if (cancelOutcome === 'DRIFT') { cancelOutcome = 'APPLY'; plan = { ...currentPlan(), revision: currentPlan().revision + 1 }; return route.fulfill({ contentType: 'application/json', body: '{' }); }
      const priorCancel = writes.find(write => write !== writes.at(-1) && write.suffix === suffix);
      if (priorCancel) { expect(key).toBe(priorCancel.key); expect(body).toEqual(priorCancel.body); }
      plan = { ...currentPlan(), revision: currentPlan().revision + 1, state: 'CANCELLED', actions: { observe: false, copy: false, reconcile: false, cancel: false } };
      return route.fulfill({ contentType: 'application/json', body: '{' });
    }
    if (suffix.endsWith('/copy')) {
      expect(body).toEqual({ expectedRevision: currentPlan().revision, expectedObservationSha256: 'b'.repeat(64), choices: [eligible] });
      const expected = currentPlan().revision;
      if (!unknownCopy) {
        plan = { ...currentPlan(), revision: expected + 2, state: 'REVIEW', reasons: [], choices: choices().map(choice => ({ ...choice, selectable: false, compatibility: 'EQUIVALENT' })),
          actions: { observe: true, copy: false, reconcile: true, cancel: true }, originalCopy: { outcome: 'SUCCEEDED', attemptedAt: new Date().toISOString() },
          pendingAction: { operationId: id(++sequence), requestKey: key, requestRevision: expected, action: 'COPY', state: 'SUCCEEDED' } };
        return route.fulfill({ json: { id: plan.id, operationId: plan.pendingAction!.operationId, duplicate: false, pendingAction: plan.pendingAction } });
      }
      plan = { ...currentPlan(), revision: expected + 1, state: 'OUTCOME_UNKNOWN', reasons: ['COPY_OUTCOME_UNRESOLVED'], actions: { observe: false, copy: false, reconcile: false, cancel: false },
        originalCopy: { outcome: 'UNKNOWN', attemptedAt: new Date().toISOString() },
        pendingAction: { operationId: id(++sequence), requestKey: key, requestRevision: expected, action: 'COPY', state: 'RUNNING' } };
      return route.fulfill({ contentType: 'application/json', body: '{' });
    }
    throw new Error('Unexpected template mutation');
  });
  const section = () => page.getByRole('region', { name: t('title'), exact: true });
  const button = (key: string) => section().getByRole('button', { name: t(key), exact: true });
  const open = async () => {
    await page.goto(`/app?view=connections&connection=${source}`);
    await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
    await button('open').click(); await expect(button('refresh')).toBeEnabled();
  };
  const capture = async (label: string, control: string) => {
    await section().getByRole('heading', { name: t('title'), exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${label}-top.png`) });
    await button(control).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`${label}-actions.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  };
  await open();
  if (!writable) {
    await expect(section().getByText(t('readOnly'), { exact: true })).toBeVisible();
    for (const key of ['observe', 'reconcile', 'reviewCopy', 'cancelPlan']) await expect(button(key)).toBeDisabled();
    expect(writes).toEqual([]); expect((await new AxeBuilder({ page }).include('.meta-template-preparation').analyze()).violations).toEqual([]);
    await capture('template-read-only', 'refresh'); return;
  }
  const choose = () => section().getByLabel(t('target'), { exact: true });
  await expect(choose()).toHaveValue(''); await expect(button('prepare')).toBeDisabled();
  // Storage failure stops dispatch before an uncertain original request can be lost.
  await choose().selectOption(target);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('synthetic quota'); }; });
  await button('prepare').click(); await expect(section().getByText(t('error.storage'), { exact: true })).toBeVisible(); expect(writes).toEqual([]);
  await open(); await choose().selectOption(target);
  await button('prepare').focus(); await page.keyboard.press('Enter');
  await expect(button('resolve')).toBeEnabled(); expect(writes.filter(write => write.suffix === '')).toHaveLength(1);
  await button('resolve').click(); await expect(section().getByText(t('notice.noEffect'), { exact: true })).toBeVisible();
  // A new deliberate preparation follows a proven no-effect tombstone, with a new key.
  prepareAdmission = true; await choose().selectOption(target); await button('prepare').click();
  await expect(button('resolve')).toBeEnabled(); await page.reload(); await button('open').click();
  await expect(button('resolve')).toBeEnabled(); await button('resolve').click(); await expect(button('observe')).toBeEnabled();
  await expect(section().getByText(t('reason.INVENTORY_INCOMPLETE'), { exact: true })).toBeVisible(); await expect(button('reviewCopy')).toBeDisabled();
  expect(new Set(writes.filter(write => write.suffix === '').map(write => write.key)).size).toBe(2);
  await button('observe').click(); await expect(section().getByRole('checkbox', { name: /order_update/u })).toBeEnabled();
  for (const label of ['same_name', 'unsupported_media']) await expect(section().getByRole('checkbox', { name: new RegExp(label) })).toBeDisabled();
  // The shared expiry hook must cancel an old deadline, then expire the live
  // confirmation without a refresh or another mutation. This remains HTTP-mocked.
  const clockNow = await page.evaluate(() => Date.now());
  plan = { ...currentPlan(), expiresAt: new Date(clockNow + 5_000).toISOString() };
  await button('refresh').click(); await expect(section().getByRole('checkbox', { name: /order_update/u })).toBeEnabled();
  plan = { ...currentPlan(), expiresAt: new Date(clockNow + 15_000).toISOString() };
  await button('refresh').click();
  const expiringChoice = section().getByRole('checkbox', { name: /order_update/u });
  await expiringChoice.check(); await expect(expiringChoice).toHaveAccessibleName(/order_update_طلب.*ar/u);
  await button('reviewCopy').click(); await expect(button('confirmCopy')).toBeEnabled();
  await page.clock.runFor(5_100); await expect(button('confirmCopy')).toBeEnabled();
  await page.clock.runFor(10_000); await expect(button('confirmCopy')).toBeDisabled();
  expect(writes.filter(write => write.suffix.endsWith('/copy'))).toHaveLength(0);
  await button('back').click();
  plan = { ...currentPlan(), expiresAt: new Date((await page.evaluate(() => Date.now())) + 600_000).toISOString() };
  await button('refresh').click(); await expect(expiringChoice).toBeEnabled();
  // Provider-free cancellation is reconciled from exact same-plan revision+1.
  await button('cancelPlan').click(); await expect(button('finishCancel')).toBeEnabled();
  await button('finishCancel').click(); await expect(section().getByText(t('state.CANCELLED'), { exact: true })).toBeVisible();
  await choose().selectOption(target); await button('prepare').click(); await expect(button('resolve')).toBeEnabled(); await button('resolve').click();
  await expect(button('observe')).toBeEnabled();
  cancelOutcome = 'DRIFT'; await button('cancelPlan').click();
  await expect(section().getByText(t('notice.superseded'), { exact: true })).toBeVisible(); await expect(button('finishCancel')).toHaveCount(0);
  await button('observe').click();
  const check = section().getByRole('checkbox', { name: /order_update/u });
  await expect(check).toBeEnabled(); await check.focus(); await expect(check).toBeFocused();
  await page.keyboard.press('Space'); await expect(check).toBeChecked();
  const bounds = await check.boundingBox(); expect(bounds!.width).toBeGreaterThanOrEqual(16); expect(bounds!.width).toBeLessThanOrEqual(24);
  expect((await new AxeBuilder({ page }).include('.meta-template-preparation').analyze()).violations).toEqual([]);
  await capture('template-comparison', 'reviewCopy');
  await button('reviewCopy').click(); await expect(page.getByRole('alertdialog')).toBeVisible(); await expect(button('back')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('alertdialog')).toHaveCount(0); await expect(button('reviewCopy')).toBeFocused();
  await button('reviewCopy').click(); await button('confirmCopy').evaluate(button => { if (!(button instanceof HTMLButtonElement)) throw new Error('Expected native button'); button.click(); button.click(); });
  await expect(section().getByText(t('copyOutcome.SUCCEEDED'), { exact: true })).toBeVisible();
  await expect(section().getByText(t('state.REVIEW'), { exact: true })).toBeVisible();
  await expect(button('reviewCopy')).toBeDisabled(); await expect(button('resolve')).toHaveCount(0);
  expect(writes.filter(write => write.suffix.endsWith('/copy'))).toHaveLength(1);
  const completedCopy = structuredClone(currentPlan().originalCopy);
  // Readiness is a separate deliberate provider-read operation. It does not
  // alter the completed copy or grant a phone-transfer capability.
  await button('reconcile').click(); await expect(button('resolve')).toBeEnabled();
  const runningReconciliation = structuredClone(currentPlan());
  const originalReconciliation = runningReconciliation.pendingAction!;
  expect(originalReconciliation.state).toBe('RUNNING');
  await page.reload(); await button('open').click(); await expect(button('resolve')).toBeEnabled();
  // Inject stale, otherwise well-shaped terminal projections. Neither READY
  // nor a terminal result for another key/action/revision settles this intent.
  for (const mismatch of [{ requestKey: id(900) }, { action: 'OBSERVE' as const }, { requestRevision: originalReconciliation.requestRevision + 1 }]) {
    plan = { ...runningReconciliation, state: 'READY', pendingAction: { ...originalReconciliation, state: 'SUCCEEDED', ...mismatch } };
    await button('refresh').click(); await expect(button('resolve')).toBeEnabled();
    expect(currentPlan().originalCopy).toEqual(completedCopy); expect(currentPlan().canCutOver).toBe(false);
    expect(writes.filter(write => write.suffix.endsWith('/copy'))).toHaveLength(1);
  }
  plan = structuredClone(runningReconciliation);
  await button('refresh').click(); await expect(button('resolve')).toBeEnabled();
  await button('resolve').click(); await expect(button('resolve')).toBeEnabled();
  expect(writes.filter(write => write.suffix.endsWith('/reconcile'))).toHaveLength(1);
  expect(writes.filter(write => write.suffix.endsWith('/reconcile/resolve'))).toHaveLength(1);
  // Only the original operation's exact terminal readback settles the local
  // request; the original copy bytes remain identical throughout.
  plan = { ...runningReconciliation, revision: runningReconciliation.revision + 1, state: 'READY',
    actions: { observe: true, copy: false, reconcile: true, cancel: true }, pendingAction: { ...originalReconciliation, state: 'SUCCEEDED' } };
  await button('refresh').click(); await expect(button('resolve')).toHaveCount(0);
  await expect(section().getByText(t('state.READY'), { exact: true })).toBeVisible();
  await expect(section().getByText(t('copyOutcome.SUCCEEDED'), { exact: true })).toBeVisible();
  expect(currentPlan().originalCopy).toEqual(completedCopy); expect(currentPlan().canCutOver).toBe(false);
  expect(writes.filter(write => write.suffix.endsWith('/copy'))).toHaveLength(1);
  await capture('template-completed', 'refresh');
  // The unresolved-copy case has a distinct fixture source/plan. Never rewrite a
  // prior original outcome to invent recovery of the successful case above.
  source = id(11); base = `/api/connections/${source}/meta/template-preparations`; plan = null; unknownCopy = true;
  await open(); await choose().selectOption(target); await button('prepare').click();
  await expect(button('resolve')).toBeEnabled(); await button('resolve').click(); await expect(button('observe')).toBeEnabled();
  await button('observe').click(); await expect(check).toBeEnabled(); await check.check();
  await button('reviewCopy').click(); await button('confirmCopy').click();
  await expect(section().getByText(t('copyOutcome.UNKNOWN'), { exact: true })).toBeVisible();
  expect(writes.filter(write => write.suffix.endsWith('/copy'))).toHaveLength(2);
  await page.reload(); await button('open').click(); await expect(button('resolve')).toBeEnabled();
  // Equal target contents do not repair the durable unknown original copy.
  plan = { ...currentPlan(), state: 'HELD', choices: choices().map(choice => ({ ...choice, selectable: false, compatibility: 'EQUIVALENT' })), reasons: ['SIGNED_TEMPLATE_CHANGE', 'COPY_OUTCOME_UNRESOLVED'] };
  await button('refresh').click(); await expect(section().getByText(t('reason.SIGNED_TEMPLATE_CHANGE'), { exact: true })).toBeVisible();
  await expect(button('reviewCopy')).toBeDisabled(); await expect(button('cancelPlan')).toBeDisabled();
  const unknownOriginal = structuredClone(currentPlan().originalCopy);
  await button('resolve').click(); await expect(button('resolve')).toBeEnabled();
  const copies = writes.filter(write => write.suffix.endsWith('/copy'));
  expect(copies).toHaveLength(2); expect(copies[0]!.sourceId).toBe(id(1)); expect(copies[1]!.sourceId).toBe(id(11));
  const resolvedUnknown = writes.find(write => write.suffix.endsWith('/copy/resolve'))!;
  expect(resolvedUnknown.key).toBe(copies[1]!.key); expect(resolvedUnknown.key).not.toBe(copies[0]!.key);
  expect(resolvedUnknown.body).toEqual(copies[1]!.body);
  expect(currentPlan().originalCopy).toEqual(unknownOriginal); expect(currentPlan().originalCopy?.outcome).toBe('UNKNOWN');
  expect(completedCopy?.outcome).toBe('SUCCEEDED'); expect(currentPlan().canCutOver).toBe(false);
  expect(writes.filter(write => write.suffix.endsWith('/copy'))).toHaveLength(2);
  await capture('template-unknown-retained', 'resolve');
  // A newer authority denial invalidates an older in-flight snapshot.
  delay = true; await button('refresh').click(); await expect.poll(() => Boolean(deferred.release)).toBe(true);
  forbidden = true; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(section().getByText(t('error.permission'), { exact: true })).toBeVisible();
  release(); await expect(section().getByText('order_update_طلب', { exact: true })).toHaveCount(0);
  await expect(button('resolve')).toBeDisabled();
  forbidden = false; unsupported = true; await button('refresh').click(); await expect(section().getByText(t('error.unsupported'), { exact: true })).toBeVisible();
  expect(writes.filter(write => write.suffix.endsWith('/copy'))).toHaveLength(2);
  expect(writes.every(write => !/register|deregister|migrate|transfer/u.test(write.suffix))).toBe(true);
  expect(denials).toEqual([]);
}
