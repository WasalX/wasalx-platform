import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BadRequestException } from "../services/control-api/node_modules/@nestjs/common/index.js";
import {
  AuditController,
  auditCsv,
  csvCell,
} from "../services/control-api/dist/audit.controller.js";

const portalBridge = await readFile(new URL("../lib/control-plane-data.ts", import.meta.url), "utf8");

const tenantId = "10000000-0000-4000-8000-000000000001";
const request = {
  id: "audit-export-request",
  principal: {
    subject: "auditor-subject",
    userId: "20000000-0000-4000-8000-000000000002",
    tenantId,
    email: "auditor@example.test",
    displayName: "Auditor",
    role: "auditor",
  },
};

test("audit CSV is spreadsheet-safe and recursively redacts secret-like values", () => {
  const csv = auditCsv([
    {
      id: "audit-1",
      actor_type: "USER",
      actor_id: "=HYPERLINK(\"https://bad.example\")",
      actor_display_name: "+Malicious",
      action: "connection.updated",
      target_type: "connection",
      target_id: "-1",
      request_id: "@request",
      created_at: "2026-08-09T09:00:00.000Z",
      previous_value: {
        state: "WORKING",
        hmacKey: "must-not-export",
        nested: { access_token: "also-secret", safe: "visible" },
      },
      new_value: {
        payload: { message_body: "private group content" },
        state: "DEGRADED",
      },
    },
  ]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /'=[^,]+/);
  assert.match(csv, /'\+Malicious/);
  assert.match(csv, /'@request/);
  assert.match(csv, /\[REDACTED\]/);
  assert.match(csv, /visible/);
  assert.match(csv, /DEGRADED/);
  assert.doesNotMatch(csv, /must-not-export|also-secret|private group content/);
});

test("the portal audit-export bridge never reflects upstream error bodies", () => {
  const start = portalBridge.indexOf("export async function exportAuditCsv");
  const end = portalBridge.indexOf("export async function inviteTeamMember", start);
  const source = portalBridge.slice(start, end);
  assert.match(source, /if \(!response\.ok\) \{[\s\S]*new ControlPlaneError\("Audit export failed", response\.status\)/u);
  assert.ok(source.indexOf("if (!response.ok)") < source.indexOf("await response.text()"));
  assert.doesNotMatch(source, /body\.slice|JSON\.parse\(body\)|parsed\.message|parsed\.error/u);
});

test("audit list and CSV project generated workspace metadata without rewriting audit identities or authored data", async () => {
  const metadata = {
    zammad_ticket_id: "10380", zammad_article_id: "90381", zammad_group_id: 4,
    zammad_instance_id: "instance-reference", zammad_state: "open",
    zammad_state_id: 2, zammad_state_name: "Zammad custom state",
    zammad_state_type_name: "open", zammadGroupId: 4, zammadTickets: 3,
    ZAMMAD_TICKET: 2, ZAMMAD_USER: 1, scope_type: "ZAMMAD_USER",
    disposition: "ZAMMAD_USER_DATA_PRIVACY", reason: "Keep Zammad authored text exact",
    nested: { zammad_ticket_id: "authored nested value", access_token: "secret" },
    message_body: "private content", constructor: "unchanged",
  };
  const expectedMetadata = {
    workspace_ticket_id: "10380", workspace_article_id: "90381", workspace_group_id: 4,
    workspace_instance_id: "instance-reference", workspace_state: "open",
    workspace_state_id: 2, workspace_state_name: "Zammad custom state",
    workspace_state_type_name: "open", workspaceGroupId: 4, workspaceTickets: 3,
    WORKSPACE_TICKET: 2, WORKSPACE_USER: 1, scope_type: "WORKSPACE_USER",
    disposition: "WORKSPACE_USER_DATA_PRIVACY", reason: "Keep Zammad authored text exact",
    nested: { zammad_ticket_id: "authored nested value", access_token: "[REDACTED]" },
    message_body: "[REDACTED]", constructor: "unchanged",
  };
  const actions = ["zammad_email.route_pinned", "zammad_email.route_applied", "zammad_email.route_manually_overridden", "delivery.retry_requested_from_zammad"];
  const publicActions = ["workspace_email.route_pinned", "workspace_email.route_applied", "workspace_email.route_manually_overridden", "delivery.retry_requested_from_workspace"];
  const targets = ["zammad_ticket", "zammad_email_route", "zammad_instance"];
  const publicTargets = ["workspace_ticket", "workspace_email_route", "workspace_instance"];
  const failures = ["ENDPOINT_INVALID", "TIMEOUT_INVALID", "ID_INVALID", "PRIVACY_ADMISSION_REQUIRED", "PRIVACY_CREDENTIAL_INVALID", "PRIVACY_PERMISSION_DENIED", "PRIVACY_HTTP", "PRIVACY_RESPONSE_INVALID", "PRIVACY_NETWORK", "PRIVACY_RESPONSE_TOO_LARGE", "PRIVACY_OUTCOME_UNKNOWN", "PRIVACY_TASK_FAILED"];
  const rows = failures.map((failure, index) => ({
    id: `audit-${index}`, actor_type: index % 2 ? "ZAMMAD_AGENT" : "ZAMMAD_USER",
    actor_id: "instance:agent:42", actor_display_name: null,
    action: actions[index % actions.length], target_type: targets[index % targets.length],
    target_id: "zammad-ticket:10380", request_id: "zammad-group-link:exact-reference",
    created_at: "2026-10-20T00:00:00.000Z",
    previous_value: { scope_type: "ZAMMAD_TICKET", error_code: `ZAMMAD_${failure}` },
    new_value: { ...metadata, code: `ZAMMAD_${failure}` },
  }));
  const original = structuredClone(rows);
  const controller = new AuditController({ rows: async () => rows });
  const listed = await controller.list(request);
  const expected = rows.map((row, index) => ({
    ...row, actor_type: index % 2 ? "WORKSPACE_AGENT" : "WORKSPACE_USER",
    action: publicActions[index % publicActions.length], target_type: publicTargets[index % publicTargets.length],
    previous_value: { scope_type: "WORKSPACE_TICKET", error_code: `WORKSPACE_${failures[index]}` },
    new_value: { ...expectedMetadata, code: `WORKSPACE_${failures[index]}` },
  }));
  assert.deepEqual(listed, expected);
  const csv = auditCsv(rows);
  const expectedRecords = expected.map(row => [row.created_at, row.actor_type, row.actor_id, "", row.action, row.target_type, row.target_id, row.request_id, JSON.stringify(row.previous_value), JSON.stringify(row.new_value)].map(csvCell).join(","));
  assert.deepEqual(csv.split("\r\n").slice(1, -1), expectedRecords);
  assert.doesNotMatch(csv, /secret|private content/u);
  assert.deepEqual(rows, original);
});

test("audit export is tenant-scoped, bounded, no-store, and emits a fixed attachment name", async () => {
  const calls = [];
  const database = {
    withTenant: async (selectedTenant, operation) => {
      return operation({
        query: async (sql, values) => {
          calls.push({ selectedTenant, sql, values });
          if (sql.includes("INSERT INTO audit_events")) return { rows: [], rowCount: 1 };
          return { rows: [{
            id: "audit-1",
            actor_type: "USER",
            actor_id: request.principal.userId,
            actor_display_name: "Auditor",
            action: "rule.activated",
            target_type: "rule_set",
            target_id: "rule-1",
            request_id: "request-1",
            previous_value: null,
            new_value: { state: "ACTIVE" },
            created_at: "2026-08-09T09:00:00.000Z",
          }], rowCount: 1 };
        },
      });
    },
  };
  const headers = new Map();
  let body;
  const reply = {
    header(name, value) { headers.set(name, value); return this; },
    send(value) { body = value; return this; },
  };
  const controller = new AuditController(database);
  await controller.export(
    request,
    reply,
    "2026-08-01T00:00:00Z",
    "2026-08-10T00:00:00Z",
    "100",
  );
  assert.equal(calls[0].selectedTenant, tenantId);
  assert.match(calls[0].sql, /a\.tenant_id=\$1/);
  assert.deepEqual(calls[0].values, [
    tenantId,
    "2026-08-01T00:00:00.000Z",
    "2026-08-10T00:00:00.000Z",
    100,
  ]);
  assert.equal(headers.get("cache-control"), "private, no-store");
  assert.equal(headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(
    headers.get("content-disposition"),
    'attachment; filename="wasalx-audit-2026-08-01-2026-08-10.csv"',
  );
  assert.match(body, /rule\.activated/);
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT INTO audit_events")));
});

test("audit export rejects abusive limits, invalid timestamps, and excessive ranges", async () => {
  const controller = new AuditController({ withTenant: async () => assert.fail("database must not run") });
  const reply = { header() { return this; }, send() { return this; } };
  await assert.rejects(
    () => controller.export(request, reply, "2026-08-10", "2026-08-01", "100"),
    (error) => error instanceof BadRequestException && /earlier than/.test(error.message),
  );
  await assert.rejects(
    () => controller.export(request, reply, "2024-01-01", "2026-08-01", "100"),
    (error) => error instanceof BadRequestException && /366 days/.test(error.message),
  );
  await assert.rejects(
    () => controller.export(request, reply, "2026-08-01", "2026-08-02", "10001"),
    (error) => error instanceof BadRequestException && /between 1 and 10000/.test(error.message),
  );
  await assert.rejects(
    () => controller.export(request, reply, "not-a-date", "2026-08-02", "100"),
    (error) => error instanceof BadRequestException && /timestamp is invalid/.test(error.message),
  );
});

test("audit activity uses a complete cursor and excludes routine no-op checks before its limit", async () => {
  const calls = [];
  const controller = new AuditController({
    rows: async (selectedTenant, sql, values) => {
      calls.push({ selectedTenant, sql, values });
      return [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
        actor_type: "USER",
        actor_id: request.principal.userId,
        actor_display_name: "Auditor",
        action: "connection.updated",
        target_type: "connection",
        target_id: "connection-1",
        request_id: "request-1",
        created_at: "2026-08-20T12:29:00.000Z",
        previous_value: { access_token: "must-not-return", safe: "visible" },
        new_value: { payload: { message_body: "private" }, state: "WORKING" },
      }];
    },
  });
  const cursor = "2026-08-20T12:30:00.000Z";
  const cursorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const listed = await controller.list(request, cursor, cursorId, "exclude");
  assert.equal(JSON.stringify(listed).includes("must-not-return"), false);
  assert.equal(JSON.stringify(listed).includes("private"), false);
  assert.equal(JSON.stringify(listed).includes("visible"), true);
  assert.equal(calls[0].selectedTenant, tenantId);
  assert.match(calls[0].sql, /\(a\.created_at,a\.id\)<\(\$2,\$3::uuid\)/u);
  assert.match(calls[0].sql, /ORDER BY a\.created_at DESC,a\.id DESC LIMIT 100/u);
  assert.match(calls[0].sql, /privacy\.job_succeeded[\s\S]*EXISTS \([\s\S]*privacy_jobs job[\s\S]*job\.tenant_id=a\.tenant_id[\s\S]*job\.id::text=a\.target_id[\s\S]*job\.job_type='RETENTION_SWEEP'[\s\S]*LIMIT 100/u);
  for (const counter of ["zammadTickets", "botConversations", "normalizedMessages", "participantIdentities", "groupWorkspaceParticipants", "mediaObjects", "exportArtifacts", "unmatchedDiagnostics"]) {
    assert.match(calls[0].sql, new RegExp(counter));
  }
  assert.deepEqual(calls[0].values, [tenantId, cursor, cursorId, false]);
  await assert.rejects(
    () => controller.list(request, cursor),
    (error) => error instanceof BadRequestException && /provided together/u.test(error.message),
  );
  await assert.rejects(
    () => controller.list(request, cursor, "not-a-uuid"),
    (error) => error instanceof BadRequestException && /cursor ID is invalid/u.test(error.message),
  );
  await assert.rejects(
    () => controller.list(request, undefined, undefined, "unexpected"),
    (error) => error instanceof BadRequestException && /routine filter is invalid/u.test(error.message),
  );
  await controller.list(request, undefined, undefined, "include");
  assert.equal(calls[1].values[3], true);
});
