import { NextResponse } from "next/server";
import { getTeamAccess } from "../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../lib/request-auth";

export async function GET(request: Request) {
  try {
    await authenticatePortalRequest(request, "team:read");
    return NextResponse.json(await getTeamAccess(), { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return authErrorResponse(error); }
}
