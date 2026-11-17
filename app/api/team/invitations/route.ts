import { NextResponse } from "next/server";
import { inviteTeamMember } from "../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../lib/request-auth";

export async function POST(request: Request) {
  try {
    const principal = await authenticatePortalRequest(request, "team:invite");
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    return NextResponse.json(
      await inviteTeamMember(await request.json() as Record<string, unknown>, principal.displayName, idempotencyKey),
      { status: 202, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) { return authErrorResponse(error); }
}
