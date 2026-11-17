import AxeBuilder from '@axe-core/playwright';
import { expect, type ConsoleMessage, type Page, type TestInfo } from '@playwright/test';
import type { MetaLegacyMigrationView } from '../../packages/core/src/meta-legacy-migration-contract';
import type { MetaSignupAttemptView } from '../../lib/meta-signup-contract';
import { englishTenantMessages } from '../../lib/i18n/messages/en/tenant';
import { arabicTenantMessages } from '../../lib/i18n/messages/ar/tenant';
const expected = new WeakMap<Page, { url: string; status: number }[]>();
export function consumeExpectedLegacyDenial(page: Page, message: ConsoleMessage) {
  if (!message.text().startsWith('Failed to load resource:')) return false;
  const entries = expected.get(page), at = entries?.findIndex(item => item.url === message.location().url && new RegExp(`\\b${item.status}\\b`).test(message.text())) ?? -1;
  if (at < 0) return false; entries!.splice(at, 1); return true;
}
/** Mock HTTP/SDK browser proof only. Never installed, live, financial or cutover proof. */
export async function metaLegacyMigrationJourney(page: Page, locale: 'en' | 'ar', role: string, info: TestInfo) {
  const messages: Readonly<Record<string, string>> = locale === 'ar' ? arabicTenantMessages : englishTenantMessages;
  const t = (key: string) => messages[`tenant.metaLegacy.${key}`]!, signup = (key: string) => messages[`tenant.metaSignup.${key}`]!;
  const id = (n: number) => `66000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const writable = ['tenant_owner', 'tenant_admin'].includes(role), denials: { url: string; status: number }[] = [];
  expected.set(page, denials);
  let storageKey = '';
  let source = id(1), sequence = 20, admission = false, cancelMode: 'ABSENT' | 'APPLY' | 'DRIFT' = 'ABSENT', unavailable = false, deny = false, unknown = false, delay = false;
  const deferred: { release?: () => void } = {}; const release = () => { deferred.release?.(); delete deferred.release; };
  const creates = new Map<string, { request: unknown; id: string | null; operationId: string }>();
  const writes: { source: string; suffix: string; key: string | undefined; body: Record<string, unknown> }[] = [], signupWrites: { path: string; body: Record<string, unknown> }[] = [];
  const prepare = { templateObservationOperationId: id(8), sourceBindingRevision: 2, targetBindingRevision: 3 };
  const sdk = { appId: '12345678', configId: '87654321', graphVersion: 'v24.0' };
  let attempt: MetaSignupAttemptView | null = null;
  const initial = (): MetaLegacyMigrationView => ({ id: id(++sequence), revision: 1, sourceConnection: { id: source, name: 'Source / المصدر' }, destinationAccount: { label: 'Destination (الوجهة)', paymentResponsibility: 'CUSTOMER' }, state: 'PREREQUISITE_REQUIRED', reviewSha256: 'a'.repeat(64), expiresAt: new Date(Date.now() + 600000).toISOString(), reasons: ['LEGACY_PROVIDER_CONTRACT_UNAVAILABLE'], capability: { live: false, qualificationOnly: false }, impact: { sourceConnections: 2, destinationConnections: 1, inheritedFlowVersions: 2, templates: 3, keepsOriginalHistory: true, result: 'PAUSED' }, authorization: null, actions: { observe: false, register: false, reconcile: false, cancel: writable }, originalRegistration: null, pendingAction: null });
  let view: MetaLegacyMigrationView | null = initial();
  const current = () => { if (!view) throw new Error('Missing synthetic migration'); return view; };
  const actionResult = () => ({ id: current().id, operationId: current().pendingAction!.operationId, pendingAction: current().pendingAction, duplicate: true });
  await page.route('https://connect.facebook.net/en_US/sdk.js', route => route.fulfill({ contentType: 'text/javascript', body: 'window.legacyCallbacks=[];window.FB={init(){},login(callback){window.legacyCallbacks.push(callback);}};' }));
  await page.route('**/api/connections/**', async route => {
    const request = route.request(), url = new URL(request.url()), base = `/api/connections/${source}/meta/legacy-migrations`;
    if (url.pathname === `/api/connections/${source}`) return route.fulfill({ json: { id: source, name: 'Source / المصدر', provider: 'META', state: 'PAUSED', provider_session_state: 'PAUSED', group_count: 0, latest_operation_type: 'PROVISION', latest_operation_state: 'SUCCEEDED' } });
    if (url.pathname.includes('/meta/signup/')) {
      const path = url.pathname.split('/signup/')[1]!;
      if (request.method() === 'GET') {
        if (path === 'capabilities') return route.fulfill({ json: { enabled: true, payerModes: ['CUSTOMER'], sdk } });
        if (path === 'attempts') expect(Object.fromEntries(url.searchParams)).toEqual({ targetConnectionId: source, targetLegacyMigrationId: current().id });
        return route.fulfill({ json: path === 'attempts' ? { attempt } : attempt });
      }
      const body = request.postDataJSON(); signupWrites.push({ path, body });
      if (path === 'attempts') {
        expect(body).toEqual({ name: t('authorization.name'), payerMode: 'CUSTOMER', idempotencyKey: expect.any(String), targetConnectionId: source, targetLegacyMigrationId: current().id });
        attempt = { purpose: 'LEGACY_MIGRATION', target: { connectionId: source, name: 'Source / المصدر', state: 'WORKING' }, targetLegacyMigrationId: current().id, attemptId: id(++sequence), revision: 1, expiresAt: new Date(Date.now() + 600000).toISOString(), status: 'AWAITING_AUTHORIZATION', nextAction: 'AUTHORIZE', canCancel: true, canStartAgain: false, choices: [], readiness: { authorization: 'PENDING', number: 'UNKNOWN', subscription: 'UNKNOWN', messaging: 'UNKNOWN', payment: { requestedPayer: 'CUSTOMER', status: 'UNKNOWN', paymentMethodVerified: false } } };
        return route.fulfill({ json: { ...attempt, sdk, challenge: 'L'.repeat(43) } });
      }
      expect(attempt).not.toBeNull();
      if (path.endsWith('/exchange')) { attempt = { ...attempt!, revision: 2, status: 'SELECTION_REQUIRED', nextAction: 'SELECT_NUMBER', selectionRevision: 1, choices: [{ choiceId: id(6), accountName: 'Exact destination', businessName: 'Portfolio', displayPhoneNumber: '12025550143', mode: 'STANDARD', numberState: 'UNKNOWN', selectable: true }, { choiceId: id(7), accountName: 'Other account', businessName: 'Portfolio', displayPhoneNumber: '12025550144', mode: 'STANDARD', numberState: 'REGISTERED', selectable: false }] }; }
      else if (path.endsWith('/select')) { expect(body).toEqual({ expectedRevision: 2, selectionRevision: 1, choiceId: id(6) }); attempt = { ...attempt!, revision: 3, status: 'COMPLETED', nextAction: 'DONE', outcome: 'MIGRATION_ACCESS_VERIFIED', connectionId: source, canCancel: false, choices: [] }; view = { ...current(), revision: current().revision + 1, state: 'REVIEW', actions: { ...current().actions, observe: true } }; }
      else if (path.endsWith('/cancel')) attempt = { ...attempt!, status: 'CANCELLED', canCancel: false, canStartAgain: true, nextAction: 'START_AGAIN' };
      else throw new Error('Unexpected signup mutation');
      return route.fulfill({ json: attempt });
    }
    if (!url.pathname.startsWith(base)) return route.fallback();
    const suffix = url.pathname.slice(base.length);
    expect(request.headers()['x-wasalx-legacy-actor']).toBeTruthy(); expect(request.headers()['x-wasalx-legacy-workspace']).toBeTruthy();
    storageKey = `wasalx:meta-legacy:v1:${encodeURIComponent(decodeURIComponent(request.headers()['x-wasalx-legacy-workspace']!))}:${encodeURIComponent(decodeURIComponent(request.headers()['x-wasalx-legacy-actor']!))}:${source}`;
    if (request.method() === 'GET') {
      if (deny || unavailable) { const status = deny ? 403 : 501; denials.push({ url: request.url(), status }); return route.fulfill({ status, json: { code: 'CURRENT_PERMISSION_REQUIRED' } }); }
      const snapshot = structuredClone(suffix ? view : { prepare: writable ? prepare : null, currentPlan: view });
      if (delay) { delay = false; await new Promise<void>(resolve => { deferred.release = resolve; }); }
      return route.fulfill({ json: snapshot });
    }
    const key = request.headers()['idempotency-key'], body = request.postDataJSON(); writes.push({ source, suffix, key, body }); expect(writable).toBe(true);
    if (!suffix.endsWith('/cancel')) expect(key).toMatch(/^[a-f0-9-]{36}$/iu); else expect(key).toBeUndefined();
    if (suffix === '') {
      expect(body).toEqual({ templateObservationOperationId: id(8), expectedSourceBindingRevision: 2, expectedTargetBindingRevision: 3 }); expect(creates.has(key!)).toBe(false);
      view = admission ? initial() : null; creates.set(key!, { request: body, id: view?.id ?? null, operationId: id(++sequence) });
      return route.fulfill({ contentType: 'application/json', body: '{' });
    }
    if (suffix === '/resolve') { const saved = creates.get(key!)!; expect(saved).toBeTruthy(); expect(body).toEqual(saved.request); return route.fulfill({ json: { ...saved, requestKey: key, state: saved.id ? 'ADMITTED' : 'NO_EFFECT', duplicate: true } }); }
    expect(suffix.startsWith(`/${current().id}/`)).toBe(true);
    if (suffix.endsWith('/resolve')) {
      const original = writes.filter(item => item.source === source && item.suffix === suffix.replace(/\/resolve$/u, '') && item.key === key); expect(original).toHaveLength(1); expect(body).toEqual(original[0]!.body);
      if (suffix.endsWith('/reconcile/resolve')) view = { ...current(), revision: current().revision + 1, state: 'RECONCILED_PAUSED', actions: { observe: false, register: false, reconcile: false, cancel: false }, pendingAction: { ...current().pendingAction!, state: 'SUCCEEDED' } };
      return route.fulfill({ json: actionResult() });
    }
    expect(body.expectedRevision).toBe(current().revision);
    if (suffix.endsWith('/cancel')) {
      const before = current().revision;
      if (cancelMode !== 'ABSENT') view = { ...current(), revision: before + 1, state: cancelMode === 'APPLY' ? 'CANCELLED' : 'REVIEW' };
      return route.fulfill({ contentType: 'application/json', body: '{' });
    }
    expect(body.expectedReviewSha256).toBe(current().reviewSha256);
    const action = suffix.split('/').at(-1)!.toUpperCase() as 'OBSERVE' | 'REGISTER' | 'RECONCILE', revision = current().revision;
    const pendingAction = { operationId: id(++sequence), requestKey: key!, action, requestRevision: revision, state: 'SUCCEEDED' as const };
    if (action === 'OBSERVE') { expect(body).not.toHaveProperty('confirmCutover'); view = { ...current(), revision: revision + 1, state: 'READY', reasons: [], capability: { live: false, qualificationOnly: true }, actions: { observe: true, register: true, reconcile: false, cancel: true }, pendingAction }; return route.fulfill({ json: actionResult() }); }
    if (action === 'REGISTER') { expect(body).toEqual({ expectedRevision: revision, expectedReviewSha256: current().reviewSha256, confirmCutover: true }); view = { ...current(), revision: revision + 1, state: unknown ? 'OUTCOME_UNKNOWN' : 'READBACK_REQUIRED', expiresAt: null, originalRegistration: { outcome: unknown ? 'UNKNOWN' : 'SUCCEEDED', attemptedAt: new Date().toISOString() }, actions: { observe: false, register: false, reconcile: !unknown, cancel: false }, pendingAction: { ...pendingAction, state: 'RUNNING' } }; }
    if (action === 'RECONCILE') { expect(current().originalRegistration?.outcome).toBe('SUCCEEDED'); view = { ...current(), revision: revision + 1, actions: { observe: false, register: false, reconcile: false, cancel: false }, pendingAction: { ...pendingAction, state: 'RUNNING' } }; }
    return route.fulfill({ contentType: 'application/json', body: '{' });
  });
  const section = () => page.getByRole('region', { name: t('title'), exact: true });
  const button = (key: string) => section().getByRole('button', { name: t(key), exact: true });
  const open = async () => { await page.goto(`/app?view=connections&connection=${source}`); await expect(page.locator('[data-application-ready="true"]')).toBeVisible(); await button('open').click(); await expect(button('refresh')).toBeEnabled(); };
  const capture = async (name: string) => { await section().getByRole('heading', { name: t('title'), exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`${name}-top.png`) }); await button('refresh').scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`${name}-actions.png`) }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); };
  await open(); await expect(section().getByText(t('boundary'), { exact: true })).toBeVisible(); await expect(button('reviewRegister')).toBeDisabled();
  if (!writable) { await expect(section().getByText(t('readOnly'), { exact: true })).toBeVisible(); expect(writes).toEqual([]); expect((await new AxeBuilder({ page }).include('.meta-legacy-migration').analyze()).violations).toEqual([]); await capture('legacy-read-only'); return; }
  await capture('legacy-live-unavailable');
  // Scoped storage faults exercise the actual mounted component, never the provider.
  const storageFault = async (method: 'getItem' | 'setItem' | 'removeItem' | null) => page.evaluate(({ key, method }) => {
    const own = window as unknown as { restoreLegacyStorage?: () => void };
    own.restoreLegacyStorage?.(); delete own.restoreLegacyStorage;
    if (method === null) return;
    const original = Object.getOwnPropertyDescriptor(Storage.prototype, method)!;
    const call = original.value as (this: Storage, key: string, value?: string) => string | null | void;
    Object.defineProperty(Storage.prototype, method, { ...original, value: function (this: Storage, item: string, value?: string) {
      if (this === sessionStorage && item === key) throw new Error('SYNTHETIC_STORAGE_UNAVAILABLE');
      return call.call(this, item, value);
    } });
    own.restoreLegacyStorage = () => Object.defineProperty(Storage.prototype, method, original);
  }, { key: storageKey, method });
  for (const kind of ['CORRUPT', 'UNAVAILABLE'] as const) {
    await button('hide').click();
    if (kind === 'CORRUPT') await page.evaluate(key => sessionStorage.setItem(key, '{'), storageKey);
    else await storageFault('getItem');
    try {
      await button('open').click(); await expect(button('refresh')).toBeEnabled();
      await expect(section().getByText(t('error.storage'), { exact: true })).toBeVisible(); await expect(button('cancel')).toBeDisabled();
      await button('refresh').click(); await expect(button('refresh')).toBeEnabled();
      await expect(section().getByText(t('error.storage'), { exact: true })).toBeVisible(); expect(writes).toEqual([]);
      if (kind === 'CORRUPT') expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBe('{');
    } finally { await storageFault(null); }
    await button('hide').click();
    // Only the fixture removes its deliberately corrupt marker; the product never does.
    if (kind === 'CORRUPT') await page.evaluate(key => sessionStorage.removeItem(key), storageKey);
    await button('open').click(); await expect(button('cancel')).toBeEnabled();
    await expect(section().getByText(t('error.storage'), { exact: true })).toHaveCount(0); expect(writes).toEqual([]);
  }
  await storageFault('setItem');
  try {
    await button('cancel').click(); await expect(section().getByText(t('error.storage'), { exact: true })).toBeVisible();
    await button('refresh').click(); await expect(button('refresh')).toBeEnabled();
    await expect(section().getByText(t('error.storage'), { exact: true })).toBeVisible(); await expect(button('cancel')).toBeDisabled(); expect(writes).toEqual([]);
  } finally { await storageFault(null); }
  await button('hide').click(); await button('open').click(); await expect(button('cancel')).toBeEnabled();
  // New independent local review: lost CREATE followed by no-admission tombstone.
  view = null; await button('refresh').click(); await button('prepare').click(); await expect(button('resolve')).toBeEnabled(); await page.reload(); await button('open').click(); await button('resolve').click(); await expect(button('resolve')).toHaveCount(0); expect(writes.filter(item => item.suffix === '')).toHaveLength(1);
  admission = true; await button('prepare').click(); await button('resolve').click(); await expect(button('cancel')).toBeEnabled();
  // Lost provider-free cancel: original same revision body can be deliberately retried.
  await button('cancel').click(); await expect(button('finishCancel')).toBeEnabled(); const oldCancel = writes.at(-1)!; cancelMode = 'APPLY';
  await storageFault('removeItem');
  let retainedCancel: string | null = null;
  try {
    await button('finishCancel').click(); await expect(section().getByText(t('error.storage'), { exact: true })).toBeVisible();
    retainedCancel = await page.evaluate(key => sessionStorage.getItem(key), storageKey); expect(retainedCancel).not.toBeNull();
    await button('refresh').click(); await expect(button('refresh')).toBeEnabled();
    await expect(section().getByText(t('error.storage'), { exact: true })).toBeVisible(); await expect(button('finishCancel')).toBeDisabled();
    expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBe(retainedCancel);
  } finally { await storageFault(null); }
  const settledWriteCount = writes.length;
  await button('hide').click(); await button('open').click(); await expect(button('refresh')).toBeEnabled();
  await expect(button('finishCancel')).toHaveCount(0); await expect(section().getByText(t('error.storage'), { exact: true })).toHaveCount(0);
  expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull(); expect(writes).toHaveLength(settledWriteCount); expect(writes.at(-1)!.body).toEqual(oldCancel.body);
  await button('prepare').click(); await button('resolve').click(); cancelMode = 'DRIFT'; await button('cancel').click(); await expect(section().getByText(t('notice.superseded'), { exact: true })).toBeVisible(); await expect(button('finishCancel')).toHaveCount(0);
  // Current explicit access offer. No review or SDK action grants registration.
  view = { ...current(), authorization: { targetConnectionId: source, targetLegacyMigrationId: current().id, canPrepare: true, canContinue: true }, reasons: ['DESTINATION_AUTHORIZATION_REQUIRED'], state: 'AUTHORIZATION_REQUIRED' }; await button('refresh').click(); await button('authorization.open').click();
  await section().getByRole('button', { name: signup('legacy.prepare'), exact: true }).click();
  await expect(section().getByRole('button', { name: signup('connect'), exact: true })).toBeEnabled();
  view = { ...current(), authorization: { ...current().authorization!, canPrepare: false, canContinue: false } }; await button('refresh').click();
  await expect(section().getByRole('button', { name: signup('connect'), exact: true })).toBeDisabled();
  await section().getByRole('button', { name: signup('cancel'), exact: true }).click();
  await expect(section().getByRole('button', { name: signup('legacy.prepare'), exact: true })).toBeDisabled();
  view = { ...current(), authorization: { ...current().authorization!, canPrepare: true, canContinue: true } }; await button('refresh').click();
  await section().getByRole('button', { name: signup('legacy.prepare'), exact: true }).click(); await section().getByRole('button', { name: signup('connect'), exact: true }).click();
  await page.evaluate(() => (window as unknown as { legacyCallbacks: ((value: unknown) => void)[] }).legacyCallbacks.at(-1)!({ authResponse: { code: 'synthetic-one-use-code' } }));
  await section().getByRole('radio', { name: /Exact destination/u }).check(); await expect(section().locator('input[type="password"]')).toHaveCount(0); await section().getByRole('button', { name: signup('legacy.select'), exact: true }).click();
  await expect(section().getByText(signup('legacy.status.COMPLETED'), { exact: true })).toBeVisible(); expect(writes.filter(item => /register|observe|reconcile/u.test(item.suffix))).toHaveLength(0);
  await section().getByRole('button', { name: signup('legacy.back'), exact: true }).first().click(); await button('observe').click(); await expect(button('reviewRegister')).toBeEnabled();
  await button('reviewRegister').focus(); await page.keyboard.press('Enter'); await expect(section().getByRole('alertdialog')).toBeVisible(); await expect(section().getByText(t('impact.paused'), { exact: true }).last()).toBeVisible(); await button('confirmRegister').click(); await expect(button('resolve')).toBeEnabled();
  await page.reload(); await button('open').click(); await button('resolve').click(); await expect(button('resolve')).toBeEnabled(); expect(writes.filter(item => item.suffix.endsWith('/register'))).toHaveLength(1);
  view = { ...current(), pendingAction: { ...current().pendingAction!, state: 'SUCCEEDED' } }; await button('refresh').click(); await expect(button('resolve')).toHaveCount(0); await button('reconcile').click(); await expect(button('resolve')).toBeEnabled(); await button('resolve').click(); await expect(section().getByText(t('state.RECONCILED_PAUSED'), { exact: true })).toBeVisible(); await expect(section().getByText(t('activation'), { exact: true })).toBeVisible();
  expect(current().impact.result).toBe('PAUSED'); expect(writes.filter(item => item.suffix.includes('activate'))).toHaveLength(0); expect((await new AxeBuilder({ page }).include('.meta-legacy-migration').analyze()).violations).toEqual([]); await capture('legacy-paused-completion');
  // Distinct source, immutable UNKNOWN registration; no successful history rewrite.
  source = id(11); unknown = true; attempt = null; view = { ...initial(), state: 'READY', reasons: [], capability: { live: false, qualificationOnly: true }, actions: { observe: true, register: true, reconcile: false, cancel: true } }; await open(); await button('reviewRegister').click(); await button('confirmRegister').click(); await page.reload(); await button('open').click(); await expect(button('resolve')).toBeEnabled(); const retainedOutcome = structuredClone(current().originalRegistration);
  await button('resolve').click(); await expect(button('reviewRegister')).toBeDisabled(); await expect(button('reconcile')).toBeDisabled(); await expect(button('cancel')).toBeDisabled(); expect(current().originalRegistration).toEqual(retainedOutcome); expect(writes.filter(item => item.suffix.endsWith('/register'))).toHaveLength(2); await capture('legacy-unknown');
  // New denial supersedes an older in-flight read; original key survives without POST.
  delay = true; await button('refresh').click(); await expect.poll(() => Boolean(deferred.release)).toBe(true); deny = true; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(section().getByText(t('error.permission'), { exact: true })).toBeVisible(); release(); await expect(section().getByText('Destination (الوجهة)', { exact: true })).toHaveCount(0); await expect(button('resolve')).toBeDisabled();
  deny = false; unavailable = true; await button('refresh').click(); await expect(section().getByText(t('error.unsupported'), { exact: true })).toBeVisible(); expect(writes.filter(item => item.suffix.endsWith('/register'))).toHaveLength(2); expect(signupWrites.filter(item => item.path.endsWith('/select'))).toHaveLength(1); expect(denials).toEqual([]);
}
