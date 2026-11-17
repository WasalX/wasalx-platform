import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const originalBackend = process.env.PORTAL_DATA_BACKEND;
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("D1 preview preserves its read-only operator boundary", async () => {
  const [portal, messages] = await Promise.all([
    read("app/WasalXApp.tsx"),
    read("lib/i18n/messages/en/tenant.ts"),
  ]);
  assert.match(portal, /t\("tenant\.environment\.previewOffline"\)/u);
  assert.match(portal, /t\("tenant\.preview\.title"\)/u);
  assert.match(portal, /t\("tenant\.preview\.body"\)/u);
  assert.match(messages, /"tenant\.environment\.previewOffline": "Sample workspace · no live operations"/u);
  assert.match(messages, /"tenant\.preview\.title": "Read-only sample workspace"/u);
  assert.match(messages, /administrative changes are unavailable/u);
  assert.match(portal, /const isPrivateDemo = runtime === "D1"/u);
  assert.match(portal, /const canConfigure = !isPrivateDemo/u);
});

test("D1 permits reads but rejects every portal mutation at the server boundary", async () => {
  process.env.PORTAL_DATA_BACKEND = "d1";
  const { authenticatePortalRequest, authErrorResponse } = await import(
    `../lib/request-auth.ts?sites-demo=${Date.now()}`
  );
  const identity = {
    "oai-authenticated-user-id": "site-user-1",
    "oai-authenticated-user-email": "owner@example.com",
  };

  const principal = await authenticatePortalRequest(
    new Request("https://demo.wasalx.example/api/connections", {
      headers: identity,
    }),
    "connection:read",
  );
  assert.equal(principal.tenantId, "tenant_northstar");

  let rejection;
  try {
    await authenticatePortalRequest(
        new Request("https://demo.wasalx.example/api/connections", {
          method: "POST",
          headers: { ...identity, "content-type": "application/json" },
          body: "{}",
        }),
        "connection:write",
      );
  } catch (error) {
    rejection = error;
  }
  assert.equal(rejection?.status, 409);
  assert.equal(rejection?.code, "SITES_PRIVATE_DEMO_READ_ONLY");
  assert.match(rejection?.message ?? "", /preview is read-only/u);
  const response = authErrorResponse(rejection);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: rejection.message,
    code: "SITES_PRIVATE_DEMO_READ_ONLY",
  });

  await assert.rejects(
    () =>
      authenticatePortalRequest(
        new Request("http://127.0.0.1/api/connections", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        "connection:write",
      ),
    (error) => error?.status === 409,
  );
});

test("fixture mutations remain available for local human-flow testing", async () => {
  process.env.PORTAL_DATA_BACKEND = "fixture";
  const { authenticatePortalRequest } = await import(
    `../lib/request-auth.ts?fixture-preview=${Date.now()}`
  );
  const principal = await authenticatePortalRequest(
    new Request("http://127.0.0.1/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    "connection:write",
  );
  assert.equal(principal.userId, "local-preview");
});

test("provider and Zammad ingress exist only for the isolated fixture", async () => {
  const paths = [
    "app/webhooks/meta/route.ts",
    "app/webhooks/waha/[token]/route.ts",
    "app/internal/v1/zammad/outbound/route.ts",
    "app/internal/v1/zammad/article-status/route.ts",
    "app/internal/v1/zammad/health/route.ts",
    "app/internal/v1/zammad/retry/route.ts",
  ];
  for (const path of paths) {
    const source = await read(path);
    assert.match(source, /!isFixtureBackend\(\)/u, path);
    assert.match(source, /status:\s*404/u, path);
  }

  const data = await read("lib/data.ts");
  assert.match(data, /throw sitesPrivateDemoError\("Live connection creation"\)/u);
  assert.match(data, /throw sitesPrivateDemoError\("Connection recovery"\)/u);
});

test.after(() => {
  if (originalBackend === undefined) delete process.env.PORTAL_DATA_BACKEND;
  else process.env.PORTAL_DATA_BACKEND = originalBackend;
});
