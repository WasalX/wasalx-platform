import { compareRuleSetVersions } from "../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../lib/request-auth";

export async function GET(request: Request) {
  try {
    await authenticatePortalRequest(request, "rule:read");
    const query = new URL(request.url).searchParams;
    const left = query.get("left") ?? "";
    const right = query.get("right") ?? "";
    if (!left || !right || left.length > 160 || right.length > 160) {
      return Response.json({ error: "Select two rule-set versions" }, { status: 400 });
    }
    return Response.json(await compareRuleSetVersions(left, right), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
