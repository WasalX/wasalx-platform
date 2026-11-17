import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeAccountOriginal, validateNativeAccountSources, validateNativeAccountRuntime, validateNativeAccountRows, validateNativeAccountMappings, claimNativeAccountContinuation } from '../scripts/release/simulation-native-account-continuation.mjs';
import { nativeAccountLinkingStage, runNativeAccountLinkingChecks } from '../scripts/release/simulation-native-account-linking.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const digest = value => hash(JSON.stringify(value));
const tenant = '00000000-0000-4000-8000-000000000001', owner = '00000000-0000-4000-8000-000000000002', agent = '00000000-0000-4000-8000-000000000003', instance = '00000000-0000-4000-8000-000000000004';
function fixture() {
  const projection = (user_id, role, native_user_id, member_version) => ({ user_id, oidc_subject: 'synthetic-' + role, email: role + '@example.invalid', display_name: role, role, member_state: 'ACTIVE', revision: '1', applied_revision: '1', native_user_id, requested_native_user_id: null, sync_state: 'READY', zammad_instance_id: instance, member_id: 'member-' + role, member_version: String(member_version), current_role: role, current_state: 'ACTIVE' });
  const projections = [projection(owner, 'tenant_owner', '11', 16), projection(agent, 'agent', '12', 17)];
  const enable = { id: 'audit-original', request_id: 'original-enable-request', at: '2026-10-08T20:39:32.404975Z', actor_id: owner, target_type: 'tenant', target_id: tenant, action: 'team.native_access_enabled', new_value: { enabled: true } };
  const effect = { project: nativeAccountOriginal.project, originalNamespace: nativeAccountOriginal.namespace, tenantRef: hash(tenant), intentsSha256: nativeAccountOriginal.hashes.intents, laterReconcileAdoptionLifecycleCount: 0,
    audit: { id: enable.id, requestId: enable.request_id, at: enable.at, actorRef: hash(owner), targetType: 'tenant', targetRef: hash(tenant), action: enable.action, newValue: enable.new_value }, actors: {} };
  for (const [index, row] of projections.entries()) effect.actors[index === 0 ? 'owner' : 'agent'] = {
    actorRef: hash(row.user_id), membershipVersion: Number(row.member_version),
    projectionSha256: digest([row.user_id, row.oidc_subject, row.email, row.display_name, row.role, row.member_state, 1, 1, row.native_user_id, null, row.sync_state, instance]),
    membershipSha256: digest([row.member_id, row.user_id, row.role, row.member_state, Number(row.member_version)]),
  };
  const rows = { projections, settings: [{ native_membership_sync_enabled: true, state: 'ACTIVE' }], registry: [{ id: instance, state: 'WORKING' }], enable: [enable], changes: [] };
  const src = { effect, manifest: { namespace: nativeAccountOriginal.namespace, evidenceMode: 'simulated' }, admission: { candidate: nativeAccountOriginal.candidate, project: nativeAccountOriginal.project }, context: { owner: { actorRef: 'sha256:' + hash(owner), tenantRef: 'sha256:' + hash(tenant), role: 'tenant_owner' } }, secondActor: { result: { tenantId: tenant, userId: agent, memberId: projections[1].member_id, subject: projections[1].oidc_subject } }, failure: { scenario: 'native-account-linking', startedAt: '2026-10-08T20:39:06.569Z', finishedAt: '2026-10-08T20:39:32.559Z', sourceLocation: { path: 'scripts/release/simulation-native-account-linking.mjs', line: 71, column: 80 } }, intents: [
    { phase: 'synthetic-request-failed', step: 'nonowner-enable-denial', code: 'api-http', httpStatus: 403, at: '2026-10-08T20:39:31.226Z' },
    { phase: 'native-account-linking-intent', namespace: nativeAccountOriginal.namespace, reviewCount: 2, at: '2026-10-08T20:39:32.308Z' },
    { phase: 'native-account-linking-accepted', status: 200, at: '2026-10-08T20:39:32.458Z' },
  ] };
  const refs = Object.fromEntries(Object.entries(nativeAccountOriginal.hashes).map(([key, sha256]) => [key, { path: key + (key === 'intents' ? '.jsonl' : '.json'), sha256 }]));
  const session = { runId: 'retained-native-successor', tenantId: tenant, ownerId: owner, model: { name: nativeAccountOriginal.project }, privateDir: '/srv/wasalx-fast/' + nativeAccountOriginal.project };
  return { rows, effect, src, refs, session };
}

test('original source admission binds one reviewed enable and rejects foreign, changed and already-started inputs', () => {
  const valid = fixture();
  assert.equal(validateNativeAccountSources(valid.src, valid.refs, valid.session, valid.session.runId).reviewCount, 2);
  for (const mutate of [
    x => x.refs.effect.sha256 = '0'.repeat(64),
    x => x.session.ownerId = agent,
    x => x.session.model.name = 'foreign-project',
    x => x.session.privateDir += '-copy',
    x => x.src.effect.audit.requestId = '',
    x => x.src.effect.audit.actorRef = hash(agent),
    x => x.src.intents[0].httpStatus = 500,
    x => x.src.intents.push({ phase: 'intent', step: 'native-link-suspend' }),
    x => x.src.intents.push({ ...x.src.intents[2] }),
    x => x.src.effect.audit.at = '2026-10-09T00:00:00Z',
  ]) {
    const x = fixture(); mutate(x);
    assert.throws(() => validateNativeAccountSources(x.src, x.refs, x.session, x.session.runId));
  }
});

test('retained readback rejects held, changed, duplicate or foreign projection and audit authority', () => {
  const x = fixture(); assert.equal(validateNativeAccountRows(x.rows, x.effect, owner, agent).length, 2);
  for (const mutate of [
    value => value.rows.projections[1].sync_state = 'UNAVAILABLE',
    value => value.rows.projections[1].revision = '2',
    value => value.rows.projections[1].native_user_id = '99',
    value => value.rows.projections[1].oidc_subject += '-changed',
    value => value.rows.projections[1].member_version = '18',
    value => value.rows.projections.push({ ...value.rows.projections[1] }),
    value => value.rows.enable[0].request_id = 'another-request',
    value => value.rows.enable.push({ ...value.rows.enable[0] }),
    value => value.rows.changes.push({ action: 'team.native_access_reconcile_requested' }),
    value => value.rows.registry[0].id = tenant,
  ]) { const value = fixture(); mutate(value); assert.throws(() => validateNativeAccountRows(value.rows, value.effect, owner, agent)); }
});

test('runtime admission rejects changed origin, installed identity and owned container bindings', () => {
  const f = fixture(), names = ['portal', 'control-api', 'connector-worker', 'postgres', 'keycloak', 'zammad-nginx', 'zammad-railsserver', 'waha-gows'];
  const candidate = { sha: 'a'.repeat(40), tree: 'b'.repeat(40) }, nativePackage = { candidate_commit_sha: 'c'.repeat(40), candidate_tree_sha: 'd'.repeat(40), native_package_sha256: 'e'.repeat(64) };
  const containers = Object.fromEntries(names.map(name => [name, { Id: name, Image: 'sha256:' + hash(name), State: { Running: true }, Config: { Labels: { 'com.docker.compose.project': f.session.model.name, 'com.docker.compose.service': name } } }]));
  const s = { ...f.session, candidate, containers, portalOrigin: 'https://portal.example.invalid', nativeOrigin: 'https://native.example.invalid', ownerPage: { url: () => 'https://portal.example.invalid/app' }, capabilities: { secondActor: { page: { url: () => 'https://portal.example.invalid/app' } } } };
  const current = { project: s.model.name, candidate, nativePackage, portalOrigin: s.portalOrigin, nativeOrigin: s.nativeOrigin, containers: Object.fromEntries(names.map(name => [name, { id: containers[name].Id, image: containers[name].Image }])) };
  validateNativeAccountRuntime(s, current);
  for (const mutate of [v => v.candidate.sha = 'f'.repeat(40), v => v.portalOrigin += ':444', v => v.containers.postgres.image = 'other', v => delete v.containers.keycloak, v => v.nativePackage.native_package_sha256 = 'missing']) {
    const v = structuredClone(current); mutate(v); assert.throws(() => validateNativeAccountRuntime(s, v));
  }
});

test('native mappings require exact original payload, one OIDC binding, current roles and real package identity', () => {
  const { rows } = fixture(), installed = { candidate_commit_sha: 'a'.repeat(40), candidate_tree_sha: 'b'.repeat(40), native_package_sha256: 'c'.repeat(64) };
  const observed = { installed, rows: rows.projections.map(row => ({ actorRef: hash(row.user_id), nativeIdRef: hash(row.native_user_id), tenantRef: hash(tenant), instanceRef: hash(instance), subjectRef: hash(row.oidc_subject), emailRef: hash(row.email), userEmailRef: hash(row.email), payloadSha256: digest({ tenant_id: tenant, instance_id: instance, user_id: row.user_id, subject: row.oidc_subject, email: row.email, name: row.display_name, role: row.role, state: 'ACTIVE', revision: 1 }), revision: 1, state: 'ACTIVE', role: row.role, active: true, allowed: true, automation: false, roles: row.role === 'agent' ? ['Agent'] : ['Admin', 'Agent'], authorizationCount: 1, subjectCount: 1, mappingCount: 1 })) };
  validateNativeAccountMappings(observed, rows.projections, tenant, installed);
  for (const mutate of [v => v.rows[1].payloadSha256 = 'x', v => v.rows[1].subjectCount = 0, v => v.rows[1].authorizationCount = 2, v => v.rows[1].roles.push('Admin'), v => v.rows[1].automation = true, v => v.rows[1].allowed = false, v => v.installed.native_package_sha256 = 'x']) {
    const v = structuredClone(observed); mutate(v); assert.throws(() => validateNativeAccountMappings(v, rows.projections, tenant, installed));
  }
});

test('a different namespace cannot repeat the original operation claim, including after an uncertain result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wasalx-native-claim-'));
  try {
    const { effect } = fixture();
    await claimNativeAccountContinuation(dir, effect, 'first');
    // No cleanup/retry on an uncertain action; the original claim remains durable.
    await assert.rejects(() => claimNativeAccountContinuation(dir, effect, 'second'), { code: 'EEXIST' });
    const files = await readdir(dir); assert.equal(files.length, 1);
    assert.equal(JSON.parse(await readFile(join(dir, files[0]), 'utf8')).namespace, 'first');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the fresh entrypoint still rejects an enabled tenant before any enable interaction', async () => {
  let reads = 0, interactions = 0;
  const s = { tenantId: tenant, ownerId: owner, capabilities: { secondActor: { userId: agent } },
    verifyOwner: async () => ({ userMatched: true, workspaceMatched: true }), ensurePrivilegedOwner: async () => {},
    ownerPage: { setViewportSize: async () => {}, viewportSize: () => ({ width: 1440, height: 1000 }), evaluate: async () => ++reads === 1 ? 'en' : { enabled: true }, locator: () => { interactions++; throw Error('unexpected enable interaction'); } },
  };
  await assert.rejects(() => nativeAccountLinkingStage(s, { namespace: 'fresh-test', inputs: { teamAccess: { results: [{}] }, secondActor: { userId: agent, tenantId: tenant } } }), /do not replay opt-in/);
  assert.equal(interactions, 0);
});

async function lifecycleFixture(failureAt) {
  const f = fixture(), initial = f.rows.projections[1], requests = [];
  let state = 'ACTIVE', version = 17, revision = 1, nativeReads = 0, reactivated = false;
  const member = () => ({ user_id: agent, role: 'agent', state, version: String(version) });
  const status = () => ({ enabled: true, members: f.rows.projections.map(row => ({ user_id: row.user_id, native_user_id: row.native_user_id, member_state: row.user_id === agent ? state : 'ACTIVE', sync_state: 'READY', revision: row.user_id === agent ? revision : 1, applied_revision: row.user_id === agent ? revision : 1 })) });
  const page = { evaluate: async () => 403, reload: async () => { reactivated = true; } };
  const s = { tenantId: tenant, ownerId: owner, portalOrigin: 'https://portal.example.invalid', containers: { 'zammad-railsserver': { Id: 'owned' } }, capabilities: { secondActor: { page, subject: initial.oidc_subject } }, checkpoint: async () => {},
    ownerPage: { viewportSize: () => ({ width: 1440, height: 1000 }), url: () => 'https://portal.example.invalid/app', evaluate: async (_fn, args) => {
      requests.push(args); if (requests.length === failureAt) throw Error('uncertain mutation');
      assert.equal(args.method, 'PATCH'); assert.equal(args.body.expectedVersion, version);
      state = args.body.state; version++; revision++; return { id: 'accepted' };
    } },
    verifyOwner: async () => ({ userMatched: true, workspaceMatched: true }),
    scoped: async query => query.includes('FROM native_membership_projections') ? [initial] : query.includes("action='team.native_access_enabled'") ? [{ id: f.effect.audit.id, actor_id: owner, request_id: f.effect.audit.requestId }] : [
      { actor_id: owner, request_id: 'suspend', new_value: { state: 'SUSPENDED' } }, { actor_id: owner, request_id: 'restore', new_value: { state: 'ACTIVE' } },
    ],
    run: async () => JSON.stringify(++nativeReads === 1 ? { nativeUserId: '12', tenantId: tenant, instanceId: instance, subject: initial.oidc_subject, revision: 1, memberState: 'ACTIVE', portalRole: 'agent', active: true, agent: true, admin: false, subjectMatches: true, interactive: true } : { nativeId: '12', revision, state, active: state === 'ACTIVE', allowed: state === 'ACTIVE' }),
  };
  const work = () => runNativeAccountLinkingChecks(s, { namespace: 'retained-test', inputs: { secondActor: { userId: agent, memberId: initial.member_id } }, startedAt: new Date().toISOString(), readPortal: async () => status(), readAgent: async () => member(), beforeAgent: member(), registry: f.rows.registry, status: status(), review: 2, retained: { namespace: nativeAccountOriginal.namespace, originalStartedAt: f.src.failure.startedAt, enableAudit: f.effect.audit } });
  return { work, requests, reactivated: () => reactivated };
}

test('shared retained lifecycle body performs only one suspend and one restore with separate prior attribution', async () => {
  const f = await lifecycleFixture(); const result = await f.work();
  assert.deepEqual(f.requests.map(row => row.body.state), ['SUSPENDED', 'ACTIVE']);
  assert(f.requests.every(row => row.method === 'PATCH' && row.path.startsWith('/api/team/members/')));
  assert.equal(result.results[0].proof.originalPrefix.sourceNamespace, nativeAccountOriginal.namespace);
  assert.equal(result.results[0].proof.portalActorReactivated, true); assert(f.reactivated());
});

test('uncertain suspension never triggers restoration and uncertain restoration is never replayed', async () => {
  for (const failureAt of [1, 2]) {
    const f = await lifecycleFixture(failureAt);
    await assert.rejects(f.work, /uncertain mutation/);
    assert.equal(f.requests.length, failureAt);
    assert.equal(f.reactivated(), false);
  }
});
