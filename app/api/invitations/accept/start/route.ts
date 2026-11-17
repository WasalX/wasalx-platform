import { NextResponse } from "next/server";
import { isControlPlaneBackend } from "../../../../../lib/backend";
import {
  createInvitationOidcTransaction,
  invitationAuthorizationUrl,
  InvitationRequestTooLargeError,
  invitationTransactionCookieName,
  readBoundedInvitationRequest,
  validInvitationToken,
} from "../../../../../lib/invitation-oidc";
import {
  cookieSecure,
  parseCookies,
  portalPublicOrigin,
  sealPortalValue,
  unsealPortalValue,
} from "../../../../../lib/portal-session";
import { OIDC_TRANSACTION_MAX_AGE_SECONDS, oidcTransactionCookieEvictions } from "../../../../../lib/oidc-transaction-cookies";

export async function POST(request: Request) {
  if (!isControlPlaneBackend()) {
    return NextResponse.json({ error: "Invitation acceptance is unavailable for this portal target" }, { status: 404 });
  }
  if (request.headers.get("origin") !== portalPublicOrigin()) {
    return NextResponse.json({ error: "The invitation request origin is invalid" }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return NextResponse.json({ error: "JSON is required" }, { status: 415 });
  }
  let body: unknown;
  try {
    const raw = await readBoundedInvitationRequest(request);
    body = JSON.parse(raw);
  } catch (error) {
    if (error instanceof InvitationRequestTooLargeError) {
      return NextResponse.json({ error: "The invitation request is too large" }, { status: 413 });
    }
    return NextResponse.json({ error: "The invitation token is invalid" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || !("token" in body) || !validInvitationToken(body.token)) {
    return NextResponse.json({ error: "The invitation token is invalid" }, { status: 400 });
  }
  const { transaction, challenge } = await createInvitationOidcTransaction(body.token);
  const response = NextResponse.json({ authorizeUrl: invitationAuthorizationUrl(transaction, challenge).toString() });
  const cookies=parseCookies(request.headers.get("cookie")??"");
  for(const name of await oidcTransactionCookieEvictions(cookies,"wasalx_invitation_oidc",cookieSecure(),unsealPortalValue)){
    response.cookies.set(name,"",{httpOnly:true,secure:cookieSecure(),sameSite:"lax",path:"/",maxAge:0});
  }
  response.cookies.set(invitationTransactionCookieName(transaction.state), await sealPortalValue(transaction), {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: OIDC_TRANSACTION_MAX_AGE_SECONDS,
  });
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
