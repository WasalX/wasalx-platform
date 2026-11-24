import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";
import ts from "typescript";
import { PortalWorkspaceController, validateWorkspaceRequest } from "../services/control-api/dist/portal-workspace.controller.js";
import { ZammadServiceSecretService } from "../services/control-api/dist/zammad-service-secret.service.js";
import { can } from "../packages/core/dist/tenant-permissions.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "30000000-0000-4000-8000-000000000003";
const instanceId = "11000000-0000-4000-8000-000000000001";
const principal = { tenantId, userId, email: "owner@example.invalid", subject: "staff-subject", role: "agent",
  authenticatedAt: Math.floor(Date.now() / 1000), authenticationMethods: ["mfa"] };
const actor = { instance_id: instanceId, native_user_id: "12", revision: 4,
  base_url: "https://case.example.test", service_secret_reference: "synthetic-secret", privacy_secret_reference: "synthetic-privacy" };
const source = { issuer: "https://identity.example.test", audience: "wasalx-api" };
const body = { operation: "SHOW", input: { ticket_id: "42" } };

function controller(t, rows = [actor, actor]) {
  let index = 0;
  const queries = [];
  const instance = new PortalWorkspaceController({ rows: async (tenant, sql, values) => {
    assert.equal(tenant, tenantId);
    queries.push({ sql, values });
    return rows[index++] ? [rows[index - 1]] : [];
  }, withTenant: async (tenant, block) => {
    assert.equal(tenant, tenantId);
    return block({ query: async () => ({ rows: [{ privileged_reauth_minutes: 15 }] }) });
  } }, { resolveCredentials: async (reference, binding) => {
    assert.equal(reference, actor.service_secret_reference);
    assert.deepEqual(binding, { tenantId, instanceId });
    return { apiToken: "synthetic-token", jwtSecret: "synthetic-signing-secret" };
  }, resolvePrivacyToken: async (reference, binding) => {
    assert.equal(reference, actor.privacy_secret_reference);
    assert.deepEqual(binding, { tenantId, instanceId });
    return "synthetic-private-privacy-token";
  } });
  const previous = { issuer: process.env.OIDC_ISSUER, audience: process.env.OIDC_AUDIENCE };
  process.env.OIDC_ISSUER = source.issuer; process.env.OIDC_AUDIENCE = source.audience;
  t.after(() => {
    if (previous.issuer === undefined) delete process.env.OIDC_ISSUER; else process.env.OIDC_ISSUER = previous.issuer;
    if (previous.audience === undefined) delete process.env.OIDC_AUDIENCE; else process.env.OIDC_AUDIENCE = previous.audience;
  });
  return { instance, queries };
}

test("ticket permissions admit staff without expanding tenant-wide case metadata", () => {
  assert.equal(can("agent", "ticket:read"), true);
  assert.equal(can("agent", "ticket:write"), true);
  assert.equal(can("agent", "case:read"), false);
  assert.equal(can("auditor", "ticket:read"), false);
  assert.equal(can("auditor", "ticket:write"), false);
  assert.equal(can("auditor", "case:read"), true);
});

test("workspace request rejects actor injection, unknown operations and oversized input", () => {
  assert.deepEqual(validateWorkspaceRequest(body), body);
  for (const value of [null, [], { ...body, actor: "admin" }, { operation: "DELETE", input: {} },
    { operation: "SHOW", input: [] }, { operation: "REPLY", input: { body: "x".repeat(32768) } }])
    assert.throws(() => validateWorkspaceRequest(value), /request|large/i);
});

test("delegation binds exact principal, purpose, method, path and serialized request", async t => {
  const { instance, queries } = controller(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls++;
    assert.equal(String(url), "https://case.example.test/api/v1/wasalx/portal-workspace");
    assert.equal(options.redirect, "error");
    const envelope = JSON.parse(options.body);
    assert.deepEqual(envelope.actor, { user_id: userId, subject: principal.subject, revision: 4, native_user_id: "12" });
    assert.deepEqual(envelope.source, source);
    assert.equal(envelope.assurance.auth_time, principal.authenticatedAt);
    assert.deepEqual(envelope.assurance.amr, ["mfa"]);
    const message = `wasalx.portal-workspace.v1\nPOST\n/api/v1/wasalx/portal-workspace\n${options.headers["x-wasalx-timestamp"]}\n${options.body}`;
    assert.equal(options.headers["x-wasalx-signature"], createHmac("sha256", "synthetic-signing-secret").update(message).digest("hex"));
    return Response.json({ id: "42" });
  });
  assert.deepEqual(await instance.execute({ principal }, body), { id: "42" });
  assert.equal(calls, 1);
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.deepEqual(query.values, [tenantId, userId, principal.subject, "agent"]);
    for (const fence of ["p.revision=p.applied_revision", "u.oidc_subject=p.oidc_subject", "p.email=u.email",
      "m.role=p.role", "m.state='ACTIVE'", "t.state='ACTIVE'", "z.id=p.zammad_instance_id", "s.native_membership_sync_enabled"])
      assert.ok(query.sql.includes(fence), fence);
  }
});

test("missing mapping and mapping drift deny content without falling back to service identity", async t => {
  const missing = controller(t, [null, { working: true }]);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ body: "private" }); });
  await assert.rejects(() => missing.instance.execute({ principal }, body), error => error.getStatus() === 403 && /access/.test(error.message));
  // A held case workspace is reported as a service outage, never as missing member access.
  const held = controller(t, [null, { working: false }]);
  await assert.rejects(() => held.instance.execute({ principal }, body), error => error.getStatus() === 503);
  assert.match(held.queries[1].sql, /z\.state='WORKING'/u);
  assert.equal(calls, 0);
  for (const changed of [{ ...actor, revision: 5 }, { ...actor, native_user_id: "13" }, { ...actor, instance_id: "other" }]) {
    const current = controller(t, [actor, changed]);
    await assert.rejects(() => current.instance.execute({ principal }, body), /access changed/);
  }
});

test("lost mutation result is never automatically retried", async t => {
  const { instance } = controller(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("socket lost after commit"); });
  await assert.rejects(() => instance.execute({ principal }, { operation: "REPLY", input: {
    ticket_id: "42", operation_id: tenantId, body: "Customer reply", internal: false,
  } }), /Check the operation/);
  assert.equal(calls, 1);
});

test("post-dispatch revocation preserves an unknown mutation outcome", async t => {
  const { instance } = controller(t, [actor, undefined]);
  t.mock.method(globalThis, "fetch", async () => Response.json({ state: "APPLIED", article_id: "99" }));
  await assert.rejects(() => instance.execute({ principal }, { operation: "REPLY", input: {
    ticket_id: "42", operation_id: tenantId, body: "Customer reply", internal: false,
  } }), error => error.getStatus() === 503 && error.getResponse().code === "WORKSPACE_OUTCOME_UNKNOWN");
});

test("attachments stream only after actor revalidation and enforce exact byte bounds", async t => {
  const { instance } = controller(t);
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "application/octet-stream", "content-length": "3" },
  }));
  const result = await instance.execute({ principal }, { operation: "ATTACHMENT",
    input: { ticket_id: "42", article_id: "10", attachment_id: "5" } });
  assert.deepEqual(result.getHeaders(), { type: "application/octet-stream", disposition: "attachment", length: 3 });
  const chunks = [];
  for await (const chunk of result.getStream()) chunks.push(chunk);
  assert.deepEqual([...Buffer.concat(chunks)], [1, 2, 3]);
});

test("oversized or unbounded attachment declarations fail before streaming", async t => {
  for (const length of [undefined, "-1", "50000001"]) {
    const { instance } = controller(t);
    const mock = t.mock.method(globalThis, "fetch", async () => new Response("private-file",
      { headers: { "content-type": "application/octet-stream", ...(length === undefined ? {} : { "content-length": length }) } }));
    await assert.rejects(() => instance.execute({ principal }, { operation: "ATTACHMENT", input: {} }), /Attachment is unavailable/);
    mock.mock.restore();
  }
});

test("native denial and large responses cannot leak backend error text", async t => {
  for (const status of [401, 403, 404, 409, 422, 503]) {
    const { instance } = controller(t);
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "private-provider-secret" }, { status }));
    await assert.rejects(() => instance.execute({ principal }, body), error => !String(error).includes("private-provider-secret"));
    mock.mock.restore();
  }
  const { instance } = controller(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ body: "x".repeat(5_242_881) }));
  await assert.rejects(() => instance.execute({ principal }, body), /result is unavailable/);
});

test("Ruby delegation validates cryptographic and replay-window boundaries", () => {
  const ruby = spawnSync("ruby", ["tests/portal-delegation-test.rb"], { encoding: "utf8", timeout: 15_000 });
  assert.ifError(ruby.error);
  assert.equal(ruby.status, 0, ruby.stderr + ruby.stdout);
});

test("group presentation preserves existing source and receipt boundaries", () => {
  const ruby = spawnSync("ruby", ["tests/portal-groups-contract.rb"], { encoding: "utf8", timeout: 15_000 });
  assert.ifError(ruby.error);
  assert.equal(ruby.status, 0, ruby.stderr + ruby.stdout);
});

test("native mutations retain policies, workflow validation and one atomic receipt", () => {
  const native = readFileSync(new URL("../zammad-package/app/controllers/api/v1/wasalx_portal_workspace_controller.rb", import.meta.url), "utf8");
  for (const required of ["TicketPolicy::ReadScope", "Ticket::ArticlePolicy", "agent_update_access?", "follow_up?",
    "UserInfo.with_user_id", "ticket.screen = 'edit'", "pg_advisory_xact_lock", "ticket.lock!",
    "WasalxTicketOperation.create!", "existing.request_sha256 == digest", "SessionAssurance.recent?",
    "SessionAssurance.authoritative_mfa?", "result['portal_source'] == @envelope['source']"])
    assert.ok(native.includes(required), required);
  assert.doesNotMatch(native, /CommunicateWasalxJob|queueOutboundParts|def current_user/);
});

test("native privileged expiry survives only administrative writes with a current actor", async t => {
  const owner = { ...principal, role: "tenant_owner", authenticatedAt: Math.floor(Date.now() / 1000) };
  for (const action of [
    { operation: "TEAM_CREATE", input: { operation_id: tenantId, name: "Support" } },
    { operation: "MAILBOX_PAUSE", input: { operation_id: tenantId, mailbox_id: "2" } },
    { operation: "TEAM_RECEIPT", input: { operation_id: tenantId, kind: "TEAM_CREATE", cancel_if_missing: true } },
    { operation: "MAILBOX_RECEIPT", input: { operation_id: tenantId, kind: "MAILBOX_PAUSE", mailbox_id: "2", cancel_if_missing: true } },
  ]) {
    const { instance, queries } = controller(t);
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({
      code: "REAUTHENTICATION_REQUIRED", message: "private-native-error", state: "NOT_APPLIED", effect: "NONE", terminal: true,
    }, { status: 403 }));
    await assert.rejects(() => instance.execute({ principal: owner }, action), error => {
      assert.equal(error.getStatus(), 403);
      assert.deepEqual(error.getResponse(), { code: "REAUTHENTICATION_REQUIRED", message: "Sign in again before changing workspace settings." });
      assert.equal(queries.length, 2);
      return true;
    });
    mock.mock.restore();
  }
});

test("native reauthentication code cannot override permissions or unrelated-operation denial", async t => {
  const { instance, queries } = controller(t);
  let calls = 0;
  const mock = t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ code: "REAUTHENTICATION_REQUIRED" }, { status: 403 }); });
  await assert.rejects(() => instance.execute({ principal }, { operation: "TEAM_CREATE", input: {} }), error => {
    assert.equal(error.getStatus(), 403);
    assert.notEqual(error.getResponse()?.code, "REAUTHENTICATION_REQUIRED");
    return true;
  });
  assert.equal(calls, 0);
  assert.equal(queries.length, 0);
  mock.mock.restore();
  for (const action of [body, { operation: "TEAM_LIST", input: {} }, { operation: "MAILBOX_LIST", input: {} },
    { operation: "TEAM_RECEIPT", input: { cancel_if_missing: false } }, { operation: "MAILBOX_RECEIPT", input: {} },
    { operation: "REPLY", input: {} }]) {
    const { instance: target } = controller(t);
    const replacement = t.mock.method(globalThis, "fetch", async () => Response.json({ code: "REAUTHENTICATION_REQUIRED" }, { status: 403 }));
    await assert.rejects(() => target.execute({ principal: { ...principal, role: "tenant_owner" } }, action), error => {
      assert.equal(error.getStatus(), 403);
      assert.notEqual(error.getResponse()?.code, "REAUTHENTICATION_REQUIRED");
      return true;
    });
    replacement.mock.restore();
  }
});

test("native privileged expiry cannot survive actor revocation, identity drift or malformed code", async t => {
  for (const current of [undefined, { ...actor, revision: 5 }, { ...actor, native_user_id: "13" }, { ...actor, instance_id: tenantId }]) {
    const { instance } = controller(t, [actor, current]);
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ code: "REAUTHENTICATION_REQUIRED" }, { status: 403 }));
    await assert.rejects(() => instance.execute({ principal: { ...principal, role: "tenant_owner" } },
      { operation: "TEAM_CREATE", input: {} }), error => error.getStatus() === 403 && error.getResponse()?.code !== "REAUTHENTICATION_REQUIRED");
    mock.mock.restore();
  }
  for (const [status, code] of [[401, "REAUTHENTICATION_REQUIRED"], [409, "REAUTHENTICATION_REQUIRED"],
    [403, "reauthentication_required"], [403, ["REAUTHENTICATION_REQUIRED"]], [403, "PRIVATE_CODE"]]) {
    const { instance } = controller(t);
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ code }, { status }));
    await assert.rejects(() => instance.execute({ principal: { ...principal, role: "tenant_owner" } },
      { operation: "MAILBOX_PAUSE", input: {} }), error => error.getResponse()?.code !== "REAUTHENTICATION_REQUIRED");
    mock.mock.restore();
  }
});

test("existing inbox BFF preserves typed reauthentication without inventing an operation outcome", async () => {
  const read = name => {
    const text = readFileSync(new URL(name, import.meta.url), "utf8");
    return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  };
  const declaration = (file, name) => {
    const node = file.statements.find(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name);
    assert.ok(node, name);
    return ts.transpileModule(node.getText(file).replace(/^export /u, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  };
  const data = read("../lib/control-plane-data.ts"), auth = read("../lib/request-auth.ts"), route = read("../app/api/inbox/route.ts");
  const ControlPlaneError = new Function(declaration(data, "ControlPlaneError") + ";return ControlPlaneError;")();
  const otherErrors = Array.from({ length: 4 }, () => class extends Error {});
  const authErrorResponse = new Function("AuthenticationError", "AuthorizationError", "RequestSecurityError", "PortalSessionError",
    declaration(auth, "authErrorResponse") + ";return authErrorResponse;")(...otherErrors);
  let rejection, requestBody = { operation: "TEAM_CREATE", input: {} };
  const POST = new Function("authenticatePortalRequest", "isControlPlaneBackend", "sitesPrivateDemoError", "readBoundedBody",
    "portalInboxRequest", "ControlPlaneError", "authErrorResponse", declaration(route, "POST") + ";return POST;")(
      async () => principal, () => true, () => new Error(), async () => new TextEncoder().encode(JSON.stringify(requestBody)),
      async () => { throw rejection; }, ControlPlaneError, authErrorResponse);
  rejection = new ControlPlaneError("Sign in again before changing workspace settings.", 403, "REAUTHENTICATION_REQUIRED");
  for (const operation of ["TEAM_CREATE", "IDENTITY_RECEIPT"]) {
    requestBody = operation === "IDENTITY_RECEIPT" ? { operation, input: { request_id: tenantId, kind: "IDENTITY_INITIALIZE", action: "LOOKUP" } } : { operation, input: {} };
    const response = await POST(new Request("https://portal.example.test/api/inbox", { method: "POST" }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Sign in again before changing workspace settings.", code: "REAUTHENTICATION_REQUIRED" });
  }
  rejection = new ControlPlaneError("Workspace access is unavailable", 403);
  const denied = await POST(new Request("https://portal.example.test/api/inbox", { method: "POST" }));
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "Workspace access is unavailable" });
});


test("source context is a read and requires the same current actor before returning UUID navigation", async t => {
  const { instance } = controller(t);
  const request = { operation: "SOURCE_CONTEXT", input: { ticket_id: "42", article_id: "901" } };
  assert.deepEqual(validateWorkspaceRequest(request), request);
  const result = { group_id: "12000000-0000-4000-8000-000000000001", message_id: "13000000-0000-4000-8000-000000000001" };
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(JSON.parse(options.body).operation, "SOURCE_CONTEXT");
    assert.deepEqual(JSON.parse(options.body).input, request.input);
    return Response.json(result);
  });
  assert.deepEqual(await instance.execute({ principal }, request), result);
  const changed = controller(t, [actor, { ...actor, revision: actor.revision + 1 }]);
  await assert.rejects(() => changed.instance.execute({ principal }, request), /access changed/);
});

test("source navigation keeps exact UUID targets on WasalX and removes malformed or stale target parameters", () => {
  const file = ts.createSourceFile("WasalXApp.tsx", readTenantPortalSource(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = name => {
    const node = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node, name);
    // Shared helpers are exported from tenant-ui; the compiled declaration is evaluated as a plain function.
    return ts.transpileModule(node.getText(file).replace(/^export /u, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  };
  const variable = file.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(file) === "NAVIGATION_TARGET_KEYS"));
  assert.ok(variable);
  const keys = ts.transpileModule(variable.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const { navigationUrl, safeNavigationTarget } = new Function(keys + declaration("safeNavigationTarget") + declaration("navigationUrl") + ";return { navigationUrl, safeNavigationTarget };")();
  const group = "12000000-0000-4000-8000-000000000001", message = "13000000-0000-4000-8000-000000000001";
  const result = navigationUrl("https://portal.example.test/app?ticket=1042&message=old", "inbox", { workspace: "groups", group, message });
  assert.equal(result.pathname, "/app"); assert.equal(result.origin, "https://portal.example.test");
  assert.equal(result.searchParams.get("group"), group); assert.equal(result.searchParams.get("message"), message);
  assert.equal(result.searchParams.get("ticket"), null);
  assert.equal(safeNavigationTarget("https://native.example.test/#ticket/42", "message"), null);
  assert.equal(safeNavigationTarget("<script>", "message"), null);
  assert.equal(safeNavigationTarget(message.toUpperCase(), "message"), message);
  assert.equal(navigationUrl(result.href, "inbox", { ticket: "1042" }).searchParams.get("message"), null);
});

test("portal email projection keeps native uncertainty and recipient state read-only", () => {
  const ruby = spawnSync("ruby", ["tests/portal-mail-delivery-contract.rb"], { encoding: "utf8", timeout: 15_000 });
  assert.ifError(ruby.error); assert.equal(ruby.status, 0, ruby.stderr + ruby.stdout);
  const source = readFileSync(new URL("../zammad-package/app/controllers/api/v1/wasalx_portal_workspace_controller.rb", import.meta.url), "utf8");
  assert(source.includes("return '' if Wasalx::PortalMailDelivery.notice?(article)"));
  assert(source.includes("delivery: Wasalx::PortalMailDelivery.article(article)"));
  assert(source.includes("Wasalx::PortalMailDelivery.recipient(ticket.customer)"));
});




test("Inbox System articles use WasalX presentation while preserving human authors and content", () => {
  const inbox = ts.createSourceFile("Inbox.tsx", readFileSync(new URL("../app/Inbox.tsx", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expressions = [];
  const visit = node => { if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)
    && ["b", "span"].includes(node.parent.openingElement.tagName.getText(inbox))) expressions.push(node.expression.getText(inbox)); ts.forEachChild(node, visit); };
  visit(inbox);
  const find = marker => { const matches = expressions.filter(text => text.includes(marker)); assert.equal(matches.length, 1); return new Function("article", "t", `return (${matches[0]});`); };
  const author = find("article.author"), label = find('"inbox.customerMessage"');
  for (const [locale, systemLabel, noteLabel, replyLabel, customerLabel] of [
    ["en", "System message", "Internal note", "Team reply", "Customer message"],
    ["ar", "رسالة النظام", "ملاحظة داخلية", "رد الفريق", "رسالة العميل"],
  ]) {
    const text = readFileSync(new URL(`../lib/i18n/messages/${locale}/cases.ts`, import.meta.url), "utf8");
    const dictionary = ts.createSourceFile("cases.ts", text, ts.ScriptTarget.Latest, true);
    const messages = { "common.brand.name": "WasalX" };
    const collect = node => { if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && ts.isStringLiteral(node.initializer)) messages[node.name.text] = node.initializer.text; ts.forEachChild(node, collect); };
    collect(dictionary);
    const t = key => { assert.equal(typeof messages[key], "string", `${locale}: ${key}`); return messages[key]; };
    for (const internal of [false, true]) {
      const article = { sender: "System", internal, author: "Zammad System <system@example.invalid>", body: "Preserve generated message content" };
      const original = structuredClone(article);
      assert.equal(author(article, t), "WasalX"); assert.equal(label(article, t), internal ? noteLabel : systemLabel);
      assert.deepEqual(article, original);
    }
    for (const [sender, expected] of [["Agent", replyLabel], ["Customer", customerLabel]]) {
      const article = { sender, internal: false, author: `Zammad mentioned by ${sender}`, body: "Preserve all customer and staff content" };
      const original = structuredClone(article);
      assert.equal(author(article, t), article.author); assert.equal(label(article, t), expected); assert.deepEqual(article, original);
      assert.equal(author({ ...article, author: null }, t), messages["inbox.customer"]);
    }
  }
});

test("owner service-access bridge signs its own purpose and private configured token hashes", async t => {
  const { instance } = controller(t);
  const owner = { ...principal, role: "tenant_owner" };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://case.example.test/api/v1/wasalx/service/identity");
    const envelope = JSON.parse(options.body);
    assert.equal(envelope.purpose, "wasalx.service-identity.v1");
    assert.equal(envelope.operation, "IDENTITY_STATUS"); assert.equal(envelope.actor.email, owner.email);
    assert.match(envelope.input.configured_runtime_sha256, /^[a-f0-9]{64}$/u);
    assert.match(envelope.input.configured_privacy_sha256, /^[a-f0-9]{64}$/u);
    assert.ok(!options.body.includes("synthetic-token") && !options.body.includes("synthetic-private-privacy-token"));
    const message = `wasalx.service-identity.v1\nPOST\n/api/v1/wasalx/service/identity\n${options.headers["x-wasalx-timestamp"]}\n${options.body}`;
    assert.equal(options.headers["x-wasalx-signature"], createHmac("sha256", "synthetic-signing-secret").update(message).digest("hex"));
    return Response.json({ mode: "FRESH", phase: "BOUND", portal_ready: true });
  });
  assert.equal((await instance.execute({ principal: owner }, { operation: "IDENTITY_STATUS", input: {} })).portal_ready, true);
});

test("service access rejects nonowners, missing recent MFA and client credential proof injection", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({}); });
  const { instance } = controller(t);
  await assert.rejects(() => instance.execute({ principal }, { operation: "IDENTITY_STATUS", input: {} }), /owner/u);
  await assert.rejects(() => instance.execute({ principal: { ...principal, role: "tenant_owner", authenticatedAt: 0 } },
    { operation: "IDENTITY_GRANT", input: {} }), error => error.getResponse().code === "REAUTHENTICATION_REQUIRED");
  await assert.rejects(() => instance.execute({ principal: { ...principal, role: "tenant_owner" } },
    { operation: "IDENTITY_STATUS", input: { configured_runtime_sha256: "a".repeat(64) } }), /Invalid workspace request/u);
  assert.equal(calls, 0);
});


function protectedSetupController(t, state = { sync: "PROTECTED", revision: 4, native: null }, beforeSettlement = () => {}) {
  const setupActor = () => ({ ...actor, instance_id: state.instanceId ?? actor.instance_id, revision: state.revision, native_user_id: state.native });
  const owner = { ...principal, role: "tenant_owner", email: "owner@example.invalid" };
  const proof = { portal_user_id: userId, native_user_id: "12", revision: 4,
    subject_sha256: createHash("sha256").update(owner.subject).digest("hex"),
    email_sha256: createHash("sha256").update(owner.email).digest("hex"), identity_receipt_sha256: "a".repeat(64) };
  let settled = 0;
  const instance = new PortalWorkspaceController({ rows: async (tenant, sql, values) => {
    assert.equal(tenant, tenantId); assert.equal(values[1], userId); assert.equal(values[2], owner.subject);
    if (state.revoked) return [];
    if (sql.includes("p.sync_state='READY'")) return state.sync === "READY" ? [setupActor()] : [];
    assert.ok(sql.includes("p.sync_state='PROTECTED'") && sql.includes("p.applied_revision=0") && sql.includes("p.requested_native_user_id IS NULL"));
    assert.equal(values[3], owner.email); return state.sync === "PROTECTED" ? [setupActor()] : [];
  }, withTenant: async (tenant, block) => {
    assert.equal(tenant, tenantId);
    return block({ query: async (sql, values) => {
      if (state.busyQuery && sql.includes(state.busyQuery)) throw Object.assign(new Error("Synthetic row contention"), { code: "55P03" });
      if (sql.startsWith("SELECT privileged_reauth_minutes")) { state.duringMfa?.(state); return { rows: [{ privileged_reauth_minutes: 15 }] }; }
      if (sql.includes("FOR UPDATE OF p")) { beforeSettlement(state); return { rows: state.revoked ? [] : [{ native_user_id: state.native, revision: state.revision, applied_revision: state.native ? state.revision : 0, sync_state: state.sync }] }; }
      if (sql.startsWith("UPDATE native_membership_projections")) { assert.equal(values[3], 4); state.sync = "READY"; state.native = "12"; settled++; return { rowCount: 1, rows: [] }; }
      if (sql.includes("app.lock_current_operator_principal(")) {
        assert.deepEqual(values,[owner.userId,owner.subject,owner.email,owner.role]);
        return {rows:[{current_role:state.revoked?null:owner.role}]};
      }
      if (sql.includes("app.lock_current_working_zammad_instance(")) {
        assert.deepEqual(values,[actor.instance_id]);return {rows:[{working:!state.revoked}]};
      }
      assert.ok(sql.startsWith("INSERT INTO audit_events")); return { rows: [] };
    } });
  } }, { resolveCredentials: async () => ({ apiToken: "synthetic-token", jwtSecret: "synthetic-signing-secret" }), resolvePrivacyToken: async () => "synthetic-private-privacy-token" });
  const previous = { issuer: process.env.OIDC_ISSUER, audience: process.env.OIDC_AUDIENCE };
  process.env.OIDC_ISSUER = source.issuer; process.env.OIDC_AUDIENCE = source.audience;
  t.after(() => { for (const [key, value] of [["OIDC_ISSUER", previous.issuer], ["OIDC_AUDIENCE", previous.audience]]) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  return { instance, owner, proof, state, settled: () => settled };
}

test("protected owner initialization loses response then settles only from exact native receipt without replay", async t => {
  const setup = protectedSetupController(t); let initializations = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const envelope = JSON.parse(options.body);
    assert.equal(envelope.actor.native_user_id, null); assert.equal(envelope.actor.email, setup.owner.email);
    if (envelope.operation === "IDENTITY_INITIALIZE") { initializations++; throw new Error("Lost committed native response"); }
    assert.equal(envelope.operation, "IDENTITY_RECEIPT");
    return Response.json({ state: "APPLIED", terminal: true, owner_projection: setup.proof });
  });
  await assert.rejects(() => setup.instance.execute({ principal: setup.owner }, { operation: "IDENTITY_INITIALIZE", input: { request_id: tenantId, expected_status_version: "b".repeat(64) } }), error => error.getResponse().code === "WORKSPACE_OUTCOME_UNKNOWN");
  assert.equal(setup.state.sync, "PROTECTED"); assert.equal(setup.settled(), 0);
  const recovered = await setup.instance.execute({ principal: setup.owner }, { operation: "IDENTITY_RECEIPT", input: { request_id: tenantId, kind: "IDENTITY_INITIALIZE", action: "LOOKUP" } });
  assert.deepEqual(recovered, { state: "APPLIED", terminal: true }); assert.equal(initializations, 1); assert.equal(setup.settled(), 1); assert.equal(setup.state.sync, "READY");
});

test("lost initializer receipt preserves trusted reauthentication until the same owner can settle without replay", async t => {
  const setup = protectedSetupController(t); let initializations = 0, lookups = 0;
  const request = { request_id: tenantId, kind: "IDENTITY_INITIALIZE", action: "LOOKUP" };
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const envelope = JSON.parse(options.body);
    if (envelope.operation === "IDENTITY_INITIALIZE") { initializations++; throw new Error("Lost committed native response"); }
    assert.equal(envelope.operation, "IDENTITY_RECEIPT"); assert.deepEqual(Object.fromEntries(Object.entries(envelope.input).filter(([key]) => !key.startsWith("configured_"))), request);
    lookups++; return Response.json({ state: "APPLIED", terminal: true, owner_projection: setup.proof });
  });
  await assert.rejects(() => setup.instance.execute({ principal: setup.owner }, { operation: "IDENTITY_INITIALIZE", input: { request_id: tenantId, expected_status_version: "b".repeat(64) } }), error => error.getResponse().code === "WORKSPACE_OUTCOME_UNKNOWN");
  const expiredOwner = { ...setup.owner, authenticatedAt: Math.floor(Date.now() / 1000) - 16 * 60 };
  await assert.rejects(() => setup.instance.execute({ principal: expiredOwner }, { operation: "IDENTITY_RECEIPT", input: request }), error => {
    assert.equal(error.getStatus(), 403);
    assert.deepEqual(error.getResponse(), { code: "REAUTHENTICATION_REQUIRED", message: "Sign in again before changing workspace settings." });
    return true;
  });
  assert.equal(setup.state.sync, "PROTECTED"); assert.equal(setup.state.native, null); assert.equal(setup.settled(), 0);
  const recovered = await setup.instance.execute({ principal: setup.owner }, { operation: "IDENTITY_RECEIPT", input: request });
  assert.deepEqual(recovered, { state: "APPLIED", terminal: true });
  assert.equal(initializations, 1); assert.equal(lookups, 2); assert.equal(setup.settled(), 1); assert.equal(setup.state.sync, "READY");
});

test("expired setup receipt cannot turn changed current ownership into a reauthentication hint", async t => {
  for (const change of [state => { state.revoked = true; }, state => { state.revision = 5; }, state => { state.instanceId = tenantId; }, state => { state.native = "13"; }]) {
    const setup = protectedSetupController(t, { sync: "PROTECTED", revision: 4, native: null, duringMfa: change });
    t.mock.method(globalThis, "fetch", async () => Response.json({ state: "APPLIED", terminal: true, owner_projection: setup.proof }));
    await assert.rejects(() => setup.instance.execute({ principal: { ...setup.owner, authenticatedAt: Math.floor(Date.now() / 1000) - 16 * 60 } },
      { operation: "IDENTITY_RECEIPT", input: { request_id: tenantId, kind: "IDENTITY_INITIALIZE", action: "LOOKUP" } }), error => error.getResponse().code === "WORKSPACE_OUTCOME_UNKNOWN");
    assert.equal(setup.settled(), 0); assert.notEqual(setup.state.native, "12"); assert.equal(setup.state.sync, "PROTECTED");
    t.mock.restoreAll();
  }
});

test("old native initialization proof cannot overwrite a new lifecycle revision or revoked owner", async t => {
  for (const change of [state => { state.revision = 5; }, state => { state.revoked = true; }]) {
    const setup = protectedSetupController(t, undefined, change);
    t.mock.method(globalThis, "fetch", async () => Response.json({ state: "APPLIED", terminal: true, owner_projection: setup.proof }));
    await assert.rejects(() => setup.instance.execute({ principal: setup.owner }, { operation: "IDENTITY_INITIALIZE", input: { request_id: tenantId, expected_status_version: "b".repeat(64) } }), error => error.getResponse().code === "WORKSPACE_OUTCOME_UNKNOWN");
    assert.equal(setup.settled(), 0); assert.equal(setup.state.native, null);
    t.mock.restoreAll();
  }
});

test("foreign source proof and cancellation cannot fabricate owner projection readiness", async t => {
  const setup = protectedSetupController(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ state: "APPLIED", terminal: true, owner_projection: { ...setup.proof, subject_sha256: "f".repeat(64) } }));
  await assert.rejects(() => setup.instance.execute({ principal: setup.owner }, { operation: "IDENTITY_RECEIPT", input: { request_id: tenantId, kind: "IDENTITY_INITIALIZE", action: "LOOKUP" } }), error => error.getResponse().code === "WORKSPACE_OUTCOME_UNKNOWN");
  assert.equal(setup.settled(), 0);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => Response.json({ state: "NOT_APPLIED", terminal: true }));
  assert.deepEqual(await setup.instance.execute({ principal: setup.owner }, { operation: "IDENTITY_RECEIPT", input: { request_id: tenantId, kind: "IDENTITY_INITIALIZE", action: "CANCEL_IF_UNADMITTED" } }), { state: "NOT_APPLIED", terminal: true });
  assert.equal(setup.state.sync, "PROTECTED"); assert.equal(setup.settled(), 0);
});


test("applied initializer responses require the exact native owner projection proof", async t => {
  const setup = protectedSetupController(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ state: "APPLIED", terminal: true }));
  for (const action of [{ operation: "IDENTITY_INITIALIZE", input: { request_id: tenantId, expected_status_version: "b".repeat(64) } },
    { operation: "IDENTITY_RECEIPT", input: { request_id: tenantId, kind: "IDENTITY_INITIALIZE", action: "LOOKUP" } }])
    await assert.rejects(() => setup.instance.execute({ principal: setup.owner }, action), error => error.getResponse().code === "WORKSPACE_OUTCOME_UNKNOWN");
  assert.equal(setup.settled(), 0); assert.equal(setup.state.sync, "PROTECTED");
});


test("service setup resolves only owned private privacy tokens and never exposes parsing failures", async t => {
  const previous = { url: process.env.SECRET_SIDECAR_URL, token: process.env.SECRET_SIDECAR_TOKEN, mode: process.env.NODE_ENV };
  process.env.NODE_ENV = "test"; process.env.SECRET_SIDECAR_URL = "http://secrets.internal"; process.env.SECRET_SIDECAR_TOKEN = "synthetic-sidecar-read-token";
  const resolver = new ZammadServiceSecretService(), owned = `secret://tenants/${tenantId}/zammad/privacy`;
  let calls = 0, value = { token: "synthetic-private-privacy-token" };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls++; assert.equal(String(url), "http://secrets.internal/v1/resolve"); assert.deepEqual(JSON.parse(options.body), { reference: owned });
    return Response.json(value);
  });
  try {
    await assert.rejects(() => resolver.resolvePrivacyToken(`secret://tenants/${userId}/zammad/privacy`, { tenantId, instanceId }));
    await assert.rejects(() => resolver.resolvePrivacyToken(`secret://tenants/${tenantId}/zammad/service`, { tenantId, instanceId }));
    assert.equal(calls, 0);
    assert.equal(await resolver.resolvePrivacyToken(owned, { tenantId, instanceId }), value.token);
    for (const invalid of [null, [], {}, { token: "short" }, { token: "synthetic-private-token\n" },
      { token: process.env.SECRET_SIDECAR_TOKEN }, { token: "x".repeat(20_000) }]) {
      value = invalid;
      await assert.rejects(() => resolver.resolvePrivacyToken(owned, { tenantId, instanceId }),
        error => error.message === "Secure Zammad service credentials could not be resolved." && !error.message.includes(owned));
    }
  } finally {
    resolver.onModuleDestroy();
    for (const [key, val] of [["SECRET_SIDECAR_URL", previous.url], ["SECRET_SIDECAR_TOKEN", previous.token], ["NODE_ENV", previous.mode]])
      if (val === undefined) delete process.env[key]; else process.env[key] = val;
  }
});


test("applied owner initialization row contention preserves unknown outcome and recovers the original receipt once", async t => {
  for (const busyQuery of ["app.lock_current_operator_principal(", "app.lock_current_working_zammad_instance(", "FOR UPDATE OF p"]) {
    const setup = protectedSetupController(t, { sync: "PROTECTED", revision: 4, native: null, busyQuery });
    let initializations = 0, receipts = 0;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      const envelope = JSON.parse(options.body);
      assert.equal(envelope.input.request_id, tenantId);
      if (envelope.operation === "IDENTITY_INITIALIZE") initializations++;
      else { assert.equal(envelope.operation, "IDENTITY_RECEIPT"); receipts++; }
      return Response.json({ state: "APPLIED", terminal: true, owner_projection: setup.proof });
    });
    await assert.rejects(() => setup.instance.execute({ principal: setup.owner }, {
      operation: "IDENTITY_INITIALIZE", input: { request_id: tenantId, expected_status_version: "b".repeat(64) },
    }), error => error.getStatus() === 503 && error.getResponse().code === "WORKSPACE_OUTCOME_UNKNOWN");
    assert.equal(initializations, 1); assert.equal(receipts, 0); assert.equal(setup.settled(), 0);
    assert.equal(setup.state.sync, "PROTECTED"); assert.equal(setup.state.native, null);
    setup.state.busyQuery = undefined;
    assert.deepEqual(await setup.instance.execute({ principal: setup.owner }, {
      operation: "IDENTITY_RECEIPT", input: { request_id: tenantId, kind: "IDENTITY_INITIALIZE", action: "LOOKUP" },
    }), { state: "APPLIED", terminal: true });
    assert.equal(initializations, 1); assert.equal(receipts, 1); assert.equal(setup.settled(), 1);
    assert.equal(setup.state.sync, "READY"); assert.equal(setup.state.native, "12");
    t.mock.restoreAll();
  }
});
