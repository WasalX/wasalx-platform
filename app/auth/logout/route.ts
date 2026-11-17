import { NextResponse } from "next/server";
import { oidcLogoutUrl } from "../../../lib/oidc";
import { authenticatePortalRequest, authErrorResponse } from "../../../lib/request-auth";
import { oidcTransactionFamilyNames } from "../../../lib/oidc-transaction-cookies";
import { cookieSecure, parseCookies, sessionCookieName } from "../../../lib/portal-session";
import { deleteStoredPortalSession } from "../../../lib/portal-session-store";

export async function POST(request:Request){
  try{
    await authenticatePortalRequest(request);
    const url=new URL(request.url);const sessionId=parseCookies(request.headers.get("cookie")??"").get(sessionCookieName());
    const redirectTo=oidcLogoutUrl(url.searchParams.get("return_to")).toString();
    await deleteStoredPortalSession(sessionId);
    const response=NextResponse.json({redirectTo});
    const cookies=parseCookies(request.headers.get("cookie")??"");
    for(const name of [sessionCookieName(),...oidcTransactionFamilyNames(cookies,"wasalx_oidc",cookieSecure()),...oidcTransactionFamilyNames(cookies,"wasalx_invitation_oidc",cookieSecure())])
      response.cookies.set(name,"",{httpOnly:true,secure:cookieSecure(),sameSite:"lax",path:"/",maxAge:0});
    response.headers.set("cache-control","no-store");
    return response;
  }catch(error){return authErrorResponse(error)}
}
