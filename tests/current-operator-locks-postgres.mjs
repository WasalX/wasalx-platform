import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { PrivacyController } from "../services/control-api/dist/privacy.controller.js";
import { PortalWorkspaceController } from "../services/control-api/dist/portal-workspace.controller.js";
import { TenantAdministrationController } from "../services/control-api/dist/tenant-administration.controller.js";

const principalFunction = "app.lock_current_operator_principal(uuid,text,text,text)";
const instanceFunction = "app.lock_current_working_zammad_instance(uuid)";
const sha = value => createHash("sha256").update(value).digest("hex");

// Reuse the gate's migrated isolated database; only these synthetic rows are owned.
export async function verifyCurrentOperatorLocks(adminUrl, appUrl, workerConfig) {
  const admin = new Client({ connectionString: adminUrl, statement_timeout: 15000 });
  const app = new Client({ connectionString: appUrl, statement_timeout: 15000, application_name: "wasalx-current-operator-locks" });
  const racer = new Client({ connectionString: adminUrl, statement_timeout: 15000 });
  const worker = new Client({ ...workerConfig, statement_timeout: 15000 });
  const writer = new Client({ connectionString: appUrl, statement_timeout: 15000, application_name: "wasalx-current-operator-writer" });
  const clients = [admin, app, racer, worker, writer];
  const connected = new Set();
  const withTenant = async (tenantId, work, client = app) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  };
  const database = { withTenant, rows: (tenantId, sql, values) => withTenant(tenantId, async client => (await client.query(sql, values)).rows) };
  let wakes = 0, nativeCalls = 0;
  const privacy = new PrivacyController(database, { wakePrivacy: async () => { wakes++; } }, {}, { privacyTarget: async () => { nativeCalls++; assert.fail("Local-scope checks cannot resolve a native target"); } });
  const portal = new PortalWorkspaceController(database, { resolveCredentials: async () => assert.fail("Settlement cannot resolve native credentials") });
  const ownedRoutingPairs = [];
  const ownedRoutingMatch = `EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb)
    AS owned(tenant_id uuid,zammad_instance_id uuid)
    WHERE owned.tenant_id=p.tenant_id AND owned.zammad_instance_id=p.zammad_instance_id)`;
  const undispatchedRouting = `p.sync_state='PENDING' AND p.safe_retry IS TRUE AND p.applied_revision=0
    AND p.desired_manifest IS NULL AND p.desired_sha256 IS NULL AND p.observed_sha256 IS NULL
    AND p.attempted_request IS NULL AND p.claim_id IS NULL AND p.claim_expires_at IS NULL
    AND p.last_checked_at IS NULL AND p.error_code IS NULL AND p.department_defaults='[]'::jsonb`;
  const routingFingerprint = async pairs => (await admin.query(`SELECT count(*)::integer AS count,
    encode(public.digest(COALESCE(string_agg(to_jsonb(p)::text,chr(10) ORDER BY p.tenant_id,p.zammad_instance_id),''),'sha256'),'hex') AS sha256
    FROM public.native_routing_projections p WHERE NOT ${ownedRoutingMatch}`, [JSON.stringify(pairs)])).rows[0];
  const cleanupRoutingPairs = async (pairs, beforeFingerprint) => {
    await admin.query("BEGIN");
    try {
      const values = [JSON.stringify(pairs)];
      const rows = (await admin.query(`SELECT p.tenant_id,p.zammad_instance_id,(${undispatchedRouting}) AS undispatched
        FROM public.native_routing_projections p WHERE ${ownedRoutingMatch} FOR UPDATE OF p NOWAIT`, values)).rows;
      assert(rows.every(row => row.undispatched === true), "Owned routing cleanup cannot remove dispatched or uncertain work");
      assert.deepEqual(await routingFingerprint(pairs), beforeFingerprint, "Unrelated routing rows changed before cleanup");
      const deleted = await admin.query(`DELETE FROM public.native_routing_projections p
        WHERE ${ownedRoutingMatch} AND ${undispatchedRouting}`, values);
      assert.equal(deleted.rowCount, rows.length, "Delete exactly the eligible owned routing rows");
      assert.equal((await admin.query(`SELECT count(*)::integer AS count FROM public.native_routing_projections p
        WHERE ${ownedRoutingMatch}`, values)).rows[0].count, 0);
      assert.deepEqual(await routingFingerprint(pairs), beforeFingerprint, "Unrelated routing rows changed during cleanup");
      await admin.query("COMMIT");
    } catch (error) {
      try { await admin.query("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Owned routing cleanup and rollback failed", { cause: error }); }
      throw error;
    }
  };
  const fixture = async ({ projection = false, standbyOwner = false } = {}) => {
    const tenantId = randomUUID(), userId = randomUUID(), instanceId = randomUUID();
    const subject = `principal-${userId}`, email = `${userId}@example.invalid`;
    await admin.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Principal lock fixture',$2,'ACTIVE')", [tenantId, `principal-${tenantId}`]);
    await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Synthetic owner')", [userId, subject, email]);
    await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')", [tenantId, userId]);
    if (standbyOwner) {
      const standbyId = randomUUID();
      await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Standby synthetic owner')", [standbyId, `principal-${standbyId}`, `${standbyId}@example.invalid`]);
      await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')", [tenantId, standbyId]);
    }
    await admin.query(`INSERT INTO zammad_instances(id,tenant_id,base_url,version,state,database_reference,search_namespace,storage_prefix,service_secret_reference,privacy_secret_reference)
      VALUES($1,$2,'https://native.invalid','7.1.3','WORKING','fixture://principal-lock',$3,$3,$4,$5)`,
    [instanceId, tenantId, `principal-${tenantId}`, `secret://tenants/${tenantId}/zammad/service`, `secret://tenants/${tenantId}/zammad/privacy`]);
    ownedRoutingPairs.push({ tenant_id: tenantId, zammad_instance_id: instanceId });
    let revision;
    if (projection) {
      await withTenant(tenantId, async client => {
        await client.query("SELECT app.enable_native_membership_sync($1)", [userId]);
        await client.query("UPDATE native_membership_projections SET zammad_instance_id=$3,sync_state='PROTECTED' WHERE tenant_id=$1 AND user_id=$2", [tenantId, userId, instanceId]);
      });
      revision = Number((await admin.query("SELECT revision FROM native_membership_projections WHERE tenant_id=$1 AND user_id=$2", [tenantId, userId])).rows[0].revision);
    }
    const principal = { tenantId, userId, subject, email, displayName: "Synthetic owner", role: "tenant_owner",
      authenticatedAt: Math.floor(Date.now() / 1000), authenticationMethods: ["mfa"] };
    const request = { id: `principal-${randomUUID()}`, principal };
    return { tenantId, userId, instanceId, principal, request, revision };
  };
  const lockPrincipal = (f, client = app, changes = {}) => {
    const principal = { ...f.principal, ...changes };
    return client.query("SELECT app.lock_current_operator_principal($1,$2,$3,$4) AS role", [principal.userId, principal.subject, principal.email, principal.role]);
  };
  const lockInstance = (instanceId, client = app) => client.query("SELECT app.lock_current_working_zammad_instance($1) AS locked", [instanceId]);
  const counts = async f => (await admin.query(`SELECT
    (SELECT count(*)::int FROM privacy_requests WHERE tenant_id=$1) AS requests,
    (SELECT count(*)::int FROM privacy_jobs WHERE tenant_id=$1) AS jobs,
    (SELECT count(*)::int FROM privacy_legal_holds WHERE tenant_id=$1) AS holds,
    (SELECT count(*)::int FROM bot_flow_operations WHERE tenant_id=$1) AS operations,
    (SELECT count(*)::int FROM audit_events WHERE tenant_id=$1) AS audits`, [f.tenantId])).rows[0];
  const waitBlocked = async (pid, blockerPid, advisory = false) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const row = (await admin.query("SELECT $2::integer=ANY(pg_blocking_pids(pid)) AS blocked, wait_event_type, lower(wait_event) AS event FROM pg_stat_activity WHERE pid=$1", [pid, blockerPid])).rows[0];
      if (row?.blocked && row.wait_event_type === "Lock" && (!advisory || row.event === "advisory")) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail("Owned operation did not reach the expected PostgreSQL lock wait");
  };
  const isNowait = error => error?.code === "55P03" && /could not obtain lock/u.test(error.message ?? "");
  let pending, background = [], routingBefore, primaryFailure, primaryFailed = false, verificationResult;
  const cleanupFailures = [];
  const settleOwnedWork = async () => {
    const rollbacks = await Promise.allSettled([racer, app, writer].filter(client => connected.has(client)).map(client => client.query("ROLLBACK")));
    const work = await Promise.allSettled([...(pending ? [pending] : []), ...background]);
    pending = undefined; background = [];
    const rollbackFailures = rollbacks.filter(result => result.status === "rejected").map(result => result.reason);
    const terminalFailures = work.flatMap(result => result.status === "rejected" ? [result.reason]
      : result.value?.error ? [result.value.error] : []);
    if (rollbackFailures.length) throw new AggregateError([...rollbackFailures, ...terminalFailures], "Owned principal-lock rollback did not establish quiescence");
    return terminalFailures;
  };
  try {
    const connections = await Promise.allSettled(clients.map(async client => { await client.connect(); connected.add(client); }));
    const failures = connections.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "Owned principal-lock PostgreSQL clients could not connect");
    await Promise.all([app, writer, racer].map(client => client.query("SET lock_timeout=0")));
    routingBefore = await routingFingerprint([]);
    const deliberateFailure = new Error("Synthetic owned routing cleanup failure-path probe");
    await assert.rejects(async () => {
      await fixture();
      const probePair = ownedRoutingPairs.at(-1);
      assert(probePair);
      assert.equal((await admin.query(`SELECT count(*)::integer AS count FROM public.native_routing_projections p
        WHERE ${ownedRoutingMatch}`, [JSON.stringify([probePair])])).rows[0].count, 1);
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.tenant_id',$1,true)", [probePair.tenant_id]);
      assert.equal((await app.query("SELECT tenant_id FROM public.native_routing_projections WHERE tenant_id=$1 AND zammad_instance_id=$2 FOR UPDATE",
        [probePair.tenant_id, probePair.zammad_instance_id])).rowCount, 1);
      try { throw deliberateFailure; }
      catch (error) {
        let terminalFailures = [];
        try {
          terminalFailures = await settleOwnedWork();
          await cleanupRoutingPairs([probePair], routingBefore);
          ownedRoutingPairs.splice(ownedRoutingPairs.indexOf(probePair), 1);
        } catch (cleanupError) { throw new AggregateError([error, ...terminalFailures, cleanupError], "Failure-path probe and owned routing cleanup failed", { cause: error }); }
        if (terminalFailures.length) throw new AggregateError([error, ...terminalFailures], "Failure-path probe tracked work failed", { cause: error });
        throw error;
      }
    }, error => { if (error !== deliberateFailure) throw error; return true; });
    const appIdentity = (await app.query(`SELECT current_user,rolsuper,rolbypassrls,
      pg_has_role(current_user,'wasalx_app','MEMBER') AS app_member,
      pg_has_role(current_user,'wasalx_tenant_admin_writer','MEMBER') AS writer_member,
      pg_has_role(current_user,'wasalx_provisioning_executor','MEMBER') AS provisioning_member
      FROM pg_roles WHERE rolname=current_user`)).rows[0];
    assert.deepEqual(appIdentity, { current_user: "wasalx_runtime", rolsuper: false, rolbypassrls: false, app_member: true, writer_member: false, provisioning_member: false });
    const appPid = (await app.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const racerPid = (await racer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    assert.equal((await writer.query("SELECT current_user AS role")).rows[0].role, "wasalx_runtime");
    for (const [signature, owner] of [[principalFunction, "wasalx_tenant_admin_writer"], [instanceFunction, "wasalx_provisioning_executor"]]) {
      const metadata = (await admin.query(`SELECT p.prosecdef,p.provolatile,r.rolname AS owner,p.proconfig,
        has_function_privilege('wasalx_app',p.oid,'EXECUTE') AS app_execute,
        has_function_privilege('wasalx_connector_worker',p.oid,'EXECUTE') AS worker_execute,
        EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
        FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure`, [signature])).rows[0];
      assert.deepEqual(metadata, { prosecdef: true, provolatile: "v", owner, proconfig: ["search_path=pg_catalog, public, app", "row_security=off"], app_execute: true, worker_execute: false, public_execute: false });
    }
    const settlement = async (f, request = f.request, capturedChanges = {}, proofChanges = {}) => {
      const captured = { instance_id: f.instanceId, native_user_id: null, revision: f.revision, ...capturedChanges };
      const proof = { portal_user_id: f.userId, native_user_id: "12", revision: f.revision, subject_sha256: sha(f.principal.subject), email_sha256: sha(f.principal.email), identity_receipt_sha256: "a".repeat(64), ...proofChanges };
      return portal.settleOwnerProjection(request, captured, { state: "APPLIED", owner_projection: proof }, { operation: "IDENTITY_INITIALIZE", input: {} });
    };
    const f = await fixture({ standbyOwner: true }), foreign = await fixture();
    for (const [sql, values] of [
      ["SELECT app.lock_current_operator_principal($1,$2,$3,$4)", [f.userId, f.principal.subject, f.principal.email, f.principal.role]],
      ["SELECT app.lock_current_working_zammad_instance($1)", [f.instanceId]],
    ]) {
      await assert.rejects(() => worker.query(sql, values), { code: "42501" });
      await assert.rejects(() => app.query(sql, values), { code: "42501" });
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.tenant_id','',true)");
      await assert.rejects(() => app.query(sql, values), { code: "42501" });
      await app.query("ROLLBACK");
    }
    for (const table of ["users", "tenants", "tenant_settings", "zammad_instances"]) {
      for (const role of ["wasalx_app", "wasalx_runtime"]) {
        assert.equal((await admin.query("SELECT has_any_column_privilege($1,$2,'UPDATE') AS writable", [role, `public.${table}`])).rows[0].writable, false);
      }
    }
    for (const sql of [
      "SELECT id FROM users WHERE id=$1 FOR SHARE",
      "UPDATE users SET display_name=display_name WHERE id=$1",
      "DELETE FROM users WHERE id=$1",
      "INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,'forged-principal','forged-principal@example.invalid','Forged')",
      "UPDATE tenants SET name=name WHERE id=$1",
      "UPDATE tenant_settings SET privileged_reauth_minutes=privileged_reauth_minutes WHERE tenant_id=$1",
      "UPDATE zammad_instances SET state=state WHERE tenant_id=$1",
    ]) await assert.rejects(() => withTenant(f.tenantId, client => client.query(sql, [sql.includes("users") ? f.userId : f.tenantId])), { code: "42501" });
    for (const table of ["tenant_memberships", "tenant_settings", "zammad_instances"]) {
      assert.deepEqual((await admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass", [`public.${table}`])).rows[0], { relrowsecurity: true, relforcerowsecurity: true });
    }
    await withTenant(f.tenantId, async client => {
      assert.deepEqual((await lockPrincipal(f, client)).rows, [{ role: "tenant_owner" }]);
      assert.deepEqual((await lockInstance(f.instanceId, client)).rows, [{ locked: true }]);
      for (const changes of [{ userId: randomUUID() }, { subject: "different" }, { email: "different@example.invalid" }, { role: "tenant_admin" }]) {
        assert.deepEqual((await lockPrincipal(f, client, changes)).rows, [{ role: null }]);
      }
      assert.deepEqual((await lockInstance(randomUUID(), client)).rows, [{ locked: false }]);
      assert.deepEqual((await lockInstance(foreign.instanceId, client)).rows, [{ locked: false }]);
      await privacy.requirePrivacyPrincipal(client, f.request, "privacy:export", "principal lock regression");
    });
    await withTenant(foreign.tenantId, async client => assert.deepEqual((await lockPrincipal(f, client)).rows, [{ role: null }]));
    for (const [change, restore, values] of [
      ["UPDATE tenant_memberships SET state='SUSPENDED' WHERE tenant_id=$1 AND user_id=$2", "UPDATE tenant_memberships SET state='ACTIVE' WHERE tenant_id=$1 AND user_id=$2", [f.tenantId, f.userId]],
      ["UPDATE tenants SET state='SUSPENDED' WHERE id=$1", "UPDATE tenants SET state='ACTIVE' WHERE id=$1", [f.tenantId]],
    ]) {
      await admin.query(change, values);
      await withTenant(f.tenantId, async client => assert.deepEqual((await lockPrincipal(f, client)).rows, [{ role: null }]));
      await admin.query(restore, values);
    }
    await admin.query("UPDATE zammad_instances SET state='PAUSED' WHERE id=$1", [f.instanceId]);
    await withTenant(f.tenantId, async client => assert.deepEqual((await lockInstance(f.instanceId, client)).rows, [{ locked: false }]));
    await admin.query("UPDATE zammad_instances SET state='WORKING' WHERE id=$1", [f.instanceId]);
    const missingSettings = await fixture();
    await admin.query("DELETE FROM tenant_settings WHERE tenant_id=$1", [missingSettings.tenantId]);
    await withTenant(missingSettings.tenantId, async client => assert.deepEqual((await lockPrincipal(missingSettings, client)).rows, [{ role: null }]));

    // SHARE locks from each helper must outlive the function call and protect the caller transaction.
    for (const [sql, values] of [
      ["UPDATE users SET display_name=display_name WHERE id=$1", [f.userId]],
      ["UPDATE tenants SET name=name WHERE id=$1", [f.tenantId]],
      ["UPDATE tenant_memberships SET state=state WHERE tenant_id=$1 AND user_id=$2", [f.tenantId, f.userId]],
      ["UPDATE tenant_settings SET version=version WHERE tenant_id=$1", [f.tenantId]],
      ["UPDATE zammad_instances SET state=state WHERE id=$1", [f.instanceId]],
    ]) {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenantId]);
      await lockPrincipal(f); await lockInstance(f.instanceId);
      pending = racer.query(sql, values).then(value => ({ value }), error => ({ error }));
      await waitBlocked(racerPid, appPid);
      await app.query("COMMIT");
      const result = await pending; pending = undefined;
      if (result.error) throw result.error;
      assert.equal(result.value.rowCount, 1);
    }

    // Contended rows fail immediately without creating another row-lock wait edge.
    for (const [sql, values, instance] of [
      ["SELECT id FROM users WHERE id=$1 FOR UPDATE", [f.userId], false],
      ["SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [f.tenantId], false],
      ["SELECT user_id FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE", [f.tenantId, f.userId], false],
      ["SELECT tenant_id FROM tenant_settings WHERE tenant_id=$1 FOR UPDATE", [f.tenantId], false],
      ["SELECT id FROM zammad_instances WHERE id=$1 FOR UPDATE", [f.instanceId], true],
    ]) {
      const before = await counts(f);
      await racer.query("BEGIN"); await racer.query(sql, values);
      await assert.rejects(() => withTenant(f.tenantId, client => instance ? lockInstance(f.instanceId, client) : lockPrincipal(f, client)), isNowait);
      if (!instance) await assert.rejects(() => withTenant(f.tenantId, client => privacy.requirePrivacyPrincipal(client, f.request, "privacy:export", "principal contention regression")),
        error => error.getStatus?.() === 409 && error.getResponse?.().code === "CURRENT_PRINCIPAL_BUSY");
      await racer.query("ROLLBACK");
      assert.deepEqual(await counts(f), before);
      await withTenant(f.tenantId, async client => { assert.equal((await lockPrincipal(f, client)).rows[0].role, "tenant_owner"); assert.equal((await lockInstance(f.instanceId, client)).rows[0].locked, true); });
    }
    const changedIdentity = await fixture();
    await racer.query("BEGIN");
    await racer.query("UPDATE users SET oidc_subject=$2 WHERE id=$1", [changedIdentity.userId, `changed-${randomUUID()}`]);
    await assert.rejects(() => withTenant(changedIdentity.tenantId, client => lockPrincipal(changedIdentity, client)), isNowait);
    await racer.query("COMMIT");
    await withTenant(changedIdentity.tenantId, async client => assert.deepEqual((await lockPrincipal(changedIdentity, client)).rows, [{ role: null }]));
    const changedInstance = await fixture();
    await racer.query("BEGIN");
    await racer.query("UPDATE zammad_instances SET state='PAUSED' WHERE id=$1", [changedInstance.instanceId]);
    await assert.rejects(() => withTenant(changedInstance.tenantId, client => lockInstance(changedInstance.instanceId, client)), isNowait);
    await racer.query("COMMIT");
    await withTenant(changedInstance.tenantId, async client => assert.deepEqual((await lockInstance(changedInstance.instanceId, client)).rows, [{ locked: false }]));
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenantId]);
    await lockInstance(f.instanceId);
    await racer.query("BEGIN");
    assert.equal((await racer.query("UPDATE zammad_instances SET state=state WHERE id=$1", [foreign.instanceId])).rowCount, 1, "An unrelated instance remains writable while the selected instance is locked");
    await racer.query("ROLLBACK"); await app.query("COMMIT");

    // Owner demotion holds the other member before upgrading tenant SHARE to UPDATE.
    const owners = await fixture(), otherOwnerId = randomUUID();
    await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Other synthetic owner')", [otherOwnerId, `principal-${otherOwnerId}`, `${otherOwnerId}@example.invalid`]);
    const otherMembership = (await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner') RETURNING id,version", [owners.tenantId, otherOwnerId])).rows[0];
    const otherOwner = { ...owners, principal: { ...owners.principal, userId: otherOwnerId, subject: `principal-${otherOwnerId}`, email: `${otherOwnerId}@example.invalid` } };
    const team = new TenantAdministrationController({ withTenant: (tenantId, work) => withTenant(tenantId, work, writer) }, null, null, { wake: () => {} });
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.tenant_id',$1,true)", [owners.tenantId]);
    await lockPrincipal(owners);
    pending = team.updateMember(owners.request, otherMembership.id, { role: "agent", state: "ACTIVE", expectedVersion: Number(otherMembership.version) }).then(value => ({ value }), error => ({ error }));
    await waitBlocked(writerPid, appPid);
    await assert.rejects(() => lockPrincipal(otherOwner), isNowait);
    await app.query("ROLLBACK");
    const demoted = await pending; pending = undefined;
    if (demoted.error) throw demoted.error;
    assert.equal(demoted.value.role, "agent"); assert.equal(demoted.value.state, "ACTIVE");
    assert.equal((await admin.query("SELECT count(*)::int AS owners FROM tenant_memberships WHERE tenant_id=$1 AND role='tenant_owner' AND state='ACTIVE'", [owners.tenantId])).rows[0].owners, 1);
    assert.equal((await admin.query("SELECT count(*)::int AS audits FROM audit_events WHERE tenant_id=$1 AND action='team.membership_updated'", [owners.tenantId])).rows[0].audits, 1);
    await withTenant(owners.tenantId, async client => assert.deepEqual((await lockPrincipal(otherOwner, client)).rows, [{ role: null }]));

    // The former three-writer cycle must unwind through NOWAIT, never deadlock detection.
    const cycle = await fixture(), secondUser = randomUUID();
    await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Second synthetic owner')", [secondUser, `principal-${secondUser}`, `${secondUser}@example.invalid`]);
    await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [cycle.tenantId, secondUser]);
    const second = { ...cycle, principal: { ...cycle.principal, userId: secondUser, subject: `principal-${secondUser}`, email: `${secondUser}@example.invalid`, role: "agent" } };
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.tenant_id',$1,true)", [cycle.tenantId]);
    assert.equal((await lockPrincipal(cycle)).rows[0].role, "tenant_owner");
    await racer.query("BEGIN");
    await racer.query("SELECT user_id FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE", [cycle.tenantId, secondUser]);
    await writer.query("BEGIN");
    await writer.query("SELECT set_config('app.tenant_id',$1,true)", [cycle.tenantId]);
    await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`native-membership:${cycle.tenantId}`]);
    const enabling = writer.query("SELECT app.enable_native_membership_sync($1) AS enabled", [cycle.userId]).then(value => ({ value }), error => ({ error }));
    background = [enabling];
    await waitBlocked(writerPid, appPid);
    const changingMember = racer.query("UPDATE tenant_memberships SET state='SUSPENDED' WHERE tenant_id=$1 AND user_id=$2", [cycle.tenantId, secondUser]).then(value => ({ value }), error => ({ error }));
    background.push(changingMember);
    await waitBlocked(racerPid, writerPid, true);
    await assert.rejects(() => lockPrincipal(second), isNowait);
    await app.query("ROLLBACK");
    const enabled = await enabling;
    if (enabled.error) throw enabled.error;
    assert.equal(enabled.value.rows[0].enabled, true);
    await writer.query("COMMIT");
    const changedMember = await changingMember;
    if (changedMember.error) throw changedMember.error;
    assert.equal(changedMember.value.rowCount, 1);
    await racer.query("COMMIT"); background = [];
    assert.equal((await admin.query("SELECT member_state FROM native_membership_projections WHERE tenant_id=$1 AND user_id=$2", [cycle.tenantId, secondUser])).rows[0].member_state, "SUSPENDED");

    // Provisioning may own instance first; principal admission must not wait back on it.
    const provision = await fixture({ projection: true });
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.tenant_id',$1,true)", [provision.tenantId]);
    await lockPrincipal(provision);
    await racer.query("BEGIN");
    await racer.query("SELECT id FROM zammad_instances WHERE id=$1 FOR UPDATE", [provision.instanceId]);
    pending = racer.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1", [provision.tenantId]).then(value => ({ value }), error => ({ error }));
    await waitBlocked(racerPid, appPid);
    await assert.rejects(() => lockInstance(provision.instanceId), isNowait);
    await app.query("ROLLBACK");
    const suspended = await pending; pending = undefined;
    if (suspended.error) throw suspended.error;
    assert.equal(suspended.value.rowCount, 1);
    await racer.query("COMMIT");
    await assert.rejects(() => settlement(provision));
    assert.equal((await counts(provision)).audits, 0);
    await admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1", [provision.tenantId]);
    assert.equal(await settlement(provision), "12", "The original setup proof recovers after provisioning settles");

    // Both original admission waits precede current authority and receipt readback.
    for (const waitKind of ["privacy", "operation"]) {
      const changed = await fixture({ standbyOwner: true }), key = `principal-wait-${randomUUID()}`;
      const created = await privacy.createRequest(changed.request, key, { requestType: "EXPORT", scopeType: "TENANT", scopeValue: changed.tenantId });
      assert.ok(created.id);
      const before = await counts(changed), wakesBefore = wakes;
      await racer.query("BEGIN");
      const lockKey = waitKind === "privacy" ? `privacy:${changed.tenantId}` : `bot-flow:${changed.tenantId}:${key}`;
      await racer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey]);
      pending = privacy.receipt(changed.request, { kind: "EXPORT", operationId: key, action: "LOOKUP" }).then(value => ({ value }), error => ({ error }));
      await waitBlocked(appPid, racerPid, true);
      await admin.query("UPDATE tenant_memberships SET role='agent' WHERE tenant_id=$1 AND user_id=$2", [changed.tenantId, changed.userId]);
      await racer.query("COMMIT");
      const result = await pending; pending = undefined;
      assert.equal(result.error?.getStatus?.(), 403);
      assert.deepEqual(await counts(changed), before);
      assert.equal(wakes, wakesBefore); assert.equal(nativeCalls, 0);
    }

    // Advisory waits still precede a fresh current policy read; row locks themselves never wait.
    const policy = await fixture(), oldRequest = { ...policy.request, principal: { ...policy.principal, authenticatedAt: Math.floor(Date.now() / 1000) - 600 } };
    await admin.query("UPDATE tenant_settings SET privileged_reauth_minutes=120 WHERE tenant_id=$1", [policy.tenantId]);
    const policyKey = `principal-policy-${randomUUID()}`;
    const policyCreated = await privacy.createRequest(oldRequest, policyKey, { requestType: "EXPORT", scopeType: "TENANT", scopeValue: policy.tenantId });
    const policyBefore = await counts(policy), policyWakes = wakes;
    await racer.query("BEGIN");
    await racer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`privacy:${policy.tenantId}`]);
    pending = privacy.receipt(oldRequest, { kind: "EXPORT", operationId: policyKey, action: "LOOKUP" }).then(value => ({ value }), error => ({ error }));
    await waitBlocked(appPid, racerPid, true);
    await admin.query("UPDATE tenant_settings SET privileged_reauth_minutes=5 WHERE tenant_id=$1", [policy.tenantId]);
    await racer.query("COMMIT");
    const policyResult = await pending; pending = undefined;
    assert.equal(policyResult.error?.getResponse?.().code, "REAUTHENTICATION_REQUIRED");
    assert.deepEqual(await counts(policy), policyBefore);
    assert.equal(wakes, policyWakes); assert.equal(nativeCalls, 0);
    assert.deepEqual(await privacy.receipt(policy.request, { kind: "EXPORT", operationId: policyKey, action: "LOOKUP" }), { state: "APPLIED", id: policyCreated.id });

    const mirrorMetadata = (await admin.query(`SELECT p.prosecdef,p.provolatile,r.rolname AS owner,p.proconfig,
      has_function_privilege('wasalx_app',p.oid,'EXECUTE') AS app_execute,
      has_function_privilege('wasalx_connector_worker',p.oid,'EXECUTE') AS worker_execute,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute,
      t.tgtype::integer AS trigger_type,t.tgenabled,t.tgname,t.tgqual IS NULL AS unconditional,
      ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::smallint[]) attribute(num) JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=attribute.num ORDER BY a.attname) AS update_columns
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_trigger t ON t.tgfoid=p.oid
      WHERE p.oid='app.sync_tenant_retention_days()'::regprocedure AND t.tgrelid='public.retention_policies'::regclass AND NOT t.tgisinternal`)).rows;
    assert.deepEqual(mirrorMetadata, [{ prosecdef: true, provolatile: "v", owner: "wasalx_provisioning_executor", proconfig: ["search_path=pg_catalog, public, app", "row_security=off"],
      app_execute: false, worker_execute: false, public_execute: false, trigger_type: 17, tgenabled: "O", tgname: "retention_policy_tenant_projection", unconditional: true, update_columns: ["resolved_case_days"] }]);
    await assert.rejects(() => app.query("SELECT app.sync_tenant_retention_days()"), { code: "42501" });
    await assert.rejects(() => worker.query("SELECT app.sync_tenant_retention_days()"), { code: "42501" });
    const policySnapshot = async f => (await admin.query(`SELECT to_jsonb(p) AS policy,to_jsonb(t) AS tenant,
      (SELECT count(*)::int FROM audit_events WHERE tenant_id=p.tenant_id AND action='privacy.retention_policy_updated') AS audits
      FROM retention_policies p JOIN tenants t ON t.id=p.tenant_id WHERE p.tenant_id=$1`, [f.tenantId])).rows[0];
    const policyOwner = await fixture(), policyForeign = await fixture();
    const initialPolicy = await policySnapshot(policyOwner), foreignPolicy = await policySnapshot(policyForeign), beforeSaveWakes = wakes;
    const policyBody = { state: "ACTIVE", resolvedCaseDays: 37, includeOpenCases: false, mediaDays: 31, unmatchedDiagnosticHours: 24, exportTtlHours: 24, expectedVersion: Number(initialPolicy.policy.version) };
    const savedPolicy = await privacy.updatePolicy(policyOwner.request, policyBody);
    assert.equal(Number(savedPolicy.version), policyBody.expectedVersion + 1);
    let savedSnapshot = await policySnapshot(policyOwner);
    assert.equal(savedSnapshot.policy.resolved_case_days, 37); assert.equal(savedSnapshot.tenant.retention_days, 37);
    assert.equal(savedSnapshot.audits, initialPolicy.audits + 1); assert.equal(wakes, beforeSaveWakes + 1);
    await assert.rejects(() => privacy.updatePolicy(policyOwner.request, policyBody), error => error.getStatus?.() === 409);
    assert.deepEqual(await policySnapshot(policyOwner), savedSnapshot); assert.equal(wakes, beforeSaveWakes + 1);
    const foreignRequest = { ...policyOwner.request, principal: { ...policyOwner.principal, tenantId: policyForeign.tenantId } };
    await assert.rejects(() => privacy.updatePolicy(foreignRequest, { ...policyBody, expectedVersion: Number(foreignPolicy.policy.version) }), error => error.getStatus?.() === 403);
    assert.deepEqual(await policySnapshot(policyForeign), foreignPolicy); assert.deepEqual(await policySnapshot(policyOwner), savedSnapshot);
    await admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1", [policyOwner.tenantId]);
    const suspendedPolicy = await policySnapshot(policyOwner);
    await assert.rejects(() => privacy.updatePolicy(policyOwner.request, { ...policyBody, expectedVersion: Number(savedPolicy.version) }), error => error.getStatus?.() === 403);
    assert.deepEqual(await policySnapshot(policyOwner), suspendedPolicy);
    await admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1", [policyOwner.tenantId]);

    // Compatible principal SHARE locks can still block the trigger's stronger tenant lock.
    savedSnapshot = await policySnapshot(policyOwner);
    const busyBody = { ...policyBody, resolvedCaseDays: 38, expectedVersion: Number(savedSnapshot.policy.version) }, beforeBusyWakes = wakes;
    await racer.query("BEGIN");
    await racer.query("SELECT id FROM tenants WHERE id=$1 FOR SHARE", [policyOwner.tenantId]);
    await assert.rejects(() => privacy.updatePolicy(policyOwner.request, busyBody),
      error => error.getStatus?.() === 409 && error.getResponse?.().code === "CURRENT_PRINCIPAL_BUSY");
    assert.deepEqual(await policySnapshot(policyOwner), savedSnapshot); assert.equal(wakes, beforeBusyWakes);
    await racer.query("ROLLBACK");
    assert.equal(Number((await privacy.updatePolicy(policyOwner.request, busyBody)).version), busyBody.expectedVersion + 1, "Failed mirror upgrade leaves the original CAS version usable");
    assert.equal((await policySnapshot(policyOwner)).tenant.retention_days, 38);
    // Assigning the unchanged canonical value must repair a drifted legacy mirror too.
    await admin.query("UPDATE tenants SET retention_days=99 WHERE id=$1", [policyOwner.tenantId]);
    const beforeResync = await policySnapshot(policyOwner);
    await privacy.updatePolicy(policyOwner.request, { ...busyBody, expectedVersion: Number(beforeResync.policy.version) });
    const resynced = await policySnapshot(policyOwner);
    assert.equal(resynced.policy.resolved_case_days, 38); assert.equal(resynced.tenant.retention_days, 38);
    assert.equal(Number(resynced.policy.version), Number(beforeResync.policy.version) + 1); assert.equal(resynced.audits, beforeResync.audits + 1);
    assert.deepEqual(await policySnapshot(policyForeign), foreignPolicy);
    const tempTable = `principal_mirror_${randomUUID().replaceAll("-", "")}`;
    try {
      await admin.query(`CREATE TEMP TABLE ${tempTable}(tenant_id uuid,resolved_case_days integer)`);
      await admin.query(`INSERT INTO ${tempTable} VALUES($1,38)`, [policyOwner.tenantId]);
      await admin.query(`CREATE TRIGGER mirror_wrong_source AFTER UPDATE OF resolved_case_days ON ${tempTable} FOR EACH ROW EXECUTE FUNCTION app.sync_tenant_retention_days()`);
      await assert.rejects(() => admin.query(`UPDATE ${tempTable} SET resolved_case_days=39`), { code: "22023" });
      assert.deepEqual(await policySnapshot(policyOwner), resynced);
    } finally { await admin.query(`DROP TABLE IF EXISTS pg_temp.${tempTable}`); }
    try {
      await app.query(`CREATE TEMP TABLE ${tempTable}(tenant_id uuid,resolved_case_days integer)`);
      await assert.rejects(() => app.query(`CREATE TRIGGER mirror_runtime_source AFTER UPDATE OF resolved_case_days ON ${tempTable} FOR EACH ROW EXECUTE FUNCTION app.sync_tenant_retention_days()`), { code: "42501" });
    } finally { await app.query(`DROP TABLE IF EXISTS pg_temp.${tempTable}`); }

    const protectedOwner = await fixture({ projection: true });
    assert.equal(await settlement(protectedOwner), "12");
    assert.equal(await settlement(protectedOwner), "12", "Exact receipt recovery cannot apply or audit twice");
    assert.deepEqual((await admin.query("SELECT native_user_id,sync_state,revision::int,applied_revision::int FROM native_membership_projections WHERE tenant_id=$1 AND user_id=$2", [protectedOwner.tenantId, protectedOwner.userId])).rows,
      [{ native_user_id: "12", sync_state: "READY", revision: protectedOwner.revision, applied_revision: protectedOwner.revision }]);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM audit_events WHERE tenant_id=$1 AND action='team.service_access_initialized'", [protectedOwner.tenantId])).rows[0].count, 1);
    for (const [change, standbyOwner] of [
      [f => admin.query("UPDATE users SET oidc_subject=$2 WHERE id=$1", [f.userId, `changed-${randomUUID()}`]), false],
      [f => admin.query("UPDATE users SET email=$2 WHERE id=$1", [f.userId, `${randomUUID()}@example.invalid`]), false],
      [f => admin.query("UPDATE tenant_memberships SET role='agent' WHERE tenant_id=$1 AND user_id=$2", [f.tenantId, f.userId]), true],
      [f => admin.query("UPDATE tenant_memberships SET state='SUSPENDED' WHERE tenant_id=$1 AND user_id=$2", [f.tenantId, f.userId]), true],
      [f => admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1", [f.tenantId]), false],
      [f => admin.query("UPDATE tenant_settings SET native_membership_sync_enabled=false WHERE tenant_id=$1", [f.tenantId]), false],
      [f => admin.query("UPDATE zammad_instances SET state='PAUSED' WHERE id=$1", [f.instanceId]), false],
      [f => admin.query("UPDATE native_membership_projections SET revision=revision+1 WHERE tenant_id=$1 AND user_id=$2", [f.tenantId, f.userId]), false],
      [f => admin.query("UPDATE native_membership_projections SET requested_native_user_id='13' WHERE tenant_id=$1 AND user_id=$2", [f.tenantId, f.userId]), false],
    ]) {
      const changed = await fixture({ projection: true, standbyOwner });
      await change(changed); const before = await counts(changed);
      await assert.rejects(() => settlement(changed));
      assert.equal((await admin.query("SELECT native_user_id FROM native_membership_projections WHERE tenant_id=$1 AND user_id=$2", [changed.tenantId, changed.userId])).rows[0].native_user_id, null);
      assert.deepEqual(await counts(changed), before);
    }
    for (const lock of ["instance", "projection"]) {
      const expiredOwner = await fixture({ projection: true }), expired = { ...expiredOwner.request, principal: { ...expiredOwner.principal, authenticatedAt: 1 } };
      const beforeExpired = await counts(expiredOwner);
      await racer.query("BEGIN");
      if (lock === "instance") await racer.query("SELECT id FROM zammad_instances WHERE id=$1 FOR UPDATE", [expiredOwner.instanceId]);
      else await racer.query("SELECT user_id FROM native_membership_projections WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE", [expiredOwner.tenantId, expiredOwner.userId]);
      await assert.rejects(() => settlement(expiredOwner, expired), isNowait, `Contended ${lock} must fail before any MFA decision`);
      await racer.query("COMMIT");
      await assert.rejects(() => settlement(expiredOwner, expired), error => error.getResponse?.().code === "REAUTHENTICATION_REQUIRED");
      assert.deepEqual(await counts(expiredOwner), beforeExpired);
      assert.deepEqual((await admin.query("SELECT native_user_id,sync_state FROM native_membership_projections WHERE tenant_id=$1 AND user_id=$2", [expiredOwner.tenantId, expiredOwner.userId])).rows, [{ native_user_id: null, sync_state: "PROTECTED" }]);
      assert.equal(await settlement(expiredOwner), "12", "Fresh MFA settles the original proof without native replay");
    }
    const changedExpired = await fixture({ projection: true });
    await admin.query("UPDATE users SET oidc_subject=$2 WHERE id=$1", [changedExpired.userId, `changed-${randomUUID()}`]);
    await assert.rejects(() => settlement(changedExpired, { ...changedExpired.request, principal: { ...changedExpired.principal, authenticatedAt: 1 } }), error => error.getResponse?.().code !== "REAUTHENTICATION_REQUIRED");
    verificationResult = { current_principal_runtime_privileges: "passed", principal_tenant_identity_guards: "passed", transaction_lock_lifetime: "passed", contention_then_identity_and_policy_recheck: "passed", owner_demotion_cycle: "passed", native_membership_three_writer_cycle: "passed", provisioning_opposite_order_recovery: "passed", privacy_admission_waits: "passed", retention_policy_mirror_atomicity: "passed", owner_settlement_real_postgres: "passed", native_evidence_mode: "synthetic-proof-no-native-http" };
  } catch (error) {
    primaryFailure = error; primaryFailed = true;
  } finally {
    try {
      cleanupFailures.push(...await settleOwnedWork());
      if (routingBefore) await cleanupRoutingPairs(ownedRoutingPairs, routingBefore);
    } catch (error) { cleanupFailures.push(error); }
    const closed = await Promise.allSettled(clients.map(client => client.end()));
    cleanupFailures.push(...closed.filter(result => result.status === "rejected").map(result => result.reason));
  }
  if (cleanupFailures.length) throw new AggregateError([...new Set([...(primaryFailed ? [primaryFailure] : []), ...cleanupFailures])], "Principal-lock verification and owned cleanup failed", { cause: primaryFailed ? primaryFailure : cleanupFailures[0] });
  if (primaryFailed) throw primaryFailure;
  return verificationResult;
}
