import { NextResponse } from "next/server";
import { reviewAction } from "../../../../../lib/data";
import { authenticatePortalRequest,authErrorResponse } from "../../../../../lib/request-auth";

export async function POST(request:Request,context:{params:Promise<{id:string}>}){try{await authenticatePortalRequest(request,"review:write");const key=request.headers.get("idempotency-key");if(!key)return NextResponse.json({error:"Idempotency-Key is required"},{status:400});const{id}=await context.params;return NextResponse.json(await reviewAction(id,"discard",await request.json(),key))}catch(error){return authErrorResponse(error)}}
