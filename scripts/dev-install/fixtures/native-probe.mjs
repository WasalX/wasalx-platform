import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { enterComposeStageLock } from "../../release/compose-stage-lock.mjs";
import { assertInstallHostname, devReviewAuthConfiguration } from "../../release/installer-stack.mjs";

const argv = process.argv.slice(2);
const [fixture] = argv;
const option = flag => argv[argv.indexOf(flag) + 1];

devReviewAuthConfiguration({
  portalOrigin: option("--dev-review-origin"),
  identityOrigin: option("--dev-review-identity-origin"),
});
assertInstallHostname();

if (existsSync(join(fixture, "hang"))) {
  // Keep both processes alive through TERM so the fixture exercises the kill grace.
  process.on("SIGTERM", () => {});
  const status = enterComposeStageLock(argv, process.env, (command, args, env) =>
    spawnSync(command, args, { env, stdio: "ignore" }).status ?? 1, fileURLToPath(import.meta.url));
  if (status === null) {
    appendFileSync(join(fixture, "calls.jsonl"), JSON.stringify(["lock-owner", process.pid]) + "\n");
    setInterval(() => {}, 60_000);
  } else {
    process.exitCode = status;
  }
} else {
  execFileSync("docker", ["compose", "--env-file", option("--env-file"), "config", "--format", "json"], { stdio: "ignore" });
  writeFileSync(option("--capture-dev-preimages"), '{"captured": true}\n', { flag: "wx", mode: 0o600 });
}
