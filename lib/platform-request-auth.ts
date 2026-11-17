import { isControlPlaneBackend } from "./backend.ts";
import {
  parsePlatformCookies,
  platformPortalOrigin,
  platformSessionCookieName,
  PlatformPortalSessionError,
} from "./platform-portal-session.ts";
import { loadStoredPlatformSession } from "./platform-portal-session-store.ts";

export async function authenticatePlatformPortalRequest(request: Request) {
  return authenticate(request, ["application/json"]);
}

/** Only the cost-source binary route calls this narrow shared entry point. */
export async function authenticatePlatformCostSourceRequest(request: Request) {
  return authenticate(request, ["application/pdf", "text/csv", "application/json"]);
}

async function authenticate(request: Request, allowedMimeTypes: readonly string[]) {
  if (!isControlPlaneBackend()) {
    throw new PlatformPortalSessionError(
      "The platform console is available only on the managed control plane",
      404,
    );
  }
  if (request.headers.get("x-wasalx-tenant-id") !== null) {
    throw new PlatformPortalSessionError(
      "Tenant context is forbidden on platform operator requests",
      401,
    );
  }
  const sessionId = parsePlatformCookies(request.headers.get("cookie") ?? "").get(
    platformSessionCookieName(),
  );
  if (!sessionId) throw new PlatformPortalSessionError("Platform sign-in is required");
  const session = await loadStoredPlatformSession(sessionId);
  if (!safeMethod(request.method)) enforceMutationSecurity(request, session.csrfToken, allowedMimeTypes);
  return session;
}

export function platformAuthErrorResponse(error: unknown) {
  if (error instanceof PlatformPortalSessionError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

function enforceMutationSecurity(request: Request, csrfToken: string, allowedMimeTypes: readonly string[]) {
  if (request.headers.get("origin") !== platformPortalOrigin()) {
    throw new PlatformPortalSessionError(
      "The platform request origin could not be verified",
      403,
    );
  }
  if (!allowedMimeTypes.includes(request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "")) {
    throw new PlatformPortalSessionError(
      allowedMimeTypes.length === 1 ? "Platform mutations require application/json" : "The source file type is not supported",
      403,
    );
  }
  if (!constantTimeEqual(request.headers.get("x-wasalx-platform-csrf") ?? "", csrfToken)) {
    throw new PlatformPortalSessionError(
      "The platform request verification token is invalid",
      403,
    );
  }
}

function safeMethod(method: string) {
  return ["GET", "HEAD", "OPTIONS"].includes(method);
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
