import { NextResponse } from "next/server";
import { getGroupConfiguration, saveGroupConfiguration } from "../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../lib/request-auth";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    await authenticatePortalRequest(request, "group:read");
    const { id } = await context.params;
    return NextResponse.json(await getGroupConfiguration(id), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const principal = await authenticatePortalRequest(request, "group:write");
    const key=request.headers.get("idempotency-key")??"";
    if(!key||key.length>255)return NextResponse.json({error:"A valid idempotency key is required"},{status:400});
    const { id } = await context.params;
    const input = await request.json() as Record<string, unknown>;
    return NextResponse.json(await saveGroupConfiguration(id, input, principal.displayName,key));
  } catch (error) {
    return authErrorResponse(error);
  }
}
