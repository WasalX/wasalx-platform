import { cloneRuleSetVersion } from "../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../lib/request-auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await authenticatePortalRequest(request, "rule:write");
    const key = request.headers.get("idempotency-key") ?? "";
    if (!key || key.length > 255 || /[\s\p{Cc}]/u.test(key)) {
      return Response.json({ error: "A valid idempotency key is required" }, { status: 400 });
    }
    const body = await request.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({error:"A JSON object is required"},{status:400});
    const { id } = await context.params;
    return Response.json(await cloneRuleSetVersion(id, principal.displayName, key, body as Record<string,unknown>), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
