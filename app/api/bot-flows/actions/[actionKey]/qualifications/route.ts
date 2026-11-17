import { qualifyBotAction } from "../../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../../lib/request-auth";

const noStore={"cache-control":"private, no-store"};

export async function POST(request:Request,context:{params:Promise<{actionKey:string}>}){
  try{
    await authenticatePortalRequest(request,"bot:write");
    const key=request.headers.get("idempotency-key")??"";
    const {actionKey}=await context.params;
    return Response.json(await qualifyBotAction(actionKey,await request.json() as Record<string,unknown>,key),{status:202,headers:noStore});
  }catch(error){return authErrorResponse(error)}
}
