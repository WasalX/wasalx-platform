import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getMessages } from "../lib/i18n/messages/index.ts";
import { getBoundaryMessages } from "../lib/i18n/messages/boundary.ts";
import { createTranslator } from "../lib/i18n/translate.ts";
import { authorizationUrl, oidcLogoutUrl } from "../lib/oidc.ts";
import { invitationAuthorizationUrl } from "../lib/invitation-oidc.ts";
import { platformAuthorizationUrl, platformOidcLogoutUrl } from "../lib/platform-oidc.ts";
import { recoverySurface, resolveBoundaryLocale, resolveBoundaryTheme } from "../app/boundary-preferences.ts";

const files = {
  layout: new URL("../app/layout.tsx", import.meta.url),
  page: new URL("../app/app/page.tsx", import.meta.url),
  tenantLoading: new URL("../app/app/loading.tsx", import.meta.url),
  tenantError: new URL("../app/app/error.tsx", import.meta.url),
  platformError: new URL("../app/platform/error.tsx", import.meta.url),
  globalError: new URL("../app/global-error.tsx", import.meta.url),
  tenantApp: new URL("../app/WasalXApp.tsx",import.meta.url),
  platformConsole: new URL("../app/platform/PlatformConsole.tsx",import.meta.url),
  tenantLogout: new URL("../app/auth/logout/route.ts",import.meta.url),
  platformLogout: new URL("../app/platform/auth/logout/route.ts",import.meta.url),
  marketing: new URL("../app/page.tsx", import.meta.url),
  authError: new URL("../app/auth/error/page.tsx", import.meta.url),
  authLogin: new URL("../app/auth/login/route.ts", import.meta.url),
  authCallback: new URL("../app/auth/callback/route.ts", import.meta.url),
  platformAuthLogin: new URL("../app/platform/auth/login/route.ts", import.meta.url),
  invitationAcceptPage: new URL("../app/invitations/accept/page.tsx", import.meta.url),
  invitationAcceptClient: new URL("../app/invitations/accept/InvitationAcceptance.tsx", import.meta.url),
  invitationResult: new URL("../app/invitations/result/page.tsx", import.meta.url),
};

test("server document and metadata resolve one request locale without hydration suppression", async () => {
  const [layout, page] = await Promise.all([readFile(files.layout, "utf8"), readFile(files.page, "utf8")]);
  assert.match(layout, /getRequestLocale\(\)/u);
  assert.match(layout, /<html lang=\{locale\} dir=\{textDirection\(locale\)\}>/u);
  assert.match(layout, /<BoundaryPreferenceSeed value=\{\{locale,tenantTheme,platformTheme\}\}>/u);
  assert.match(layout, /__Host-wasalx_theme/u);
  assert.match(layout, /__Host-wasalx_platform_theme/u);
  assert.doesNotMatch(layout, /suppressHydrationWarning/u);
  assert.match(layout, /translate\("common\.metadata\.defaultTitle"\)/u);
  assert.match(layout, /translate\("common\.metadata\.description"\)/u);
  assert.match(page, /export async function generateMetadata/u);
  assert.match(page, /translate\(tenantViewTitle\(requested\)\[0\]\)/u);

  const english = createTranslator(getMessages("en"));
  const arabic = createTranslator(getMessages("ar"));
  assert.equal(english("common.metadata.defaultTitle"), "WasalX — Connected support operations");
  assert.equal(arabic("common.metadata.defaultTitle"), "WasalX — عمليات دعم مترابطة");
  assert.equal(english("tenant.navigation.overview"), "Overview");
  assert.equal(arabic("tenant.navigation.overview"), "نظرة عامة");
});

test("tenant startup has localized loading and safe recovery boundaries", async () => {
  const [loading, error] = await Promise.all([
    readFile(files.tenantLoading, "utf8"),
    readFile(files.tenantError, "utf8"),
  ]);
  assert.match(loading, /const \[locale, cookieStore\] = await Promise\.all\(\[getRequestLocale\(\), cookies\(\)\]\)/u);
  assert.match(loading, /createTranslator\(getMessages\(locale\)\)/u);
  assert.match(loading, /dir=\{textDirection\(locale\)\}/u);
  assert.match(loading, /lang=\{locale\}/u);
  assert.match(loading, /value === "dark" \|\| value === "light"/u);
  assert.match(loading, /aria-busy="true"/u);
  assert.match(loading, /tenant\.loading\.workspace/u);
  assert.match(error, /tenant\.boundary\.error\.heading/u);
  assert.match(error, /tenant\.boundary\.error\.description/u);
  assert.match(error, /useBoundaryPreferences/u);
  assert.match(error, /useBoundaryPreferences\("tenant"\)/u);
  assert.match(error, /data-boundary-recovery/u);
  assert.match(error, /theme-\$\{theme\}/u);
  assert.match(error, /textDirection\(locale\)/u);
  assert.match(error, /onClick=\{reset\}/u);
  assert.match(error, /\/auth\/login\?return_to=\/app/u);
  assert.doesNotMatch(error, /error\.message/u);

  const english = getMessages("en");
  const arabic = getMessages("ar");
  for (const key of ["tenant.loading.workspace", "tenant.boundary.error.heading", "tenant.boundary.error.description"]) {
    assert.ok(english[key].trim(), `${key} must have English copy`);
    assert.ok(arabic[key].trim(), `${key} must have Arabic copy`);
  }
});

test("global recovery follows the active locale and theme",async()=>{
  const [source,platformError,boundary]=await Promise.all([files.globalError,files.platformError,new URL("../app/boundary-preferences.ts",import.meta.url)].map(file=>readFile(file,"utf8")));
  assert.match(source,/textDirection\(locale\)/u);
  assert.match(source,/theme-\$\{theme\}/u);
  assert.match(source,/tenant\.boundary\.error\.heading/u);
  assert.match(source,/platform\.error\.heading/u);
  assert.match(source,/common\.boundary\.error\.heading/u);
  assert.match(source,/useBoundaryPreferences\(undefined,true\)/u);
  assert.match(source,/type BoundaryMessageKey/u);
  assert.match(source,/lang="en" dir="ltr"/u);
  assert.match(source,/lang="ar" dir="rtl"/u);
  assert.match(source,/data-boundary-recovery/u);
  assert.match(boundary,/BoundaryPreferenceSeed/u);
  assert.match(boundary,/\.theme-dark:not\(\[data-boundary-recovery\]\)/u);
  assert.match(boundary,/document\.cookie/u);
  assert.equal(recoverySurface("/"),"public");
  assert.equal(recoverySurface("/app?view=groups"),"tenant");
  assert.equal(recoverySurface("/platform"),"platform");
  assert.equal(resolveBoundaryLocale({stored:"ar",documentLanguage:"en",navigatorLanguage:"en-US",documentIsFallback:true}),"ar");
  assert.equal(resolveBoundaryLocale({documentLanguage:"ar-SA",navigatorLanguage:"en-US"}),"ar");
  assert.equal(resolveBoundaryLocale({documentLanguage:"en",navigatorLanguage:"ar-SA",documentIsFallback:true}),"ar");
  assert.equal(resolveBoundaryTheme({stored:"light",domTheme:"dark",prefersLight:false,documentIsFallback:true}),"light");
  assert.equal(resolveBoundaryTheme({domTheme:"dark",prefersLight:true,documentIsFallback:true}),"light");
  assert.equal(resolveBoundaryTheme({domTheme:"dark",prefersLight:true}),"dark");
  assert.equal(createTranslator(getMessages("en"))("common.boundary.error.heading"),"WasalX is temporarily unavailable");
  assert.equal(createTranslator(getMessages("ar"))("common.boundary.error.heading"),"WasalX غير متاح مؤقتًا");
  assert.doesNotMatch(source,/>WasalX is temporarily unavailable/u);
  assert.doesNotMatch(source,/error\.message/u);
  assert.match(platformError,/useBoundaryPreferences/u);
  assert.match(platformError,/useBoundaryPreferences\("platform"\)/u);
  assert.match(platformError,/theme-\$\{theme\}/u);
  assert.match(platformError,/textDirection\(locale\)/u);
  assert.match(platformError,/aria-hidden="true"/u);
  assert.doesNotMatch(platformError,/error\.message/u);
});

test("error boundaries carry only their own catalogue-equal strings in both locales",async()=>{
  const boundaryModule=new URL("../lib/i18n/messages/boundary.ts",import.meta.url);
  const sources=await Promise.all([files.tenantError,files.platformError,files.globalError,boundaryModule].map(file=>readFile(file,"utf8")));
  for (const source of sources) {
    // A value import of the catalogue would put every English and Arabic string in the first load.
    assert.doesNotMatch(source,/^import(?!\s+type\b)[^;]*messages\/(?:index|en\/|ar\/)/mu);
    assert.doesNotMatch(source,/\bgetMessages\(/u);
  }
  const [tenantError,platformError,globalError]=sources;
  for (const source of [tenantError,platformError,globalError]) assert.match(source,/getBoundaryMessages\(/u);
  for (const locale of ["en","ar"]) {
    const subset=getBoundaryMessages(locale);
    const catalogue=getMessages(locale);
    assert.ok(Object.keys(subset).length>0);
    for (const [key,value] of Object.entries(subset)) {
      assert.ok(value.trim(),`${locale} ${key} must have copy`);
      assert.equal(value,catalogue[key],`${locale} ${key} must match the catalogue`);
    }
  }
  assert.notEqual(getBoundaryMessages("ar")["tenant.boundary.error.heading"],getBoundaryMessages("en")["tenant.boundary.error.heading"]);
  const usedKeys=new Set(sources.slice(0,3).join("\n").match(/"(?:common|tenant|platform)\.[A-Za-z.]+"/gu).map(key=>key.slice(1,-1)));
  assert.deepEqual([...usedKeys].sort(),Object.keys(getBoundaryMessages("en")).sort());
});

test("tenant and platform sign-out hand off to the configured OIDC logout endpoint",async()=>{
  const [tenantApp,platformConsole,tenantRoute,platformRoute]=await Promise.all([files.tenantApp,files.platformConsole,files.tenantLogout,files.platformLogout].map(file=>readFile(file,"utf8")));
  assert.match(tenantApp,/window\.location\.assign\(result\.redirectTo\)/u);
  assert.match(platformConsole,/window\.location\.assign\(result\.redirectTo\)/u);
  assert.match(tenantRoute,/oidcLogoutUrl/u);
  assert.match(platformRoute,/platformOidcLogoutUrl/u);
});

test("public landing metadata and content use the bilingual catalog", async () => {
  const marketing = await readFile(files.marketing, "utf8");
  assert.match(marketing, /marketing\.metadata\.title/u);
  assert.match(marketing, /marketing\.hero\.title/u);
  assert.match(marketing, /MarketingInbox/u);
  assert.match(marketing, /marketing\.groups\.title/u);
  assert.match(marketing, /process\.env\.PUBLIC_CONTACT_EMAIL/u);
  assert.match(marketing, /\/auth\/login\?return_to=\/app/u);
  assert.match(marketing, /redirect\(`\/app\?\$\{legacy\.toString\(\)\}`\)/u);
  assert.doesNotMatch(marketing, /I18nProvider/u);
  assert.match(getMessages("en")["marketing.hero.title"], /All your conversations/u);
  assert.match(getMessages("ar")["marketing.hero.title"], /كل محادثاتك/u);
  assert.match(getMessages("en")["marketing.inbox.groupMessage"], /Shipment #4821/u);
  assert.match(getMessages("ar")["marketing.inbox.groupMessage"], /الشحنة رقم 4821/u);
  assert.equal(getMessages("en")["marketing.contact.email"], "contact@example.invalid");
  assert.equal(getMessages("ar")["marketing.contact.email"], "contact@example.invalid");
  assert.equal(getMessages("en")["marketing.channels.soon"], "Coming soon");
  assert.match(getMessages("ar")["marketing.channels.soon"], /قريبًا/u);
});

test("public marketing and case copy uses customer language in English and Arabic", () => {
  const english = getMessages("en");
  const arabic = getMessages("ar");
  const copy = (dictionary, prefixes) => Object.entries(dictionary)
    .filter(([key]) => prefixes.some((prefix) => key.startsWith(prefix)))
    .map(([, value]) => value)
    .join("\n");

  assert.doesNotMatch(
    copy(english, ["marketing.", "cases."]),
    /deterministic|tenant[- ]isolated|tenant-owned|immutable|audit record|uncertain outcomes|case correlations?|identifier generations?|side effects|versioned policies|case lifecycle/iu,
  );
  assert.doesNotMatch(
    copy(arabic, ["marketing.", "cases."]),
    /الحتمي|المستأجر|نسخة ثابتة|سجل التدقيق|النتائج غير المؤكدة|ارتباطات الحالات|أجيال المعرّفات|دورة حياة/u,
  );
  assert.equal(english["cases.title"], "Linked support cases");
  assert.equal(arabic["cases.title"], "حالات الدعم المرتبطة");
  assert.equal(english["cases.dialog.confirm"], "End current link");
  assert.equal(arabic["cases.dialog.confirm"], "إنهاء الرابط الحالي");
});

test("authentication error initial HTML is sourced entirely from bilingual messages", async () => {
  const [page, login, platformLogin,callback] = await Promise.all([
    readFile(files.authError, "utf8"),
    readFile(files.authLogin, "utf8"),
    readFile(files.platformAuthLogin, "utf8"),
    readFile(files.authCallback,"utf8"),
  ]);
  for (const key of [
    "auth.error.metadataTitle",
    "auth.error.invalidState",
    "auth.error.default",
    "auth.error.expired",
    "auth.error.identity",
    "auth.error.membership",
    "auth.error.unavailable",
    "auth.error.title",
    "auth.error.action",
  ]) {
    assert.match(page, new RegExp(key.replaceAll(".", "\\."), "u"));
  }
  assert.doesNotMatch(page, />Sign-in could not be completed</u);
  assert.match(login, /getRequestLocale\(\)/u);
  assert.match(login, /authorizationUrl\(transaction,challenge,locale\)/u);
  for (const route of [login,platformLogin]) {
    assert.match(route,/notFound\(\)/u);
    assert.doesNotMatch(route,/NextResponse\.json|OIDC login is unavailable|platform\.auth\.unavailable/u);
  }

  const arabic = createTranslator(getMessages("ar"));
  assert.match(arabic("auth.error.invalidState"), /نتحقّق/u);
  assert.match(arabic("auth.error.default"), /عضوية/u);
  assert.match(page,/Object\.hasOwn\(authenticationErrorDetails,reason\)/u);
  assert.match(callback,/providerError\)return failure\(providerError==="server_error"\|\|providerError==="temporarily_unavailable"\?"unavailable":"identity",state\)/u);
  assert.match(callback,/!validOidcState\(state\)\)return failure\("expired"\)/u);
  assert.match(callback,/!transactionValue\)return failure\("expired",state\)/u);
  assert.ok(callback.indexOf("transaction.state!==state") < callback.indexOf("if(providerError)"));
  assert.match(callback,/error instanceof OidcLoginError\)return failure\(error\.reason,state\)/u);
  assert.doesNotMatch(callback,/error\.message/u);
});

test("invitation accept and terminal failure states have complete English and Arabic server copy", async () => {
  const [acceptPage, acceptClient, result] = await Promise.all([
    readFile(files.invitationAcceptPage, "utf8"),
    readFile(files.invitationAcceptClient, "utf8"),
    readFile(files.invitationResult, "utf8"),
  ]);
  assert.match(acceptPage, /getRequestLocale\(\)/u);
  assert.match(acceptPage, /<InvitationAcceptance locale=\{locale\} copy=\{copy\}/u);
  assert.match(acceptClient, /authorizationUrl\.searchParams\.set\("ui_locales", locale\)/u);
  assert.match(acceptClient, /window\.history\.replaceState\(null, "", window\.location\.pathname\)/u);
  assert.match(acceptClient, /window\.location\.assign\(result\.authorizeUrl\)/u);
  assert.doesNotMatch(acceptClient, />Preparing your secure invitation</u);
  assert.doesNotMatch(acceptClient, />Try again</u);

  for (const state of [
    "expired_or_used",
    "identity_mismatch",
    "identity_unverified",
    "membership_conflict",
    "authentication_failed",
  ]) {
    assert.match(result, new RegExp(`${state}:`, "u"));
  }
  assert.match(result, /translate\(content\.title\)/u);
  assert.match(result, /translate\(content\.detail\)/u);
  assert.match(result, /translate\(content\.action\)/u);
  // Successful acceptance redirects to the app; it is not a terminal result page.
  assert.doesNotMatch(result, /\baccepted(?:_session_pending)?:/u);

  const english = getMessages("en");
  const arabic = getMessages("ar");
  const resultKeys = Object.keys(english).filter((key) => key.startsWith("invitation.result."));
  assert.ok(resultKeys.length >= 20);
  for (const key of resultKeys) {
    assert.ok(english[key].trim(), `${key} must have English copy`);
    assert.ok(arabic[key].trim(), `${key} must have Arabic copy`);
  }
});

test("tenant, invitation, and platform OIDC authorization requests carry an explicit ui_locales hint", () => {
  const snapshot = { ...process.env };
  try {
    Object.assign(process.env, {
      OIDC_ISSUER: "https://identity.wasalx.test",
      OIDC_CLIENT_ID: "wasalx-portal",
      OIDC_AUTHORIZATION_ENDPOINT: "https://identity.wasalx.test/authorize",
      OIDC_END_SESSION_ENDPOINT: "https://identity.wasalx.test/logout",
      OIDC_REDIRECT_URI: "https://portal.wasalx.test/auth/callback",
      OIDC_INVITATION_REDIRECT_URI: "https://portal.wasalx.test/invitations/callback",
      OIDC_PRIVILEGED_ACR_VALUES: "urn:wasalx:loa:2",
      CONTROL_API_URL: "https://control.wasalx.test",
      PORTAL_PUBLIC_ORIGIN: "https://portal.wasalx.test",
      PLATFORM_OPERATOR_OIDC_ISSUER: "https://operator-identity.wasalx.test",
      PLATFORM_OPERATOR_OIDC_CLIENT_ID: "wasalx-platform-portal",
      PLATFORM_OPERATOR_OIDC_AUDIENCE: "wasalx-platform-api",
      PLATFORM_OPERATOR_OIDC_AUTHORIZATION_ENDPOINT: "https://operator-identity.wasalx.test/authorize",
      PLATFORM_OPERATOR_OIDC_END_SESSION_ENDPOINT: "https://operator-identity.wasalx.test/logout",
      PLATFORM_OPERATOR_OIDC_REDIRECT_URI: "https://portal.wasalx.test/platform/auth/callback",
    });
    const transaction = {
      state: "state",
      nonce: "nonce",
      verifier: "verifier",
      returnTo: "/",
      createdAt: Date.now(),
    };
    assert.equal(authorizationUrl(transaction, "challenge", "ar").searchParams.get("ui_locales"), "ar");
    assert.equal(
      invitationAuthorizationUrl(
        { ...transaction, kind: "tenant_invitation", token: "A".repeat(43) },
        "challenge",
        "ar",
      ).searchParams.get("ui_locales"),
      "ar",
    );
    assert.equal(
      platformAuthorizationUrl(transaction, "challenge", "ar").searchParams.get("ui_locales"),
      "ar",
    );
    assert.equal(authorizationUrl(transaction, "challenge").searchParams.get("ui_locales"), "en");
    assert.equal(oidcLogoutUrl("/app?view=groups#selected").searchParams.get("post_logout_redirect_uri"),"https://portal.wasalx.test/app?view=groups");
    assert.equal(platformOidcLogoutUrl("/platform#capacity").searchParams.get("post_logout_redirect_uri"),"https://portal.wasalx.test/platform");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    Object.assign(process.env, snapshot);
  }
});
