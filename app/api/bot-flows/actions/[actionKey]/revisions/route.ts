import { getBotActionRevisions } from "../../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../../lib/request-auth";

const noStore={"cache-control":"private, no-store"};

export async function GET(request:Request,context:{params:Promise<{actionKey:string}>}){
  try{await authenticatePortalRequest(request,"bot:read");const{actionKey}=await context.params;return Response.json(await getBotActionRevisions(actionKey),{headers:noStore})}
  catch(error){return authErrorResponse(error)}
}
