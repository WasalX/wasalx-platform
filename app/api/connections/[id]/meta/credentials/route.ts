import { NextResponse } from "next/server";
import { isControlPlaneBackend } from "../../../../../../lib/backend";
import { rotateMetaCredential } from "../../../../../../lib/control-plane-data";
import {
  authenticatePortalRequest,
  authErrorResponse,
} from "../../../../../../lib/request-auth";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await authenticatePortalRequest(request, "connection:write");
    if (!isControlPlaneBackend()) {
      return response({ error: "Meta credentials require the managed service." }, 501);
    }
    const body = (await request.json().catch(() => ({}))) as { accessToken?: unknown };
    if (
      typeof body.accessToken !== "string" ||
      body.accessToken.length < 16 ||
      body.accessToken.length > 4_096 ||
      Array.from(body.accessToken).some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 || code === 127;
      })
    ) {
      return response({ error: "A valid Meta System User access token is required." }, 400);
    }
    const { id } = await context.params;
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!idempotencyKey || idempotencyKey.length > 255) {
      return response({ error: "A valid Idempotency-Key header is required." }, 400);
    }
    return response(await rotateMetaCredential(id, body.accessToken, idempotencyKey), 200);
  } catch (error) {
    const result = authErrorResponse(error);
    result.headers.set("Cache-Control", "no-store, private, max-age=0");
    result.headers.set("Pragma", "no-cache");
    return result;
  }
}

function response(value: unknown, status: number) {
  return NextResponse.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store, private, max-age=0",
      Pragma: "no-cache",
    },
  });
}
