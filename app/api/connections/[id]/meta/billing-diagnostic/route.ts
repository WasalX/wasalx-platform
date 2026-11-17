import { NextResponse } from "next/server";
import { isControlPlaneBackend, isFixtureBackend } from "../../../../../../lib/backend";
import { getMetaBillingDiagnostic, requestMetaBillingDiagnostic } from "../../../../../../lib/control-plane-data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../../lib/request-auth";
import { readBoundedJson } from "../../../../../../lib/bounded-json";

type Context = { params: Promise<{id:string}> };
const headers = {"Cache-Control":"no-store, private, max-age=0",Pragma:"no-cache"};
export async function GET(request:Request,context:Context) {
  try {
    await authenticatePortalRequest(request,"connection:read");
    // Explicit portal fixtures contain no recorded payment checks, not a provider result.
    if (isFixtureBackend()) return NextResponse.json({operationId:null,state:null,diagnostic:null,current:false},{headers});
    if (!isControlPlaneBackend()) return NextResponse.json({error:"Payment diagnostics require the persistent backend."},{status:501,headers});
    return NextResponse.json(await getMetaBillingDiagnostic((await context.params).id),{headers});
  } catch(error) {const response=authErrorResponse(error);Object.entries(headers).forEach(([key,value])=>response.headers.set(key,value));return response;}
}
export async function POST(request:Request,context:Context) {
  try {
    await authenticatePortalRequest(request,"connection:write");
    if (!isControlPlaneBackend()) return NextResponse.json({error:"Payment diagnostics require the persistent backend."},{status:501,headers});
    let body:unknown;
    try {body=await readBoundedJson(new Response(request.body,{headers:request.headers}),4096);} catch {return NextResponse.json({error:"A valid diagnostic request is required."},{status:400,headers});}
    if (!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).length) return NextResponse.json({error:"Payment diagnostics do not accept payment settings."},{status:400,headers});
    const key=request.headers.get("idempotency-key");
    if (!key) return NextResponse.json({error:"A valid Idempotency-Key header is required."},{status:400,headers});
    return NextResponse.json(await requestMetaBillingDiagnostic((await context.params).id,key),{status:202,headers});
  } catch(error) {const response=authErrorResponse(error);Object.entries(headers).forEach(([key,value])=>response.headers.set(key,value));return response;}
}
