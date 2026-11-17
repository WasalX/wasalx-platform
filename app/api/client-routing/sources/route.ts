import { getClientRoutingSources } from "../../../../lib/data";
import { authenticatePortalRequest,authErrorResponse } from "../../../../lib/request-auth";

export async function GET(request:Request){try{await authenticatePortalRequest(request,"bot:read");return Response.json(await getClientRoutingSources(),{headers:{"cache-control":"private, no-store"}})}catch(error){return authErrorResponse(error)}}
