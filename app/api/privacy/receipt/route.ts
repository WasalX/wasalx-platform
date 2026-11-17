import { isControlPlaneBackend,isFixtureBackend } from "../../../../lib/backend";
import {readBoundedBody} from "../../../../lib/bounded-json";
import {privacyOperationReceipt} from "../../../../lib/control-plane-data";
import {authenticatePortalRequest,authErrorResponse,requirePermission} from "../../../../lib/request-auth";
export async function POST(request:Request){
 try{
  const principal=await authenticatePortalRequest(request,"privacy:read");
  const body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await readBoundedBody(request,2048,5000))) as Record<string,unknown>;
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).sort().join(",")!=="action,kind,operationId"
   ||typeof body.operationId!=="string"||typeof body.kind!=="string"||!["EXPORT","DELETE","HOLD"].includes(body.kind)
   ||typeof body.action!=="string"||!["LOOKUP","CANCEL_IF_UNADMITTED"].includes(body.action))return Response.json({error:"Invalid privacy receipt"},{status:400});
  requirePermission(principal,body.kind==="HOLD"?"privacy:hold:write":body.kind==="DELETE"?"privacy:delete":"privacy:export");
  const input={operationId:body.operationId,kind:body.kind,action:body.action};
  const result=isFixtureBackend()?await(await import("../../../../lib/fixture-data")).privacyOperationReceipt(input,principal.role)
    :isControlPlaneBackend()?await privacyOperationReceipt(input):null;
  if(!result)return Response.json({error:"Privacy recovery unavailable"},{status:503});
  return Response.json(result,{headers:{"cache-control":"private, no-store"}});
 }catch(error){if(error instanceof SyntaxError)return Response.json({error:"Invalid privacy receipt"},{status:400});return authErrorResponse(error)}
}
