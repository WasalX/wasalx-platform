import { qualifyClientRoutingSource } from "../../../../../../../lib/data";
import { authenticatePortalRequest,authErrorResponse } from "../../../../../../../lib/request-auth";

const noStore={"cache-control":"private, no-store"};

export async function POST(request:Request,context:{params:Promise<{id:string;sourceId:string}>}){
  try{await authenticatePortalRequest(request,"bot:write");const key=request.headers.get("idempotency-key")??"";if(!key||key.length>255)return Response.json({error:"A valid idempotency key is required"},{status:400,headers:noStore});const{id,sourceId}=await context.params;return Response.json(await qualifyClientRoutingSource(id,sourceId,await request.json() as Record<string,unknown>,key),{status:202,headers:noStore})}
  catch(error){return authErrorResponse(error)}
}
