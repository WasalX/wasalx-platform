import { NextResponse } from "next/server";
import { isFixtureBackend } from "../../../../../lib/backend";
import { updateOutboundStatus } from "../../../../../lib/data";
import { ServiceAuthenticationError, verifyServiceJwt } from "../../../../../packages/core/src/service-auth";

const DELIVERY_STATES = new Set([
  "QUEUED", "CLAIMED", "SENDING", "SENT", "DELIVERED", "READ",
  "FAILED_RETRYABLE", "FAILED_TERMINAL", "OUTCOME_UNKNOWN", "BLOCKED",
]);

export async function POST(request: Request) {
  if (!isFixtureBackend()) return unavailable();
  try {
    const secret = process.env.ZAMMAD_SERVICE_JWT_SECRET;
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!secret) return NextResponse.json({ error: "Service authentication unavailable" }, { status: 503 });
    if (!token) return NextResponse.json({ error: "Bearer token required" }, { status: 401 });
    const claims = await verifyServiceJwt(token, secret, { audience: "wasalx-control", scope: "zammad:status" });
    const body = await request.json() as {
      idempotency_key?: string;
      state?: string;
      external_message_id?: string;
      safe_error?: string;
    };
    if (!body.idempotency_key || !body.state || !DELIVERY_STATES.has(body.state)) {
      return NextResponse.json({ error: "A valid idempotency_key and state are required" }, { status: 400 });
    }
    await updateOutboundStatus({
      tenantId: claims.tenant_id,
      idempotencyKey: body.idempotency_key,
      state: body.state,
      externalMessageId: body.external_message_id,
      safeError: body.safe_error,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ServiceAuthenticationError) return NextResponse.json({ error: error.message }, { status: 401 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Status update failed" }, { status: 400 });
  }
}

function unavailable() {
  return NextResponse.json({ error: "Zammad ingress is not exposed by the portal" }, { status: 404 });
}
