import { revealDeliveryContent } from "../../../../../lib/data";
import {
  authenticatePortalRequest,
  authErrorResponse,
} from "../../../../../lib/request-auth";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const principal = await authenticatePortalRequest(request, "delivery:content:read");
    const body = await request.json() as { purpose?: unknown; confirmation?: unknown };
    if (body.purpose !== "OPERATIONAL_REVIEW" || body.confirmation !== "REVEAL") {
      return Response.json(
        { error: "Explicit operational-review confirmation is required" },
        { status: 400 },
      );
    }
    const { id } = await context.params;
    return Response.json(await revealDeliveryContent(id, principal.displayName), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
