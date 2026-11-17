import { getBotActions, saveBotAction } from "../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../lib/request-auth";

const noStore={"cache-control":"private, no-store"};
export async function GET(request:Request){try{await authenticatePortalRequest(request,"bot:read");return Response.json(await getBotActions(),{headers:noStore})}catch(error){return authErrorResponse(error)}}
export async function POST(request:Request){try{await authenticatePortalRequest(request,"bot:write");const key=request.headers.get("idempotency-key")??"";return Response.json(await saveBotAction(await request.json() as Record<string,unknown>,key),{headers:noStore})}catch(error){return authErrorResponse(error)}}
