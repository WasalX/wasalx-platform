import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
} from "jose";

import {
  AttestationError,
  IdentityPolicyAttestationVerifier,
  REQUIRED_VERIFIED_CONTROLS,
  equalSha256,
  identityPolicySha256,
} from "../services/identity-policy-activator/dist/attestation.js";
import { loadIdentityPolicyActivatorConfig } from "../services/identity-policy-activator/dist/config.js";
import { createIdentityPolicyHandler } from "../services/identity-policy-activator/dist/server.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const policy = {
  tenant_id: tenantId,
  version: "9",
  sso_enforcement_state: "REQUESTED",
  sso_provider_name: "Example Identity",
  sso_issuer: "https://identity.example.com/realms/example",
  sso_email_domains: ["example.com", "operations.example.com"],
  mfa_required_roles: ["tenant_admin", "tenant_owner"],
  session_timeout_minutes: 480,
  privileged_reauth_minutes: 15,
  support_access_requires_approval: true,
  security_policy_state: "REQUESTED",
};

test("policy snapshots are canonical and bind every requested session and IdP control", () => {
  const digest = identityPolicySha256(policy);
  const reordered = identityPolicySha256({
    ...policy,
    sso_email_domains: [...policy.sso_email_domains].reverse(),
    mfa_required_roles: [...policy.mfa_required_roles].reverse(),
  });
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, reordered);
  assert.equal(equalSha256(digest, reordered), true);
  assert.equal(equalSha256(digest, "0".repeat(64)), false);
});

test("signed independent attestation requires the exact audience, type, subject, controls, and fresh lifetime", async (context) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: "verifier-key-1", alg: "RS256", use: "sig" });
  const jwksServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => jwksServer.close(resolve)));
  const address = jwksServer.address();
  assert.ok(address && typeof address === "object");
  const verifier = new IdentityPolicyAttestationVerifier(
    "https://policy-verifier.example.com",
    "wasalx-identity-policy-activator",
    new URL(`http://127.0.0.1:${address.port}/jwks`),
  );
  const sign = (controls = REQUIRED_VERIFIED_CONTROLS) => new SignJWT({
    tenant_id: tenantId,
    settings_version: 9,
    policy_sha256: identityPolicySha256(policy),
    verified_controls: controls,
  })
    .setProtectedHeader({ alg: "RS256", kid: "verifier-key-1", typ: "wasalx-idp-session-attestation+jwt" })
    .setIssuer("https://policy-verifier.example.com")
    .setAudience("wasalx-identity-policy-activator")
    .setSubject("identity-policy-verifier")
    .setJti("verification-run-123")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);

  const verified = await verifier.verify(await sign());
  assert.equal(verified.tenantId, tenantId);
  assert.equal(verified.settingsVersion, 9);
  assert.equal(verified.policySha256, identityPolicySha256(policy));
  assert.match(verified.evidenceSha256, /^[0-9a-f]{64}$/);

  await assert.rejects(
    verifier.verify(await sign(REQUIRED_VERIFIED_CONTROLS.slice(1))),
    (error) => error instanceof AttestationError && error.code === "ATTESTATION_CONTROLS_INCOMPLETE",
  );
});

test("activation handler fails closed on policy mismatch and activates only inside the requested-policy transaction", async (context) => {
  let activatedEvidence;
  let requested = true;
  const store = {
    ready: async () => true,
    close: async () => undefined,
    withRequestedPolicy: async (_tenantId, _version, operation) => {
      if (!requested) return null;
      return operation(policy, async (evidence) => {
        activatedEvidence = evidence;
        requested = false;
        return true;
      });
    },
  };
  let mismatch = true;
  const verifier = {
    ready: async () => true,
    verify: async () => ({
      tenantId,
      settingsVersion: 9,
      policySha256: mismatch ? "0".repeat(64) : identityPolicySha256(policy),
      verificationRunId: "verification-run-123",
      evidenceSha256: "a".repeat(64),
    }),
  };
  const server = createServer(createIdentityPolicyHandler(store, verifier));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/internal/v1/identity-policy/activate`;

  const mismatchResponse = await fetch(url, { method: "POST", headers: { authorization: "Bearer signed-attestation" } });
  assert.equal(mismatchResponse.status, 409);
  assert.equal((await mismatchResponse.json()).error.code, "POLICY_SNAPSHOT_MISMATCH");
  assert.equal(activatedEvidence, undefined);

  mismatch = false;
  const success = await fetch(url, { method: "POST", headers: { authorization: "Bearer signed-attestation" } });
  assert.equal(success.status, 200);
  assert.equal((await success.json()).state, "ACTIVE");
  assert.equal(activatedEvidence, "a".repeat(64));

  const replay = await fetch(url, { method: "POST", headers: { authorization: "Bearer signed-attestation" } });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error.code, "POLICY_NOT_REQUESTED");
});

test("activation runtime production config requires HTTPS attestation endpoints", () => {
  assert.throws(() => loadIdentityPolicyActivatorConfig({
    NODE_ENV: "production",
    IDENTITY_POLICY_DATABASE_URL: "postgresql://fixture:placeholder@db.example.test:5432/example_db",
    IDENTITY_POLICY_ATTESTATION_ISSUER: "https://verifier.example.com",
    IDENTITY_POLICY_ATTESTATION_AUDIENCE: "wasalx-identity-policy-activator",
    IDENTITY_POLICY_ATTESTATION_JWKS_URI: "http://verifier.example.com/jwks",
  }), /HTTPS URL/);
});

test("migration exposes only a REQUESTED snapshot and preserves the provisioning-only activation boundary", async () => {
  const migration = await readFile(new URL("../services/control-api/migrations/0027_identity_policy_activation_runtime.sql", import.meta.url), "utf8");
  assert.match(migration, /security_policy_state='REQUESTED'/i);
  assert.match(migration, /FOR UPDATE OF settings,tenant/i);
  assert.match(migration, /tenant\.state IN \('ACTIVE','PROVISIONING'\)/i);
  assert.match(migration, /CREATE ROLE wasalx_identity_policy_activator NOLOGIN NOBYPASSRLS/i);
  assert.match(migration, /GRANT CONNECT ON DATABASE %I TO wasalx_identity_policy_activator/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION app\.activate_tenant_identity_policy\(uuid,bigint,text\)\s+TO wasalx_identity_policy_activator/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION app\.activate_tenant_identity_policy[\s\S]*wasalx_app/i);
  assert.doesNotMatch(migration, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)\s+ON\s+tenant_settings\s+TO\s+wasalx_identity_policy_activator/i);
});
