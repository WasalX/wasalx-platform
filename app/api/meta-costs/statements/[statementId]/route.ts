import {isControlPlaneBackend} from "../../../../../lib/backend";
import {getMetaCostStatement} from "../../../../../lib/control-plane-data";
import {authenticatePortalRequest,authErrorResponse} from "../../../../../lib/request-auth";
import {metaCostUuid} from "../../../../../packages/core/src/meta-cost";
export const dynamic="force-dynamic";
const headers={"cache-control":"private, no-store","x-content-type-options":"nosniff"};
export async function GET(request:Request,context:{params:Promise<{statementId:string}>}){
 try{
  await authenticatePortalRequest(request,"billing:read");
  if(!isControlPlaneBackend())return Response.json({error:"Statement evidence is unavailable"},{status:503,headers});
  let id:string;try{id=metaCostUuid((await context.params).statementId);}catch{return Response.json({error:"Invalid statement"},{status:400,headers});}
  if(new URL(request.url).search)return Response.json({error:"Invalid statement query"},{status:400,headers});
  return Response.json(await getMetaCostStatement(id),{headers});
 }catch(error){try{return authErrorResponse(error);}catch{return Response.json({error:"Statement evidence could not be loaded"},{status:503,headers});}}
}
