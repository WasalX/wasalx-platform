import assert from "node:assert/strict";
import test from "node:test";
import { runMetaGroupsContract } from "../scripts/contracts/meta-groups-live.mjs";
import { runOnboardingTimingContract } from "../scripts/contracts/onboarding-timing-live.mjs";
import { runProvisioningContract } from "../scripts/contracts/provisioning-live.mjs";
import { runWahaContract } from "../scripts/contracts/waha-live.mjs";
import { runZammadContract } from "../scripts/contracts/zammad-live.mjs";

const tenantId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000001";

test("onboarding timing contract requires three cleaned independent runs and excludes human scan time", async () => {
  const rows = [1, 2, 3].map((run) => ({
    session_id: `20000000-0000-4000-8000-00000000000${run}`,
    connection_id: `30000000-0000-4000-8000-00000000000${run}`,
    name: `QR timing contract-R${run}`,
    connection_state: "REVOKED",
    session_state: "REVOKED",
    provider_state: "DELETED",
    ownership_state: "RETIRED",
    onboarding_qr_ready_at: `2026-08-14T01:0${run}:00.000Z`,
    onboarding_authorization_method: "QR",
    onboarding_scan_acknowledged_at: `2026-08-14T01:0${run}:30.000Z`,
    onboarding_scan_completed_at: `2026-08-14T01:0${run}:30.000Z`,
    onboarding_working_at: `2026-08-14T01:0${run}:${40 + run}.000Z`,
    scan_audit_present: true,
    duplicate_identity_rejected: false,
  }));
  const client = fakeDatabase(rows);
  const env = {
    WASALX_ONBOARDING_TENANT_ID: tenantId,
    WASALX_ONBOARDING_CONNECTION_PREFIX: "QR timing contract-",
  };
  const report = await runOnboardingTimingContract({ env, client });
  assert.equal(report.schema, "wasalx-onboarding-timing-v2");
  assert.equal(report.runs.length, 3);
  assert.equal(report.timing_eligible_runs, 3);
  assert.equal(report.median_provider_seconds, 12);
  assert.equal(report.runs[0].timing_eligible, true);
  assert.equal(report.runs[0].late_acknowledgement, false);
  assert.equal(report.runs[0].human_seconds, 30);
  assert.equal(report.runs[0].provider_seconds, 11);
  assert.equal(report.runs[0].total_seconds, 41);
  assert.equal(report.human_scan_time_excluded, true);
  assert.doesNotMatch(JSON.stringify(report), /30000000|20000000|QR timing contract/u);
  await assert.rejects(() => runOnboardingTimingContract({ env, client: fakeDatabase(rows.slice(0, 2)) }), /Exactly three/u);
  const lateRows = structuredClone(rows);
  lateRows[0].onboarding_scan_acknowledged_at = "2026-08-14T01:01:50.000Z";
  lateRows[0].onboarding_scan_completed_at = null;
  await assert.rejects(() => runOnboardingTimingContract({ env, client: fakeDatabase(lateRows) }), /All three onboarding sessions must be timing-eligible/u);
  const duplicateRows = structuredClone(rows);
  duplicateRows[0].duplicate_identity_rejected = true;
  await assert.rejects(() => runOnboardingTimingContract({ env, client: fakeDatabase(duplicateRows) }), /Duplicate-identity rejection/u);
});

test("WAHA live contract verifies the observed engine and required group metadata", async () => {
  const calls = [];
  const report = await runWahaContract({
    env: {
      WAHA_BASE_URL: "https://waha.private.test",
      WAHA_API_KEY: "super-secret-waha-api-key",
      WAHA_SESSION: "tenant-session",
      WAHA_ENGINE: "GOWS",
      WAHA_CONTRACT_GROUP_ID: "123456789@g.us",
      WAHA_CONTRACT_REQUIRE_MESSAGE_METADATA: "true",
    },
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), headers: init.headers });
      const url = new URL(input);
      if (url.pathname === "/api/sessions/tenant-session") return json({ status: "WORKING", engine: { gows: { found: true, connected: true }, grpc: { client: "ready" } } });
      if (url.pathname.endsWith("/me")) return json({ id: "12025550102@c.us" });
      if (url.pathname.endsWith("/groups")) return json([{ JID: "123456789@g.us", Name: "GOWS contract group" }]);
      if (url.pathname === "/api/messages") return json([{ participant: "12025550129@c.us", replyTo: { id: "quoted" }, hasMedia: true, mimetype: "image/jpeg" }]);
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  assert.equal(report.engine, "GOWS");
  assert.equal(report.participant_metadata, true);
  assert.equal(report.reply_metadata, true);
  assert.equal(report.media_metadata, true);
  assert.equal(report.worker_restart_recovery, "not-requested");
  assert.equal(report.session_restart_provider_seconds, null);
  assert.equal(report.restart_snapshot.session_identity_sha256.length, 64);
  assert.ok(calls.every((call) => call.headers["x-api-key"] === "super-secret-waha-api-key"));
  assert.doesNotMatch(JSON.stringify(report), /super-secret|12025550102|123456789@g\.us/u);
});

test("WAHA restart snapshot proves persisted identity without exposing it", async () => {
  const env = {
    WAHA_BASE_URL: "https://waha.private.test",
    WAHA_API_KEY: "another-super-secret-key",
    WAHA_SESSION: "persisted-session",
    WAHA_ENGINE: "NOWEB",
    WAHA_CONTRACT_GROUP_ID: "987654321@g.us",
  };
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/sessions/persisted-session") return json({ status: "WORKING", engine: { engine: "NOWEB" } });
    if (url.pathname.endsWith("/me")) return json({ id: "12025550159@c.us" });
    if (url.pathname.endsWith("/groups")) return json([{ id: "987654321@g.us" }]);
    if (url.pathname === "/api/messages") return json([]);
    throw new Error(`Unexpected URL ${url}`);
  };
  const before = await runWahaContract({ env, fetchImpl });
  const after = await runWahaContract({ env, fetchImpl, restartSnapshot: before.restart_snapshot });
  assert.equal(after.worker_restart_recovery, "passed");
  assert.deepEqual(after.restart_snapshot.session_identity_sha256, before.restart_snapshot.session_identity_sha256);
});

test("WAHA live contract records only opt-in provider restart time", async () => {
  const report = await runWahaContract({
    env: {
      WAHA_BASE_URL: "https://waha.private.test",
      WAHA_API_KEY: "restart-timing-secret",
      WAHA_SESSION: "timed-session",
      WAHA_ENGINE: "GOWS",
      WAHA_CONTRACT_ALLOW_SESSION_RESTART: "true",
    },
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname === "/api/sessions/timed-session/restart") return json({ status: "STARTING" });
      if (url.pathname === "/api/sessions/timed-session") return json({ status: "WORKING", engine: { engine: "GOWS" } });
      if (url.pathname.endsWith("/me")) return json({ id: "hidden-identity" });
      if (url.pathname.endsWith("/groups")) return json([{ id: "hidden-group" }]);
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  assert.equal(report.session_restart, "passed");
  assert.ok(Number.isFinite(report.session_restart_provider_seconds));
  assert.ok(report.session_restart_provider_seconds >= 0);
  assert.doesNotMatch(JSON.stringify(report), /restart-timing-secret|hidden-identity|hidden-group/u);
});

test("WAHA live gate fails closed when required metadata was not observed", async () => {
  await assert.rejects(
    () => runWahaContract({
      env: {
        WAHA_BASE_URL: "https://waha.private.test",
        WAHA_API_KEY: "required-secret-value",
        WAHA_SESSION: "session",
        WAHA_ENGINE: "GOWS",
        WAHA_CONTRACT_GROUP_ID: "123@g.us",
        WAHA_CONTRACT_REQUIRE_MESSAGE_METADATA: "true",
      },
      fetchImpl: async (input) => {
        const path = new URL(input).pathname;
        if (path === "/api/sessions/session") return json({ status: "WORKING", engine: { engine: "GOWS" } });
        if (path.endsWith("/me")) return json({ id: "identity" });
        if (path.endsWith("/groups")) return json([{ id: "123@g.us" }]);
        if (path === "/api/messages") return json([{ body: "no metadata" }]);
        throw new Error(`Unexpected URL ${path}`);
      },
    }),
    /Participant metadata was not observed/u,
  );
});

test("WAHA live write contract proves text edit, delete, and private base64 media without leaking content", async () => {
  let textMessage = "original";
  let deleted = false;
  const report = await runWahaContract({
    env: {
      WAHA_BASE_URL: "https://waha.private.test",
      WAHA_API_KEY: "write-contract-api-key",
      WAHA_SESSION: "write-session",
      WAHA_ENGINE: "GOWS",
      WAHA_CONTRACT_GROUP_ID: "456@g.us",
      WAHA_CONTRACT_ALLOW_SEND: "true",
      WAHA_CONTRACT_ALLOW_EDIT_DELETE: "true",
      WAHA_CONTRACT_ALLOW_MEDIA_SEND: "true",
    },
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/api/sessions/write-session") return json({ status: "WORKING", engine: { engine: "GOWS" } });
      if (url.pathname.endsWith("/me")) return json({ id: "hidden-identity" });
      if (url.pathname.endsWith("/groups")) return json([{ id: "456@g.us" }]);
      if (url.pathname === "/api/messages") return json([]);
      if (url.pathname === "/api/sendText") return json({ id: "text-message-id" });
      if (url.pathname === "/api/sendImage") {
        const body = JSON.parse(init.body);
        assert.equal(body.file.url, undefined);
        assert.equal(body.file.mimetype, "image/png");
        assert.match(body.file.data, /^[A-Za-z0-9+/]+=*$/u);
        return json({ id: "media-message-id" });
      }
      if (url.pathname.endsWith("/messages/text-message-id")) {
        if (init.method === "PUT") {
          textMessage = JSON.parse(init.body).text;
          return json({
            id: "edit-protocol-message-id",
            _data: {
              Message: {
                protocolMessage: {
                  editedMessage: { extendedTextMessage: { text: textMessage } },
                },
              },
            },
          });
        }
        if (init.method === "DELETE") {
          deleted = true;
          return json({ success: true });
        }
        return json({ id: "text-message-id", body: textMessage });
      }
      if (url.pathname.endsWith("/messages/media-message-id")) {
        return json({ id: "media-message-id", hasMedia: true, mimetype: "image/png" });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  assert.equal(report.send_test, "passed");
  assert.equal(report.edit_delete_test, "passed");
  assert.equal(report.media_send_test, "passed");
  assert.equal(deleted, true);
  assert.equal(report.sent_message_sha256.length, 64);
  assert.equal(report.sent_media_sha256.length, 64);
  assert.doesNotMatch(JSON.stringify(report), /hidden-identity|456@g\.us|WasalX edited|WasalX media/u);
});

test("Meta live contract proves provider eligibility without exposing credentials or group IDs", async () => {
  const report = await runMetaGroupsContract({
    env: {
      META_GRAPH_VERSION: "v24.0",
      META_PHONE_NUMBER_ID: "phone_number_123",
      META_ACCESS_TOKEN: "meta-access-token-that-must-not-leak",
      META_GRAPH_BASE_URL: "https://meta.private.test",
      META_LIVE_ALLOW_NON_PRODUCTION: "true",
      META_CONTRACT_GROUP_ID: "group_123",
      META_CONTRACT_READ_INVITE_LINK: "true",
    },
    fetchImpl: async (input, init) => {
      assert.equal(init.headers.authorization, "Bearer meta-access-token-that-must-not-leak");
      const url = new URL(input);
      if (url.pathname.endsWith("/phone_number_123/groups")) return json({ data: [{ id: "group_123", subject: "Secret group" }] });
      if (url.pathname.endsWith("/group_123/invite_link")) return json({ invite_link: "https://chat.whatsapp.com/ContractInvite123" });
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  assert.equal(report.eligibility_probe, "passed");
  assert.equal(report.selected_group_present, true);
  assert.equal(report.invite_link_read, "passed");
  assert.doesNotMatch(JSON.stringify(report), /access-token|group_123|ContractInvite/u);
});

test("Zammad live outbound contract waits for the package-driven provider result and never fabricates SENT", async () => {
  const methods = [];
  const report = await runZammadContract({
    env: {
      ZAMMAD_BASE_URL: "https://zammad.private.test",
      ZAMMAD_API_TOKEN: "zammad-token-that-must-not-leak",
      ZAMMAD_CONTRACT_ALLOW_OUTBOUND: "true",
      ZAMMAD_CONTRACT_GROUP: "WasalX Operations",
      ZAMMAD_CONTRACT_CUSTOMER: "contract-customer@example.test",
      ZAMMAD_CONTRACT_CONNECTION_ID: "12000000-0000-4000-8000-000000000001",
      ZAMMAD_CONTRACT_PROVIDER_GROUP_ID: "456789@g.us",
    },
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      methods.push(`${init.method ?? "GET"} ${url.pathname}`);
      assert.equal(init.headers.authorization, "Token token=zammad-token-that-must-not-leak");
      if (url.pathname === "/api/v1/online-notification-count") return json({ count: 0 });
      if (url.pathname === "/api/v1/tickets" && init.method === "POST") {
        const body = JSON.parse(init.body);
        assert.equal(body.article.sender, "Agent");
        assert.equal(body.article.internal, false);
        assert.equal(body.article.type, "wasalx group message");
        assert.equal(body.article.preferences, undefined);
        assert.equal(body.wasalx_connection_id, "12000000-0000-4000-8000-000000000001");
        assert.equal(body.wasalx_group_id, "456789@g.us");
        return json({ id: 42, number: "100042", wasalx_delivery_status: "QUEUED" });
      }
      if (url.pathname === "/api/v1/tickets/42") {
        return json({ id: 42, wasalx_delivery_status: "SENT" });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  assert.equal(report.outbound_roundtrip, "passed");
  assert.equal(report.outbound_ticket_sha256.length, 64);
  assert.equal(methods.some((entry) => entry.startsWith("PUT ")), false);
  assert.doesNotMatch(JSON.stringify(report), /zammad-token|WasalX Operations|contract-customer|456789/u);
});

test("tenant provisioning live contract creates once, replays, and requires every ordered step", async () => {
  let creates = 0;
  const completedSteps = ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults", "health"];
  const report = await runProvisioningContract({
    env: {
      WASALX_CONTROL_API_URL: "https://control.private.test",
      WASALX_PLATFORM_OPERATOR_BEARER: "operator-bearer-that-is-long-enough-for-validation",
      WASALX_PROVISIONING_IDEMPOTENCY_KEY: "contract-provision-northstar",
      WASALX_PROVISIONING_TIMEOUT_SECONDS: "30",
    },
    spec: {
      tenant: { name: "Northstar", slug: "northstar-live", retentionDays: 90 },
      owner: { oidcSubject: "owner-subject", email: "owner@example.test", displayName: "Owner" },
      deployment: { region: "sa-riyadh-1", resourceProfile: "small", zammadVersion: "7.1.3" },
    },
    fetchImpl: async (input, init) => {
      assert.equal(init.headers.authorization, "Bearer operator-bearer-that-is-long-enough-for-validation");
      const url = new URL(input);
      if (url.pathname === "/platform/v1/tenants") {
        creates += 1;
        return json({ tenant_id: tenantId, operation_id: operationId, status: "PENDING", duplicate: creates > 1 });
      }
      if (url.pathname.endsWith(`/tenants/${tenantId}/provisioning`)) {
        return json({
          tenant_id: tenantId,
          operation_id: operationId,
          tenant_state: "ACTIVE",
          status: "COMPLETE",
          completed_steps: completedSteps,
          current_step: null,
          attempts: 1,
          completed_at: "2026-08-11T12:00:00.000Z",
          step_results: { secrets: { raw: "must-not-leak" } },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  assert.equal(creates, 2);
  assert.equal(report.idempotent_replay, "passed");
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.completed_steps.length, 10);
  assert.doesNotMatch(JSON.stringify(report), /operator-bearer|owner@example|must-not-leak/u);
});

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeDatabase(rows) {
  return {
    async query(sql) {
      return { rows: sql.includes("FROM provider_sessions ps") ? rows : [] };
    },
  };
}
