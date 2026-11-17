import assert from "node:assert/strict";
import test from "node:test";

const originalBackend = process.env.PORTAL_DATA_BACKEND;
const originalRole = process.env.PORTAL_FIXTURE_ROLE;

test("fixture role accepts only the five tenant roles in fixture mode", async () => {
  process.env.PORTAL_DATA_BACKEND = "fixture";
  const { portalFixtureRole, portalFixturePersona } = await import(`../lib/fixture-role.ts?fixture=${Date.now()}`);
  for (const role of ["tenant_owner","tenant_admin","supervisor","agent","auditor"]) {
    process.env.PORTAL_FIXTURE_ROLE = role;
    assert.equal(portalFixtureRole(), role);
    assert.equal(portalFixturePersona().role, role);
    assert.match(portalFixturePersona().email, /@northstar\.example$/);
  }
  process.env.PORTAL_FIXTURE_ROLE = "platform_operator";
  assert.throws(() => portalFixtureRole(), /Invalid PORTAL_FIXTURE_ROLE/);
});

test("fixture role cannot affect control-plane or D1 authorization", async () => {
  process.env.PORTAL_FIXTURE_ROLE = "tenant_owner";
  process.env.PORTAL_DATA_BACKEND = "control-plane";
  const { portalFixtureRole } = await import(`../lib/fixture-role.ts?production=${Date.now()}`);
  assert.throws(() => portalFixtureRole(), /allowed only when PORTAL_DATA_BACKEND=fixture/);
});

test("fixture personas mirror current identity and fine-grained team boundaries", async () => {
  process.env.PORTAL_DATA_BACKEND = "fixture";
  process.env.PORTAL_FIXTURE_ROLE = "tenant_admin";
  const fixture = await import(`../lib/fixture-data.ts?personas=${Date.now()}`);
  const adminTeam = await fixture.getTeamAccess();
  assert.equal(adminTeam.members.find((member) => member.is_current_user)?.role, "tenant_admin");
  await assert.rejects(
    () => fixture.inviteTeamMember({ email: "owner-preview@northstar.example", role: "tenant_owner" }, "Omar Haddad"),
    (error) => error?.status === 403 && /cannot invite owners/.test(error.message),
  );
  process.env.PORTAL_FIXTURE_ROLE = "supervisor";
  const supervisorTeam = await fixture.getTeamAccess();
  assert.equal(supervisorTeam.members.find((member) => member.is_current_user)?.role, "supervisor");
  assert.deepEqual(supervisorTeam.invitations, []);
  assert.equal(supervisorTeam.capabilities.can_manage_members, false);
});


test("loopback request identity matches every fixture persona without changing authorization", async () => {
  const previousBackend = process.env.PORTAL_DATA_BACKEND;
  const previousRole = process.env.PORTAL_FIXTURE_ROLE;
  const { portalFixturePersona, TENANT_ROLES } = await import("../lib/fixture-role.ts");
  const { authenticatePortalRequest, AuthenticationError, AuthorizationError } = await import("../lib/request-auth.ts");
  const users = new Set();
  try {
    process.env.PORTAL_DATA_BACKEND = "fixture";
    for (const role of TENANT_ROLES) {
      process.env.PORTAL_FIXTURE_ROLE = role;
      const persona = portalFixturePersona();
      const principal = await authenticatePortalRequest(new Request("http://localhost/api/connections"), "connection:read");
      assert.deepEqual(principal, { userId: persona.userId, email: persona.email, displayName: persona.displayName, tenantId: "tenant_northstar", role });
      users.add(principal.userId);
      const mutate = () => authenticatePortalRequest(new Request("http://127.0.0.1/api/connections", { method: "POST" }), "connection:write");
      if (["tenant_owner", "tenant_admin"].includes(role)) assert.equal((await mutate()).userId, persona.userId);
      else await assert.rejects(mutate, AuthorizationError);
      await assert.rejects(() => authenticatePortalRequest(new Request("https://portal.example/api/connections")), AuthenticationError);
    }
    assert.equal(users.size, TENANT_ROLES.length);
    const forwarded = await authenticatePortalRequest(new Request("http://localhost/api/connections", { headers: {
      "oai-authenticated-user-id": "explicit-preview-user", "oai-authenticated-user-email": "explicit@example.test",
    } }), "connection:read");
    assert.equal(forwarded.userId, "explicit-preview-user");
    assert.equal(forwarded.email, "explicit@example.test");
    delete process.env.PORTAL_FIXTURE_ROLE;
    assert.equal((await authenticatePortalRequest(new Request("http://localhost/api/connections"))).userId, "local-preview");
    process.env.PORTAL_DATA_BACKEND = "d1";
    assert.equal((await authenticatePortalRequest(new Request("http://localhost/api/connections"))).userId, "local-preview");
    await assert.rejects(() => authenticatePortalRequest(new Request("http://localhost/api/connections", { method: "POST" })), error => error.status === 409);
    process.env.PORTAL_FIXTURE_ROLE = "tenant_admin";
    await assert.rejects(() => authenticatePortalRequest(new Request("http://localhost/api/connections")), /allowed only when PORTAL_DATA_BACKEND=fixture/);
    process.env.PORTAL_DATA_BACKEND = "control-plane";
    await assert.rejects(() => authenticatePortalRequest(new Request("http://localhost/api/connections")), error => error.status === 401);
  } finally {
    if (previousBackend === undefined) delete process.env.PORTAL_DATA_BACKEND; else process.env.PORTAL_DATA_BACKEND = previousBackend;
    if (previousRole === undefined) delete process.env.PORTAL_FIXTURE_ROLE; else process.env.PORTAL_FIXTURE_ROLE = previousRole;
  }
});

test.after(() => {
  if (originalBackend === undefined) delete process.env.PORTAL_DATA_BACKEND; else process.env.PORTAL_DATA_BACKEND = originalBackend;
  if (originalRole === undefined) delete process.env.PORTAL_FIXTURE_ROLE; else process.env.PORTAL_FIXTURE_ROLE = originalRole;
});
