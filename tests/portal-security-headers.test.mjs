import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";

let origin;
let server;
let serverEnv;
let serverOutput = "";
let serverExit;

before(async () => {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/vinext/dist/cli.js", "start", "-p", String(port)], {
    cwd: new URL("../", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
    env: serverEnv = {
      ...process.env,
      CONTROL_API_URL: "http://127.0.0.1:1",
      NODE_ENV: "production",
      WASALX_ENVIRONMENT: "local-full",
      ALLOW_INSECURE_PLATFORM_OPERATOR_OIDC: "true",
      OIDC_AUTHORIZATION_ENDPOINT: "https://identity.example.test/authorize",
      OIDC_CLIENT_ID: "wasalx-portal",
      OIDC_ISSUER: "https://identity.example.test",
      OIDC_JWKS_URI: "https://identity.example.test/jwks",
      OIDC_REDIRECT_URI: `${origin}/auth/callback`,
      OIDC_TOKEN_ENDPOINT: "https://identity.example.test/token",
      PLATFORM_OPERATOR_OIDC_AUDIENCE: "wasalx-platform-api",
      PLATFORM_OPERATOR_OIDC_AUTHORIZATION_ENDPOINT: "https://platform-identity.example.test/authorize",
      PLATFORM_OPERATOR_OIDC_CLIENT_ID: "wasalx-platform-portal",
      PLATFORM_OPERATOR_OIDC_ISSUER: "https://platform-identity.example.test",
      PLATFORM_OPERATOR_OIDC_JWKS_URI: "https://platform-identity.example.test/jwks",
      PLATFORM_OPERATOR_OIDC_REDIRECT_URI: `${origin}/platform/auth/callback`,
      PLATFORM_OPERATOR_OIDC_TOKEN_ENDPOINT: "https://platform-identity.example.test/token",
      PLATFORM_PORTAL_SESSION_SECRET: "platform-test-session-secret-at-least-32-bytes",
      PORTAL_COOKIE_SECURE: "false",
      PORTAL_DATA_BACKEND: "control-plane",
      PORTAL_PUBLIC_ORIGIN: origin,
      PORTAL_SESSION_SECRET: "tenant-test-session-secret-at-least-32-bytes",
      WRANGLER_LOG_PATH: `/tmp/wasalx-security-headers-${process.pid}.log`,
    },
  });
  server.stdout.on("data", (chunk) => { serverOutput += String(chunk); });
  server.stderr.on("data", (chunk) => { serverOutput += String(chunk); });
  server.once("exit", (code, signal) => { serverExit = { code, signal }; });
  await waitForServer();
});

after(() => { server?.kill("SIGTERM"); });

test("trusted HTTPS proxy preserves tenant and platform login without trusting foreign hosts", async () => {
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const publicOrigin = "https://example.test";
  const proxy = spawn(process.execPath, ["node_modules/vinext/dist/cli.js", "start", "-p", String(port)], {
    cwd: new URL("../", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...serverEnv, VINEXT_TRUST_PROXY: "", VINEXT_TRUSTED_HOSTS: "example.test",
      WASALX_ENVIRONMENT: "production", ALLOW_INSECURE_PLATFORM_OPERATOR_OIDC: "false",
      CONTROL_API_URL: "http://wasalx-api:3001",
      PORTAL_PUBLIC_ORIGIN: publicOrigin, PORTAL_COOKIE_SECURE: "true",
      OIDC_REDIRECT_URI: `${publicOrigin}/auth/callback`,
      PLATFORM_OPERATOR_OIDC_REDIRECT_URI: `${publicOrigin}/platform/auth/callback` },
  });
  let output = "";
  proxy.stdout.on("data", chunk => { output += String(chunk); });
  proxy.stderr.on("data", chunk => { output += String(chunk); });
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      try { if ((await fetch(`${endpoint}/invitations/accept`)).status === 200) break; } catch { /* server startup */ }
      assert.ok(Date.now() < deadline && proxy.exitCode === null, output);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const [path, identity] of [["/auth/login", "https://identity.example.test"], ["/platform/auth/login", "https://platform-identity.example.test"]]) {
      for (const host of ["example.test", "evil.example", "evil.example, example.test"]) {
        const response = await fetch(`${endpoint}${path}`, { redirect: "manual", headers: {
          "x-forwarded-proto": "https", "x-forwarded-host": host,
        } });
        assert.equal(response.status, 307);
        const location = new URL(response.headers.get("location"));
        if (host === "example.test") {
          assert.equal(location.origin, identity);
          assert.equal(location.pathname, "/authorize");
          assert.match(response.headers.get("set-cookie"), /__Host-wasalx.*;.*Secure/iu);
        } else {
          assert.equal(location.href, `${publicOrigin}${path}`);
          assert.equal(response.headers.get("set-cookie"), null);
        }
        await response.body?.cancel();
      }
    }
  } finally { proxy.kill("SIGTERM"); }
});

test("production portal responses enforce the browser security boundary without breaking entry routes", async () => {
  const cases = [
    ["/", 200],
    ["/app", 307, `${origin}/auth/login?return_to=/app`],
    ["/auth/login?return_to=/app", 307, "https://identity.example.test/authorize"],
    ["/invitations/accept", 200],
    ["/platform", 307, `${origin}/platform/auth/login?return_to=/platform`],
    ["/platform/auth/login?return_to=/platform", 307, "https://platform-identity.example.test/authorize"],
  ];

  for (const [path, status, location] of cases) {
    const response = await fetch(`${origin}${path}`, { redirect: "manual" });
    assert.equal(response.status, status, path);
    if (location) {
      const redirect = new URL(response.headers.get("location"), origin);
      assert.equal(location.startsWith(origin) ? redirect.href : `${redirect.origin}${redirect.pathname}`, location, path);
    }
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin", path);
    assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000", path);
    assert.equal(response.headers.get("permissions-policy"), "camera=(), geolocation=(), microphone=()", path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /(?:^|; )frame-ancestors 'none'(?:;|$)/u, path);
    assert.match(csp, path === "/app"
      ? /(?:^|; )script-src 'self' 'unsafe-inline' https:\/\/connect\.facebook\.net(?:;|$)/u
      : /(?:^|; )script-src 'self' 'unsafe-inline'(?:;|$)/u, path);
    assert.match(csp, /(?:^|; )form-action 'self'(?:;|$)/u, path);
  }
});

test("Meta signup proxy rejects unauthenticated reads and mutations without exposing provider details", async () => {
  const attempt = "44000000-0000-4000-8000-000000000001";
  for (const [method, suffix] of [["GET", "capabilities"], ["GET", "attempts"], ["POST", "attempts"],
    ["GET", `attempts/${attempt}`], ...["exchange", "discover", "select", "cancel"].map(action => ["POST", `attempts/${attempt}/${action}`])]) {
    const response = await fetch(`${origin}/api/connections/meta/signup/${suffix}`, {
      method, ...(method === "POST" ? { headers: { "content-type": "application/json", origin }, body: "{}" } : {}),
    });
    assert.equal(response.status, 401, `${method} ${suffix}`);
    assert.match(response.headers.get("cache-control"), /no-store/u);
    assert.deepEqual(Object.keys(await response.json()), ["code"]);
  }
});

test("Node portal lazily loads every closed ingress route without Worker bindings", async () => {
  for (const [method, path] of [
    ["GET", "/webhooks/meta"],
    ["POST", "/webhooks/meta"],
    ["POST", "/webhooks/waha/opaque-test-token"],
    ["POST", "/internal/v1/zammad/outbound"],
    ["POST", "/internal/v1/zammad/article-status"],
    ["GET", "/internal/v1/zammad/health"],
    ["POST", "/internal/v1/zammad/retry"],
  ]) {
    const response = await fetch(`${origin}${path}`, {
      method,
      ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
    });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.match((await response.json()).error, /ingress is not exposed by the portal/u);
  }
  assert.equal((await fetch(`${origin}/invitations/accept`)).status, 200);
});

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (serverExit) throw new Error(`Production server exited before readiness (${JSON.stringify(serverExit)}). ${serverOutput}`);
    try {
      const response = await fetch(`${origin}/invitations/accept`);
      if (response.status === 200) return;
    } catch (error) {
      if (error instanceof Error) serverOutput += `\n${error.message}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Production server did not start. ${serverOutput}`);
}

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
