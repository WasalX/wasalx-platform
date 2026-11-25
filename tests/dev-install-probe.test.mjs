import assert from "node:assert/strict";
import test from "node:test";
import { censusFailure, sanitizeProbeError } from "../scripts/dev-install/probe.mjs";
import { devColdResidents, devHeldServices, devPreservedServices } from "../scripts/release/installer-stack.mjs";

test("probe errors keep bounded diagnostics and discard subprocess data", () => {
  const secret = "sample-secret";
  const hash = "ab".repeat(32);
  const error = Object.assign(new Error(`TOKEN=${secret} https://sandbox:${secret}@host.invalid/${hash}`), {
    code: "ETIMEDOUT", stderr: secret,
    stack: `Error: ${secret}\n    at render (/private-dir/scripts/release/installer-artifacts.mjs:177:10)`,
    rollbackFields: ["worker.compose.config-hash", "worker.network_mode", `worker.${secret}`, hash],
  });
  assert.equal(sanitizeProbeError(error, { service: "worker", field: "State.Running" }),
    "probe-scan error=Error message=native read failed (ETIMEDOUT) service=worker field=State.Running fields=compose.config-hash,network_mode at=installer-artifacts.mjs:177");
  assert.equal(sanitizeProbeError(error, { service: hash, field: secret }),
    "probe-scan error=Error message=native read failed (ETIMEDOUT) at=installer-artifacts.mjs:177");
  assert.equal(sanitizeProbeError(new SyntaxError(`Unexpected token '${secret}'`)),
    "probe-scan error=SyntaxError message=invalid native JSON");
});

test("probe census checks DEV holds, running nightly services, one-shots and cold state", () => {
  const names = [...new Set([...devHeldServices, ...devPreservedServices, ...devColdResidents,
    "control-api", "held-init"])];
  const oneShots = devPreservedServices.filter(name => !devHeldServices.includes(name) && name !== "zammad-backup");
  const completed = { condition: "service_completed_successfully" };
  const services = Object.fromEntries(names.map(name => [name, {}]));
  services[devHeldServices[0]].depends_on = { "held-init": completed };
  services["control-api"] = { healthcheck: {}, depends_on: Object.fromEntries(oneShots.map(name => [name, completed])) };
  const model = { services };
  const row = (name, state) => ({ Config: { Labels: { "com.docker.compose.service": name }, Healthcheck: { Test: ["CMD", "true"] } },
    RestartCount: state === "held" ? 1 : 0, State: { Running: state === "resident", Status: state === "resident" ? "running" : state === "held" ? "created" : "exited",
      Pid: state === "resident" ? 10 : 0, ExitCode: 0, Paused: false, Dead: false, Health: { Status: "healthy" } } });
  const rows = names.map(name => row(name, [...devHeldServices, "held-init"].includes(name) ? "held" : oneShots.includes(name) ? "one-shot" : "resident"));
  const census = (entries, held) => censusFailure(model, entries, held);
  assert.equal(census(rows), null);
  const update = (name, change) => rows.map(entry => entry.Config.Labels["com.docker.compose.service"] === name ? change(structuredClone(entry)) : entry);
  const held = devHeldServices[0];
  assert.deepEqual(census(update(held, () => row(held, "resident"))), { service: held, field: "State.Running" });
  const oneShot = oneShots[0];
  assert.deepEqual(census(update(oneShot, entry => { entry.State.ExitCode = 1; return entry; })), { service: oneShot, field: "State.ExitCode" });
  assert.deepEqual(census(update("control-api", entry => { entry.RestartCount = 1; return entry; })), { service: "control-api", field: "RestartCount" });
  assert.deepEqual(census(update("control-api", entry => { delete entry.Config.Healthcheck; return entry; })), { service: "control-api", field: "State.Health.Status" });
  assert.deepEqual(census(update("zammad-backup", () => row("zammad-backup", "held"))), { service: "zammad-backup", field: "cold-mode" });
  assert.deepEqual(census(rows.slice(1)), { field: "inventory" });
  const nightly = names.map(name => row(name, [...oneShots, "held-init"].includes(name) ? "one-shot" : "resident"));
  assert.equal(census(nightly, []), null);
  services["new-worker"] = { profiles: ["full"] };
  services["inactive-worker"] = { profiles: ["other"] };
  assert.deepEqual(census(nightly, []), { field: "inventory" });
  assert.deepEqual(census([...nightly, row("inactive-worker", "resident")], []), { field: "inventory" });
  assert.equal(census([...nightly, row("new-worker", "resident")], []), null);
});
