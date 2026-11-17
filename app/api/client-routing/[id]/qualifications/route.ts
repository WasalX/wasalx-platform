import { getClientRoutingQualifications } from "../../../../../lib/data";
import { authenticatePortalRequest,authErrorResponse } from "../../../../../lib/request-auth";

const noStore={"cache-control":"private, no-store"};

export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  try{await authenticatePortalRequest(request,"bot:read");const{id}=await context.params;return Response.json(await getClientRoutingQualifications(id),{headers:noStore})}
  catch(error){return authErrorResponse(error)}
}
