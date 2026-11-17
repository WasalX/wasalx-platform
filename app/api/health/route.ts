import { NextResponse } from "next/server";
import { isControlPlaneBackend } from "../../../lib/backend";
import { getDashboardData } from "../../../lib/data";

export async function GET(){
  if(isControlPlaneBackend()){
    const base=process.env.CONTROL_API_URL?.replace(/\/$/,"");
    const configured=Boolean(base&&process.env.PORTAL_SESSION_SECRET&&process.env.PORTAL_SESSION_SECRET.length>=32&&process.env.OIDC_ISSUER&&process.env.OIDC_CLIENT_ID&&process.env.OIDC_REDIRECT_URI&&process.env.PORTAL_PUBLIC_ORIGIN&&(process.env.PORTAL_SESSION_REDIS_URL||process.env.REDIS_URL));
    if(!configured)return NextResponse.json({status:"failed",timestamp:new Date().toISOString()},{status:503});
    try{
      const [{portalSessionStoreReady},response]=await Promise.all([import("../../../lib/portal-session-store"),fetch(`${base}/health/ready`,{cache:"no-store",signal:AbortSignal.timeout(3_000)})]);
      const sessionStore=await portalSessionStoreReady();const ready=response.ok&&sessionStore;
      return NextResponse.json({status:ready?"operational":"failed",timestamp:new Date().toISOString()},{status:ready?200:503});
    }catch{return NextResponse.json({status:"failed",timestamp:new Date().toISOString()},{status:503})}
  }
  const data=await getDashboardData();
  return NextResponse.json({status:data.connections.some((c)=>c.state==="ACTION_REQUIRED")?"degraded":"operational",timestamp:new Date().toISOString()});
}
