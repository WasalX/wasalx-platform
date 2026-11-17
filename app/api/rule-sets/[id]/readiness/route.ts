import { getRuleSetReadiness } from "../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../lib/request-auth";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await authenticatePortalRequest(request, "rule:read");
    const { id } = await context.params;
    return Response.json(await getRuleSetReadiness(id), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
