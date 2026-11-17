import { NextResponse } from "next/server";
import { stopRetryingDelivery } from "../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../lib/request-auth";

export async function POST(request:Request,context:{params:Promise<{id:string}>}) {
  try {
    await authenticatePortalRequest(request,"delivery:retry");
    const body=await request.json().catch(()=>null);
    if(!body||typeof body!=="object"||Array.isArray(body))return NextResponse.json({error:"Delivery confirmation is invalid"},{status:400});
    const {id}=await context.params;
    return NextResponse.json(await stopRetryingDelivery(id,body,request.headers.get("idempotency-key")??""));
  } catch(error) { return authErrorResponse(error); }
}
