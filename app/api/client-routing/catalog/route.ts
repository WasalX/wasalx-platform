import { getClientRoutingCatalog } from "../../../../lib/data";
import { authenticatePortalRequest,authErrorResponse } from "../../../../lib/request-auth";

const noStore={"cache-control":"private, no-store"};
export async function GET(request:Request){try{await authenticatePortalRequest(request,"bot:read");const url=new URL(request.url);const query=new URLSearchParams();for(const key of ["cursor","limit"]){const value=url.searchParams.get(key);if(value!==null)query.set(key,value)}return Response.json(await getClientRoutingCatalog(query.size?`?${query}`:""),{headers:noStore})}catch(error){return authErrorResponse(error)}}
