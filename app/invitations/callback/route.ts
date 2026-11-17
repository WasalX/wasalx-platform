import { NextResponse } from "next/server";
import {
  completeInvitationAcceptance,
  InvitationAcceptanceError,
  invitationTransactionCookieName,
  validInvitationTransaction,
  type InvitationFailureState,
  type InvitationOidcTransaction,
} from "../../../lib/invitation-oidc";
import {
  cookieSecure,
  parseCookies,
  portalPublicOrigin,
  sessionCookieName,
  unsealPortalValue,
} from "../../../lib/portal-session";
import { validOidcState } from "../../../lib/oidc-transaction-cookies";
import {
  createStoredPortalSession,
  deleteStoredPortalSession,
} from "../../../lib/portal-session-store";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");
  if(!validOidcState(state))return failure("authentication_failed");
  const sealed = parseCookies(request.headers.get("cookie") ?? "").get(invitationTransactionCookieName(state));
  if (providerError || !code || !sealed) return failure("authentication_failed",state);
  let membershipAccepted = false;
  try {
    const transaction = await unsealPortalValue<InvitationOidcTransaction>(sealed);
    if (!validInvitationTransaction(transaction) || transaction.state !== state) {
      return failure("authentication_failed",state);
    }
    const { session } = await completeInvitationAcceptance({ code, transaction });
    membershipAccepted = true;
    const stored = await createStoredPortalSession(session);
    const previousSessionId = parseCookies(request.headers.get("cookie") ?? "").get(sessionCookieName());
    if (previousSessionId && previousSessionId !== stored.id) {
      await deleteStoredPortalSession(previousSessionId);
    }
    const response = NextResponse.redirect(new URL("/app", portalPublicOrigin()));
    response.cookies.set(sessionCookieName(), stored.id, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: "lax",
      path: "/",
      maxAge: stored.maxAge,
    });
    clearTransaction(response,state);
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return failure(membershipAccepted ? "accepted_session_pending" : error instanceof InvitationAcceptanceError ? error.result : "authentication_failed",state);
  }
}

function failure(result: InvitationFailureState,transactionState?:string) {
  const destination = result === "accepted_session_pending"
    ? "/auth/login?return_to=/app"
    : `/invitations/result?state=${encodeURIComponent(result)}`;
  const response = NextResponse.redirect(new URL(destination, portalPublicOrigin()));
  if(validOidcState(transactionState))clearTransaction(response,transactionState);
  response.headers.set("cache-control", "no-store");
  return response;
}

function clearTransaction(response: NextResponse,state:string) {
  response.cookies.set(invitationTransactionCookieName(state), "", {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
