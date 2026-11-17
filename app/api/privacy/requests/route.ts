import { NextResponse } from "next/server";
import { isControlPlaneBackend, isFixtureBackend } from "../../../../lib/backend";
import { createPrivacyRequest, getPrivacyRequests } from "../../../../lib/control-plane-data";
import { authenticatePortalRequest, authErrorResponse, requirePermission } from "../../../../lib/request-auth";

export async function GET(request: Request) {
  try {
    const principal = await authenticatePortalRequest(request, "privacy:read");
    if (isFixtureBackend()) return NextResponse.json(await (await import("../../../../lib/fixture-data")).getPrivacyRequests(principal.role !== "auditor"));
    if (!isControlPlaneBackend()) return unavailable();
    return NextResponse.json(await getPrivacyRequests());
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = await authenticatePortalRequest(request, "privacy:read");
    const body = await request.json() as { requestType?: string; scopeType?: string; scopeValue?: string; confirmation?: string };
    const requestType = body.requestType?.toUpperCase();
    if (requestType === "EXPORT") requirePermission(principal, "privacy:export");
    else if (requestType === "DELETE") requirePermission(principal, "privacy:delete");
    const key = request.headers.get("idempotency-key");
    if (!key) return NextResponse.json({ error: "Idempotency-Key is required" }, { status: 400 });
    if (isFixtureBackend()) return NextResponse.json(await (await import("../../../../lib/fixture-data")).createPrivacyRequest(body, key, principal.displayName), { status: 202 });
    if (!isControlPlaneBackend()) return unavailable();
    return NextResponse.json(await createPrivacyRequest(body as { requestType: "EXPORT" | "DELETE"; scopeType: string; scopeValue?: string; confirmation?: string }, key), { status: 202 });
  } catch (error) {
    return authErrorResponse(error);
  }
}

function unavailable() {
  return NextResponse.json({ error: "Privacy lifecycle requires the production control plane" }, { status: 503 });
}
