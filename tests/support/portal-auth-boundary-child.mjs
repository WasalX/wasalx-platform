// Existing opaque-session contract moved out of FakeRedis to the owned real-Redis browser fixture.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
  import { authenticatePortalBinaryUploadRequest, authenticatePortalRequest, AuthorizationError, RequestSecurityError } from "../../lib/request-auth.ts";
  import { createStoredPortalSession, deleteStoredPortalSession, loadStoredPortalSession } from "../../lib/portal-session-store.ts";
  import { finalizePortalLoginSession, PortalSessionError, sessionCookieName } from "../../lib/portal-session.ts";

  const now = Math.floor(Date.now() / 1000);
  const csrfToken = "csrf-token-with-fixed-test-value";
  const stored = await createStoredPortalSession({
    version: 1,
    oidcBinding: {issuer:process.env.OIDC_ISSUER,clientId:process.env.OIDC_CLIENT_ID,sid:"auth-boundary-child"},
    accessToken: "very-sensitive-access-token",
    refreshToken: "very-sensitive-refresh-token",
    expiresAt: now + 600,
    subject: "subject-agent",
    userId: "user-agent",
    email: "agent@example.com",
    displayName: "Operations Agent",
    tenantId: "10000000-0000-4000-8000-000000000001",
    tenantName: "Tenant A",
    tenantSlug: "tenant-a",
    role: "agent",
    csrfToken,
    createdAt: now,
    sessionTimeoutSeconds: 3600,
    absoluteExpiresAt: now + 3600,
  });
  assert.match(stored.id, /^[A-Za-z0-9_-]{43}$/);
  const valid = await loadStoredPortalSession(stored.id);
  for (const oidcBinding of [undefined, { ...valid.oidcBinding, issuer: "https://foreign.example.test" }, { ...valid.oidcBinding, clientId: "foreign-client" }]) {
    await assert.rejects(() => createStoredPortalSession({ ...valid, oidcBinding }), PortalSessionError);
  }
  await assert.rejects(() => createStoredPortalSession({ ...valid, absoluteExpiresAt: valid.createdAt + 86_401 }), PortalSessionError);
  assert.ok(process.env.AUTH_BOUNDARY_REVOKED_SID);
  await assert.rejects(() => createStoredPortalSession({
    ...valid, oidcBinding: { ...valid.oidcBinding, sid: process.env.AUTH_BOUNDARY_REVOKED_SID },
  }), PortalSessionError);
  const cookie = sessionCookieName() + "=" + stored.id;
  assert.equal(cookie.includes("sensitive"), false);
  assert.equal((await loadStoredPortalSession(stored.id)).subject, "subject-agent");

  const getRequest = new Request("https://portal.wasalx.test/api/deliveries", { headers: { cookie } });
  const principal = await authenticatePortalRequest(getRequest, "delivery:read");
  assert.equal(principal.role, "agent");
  await assert.rejects(() => authenticatePortalRequest(getRequest, "delivery:retry"), AuthorizationError);

  const validMutation = () => new Request("https://portal.wasalx.test/api/groups/group-1/toggle", {
    method: "POST",
    headers: {
      cookie,
      origin: "https://portal.wasalx.test",
      "content-type": "application/json; charset=utf-8",
      "x-wasalx-csrf": csrfToken,
    },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal((await authenticatePortalRequest(validMutation(), "group:read")).tenantId, "10000000-0000-4000-8000-000000000001");

  const invalidMutation = (headers) => new Request("https://portal.wasalx.test/api/groups/group-1/toggle", {
    method: "POST",
    headers: { cookie, origin: "https://portal.wasalx.test", "content-type": "application/json", "x-wasalx-csrf": csrfToken, ...headers },
    body: "{}",
  });
  await assert.rejects(() => authenticatePortalRequest(invalidMutation({ origin: "https://attacker.test" })), RequestSecurityError);
  await assert.rejects(() => authenticatePortalRequest(invalidMutation({ "content-type": "text/plain" })), RequestSecurityError);
  await assert.rejects(() => authenticatePortalRequest(invalidMutation({ "x-wasalx-csrf": "csrf-token-with-fixed-test-valuE" })), RequestSecurityError);
  await assert.rejects(() => authenticatePortalRequest(invalidMutation({ "x-wasalx-csrf": "short" })), RequestSecurityError);

  const binaryUpload = (contentType = "image/png", csrf = csrfToken) => new Request("https://portal.wasalx.test/api/bot-flows/media-assets", {
    method: "POST",
    headers: { cookie, origin: "https://portal.wasalx.test", "content-type": contentType, "x-wasalx-csrf": csrf },
    body: new Uint8Array([137, 80, 78, 71]),
  });
  assert.equal((await authenticatePortalBinaryUploadRequest(binaryUpload(), "group:read", ["image/png", "application/pdf"])).tenantId, "10000000-0000-4000-8000-000000000001");
  await assert.rejects(() => authenticatePortalBinaryUploadRequest(binaryUpload("text/html"), "group:read", ["image/png", "application/pdf"]), RequestSecurityError);
  await assert.rejects(() => authenticatePortalBinaryUploadRequest(binaryUpload("image/png", "invalid-token"), "group:read", ["image/png", "application/pdf"]), RequestSecurityError);
  await assert.rejects(() => loadStoredPortalSession("not-an-opaque-session-id"), PortalSessionError);

  const previous = await loadStoredPortalSession(stored.id);
  const elevated = { ...previous, accessToken: "elevated-access-token", csrfToken: "new-csrf-token" };
  assert.equal(finalizePortalLoginSession(elevated, previous, undefined).csrfToken, "new-csrf-token");
  assert.throws(
    () => finalizePortalLoginSession({ ...elevated, tenantId: "20000000-0000-4000-8000-000000000002" }, previous, "privileged"),
    PortalSessionError,
  );
  const privileged = finalizePortalLoginSession(elevated, previous, "privileged");
  const rotated = await createStoredPortalSession(privileged);
  assert.notEqual(rotated.id, stored.id);
  await deleteStoredPortalSession(stored.id);
  await assert.rejects(() => loadStoredPortalSession(stored.id), PortalSessionError);
  assert.equal((await loadStoredPortalSession(rotated.id)).csrfToken, csrfToken);
  const openTabMutation = new Request("https://portal.wasalx.test/api/groups/group-1/toggle", {
    method: "POST",
    headers: {
      cookie: sessionCookieName() + "=" + rotated.id,
      origin: "https://portal.wasalx.test",
      "content-type": "application/json",
      "x-wasalx-csrf": csrfToken,
    },
    body: "{}",
  });
  assert.equal((await authenticatePortalRequest(openTabMutation, "group:read")).tenantId, previous.tenantId);

  // Audit352 control-plane response contract, using this same real-Redis session.
  registerHooks({ load(url, context, nextLoad) {
    if (url === new URL("../../lib/control-plane-data.ts", import.meta.url).href) return {
      format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }), shortCircuit: true,
    };
    return nextLoad(url, context);
  }, resolve(specifier, context, nextResolve) {
    if (specifier === "next/headers") return { url: "data:text/javascript," + encodeURIComponent("export const cookies = async () => ({ get: () => ({ value: " + JSON.stringify(rotated.id) + " }) });"), shortCircuit: true };
    try { return nextResolve(specifier, context); }
    catch (error) { if (specifier.startsWith(".") && !/\.[a-z]+$/u.test(specifier)) return nextResolve(specifier + ".ts", context); throw error; }
  } });
  const { getMetaCostStatement, portalInboxRequest, portalInboxAttachmentRequest, portalInboxUploadRequest, ControlPlaneError } = await import("../../lib/control-plane-data.ts");
  const originalFetch = globalThis.fetch;
  try {
    let response;
    let expectedPath = "/v1/meta/costs/statements/statement";
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), process.env.CONTROL_API_URL + expectedPath);
      assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer elevated-access-token");
      assert.equal(new Headers(init.headers).get("x-wasalx-tenant-id"), previous.tenantId);
      return response;
    };
    response = Response.json({ id: "statement", state: "READY" });
    assert.deepEqual(await getMetaCostStatement("statement"), { id: "statement", state: "READY" });
    for (const invalid of [new Response("{", { headers: { "content-type": "application/json" } }),
      new Response("{}", { headers: { "content-type": "text/html" } })]) {
      response = invalid;
      await assert.rejects(() => getMetaCostStatement("statement"), error => error instanceof ControlPlaneError && error.status === 502);
    }
    let cancelled = false;
    response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json", "content-length": "10485761" } });
    await assert.rejects(() => getMetaCostStatement("statement"), error => error instanceof ControlPlaneError && error.status === 502);
    assert.equal(cancelled, true);
    response = Response.json({ message: "Permission required", code: "PERMISSION_REQUIRED" }, { status: 403 });
    await assert.rejects(() => getMetaCostStatement("statement"), error => error instanceof ControlPlaneError && error.status === 403 && error.code === "PERMISSION_REQUIRED");
    // Invalid bodies never supply scoped or reauthentication authority. Include
    // actual Inbox JSON, attachment, group media and upload entry points.
    const actor = { userId: previous.userId, tenantId: previous.tenantId };
    const groupId = "41000000-0000-4000-8000-000000000001";
    const probes = [
      { path: "/v1/meta/costs/statements/statement", call: () => getMetaCostStatement("statement") },
      { path: "/v1/inbox", call: () => portalInboxRequest(actor, { operation: "CHECK", input: {} }) },
      { path: "/v1/inbox", call: () => portalInboxAttachmentRequest(actor, { ticket_id: "42", article_id: "60", attachment_id: "1" }) },
      { path: "/v1/inbox", call: () => portalInboxAttachmentRequest(actor, { group_id: groupId, message_id: groupId }, "GROUP_MEDIA") },
      { path: "/v1/inbox/upload", call: () => portalInboxUploadRequest(actor, { operation: "GROUP_UPLOAD", input: { group_id: groupId } }, new File(["synthetic"], "proof.txt"), { filename: "proof.txt", mime_type: "text/plain" }) },
    ];
    for (const probe of probes) {
      expectedPath = probe.path;
      for (const status of [401, 403]) {
        for (const invalid of [new Response("{", { status, headers: { "content-type": "application/json" } }),
          new Response("<html>Denied</html>", { status, headers: { "content-type": "text/html" } }),
          new Response("{}", { status, headers: { "content-type": "application/json", "content-length": "10485761" } })]) {
          response = invalid;
          await assert.rejects(probe.call, error => error instanceof ControlPlaneError && error.status === status && error.code === undefined && error.workspaceProof === undefined);
        }
      }
    }
    expectedPath = "/v1/inbox";
    response = Response.json({ code: "REAUTHENTICATION_REQUIRED" }, { status: 403 });
    await assert.rejects(() => portalInboxRequest(actor, { operation: "CHECK", input: {} }), error => error.status === 403 && error.code === "REAUTHENTICATION_REQUIRED" && error.workspaceProof === undefined);
    response = Response.json({ code: "GROUP_ACCESS_DENIED", group_id: groupId }, { status: 403 });
    await assert.rejects(() => portalInboxRequest(actor, { operation: "GROUP_SHOW", input: { group_id: groupId } }), error => error.status === 403 && error.code === "GROUP_ACCESS_DENIED" && error.workspaceProof?.group_id === groupId);
    expectedPath = "/v1/meta/costs/statements/statement";
    response = Response.json(null, { status: 500 });
    await assert.rejects(() => getMetaCostStatement("statement"), error => error instanceof ControlPlaneError && error.status === 500);
  } finally { globalThis.fetch = originalFetch; }

  process.stdout.write(JSON.stringify({ idLength: rotated.id.length, cookieLength: cookie.length }));
  process.exit(0);
