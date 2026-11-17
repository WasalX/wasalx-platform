import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSyntheticRequest } from './seed-simulation-group.mjs';
import { parseRailsJson } from './simulation-rails-json.mjs';
import { waitForNativeProjectionSettlement } from './simulation-native-identity-contract.mjs';

export const nativeLinkTestId = 'team-access/roles-invitations-revocation-and-last-owner-protection::native-account-linking-requires-owner-review-and-current-membership::01';

// Proposed final fixture stage for a fresh, owned simulated tenant. It must run
// after existing team/routing producers: enabling projection is a one-way
// tenant lifecycle action and must not change their fixture assumptions.
export async function nativeAccountLinkingStage(s, { namespace, inputs }) {
  const startedAt = new Date().toISOString();
  assert(inputs.teamAccess?.results?.length, 'Completed role-wave fixture required');
  assert(inputs.secondActor?.userId && s.capabilities.secondActor?.userId === inputs.secondActor.userId);
  assert.equal(inputs.secondActor.tenantId, s.tenantId);
  const owner = await s.verifyOwner(s.ownerPage, s.ownerId, 'tenant_owner', s.tenantId);
  await s.ensurePrivilegedOwner();
  assert(owner.userMatched && owner.workspaceMatched);
  const locale = await s.ownerPage.evaluate(() => document.documentElement.lang);
  assert(/^en(?:[-_]|$)/iu.test(locale));
  await s.ownerPage.setViewportSize({ width: 1440, height: 1000 });
  const viewport = s.ownerPage.viewportSize();
  assert.deepEqual(viewport, { width: 1440, height: 1000 });
  const readPortal = (timeoutMs = 5000) => s.ownerPage.evaluate(async timeoutMs => {
    const response = await fetch('/api/team/workspace-access', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw Error('Actual workspace access unavailable');
    return response.json();
  }, timeoutMs);
  const original = await readPortal();
  assert.equal(original.enabled, false, 'Use a fresh owned tenant; do not replay opt-in');
  const registry = await s.scoped("SELECT id,state FROM zammad_instances WHERE tenant_id=$1 AND state='WORKING'", [s.tenantId]);
  assert.equal(registry.length, 1, 'Exactly one current native instance required');
  const agent = await s.verifyOwner(s.capabilities.secondActor.page, inputs.secondActor.userId, 'agent', s.tenantId);
  assert(agent.userMatched && agent.workspaceMatched);
  const readAgent = async () => {
    const rows = await s.scoped('SELECT user_id,role,state,version FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2', [s.tenantId, inputs.secondActor.userId]);
    assert.equal(rows.length, 1);
    return rows[0];
  };
  const beforeAgent = await readAgent();
  assert.equal(beforeAgent.role, 'agent');
  assert.equal(beforeAgent.state, 'ACTIVE');
  const denied = createSyntheticRequest({ page: s.capabilities.secondActor.page, origin: s.portalOrigin, runId: namespace + '-native-link-denial', checkpoint: s.checkpoint });
  await assert.rejects(() => denied('/api/team/workspace-access', 'POST', { action: 'enable' }, 'nonowner-enable-denial'), /HTTP 403;/);
  assert.equal((await readPortal()).enabled, false, 'Denied agent request changed opt-in');
  assert.deepEqual(await readAgent(), beforeAgent, 'Denied agent request changed membership');

  const review = await enableNativeWorkspaceAccessUi(s,{namespace,minimumReview:2});

  // UNAVAILABLE is committed before APPLY and can still be in flight. Read only;
  // the settlement deadline never queues, reconciles, or repeats that operation.
  const status = await waitForNativeProjectionSettlement(readPortal, [
    { userId: s.ownerId, memberState: 'ACTIVE', revision: 1 },
    { userId: inputs.secondActor.userId, memberState: 'ACTIVE', revision: 1 },
  ]);
  return runNativeAccountLinkingChecks(s, { namespace, inputs, startedAt, readPortal, readAgent, beforeAgent, registry, status, review });
}

// Shared post-enable checks. Only the fresh stage or explicitly admitted retained
// entrypoint calls this body; neither can repeat the original enable here.
export async function runNativeAccountLinkingChecks(s, { namespace, inputs, startedAt, readPortal, readAgent, beforeAgent, registry, status, review, retained }) {
  const viewport = s.ownerPage.viewportSize();
  assert.deepEqual(viewport, { width: 1440, height: 1000 });
  assert(status.enabled, 'Owner opt-in did not persist');
  const ownerProjected = status.members.filter(row => row.user_id === s.ownerId);
  assert.equal(ownerProjected.length, 1);
  assert.equal(ownerProjected[0].sync_state, 'READY', 'Human owner projection must be current before service handover');
  const projected = status.members.filter(row => row.user_id === inputs.secondActor.userId);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].sync_state, 'READY', 'Native projection has not settled');
  const rows = await s.scoped('SELECT user_id,oidc_subject,role,member_state,revision,applied_revision,native_user_id,sync_state,zammad_instance_id FROM native_membership_projections WHERE tenant_id=$1 AND user_id=$2', [s.tenantId, inputs.secondActor.userId]);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.sync_state, 'READY');
  assert.equal(row.member_state, 'ACTIVE');
  assert.equal(row.role, 'agent');
  assert.equal(Number(row.revision), Number(row.applied_revision));
  assert.equal(row.zammad_instance_id, registry[0].id);
  assert.equal(row.oidc_subject, s.capabilities.secondActor.subject);
  assert.deepEqual(await readAgent(), beforeAgent, 'Projection changed current membership');
  assert.match(String(row.native_user_id), /^[1-9][0-9]{0,15}$/u);
  const ruby = "require 'json';m=WasalxMembership.find_by!(portal_user_id:ENV.fetch('WASALX_USER_ID'));u=User.find(m.user_id);a=u.authorizations.where(provider:'openid_connect',uid:ENV.fetch('WASALX_SUBJECT')).count;puts JSON.generate({nativeUserId:u.id.to_s,tenantId:m.tenant_id,instanceId:m.instance_id,subject:m.subject,revision:m.revision,memberState:m.member_state,portalRole:m.portal_role,active:u.active,agent:u.roles.map(&:name).include?('Agent'),admin:u.roles.map(&:name).include?('Admin'),subjectMatches:a==1,interactive:Wasalx::MembershipAccess.allowed?(u)})";
  const native = parseRailsJson(await s.run('docker', ['exec', '-e', 'WASALX_USER_ID=' + row.user_id, '-e', 'WASALX_SUBJECT=' + row.oidc_subject, s.containers['zammad-railsserver'].Id, 'bundle', 'exec', 'rails', 'runner', ruby]));
  assert.equal(native.nativeUserId, String(row.native_user_id));
  assert.equal(native.tenantId, s.tenantId);
  assert.equal(native.instanceId, row.zammad_instance_id);
  assert.equal(native.subject, row.oidc_subject);
  assert.equal(native.memberState, beforeAgent.state);
  assert.equal(native.portalRole, beforeAgent.role);
  assert.equal(Number(native.revision), Number(row.revision));
  assert(native.active && native.agent && !native.admin && native.subjectMatches && native.interactive);
  const ownerRequest = createSyntheticRequest({ page: s.ownerPage, origin: s.portalOrigin, runId: namespace + '-native-link-lifecycle', checkpoint: s.checkpoint });
  const waitCurrent = async (memberState, revision) => {
    const latest = await waitForNativeProjectionSettlement(readPortal, [
      { userId: inputs.secondActor.userId, memberState, revision },
    ]);
    return latest.members.find(item => item.user_id === inputs.secondActor.userId);
  };
  const nativeAdmission = async () => parseRailsJson(await s.run('docker', ['exec', '-e', 'WASALX_USER_ID=' + row.user_id, s.containers['zammad-railsserver'].Id, 'bundle', 'exec', 'rails', 'runner', "require 'json';m=WasalxMembership.find_by!(portal_user_id:ENV.fetch('WASALX_USER_ID'));u=User.find(m.user_id);puts JSON.generate({nativeId:u.id.to_s,revision:m.revision,state:m.member_state,active:u.active,allowed:Wasalx::MembershipAccess.allowed?(u)})"]));
  const suspendBefore = await readAgent();
  assert.deepEqual(suspendBefore, beforeAgent, 'Membership changed before the first lifecycle effect');
  await ownerRequest('/api/team/members/' + inputs.secondActor.memberId, 'PATCH', { role: 'agent', state: 'SUSPENDED', expectedVersion: Number(suspendBefore.version) }, 'native-link-suspend');
  const suspended = await readAgent();
  assert.equal(suspended.state, 'SUSPENDED');
  assert.equal(Number(suspended.version), Number(suspendBefore.version) + 1);
  const suspendedProjection = await waitCurrent('SUSPENDED', Number(row.revision) + 1);
  const deniedNative = await nativeAdmission();
  assert.equal(deniedNative.nativeId, String(row.native_user_id));
  assert.equal(Number(deniedNative.revision), Number(suspendedProjection.revision));
  assert(deniedNative.state === 'SUSPENDED' && !deniedNative.active && !deniedNative.allowed);
  const browserDenial = await s.capabilities.secondActor.page.evaluate(async () => (await fetch('/api/connections', { cache: 'no-store', signal: AbortSignal.timeout(5000) })).status);
  assert([401, 403].includes(browserDenial));
  await ownerRequest('/api/team/members/' + inputs.secondActor.memberId, 'PATCH', { role: 'agent', state: 'ACTIVE', expectedVersion: Number(suspended.version) }, 'native-link-restore');
  const restored = await readAgent();
  assert.equal(restored.state, 'ACTIVE');
  assert.equal(Number(restored.version), Number(suspended.version) + 1);
  const restoredProjection = await waitCurrent('ACTIVE', Number(suspendedProjection.revision) + 1);
  assert.equal(String(restoredProjection.native_user_id), String(row.native_user_id));
  const admittedAgain = await nativeAdmission();
  assert.equal(admittedAgain.nativeId, String(row.native_user_id));
  assert.equal(Number(admittedAgain.revision), Number(restoredProjection.revision));
  assert(admittedAgain.state === 'ACTIVE' && admittedAgain.active && admittedAgain.allowed);
  if (retained) {
    await s.capabilities.secondActor.page.reload({ waitUntil: 'domcontentloaded' });
    const resumed = await s.verifyOwner(s.capabilities.secondActor.page, inputs.secondActor.userId, 'agent', s.tenantId);
    assert(resumed.userMatched && resumed.workspaceMatched);
  }
  const after = await s.verifyOwner(s.ownerPage, s.ownerId, 'tenant_owner', s.tenantId);
  assert(after.userMatched && after.workspaceMatched);
  const enableAudit = await s.scoped("SELECT id,actor_id,request_id FROM audit_events WHERE tenant_id=$1 AND action='team.native_access_enabled' AND target_id=$1 AND created_at >= $2::timestamptz ORDER BY created_at,id", [s.tenantId, retained?.originalStartedAt ?? startedAt]);
  assert.equal(enableAudit.length, 1);
  assert.equal(enableAudit[0].actor_id, s.ownerId);
  assert(enableAudit[0].request_id);
  if (retained) {
    assert.equal(enableAudit[0].id, retained.enableAudit.id);
    assert.equal(enableAudit[0].request_id, retained.enableAudit.requestId);
  }
  const lifecycleAudit = await s.scoped("SELECT id,actor_id,request_id,new_value FROM audit_events WHERE tenant_id=$1 AND action='team.membership_updated' AND target_id=$2 AND created_at >= $3::timestamptz ORDER BY created_at,id", [s.tenantId, inputs.secondActor.memberId, startedAt]);
  assert.equal(lifecycleAudit.length, 2);
  assert(lifecycleAudit.every(item => item.actor_id === s.ownerId && item.request_id));
  assert.deepEqual(lifecycleAudit.map(item => item.new_value.state), ['SUSPENDED', 'ACTIVE']);
  const digest = value => 'sha256:' + createHash('sha256').update(String(value)).digest('hex');
  const binding = { role: 'tenant_owner', locale: 'en', actorRef: digest(s.ownerId), tenantRef: digest(s.tenantId), viewport };
  return { namespace, tenantId: s.tenantId, ownerProjection: { userId: s.ownerId, nativeUserId: ownerProjected[0].native_user_id, revision: ownerProjected[0].revision }, results: [{ testId: nativeLinkTestId, contextId: 'tenant_owner-en-desktop', result: 'passed', startedAt, finishedAt: new Date().toISOString(), actorRef: binding.actorRef, tenantRef: binding.tenantRef, actualViewport: viewport, verifiedContext: binding, ...(retained ? { retainedProvenance: retained } : {}), proof: { actorVerified: true, ...(retained ? { originalPrefix: { ownerReviewCount: review, nonOwnerDenied: true, enabledOnce: true, sourceNamespace: retained.namespace } } : { ownerReviewCount: review, nonOwnerDenied: true }), optInEnabled: true, projectionReady: true, exactNativeIdentity: true, currentMembershipAdmitted: true, fencedOnSuspension: true, browserDeniedOnSuspension: true, sameNativeIdentityRestored: true, ...(retained ? { portalActorReactivated: true } : {}), ownerAuditCount: enableAudit.length, lifecycleAuditCount: lifecycleAudit.length } }] };
}

// Shared owner-review action. An uncertain response is held; this function never replays enable.
export async function enableNativeWorkspaceAccessUi(s,{namespace,minimumReview=2}) {
  assert(Number.isSafeInteger(minimumReview)&&minimumReview>=1&&minimumReview<=2);
  await s.ownerPage.goto(s.portalOrigin + '/app?view=team');
  const section = s.ownerPage.locator('section[aria-labelledby="workspace-access-title"]');
  await section.waitFor({ state: 'visible' });
  await section.locator('button.primary').click();
  const dialog = s.ownerPage.locator('.workspace-access-dialog');
  await dialog.waitFor({ state: 'visible' });
  const review = await dialog.locator('li').count();
  assert(review >= minimumReview, 'Owner review omitted accepted staff');
  await dialog.locator('input[type="checkbox"]').check();
  await s.checkpoint({ phase: 'native-account-linking-intent', namespace, reviewCount: review, at: new Date().toISOString() });
  const posted = s.ownerPage.waitForResponse(response => new URL(response.url()).pathname === '/api/team/workspace-access' && response.request().method() === 'POST');
  await dialog.locator('button.primary').click();
  const response = await posted;
  assert(response.ok(), 'Owner opt-in outcome requires reconciliation; never click twice blindly');
  await s.checkpoint({ phase: 'native-account-linking-accepted', status: response.status(), at: new Date().toISOString() });

  return review;
}
