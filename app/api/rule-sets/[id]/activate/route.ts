import { activateRuleSetVersion } from "../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../lib/request-auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await authenticatePortalRequest(request, "rule:write");
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!idempotencyKey || idempotencyKey.length > 255) {
      return Response.json({ error: "A valid idempotency key is required" }, { status: 400 });
    }
    const { id } = await context.params;
    return Response.json(await activateRuleSetVersion(id, await request.json() as Record<string, unknown>, principal.displayName, idempotencyKey), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
