import { NextResponse } from "next/server";
import { retryDelivery } from "../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../lib/request-auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await authenticatePortalRequest(request, "delivery:retry");
    const key=request.headers.get("idempotency-key")??"";
    if(!key||key.length>255)return NextResponse.json({error:"A valid idempotency key is required"},{status:400});
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as { confirmOutcomeUnknown?: boolean };
    await retryDelivery(id, principal.displayName, body.confirmOutcomeUnknown === true,key);
    return NextResponse.json({ ok: true, state: "QUEUED" });
  } catch (error) {
    return authErrorResponse(error);
  }
}
