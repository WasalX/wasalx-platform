import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ciExecutionContext, cloudSelector } from "./ci-execution-context.mjs";
import { rootlessDataRoot } from "./ci-browser-runtime.mjs";

export function admitCloudPostgres(environment, info) {
  const context = ciExecutionContext(environment);
  assert.equal(context.job, "postgres", "Cloud PostgreSQL probe belongs to another job");
  assert.equal(context.WASALX_CI_RUNTIME, "native", "Cloud PostgreSQL requires the native runtime");
  assert.equal(context.route, "cloud", "Cloud PostgreSQL requires the cloud route");
  assert.deepEqual(context.selector, cloudSelector, "Cloud PostgreSQL requires the one-job-per-VM unit class");
  assert.equal(environment.GITHUB_ACTIONS, "true", "Cloud PostgreSQL admission is CI-only");
  assert.equal(environment.RUNNER_OS, "Linux", "Cloud PostgreSQL requires a Linux VM");
  assert.equal(environment.RUNNER_ENVIRONMENT, "self-hosted", "Cloud PostgreSQL requires the owned VM pool");
  rootlessDataRoot(info);
  // shortcut: reuse browser VM sizing provisionally; replace after measured PostgreSQL cloud qualification.
  assert(Number.isSafeInteger(info.NCPU) && info.NCPU >= 6 && Number.isSafeInteger(info.MemTotal)
    && info.MemTotal >= 15 * 1024 ** 3, "Cloud PostgreSQL requires a provisional 6 CPU / 16 GiB VM");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.platform, "linux", "Cloud PostgreSQL admission runs only on Linux");
  const probe = spawnSync("docker", ["info", "--format", "{{json .}}"], { encoding: "utf8" });
  if (probe.error) throw probe.error;
  assert.equal(probe.status, 0, "Cloud PostgreSQL Docker daemon probe failed");
  admitCloudPostgres(process.env, JSON.parse(probe.stdout));
}
