import { NextResponse } from "next/server";
import { authorizationUrl, completeOidcLogin, createOidcTransaction, OidcLoginError, PortalMfaRequiredError, validOidcTransaction, type OidcLoginFailureReason, type OidcTransaction } from "../../../lib/oidc";
import { OIDC_TRANSACTION_MAX_AGE_SECONDS, validOidcState } from "../../../lib/oidc-transaction-cookies";
import { cookieSecure, finalizePortalLoginSession, parseCookies, PortalSessionError, portalPublicOrigin, sealPortalValue, sessionCookieName, transactionCookieName, unsealPortalValue } from "../../../lib/portal-session";
import { getRequestLocale } from "../../../lib/i18n/request-locale";
import { createStoredPortalSession, deleteStoredPortalSession, loadStoredPortalSession } from "../../../lib/portal-session-store";

export async function GET(request:Request){
  const url=new URL(request.url);const code=url.searchParams.get("code");const state=url.searchParams.get("state");const providerError=url.searchParams.get("error");
  if(!validOidcState(state))return failure("expired");
  const transactionValue=parseCookies(request.headers.get("cookie")??"").get(transactionCookieName(state));
  if(!transactionValue)return failure("expired",state);
  let transaction:OidcTransaction;
  try{transaction=await unsealPortalValue<OidcTransaction>(transactionValue)}catch{return failure("expired",state)}
  if(!validOidcTransaction(transaction))return failure("expired",state);
  if(transaction.state!==state)return failure("invalid_state",state);
  if(providerError)return failure(providerError==="server_error"||providerError==="temporarily_unavailable"?"unavailable":"identity",state);
  if(!code)return failure("expired",state);
  try{
    const previousSessionId=parseCookies(request.headers.get("cookie")??"").get(sessionCookieName());
    const previousSession=transaction.stepUp==="privileged"?await loadStoredPortalSession(previousSessionId??""):undefined;
    const session=finalizePortalLoginSession(await completeOidcLogin({code,transaction}),previousSession,transaction.stepUp);
    const stored=await createStoredPortalSession(session);
    if(previousSessionId&&previousSessionId!==stored.id)await deleteStoredPortalSession(previousSessionId);
    const response=NextResponse.redirect(new URL(transaction.returnTo,portalPublicOrigin()));
    response.cookies.set(sessionCookieName(),stored.id,{httpOnly:true,secure:cookieSecure(),sameSite:"lax",path:"/",maxAge:stored.maxAge});
    response.cookies.set(transactionCookieName(state),"",{httpOnly:true,secure:cookieSecure(),sameSite:"lax",path:"/",maxAge:0});
    response.headers.set("cache-control","no-store");
    return response;
  }catch(error){
    if(error instanceof PortalMfaRequiredError){
      const next=await createOidcTransaction({returnTo:transaction.returnTo,tenantId:error.tenantId,stepUp:"required_mfa"});
      const response=NextResponse.redirect(authorizationUrl(next.transaction,next.challenge,await getRequestLocale()));
      response.cookies.set(transactionCookieName(state),"",{httpOnly:true,secure:cookieSecure(),sameSite:"lax",path:"/",maxAge:0});
      response.cookies.set(transactionCookieName(next.transaction.state),await sealPortalValue(next.transaction),{httpOnly:true,secure:cookieSecure(),sameSite:"lax",path:"/",maxAge:OIDC_TRANSACTION_MAX_AGE_SECONDS});
      response.headers.set("cache-control","no-store");
      return response;
    }
    if(error instanceof OidcLoginError)return failure(error.reason,state);
    if(error instanceof PortalSessionError)return failure("expired",state);
    return failure("authentication_failed",state)
  }
}

function failure(reason:OidcLoginFailureReason|"invalid_state"|"authentication_failed",state?:string){
  const response=NextResponse.redirect(new URL(`/auth/error?reason=${encodeURIComponent(reason)}`,portalPublicOrigin()));
  if(validOidcState(state))response.cookies.set(transactionCookieName(state),"",{httpOnly:true,secure:cookieSecure(),sameSite:"lax",path:"/",maxAge:0});
  response.headers.set("cache-control","no-store");
  return response;
}
