import { NextResponse } from "next/server";
import { getCases } from "../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../lib/request-auth";

export async function GET(request: Request) {
  try {
    await authenticatePortalRequest(request, "case:read");
    const url=new URL(request.url);const before=url.searchParams.get("before")??undefined;const limitValue=url.searchParams.get("limit");const limit=limitValue===null?undefined:Number(limitValue);const ticket=url.searchParams.get("ticket")??undefined;
    return NextResponse.json(await getCases({before,limit,ticket}), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
