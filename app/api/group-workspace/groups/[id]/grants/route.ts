import { NextResponse } from "next/server";
import { grantGroupWorkspaceAccess } from "../../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../../lib/request-auth";

type RouteContext={params:Promise<{id:string}>};
export async function POST(request:Request,context:RouteContext){try{const principal=await authenticatePortalRequest(request,"group:write");const key=request.headers.get("idempotency-key")??"";if(!key||key.length>255)return NextResponse.json({error:"A valid idempotency key is required"},{status:400});const{id}=await context.params;return NextResponse.json(await grantGroupWorkspaceAccess(id,await request.json() as Record<string,unknown>,principal.displayName,key),{headers:{"cache-control":"private, no-store"}})}catch(error){return authErrorResponse(error)}}
