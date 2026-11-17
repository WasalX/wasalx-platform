import { exportAuditCsv } from "../../../../lib/data";
import {
  authenticatePortalRequest,
  authErrorResponse,
} from "../../../../lib/request-auth";

const DAY = 86_400_000;

export async function GET(request: Request) {
  try {
    await authenticatePortalRequest(request, "audit:export");
    const input = exportQuery(new URL(request.url).searchParams);
    const result = await exportAuditCsv(input);
    return new Response(result.body, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${result.filename}"`,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    try {
      return authErrorResponse(error);
    } catch {
      return Response.json(
        { error: error instanceof Error ? error.message : "Audit export failed" },
        { status: 400, headers: { "cache-control": "private, no-store" } },
      );
    }
  }
}

function exportQuery(query: URLSearchParams) {
  const to = timestamp(query.get("to") ?? new Date().toISOString(), "to");
  const from = timestamp(
    query.get("from") ?? new Date(new Date(to).getTime() - 30 * DAY).toISOString(),
    "from",
  );
  if (new Date(from).getTime() >= new Date(to).getTime()) {
    throw new Error("Audit export start must be earlier than its end");
  }
  if (new Date(to).getTime() - new Date(from).getTime() > 366 * DAY) {
    throw new Error("Audit export range cannot exceed 366 days");
  }
  const limit = Number(query.get("limit") ?? 5_000);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("Audit export limit must be between 1 and 10000");
  }
  return { from, to, limit };
}

function timestamp(value: string, label: string) {
  if (value.length > 40 || Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  })) throw new Error(`Audit export ${label} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Audit export ${label} is invalid`);
  return parsed.toISOString();
}
