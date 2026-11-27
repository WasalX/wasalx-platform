import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import test from "node:test";
import { arabicPlatformMessages } from "../lib/i18n/messages/ar/platform.ts";
import { expiredInvitationToken, invitationToken, sha256, storedSession, tenantId, withSignedPlatformFixture, waitFor } from "./support/signed-platform-fixture.mjs";

test("platform and invitation journeys cross signed OIDC, portal, API, Redis, and PostgreSQL", { timeout: 300_000 }, async (t) => {
  await withSignedPlatformFixture(async ({ resources, portalOrigin, signIn }) => {
    const context = await resources.browser.newContext();
    const page = await context.newPage();
    const browserErrors = [];
    const requests = [];
    const invitationStarts = [];
    page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") browserErrors.push(`console: ${message.text()}`); });
    page.on("request", (request) => requests.push(request.url()));
    page.on("response", (response) => {
      if (response.url().endsWith("/api/invitations/accept/start")) invitationStarts.push(response);
    });

    for (const state of ["accepted", "accepted_session_pending"]) {
      await page.goto(`${portalOrigin}/invitations/result?state=${state}`);
      assert.equal(await page.getByRole("main").getByRole("link", { name: "Back to WasalX" }).getAttribute("href"), "/");
      assert.equal(await page.getByRole("heading", { name: "You have joined the workspace" }).count(), 0);
      assert.equal((await context.cookies(portalOrigin)).some(({ name }) => name === "wasalx_session"), false);
    }
    await page.goto(`${portalOrigin}/invitations/accept#token=invalid`);
    await page.waitForFunction(() => window.location.hash === "");
    assert.equal(invitationStarts.length, 0);

    const firstPlatform = await signIn(context, page);
    await assertBasicAxe(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileGeometry = await page.evaluate(() => ({ viewport: window.innerWidth, root: document.documentElement.scrollWidth }));
    assert.ok(mobileGeometry.root <= mobileGeometry.viewport, `platform root overflows mobile viewport: ${JSON.stringify(mobileGeometry)}`);
    await page.setViewportSize({ width: 1280, height: 720 });
    const tenantOperations = await (await context.request.get(`${portalOrigin}/api/platform-console/operations/tenants?limit=50`)).json();

    await t.test("Arabic platform workspace operations localize failed provisioning", async () => {
      const arabic = await resources.browser.newContext({ storageState: await context.storageState(), locale: "ar-SA" });
      try {
        await arabic.addCookies([{ name: "wasalx_locale", value: "ar", url: portalOrigin }]);
        const arabicPage = await arabic.newPage();
        const englishError = "The provisioning worker could not finish its last step.";
        await arabicPage.route("**/api/platform-console/operations/tenants?*", (route) => route.fulfill({
          json: {
            ...tenantOperations,
            items: tenantOperations.items.map(operation => ({
              ...operation, status: "FAILED", error_code: "PROVISIONING_FAILED", safe_error: englishError,
            })),
          },
        }));
        await arabicPage.goto(`${portalOrigin}/platform#tenants`);
        await expect(arabicPage.locator("html")).toHaveAttribute("lang", "ar");
        await arabicPage.getByRole("textbox", { name: arabicPlatformMessages["platform.tenants.searchLabel"], exact: true })
          .fill("Invitation Proof Workspace");
        const row = arabicPage.getByRole("row").filter({ hasText: "Invitation Proof Workspace" });
        await expect(row.getByText(arabicPlatformMessages["platform.tenants.operationFailed"], { exact: true })).toBeVisible();
        await expect(arabicPage.getByText(englishError, { exact: false })).toHaveCount(0);
      } finally {
        await arabic.close();
      }
    });

    const forbiddenSuspend = await page.evaluate(async (id) => {
      const response = await fetch(`/api/platform-console/tenants/${id}/suspend`, {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ reason: "Must fail without browser CSRF proof" }),
      });
      return response.status;
    }, tenantId);
    assert.equal(forbiddenSuspend, 403);
    assert.equal((await resources.admin.query("SELECT state FROM tenants WHERE id=$1", [tenantId])).rows[0].state, "ACTIVE");
    assert.ok(browserErrors.every((error) => error.includes("403 (Forbidden)")), browserErrors.join("\n"));
    browserErrors.length = 0;

    const platformAuthorizationCount=resources.identity.authorizations.length;
    const platformProviderSession=resources.identity.authorizations.at(-1).sessionId;
    await page.getByRole("button",{name:"Sign out of platform operations"}).click();
    await waitFor(()=>resources.identity.logouts.length===1,"platform identity-provider logout");
    assert.equal(resources.identity.logouts[0].url.searchParams.get("client_id"),"wasalx-platform-portal");
    assert.equal(resources.identity.logouts[0].url.searchParams.get("post_logout_redirect_uri"),`${portalOrigin}/platform`);
    assert.equal(resources.identity.logouts[0].sessionId,platformProviderSession);
    await page.getByRole("heading", { name: "Operational control, without tenant data exposure." }).waitFor();
    const secondPlatform = await storedSession(context, resources.redis, portalOrigin, "wasalx_platform_session", "wasalx:platform-portal:session:");
    assert.notEqual(secondPlatform.id, firstPlatform.id);
    assert.equal(await resources.redis.exists(`wasalx:platform-portal:session:${firstPlatform.id}`), 0);
    assert.equal(resources.identity.authorizations.length,platformAuthorizationCount+1);
    assert.equal(resources.identity.authorizations.at(-1).hadSession,false);

    resources.identity.profile = "expired-invitee";
    await page.goto(`${portalOrigin}/invitations/accept#token=${expiredInvitationToken}`);
    await page.waitForURL("**/invitations/result?state=expired_or_used");
    await page.getByRole("heading",{name:"This invitation has expired or was already used"}).waitFor();
    assert.equal(await page.getByRole("main").getByRole("link",{name:"Sign in",exact:true}).getAttribute("href"),"/auth/login?return_to=/app");
    assert.deepEqual((await resources.admin.query(`SELECT
      (SELECT count(*)::integer FROM users WHERE oidc_subject='expired-invitee-subject') AS users,
      (SELECT count(*)::integer FROM tenant_memberships member JOIN users identity ON identity.id=member.user_id
        WHERE identity.oidc_subject='expired-invitee-subject') AS memberships,
      (SELECT count(*)::integer FROM audit_events WHERE action='team.invitation_accepted'
        AND target_id='32000000-0000-4000-8000-000000000004') AS audits,
      (SELECT state FROM tenant_invitations WHERE id='32000000-0000-4000-8000-000000000004') AS invitation_state`)).rows,[
      {users:0,memberships:0,audits:0,invitation_state:"PENDING"},
    ]);

    resources.identity.profile = "wrong-invitee";
    await page.goto(`${portalOrigin}/invitations/accept#token=${invitationToken}`);
    await page.waitForURL("**/invitations/result?state=identity_mismatch");
    await page.getByRole("heading", { name: "Use the account that was invited" }).waitFor();
    assert.equal(await page.getByRole("main").getByRole("link", { name: "Back to WasalX" }).getAttribute("href"), "/");
    await assertBasicAxe(page);
    assert.equal((await resources.admin.query("SELECT state FROM tenant_invitations WHERE token_hash=$1", [sha256(invitationToken)])).rows[0].state, "PENDING");
    assert.equal((await context.cookies(portalOrigin)).some(({ name }) => name === "wasalx_session"), false);

    resources.identity.profile = "valid-invitee";
    await page.goto(`${portalOrigin}/invitations/accept#token=${invitationToken}`);
    await page.waitForURL("**/app");
    await page.getByRole("heading", { name: "Operational overview" }).waitFor();
    await assertBasicAxe(page);
    const tenantSession = await storedSession(context, resources.redis, portalOrigin, "wasalx_session", "wasalx:portal:session:");
    assert.equal(tenantSession.value.tenantId, tenantId);
    assert.equal(tenantSession.value.subject, "valid-invitee-subject");

    await page.goto(`${portalOrigin}/invitations/accept#token=${invitationToken}`);
    await page.waitForURL("**/invitations/result?state=expired_or_used");
    await page.getByRole("heading",{name:"This invitation has expired or was already used"}).waitFor();
    assert.equal(invitationStarts.length, 4);
    for (const response of invitationStarts) {
      assert.equal(response.status(), 200);
      assert.equal(response.headers()["cache-control"], "no-store");
      assert.equal(response.headers()["referrer-policy"], "no-referrer");
    }
    for(const [state,label,href] of [
      ["accepted","Back to WasalX","/"],
      ["expired_or_used","Sign in","/auth/login?return_to=/app"],
      ["identity_mismatch","Back to WasalX","/"],
      ["identity_unverified","Back to WasalX","/"],
      ["membership_conflict","Sign in","/auth/login?return_to=/app"],
      ["accepted_session_pending","Back to WasalX","/"],
      ["authentication_failed","Back to WasalX","/"],
    ]){
      await page.goto(`${portalOrigin}/invitations/result?state=${state}`);
      assert.equal(await page.getByRole("main").getByRole("link",{name:label,exact:true}).getAttribute("href"),href);
    }
    assert.equal(requests.some((url) => url.includes(invitationToken)), false, "invitation token leaked into an HTTP request URL");
    const invitationEvidence = await resources.admin.query(`
      SELECT i.state,m.role,u.oidc_subject,
        EXISTS (SELECT 1 FROM audit_events a WHERE a.tenant_id=i.tenant_id AND a.action='team.invitation_accepted' AND a.target_id=i.id::text) AS audited
      FROM tenant_invitations i
      JOIN users u ON u.id=i.accepted_by
      JOIN tenant_memberships m ON m.tenant_id=i.tenant_id AND m.user_id=u.id
      WHERE i.token_hash=$1`, [sha256(invitationToken)]);
    assert.deepEqual(invitationEvidence.rows, [{ state: "ACCEPTED", role: "agent", oidc_subject: "valid-invitee-subject", audited: true }]);
    const platformAudit = await resources.admin.query(
      "SELECT DISTINCT action FROM platform_operations_audit_events WHERE operator_subject=$1 ORDER BY action",
      ["platform-operator-subject"],
    );
    assert.deepEqual(platformAudit.rows.map(({ action }) => action), ["platform.overview_inspected", "platform.tenants_inspected"]);
    assert.deepEqual(browserErrors, []);
    await context.close();

    process.stdout.write(`${JSON.stringify({ signedJwks: true, platformSessionRotated: true, platformReadAudited: true, highRiskMutation: "blocked", invitationMismatch: "blocked", invitationAccepted: true })}\n`);
  });
});

async function assertBasicAxe(page) {
  const result = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(result.violations.filter(({ impact }) => impact === "critical" || impact === "serious").map(({ id }) => id), []);
}
