import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { registerHooks } from "node:module";
import { formatDateTime, formatNumber } from "../lib/i18n/format.ts";
import { arabicPlatformMessages } from "../lib/i18n/messages/ar/platform.ts";
import { englishPlatformMessages } from "../lib/i18n/messages/en/platform.ts";
import { allowedPlatformProxyRoute } from "../lib/platform-proxy-routes.ts";
import {
  platformClaims,
  validPlatformOidcTransaction,
} from "../lib/platform-oidc.ts";
import {
  assertPlatformPortalSession,
  platformSessionCookieName,
  safePlatformReturnPath,
} from "../lib/platform-portal-session.ts";

const sessionSource = await readFile(
  new URL("../lib/platform-portal-session.ts", import.meta.url),
  "utf8",
);
const storeSource = await readFile(
  new URL("../lib/platform-portal-session-store.ts", import.meta.url),
  "utf8",
);
const oidcSource = await readFile(
  new URL("../lib/platform-oidc.ts", import.meta.url),
  "utf8",
);
const proxySource = await readFile(
  new URL("../app/api/platform-console/[...path]/route.ts", import.meta.url),
  "utf8",
);
const pageSource = await readFile(
  new URL("../app/platform/page.tsx", import.meta.url),
  "utf8",
);
const tenantPageSource = await readFile(
  new URL("../app/app/page.tsx", import.meta.url),
  "utf8",
);
const componentSource = await readFile(
  new URL("../app/platform/PlatformConsole.tsx", import.meta.url),
  "utf8",
);
const platformClientSource = await readFile(
  new URL("../lib/platform-client.ts", import.meta.url),
  "utf8",
);
const localeSwitcherSource = await readFile(
  new URL("../app/LocaleSwitcher.tsx", import.meta.url),
  "utf8",
);
const errorSource = await readFile(
  new URL("../app/platform/error.tsx", import.meta.url),
  "utf8",
);
const loadingSource = await readFile(
  new URL("../app/platform/PlatformLoading.tsx", import.meta.url),
  "utf8",
);
const cssSource = await readFile(
  new URL("../app/platform/PlatformConsole.module.css", import.meta.url),
  "utf8",
);
const boundaryCssSource = await readFile(
  new URL("../app/platform/PlatformBoundary.module.css", import.meta.url),
  "utf8",
);
const recoveryMigrationSource = await readFile(
  new URL("../services/control-api/migrations/0115_platform_operator_recovery.sql", import.meta.url),
  "utf8",
);
const platformRealm = JSON.parse(
  await readFile(
    new URL(
      "../infra/docker/full/keycloak/wasalx-platform-realm.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  realm: string;
  browserFlow?: string;
  authenticatorConfig?: Array<{ alias?: string; config?: Record<string, string> }>;
  authenticationFlows?: Array<{
    alias?: string;
    authenticationExecutions?: Array<{
      authenticator?: string;
      authenticatorConfig?: string;
      requirement?: string;
    }>;
  }>;
  roles?: { realm?: Array<{ name?: string }> };
  clients?: Array<{ clientId?: string; redirectUris?: string[]; protocolMappers?: Array<{ protocolMapper?: string }> }>;
  users?: Array<{ username?: string; realmRoles?: string[]; requiredActions?: string[] }>;
};

test("operator browser session has a separate cookie, key, Redis namespace, and short lifetime", () => {
  const previousSecure = process.env.PORTAL_COOKIE_SECURE;
  process.env.PORTAL_COOKIE_SECURE = "true";
  try {
    assert.equal(platformSessionCookieName(), "__Host-wasalx_platform_session");
  } finally {
    if (previousSecure === undefined) delete process.env.PORTAL_COOKIE_SECURE;
    else process.env.PORTAL_COOKIE_SECURE = previousSecure;
  }
  assert.match(sessionSource, /PLATFORM_PORTAL_SESSION_SECRET/);
  assert.doesNotMatch(sessionSource, /sessionCookieName\(/);
  assert.match(storeSource, /wasalx:platform-portal:session:/);
  assert.match(storeSource, /Math\.min\(lifetime, 15 \* 60\)/);
  assert.doesNotMatch(storeSource, /refreshOidcSession/);
});

test("rejected platform OIDC callbacks log only presence flags and correlation", async (t) => {
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.endsWith("/app/platform/auth/callback/route.ts")) {
        if (specifier === "next/server") return nextResolve("vinext/shims/server", context);
        if (specifier.startsWith("../../../../lib/")) return nextResolve(`${specifier}.ts`, context);
      }
      return nextResolve(specifier, context);
    },
  });
  const { GET } = await import("../app/platform/auth/callback/route.ts").finally(() => hook.deregister());
  const previousOrigin = process.env.PORTAL_PUBLIC_ORIGIN;
  process.env.PORTAL_PUBLIC_ORIGIN = "https://portal.example.test";
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.PORTAL_PUBLIC_ORIGIN;
    else process.env.PORTAL_PUBLIC_ORIGIN = previousOrigin;
  });
  const warnings: string[] = [];
  t.mock.method(process.stderr, "write", (line: string) => { warnings.push(String(line)); return true; });
  const response = await GET(new Request(
    "https://portal.example.test/platform/auth/callback?error=fixture-error&code=fixture-code&state=invalid",
  ));
  assert.equal(new URL(response.headers.get("location")!).searchParams.get("reason"), "invalid_callback");
  assert.equal(warnings.length, 1);
  const { timestamp, request_id, ...entry } = JSON.parse(warnings[0]);
  assert.deepEqual(entry, {
    level: "warn", event: "platform_oidc_callback_rejected", providerError: true,
    codePresent: true, statePresent: true, transactionPresent: false,
  });
  assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T/u);
  assert.match(request_id, /^[a-f0-9-]{36}$/u);
});

test("successful operator login rotates the previous server-side session", async () => {
  const callback = await readFile(
    new URL("../app/platform/auth/callback/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(callback, /previousSessionId/);
  assert.match(callback, /deleteStoredPlatformSession\(previousSessionId\)/);
  const failure = callback.slice(callback.indexOf("function failure"), callback.indexOf("function clearTransaction"));
  assert.doesNotMatch(failure, /deleteStoredPlatformSession/u);
  assert.doesNotMatch(failure, /response\.cookies\.set\(platformSessionCookieName\(\)/u);
  assert.match(callback.slice(callback.indexOf("function clearTransaction")), /platformTransactionCookieName\(state\)/u);
});

test("operator OIDC validates access and identity tokens, forces fresh login, MFA, role, and recent auth", () => {
  assert.match(oidcSource, /jwtVerify\(tokens\.id_token/);
  assert.match(oidcSource, /jwtVerify\(tokens\.access_token/);
  assert.match(oidcSource, /audience: configuration\.audience/);
  assert.match(oidcSource, /prompt: "login"/);
  assert.match(oidcSource, /max_age: "0"/);
  assert.match(oidcSource, /must not reuse the tenant client or audience/);
  assert.match(oidcSource, /must use HTTPS outside local development/);
  assert.match(oidcSource, /WASALX_ENVIRONMENT === "local-full"/);
  const now = Math.floor(Date.now() / 1_000);
  assert.deepEqual(
    platformClaims(
      {
        sub: "operator-1",
        email: "operator@example.test",
        name: "Platform Operator",
        platform_role: "platform_operator",
        amr: ["pwd", "otp"],
        auth_time: now - 30,
      },
      900,
    ),
    {
      subject: "operator-1",
      email: "operator@example.test",
      displayName: "Platform Operator",
      authenticatedAt: now - 30,
    },
  );
  assert.throws(
    () =>
      platformClaims(
        {
          sub: "operator-1",
          email: "operator@example.test",
          platform_role: "platform_operator",
          amr: ["pwd"],
          auth_time: now - 30,
        },
        900,
      ),
    /MFA is required/,
  );
  assert.throws(
    () =>
      platformClaims(
        {
          sub: "operator-1",
          email: "operator@example.test",
          platform_role: "platform_operator",
          amr: ["pwd", "otp"],
          auth_time: now - 901,
        },
        900,
      ),
    /Recent platform operator authentication is required/,
  );
  assert.throws(
    () =>
      platformClaims(
        {
          sub: "operator-1",
          email: "operator@example.test",
          platform_role: "tenant_owner",
          amr: ["mfa"],
          auth_time: now - 30,
        },
        900,
      ),
    /Platform operator role is required/,
  );
});

test("local human checkpoint uses a distinct operator realm, audience, client, role, and TOTP enrollment", () => {
  assert.equal(platformRealm.realm, "wasalx-platform");
  assert.ok(platformRealm.roles?.realm?.some((role) => role.name === "wasalx-platform-operator"));
  const clientIds = platformRealm.clients?.map((client) => client.clientId);
  assert.deepEqual(clientIds, ["wasalx-platform-api", "wasalx-platform-portal"]);
  const portal = platformRealm.clients?.find((client) => client.clientId === "wasalx-platform-portal");
  assert.deepEqual(portal?.redirectUris, ["http://127.0.0.1:3000/platform/auth/callback"]);
  assert.ok(portal?.protocolMappers?.some((mapper) => mapper.protocolMapper === "oidc-amr-mapper"));
  assert.equal(platformRealm.browserFlow, "wasalx-platform-browser");
  const platformBrowser = platformRealm.authenticationFlows?.find(
    (flow) => flow.alias === platformRealm.browserFlow,
  );
  assert.deepEqual(
    platformBrowser?.authenticationExecutions,
    [
      {
        authenticatorConfig: "wasalx-platform-password-reference",
        authenticator: "auth-username-password-form",
        authenticatorFlow: false,
        requirement: "REQUIRED",
        priority: 10,
        userSetupAllowed: false,
      },
      {
        authenticatorConfig: "wasalx-platform-otp-reference",
        authenticator: "auth-otp-form",
        authenticatorFlow: false,
        requirement: "REQUIRED",
        priority: 20,
        userSetupAllowed: false,
      },
    ],
  );
  assert.deepEqual(
    platformRealm.authenticatorConfig?.map((config) => config.config),
    [
      { "default.reference.value": "pwd", "default.reference.maxAge": "900" },
      { "default.reference.value": "otp", "default.reference.maxAge": "900" },
    ],
  );
  const operator = platformRealm.users?.find((user) => user.username === "example.platform");
  assert.ok(operator?.realmRoles?.includes("wasalx-platform-operator"));
  assert.ok(operator?.requiredActions?.includes("CONFIGURE_TOTP"));
});

test("platform return paths never leave the isolated console and transactions expire", () => {
  assert.equal(safePlatformReturnPath("/"), "/platform");
  assert.equal(safePlatformReturnPath("//evil.example"), "/platform");
  assert.equal(safePlatformReturnPath("/platformevil"), "/platform");
  assert.equal(safePlatformReturnPath("/platform/../auth/callback"), "/platform");
  assert.equal(safePlatformReturnPath(`/platform/${"x".repeat(502)}`), `/platform/${"x".repeat(502)}`);
  assert.equal(safePlatformReturnPath(`/platform/${"x".repeat(503)}`), "/platform");
  assert.equal(
    safePlatformReturnPath("/platform?state=FAILED"),
    "/platform?state=FAILED",
  );
  assert.equal(
    safePlatformReturnPath("/platform/auth/callback?code=leak"),
    "/platform",
  );
  assert.equal(
    validPlatformOidcTransaction({
      state: "S".repeat(43),
      nonce: "N".repeat(43),
      verifier: "V".repeat(86),
      returnTo: "/platform",
      createdAt: Date.now(),
    }),
    true,
  );
});

test("platform BFF exposes only reviewed paths and never constructs tenant context", () => {
  assert.equal(allowedPlatformProxyRoute("GET", "operations/overview"), true);
  assert.equal(allowedPlatformProxyRoute("POST", "support-access"), true);
  assert.equal(
    allowedPlatformProxyRoute(
      "GET",
      "support-access/10000000-0000-4000-8000-000000000001/overview",
    ),
    true,
  );
  assert.equal(
    allowedPlatformProxyRoute(
      "POST",
      "support-access/10000000-0000-4000-8000-000000000001/cancel",
    ),
    true,
  );
  assert.equal(
    allowedPlatformProxyRoute(
      "POST",
      "tenants/10000000-0000-4000-8000-000000000001/suspend",
    ),
    true,
  );
  assert.equal(
    allowedPlatformProxyRoute(
      "POST",
      "tenants/10000000-0000-4000-8000-000000000001/resume",
    ),
    true,
  );
  assert.equal(
    allowedPlatformProxyRoute(
      "GET",
      "tenants/10000000-0000-4000-8000-000000000001/resume",
    ),
    false,
  );
  assert.equal(allowedPlatformProxyRoute("GET", "../v1/audit-events"), false);
  assert.equal(allowedPlatformProxyRoute("POST", "support-access/x/overview"), false);
  assert.doesNotMatch(proxySource, /x-wasalx-tenant-id/);
  assert.match(proxySource, /authorization: `Bearer \$\{session\.accessToken\}`/);
  assert.match(proxySource, /readBoundedBody\(request, isStatement \? 524_288 : 65_536, 30_000\)/);
});

test("platform page is managed-control-plane only and supports real operator workflows without synthetic success", () => {
  assert.match(pageSource, /if \(!isControlPlaneBackend\(\)\) notFound\(\)/);
  assert.match(pageSource, /platformSessionCookieName/);
  assert.ok(pageSource.indexOf("await loadPlatformSession(sessionId)") < pageSource.indexOf("<Suspense"));
  assert.match(pageSource, /const session = await loadPlatformSession\(sessionId\);\s+if \(!session\) redirect\(platformLoginPath\(returnTo\)\);/u);
  assert.equal(existsSync(new URL("../app/platform/loading.tsx", import.meta.url)), false);
  assert.match(pageSource, /<I18nProvider/);
  assert.match(componentSource, /platform\.dialog\.workspace\.title/);
  assert.match(componentSource, /platform\.dialog\.support\.title/);
  assert.match(componentSource, /<ModalDialog/);
  assert.match(componentSource, /<select name="tenantId"/);
  assert.doesNotMatch(componentSource, />Tenant ID<input/);
  assert.match(componentSource, /platform\.workers\.title/);
  assert.match(componentSource, /platform\.dialog\.worker\.eyebrow/);
  assert.match(componentSource, /"PATCH"/);
  assert.match(componentSource, /allowedActions\.has\("RESUME"\)/);
  assert.doesNotMatch(componentSource, /tenant\.tenant_state === "(?:ACTIVE|SUSPENDED)"/);
  assert.match(componentSource, /platform\.actions\.reactivate/);
  assert.match(componentSource, /tenants\/\$\{modal\.tenant\.tenant_id\}\/resume/);
  assert.match(componentSource, /platform\.dialog\.resume\.warningTitle/);
  assert.match(componentSource, /platform\.dialog\.resume\.warningDescription/);
  assert.match(componentSource, /platform\.actions\.requestReactivation/);
  assert.match(componentSource, /tenant\.allowed_actions/);
  assert.match(componentSource, /provisioning\/retry/);
  assert.match(componentSource, /SupportInspectionDrawer/);
  assert.match(componentSource, /support-access\/\$\{request\.id\}\/cancel/);
  assert.match(componentSource, /platform\.usage\.eyebrow/);
  assert.match(componentSource, /await platformRequest/);
  assert.match(componentSource, /operationKeys\.current\.get\(operation\)/);
  assert.match(componentSource, /operationKeys\.current\.delete\(operation\)/);
  assert.match(componentSource, /tenantListPath\(query, stateFilter, tenants\.next_cursor\)/);
  assert.match(componentSource, /loadTenantPages\(operator, query, stateFilter, pageCount, signal\)/);
  assert.match(componentSource, /platform\.tenants\.loadMore/);
  const mutationSource = componentSource.slice(componentSource.indexOf("async function mutate"), componentSource.indexOf("async function inspectUsage"));
  assert.ok(mutationSource.indexOf('setFeedback(t("platform.feedback.accepted"))') < mutationSource.indexOf("await refresh()"));
  assert.match(mutationSource, /platform\.feedback\.acceptedRefreshFailed/);
  assert.doesNotMatch(componentSource, /setTimeout\([^)]*success/iu);
  assert.match(errorSource, /platform\.error\.description/);
  assert.match(errorSource, /onClick=\{reset\}/);
  assert.match(loadingSource, /aria-busy="true"/);
  assert.match(errorSource, /PlatformBoundary\.module\.css/);
  assert.match(loadingSource, /PlatformBoundary\.module\.css/);
  assert.doesNotMatch(errorSource, /PlatformConsole\.module\.css/);
  assert.doesNotMatch(loadingSource, /PlatformConsole\.module\.css/);
  const rowActions = componentSource.slice(componentSource.indexOf("<div className={styles.rowActions}"), componentSource.indexOf("</div></td>", componentSource.indexOf("<div className={styles.rowActions}")));
  assert.equal(rowActions.match(/disabled=\{loadingTenants \|\|/gu)?.length, 7);
});

test("operator states, provisioning choices, metering totals, and session recovery remain truthful", () => {
  const danger = componentSource.indexOf('["FAILED", "UNHEALTHY", "REVOKED", "DENIED"]');
  const success = componentSource.indexOf('["HEALTHY", "ACTIVE", "WORKING", "COMPLETE", "APPROVED"]');
  assert.ok(danger > 0 && danger < success, "UNHEALTHY must be classified before HEALTHY");
  assert.match(componentSource, /<select dir="ltr" name="zammadVersion" defaultValue="7\.1\.3">/u);
  assert.doesNotMatch(componentSource, /defaultValue="7\.0\.1"/u);
  assert.match(componentSource, /const estimatedByCurrency = new Map<string, number>\(\)/u);
  assert.match(componentSource, /\[\.\.\.estimatedByCurrency\]\.map/u);
  assert.doesNotMatch(componentSource, /usage\.usage\.reduce\(\(sum, row\) => sum \+ Number\(row\.estimated_cost_micros/u);
  assert.match(platformClientSource, /window\.location\.pathname.*window\.location\.search.*window\.location\.hash/u);
  assert.doesNotMatch(componentSource, /<Status value="HEALTHY" label=\{t\("platform\.workers\.healthyRatio"/u);
  assert.match(componentSource, /overview\.metering_capture/);
  assert.match(componentSource, /monthCostSummary/);
  // The overview month is the UTC calendar month (#263), so the label says so in both languages.
  for (const key of ["platform.summary.monthCost", "platform.summary.monthCostUnpriced"] as const) {
    assert.match(englishPlatformMessages[key], /this month \(UTC\)/u, key);
    assert.match(arabicPlatformMessages[key], /هذا الشهر بتوقيت UTC/u, key);
  }
  assert.match(componentSource, /name="name" required minLength=\{2\} maxLength=\{120\}/u);
  assert.match(componentSource, /name="displayName" required maxLength=\{120\}/u);
  assert.match(componentSource, /name="email" required type="email" maxLength=\{320\}/u);
  assert.match(componentSource, /name="region" required maxLength=\{63\} pattern=\{"\[a-z0-9\]/u);
  assert.match(recoveryMigrationSource, /'allowed_actions',allowed_actions/u);
  assert.match(recoveryMigrationSource, /p\.status IN \('FAILED','FAILED_RETRYABLE'\)[\s\S]*jsonb_build_array\('RETRY'\)/u);
  assert.match(recoveryMigrationSource, /t\.state='ACTIVE' AND p\.status='COMPLETE' AND z\.state='WORKING'[\s\S]*jsonb_build_array\('SUSPEND'\)/u);
  assert.match(recoveryMigrationSource, /t\.state='SUSPENDED' AND p\.status='SUSPENDED' AND z\.state='SUSPENDED'[\s\S]*jsonb_build_array\('RESUME'\)/u);
});

test("tenant and platform authentication preserve query-driven deep links", () => {
  assert.match(tenantPageSource, /loadControlPlanePage\(appReturnPath\(query\)\)/u);
  assert.match(tenantPageSource, /parameters\.append\(key, entry\)/u);
  assert.match(tenantPageSource, /encodeURIComponent\(returnTo\)/u);
  assert.match(pageSource, /const returnTo = platformReturnPath\(query\)/u);
  assert.match(pageSource, /redirect\(platformLoginPath\(returnTo\)\)/u);
  assert.match(pageSource, /parameters\.append\(key, entry\)/u);
});

test("platform operator copy is bilingual, locale-selectable, and RTL-safe", () => {
  assert.deepEqual(
    Object.keys(arabicPlatformMessages).sort(),
    Object.keys(englishPlatformMessages).sort(),
  );
  assert.equal(arabicPlatformMessages["platform.actions.support"], "طلب صلاحية الدعم");
  assert.equal(englishPlatformMessages["platform.actions.support"], "Request support access");
  assert.match(formatNumber(1234, "ar"), /[١٢٣٤]/u);
  assert.notEqual(
    formatDateTime("2026-08-16T08:00:00.000Z", "ar"),
    formatDateTime("2026-08-16T08:00:00.000Z", "en"),
  );
  assert.match(componentSource, /dir=\{direction\}/);
  assert.match(componentSource, /className="skip-link" href="#platform-main"/u);
  assert.match(componentSource, /id="platform-main" tabIndex=\{-1\}/u);
  assert.match(componentSource, /<bdi[^>]+dir="ltr"[^>]*>\{tenant\.tenant_id\}<\/bdi>/);
  assert.match(componentSource, /<bdi[^>]+dir="ltr"[^>]*>\{worker\.worker_key\}<\/bdi>/);
  assert.match(componentSource, /<LocaleSwitcher locale=\{locale\}/u);
  assert.match(localeSwitcherSource, /const localeFocusKey = "wasalx:locale-focus"/u);
  assert.match(localeSwitcherSource, /fieldsetRef/u);
  assert.match(cssSource, /margin-inline-start: var\(--wx-sidebar-width\)/);
  assert.match(cssSource, /border-inline-end:/);
  assert.match(cssSource, /unicode-bidi: isolate/);
  assert.doesNotMatch(cssSource, /(?:border|margin|padding)-(?:left|right):/);
});

test("operator shell remains operable on mobile and protects in-progress work", () => {
  assert.match(componentSource, /aria-controls="platform-navigation"/u);
  assert.match(componentSource, /data-mobile-navigation-open=\{mobileNavigationOpen\}/u);
  assert.match(componentSource, /window\.addEventListener\("hashchange", syncActiveSection\)/u);
  assert.match(componentSource, /aria-current=\{activeSection === "overview" \? "page" : undefined\}/u);
  assert.doesNotMatch(componentSource, /aria-current="page"/u);
  assert.match(cssSource, /\.sidebar\[data-mobile-navigation-open="false"\] \.navigation \{ display: none; \}/u);
  assert.match(cssSource, /\.navigation a \{ display: flex; min-height: 44px;/u);
  assert.match(componentSource, /role="region"[\s\S]{0,320}tabIndex=\{0\}[\s\S]{0,160}platform\.tenants\.tableLabel/u);
  assert.match(cssSource, /\.tableScroll:focus-visible/u);
  assert.match(cssSource, /@media \(pointer: coarse\)/u);
  assert.match(componentSource, /data-unsaved=\{dirty \|\| undefined\}/u);
  assert.match(componentSource, /<InlineConfirmation[\s\S]{0,500}platform\.dialog\.discard\.keepEditing/u);
  assert.match(componentSource, /<InlineConfirmation busy=\{busy\}[\s\S]{0,500}platform\.support\.endConfirmTitle/u);
  assert.match(componentSource, /<ModalDialog close=\{requestClose\}/u);
  assert.match(cssSource, /height: 100dvh/u);
  assert.match(cssSource, /env\(safe-area-inset-top\)/u);
  assert.match(cssSource, /place-items: safe center/u);
});

test("operator preferences persist and unknown states fail to localized safe copy", () => {
  assert.match(componentSource, /localStorage\.getItem\(PLATFORM_THEME_KEY\)/u);
  assert.match(componentSource, /rememberBoundaryTheme\("platform",next\)/u);
  assert.match(componentSource, /t\("platform\.states\.unavailable"\)/u);
  assert.equal(englishPlatformMessages["platform.states.unavailable"], "Status unavailable");
  assert.equal(arabicPlatformMessages["platform.states.unavailable"], "الحالة غير متاحة");
});

test("operator console feature CSS uses WasalX design tokens and responsive states", () => {
  assert.match(cssSource, /var\(--wx-color-page\)/);
  assert.match(cssSource, /var\(--wx-space-4\)/);
  assert.match(cssSource, /@media \(max-width: 48rem\)/);
  assert.doesNotMatch(cssSource, /#[0-9a-f]{3,8}\b/iu);
  assert.match(boundaryCssSource, /var\(--wx-color-page\)/);
  assert.match(boundaryCssSource, /var\(--wx-space-4\)/);
  assert.doesNotMatch(boundaryCssSource, /#[0-9a-f]{3,8}\b/iu);
});

test("platform session rejects expired or incomplete records", () => {
  assert.throws(
    () =>
      assertPlatformPortalSession({
        version: 1,
        accessToken: "token",
        subject: "operator",
        email: "operator@example.test",
        displayName: "Operator",
        authenticatedAt: Math.floor(Date.now() / 1_000) - 30,
        expiresAt: Math.floor(Date.now() / 1_000) - 1,
        csrfToken: "csrf",
      }),
    /invalid or expired/,
  );
});
