import { NextResponse } from "next/server";
import { isControlPlaneBackend, isFixtureBackend } from "../../../../../../lib/backend";
import { downloadPrivacyExport } from "../../../../../../lib/control-plane-data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../../lib/request-auth";

const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer" };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await authenticatePortalRequest(request, "privacy:export");
    const { id } = await context.params;
    if (isFixtureBackend()) return NextResponse.json(await (await import("../../../../../../lib/fixture-data")).downloadPrivacyExport(id, principal.displayName), { headers });
    if (!isControlPlaneBackend()) {
      return NextResponse.json({ error: "Privacy lifecycle requires the managed service" }, { status: 503, headers });
    }
    return NextResponse.json(await downloadPrivacyExport(id), { headers });
  } catch (error) {
    const response = authErrorResponse(error);
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  }
}
