import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { appendAudit } from "./audit.js";
import { DatabaseService } from "./database.service.js";
import { Requires } from "./permission.guard.js";
import type { AuthenticatedRequest } from "./types.js";

type AuditRow = {
  id: string;
  actor_type: string;
  actor_id: string;
  actor_display_name: string | null;
  action: string;
  target_type: string;
  target_id: string;
  previous_value: unknown;
  new_value: unknown;
  request_id: string;
  created_at: string | Date;
};

const AUDIT_SELECT = `SELECT a.id,a.actor_type,a.actor_id,
  u.display_name AS actor_display_name,a.action,a.target_type,a.target_id,
  a.previous_value,a.new_value,a.request_id,a.created_at
  FROM audit_events a LEFT JOIN users u ON u.id::text=a.actor_id`;

@Controller("v1/audit-events")
export class AuditController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  @Requires("audit:read")
  async list(
    @Req() request: AuthenticatedRequest,
    @Query("cursor") cursor?: string,
    @Query("cursorId") cursorId?: string,
    @Query("routine") routineValue?: string,
  ) {
    if ((cursor === undefined) !== (cursorId === undefined)) {
      throw new BadRequestException("Audit cursor timestamp and ID must be provided together");
    }
    const parsedCursor = cursor === undefined ? null : isoTimestamp(cursor, "cursor");
    const parsedCursorId = cursorId === undefined ? null : uuid(cursorId, "cursor ID");
    const includeRoutine = auditRoutine(routineValue) === "include";
    const rows = await this.database.rows<AuditRow>(
      request.principal.tenantId,
      `${AUDIT_SELECT}
       WHERE a.tenant_id=$1
         AND ($2::timestamptz IS NULL OR (a.created_at,a.id)<($2,$3::uuid))
         AND ($4::boolean OR NOT (
           a.actor_type='SYSTEM'
           AND a.action='privacy.job_succeeded'
           AND a.target_type='privacy_job'
           AND EXISTS (
             SELECT 1 FROM privacy_jobs job
              WHERE job.tenant_id=a.tenant_id
                AND job.id::text=a.target_id
                AND job.job_type='RETENTION_SWEEP'
           )
           AND COALESCE(a.new_value->>'zammadTickets','0')='0'
           AND COALESCE(a.new_value->>'botConversations','0')='0'
           AND COALESCE(a.new_value->>'normalizedMessages','0')='0'
           AND COALESCE(a.new_value->>'deliveryBodies','0')='0'
           AND COALESCE(a.new_value->>'participantIdentities','0')='0'
           AND COALESCE(a.new_value->>'groupWorkspaceParticipants','0')='0'
           AND COALESCE(a.new_value->>'mediaObjects','0')='0'
           AND COALESCE(a.new_value->>'exportArtifacts','0')='0'
           AND COALESCE(a.new_value->>'exportObjects','0')='0'
           AND COALESCE(a.new_value->>'unmatchedDiagnostics','0')='0'
         ))
       ORDER BY a.created_at DESC,a.id DESC LIMIT 100`,
      [request.principal.tenantId, parsedCursor, parsedCursorId, includeRoutine],
    );
    return rows.map(projectAuditRow);
  }

  @Get("export")
  @Requires("audit:export")
  async export(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") rawLimit?: string,
  ) {
    const toValue = to === undefined ? new Date().toISOString() : isoTimestamp(to, "to");
    const fromValue =
      from === undefined
        ? new Date(new Date(toValue).getTime() - 30 * 86_400_000).toISOString()
        : isoTimestamp(from, "from");
    if (new Date(fromValue).getTime() >= new Date(toValue).getTime()) {
      throw new BadRequestException("Audit export from must be earlier than to");
    }
    if (new Date(toValue).getTime() - new Date(fromValue).getTime() > 366 * 86_400_000) {
      throw new BadRequestException("Audit export range cannot exceed 366 days");
    }
    const limit = rawLimit === undefined ? 5_000 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new BadRequestException("Audit export limit must be between 1 and 10000");
    }
    const rows = await this.database.withTenant(
      request.principal.tenantId,
      async (client) => {
        const exported = (
          await client.query<AuditRow>(
            `${AUDIT_SELECT}
             WHERE a.tenant_id=$1 AND a.created_at>=$2 AND a.created_at<$3
             ORDER BY a.created_at DESC,a.id DESC LIMIT $4`,
            [request.principal.tenantId, fromValue, toValue, limit],
          )
        ).rows;
        await appendAudit(client, request.principal, {
          action: "audit.exported",
          targetType: "audit_export",
          targetId: `${fromValue}/${toValue}`,
          requestId: String(request.id),
          newValue: {
            from: fromValue,
            to: toValue,
            requested_limit: limit,
            exported_rows: exported.length,
            redaction_policy: "SECRET_AND_MESSAGE_FIELDS",
          },
        });
        return exported;
      },
    );
    const body = auditCsv(rows);
    reply
      .header("cache-control", "private, no-store")
      .header("content-type", "text/csv; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="wasalx-audit-${fromValue.slice(0, 10)}-${toValue.slice(0, 10)}.csv"`,
      )
      .header("x-content-type-options", "nosniff")
      .send(body);
  }
}

export function auditCsv(rows: AuditRow[]) {
  const header = [
    "time",
    "actor_type",
    "actor_id",
    "actor_display_name",
    "action",
    "target_type",
    "target_id",
    "request_id",
    "previous_value",
    "new_value",
  ];
  const records = rows.map(projectAuditRow).map((row) => [
    new Date(row.created_at).toISOString(),
    row.actor_type,
    row.actor_id,
    row.actor_display_name ?? "",
    row.action,
    row.target_type,
    row.target_id,
    row.request_id,
    safeJson(row.previous_value),
    safeJson(row.new_value),
  ]);
  return `\uFEFF${[header, ...records].map((record) => record.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function projectAuditRow(row: AuditRow): AuditRow {
  return {
    ...row,
    actor_type: publicAuditLabel(row.actor_type),
    action: publicAuditLabel(row.action),
    target_type: publicAuditLabel(row.target_type),
    previous_value: publicAuditValue(row.previous_value),
    new_value: publicAuditValue(row.new_value),
  };
}

const PUBLIC_AUDIT_LABELS: Readonly<Record<string, string>> = {
  ZAMMAD_USER: "WORKSPACE_USER",
  ZAMMAD_AGENT: "WORKSPACE_AGENT",
  ZAMMAD_TICKET: "WORKSPACE_TICKET",
  ZAMMAD_USER_DATA_PRIVACY: "WORKSPACE_USER_DATA_PRIVACY",
  zammad_ticket: "workspace_ticket",
  zammad_email_route: "workspace_email_route",
  zammad_instance: "workspace_instance",
  "zammad_email.route_pinned": "workspace_email.route_pinned",
  "zammad_email.route_applied": "workspace_email.route_applied",
  "zammad_email.route_manually_overridden": "workspace_email.route_manually_overridden",
  "delivery.retry_requested_from_zammad": "delivery.retry_requested_from_workspace",
  zammad_ticket_id: "workspace_ticket_id",
  zammad_article_id: "workspace_article_id",
  zammad_group_id: "workspace_group_id",
  zammad_instance_id: "workspace_instance_id",
  zammad_state: "workspace_state",
  zammad_state_id: "workspace_state_id",
  zammad_state_name: "workspace_state_name",
  zammad_state_type_name: "workspace_state_type_name",
  zammadGroupId: "workspaceGroupId",
  zammadTickets: "workspaceTickets",
  ZAMMAD_ENDPOINT_INVALID: "WORKSPACE_ENDPOINT_INVALID",
  ZAMMAD_TIMEOUT_INVALID: "WORKSPACE_TIMEOUT_INVALID",
  ZAMMAD_ID_INVALID: "WORKSPACE_ID_INVALID",
  ZAMMAD_PRIVACY_ADMISSION_REQUIRED: "WORKSPACE_PRIVACY_ADMISSION_REQUIRED",
  ZAMMAD_PRIVACY_CREDENTIAL_INVALID: "WORKSPACE_PRIVACY_CREDENTIAL_INVALID",
  ZAMMAD_PRIVACY_PERMISSION_DENIED: "WORKSPACE_PRIVACY_PERMISSION_DENIED",
  ZAMMAD_PRIVACY_HTTP: "WORKSPACE_PRIVACY_HTTP",
  ZAMMAD_PRIVACY_RESPONSE_INVALID: "WORKSPACE_PRIVACY_RESPONSE_INVALID",
  ZAMMAD_PRIVACY_NETWORK: "WORKSPACE_PRIVACY_NETWORK",
  ZAMMAD_PRIVACY_RESPONSE_TOO_LARGE: "WORKSPACE_PRIVACY_RESPONSE_TOO_LARGE",
  ZAMMAD_PRIVACY_OUTCOME_UNKNOWN: "WORKSPACE_PRIVACY_OUTCOME_UNKNOWN",
  ZAMMAD_PRIVACY_TASK_FAILED: "WORKSPACE_PRIVACY_TASK_FAILED",
};

function publicAuditLabel(value: string) {
  return Object.hasOwn(PUBLIC_AUDIT_LABELS, value) ? PUBLIC_AUDIT_LABELS[value]! : value;
}

function publicAuditValue(value: unknown): unknown {
  const redacted = redactAuditValue(value);
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted)) return redacted;
  // Only generated top-level metadata is translated; authored values and correlation IDs stay exact.
  return Object.fromEntries(Object.entries(redacted).map(([key, entry]) => [
    publicAuditLabel(key),
    ["scope_type", "disposition", "code", "error_code"].includes(key) && typeof entry === "string"
      ? publicAuditLabel(entry) : entry,
  ]));
}

function isoTimestamp(value: string, label: string) {
  if (value.length > 40 || hasControlCharacters(value)) {
    throw new BadRequestException(`Audit ${label} timestamp is invalid`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new BadRequestException(`Audit ${label} timestamp is invalid`);
  }
  return timestamp.toISOString();
}

function auditRoutine(value: string | undefined) {
  if (value === undefined) return "include";
  if (value !== "include" && value !== "exclude") {
    throw new BadRequestException("Audit routine filter is invalid");
  }
  return value;
}

function uuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new BadRequestException(`Audit ${label} is invalid`);
  }
  return value.toLowerCase();
}

function safeJson(value: unknown) {
  if (value === undefined || value === null) return "";
  return JSON.stringify(redactAuditValue(value));
}

function redactAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[DEPTH_LIMIT]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => redactAuditValue(entry, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.length > 2_000
      ? `${value.slice(0, 2_000)}…`
      : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 200)
      .map(([key, entry]) => [
        key,
        isSensitiveAuditKey(key) ? "[REDACTED]" : redactAuditValue(entry, depth + 1),
      ]),
  );
}

function isSensitiveAuditKey(key: string) {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
  return [
    "secret",
    "token",
    "password",
    "credential",
    "authorization",
    "apikey",
    "hmackey",
    "routetoken",
    "payload",
    "messagebody",
    "messagetext",
    "rawbody",
    "objectkey",
  ].some((sensitive) => normalized.includes(sensitive));
}

export function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}
