import { NextResponse } from "next/server";
import { isFixtureBackend } from "../../../../../lib/backend";
import { verifyServiceJwt } from "../../../../../packages/core/src/service-auth";

export async function GET(request: Request) {
  if (!isFixtureBackend()) return unavailable();
  const secret = process.env.ZAMMAD_SERVICE_JWT_SECRET;
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret) return NextResponse.json({ error: "Service authentication unavailable" }, { status: 503 });
  if (!token) return NextResponse.json({ error: "Bearer token required" }, { status: 401 });
  try {
    const claims = await verifyServiceJwt(token, secret, { audience: "wasalx-control", scope: "zammad:health" });
    return NextResponse.json({
      ok: true,
      tenant_id: claims.tenant_id,
      instance_id: claims.instance_id,
      time: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized" }, { status: 401 });
  }
}

function unavailable() {
  return NextResponse.json({ error: "Zammad ingress is not exposed by the portal" }, { status: 404 });
}
