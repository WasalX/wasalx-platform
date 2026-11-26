import { NextResponse } from "next/server";
import { BoundedBodyError, readOptionalJsonObject } from "../../../../../lib/bounded-json";
import { retryDelivery } from "../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../lib/request-auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await authenticatePortalRequest(request, "delivery:retry");
    const key=request.headers.get("idempotency-key")??"";
    if(!key||key.length>255)return NextResponse.json({error:"A valid idempotency key is required"},{status:400});
    const { id } = await context.params;
    const { confirmOutcomeUnknown } = await readOptionalJsonObject(request);
    if (confirmOutcomeUnknown !== undefined && typeof confirmOutcomeUnknown !== "boolean") {
      throw new BoundedBodyError(400, "confirmOutcomeUnknown must be a boolean");
    }
    await retryDelivery(id, principal.displayName, confirmOutcomeUnknown ?? false, key);
    return NextResponse.json({ ok: true, state: "QUEUED" });
  } catch (error) {
    return authErrorResponse(error);
  }
}
