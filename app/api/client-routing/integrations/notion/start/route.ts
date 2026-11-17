import { startNotionRoutingOAuth } from "../../../../../../lib/data";
import { authenticatePortalRequest,authErrorResponse } from "../../../../../../lib/request-auth";

export async function POST(request:Request){try{await authenticatePortalRequest(request,"bot:write");const body=await request.json().catch(()=>({})) as {integrationId?:unknown};const integrationId=typeof body.integrationId==="string"?body.integrationId:undefined;return Response.json(await startNotionRoutingOAuth(integrationId),{headers:{"cache-control":"private, no-store"}})}catch(error){return authErrorResponse(error)}}
