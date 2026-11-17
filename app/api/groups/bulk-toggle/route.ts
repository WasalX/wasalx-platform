import { toggleGroup } from "../../../../lib/data";
import {
  authenticatePortalRequest,
  authErrorResponse,
} from "../../../../lib/request-auth";

const SAFE_GROUP_CODES=new Set(["CONFIGURATION_REQUIRED","CONNECTION_NOT_WORKING","CONNECTION_OPERATION_PENDING","WEBHOOK_ROUTE_NOT_ACTIVE","PROVIDER_SESSION_NOT_WORKING","WAHA_WORKER_NOT_READY","GROUP_SYNC_STALE","ZAMMAD_NOT_WORKING","RULE_SET_NOT_ACTIVE","NO_ENABLED_RULES","ZAMMAD_ROUTING_NOT_READY","GROUP_BOT_ALREADY_DESIGNATED","READINESS_UNAVAILABLE"]);

export async function POST(request: Request) {
  try {
    const principal = await authenticatePortalRequest(request, "group:write");
    const key=request.headers.get("idempotency-key")??"";
    if(!key||key.length>255)return Response.json({code:"VALIDATION_ERROR",error:"A valid idempotency key is required"},{status:400});
    const body = await request.json() as { ids?: unknown; enabled?: unknown; expectedRevisions?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 100) {
      return Response.json({ code:"VALIDATION_ERROR",error: "Select between 1 and 100 groups" }, { status: 400 });
    }
    if (typeof body.enabled !== "boolean") {
      return Response.json({ code:"VALIDATION_ERROR",error: "enabled must be a boolean" }, { status: 400 });
    }
    const ids = [...new Set(body.ids.map(String))];
    if (ids.some((id) => !id || id.length > 160)) {
      return Response.json({ code:"VALIDATION_ERROR",error: "A selected group ID is invalid" }, { status: 400 });
    }
    const expectedRevisions=body.expectedRevisions&&typeof body.expectedRevisions==="object"&&!Array.isArray(body.expectedRevisions)?body.expectedRevisions as Record<string,unknown>:{};
    if(ids.some(id=>!Number.isSafeInteger(expectedRevisions[id])||Number(expectedRevisions[id])<1))return Response.json({code:"CONFLICT",error:"Refresh the selected groups before changing them"},{status:409});
    const settled = await Promise.allSettled(
      ids.map((id) => toggleGroup(id, body.enabled as boolean, principal.displayName,Number(expectedRevisions[id]),`${key}:${id}`)),
    );
    const results = settled.map((result, index) => result.status === "fulfilled"
      ? { id: ids[index], ok: true }
      : {
          id: ids[index],
          ok: false,
          error: "The group could not be updated. Refresh its readiness before trying again.",
          code: (typeof result.reason?.code==="string"&&SAFE_GROUP_CODES.has(result.reason.code))?result.reason.code:"SERVICE_UNAVAILABLE",
        });
    const succeeded = results.filter((result) => result.ok).length;
    return Response.json(
      { requested: ids.length, succeeded, failed: ids.length - succeeded, results },
      { status: succeeded === ids.length ? 200 : 207, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
