import { decideSupportAccess } from "../../../lib/data";
import {
  authenticatePortalRequest,
  authErrorResponse,
} from "../../../lib/request-auth";

export async function supportDecision(
  request: Request,
  context: { params: Promise<{ id: string }> },
  action: "approve" | "deny" | "revoke",
) {
  try {
    const principal = await authenticatePortalRequest(request, "support:approve");
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    return Response.json(
      await decideSupportAccess(id, action, body, principal.displayName),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
