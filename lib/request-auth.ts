import {
  isControlPlaneBackend,
  isSitesPrivateDemoBackend,
  sitesPrivateDemoError,
} from "./backend.ts";
import { portalFixturePersona } from "./fixture-role.ts";
import {
  getPortalSessionFromRequest,
  portalPublicOrigin,
  PortalSessionError,
} from "./portal-session.ts";
import { can, type Permission, type TenantRole } from "./tenant-permissions.ts";
export { can, type Permission, type TenantRole } from "./tenant-permissions.ts";

export type RequestPrincipal = {
  userId: string;
  email: string;
  displayName: string;
  tenantId: string;
  role: TenantRole;
};

export class AuthenticationError extends Error {
  status = 401;
}
export class AuthorizationError extends Error {
  status = 403;
}
export class RequestSecurityError extends Error {
  status = 403;
}

export function requirePermission(
  principal: RequestPrincipal,
  permission: Permission,
) {
  if (!can(principal.role, permission))
    throw new AuthorizationError(`Role ${principal.role} lacks ${permission}`);
}

export async function authenticatePortalRequest(
  request: Request,
  permission?: Permission,
): Promise<RequestPrincipal> {
  return authenticatePortalRequestWithContentTypes(request, permission, ["application/json"]);
}

export async function authenticatePortalBinaryUploadRequest(
  request: Request,
  permission: Permission,
  allowedContentTypes: readonly string[],
): Promise<RequestPrincipal> {
  if (!allowedContentTypes.length || allowedContentTypes.some((value) => value !== value.trim().toLowerCase() || value === "application/json"))
    throw new RequestSecurityError("The upload media types are invalid");
  return authenticatePortalRequestWithContentTypes(request, permission, allowedContentTypes);
}

async function authenticatePortalRequestWithContentTypes(
  request: Request,
  permission: Permission | undefined,
  allowedContentTypes: readonly string[],
): Promise<RequestPrincipal> {
  if (isControlPlaneBackend()) {
    const session = await getPortalSessionFromRequest(request);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method))
      enforceMutationSecurity(request, session.csrfToken, allowedContentTypes);
    const principal = {
      userId: session.userId,
      email: session.email,
      displayName: session.displayName,
      tenantId: session.tenantId,
      role: session.role,
    };
    if (permission) requirePermission(principal, permission);
    enforceSitesPrivateDemoBoundary(request);
    return principal;
  }
  const userId = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email");
  const url = new URL(request.url);
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const fixturePersona = portalFixturePersona();
  if (!userId || !email) {
    if (!isLocal)
      throw new AuthenticationError(
        "Authenticated workspace identity is required",
      );
    const principal = {
      userId: fixturePersona?.userId ?? "local-preview",
      email: fixturePersona?.email ?? "maya@northstar.example",
      displayName: fixturePersona?.displayName ?? "Maya Al-Salem",
      tenantId: "tenant_northstar",
      role: fixturePersona?.role ?? "tenant_owner" as const,
    };
    if (permission) requirePermission(principal, permission);
    enforceSitesPrivateDemoBoundary(request);
    return principal;
  }
  const encodedName = request.headers.get("oai-authenticated-user-full-name");
  const encoding = request.headers.get(
    "oai-authenticated-user-full-name-encoding",
  );
  let displayName = email;
  if (encodedName && encoding === "percent-encoded-utf-8") {
    try {
      displayName = decodeURIComponent(encodedName);
    } catch {
      displayName = email;
    }
  }

  // Sites is owner-only for the pilot. The production OIDC adapter replaces this role
  // with a database membership lookup before commercial multi-user rollout.
  const principal = {
    userId,
    email,
    displayName,
    tenantId: "tenant_northstar",
    role: fixturePersona?.role ?? "tenant_owner" as const,
  };
  if (permission) requirePermission(principal, permission);
  enforceSitesPrivateDemoBoundary(request);
  return principal;
}

function enforceSitesPrivateDemoBoundary(request: Request) {
  if (
    isSitesPrivateDemoBackend() &&
    !["GET", "HEAD", "OPTIONS"].includes(request.method)
  ) {
    throw sitesPrivateDemoError("Administrative mutations");
  }
}

function enforceMutationSecurity(request: Request, csrfToken: string, allowedContentTypes: readonly string[]) {
  if (request.headers.get("origin") !== portalPublicOrigin())
    throw new RequestSecurityError("The request origin could not be verified");
  const contentType=request.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase()??"";
  if (!allowedContentTypes.includes(contentType))
    throw new RequestSecurityError(allowedContentTypes.length===1&&allowedContentTypes[0]==="application/json"?"Mutations require application/json":"The upload media type is not allowed");
  const provided = request.headers.get("x-wasalx-csrf") ?? "";
  if (!constantTimeEqual(provided, csrfToken))
    throw new RequestSecurityError("The request verification token is invalid");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function authErrorResponse(error: unknown) {
  if (
    error instanceof AuthenticationError ||
    error instanceof AuthorizationError ||
    error instanceof RequestSecurityError ||
    error instanceof PortalSessionError
  ) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    const code =
      "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    return Response.json(
      { error: error.message, ...(code ? { code } : {}) },
      { status: error.status },
    );
  }
  throw error;
}
