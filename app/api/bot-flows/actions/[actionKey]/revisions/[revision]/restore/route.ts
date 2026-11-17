import { restoreBotActionRevision } from "../../../../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../../../../lib/request-auth";

const noStore={"cache-control":"private, no-store"};

export async function POST(request:Request,context:{params:Promise<{actionKey:string;revision:string}>}){
  try{await authenticatePortalRequest(request,"bot:write");const key=request.headers.get("idempotency-key")??"";if(!key||key.length>255)return Response.json({error:"A valid idempotency key is required"},{status:400,headers:noStore});const{actionKey,revision}=await context.params;const value=Number(revision);if(!Number.isSafeInteger(value)||value<1)return Response.json({error:"A valid revision is required"},{status:400,headers:noStore});return Response.json(await restoreBotActionRevision(actionKey,value,await request.json() as Record<string,unknown>,key),{status:201,headers:noStore})}
  catch(error){return authErrorResponse(error)}
}
