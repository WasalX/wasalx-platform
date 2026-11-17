import { NextResponse } from "next/server";
import { isControlPlaneBackend } from "../../../lib/backend.ts";
import { discoverOidcMemberships } from "../../../lib/oidc.ts";
import {
  getPortalSessionFromRequest,
  PortalSessionError,
} from "../../../lib/portal-session.ts";
import { authErrorResponse } from "../../../lib/request-auth.ts";

export async function GET(request: Request) {
  if (!isControlPlaneBackend()) return noStore({ error: "Not found" }, 404);
  try {
    const session = await getPortalSessionFromRequest(request);
    const discovery = await discoverOidcMemberships(session.accessToken);
    if (discovery.subject !== session.subject)
      throw new PortalSessionError("OIDC token subject validation failed");
    if (!discovery.tenants.some((tenant) => tenant.id === session.tenantId))
      throw new PortalSessionError("Access to this workspace has been revoked", 403);
    return noStore({
      data: discovery.tenants.map(({ id, name, slug, role }) => ({
        id,
        name,
        slug,
        role,
        current: id === session.tenantId,
      })),
    });
  } catch (error) {
    const response = authErrorResponse(error);
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
}

function noStore(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}
