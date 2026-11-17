import { NextResponse } from "next/server";
import { getWorkspaceSettings, updateWorkspaceSettings } from "../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../lib/request-auth";

const NO_STORE = { "cache-control": "private, no-store" };

export async function GET(request: Request) {
  try {
    await authenticatePortalRequest(request, "settings:read");
    return NextResponse.json(await getWorkspaceSettings(), { headers: NO_STORE });
  } catch (error) { return authErrorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const principal = await authenticatePortalRequest(request, "settings:write");
    return NextResponse.json(
      await updateWorkspaceSettings(await request.json() as Record<string, unknown>, principal.displayName),
      { headers: NO_STORE },
    );
  } catch (error) { return authErrorResponse(error); }
}
