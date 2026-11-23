import assert from "node:assert/strict";
import test from "node:test";
import { metricNames, parseTraceParent, redactLogValue } from "../packages/observability/src/index.ts";

test("structured log redaction removes bodies, secrets, tokens, and phone numbers",()=>{const redacted=redactLogValue({tenant_id:"tenant-a",body:"customer message",nested:{authorization:"Bearer secret",phone:"+12025550178"},safe:"connection +12025550179"}) as Record<string,unknown>;assert.equal(redacted.body,"[REDACTED]");assert.deepEqual(redacted.nested,{authorization:"[REDACTED]",phone:"[REDACTED]"});assert.equal(redacted.safe,"connection [PHONE]");assert.equal(redacted.tenant_id,"tenant-a")});

for (const key of [
  "email", "recipient_email", "recipientEmail", "recipient-email",
  "name", "display_name", "displayName", "display-name",
  "recipient", "primary_recipient", "primaryRecipient", "primary-recipient",
  "subject", "subject_line", "subjectLine", "subject-line",
  "EMAILAddress", "recipientEMAIL", "DisplayName", "SUBJECT-LINE",
]) {
  test(`structured logs redact ${key}`, () => {
    assert.deepEqual(redactLogValue({ [key]: "synthetic value" }), { [key]: "[REDACTED]" });
  });
}

test("structured logs preserve record identifiers and unrelated fields", () => {
  const fields = {
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    externalMessageID: "message-1",
    recipient_id: "recipient-1",
    "subject-ids": ["subject-1"],
    workspace_namespace: "test-workspace",
  };
  assert.deepEqual(redactLogValue(fields), fields);
});

test("structured log redaction still applies to credentials with identifier suffixes", () => {
  assert.deepEqual(redactLogValue({
    authorization_id: "synthetic value",
    apiTokenId: "synthetic value",
    passKey: "synthetic value",
  }), {
    authorization_id: "[REDACTED]",
    apiTokenId: "[REDACTED]",
    passKey: "[REDACTED]",
  });
});

test("traceparent parser rejects zero and malformed identifiers",()=>{assert.deepEqual(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),{traceId:"4bf92f3577b34da6a3ce929d0e0e4736",parentId:"00f067aa0ba902b7",sampled:true});assert.equal(parseTraceParent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"),null);assert.equal(parseTraceParent("bad"),null)});
test("metric catalog includes acceptance, latency, failure, authorization, privacy, and WAHA capacity signals",()=>{assert.ok(metricNames.includes("wasalx_webhook_accepted_total"));assert.ok(metricNames.includes("wasalx_delivery_terminal_failure_total"));assert.ok(metricNames.includes("wasalx_delivery_persistence_failure_total"));assert.ok(metricNames.includes("wasalx_tenant_authorization_denied_total"));assert.ok(metricNames.includes("wasalx_privacy_job_total"));assert.ok(metricNames.includes("wasalx_privacy_legal_hold_block_total"));assert.ok(metricNames.includes("wasalx_unmatched_diagnostic_purged_total"));assert.ok(metricNames.includes("wasalx_waha_worker_health"));assert.ok(metricNames.includes("wasalx_waha_worker_capacity"));assert.ok(metricNames.includes("wasalx_waha_worker_sessions"));assert.ok(metricNames.includes("wasalx_waha_worker_mode_changes_total"))});

