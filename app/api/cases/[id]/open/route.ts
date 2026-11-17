import { NextResponse } from "next/server";
import { agentTicketDestination } from "../../../../../lib/agent-ticket-destination";
import { getCaseAgentDestination } from "../../../../../lib/data";
import { authenticatePortalRequest, authErrorResponse, requirePermission } from "../../../../../lib/request-auth";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const principal = await authenticatePortalRequest(request, "case:read");
    requirePermission(principal, "ticket:read");
    const { id } = await context.params;
    const { ticket_number } = await getCaseAgentDestination(id);
    return NextResponse.redirect(agentTicketDestination(request.url, ticket_number), 303);
  } catch (error) {
    return authErrorResponse(error);
  }
}
