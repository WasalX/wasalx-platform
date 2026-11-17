import { META_ROUTING_ROLES, type MetaRoutingAction, type MetaRoutingRole, type MetaThreadActionDto, type MetaThreadControlCommand, type MetaThreadRoutingDto } from "./meta-routing-contract.ts";

export type MetaThreadIntent = { key: string; body: MetaThreadControlCommand };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** This local recovery record contains no credential or provider recipient. */
export function parseMetaThreadIntent(raw: string): MetaThreadIntent | null {
  if (raw.length > 2048) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).some(key => !["key", "body"].includes(key)) || typeof entry.key !== "string" || !uuid.test(entry.key)
      || !entry.body || typeof entry.body !== "object" || Array.isArray(entry.body)) return null;
    const body = entry.body as Record<string, unknown>;
    if (Object.keys(body).some(key => !["action", "targetRole", "expectedRoutingEpoch", "expectedConfigurationVersion", "expectedReviewVersion"].includes(key))
      || typeof body.action !== "string" || !["take", "pass", "release"].includes(body.action)
      || [body.expectedRoutingEpoch, body.expectedConfigurationVersion, body.expectedReviewVersion].some(value => !Number.isSafeInteger(value) || Number(value) < 0)
      || (Object.hasOwn(body, "targetRole") && (body.action !== "pass" || typeof body.targetRole !== "string" || !META_ROUTING_ROLES.some(role => role === body.targetRole)))) return null;
    return { key: entry.key, body: {
      action: body.action as MetaRoutingAction,
      ...(Object.hasOwn(body, "targetRole") ? { targetRole: body.targetRole as MetaRoutingRole } : {}),
      expectedRoutingEpoch: body.expectedRoutingEpoch as number,
      expectedConfigurationVersion: body.expectedConfigurationVersion as number,
      expectedReviewVersion: body.expectedReviewVersion as number,
    } };
  } catch { return null; }
}

/** Both POST and read recovery require the persisted action's complete public shape and exact command. */
export function metaThreadActionMatches(command: MetaThreadControlCommand, value: unknown): value is MetaThreadActionDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  return typeof action.id === "string" && uuid.test(action.id)
    && typeof action.state === "string" && ["RUNNING", "SUCCEEDED", "FAILED", "OUTCOME_UNKNOWN"].includes(action.state)
    && typeof action.action === "string" && ["take", "pass", "release"].includes(action.action)
    && (action.targetRole === null || (action.action === "pass" && typeof action.targetRole === "string" && META_ROUTING_ROLES.some(role => role === action.targetRole)))
    && (action.requestId === null || (typeof action.requestId === "string" && action.requestId.length > 0 && action.requestId.length <= 512 && !/[\p{Cc}]/u.test(action.requestId)))
    && (action.state !== "SUCCEEDED" || action.requestId !== null)
    && (action.reason === null || (typeof action.reason === "string" && /^[A-Z0-9_]{1,100}$/u.test(action.reason))) && action.retryable === false
    && action.action === command.action && (action.targetRole ?? undefined) === command.targetRole;
}

/** A read settles uncertainty only for this exact original command and terminal action. */
export function metaThreadIntentSettled(intent: MetaThreadIntent, correlation: MetaThreadRoutingDto["correlation"]): boolean {
  if (correlation?.state !== "MATCHED") return false;
  const { command, action } = correlation;
  if (!command || !metaThreadActionMatches(intent.body, action) || !["SUCCEEDED", "FAILED"].includes(action.state)) return false;
  const expected = intent.body;
  return command.action === expected.action && command.targetRole === expected.targetRole
    && command.expectedRoutingEpoch === expected.expectedRoutingEpoch
    && command.expectedConfigurationVersion === expected.expectedConfigurationVersion
    && command.expectedReviewVersion === expected.expectedReviewVersion;
}
