import { isControlPlaneBackend } from "../../../../../../lib/backend";
import { metaThreadControlPortalRequest } from "../../../../../../lib/control-plane-data";
import { authenticatePortalRequest, requirePermission } from "../../../../../../lib/request-auth";
import { readBoundedJson } from "../../../../../../lib/bounded-json";
import { parseMetaThreadIntent } from "../../../../../../lib/meta-thread-intent";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store, private, max-age=0", Pragma: "no-cache" } });
}
async function route(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const method = request.method as "GET" | "POST";
    const principal = await authenticatePortalRequest(request, method === "GET" ? "bot:read" : "bot:operate");
    if (method === "POST") requirePermission(principal, "connection:write");
    const { id } = await context.params;
    if (!uuid.test(id)) return response({ code: "NOT_FOUND" }, 404);
    if (new URL(request.url).search) return response({ code: "VALIDATION_ERROR" }, 400);
    const key = request.headers.get("idempotency-key");
    if ((key !== null && !uuid.test(key)) || (method === "POST" && !key)) return response({ code: "VALIDATION_ERROR" }, 400);
    let body: unknown;
    if (method === "POST") {
      let value: unknown;
      try { value = await readBoundedJson(new Response(request.body, { headers: request.headers }), 1024); }
      catch { return response({ code: "VALIDATION_ERROR" }, 400); }
      const intent = parseMetaThreadIntent(JSON.stringify({ key, body: value }));
      if (!intent) return response({ code: "VALIDATION_ERROR" }, 400);
      body = intent.body;
    }
    if (!isControlPlaneBackend()) return response({ code: "SERVICE_UNAVAILABLE" }, 501);
    return response(await metaThreadControlPortalRequest(id, method, body, method === "POST" ? request.headers.get("origin") ?? undefined : undefined, key ?? undefined));
  } catch (failure) {
    const status = failure && typeof failure === "object" && "status" in failure && typeof failure.status === "number" ? failure.status : 503;
    const code = failure && typeof failure === "object" && "code" in failure && typeof failure.code === "string" && /^[A-Z_]{1,80}$/u.test(failure.code) ? failure.code : "SERVICE_UNAVAILABLE";
    return response({ code }, status >= 400 && status <= 599 ? status : 503);
  }
}
export const GET = route;
export const POST = route;
