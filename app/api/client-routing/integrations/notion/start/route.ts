import { BoundedBodyError, readOptionalJsonObject } from "../../../../../../lib/bounded-json";
import { startNotionRoutingOAuth } from "../../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../../lib/request-auth";

export async function POST(request: Request) {
  try {
    await authenticatePortalRequest(request, "bot:write");
    const { integrationId } = await readOptionalJsonObject(request);
    if (integrationId !== undefined && typeof integrationId !== "string") {
      throw new BoundedBodyError(400, "integrationId must be a string");
    }
    return Response.json(await startNotionRoutingOAuth(integrationId), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
