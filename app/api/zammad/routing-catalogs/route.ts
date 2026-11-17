import { NextResponse } from "next/server";
import { getZammadRoutingCatalog } from "../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../lib/request-auth";

export async function GET(request: Request) {
  try {
    await authenticatePortalRequest(request, "group:read");
    return NextResponse.json(await getZammadRoutingCatalog(), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
