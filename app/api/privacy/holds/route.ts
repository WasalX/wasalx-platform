import { NextResponse } from "next/server";
import { isControlPlaneBackend, isFixtureBackend } from "../../../../lib/backend";
import { createPrivacyLegalHold, getPrivacyLegalHolds } from "../../../../lib/control-plane-data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../lib/request-auth";

export async function GET(request: Request) {
  try {
    const principal = await authenticatePortalRequest(request, "privacy:read");
    if (isFixtureBackend()) return NextResponse.json(await (await import("../../../../lib/fixture-data")).getPrivacyLegalHolds(principal.role !== "auditor"));
    if (!isControlPlaneBackend()) return unavailable();
    return NextResponse.json(await getPrivacyLegalHolds());
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = await authenticatePortalRequest(request, "privacy:hold:write");
    const operationId=request.headers.get("idempotency-key");
    if(!operationId) return NextResponse.json({error:"Idempotency-Key is required"},{status:400});

    if (isFixtureBackend()) return NextResponse.json(await (await import("../../../../lib/fixture-data")).createPrivacyLegalHold(await request.json(), principal.displayName, operationId), { status: 201 });
    if (!isControlPlaneBackend()) return unavailable();
    return NextResponse.json(await createPrivacyLegalHold(await request.json(), operationId), { status: 201 });
  } catch (error) {
    return authErrorResponse(error);
  }
}

function unavailable() {
  return NextResponse.json({ error: "Privacy lifecycle requires the managed service" }, { status: 503 });
}
