import { NextResponse } from "next/server";
import { isFixtureBackend, portalDataBackend } from "../../../../lib/backend";
import { acceptWahaEvent } from "../../../../lib/data";
import { verifyHmac } from "../../../../packages/core/src/security";

export async function POST(request: Request, context: {params:Promise<{token:string}>}) {
  if(!isFixtureBackend())return NextResponse.json({error:"Provider ingress is not exposed by the portal"},{status:404});
  const env = process.env;
  const {token}=await context.params;const raw=await request.text();if(raw.length>2_000_000)return NextResponse.json({error:"Payload too large"},{status:413});
  const secret=env.WAHA_WEBHOOK_SECRET;const local=["localhost","127.0.0.1","::1"].includes(new URL(request.url).hostname);
  const unsignedFixture=portalDataBackend()==="fixture"&&local;
  if(!secret&&!unsignedFixture)return NextResponse.json({error:"Webhook verification is unavailable"},{status:503});
  if(secret){if(request.headers.get("x-webhook-hmac-algorithm")?.toLowerCase()!=="sha512")return NextResponse.json({error:"Unsupported signature algorithm"},{status:401});const verification=await verifyHmac({rawBody:raw,secret,provided:request.headers.get("x-webhook-hmac")??"",timestamp:request.headers.get("x-webhook-timestamp")??undefined,algorithm:"sha512",requireTimestamp:true});if(!verification.valid)return NextResponse.json({error:verification.reason==="stale"?"Stale request":"Invalid signature"},{status:401})}
  let body:Record<string,unknown>;try{body=JSON.parse(raw)}catch{return NextResponse.json({error:"Invalid JSON"},{status:400})}
  const eventId=String(request.headers.get("x-webhook-request-id")??body.id??body.event_id??"");if(!eventId)return NextResponse.json({error:"Event ID is required"},{status:400});
  try{const accepted=await acceptWahaEvent(token,eventId,String(body.event??body.event_type??"unknown"),raw);return NextResponse.json({accepted:true,...accepted},{status:accepted.duplicate?200:202})}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Webhook endpoint rejected"},{status:404})}
}
