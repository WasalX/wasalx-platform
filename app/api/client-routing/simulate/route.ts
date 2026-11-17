import { simulateClientRouting } from "../../../../lib/data";
import { authenticatePortalRequest,authErrorResponse } from "../../../../lib/request-auth";

export async function POST(request:Request){try{await authenticatePortalRequest(request,"bot:read");return Response.json(await simulateClientRouting(await request.json() as Record<string,unknown>),{headers:{"cache-control":"private, no-store"}})}catch(error){return authErrorResponse(error)}}
