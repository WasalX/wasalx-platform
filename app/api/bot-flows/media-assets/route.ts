import { BoundedBodyError as UploadBodyError, readBoundedBody } from "../../../../lib/bounded-json";
import { createBotMediaAsset, getBotMediaAssets } from "../../../../lib/data";
import { authenticatePortalBinaryUploadRequest, authenticatePortalRequest, authErrorResponse } from "../../../../lib/request-auth";
import { MEDIA_LIMITS, MediaUploadAdmission, maximumMediaBytes, normalizeMediaMime } from "../../../../packages/core/src/media";

const noStore={"cache-control":"private, no-store"};
const maximumUploadBytes=50_000_000;
const uploadAdmission=new MediaUploadAdmission(2,1);
const uploadReadTimeoutMs=30_000;

async function readUploadBody(request:Request,expectedBytes:number):Promise<ArrayBuffer>{
  return Uint8Array.from(await readBoundedBody(request,expectedBytes,uploadReadTimeoutMs,expectedBytes)).buffer;
}

export async function GET(request:Request){try{await authenticatePortalRequest(request,"bot:read");const ids=new URL(request.url).searchParams.getAll("id");if(ids.length>100||ids.some(id=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)))return Response.json({error:"The media selection is invalid"},{status:400,headers:noStore});return Response.json(await getBotMediaAssets(ids),{headers:noStore})}catch(error){return authErrorResponse(error)}}

export async function POST(request:Request){try{
  const mimeType=normalizeMediaMime(request.headers.get("content-type")??"");const principal=await authenticatePortalBinaryUploadRequest(request,"bot:write",Object.keys(MEDIA_LIMITS));const key=request.headers.get("idempotency-key")??"";
  const encodedName=request.headers.get("x-file-name")??"";let filename="";try{filename=decodeURIComponent(encodedName)}catch{return Response.json({error:"The file name is invalid"},{status:400,headers:noStore})}const byteSize=Number(request.headers.get("content-length")??0);const contentSha256=request.headers.get("x-content-sha256")??"";const mimeMaximum=maximumMediaBytes(mimeType);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(key)||!filename||filename.length>120||!Number.isSafeInteger(byteSize)||byteSize<1||!mimeMaximum||byteSize>Math.min(maximumUploadBytes,mimeMaximum)||!/^[0-9a-f]{64}$/u.test(contentSha256))return Response.json({error:"Choose a supported file up to 50 MB"},{status:400,headers:noStore});
  const release=uploadAdmission.tryAcquire(principal.tenantId);if(!release)return Response.json({error:"Too many media uploads are in progress"},{status:429,headers:{...noStore,"retry-after":"2"}});try{
    let body:ArrayBuffer;try{body=await readUploadBody(request,byteSize)}catch(error){if(error instanceof UploadBodyError)return Response.json({error:error.message},{status:error.status,headers:{...noStore,...(error.status===408?{"retry-after":"2"}:{})}});throw error}
    const asset=await createBotMediaAsset({filename,mimeType,byteSize,contentSha256},key);
    if(asset.state==="READY")return Response.json({id:asset.id,state:asset.state},{status:200,headers:noStore});
    if(!asset.uploadToken)return Response.json({error:"The media file cannot be uploaded"},{status:409,headers:noStore});
    const workerBase=process.env.CONNECTOR_WORKER_INTERNAL_URL?.replace(/\/$/u,"");if(!workerBase)throw new Error("Media upload service is not configured");
    const response=await fetch(`${workerBase}/internal/media-assets/${encodeURIComponent(asset.id)}`,{method:"PUT",headers:{authorization:`Bearer ${asset.uploadToken}`,"x-tenant-id":asset.tenantId,"content-type":"application/octet-stream","content-length":String(byteSize)},body,redirect:"error",signal:AbortSignal.timeout(120_000)});
    const result=await response.json().catch(()=>({error:"Media upload failed"}));return Response.json(response.status===401?{error:"Media upload service is temporarily unavailable"}:result,{status:response.status===401?503:response.status,headers:noStore});
  }finally{release()}
}catch(error){return authErrorResponse(error)}}
