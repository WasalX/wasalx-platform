import { NextResponse } from "next/server";
import { removeTeamMember, updateTeamMember } from "../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../lib/request-auth";

type Context = { params: Promise<{ id: string }> };
const NO_STORE = { "cache-control": "private, no-store" };

export async function PATCH(request: Request, context: Context) {
  try {
    const principal = await authenticatePortalRequest(request, "team:write");
    const { id } = await context.params;
    return NextResponse.json(
      await updateTeamMember(id, await request.json() as Record<string, unknown>, principal.displayName),
      { headers: NO_STORE },
    );
  } catch (error) { return authErrorResponse(error); }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const principal = await authenticatePortalRequest(request, "team:write");
    const { id } = await context.params;
    const body = await request.json() as { expectedVersion?: number };
    return NextResponse.json(
      await removeTeamMember(id, Number(body.expectedVersion), principal.displayName),
      { headers: NO_STORE },
    );
  } catch (error) { return authErrorResponse(error); }
}
