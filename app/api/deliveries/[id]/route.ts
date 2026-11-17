import { NextResponse } from "next/server";
import { getDeliveryDetail } from "../../../../lib/data";
import { authenticatePortalRequest,authErrorResponse } from "../../../../lib/request-auth";

export async function GET(request:Request,context:{params:Promise<{id:string}>}){try{await authenticatePortalRequest(request,"delivery:read");const{id}=await context.params;return NextResponse.json(await getDeliveryDetail(id),{headers:{"cache-control":"no-store"}})}catch(error){return authErrorResponse(error)}}
