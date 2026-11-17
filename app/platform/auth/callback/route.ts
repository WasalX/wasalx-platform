import { NextResponse } from "next/server";
import {
  completePlatformOidcLogin,
  validPlatformOidcTransaction,
  type PlatformOidcTransaction,
} from "../../../../lib/platform-oidc";
import {
  parsePlatformCookies,
  platformPortalOrigin,
  platformSessionCookieName,
  platformTransactionCookieName,
  secureCookies,
  unsealPlatformValue,
} from "../../../../lib/platform-portal-session";
import {
  createStoredPlatformSession,
  deleteStoredPlatformSession,
} from "../../../../lib/platform-portal-session-store";
import { validOidcState } from "../../../../lib/oidc-transaction-cookies";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");
  const cookies = parsePlatformCookies(request.headers.get("cookie") ?? "");
  const transactionValue = validOidcState(state) ? cookies.get(platformTransactionCookieName(state)) : undefined;
  if (providerError || !code || !validOidcState(state) || !transactionValue) {
    console.warn(
      JSON.stringify({
        event: "platform_oidc_callback_rejected",
        providerError: Boolean(providerError),
        codePresent: Boolean(code),
        statePresent: Boolean(state),
        transactionCookiePresent: Boolean(transactionValue),
      }),
    );
    return failure("invalid_callback",validOidcState(state)?state:undefined);
  }
  try {
    const transaction = await unsealPlatformValue<PlatformOidcTransaction>(
      transactionValue,
    );
    if (!validPlatformOidcTransaction(transaction) || transaction.state !== state) {
      return failure("invalid_state",state);
    }
    const stored = await createStoredPlatformSession(
      await completePlatformOidcLogin({ code, transaction }),
    );
    const previousSessionId = cookies.get(platformSessionCookieName());
    if (previousSessionId && previousSessionId !== stored.id) {
      await deleteStoredPlatformSession(previousSessionId);
    }
    const response = NextResponse.redirect(
      new URL(transaction.returnTo, platformPortalOrigin()),
    );
    response.cookies.set(platformSessionCookieName(), stored.id, {
      httpOnly: true,
      secure: secureCookies(),
      sameSite: "lax",
      path: "/",
      maxAge: stored.maxAge,
    });
    clearTransaction(response,state);
    response.headers.set("cache-control", "no-store");
    return response;
  } catch {
    return failure("authentication_failed",state);
  }
}

function failure(reason: string,state?:string) {
  const response = NextResponse.redirect(
    new URL(
      `/platform/auth/error?reason=${encodeURIComponent(reason)}`,
      platformPortalOrigin(),
    ),
  );
  if(validOidcState(state))clearTransaction(response,state);
  response.headers.set("cache-control", "no-store");
  return response;
}

function clearTransaction(response: NextResponse,state:string) {
  response.cookies.set(platformTransactionCookieName(state), "", {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
