import { NextResponse } from "next/server";
import { platformOidcLogoutUrl } from "../../../../lib/platform-oidc";
import {
  parsePlatformCookies,
  platformSessionCookieName,
  secureCookies,
} from "../../../../lib/platform-portal-session";
import { oidcTransactionFamilyNames } from "../../../../lib/oidc-transaction-cookies";
import { deleteStoredPlatformSession } from "../../../../lib/platform-portal-session-store";
import {
  authenticatePlatformPortalRequest,
  platformAuthErrorResponse,
} from "../../../../lib/platform-request-auth";

export async function POST(request: Request) {
  try {
    await authenticatePlatformPortalRequest(request);
    const redirectTo=platformOidcLogoutUrl(new URL(request.url).searchParams.get("return_to")).toString();
    const sessionId = parsePlatformCookies(request.headers.get("cookie") ?? "").get(
      platformSessionCookieName(),
    );
    await deleteStoredPlatformSession(sessionId);
    const response = NextResponse.json({ redirectTo });
    response.cookies.set(platformSessionCookieName(), "", {
      httpOnly: true,
      secure: secureCookies(),
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    for(const name of oidcTransactionFamilyNames(parsePlatformCookies(request.headers.get("cookie")??""),"wasalx_platform_oidc",secureCookies())){
      response.cookies.set(name,"",{httpOnly:true,secure:secureCookies(),sameSite:"lax",path:"/",maxAge:0});
    }
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return platformAuthErrorResponse(error);
  }
}
