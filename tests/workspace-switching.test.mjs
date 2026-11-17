import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { discoverOidcMemberships, oidcConfiguration } from "../lib/oidc.ts";

test("workspace discovery returns only authenticated membership metadata", async () => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  try {
    Object.assign(process.env, {
      NODE_ENV: "production", WASALX_ENVIRONMENT: "production",
      OIDC_ISSUER: "https://identity.wasalx.test",
      OIDC_CLIENT_ID: "wasalx-portal",
      OIDC_REDIRECT_URI: "https://portal.wasalx.test/auth/callback",
      CONTROL_API_URL: "http://wasalx-api:3001",
      PORTAL_PUBLIC_ORIGIN: "https://portal.wasalx.test",
    });
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "http://wasalx-api:3001/v1/session");
      assert.equal(init?.headers?.authorization, "Bearer access-token");
      assert.equal(init?.redirect, "error");
      return Response.json({
        subject: "subject-1",
        user: { id: "user-1", email: "owner@example.test", display_name: "Owner" },
        tenants: [
          { id: "10000000-0000-4000-8000-000000000001", name: "North", slug: "north", state: "ACTIVE", role: "tenant_owner" },
          { id: "20000000-0000-4000-8000-000000000002", name: "South", slug: "south", state: "ACTIVE", role: "auditor" },
        ],
      });
    };
    const result = await discoverOidcMemberships("access-token");
    assert.equal(result.tenants.length, 2);
    assert.equal(result.subject, "subject-1");
    for (const value of ["http://external.example", "http://wasalx-api.evil:3001", "http://wasalx-api:3002", "https://fixture:placeholder@api.example.test/path", "http://wasalx-api:3001/path", "http://wasalx-api:3001?query=1", "http://wasalx-api:3001#fragment"]) {
      process.env.CONTROL_API_URL = value;
      assert.throws(() => oidcConfiguration(), /CONTROL_API_URL/);
    }
    process.env.CONTROL_API_URL = "http://wasalx-api:3001";
    for (const key of ["OIDC_ISSUER", "OIDC_AUTHORIZATION_ENDPOINT", "OIDC_END_SESSION_ENDPOINT", "OIDC_TOKEN_ENDPOINT", "OIDC_JWKS_URI"]) {
      const previousValue = process.env[key];
      process.env[key] = "http://wasalx-api:3001";
      assert.throws(() => oidcConfiguration(), /OIDC URLs must use HTTPS/);
      if (previousValue === undefined) delete process.env[key]; else process.env[key] = previousValue;
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("workspace BFF is no-store, subject-bound, minimal, and switches through session rotation", async () => {
  const [route, app, login, callback] = await Promise.all([
    readFile(new URL("../app/api/workspaces/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/WasalXApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/login/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/callback/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /discovery\.subject !== session\.subject/);
  assert.match(route, /private, no-store/);
  assert.match(route, /data: discovery\.tenants\.map\(\(\{ id, name, slug, role \}\)/);
  assert.match(app, /\/auth\/login\?tenant_id=/);
  assert.match(app, /return_to=/);
  assert.match(login, /tenantId:current\?\.tenantId\?\?url\.searchParams\.get\("tenant_id"\)/);
  assert.match(callback, /deleteStoredPortalSession\(previousSessionId\)/);
  assert.match(app, /installShellFetch\(window, \{\s*tenantId: String\(initialData\.tenant\.id\),\s*role,/u);
  assert.match(app, /workspaceLoadState==="failed"/u);
  assert.match(app, /<details className="workspace-select"/u);
  assert.match(app, /aria-current=\{workspace\.current\?"true":undefined\}/u);
  assert.match(app, /aria-label=\{workspace\.name\}/u);
  assert.doesNotMatch(app, /<select[\s\S]*id="workspace-select"/u);
  assert.doesNotMatch(app, /setWorkspaces\(\[\]\)/u);
});
