import { getBotAction } from "../../../../../lib/data";
import { authenticatePortalRequest,authErrorResponse } from "../../../../../lib/request-auth";

export async function GET(request:Request,context:{params:Promise<{actionKey:string}>}){try{await authenticatePortalRequest(request,"bot:read");const{actionKey}=await context.params;return Response.json(await getBotAction(actionKey),{headers:{"cache-control":"private, no-store"}})}catch(error){return authErrorResponse(error)}}
