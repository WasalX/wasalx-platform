import { NextResponse } from "next/server";
import { getWahaOutboundSafety, updateWahaOutboundConnectionSafety } from "../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../lib/request-auth";

const NO_STORE={"cache-control":"private, no-store"};

export async function GET(request:Request){
  try{await authenticatePortalRequest(request,"settings:read");return NextResponse.json(await getWahaOutboundSafety(),{headers:NO_STORE})}
  catch(error){return authErrorResponse(error)}
}

export async function PATCH(request:Request){
  try{
    const principal=await authenticatePortalRequest(request,"settings:write");
    const idempotencyKey=request.headers.get("idempotency-key")??"";
    if(!idempotencyKey||idempotencyKey.length>255)return NextResponse.json({error:"A valid Idempotency-Key header is required"},{status:400,headers:NO_STORE});
    const body=await request.json() as Record<string,unknown>;
    const connectionId=String(body.connectionId??"");
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(connectionId)&&!/^conn_[a-z0-9_]+$/u.test(connectionId))return NextResponse.json({error:"Connection ID is invalid"},{status:400,headers:NO_STORE});
    const input={...body};delete input.connectionId;
    return NextResponse.json(await updateWahaOutboundConnectionSafety(connectionId,input,principal.displayName,idempotencyKey),{headers:NO_STORE});
  }catch(error){return authErrorResponse(error)}
}
