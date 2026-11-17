import assert from "node:assert/strict";
import pg from "pg";
import { isMain, opaqueDigest, required, writeEvidence } from "./live-common.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function runOnboardingTimingContract({ env = process.env, client } = {}) {
  const tenantId = required(env, "WASALX_ONBOARDING_TENANT_ID");
  const prefix = required(env, "WASALX_ONBOARDING_CONNECTION_PREFIX");
  assert.match(tenantId, UUID, "WASALX_ONBOARDING_TENANT_ID must be a UUID");
  assert.ok(prefix.length >= 8 && prefix.length <= 140 && !hasControlCharacters(prefix), "WASALX_ONBOARDING_CONNECTION_PREFIX is invalid");

  const database = client ?? new pg.Client({ connectionString: required(env, "DATABASE_URL") });
  if (!client) await database.connect();
  try {
    await database.query("BEGIN READ ONLY");
    await database.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    const rows = (await database.query(
      `SELECT ps.id::text AS session_id,ps.connection_id::text,c.name,
              c.state AS connection_state,ps.state AS session_state,
              ps.provider_state,ps.ownership_state,
              ps.onboarding_qr_ready_at,ps.onboarding_authorization_method,
              ps.onboarding_scan_acknowledged_at,
              ps.onboarding_scan_completed_at,ps.onboarding_working_at,
              EXISTS (
                SELECT 1 FROM audit_events audit
                 WHERE audit.tenant_id=ps.tenant_id
                   AND audit.action='connection.auth_scan_completed'
                   AND audit.target_type='connection'
                   AND audit.target_id=ps.connection_id
              ) AS scan_audit_present
              ,EXISTS (
                SELECT 1 FROM audit_events audit
                 WHERE audit.tenant_id=ps.tenant_id
                   AND audit.action='connection.duplicate_identity_rejected'
                   AND audit.target_type='connection'
                   AND audit.target_id=ps.connection_id
              ) AS duplicate_identity_rejected
         FROM provider_sessions ps
         JOIN connections c ON c.tenant_id=ps.tenant_id AND c.id=ps.connection_id
        WHERE ps.tenant_id=$1 AND starts_with(c.name,$2)
          AND c.provider='WAHA' AND c.engine='GOWS'
        ORDER BY c.name,ps.created_at,ps.id`,
      [tenantId, prefix],
    )).rows;
    await database.query("ROLLBACK");

    assert.equal(rows.length, 3, "Exactly three independent onboarding sessions are required");
    assert.deepEqual(rows.map((row) => row.name), ["R1", "R2", "R3"].map((suffix) => `${prefix}${suffix}`));
    assert.equal(new Set(rows.map((row) => row.session_id)).size, 3, "Onboarding sessions must be distinct");
    assert.equal(new Set(rows.map((row) => row.connection_id)).size, 3, "Onboarding connections must be distinct");

    const runs = rows.map((row) => {
      assert.equal(row.connection_state, "REVOKED", "Disposable connection cleanup is incomplete");
      assert.equal(row.session_state, "REVOKED", "Disposable session cleanup is incomplete");
      assert.equal(row.provider_state, "DELETED", "Provider session was not deleted");
      assert.equal(row.ownership_state, "RETIRED", "Provider session ownership is still active");
      assert.equal(row.scan_audit_present, true, "Scan completion audit evidence is missing");
      assert.equal(row.duplicate_identity_rejected, false, "Duplicate-identity rejection is not valid onboarding timing evidence");
      assert.equal(row.onboarding_authorization_method, "QR", "Only QR onboarding sessions are valid timing evidence");
      const qrReadyAt = timestamp(row.onboarding_qr_ready_at, "QR-ready");
      const scanAcknowledgedAt = timestamp(row.onboarding_scan_acknowledged_at, "scan-acknowledged");
      const workingAt = timestamp(row.onboarding_working_at, "provider-working");
      const scanCompletedAt = optionalTimestamp(row.onboarding_scan_completed_at, "scan-complete");
      assert.ok(qrReadyAt <= scanAcknowledgedAt, "Scan acknowledgement predates QR readiness");
      assert.ok(qrReadyAt <= workingAt, "Provider working time predates QR readiness");
      const timingEligible = scanCompletedAt !== null;
      const lateAcknowledgement = scanAcknowledgedAt > workingAt;
      if (timingEligible) {
        assert.ok(qrReadyAt <= scanCompletedAt && scanCompletedAt <= workingAt, "Eligible onboarding milestones are out of order");
        assert.equal(scanCompletedAt, scanAcknowledgedAt, "Eligible scan timing must come from the human acknowledgement");
      } else {
        assert.equal(lateAcknowledgement, true, "A non-late acknowledgement is missing its eligible scan milestone");
      }
      return {
        connection_sha256: opaqueDigest(row.connection_id),
        session_sha256: opaqueDigest(row.session_id),
        qr_ready_at: new Date(qrReadyAt).toISOString(),
        scan_acknowledged_at: new Date(scanAcknowledgedAt).toISOString(),
        scan_completed_at: scanCompletedAt === null ? null : new Date(scanCompletedAt).toISOString(),
        working_at: new Date(workingAt).toISOString(),
        timing_eligible: timingEligible,
        late_acknowledgement: lateAcknowledgement,
        human_seconds: scanCompletedAt === null ? null : seconds(scanCompletedAt - qrReadyAt),
        provider_seconds: scanCompletedAt === null ? null : seconds(workingAt - scanCompletedAt),
        total_seconds: seconds(workingAt - qrReadyAt),
      };
    });
    const eligibleProviderSeconds = runs
      .filter((run) => run.timing_eligible)
      .map((run) => run.provider_seconds)
      .filter((value) => value !== null)
      .sort((left, right) => left - right);
    assert.equal(eligibleProviderSeconds.length, 3, "All three onboarding sessions must be timing-eligible");
    const middle = Math.floor(eligibleProviderSeconds.length / 2);
    const medianProviderSeconds = eligibleProviderSeconds.length % 2
      ? eligibleProviderSeconds[middle]
      : Number(((eligibleProviderSeconds[middle - 1] + eligibleProviderSeconds[middle]) / 2).toFixed(3));
    assert.ok(medianProviderSeconds < 300, "Median provider onboarding time must be under five minutes");
    return {
      schema: "wasalx-onboarding-timing-v2",
      runs,
      timing_eligible_runs: eligibleProviderSeconds.length,
      median_provider_seconds: medianProviderSeconds,
      human_scan_time_excluded: true,
      passed: true,
    };
  } catch (error) {
    await database.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (!client) await database.end();
  }
}

function timestamp(value, label) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  assert.ok(Number.isFinite(parsed), `${label} timestamp is missing or invalid`);
  return parsed;
}

function optionalTimestamp(value, label) {
  if (value === null || value === undefined) return null;
  return timestamp(value, label);
}

function seconds(milliseconds) {
  return Number((milliseconds / 1_000).toFixed(3));
}

function hasControlCharacters(value) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

if (isMain(import.meta.url)) writeEvidence(await runOnboardingTimingContract());
