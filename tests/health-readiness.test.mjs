import assert from "node:assert/strict";
import test from "node:test";
import { ServiceUnavailableException } from "../services/control-api/node_modules/@nestjs/common/index.js";
import { HealthController } from "../services/control-api/dist/health.controller.js";

test("control API readiness covers PostgreSQL, Redis, and the secret manager", async () => {
  const controller = new HealthController(
    { ready: async () => true },
    { ready: async () => true },
    { ready: async () => true },
  );
  const result = await controller.ready();
  assert.deepEqual(result.checks, { database: true, redis: true, secret_manager: true });
  assert.equal(result.status, "ok");
});

test("control API readiness fails closed and identifies every degraded dependency", async () => {
  const controller = new HealthController(
    { ready: async () => true },
    { ready: async () => false },
    { ready: async () => false },
  );
  await assert.rejects(
    () => controller.ready(),
    (error) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.deepEqual(error.getResponse().checks, {
        database: true,
        redis: false,
        secret_manager: false,
      });
      return true;
    },
  );
});
