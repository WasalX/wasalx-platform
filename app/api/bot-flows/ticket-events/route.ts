import { bindTicketEvent, getTicketEventConfiguration } from "../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../lib/request-auth";

const headers={"cache-control":"private, no-store"};
export async function GET(request:Request){
  try{await authenticatePortalRequest(request,"bot:read");return Response.json(await getTicketEventConfiguration(),{headers})}
  catch(error){return authErrorResponse(error)}
}
export async function POST(request:Request){
  try{
    await authenticatePortalRequest(request,"bot:write");
    const key=request.headers.get("idempotency-key")??"";
    if(!key||key.length>255)return Response.json({error:"A valid idempotency key is required"},{status:400,headers});
    return Response.json(await bindTicketEvent(await request.json() as Record<string,unknown>,key),{headers});
  }catch(error){return authErrorResponse(error)}
}
