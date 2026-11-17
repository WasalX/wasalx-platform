import { getGroups } from "../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../lib/request-auth";

export async function GET(request:Request){
  try{
    await authenticatePortalRequest(request,"group:read");
    const url=new URL(request.url);const after=url.searchParams.get("after")??undefined;const limitValue=url.searchParams.get("limit");const limit=limitValue===null?undefined:Number(limitValue);const query=url.searchParams.get("q")??undefined;const connectionId=url.searchParams.get("connection")??undefined;
    return Response.json(await getGroups({after,limit,query,connectionId}),{headers:{"cache-control":"private, no-store"}});
  }catch(error){return authErrorResponse(error)}
}
