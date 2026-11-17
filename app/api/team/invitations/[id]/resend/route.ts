import { NextResponse } from "next/server";
import { resendTeamInvitation } from "../../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../../lib/request-auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await authenticatePortalRequest(request, "team:invite");
    const { id } = await context.params;
    return NextResponse.json(
      await resendTeamInvitation(id, await request.json() as Record<string, unknown>, principal.displayName, request.headers.get("idempotency-key") ?? ""),
      { status: 202, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) { return authErrorResponse(error); }
}
