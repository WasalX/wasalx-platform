import { createBotFlow, getBotFlows } from "../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../lib/request-auth";

const noStore={"cache-control":"private, no-store"};
export async function GET(request:Request){try{await authenticatePortalRequest(request,"bot:read");return Response.json(await getBotFlows(),{headers:noStore})}catch(error){return authErrorResponse(error)}}
export async function POST(request:Request){try{await authenticatePortalRequest(request,"bot:write");const key=request.headers.get("idempotency-key")??"";if(!key||key.length>255)return Response.json({error:"A valid idempotency key is required"},{status:400});return Response.json(await createBotFlow(await request.json() as Record<string,unknown>,key),{status:201,headers:noStore})}catch(error){return authErrorResponse(error)}}
