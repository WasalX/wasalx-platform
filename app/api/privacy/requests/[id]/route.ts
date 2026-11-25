import { NextResponse } from "next/server";
import { isControlPlaneBackend, isFixtureBackend } from "../../../../../lib/backend";
import { getPrivacyRequest } from "../../../../../lib/control-plane-data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../lib/request-auth";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await authenticatePortalRequest(request, "privacy:read");
    const { id } = await context.params;
    if (isFixtureBackend()) return NextResponse.json(await (await import("../../../../../lib/fixture-data")).getPrivacyRequest(id, principal.role !== "auditor"));
    if (!isControlPlaneBackend()) {
      return NextResponse.json({ error: "Privacy lifecycle requires the managed service" }, { status: 503 });
    }
    return NextResponse.json(await getPrivacyRequest(id));
  } catch (error) {
    return authErrorResponse(error);
  }
}
