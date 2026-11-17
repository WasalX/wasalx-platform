import { isControlPlaneBackend, sitesPrivateDemoError } from "../../../../lib/backend";
import { readBoundedBody } from "../../../../lib/bounded-json";
import { portalInboxAttachmentRequest } from "../../../../lib/control-plane-data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../lib/request-auth";

export async function POST(request: Request) {
  try {
    const principal = await authenticatePortalRequest(request, "ticket:read");
    if (!isControlPlaneBackend()) throw sitesPrivateDemoError("Group media");
    const bytes = await readBoundedBody(request, 4_096, 5_000);
    const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return await portalInboxAttachmentRequest(principal, input, "GROUP_MEDIA");
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "Invalid media request" }, { status: 400 });
    return authErrorResponse(error);
  }
}
