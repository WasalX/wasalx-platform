import { isControlPlaneBackend } from "../../../../lib/backend";
import { exportMetaCostCsv, getMetaCostAccounts, getMetaCostUsage, getMetaCostStatements } from "../../../../lib/control-plane-data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../lib/request-auth";

export const dynamic="force-dynamic";
const headers={"cache-control":"private, no-store","x-content-type-options":"nosniff"};
export async function GET(request:Request,context:{params:Promise<{action:string}>}){
  try{
    const{action}=await context.params;
    if(!["accounts","usage","export","statements","statement-export"].includes(action))return Response.json({error:"Not found"},{status:404,headers});
    await authenticatePortalRequest(request,(action==="export"||action==="statement-export")?"billing:export":"billing:read");
    if(!isControlPlaneBackend())return Response.json({error:"Connect a workspace to review cost evidence"},{status:503,headers});
    const query=new URL(request.url).searchParams;
    if(query.toString().length>1024||[...query.keys()].some(key=>!["accountId","from","to"].includes(key)||query.getAll(key).length!==1))
      return Response.json({error:"Invalid cost period"},{status:400,headers});
    if((action==="export"||action==="statement-export"))return new Response(await exportMetaCostCsv(query.toString(),action==="statement-export"),{headers:{...headers,"content-type":"text/csv; charset=utf-8","content-disposition":"attachment; filename=\"wasalx-meta-costs.csv\""}});
    return Response.json(action==="accounts"?await getMetaCostAccounts():action==="statements"?await getMetaCostStatements(query.toString()):await getMetaCostUsage(query.toString()),{headers});
  }catch(error){
    try{const response=authErrorResponse(error);for(const[name,value]of Object.entries(headers))response.headers.set(name,value);return response;}
    catch{return Response.json({error:"Cost evidence could not be loaded"},{status:503,headers});}
  }
}
