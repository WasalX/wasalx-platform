import { NextResponse } from "next/server";
import { isControlPlaneBackend } from "../../../lib/backend";
import {
  createMetaOfficialGroup,
  getMetaGroupInviteLink,
  getMetaGroupsCapability,
  resetMetaGroupInviteLink,
  updateMetaOfficialGroup,
} from "../../../lib/control-plane-data";
import {
  authenticatePortalRequest,
  authErrorResponse,
  type Permission,
} from "../../../lib/request-auth";

export type MetaGroupsPortalAction =
  | "capability"
  | "create"
  | "invite-link"
  | "reset-invite-link"
  | "update";

type RouteContext = {
  params: Promise<{ id: string; groupId?: string }>;
};

export async function metaGroupsRoute(
  request: Request,
  context: RouteContext,
  action: MetaGroupsPortalAction,
) {
  const permission: Permission =
    action === "capability"
      ? "connection:read"
      : action === "invite-link"
        ? "group:read"
        : "group:write";
  try {
    await authenticatePortalRequest(request, permission);
    if (!isControlPlaneBackend()) {
      return noStore(
        {
          error:
            "Official Meta Groups requires the managed service and cannot be simulated.",
        },
        501,
      );
    }
    const { id, groupId } = await context.params;
    if (action === "capability") {
      return noStore(await getMetaGroupsCapability(id), 200);
    }
    if (action === "create") {
      const body = (await request.json().catch(() => ({}))) as {
        subject?: unknown;
        description?: unknown;
        joinApprovalMode?: unknown;
      };
      if (
        typeof body.subject !== "string" ||
        (body.description !== undefined && typeof body.description !== "string") ||
        (body.joinApprovalMode !== undefined &&
          body.joinApprovalMode !== "approval_required" &&
          body.joinApprovalMode !== "auto_approve")
      ) {
        return noStore({ error: "A valid official group subject and configuration are required." }, 400);
      }
      return noStore(
        await createMetaOfficialGroup(
          id,
          {
            subject: body.subject,
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(body.joinApprovalMode === "approval_required" || body.joinApprovalMode === "auto_approve"
              ? { joinApprovalMode: body.joinApprovalMode }
              : {}),
          },
          requireIdempotencyKey(request),
        ),
        202,
      );
    }
    if (!groupId) return noStore({ error: "Official group ID is required." }, 400);
    if (action === "invite-link") {
      return noStore(await getMetaGroupInviteLink(id, groupId), 200);
    }
    if (action === "reset-invite-link") {
      return noStore(
        await resetMetaGroupInviteLink(id, groupId, requireIdempotencyKey(request)),
        200,
      );
    }
    const body = (await request.json().catch(() => ({}))) as {
      subject?: unknown;
      description?: unknown;
    };
    if (
      (body.subject !== undefined && typeof body.subject !== "string") ||
      (body.description !== undefined && typeof body.description !== "string") ||
      (body.subject === undefined && body.description === undefined)
    ) {
      return noStore({ error: "At least one valid official group setting is required." }, 400);
    }
    return noStore(
      await updateMetaOfficialGroup(
        id,
        groupId,
        {
          ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
        },
        requireIdempotencyKey(request),
      ),
      200,
    );
  } catch (error) {
    const response = authErrorResponse(error);
    response.headers.set("Cache-Control", "no-store, private, max-age=0");
    response.headers.set("Pragma", "no-cache");
    return response;
  }
}

function requireIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key");
  if (!value) {
    const error = new Error("A valid Idempotency-Key header is required.") as Error & {
      status: number;
    };
    error.status = 400;
    throw error;
  }
  return value;
}

function noStore(value: unknown, status: number) {
  return NextResponse.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store, private, max-age=0",
      Pragma: "no-cache",
    },
  });
}
