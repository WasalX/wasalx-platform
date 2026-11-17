import { NextResponse } from "next/server";
import { isFixtureBackend } from "../../../../../lib/backend";
import { retryOutboundByTicket } from "../../../../../lib/data";
import { ServiceAuthenticationError, verifyServiceJwt } from "../../../../../packages/core/src/service-auth";

export async function POST(request:Request){
  if(!isFixtureBackend())return NextResponse.json({error:"Zammad ingress is not exposed by the portal"},{status:404});
  try{
    const secret=process.env.ZAMMAD_SERVICE_JWT_SECRET;
    const token=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"");
    if(!secret)return NextResponse.json({error:"Service authentication unavailable"},{status:503});
    if(!token)return NextResponse.json({error:"Bearer token required"},{status:401});
    const claims=await verifyServiceJwt(token,secret,{audience:"wasalx-control",scope:"zammad:retry"});
    const body=await request.json() as {tenant_id?:string;ticket_id?:string|number;article_id?:string|number;actor_id?:string|number};
    if(body.tenant_id!==claims.tenant_id)return NextResponse.json({error:"Tenant mismatch"},{status:403});
    if(body.ticket_id==null||body.article_id==null||body.actor_id==null)return NextResponse.json({error:"ticket_id, article_id, and actor_id are required"},{status:400});
    const result=await retryOutboundByTicket({tenantId:claims.tenant_id,ticketId:String(body.ticket_id),articleId:String(body.article_id)});
    return NextResponse.json(result,{status:202});
  }catch(error){
    if(error instanceof ServiceAuthenticationError)return NextResponse.json({error:error.message},{status:401});
    const message=error instanceof Error?error.message:"Retry failed";
    return NextResponse.json({error:message},{status:message==="Delivery not found"?404:409});
  }
}
