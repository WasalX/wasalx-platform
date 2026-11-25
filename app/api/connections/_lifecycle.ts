import { NextResponse } from "next/server";
import { isControlPlaneBackend } from "../../../lib/backend";
import {
  connectionLifecycle,
  type ConnectionLifecycleAction,
} from "../../../lib/control-plane-data";
import {
  authenticatePortalRequest,
  authErrorResponse,
  type Permission,
} from "../../../lib/request-auth";

type RouteContext = { params: Promise<{ id: string }> };

export async function lifecycleRoute(
  request: Request,
  context: RouteContext,
  action: ConnectionLifecycleAction,
  permission: Permission = "connection:write",
) {
  try {
    await authenticatePortalRequest(request, permission);
    if (!isControlPlaneBackend()) {
      return NextResponse.json(
        {
          error:
            "Connection lifecycle operations require the managed service.",
        },
        { status: 501 },
      );
    }
    let body: Record<string, unknown> | undefined;
    if (action === "disconnect") {
      const input = (await request.json().catch(() => ({}))) as {
        confirmation?: unknown;
      };
      if (input.confirmation !== "DISCONNECT") {
        return NextResponse.json(
          { error: 'Type "DISCONNECT" to confirm permanent disconnection.' },
          { status: 400 },
        );
      }
      body = { confirmation: "DISCONNECT" };
    } else if (action === "groups/sync") {
      const text = await request.text();
      let input;
      try { input = text ? JSON.parse(text) : {}; }
      catch { return NextResponse.json({ error: "A valid group synchronization request is required." }, { status: 400 }); }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return NextResponse.json({ error: "A valid group synchronization request is required." }, { status: 400 });
      }
      body = { eligibilityAccepted: input.eligibilityAccepted, eligibilityVersion: input.eligibilityVersion };
    }
    const { id } = await context.params;
    const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;
    const result = await connectionLifecycle(
      id,
      action,
      idempotencyKey,
      body,
    );
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
