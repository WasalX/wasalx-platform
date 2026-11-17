import {createHash} from "node:crypto";
import {authenticatePlatformCostSourceRequest,platformAuthErrorResponse} from "../../../../../../../../../lib/platform-request-auth";
import {BoundedBodyError,readBoundedBody,readBoundedJson} from "../../../../../../../../../lib/bounded-json";
import {MediaUploadAdmission} from "../../../../../../../../../packages/core/src/media";
import {META_COST_SOURCE_MAX_BYTES,META_COST_SOURCE_MIMES,metaCostUuid} from "../../../../../../../../../packages/core/src/meta-cost";

export const dynamic="force-dynamic";
const admission=new MediaUploadAdmission(2,1);
const noStore={"cache-control":"private, no-store","x-content-type-options":"nosniff"};
type Context={params:Promise<{tenantId:string;statementId:string}>};
type Access={tenantId:string;id:string;token:string;sha256:string;byteSize:number;mimeType:string};

export function GET(request:Request,context:Context){return original(request,context,false);}
export function PUT(request:Request,context:Context){return original(request,context,true);}

async function original(request:Request,context:Context,uploading:boolean){
  try{
    const session=await authenticatePlatformCostSourceRequest(request);
    const params=await context.params;
    let tenantId:string,id:string;
    try{tenantId=metaCostUuid(params.tenantId);id=metaCostUuid(params.statementId);}catch{return failure(400,"The source selection is invalid");}
    const control=process.env.CONTROL_API_URL,worker=process.env.CONNECTOR_WORKER_INTERNAL_URL;
    if(!control||!worker)return failure(503,"Source storage is temporarily unavailable");
    const authorization=await fetch(new URL(`/platform/v1/meta-costs/tenants/${tenantId}/statements/${id}/source-access`,control),{
      method:"POST",headers:{authorization:`Bearer ${session.accessToken}`,"content-type":"application/json"},
      body:JSON.stringify({operation:uploading?"UPLOAD":"READ"}),redirect:"error",signal:AbortSignal.timeout(15_000),
    });
    if(!authorization.ok)return failure(authorization.status===401?401:authorization.status===403?403:409,"The source is unavailable or has changed");
    const access=await readBoundedJson<Access>(authorization,8192);
    if(access.tenantId!==tenantId||access.id!==id||typeof access.token!=="string"||access.token.length>8192
      ||!/^[a-f0-9]{64}$/u.test(access.sha256)||!Number.isSafeInteger(access.byteSize)||access.byteSize<1||access.byteSize>META_COST_SOURCE_MAX_BYTES
      ||!META_COST_SOURCE_MIMES.includes(access.mimeType as typeof META_COST_SOURCE_MIMES[number]))return failure(503,"Source storage is temporarily unavailable");
    const release=admission.tryAcquire(tenantId);
    if(!release)return failure(429,"Too many source requests are in progress");
    try{
      const target=new URL(`/internal/meta-cost-sources/${id}`,worker);
      const headers={authorization:`Bearer ${access.token}`,"x-tenant-id":tenantId};
      if(uploading){
        const mime=request.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase();
        const size=Number(request.headers.get("content-length")??0);
        if(mime!==access.mimeType||size!==access.byteSize)return failure(400,"The original does not match its reserved size or type");
        const bytes=await readBoundedBody(request,META_COST_SOURCE_MAX_BYTES,30_000,access.byteSize);
        if(createHash("sha256").update(bytes).digest("hex")!==access.sha256)return failure(400,"The original does not match its reserved digest");
        const response=await fetch(target,{method:"PUT",headers:{...headers,"content-type":access.mimeType,"content-length":String(bytes.byteLength)},
          body:Uint8Array.from(bytes).buffer,redirect:"error",signal:AbortSignal.timeout(120_000)});
        if(!response.ok)return failure(response.status===401?503:response.status,"The source upload is unresolved or unavailable; reload its status");
        const result=await readBoundedJson<{id:string;state:string}>(response,8192);
        if(result.id!==id||result.state!=="READY")return failure(409,"The source upload requires review");
        return Response.json({id,state:"READY"},{headers:noStore});
      }
      const response=await fetch(target,{method:"GET",headers,redirect:"error",signal:AbortSignal.timeout(45_000)});
      if(!response.ok)return failure(response.status===401?503:response.status,"The verified original is unavailable");
      const bytes=await readBoundedBody(response,META_COST_SOURCE_MAX_BYTES,30_000,access.byteSize);
      if(response.headers.get("content-type")!==access.mimeType||createHash("sha256").update(bytes).digest("hex")!==access.sha256)
        return failure(409,"The original failed its integrity check");
      const currentSession=await authenticatePlatformCostSourceRequest(request);
      const currentAuthorization=await fetch(new URL(`/platform/v1/meta-costs/tenants/${tenantId}/statements/${id}/source-access`,control),{
        method:"POST",headers:{authorization:`Bearer ${currentSession.accessToken}`,"content-type":"application/json"},
        body:JSON.stringify({operation:"READ"}),redirect:"error",signal:AbortSignal.timeout(15_000),
      });
      if(!currentAuthorization.ok)return failure(409,"The original is no longer available");
      const current=await readBoundedJson<Access>(currentAuthorization,8192);
      if(current.tenantId!==tenantId||current.id!==id||current.sha256!==access.sha256||current.byteSize!==access.byteSize||current.mimeType!==access.mimeType)
        return failure(409,"The original changed during retrieval");
      return new Response(Uint8Array.from(bytes).buffer,{headers:{...noStore,"content-type":access.mimeType,
        "content-disposition":`attachment; filename="cost-source.${access.mimeType==="application/pdf"?"pdf":access.mimeType==="text/csv"?"csv":"json"}"`}});
    }finally{release();}
  }catch(error){
    if(error instanceof BoundedBodyError)return failure(error.status,error.message);
    // Authentication errors retain their existing safe status; no backend body,
    // token, storage key or unbounded provider error is returned to the browser.
    try{return platformAuthErrorResponse(error);}catch{return failure(503,"Source storage is temporarily unavailable");}
  }
}
function failure(status:number,error:string){return Response.json({error},{status,headers:noStore});}
