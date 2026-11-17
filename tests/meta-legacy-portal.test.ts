import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { englishTenantMessages } from '../lib/i18n/messages/en/tenant.ts';
import { arabicTenantMessages } from '../lib/i18n/messages/ar/tenant.ts';

// Authored BFF behavior only. Real authentication/CSRF/body parser, scoped session
// store and control-plane transport doubles; no installed session/provider proof.
const fixture = globalThis as typeof globalThis & { legacySession?: { userId: string; tenantId: string; role: string; csrfToken: string }; legacyCalls?: unknown[][] };
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './portal-session-store.ts' && context.parentURL?.endsWith('/lib/portal-session.ts')) return { url: 'data:text/javascript,export async function loadStoredPortalSession(){return globalThis.legacySession}', shortCircuit: true };
  if (context.parentURL && decodeURIComponent(context.parentURL).endsWith('/legacy-migrations/[[...path]]/route.ts')) {
    if (specifier.endsWith('/control-plane-data')) return { url: 'data:text/javascript,export async function metaLegacyMigrationPortalRequest(...args){globalThis.legacyCalls.push(args);return {currentPlan:null,prepare:null}}', shortCircuit: true };
    if (!specifier.endsWith('.ts')) return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href, context);
  }
  return nextResolve(specifier, context);
} });
const route = await import('../app/api/connections/[id]/meta/legacy-migrations/[[...path]]/route.ts');
after(() => hooks.deregister());
const id = (n: number) => `65000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('actual legacy proxy fences current actor/workspace, permission, CSRF, exact routes and original bodies', async () => {
  const env = { PORTAL_DATA_BACKEND: 'control-plane', PORTAL_COOKIE_SECURE: 'false', PORTAL_PUBLIC_ORIGIN: 'https://portal.example' };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  const previousSession = fixture.legacySession, previousCalls = fixture.legacyCalls;
  Object.assign(process.env, env); fixture.legacySession = { userId: 'actor-a', tenantId: id(10), role: 'tenant_owner', csrfToken: 'synthetic-csrf' }; fixture.legacyCalls = [];
  const headers = { cookie: 'wasalx_session=synthetic-cookie', origin: env.PORTAL_PUBLIC_ORIGIN, 'content-type': 'application/json', 'x-wasalx-csrf': 'synthetic-csrf', 'x-wasalx-legacy-actor': 'actor-a', 'x-wasalx-legacy-workspace': id(10), 'idempotency-key': id(3) };
  const create = { templateObservationOperationId: id(8), expectedSourceBindingRevision: 2, expectedTargetBindingRevision: 3 };
  const register = { expectedRevision: 5, expectedReviewSha256: 'a'.repeat(64), confirmCutover: true };
  const observe = { expectedRevision: 5, expectedReviewSha256: 'a'.repeat(64) };
  const reconcile = { expectedRevision: 5, expectedReviewSha256: 'a'.repeat(64) };
  const cancel = { expectedRevision: 5 };
  const invoke = (suffix: string, method: 'GET' | 'POST', value?: unknown, changed: Record<string, string> = {}, requestOrigin = env.PORTAL_PUBLIC_ORIGIN) => route[method](new Request(`${requestOrigin}/api/connections/${id(1)}/meta/legacy-migrations${suffix}`, {
    method, headers: { ...Object.fromEntries(Object.entries(headers).filter(([key]) => !suffix.endsWith('/cancel') || key !== 'idempotency-key')), ...changed }, ...(method === 'POST' ? { body: typeof value === 'string' ? value : JSON.stringify(value) } : {}),
  }), { params: Promise.resolve({ id: id(1), path: suffix.split('?')[0]!.split('/').filter(Boolean) }) });
  try {
    const positives: Array<[string, 'GET' | 'POST', unknown]> = [
      ['', 'GET', undefined], [`/${id(2)}`, 'GET', undefined],
      ['', 'POST', create], ['/resolve', 'POST', create],
      [`/${id(2)}/register`, 'POST', register], [`/${id(2)}/register/resolve`, 'POST', register],
      [`/${id(2)}/observe`, 'POST', observe], [`/${id(2)}/observe/resolve`, 'POST', observe],
      [`/${id(2)}/reconcile`, 'POST', reconcile], [`/${id(2)}/reconcile/resolve`, 'POST', reconcile],
      [`/${id(2)}/cancel`, 'POST', cancel],
    ];
    for (const [suffix, method, value] of positives) {
      const count: number = fixture.legacyCalls.length;
      assert.equal((await invoke(suffix, method, value)).status, 200);
      assert.equal(fixture.legacyCalls.length, count + 1);
      const call: unknown[] = fixture.legacyCalls.at(-1)!;
      assert.deepEqual(call[0], { userId: 'actor-a', email: undefined, displayName: undefined, tenantId: id(10), role: 'tenant_owner' });
      assert.equal(call[1], id(1)); assert.equal(call[2], suffix.replace(/^\//u, '')); assert.equal(call[3], method);
      assert.deepEqual(call[4], value); assert.equal(call[5], method === 'POST' && !suffix.endsWith('/cancel') ? id(3) : undefined);
    }
    const denials: Array<[string, 'GET' | 'POST', unknown, Record<string, string>, number]> = [
      ['', 'GET', undefined, { 'x-wasalx-legacy-actor': 'other' }, 403], ['', 'GET', undefined, { 'x-wasalx-legacy-workspace': id(11) }, 403],
      ['', 'POST', create, { origin: 'https://foreign.example' }, 403], ['', 'POST', create, { 'x-wasalx-csrf': 'wrong' }, 403], ['', 'POST', create, { cookie: '' }, 401],
      ['', 'POST', create, { 'idempotency-key': 'invalid' }, 400], ['?tenant=foreign', 'GET', undefined, {}, 400],
      [`/${id(2)}/transfer`, 'POST', create, {}, 404], [`/${id(2)}/register/resolve/extra`, 'POST', register, {}, 404],
      ['', 'POST', '{', {}, 400], ['', 'POST', { ...create, phoneNumberId: 'secret' }, {}, 400],
      [`/${id(2)}/register`, 'POST', { ...register, confirmCutover: false }, {}, 400],
      [`/${id(2)}/observe`, 'POST', register, {}, 400], [`/${id(2)}/cancel`, 'POST', cancel, { 'idempotency-key': id(3) }, 400], ['', 'POST', ' '.repeat(4097), {}, 400],
    ];
    for (const [suffix, method, value, changed, status] of denials) {
      const count: number = fixture.legacyCalls.length; const response = await invoke(suffix, method, value, changed);
      assert.equal(response.status, status); assert.equal(fixture.legacyCalls.length, count); assert.match(response.headers.get('cache-control') ?? '', /no-store/u);
    }
    fixture.legacySession.userId = 'actor-b';
    for (const method of ['GET', 'POST'] as const) { const count: number = fixture.legacyCalls.length; assert.equal((await invoke(method === 'POST' ? '/resolve' : '', method, create)).status, 403); assert.equal(fixture.legacyCalls.length, count); }
    fixture.legacySession.userId = 'actor-a'; fixture.legacySession.role = 'auditor';
    assert.equal((await invoke('', 'GET')).status, 200);
    const count: number = fixture.legacyCalls.length;
    assert.equal((await invoke('', 'POST', create)).status, 403); assert.equal(fixture.legacyCalls.length, count);
    fixture.legacySession.role = 'tenant_owner'; process.env.PORTAL_DATA_BACKEND = 'fixture';
    // Use the incumbent local fixture principal; a nonlocal fixture request is
    // correctly rejected by authentication before reaching backend availability.
    const unsupported = await invoke('', 'GET', undefined, { 'x-wasalx-legacy-actor': 'local-preview', 'x-wasalx-legacy-workspace': 'tenant_northstar' }, 'http://localhost');
    assert.equal(unsupported.status, 501); assert.equal(fixture.legacyCalls.length, count);
  } finally {
    if (previousSession === undefined) delete fixture.legacySession; else fixture.legacySession = previousSession;
    if (previousCalls === undefined) delete fixture.legacyCalls; else fixture.legacyCalls = previousCalls;
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
test('every finite legacy reason, state and recovery message is available in both languages', () => {
  const keys = Object.keys(englishTenantMessages).filter(key => key.startsWith('tenant.metaLegacy.'));
  const english: Readonly<Record<string, string>> = englishTenantMessages, arabic: Readonly<Record<string, string>> = arabicTenantMessages;
  assert.ok(keys.length > 60);
  for (const key of keys) { assert.ok(arabic[key], key); assert.notEqual(english[key], arabic[key], key); }
});
