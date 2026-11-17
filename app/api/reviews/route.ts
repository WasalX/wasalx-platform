import { NextResponse } from "next/server";
import { getReviewItems } from "../../../lib/data";
import { authenticatePortalRequest,authErrorResponse } from "../../../lib/request-auth";

export async function GET(request:Request){try{await authenticatePortalRequest(request,"review:read");const state=new URL(request.url).searchParams.get("state")??undefined;return NextResponse.json(await getReviewItems(state),{headers:{"cache-control":"no-store"}})}catch(error){return authErrorResponse(error)}}
