import { NextResponse } from "next/server";
import { isControlPlaneBackend, isFixtureBackend } from "../../../../../../lib/backend";
import { releasePrivacyLegalHold } from "../../../../../../lib/control-plane-data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../../lib/request-auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await authenticatePortalRequest(request, "privacy:hold:write");
    const { id } = await context.params;
    if (isFixtureBackend()) return NextResponse.json(await (await import("../../../../../../lib/fixture-data")).releasePrivacyLegalHold(id, principal.displayName));
    if (!isControlPlaneBackend()) {
      return NextResponse.json({ error: "Privacy lifecycle requires the production control plane" }, { status: 503 });
    }
    return NextResponse.json(await releasePrivacyLegalHold(id));
  } catch (error) {
    return authErrorResponse(error);
  }
}
