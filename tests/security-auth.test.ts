import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { authenticatePortalRequest, can, AuthenticationError } from "../lib/request-auth.ts";
import { ServiceAuthenticationError, signServiceJwt, verifyServiceJwt } from "../packages/core/src/service-auth.ts";
import { verifyProviderHmac as verifyRawProviderHmac } from "../services/control-api/src/webhook-security.ts";
import { AuthService } from "../services/control-api/dist/auth.service.js";
import { SecretResolutionError, SidecarSecretResolver } from "../services/connector-worker/dist/services/connector-worker/src/secrets.js";
import {
  hasAuthoritativeMfa,
  requirePrivilegedAuthentication,
} from "../services/control-api/dist/privileged-auth.js";

test("RBAC matrix prevents agents from changing configuration",()=>{assert.equal(can("agent","group:write"),false);assert.equal(can("tenant_admin","group:write"),true);assert.equal(can("auditor","audit:export"),true);assert.equal(can("supervisor","audit:export"),false);assert.equal(can("tenant_owner","audit:export"),true);assert.equal(can("tenant_admin","audit:export"),true);assert.equal(can("auditor","delivery:retry"),false)});
test("remote portal requests fail closed without signed identity headers",async()=>{await assert.rejects(()=>authenticatePortalRequest(new Request("https://wasalx.example/api/groups")),AuthenticationError)});
test("local development identity is restricted to loopback hosts",async()=>{const principal=await authenticatePortalRequest(new Request("http://127.0.0.1/api/groups"),"group:write");assert.equal(principal.userId,"local-preview");assert.equal(principal.role,"tenant_owner")});
test("service JWT enforces signature, audience, scope, tenant, and short lifetime",async()=>{const now=1_800_000_000;const claims={iss:"wasalx-zammad",aud:"wasalx-control",sub:"zammad-instance",tenant_id:"tenant-a",instance_id:"zammad-a",scope:"zammad:outbound zammad:health",iat:now-5,exp:now+60,jti:"jti-1"};const token=await signServiceJwt(claims,"secret");assert.equal((await verifyServiceJwt(token,"secret",{audience:"wasalx-control",scope:"zammad:outbound",tenantId:"tenant-a",now:now*1000})).jti,"jti-1");await assert.rejects(verifyServiceJwt(token,"wrong",{audience:"wasalx-control",now:now*1000}));await assert.rejects(verifyServiceJwt(token,"secret",{audience:"wrong",now:now*1000}));await assert.rejects(verifyServiceJwt(token,"secret",{audience:"wasalx-control",scope:"zammad:admin",now:now*1000}))});

test("service JWT rejects malformed signed claims and never bypasses its maximum lifetime", async () => {
  const now = 1_800_000_000;
  const claims = { iss: "wasalx-zammad", aud: "wasalx-control", sub: "zammad-instance", tenant_id: "tenant-a", instance_id: "zammad-a", scope: "zammad:outbound", iat: now - 5, exp: now + 60, jti: "jti-1" };
  const requirements = { audience: "wasalx-control", scope: "zammad:outbound", tenantId: "tenant-a", now: now * 1_000 };
  for (const patch of [
    { iat: undefined, exp: now + 86_400 },
    { iat: "invalid", exp: now + 86_400 },
    { iat: null, exp: now + 86_400 },
    { iat: now + 5, exp: now + 4 },
    { iat: now - 0.5 },
    { exp: now + 0.5 },
    { iat: now + 31 },
    { exp: now + 301 },
    { scope: undefined },
    { scope: ["zammad:outbound"] },
    { scope: "zammad:outbound\u0000" },
    { sub: undefined },
    { tenant_id: undefined },
    { instance_id: "" },
    { jti: undefined },
  ]) {
    const token = await signServiceJwt({ ...claims, ...patch } as never, "secret");
    await assert.rejects(verifyServiceJwt(token, "secret", requirements), ServiceAuthenticationError, JSON.stringify(patch));
  }
  const signMalformed = (header: unknown, payload: unknown) => {
    const encoded = [header, payload].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    return `${encoded}.${createHmac("sha256", "secret").update(encoded).digest("base64url")}`;
  };
  const valid = await signServiceJwt(claims, "secret");
  for (const token of [
    signMalformed(null, claims),
    signMalformed({ alg: "HS256", typ: "JWT" }, null),
    signMalformed({ alg: "HS256", typ: "JWT" }, []),
    valid.slice(0, valid.lastIndexOf(".") + 1) + "a",
    `${valid}\n`,
    "a".repeat(8_193),
  ]) await assert.rejects(verifyServiceJwt(token, "secret", requirements), ServiceAuthenticationError);
});

test("service JWT rejects malformed issued-at claims instead of bypassing its lifetime bound", async (t) => {
  const now = 1_800_000_000;
  const claims = { iss: "wasalx-zammad", aud: "wasalx-control", sub: "zammad-instance", tenant_id: "tenant-a", instance_id: "zammad-a", scope: "zammad:health", iat: now, exp: now + 300, jti: "lifetime-test" };
  const requirements = { audience: "wasalx-control", scope: "zammad:health", tenantId: "tenant-a", now: now * 1000 };
  for (const [name, override] of [
    ["missing iat", { iat: undefined, exp: now + 86_400 }],
    ["nonnumeric iat", { iat: "not-a-timestamp", exp: now + 86_400 }],
    ["object iat", { iat: {}, exp: now + 86_400 }],
    ["numeric string iat", { iat: String(now) }],
    ["expired", { exp: now }],
    ["future iat beyond skew", { iat: now + 31 }],
    ["lifetime above five minutes", { exp: now + 301 }],
  ] as const) await t.test(name, async () => {
    const token = await signServiceJwt({ ...claims, ...override } as never, "secret");
    await assert.rejects(
      () => verifyServiceJwt(token, "secret", requirements),
      (error: unknown) => error instanceof ServiceAuthenticationError && /lifetime/u.test(error.message),
    );
  });
  const token = await signServiceJwt(claims, "secret");
  assert.equal((await verifyServiceJwt(token, "secret", requirements)).exp, now + 300);
  const skewed = await signServiceJwt({ ...claims, iat: now + 30, exp: now + 330 }, "secret");
  assert.equal((await verifyServiceJwt(skewed, "secret", requirements)).iat, now + 30);
});

test("privileged actions require tenant-bounded freshness and authoritative MFA evidence", async () => {
  const timestamp = Math.floor(Date.now() / 1_000);
  const principal = {
    subject: "oidc-owner",
    userId: "20000000-0000-4000-8000-000000000001",
    tenantId: "10000000-0000-4000-8000-000000000001",
    email: "owner@example.test",
    displayName: "Owner",
    role: "tenant_owner" as const,
    authenticatedAt: timestamp - 30,
    authenticationMethods: ["pwd", "mfa"],
  };
  const queryable = {
    query: async () => ({ rows: [{ privileged_reauth_minutes: 15 }] }),
  };
  assert.equal(hasAuthoritativeMfa(principal), true);
  await assert.doesNotReject(
    requirePrivilegedAuthentication(queryable, principal, "disconnecting a connection"),
  );
  for (const privileged_reauth_minutes of [5, 120]) {
    await assert.doesNotReject(requirePrivilegedAuthentication(
      { query: async () => ({ rows: [{ privileged_reauth_minutes }] }) },
      principal,
      "disconnecting a connection",
    ));
  }
  for (const privileged_reauth_minutes of [4, 121]) {
    await assert.rejects(requirePrivilegedAuthentication(
      { query: async () => ({ rows: [{ privileged_reauth_minutes }] }) },
      principal,
      "disconnecting a connection",
    ));
  }
  for (const rejected of [
    { ...principal, authenticatedAt: undefined },
    { ...principal, authenticatedAt: timestamp - 901 },
    { ...principal, authenticatedAt: timestamp + 10 },
    { ...principal, authenticationMethods: ["pwd"] },
  ]) {
    await assert.rejects(
      requirePrivilegedAuthentication(queryable, rejected, "disconnecting a connection"),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "response" in error &&
            (error.response as { code?: string }).code === "REAUTHENTICATION_REQUIRED",
        ),
    );
  }
});

test("normal and invitation authentication enforce active session, MFA, and freshness policy", async () => {
  const previous = { issuer: process.env.OIDC_ISSUER, audience: process.env.OIDC_AUDIENCE };
  process.env.OIDC_ISSUER = "https://identity.example.test/realms/wasalx";
  process.env.OIDC_AUDIENCE = "wasalx-control";
  const now = Math.floor(Date.now() / 1_000);
  const membership = {
    user_id: "20000000-0000-4000-8000-000000000001",
    email: "owner@example.test",
    display_name: "Owner",
    role: "tenant_owner",
    active_mfa_required_roles: ["tenant_owner"],
    active_session_timeout_minutes: 15,
  };
  const service = new AuthService({ rows: async () => [membership] } as never);
  const setIdentity = (identity: Record<string, unknown>) => Object.defineProperty(service, "verify", { configurable: true, value: async () => identity });
  try {
    setIdentity({ subject: "oidc-owner", authenticatedAt: now - 30, authenticationMethods: ["pwd", "mfa"], email: membership.email, emailVerified: true, displayName: membership.display_name });
    assert.equal((await service.authenticate("token", "tenant-1")).role, "tenant_owner");
    assert.equal((await service.authenticateInvitationIdentity("token")).email, membership.email);
    setIdentity({ subject: "oidc-owner", authenticatedAt: now - 901, authenticationMethods: ["pwd", "mfa"], email: membership.email, emailVerified: true });
    await assert.rejects(service.authenticate("token", "tenant-1"), /Session has expired/u);
    setIdentity({ subject: "oidc-owner", authenticatedAt: now - 30, authenticationMethods: ["pwd"], email: membership.email, emailVerified: true });
    await assert.rejects(service.authenticate("token", "tenant-1"), /Multi-factor authentication/u);
    setIdentity({ subject: "oidc-owner", authenticatedAt: now - 61, authenticationMethods: ["pwd", "mfa"], email: membership.email, emailVerified: true });
    await assert.rejects(service.authenticateInvitationIdentity("token"), /Recent multi-factor authentication/u);
    setIdentity({ subject: "oidc-owner", authenticatedAt: now - 30, authenticationMethods: ["pwd"], email: membership.email, emailVerified: true });
    await assert.rejects(service.authenticateInvitationIdentity("token"), /Recent multi-factor authentication/u);
    for (const authenticatedAt of [undefined, now + 10]) {
      setIdentity({ subject: "oidc-owner", authenticatedAt, authenticationMethods: ["pwd", "mfa"], email: membership.email, emailVerified: true });
      await assert.rejects(service.authenticateInvitationIdentity("token"), /Recent multi-factor authentication/u);
    }
  } finally {
    if (previous.issuer === undefined) delete process.env.OIDC_ISSUER; else process.env.OIDC_ISSUER = previous.issuer;
    if (previous.audience === undefined) delete process.env.OIDC_AUDIENCE; else process.env.OIDC_AUDIENCE = previous.audience;
  }
});

test("verified OIDC assurance is propagated and every existing privileged operation uses the shared gate", async () => {
  const source = async (path: string) =>
    readFile(new URL(path, import.meta.url), "utf8");
  const auth = await source("../services/control-api/src/auth.service.ts");
  for (const claim of ["payload.auth_time", "payload.amr", "payload.acr"]) {
    assert.match(auth, new RegExp(claim.replace(".", "\\.")));
  }
  const files = await Promise.all([
    source("../services/control-api/src/connections.controller.ts"),
    source("../services/control-api/src/cases.controller.ts"),
    source("../services/control-api/src/privacy.controller.ts"),
    source("../services/control-api/src/support-access.service.ts"),
    source("../services/control-api/src/bot-flows.service.ts"),
  ]);
  for (const file of files) assert.match(file, /requirePrivilegedAuthentication\(/);
  assert.match(files[0]!, /operationType === "DISCONNECT"/);
  const privacyPrincipal = files[2]!.split("private async requirePrivacyPrincipal(")[1]!.split("private async privacyAdmission(")[0]!;
  assert.match(privacyPrincipal, /app\.lock_current_operator_principal\(\$1,\$2,\$3,\$4\) AS current_role/);
  assert.match(privacyPrincipal, /current\.current_role !== principal\.role[\s\S]*can\(current\.current_role, permission\)[\s\S]*await requirePrivilegedAuthentication\(client, principal, action\)/);
  assert.match(privacyPrincipal, /\[principal\.userId,principal\.subject,principal\.email,principal\.role\]/);
  const privacyAdmission = files[2]!.split("private async privacyAdmission(")[1]!.split("private async savePrivacyAdmission(")[0]!;
  assert.match(privacyAdmission, /kind === "HOLD" \? "privacy:hold:write" : kind === "DELETE" \? "privacy:delete" : "privacy:export"/);
  const admission = privacyAdmission.indexOf("await this.requirePrivacyPrincipal(");
  assert.ok(privacyAdmission.indexOf("pg_advisory_xact_lock") >= 0 && privacyAdmission.indexOf("bot-flow:") >= 0);
  assert.ok(privacyAdmission.indexOf("pg_advisory_xact_lock") < admission && privacyAdmission.indexOf("bot-flow:") < admission, "current identity and fresh MFA must follow both lock waits");
  assert.ok(admission < privacyAdmission.indexOf("SELECT action,request_sha256,result,requested_by"), "receipt recovery must revalidate current authority");
  assert.match(files[2]!, /this\.requirePrivacyPrincipal\(client, request, "privacy:export", "downloading a privacy export"\)/);
  for (const action of ["approving", "denying", "revoking"]) {
    assert.match(files[3]!, new RegExp(action));
  }
  for (const action of [
    "adding or replacing a plugin action credential",
    "adding or replacing a routing connection credential",
    "connecting a Notion workspace",
  ]) assert.match(files[4]!, new RegExp(action));
  assert.match(files[4]!, /input\.secretReference!==actionSecretReference/);
});

test("normal sessions enforce only the last verified tenant MFA and timeout policy", async () => {
  const [auth, migration] = await Promise.all([
    readFile(new URL("../services/control-api/src/auth.service.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/control-api/migrations/0119_operator_release_blockers.sql", import.meta.url), "utf8"),
  ]);
  assert.match(auth, /active_mfa_required_roles/);
  assert.match(auth, /active_session_timeout_minutes/);
  assert.match(auth, /hasRecentAuthentication\(identity,sessionMinutes\)/);
  assert.match(auth, /hasAuthoritativeMfa\(identity\)\|\|!hasRecentAuthentication\(identity,1\)/);
  assert.doesNotMatch(auth, /SELECT mfa_required_roles,session_timeout_minutes FROM tenant_settings/);
  assert.match(migration, /active_mfa_required_roles=mfa_required_roles/);
  assert.match(migration, /active_session_timeout_minutes=session_timeout_minutes/);
  assert.match(migration, /active_mfa_required_roles=mfa_required_roles,[\s\S]*active_session_timeout_minutes=session_timeout_minutes,[\s\S]*security_policy_state='ACTIVE'/);
});

test("HTTP plugin credentials remain owned by exactly one action through API, database, and workers", async () => {
  const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");
  const [service, migration, repository, processor, inboundProcessor, secrets, coreSecrets] = await Promise.all([
    source("../services/control-api/src/bot-flows.service.ts"),
    source("../services/control-api/migrations/0103_bot_action_credential_ownership.sql"),
    source("../services/connector-worker/src/repository.ts"),
    source("../services/connector-worker/src/processor.ts"),
    source("../services/connector-worker/src/inbound-processor.ts"),
    source("../services/connector-worker/src/secrets.ts"),
    source("../packages/core/src/secret-reference.ts"),
  ]);
  assert.match(service, /input\.secretReference!==actionSecretReference/);
  assert.match(migration, /kind = 'HTTP_JSON'[\s\S]*secret_reference = \([\s\S]*action_key/);
  assert.match(migration, /kind = 'NOTION_CREATE_PAGE'[\s\S]*secret_reference = \([\s\S]*action_key[\s\S]*routing\/integrations/);
  assert.match(repository, /definition\.action_key[\s\S]*actionKey:row\.action_key/);
  assert.match(processor, /this\.secrets\.resolve\(job\.secretReference!,\{kind:"bot-action",tenantId:job\.tenantId,actionKey:job\.actionKey!,actionKind:job\.kind\}\)/);
  assert.match(inboundProcessor, /isBotActionSecretReference\(event\.tenantId,execution\.action\.kind,execution\.action\.secretReference,execution\.action\.actionId\)/);
  assert.match(secrets, /isOwnedSecretReference\(reference,\{kind:"bot-action",tenantId,actionKey,actionKind:kind\}\)/);
  assert.match(coreSecrets, /reference\s*===\s*actionPrefix\s*\|\|\s*reference\.startsWith\(`\$\{actionPrefix\}\/credentials\/`\)/);
  assert.match(coreSecrets, /\^\[0-9a-f\]\{64\}\$/);
});

test("known bot action results are checkpointed before Zammad projection and cannot be replaced", async () => {
  const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");
  const [migration, repository, processor, postgresHarness] = await Promise.all([
    source("../services/control-api/migrations/0104_bot_action_result_checkpoint.sql"),
    source("../services/connector-worker/src/repository.ts"),
    source("../services/connector-worker/src/processor.ts"),
    source("../scripts/test-postgres-integration.mjs"),
  ]);
  assert.match(migration, /execution_result_state[\s\S]*execution_result_recorded_at/);
  assert.match(migration, /execution_result_variables IS NOT NULL/);
  assert.match(migration, /OLD\.execution_result_recorded_at IS NOT NULL[\s\S]*bot action execution result is immutable/);
  assert.match(repository, /execution_result_state IS NULL[\s\S]*Bot action result fence was lost/);
  assert.match(repository, /job\.execution_result_state[\s\S]*recordedBotActionResult\(row\)/);
  const checkpoint = processor.indexOf("recordBotActionResult");
  const completion = processor.indexOf("completeBotAction");
  assert.ok(checkpoint >= 0 && completion >= 0 && checkpoint < completion);
  assert.match(postgresHarness, /recordBotActionResult\([\s\S]*completeBotAction\(/);
});

test("webhook HMAC authenticates the exact received bytes without text normalization", async () => {
  const body=Uint8Array.from([0xc3,0x28]);
  const secret="webhook-byte-test-secret";
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const provided=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",key,body)),byte=>byte.toString(16).padStart(2,"0")).join("");
  assert.deepEqual(await verifyRawProviderHmac({rawBody:body,secret,provided,algorithm:"sha256"}),{valid:true});
  assert.deepEqual(await verifyRawProviderHmac({rawBody:new TextDecoder().decode(body),secret,provided,algorithm:"sha256"}),{valid:false,reason:"signature"});
});

test("worker secret resolution rejects redirects, oversized or malformed values, and classifies transient status codes",async()=>{
  for(const url of ["ftp://secrets.internal","https://fixture:placeholder@api.example.test/path","http://secrets.internal/prefix","http://secrets.internal?token=x"]){
    assert.throws(()=>new SidecarSecretResolver(url,"read-token",false),/URL is invalid/);
  }
  assert.throws(()=>new SidecarSecretResolver("http://secrets.internal","read-token",true),/must use HTTPS/);
  const resolver=new SidecarSecretResolver("http://secrets.internal","read-token",false);const previousFetch=globalThis.fetch;let request:RequestInit|undefined;
  const reference="secret://tenants/test/zammad/service";const owner={kind:"zammad",tenantId:"test",purpose:"service"} as const;
  try{
    globalThis.fetch=async(_input,init)=>{request=init;return new Response(JSON.stringify({token:"zammad-token",jwt_secret:"separate-signing-key",instance_id:"11000000-0000-4000-8000-000000000001"}),{headers:{"content-type":"application/json"}})};
    assert.deepEqual(await resolver.resolve(reference,owner),{token:"zammad-token"});
    assert.equal(request?.redirect,"error");
    let fetched=false;globalThis.fetch=async()=>{fetched=true;return new Response()};
    await assert.rejects(()=>resolver.resolve(reference,{...owner,tenantId:"other"}),(error:unknown)=>error instanceof SecretResolutionError&&!error.retryable);assert.equal(fetched,false);
    await assert.rejects(
      ()=>resolver.resolve("secret://platform/waha/admin",{kind:"exact",expectedReference:"secret://platform/waha/admin"}),
      (error:unknown)=>error instanceof SecretResolutionError&&!error.retryable,
    );
    assert.equal(fetched,false);
    await assert.rejects(()=>resolver.resolve("https://invalid",owner),(error:unknown)=>error instanceof SecretResolutionError&&!error.retryable);
    for(const status of [408,425,429,500]){
      globalThis.fetch=async()=>new Response(null,{status});
      await assert.rejects(()=>resolver.resolve(reference,owner),(error:unknown)=>error instanceof SecretResolutionError&&error.retryable);
    }
    globalThis.fetch=async()=>new Response(null,{status:400});
    await assert.rejects(()=>resolver.resolve(reference,owner),(error:unknown)=>error instanceof SecretResolutionError&&!error.retryable);
    for(const body of [JSON.stringify(["not-a-record"]),JSON.stringify({token:{nested:"invalid"}}),JSON.stringify({unknown:"no runtime field"}),"x".repeat(16_385)]){
      globalThis.fetch=async()=>new Response(body,{headers:{"content-type":"application/json"}});
      await assert.rejects(()=>resolver.resolve(reference,owner),(error:unknown)=>error instanceof SecretResolutionError&&!error.retryable);
    }
  }finally{globalThis.fetch=previousFetch}
});

test("worker accepts only purpose-scoped Zammad provisioning fields without exposing them",async()=>{
  const resolver=new SidecarSecretResolver("https://secrets.internal","read-token",true,["secret://platform/waha/admin"]);
  const previousFetch=globalThis.fetch;
  try{
    for(const [purpose,field,otherField] of [["service","bootstrap_password","key"],["privacy","key","bootstrap_password"]] as const){
      const reference=`secret://tenants/test/zammad/${purpose}`;
      const owner={kind:"zammad",tenantId:"test",purpose} as const;
      const payload={token:"runtime-token",[field]:"provisioner-only",...(purpose==="service"?{jwt_secret:"signing-key",instance_id:"instance-1"}:{})};
      globalThis.fetch=async()=>Response.json(payload);
      assert.deepEqual(await resolver.resolve(reference,owner),{token:"runtime-token"});
      for(const malformed of ["",42,"x".repeat(4097),"line\nbreak"]){
        globalThis.fetch=async()=>Response.json({...payload,[field]:malformed});
        await assert.rejects(()=>resolver.resolve(reference,owner),error=>error instanceof SecretResolutionError&&!error.retryable);
      }
      for(const invalid of [{[field]:"provisioner-only"},{token:"runtime-token",[otherField]:"wrong-purpose"},{...payload,unknown:"unexpected"}]){
        globalThis.fetch=async()=>Response.json(invalid);
        await assert.rejects(()=>resolver.resolve(reference,owner),error=>error instanceof SecretResolutionError&&!error.retryable);
      }
      const otherOwners=[
        {reference:"secret://platform/waha/admin",owner:{kind:"exact",expectedReference:"secret://platform/waha/admin"}},
        {reference:"secret://test/connections/connection/meta",owner:{kind:"meta-connection",tenantId:"test",connectionId:"connection"}},
        {reference:"secret://test/connections/connection/webhook",owner:{kind:"waha-webhook",tenantId:"test",connectionId:"connection"}},
        {reference:"secret://tenants/test/routing/route",owner:{kind:"routing",tenantId:"test"}},
        {reference:"secret://tenants/test/bot-actions/action",owner:{kind:"bot-action",tenantId:"test",actionKey:"action",actionKind:"HTTP_JSON"}},
      ] as const;
      globalThis.fetch=async()=>Response.json(payload);
      for(const other of otherOwners)await assert.rejects(()=>resolver.resolve(other.reference,other.owner),error=>error instanceof SecretResolutionError&&!error.retryable);
    }
  }finally{globalThis.fetch=previousFetch}
});


test("current-principal lock boundary preserves all nine admission guards across SQL and callers", async () => {
  const [privacy, migration, workspace] = await Promise.all([
    readFile(new URL("../services/control-api/src/privacy.controller.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/control-api/migrations/0199_current_operator_row_locks.sql", import.meta.url), "utf8"),
    readFile(new URL("../services/control-api/src/portal-workspace.controller.ts", import.meta.url), "utf8"),
  ]);
  const verify = (control: string, sql: string, portal: string) => {
    const principal = control.split("private async requirePrivacyPrincipal(")[1]!.split("private async privacyAdmission(")[0]!;
    const admission = control.split("private async privacyAdmission(")[1]!.split("private async savePrivacyAdmission(")[0]!;
    const operator = sql.split("CREATE FUNCTION app.lock_current_operator_principal(")[1]!.split("CREATE FUNCTION app.lock_current_working_zammad_instance(")[0]!;
    const instance = sql.split("CREATE FUNCTION app.lock_current_working_zammad_instance(")[1]!.split("CREATE FUNCTION app.sync_tenant_retention_days(")[0]!;
    for (const body of [operator, instance]) {
      assert.match(body, /VOLATILE\s+SECURITY DEFINER\s+SET search_path=pg_catalog,public,app\s+SET row_security=off/u);
      assert.doesNotMatch(body, /\b(?:INSERT|UPDATE|DELETE|EXECUTE)\s+(?:INTO|public\.)/u);
    }
    assert.match(operator, /tenant_id_value uuid := app\.current_tenant_id\(\)/u);
    assert.match(operator, /settings\.tenant_id=tenant_id_value FOR SHARE OF settings NOWAIT/u);
    assert.match(operator, /tenant\.id=tenant_id_value AND tenant\.state='ACTIVE' FOR SHARE OF tenant NOWAIT/u);
    assert.match(operator, /identity\.id=user_id_value AND identity\.oidc_subject=subject_value\s+AND identity\.email=email_value FOR SHARE OF identity NOWAIT/u);
    assert.match(operator, /member\.tenant_id=tenant_id_value AND member\.user_id=user_id_value\s+AND member\.state='ACTIVE' AND member\.role=expected_role_value FOR SHARE OF member NOWAIT/u);
    const locks = ["FOR SHARE OF settings", "FOR SHARE OF tenant", "FOR SHARE OF identity", "FOR SHARE OF member"].map(lock => operator.indexOf(lock));
    assert.ok(locks.every((offset, index) => offset >= 0 && (index === 0 || offset > locks[index - 1]!)));
    assert.match(operator, /OWNER TO wasalx_tenant_admin_writer/u);
    assert.match(operator, /REVOKE ALL ON FUNCTION app\.lock_current_operator_principal\(uuid,text,text,text\) FROM PUBLIC/u);
    assert.match(operator, /GRANT EXECUTE ON FUNCTION app\.lock_current_operator_principal\(uuid,text,text,text\) TO wasalx_app/u);
    assert.match(instance, /instance\.tenant_id=app\.current_tenant_id\(\) AND instance\.id=instance_id_value\s+AND instance\.state='WORKING' FOR SHARE OF instance NOWAIT/u);
    assert.match(instance, /OWNER TO wasalx_provisioning_executor/u);
    assert.match(instance, /REVOKE ALL ON FUNCTION app\.lock_current_working_zammad_instance\(uuid\) FROM PUBLIC/u);
    assert.match(instance, /GRANT EXECUTE ON FUNCTION app\.lock_current_working_zammad_instance\(uuid\) TO wasalx_app/u);
    assert.match(principal, /app\.lock_current_operator_principal\(\$1,\$2,\$3,\$4\) AS current_role/u);
    assert.match(principal, /\[principal\.userId,principal\.subject,principal\.email,principal\.role\]/u);
    assert.match(principal, /current\.current_role !== principal\.role[\s\S]*!can\(current\.current_role, permission\)/u);
    assert.match(principal, /await requirePrivilegedAuthentication\(client, principal, action\)/u);
    const authority = admission.indexOf("await this.requirePrivacyPrincipal(");
    assert.ok(authority > admission.indexOf("pg_advisory_xact_lock") && admission.indexOf("pg_advisory_xact_lock") >= 0);
    assert.ok(authority > admission.indexOf("bot-flow:") && admission.indexOf("bot-flow:") >= 0);
    assert.ok(authority < admission.indexOf("SELECT action,request_sha256,result,requested_by"));
    assert.match(control, /this\.requirePrivacyPrincipal\(client, request, "privacy:export", "downloading a privacy export"\)/u);
    const settle = portal.split("private async settleOwnerProjection(")[1]!.split("private async actor(")[0]!;
    assert.match(settle, /current\.current_role!==principal\.role \|\| current\.current_role!=="tenant_owner"/u);
    assert.match(settle, /\[principal\.userId,principal\.subject,principal\.email,principal\.role\]/u);
    assert.match(settle, /lock_current_working_zammad_instance\(\$1\) AS working",\[captured\.instance_id\]/u);
    assert.match(settle, /if \(!instance\?\.working\) throw/u);
    const order = ["app.lock_current_operator_principal(", "app.lock_current_working_zammad_instance(", "FOR UPDATE OF p", "await requirePrivilegedAuthentication(", "UPDATE native_membership_projections"].map(part => settle.indexOf(part));
    assert.ok(order.every((offset, index) => offset >= 0 && (index === 0 || offset > order[index - 1]!)));
    assert.match(settle, /FOR UPDATE OF p NOWAIT/u);
    assert.match(principal, /\.catch\(mapPrivacyLockConflict\)/u);
    assert.match(control, /function mapPrivacyLockConflict\(error: unknown\): never[\s\S]*error\.code === "55P03"[\s\S]*code: "CURRENT_PRINCIPAL_BUSY"/u);
    const policy = control.split("  async updatePolicy(")[1]!.split('  @Get("legal-holds")')[0]!;
    assert.match(policy, /\}\)\.catch\(mapPrivacyLockConflict\);[\s\S]*wakePrivacy/u);
    assert.doesNotMatch(policy, /UPDATE tenants SET retention_days/u);
    const mirror = sql.split("CREATE FUNCTION app.sync_tenant_retention_days(")[1]!;
    assert.match(mirror, /TG_RELID<>'public\.retention_policies'::regclass OR TG_OP<>'UPDATE'/u);
    assert.match(mirror, /tenant\.id=NEW\.tenant_id\s+FOR UPDATE OF tenant NOWAIT/u);
    assert.match(mirror, /UPDATE public\.tenants SET retention_days=NEW\.resolved_case_days[\s\S]*WHERE id=NEW\.tenant_id/u);
    assert.match(mirror, /OWNER TO wasalx_provisioning_executor/u);
    assert.match(mirror, /REVOKE ALL ON FUNCTION app\.sync_tenant_retention_days\(\) FROM PUBLIC,wasalx_app,wasalx_connector_worker/u);
    assert.match(mirror, /AFTER UPDATE OF resolved_case_days ON public\.retention_policies\s+FOR EACH ROW EXECUTE FUNCTION app\.sync_tenant_retention_days\(\)/u);
    assert.doesNotMatch(mirror, /GRANT EXECUTE|WHEN\s*\(/u);
    assert.doesNotMatch(settle, /FOR SHARE OF m,u,t,s,z|lock_current_active_tenant_for_event_admission/u);
  };
  verify(privacy, migration, workspace);
  const authority = '    await this.requirePrivacyPrincipal(client, request, permission, "recovering or submitting a privacy action");';
  const mutations: [string, string, string][] = [
    ["subject", privacy, migration.replace("identity.oidc_subject=subject_value", "true")],
    ["email", privacy, migration.replace("identity.email=email_value", "true")],
    ["tenant state", privacy, migration.replace("tenant.state='ACTIVE'", "true")],
    ["policy lock", privacy, migration.replace("FOR SHARE OF settings", "")],
    ["permission", privacy.replace("!can(current.current_role, permission)", "false"), migration],
    ["fresh MFA", privacy.replace("await requirePrivilegedAuthentication(client, principal, action);", ""), migration],
    ["operation wait", privacy.replace('`bot-flow:${request.principal.tenantId}:${key}`', '`unused:${key}`'), migration],
    ["download authority", privacy.replaceAll('this.requirePrivacyPrincipal(client, request, "privacy:export", "downloading a privacy export")', 'Promise.resolve()'), migration],
    ["authority before waits", privacy.replace(authority, "").replace('    await client.query("SELECT pg_advisory_xact_lock', `${authority}\n    await client.query("SELECT pg_advisory_xact_lock`), migration],
  ];
  for (const [name, control, sql] of mutations) assert.throws(() => verify(control, sql, workspace), { name: "AssertionError" }, name);
});
