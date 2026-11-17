import { commandBotConversation } from "../../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../../lib/request-auth";

export async function POST(request:Request,context:{params:Promise<{id:string}>}){try{await authenticatePortalRequest(request,"bot:operate");const key=request.headers.get("idempotency-key")??"";if(!key||key.length>255)return Response.json({error:"A valid idempotency key is required"},{status:400});const{id}=await context.params;return Response.json(await commandBotConversation(id,await request.json() as Record<string,unknown>,key),{headers:{"cache-control":"private, no-store"}})}catch(error){return authErrorResponse(error)}}
