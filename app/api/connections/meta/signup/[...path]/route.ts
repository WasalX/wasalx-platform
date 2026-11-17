import { isControlPlaneBackend } from "../../../../../../lib/backend";
import { metaSignupPortalRequest } from "../../../../../../lib/control-plane-data";
import { authenticatePortalRequest } from "../../../../../../lib/request-auth";
import { readBoundedJson } from "../../../../../../lib/bounded-json";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
type Context = { params: Promise<{ path: string[] }> };

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store, private, max-age=0", Pragma: "no-cache" } });
}

async function route(request: Request, context: Context) {
  try {
    await authenticatePortalRequest(request, "connection:write");
    if (!isControlPlaneBackend()) return response({ code: "META_SIGNUP_NOT_CONFIGURED" }, 503);
    const { path } = await context.params;
    const method = request.method as "GET" | "POST";
    const isAttempt = path[0] === "attempts" && uuid.test(path[1] ?? "");
    const valid = method === "GET"
      ? (path.length === 1 && ["capabilities", "attempts"].includes(path[0])) || (path.length === 2 && isAttempt)
      : (path.length === 1 && path[0] === "attempts") || (path.length === 3 && isAttempt && ["exchange", "discover", "select", "cancel", "session-log"].includes(path[2]));
    if (!valid) return response({ code: "NOT_FOUND" }, 404);
    const query = new URL(request.url).searchParams;
    const targetConnectionId = query.get("targetConnectionId");
    const purpose = query.get("purpose");
    const targetTransitionId = query.get("targetTransitionId");
    const targetLegacyMigrationId = query.get("targetLegacyMigrationId");
    if ([...query.keys()].some(key => !["targetConnectionId", "targetTransitionId", "targetLegacyMigrationId", "purpose"].includes(key)) || query.getAll("targetConnectionId").length > 1 || query.getAll("purpose").length > 1 || query.getAll("targetTransitionId").length > 1 || query.getAll("targetLegacyMigrationId").length > 1
      || (targetConnectionId !== null && purpose !== null)
      || (targetLegacyMigrationId !== null && (targetTransitionId !== null || targetConnectionId === null || !uuid.test(targetLegacyMigrationId)))
      || (targetTransitionId !== null && (targetConnectionId === null || !uuid.test(targetTransitionId)))
      || (query.size > 0 && (method !== "GET" || path.length !== 1 || path[0] !== "attempts"))
      || (targetConnectionId !== null && !uuid.test(targetConnectionId))
      || (purpose !== null && !["NEW_NUMBER", "ADD_ACCESS"].includes(purpose))) {
      return response({ code: "VALIDATION_ERROR" }, 400);
    }
    let body: Record<string, unknown> | undefined;
    if (method === "POST") {
      let value: unknown;
      try { value = await readBoundedJson(new Response(request.body, { headers: request.headers }), 8192); }
      catch { return response({ code: "VALIDATION_ERROR" }, 400); }
      if (!value || typeof value !== "object" || Array.isArray(value)) return response({ code: "VALIDATION_ERROR" }, 400);
      const input = value as Record<string, unknown>;
      if (path.length === 1) {
        if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 100 || /\p{Cc}/u.test(input.name) || input.payerMode !== "CUSTOMER"
          || typeof input.idempotencyKey !== "string" || !uuid.test(input.idempotencyKey)) return response({ code: "VALIDATION_ERROR" }, 400);
        if (input.targetConnectionId !== undefined && (typeof input.targetConnectionId !== "string" || !uuid.test(input.targetConnectionId))) {
          return response({ code: "VALIDATION_ERROR" }, 400);
        }
        if (input.targetTransitionId !== undefined && (typeof input.targetTransitionId !== "string" || !uuid.test(input.targetTransitionId)
          || input.targetConnectionId === undefined)) return response({ code: "VALIDATION_ERROR" }, 400);
        if (input.targetLegacyMigrationId !== undefined && (typeof input.targetLegacyMigrationId !== "string" || !uuid.test(input.targetLegacyMigrationId)
          || input.targetConnectionId === undefined || input.targetTransitionId !== undefined)) return response({ code: "VALIDATION_ERROR" }, 400);
        if (input.purpose !== undefined && (typeof input.purpose !== "string" || !["NEW_NUMBER", "ADD_ACCESS"].includes(input.purpose)
          || input.targetConnectionId !== undefined)) return response({ code: "VALIDATION_ERROR" }, 400);
        if (input.variant !== undefined && (typeof input.variant !== "string" || !["STANDARD", "BUSINESS_APP"].includes(input.variant))) return response({ code: "VALIDATION_ERROR" }, 400);
        if (input.variant === "BUSINESS_APP") {
          const consent = input.coexistenceConsent;
          if (input.targetConnectionId !== undefined || (input.purpose ?? "NEW_NUMBER") !== "NEW_NUMBER" || !consent || typeof consent !== "object" || Array.isArray(consent)) return response({ code: "VALIDATION_ERROR" }, 400);
          const flags = consent as Record<string, unknown>;
          if (Object.keys(flags).some(key => !["version", "history", "contacts", "echoes"].includes(key)) || flags.version !== "2026-10-07"
            || typeof flags.history !== "boolean" || typeof flags.contacts !== "boolean" || flags.echoes !== true) return response({ code: "VALIDATION_ERROR" }, 400);
        } else if (input.coexistenceConsent !== undefined) return response({ code: "VALIDATION_ERROR" }, 400);
        body = { name: input.name.trim(), payerMode: "CUSTOMER", idempotencyKey: input.idempotencyKey,
          ...(input.targetConnectionId === undefined ? {} : { targetConnectionId: input.targetConnectionId }),
          ...(input.targetTransitionId === undefined ? {} : { targetTransitionId: input.targetTransitionId }),
          ...(input.targetLegacyMigrationId === undefined ? {} : { targetLegacyMigrationId: input.targetLegacyMigrationId }),
          ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
          ...(input.variant === undefined ? {} : { variant: input.variant }),
          ...(input.variant === "BUSINESS_APP" ? { coexistenceConsent: input.coexistenceConsent } : {}) };
      } else if (path[2] === "session-log") {
        if (typeof input.challenge !== "string" || input.challenge.length < 16 || input.challenge.length > 100
          || typeof input.event !== "string" || !["FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", "CANCEL", "ERROR"].includes(input.event) || input.sessionInfoVersion !== "3"
          || typeof input.sourceOrigin !== "string" || !["https://www.facebook.com", "https://web.facebook.com"].includes(input.sourceOrigin)
          || typeof input.traceSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(input.traceSha256)) return response({ code: "VALIDATION_ERROR" }, 400);
        body = { challenge: input.challenge, event: input.event, sessionInfoVersion: "3", sourceOrigin: input.sourceOrigin, traceSha256: input.traceSha256 };
      } else {
        if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) return response({ code: "VALIDATION_ERROR" }, 400);
        body = { expectedRevision: input.expectedRevision };
        if (path[2] === "exchange") {
          if (typeof input.challenge !== "string" || input.challenge.length < 16 || input.challenge.length > 256
            || typeof input.code !== "string" || !input.code || input.code.length > 4096) return response({ code: "VALIDATION_ERROR" }, 400);
          body.challenge = input.challenge; body.code = input.code;
        } else if (path[2] === "select") {
          if (!Number.isSafeInteger(input.selectionRevision) || Number(input.selectionRevision) < 0
            || typeof input.choiceId !== "string" || !input.choiceId || input.choiceId.length > 200
            || (input.registrationPin !== undefined && (typeof input.registrationPin !== "string" || !/^\d{6}$/u.test(input.registrationPin)))) return response({ code: "VALIDATION_ERROR" }, 400);
          body.selectionRevision = input.selectionRevision; body.choiceId = input.choiceId;
          if (input.registrationPin !== undefined) body.registrationPin = input.registrationPin;
        }
      }
    }
    // authenticatePortalRequest already enforces the exact portal origin and CSRF.
    return response(await metaSignupPortalRequest(path.join("/") + (targetConnectionId ? `?targetConnectionId=${encodeURIComponent(targetConnectionId)}${targetTransitionId ? `&targetTransitionId=${encodeURIComponent(targetTransitionId)}` : targetLegacyMigrationId ? `&targetLegacyMigrationId=${encodeURIComponent(targetLegacyMigrationId)}` : ""}` : purpose ? `?purpose=${encodeURIComponent(purpose)}` : ""), method, body, method === "POST" ? request.headers.get("origin") ?? undefined : undefined));
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 503;
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z_]{1,80}$/u.test(error.code) ? error.code : "SERVICE_UNAVAILABLE";
    // Never serialize provider errors: exchange and registration carry secrets.
    return response({ code }, status >= 400 && status <= 599 ? status : 503);
  }
}

export const GET = route;
export const POST = route;
