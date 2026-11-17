import { isControlPlaneBackend } from "../../../../../../../lib/backend";
import { metaCoexistencePortalRequest } from "../../../../../../../lib/control-plane-data";
import { authenticatePortalRequest } from "../../../../../../../lib/request-auth";
import { readBoundedJson } from "../../../../../../../lib/bounded-json";

type Context = { params: Promise<{ id: string; path?: string[] }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store, private, max-age=0", Pragma: "no-cache" } });
}

async function route(request: Request, context: Context) {
  let summaryRead = false;
  try {
    // Imported personal content is limited to the same owner/admin boundary as configuration.
    await authenticatePortalRequest(request, "connection:write");
    const { id, path = [] } = await context.params;
    if (!uuid.test(id)) return response({ code: "NOT_FOUND" }, 404);
    const method = request.method as "GET" | "POST";
    const paged = (path.length === 1 && path[0] === "contacts") || (path.length === 3 && path[0] === "threads"
      && /^[0-9a-f]{64}$/u.test(path[1]) && path[2] === "messages");
    if (method === "GET" ? path.length !== 0 && !paged : path.length !== 1 || path[0] !== "consent") return response({ code: "NOT_FOUND" }, 404);
    summaryRead = method === "GET" && path.length === 0;
    if (!isControlPlaneBackend()) return summaryRead ? response(null) : response({ code: "SERVICE_UNAVAILABLE" }, 501);
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => !paged || !["cursor", "limit"].includes(key))
      || [...new Set(query.keys())].some(key => query.getAll(key).length !== 1)) return response({ code: "VALIDATION_ERROR" }, 400);
    const cursor = query.get("cursor"), limit = query.get("limit");
    if ((cursor !== null && !/^[A-Za-z0-9_-]{1,256}$/u.test(cursor))
      || (limit !== null && (!/^\d{1,3}$/u.test(limit) || Number(limit) < 1 || Number(limit) > 100))) return response({ code: "VALIDATION_ERROR" }, 400);
    let body: unknown;
    if (method === "POST") {
      let value: unknown;
      try { value = await readBoundedJson(new Response(request.body, { headers: request.headers }), 1024); }
      catch { return response({ code: "VALIDATION_ERROR" }, 400); }
      if (!value || typeof value !== "object" || Array.isArray(value)) return response({ code: "VALIDATION_ERROR" }, 400);
      const input = value as Record<string, unknown>;
      if (Object.keys(input).some(key => !["expectedRevision", "history", "contacts", "echoes"].includes(key))
        || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1
        || input.history !== false || input.contacts !== false || input.echoes !== false) return response({ code: "VALIDATION_ERROR" }, 400);
      body = { expectedRevision: input.expectedRevision, history: false, contacts: false, echoes: false };
    }
    const suffix = `${path.length ? `/${path.map(encodeURIComponent).join("/")}` : ""}${query.size ? `?${query}` : ""}`;
    return response(await metaCoexistencePortalRequest(id, suffix, method, body, method === "POST" ? request.headers.get("origin") ?? undefined : undefined));
  } catch (failure) {
    const status = failure && typeof failure === "object" && "status" in failure && typeof failure.status === "number" ? failure.status : 503;
    const code = failure && typeof failure === "object" && "code" in failure && typeof failure.code === "string" && /^[A-Z_]{1,80}$/u.test(failure.code) ? failure.code : "SERVICE_UNAVAILABLE";
    if (summaryRead && status === 404) return response(null);
    return response({ code }, status >= 400 && status <= 599 ? status : 503);
  }
}

export const GET = route;
export const POST = route;
