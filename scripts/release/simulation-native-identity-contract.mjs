import assert from 'node:assert/strict';

const held = new Set(['UNAVAILABLE', 'CONFLICT', 'ADOPTION_REQUIRED', 'PROTECTED']);

export function assertNativeLoginDenial(status, contentType, body) {
  assert.equal(status, 200, 'Native login transport failed');
  assert(/^application\/json\b/iu.test(contentType ?? ''), 'Native login response is not JSON');
  assert(body && (!Object.hasOwn(body, 'errors') || (Array.isArray(body.errors) && body.errors.length === 0)), 'GraphQL infrastructure error');
  const result = body.data?.login;
  assert(result && result.session === null && result.twoFactorRequired === null && Array.isArray(result.errors) && result.errors.length > 0, 'Native credential denial missing');
  const messages = result.errors.map(error => String(error?.message ?? ''));
  assert(!messages.some(message => /csrf|authenticity|server|unavailable|timeout/iu.test(message)), 'Infrastructure failure is not credential denial');
  assert(messages.some(message => /incorrect|invalid|not authorized|forbidden|credential/iu.test(message)), 'Native credential error missing');
}

export function currentProjectionDisposition(status, userId) {
  assert(status?.enabled === true && Array.isArray(status.members), 'Native membership opt-in is not current');
  const rows = status.members.filter(row => row.user_id === userId);
  assert.equal(rows.length, 1, 'Expected exactly one current projection');
  const row = rows[0];
  if (held.has(row.sync_state)) return { kind: 'held', state: row.sync_state, noReplay: true };
  if (row.sync_state === 'READY') return { kind: 'ready', revision: Number(row.revision), nativeUserId: row.native_user_id };
  assert.equal(row.sync_state, 'PENDING', 'Unknown native projection state');
  return { kind: 'pending', noReplay: true };
}

// Observation only: the worker uses UNAVAILABLE for both its committed in-flight
// fence and a retained unknown outcome. A deadline preserves the latter as held.
export async function waitForNativeProjectionSettlement(read, expected, {
  timeoutMs = 60_000, pollMs = 500, now = Date.now,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  assert(typeof read === 'function' && Array.isArray(expected) && expected.length >= 1 && expected.length <= 2);
  assert.equal(new Set(expected.map(row => row.userId)).size, expected.length);
  for (const row of expected) {
    assert(typeof row.userId === 'string' && row.userId.length > 0);
    assert(['ACTIVE', 'SUSPENDED'].includes(row.memberState));
    assert(Number.isSafeInteger(row.revision) && row.revision >= 1);
  }
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000);
  assert(Number.isSafeInteger(pollMs) && pollMs > 0 && pollMs <= 500);
  const deadline = now() + timeoutMs;
  let unavailable = false;
  while (now() < deadline) {
    const status = await read(Math.max(1, Math.min(5000, deadline - now())));
    if (now() >= deadline) throw Error('Native read exceeded settlement deadline; preserve original intent; no replay');
    let ready = true;
    unavailable = false;
    for (const item of expected) {
      const disposition = currentProjectionDisposition(status, item.userId);
      const row = status.members.find(value => value.user_id === item.userId);
      assert.equal(Number(row.revision), item.revision, 'Native projection revision changed; preserve intent');
      assert.equal(row.member_state, item.memberState, 'Native membership changed; preserve intent');
      if (disposition.kind === 'held' && disposition.state !== 'UNAVAILABLE')
        throw Error('Native projection needs owner reconciliation: ' + disposition.state + '; no automatic replay');
      unavailable ||= disposition.state === 'UNAVAILABLE';
      if (disposition.kind === 'ready') {
        assert.equal(Number(row.applied_revision), item.revision, 'Native READY projection is stale');
        assert.match(String(row.native_user_id), /^[1-9][0-9]{0,15}$/u);
      } else ready = false;
    }
    if (ready) return status;
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }
  throw Error(unavailable
    ? 'Native projection remains UNAVAILABLE at settlement deadline; preserve original intent; no replay'
    : 'Native projection did not settle before deadline; preserve original intent; no replay');
}

export function assertHandoverPreconditions({ owner, legacy, installed }) {
  assert(owner?.state === 'READY' && owner.memberState === 'ACTIVE' && owner.role === 'tenant_owner');
  assert.equal(Number(owner.revision), Number(owner.appliedRevision));
  assert.match(String(owner.nativeUserId), /^[1-9][0-9]{0,15}$/u);
  assert(legacy?.active === true && legacy?.admin === true);
  assert.match(String(legacy.nativeUserId), /^[1-9][0-9]{0,15}$/u);
  assert.notEqual(String(legacy.nativeUserId), String(owner.nativeUserId));
  assert.match(String(legacy.oidcAuthorizationId), /^[1-9][0-9]{0,15}$/u, 'Synthetic bootstrap subject must be bound before initial native bootstrap');
  assert.match(String(legacy.oidcSubject), /^synthetic-[A-Za-z0-9_-]+$/u);
  assert.match(String(legacy.runtimeTokenId), /^[1-9][0-9]{0,15}$/u);
  assert.match(String(legacy.privacyTokenId), /^[1-9][0-9]{0,15}$/u);
  assert.notEqual(legacy.runtimeTokenId, legacy.privacyTokenId);
  assert.match(String(installed?.candidate_commit_sha), /^[a-f0-9]{40}$/u);
  assert.match(String(installed?.candidate_tree_sha), /^[a-f0-9]{40}$/u);
  assert.match(String(installed?.native_package_sha256), /^[a-f0-9]{64}$/u);
  return true;
}

export function buildGovernedHandoverInput({ action, operationId, tenantId, instanceId, owner, legacy, installed, expectedRevision, expectedReceiptSha256, expectedGroupGrantsSha256, verificationReceiptSha256 = null }) {
  assertHandoverPreconditions({ owner, legacy, installed });
  assert(['PREPARE', 'BIND', 'COMPLETE'].includes(action));
  assert.match(operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.match(tenantId, /^[0-9a-f-]{36}$/iu);
  assert.match(instanceId, /^[0-9a-f-]{36}$/iu);
  assert(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0);
  if (action === 'PREPARE') assert(expectedRevision === 0 && expectedReceiptSha256 === null);
  else assert.match(expectedReceiptSha256, /^[a-f0-9]{64}$/u);
  assert.match(expectedGroupGrantsSha256, /^[a-f0-9]{64}$/u);
  if (action === 'COMPLETE') assert.match(verificationReceiptSha256, /^[a-f0-9]{64}$/u);
  else assert.equal(verificationReceiptSha256, null);
  return {
    version: 1, action, operation_id: operationId, expected_revision: expectedRevision, expected_receipt_sha256: expectedReceiptSha256,
    tenant_id: tenantId, instance_id: instanceId, human_portal_user_id: owner.userId, human_native_user_id: String(owner.nativeUserId),
    human_subject: owner.subject, human_projection_revision: Number(owner.revision), legacy_native_user_id: String(legacy.nativeUserId),
    legacy_oidc_authorization_id: String(legacy.oidcAuthorizationId), legacy_subject: legacy.oidcSubject,
    runtime_token_id: String(legacy.runtimeTokenId), privacy_token_id: String(legacy.privacyTokenId),
    expected_runtime_scopes: ['ticket.agent', 'wasalx_service'], expected_privacy_scopes: ['wasalx_privacy'],
    expected_group_grants_sha256: expectedGroupGrantsSha256, candidate_commit_sha: installed.candidate_commit_sha,
    candidate_tree_sha: installed.candidate_tree_sha, native_package_sha256: installed.native_package_sha256,
    verification_receipt_sha256: verificationReceiptSha256,
  };
}
