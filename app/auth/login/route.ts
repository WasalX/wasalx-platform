import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { isControlPlaneBackend } from "../../../lib/backend";
import { authorizationUrl, createOidcTransaction } from "../../../lib/oidc";
import { getRequestLocale } from "../../../lib/i18n/request-locale.ts";
import { OIDC_TRANSACTION_MAX_AGE_SECONDS, oidcTransactionCookieEvictions } from "../../../lib/oidc-transaction-cookies";
import { cookieSecure, getPortalSessionFromRequest, parseCookies, PortalSessionError, portalPublicOrigin, sealPortalValue, transactionCookieName, unsealPortalValue } from "../../../lib/portal-session";

export async function GET(request:Request){
  if(!isControlPlaneBackend())notFound();
  const url=new URL(request.url);
  if(url.origin!==portalPublicOrigin())return NextResponse.redirect(new URL(`${url.pathname}${url.search}`,portalPublicOrigin()),307);
  let stepUp=url.searchParams.get("step_up")==="privileged"?"privileged" as const:undefined;
  let current:Awaited<ReturnType<typeof getPortalSessionFromRequest>>|undefined;
  if(stepUp){
    try{current=await getPortalSessionFromRequest(request)}
    catch(error){if(!(error instanceof PortalSessionError)||error.status>=500)throw error;stepUp=undefined}
  }
  const locale=await getRequestLocale();
  const {transaction,challenge}=await createOidcTransaction({
    returnTo:url.searchParams.get("return_to")??undefined,
    tenantId:current?.tenantId??url.searchParams.get("tenant_id")??undefined,
    stepUp,
  });
  const target=authorizationUrl(transaction,challenge,locale);
  // "Sign in with another account" must show the identity provider's form instead of silently reusing the current session.
  if(url.searchParams.get("prompt")==="login")target.searchParams.set("prompt","login");
  const response=NextResponse.redirect(target);
  const cookies=parseCookies(request.headers.get("cookie")??"");
  for(const name of await oidcTransactionCookieEvictions(cookies,"wasalx_oidc",cookieSecure(),unsealPortalValue))
    response.cookies.set(name,"",{httpOnly:true,secure:cookieSecure(),sameSite:"lax",path:"/",maxAge:0});
  response.cookies.set(transactionCookieName(transaction.state),await sealPortalValue(transaction),{httpOnly:true,secure:cookieSecure(),sameSite:"lax",path:"/",maxAge:OIDC_TRANSACTION_MAX_AGE_SECONDS});response.headers.set("cache-control","no-store");return response;
}
