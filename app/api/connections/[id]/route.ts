import { NextResponse } from "next/server";
import { isControlPlaneBackend } from "../../../../lib/backend";
import { getConnectionDetail } from "../../../../lib/control-plane-data";
import { getDashboardData } from "../../../../lib/data";
import {
  authenticatePortalRequest,
  authErrorResponse,
} from "../../../../lib/request-auth";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await authenticatePortalRequest(request, "connection:read");
    const { id } = await context.params;
    if (isControlPlaneBackend()) {
      return NextResponse.json(await getConnectionDetail(id));
    }
    const data = await getDashboardData();
    const connection = data.connections.find(
      (row) => String(row.id) === id,
    );
    if (!connection) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 },
      );
    }
    return NextResponse.json(connection);
  } catch (error) {
    return authErrorResponse(error);
  }
}
