import { NextResponse } from "next/server";
import { readBoundedJson } from "../../../../lib/bounded-json";

export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store, max-age=0","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"};
export async function POST(request:Request) {
  let body:unknown;
  try {body=await readBoundedJson(new Response(request.body,{headers:request.headers}),1024);} catch {return NextResponse.json({error:"INVALID_REQUEST"},{status:400,headers});}
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).length!==1||!("code" in body)||typeof body.code!=="string"||!/^[0-9a-f]{64}$/u.test(body.code))return NextResponse.json({error:"INVALID_REQUEST"},{status:400,headers});
  const base=process.env.CONTROL_API_URL;
  if(!base)return NextResponse.json({error:"UNAVAILABLE"},{status:503,headers});
  try {
    const response=await fetch(new URL("/webhooks/meta/data-deletion/status",base),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:body.code}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});
    if(response.status===429)return NextResponse.json({error:"LOOKUP_LIMIT"},{status:429,headers:{...headers,"Retry-After":"60"}});
    if(!response.ok)return NextResponse.json({error:"UNAVAILABLE"},{status:503,headers});
    const value=await readBoundedJson<{state:unknown;refusalPolicyUrl?:unknown}>(response,4096);
    const states=["SCOPE_REVIEW_REQUIRED","NEEDS_INFORMATION","HELD","REFUSED","UNAVAILABLE"];
    const state=typeof value.state==="string"&&states.includes(value.state)?value.state:"UNAVAILABLE";
    if(state==="REFUSED"){
      if(typeof value.refusalPolicyUrl!=="string"||value.refusalPolicyUrl.length>2048)throw new Error("Status unavailable");
      const policy=new URL(value.refusalPolicyUrl);if(policy.protocol!=="https:"||policy.username||policy.password||policy.search||policy.hash)throw new Error("Status unavailable");
      return NextResponse.json({state,refusalPolicyUrl:policy.href},{headers});
    }
    return NextResponse.json({state},{headers});
  } catch {return NextResponse.json({error:"UNAVAILABLE"},{status:503,headers});}
}
