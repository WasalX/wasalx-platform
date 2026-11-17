import { storeBotActionCredential } from "../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../lib/request-auth";

export async function POST(request:Request){try{await authenticatePortalRequest(request,"bot:write");const key=request.headers.get("idempotency-key")??"";return Response.json(await storeBotActionCredential(await request.json(),key),{headers:{"cache-control":"private, no-store"}})}catch(error){return authErrorResponse(error)}}
