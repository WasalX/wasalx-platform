import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { fixtureNetwork, fixtureNetworkArgs } from "./ci-fixture-network.mjs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import Redis from "ioredis";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Client } from "pg";

const root = fileURLToPath(new URL("../..", import.meta.url));
const postgresImage = "postgres:17.12-alpine3.23@sha256:57a828ad76b719bbed499fc30f71754bbe37d78c8c4c990a1a2096380b8d7ca5";
const redisImage = "redis:8.12.0-alpine@sha256:5af80107c1eeecb484a2269b80a26d12bfa6521787da4663bd9f19f60a163483";
export const tenantId = "10000000-0000-4000-8000-000000000001";
export const tenantName = "Invitation Proof Workspace";
export const invitationToken = Buffer.alloc(32, 7).toString("base64url");
export const expiredInvitationToken = Buffer.alloc(32, 8).toString("base64url");

export async function withSignedPlatformFixture(run) {
  const suffix = `${process.pid}-${Date.now()}`;
  const pgName = `wasalx-platform-pg-${suffix}`;
  const redisName = `wasalx-platform-redis-${suffix}`;
  const resources = { browser: undefined, control: undefined, portal: undefined, identity: undefined, admin: undefined, redis: undefined };
  const imagesPresent = new Map();
  try {
    for (const image of [postgresImage, redisImage]) {
      const present = await succeeds("docker", ["image", "inspect", image]);
      imagesPresent.set(image, present);
      if (!present) { assert.equal(fixtureNetwork(), null, "preload pinned fixture images before offline CI"); await command("docker", ["pull", image]); }
    }
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
    const platformUrl = `postgresql://wasalx_platform_operations_runtime:platform-test@127.0.0.1:${postgresPort}/wasalx`;
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
    const controlPort = process.env.WASALX_E2E_CONTROL_PORT ?? await freePort();
    const portalPort = process.env.WASALX_E2E_PORTAL_PORT ?? await freePort();
    const controlOrigin = `http://127.0.0.1:${controlPort}`;
    const portalOrigin = `http://127.0.0.1:${portalPort}`;
    resources.control = start("control-api", process.execPath, ["services/control-api/dist/cli.js", "serve"], {
      NODE_ENV: "development", PORT: String(controlPort), DATABASE_URL: appUrl, DATABASE_POOL_SIZE: "4",
      PLATFORM_OPERATIONS_DATABASE_URL: platformUrl, PLATFORM_OPERATIONS_DATABASE_POOL_SIZE: "2",
      WAHA_OPERATOR_DATABASE_URL: appUrl, SECRET_CLEANUP_DATABASE_URL: appUrl, META_GRAPH_VERSION: "v24.0",
      REDIS_URL: redisUrl, WORKER_JOB_JWT_SECRET: "test-worker-secret-value-at-least-32-bytes",
      SECRET_SIDECAR_URL: resources.identity.origin, SECRET_SIDECAR_TOKEN: "test-read-token", SECRET_SIDECAR_WRITE_TOKEN: "test-write-token",
      OIDC_ISSUER: resources.identity.origin, OIDC_AUDIENCE: "wasalx-control-api", OIDC_JWKS_URI: `${resources.identity.origin}/jwks`,
      PLATFORM_OPERATOR_OIDC_ISSUER: resources.identity.origin, PLATFORM_OPERATOR_OIDC_AUDIENCE: "wasalx-platform-api",
      PLATFORM_OPERATOR_OIDC_JWKS_URI: `${resources.identity.origin}/jwks`, ALLOW_INSECURE_PLATFORM_OPERATOR_OIDC: "true",
      CLIENT_ROUTING_EXTERNAL_CONNECTORS_ENABLED: "false", OTEL_SDK_DISABLED: "true",
    });
    await waitHttp(`${controlOrigin}/health/ready`, "control API", resources.control);
    resources.portal = start("portal", process.execPath, ["node_modules/vinext/dist/cli.js", "start", "--hostname", "127.0.0.1", "-p", String(portalPort)], {
      NODE_ENV: "production", WASALX_ENVIRONMENT: "local-full", PORTAL_DATA_BACKEND: "control-plane", CONTROL_API_URL: controlOrigin,
      PORTAL_SESSION_REDIS_URL: redisUrl, PORTAL_SESSION_SECRET: "test-portal-session-secret-at-least-32-bytes",
      PLATFORM_PORTAL_SESSION_REDIS_URL: redisUrl, PLATFORM_PORTAL_SESSION_SECRET: "test-platform-session-secret-at-least-32-bytes",
      PORTAL_COOKIE_SECURE: "false", PORTAL_PUBLIC_ORIGIN: portalOrigin,
      OIDC_ISSUER: resources.identity.origin, OIDC_CLIENT_ID: "wasalx-portal",
      OIDC_AUTHORIZATION_ENDPOINT: `${resources.identity.origin}/authorize`, OIDC_TOKEN_ENDPOINT: `${resources.identity.origin}/token`,
      OIDC_END_SESSION_ENDPOINT: `${resources.identity.origin}/protocol/openid-connect/logout`,
      OIDC_JWKS_URI: `${resources.identity.origin}/jwks`, OIDC_REDIRECT_URI: `${portalOrigin}/auth/callback`,
      OIDC_PRIVILEGED_ACR_VALUES: "urn:wasalx:loa:2",
      OIDC_INVITATION_REDIRECT_URI: `${portalOrigin}/invitations/callback`,
      PLATFORM_OPERATOR_OIDC_ISSUER: resources.identity.origin, PLATFORM_OPERATOR_OIDC_CLIENT_ID: "wasalx-platform-portal",
      PLATFORM_OPERATOR_OIDC_AUDIENCE: "wasalx-platform-api", PLATFORM_OPERATOR_OIDC_AUTHORIZATION_ENDPOINT: `${resources.identity.origin}/authorize`,
      PLATFORM_OPERATOR_OIDC_TOKEN_ENDPOINT: `${resources.identity.origin}/token`, PLATFORM_OPERATOR_OIDC_JWKS_URI: `${resources.identity.origin}/jwks`,
      PLATFORM_OPERATOR_OIDC_END_SESSION_ENDPOINT: `${resources.identity.origin}/protocol/openid-connect/logout`,
      PLATFORM_OPERATOR_OIDC_REDIRECT_URI: `${portalOrigin}/platform/auth/callback`, ALLOW_INSECURE_PLATFORM_OPERATOR_OIDC: "true",
      OTEL_SDK_DISABLED: "true", WRANGLER_LOG_PATH: `/tmp/wasalx-platform-${suffix}.log`,
      MINIFLARE_REGISTRY_PATH: `/tmp/wasalx-platform-${suffix}-registry`,
    });
    await waitHttp(`${portalOrigin}/api/health`, "portal", resources.portal);
    resources.redis = new Redis(redisUrl);
    const browserExecutable = await browserPath();
    resources.browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
    await run({ resources, portalOrigin, browserExecutable, signIn: (context, page) => signInPlatform(resources, portalOrigin, context, page) });

  } finally {
    await resources.browser?.close().catch(() => undefined);
    await resources.redis?.quit().catch(() => undefined);
    await stop(resources.portal);
    await stop(resources.control);
    await resources.admin?.end().catch(() => undefined);
    await resources.identity?.close().catch(() => undefined);
    await command("docker", ["rm", "-f", redisName], true);
    await command("docker", ["rm", "-f", pgName], true);
    for (const image of [redisImage, postgresImage]) {
      if (imagesPresent.get(image) === false) await command("docker", ["image", "rm", image], true);
    }
    assert.equal(await succeeds("docker", ["container", "inspect", pgName]), false, "PostgreSQL test container leaked");
    assert.equal(await succeeds("docker", ["container", "inspect", redisName]), false, "Redis test container leaked");
    for (const image of [redisImage, postgresImage]) {
      if (imagesPresent.get(image) === false) assert.equal(await succeeds("docker", ["image", "inspect", image]), false, `pulled image leaked: ${image}`);
    }
  }
}

async function signInPlatform(resources, portalOrigin, context, page) {
  resources.identity.profile = "platform";
  await page.goto(`${portalOrigin}/platform`);
  await page.getByRole("heading", { name: "Operational control, without tenant data exposure." }).waitFor();
  await page.getByText(tenantName, { exact: true }).waitFor();
  const firstPlatform = await storedSession(context, resources.redis, portalOrigin, "wasalx_platform_session", "wasalx:platform-portal:session:");
  assert.equal(firstPlatform.value.subject, "platform-operator-subject");
  const platformRead = await context.request.get(`${portalOrigin}/api/platform-console/operations/tenants?limit=50`);
  assert.equal(platformRead.status(), 200);
  assert.equal(platformRead.headers()["cache-control"], "no-store");
  assert.equal((await platformRead.json()).items[0].tenant_id, tenantId);
  return firstPlatform;
}

export async function storedSession(context, redis, origin, cookieName, prefix) {
  const cookie = (await context.cookies(origin)).find(({ name }) => name === cookieName);
  assert.ok(cookie?.value);
  const raw = await redis.get(`${prefix}${cookie.value}`);
  assert.ok(raw);
  return { id: cookie.value, value: JSON.parse(raw) };
}

async function seed(client) {
  await client.query("BEGIN");
  try {
    await client.query("INSERT INTO tenants (id,name,slug,state) VALUES ($1,$2,'invitation-proof','ACTIVE')", [tenantId, tenantName]);
    await client.query("INSERT INTO users (id,oidc_subject,email,display_name) VALUES ('30000000-0000-4000-8000-000000000003','inviter-subject','owner@invitation.test','Invitation Owner')");
    await client.query("INSERT INTO tenant_memberships (tenant_id,user_id,role) VALUES ($1,'30000000-0000-4000-8000-000000000003','tenant_owner')", [tenantId]);
    await client.query(`
      INSERT INTO zammad_instances
        (id,tenant_id,base_url,version,state,database_reference,search_namespace,storage_prefix,service_secret_reference,privacy_secret_reference,last_healthy_at)
      VALUES ('31000000-0000-4000-8000-000000000001',$1::uuid,'https://zammad.invitation.invalid','7.0.1','WORKING','db://invitation','invitation','invitation/','secret://tenants/'||$1::uuid::text||'/zammad/service','secret://tenants/'||$1::uuid::text||'/zammad/privacy',now())
    `, [tenantId]);
    await client.query(`
      INSERT INTO tenant_invitations
        (id,tenant_id,email,display_name,role,token_hash,expires_at,invited_by,create_idempotency_key,create_request_sha256)
      VALUES
        ('32000000-0000-4000-8000-000000000002',$1,'invitee@invitation.test','Valid Invitee','agent',$2,now()+interval '1 day','30000000-0000-4000-8000-000000000003','platform-invitation-e2e',$3),
        ('32000000-0000-4000-8000-000000000004',$1,'expired@invitation.test','Expired Invitee','agent',$4,now()-interval '1 hour','30000000-0000-4000-8000-000000000003','platform-invitation-expired',$5)
    `, [tenantId, sha256(invitationToken), "e".repeat(64), sha256(expiredInvitationToken), "f".repeat(64)]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
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
  sessions = new Set();
  authorizations = [];
  logouts = [];
  sockets = new Set();
  profile = "platform";
  constructor(server, origin, privateKey, jwk) { this.server = server; this.origin = origin; this.privateKey = privateKey; this.jwk = jwk; }
  static async start() {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "platform-invitation-test", use: "sig" };
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
      if (url.searchParams.get("client_id") === "wasalx-platform-portal") {
        assert.equal(url.searchParams.get("prompt"), "login");
        assert.equal(url.searchParams.get("max_age"), "0");
      }
      const existing=/(?:^|;\s*)wasalx_identity_session=([^;]+)/u.exec(request.headers.cookie??"")?.[1];
      const hadSession=typeof existing==="string"&&this.sessions.has(existing);
      const sessionId=hadSession?existing:randomUUID();
      if(!hadSession)this.sessions.add(sessionId);
      this.authorizations.push({hadSession,sessionId});
      const code = randomUUID();
      this.codes.set(code, {
        sid: sessionId, nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge"),
        clientId: url.searchParams.get("client_id"), redirectUri: url.searchParams.get("redirect_uri"), profile: this.profile,
      });
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
      const record = this.codes.get(form.get("code"));
      assert.ok(record); assert.equal(form.get("client_id"), record.clientId); assert.equal(form.get("redirect_uri"), record.redirectUri);
      assert.equal(base64url(createHash("sha256").update(form.get("code_verifier")).digest()), record.challenge);
      this.codes.delete(form.get("code"));
      const now = Math.floor(Date.now() / 1_000);
      const identity = identityFor(record.profile);
      const authenticationMethods = record.clientId === "wasalx-platform-portal"
        ? ["pwd", "otp"]
        : ["pwd", "mfa"];
      const accessClaims = {
        email: identity.email, email_verified: true, name: identity.name, auth_time: now, amr: authenticationMethods,
        ...(record.clientId === "wasalx-platform-portal" ? { platform_role: "platform_operator" } : {}),
      };
      const accessToken = await new SignJWT(accessClaims)
        .setProtectedHeader({ alg: "RS256", kid: "platform-invitation-test" }).setIssuer(this.origin)
        .setAudience(record.clientId === "wasalx-platform-portal" ? "wasalx-platform-api" : "wasalx-control-api")
        .setSubject(identity.subject).setIssuedAt().setExpirationTime("10m").sign(this.privateKey);
      const idToken = await new SignJWT({ sid: record.sid, nonce: record.nonce, email: identity.email, email_verified: true, name: identity.name, auth_time: now, amr: authenticationMethods })
        .setProtectedHeader({ alg: "RS256", kid: "platform-invitation-test" }).setIssuer(this.origin).setAudience(record.clientId)
        .setSubject(identity.subject).setIssuedAt().setExpirationTime("10m").sign(this.privateKey);
      return json(response, 200, { access_token: accessToken, id_token: idToken, refresh_token: `refresh-${record.profile}`, expires_in: 600, token_type: "Bearer" });
    }
    response.writeHead(404); response.end();
  }
  async close() { for (const socket of this.sockets) socket.destroy(); this.server.close(); await once(this.server, "close"); }
}

function identityFor(profile) {
  if (profile === "platform") return { subject: "platform-operator-subject", email: "operator@platform.test", name: "Platform Operator" };
  if (profile === "valid-invitee") return { subject: "valid-invitee-subject", email: "invitee@invitation.test", name: "Valid Invitee" };
  if (profile === "expired-invitee") return { subject: "expired-invitee-subject", email: "expired@invitation.test", name: "Expired Invitee" };
  return { subject: "wrong-invitee-subject", email: "wrong@invitation.test", name: "Wrong Invitee" };
}

export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function json(response, status, value) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks).toString("utf8"); }
function base64url(value) { return Buffer.from(value).toString("base64url"); }
async function freePort() { const server = createNetServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object"); server.close(); await once(server, "close"); return address.port; }
async function publishedPort(container, port) { if (fixtureNetwork()) return port; return waitFor(async () => { const output = await command("docker", ["port", container, `${port}/tcp`], true); const match = output.trim().match(/^127\.0\.0\.1:(\d+)$/u); return match ? Number(match[1]) : false; }, `Docker loopback port for ${container}:${port}`); }
export async function waitFor(operation, label) { const deadline = Date.now() + 90_000; while (Date.now() < deadline) { const result = await operation(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`${label} did not become ready`); }
async function waitHttp(url, label, process) { await waitFor(async () => { if (process.child.exitCode !== null) throw new Error(`${label} exited early\n${process.logs()}`); try { return (await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; } }, label); }
function start(label, executable, args, extraEnv) { const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...extraEnv }, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let output = ""; for (const stream of [child.stdout, child.stderr]) stream.setEncoding("utf8").on("data", (chunk) => { output = `${output}${chunk}`.slice(-40_000); }); return { label, child, logs: () => output }; }
async function stop(process) {
  if (!process?.child.pid || process.child.exitCode !== null) return;
  if (globalThis.process.platform === "win32") {
    const exited = once(process.child, "exit");
    await command("taskkill.exe", ["/PID", String(process.child.pid), "/T", "/F"], true);
    if (process.child.exitCode === null) await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    assert.notEqual(process.child.exitCode, null, `${process.label} child tree did not stop`);
    return;
  }
  try { globalThis.process.kill(-process.child.pid, "SIGTERM"); } catch { return; }
  await Promise.race([once(process.child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (process.child.exitCode === null) {
    try { globalThis.process.kill(-process.child.pid, "SIGKILL"); } catch { return; }
    await Promise.race([once(process.child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
}
async function runProcess(executable, args, extraEnv) { const child = start(executable, executable, args, extraEnv); const [code] = await once(child.child, "exit"); assert.equal(code, 0, child.logs()); }
async function command(executable, args, ignoreFailure = false) { const child = start(executable, executable, args, {}); const [code] = await once(child.child, "exit"); if (!ignoreFailure) assert.equal(code, 0, child.logs()); return child.logs(); }
async function succeeds(executable, args) { const child = start(executable, executable, args, {}); const [code] = await once(child.child, "exit"); return code === 0; }
async function browserPath() { for (const path of [chromium.executablePath(), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) try { await access(path); return path; } catch { /* Keep looking. */ } throw new Error("Chromium is required"); }
