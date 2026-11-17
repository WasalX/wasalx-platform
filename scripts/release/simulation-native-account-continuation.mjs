import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRetainedDirectSources } from './simulation-direct-continuation.mjs';
import { parseRailsJson } from './simulation-rails-json.mjs';
import { runNativeAccountLinkingChecks } from './simulation-native-account-linking.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const digest = value => hash(JSON.stringify(value));
const one = (rows, label) => { assert.equal(rows.length, 1, label); return rows[0]; };
export const nativeAccountOriginal = Object.freeze({
  namespace: 'example-native-account-original', project: "example-project",
  candidate: { sha: '0000000000000000000000000000000000000000', tree: '0000000000000000000000000000000000000000' },
  hashes: {
    manifest: 'f3a3017d0940089ea462985526586c8b1f2c90442d258751b449c8bdc4582bda',
    admission: '5f074b530e926290c3ac2923aa4f45d595170ce17771441e6dcb305687206678',
    context: '3f00c178015ed737270f19229eab94e55df08e996a014f97d9e9ac9a0f7f6642',
    secondActor: '339f8f9ae9af0230a978a695b305d4ed0dd6c1e042f443d0dc68d6c1966e8117',
    failure: '76986f184abca2a8401c061a182848a39d7de7ba6b0e77186d1c24f706a35376',
    intents: '41064cfe968cf09b81e9f5e6b1bf41113ea78bc294b93358f4ff62438c6b8865',
    effect: 'f64247d69c2923415b1fd0313df61b5dc57f36abc5673b3c4f5e514556f4e260',
  },
});

export function validateNativeAccountSources(src, refs, session, namespace) {
  assert.deepEqual(Object.keys(refs).sort(), Object.keys(nativeAccountOriginal.hashes).sort());
  for (const [key, expected] of Object.entries(nativeAccountOriginal.hashes)) assert.equal(refs[key].sha256, expected, 'Original native source changed');
  assert.match(namespace, /^[A-Za-z0-9-]{1,40}$/u);
  assert.notEqual(namespace, nativeAccountOriginal.namespace);
  assert.equal(session.runId, namespace);
  assert.equal(session.model.name, nativeAccountOriginal.project);
  assert.equal(session.privateDir, '/srv/wasalx-fast/' + nativeAccountOriginal.project);
  assert.equal(src.manifest.namespace, nativeAccountOriginal.namespace);
  assert.equal(src.manifest.evidenceMode, 'simulated');
  assert.deepEqual(src.admission.candidate, nativeAccountOriginal.candidate);
  assert.equal(src.admission.project, session.model.name);
  assert.equal(src.effect.originalNamespace, nativeAccountOriginal.namespace);
  assert.equal(src.effect.project, session.model.name);
  assert.equal(src.effect.intentsSha256, refs.intents.sha256);
  assert.equal(src.effect.tenantRef, hash(session.tenantId));
  assert.equal(src.context.owner.actorRef, 'sha256:' + hash(session.ownerId));
  assert.equal(src.context.owner.tenantRef, 'sha256:' + hash(session.tenantId));
  assert.equal(src.context.owner.role, 'tenant_owner');
  const actor = src.secondActor.result;
  assert.equal(actor.tenantId, session.tenantId);
  assert.notEqual(actor.userId, session.ownerId);
  assert.equal(src.effect.actors.owner.actorRef, hash(session.ownerId));
  assert.equal(src.effect.actors.agent.actorRef, hash(actor.userId));
  assert.equal(src.effect.audit.actorRef, hash(session.ownerId));
  assert.equal(src.effect.audit.targetRef, hash(session.tenantId));
  assert.equal(src.effect.audit.action, 'team.native_access_enabled');
  assert.deepEqual(src.effect.audit.newValue, { enabled: true });
  assert(src.effect.audit.id && src.effect.audit.requestId);
  assert.equal(src.effect.laterReconcileAdoptionLifecycleCount, 0);
  assert.equal(src.failure.scenario, 'native-account-linking');
  assert.deepEqual(src.failure.sourceLocation, { path: 'scripts/release/simulation-native-account-linking.mjs', line: 71, column: 80 });
  const event = (phase, step) => one(src.intents.filter(row => row.phase === phase && (step === undefined || row.step === step)), 'Original native checkpoint');
  const denied = event('synthetic-request-failed', 'nonowner-enable-denial');
  assert.equal(denied.code, 'api-http'); assert.equal(denied.httpStatus, 403);
  const intent = event('native-account-linking-intent'), accepted = event('native-account-linking-accepted');
  assert.equal(intent.namespace, nativeAccountOriginal.namespace);
  assert.equal(intent.reviewCount, 2); assert.equal(accepted.status, 200);
  const times = [src.failure.startedAt, denied.at, intent.at, src.effect.audit.at, accepted.at, src.failure.finishedAt].map(Date.parse);
  assert(times.every(Number.isFinite) && times.every((value, index) => index === 0 || value >= times[index - 1]), 'Original event order changed');
  assert(!src.intents.some(row => ['native-link-suspend', 'native-link-restore'].includes(row.step)), 'An original lifecycle intent already exists');
  return { actor, reviewCount: intent.reviewCount, originalStartedAt: src.failure.startedAt };
}

export function validateNativeAccountRuntime(session, current) {
  assert(current && current.project === nativeAccountOriginal.project);
  assert.deepEqual(session.candidate, current.candidate);
  for (const value of Object.values(current.candidate)) assert.match(value, /^[a-f0-9]{40}$/u);
  assert.deepEqual(Object.keys(current.containers).sort(), Object.keys(session.containers).sort());
  assert.deepEqual(Object.keys(session.containers).sort(), ['portal', 'control-api', 'connector-worker', 'postgres', 'keycloak', 'zammad-nginx', 'zammad-railsserver', 'waha-gows'].sort());
  for (const [name, container] of Object.entries(session.containers)) {
    assert.equal(container.Id, current.containers[name].id);
    assert.equal(container.Image, current.containers[name].image);
    assert.equal(container.State.Running, true);
    assert.equal(container.Config.Labels['com.docker.compose.project'], current.project);
    assert.equal(container.Config.Labels['com.docker.compose.service'], name);
  }
  assert.equal(session.portalOrigin, current.portalOrigin);
  assert.equal(session.nativeOrigin, current.nativeOrigin);
  assert.equal(new URL(session.ownerPage.url()).origin, current.portalOrigin);
  assert.equal(new URL(session.capabilities.secondActor.page.url()).origin, current.portalOrigin);
  assert.match(current.nativePackage.native_package_sha256, /^[a-f0-9]{64}$/u);
  assert.match(current.nativePackage.candidate_commit_sha, /^[a-f0-9]{40}$/u);
  assert.match(current.nativePackage.candidate_tree_sha, /^[a-f0-9]{40}$/u);
}

async function refreshNativeAccountRuntime(session, current) {
  const inspected = JSON.parse(await session.run('docker', ['inspect', ...Object.values(current.containers).map(value => value.id)]));
  assert.equal(inspected.length, 8);
  const containers = Object.fromEntries(inspected.map(value => [value.Config.Labels['com.docker.compose.service'], value]));
  validateNativeAccountRuntime({ ...session, containers }, current);
}

export const nativeAccountSql = Object.freeze({
  settings: "SELECT s.native_membership_sync_enabled,t.state FROM tenant_settings s JOIN tenants t ON t.id=s.tenant_id WHERE s.tenant_id=$1",
  registry: 'SELECT id,state FROM zammad_instances WHERE tenant_id=$1 ORDER BY id',
  projections: 'SELECT p.user_id,p.oidc_subject,p.email,p.display_name,p.role,p.member_state,p.revision,p.applied_revision,p.native_user_id,p.requested_native_user_id,p.sync_state,p.zammad_instance_id,m.id AS member_id,m.version AS member_version,m.role AS current_role,m.state AS current_state FROM native_membership_projections p JOIN tenant_memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.user_id WHERE p.tenant_id=$1 ORDER BY p.user_id',
  enable: `SELECT id::text,actor_id,request_id,target_type,target_id,action,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,new_value FROM audit_events WHERE tenant_id=$1 AND action='team.native_access_enabled' ORDER BY created_at,id`,
  changes: "SELECT action FROM audit_events WHERE tenant_id=$1 AND created_at >= $2::timestamptz AND (action IN ('team.native_access_reconcile_requested','team.native_account_adoption_requested') OR (action='team.membership_updated' AND target_id=$3))",
});

export function validateNativeAccountRows(rows, effect, ownerId, agentId) {
  assert.equal(rows.projections.length, 2);
  assert.deepEqual(one(rows.settings, 'Tenant setting'), { native_membership_sync_enabled: true, state: 'ACTIVE' });
  const registry = one(rows.registry, 'Original native instance'); assert.equal(registry.state, 'WORKING');
  const enable = one(rows.enable, 'Original enable audit');
  assert.deepEqual({ id: enable.id, requestId: enable.request_id, at: enable.at, actorRef: hash(enable.actor_id), targetType: enable.target_type, targetRef: hash(enable.target_id), action: enable.action, newValue: enable.new_value }, effect.audit);
  assert.equal(rows.changes.length, 0, 'A later native intent requires separate reconciliation');
  return [ownerId, agentId].map((userId, index) => {
    const row = one(rows.projections.filter(value => value.user_id === userId), 'Bound native actor');
    const expected = effect.actors[index === 0 ? 'owner' : 'agent'];
    assert.equal(row.role, index === 0 ? 'tenant_owner' : 'agent');
    assert.equal(row.member_state, 'ACTIVE'); assert.equal(row.sync_state, 'READY');
    assert.equal(Number(row.revision), 1); assert.equal(Number(row.applied_revision), 1);
    assert.equal(row.zammad_instance_id, registry.id);
    const projection = [row.user_id, row.oidc_subject, row.email, row.display_name, row.role, row.member_state, Number(row.revision), Number(row.applied_revision), row.native_user_id, row.requested_native_user_id, row.sync_state, row.zammad_instance_id];
    const membership = [row.member_id, row.user_id, row.current_role, row.current_state, Number(row.member_version)];
    assert.equal(digest(projection), expected.projectionSha256, 'Original projection identity changed');
    assert.equal(digest(membership), expected.membershipSha256, 'Original membership changed');
    return row;
  });
}

const nativeRead = `require 'json';require 'digest';ids=JSON.parse(ENV.fetch('WASALX_NATIVE_USERS'));proof=Wasalx::InstalledPackage.verify!;rows=ids.map do |id|;list=WasalxMembership.where(portal_user_id:id).to_a;raise 'Native mapping ambiguous' unless list.length==1;m=list.first;u=User.find(m.user_id);{actorRef:Digest::SHA256.hexdigest(id),nativeIdRef:Digest::SHA256.hexdigest(u.id.to_s),tenantRef:Digest::SHA256.hexdigest(m.tenant_id),instanceRef:Digest::SHA256.hexdigest(m.instance_id),subjectRef:Digest::SHA256.hexdigest(m.subject),emailRef:Digest::SHA256.hexdigest(m.email),userEmailRef:Digest::SHA256.hexdigest(u.email),revision:m.revision,state:m.member_state,role:m.portal_role,payloadSha256:m.payload_sha256,active:u.active,roles:u.roles.map(&:name).sort,authorizationCount:u.authorizations.count,subjectCount:u.authorizations.where(provider:'openid_connect',uid:m.subject).count,mappingCount:WasalxMembership.where(user_id:u.id).count,automation:!!Wasalx::ServiceIdentity.automation?(u),allowed:Wasalx::MembershipAccess.allowed?(u)};end;puts JSON.generate({installed:proof,rows:rows})`;

export function validateNativeAccountMappings(observed, rows, tenantId, expectedPackage) {
  for (const key of ['candidate_commit_sha', 'candidate_tree_sha', 'native_package_sha256']) assert.equal(observed.installed[key], expectedPackage[key], 'Native installed source changed');
  assert.equal(observed.rows.length, 2);
  for (const row of rows) {
    const native = one(observed.rows.filter(value => value.actorRef === hash(row.user_id)), 'Native original mapping');
    for (const [key, value] of [['nativeIdRef', row.native_user_id], ['tenantRef', tenantId], ['instanceRef', row.zammad_instance_id], ['subjectRef', row.oidc_subject], ['emailRef', row.email], ['userEmailRef', row.email]]) assert.equal(native[key], hash(value));
    const payload = { tenant_id: tenantId, instance_id: row.zammad_instance_id, user_id: row.user_id, subject: row.oidc_subject, email: row.email, name: row.display_name, role: row.role, state: row.member_state, revision: Number(row.revision) };
    assert.equal(native.payloadSha256, digest(payload));
    assert.equal(Number(native.revision), 1); assert.equal(native.state, 'ACTIVE'); assert.equal(native.role, row.role);
    assert.equal(native.authorizationCount, 1); assert.equal(native.subjectCount, 1); assert.equal(native.mappingCount, 1);
    assert.deepEqual(native.roles, row.role === 'tenant_owner' ? ['Admin', 'Agent'] : ['Agent']);
    assert(native.active === true && native.allowed === true && native.automation === false);
  }
}

export async function claimNativeAccountContinuation(privateDir, effect, namespace) {
  // Original operation and actor pair determine the key. A new namespace cannot
  // create a second claim, and failures never remove the existing claim.
  const key = digest([effect.project, effect.audit.id, effect.audit.requestId, effect.tenantRef, effect.actors.owner.actorRef, effect.actors.agent.actorRef]);
  const handle = await open(join(privateDir, 'native-account-continuation-' + key + '.claim.json'), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ namespace, originalNamespace: effect.originalNamespace, enableAuditId: effect.audit.id, enableRequestId: effect.audit.requestId, at: new Date().toISOString(), disposition: 'reconcile-before-any-repeat' })); await handle.sync(); }
  finally { await handle.close(); }
  return key;
}

// Explicit existing owned-session callback only. No CLI, manifest builder,
// bootstrap, enable/reconcile action, database write, or automatic restoration.
export async function nativeAccountLinkingContinuationStage(s, { namespace, inputs, config }) {
  const startedAt = new Date().toISOString();
  const src = await loadRetainedDirectSources(s, config.sources);
  const prior = validateNativeAccountSources(src, config.sources, s, namespace);
  assert.equal(inputs.secondActor.userId, prior.actor.userId); assert.equal(inputs.secondActor.memberId, prior.actor.memberId);
  assert.equal(inputs.secondActor.tenantId, s.tenantId);
  assert.equal(s.capabilities.secondActor.userId, prior.actor.userId); assert.equal(s.capabilities.secondActor.memberId, prior.actor.memberId);
  assert.equal(s.capabilities.secondActor.subject, prior.actor.subject);
  validateNativeAccountRuntime(s, config.current);
  await refreshNativeAccountRuntime(s, config.current);
  assert.equal(s.containers.postgres.Id, src.effect.postgres.id); assert.equal(s.containers.postgres.Image, src.effect.postgres.image);
  const owner = await s.verifyOwner(s.ownerPage, s.ownerId, 'tenant_owner', s.tenantId);
  const agent = await s.verifyOwner(s.capabilities.secondActor.page, prior.actor.userId, 'agent', s.tenantId);
  assert(owner.userMatched && owner.workspaceMatched && agent.userMatched && agent.workspaceMatched);
  await s.ensurePrivilegedOwner();
  assert(/^en(?:[-_]|$)/iu.test(await s.ownerPage.evaluate(() => document.documentElement.lang)));
  await s.ownerPage.setViewportSize({ width: 1440, height: 1000 });
  assert.deepEqual(s.ownerPage.viewportSize(), { width: 1440, height: 1000 });
  const readRows = async () => ({ settings: await s.scoped(nativeAccountSql.settings, [s.tenantId]), registry: await s.scoped(nativeAccountSql.registry, [s.tenantId]), projections: await s.scoped(nativeAccountSql.projections, [s.tenantId]), enable: await s.scoped(nativeAccountSql.enable, [s.tenantId]), changes: await s.scoped(nativeAccountSql.changes, [s.tenantId, prior.originalStartedAt, prior.actor.memberId]) });
  const before = await readRows(), rows = validateNativeAccountRows(before, src.effect, s.ownerId, prior.actor.userId);
  const observed = parseRailsJson(await s.run('docker', ['exec', '-e', 'WASALX_NATIVE_USERS=' + JSON.stringify(rows.map(row => row.user_id)), s.containers['zammad-railsserver'].Id, 'bundle', 'exec', 'rails', 'runner', nativeRead]));
  validateNativeAccountMappings(observed, rows, s.tenantId, config.current.nativePackage);
  const readPortal = (timeoutMs = 5000) => s.ownerPage.evaluate(async timeoutMs => { const response = await fetch('/api/team/workspace-access', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) }); if (!response.ok) throw Error('Current workspace access unavailable'); return response.json(); }, timeoutMs);
  const readAgent = async () => one(await s.scoped('SELECT user_id,role,state,version FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2', [s.tenantId, prior.actor.userId]), 'Current agent');
  const status = await readPortal(), beforeAgent = await readAgent();
  assert.equal(status.enabled, true); assert.equal(status.members.length, 2);
  for (const row of rows) {
    const current = one(status.members.filter(value => value.user_id === row.user_id), 'Actual portal projection');
    assert.equal(current.sync_state, 'READY'); assert.equal(current.member_state, 'ACTIVE');
    assert.equal(Number(current.revision), 1); assert.equal(Number(current.applied_revision), 1); assert.equal(current.native_user_id, row.native_user_id);
  }
  assert.equal(beforeAgent.user_id, prior.actor.userId); assert.equal(beforeAgent.role, 'agent'); assert.equal(beforeAgent.state, 'ACTIVE'); assert.equal(Number(beforeAgent.version), src.effect.actors.agent.membershipVersion);
  validateNativeAccountRows(await readRows(), src.effect, s.ownerId, prior.actor.userId);
  await refreshNativeAccountRuntime(s, config.current);
  const claimKey = await claimNativeAccountContinuation(s.privateDir, src.effect, namespace);
  await s.checkpoint({ phase: 'retained-native-account-admitted', originalNamespace: nativeAccountOriginal.namespace, sourceHashes: nativeAccountOriginal.hashes, claimKey, noEnableReplay: true });
  return runNativeAccountLinkingChecks(s, { namespace, inputs, startedAt, readPortal, readAgent, beforeAgent, registry: before.registry, status, review: prior.reviewCount,
    retained: { namespace: nativeAccountOriginal.namespace, originalStartedAt: prior.originalStartedAt, originalCandidate: nativeAccountOriginal.candidate, sourceHashes: nativeAccountOriginal.hashes, enableAudit: src.effect.audit, claimKey, noEnableReplay: true } });
}
