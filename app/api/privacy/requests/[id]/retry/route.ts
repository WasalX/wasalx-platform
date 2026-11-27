import { NextResponse } from "next/server";
import { isControlPlaneBackend, isFixtureBackend } from "../../../../../../lib/backend";
import { BoundedBodyError, readOptionalJsonObject } from "../../../../../../lib/bounded-json";
import { retryPrivacyRequest } from "../../../../../../lib/control-plane-data";
import { authenticatePortalRequest, authErrorResponse, requirePermission } from "../../../../../../lib/request-auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await authenticatePortalRequest(request, "privacy:read");
    const { id } = await context.params;
    const { confirmation } = await readOptionalJsonObject(request);
    if (confirmation !== undefined && typeof confirmation !== "string") {
      throw new BoundedBodyError(400, "confirmation must be a string");
    }
    const idempotencyKey=request.headers.get("idempotency-key")??"";
    if (isFixtureBackend()) {
      const fixture = await import("../../../../../../lib/fixture-data");
      const existing = await fixture.getPrivacyRequest(id, true);
      requirePermission(principal, existing.request_type === "DELETE" ? "privacy:delete" : "privacy:export");
      return NextResponse.json(await fixture.retryPrivacyRequest(id, confirmation, idempotencyKey, principal.displayName), { status: 202 });
    }
    if (!isControlPlaneBackend()) {
      return NextResponse.json({ error: "Privacy lifecycle requires the managed service" }, { status: 503 });
    }
    return NextResponse.json(await retryPrivacyRequest(id, confirmation, idempotencyKey), { status: 202 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
