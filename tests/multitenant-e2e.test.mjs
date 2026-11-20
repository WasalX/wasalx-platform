import assert from "node:assert/strict";
import { fixtureNetwork, fixtureNetworkArgs } from "./support/ci-fixture-network.mjs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { boundedCommand } from "./support/bounded-command.mjs";
import { chromium } from "@playwright/test";
import Redis from "ioredis";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Client } from "pg";

const root = fileURLToPath(new URL("..", import.meta.url));
const postgresImage = "postgres:17.10-alpine3.23@sha256:8189a1f6e40904781fc9e2612687877791d21679866db58b1de996b31fc312e4";
const redisImage = "redis:8.4.1-alpine@sha256:e55195a3afbb812a14306909caad6583a1ab6c79f393f53490e42cb2111084a9";
const tenantA = "10000000-0000-4000-8000-000000000001";
const tenantB = "20000000-0000-4000-8000-000000000002";
const connectionA = "11000000-0000-4000-8000-000000000001";
const connectionB = "22000000-0000-4000-8000-000000000002";

test("one OIDC subject switches between isolated tenant sessions fail closed", { timeout: 240_000 }, async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pgName = `wasalx-mt-pg-${suffix}`;
  const redisName = `wasalx-mt-redis-${suffix}`;
  const resources = { browser: undefined, control: undefined, portal: undefined, identity: undefined, admin: undefined, redis: undefined };
  const redisWasPresent = await succeeds("docker", ["image", "inspect", redisImage]);
  const failures = [];
  try {
    if (!redisWasPresent) { assert.equal(fixtureNetwork(), null, "preload the pinned Redis image before offline CI"); await command("docker", ["pull", redisImage]); }
    await command("docker", [
      "run", "--detach", "--rm", "--name", pgName,
      "--tmpfs", "/var/lib/postgresql/data:rw,size=512m", "--tmpfs", "/tmp:rw,size=64m",
      ...fixtureNetworkArgs(5432, await freePort()),
      "-e", "POSTGRES_DB=wasalx", "-e", "POSTGRES_USER=wasalx", "-e", "POSTGRES_PASSWORD=wasalx-local-admin",
      ...roleEnvironment().flatMap(([name, value]) => ["-e", `${name}=${value}`]),
      "-v", `${root}/infra/docker/postgres/init-app-role.sh:/docker-entrypoint-initdb.d/10-app-role.sh:ro`,
      postgresImage, "postgres", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off",
    ]);
    await command("docker", [
      "run", "--detach", "--rm", "--name", redisName, "--tmpfs", "/data:rw,size=64m",
      ...fixtureNetworkArgs(6379, await freePort()), redisImage,
      "redis-server", "--appendonly", "no", "--save", "",
    ]);
    const postgresPort = await publishedPort(pgName, 5432);
    const redisPort = await publishedPort(redisName, 6379);
    const adminUrl = `postgresql://wasalx:wasalx-local-admin@127.0.0.1:${postgresPort}/wasalx`;
    const appUrl = `postgresql://wasalx_runtime:wasalx-local-app@127.0.0.1:${postgresPort}/wasalx`;
    const redisUrl = `redis://127.0.0.1:${redisPort}`;
    await waitFor(async () => {
      const client = new Client({ connectionString: adminUrl });
      try { await client.connect(); await client.query("SELECT 1"); return true; }
      catch { return false; }
      finally { await client.end().catch(() => undefined); }
    }, "PostgreSQL");
    await runProcess(process.execPath, ["services/control-api/dist/cli.js", "migrate", "--path", "services/control-api/migrations"], {
      DATABASE_ADMIN_URL: adminUrl,
    });
    resources.admin = new Client({ connectionString: adminUrl });
    await resources.admin.connect();
    assert.equal((await resources.admin.query("SELECT current_setting('fsync') || '|' || current_setting('synchronous_commit') || '|' || current_setting('full_page_writes') AS settings")).rows[0].settings, "off|off|off", "Disposable PostgreSQL durability settings must be effective");
    await seed(resources.admin);

    resources.identity = await IdentityServer.start();
    const controlPort = await freePort();
    const portalPort = await freePort();
    const controlOrigin = `http://127.0.0.1:${controlPort}`;
    const portalOrigin = `http://127.0.0.1:${portalPort}`;
    resources.control = start("control-api", process.execPath, ["services/control-api/dist/cli.js", "serve"], {
      NODE_ENV: "development", PORT: String(controlPort), DATABASE_URL: appUrl, DATABASE_POOL_SIZE: "4",
      WAHA_OPERATOR_DATABASE_URL: appUrl, SECRET_CLEANUP_DATABASE_URL: appUrl, META_GRAPH_VERSION: "v24.0",
      REDIS_URL: redisUrl, WORKER_JOB_JWT_SECRET: "test-worker-secret-value-at-least-32-bytes",
      SECRET_SIDECAR_URL: resources.identity.origin, SECRET_SIDECAR_TOKEN: "test-read-token", SECRET_SIDECAR_WRITE_TOKEN: "test-write-token",
      OIDC_ISSUER: resources.identity.origin, OIDC_AUDIENCE: "wasalx-control-api", OIDC_JWKS_URI: `${resources.identity.origin}/jwks`,
      CLIENT_ROUTING_EXTERNAL_CONNECTORS_ENABLED: "false", OTEL_SDK_DISABLED: "true",
    });
    await waitHttp(`${controlOrigin}/health/ready`, "control API", resources.control);
    resources.portal = start("portal", process.execPath, ["node_modules/vinext/dist/cli.js", "start", "-p", String(portalPort)], {
      NODE_ENV: "production", WASALX_ENVIRONMENT: "local-full", PORTAL_DATA_BACKEND: "control-plane", CONTROL_API_URL: controlOrigin,
      PORTAL_SESSION_REDIS_URL: redisUrl, PORTAL_SESSION_SECRET: "test-portal-session-secret-at-least-32-bytes",
      PORTAL_COOKIE_SECURE: "false", PORTAL_PUBLIC_ORIGIN: portalOrigin,
      OIDC_ISSUER: resources.identity.origin, OIDC_CLIENT_ID: "wasalx-portal",
      OIDC_AUTHORIZATION_ENDPOINT: `${resources.identity.origin}/authorize`, OIDC_TOKEN_ENDPOINT: `${resources.identity.origin}/token`,
      OIDC_END_SESSION_ENDPOINT: `${resources.identity.origin}/protocol/openid-connect/logout`,
      OIDC_JWKS_URI: `${resources.identity.origin}/jwks`, OIDC_REDIRECT_URI: `${portalOrigin}/auth/callback`,
      OTEL_SDK_DISABLED: "true", WRANGLER_LOG_PATH: `/tmp/wasalx-mt-${suffix}.log`,
      MINIFLARE_REGISTRY_PATH: `/tmp/wasalx-mt-${suffix}-registry`,
    });
    await waitHttp(`${portalOrigin}/api/health`, "portal", resources.portal);
    resources.redis = new Redis(redisUrl);
    resources.browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
    const context = await resources.browser.newContext();
    const page = await context.newPage();

    await waitForApplication(page, resources, `${portalOrigin}/auth/login?tenant_id=${tenantA}&return_to=/app`);
    await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: /Connections/u }).click();
    await assertWorkspace(page, "Tenant Alpha", "ALPHA-ONLY-CONNECTION", "BETA-ONLY-CONNECTION");
    const sessionA = await portalSession(context, resources.redis, portalOrigin);
    assert.equal(sessionA.value.tenantId, tenantA);
    const workspacesA = await context.request.get(`${portalOrigin}/api/workspaces`);
    assert.equal(workspacesA.status(), 200);
    assert.equal(workspacesA.headers()["cache-control"], "private, no-store");

    await page.setViewportSize({width:390,height:844});
    await page.getByRole("button",{name:"Menu"}).click();
    const workspaceSwitch=page.getByLabel("Switch workspace");
    const workspaceDetails=page.locator(".workspace-select");
    const betaWorkspace=page.locator(".workspace-options").getByRole("button", { name: "Tenant Beta", exact: true });
    await workspaceSwitch.focus();
    await page.keyboard.press("Enter");
    assert.notEqual(await workspaceDetails.getAttribute("open"),null);
    await page.keyboard.press("Tab");
    await page.waitForFunction(()=>document.activeElement?.textContent?.includes("Tenant Beta"));
    assert.equal(await betaWorkspace.evaluate(element=>element===document.activeElement),true);
    await page.keyboard.press("Escape");
    assert.equal(await workspaceDetails.getAttribute("open"),null);
    assert.equal(await workspaceSwitch.evaluate(element=>element===document.activeElement),true);
    await page.keyboard.press("Enter");
    const workspaceGeometry=await page.locator(".workspace-switcher").evaluate(element=>({right:element.getBoundingClientRect().right,viewport:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth}));
    assert.ok(workspaceGeometry.right<=workspaceGeometry.viewport);assert.equal(workspaceGeometry.scrollWidth,workspaceGeometry.viewport);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.waitForFunction((name) => document.body.textContent?.includes(name), "BETA-ONLY-CONNECTION");
    await assertWorkspace(page, "Tenant Beta", "BETA-ONLY-CONNECTION", "ALPHA-ONLY-CONNECTION");
    const sessionB = await portalSession(context, resources.redis, portalOrigin);
    assert.notEqual(sessionB.id, sessionA.id);
    assert.equal(sessionB.value.tenantId, tenantB);
    assert.equal(await resources.redis.exists(`wasalx:portal:session:${sessionA.id}`), 0);

    await waitForApplication(page, resources, `${portalOrigin}/app?view=connections&connection=${connectionA}`);
    await assertWorkspace(page, "Tenant Beta", "BETA-ONLY-CONNECTION", "ALPHA-ONLY-CONNECTION");
    const foreignRead = await context.request.get(`${portalOrigin}/api/connections/${connectionA}`);
    if (foreignRead.status() !== 404) {
      const direct = await context.request.get(`${controlOrigin}/v1/connections/${connectionA}`, {
        headers: { authorization: `Bearer ${sessionB.value.accessToken}`, "x-wasalx-tenant-id": tenantB },
      });
      process.stderr.write(`${JSON.stringify({ foreignRead: { status: foreignRead.status(), body: await foreignRead.text() }, direct: { status: direct.status(), body: await direct.text() } })}\n`);
      process.stderr.write(`control-api:\n${resources.control.logs()}\nportal:\n${resources.portal.logs()}\n`);
    }
    assert.equal(foreignRead.status(), 404);
    const foreignMutation = await page.evaluate(async ({ id, csrf }) => {
      const response = await fetch(`/api/connections/${id}/restart`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-wasalx-csrf": csrf, "idempotency-key": crypto.randomUUID() },
        body: "{}",
      });
      return response.status;
    }, { id: connectionA, csrf: sessionB.value.csrfToken });
    assert.equal(foreignMutation, 404);
    assert.equal((await context.request.get(`${portalOrigin}/api/connections/${connectionB}`)).status(), 200);
    const foreignDetail=page.getByRole("dialog",{name:"Connection details"});
    await foreignDetail.getByRole("alert").waitFor();
    await foreignDetail.getByRole("button",{name:"Close connection details"}).click();
    await foreignDetail.waitFor({state:"detached"});

    const authorizationCount=resources.identity.authorizations.length;
    const providerSession=resources.identity.authorizations.at(-1).sessionId;
    await page.getByRole("button", { name: "Sign out" }).click();
    await waitFor(()=>resources.identity.logouts.length===1,"identity-provider logout");
    const logoutUrl=resources.identity.logouts[0].url;
    assert.equal(logoutUrl.searchParams.get("client_id"),"wasalx-portal");
    assert.equal(logoutUrl.searchParams.get("post_logout_redirect_uri"),`${portalOrigin}/app`);
    assert.equal(resources.identity.logouts[0].sessionId,providerSession);
    await waitFor(() => resources.redis.exists(`wasalx:portal:session:${sessionB.id}`).then((value) => value === 0), "logout deletion");
    await waitForApplication(page, resources);
    assert.equal(resources.identity.authorizations.length,authorizationCount+1);
    assert.equal(resources.identity.authorizations.at(-1).hadSession,false);
    assert.notEqual(resources.identity.authorizations.at(-1).sessionId,providerSession);
    const sessionAfterLogout=await portalSession(context,resources.redis,portalOrigin);
    assert.notEqual(sessionAfterLogout.id,sessionB.id);
    // Close the polling SPA before the controlled token-grant barriers below.
    await page.close();
    await assertBackchannelBoundary(resources, context, sessionAfterLogout, portalOrigin, {
      NODE_ENV: "production", WASALX_ENVIRONMENT: "local-full", PORTAL_DATA_BACKEND: "control-plane",
      CONTROL_API_URL: controlOrigin, PORTAL_SESSION_REDIS_URL: redisUrl,
      PORTAL_SESSION_SECRET: "test-portal-session-secret-at-least-32-bytes",
      PORTAL_COOKIE_SECURE: "false", PORTAL_PUBLIC_ORIGIN: "https://portal.wasalx.test",
      OIDC_ISSUER: resources.identity.origin, OIDC_CLIENT_ID: "wasalx-portal",
      OIDC_AUTHORIZATION_ENDPOINT: `${resources.identity.origin}/authorize`,
      OIDC_TOKEN_ENDPOINT: `${resources.identity.origin}/token`,
      OIDC_JWKS_URI: `${resources.identity.origin}/jwks`,
      OIDC_REDIRECT_URI: "https://portal.wasalx.test/auth/callback",
    });
    await context.close();

    process.stdout.write(`${JSON.stringify({ postgresImage, redisImage, redisPulled: !redisWasPresent, sessionRotated: true, oldSessionDeleted: true })}\n`);
  } catch (error) {
    failures.push(error);
  } finally {
    await resources.browser?.close().catch(() => undefined);
    await resources.redis?.quit().catch(() => undefined);
    await resources.admin?.end().catch(() => undefined);
    await stop(resources.portal);
    await stop(resources.control);
    await resources.identity?.close().catch(() => undefined);
    const cleanup = await Promise.allSettled([redisName, pgName].map(async name => {
      await command("docker", ["rm", "-f", name], true);
      const result = await boundedCommand("docker", ["container", "inspect", name]);
      assert.ok(result.code !== 0 && /no such (object|container)/iu.test(result.output), `Owned test container cleanup unverified: ${name}`);
    }));
    failures.push(...cleanup.filter(result => result.status === "rejected").map(result => result.reason));
  }
  if (failures.length) {
    for (const failure of failures) process.stderr.write(`${failure?.stack ?? String(failure)}\n`);
    throw new AggregateError(failures, "Multitenant test or owned cleanup failed; inspect each cause");
  }
});

const diagnosedPaths = new Set(["/auth/callback", "/api/workspaces"]);
// Query strings can carry OIDC codes or state, so diagnostics print paths and parameter names only.
const safeUrl = value => { try { const url = new URL(value); return `${url.origin}${url.pathname}${[...url.searchParams.keys()].map(key => `[${key}]`).join("")}`; } catch { return "unparsable"; } };
const safeText = value => value.replace(/https?:\/\/\S+/gu, safeUrl).replace(/\b(Bearer|token|code|secret|cookie)\b(?:\s*[:=]\s*|\s+)\S+/giu, "$1 [redacted]").slice(0, 300);

async function waitForApplication(page, resources, url) {
  const started = Date.now();
  const events = [];
  const consoleErrors = [];
  const onResponse = response => {
    const { pathname } = new URL(response.url());
    if (diagnosedPaths.has(pathname)) events.push(`${response.request().method()} ${pathname} ${response.status()} at +${Date.now() - started}ms`);
  };
  const onFailed = request => {
    const { pathname } = new URL(request.url());
    if (diagnosedPaths.has(pathname)) events.push(`${request.method()} ${pathname} failed (${request.failure()?.errorText}) at +${Date.now() - started}ms`);
  };
  const onConsole = message => { if (message.type() === "error") consoleErrors.push(safeText(message.text())); };
  page.on("response", onResponse); page.on("requestfailed", onFailed); page.on("console", onConsole);
  try {
    if (url) await page.goto(url);
    await page.waitForSelector('[data-application-ready="true"]');
  } catch (error) {
    const shell = await page.locator("[data-shell-validation]").first().getAttribute("data-shell-validation", { timeout: 1_000 }).catch(() => "absent");
    process.stderr.write(`${JSON.stringify({ readinessTimeout: { url: safeUrl(page.url()), shellValidation: shell, elapsedMs: Date.now() - started, events, consoleErrors } }, null, 2)}\n`);
    process.stderr.write(`control-api:\n${resources.control.logs()}\nportal:\n${resources.portal.logs()}\n`);
    throw error;
  } finally {
    page.off("response", onResponse); page.off("requestfailed", onFailed); page.off("console", onConsole);
  }
}

async function assertWorkspace(page, workspace, visible, hidden) {
  await assert.doesNotReject(() => page.getByText(workspace, { exact: true }).first().waitFor());
  await assert.doesNotReject(() => page.getByText(visible, { exact: true }).first().waitFor());
  assert.equal(await page.getByText(hidden, { exact: true }).count(), 0);
}

async function portalSession(context, redis, origin) {
  const cookie = (await context.cookies(origin)).find(({ name }) => name === "wasalx_session");
  assert.ok(cookie?.value);
  const raw = await redis.get(`wasalx:portal:session:${cookie.value}`);
  assert.ok(raw);
  return { id: cookie.value, value: JSON.parse(raw) };
}

async function assertBackchannelBoundary(resources, original, first, origin, childEnv) {
  const { browser, identity, redis } = resources;
  const rowKey = id => `wasalx:portal:session:${id}`;
  const claimKey = id => `wasalx:portal:session-refresh:${id}`;
  const read = context => context.request.get(`${origin}/api/workspaces`);
  const submit = (token, encodedBody) => fetch(`${origin}/auth/backchannel-logout`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: encodedBody ?? new URLSearchParams({ logout_token: token }),
    redirect: "manual", signal: AbortSignal.timeout(5_000),
  });
  const contexts = [];
  const login = async (sameProviderContext) => {
    const context = await browser.newContext(); contexts.push(context);
    if (sameProviderContext) {
      const cookie = (await sameProviderContext.cookies(identity.origin)).find(value => value.name === "wasalx_identity_session");
      assert.ok(cookie); await context.addCookies([cookie]);
    }
    // The shell's readiness covers its own workspace and role check; close it before the grant barriers.
    const page = await context.newPage();
    await waitForApplication(page, resources, `${origin}/auth/login?tenant_id=${tenantA}&return_to=/app`);
    await page.close();
    const stored = await portalSession(context, redis, origin);
    const workspaces = await read(context);
    assert.equal(workspaces.status(), 200, "The workspace API must accept the new portal session");
    const current = (await workspaces.json()).data.find(workspace => workspace.current);
    assert.equal(current?.id, tenantA);
    assert.equal(current.role, stored.value.role, "The session role must match the workspace role");
    assert.equal(stored.value.role, "tenant_owner");
    return { context, ...stored };
  };
  const due = async (stored, expiresAt = Math.floor(Date.now() / 1_000) + 30) => {
    const value = { ...stored.value, expiresAt };
    await redis.set(rowKey(stored.id), JSON.stringify(value), "KEEPTTL");
    return value;
  };
  try {
    const peer = await login(original);
    const other = await login();
    assert.deepEqual(first.value.oidcBinding, peer.value.oidcBinding);
    assert.notEqual(first.id, peer.id);
    assert.notEqual(first.value.oidcBinding.sid, other.value.oidcBinding.sid);
    assert.equal(first.value.subject, other.value.subject, "SID scope, not user eviction");
    const before = await redis.mget(rowKey(first.id), rowKey(peer.id), rowKey(other.id));
    for (const token of [
      await identity.logoutToken(first.value.oidcBinding.sid, { aud: "foreign-client" }),
      await identity.logoutToken(undefined),
    ]) assert.equal((await submit(token)).status, 400);
    const valid = await identity.logoutToken(first.value.oidcBinding.sid);
    const duplicateForm = new URLSearchParams([ ["logout_token", valid], ["logout_token", valid] ]);
    assert.equal((await submit(valid, duplicateForm)).status, 400);
    assert.equal((await submit(valid, "logout_token=" + "a".repeat(33 * 1_024))).status, 400);
    assert.deepEqual(await redis.mget(rowKey(first.id), rowKey(peer.id), rowKey(other.id)), before);

    const accepted = await submit(valid);
    assert.equal(accepted.status, 200);
    assert.match(accepted.headers.get("cache-control") ?? "", /no-store/u);
    const marker = "wasalx:portal:oidc-logout:" + createHash("sha256")
      .update(JSON.stringify([identity.origin, "wasalx-portal", first.value.oidcBinding.sid])).digest("hex");
    const ttlBeforeReplay = await redis.pttl(marker);
    assert.ok(ttlBeforeReplay > 0 && ttlBeforeReplay <= (86_400 + 125 + 5) * 1_000);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await submit(valid)).status, 200);
    assert.ok(await redis.pttl(marker) < ttlBeforeReplay, "duplicate callback must not reset retention");
    assert.equal((await read(original)).status(), 401);
    assert.equal((await read(peer.context)).status(), 401);
    assert.equal((await read(other.context)).status(), 200);

    // Retains all prior opaque-cookie, CSRF, role and rotation assertions, now on real Redis.
    // Its extra CREATE negative proves a valid but late code result cannot resurrect this SID.
    await runProcess(process.execPath, ["--experimental-strip-types", "tests/support/portal-auth-boundary-child.mjs"], {
      ...childEnv, AUTH_BOUNDARY_REVOKED_SID: first.value.oidcBinding.sid,
    });

    const legacyId = randomUUID().replaceAll("-", "").padEnd(43, "x");
    const legacy = { ...other.value }; delete legacy.oidcBinding;
    await redis.set(rowKey(legacyId), JSON.stringify(legacy), "EX", 60);
    const legacyResponse = await fetch(`${origin}/api/workspaces`, {
      headers: { cookie: `wasalx_session=${legacyId}` }, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(legacyResponse.status, 401);
    assert.equal(await redis.exists(rowKey(legacyId)), 0);
    assert.equal((await read(other.context)).status(), 200);

    const successfulRefresh = await login();
    await due(successfulRefresh);
    const beforeSuccessfulRefresh = identity.refreshRequests;
    assert.equal((await read(successfulRefresh.context)).status(), 200);
    const renewed = await portalSession(successfulRefresh.context, redis, origin);
    assert.equal(identity.refreshRequests, beforeSuccessfulRefresh + 1);
    assert.notEqual(renewed.value.accessToken, successfulRefresh.value.accessToken);
    assert.notEqual(renewed.value.refreshToken, successfulRefresh.value.refreshToken);
    for (const field of ["oidcBinding", "createdAt", "absoluteExpiresAt", "authenticatedAt", "authenticationMethods", "authenticationContext"])
      assert.deepEqual(renewed.value[field], successfulRefresh.value[field], `Refresh preserves original ${field}`);
    assert.equal(await redis.exists(claimKey(successfulRefresh.id)), 0);
    assert.equal((await read(successfulRefresh.context)).status(), 200);
    assert.equal(identity.refreshRequests, beforeSuccessfulRefresh + 1);

    const refreshing = await login();
    await due(refreshing);
    let barrier = identity.pauseNextRefresh();
    const grantsBefore = identity.refreshRequests;
    let pending = read(refreshing.context);
    await barrier.entered;
    const claimTtl = await redis.pttl(claimKey(refreshing.id));
    assert.ok(claimTtl > 10_000, "claim must outlive the former 10s refresh lease");
    assert.ok(claimTtl >= (refreshing.value.absoluteExpiresAt - Math.floor(Date.now() / 1_000) - 2) * 1_000);
    assert.equal((await read(refreshing.context)).status(), 200, "still-valid cached read during one claim");
    assert.equal(identity.refreshRequests, grantsBefore + 1);
    assert.equal((await submit(await identity.logoutToken(refreshing.value.oidcBinding.sid))).status, 200);
    barrier.release();
    assert.ok([401, 503].includes((await pending).status()));
    assert.equal((await read(refreshing.context)).status(), 401);
    assert.equal(identity.refreshRequests, grantsBefore + 1, "logout must not re-issue a consumed grant");
    assert.equal(await redis.exists(rowKey(refreshing.id)), 0);

    const losingResponse = await login();
    await due(losingResponse);
    const beforeLostResponse = identity.refreshRequests;
    identity.dropNextRefreshResponse = true;
    assert.ok([401, 503].includes((await read(losingResponse.context)).status()));
    assert.equal((await read(losingResponse.context)).status(), 401);
    assert.equal(identity.refreshRequests, beforeLostResponse + 1, "unknown grant response is not replayed");

    const abandoned = await login();
    await due(abandoned, Math.floor(Date.now() / 1_000) - 1);
    // Models a process lost after an acknowledged/unknown claim. No HTTP retry is permitted.
    await redis.set(claimKey(abandoned.id), "abandoned-owned-test-intent", "EX", 60);
    const beforeAbandoned = identity.refreshRequests;
    assert.equal((await read(abandoned.context)).status(), 401);
    assert.equal(identity.refreshRequests, beforeAbandoned);
    assert.equal(await redis.get(claimKey(abandoned.id)), "abandoned-owned-test-intent");

    const ownLogout = await login();
    await due(ownLogout);
    barrier = identity.pauseNextRefresh();
    pending = read(ownLogout.context);
    await barrier.entered;
    const logout = await ownLogout.context.request.post(`${origin}/auth/logout`, {
      headers: { origin, "content-type": "application/json", "x-wasalx-csrf": ownLogout.value.csrfToken }, data: {},
    });
    assert.equal(logout.status(), 200);
    assert.equal(await redis.exists(rowKey(ownLogout.id), claimKey(ownLogout.id)), 0);
    barrier.release();
    assert.ok([401, 503].includes((await pending).status()));
    assert.equal(await redis.exists(rowKey(ownLogout.id)), 0, "refresh cannot recreate an own-logout row");

    const replacedClaim = await login();
    await due(replacedClaim);
    const oldRaw = await redis.get(rowKey(replacedClaim.id));
    barrier = identity.pauseNextRefresh();
    pending = read(replacedClaim.context);
    await barrier.entered;
    await redis.set(claimKey(replacedClaim.id), "different-owned-test-intent", "EX", 60);
    barrier.release();
    assert.ok([401, 503].includes((await pending).status()));
    assert.equal(await redis.get(rowKey(replacedClaim.id)), oldRaw);
    assert.equal(await redis.get(claimKey(replacedClaim.id)), "different-owned-test-intent", "CAS must preserve another claim");
  } finally {
    identity.releaseRefresh();
    await Promise.allSettled(contexts.map(context => context.close()));
  }
}

async function seed(client) {
  await client.query(`
    INSERT INTO tenants (id,name,slug,state) VALUES
      ('${tenantA}','Tenant Alpha','tenant-alpha','ACTIVE'),
      ('${tenantB}','Tenant Beta','tenant-beta','ACTIVE');
    INSERT INTO users (id,oidc_subject,email,display_name)
      VALUES ('30000000-0000-4000-8000-000000000003','subject-two-workspaces','owner@example.test','Multi Workspace Owner');
    INSERT INTO tenant_memberships (tenant_id,user_id,role) VALUES
      ('${tenantA}','30000000-0000-4000-8000-000000000003','tenant_owner'),
      ('${tenantB}','30000000-0000-4000-8000-000000000003','tenant_owner');
    INSERT INTO zammad_instances
      (id,tenant_id,base_url,version,state,database_reference,search_namespace,storage_prefix,service_secret_reference,privacy_secret_reference,last_healthy_at) VALUES
      ('31000000-0000-4000-8000-000000000001','${tenantA}','https://alpha.invalid','test','WORKING','db://alpha','alpha','alpha/','secret://tenants/${tenantA}/zammad/service','secret://tenants/${tenantA}/zammad/privacy',now()),
      ('32000000-0000-4000-8000-000000000002','${tenantB}','https://beta.invalid','test','WORKING','db://beta','beta','beta/','secret://tenants/${tenantB}/zammad/service','secret://tenants/${tenantB}/zammad/privacy',now());
    INSERT INTO connections (id,tenant_id,name,provider,engine,state,secret_reference,last_heartbeat_at) VALUES
      ('${connectionA}','${tenantA}','ALPHA-ONLY-CONNECTION','WAHA','GOWS','WORKING','secret://alpha/waha',now()),
      ('${connectionB}','${tenantB}','BETA-ONLY-CONNECTION','WAHA','GOWS','WORKING','secret://beta/waha',now());
  `);
}

function roleEnvironment() {
  return [
    ["WASALX_APP_PASSWORD", "wasalx-local-app"], ["WASALX_CONNECTOR_WORKER_DB_PASSWORD", "connector-worker-test"],
    ["WASALX_SECRET_CLEANUP_DB_PASSWORD", "cleanup-test"],
    ["WASALX_PROVISIONING_DB_PASSWORD", "provisioning-test"], ["WASALX_SUPPORT_DB_PASSWORD", "support-test"],
    ["WASALX_WAHA_REGISTRY_DB_PASSWORD", "registry-test"], ["WASALX_WAHA_OPERATOR_DB_PASSWORD", "operator-test"],
    ["WASALX_WAHA_ROLLOUT_GATE_DB_PASSWORD", "rollout-test"], ["WASALX_INVITATION_MAILER_DB_PASSWORD", "mailer-test"],
    ["WASALX_IDENTITY_POLICY_DB_PASSWORD", "identity-test"], ["WASALX_METERING_INGEST_DB_PASSWORD", "metering-test"],
    ["WASALX_PLATFORM_OPERATIONS_DB_PASSWORD", "platform-test"],
  ];
}

class IdentityServer {
  codes = new Map();
  refreshTokens = new Map();
  refreshRequests = 0;
  refreshBarrier = undefined;
  activeRefreshBarrier = undefined;
  dropNextRefreshResponse = false;
  sessions = new Set();
  authorizations = [];
  logouts = [];
  sockets = new Set();
  constructor(server, origin, privateKey, jwk) { this.server = server; this.origin = origin; this.privateKey = privateKey; this.jwk = jwk; }
  static async start() {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "multitenant-test", use: "sig" };
    let instance;
    const server = createServer((request, response) => instance.handle(request, response).catch((error) => {
      response.writeHead(500, { "content-type": "text/plain" }); response.end(String(error));
    }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address === "object");
    instance = new IdentityServer(server, `http://127.0.0.1:${address.port}`, privateKey, jwk);
    server.on("connection", (socket) => { instance.sockets.add(socket); socket.on("close", () => instance.sockets.delete(socket)); });
    return instance;
  }
  async handle(request, response) {
    const url = new URL(request.url, this.origin);
    if (url.pathname === "/health") return json(response, 200, { status: "ok" });
    if (url.pathname === "/jwks") return json(response, 200, { keys: [this.jwk] });
    if (url.pathname === "/authorize") {
      const existing=/(?:^|;\s*)wasalx_identity_session=([^;]+)/u.exec(request.headers.cookie??"")?.[1];
      const hadSession=typeof existing==="string"&&this.sessions.has(existing);
      const sessionId=hadSession?existing:randomUUID();
      if(!hadSession)this.sessions.add(sessionId);
      this.authorizations.push({hadSession,sessionId});
      const code = randomUUID();
      this.codes.set(code, { nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge"), sid: sessionId, authTime: Math.floor(Date.now() / 1_000) });
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      redirect.searchParams.set("code", code); redirect.searchParams.set("state", url.searchParams.get("state"));
      response.writeHead(302, { location: redirect.toString(), "cache-control": "no-store",
        ...(!hadSession?{"set-cookie":`wasalx_identity_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`}:{}) }); return response.end();
    }
    if(url.pathname==="/protocol/openid-connect/logout"){
      const sessionId=/(?:^|;\s*)wasalx_identity_session=([^;]+)/u.exec(request.headers.cookie??"")?.[1]??null;
      if(sessionId)this.sessions.delete(sessionId);
      this.logouts.push({url,sessionId});
      const redirect=new URL(url.searchParams.get("post_logout_redirect_uri"));
      response.writeHead(302,{location:redirect.toString(),"cache-control":"no-store","set-cookie":"wasalx_identity_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"});return response.end();
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await body(request));
      let record;
      const refresh = form.get("grant_type") === "refresh_token";
      if (refresh) {
        this.refreshRequests += 1;
        record = this.refreshTokens.get(form.get("refresh_token"));
        if (!record) return json(response, 400, { error: "invalid_grant" });
        this.refreshTokens.delete(form.get("refresh_token"));
        this.activeRefreshBarrier = this.refreshBarrier; this.refreshBarrier = undefined;
        if (this.activeRefreshBarrier) {
          this.activeRefreshBarrier.enter(); await this.activeRefreshBarrier.released;
          this.activeRefreshBarrier = undefined;
        }
      } else {
        assert.equal(form.get("grant_type"), "authorization_code");
        record = this.codes.get(form.get("code"));
        assert.ok(record); assert.equal(base64url(createHash("sha256").update(form.get("code_verifier")).digest()), record.challenge);
        this.codes.delete(form.get("code"));
      }
      const tokens = await this.tokens(record);
      if (refresh && this.dropNextRefreshResponse) {
        this.dropNextRefreshResponse = false; response.destroy(); return;
      }
      return json(response, 200, tokens);
    }
    response.writeHead(404); response.end();
  }
  async tokens(record) {
    const claims = { email: "owner@example.test", name: "Multi Workspace Owner", auth_time: record.authTime, amr: ["pwd", "mfa"] };
    const accessToken = await new SignJWT({ ...claims, jti: randomUUID() })
      .setProtectedHeader({ alg: "RS256", kid: "multitenant-test" }).setIssuer(this.origin).setAudience("wasalx-control-api").setSubject("subject-two-workspaces").setIssuedAt().setExpirationTime("10m").sign(this.privateKey);
    const idToken = await new SignJWT({ ...claims, nonce: record.nonce, sid: record.sid })
      .setProtectedHeader({ alg: "RS256", kid: "multitenant-test" }).setIssuer(this.origin).setAudience("wasalx-portal").setSubject("subject-two-workspaces").setIssuedAt().setExpirationTime("10m").sign(this.privateKey);
    const refreshToken = randomUUID(); this.refreshTokens.set(refreshToken, record);
    return { access_token: accessToken, id_token: idToken, refresh_token: refreshToken, expires_in: 600, token_type: "Bearer" };
  }
  logoutToken(sid, overrides = {}) {
    const now = Math.floor(Date.now() / 1_000);
    return new SignJWT({ iss: this.origin, aud: "wasalx-portal", sub: "subject-two-workspaces", sid,
      iat: now, exp: now + 120, jti: randomUUID(), events: { "http://schemas.openid.net/event/backchannel-logout": {} }, ...overrides })
      .setProtectedHeader({ alg: "RS256", kid: "multitenant-test", typ: "logout+jwt" }).sign(this.privateKey);
  }
  pauseNextRefresh() {
    assert.equal(this.refreshBarrier, undefined); assert.equal(this.activeRefreshBarrier, undefined);
    let enter; let release;
    const entered = new Promise(resolve => { enter = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    this.refreshBarrier = { enter, released, release };
    return { entered: Promise.race([entered, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Refresh barrier not entered")), 5_000); timer.unref(); })]), release };
  }
  releaseRefresh() { this.refreshBarrier?.release(); this.activeRefreshBarrier?.release(); this.refreshBarrier = undefined; }
  async close() { for (const socket of this.sockets) socket.destroy(); this.server.close(); await once(this.server, "close"); }
}

function json(response, status, value) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks).toString("utf8"); }
function base64url(value) { return Buffer.from(value).toString("base64url"); }

async function freePort() { const server = createNetServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object"); server.close(); await once(server, "close"); return address.port; }
async function publishedPort(container, port) { if (fixtureNetwork()) return port; return waitFor(async () => { const output = await command("docker", ["port", container, `${port}/tcp`], true); const match = output.trim().match(/^127\.0\.0\.1:(\d+)$/u); return match ? Number(match[1]) : false; }, `Docker loopback port for ${container}:${port}`); }
async function waitFor(operation, label) { const deadline = Date.now() + 90_000; while (Date.now() < deadline) { const result = await operation(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`${label} did not become ready`); }
async function waitHttp(url, label, process) { await waitFor(async () => { if (process.child.exitCode !== null) throw new Error(`${label} exited early\n${process.logs()}`); try { return (await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; } }, label); }
function start(label, executable, args, extraEnv) { const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...extraEnv }, detached: true, stdio: ["ignore", "pipe", "pipe"] }); let output = ""; for (const stream of [child.stdout, child.stderr]) stream.setEncoding("utf8").on("data", (chunk) => { output = `${output}${chunk}`.slice(-40_000); }); return { label, child, logs: () => output }; }
async function stop(process) { if (!process?.child.pid || process.child.exitCode !== null) return; try { globalThis.process.kill(-process.child.pid, "SIGTERM"); } catch { /* Already stopped. */ } await Promise.race([once(process.child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]); if (process.child.exitCode === null) try { globalThis.process.kill(-process.child.pid, "SIGKILL"); } catch { /* Already stopped. */ } }
async function runProcess(executable, args, extraEnv) { const result = await boundedCommand(executable, args, { cwd: root, env: { ...process.env, ...extraEnv }, timeout: 180_000 }); assert.equal(result.code, 0, result.output); }
async function command(executable, args, ignoreFailure = false) { const result = await boundedCommand(executable, args, { cwd: root, timeout: args[0] === "pull" ? 120_000 : 60_000 }); if (!ignoreFailure) assert.equal(result.code, 0, result.output); return result.output; }
async function succeeds(executable, args) { const result = await boundedCommand(executable, args, { cwd: root }); if (result.code !== 0) assert.match(result.output, /no such (object|image)/iu); return result.code === 0; }
async function browserPath() { for (const path of [chromium.executablePath(), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) try { await access(path); return path; } catch { /* Keep looking. */ } throw new Error("Chromium is required"); }
