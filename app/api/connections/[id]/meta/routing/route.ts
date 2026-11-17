import { isControlPlaneBackend } from "../../../../../../lib/backend";
import { metaRoutingPortalRequest } from "../../../../../../lib/control-plane-data";
import { authenticatePortalRequest } from "../../../../../../lib/request-auth";
import { readBoundedJson } from "../../../../../../lib/bounded-json";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store, private, max-age=0", Pragma: "no-cache" } });
}
async function route(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const method = request.method as "GET" | "POST";
    await authenticatePortalRequest(request, method === "GET" ? "connection:read" : "connection:write");
    const { id } = await context.params;
    if (!uuid.test(id)) return response({ code: "NOT_FOUND" }, 404);
    if (new URL(request.url).search) return response({ code: "VALIDATION_ERROR" }, 400);
    let body: unknown;
    const key = method === "POST" ? request.headers.get("idempotency-key") : null;
    if (method === "POST") {
      if (!key || !uuid.test(key)) return response({ code: "VALIDATION_ERROR" }, 400);
      let value: unknown;
      try { value = await readBoundedJson(new Response(request.body, { headers: request.headers }), 1024); }
      catch { return response({ code: "VALIDATION_ERROR" }, 400); }
      if (!value || typeof value !== "object" || Array.isArray(value)) return response({ code: "VALIDATION_ERROR" }, 400);
      const input = value as Record<string, unknown>;
      if (Object.keys(input).some(field => !["expectedVersion", "expectedSessionId", "fallback"].includes(field))
        || !Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 0
        || typeof input.expectedSessionId !== "string" || !uuid.test(input.expectedSessionId)
        || input.fallback !== "HOLD") return response({ code: "VALIDATION_ERROR" }, 400);
      body = { expectedVersion: input.expectedVersion, expectedSessionId: input.expectedSessionId, fallback: "HOLD" };
    }
    if (!isControlPlaneBackend()) return response({ code: "SERVICE_UNAVAILABLE" }, 501);
    return response(await metaRoutingPortalRequest(id, method, body, method === "POST" ? request.headers.get("origin") ?? undefined : undefined, key ?? undefined));
  } catch (failure) {
    const status = failure && typeof failure === "object" && "status" in failure && typeof failure.status === "number" ? failure.status : 503;
    const code = failure && typeof failure === "object" && "code" in failure && typeof failure.code === "string" && /^[A-Z_]{1,80}$/u.test(failure.code) ? failure.code : "SERVICE_UNAVAILABLE";
    return response({ code }, status >= 400 && status <= 599 ? status : 503);
  }
}
export const GET = route;
export const POST = route;
