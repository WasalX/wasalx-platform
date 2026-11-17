import assert from "node:assert/strict";
import test from "node:test";
import { retryPolicyFromEnvironment } from "../services/connector-worker/dist/services/connector-worker/src/processor.js";

test("delivery retry ceilings are independently configurable by provider and Zammad status", () => {
  assert.deepEqual(retryPolicyFromEnvironment({}), {
    waha: 8,
    meta: 8,
    zammadStatus: 8,
  });
  assert.deepEqual(
    retryPolicyFromEnvironment({
      WAHA_DELIVERY_MAX_ATTEMPTS: "6",
      META_DELIVERY_MAX_ATTEMPTS: "4",
      ZAMMAD_STATUS_MAX_ATTEMPTS: "12",
    }),
    { waha: 6, meta: 4, zammadStatus: 12 },
  );
});

test("invalid retry ceilings fail connector startup instead of silently falling back", () => {
  for (const [name, value] of [
    ["WAHA_DELIVERY_MAX_ATTEMPTS", "0"],
    ["META_DELIVERY_MAX_ATTEMPTS", "26"],
    ["ZAMMAD_STATUS_MAX_ATTEMPTS", "8.5"],
  ]) {
    assert.throws(() => retryPolicyFromEnvironment({ [name]: value }), /must be between 1 and 25/u);
  }
});
