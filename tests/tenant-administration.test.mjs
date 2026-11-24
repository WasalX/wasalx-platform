import assert from "node:assert/strict";
import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from "../services/control-api/node_modules/@nestjs/common/index.js";
import { TenantAdministrationController } from "../services/control-api/dist/tenant-administration.controller.js";
import { InvitationTokenService } from "../services/control-api/dist/invitation-token.service.js";
import { can } from "../services/control-api/dist/rbac.js";

const migration = await readFile(new URL("../services/control-api/migrations/0019_tenant_administration.sql", import.meta.url), "utf8");
const app = await readTenantPortalSource();
const tenantMessages = await readFile(new URL("../lib/i18n/messages/en/tenant.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const settingsRoute = await readFile(new URL("../app/api/settings/route.ts", import.meta.url), "utf8");
const teamRoute = await readFile(new URL("../app/api/team/route.ts", import.meta.url), "utf8");

test("member WhatsApp numbers reject invalid input before database access", async () => {
  const controller = new TenantAdministrationController({ withTenant: () => { throw new Error("unexpected database access"); } }, {}, {});
  for (const whatsappNumbers of ["", "0551234567", "+0123456", "+1234567890123456", 123, {}, null, ["invalid"], ["+12025550132", "+12025550132"]]) {
    await assert.rejects(() => controller.updateMember({}, "30000000-0000-4000-8000-000000000003", {
      role: "agent", state: "ACTIVE", expectedVersion: 1, whatsappNumbers,
    }), BadRequestException);
  }
});
const inviteRoute = await readFile(new URL("../app/api/team/invitations/route.ts", import.meta.url), "utf8");

const ownerRequest = {
  id: "request-admin-test",
  principal: {
    subject: "oidc-owner",
    userId: "10000000-0000-4000-8000-000000000001",
    tenantId: "20000000-0000-4000-8000-000000000002",
    email: "owner@example.test",
    displayName: "Owner",
    role: "tenant_owner",
  },
};

test("tenant administration schema is forced-RLS, audited, token-safe, and delivery-role separated", () => {
  for (const table of ["tenant_settings", "tenant_invitations", "tenant_invitation_email_outbox"]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table} \\(`));
  }
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /tenant_id=app\.current_tenant_id\(\)/);
  assert.match(migration, /token_hash text NOT NULL UNIQUE/);
  assert.match(migration, /token_ciphertext bytea NOT NULL/);
  assert.doesNotMatch(migration, /token_plaintext|invitation_url text/i);
  assert.match(migration, /wasalx_invitation_mailer NOLOGIN NOBYPASSRLS/);
  assert.match(migration, /REVOKE ALL ON FUNCTION app\.claim_invitation_email_jobs\(uuid,integer\) FROM wasalx_app/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION app\.claim_invitation_email_jobs\(uuid,integer\)[\s\S]*TO wasalx_invitation_mailer/);
  assert.match(migration, /sso_enforcement_state IN \('DISABLED','REQUESTED','ACTIVE'\)/);
  assert.match(migration, /security_policy_state IN \('REQUESTED','ACTIVE'\)/);
  assert.match(migration, /activate_tenant_identity_policy/);
  assert.match(migration, /policy_verification_evidence_sha256/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION app\.activate_tenant_identity_policy[\s\S]*TO wasalx_provisioning_client/);
  assert.match(migration, /audit_events/);
  assert.match(migration, /m\.state='ACTIVE'/);
});

test("single-use invitation tokens are SHA-256 bound and RSA-OAEP encrypted for a separate mailer", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const previous = process.env.INVITATION_TOKEN_ENCRYPTION_PUBLIC_KEY;
  process.env.INVITATION_TOKEN_ENCRYPTION_PUBLIC_KEY = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  try {
    const envelope = new InvitationTokenService().issue();
    assert.match(envelope.tokenHash, /^[0-9a-f]{64}$/);
    assert.notEqual(envelope.ciphertext.toString("utf8"), envelope.token);
    const payload = JSON.parse(privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, envelope.ciphertext).toString("utf8"));
    assert.equal(payload.token, envelope.token);
  } finally {
    if (previous === undefined) delete process.env.INVITATION_TOKEN_ENCRYPTION_PUBLIC_KEY;
    else process.env.INVITATION_TOKEN_ENCRYPTION_PUBLIC_KEY = previous;
  }
});

test("RBAC grants owner administration, limits tenant administrators, and keeps other roles read-only", () => {
  assert.equal(can("tenant_owner", "settings:write"), true);
  assert.equal(can("tenant_owner", "team:write"), true);
  assert.equal(can("tenant_admin", "team:write"), true);
  assert.equal(can("tenant_admin", "settings:write"), false);
  assert.equal(can("supervisor", "team:read"), true);
  assert.equal(can("supervisor", "team:write"), false);
  assert.equal(can("auditor", "team:read"), true);
  assert.equal(can("agent", "team:read"), false);
});

test("workspace updates use optimistic concurrency and append immutable audit evidence", async () => {
  const calls = [];
  const database = {
    withTenant: async (tenantId, operation) => {
      assert.equal(tenantId, ownerRequest.principal.tenantId);
      return operation({
        async query(sql) {
          if (sql.includes("FROM tenants t JOIN tenant_settings")) return { rows: [{ name: "Before", slug: "before", version: 4 }] };
          if (sql.includes("app.update_tenant_workspace")) return { rows: [{ tenant_id: tenantId, name: "After", slug: "after", version: 5 }] };
          if (sql.includes("INSERT INTO audit_events")) { calls.push(sql); return { rows: [] }; }
          throw new Error(`Unexpected SQL ${sql}`);
        },
      });
    },
  };
  const controller = new TenantAdministrationController(database, {}, {});
  const result = await controller.updateWorkspace(ownerRequest, {
    expectedVersion: 4,
    name: "After",
    slug: "after",
    accentColor: "#5B5BD6",
    defaultTheme: "DARK",
    groupDisclosureEnabled: true,
    groupDisclosureMessage: "Matched operational references are tracked as cases.",
    ssoEnforcementRequested: true,
    ssoProviderName: "Example Identity",
    ssoIssuer: "https://identity.example.test",
    ssoEmailDomains: ["example.test"],
    mfaRequiredRoles: ["tenant_owner", "tenant_admin"],
    sessionTimeoutMinutes: 480,
    privilegedReauthMinutes: 15,
    supportAccessRequiresApproval: true,
  });
  assert.equal(result.version, 5);
  assert.equal(calls.length, 1);
});

test("workspace policy validation rejects secret-bearing issuer URLs and unsafe activation metadata", async () => {
  const controller = new TenantAdministrationController({ withTenant: async () => assert.fail("database must not be called") }, {}, {});
  const base = {
    expectedVersion: 1,name: "Workspace",slug: "workspace",accentColor: "#5B5BD6",defaultTheme: "DARK",
    groupDisclosureEnabled: true,groupDisclosureMessage: "Disclosure",ssoEnforcementRequested: true,
    ssoProviderName: "Identity",ssoEmailDomains: ["example.test"],mfaRequiredRoles: ["tenant_owner"],
    sessionTimeoutMinutes: 480,privilegedReauthMinutes: 15,supportAccessRequiresApproval: true,
  };
  await assert.rejects(
    () => controller.updateWorkspace(ownerRequest, { ...base, ssoIssuer: "https://fixture:placeholder@api.example.test/path" }),
    (error) => error instanceof BadRequestException && /without credentials, query, or fragment/.test(error.message),
  );
});

test("tenant administrators cannot invite or mutate owner access", async () => {
  const request = { ...ownerRequest, principal: { ...ownerRequest.principal, role: "tenant_admin" } };
  const controller = new TenantAdministrationController({ withTenant: async () => assert.fail("database must not be called") }, {}, {});
  await assert.rejects(
    () => controller.invite(request, "invite-owner", { email: "next@example.test", role: "tenant_owner", expiresInDays: 7 }),
    (error) => error instanceof ForbiddenException && /cannot invite owners/.test(error.message),
  );
});

test("invitation addresses reject lists and display-name forms before database access", async () => {
  const controller = new TenantAdministrationController({ withTenant: async () => assert.fail("database must not be called") }, {}, {});
  for (const email of ["fixture-0011@example.test,invalid", "fixture-0011@example.test;fixture-0037@example.test", "Victim <fixture-0011@example.test>"]) {
    await assert.rejects(
      () => controller.invite(ownerRequest, `invalid-${email.length}`, { email, role: "agent", expiresInDays: 7 }),
      (error) => error instanceof BadRequestException && /valid invitation email/.test(error.message),
    );
  }
});

test("resend and revoke never mutate an invitation while any delivery is sending", async () => {
  let tokenIssues = 0;
  const invitation = {
    id: "30000000-0000-4000-8000-000000000005", email: "fixture-0038@example.test", display_name: "Invitee",
    role: "agent", state: "PENDING", expires_at: "2026-09-12T00:00:00.000Z", version: 1,
    created_at: "2026-09-04T00:00:00.000Z", updated_at: "2026-09-04T00:00:00.000Z",
  };
  const database = { withTenant: async (_tenantId, operation) => operation({ query: async (sql) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("idempotency_key=$2")) return { rows: [] };
    if (sql.includes("FROM tenant_invitations WHERE")) return { rows: [invitation] };
    if (sql.includes("state IN ('PENDING','SENDING','FAILED_RETRYABLE')")) return { rows: [{ state: "SENDING" }] };
    assert.fail(`Unexpected SQL ${sql}`);
  } }) };
  const controller = new TenantAdministrationController(database, { issue: () => { tokenIssues += 1; } }, {});
  await assert.rejects(
    () => controller.resend(ownerRequest, invitation.id, "resend-sending", { expiresInDays: 7 }),
    (error) => error instanceof ConflictException && /already in progress/.test(error.message),
  );
  await assert.rejects(
    () => controller.revoke(ownerRequest, invitation.id, { expectedVersion: 1 }),
    (error) => error instanceof ConflictException && /already in progress/.test(error.message),
  );
  assert.equal(tokenIssues, 0);
});

test("unknown invitation delivery requires explicit verification before resend", async () => {
  for (const code of ["EMAIL_PROVIDER_SMTP_OUTCOME_UNKNOWN", "EMAIL_PROVIDER_RECEIPT_PERSISTENCE_UNKNOWN"]) {
    let tokenIssues = 0;
    const invitation = {
      id: "30000000-0000-4000-8000-000000000006", email: "fixture-0038@example.test", display_name: "Invitee",
      role: "agent", state: "PENDING", expires_at: "2026-09-12T00:00:00.000Z", version: 1,
      created_at: "2026-09-04T00:00:00.000Z", updated_at: "2026-09-04T00:00:00.000Z",
    };
    const database = { withTenant: async (_tenantId, operation) => operation({ query: async (sql) => {
      if (sql.includes("pg_advisory_xact_lock") || sql.includes("idempotency_key=$2")) return { rows: [] };
      if (sql.includes("FROM tenant_invitations WHERE")) return { rows: [invitation] };
      if (sql.includes("state IN ('PENDING','SENDING','FAILED_RETRYABLE')")) return { rows: [] };
      if (sql.includes("SELECT state,error_code")) return { rows: [{ state: "FAILED_TERMINAL", error_code: code }] };
      assert.fail(`Unexpected SQL ${sql}`);
    } }) };
    const controller = new TenantAdministrationController(database, { issue: () => { tokenIssues += 1; } }, {});
    await assert.rejects(
      () => controller.resend(ownerRequest, invitation.id, `unknown-${code}`, { expiresInDays: 7 }),
      (error) => error instanceof ConflictException && /Check the destination mailbox/.test(error.message),
    );
    assert.equal(tokenIssues, 0);
  }
});

test("verified unknown resend records the decision and queues exactly one replacement", async () => {
  const invitation = {
    id: "30000000-0000-4000-8000-000000000007", email: "fixture-0038@example.test", display_name: "Invitee",
    role: "agent", state: "PENDING", expires_at: "2026-09-12T00:00:00.000Z", version: 1,
    created_at: "2026-09-04T00:00:00.000Z", updated_at: "2026-09-04T00:00:00.000Z",
  };
  let inserted = 0;
  let audit;
  const database = { withTenant: async (_tenantId, operation) => operation({ query: async (sql, values) => {
    if (sql.includes("pg_advisory_xact_lock") || sql.includes("idempotency_key=$2")) return { rows: [] };
    if (sql.includes("FROM tenant_invitations WHERE")) return { rows: [invitation] };
    if (sql.includes("state IN ('PENDING','SENDING','FAILED_RETRYABLE')") && sql.includes("SELECT state")) return { rows: [] };
    if (sql.includes("SELECT state,error_code")) return { rows: [{ state: "FAILED_TERMINAL", error_code: "EMAIL_PROVIDER_SMTP_OUTCOME_UNKNOWN" }] };
    if (sql.startsWith("UPDATE tenant_invitations")) return { rows: [{ ...invitation, state: "PENDING", version: 2 }] };
    if (sql.startsWith("UPDATE tenant_invitation_email_outbox")) return { rows: [] };
    if (sql.startsWith("INSERT INTO tenant_invitation_email_outbox")) { inserted += 1; return { rows: [{ state: "PENDING" }] }; }
    if (sql.startsWith("INSERT INTO audit_events")) { audit = values; return { rows: [] }; }
    assert.fail(`Unexpected SQL ${sql}`);
  } }) };
  const tokens = { issue: () => ({ tokenHash: "a".repeat(64), ciphertext: Buffer.alloc(256), keyVersion: "v1" }) };
  const result = await new TenantAdministrationController(database, tokens, {}).resend(
    ownerRequest, invitation.id, "verified-unknown-resend", { expiresInDays: 7, confirmUnknownDelivery: true },
  );
  assert.equal(inserted, 1);
  assert.equal(result.delivery_state, "PENDING");
  assert.equal(result.delivery_error_code, null);
  assert.equal(audit[5].delivery_error_code, "EMAIL_PROVIDER_SMTP_OUTCOME_UNKNOWN");
  assert.equal(audit[6].unknown_delivery_confirmed, true);
});

test("team lists page independently past 200 and keep invitations restricted", async () => {
  const tenant = ownerRequest.principal.tenantId;
  const records = Object.fromEntries(["members", "invitations"].map((kind, stream) => [kind,
    Array.from({ length: stream ? 202 : 200 }, (_, index) => ({
      id: "30000000-0000-4000-8000-" + String(stream * 1000 + index).padStart(12, "0"),
      user_id: "40000000-0000-4000-8000-" + String(index).padStart(12, "0"),
      version: "1",
    })),
  ]));
  let calls = 0;
  const database = { rows: async (tenantId, sql, [, cursor, fetchSize]) => {
    calls += 1;
    assert.equal(tenantId, tenant);
    assert.match(sql, /LIMIT \$3/u);
    const kind = sql.includes("FROM tenant_invitations") ? "invitations" : "members";
    const offset = cursor ? records[kind].findIndex(row => row.id === cursor) + 1 : 0;
    return records[kind].slice(offset, offset + fetchSize);
  } };
  const controller = new TenantAdministrationController(database, {}, {});
  const ids = items => items.map(row => row.id);
  const first = await controller.team(ownerRequest);
  assert.deepEqual(ids(first.members), ids(records.members));
  assert.equal(first.members_next_cursor, null);
  assert.deepEqual(ids(first.invitations), ids(records.invitations.slice(0, 200)));
  assert.equal(first.invitations_next_cursor, records.invitations[199].id);

  const next = await controller.team(ownerRequest, { invitation_cursor: first.invitations_next_cursor });
  assert.deepEqual(next.members, []);
  assert.deepEqual(ids(next.invitations), ids(records.invitations.slice(200)));
  assert.equal(next.invitations_next_cursor, null);

  const ownerAtTwo = await controller.team(ownerRequest, { limit: "2" });
  const role = { ...ownerRequest, principal: { ...ownerRequest.principal, role: "supervisor" } };
  const readOnly = await controller.team(role, { limit: "2", member_cursor: ownerAtTwo.members_next_cursor,
    invitation_cursor: first.invitations_next_cursor });
  assert.deepEqual(ids(readOnly.members), ids(records.members.slice(2, 4)));
  assert.equal(readOnly.members_next_cursor, records.members[3].id);
  assert.deepEqual(readOnly.invitations, []);
  assert.equal(readOnly.invitations_next_cursor, null);

  for (const query of [{ limit: "201" }, { member_cursor: "bad" }, { invitation_cursor: [first.invitations_next_cursor] }]) {
    await assert.rejects(() => controller.team(ownerRequest, query), BadRequestException);
  }
  assert.equal(calls, 6);
});

test("team responses expose only normalized invitation delivery codes", async () => {
  let calls = 0;
  const database = { rows: async () => {
    calls += 1;
    if (calls === 1) return [];
    return [{
      id: "30000000-0000-4000-8000-000000000008", email: "fixture-0038@example.test", display_name: null,
      role: "agent", state: "PENDING", expires_at: "2026-09-12T00:00:00.000Z", version: 1,
      created_at: "2026-09-04T00:00:00.000Z", updated_at: "2026-09-04T00:00:00.000Z",
      delivery_state: "FAILED_TERMINAL", delivery_error_code: "PRIVATE_PROVIDER_DIAGNOSTIC",
    }];
  } };
  const result = await new TenantAdministrationController(database, {}, {}).team(ownerRequest);
  assert.equal(result.invitations[0].delivery_error_code, "INVITATION_DELIVERY_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_DIAGNOSTIC/);
});

test("invitation acceptance proves the same verified subject before database mutation", async () => {
  let accepts=0;
  const database={acceptTenantInvitation:async()=>{accepts+=1;return{tenant_id:"20000000-0000-4000-8000-000000000002"}}};
  const auth={authenticateInvitationIdentity:async()=>({subject:"verified-subject",email:"owner@example.test",displayName:"Owner"})};
  const controller=new TenantAdministrationController(database,{},auth);
  await assert.rejects(
    ()=>controller.acceptInvitation("Bearer token",{token:"A".repeat(43),expectedSubject:"different-subject"}),
    error=>error instanceof UnauthorizedException,
  );
  assert.equal(accepts,0);
  await controller.acceptInvitation("Bearer token",{token:"A".repeat(43),expectedSubject:"verified-subject"});
  assert.equal(accepts,1);
});

test("owner and admin can register their own team numbers without changing access", async () => {
  for (const role of ["tenant_owner", "tenant_admin"]) {
    const request = { ...ownerRequest, principal: { ...ownerRequest.principal, role } };
    const member = { id: "30000000-0000-4000-8000-000000000003", user_id: request.principal.userId,
      role, state: "ACTIVE", version: 1, whatsapp_numbers: [] };
    const database = { withTenant: async (_tenant, run) => run({ query: async (sql, values) => {
      if (sql.includes("FOR UPDATE OF m")) return { rows: [member] };
      if (sql.includes("UPDATE tenant_memberships")) {
        assert.equal(values[5], true);
        assert.deepEqual(values[6], ["+12025550132", "+12025550141"]);
        return { rows: [{ ...member, version: 2, whatsapp_numbers: values[6] }] };
      }
      if (sql.includes("INSERT INTO audit_events")) return { rows: [] };
      assert.fail(`Unexpected SQL ${sql}`);
    } }) };
    const result = await new TenantAdministrationController(database, {}, {}).updateMember(request, member.id,
      { role, state: "ACTIVE", expectedVersion: 1, whatsappNumbers: ["+12025550132", "+12025550141"] });
    assert.equal(result.is_current_user, true);
    assert.deepEqual(result.whatsapp_numbers, ["+12025550132", "+12025550141"]);
  }
});

test("member number updates distinguish omission from clearing and reject stale versions", async () => {
  const member = { id: "30000000-0000-4000-8000-000000000005", user_id: "40000000-0000-4000-8000-000000000005",
    role: "agent", state: "ACTIVE", version: 2, whatsapp_numbers: ["+12025550132", "+12025550141"] };
  let writes = 0;
  const database = { withTenant: async (_tenant, run) => run({ query: async (sql, values) => {
    if (sql.includes("FOR UPDATE OF m")) return { rows: [member] };
    if (sql.includes("UPDATE tenant_memberships")) {
      writes++;
      return { rows: [{ ...member, version: 3, whatsapp_numbers: values[5] ? values[6] : member.whatsapp_numbers }] };
    }
    if (sql.includes("INSERT INTO audit_events")) return { rows: [] };
    assert.fail(`Unexpected SQL ${sql}`);
  } }) };
  const controller = new TenantAdministrationController(database, {}, {});
  const body = { role: "agent", state: "ACTIVE", expectedVersion: 2 };
  assert.deepEqual((await controller.updateMember(ownerRequest, member.id, body)).whatsapp_numbers, member.whatsapp_numbers);
  assert.deepEqual((await controller.updateMember(ownerRequest, member.id, { ...body, whatsappNumbers: [] })).whatsapp_numbers, []);
  assert.deepEqual((await controller.updateMember(ownerRequest, member.id, { ...body, whatsappNumbers: ["+12025550141"] })).whatsapp_numbers, ["+12025550141"]);
  await assert.rejects(() => controller.updateMember(ownerRequest, member.id, { ...body, expectedVersion: 1, whatsappNumbers: [] }), ConflictException);
  assert.equal(writes, 3);
});

test("member mutations prevent self-lockout and removal of the last active owner", async () => {
  const selfDatabase = { withTenant: async (_tenantId, operation) => operation({ query: async (sql) => sql.includes("FOR UPDATE OF m") ? { rows: [{ id: "30000000-0000-4000-8000-000000000003", user_id: ownerRequest.principal.userId, email: ownerRequest.principal.email, display_name: "Owner", role: "tenant_owner", state: "ACTIVE", version: 1 }] } : assert.fail(`Unexpected SQL ${sql}`) }) };
  await assert.rejects(
    () => new TenantAdministrationController(selfDatabase, {}, {}).updateMember(ownerRequest, "30000000-0000-4000-8000-000000000003", { role: "tenant_admin", state: "ACTIVE", expectedVersion: 1 }),
    (error) => error instanceof ForbiddenException && /own workspace access/.test(error.message),
  );

  const lastOwnerDatabase = { withTenant: async (_tenantId, operation) => operation({ query: async (sql) => {
    if (sql.includes("FOR UPDATE OF m")) return { rows: [{ id: "30000000-0000-4000-8000-000000000004", user_id: "40000000-0000-4000-8000-000000000004", email: "last@example.test", display_name: "Last", role: "tenant_owner", state: "ACTIVE", version: 1 }] };
    if (sql.startsWith("DELETE FROM tenant_memberships")) throw new Error("WASALX_LAST_ACTIVE_OWNER");
    throw new Error(`Unexpected SQL ${sql}`);
  } }) };
  await assert.rejects(
    () => new TenantAdministrationController(lastOwnerDatabase, {}, {}).removeMember(ownerRequest, "30000000-0000-4000-8000-000000000004", { expectedVersion: 1 }),
    (error) => error instanceof ConflictException && /at least one active owner/.test(error.message),
  );
});

test("portal tenant administration has full states, recovery, accessibility, and no-store BFFs", async () => {
  for (const key of [
    "tenant.navigation.team", "tenant.settings.errors.unavailable", "tenant.settings.actions.reload",
    "tenant.settings.state.unsaved", "tenant.settings.identity.enforceTitle", "tenant.settings.security.pendingTitle",
    "tenant.team.invite.title", "tenant.team.member.removeTitle", "tenant.team.protected", "tenant.settings.readOnly.title",
    "tenant.settings.general.disclosureHelp",
  ]) assert.match(app, new RegExp(key.replaceAll(".", "\\.")));
  for (const evidence of ["workspace-disclosure", "sso-provider", "session-timeout", "beforeunload"])
    assert.match(app, new RegExp(evidence));
  for (const copy of [
    "Team & access", "Workspace settings unavailable", "Request enforced workspace SSO",
    "Invite a team member", "Saving different text creates a new disclosure version",
    "Activating a group alone never sends it",
  ]) assert.match(tenantMessages, new RegExp(copy));
  assert.match(app, /tenant\.team\.invitations\.body/);
  assert.match(app, /resendText!=="RESEND"/);
  assert.match(app, /confirmUnknownDelivery/);
  assert.match(app, /delivery_state === "SENDING"/);
  assert.doesNotMatch(app, /EMAIL_PROVIDER_(?:SMTP_OUTCOME|RECEIPT_PERSISTENCE)_UNKNOWN/);
  assert.match(tenantMessages, /previous email may already be in the destination mailbox/);
  assert.match(tenantMessages, /Invitation links are single-use/);
  assert.match(styles, /\.team-summary/);
  assert.match(styles, /\.settings-feedback\.error/);
  assert.match(styles, /@media\(max-width:760px\).*\.team-summary/s);
  for (const route of [settingsRoute, teamRoute, inviteRoute]) assert.match(route, /private, no-store/);
  assert.match(settingsRoute, /settings:write/);
  assert.match(teamRoute, /team:read/);
  assert.match(inviteRoute, /team:invite/);
  assert.doesNotMatch(app, /query-string role|searchParams.*role/i);
  const controllerSource = await readFile(new URL("../services/control-api/src/tenant-administration.controller.ts", import.meta.url), "utf8");
  assert.match(controllerSource, /state IN \('PENDING','SENDING','FAILED_RETRYABLE'\)[\s\S]*FOR UPDATE/u);
  assert.doesNotMatch(controllerSource, /SET state='CANCELLED'[\s\S]{0,240}state IN \([^)]*'SENDING'/u);
  assert.match(controllerSource, /canonicalHash\(\{ action: "RESEND", invitationId: id, expiresInDays, confirmUnknownDelivery \}\)/u);
  assert.match(controllerSource, /INVITATION_DELIVERY_OUTCOME_UNKNOWN/u);
});
