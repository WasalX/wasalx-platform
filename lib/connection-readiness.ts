type ConnectionReadinessProjection = Record<string, unknown>;

export function connectionAuthorizationState(row: ConnectionReadinessProjection) {
  const state=normalized(row.state);
  if (state==="PROVISIONING") return "CONNECTING";
  if (["ACTION_REQUIRED","FAILED","PAUSED","REVOKED","CONNECTING","PROVISIONING"].includes(state)) return state;
  if (normalized(row.provider)==="META") {
    return normalized(row.provider_state)==="AVAILABLE" && timestamp(row.last_heartbeat_at)!==null
      ? "LAST_VERIFIED" : "UNKNOWN";
  }
  if (normalized(row.provider_state)==="WORKING" && row.worker_ready!==true) return "UNKNOWN";
  return normalized(row.provider_state,"UNKNOWN");
}

export function connectionDisplayState(row: ConnectionReadinessProjection) {
  const state = normalized(row.state, "PROVISIONING");
  if (state !== "WORKING" || !hasReadinessProjection(row)) return state;
  return connectionTransportIsReady(row) ? state : "CONNECTING";
}

export function connectionTransportIsReady(row: ConnectionReadinessProjection) {
  if (normalized(row.state) !== "WORKING" || !row.last_heartbeat_at) return false;
  const sessionState = normalized(row.provider_session_state);
  if (sessionState !== "WORKING") return false;
  if (normalized(row.provider) === "META") {
    return normalized(row.provider_state) === "AVAILABLE"
      && normalized(row.webhook_state) === "ACTIVE";
  }
  return normalized(row.provider_state) === "WORKING" && row.worker_ready === true;
}

export function connectionInboundIsReady(row: ConnectionReadinessProjection) {
  if (!connectionTransportIsReady(row)) return false;
  if (normalized(row.provider) !== "META") return true;
  if (row.meta_routing_configuration_ready !== true) return false;
  const eventAt = timestamp(row.last_processed_provider_message_at);
  const fenceAt = timestamp(row.webhook_admission_opened_at);
  return eventAt !== null && fenceAt !== null && eventAt >= fenceAt;
}

export function connectionIsReady(row: ConnectionReadinessProjection) {
  return connectionInboundIsReady(row);
}

function hasReadinessProjection(row: ConnectionReadinessProjection) {
  return ["provider_state", "provider_session_state", "webhook_state", "onboarding_working_at", "last_provider_event_at"]
    .some((key) => key in row);
}

function normalized(value: unknown, fallback = "") {
  return String(value ?? fallback).toUpperCase();
}

function timestamp(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
