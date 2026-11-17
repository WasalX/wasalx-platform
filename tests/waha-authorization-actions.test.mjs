import assert from "node:assert/strict";
import test from "node:test";
import {
  ConflictException,
} from "../services/control-api/node_modules/@nestjs/common/index.js";
import {
  HttpWahaAuthorizationClient,
  privateWahaBaseUrl,
} from "../services/control-api/dist/waha-authorization.client.js";
import { WahaAuthorizationController } from "../services/control-api/dist/waha-authorization.controller.js";
import {
  WahaAuthorizationService,
  wahaQrFreshness,
} from "../services/control-api/dist/waha-authorization.service.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const connectionId = "40000000-0000-4000-8000-000000000001";
const request = {
  id: "request-auth-1",
  principal: {
    subject: "operator-1",
    userId: "20000000-0000-4000-8000-000000000001",
    tenantId,
    email: "operator@example.test",
    displayName: "Operator",
    role: "tenant_admin",
  },
};

test("private WAHA authorization client uses only scoped auth endpoints and sanitizes outputs", async () => {
  const requests = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({
      url: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
      apiKey: new Headers(init.headers).get("x-api-key"),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.pathname.endsWith("/auth/qr")) {
      return Response.json({ mimetype: "image/png", data: png });
    }
    if (url.pathname.endsWith("/auth/request-code")) {
      return Response.json({ code: "ABCD-1234" });
    }
    if (url.pathname.endsWith("/auth/passkey/challenge")) {
      return Response.json({
        challenge: "Y2hhbGxlbmdl",
        rpId: "web.whatsapp.com",
        timeout: 30_000,
        allowCredentials: [{ id: "Y3JlZGVudGlhbA", type: "public-key", transports: ["internal", "invalid"] }],
        ignored: "never-forwarded",
      });
    }
    if (url.pathname.endsWith("/auth/passkey/confirmation")) {
      return Response.json({ code: "WXYZ-9876" });
    }
    return Response.json({});
  };
  const client = new HttpWahaAuthorizationClient(
    new URL("http://waha-gows:3000"),
    "fake-test-key-not-a-secret-00000000000000000000000000000000000000",
    "tenant/session one",
  );
  const assertion = {
    id: "Y3JlZGVudGlhbA",
    rawId: "Y3JlZGVudGlhbA",
    type: "public-key",
    response: {
      clientDataJSON: "Y2xpZW50",
      authenticatorData: "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh",
      signature: "c2lnbmF0dXJl",
      userHandle: null,
    },
  };
  try {
    assert.deepEqual(await client.getQr(), { mimeType: "image/png", data: png });
    assert.deepEqual(await client.requestPairingCode("+12025550131"), { code: "ABCD-1234" });
    assert.deepEqual(await client.getPasskeyChallenge(), {
      challenge: "Y2hhbGxlbmdl",
      rpId: "web.whatsapp.com",
      timeout: 30_000,
      allowCredentials: [{ id: "Y3JlZGVudGlhbA", type: "public-key", transports: ["internal"] }],
    });
    assert.deepEqual(await client.submitPasskey(assertion), { accepted: true });
    assert.deepEqual(await client.getPasskeyConfirmation(), { code: "WXYZ-9876" });
    assert.deepEqual(await client.confirmPasskey(), { confirmed: true });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests.map(({ url, method }) => [url, method]), [
    ["/api/tenant%2Fsession%20one/auth/qr?format=image", "GET"],
    ["/api/tenant%2Fsession%20one/auth/request-code", "POST"],
    ["/api/tenant%2Fsession%20one/auth/passkey/challenge", "GET"],
    ["/api/tenant%2Fsession%20one/auth/passkey", "POST"],
    ["/api/tenant%2Fsession%20one/auth/passkey/confirmation", "GET"],
    ["/api/tenant%2Fsession%20one/auth/passkey/confirm", "POST"],
  ]);
  assert.ok(requests.every(({ apiKey }) => apiKey === "fake-test-key-not-a-secret-00000000000000000000000000000000000000"));
  assert.deepEqual(requests[1].body, { phoneNumber: "12025550131" });
  assert.deepEqual(requests[3].body, assertion);
});

test("WAHA authorization base URL fails closed for public or decorated endpoints", () => {
  assert.equal(privateWahaBaseUrl("http://waha-gows:3000").hostname, "waha-gows");
  assert.equal(privateWahaBaseUrl("https://waha.private.svc.cluster.local:3000").hostname, "waha.private.svc.cluster.local");
  assert.throws(() => privateWahaBaseUrl("https://waha.example.com"), /private WAHA endpoint/);
  assert.throws(() => privateWahaBaseUrl("https://fixture:placeholder@api.example.test/path"), /private WAHA endpoint/);
  assert.throws(() => privateWahaBaseUrl("http://waha-gows:3000/api?token=secret"), /private WAHA endpoint/);
});

test("tenant QR endpoint gates the exact provider state, audits the read, and returns no session or admin secret", async () => {
  const database = new FakeAuthorizationDatabase();
  let secretReference;
  const service = new WahaAuthorizationService(
    database,
    { resolveApiKey: async (reference) => { secretReference = reference; return "fake-test-key-not-a-secret-00000000000000000000000000000000000000"; } },
    { create: (_apiKey, sessionId, workerBaseUrl) => ({ getQr: async () => {
      assert.equal(sessionId, "opaque-session-one");
      assert.equal(workerBaseUrl, "http://waha-gows.internal:3000/");
      return { mimeType: "image/png", data: "iVBORw0KGgo=" };
    } }) },
  );
  const result = await service.qr(request, connectionId);
  assert.equal(result.imageDataUrl, "data:image/png;base64,iVBORw0KGgo=");
  assert.equal(result.providerState, "SCAN_QR_CODE");
  assert.equal(result.sequence, 1);
  assert.equal(result.expired, false);
  assert.equal(result.issuedAt, database.context.last_provider_status_at);
  assert.equal(
    result.expiresAt,
    new Date(new Date(database.context.last_provider_status_at).getTime() + 60_000).toISOString(),
  );
  assert.equal(secretReference, "secret://platform/waha-admin");
  assert.doesNotMatch(JSON.stringify(result), /opaque-session|api-key|secret:\/\//);
  assert.equal(database.audits.at(-1).action, "connection.auth_qr_viewed");

  database.context.provider_state = "PASSKEY_REQUIRED";
  await assert.rejects(() => service.qr(request, connectionId), ConflictException);
});

test("QR freshness uses provider event time, first/subsequent lifetimes, and fails closed when stale", async () => {
  const firstIssuedAt = "2026-08-12T12:00:00.000Z";
  assert.deepEqual(wahaQrFreshness({ qrSequence: 1 }, firstIssuedAt, Date.parse(firstIssuedAt) + 59_000), {
    issuedAt: firstIssuedAt,
    expiresAt: "2026-08-12T12:01:00.000Z",
    sequence: 1,
    expired: false,
  });
  assert.deepEqual(wahaQrFreshness({ qrSequence: 2 }, firstIssuedAt, Date.parse(firstIssuedAt) + 20_000), {
    issuedAt: firstIssuedAt,
    expiresAt: "2026-08-12T12:00:20.000Z",
    sequence: 2,
    expired: true,
  });
  assert.deepEqual(wahaQrFreshness({}, null), {
    issuedAt: null,
    expiresAt: null,
    sequence: 1,
    expired: true,
  });

  const database = new FakeAuthorizationDatabase();
  database.context.provider_state_data = { qrSequence: 3 };
  database.context.last_provider_status_at = "2026-08-12T08:00:00.000Z";
  let providerCalls = 0;
  const service = new WahaAuthorizationService(
    database,
    { resolveApiKey: async () => "fake-test-key-not-a-secret-00000000000000000000000000000000000000" },
    { create: () => ({ getQr: async () => { providerCalls++; throw new Error("must not fetch an expired QR"); } }) },
  );
  const result = await service.qr(request, connectionId);
  assert.equal(result.imageDataUrl, null);
  assert.equal(result.expired, true);
  assert.equal(result.sequence, 3);
  assert.equal(providerCalls, 0);
});

test("scan acknowledgement records one durable human milestone without inventing provider timing", async () => {
  const database = new FakeAuthorizationDatabase();
  const service = new WahaAuthorizationService(
    database,
    { resolveApiKey: async () => "unused" },
    { create: () => ({}) },
  );
  const result = await service.scanComplete(request, connectionId);
  assert.equal(result.recordedAt, database.scanAcknowledgedAt);
  assert.equal(result.scanCompletedAt, null);
  assert.equal(result.timingEligible, false);
  assert.equal(database.audits.at(-1).action, "connection.auth_scan_completed");
  assert.doesNotMatch(JSON.stringify(result), /opaque|secret|phone|qr/u);
});

test("a late scan acknowledgement is accepted after WORKING and audited only once", async () => {
  const database = new FakeAuthorizationDatabase();
  database.context.connection_state = "WORKING";
  database.context.provider_session_state = "WORKING";
  database.context.provider_state = "WORKING";
  database.context.onboarding_working_at = "2026-08-13T12:00:30.000Z";
  const service = new WahaAuthorizationService(database,{ resolveApiKey:async()=>"unused" },{ create:()=>({}) });
  const first=await service.scanComplete(request,connectionId);
  const replay=await service.scanComplete(request,connectionId);
  assert.equal(first.lateAcknowledgement,true);
  assert.equal(first.timingEligible,false);
  assert.equal(replay.duplicate,true);
  assert.equal(database.audits.filter(audit=>audit.action==="connection.auth_scan_completed").length,1);
});

test("pairing-code sessions cannot be recorded as QR scan acknowledgements", async () => {
  const database = new FakeAuthorizationDatabase();
  database.context.onboarding_authorization_method = "PAIRING_CODE";
  const service = new WahaAuthorizationService(database,{ resolveApiKey:async()=>"unused" },{ create:()=>({}) });
  await assert.rejects(() => service.scanComplete(request,connectionId), /cannot accept a scan acknowledgement/u);
  assert.equal(database.audits.length,0);
});

test("pairing-code mutation persists only a digest/status and suppresses a provider replay", async () => {
  const database = new FakeAuthorizationDatabase();
  database.context.onboarding_scan_acknowledged_at = "2026-08-13T12:00:10.000Z";
  database.scanCompletedAt = "2026-08-13T12:00:10.000Z";
  let providerCalls = 0;
  const service = new WahaAuthorizationService(
    database,
    { resolveApiKey: async () => "fake-test-key-not-a-secret-00000000000000000000000000000000000000" },
    { create: () => ({ requestPairingCode: async () => {
      providerCalls++;
      database.context.last_provider_status_at = new Date(Date.now() + 1_000).toISOString();
      return { code: "ABCD-1234" };
    } }) },
  );
  assert.deepEqual(
    await service.pairingCode(request, connectionId, "pairing-request-1", "+12025550131"),
    { code: "ABCD-1234" },
  );
  assert.equal(providerCalls, 1);
  assert.equal(database.action.state, "SUCCEEDED");
  assert.equal(database.context.onboarding_authorization_method, "PAIRING_CODE");
  assert.equal(database.context.onboarding_scan_acknowledged_at, null);
  assert.equal(database.scanCompletedAt, null);
  assert.match(database.action.request_sha256, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(database.action), /ABCD|966|opaque|private-api/);
  await assert.rejects(
    () => service.pairingCode(request, connectionId, "pairing-request-1", "+12025550131"),
    (error) => error instanceof ConflictException && /already completed/.test(error.message),
  );
  assert.equal(providerCalls, 1);
});

test("authorization mutation fails closed when the reserved provider generation changes", async () => {
  const database = new FakeAuthorizationDatabase();
  database.generationFinalizeRowCount = 0;
  let providerCalls = 0;
  const service = new WahaAuthorizationService(
    database,
    { resolveApiKey: async () => "fake-test-key-not-a-secret-00000000000000000000000000000000000000" },
    { create: () => ({ requestPairingCode: async () => { providerCalls++; return { code: "ABCD-1234" }; } }) },
  );
  await assert.rejects(
    () => service.pairingCode(request, connectionId, "pairing-generation-race", "+12025550131"),
    (error) => error instanceof ConflictException && /session changed/.test(error.message),
  );
  assert.equal(providerCalls, 1);
  assert.equal(database.action.state, "OUTCOME_UNKNOWN");
  assert.equal(database.context.onboarding_authorization_method, "QR");
});

test("passkey replay returns an audit-safe accepted result without forwarding the assertion twice", async () => {
  const database = new FakeAuthorizationDatabase();
  database.context.provider_state = "PASSKEY_REQUIRED";
  let providerCalls = 0;
  const service = new WahaAuthorizationService(
    database,
    { resolveApiKey: async () => "fake-test-key-not-a-secret-00000000000000000000000000000000000000" },
    { create: () => ({ submitPasskey: async () => { providerCalls++; return { accepted: true }; } }) },
  );
  const assertion = {
    id: "Y3JlZGVudGlhbA",
    rawId: "Y3JlZGVudGlhbA",
    type: "public-key",
    response: {
      clientDataJSON: "Y2xpZW50",
      authenticatorData: "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh",
      signature: "c2lnbmF0dXJl",
      userHandle: null,
    },
  };
  assert.deepEqual(await service.submitPasskey(request, connectionId, "passkey-1", assertion), { accepted: true });
  assert.deepEqual(await service.submitPasskey(request, connectionId, "passkey-1", assertion), { accepted: true, duplicate: true });
  assert.equal(providerCalls, 1);
  assert.doesNotMatch(JSON.stringify(database.action), /Y2xpZW50|c2lnbmF0dXJl/);
});

test("controller requires connection write permission for every no-store authorization route", () => {
  assert.equal(Reflect.getMetadata("wasalx:permission", WahaAuthorizationController), "connection:write");
  for (const method of ["qr", "scanComplete", "pairingCode", "passkeyChallenge", "submitPasskey", "passkeyConfirmation", "confirmPasskey"]) {
    assert.equal(typeof WahaAuthorizationController.prototype[method], "function");
  }
});

class FakeAuthorizationDatabase {
  action = undefined;
  audits = [];
  generationFinalizeRowCount = 1;
  sessionFinalizeRowCount = 1;
  scanAcknowledgedAt = "2026-08-13T12:01:00.000Z";
  scanCompletedAt = null;
  context = {
    id: connectionId,
    provider_session_id: "40000000-0000-4000-8000-000000000001",
    provider: "WAHA",
    connection_state: "AWAITING_AUTH",
    secret_reference: "secret://platform/waha-admin",
    opaque_session_id: "opaque-session-one",
    provider_session_state: "AWAITING_AUTH",
    provider_state: "SCAN_QR_CODE",
    provider_state_data: { qrSequence: 1 },
    last_provider_status_at: new Date().toISOString(),
    worker_id: null,
    lease_expires_at: null,
    waha_worker_id: "30000000-0000-4000-8000-000000000001",
    assignment_fencing_token: 7,
    assignment_lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    worker_base_url: "http://waha-gows.internal:3000/",
    worker_secret_reference: "secret://platform/waha-admin",
    worker_health_state: "HEALTHY",
    worker_lifecycle_state: "ACTIVE",
    worker_last_heartbeat_at: new Date().toISOString(),
    worker_heartbeat_ttl_seconds: 45,
    webhook_state: "ACTIVE",
    lifecycle_pending: false,
    onboarding_qr_ready_at: "2026-08-13T12:00:00.000Z",
    onboarding_authorization_method: "QR",
    onboarding_scan_acknowledged_at: null,
    onboarding_scan_completed_at: null,
    onboarding_working_at: null,
  };

  async withTenant(actualTenant, callback) {
    assert.equal(actualTenant, tenantId);
    return callback({ query: (sql, values = []) => this.query(sql, values) });
  }

  async query(sql, values) {
    if (sql.includes("SELECT 1") && sql.includes("FROM connections connection")) {
      assert.doesNotMatch(sql, /last_provider_status_at/);
      assert.deepEqual(values,[
        tenantId,
        connectionId,
        this.context.provider_session_id,
        this.context.opaque_session_id,
        this.context.waha_worker_id,
        this.context.assignment_fencing_token,
        this.context.provider_state,
      ]);
      return {
        rows:this.generationFinalizeRowCount === 1 ? [{ "?column?":1 }] : [],
        rowCount:this.generationFinalizeRowCount,
      };
    }
    if (sql.includes("SELECT session.id,session.onboarding_scan_acknowledged_at")) {
      assert.deepEqual(values, [tenantId, connectionId]);
      if (this.context.onboarding_authorization_method!=="QR") return { rows: [], rowCount:0 };
      return { rows: [{
        id:"40000000-0000-4000-8000-000000000001",
        onboarding_scan_acknowledged_at:this.context.onboarding_scan_acknowledged_at,
        onboarding_scan_completed_at:this.scanCompletedAt,
        onboarding_working_at:this.context.onboarding_working_at,
        onboarding_authorization_method:this.context.onboarding_authorization_method,
      }], rowCount: 1 };
    }
    if (sql.includes("SET onboarding_scan_acknowledged_at=now()")) {
      assert.deepEqual(values,[tenantId,"40000000-0000-4000-8000-000000000001"]);
      this.context.onboarding_scan_acknowledged_at=this.scanAcknowledgedAt;
      return { rows: [{ acknowledged_at:this.scanAcknowledgedAt }], rowCount:1 };
    }
    if (sql.includes("FROM connections c")) return { rows: [{ ...this.context }], rowCount: 1 };
    if (sql.includes("app.renew_waha_session_assignment")) {
      assert.equal(values[3], this.context.waha_worker_id);
      assert.equal(values[4], this.context.assignment_fencing_token);
      return { rows: [{ waha_worker_id: this.context.waha_worker_id }], rowCount: 1 };
    }
    if (sql.includes("SET state='OUTCOME_UNKNOWN'")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM connection_auth_actions")) return { rows: this.action ? [{ ...this.action }] : [], rowCount: this.action ? 1 : 0 };
    if (sql.includes("INSERT INTO connection_auth_actions")) {
      this.action = {
        id: "50000000-0000-4000-8000-000000000001",
        connection_id: values[1],
        action_type: values[2],
        request_sha256: values[4],
        state: "RUNNING",
        safe_error: null,
        expires_at: "2026-08-09T00:10:00.000Z",
      };
      return { rows: [{ ...this.action }], rowCount: 1 };
    }
    if (sql.includes("SET state='SUCCEEDED'")) {
      assert.equal(values[1], this.action.id);
      this.action.state = "SUCCEEDED";
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET onboarding_authorization_method=$3")) {
      assert.deepEqual(values.slice(3),[
        this.context.provider_session_id,
        this.context.opaque_session_id,
        this.context.waha_worker_id,
        this.context.assignment_fencing_token,
      ]);
      if (this.sessionFinalizeRowCount === 1) {
        this.context.onboarding_authorization_method=values[2];
        this.context.onboarding_scan_acknowledged_at=null;
        this.scanCompletedAt=null;
      }
      return { rows: [], rowCount: this.sessionFinalizeRowCount };
    }
    if (sql.includes("SET state=$1,error_code=$2")) {
      this.action.state = values[0];
      this.action.safe_error = values[2];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO audit_events")) {
      this.audits.push({ action: values[2], newValue: values[6] });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}
