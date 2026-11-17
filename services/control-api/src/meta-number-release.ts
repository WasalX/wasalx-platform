import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { requirePrivilegedAuthentication } from "./privileged-auth.js";
import type { AuthenticatedRequest } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export async function readMetaNumberRelease(client: PoolClient, tenantId: string, connectionId: string) {
  if ((!UUID.test(connectionId) || connectionId.length!==36)) throw invalid();
  const row = (await client.query(`SELECT route.id AS "routeId",route.external_key AS "phoneNumberId",
    route.reservation_release_id AS "releaseId",connection.state,
    (SELECT id FROM connection_operations operation WHERE operation.tenant_id=connection.tenant_id
      AND operation.connection_id=connection.id AND operation.operation_type='DISCONNECT'
      AND operation.state='SUCCEEDED' ORDER BY operation.created_at DESC LIMIT 1) AS "disconnectOperationId"
    FROM connections connection JOIN webhook_routes route ON route.tenant_id=connection.tenant_id AND route.connection_id=connection.id
    WHERE connection.tenant_id=$1 AND connection.id=$2 AND connection.provider='META'`, [tenantId, connectionId])).rows[0];
  if (!row) throw new NotFoundException("Connection not found");
  return { ...row, reconnectRequiresNewConnection: true };
}

export async function releaseMetaNumber(client: PoolClient, request: AuthenticatedRequest, connectionId: string, key: string, body: unknown) {
  if ((!UUID.test(connectionId) || connectionId.length!==36) || !body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const value = body as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "disconnectOperationId,phoneNumberId,routeId"
    || typeof value.routeId !== "string" || value.routeId.length!==36 || !UUID.test(value.routeId)
    || typeof value.disconnectOperationId !== "string" || value.disconnectOperationId.length!==36 || !UUID.test(value.disconnectOperationId)
    || typeof value.phoneNumberId !== "string" || value.phoneNumberId.trim()!==value.phoneNumberId || !/^\d{5,32}$/u.test(value.phoneNumberId)) throw invalid();
  await requirePrivilegedAuthentication(client, request.principal, "releasing a disconnected WhatsApp number");
  try {
    const row = (await client.query<{ result: Record<string, unknown> }>(
      "SELECT app.release_meta_number($1,$2,$3,$4,$5,$6,$7) AS result",
      [connectionId, value.routeId, value.disconnectOperationId, value.phoneNumberId, key, request.principal.userId, String(request.id)])).rows[0];
    if (!row) throw new ConflictException({ code: "META_NUMBER_RELEASE_NOT_READY", message: "Review the disconnected number before releasing it." });
    return row.result;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "P0002") throw new NotFoundException("Connection not found");
    if (code === "42501") throw new ForbiddenException({ code: "META_NUMBER_RELEASE_FORBIDDEN", message: "Current workspace administration is required." }, { cause:error });
    if (code === "22023") throw invalid();
    if (code === "55000" || code === "23505" || code === "23514" || code === "55P03") {
      throw new ConflictException({ code: "META_NUMBER_RELEASE_NOT_READY", message: "The number or its pending work changed. Review its disconnected state before releasing it." }, { cause:error });
    }
    throw error;
  }
}
function invalid() { return new BadRequestException({ code: "META_NUMBER_RELEASE_INVALID", message: "Review the number release details." }); }
