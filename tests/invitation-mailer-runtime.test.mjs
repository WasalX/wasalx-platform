import assert from "node:assert/strict";
import {
  constants,
  generateKeyPairSync,
  publicEncrypt,
} from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalEmail, loadInvitationMailerConfig } from "../services/invitation-mailer/dist/config.js";
import {
  HttpsTransactionalEmailProvider,
  InvitationDeliveryError,
  SmtpTransactionalEmailProvider,
  buildInvitationAcceptanceUrl,
  classifySmtpFailure,
  decryptInvitationToken,
  invitationDeliverySecretsReady,
  smtpInvitationMessage,
  smtpTransportOptions,
} from "../services/invitation-mailer/dist/provider.js";
import { InvitationMailerProcessor, nextAttempt } from "../services/invitation-mailer/dist/processor.js";
import { invitationExpiry } from "../services/invitation-mailer/dist/repository.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const workerId = "22222222-2222-4222-8222-222222222222";
const deliveryId = "33333333-3333-4333-8333-333333333333";

test("mailer production configuration requires a live HTTPS or TLS-required SMTP provider", () => {
  const base = {
    NODE_ENV: "production",
    INVITATION_MAILER_DATABASE_URL: "postgresql://fixture:placeholder@db.example.test:5432/example_db",
    INVITATION_MAILER_TENANT_ID: tenantId,
    SECRET_SIDECAR_URL: "https://secrets.internal",
    SECRET_SIDECAR_TOKEN: "read-only-sidecar-token",
    INVITATION_TOKEN_PRIVATE_KEY_REFERENCES_JSON: JSON.stringify({ v1: "secret://platform/invitations/v1" }),
    INVITATION_EMAIL_PROVIDER_URL: "http://email.internal/send",
    INVITATION_EMAIL_PROVIDER_SECRET_REFERENCE: "secret://platform/email/provider",
    INVITATION_EMAIL_FROM: ["test-user-0456","example.home.arpa"].join("@"),
    INVITATION_EMAIL_TEMPLATE_ID: "wasalx-tenant-invitation-v1",
    PORTAL_PUBLIC_ORIGIN: "https://portal.example.com",
  };
  assert.throws(() => loadInvitationMailerConfig(base), /HTTPS endpoint or credential-free SMTP submission URL/);
  assert.throws(() => loadInvitationMailerConfig({
    ...base,
    INVITATION_EMAIL_PROVIDER_URL: "https://email.internal/v1/send",
    INVITATION_EMAIL_FROM: "support@wasalx.invalid",
  }), /INVITATION_EMAIL_FROM is invalid/u);
  assert.equal(canonicalEmail(["test-user-0510","example.home.arpa"].join("@"), "Simulation sender"), ["test-user-0510","example.home.arpa"].join("@"));
  assert.throws(() => loadInvitationMailerConfig({
    ...base,
    INVITATION_EMAIL_PROVIDER_URL: "https://email.internal/v1/send",
    INVITATION_EMAIL_FROM: ["test-user-0456","example.home.arpa,invalid"].join("@"),
  }), /INVITATION_EMAIL_FROM is invalid/u);
  const config = loadInvitationMailerConfig({
    ...base,
    INVITATION_EMAIL_PROVIDER_URL: "https://email.internal/v1/send",
  });
  assert.equal(config.tenantId, tenantId);
  assert.equal(config.privateKeyReferences.get("v1"), "secret://platform/invitations/v1");
  assert.equal(config.port, 8085);
  assert.equal(config.testRecipients, undefined);
  const mailFence = "WASALX_TEST_EMAIL_RECIPIENT_ALLOWLIST";
  const email = ["fixture-2718", "example.home.arpa"].join("@");
  const withFence = value => loadInvitationMailerConfig({
    ...base,
    INVITATION_EMAIL_PROVIDER_URL: "https://email.internal/v1/send",
    [mailFence]: value,
  });
  assert.deepEqual(withFence("").testRecipients, new Set());
  assert.deepEqual(withFence(JSON.stringify([email.toUpperCase()])).testRecipients, new Set([email]));
  for (const invalid of ["*", "null", "{}", '[1]', JSON.stringify([email, "*"])]) {
    assert.throws(() => withFence(invalid), /WASALX_TEST_EMAIL_RECIPIENT_ALLOWLIST/u);
  }
  const shared = loadInvitationMailerConfig({
    ...base,
    INVITATION_EMAIL_PROVIDER_URL: "https://email.internal/v1/send",
    INVITATION_MAILER_TENANT_ID: undefined,
  });
  assert.equal(shared.tenantId, undefined);
  const smtp = loadInvitationMailerConfig({
    ...base,
    INVITATION_EMAIL_PROVIDER_URL: "smtp://example.home.arpa:587",
  });
  assert.equal(smtp.providerUrl.protocol, "smtp:");
  for (const providerUrl of [
    "https://transactional-email.invalid/v1/send",
    "https://fixture:placeholder@api.example.test/mail",
    "smtp://example.home.arpa:25",
  ]) assert.throws(
    () => loadInvitationMailerConfig({ ...base, INVITATION_EMAIL_PROVIDER_URL: providerUrl }),
    /HTTPS endpoint or credential-free SMTP submission URL/,
  );
});

test("encrypted invitation tokens decrypt only with the referenced key version and stay in URL fragments", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const token = "A".repeat(43);
  const ciphertext = publicEncrypt({
    key: publicKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256",
  }, Buffer.from(JSON.stringify({ token }), "utf8"));
  const secrets = {
    ready: async () => true,
    resolve: async (reference) => {
      assert.equal(reference, "secret://platform/invitations/v1");
      return { keyVersion: "v1", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    },
  };
  const decrypted = await decryptInvitationToken({
    ciphertext,
    keyVersion: "v1",
    privateKeyReferences: new Map([["v1", "secret://platform/invitations/v1"]]),
    secrets,
  });
  assert.equal(decrypted, token);
  const invitationUrl = new URL(buildInvitationAcceptanceUrl("https://portal.example.com", decrypted));
  assert.equal(invitationUrl.pathname, "/invitations/accept");
  assert.equal(invitationUrl.search, "");
  assert.equal(invitationUrl.hash, `#token=${token}`);
  await assert.rejects(
    decryptInvitationToken({ ciphertext, keyVersion: "v2", privateKeyReferences: new Map(), secrets }),
    (error) => error instanceof InvitationDeliveryError && error.code === "INVITATION_KEY_VERSION_UNKNOWN" && !error.retryable,
  );
});

test("readiness fails closed unless provider and every configured private key resolve", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const good = await invitationDeliverySecretsReady({
    providerSecretReference: "secret://platform/email/provider",
    privateKeyReferences: new Map([["v1", "secret://platform/invitations/v1"]]),
    secrets: {
      ready: async () => true,
      resolve: async (reference) => reference.endsWith("provider")
        ? { apiKey: "provider-key" }
        : { keyVersion: "v1", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    },
  });
  assert.equal(good, true);
  const missing = await invitationDeliverySecretsReady({
    providerSecretReference: "secret://platform/email/provider",
    privateKeyReferences: new Map([["v1", "secret://platform/invitations/v1"]]),
    secrets: { ready: async () => true, resolve: async () => ({}) },
  });
  assert.equal(missing, false);
});

test("transactional provider requires a real provider receipt and sends an idempotent template request", async (context) => {
  let captured;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    captured = {
      authorization: request.headers.authorization,
      idempotency: request.headers["idempotency-key"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ message_id: "provider-receipt-123" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const provider = new HttpsTransactionalEmailProvider(
    new URL(`http://127.0.0.1:${address.port}/send`),
    "secret://platform/email/provider",
    { ready: async () => true, resolve: async () => ({ apiKey: "provider-api-key" }) },
  );
  const receipt = await provider.send({
    recipient: ["test-user-0155","example.home.arpa"].join("@"),
    sender: ["test-user-1653","example.home.arpa"].join("@"),
    templateId: "invite-v1",
    acceptanceUrl: "https://portal.example.com/invitations/accept#token=opaque",
    expiresAt: "2026-08-17T00:00:00.000Z",
    idempotencyKey: "invitation-job-1",
    deliveryId,
  });
  assert.equal(receipt.messageId, "provider-receipt-123");
  assert.equal(captured.authorization, "Bearer provider-api-key");
  assert.equal(captured.idempotency, "invitation-job-1");
  assert.equal(captured.body.to[0], ["test-user-0155","example.home.arpa"].join("@"));
  assert.match(captured.body.personalization.acceptance_url, /#token=/);

  await assert.rejects(
    () => provider.send({
      recipient: ["Victim <test-user-0251","example.home.arpa>"].join("@"), sender: ["test-user-1653","example.home.arpa"].join("@"),
      templateId: "invite-v1", acceptanceUrl: "https://portal.example.com/invitations/accept#token=opaque",
      idempotencyKey: "invalid-envelope", deliveryId,
    }),
    (error) => error instanceof InvitationDeliveryError && error.code === "EMAIL_PROVIDER_RECIPIENT_INVALID",
  );
});

test("SMTP invitation delivery requires STARTTLS and produces a stable receipt identity", () => {
  const endpoint = new URL("smtp://example.home.arpa:587");
  const options = smtpTransportOptions(endpoint, ["test-user-1318","example.home.arpa"].join("@"), " whitespace-bearing-password ");
  assert.deepEqual(options.auth, {
    user: ["test-user-1318","example.home.arpa"].join("@"),
    pass: " whitespace-bearing-password ",
  });
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.disableFileAccess, true);
  assert.equal(options.disableUrlAccess, true);
  const implicitTls = smtpTransportOptions(new URL("smtps://example.home.arpa:465"), ["test-user-1318","example.home.arpa"].join("@"), "password");
  assert.equal(implicitTls.secure, true);
  assert.equal(implicitTls.requireTLS, false);
  const input = {
    recipient: ["test-user-0155","example.home.arpa"].join("@"),
    sender: ["test-user-1318","example.home.arpa"].join("@"),
    templateId: "wasalx-first-client-beta-invitation-v1",
    acceptanceUrl: "https://portal.example.com/invitations/accept#token=opaque",
    expiresAt: "2026-09-05T00:00:00.000Z",
    idempotencyKey: "invitation-job-1",
    deliveryId,
  };
  const first = smtpInvitationMessage(input);
  const replay = smtpInvitationMessage(input);
  const distinct = smtpInvitationMessage({ ...input, deliveryId: "44444444-4444-4444-8444-444444444444" });
  assert.equal(first.messageId, replay.messageId);
  assert.notEqual(first.messageId, distinct.messageId);
  assert.match(first.messageId, /^<wasalx-invite-[a-f0-9]{64}@example\.home\.arpa>$/u);
  assert.match(first.text, /#token=opaque/u);
  assert.match(first.text, /2026-09-05T00:00:00\.000Z/u);
  assert.doesNotMatch(first.text, /invitation-job-1/u);
  assert.match(first.html, /Accept the invitation/u);
  assert.doesNotMatch(JSON.stringify(first), /bcc/iu);
  assert.deepEqual(classifySmtpFailure({ command: "CONN", code: "ETIMEDOUT" }), {
    code: "EMAIL_PROVIDER_SMTP_OUTCOME_UNKNOWN", retryable: false,
  });
  assert.deepEqual(classifySmtpFailure({ command: "CONN", code: "EDNS" }), {
    code: "EMAIL_PROVIDER_SMTP_UNAVAILABLE", retryable: true,
  });
  assert.deepEqual(classifySmtpFailure({ command: "RCPT TO", responseCode: 451 }), {
    code: "EMAIL_PROVIDER_SMTP_UNAVAILABLE", retryable: true,
  });
  assert.deepEqual(classifySmtpFailure({ command: "DATA", code: "ETIMEDOUT" }), {
    code: "EMAIL_PROVIDER_SMTP_OUTCOME_UNKNOWN", retryable: false,
  });
  assert.deepEqual(classifySmtpFailure({ command: "AUTH PLAIN", responseCode: 535 }), {
    code: "EMAIL_PROVIDER_SMTP_REJECTED", retryable: false,
  });
});

test("SMTP provider verifies credentials, requires exact acceptance, and fails ambiguous sends closed", async () => {
  const sent = [];
  const options = [];
  let verified = 0;
  let closed = 0;
  const factory = (value) => {
    options.push(value);
    return {
      verify: async () => { verified += 1; },
      sendMail: async (message) => {
        sent.push(message);
        return { accepted: [["test-user-0155","example.home.arpa"].join("@")], rejected: [], pending: [], messageId: message.messageId };
      },
      close: () => { closed += 1; },
    };
  };
  const provider = new SmtpTransactionalEmailProvider(
    new URL("smtp://example.home.arpa:587"),
    "secret://platform/email/provider",
    { ready: async () => true, resolve: async () => ({ apiKey: "smtp-secret-sentinel", smtpUsername: ["test-user-0020","example.home.arpa"].join("@") }) },
    ["test-user-1318","example.home.arpa"].join("@"),
    factory,
  );
  assert.equal(await provider.ready(), true);
  assert.equal(await provider.ready(), true);
  assert.equal(verified, 1);
  const receipt = await provider.send({
    recipient: ["test-user-0155","example.home.arpa"].join("@"),
    sender: ["test-user-1318","example.home.arpa"].join("@"),
    templateId: "wasalx-first-client-beta-invitation-v1",
    acceptanceUrl: "https://portal.example.com/invitations/accept#token=opaque",
    idempotencyKey: "invitation-job-1",
    deliveryId,
  });
  assert.equal(receipt.messageId, sent[0].messageId);
  assert.equal(options.at(-1).auth.pass, "smtp-secret-sentinel");
  assert.equal(options.at(-1).auth.user, ["test-user-0020","example.home.arpa"].join("@"));
  assert.equal(sent[0].from, ["test-user-1318","example.home.arpa"].join("@"));
  assert.equal(closed, 2);

  const factoryCalls = options.length;
  for (const recipient of [
    ["test-user-0251","example.home.arpa,invalid"].join("@"),
    ["test-user-0251","example.home.arpa;test-user-0939","example.home.arpa"].join("@"),
    ["Victim <test-user-0251","example.home.arpa>"].join("@"),
  ]) {
    await assert.rejects(
      () => provider.send({
        recipient, sender: ["test-user-1318","example.home.arpa"].join("@"), templateId: "invite-v1",
        acceptanceUrl: "https://portal.example.com/invitations/accept#token=opaque",
        idempotencyKey: "invalid-envelope", deliveryId,
      }),
      (error) => error instanceof InvitationDeliveryError && error.code === "EMAIL_PROVIDER_RECIPIENT_INVALID",
    );
  }
  assert.equal(options.length, factoryCalls);
  assert.equal(sent.length, 1);

  const ambiguous = new SmtpTransactionalEmailProvider(
    new URL("smtp://example.home.arpa:587"),
    "secret://platform/email/provider",
    { ready: async () => true, resolve: async () => ({ apiKey: "smtp-secret-sentinel" }) },
    ["test-user-1318","example.home.arpa"].join("@"),
    () => ({
      verify: async () => {}, close: () => {},
      sendMail: async () => { throw { command: "CONN", code: "ETIMEDOUT" }; },
    }),
  );
  await assert.rejects(
    () => ambiguous.send({
      recipient: ["test-user-0155","example.home.arpa"].join("@"), sender: ["test-user-1318","example.home.arpa"].join("@"), templateId: "invite-v1",
      acceptanceUrl: "https://portal.example.com/invitations/accept#token=opaque", idempotencyKey: "job-2",
      deliveryId: "55555555-5555-4555-8555-555555555555",
    }),
    (error) => error instanceof InvitationDeliveryError
      && error.code === "EMAIL_PROVIDER_SMTP_OUTCOME_UNKNOWN"
      && error.retryable === false
      && !error.safeMessage.includes("smtp-secret-sentinel"),
  );
});

test("SMTP readiness coalesces failures and recovers within the rollout deadline", async () => {
  let now = 1_000;
  let verified = 0;
  let closed = 0;
  let failVerification = true;
  const provider = new SmtpTransactionalEmailProvider(
    new URL("smtp://example.home.arpa:587"),
    "secret://platform/email/provider",
    { ready: async () => true, resolve: async () => ({ apiKey: "smtp-secret-sentinel" }) },
    ["test-user-1318","example.home.arpa"].join("@"),
    () => ({
      verify: async () => {
        verified += 1;
        if (failVerification) throw new Error("provider unavailable");
      },
      sendMail: async () => { throw new Error("not used"); },
      close: () => { closed += 1; },
    }),
    () => now,
  );

  assert.deepEqual(await Promise.all([provider.ready(), provider.ready(), provider.ready()]), [false, false, false]);
  assert.equal(verified, 1);
  assert.equal(closed, 1);

  now += 59_999;
  assert.equal(await provider.ready(), false);
  assert.equal(verified, 1);
  assert.equal(closed, 1);

  now += 1;
  assert.deepEqual(await Promise.all([provider.ready(), provider.ready()]), [false, false]);
  assert.equal(verified, 2);
  assert.equal(closed, 2);

  now += 59_999;
  assert.equal(await provider.ready(), false);
  assert.equal(verified, 2);
  assert.equal(closed, 2);

  now += 1;
  failVerification = false;
  assert.deepEqual(await Promise.all([provider.ready(), provider.ready(), provider.ready()]), [true, true, true]);
  assert.equal(verified, 3);
  assert.equal(closed, 3);

  now += 59_999;
  assert.equal(await provider.ready(), true);
  assert.equal(verified, 3);
  assert.equal(closed, 3);
});

test("repository normalizes PostgreSQL invitation expiry dates", () => {
  assert.equal(invitationExpiry(new Date("2026-09-05T00:00:00.000Z")), "2026-09-05T00:00:00.000Z");
  assert.equal(invitationExpiry("2026-09-05T00:00:00.000Z"), "2026-09-05T00:00:00.000Z");
  assert.throws(() => invitationExpiry("not-a-date"), /invalid invitation expiry/iu);
});

test("processor completes only after a provider receipt and preserves fencing", async () => {
  const fixture = mailerFixture();
  const result = await fixture.processor.drainOnce();
  assert.deepEqual(result, { claimed: 1, sent: 1, retrying: 0, terminal: 0, stale: 0 });
  assert.equal(fixture.calls.complete.length, 1);
  assert.equal(fixture.calls.complete[0].providerMessageId, "provider-123");
  assert.equal(fixture.calls.complete[0].job.fencing_token, "7");
  assert.equal(fixture.calls.fail.length, 0);
});

test("a persistence failure after a provider receipt never schedules an automatic resend", async () => {
  const fixture = mailerFixture({ completeError: new Error("database unavailable") });
  assert.equal((await fixture.processor.drainOnce()).terminal, 1);
  assert.equal(fixture.calls.complete.length, 1);
  assert.equal(fixture.calls.fail.length, 1);
  assert.equal(fixture.calls.fail[0].input.retryable, false);
  assert.equal(fixture.calls.fail[0].input.code, "EMAIL_PROVIDER_RECEIPT_PERSISTENCE_UNKNOWN");
  assert.match(fixture.calls.fail[0].input.safeError, /operator verification/u);
});

test("retryable provider failures back off, exhaust to terminal, and stale leases never report success", async () => {
  const retry = mailerFixture({
    provider: { send: async () => { throw new InvitationDeliveryError("EMAIL_PROVIDER_503", true, "temporary"); } },
  });
  assert.equal((await retry.processor.drainOnce()).retrying, 1);
  assert.equal(retry.calls.fail[0].input.retryable, true);

  const exhausted = mailerFixture({
    attempts: 8,
    provider: { send: async () => { throw new InvitationDeliveryError("EMAIL_PROVIDER_503", true, "temporary"); } },
  });
  assert.equal((await exhausted.processor.drainOnce()).terminal, 1);
  assert.equal(exhausted.calls.fail[0].input.retryable, false);

  const stale = mailerFixture({ completeResult: false });
  assert.equal((await stale.processor.drainOnce()).stale, 1);
});

test("the invitation mail fence stops non-members before secret access or provider delivery", async () => {
  const recipient = ["fixture-2718", "example.home.arpa"].join("@");
  let sends = 0;
  let secretReads = 0;
  const provider = { send: async input => {
    assert.equal(input.recipient, recipient);
    sends++;
    return { messageId: "provider-allowed" };
  } };
  const fixture = testRecipients => mailerFixture({
    recipient, testRecipients, provider, onResolve: () => { secretReads++; },
  });
  for (const recipients of [new Set(), new Set([["fixture-0002", "example.home.arpa"].join("@")])]) {
    const denied = fixture(recipients);
    assert.equal((await denied.processor.drainOnce()).terminal, 1);
    assert.equal(denied.calls.fail[0].input.code, "EMAIL_TEST_RECIPIENT_NOT_ALLOWED");
    assert.equal(denied.calls.fail[0].input.retryable, false);
  }
  assert.equal(secretReads, 0);
  assert.equal(sends, 0);
  assert.equal((await fixture(new Set([recipient])).processor.drainOnce()).sent, 1);
  assert.equal(secretReads, 1);
  assert.equal(sends, 1);
});

test("retry schedule is bounded and source logging never includes token, recipient, or ciphertext fields", async () => {
  const earliest = Date.now() + 1_400;
  const latest = Date.now() + 2_600;
  const scheduled = nextAttempt(1, () => 0.5).getTime();
  assert.ok(scheduled >= earliest && scheduled <= latest);
  const source = await readFile(new URL("../services/invitation-mailer/src/processor.ts", import.meta.url), "utf8");
  for (const forbidden of ["recipient_email:", "token:", "token_ciphertext:", "acceptanceUrl:"]) {
    assert.doesNotMatch(source, new RegExp(`recordStructuredLog\\([^)]*${forbidden}`, "su"));
  }
});

test("shared tenant discovery exposes UUIDs only and keeps payload claims tenant-scoped", async () => {
  const migration = await readFile(new URL("../services/control-api/migrations/0027_identity_policy_activation_runtime.sql", import.meta.url), "utf8");
  assert.match(migration, /RETURNS SETOF uuid/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION app\.pending_invitation_email_tenants\(integer\)\s+TO wasalx_invitation_mailer/i);
  assert.match(migration, /GRANT CONNECT ON DATABASE %I TO wasalx_invitation_mailer/i);
  assert.doesNotMatch(migration, /RETURNS SETOF tenant_invitation_email_outbox[\s\S]*pending_invitation_email_tenants/i);
  const repository = await readFile(new URL("../services/invitation-mailer/src/repository.ts", import.meta.url), "utf8");
  assert.match(repository, /pending_invitation_email_tenants/);
  assert.match(repository, /set_config\('app\.tenant_id',\$1,true\)/);
  assert.match(repository, /claim_invitation_email_jobs/);
});

test("ordinary tenant runtime cannot read invitation delivery secrets", async () => {
  const migration = await readFile(new URL("../services/control-api/migrations/0029_invitation_outbox_least_privilege.sql", import.meta.url), "utf8");
  assert.match(
    migration,
    /REVOKE ALL PRIVILEGES ON TABLE public\.tenant_invitation_email_outbox\s+FROM PUBLIC,wasalx_app/i,
  );
  assert.match(
    migration,
    /REVOKE SELECT \(recipient_email,token_ciphertext,token_key_version\)\s+ON TABLE public\.tenant_invitation_email_outbox FROM PUBLIC,wasalx_app/i,
  );
  const selectGrant = migration.match(
    /GRANT SELECT \(([^)]+)\) ON TABLE public\.tenant_invitation_email_outbox TO wasalx_app/i,
  )?.[1] ?? "";
  for (const required of ["idempotency_key", "request_sha256", "state", "safe_error"]) {
    assert.match(selectGrant, new RegExp(`\\b${required}\\b`, "i"));
  }
  for (const forbidden of ["recipient_email", "token_ciphertext", "token_key_version"]) {
    assert.doesNotMatch(selectGrant, new RegExp(`\\b${forbidden}\\b`, "i"));
  }
  assert.match(
    migration,
    /GRANT INSERT \([\s\S]*token_ciphertext[\s\S]*\) ON TABLE public\.tenant_invitation_email_outbox TO wasalx_app/i,
  );
  assert.doesNotMatch(
    migration,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE)(?:\s*,\s*(?:SELECT|INSERT|UPDATE|DELETE))* ON (?:TABLE )?public\.tenant_invitation_email_outbox TO wasalx_app/i,
  );
  const original = await readFile(new URL("../services/control-api/migrations/0019_tenant_administration.sql", import.meta.url), "utf8");
  assert.match(original, /GRANT SELECT,UPDATE ON tenant_invitation_email_outbox TO wasalx_invitation_mailer/i);
  assert.match(original, /GRANT EXECUTE ON FUNCTION app\.claim_invitation_email_jobs\(uuid,integer\)\s+TO wasalx_invitation_mailer/i);
});

test("ordinary tenant runtime cannot read invitation token hashes", async () => {
  const migration = await readFile(new URL("../services/control-api/migrations/0029_invitation_outbox_least_privilege.sql", import.meta.url), "utf8");
  assert.match(
    migration,
    /REVOKE ALL PRIVILEGES ON TABLE public\.tenant_invitations\s+FROM PUBLIC,wasalx_app/i,
  );
  assert.match(
    migration,
    /REVOKE SELECT \(token_hash,create_idempotency_key,create_request_sha256\)\s+ON TABLE public\.tenant_invitations FROM PUBLIC,wasalx_app/i,
  );
  const selectGrant = migration.match(
    /GRANT SELECT \(([^)]+)\) ON TABLE public\.tenant_invitations TO wasalx_app/i,
  )?.[1] ?? "";
  for (const required of ["id", "tenant_id", "email", "role", "state", "expires_at", "version"]) {
    assert.match(selectGrant, new RegExp(`\\b${required}\\b`, "i"));
  }
  for (const forbidden of ["token_hash", "create_idempotency_key", "create_request_sha256"]) {
    assert.doesNotMatch(selectGrant, new RegExp(`\\b${forbidden}\\b`, "i"));
  }
  assert.match(
    migration,
    /GRANT INSERT \([\s\S]*token_hash[\s\S]*create_request_sha256[\s\S]*\) ON TABLE public\.tenant_invitations TO wasalx_app/i,
  );
  assert.match(
    migration,
    /GRANT UPDATE \([\s\S]*token_hash[\s\S]*revoked_at[\s\S]*\) ON TABLE public\.tenant_invitations TO wasalx_app/i,
  );
  assert.doesNotMatch(
    migration,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE)(?:\s*,\s*(?:SELECT|INSERT|UPDATE|DELETE))* ON (?:TABLE )?public\.tenant_invitations TO wasalx_app/i,
  );
  const original = await readFile(new URL("../services/control-api/migrations/0019_tenant_administration.sql", import.meta.url), "utf8");
  assert.match(original, /SECURITY DEFINER[\s\S]*app\.accept_tenant_invitation|app\.accept_tenant_invitation[\s\S]*SECURITY DEFINER/i);
  assert.match(original, /GRANT EXECUTE ON FUNCTION app\.accept_tenant_invitation\(text,text,text,text\) TO wasalx_app/i);
});

function mailerFixture(options = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const token = "B".repeat(43);
  const job = {
    id: "33333333-3333-4333-8333-333333333333",
    tenant_id: tenantId,
    invitation_id: "44444444-4444-4444-8444-444444444444",
    action: "INVITE",
    recipient_email: options.recipient ?? "invitee@example.com",
    token_ciphertext: publicEncrypt({
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    }, Buffer.from(JSON.stringify({ token }), "utf8")),
    token_key_version: "v1",
    idempotency_key: "invite-job-1",
    attempts: options.attempts ?? 1,
    fencing_token: "7",
    expires_at: "2026-08-17T00:00:00.000Z",
  };
  const calls = { complete: [], fail: [] };
  const store = {
    claim: async () => [job],
    complete: async (claimed, claimedWorkerId, providerMessageId) => {
      calls.complete.push({ job: claimed, workerId: claimedWorkerId, providerMessageId });
      if (options.completeError) throw options.completeError;
      return options.completeResult ?? true;
    },
    fail: async (claimed, claimedWorkerId, input) => {
      calls.fail.push({ job: claimed, workerId: claimedWorkerId, input });
      return options.failResult ?? true;
    },
    ready: async () => true,
    close: async () => undefined,
  };
  const secrets = {
    ready: async () => true,
    resolve: async () => {
      options.onResolve?.();
      return { keyVersion: "v1", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    },
  };
  const provider = options.provider ?? { send: async () => ({ messageId: "provider-123" }) };
  const processor = new InvitationMailerProcessor({
    workerId,
    batchSize: 10,
    maxAttempts: 8,
    privateKeyReferences: new Map([["v1", "secret://platform/invitations/v1"]]),
    portalOrigin: "https://portal.example.com",
    sender: "operations@example.com",
    templateId: "invite-v1",
    testRecipients: options.testRecipients,
  }, store, secrets, provider);
  return { processor, calls };
}
