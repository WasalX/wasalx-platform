import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  authorizationUrl,
  assertPrivilegedOidcClaims,
  assertRequiredMfaOidcClaims,
  completeOidcLogin,
  createOidcTransaction,
  OidcLoginError,
  OidcLogoutError,
  verifyOidcLogoutToken,
} from "../lib/oidc.ts";
import {
  portalPublicOrigin,
  sessionCookieName,
  transactionCookieName,
} from "../lib/portal-session.ts";
import { readBoundedJson } from "../lib/bounded-json.ts";

type EnvironmentSnapshot = Record<string, string | undefined>;

const managedEnvironment = [
  "CONTROL_API_URL",
  "OIDC_AUTHORIZATION_ENDPOINT",
  "OIDC_CLIENT_ID",
  "OIDC_ISSUER",
  "OIDC_JWKS_URI",
  "OIDC_REDIRECT_URI",
  "OIDC_PRIVILEGED_ACR_VALUES",
  "OIDC_PRIVILEGED_MFA_AMR_VALUES",
  "OIDC_TOKEN_ENDPOINT",
  "PORTAL_COOKIE_SECURE",
  "PORTAL_DATA_BACKEND",
  "PORTAL_PUBLIC_ORIGIN",
  "PORTAL_SESSION_REDIS_URL",
] as const;

test("portal origin configuration is exact and cookie names use the secure host prefix", () => {
  const snapshot = snapshotEnvironment(managedEnvironment);
  try {
    process.env.PORTAL_PUBLIC_ORIGIN = "https://portal.wasalx.example/";
    assert.equal(portalPublicOrigin(), "https://portal.wasalx.example");

    const state="A".repeat(43);
    process.env.PORTAL_COOKIE_SECURE = "true";
    assert.equal(sessionCookieName(), "__Host-wasalx_session");
    assert.equal(transactionCookieName(state), `__Host-wasalx_oidc_${state}`);

    process.env.PORTAL_COOKIE_SECURE = "false";
    assert.equal(sessionCookieName(), "wasalx_session");
    assert.equal(transactionCookieName(state), `wasalx_oidc_${state}`);

    for (const invalid of [
      "ftp://portal.wasalx.example",
      "https://portal.wasalx.example/admin",
      "https://portal.wasalx.example/?tenant=other",
      "https://portal.wasalx.example/#fragment",
    ]) {
      process.env.PORTAL_PUBLIC_ORIGIN = invalid;
      assert.throws(() => portalPublicOrigin(), /HTTP\(S\) origin without a path/);
    }
  } finally {
    restoreEnvironment(snapshot);
  }
});

test("identity JSON responses are content-typed and size bounded", async () => {
  await assert.rejects(() => readBoundedJson(new Response("{}", { headers: { "content-type": "text/plain" } }), 32));
  await assert.rejects(() => readBoundedJson(new Response("x".repeat(33), { headers: { "content-type": "application/json" } }), 32));
  assert.deepEqual(await readBoundedJson(new Response('{"ok":true}', { headers: { "content-type": "application/json" } }), 32), { ok: true });
});

test("authenticated portal mutations distinguish malformed JSON from an omitted body", async (t) => {
  const origin = "https://portal.invalid";
  const id = "10000000-0000-4000-8000-000000000001";
  const key = "synthetic-mutation";
  const actor = "operator@example.test";
  const session = { userId: "synthetic-user", tenantId: id, role: "tenant_owner", displayName: actor, csrfToken: "synthetic-csrf" };
  const dataModule = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
  const sessionStore = dataModule(`export async function loadStoredPortalSession() { return ${JSON.stringify(session)}; }`);
  const effects = dataModule(`
    export const calls = [];
    export async function startNotionRoutingOAuth(...args) {
      calls.push(["notion", ...args]);
      return { integrationId: ${JSON.stringify(id)}, authorizationUrl: "https://authorization.invalid/" };
    }
    export async function retryDelivery(...args) { calls.push(["delivery", ...args]); }
    export async function getPrivacyRequest() { return { request_type: "EXPORT" }; }
    export async function retryPrivacyRequest(...args) {
      calls.push(["privacy", ...args]);
      return { state: "QUEUED" };
    }
  `);
  const routeFiles = [
    "/api/client-routing/integrations/notion/start/route.ts",
    "/api/deliveries/[id]/retry/route.ts",
    "/api/privacy/requests/[id]/retry/route.ts",
  ];
  // Use the real handlers and authentication. Replace session storage and mutation effects.
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    const parent = decodeURIComponent(context.parentURL ?? "");
    if (parent.endsWith("/lib/portal-session.ts") && specifier === "./portal-session-store.ts") {
      return { url: sessionStore, shortCircuit: true };
    }
    if (routeFiles.some(file => parent.endsWith(file))) {
      if (specifier === "next/server") return nextResolve("vinext/shims/server", context);
      if (/\/lib\/(data|control-plane-data|fixture-data)(\.ts)?$/u.test(specifier)) {
        return { url: effects, shortCircuit: true };
      }
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
        return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href, context);
      }
    }
    return nextResolve(specifier, context);
  } });
  const previous = snapshotEnvironment([...managedEnvironment, "PORTAL_FIXTURE_ROLE"]);
  t.mock.method(globalThis, "fetch", async () => assert.fail("Portal mutation tests must keep every request in-process"));
  try {
    process.env.PORTAL_DATA_BACKEND = "control-plane";
    process.env.PORTAL_COOKIE_SECURE = "false";
    process.env.PORTAL_PUBLIC_ORIGIN = origin;
    delete process.env.PORTAL_FIXTURE_ROLE;
    const { calls } = await import(effects) as { calls: unknown[][] };
    const { POST: notion } = await import("../app/api/client-routing/integrations/notion/start/route.ts");
    const { POST: delivery } = await import("../app/api/deliveries/[id]/retry/route.ts");
    const { POST: privacy } = await import("../app/api/privacy/requests/[id]/retry/route.ts");
    const cases = [
      { name: "Notion OAuth start", post: notion, field: "integrationId", valid: id, invalid: 42, status: 200,
        call: (value?: unknown) => ["notion", value] },
      { name: "delivery retry", post: delivery, field: "confirmOutcomeUnknown", valid: true, invalid: "yes", status: 200,
        call: (value: unknown = false) => ["delivery", id, actor, value, key] },
      { name: "managed privacy retry", post: privacy, field: "confirmation", valid: "DELETE", invalid: false, status: 202,
        call: (value?: unknown) => ["privacy", id, value, key] },
      { name: "fixture privacy retry", post: privacy, field: "confirmation", valid: "DELETE", invalid: false, status: 202,
        call: (value?: unknown) => ["privacy", id, value, key, actor], fixture: true },
    ];
    for (const contract of cases) {
      await t.test(contract.name, async (contractTest) => {
        process.env.PORTAL_DATA_BACKEND = contract.fixture ? "fixture" : "control-plane";
        const variants = [
          { label: "valid body", raw: JSON.stringify({ [contract.field]: contract.valid }), expected: [contract.call(contract.valid)], status: contract.status },
          { label: "empty object", raw: "{}", expected: [contract.call()], status: contract.status },
          { label: "omitted body", raw: undefined, expected: [contract.call()], status: contract.status },
          { label: "malformed JSON", raw: JSON.stringify({ [contract.field]: contract.valid }).slice(0, -1), expected: [], status: 400 },
          { label: "JSON array", raw: "[]", expected: [], status: 400 },
          { label: "JSON null", raw: "null", expected: [], status: 400 },
          { label: "invalid field type", raw: JSON.stringify({ [contract.field]: contract.invalid }), expected: [], status: 400 },
        ];
        for (const { label, raw, expected, status } of variants) {
          await contractTest.test(label, async () => {
            calls.length = 0;
            const response = await contract.post(new Request(origin, {
              method: "POST",
              headers: {
                origin, cookie: "wasalx_session=synthetic-cookie", "content-type": "application/json",
                "x-wasalx-csrf": session.csrfToken, "idempotency-key": key,
                "oai-authenticated-user-id": session.userId, "oai-authenticated-user-email": actor,
              },
              body: raw,
            }), { params: Promise.resolve({ id }) });
            assert.deepEqual({ status: response.status, calls }, { status, calls: expected });
          });
        }
      });
    }
  } finally {
    hooks.deregister();
    restoreEnvironment(previous);
  }
});

test("identity JSON admission cancels rejected headers and times out stalled bodies even if cancellation stalls", async () => {
  let cancelled = false;
  const wrongType = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/plain" } });
  await assert.rejects(() => readBoundedJson(wrongType), /Expected a JSON response/);
  assert.equal(cancelled, true);

  let deadlineCancelled = false;
  const stalled = new Response(new ReadableStream({ cancel() { deadlineCancelled = true; return new Promise<void>(() => {}); } }), { headers: { "content-type": "application/json" } });
  await assert.rejects(() => readBoundedJson(stalled, 32, 25), /timed out/);
  assert.equal(deadlineCancelled, true);
  assert.equal(stalled.body!.locked, false);
});

test("OIDC authorization uses PKCE and accepts only an explicitly configured redirect", async () => {
  const snapshot = snapshotEnvironment(managedEnvironment);
  try {
    configureOidcEnvironment();
    const { transaction, challenge } = await createOidcTransaction({
      returnTo: "/groups?state=active",
      tenantId: "10000000-0000-4000-8000-000000000001",
    });
    const url = authorizationUrl(transaction, challenge);

    assert.equal(url.origin, "https://identity.wasalx.test");
    assert.equal(url.pathname, "/authorize");
    assert.equal(url.searchParams.get("redirect_uri"), "https://portal.wasalx.test/auth/callback");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("code_challenge"), challenge);
    assert.equal(url.searchParams.get("state"), transaction.state);
    assert.equal(url.searchParams.get("nonce"), transaction.nonce);
    assert.doesNotMatch(url.toString(), new RegExp(transaction.verifier));
  } finally {
    restoreEnvironment(snapshot);
  }
});

test("privileged OIDC step-up forces a fresh login and exact configured assurance", async () => {
  const snapshot = snapshotEnvironment(managedEnvironment);
  try {
    configureOidcEnvironment();
    process.env.OIDC_PRIVILEGED_ACR_VALUES = "urn:wasalx:loa:2";
    process.env.OIDC_PRIVILEGED_MFA_AMR_VALUES = "mfa";
    const { transaction, challenge } = await createOidcTransaction({
      returnTo: "/?view=settings",
      stepUp: "privileged",
    });
    const url = authorizationUrl(transaction, challenge);
    assert.equal(url.searchParams.get("prompt"), "login");
    assert.equal(url.searchParams.get("max_age"), "0");
    assert.equal(url.searchParams.get("acr_values"), "urn:wasalx:loa:2");

    const now = Math.floor(Date.now() / 1_000);
    assert.doesNotThrow(() =>
      assertPrivilegedOidcClaims({
        auth_time: now - 5,
        amr: ["pwd", "mfa"],
        acr: "urn:wasalx:loa:2",
      }),
    );
    assert.throws(
      () => assertPrivilegedOidcClaims({ auth_time: now - 120, amr: ["mfa"] }),
      /fresh authentication/i,
    );
    assert.throws(
      () => assertPrivilegedOidcClaims({ auth_time: now, amr: ["pwd"], acr: "urn:loa:1" }),
      /MFA evidence/i,
    );
  } finally {
    restoreEnvironment(snapshot);
  }
});

test("required MFA step-up reuses the password session while requiring MFA evidence", async () => {
  const snapshot = snapshotEnvironment(managedEnvironment);
  try {
    configureOidcEnvironment();
    process.env.OIDC_PRIVILEGED_ACR_VALUES = "urn:wasalx:loa:2";
    const { transaction, challenge } = await createOidcTransaction({ stepUp: "required_mfa" });
    const url = authorizationUrl(transaction, challenge);
    assert.equal(url.searchParams.get("acr_values"), "urn:wasalx:loa:2");
    assert.equal(url.searchParams.has("prompt"), false);
    assert.equal(url.searchParams.has("max_age"), false);
    assert.doesNotThrow(() => assertRequiredMfaOidcClaims({ auth_time: 1, acr: "urn:wasalx:loa:2" }));
    assert.throws(
      () => assertRequiredMfaOidcClaims({ auth_time: 1, amr: ["pwd"], acr: "urn:wasalx:loa:1" }),
      /MFA evidence/i,
    );
  } finally {
    restoreEnvironment(snapshot);
  }
});

test("the privileged login stays on the active tenant and rotates the session without breaking open-tab CSRF", async () => {
  const login = await readFile(
    new URL("../app/auth/login/route.ts", import.meta.url),
    "utf8",
  );
  const callback = await readFile(
    new URL("../app/auth/callback/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(login, /try\{current=await getPortalSessionFromRequest\(request\)\}/);
  assert.match(login, /error instanceof PortalSessionError\)\|\|error\.status>=500\)throw error;stepUp=undefined/);
  assert.match(login, /tenantId:current\?\.tenantId/);
  assert.match(callback, /finalizePortalLoginSession/);
  assert.match(callback, /loadStoredPortalSession\(previousSessionId\?\?""\)/);
  assert.match(callback, /previousSessionId/);
  assert.match(callback, /deleteStoredPortalSession\(previousSessionId\)/);
  assert.match(callback, /error instanceof PortalSessionError\)return failure\("expired",state\)/);
  const failure = callback.slice(callback.indexOf("function failure"));
  assert.doesNotMatch(failure, /deleteStoredPortalSession/u);
  assert.doesNotMatch(failure, /response\.cookies\.set\(sessionCookieName\(\)/u);
  assert.match(failure, /response\.cookies\.set\(transactionCookieName\(state\)/u);
});

test("OIDC completion enforces tenant, subject, and MFA evidence without requiring a second password", async () => {
  const snapshot = snapshotEnvironment(managedEnvironment);
  const originalFetch = globalThis.fetch;
  try {
    configureOidcEnvironment();
    process.env.OIDC_PRIVILEGED_ACR_VALUES = "urn:wasalx:loa:2";
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "portal-test-key", use: "sig" };
    const requestedTenantId = "10000000-0000-4000-8000-000000000001";
    const otherTenantId = "20000000-0000-4000-8000-000000000002";
    const subject = "oidc-subject-1";

    const run = async (discoveredSubject: string, tenants: Array<Record<string, string>>, assurance?: string) => {
      const { transaction } = await createOidcTransaction({ tenantId: requestedTenantId, stepUp: assurance ? "required_mfa" : undefined });
      const idToken = await new SignJWT({ nonce: transaction.nonce, sid: "completion-sid", ...(assurance ? { acr: assurance, auth_time: Math.floor(Date.now() / 1_000) - 120 } : {}) })
        .setProtectedHeader({ alg: "RS256", kid: "portal-test-key", typ: "JWT" })
        .setIssuer("https://identity.wasalx.test")
        .setAudience("wasalx-portal")
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url === "https://identity.wasalx.test/token") {
          return Response.json({ access_token: "access-token", id_token: idToken, expires_in: 300 });
        }
        if (url === "https://identity.wasalx.test/jwks") return Response.json({ keys: [publicJwk] });
        if (url === "https://control.wasalx.test/v1/session") {
          return Response.json({
            subject: discoveredSubject,
            user: { id: "user-1", email: "owner@example.com", display_name: "Owner" },
            tenants: tenants.map((tenant) => ({ ...tenant, mfaRequiredRoles: ["tenant_owner"], sessionTimeoutMinutes: 480 })),
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      };
      return completeOidcLogin({ code: "authorization-code", transaction });
    };

    await assert.rejects(
      () => run(subject, [{ id: otherTenantId, name: "Other", slug: "other", state: "ACTIVE", role: "tenant_owner" }]),
      (error: unknown) => error instanceof OidcLoginError && error.reason === "membership" && error.status === 403 && /requested workspace/i.test(error.message),
    );

    await assert.rejects(
      () => run("different-subject", [{ id: requestedTenantId, name: "Requested", slug: "requested", state: "ACTIVE", role: "tenant_owner" }]),
      (error: unknown) => error instanceof OidcLoginError && error.reason === "identity" && error.status === 401 && /subject validation/i.test(error.message),
    );

    const session = await run(subject, [{ id: requestedTenantId, name: "Requested", slug: "requested", state: "ACTIVE", role: "auditor" }]);
    assert.equal(session.subject, subject);
    assert.equal(session.tenantId, requestedTenantId);
    assert.equal(session.role, "auditor");

    const owner = { id: requestedTenantId, name: "Requested", slug: "requested", state: "ACTIVE", role: "tenant_owner" };
    const mfaSession = await run(subject, [owner], "urn:wasalx:loa:2");
    assert.equal(mfaSession.role, "tenant_owner");
    await assert.rejects(
      () => run(subject, [owner], "urn:wasalx:loa:1"),
      (error: unknown) => error instanceof OidcLoginError && error.reason === "identity" && error.status === 403,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(snapshot);
  }
});

test("OIDC completion exposes only typed expired and unavailable reasons",async()=>{
  const snapshot=snapshotEnvironment(managedEnvironment);
  const originalFetch=globalThis.fetch;
  try{
    configureOidcEnvironment();
    const {transaction}=await createOidcTransaction({});
    transaction.createdAt=Date.now()-11*60_000;
    await assert.rejects(()=>completeOidcLogin({code:"authorization-code",transaction}),(error:unknown)=>error instanceof OidcLoginError&&error.reason==="expired");
    transaction.createdAt=Date.now();
    globalThis.fetch=async()=>{throw new TypeError("network unavailable")};
    await assert.rejects(()=>completeOidcLogin({code:"authorization-code",transaction}),(error:unknown)=>error instanceof OidcLoginError&&error.reason==="unavailable"&&error.status===503);
    globalThis.fetch=async()=>Response.json({error:"invalid_grant",error_description:"Code expired"},{status:400});
    await assert.rejects(()=>completeOidcLogin({code:"authorization-code",transaction}),(error:unknown)=>error instanceof OidcLoginError&&error.reason==="expired"&&error.status===401);
  }finally{
    globalThis.fetch=originalFetch;
    restoreEnvironment(snapshot);
  }
});


function configureOidcEnvironment() {
  process.env.PORTAL_PUBLIC_ORIGIN = "https://portal.wasalx.test";
  process.env.OIDC_ISSUER = "https://identity.wasalx.test";
  process.env.OIDC_CLIENT_ID = "wasalx-portal";
  process.env.OIDC_AUTHORIZATION_ENDPOINT = "https://identity.wasalx.test/authorize";
  process.env.OIDC_TOKEN_ENDPOINT = "https://identity.wasalx.test/token";
  process.env.OIDC_JWKS_URI = "https://identity.wasalx.test/jwks";
  process.env.OIDC_REDIRECT_URI = "https://portal.wasalx.test/auth/callback";
  process.env.CONTROL_API_URL = "https://control.wasalx.test";
}

function snapshotEnvironment(names: readonly string[]): EnvironmentSnapshot {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(snapshot: EnvironmentSnapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// Exercise real JOSE signatures; the actual Redis boundary is in multitenant E2E.
test("backchannel accepts only the configured Keycloak session event", async () => {
  const snapshot=snapshotEnvironment(managedEnvironment), originalFetch=globalThis.fetch;
  try {
    configureOidcEnvironment();
    process.env.OIDC_JWKS_URI="https://identity.wasalx.test/logout-positive-jwks";
    const {privateKey,publicKey}=await generateKeyPair("RS256");
    const jwk={...(await exportJWK(publicKey)),alg:"RS256",kid:"logout-positive",use:"sig"};
    globalThis.fetch=async input=>{
      assert.equal(String(input),process.env.OIDC_JWKS_URI,"never fetch a token-supplied issuer/key URL");
      return Response.json({keys:[jwk]});
    };
    const now=Math.floor(Date.now()/1000);
    const token=await new SignJWT({sid:"session-a",events:{"http://schemas.openid.net/event/backchannel-logout":{}}})
      .setProtectedHeader({alg:"RS256",kid:jwk.kid,typ:"logout+jwt"})
      .setIssuer("https://identity.wasalx.test").setAudience("wasalx-portal")
      .setSubject("subject-a").setJti("logout-event-a").setIssuedAt(now).setExpirationTime(now+120).sign(privateKey);
    assert.deepEqual(await verifyOidcLogoutToken(token),{
      issuer:"https://identity.wasalx.test",clientId:"wasalx-portal",sid:"session-a",
    });
  } finally {globalThis.fetch=originalFetch;restoreEnvironment(snapshot);}
});

test("backchannel rejects foreign, stale, future, replay-shaped and cross-JWT inputs before effects",async()=>{
  const snapshot=snapshotEnvironment(managedEnvironment), originalFetch=globalThis.fetch;
  try {
    configureOidcEnvironment();process.env.OIDC_JWKS_URI="https://identity.wasalx.test/logout-negative-jwks";
    const {privateKey,publicKey}=await generateKeyPair("RS256"), foreign=await generateKeyPair("RS256");
    const jwk={...(await exportJWK(publicKey)),alg:"RS256",kid:"logout-negative",use:"sig"};
    globalThis.fetch=async input=>{assert.equal(String(input),process.env.OIDC_JWKS_URI);return Response.json({keys:[jwk]});};
    const now=Math.floor(Date.now()/1000), event="http://schemas.openid.net/event/backchannel-logout";
    const base={iss:"https://identity.wasalx.test",aud:"wasalx-portal",sub:"subject-a",sid:"session-a",iat:now,exp:now+120,jti:"event-a",events:{[event]:{}}};
    const variants:Array<Record<string,unknown>>=[
      {iss:"https://foreign.invalid"},{aud:"foreign-client"},{aud:["wasalx-portal","foreign-client"]},
      {iat:now+60,exp:now+180},{iat:now-600,exp:now-480},{iat:undefined},{exp:undefined},
      {exp:now+3600},{jti:undefined},{jti:""},{sid:undefined},{sid:""},{sid:["session-a"]},
      {events:undefined},{events:{[event]:null}},{events:{[event]:[]}},{nonce:null},{nonce:"authentication-nonce"},
    ];
    for(const change of variants){
      const token=await new SignJWT({...base,...change}).setProtectedHeader({alg:"RS256",kid:jwk.kid,typ:"logout+jwt"}).sign(privateKey);
      await assert.rejects(()=>verifyOidcLogoutToken(token));
    }
    const badSignature=await new SignJWT(base).setProtectedHeader({alg:"RS256",kid:jwk.kid,typ:"logout+jwt"}).sign(foreign.privateKey);
    await assert.rejects(()=>verifyOidcLogoutToken(badSignature));
    const idLike=await new SignJWT(base).setProtectedHeader({alg:"RS256",kid:jwk.kid,typ:"JWT"}).sign(privateKey);
    await assert.rejects(()=>verifyOidcLogoutToken(idLike));
    const unsigned=Buffer.from(JSON.stringify({alg:"none",typ:"logout+jwt"})).toString("base64url")+"."+Buffer.from(JSON.stringify(base)).toString("base64url")+".";
    await assert.rejects(()=>verifyOidcLogoutToken(unsigned));
  } finally {globalThis.fetch=originalFetch;restoreEnvironment(snapshot);}
});

test("malformed configured-provider key material leaves logout verification unavailable",async()=>{
  const snapshot=snapshotEnvironment(managedEnvironment),originalFetch=globalThis.fetch;
  try{
    configureOidcEnvironment();
    const {privateKey}=await generateKeyPair("RS256",{extractable:true});
    const privateJwk={...await exportJWK(privateKey),alg:"RS256",kid:"configured-provider",use:"sig"};
    const now=Math.floor(Date.now()/1000);
    const token=await new SignJWT({sid:"session-a",events:{"http://schemas.openid.net/event/backchannel-logout":{}}})
      .setProtectedHeader({alg:"RS256",kid:privateJwk.kid,typ:"logout+jwt"})
      .setIssuer("https://identity.wasalx.test").setAudience("wasalx-portal")
      .setJti("provider-prerequisite").setIssuedAt(now).setExpirationTime(now+120).sign(privateKey);
    const materials=[{keys:"not-a-key-set"},{keys:[privateJwk]}];
    for(const [index,material] of materials.entries()){
      process.env.OIDC_JWKS_URI=`https://identity.wasalx.test/malformed-provider-${index}`;
      let reads=0;
      globalThis.fetch=async input=>{
        assert.equal(String(input),process.env.OIDC_JWKS_URI);
        reads+=1;return Response.json(material);
      };
      await assert.rejects(()=>verifyOidcLogoutToken(token),
        (error:unknown)=>error instanceof OidcLogoutError&&error.status===503);
      assert.equal(reads,1,"only the configured provider was consulted");
    }
  }finally{globalThis.fetch=originalFetch;restoreEnvironment(snapshot);}
});
