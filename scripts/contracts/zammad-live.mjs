import assert from "node:assert/strict";
import {
  boundedJsonRequest,
  explicitBoolean,
  isMain,
  liveBaseUrl,
  opaqueDigest,
  required,
  writeEvidence,
} from "./live-common.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SUCCESS_STATES = new Set(["SENT", "DELIVERED", "READ"]);
const FAILURE_STATES = new Set(["FAILED_RETRYABLE", "FAILED_TERMINAL", "OUTCOME_UNKNOWN"]);

export async function runZammadContract({ env = process.env, fetchImpl = fetch } = {}) {
  const baseUrl = liveBaseUrl(
    required(env, "ZAMMAD_BASE_URL"),
    "ZAMMAD_BASE_URL",
    explicitBoolean(env, "ZAMMAD_LIVE_ALLOW_INSECURE"),
  );
  const token = required(env, "ZAMMAD_API_TOKEN");
  assert.ok(token.length >= 16 && token.length <= 4_096, "ZAMMAD_API_TOKEN has an invalid length");
  const request = (path, init = {}) => boundedJsonRequest(fetchImpl, new URL(path, baseUrl), {
    ...init,
    headers: {
      authorization: `Token token=${token}`,
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  }, { label: "Zammad", timeoutMs: 20_000 });

  await request("/api/v1/online-notification-count");

  let fixtureTicketDigest = null;
  if (explicitBoolean(env, "ZAMMAD_CONTRACT_ALLOW_WRITE")) {
    const ticket = record(await request("/api/v1/tickets", {
      method: "POST",
      body: JSON.stringify(providerFixture(env)),
    }));
    const ticketId = positiveIdentifier(ticket.id, "Zammad fixture ticket ID");
    await request("/api/v1/ticket_articles", {
      method: "POST",
      body: JSON.stringify({
        ticket_id: ticketId,
        subject: "WasalX contract internal note",
        body: "This contract note must remain internal.",
        type: "note",
        internal: true,
        sender: "Agent",
        content_type: "text/plain",
      }),
    });
    fixtureTicketDigest = opaqueDigest(String(ticketId));
  }

  let outboundTicketDigest = null;
  let outboundRoundtrip = "not-requested";
  if (explicitBoolean(env, "ZAMMAD_CONTRACT_ALLOW_OUTBOUND")) {
    const ticket = record(await request("/api/v1/tickets", {
      method: "POST",
      body: JSON.stringify(outboundFixture(env)),
    }));
    const ticketId = positiveIdentifier(ticket.id, "Zammad outbound ticket ID");
    const terminalState = await waitForDelivery(request, ticketId, timeoutSeconds(env));
    assert.ok(SUCCESS_STATES.has(terminalState), "Zammad package delivery did not reach a successful provider state");
    outboundRoundtrip = "passed";
    outboundTicketDigest = opaqueDigest(String(ticketId));
  }

  return {
    provider: "ZAMMAD",
    health: "passed",
    provider_origin_fixture: fixtureTicketDigest ? "passed" : "not-requested",
    fixture_ticket_sha256: fixtureTicketDigest,
    outbound_roundtrip: outboundRoundtrip,
    outbound_ticket_sha256: outboundTicketDigest,
    observed_at: new Date().toISOString(),
  };
}

function providerFixture(env) {
  const reference = `CONTRACT${Date.now()}`;
  return {
    title: `WasalX inbound contract ${reference}`,
    group: required(env, "ZAMMAD_CONTRACT_GROUP"),
    customer: required(env, "ZAMMAD_CONTRACT_CUSTOMER"),
    article: {
      subject: `WasalX inbound contract ${reference}`,
      body: "Inbound provider-origin contract fixture",
      type: "wasalx group message",
      internal: false,
      sender: "Customer",
      preferences: {
        wasalx_origin: "provider",
        wasalx_external_message_id: `contract:${reference}`,
      },
    },
    wasalx_reference: reference,
    wasalx_provider: "WAHA",
    wasalx_correlation_status: "OPEN",
  };
}

function outboundFixture(env) {
  const connectionId = required(env, "ZAMMAD_CONTRACT_CONNECTION_ID");
  assert.match(connectionId, UUID, "ZAMMAD_CONTRACT_CONNECTION_ID must be a UUID");
  const providerGroupId = required(env, "ZAMMAD_CONTRACT_PROVIDER_GROUP_ID");
  assert.ok(providerGroupId.length <= 255 && !hasControlCharacters(providerGroupId), "ZAMMAD_CONTRACT_PROVIDER_GROUP_ID is invalid");
  const reference = `CONTRACT${Date.now()}`;
  return {
    title: `WasalX outbound contract ${reference}`,
    group: required(env, "ZAMMAD_CONTRACT_GROUP"),
    customer: required(env, "ZAMMAD_CONTRACT_CUSTOMER"),
    article: {
      subject: `WasalX outbound contract ${reference}`,
      body: `WasalX approved outbound contract ${reference}`,
      type: "wasalx group message",
      internal: false,
      sender: "Agent",
      content_type: "text/plain",
    },
    wasalx_reference: reference,
    wasalx_provider: "WAHA",
    wasalx_connection_id: connectionId,
    wasalx_group_id: providerGroupId,
    wasalx_correlation_status: "OPEN",
  };
}

async function waitForDelivery(request, ticketId, timeout) {
  const deadline = Date.now() + timeout * 1_000;
  while (Date.now() < deadline) {
    const ticket = record(await request(`/api/v1/tickets/${encodeURIComponent(ticketId)}`));
    const state = typeof ticket.wasalx_delivery_status === "string"
      ? ticket.wasalx_delivery_status.toUpperCase()
      : "";
    if (SUCCESS_STATES.has(state)) return state;
    if (FAILURE_STATES.has(state)) {
      throw new Error(`Zammad package delivery reached ${state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Zammad package delivery did not reach a terminal state within ${timeout} seconds`);
}

function timeoutSeconds(env) {
  const value = env.ZAMMAD_CONTRACT_TIMEOUT_SECONDS ?? "180";
  if (!/^\d{2,3}$/u.test(value)) throw new Error("ZAMMAD_CONTRACT_TIMEOUT_SECONDS must be an integer from 30 to 600");
  const parsed = Number(value);
  if (parsed < 30 || parsed > 600) throw new Error("ZAMMAD_CONTRACT_TIMEOUT_SECONDS must be an integer from 30 to 600");
  return parsed;
}

function positiveIdentifier(value, label) {
  const text = String(value ?? "");
  assert.match(text, /^[1-9]\d{0,18}$/u, `${label} is invalid`);
  return text;
}

function hasControlCharacters(value) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

if (isMain(import.meta.url)) {
  writeEvidence(await runZammadContract());
}
