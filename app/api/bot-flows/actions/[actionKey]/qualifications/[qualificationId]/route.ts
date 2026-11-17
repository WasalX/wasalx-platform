import { getBotActionQualification } from "../../../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../../../lib/request-auth";

export async function GET(request:Request,context:{params:Promise<{actionKey:string;qualificationId:string}>}){
  try{
    await authenticatePortalRequest(request,"bot:read");
    const {actionKey,qualificationId}=await context.params;
    return Response.json(await getBotActionQualification(actionKey,qualificationId),{headers:{"cache-control":"private, no-store"}});
  }catch(error){return authErrorResponse(error)}
}
