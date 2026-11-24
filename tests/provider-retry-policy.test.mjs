import assert from "node:assert/strict";
import test from "node:test";
import { DeliveryProcessor, retryPolicyFromEnvironment } from "../services/connector-worker/dist/services/connector-worker/src/processor.js";

import { SecretResolutionError } from "../services/connector-worker/dist/services/connector-worker/src/secrets.js";

test("delivery retry ceilings are independently configurable", () => {
  assert.deepEqual(retryPolicyFromEnvironment({}), {
    waha: 8,
    meta: 8,
    zammadStatus: 8,
    botAction: 8,
    botHandoff: 8,
  });
  assert.deepEqual(
    retryPolicyFromEnvironment({
      WAHA_DELIVERY_MAX_ATTEMPTS: "6",
      META_DELIVERY_MAX_ATTEMPTS: "4",
      ZAMMAD_STATUS_MAX_ATTEMPTS: "12",
      BOT_ACTION_MAX_ATTEMPTS: "25",
      BOT_HANDOFF_MAX_ATTEMPTS: "3",
    }),
    { waha: 6, meta: 4, zammadStatus: 12, botAction: 25, botHandoff: 3 },
  );
});

test("invalid retry ceilings fail connector startup instead of silently falling back", () => {
  for (const [name, value] of [
    ["WAHA_DELIVERY_MAX_ATTEMPTS", "0"],
    ["META_DELIVERY_MAX_ATTEMPTS", "26"],
    ["ZAMMAD_STATUS_MAX_ATTEMPTS", "8.5"],
    ["BOT_ACTION_MAX_ATTEMPTS", "26"],
    ["BOT_ACTION_MAX_ATTEMPTS", ""],
    ["BOT_HANDOFF_MAX_ATTEMPTS", "9"],
    ["BOT_HANDOFF_MAX_ATTEMPTS", "no limit"],
  ]) {
    assert.throws(() => retryPolicyFromEnvironment({ [name]: value }), new RegExp(name, "u"));
  }
});

test("bot action and handoff failures stop scheduling retries at their configured ceilings", async () => {
  const calls = [];
  const action = { origin: "QUALIFICATION", tenantId: "t1", attempts: 2, actionKey: "test.action", authScheme: "BEARER", secretReference: "secret://action" };
  const handoff = { tenantId: "t1", attempts: 2, zammadSecretReference: "secret://zammad" };
  const repository = {
    claimBotActions: async () => [action],
    claimDeliveries: async () => [],
    claimBotHandoffs: async () => [handoff],
    claimStatuses: async () => [],
    retryBotAction: async () => calls.push("retry action"),
    recordBotActionResult: async (_job, _lease, state) => assert.equal(state, "FAILED_TERMINAL"),
    completeBotActionQualification: async (_job, _lease, state) => calls.push(state),
    retryBotHandoff: async () => calls.push("retry handoff"),
    failBotHandoff: async () => calls.push("fail handoff"),
  };
  const secrets = { resolve: async () => { throw new SecretResolutionError("Temporarily unavailable", true); } };
  for (const [env, expected] of [
    [{}, ["retry action", "retry handoff"]],
    [{ BOT_ACTION_MAX_ATTEMPTS: "2", BOT_HANDOFF_MAX_ATTEMPTS: "3" }, ["FAILED_TERMINAL", "retry handoff"]],
    [{ BOT_ACTION_MAX_ATTEMPTS: "3", BOT_HANDOFF_MAX_ATTEMPTS: "2" }, ["retry action", "fail handoff"]],
  ]) {
    calls.length = 0;
    const processor = new DeliveryProcessor(repository, secrets, { metaGraphVersion: "v24.0" }, retryPolicyFromEnvironment(env));
    await processor.drainTenant("t1");
    assert.deepEqual(calls, expected);
  }
});
