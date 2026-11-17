import { isControlPlaneBackend, sitesPrivateDemoError } from "../../../lib/backend";
import { readBoundedBody } from "../../../lib/bounded-json";
import { ControlPlaneError, portalInboxRequest } from "../../../lib/control-plane-data";
import { authenticatePortalRequest, authErrorResponse } from "../../../lib/request-auth";

export async function POST(request: Request) {
  try {
    const principal = await authenticatePortalRequest(request, "ticket:read");
    if (!isControlPlaneBackend()) throw sitesPrivateDemoError("The conversation workspace");
    const bytes = await readBoundedBody(request, 32_768, 5_000);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return Response.json(await portalInboxRequest(principal, value), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ControlPlaneError && error.workspaceProof)
      return Response.json({ error: error.message, code: error.code, ...error.workspaceProof },
        { status: error.status, headers: { "cache-control": "private, no-store" } });
    if (error instanceof SyntaxError) return Response.json({ error: "Invalid workspace request" }, { status: 400 });
    return authErrorResponse(error);
  }
}
