import { getNativeRoutingSync, updateNativeRoutingSync } from "../../../../lib/data";
import { parseNativeRoutingSyncCommand } from "../../../../packages/core/src/native-routing-contract";
import { authenticatePortalRequest, authErrorResponse } from "../../../../lib/request-auth";

const headers={"cache-control":"private, no-store"};
export async function GET(request:Request){try{await authenticatePortalRequest(request,"group:read");return Response.json(await getNativeRoutingSync(),{headers});}catch(error){return authErrorResponse(error);}}
export async function POST(request:Request){try{
  await authenticatePortalRequest(request,"bot:write");
  const key=request.headers.get("idempotency-key");
  let command:ReturnType<typeof parseNativeRoutingSyncCommand>;
  try{command=parseNativeRoutingSyncCommand(await request.json());if(!key||key.length>255||/\s/u.test(key))throw new Error("Invalid key");}
  catch{return Response.json({code:"NATIVE_ROUTING_VALIDATION_ERROR",error:"Routing synchronization request is invalid"},{status:400,headers});}
  return Response.json(await updateNativeRoutingSync(command,key),{headers});
}catch(error){return authErrorResponse(error);}}
