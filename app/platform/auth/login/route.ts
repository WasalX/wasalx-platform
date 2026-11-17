import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { isControlPlaneBackend } from "../../../../lib/backend";
import { getRequestLocale } from "../../../../lib/i18n/request-locale.ts";
import {
  createPlatformOidcTransaction,
  platformAuthorizationUrl,
} from "../../../../lib/platform-oidc";
import {
  parsePlatformCookies,
  platformTransactionCookieName,
  sealPlatformValue,
  secureCookies,
  unsealPlatformValue,
} from "../../../../lib/platform-portal-session";
import { OIDC_TRANSACTION_MAX_AGE_SECONDS, oidcTransactionCookieEvictions } from "../../../../lib/oidc-transaction-cookies";
import { portalPublicOrigin } from "../../../../lib/portal-session";

export async function GET(request: Request) {
  if (!isControlPlaneBackend()) {
    notFound();
  }
  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== portalPublicOrigin()) {
    return NextResponse.redirect(new URL(`${requestUrl.pathname}${requestUrl.search}`, portalPublicOrigin()), 307);
  }
  const returnTo = requestUrl.searchParams.get("return_to") ?? undefined;
  const locale = await getRequestLocale();
  const { transaction, challenge } = await createPlatformOidcTransaction(returnTo);
  const response = NextResponse.redirect(
    platformAuthorizationUrl(transaction, challenge, locale),
  );
  const cookies=parsePlatformCookies(request.headers.get("cookie")??"");
  for(const name of await oidcTransactionCookieEvictions(cookies,"wasalx_platform_oidc",secureCookies(),unsealPlatformValue)){
    response.cookies.set(name,"",{httpOnly:true,secure:secureCookies(),sameSite:"lax",path:"/",maxAge:0});
  }
  response.cookies.set(
    platformTransactionCookieName(transaction.state),
    await sealPlatformValue(transaction),
    {
      httpOnly: true,
      secure: secureCookies(),
      sameSite: "lax",
      path: "/",
      maxAge: OIDC_TRANSACTION_MAX_AGE_SECONDS,
    },
  );
  response.headers.set("cache-control", "no-store");
  return response;
}
