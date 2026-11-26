import assert from "node:assert/strict";
import test from "node:test";
import { metricNames, parseTraceParent, recordStructuredLog, redactLogValue } from "../packages/observability/src/index.ts";

test("structured log redaction removes bodies, secrets, tokens, and phone numbers",()=>{const redacted=redactLogValue({tenant_id:"tenant-a",body:"customer message",nested:{authorization:"Bearer secret",phone:"+12025550178"},safe:"connection +12025550179"}) as Record<string,unknown>;assert.equal(redacted.body,"[REDACTED]");assert.deepEqual(redacted.nested,{authorization:"[REDACTED]",phone:"[REDACTED]"});assert.equal(redacted.safe,"connection [PHONE]");assert.equal(redacted.tenant_id,"tenant-a")});

for (const key of [
  "email", "recipient_email", "recipientEmail", "recipient-email",
  "name", "display_name", "displayName", "display-name",
  "recipient", "primary_recipient", "primaryRecipient", "primary-recipient",
  "subject", "subject_line", "subjectLine", "subject-line",
  "EMAILAddress", "recipientEMAIL", "DisplayName", "SUBJECT-LINE",
  "firstName", "last_name", "full-name", "contactName", "senderName", "recipientName",
  "username", "userName", "pushname", "pushName", "contact", "sender",
  "to", "from", "headers.to", "e_mail", "emailId", "recipient_id",
  "apiKey", "credentials", "credential", "privateKey", "signature", "otp", "totp",
  "http.request.body", "auth.token", "x-hub-signature-256",
  "message", "title", "title_id", "filename", "filename_id", "group_name", "group_name_id",
  "url", "reference", "mEsSaGe_Id",
  "wa_id", "waId", "WA_ID", "waIds", "participant", "participants", "author", "authors",
  "customer_name", "customerName", "agentName", "profile_name", "profile.name", "nickname",
  "cc", "headers.bcc", "reply_to", "replyTo", "mail_from", "address",
  "access_key", "accessKeyId", "passphrase", "hmac",
  "session", "sessionId", "jwt", "key", "headers.sig",
]) {
  test(`structured logs redact ${key}`, () => {
    assert.deepEqual(redactLogValue({ [key]: "synthetic value" }), { [key]: "[REDACTED]" });
  });
}

test("structured logs preserve record identifiers and unrelated fields", () => {
  const fields = {
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    request_id: "request-1",
    delivery_ids: ["delivery-1"],
    workspace_namespace: "test-workspace",
    service_name: "control-api",
    queueName: "outbox",
    "template-name": "status-update",
    from_state: "pending",
    toState: "sent",
  };
  assert.deepEqual(redactLogValue(fields), fields);
});

test("structured logs preserve internal UUIDs and message counters", () => {
  const internalId = "10000000-0000-4000-8000-000000000001";
  const fields = {
    contact_id: internalId, senderId: internalId, subject_id: internalId, emailID: internalId,
    contact_ids: [internalId],
    message_count: 3, messagesSent: 2,
  };
  assert.deepEqual(redactLogValue(fields), fields);
  assert.deepEqual(redactLogValue({
    contact_id: "12025550102",
    contact_ids: [internalId, "12025550102"],
    message_count: "fixture message",
  }), {
    contact_id: "[REDACTED]", contact_ids: "[REDACTED]", message_count: "[REDACTED]",
  });
});

test("structured logs redact phone-shaped numbers and digit strings", () => {
  assert.deepEqual(redactLogValue({
    wa_id: 12025550102,
    detail: [12025550102, "12025550102", 42, "12345"],
  }), { wa_id: "[REDACTED]", detail: ["[PHONE]", "[PHONE]", 42, "12345"] });
});

for (const [format, number] of [
  ["local leading zero", "07700900000"],
  ["dotted 2+2+6", "06.12.345678"],
  ["international 00 prefix", "0012025550102"],
  ["Arabic-Indic digits", "٠٧٧٠٠٩٠٠٠٠٠"],
  ["extended Arabic-Indic digits", "۰۰۱۲۰۲۵۵۵۰۱۰۲"],
  ["formatted Arabic-Indic digits", "+١ ٢٠٢ ٥٥٥ ٠١٠٢"],
]) {
  test(`structured logs redact ${format} in free text and arrays`, () => {
    assert.deepEqual(redactLogValue({ detail: `Called ${number}.`, entries: [number] }), {
      detail: "Called [PHONE].", entries: ["[PHONE]"],
    });
  });
}

for (const key of ["mobile", "msisdn", "tel", "jid", "customer", "to_number", "caller_number"]) {
  test(`structured logs redact bare phone strings under ${key}`, () => {
    assert.deepEqual(redactLogValue({ [key]: "12025550102" }), { [key]: "[REDACTED]" });
  });
}

test("structured logs preserve long numeric IDs and timestamps in fields", () => {
  const fields = {
    at: 1764000000000,
    timestamp: "2026-11-24T12:05:00.000Z",
    waba_id: "123456789012345",
    business_id: 123456789012345,
    customer_id: "12025550102",
    ticket_number: "20261124000123",
    request_id: "120255501020",
    external_id: "٠٧٧٠٠٩٠٠٠٠٠",
    job_id: 120255501021,
  };
  assert.deepEqual(redactLogValue(fields), fields);
});

test("phone redaction covers grouped and wide digits without hiding dates or mobile metadata", () => {
  const phones = [
    "202 5550102",
    "0770 0900123",
    "07700 900123",
    "1-202-555-0102",
    "00 1 202 555 0102",
    "001 2025550102",
    "00 12025550102",
    "０７７００９００１２３",
  ];
  const phoneFields = Object.fromEntries(
    ["number", "telephone", "cellphone", "whatsapp", "from_number", "whatsappNumber", "customer_mobile"].map(
      key => [key, "12025550102"],
    ),
  );
  const preserved = { request_id: "120255501020", is_mobile: true, mobile_platform: "android", isMobile: false };
  const dates = ["Date 24-11-2026.", "Date 24.11.2026.", "Date 2026-11-24."];
  assert.deepEqual(redactLogValue({
    detail: [...phones.map(value => "Called " + value + "."), ...dates],
    ...phoneFields,
    ...preserved,
  }), {
    detail: [...phones.map(() => "Called [PHONE]."), ...dates],
    ...Object.fromEntries(Object.keys(phoneFields).map(key => [key, "[REDACTED]"])),
    ...preserved,
  });
});

test("structured logs redact phone numbers embedded in text with common separators", () => {
  const cases = [
    "12025550102", "+999 50 555 0102", "050-000-0000", "202.555.0102", "(202) 555-0102",
  ];
  for (const number of cases) {
    assert.deepEqual(redactLogValue({ detail: `Customer ${number} called.` }), {
      detail: "Customer [PHONE] called.",
    });
  }
});

test("structured logs redact phones after a hyphen and preserve UUIDs and dates in text", () => {
  const preserved = "10000000-dead-4000-8abc-000000000001 on 2026-11-24";
  assert.equal(redactLogValue(`ID-(202) 555-0102; ${preserved}`), `ID-[PHONE]; ${preserved}`);
  const labelledDates = "date-24-11-2026; date-2026-11-24";
  assert.equal(redactLogValue(labelledDates), labelledDates);
});

test("structured logs preserve space-separated dates", () => {
  const detail = "Date 24 11 2026.";
  assert.deepEqual(redactLogValue({ detail }), { detail });
});

test("structured logs preserve whitespace-separated number pairs", () => {
  const detail = "Values 8080 1234567.";
  assert.deepEqual(redactLogValue({ detail }), { detail });
});

test("structured logs keep label-hyphen-digit IDs", () => {
  const fields = { request_id: "req-1764000000000", job_id: "wa-1764000000000", trace: "req-0123456789" };
  assert.deepEqual(redactLogValue(fields), fields);
  const text = "TKT-20261124000123 and import-1764000000000 and req-0012025550102 done";
  assert.deepEqual(redactLogValue({ detail: text }), { detail: text });
});

test("structured logs drop split localized phone fragments after a hyphen", () => {
  const prefix = `${"x ".repeat(994)}ID-`;
  assert.equal(redactLogValue(`${prefix}+١ ٢٠٢ ٥٥٥ ٠١٠٢`), `${prefix}…`);
});

test("structured logs redact JWTs in text", () => {
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c3ludGhldGlj";
  assert.deepEqual(redactLogValue({ detail: `Rejected ${token}.` }), {
    detail: "Rejected [CREDENTIAL].",
  });
});

test("structured logs redact provider message and chat identifiers", () => {
  const wahaId = "false_12025550102@c.us_SAMPLE";
  const metaId = "wamid.MTIwMjU1NTAxMDI=";
  assert.deepEqual(redactLogValue({
    message_id: wahaId,
    message_ids: [wahaId],
    messageId: metaId,
    externalMessageID: metaId,
    wamid: metaId,
    "chat-id": "12025550102",
    externalChatIDs: ["12025550102"],
    id: metaId,
    detail: `Received ${wahaId}`,
    group: "Received false_123456789-123456789@g.us_SAMPLE_12025550102@c.us.",
    linked: "Received false_123456789@g.us_SAMPLE_12025550102@lid.",
    bareLink: "Received 12025550102@lid.",
  }), {
    message_id: "[REDACTED]",
    message_ids: "[REDACTED]",
    messageId: "[REDACTED]",
    externalMessageID: "[REDACTED]",
    wamid: "[REDACTED]",
    "chat-id": "[REDACTED]",
    externalChatIDs: "[REDACTED]",
    id: "[REDACTED]",
    detail: "Received [REDACTED]",
    group: "Received [REDACTED].",
    linked: "Received [REDACTED].",
    bareLink: "Received [REDACTED].",
  });
});

test("structured logs redact nested personal arrays by their field key", () => {
  assert.deepEqual(redactLogValue({
    entries: [{
      recipients: [{ label: "synthetic value" }],
      emails: [["synthetic value"]],
      names: ["synthetic value"],
      subjects: ["synthetic value"],
      context: { to: ["12025550102"], "auth.privateKey": "synthetic value" },
    }],
  }), {
    entries: [{
      recipients: "[REDACTED]",
      emails: "[REDACTED]",
      names: "[REDACTED]",
      subjects: "[REDACTED]",
      context: { to: "[REDACTED]", "auth.privateKey": "[REDACTED]" },
    }],
  });
});

test("structured logs scrub email addresses from free text and unlabeled array items", () => {
  assert.deepEqual(redactLogValue({
    detail: "Sent to <Fixture.Person+alerts@sub.example.test>.",
    entries: ["other@example.test", "missing address", { detail: "synthetic@example.test" }],
  }), {
    detail: "Sent to <[EMAIL]>.",
    entries: ["[EMAIL]", "missing address", { detail: "[EMAIL]" }],
  });
});

test("structured logs bound long value scans and skip the email regex when there is no at-sign", (t) => {
  const prefix = "fixture-log ";
  const value = prefix.padEnd(1_000_000, "x");
  const exec = RegExp.prototype.exec;
  let longestInput = 0;
  let scannedForEmail = false;
  const scan = t.mock.method(RegExp.prototype, "exec", function (this: RegExp, input: string) {
    if (input.startsWith(prefix)) {
      longestInput = Math.max(longestInput, input.length);
      scannedForEmail ||= this.source.startsWith("[\\p{L}\\p{N}.");
    }
    return exec.call(this, input);
  });
  const actual = redactLogValue(value);
  scan.mock.restore();
  assert.equal(actual, `${prefix}…`);
  assert.deepEqual({ boundedInput: longestInput <= 2_000, scannedForEmail }, {
    boundedInput: true, scannedForEmail: false,
  });
});

for (const [kind, secret, fragment] of [
  ["email", "fixture.local@example.test", "fixture"],
  ["phone", "+1 202 555 0102", "+1"],
]) {
  test(`structured logs drop split ${kind} fragments after earlier redaction shrinks text`, () => {
    const credential = `Bearer ${"A".repeat(1_500)} `;
    for (const start of [2_394, 1_994]) {
      const prefix = `${credential.padEnd(start - 1, "x ")} `;
      const result = redactLogValue(prefix + secret);
      assert(typeof result === "string");
      assert(result.startsWith("[CREDENTIAL] "));
      assert(!result.includes(fragment), `a secret fragment survived at offset ${start}`);
      assert(result.endsWith("…"));
    }
  });
}

test("structured logs preserve token boundaries when replacement markers expand the text", () => {
  const result = redactLogValue(`x ${"a@b.c ".repeat(333)}`);
  assert(typeof result === "string");
  assert(result.length <= 2_001);
  assert.match(result, /^x (?:\[EMAIL\] )+…$/u);
});

test("structured logs redact toJSON output before it reaches the sink", (t) => {
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (line: string) => { lines.push(line); return true; });
  const projection = {
    value: "+1 202 555 0102",
    toJSON() { return { phone: this.value, detail: "fixture@example.test" }; },
  };
  const nestedProjection = { toJSON() { return { detail: projection }; } };
  recordStructuredLog("warn", "fixture", { projected: nestedProjection });
  assert.deepEqual(JSON.parse(lines[0]).projected, {
    detail: { phone: "[REDACTED]", detail: "[EMAIL]" },
  });
});

test("structured logs serialize BigInt values without losing precision", (t) => {
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (line: string) => { lines.push(line); return true; });
  recordStructuredLog("warn", "fixture", { counter: BigInt("900719925474099312345") });
  assert.equal(JSON.parse(lines[0]).counter, "900719925474099312345");
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

