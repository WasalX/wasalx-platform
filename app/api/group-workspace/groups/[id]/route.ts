import { NextResponse } from "next/server";
import { getGroupWorkspaceGroup, updateGroupWorkspaceGroup } from "../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../lib/request-auth";

type RouteContext={params:Promise<{id:string}>};const NO_STORE={"cache-control":"private, no-store"};
export async function GET(request:Request,context:RouteContext){try{await authenticatePortalRequest(request,"group:read");const{id}=await context.params;return NextResponse.json(await getGroupWorkspaceGroup(id),{headers:NO_STORE})}catch(error){return authErrorResponse(error)}}
export async function PUT(request:Request,context:RouteContext){try{const principal=await authenticatePortalRequest(request,"group:write");const key=request.headers.get("idempotency-key")??"";if(!key||key.length>255)return NextResponse.json({error:"A valid idempotency key is required"},{status:400,headers:NO_STORE});const{id}=await context.params;return NextResponse.json(await updateGroupWorkspaceGroup(id,await request.json() as Record<string,unknown>,principal.displayName,key),{headers:NO_STORE})}catch(error){return authErrorResponse(error)}}
