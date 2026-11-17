import { NextResponse } from "next/server";
import { getGroupWorkspaceSettings, updateGroupWorkspaceSettings } from "../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../lib/request-auth";

const NO_STORE={"cache-control":"private, no-store"};
export async function GET(request:Request){try{await authenticatePortalRequest(request,"settings:read");return NextResponse.json(await getGroupWorkspaceSettings(),{headers:NO_STORE})}catch(error){return authErrorResponse(error)}}
export async function PUT(request:Request){try{const principal=await authenticatePortalRequest(request,"settings:write");const key=request.headers.get("idempotency-key")??"";if(!key||key.length>255)return NextResponse.json({error:"A valid idempotency key is required"},{status:400,headers:NO_STORE});return NextResponse.json(await updateGroupWorkspaceSettings(await request.json() as Record<string,unknown>,principal.displayName,key),{headers:NO_STORE})}catch(error){return authErrorResponse(error)}}
