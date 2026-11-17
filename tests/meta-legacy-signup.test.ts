import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
// Actual signup BFF with incumbent authentication and bounded parser; transport only is doubled.
const fixture = globalThis as typeof globalThis & { legacySignupSession?: { userId: string; tenantId: string; role: string; csrfToken: string }; legacySignupCalls?: unknown[][] };
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './portal-session-store.ts' && context.parentURL?.endsWith('/lib/portal-session.ts')) return { url: 'data:text/javascript,export async function loadStoredPortalSession(){return globalThis.legacySignupSession}', shortCircuit: true };
  if (context.parentURL && decodeURIComponent(context.parentURL).endsWith('/meta/signup/[...path]/route.ts')) {
    if (specifier.endsWith('/control-plane-data')) return { url: 'data:text/javascript,export async function metaSignupPortalRequest(...args){globalThis.legacySignupCalls.push(args);return {attempt:null}}', shortCircuit: true };
    if (!specifier.endsWith('.ts')) return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href, context);
  }
  return nextResolve(specifier, context);
} });
const route = await import('../app/api/connections/meta/signup/[...path]/route.ts');
after(() => hooks.deregister());
const id = (n: number) => `66000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('legacy signup forwards only the exact local target pair and preserves separate purposes/CSRF/origin', async () => {
  const env = { PORTAL_DATA_BACKEND: 'control-plane', PORTAL_COOKIE_SECURE: 'false', PORTAL_PUBLIC_ORIGIN: 'https://portal.example' };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]])), oldSession = fixture.legacySignupSession, oldCalls = fixture.legacySignupCalls;
  Object.assign(process.env, env); fixture.legacySignupSession = { userId: 'actor-a', tenantId: id(10), role: 'tenant_owner', csrfToken: 'synthetic-csrf' }; fixture.legacySignupCalls = [];
  const headers = { cookie: 'wasalx_session=synthetic-cookie', origin: env.PORTAL_PUBLIC_ORIGIN, 'content-type': 'application/json', 'x-wasalx-csrf': 'synthetic-csrf' };
  const body = { name: 'Authorize number move', payerMode: 'CUSTOMER', idempotencyKey: id(3), targetConnectionId: id(1), targetLegacyMigrationId: id(2) };
  const invoke = (query: string, value?: unknown, changed: Record<string, string> = {}) => {
    const method = value === undefined ? 'GET' : 'POST'; return route[method](new Request(`${env.PORTAL_PUBLIC_ORIGIN}/api/connections/meta/signup/attempts${query}`, { method, headers: { ...headers, ...changed }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), { params: Promise.resolve({ path: ['attempts'] }) });
  };
  try {
    const query = `?targetConnectionId=${id(1)}&targetLegacyMigrationId=${id(2)}`;
    assert.equal((await invoke(query)).status, 200); assert.equal(fixture.legacySignupCalls.at(-1)![0], 'attempts'+query);
    assert.equal((await invoke('', body)).status, 200); assert.deepEqual(fixture.legacySignupCalls.at(-1), ['attempts', 'POST', body, env.PORTAL_PUBLIC_ORIGIN]);
    const invalidQueries = [`?targetLegacyMigrationId=${id(2)}`, query+`&targetTransitionId=${id(4)}`, query+'&purpose=ADD_ACCESS', query+`&targetLegacyMigrationId=${id(2)}`, `?targetConnectionId=${id(1)}&targetLegacyMigrationId=bad`];
    for (const q of invalidQueries) { const count: number = fixture.legacySignupCalls.length; assert.equal((await invoke(q)).status, 400); assert.equal(fixture.legacySignupCalls.length, count); }
    for (const value of [{ ...body, targetConnectionId: undefined }, { ...body, targetTransitionId: id(4) }, { ...body, purpose: 'LEGACY_MIGRATION' }, { ...body, purpose: 'ADD_ACCESS' }, { ...body, variant: 'BUSINESS_APP', coexistenceConsent: { version: '2026-10-07', history: false, contacts: false, echoes: true } }]) { const count: number = fixture.legacySignupCalls.length; assert.equal((await invoke('', value)).status, 400); assert.equal(fixture.legacySignupCalls.length, count); }
    const rejectedHeaders: Record<string, string>[] = [{ origin: 'https://foreign.example' }, { 'x-wasalx-csrf': 'wrong' }];
    for (const changed of rejectedHeaders) { const count: number = fixture.legacySignupCalls.length; assert.equal((await invoke('', body, changed)).status, 403); assert.equal(fixture.legacySignupCalls.length, count); }
    fixture.legacySignupSession.role = 'auditor'; const count: number = fixture.legacySignupCalls.length; assert.equal((await invoke(query)).status, 403); assert.equal(fixture.legacySignupCalls.length, count);
  } finally {
    if (oldSession === undefined) delete fixture.legacySignupSession; else fixture.legacySignupSession = oldSession;
    if (oldCalls === undefined) delete fixture.legacySignupCalls; else fixture.legacySignupCalls = oldCalls;
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
