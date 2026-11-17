import { NextResponse } from "next/server";
import { agentTicketDestination } from "../../../../../lib/agent-ticket-destination";
import { getDeliveryAgentDestination } from "../../../../../lib/data";
import { authenticatePortalRequest,authErrorResponse,requirePermission } from "../../../../../lib/request-auth";

export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  try{
    const principal=await authenticatePortalRequest(request,"delivery:read");
    requirePermission(principal,"ticket:read");
    const{id}=await context.params;
    const{ticket_number}=await getDeliveryAgentDestination(id);
    return NextResponse.redirect(agentTicketDestination(request.url,ticket_number),303);
  }catch(error){return authErrorResponse(error)}
}
