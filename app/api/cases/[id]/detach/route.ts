import { NextResponse } from "next/server";
import { detachCase } from "../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../lib/request-auth";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const principal = await authenticatePortalRequest(request, "case:detach");
    const key = request.headers.get("idempotency-key");
    if (!key) return NextResponse.json({ error: "Idempotency-Key is required" }, { status: 400 });
    const body = await request.json() as { expectedVersion?: number; confirmation?: string };
    if (body.confirmation !== "START_NEW_CASE") {
      return NextResponse.json({ error: "Confirmation START_NEW_CASE is required" }, { status: 400 });
    }
    const { id } = await context.params;
    return NextResponse.json(
      await detachCase(id, Number(body.expectedVersion), principal.displayName, key),
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
