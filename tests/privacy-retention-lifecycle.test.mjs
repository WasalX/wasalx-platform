import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PrivacyProcessor,
  classifyPrivacyFailure,
} from "../services/connector-worker/dist/services/connector-worker/src/privacy-processor.js";
import {
  PrivacyLegalHoldError,
  PrivacyRepository,
  shouldAuditPrivacySuccess,
} from "../services/connector-worker/dist/services/connector-worker/src/privacy-repository.js";
import {
  PrivacyZammadClient,
  PrivacyZammadError,
} from "../services/connector-worker/dist/services/connector-worker/src/privacy-zammad.js";
import {
  MediaRuntimeError,
  S3MediaStorage,
} from "../services/connector-worker/dist/services/connector-worker/src/media-runtime.js";
import { PrivacyController } from "../services/control-api/dist/privacy.controller.js";
import { PrivacyArtifactService } from "../services/control-api/dist/privacy-artifact.service.js";
import { SidecarSecretResolver } from "../services/connector-worker/dist/services/connector-worker/src/secrets.js";

const migrationUrl = new URL(
  "../services/control-api/migrations/0017_privacy_retention_lifecycle.sql",
  import.meta.url,
);
const directBotPrivacyUrl = new URL(
  "../services/control-api/migrations/0048_direct_bot_lifecycle_privacy.sql",
  import.meta.url,
);
const directDestinationPrivacyUrl = new URL(
  "../services/control-api/migrations/0069_direct_delivery_destination_privacy.sql",
  import.meta.url,
);
const groupWorkspaceLegalHoldUrl = new URL(
  "../services/control-api/migrations/0096_group_workspace_legal_holds.sql",
  import.meta.url,
);
const tenantId = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000001";

function job(overrides = {}) {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    tenantId,
    requestId,
    jobType: "DELETE",
    scopeType: "ZAMMAD_TICKET",
    scopeValue: "42",
    disposition: "DELETE_TICKETS",
    state: "RUNNING",
    stage: "DISCOVER",
    attempts: 1,
    maxAttempts: 25,
    fencingToken: 4,
    zammadBaseUrl: "https://zammad.example.test",
    zammadPrivacySecretReference: `secret://tenants/${tenantId}/zammad/privacy`,
    unmatchedDiagnosticHours: 24,
    exportTtlHours: 24,
    ...overrides,
  };
}

test("routine zero-work retention success stays out of the audit timeline", async () => {
  const empty = { zammadTickets: 0, botConversations: 0, normalizedMessages: 0, participantIdentities:0, groupWorkspaceParticipants:0, mediaObjects: 0, exportArtifacts: 0, unmatchedDiagnostics: 0 };
  assert.equal(shouldAuditPrivacySuccess(job({ jobType: "RETENTION_SWEEP" }), empty), false);
  assert.equal(shouldAuditPrivacySuccess(job({ jobType: "RETENTION_SWEEP" }), { ...empty, normalizedMessages: 1 }), true);
  assert.equal(shouldAuditPrivacySuccess(job({ jobType: "EXPORT" }), empty), true);
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(sql);
      return sql.includes("app.complete_privacy_job") ? { rows: [{ completed: true }] } : { rows: [] };
    },
    release() {},
  };
  const repository = new PrivacyRepository({ connect: async () => client });
  await repository.complete(job({ jobType: "RETENTION_SWEEP" }), "lease", empty);
  assert.equal(queries.some((sql) => sql.includes("INSERT INTO audit_events")), false);
  await repository.complete(job({ jobType: "RETENTION_SWEEP" }), "lease", { ...empty, mediaObjects: 1 });
  assert.equal(queries.filter((sql) => sql.includes("INSERT INTO audit_events")).length, 1);
});

test("media download signatures use AWS byte-order when response metadata is signed", async () => {
  const keys = [
    "PRIVACY_EXPORT_S3_ENDPOINT",
    "PRIVACY_EXPORT_S3_REGION",
    "PRIVACY_EXPORT_S3_BUCKET",
    "PRIVACY_EXPORT_S3_ACCESS_KEY_ID",
    "PRIVACY_EXPORT_S3_SECRET_ACCESS_KEY",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    PRIVACY_EXPORT_S3_ENDPOINT: "https://s3.example.test",
    PRIVACY_EXPORT_S3_REGION: "us-east-1",
    PRIVACY_EXPORT_S3_BUCKET: "wasalx-media",
    PRIVACY_EXPORT_S3_ACCESS_KEY_ID: "test-access",
    PRIVACY_EXPORT_S3_SECRET_ACCESS_KEY: "test-secret",
  });
  try {
    const url = new URL(await new PrivacyArtifactService().signedMediaUrl(
      tenantId,
      `${tenantId}/sha256/bb/${"b".repeat(64)}`,
      "b".repeat(64),
      "proof.png",
      "image/png",
      60,
    ));
    assert.deepEqual([...url.searchParams.keys()], [
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-Signature",
      "X-Amz-SignedHeaders",
      "response-content-disposition",
      "response-content-type",
    ]);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("privacy migration is tenant isolated, fenced, hold-aware, and caps unmatched diagnostics at 24 hours", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const table of [
    "retention_policies",
    "privacy_legal_holds",
    "privacy_requests",
    "privacy_jobs",
    "privacy_job_targets",
    "privacy_export_artifacts",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table} \\(`));
  }
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /tenant_id=app\.current_tenant_id\(\)/);
  assert.match(sql, /privacy_secret_reference/);
  assert.match(sql, /zammad\/privacy/);
  assert.doesNotMatch(sql, /SET privacy_secret_reference\s*=\s*service_secret_reference/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /fencing_token=job\.fencing_token\+1/);
  assert.match(sql, /fencing_token=expected_fencing_token/);
  assert.match(sql, /lease_expires_at>=now\(\)/);
  assert.match(sql, /scope_type='TENANT'/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app\.has_applicable_privacy_hold/);
  assert.match(sql, /requested_scope_type='TENANT'/);
  assert.match(sql, /hold\.scope_type='GROUP_BINDING'/);
  assert.match(sql, /state IN \('ACTIVE','RELEASED','EXPIRED'\)/);
  assert.doesNotMatch(sql, /claim_privacy_jobs[\s\S]*?AND NOT EXISTS \(\s*SELECT 1 FROM privacy_legal_holds[\s\S]*?ORDER BY job\.available_at/);
  assert.match(sql, /unmatched_diagnostic_hours BETWEEN 1 AND 24/);
  assert.match(sql, /retain_for > interval '24 hours'/);
  assert.match(sql, /DELETE FROM event_inbox AS inbox/);
  assert.match(sql, /NOT EXISTS \(\s*SELECT 1 FROM normalized_messages/);
  assert.match(sql, /'privacy'::text/);
  assert.match(sql, /GRANT SELECT \(tenant_id,state,next_sweep_at\)/);
  assert.doesNotMatch(sql, /GRANT SELECT \([^)]*(?:scope_value|object_key|message_text|payload)/i);
});

test("direct bot lifecycle permits a new resolved chat and includes its ticket in hold containment", async () => {
  const sql = await readFile(directBotPrivacyUrl, "utf8");
  assert.match(sql, /DROP CONSTRAINT bot_conversations_tenant_id_assignment_id_external_chat_id_key/);
  assert.match(sql, /CREATE UNIQUE INDEX bot_conversations_active_identity_uq[\s\S]*WHERE state<>'RESOLVED'/);
  assert.match(sql, /FROM bot_conversations AS conversation/);
  assert.match(sql, /requested_scope_type='PARTICIPANT' AND conversation\.external_chat_id=requested_scope_value/);
  assert.match(sql, /hold\.scope_type='ZAMMAD_TICKET'[\s\S]*impacted_tickets/);
});

test("successor privacy schema permits Zammad-user exports while preserving delete dispositions", async () => {
  const sql = await readFile(directDestinationPrivacyUrl, "utf8");
  assert.match(sql, /request_type='EXPORT' AND disposition='EXPORT_ONLY'/);
  assert.match(sql, /request_type='DELETE' AND disposition='DELETE_TICKETS' AND scope_type<>'ZAMMAD_USER'/);
  assert.match(sql, /request_type='DELETE' AND disposition='ZAMMAD_USER_DATA_PRIVACY' AND scope_type='ZAMMAD_USER'/);
});

test("group legal holds use tenant-owned binding and workspace identities", async () => {
  const migration = await readFile(groupWorkspaceLegalHoldUrl, "utf8");
  const controller = await readFile(
    new URL("../services/control-api/src/privacy.controller.ts", import.meta.url),
    "utf8",
  );
  assert.match(migration, /'GROUP_BINDING','WHATSAPP_GROUP'/);
  assert.match(migration, /duplicate case-variant group legal holds must be resolved before migration/);
  assert.match(migration, /privacy_legal_holds_group_uuid_canonical_check/);
  assert.match(migration, /binding\.whatsapp_group_id::text=lower\(hold\.scope_value\)/);
  assert.match(migration, /group_record\.id::text=lower\(hold\.scope_value\)/);
  assert.match(migration, /hold\.scope_type='ZAMMAD_USER'[\s\S]*provider_metadata->>'zammad_customer_id'=hold\.scope_value/);
  assert.match(controller, /SELECT 1 FROM group_bindings WHERE tenant_id=\$1 AND id=\$2 FOR KEY SHARE/);
  assert.match(controller, /FROM group_workspace_settings workspace[\s\S]*workspace\.tenant_id=\$1 AND workspace\.whatsapp_group_id=\$2/);
  assert.ok((controller.match(/value = value\.toLowerCase\(\)/g)??[]).length===2);
});

test("legal-hold creation fails closed for missing group targets", async () => {
  const queries = [];
  const database = {
    withTenant: async (_tenantId, operation) => operation({
      query: async (sql, values) => {
        queries.push({ sql, values });
        if (sql.includes("app.lock_current_operator_principal(")) return {rows:[{current_role:"tenant_owner"}]};
        if (sql.includes("privileged_reauth_minutes")) return { rows:[{privileged_reauth_minutes:5}] };
        if (sql.includes("FROM bot_flow_operations")) return {rows:[]};
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
        if (sql.includes("FROM group_bindings")) return { rows: [], rowCount: 0 };
        throw new Error(`Unexpected query: ${sql}`);
      },
    }),
  };
  const controller = new PrivacyController(database, {}, {},{privacyTarget:async()=>assert.fail('No native target in this fixture')});
  const request = {
    id: "hold-missing-group",
    principal: {
      tenantId,
      userId: "11000000-0000-4000-8000-000000000001",
      subject: "privacy-fixture-owner", email: "privacy-owner@example.test",
      role: "tenant_owner", authenticatedAt:Math.floor(Date.now()/1000), authenticationMethods:["mfa"],
    },
  };
  await assert.rejects(
    () => controller.createHold(request, {
      scopeType: "GROUP_BINDING",
      scopeValue: "12000000-0000-4000-8000-000000000001",
      reason: "Preserve the group history",
    }, "privacy-hold-fixture-1"),
    (error) => error?.getStatus?.() === 404 && error.message === "Group binding not found",
  );
  assert.equal(queries.filter(({ sql }) => sql.includes("INSERT INTO privacy_legal_holds")).length, 0);
});

test("privacy control surface audits every mutation and never returns message bodies or object keys", async () => {
  const controller = await readFile(
    new URL("../services/control-api/src/privacy.controller.ts", import.meta.url),
    "utf8",
  );
  for (const action of [
    "privacy.retention_policy_updated",
    "privacy.legal_hold_created",
    "privacy.legal_hold_released",
    "privacy.legal_hold_expired",
    "privacy.export_requested",
    "privacy.deletion_requested",
    "privacy.request_retry_requested",
    "privacy.export_downloaded",
  ]) assert.match(controller, new RegExp(action.replace(".", "\\.")));
  assert.match(controller, /requirePrivilegedAuthentication\(/);
  assert.match(controller, /releasing a legal hold/);
  assert.match(controller, /PRIVACY_REQUEST_RETRY/);
  assert.match(controller, /scope_sha256/);
  assert.doesNotMatch(controller, /SELECT[^`]*(?:message_text|message_body|payload)[^`]*FROM/is);
  assert.doesNotMatch(controller, /return\s*\{[^}]*object(?:K|_k)ey/is);
  assert.match(controller, /url_ttl_seconds: 300/);
  assert.match(controller, /role !== "auditor"/);
  assert.match(controller, /app\.has_applicable_privacy_hold/);
});

test("privacy repository applies media retention, expires holds with audit, and uses shared hold containment", async () => {
  const repository = await readFile(
    new URL("../services/connector-worker/src/privacy-repository.ts", import.meta.url),
    "utf8",
  );
  assert.match(repository, /privacy\.legal_hold_expired/);
  assert.match(repository, /job\.jobType === "DELETE" \|\| \(job\.jobType === "RETENTION_SWEEP" && job\.stage !== "DISCOVER"\)/);
  assert.match(repository, /async finalize[\s\S]*if \(job\.jobType === "DELETE" && await this\.hasApplicableHold\(client, job\)\)/);
  assert.doesNotMatch(repository, /job\.jobType !== "EXPORT" && await this\.hasApplicableHold/);
  assert.match(repository, /SET state='EXPIRED',released_at=expires_at/);
  assert.match(repository, /app\.has_applicable_privacy_hold\('PARTICIPANT'/);
  assert.match(repository, /app\.has_applicable_privacy_hold\('ZAMMAD_TICKET'/);
  assert.match(repository, /make_interval\(days=>policy\.media_days\)/);
  assert.match(repository, /message\.provider_metadata-'media_object_id'/);
  assert.match(repository, /Related media expired under the tenant retention policy/);
  assert.match(repository, /FROM bot_conversations conversation/);
  assert.match(repository, /app\.meta_direct_participant_matches\(conversation\.connection_id,conversation\.external_chat_id,\$2\)/);
  assert.match(repository, /WITH scoped_tickets[\s\S]*UNION[\s\S]*FROM bot_conversations conversation/);
  assert.match(repository, /const targetedTicket = `EXISTS \(SELECT 1 FROM privacy_job_targets target WHERE target\.tenant_id=\$1 AND target\.job_id=\$2 AND target\.target_type='ZAMMAD_TICKET' AND target\.target_id=zammad_ticket_id\)`;/);
  assert.match(repository, /DELETE FROM bot_conversations conversation WHERE conversation\.tenant_id=\$1 AND \$\{targetedTicket\}/);
  assert.match(repository, /botConversations, botEvents, botActions/);
  assert.match(repository, /message\.provider_timestamp,message\.provider_metadata,message\.created_at/);
  assert.match(repository, /JOIN group_workspace_settings workspace/);
  assert.match(repository, /message\.history_captured_at IS NOT NULL/);
  assert.match(repository, /make_interval\(days=>workspace\.retention_days\)/);
  assert.match(repository, /hold\.scope_type='WHATSAPP_GROUP'/);
  assert.match(repository, /COALESCE\(delivery\.group_workspace_group_id,binding\.whatsapp_group_id\)::text/);
  assert.match(repository, /delivery\.zammad_ticket_id IS NOT NULL[\s\S]*app\.has_applicable_privacy_hold\('ZAMMAD_TICKET',delivery\.zammad_ticket_id\)/);
  assert.ok((repository.match(/NOT app\.has_applicable_privacy_hold\('ZAMMAD_TICKET',(?:correlation|conversation)\.zammad_ticket_id\)/g)??[]).length===2);
  assert.match(repository, /AND state='PENDING' LIMIT 1/);
  assert.match(repository, /job\.stage !== "DISCOVER"[\s\S]*return this\.targetCounts\(client, job\)/);
  assert.doesNotMatch(repository, /SELECT unmatched_diagnostic_hours FROM retention_policies WHERE tenant_id=\$1 FOR SHARE/);
  assert.match(repository, /async discover[\s\S]*return this\.tenant\(job\.tenantId,[\s\S]*\},true\);[\s\S]*async targets/);
  assert.match(repository, /client\.query\("BEGIN"\);[\s\S]*SET TRANSACTION ISOLATION LEVEL REPEATABLE READ[\s\S]*set_config\('app\.tenant_id'/);
  assert.doesNotMatch(repository, /SET unmatched_diagnostic_hours_snapshot=\$1[\s\S]*stage='DISCOVER'/);
  assert.match(repository, /COALESCE\(j\.unmatched_diagnostic_hours_snapshot,p\.unmatched_diagnostic_hours\) AS unmatched_diagnostic_hours/);
  assert.match(repository, /to_char\(j\.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\) AS created_at/);
  assert.match(repository, /createdAt: String\(row\.created_at\)/);
  assert.doesNotMatch(repository, /createdAt: new Date\(row\.created_at\)/);
  assert.match(repository, /APPLICABLE_MESSAGE_HOLD_SQL[\s\S]*message_links protected_link[\s\S]*app\.has_applicable_privacy_hold\('ZAMMAD_TICKET',protected_link\.zammad_ticket_id\)/);
  assert.match(repository, /APPLICABLE_DELIVERY_HOLD_SQL[\s\S]*delivery_ticket_links protected_link[\s\S]*app\.has_applicable_privacy_hold\('ZAMMAD_TICKET',protected_link\.zammad_ticket_id\)/);
  assert.match(repository, /NON_TARGET_MESSAGE_REFERENCE_SQL[\s\S]*message_links retained_link[\s\S]*privacy_job_targets targeted_ticket/);
  assert.match(repository, /NON_TARGET_DELIVERY_REFERENCE_SQL[\s\S]*delivery_ticket_links retained_link[\s\S]*privacy_job_targets targeted_ticket/);
  assert.ok((repository.match(/\$\{APPLICABLE_MESSAGE_HOLD_SQL\}/g)??[]).length>=3);
  assert.ok((repository.match(/\$\{APPLICABLE_DELIVERY_HOLD_SQL\}/g)??[]).length>=3);
  assert.ok((repository.match(/\$\{NON_TARGET_MESSAGE_REFERENCE_SQL\}/g)??[]).length===2);
  assert.ok((repository.match(/\$\{NON_TARGET_DELIVERY_REFERENCE_SQL\}/g)??[]).length>=5);
  assert.match(
    repository,
    /SET state='PRIVACY_CANCELLED',manual_retry_allowed=false,blocked_by_delivery_id=NULL,[\s\S]*delivery\.state IN \('QUEUED','FAILED_RETRYABLE','BLOCKED'\)[\s\S]*delivery\.state='CLAIMED' AND delivery\.lease_expires_at<now\(\)[\s\S]*delivery\.state='FAILED_TERMINAL' AND delivery\.manual_retry_allowed/,
  );
  assert.match(repository, /job\.scopeType==="PARTICIPANT"\?job\.scopeValue:null/);
  const relatedDelivery=repository.slice(repository.indexOf("const RELATED_DELIVERY_SQL"),repository.indexOf("const NON_TARGET_MESSAGE_REFERENCE_SQL"));
  assert.match(relatedDelivery, /\$\{TARGETED_DELIVERY_SQL\} OR EXISTS/);
  assert.match(relatedDelivery, /target\.tenant_id=delivery\.tenant_id AND target\.job_id=\$2/);
  assert.match(relatedDelivery, /target\.target_type='ZAMMAD_TICKET'/);
  assert.match(relatedDelivery, /target\.target_id=delivery\.zammad_ticket_id OR EXISTS/);
  assert.match(relatedDelivery, /FROM delivery_ticket_links link[\s\S]*link\.tenant_id=delivery\.tenant_id AND link\.delivery_id=delivery\.id[\s\S]*link\.zammad_ticket_id=target\.target_id/);
  assert.equal((repository.match(/\$\{RELATED_DELIVERY_SQL\}/g)??[]).length,2);
  assert.equal((repository.match(/delivery\.state IN \('SENDING','OUTCOME_UNKNOWN'\)\s+OR \(delivery\.state='CLAIMED' AND delivery\.lease_expires_at>=now\(\)\)\s+\)\s+AND \$\{RELATED_DELIVERY_SQL\}/g)??[]).length,2);
  assert.match(
    repository,
    /'privacy:maintenance:'\|\|\$1::text\|\|':'\|\|\$2::text\|\|':'\|\|id::text/,
  );
  assert.doesNotMatch(
    repository,
    /VALUES \(\$1,'RETENTION_SWEEP','TENANT',\$1::text/,
  );
  assert.match(repository, /FROM participant_identities[\s\S]*LIMIT 5001/);
  assert.match(repository, /FROM group_workspace_participants[\s\S]*LIMIT 5001/);
  assert.match(repository, /participantIdentities\.length > 5_000/);
  assert.match(repository, /groupWorkspaceParticipants\.length > 5_000/);
  assert.match(repository, /DELETE FROM participant_identities participant WHERE participant\.tenant_id=\$1/);
  assert.match(repository, /DELETE FROM group_workspace_participants WHERE tenant_id=\$1/);
});

test("participant exports include only scoped, bounded identity and roster rows", async () => {
  const participantId = "12025550120@c.us";
  const queries = [];
  const client = {
    query: async (sql, values = []) => {
      queries.push({ sql, values });
      if (sql.includes("app.export_meta_cost_statements")) return { rows: [{ value: { metaCostStatements: [], metaCostSourceReviewStatus: [] } }], rowCount: 1 };
      if (sql.includes("app.export_meta_signup_privacy")) return { rows: [{ value: [] }], rowCount: 1 };
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT 1 FROM privacy_jobs")) return { rows: [{ ok: 1 }], rowCount: 1 };
      if (sql.includes("SELECT message.id,message.external_message_id")) {
        return { rows: [{ id: "message-1", external_participant_id: participantId }], rowCount: 1 };
      }
      if (sql.includes("FROM participant_identities")) {
        return { rows: [{ id: "identity-1", external_participant_id: participantId }], rowCount: 1 };
      }
      if (sql.includes("FROM group_workspace_participants")) {
        return { rows: [{ whatsapp_group_id: "group-1", external_participant_id: participantId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = new PrivacyRepository({ connect: async () => client });
  const exported = await repository.exportData(job({
    jobType: "EXPORT",
    scopeType: "PARTICIPANT",
    scopeValue: participantId,
    disposition: "EXPORT_ONLY",
  }), "lease-a");
  assert.deepEqual(exported.participantIdentities, [{ id: "identity-1", external_participant_id: participantId }]);
  assert.deepEqual(exported.groupWorkspaceParticipants, [{ whatsapp_group_id: "group-1", external_participant_id: participantId }]);
  for (const table of ["participant_identities", "group_workspace_participants"]) {
    const query = queries.find((entry) => entry.sql.includes(`FROM ${table}`));
    if (table === "group_workspace_participants") {
      assert.match(query.sql, /tenant_id=\$1 AND external_participant_id=ANY\(\$2::text\[\]\)/);
      assert.doesNotMatch(query.sql, /meta_direct_participant_matches/);
    } else {
      assert.match(query.sql, /tenant_id=\$1 AND EXISTS/);
      assert.match(query.sql, /app\.meta_direct_participant_matches\(participant_identities\.connection_id,participant_identities\.external_participant_id,requested\.value\)/);
    }
    assert.match(query.sql, /LIMIT 5001/);
    assert.deepEqual(query.values, [tenantId, [participantId]]);
  }
});

const nativePrivacyContext = { jobId: '10000000-0000-4000-8000-000000000011', leaseId: '10000000-0000-4000-8000-000000000012', fencingToken: 3 };
const nativePrivacyTarget = { id: '10000000-0000-4000-8000-000000000013', attempts: 1 };

test("Zammad privacy uses only purpose-bound job-admitted native operations", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const body = JSON.parse(init.body);
    calls.push({ path: new URL(input).pathname, method: init.method, body });
    if (body.operation === 'DELETE_TICKET') return new Response(null, { status: 204 });
    if (body.operation === 'READ_TICKET') return Response.json(null);
    if (body.operation === 'READ_ARTICLES') return Response.json([]);
    return Response.json({ id: 7, state: body.operation === 'READ_USER_TASK' ? 'completed' : 'in process' });
  };
  try {
    const client = new PrivacyZammadClient('https://zammad.example.test', 'privacy-token', 30_000, nativePrivacyContext);
    await client.deleteTicket('42', nativePrivacyTarget);
    assert.deepEqual(await client.createUserDataPrivacyTask('19', nativePrivacyTarget), { id: '7', state: 'in process' });
    assert.deepEqual(await client.getDataPrivacyTask('7', nativePrivacyTarget), { id: '7', state: 'completed' });
    assert.equal(await client.getTicket('42'), null);
    assert.deepEqual(await client.getTicketArticles('42'), []);
  } finally { globalThis.fetch = originalFetch; }
  assert.ok(calls.every(call => call.path === '/api/v1/wasalx/privacy' && call.method === 'POST'));
  assert.deepEqual(calls.map(call => [call.body.operation, call.body.native_id]), [
    ['DELETE_TICKET', '42'], ['CREATE_USER_TASK', '19'], ['READ_USER_TASK', '7'], ['READ_TICKET', '42'], ['READ_ARTICLES', '42'],
  ]);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.body.job_id, nativePrivacyContext.jobId);
    assert.equal(call.body.lease_id, nativePrivacyContext.leaseId);
    assert.equal(call.body.fencing_token, nativePrivacyContext.fencingToken);
    assert.equal(call.body.attempt, index < 3 ? 1 : 0);
    assert.equal(call.body.target_id, index < 3 ? nativePrivacyTarget.id : undefined);
  }
});

test("missing privacy endpoint is not successful deletion; purpose denial is terminal", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const client = new PrivacyZammadClient('https://zammad.example.test', 'privacy-token', 30_000, nativePrivacyContext);
    globalThis.fetch = async () => Response.json({}, { status: 404 });
    await assert.rejects(client.deleteTicket('42', nativePrivacyTarget), { code: 'ZAMMAD_PRIVACY_HTTP', status: 404, retryable: false });
    globalThis.fetch = async () => Response.json({}, { status: 403 });
    await assert.rejects(client.deleteTicket('42', nativePrivacyTarget), error => error instanceof PrivacyZammadError && error.code === 'ZAMMAD_PRIVACY_PERMISSION_DENIED' && !error.retryable);
    globalThis.fetch = async () => { throw new Error('must not call without a job lease'); };
    await assert.rejects(new PrivacyZammadClient('https://zammad.example.test', 'privacy-token').deleteTicket('42', nativePrivacyTarget), { code: 'ZAMMAD_PRIVACY_ADMISSION_REQUIRED' });
  } finally { globalThis.fetch = originalFetch; }
});

test("Zammad privacy preserves 19-digit native IDs as exact strings", async () => {
  let body;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init = {}) => { body = JSON.parse(init.body); return Response.json({ id: 9, state: 'in process' }); };
  try {
    await new PrivacyZammadClient('https://zammad.example.test', 'privacy-token', 30_000, nativePrivacyContext).createUserDataPrivacyTask('9007199254740993', nativePrivacyTarget);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(body.native_id, '9007199254740993');
});

test("private object deletion is SigV4-authenticated, idempotent on 404, and classifies retryable storage failures", async () => {
  const storage = new S3MediaStorage({
    endpoint: "https://s3.example.test",
    region: "us-east-1",
    bucket: "wasalx-media",
    accessKeyId: "privacy-worker",
    secretAccessKey: "private-secret",
  });
  const calls = [];
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: calls.length === 1 ? 204 : calls.length === 2 ? 404 : 503 });
    };
    await storage.delete(`tenants/${tenantId}/media/proof.bin`);
    await storage.delete(`tenants/${tenantId}/media/already-gone.bin`);
    await assert.rejects(
      () => storage.delete(`tenants/${tenantId}/media/retry.bin`),
      (error) => error instanceof MediaRuntimeError && error.code === "MEDIA_STORAGE_DELETE_HTTP" && error.retryable,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls[0].init.method, "DELETE");
  assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 /u);
  assert.equal(calls[0].init.redirect, "error");
});

test("privacy processor checkpoints Zammad and object deletion before local completion", async () => {
  const current = job();
  const calls = [];
  const ticketTarget = { id: "target-ticket", type: "ZAMMAD_TICKET", targetId: "42", state: "PENDING" };
  const mediaTarget = {
    id: "target-media",
    type: "MEDIA_OBJECT",
    targetId: "40000000-0000-4000-8000-000000000001",
    state: "PENDING",
    attempts: 0,
    objectKey: `${tenantId}/sha256/aa/${"a".repeat(64)}`,
  };
  const repository = {
    expireHolds: async () => 0,
    ensureMaintenanceJob: async () => null,
    claim: async () => [current],
    hasPendingFinanceReview: async () => false,
    discover: async () => ({ ZAMMAD_TICKET: 1, MEDIA_OBJECT: 1 }),
    targets: async () => [ticketTarget, mediaTarget],
    hasPendingExternalTargets: async () => false,
    beginTargetExternal: async () => 1,
    markTargetExternal: async (_job, _lease, target) => calls.push(`checkpoint:${target.type}`),
    finalize: async () => {
      calls.push("local:finalize");
      return { zammadTickets: 1, normalizedMessages: 1, unmatchedDiagnostics: 0 };
    },
    complete: async () => {
      calls.push("job:complete");
      return true;
    },
    fail: async () => assert.fail("must not fail"),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    if(String(input)==="https://secrets.example/v1/resolve"){
      assert.deepEqual(JSON.parse(init.body),{reference:current.zammadPrivacySecretReference});
      return Response.json({token:"privacy-token",key:"provisioner-privacy-key"});
    }
    calls.push(`zammad:${init.method}`);
    return Response.json({});
  };
  try {
    const processor = new PrivacyProcessor(
      repository,
      new SidecarSecretResolver("https://secrets.example","read-token",true),
      {
        put: async () => assert.fail("must not upload"),
        delete: async (key) => calls.push(`storage:delete:${key}`),
      },
    );
    assert.deepEqual(await processor.drainTenant(tenantId), {
      claimed: 1,
      succeeded: 1,
      deferred: 0,
      failedRetryable: 0,
      failedTerminal: 0,
      legalHoldBlocked: 0,
      leaseLost: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(calls.indexOf("zammad:DELETE") < calls.indexOf("local:finalize"));
  assert.ok(calls.indexOf(`storage:delete:${tenantId}/sha256/aa/${"a".repeat(64)}`) < calls.indexOf("local:finalize"));
  assert.deepEqual(calls.slice(-2), ["local:finalize", "job:complete"]);
});

test("async Zammad user privacy tasks persist their operation id and defer without duplicate creation", async () => {
  const current = job({ scopeType: "ZAMMAD_USER", scopeValue: "19", disposition: "ZAMMAD_USER_DATA_PRIVACY" });
  const calls = [];
  const repository = {
    expireHolds: async () => 0,
    ensureMaintenanceJob: async () => null,
    claim: async () => [current],
    hasPendingFinanceReview: async () => false,
    discover: async () => ({ ZAMMAD_USER: 1 }),
    targets: async () => [{ id: "target-user", type: "ZAMMAD_USER", targetId: "19", state: "PENDING", attempts: 0 }],
    beginTargetExternal: async () => 1,
    setTargetOperation: async (_job, _lease, _target, operationId) => calls.push(`operation:${operationId}`),
    defer: async () => {
      calls.push("deferred");
      return true;
    },
    complete: async () => assert.fail("must not complete"),
    fail: async () => assert.fail("must not fail"),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: 8, state: "in process" }, { status: 201 });
  try {
    const processor = new PrivacyProcessor(repository, { resolve: async () => ({ token: "privacy-token" }) }, {
      put: async () => {},
      delete: async () => {},
    });
    const result = await processor.drainTenant(tenantId);
    assert.equal(result.deferred, 1);
    assert.equal(result.succeeded, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(calls, ["operation:8", "deferred"]);
});

test("privacy object cleanup rejects a cross-tenant key before touching storage", async () => {
  const current = job();
  let deleted = false;
  let failure;
  const repository = {
    expireHolds: async () => 0,
    ensureMaintenanceJob: async () => null,
    claim: async () => [current],
    hasPendingFinanceReview: async () => false,
    discover: async () => ({ EXPORT_OBJECT: 1 }),
    targets: async () => [{
      id: "target-object",
      type: "EXPORT_OBJECT",
      targetId: "tenants/20000000-0000-4000-8000-000000000002/privacy-exports/62000000-0000-4000-8000-000000000001-1.json",
      state: "PENDING",
      attempts: 0,
      objectKey: "tenants/20000000-0000-4000-8000-000000000002/privacy-exports/62000000-0000-4000-8000-000000000001-1.json",
    }],
    fail: async (_job, _lease, value) => { failure = value; return true; },
    complete: async () => assert.fail("must not complete"),
  };
  const processor = new PrivacyProcessor(repository, { resolve: async () => ({ token: "privacy-token" }) }, {
    put: async () => {},
    delete: async () => { deleted = true; },
  });
  const result = await processor.drainTenant(tenantId);
  assert.equal(deleted, false);
  assert.equal(result.failedTerminal, 1);
  assert.equal(failure.code, "PRIVACY_OBJECT_KEY_INVALID");
});

const populatedCoexistenceExport={ messages: [{ external_message_id: "wamid.private-export", subject_phone: "12025550162", message_text: "Private imported body", source: "HISTORY" }],
  contacts: [{ subject_phone: "12025550162", display_name: "Private imported contact", action: "add" }] };
const populatedRoutingExport={events:[{id:"routing-event-private",meta_routing_evidence:{category:"STANDBY_MESSAGE",peer:{kind:"BSUID",value:"SA.PrivateRouting"}}}],
  actions:[{id:"routing-action-private",recipient_snapshot:{kind:"BSUID",value:"SA.PrivateRouting"},state:"SUCCEEDED"}]};
for (const {coexistence,routing,previews,label} of [
  {coexistence:populatedCoexistenceExport,routing:populatedRoutingExport,previews:[],label:"populated projections"},
  {coexistence:{messages:[],contacts:[]},routing:{events:[],actions:[]},previews:[],label:"empty projections"},
  {coexistence:undefined,routing:undefined,previews:[],label:"absent projections"},
  {coexistence:populatedCoexistenceExport,routing:populatedRoutingExport,previews:[{id:'private-preview',requested_mode:'CUSTOMER',target_currency:'SAR',state:'BLOCKED'}],label:"private account preview"},
]) test(`exports preserve projected data without sensitive summaries (${label})`, async () => {
  const current = job({ jobType: "EXPORT", scopeType: previews.length ? "TENANT" : "REFERENCE", scopeValue: previews.length ? null : "ABC1234567", disposition: "EXPORT_ONLY" });
  let uploaded;
  let completionSummary;
  const repository = {
    expireHolds: async () => 0,
    ensureMaintenanceJob: async () => null,
    claim: async () => [current],
    hasPendingFinanceReview: async () => false,
    discover: async () => ({}),
    exportData: async () => ({
      ticketIds: ["42"],
      messages: [{ id: "message-1", message_text: "authorized export body" }],
      participantIdentities:[{id:"identity-1",external_participant_id:"12025550120@c.us"}],
      metaDirectAliases:[{id:"alias-1",kind:"BSUID",value:"SA.PrivateExport"}],
      metaDirectIdentityEvents:[{id:"identity-event-1",meta_direct_identity_change:{scope:"ALIASES",previous:[{kind:"BSUID",value:"SA.PrivateExport"}]}}],
      metaDirectRecipients:[{delivery_id:"delivery-1",meta_direct_recipient:{recipient:{kind:"BSUID",value:"SA.PrivateExport"}},receipt_status:"READ"}],
      ...(coexistence ? { metaCoexistence: coexistence } : {}),
      metaBillingEvidence:[{delivery_id:"delivery-1",meta_billing_admission:{snapshot:{providerAccountId:"private-account"}}}],
      metaAccountPolicies:[{id:"private-account",policy_id:"private-policy-1",mode:"MANAGED",actual_payer:"UNVERIFIED",
        commercial_terms_version_id:"private-terms-1",accepted_tariff_version_id:"private-tariff-1",arrangement_version_id:"private-arrangement"},
        {id:"private-account",policy_id:"private-policy-2",mode:"MANAGED",actual_payer:"UNVERIFIED",
        commercial_terms_version_id:"private-terms-2",accepted_tariff_version_id:null,arrangement_version_id:"private-arrangement-2"}],
      metaManagedAuthority:[{id:"private-arrangement",payer_authority_version_id:"private-authority",evidence_mode:"SIMULATED"}],
      metaFinancialEffects:[{id:"private-financial-effect",outcome:"SUCCEEDED",result:{allocationConfigId:"private-allocation"}}],
      metaAccountTransitions:previews,
      ...(routing?{metaRouting:routing}:{}),
      groupWorkspaceParticipants:[{whatsapp_group_id:"group-1",external_participant_id:"12025550120@c.us"}],
      metaCostAssessments:[{id:"cost-history-1",state:"UNPRICED",evidence_redacted_at:null},{id:"cost-history-2",state:"ESTIMATED",evidence_redacted_at:null}],
      metaCostTariffs:[],
      metaCostStatements:[{id:"statement-history-1",sourceState:"PURGED",publicationSha256:"a".repeat(64)}],
      metaCostSourceReviewStatus:[{unknownSubjectCoverage:1,unresolvedWrites:0}],
      correlations: [{ zammad_ticket_id: "42" }],
      metaSignupAttempts: [],
      botConversations: [{ id: "conversation-1", external_chat_id: "participant-1" }],
      botEvents: [{ id: "event-1", event_kind: "LOCATION" }],
      botActions: [{ id: "action-1", response_variables: { "action.status": "shipped" } }],
    }),
    renew: async () => {},
    reserveArtifactUpload: async () => {},
    persistArtifact: async (_job, _lease, input) => {
      assert.match(input.objectKey, /privacy-exports/);
      return { id: "artifact-1", expiresAt: "2026-08-10T00:00:00.000Z" };
    },
    finalize: async () => ({ zammadTickets: 0, normalizedMessages: 0, unmatchedDiagnostics: 0 }),
    complete: async (_job, _lease, summary) => {
      completionSummary = summary;
      assert.equal(JSON.stringify(summary).includes("authorized export body"), false);
      assert.equal(JSON.stringify(summary).includes("privacy-exports"), false);
      assert.equal(JSON.stringify(summary).includes("SA.PrivateExport"), false);
      for (const value of ["wamid.private-export", "12025550162", "Private imported body", "Private imported contact"]) {
        assert.equal(JSON.stringify(summary).includes(value), false);
      }
      assert.equal(JSON.stringify(summary).includes("private-account"), false);
      assert.equal(JSON.stringify(summary).includes("private-preview"), false);
      assert.equal(JSON.stringify(summary).includes("PrivateRouting"), false);
      assert.equal(JSON.stringify(summary).includes("routing-event-private"), false);
      assert.equal(JSON.stringify(summary).includes("routing-action-private"), false);
      for(const value of ["private-arrangement","private-authority","private-financial-effect","private-allocation"])assert.equal(JSON.stringify(summary).includes(value),false);
      assert.equal(JSON.stringify(summary).includes("cost-history-"), false);
      return true;
    },
    fail: async () => assert.fail("must not fail"),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, '/api/v1/wasalx/privacy');
    const body = JSON.parse(init.body);
    if (body.operation === 'READ_TICKET') return Response.json({ id: 42, title: 'Case' });
    if (body.operation === 'READ_ARTICLES') return Response.json([{ id: 9, body: 'Zammad body' }]);
    return Response.json({}, { status: 403 });
  };
  try {
    const processor = new PrivacyProcessor(repository, { resolve: async () => ({ token: "privacy-token" }) }, {
      put: async (key, bytes, metadata) => { uploaded = { key, bytes, metadata }; },
      delete: async () => {},
    });
    assert.equal((await processor.drainTenant(tenantId)).succeeded, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(uploaded.metadata.mime_type, "application/json");
  const exportValue = JSON.parse(new TextDecoder().decode(uploaded.bytes));
  assert.equal(exportValue.local.messages[0].message_text, "authorized export body");
  assert.deepEqual(exportValue.local.metaSignupAttempts,[]);
  assert.equal(completionSummary.metaSignupAttempts,0);
  assert.equal(exportValue.local.participantIdentities[0].external_participant_id,"12025550120@c.us");
  assert.equal(exportValue.local.groupWorkspaceParticipants[0].whatsapp_group_id,"group-1");
  assert.equal(exportValue.local.botConversations[0].external_chat_id, "participant-1");
  assert.equal(exportValue.local.botEvents[0].event_kind, "LOCATION");
  assert.equal(exportValue.local.botActions[0].response_variables["action.status"], "shipped");
  assert.equal(exportValue.zammad.tickets[0].articles[0].body, "Zammad body");
  assert.equal(exportValue.local.metaDirectAliases[0].value,"SA.PrivateExport");
  assert.equal(exportValue.local.metaDirectIdentityEvents[0].meta_direct_identity_change.previous[0].value,"SA.PrivateExport");
  assert.equal(exportValue.local.metaDirectRecipients[0].meta_direct_recipient.recipient.value,"SA.PrivateExport");
  assert.equal(exportValue.local.metaDirectRecipients[0].receipt_status,"READ");
  assert.deepEqual(exportValue.local.metaCoexistence, coexistence ?? { messages: [], contacts: [] });
  assert.equal(completionSummary.metaCoexistenceMessages, coexistence?.messages.length ?? 0);
  assert.equal(completionSummary.metaCoexistenceContacts, coexistence?.contacts.length ?? 0);
  assert.deepEqual(exportValue.local.metaRouting,routing??{events:[],actions:[]});
  assert.equal(completionSummary.metaRoutingEvents,routing?.events.length??0);
  assert.equal(completionSummary.metaRoutingActions,routing?.actions.length??0);
  assert.equal(completionSummary.metaDirectAliases,1);
  assert.equal(completionSummary.metaDirectIdentityEvents,1);
  assert.equal(completionSummary.metaDirectRecipients,1);
  assert.equal(exportValue.local.metaBillingEvidence[0].meta_billing_admission.snapshot.providerAccountId,"private-account");
  assert.equal(exportValue.local.metaAccountPolicies[0].actual_payer,"UNVERIFIED");
  assert.equal(completionSummary.metaBillingEvidence,1);
  assert.equal(completionSummary.metaAccountPolicies,2);
  assert.deepEqual(exportValue.local.metaAccountPolicies.map(row=>[row.policy_id,row.commercial_terms_version_id,row.accepted_tariff_version_id,row.arrangement_version_id]),
    [["private-policy-1","private-terms-1","private-tariff-1","private-arrangement"],["private-policy-2","private-terms-2",null,"private-arrangement-2"]]);
  for(const value of ["private-policy-1","private-policy-2","private-terms-1","private-terms-2","private-tariff-1","private-arrangement-2"])
    assert.equal(JSON.stringify(completionSummary).includes(value),false);
  assert.equal(exportValue.local.metaManagedAuthority[0].payer_authority_version_id,"private-authority");
  assert.equal(exportValue.local.metaFinancialEffects[0].result.allocationConfigId,"private-allocation");
  assert.equal(completionSummary.metaManagedAuthority,1);assert.equal(completionSummary.metaFinancialEffects,1);
  assert.deepEqual(exportValue.local.metaAccountTransitions,previews);
  assert.equal(completionSummary.metaAccountTransitions,previews.length);
  assert.equal(typeof completionSummary.metaAccountTransitions,'number');
  assert.deepEqual(exportValue.local.metaCostAssessments,[{id:"cost-history-1",state:"UNPRICED",evidence_redacted_at:null},{id:"cost-history-2",state:"ESTIMATED",evidence_redacted_at:null}]);
  assert.deepEqual(exportValue.local.metaCostTariffs,[]);
  assert.equal(completionSummary.metaCostAssessments,2);
  assert.equal(completionSummary.metaCostTariffs,0);
  assert.deepEqual(exportValue.local.metaCostStatements,[{id:"statement-history-1",sourceState:"PURGED",publicationSha256:"a".repeat(64)}]);
  assert.deepEqual(exportValue.local.metaCostSourceReviewStatus,[{unknownSubjectCoverage:1,unresolvedWrites:0}]);
  assert.equal(completionSummary.metaCostStatements,1);
  assert.equal(completionSummary.metaCostSourceReviewStatus,1);
  assert.equal(JSON.stringify(completionSummary).includes("statement-history-1"),false);
  assert.equal(completionSummary.participantIdentities, 1);
  assert.equal(completionSummary.groupWorkspaceParticipants, 1);
});

test("legal holds are terminal-blocked and failure classification redacts unexpected errors", () => {
  assert.deepEqual(classifyPrivacyFailure(new PrivacyLegalHoldError(), job()), {
    retryable: false,
    legalHold: true,
    code: "LEGAL_HOLD_ACTIVE",
    safeError: "An active legal hold blocks this privacy deletion.",
  });
  const unexpected = classifyPrivacyFailure(new Error("message body secret://must-not-leak"), job());
  assert.equal(unexpected.retryable, true);
  assert.equal(unexpected.safeError, "Privacy processing failed temporarily.");
  assert.equal(JSON.stringify(unexpected).includes("must-not-leak"), false);
  const storage = classifyPrivacyFailure({ code: "MEDIA_STORAGE_HTTP", retryable: true }, job());
  assert.equal(storage.code, "MEDIA_STORAGE_HTTP");
  assert.equal(storage.safeError, "Private object storage is unavailable for the privacy operation.");
  const unconfigured = classifyPrivacyFailure({ code: "PRIVACY_STORAGE_NOT_CONFIGURED", retryable: false }, job());
  assert.equal(unconfigured.retryable, false);
  assert.equal(unconfigured.code, "PRIVACY_STORAGE_NOT_CONFIGURED");
  const database = classifyPrivacyFailure(Object.assign(new Error("permission denied"), { code: "42501" }), job());
  assert.equal(database.code, "PRIVACY_UNEXPECTED_FAILURE");
  assert.equal(database.safeError, "Privacy processing failed temporarily.");
  assert.equal(JSON.stringify(database).includes("42501"), false);
});

test("portal exposes BFF routes without adding message access to the main app component", async () => {
  const routes = [
    "app/api/privacy/policy/route.ts",
    "app/api/privacy/holds/route.ts",
    "app/api/privacy/holds/[id]/release/route.ts",
    "app/api/privacy/requests/route.ts",
    "app/api/privacy/requests/[id]/route.ts",
    "app/api/privacy/requests/[id]/retry/route.ts",
    "app/api/privacy/requests/[id]/download/route.ts",
  ];
  for (const route of routes) {
    const source = await readFile(new URL(`../${route}`, import.meta.url), "utf8");
    assert.match(source, /authenticatePortalRequest/);
    assert.match(source, /isControlPlaneBackend/);
  }
});

test('native export reads its admitted manifest rather than newly discovered native links', async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => {
    calls.push({ sql, values });
      if (sql.includes("app.export_meta_cost_statements")) return { rows: [{ value: { metaCostStatements: [], metaCostSourceReviewStatus: [] } }], rowCount: 1 };
      if (sql.includes("app.export_meta_signup_privacy")) return { rows: [{ value: [] }], rowCount: 1 };
    if (sql.includes('SELECT 1 FROM privacy_jobs')) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (sql.startsWith('SELECT target_id FROM privacy_job_targets')) return { rows: [{ target_id: '42' }] };
    return { rows: [], rowCount: 0 };
  }, release() {} };
  const repository = new PrivacyRepository({ connect: async () => client });
  repository.ticketIdsForScope = async () => { throw new Error('must not rediscover native targets after admission'); };
  const current = job({ jobType: 'EXPORT', stage: 'EXPORT', disposition: 'EXPORT_ONLY' });
  const output = await repository.exportData(current, 'lease-a');
  assert.deepEqual(output.ticketIds, ['42']);
  const manifest = calls.find(call => call.sql.startsWith('SELECT target_id FROM privacy_job_targets'));
  assert.deepEqual(manifest.values, [tenantId, current.id]);
  assert.match(manifest.sql, /LIMIT 251/);
});

test('user export discovers ticket read targets and finalizes without business mutations', async () => {
  const calls = [], targets = [];
  const client = { query: async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('SELECT 1 FROM privacy_jobs')) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (sql.startsWith('UPDATE privacy_jobs SET stage=')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }, release() {} };
  const repository = new PrivacyRepository({ connect: async () => client });
  repository.ticketIdsForScope = async () => ['77'];
  repository.insertTarget = async (_client, _job, type, id) => { targets.push({ type, id }); };
  repository.targetCounts = async () => ({ ZAMMAD_TICKET: 1 });
  const current = job({ jobType: 'EXPORT', stage: 'DISCOVER', disposition: 'EXPORT_ONLY', scopeType: 'ZAMMAD_USER', scopeValue: '77' });
  await repository.discover(current, 'lease-a');
  assert.deepEqual(targets, [{ type: 'ZAMMAD_TICKET', id: '77' }]);
  calls.length = 0;
  const result = await repository.finalize({ ...current, stage: 'LOCAL' }, 'lease-a');
  assert.equal(result.zammadTickets, 1);
  assert.equal(result.botConversations, 0);
  assert.equal(result.deliveryBodies, 0);
  assert.equal(calls.some(call => /^\s*(INSERT|UPDATE|DELETE)/u.test(call.sql)), false);
  repository.targetCounts = async () => ({ ZAMMAD_TICKET: 1, NORMALIZED_MESSAGE: 1 });
  await assert.rejects(repository.finalize({ ...current, stage: 'LOCAL' }, 'lease-a'), /destructive target/);
});

test("tenant signup metadata reaches uploaded bytes and count-only completion", async () => {
  const history=[{id:"signup-history-1",name:"Authorized signup name",status:"OUTCOME_UNKNOWN",selectedAsset:null},
    {id:"signup-history-2",name:"[removed]",status:"COMPLETED",selectedAsset:{phoneId:"5555555",proofSha256:"c".repeat(64)}}];
  let bytes,summary;
  const current=job({jobType:"EXPORT",scopeType:"TENANT",scopeValue:tenantId,disposition:"EXPORT_ONLY"});
  const repository={expireHolds:async()=>0,ensureMaintenanceJob:async()=>null,claim:async()=>[current],discover:async()=>({META_SIGNUP_METADATA:2}),renew:async()=>{},
    exportData:async()=>({ticketIds:[],messages:[],participantIdentities:[],metaDirectAliases:[],metaDirectIdentityEvents:[],metaDirectRecipients:[],
      groupWorkspaceParticipants:[],correlations:[],botConversations:[],botEvents:[],botActions:[],metaBillingEvidence:[],metaAccountPolicies:[],metaAccountTransitions:[],metaManagedAuthority:[],metaFinancialEffects:[],metaCostAssessments:[],metaCostTariffs:[],metaCostStatements:[],metaCostSourceReviewStatus:[],metaSignupAttempts:history}),
    reserveArtifactUpload:async()=>{},persistArtifact:async()=>({id:"artifact",expiresAt:"2026-10-09T00:00:00Z"}),
    finalize:async()=>({normalizedMessages:0}),complete:async(_job,_lease,value)=>{summary=value;return true},fail:async()=>assert.fail("must not fail")};
  const processor=new PrivacyProcessor(repository,{resolve:async()=>({token:"synthetic-privacy-token"})},{put:async(_key,value)=>{bytes=value},delete:async()=>{}});
  assert.equal((await processor.drainTenant(tenantId)).succeeded,1);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)).local.metaSignupAttempts,history);
  assert.equal(summary.metaSignupAttempts,2);
  assert.equal(typeof summary.metaSignupAttempts,"number");
  for(const value of ["signup-history-1","signup-history-2","Authorized signup name","5555555"])assert.equal(JSON.stringify(summary).includes(value),false);
});

import { PortalWorkspaceController } from "../services/control-api/dist/portal-workspace.controller.js";

function privacySelectionHarness() {
  const statements = [], requests = new Map(), operations=new Map();
  let depth=0, resolveHook, targetReturnHook, lockHook, downloadHook;
  const authority={active:true,tenantActive:true,role:"tenant_owner",subject:"privacy-fixture-owner",email:"privacy-owner@example.test"};
  let calls = 0, deny = false, mismatch = false, wakes = 0, failWake = false;
  const request = { id: "privacy-selection", principal: { tenantId, userId: "11000000-0000-4000-8000-000000000001", role: "tenant_owner",
    subject:authority.subject,email:authority.email,
    authenticatedAt: Math.floor(Date.now() / 1000), authenticationMethods: ["mfa"] } };
  const client = { query: async (sql, values = []) => {
    statements.push({ sql, values });
    if (sql.includes("pg_advisory_xact_lock") && lockHook) { const hook=lockHook;lockHook=undefined;await hook(values[0]); }
    if (sql.includes("app.lock_current_operator_principal(")) {
      assert.equal(values.length,4);
      const allowed=values[0]===request.principal.userId&&authority.active&&authority.tenantActive&&values[1]===authority.subject&&values[2]===authority.email&&values[3]===authority.role;
      return{rows:allowed?[{current_role:authority.role}]:[]};
    }
    if (sql.includes("SELECT request_type,scope_type,scope_value FROM privacy_requests")) return{rows:[{request_type:"EXPORT",scope_type:"REFERENCE",scope_value:"owned"}]};
    if (sql.includes("privileged_reauth_minutes")) return { rows: [{ privileged_reauth_minutes: 5 }], rowCount: 1 };
    if(sql.includes("FROM bot_flow_operations")) return {rows:operations.has(values[1])?[operations.get(values[1])]:[]};
    if(sql.includes("INSERT INTO bot_flow_operations")){operations.set(values[2],{action:values[1],request_sha256:values[3],result:values[4],requested_by:values[5]});return{rows:[]};}
    if (sql.includes("SELECT id,request_sha256,state")) return { rows: requests.has(values[1]) ? [requests.get(values[1])] : [] };
    if (sql.includes("app.has_applicable_privacy_hold")) return { rows: [{ held: false }] };
    if (sql.includes("INSERT INTO privacy_requests")) {
      const row = { id: requestId, state: "QUEUED", request_sha256: values[7] }; requests.set(values[6], row); return { rows: [row] };
    }
    if (sql.includes("INSERT INTO privacy_legal_holds")) return { rows: [{ id: requestId, state: "ACTIVE" }] };
    return { rows: [], rowCount: 0 };
  } };
  const workspace = { privacyTarget: async (_request, input) => {
    assert.equal(depth,0,"Native bridge called while control connection is held");
    calls++; if(targetReturnHook){const hook=targetReturnHook;targetReturnHook=undefined;await hook();} if(resolveHook){const hook=resolveHook;resolveHook=undefined;await hook();throw new Error("Native target disappeared after racing admission");}
    if (deny || input.reference === "87") throw Object.assign(new Error("Target is unavailable"), { status: 403 });
    return { scope_type: input.scope_type, scope_value: input.scope_type === "ZAMMAD_TICKET" ? "87" : "91",
      display: input.scope_type === "ZAMMAD_TICKET" ? "#20261018123" : "Synthetic contact · contact@example.test",
      selection_sha256: (mismatch ? "b" : "a").repeat(64) };
  } };
  const database = { withTenant: async (tenant, fn) => { assert.equal(tenant, tenantId); depth++;try{return await fn(client)}finally{depth--;} }, rows: async (_tenant, sql, values) => { statements.push({ sql, values }); return sql.includes("SELECT a.id,a.object_key,a.expires_at")?[{id:requestId,object_key:`tenants/${tenantId}/privacy-exports/${requestId}.json`,expires_at:new Date(Date.now()+300000)}]:[]; } };
  const controller = new PrivacyController(database, { wakePrivacy: async () => { wakes++; if (failWake) throw new Error("Synthetic wake response loss"); } }, {signedDownloadUrl:async()=>{if(downloadHook){const hook=downloadHook;downloadHook=undefined;await hook();}return"https://downloads.example.test/owned";}}, workspace);
  return { controller, request, statements, authority,
    onTargetReturn:hook=>{targetReturnHook=hook;},onLock:hook=>{lockHook=hook;},onDownload:hook=>{downloadHook=hook;}, input: { scopeType: "ZAMMAD_TICKET", scopeValue: "20261018123", selection_sha256: "a".repeat(64) },
    onResolve: hook => {resolveHook=hook;}, calls: () => calls, wakes: () => wakes, failWake: value => { failWake = value; }, deny: () => { deny = true; }, mismatch: () => { mismatch = true; } };
}

test("privacy target lookup denies auditors before native identity access and hides native IDs", async () => {
  const h = privacySelectionHarness();
  await assert.rejects(() => h.controller.target({ ...h.request, principal: { ...h.request.principal, role: "auditor" } }, h.input), error => error.getStatus() === 403);
  assert.equal(h.calls(), 0);
  const selected = await h.controller.target(h.request, h.input);
  assert.equal(selected.display, "#20261018123"); assert.equal("scope_value" in selected, false);
  const gateway = new PortalWorkspaceController({ withTenant: async () => assert.fail("Denied lookup reached native actor") }, {});
  await assert.rejects(() => gateway.privacyTarget({ principal: { role: "auditor" } }, {}), error => error.getStatus() === 403);
  await assert.rejects(() => gateway.execute(h.request, { operation: "PRIVACY_TARGET", input: {} }), error => error.getStatus() === 403);
});

test("privacy request and hold require fresh confirmed identity with no alias or raw-ID fallback", async () => {
  for (const kind of ["request", "hold"]) {
    const h = privacySelectionHarness();
    const submit = input => kind === "request" ? h.controller.createRequest(h.request, "privacy-selection-missing", { requestType: "EXPORT", ...input })
      : h.controller.createHold(h.request, { reason: "Preserve selected case", ...input }, "privacy-hold-fixture-2");
    await assert.rejects(() => submit({ scopeType: "zammad_ticket", scopeValue: "87" }), error => error.getStatus() === 400);
    assert.equal(h.calls(), 0);
    await assert.rejects(() => submit({ ...h.input, scopeValue: "87" }), /unavailable/);
    h.mismatch();
    await assert.rejects(() => submit(h.input), error => error.getStatus() === 409);
    assert.equal(h.statements.some(row => /INSERT INTO privacy_(requests|jobs|legal_holds)/u.test(row.sql)), false);
  }
});

test("privacy request jobs and holds persist only server-resolved native IDs and minimize customer history", async () => {
  for (const scopeType of ["ZAMMAD_TICKET", "ZAMMAD_USER"]) {
    const h = privacySelectionHarness(), input = { ...h.input, scopeType, scopeValue: scopeType === "ZAMMAD_TICKET" ? "20261018123" : "contact@example.test" };
    await h.controller.createRequest(h.request, `privacy-selection-${scopeType}`, { requestType: "EXPORT", ...input });
    await h.controller.createHold(h.request, { reason: "Preserve confirmed identity", ...input }, "privacy-hold-fixture-3");
    const id = scopeType === "ZAMMAD_TICKET" ? "87" : "91";
    const inserted = h.statements.find(row => row.sql.includes("INSERT INTO privacy_requests"));
    const job = h.statements.find(row => row.sql.includes("INSERT INTO privacy_jobs"));
    const hold = h.statements.find(row => row.sql.includes("INSERT INTO privacy_legal_holds"));
    assert.equal(inserted.values[3], id); assert.equal(job.values[4], id); assert.equal(hold.values[2], id);
    assert.equal(inserted.values[9], scopeType === "ZAMMAD_TICKET" ? "#20261018123" : null);
    assert.equal(hold.values[7], scopeType === "ZAMMAD_TICKET" ? "#20261018123" : null);
    assert.equal(inserted.values.includes("contact@example.test"), false); assert.equal(hold.values.includes("contact@example.test"), false);
    await h.controller.listHolds(h.request); await h.controller.listRequests(h.request);
    const reads = h.statements.filter(row => row.sql.includes("AS scope_value"));
    assert.equal(reads.length, 2); for (const row of reads) assert.match(row.sql, /scope_type IN \('ZAMMAD_TICKET','ZAMMAD_USER'\) THEN (?:r\.)?scope_display/u);
    const auditor = { ...h.request, principal: { ...h.request.principal, role: "auditor" } };
    await h.controller.listRequests(auditor); assert.equal(h.statements.at(-1).values[1], false);
  }
});

test("privacy unknown-response replay recovers receipt after target deletion without another native lookup", async () => {
  const h = privacySelectionHarness(), input = { requestType: "DELETE", confirmation: "DELETE", ...h.input };
  h.failWake(true);
  await assert.rejects(() => h.controller.createRequest(h.request, "privacy-selection-lost", input), /Synthetic wake response loss/);
  h.failWake(false);
  h.deny(); // Native effect may already have deleted its target after the response was lost.
  const replay = await h.controller.createRequest(h.request, "privacy-selection-lost", input);
  assert.equal(replay.id, requestId); assert.equal(replay.duplicate, true); assert.equal(h.calls(), 1);
  assert.equal(h.statements.filter(row => row.sql.includes("INSERT INTO privacy_jobs")).length, 1);
  await assert.rejects(() => h.controller.createRequest(h.request, "privacy-selection-lost", { ...input, scopeValue: "another" }), error => error.getStatus() === 409);
  await assert.rejects(() => h.controller.createRequest({ ...h.request, principal: { ...h.request.principal, authenticatedAt: 1 } }, "privacy-selection-lost", input), error => error.getStatus() === 403);
  assert.equal(h.calls(), 1);
});

test("privacy no control connection spans resolution and a competing receipt wins even when outer resolution fails", async()=>{
 const h=privacySelectionHarness(), input={requestType:"EXPORT",...h.input};
 h.onResolve(()=>h.controller.createRequest(h.request,"privacy-racing-admission",input));
 const result=await h.controller.createRequest(h.request,"privacy-racing-admission",input);
 assert.equal(result.id,requestId);assert.equal(result.duplicate,true);assert.equal(h.calls(),2);
 assert.equal(h.statements.filter(row=>row.sql.includes("INSERT INTO privacy_jobs")).length,1);
});
test("privacy receipt absence is unknown; explicit cancellation fences delayed requests and holds with actor/kind binding",async()=>{
 for(const kind of ["EXPORT","DELETE","HOLD"]){
  const h=privacySelectionHarness(),operationId=`privacy-cancel-${kind}`;
  assert.deepEqual(await h.controller.receipt(h.request,{operationId,kind,action:"LOOKUP"}),{state:"UNKNOWN"});
  const proof=await h.controller.receipt(h.request,{operationId,kind,action:"CANCEL_IF_UNADMITTED"});
  assert.deepEqual(proof,{state:"NOT_APPLIED",terminal:true,effect:"NONE"});
  const result=kind==="HOLD"?await h.controller.createHold(h.request,{...h.input,reason:"Preserve selected"},operationId)
   :await h.controller.createRequest(h.request,operationId,{...h.input,requestType:kind,confirmation:"DELETE"});
  assert.equal(result.state,"NOT_APPLIED");assert.equal(h.calls(),0);
  assert.equal(h.statements.some(row=>/INSERT INTO privacy_(jobs|requests|legal_holds)/u.test(row.sql)),false);
  await assert.rejects(()=>h.controller.receipt({...h.request,principal:{...h.request.principal,userId:"11000000-0000-4000-8000-000000000002"}},{operationId,kind,action:"LOOKUP"}),error=>error.getStatus()===403);
  await assert.rejects(()=>h.controller.receipt(h.request,{operationId,kind:kind==="HOLD"?"EXPORT":"HOLD",action:"LOOKUP"}),error=>error.getStatus()===409);
 }
});
test("admitted privacy request and hold recover exact IDs without inputs and cannot be cancelled",async()=>{
 for(const kind of ["EXPORT","HOLD"]){const h=privacySelectionHarness(),operationId=`privacy-applied-${kind}`;
  const result=kind==="HOLD"?await h.controller.createHold(h.request,{...h.input,reason:"Preserve selected"},operationId)
   :await h.controller.createRequest(h.request,operationId,{...h.input,requestType:kind});
  h.deny();const receipt=await h.controller.receipt(h.request,{operationId,kind,action:"CANCEL_IF_UNADMITTED"});
  assert.deepEqual(receipt,{state:"APPLIED",id:result.id});assert.equal(h.calls(),1);
 }
});

test("privacy admitted hold replay precedes expiry-dependent preflight",async()=>{
 const h=privacySelectionHarness(),now=Date.now(),input={...h.input,reason:"Preserve selected",expiresAt:new Date(now+3600000).toISOString()};
 const original=await h.controller.createHold(h.request,input,"privacy-expired-replay");
 const originalNow=Date.now;
 try{Date.now=()=>now+7200000;h.request.principal.authenticatedAt=Math.floor(Date.now()/1000);
  const replay=await h.controller.createHold(h.request,input,"privacy-expired-replay");assert.equal(replay.id,original.id);assert.equal(h.calls(),1);
 }finally{Date.now=originalNow;}
});

test("privacy retry shares tenant-before-operation lock order with create and cancellation",async()=>{
 const source=await readFile(new URL("../services/control-api/src/privacy.controller.ts",import.meta.url),"utf8");
 const retry=source.slice(source.indexOf("  async retryRequest("),source.indexOf('  @Post("requests/:id/download")'));
 assert(retry.indexOf("pg_advisory_xact_lock")<retry.indexOf("this.requirePrivacyPrincipal("));
 assert(retry.indexOf("pg_advisory_xact_lock")<retry.indexOf("withOperationReceipt("));
 assert(retry.indexOf("bot-flow:")<retry.indexOf("this.requirePrivacyPrincipal("));
});


const privacyAuthorityChanges={
  removal:authority=>{authority.active=false;},
  demotion:authority=>{authority.role="tenant_admin";},
  subject:authority=>{authority.subject="other-subject";},
  email:authority=>{authority.email="other@example.test";},
  tenant:authority=>{authority.tenantActive=false;},
};
for(const [name,change]of Object.entries(privacyAuthorityChanges)){
 test(`privacy admission rejects current ${name} drift after target resolution without a job or hold`,async()=>{
  for(const kind of["EXPORT","DELETE","HOLD"]){const h=privacySelectionHarness();h.onTargetReturn(()=>change(h.authority));
   const submit=kind==="HOLD"?()=>h.controller.createHold(h.request,{...h.input,reason:"Preserve selected"},`current-${name}-${kind}`)
    :()=>h.controller.createRequest(h.request,`current-${name}-${kind}`,{...h.input,requestType:kind,confirmation:"DELETE"});
   await assert.rejects(submit,error=>error.getStatus()===403);assert.equal(h.calls(),1);
   assert.equal(h.statements.some(row=>/INSERT INTO (privacy_requests|privacy_jobs|privacy_legal_holds|bot_flow_operations)/u.test(row.sql)),false);
  }
 });
 test(`privacy current ${name} drift during lock waits blocks cancellation, retry, hold release and policy update`,async()=>{
  const policy={state:"ACTIVE",resolvedCaseDays:30,includeOpenCases:false,mediaDays:30,unmatchedDiagnosticHours:24,exportTtlHours:24,expectedVersion:1};
  for(const action of["cancel","retry","release","policy"]){const h=privacySelectionHarness();h.onLock(()=>change(h.authority));
   const run=action==="cancel"?()=>h.controller.receipt(h.request,{operationId:`current-${name}`,kind:"EXPORT",action:"CANCEL_IF_UNADMITTED"})
    :action==="retry"?()=>h.controller.retryRequest(h.request,requestId,`current-${name}`,{})
    :action==="release"?()=>h.controller.releaseHold(h.request,requestId):()=>h.controller.updatePolicy(h.request,policy);
   await assert.rejects(run,error=>error.getStatus()===403);
   assert.equal(h.statements.some(row=>/^\s*(INSERT|UPDATE|DELETE)/u.test(row.sql)),false);
  }
 });
 test(`privacy current ${name} drift prevents receipt readback and a newly prepared download`,async()=>{
  const h=privacySelectionHarness(),created=await h.controller.createRequest(h.request,`receipt-current-${name}`,{...h.input,requestType:"EXPORT"});
  change(h.authority);const before=h.statements.length;
  await assert.rejects(()=>h.controller.receipt(h.request,{operationId:`receipt-current-${name}`,kind:"EXPORT",action:"LOOKUP"}),error=>error.getStatus()===403);
  assert.equal(h.statements.slice(before).some(row=>row.sql.includes("FROM bot_flow_operations")),false);assert(created.id);
  const download=privacySelectionHarness();download.onDownload(()=>change(download.authority));
  await assert.rejects(()=>download.controller.download(download.request,requestId),error=>error.getStatus()===403);
  assert.equal(download.statements.some(row=>row.sql.includes("SET downloaded_at")||row.sql.includes("INSERT INTO audit_events")),false);
 });
}
test("privacy policy and download retain typed MFA step-up denial with no mutation",async()=>{
 for(const action of["policy","download"]){const h=privacySelectionHarness();h.request.principal.authenticatedAt=1;
  const run=action==="policy"?()=>h.controller.updatePolicy(h.request,{state:"ACTIVE",resolvedCaseDays:30,includeOpenCases:false,mediaDays:30,unmatchedDiagnosticHours:24,exportTtlHours:24,expectedVersion:1})
   :()=>h.controller.download(h.request,requestId);
  await assert.rejects(run,error=>error.getStatus()===403&&error.getResponse().code==="REAUTHENTICATION_REQUIRED");
  assert.equal(h.statements.some(row=>/^\s*(INSERT|UPDATE|DELETE)/u.test(row.sql)),false);
 }
});


test("privacy row contention is a safe typed conflict and cannot read receipts or create effects", async () => {
  const request = { principal: { tenantId, userId: "11000000-0000-4000-8000-000000000001", role: "tenant_owner",
    subject: "synthetic-owner", email: "owner@example.invalid" } };
  for (const code of ["55P03", "XX000"]) {
    const failure = Object.assign(new Error("private database diagnostic"), { code });
    const statements = [];
    const client = { query: async sql => { statements.push(sql); if (sql.includes("app.lock_current_operator_principal(")) throw failure; return { rows: [] }; } };
    const controller = new PrivacyController({}, {}, {}, {});
    await assert.rejects(() => controller.privacyAdmission(client, request, "EXPORT", "busy-operation"), error => {
      if (code !== "55P03") return error === failure;
      assert.equal(error.getStatus(), 409);
      assert.equal(error.getResponse().code, "CURRENT_PRINCIPAL_BUSY");
      assert.equal(JSON.stringify(error.getResponse()).includes("private database diagnostic"), false);
      return true;
    });
    assert.equal(statements.length, 3);
    assert.equal(statements.some(sql => /FROM bot_flow_operations|INSERT|UPDATE|DELETE/u.test(sql)), false);
  }
});


test("privacy policy transaction contention keeps the safe conflict and never wakes uncommitted work", async () => {
  let wakes = 0;
  const failure = Object.assign(new Error("private retention projection diagnostic"), { code: "55P03" });
  const controller = new PrivacyController({ withTenant: async () => { throw failure; } }, { wakePrivacy: async () => { wakes++; } }, {}, {});
  await assert.rejects(() => controller.updatePolicy({ principal: { tenantId } }, {
    state: "ACTIVE", resolvedCaseDays: 30, includeOpenCases: false, mediaDays: 30,
    unmatchedDiagnosticHours: 24, exportTtlHours: 24, expectedVersion: 1,
  }), error => {
    assert.equal(error.getStatus(), 409);
    assert.equal(error.getResponse().code, "CURRENT_PRINCIPAL_BUSY");
    assert.equal(JSON.stringify(error.getResponse()).includes("private retention projection diagnostic"), false);
    return true;
  });
  assert.equal(wakes, 0);
});
