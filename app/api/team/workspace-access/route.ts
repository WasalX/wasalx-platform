import { NextResponse } from "next/server";
import { workspaceAccess } from "../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../lib/request-auth";

const headers = { "cache-control": "private, no-store" };
export async function GET(request: Request) {
  try {
    await authenticatePortalRequest(request, "team:read");
    const userId = new URL(request.url).searchParams.get("userId");
    return NextResponse.json(await workspaceAccess(userId ? { action: "candidates", userId } : { action: "status" }), { headers });
  } catch (error) { return authErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    await authenticatePortalRequest(request, "team:write");
    const body = await request.json() as Record<string, unknown>;
    return NextResponse.json(await workspaceAccess(body), { headers });
  } catch (error) { return authErrorResponse(error); }
}
