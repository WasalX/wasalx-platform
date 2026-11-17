import { NextResponse } from "next/server";
import { getReviewItem } from "../../../../lib/data";
import { authenticatePortalRequest,authErrorResponse } from "../../../../lib/request-auth";

export async function GET(request:Request,context:{params:Promise<{id:string}>}){try{await authenticatePortalRequest(request,"review:read");const{id}=await context.params;return NextResponse.json(await getReviewItem(id),{headers:{"cache-control":"no-store"}})}catch(error){return authErrorResponse(error)}}
