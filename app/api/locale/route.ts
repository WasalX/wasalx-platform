import { NextResponse } from "next/server";
import { parseLocaleRequest } from "../../../lib/i18n/locale-request.ts";
import {
  localeCookieName,
  localeCookieSecure,
} from "../../../lib/i18n/request-locale.ts";

export async function POST(request: Request) {
  const result = await parseLocaleRequest(request);
  if (!result.ok) {
    return NextResponse.json(
      { code: result.code },
      { status: result.status, headers: { "cache-control": "no-store" } },
    );
  }

  const response = new NextResponse(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
  response.cookies.set(localeCookieName(), result.locale, {
    httpOnly: true,
    secure: localeCookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  });
  return response;
}
