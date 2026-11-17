import { getAuditEvents } from "../../../lib/data";
import {
  authenticatePortalRequest,
  authErrorResponse,
} from "../../../lib/request-auth";

export async function GET(request: Request) {
  try {
    await authenticatePortalRequest(request, "audit:read");
    const query = new URL(request.url).searchParams;
    const createdAt = query.get("cursor");
    const id = query.get("cursorId");
    const routine = auditRoutine(query.get("routine"));
    if ((createdAt === null) !== (id === null)) {
      throw new Error("Audit cursor timestamp and ID must be provided together");
    }
    const cursor = createdAt && id ? auditCursor(createdAt, id) : undefined;
    return Response.json(await getAuditEvents(cursor, routine), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    try {
      return authErrorResponse(error);
    } catch {
      return Response.json(
        { error: error instanceof Error ? error.message : "Audit activity could not be loaded" },
        { status: 400, headers: { "cache-control": "private, no-store" } },
      );
    }
  }
}

function auditRoutine(value: string | null): "include" | "exclude" {
  if (value === null) return "exclude";
  if (value !== "include" && value !== "exclude") throw new Error("Audit routine filter is invalid");
  return value;
}

function auditCursor(createdAt: string, id: string) {
  const time = new Date(createdAt);
  if (createdAt.length > 40 || !Number.isFinite(time.getTime()) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new Error("Audit cursor is invalid");
  }
  return { createdAt: time.toISOString(), id };
}
