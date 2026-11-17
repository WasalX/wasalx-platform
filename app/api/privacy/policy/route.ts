import { NextResponse } from "next/server";
import { isControlPlaneBackend, isFixtureBackend } from "../../../../lib/backend";
import { getPrivacyRetentionPolicy, updatePrivacyRetentionPolicy } from "../../../../lib/control-plane-data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../lib/request-auth";

export async function GET(request: Request) {
  try {
    await authenticatePortalRequest(request, "privacy:read");
    if (isFixtureBackend()) return NextResponse.json(await (await import("../../../../lib/fixture-data")).getPrivacyRetentionPolicy());
    if (!isControlPlaneBackend()) return unavailable();
    return NextResponse.json(await getPrivacyRetentionPolicy());
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const principal = await authenticatePortalRequest(request, "privacy:policy:write");
    if (isFixtureBackend()) return NextResponse.json(await (await import("../../../../lib/fixture-data")).updatePrivacyRetentionPolicy(await request.json(), principal.displayName));
    if (!isControlPlaneBackend()) return unavailable();
    return NextResponse.json(await updatePrivacyRetentionPolicy(await request.json()));
  } catch (error) {
    return authErrorResponse(error);
  }
}

function unavailable() {
  return NextResponse.json({ error: "Privacy lifecycle requires the production control plane" }, { status: 503 });
}
