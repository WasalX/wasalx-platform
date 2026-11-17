import assert from "node:assert/strict";
import test from "node:test";
import { connectionAuthorizationState, connectionDisplayState, connectionInboundIsReady, connectionIsReady, connectionTransportIsReady } from "../lib/connection-readiness.ts";

const heartbeat = "2026-08-31T10:03:39.000Z";

test("Meta authorization reports historical proof and respects later lifecycle failure",()=>{
  const row={provider:"META",state:"WORKING",provider_state:"AVAILABLE",last_heartbeat_at:heartbeat};
  assert.equal(connectionAuthorizationState(row),"LAST_VERIFIED");
  assert.equal(connectionAuthorizationState({...row,state:"PROVISIONING"}),"CONNECTING");
  for(const last_heartbeat_at of [null,"invalid"])
    assert.equal(connectionAuthorizationState({...row,last_heartbeat_at}),"UNKNOWN");
  for(const state of ["ACTION_REQUIRED","FAILED","PAUSED","REVOKED"])
    assert.equal(connectionAuthorizationState({...row,state}),state);
  assert.equal(connectionAuthorizationState({provider:"WAHA",state:"WORKING",provider_state:"WORKING",worker_ready:true}),"WORKING");
});

test("Meta readiness requires current routing setup and a successfully processed current-session message", () => {
  const ready = {
    provider: "META",
    state: "WORKING",
    provider_session_state: "WORKING",
    provider_state: "AVAILABLE",
    webhook_state: "ACTIVE",
    last_heartbeat_at: heartbeat,
    last_provider_event_at: heartbeat,
    last_processed_provider_message_at: heartbeat,
    meta_routing_configuration_ready: true,
    webhook_admission_opened_at: heartbeat,
  };
  assert.equal(connectionTransportIsReady(ready), true);
  assert.equal(connectionInboundIsReady(ready), true);
  assert.equal(connectionIsReady(ready), true);
  assert.equal(connectionDisplayState(ready), "WORKING");
  const stale = { ...ready, last_processed_provider_message_at: "2026-08-31T10:03:38.999Z" };
  assert.equal(connectionTransportIsReady(stale), true);
  assert.equal(connectionInboundIsReady(stale), false);
  assert.equal(connectionDisplayState(stale), "WORKING");
  for (const degraded of [
    { ...ready, provider_session_state: "CONNECTING" },
    { ...ready, provider_state: "UNAVAILABLE" },
    { ...ready, webhook_state: "PAUSED" },
    { ...ready, last_heartbeat_at: null },
    { ...ready, last_processed_provider_message_at: null },
    { ...ready, meta_routing_configuration_ready: false },
    { ...ready, meta_routing_configuration_ready: undefined },
    { ...ready, webhook_admission_opened_at: null },
    { ...ready, webhook_admission_opened_at: "invalid" },
  ]) {
    assert.equal(connectionIsReady(degraded), false);
  }
  assert.equal(connectionDisplayState({ ...ready, provider_session_state: "CONNECTING" }), "CONNECTING");
  assert.equal(connectionDisplayState({ ...ready, last_provider_event_at: null }), "WORKING");
  // A received callback may be held or terminally rejected before any message is processed.
  assert.equal(connectionInboundIsReady({ ...ready, last_processed_provider_message_at: null, meta_routing_configuration_ready: false }), false);
  assert.equal(connectionInboundIsReady({ ...ready, last_processed_provider_message_at: null }), false);
});

test("linked-device readiness accepts restored sessions without a new QR onboarding milestone", () => {
  const ready = {
    provider: "WAHA",
    state: "WORKING",
    provider_session_state: "WORKING",
    provider_state: "WORKING",
    last_heartbeat_at: heartbeat,
    last_provider_event_at: null,
    onboarding_working_at: heartbeat,
    worker_ready: true,
  };
  assert.equal(connectionIsReady(ready), true);
  assert.equal(connectionDisplayState(ready), "WORKING");
  assert.equal(connectionAuthorizationState(ready), "WORKING");
  for (const worker_ready of [false, undefined, null]) {
    assert.equal(connectionIsReady({ ...ready, worker_ready }), false);
    assert.equal(connectionDisplayState({ ...ready, worker_ready }), "CONNECTING");
    assert.equal(connectionAuthorizationState({ ...ready, worker_ready }), "UNKNOWN");
  }
  assert.equal(connectionDisplayState({ ...ready, onboarding_working_at: null }), "WORKING");
  assert.equal(connectionIsReady({ ...ready, onboarding_working_at: null }), true);
  for (const degraded of [
    { ...ready, state: "CONNECTING" },
    { ...ready, provider_session_state: "STOPPED" },
    { ...ready, last_heartbeat_at: null },
    { ...ready, onboarding_working_at: null, worker_ready: false },
  ]) assert.equal(connectionIsReady(degraded), false);
  assert.equal(connectionDisplayState({ ...ready, provider_state: "STARTING" }), "CONNECTING");
  assert.equal(connectionDisplayState({ state: "PAUSED" }), "PAUSED");
  assert.equal(connectionDisplayState({ state: "WORKING" }), "WORKING");
});

test("negative linked-device observations retain their actionable status instead of stale Working", () => {
  for (const [state, provider_state] of [["ACTION_REQUIRED", "STOPPED"], ["DEGRADED", "DISCONNECTED"], ["FAILED", "FAILED"], ["PAUSED", "STOPPED"], ["REVOKED", "DELETED"]]) {
    const row = { provider: "WAHA", state, provider_state, provider_session_state: state, worker_ready: false, last_heartbeat_at: heartbeat };
    assert.equal(connectionIsReady(row), false);
    assert.equal(connectionDisplayState(row), state);
    assert.equal(connectionAuthorizationState(row), state === "DEGRADED" ? provider_state : state);
  }
});
