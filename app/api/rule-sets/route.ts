import { getRuleSetVersions } from "../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../lib/request-auth";

export async function GET(request: Request) {
  try {
    await authenticatePortalRequest(request, "rule:read");
    const url=new URL(request.url);const before=url.searchParams.get("before")??undefined;const state=url.searchParams.get("state")??undefined;const limitValue=url.searchParams.get("limit");const limit=limitValue===null?undefined:Number(limitValue);
    return Response.json(await getRuleSetVersions({before,state,limit}), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
