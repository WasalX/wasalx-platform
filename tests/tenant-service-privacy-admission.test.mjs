import assert from 'node:assert/strict';
import test from 'node:test';
import { ZammadInternalController } from '../services/control-api/dist/zammad-internal.controller.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const instanceId = '20000000-0000-4000-8000-000000000001';
const jobId = '30000000-0000-4000-8000-000000000001';
const leaseId = '40000000-0000-4000-8000-000000000001';
const targetId = '50000000-0000-4000-8000-000000000001';
const request = { job_id: jobId, lease_id: leaseId, fencing_token: 2, target_id: targetId, operation: 'DELETE_TICKET', native_id: '42', attempt: 1 };
const target = { id: targetId, job_type: 'DELETE', stage: 'EXTERNAL', disposition: 'DELETE_TICKETS', target_type: 'ZAMMAD_TICKET', target_id: '42', state: 'PENDING', attempts: 1, external_operation_id: null, external_started_at: new Date(), held: false };
function fixture(row = target) {
  const calls = [];
  const controller = new ZammadInternalController({
    rows: async (tenant, sql, values) => {
      assert.equal(tenant, tenantId);
      assert.match(sql, /state='WORKING'/);
      assert.deepEqual(values, [tenantId, instanceId]);
      return [{ id: instanceId }];
    },
    withTenant: async (tenant, fn) => {
      assert.equal(tenant, tenantId);
      return fn({ query: async (sql, values) => {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT pg_advisory_xact_lock')) { assert.deepEqual(values, ['privacy:' + tenantId]); return { rows: [] }; }
        assert.match(sql, /tenant.state='ACTIVE'/);
        assert.match(sql, /job.state='RUNNING'/);
        assert.ok(sql.includes('job.lease_id=$3 AND job.fencing_token=$4'));
        assert.ok(sql.includes('job.lease_expires_at>=clock_timestamp()'));
        assert.match(sql, /FOR SHARE OF job,target/);
        assert.ok(sql.includes('app.has_applicable_privacy_hold(job.scope_type,job.scope_value)'));
        assert.ok(sql.includes('app.has_applicable_privacy_hold(target.target_type,target.target_id)'));
        assert.equal(values[0], tenantId);
        return { rows: row ? [row] : [] };
      } });
    },
  }, { verify: async (_auth, scope) => { assert.equal(scope, 'zammad:privacy'); return { tenantId, instanceId }; } }, {});
  return { controller, calls };
}

test('privacy admission binds exact tenant, live instance, durable lease and target', async () => {
  const { controller, calls } = fixture();
  assert.deepEqual(await controller.privacyAdmission('signed', request), { allowed: true, tenant_id: tenantId, instance_id: instanceId, job_id: jobId, target_id: targetId, operation: 'DELETE_TICKET', native_id: '42', source_native_id: '42' });
  assert.deepEqual(calls[1].values, [tenantId, jobId, leaseId, 2, targetId, '42', 'ZAMMAD_TICKET']);
  assert.equal((await fixture(null).controller.privacyAdmission('signed', request)).allowed, false);
});

test('destructive privacy denies hold, stale attempt, settled/unknown target and mismatched operation', async () => {
  for (const change of [{ held: true }, { attempts: 2 }, { state: 'COMPLETE' }, { state: 'FAILED_TERMINAL' }, { state: 'OUTCOME_UNKNOWN' }, { stage: 'DISCOVER' }, { target_id: '43' }, { target_type: 'ZAMMAD_USER' }, { disposition: 'EXPORT_ONLY' }, { external_started_at: null }]) {
    assert.equal((await fixture({ ...target, ...change }).controller.privacyAdmission('signed', request)).allowed, false, JSON.stringify(change));
  }
});

test('privacy export is read-only, manifest-bound and does not turn a legal hold into data erasure', async () => {
  const row = { ...target, job_type: 'EXPORT', stage: 'EXPORT', disposition: 'EXPORT_ONLY', attempts: 0, held: true, external_started_at: null };
  for (const operation of ['READ_TICKET', 'READ_ARTICLES']) {
    const input = { ...request, operation, attempt: 0 };delete input.target_id;
    const { controller, calls } = fixture(row);
    assert.equal((await controller.privacyAdmission('signed', input)).allowed, true);
    assert.deepEqual(calls[1].values, [tenantId, jobId, leaseId, 2, null, '42', 'ZAMMAD_TICKET']);
    assert.equal((await fixture(null).controller.privacyAdmission('signed', input)).allowed, false);
  }
  assert.equal((await fixture(row).controller.privacyAdmission('signed', request)).allowed, false);
});

test('native asynchronous user erasure admits only first intent and later polls exact persisted operation', async () => {
  const row = { ...target, disposition: 'ZAMMAD_USER_DATA_PRIVACY', target_type: 'ZAMMAD_USER', target_id: '19' };
  const create = { ...request, operation: 'CREATE_USER_TASK', native_id: '19' };
  assert.equal((await fixture(row).controller.privacyAdmission('signed', create)).allowed, true);
  for (const change of [{ held: true }, { external_operation_id: '8' }, { attempts: 2 }]) assert.equal((await fixture({ ...row, ...change }).controller.privacyAdmission('signed', create)).allowed, false);
  const polling = { ...row, external_operation_id: '7', held: true };
  assert.equal((await fixture(polling).controller.privacyAdmission('signed', { ...request, operation: 'READ_USER_TASK', native_id: '7' })).allowed, true);
  assert.equal((await fixture(polling).controller.privacyAdmission('signed', { ...request, operation: 'READ_USER_TASK', native_id: '8' })).allowed, false);
});

test('privacy operation inputs reject raw authority, missing identity and malformed numbers before querying job state', async () => {
  for (const change of [{ tenant_id: tenantId }, { job_id: '' }, { lease_id: '' }, { target_id: undefined }, { operation: 'DELETE_USER' }, { native_id: '0' }, { native_id: '900719925474099312345' }, { native_id: 42 }, { attempt: -1 }, { attempt: 1.5 }, { fencing_token: 0 }]) {
    const { controller, calls } = fixture();
    await assert.rejects(controller.privacyAdmission('signed', { ...request, ...change }), { status: 400 });
    assert.equal(calls.length, 0);
  }
});
