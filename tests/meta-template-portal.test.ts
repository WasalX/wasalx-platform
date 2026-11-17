import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { englishTenantMessages } from '../lib/i18n/messages/en/tenant.ts';
import { arabicTenantMessages } from '../lib/i18n/messages/ar/tenant.ts';

// Authored BFF behavior only. Real authentication/CSRF/body parser, scoped session
// store and control-plane transport doubles; no installed session/provider proof.
const fixture = globalThis as typeof globalThis & { templateSession?: { userId: string; tenantId: string; role: string; csrfToken: string }; templateCalls?: unknown[][] };
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './portal-session-store.ts' && context.parentURL?.endsWith('/lib/portal-session.ts')) return { url: 'data:text/javascript,export async function loadStoredPortalSession(){return globalThis.templateSession}', shortCircuit: true };
  if (context.parentURL && decodeURIComponent(context.parentURL).endsWith('/template-preparations/[[...path]]/route.ts')) {
    if (specifier.endsWith('/control-plane-data')) return { url: 'data:text/javascript,export async function metaTemplatePreparationPortalRequest(...args){globalThis.templateCalls.push(args);return {currentPlan:null,prepare:null}}', shortCircuit: true };
    if (!specifier.endsWith('.ts')) return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href, context);
  }
  return nextResolve(specifier, context);
} });
const route = await import('../app/api/connections/[id]/meta/template-preparations/[[...path]]/route.ts');
after(() => hooks.deregister());
const id = (n: number) => `65000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('actual template proxy fences current actor/workspace, permission, CSRF, exact routes and original bodies', async () => {
  const env = { PORTAL_DATA_BACKEND: 'control-plane', PORTAL_COOKIE_SECURE: 'false', PORTAL_PUBLIC_ORIGIN: 'https://portal.example' };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  const previousSession = fixture.templateSession, previousCalls = fixture.templateCalls;
  Object.assign(process.env, env); fixture.templateSession = { userId: 'actor-a', tenantId: id(10), role: 'tenant_owner', csrfToken: 'synthetic-csrf' }; fixture.templateCalls = [];
  const headers = { cookie: 'wasalx_session=synthetic-cookie', origin: env.PORTAL_PUBLIC_ORIGIN, 'content-type': 'application/json', 'x-wasalx-csrf': 'synthetic-csrf', 'x-wasalx-template-actor': 'actor-a', 'x-wasalx-template-workspace': id(10), 'idempotency-key': id(3) };
  const create = { targetConnectionId: id(8), expectedAccountRevision: 2, expectedBindingRevision: 3 };
  const copy = { expectedRevision: 5, expectedObservationSha256: 'a'.repeat(64), choices: [id(6)] };
  const observe = { expectedRevision: 5, expectedObservationSha256: null };
  const reconcile = { expectedRevision: 5, expectedObservationSha256: 'a'.repeat(64) };
  const cancel = { expectedRevision: 5 };
  const invoke = (suffix: string, method: 'GET' | 'POST', value?: unknown, changed: Record<string, string> = {}, requestOrigin = env.PORTAL_PUBLIC_ORIGIN) => route[method](new Request(`${requestOrigin}/api/connections/${id(1)}/meta/template-preparations${suffix}`, {
    method, headers: { ...headers, ...changed }, ...(method === 'POST' ? { body: typeof value === 'string' ? value : JSON.stringify(value) } : {}),
  }), { params: Promise.resolve({ id: id(1), path: suffix.split('?')[0]!.split('/').filter(Boolean) }) });
  try {
    const positives: Array<[string, 'GET' | 'POST', unknown]> = [
      ['', 'GET', undefined], [`/${id(2)}`, 'GET', undefined],
      ['', 'POST', create], ['/resolve', 'POST', create],
      [`/${id(2)}/copy`, 'POST', copy], [`/${id(2)}/copy/resolve`, 'POST', copy],
      [`/${id(2)}/observe`, 'POST', observe], [`/${id(2)}/observe/resolve`, 'POST', observe],
      [`/${id(2)}/reconcile`, 'POST', reconcile], [`/${id(2)}/reconcile/resolve`, 'POST', reconcile],
      [`/${id(2)}/cancel`, 'POST', cancel],
    ];
    for (const [suffix, method, value] of positives) {
      const count: number = fixture.templateCalls.length;
      assert.equal((await invoke(suffix, method, value)).status, 200);
      assert.equal(fixture.templateCalls.length, count + 1);
      const call: unknown[] = fixture.templateCalls.at(-1)!;
      assert.deepEqual(call[0], { userId: 'actor-a', email: undefined, displayName: undefined, tenantId: id(10), role: 'tenant_owner' });
      assert.equal(call[1], id(1)); assert.equal(call[2], suffix.replace(/^\//u, '')); assert.equal(call[3], method);
      assert.deepEqual(call[4], value); assert.equal(call[5], method === 'POST' ? id(3) : undefined);
    }
    const denials: Array<[string, 'GET' | 'POST', unknown, Record<string, string>, number]> = [
      ['', 'GET', undefined, { 'x-wasalx-template-actor': 'other' }, 403], ['', 'GET', undefined, { 'x-wasalx-template-workspace': id(11) }, 403],
      ['', 'POST', create, { origin: 'https://foreign.example' }, 403], ['', 'POST', create, { 'x-wasalx-csrf': 'wrong' }, 403], ['', 'POST', create, { cookie: '' }, 401],
      ['', 'POST', create, { 'idempotency-key': 'invalid' }, 400], ['?tenant=foreign', 'GET', undefined, {}, 400],
      [`/${id(2)}/register`, 'POST', create, {}, 404], [`/${id(2)}/copy/resolve/extra`, 'POST', copy, {}, 404],
      ['', 'POST', '{', {}, 400], ['', 'POST', { ...create, phoneNumberId: 'secret' }, {}, 400],
      [`/${id(2)}/copy`, 'POST', { ...copy, choices: [id(6), id(6)] }, {}, 400],
      [`/${id(2)}/observe`, 'POST', copy, {}, 400], ['', 'POST', ' '.repeat(33000), {}, 400],
    ];
    for (const [suffix, method, value, changed, status] of denials) {
      const count: number = fixture.templateCalls.length; const response = await invoke(suffix, method, value, changed);
      assert.equal(response.status, status); assert.equal(fixture.templateCalls.length, count); assert.match(response.headers.get('cache-control') ?? '', /no-store/u);
    }
    fixture.templateSession.userId = 'actor-b';
    for (const method of ['GET', 'POST'] as const) { const count: number = fixture.templateCalls.length; assert.equal((await invoke(method === 'POST' ? '/resolve' : '', method, create)).status, 403); assert.equal(fixture.templateCalls.length, count); }
    fixture.templateSession.userId = 'actor-a'; fixture.templateSession.role = 'auditor';
    assert.equal((await invoke('', 'GET')).status, 200);
    const count: number = fixture.templateCalls.length;
    assert.equal((await invoke('', 'POST', create)).status, 403); assert.equal(fixture.templateCalls.length, count);
    fixture.templateSession.role = 'tenant_owner'; process.env.PORTAL_DATA_BACKEND = 'fixture';
    // Use the incumbent local fixture principal; a nonlocal fixture request is
    // correctly rejected by authentication before reaching backend availability.
    const unsupported = await invoke('', 'GET', undefined, { 'x-wasalx-template-actor': 'local-preview', 'x-wasalx-template-workspace': 'tenant_northstar' }, 'http://localhost');
    assert.equal(unsupported.status, 501); assert.equal(fixture.templateCalls.length, count);
  } finally {
    if (previousSession === undefined) delete fixture.templateSession; else fixture.templateSession = previousSession;
    if (previousCalls === undefined) delete fixture.templateCalls; else fixture.templateCalls = previousCalls;
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
test('every finite template reason, state and recovery message is available in both languages', () => {
  const keys = Object.keys(englishTenantMessages).filter(key => key.startsWith('tenant.metaTemplates.'));
  const english: Readonly<Record<string, string>> = englishTenantMessages, arabic: Readonly<Record<string, string>> = arabicTenantMessages;
  assert.ok(keys.length > 60);
  for (const key of keys) { assert.ok(arabic[key], key); assert.notEqual(english[key], arabic[key], key); }
});
