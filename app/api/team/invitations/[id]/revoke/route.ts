import { NextResponse } from "next/server";
import { revokeTeamInvitation } from "../../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../../lib/request-auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await authenticatePortalRequest(request, "team:invite");
    const { id } = await context.params;
    const body = await request.json() as { expectedVersion?: number };
    return NextResponse.json(
      await revokeTeamInvitation(id, Number(body.expectedVersion), principal.displayName),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) { return authErrorResponse(error); }
}
