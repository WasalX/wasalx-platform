import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projects = [
  "packages/observability/tsconfig.json",
  "packages/core/tsconfig.package.json",
  "packages/core/tsconfig.domain.json",
  "services/control-api/tsconfig.json",
  "services/connector-worker/tsconfig.json",
  "services/tenant-provisioner/tsconfig.json",
  "services/invitation-mailer/tsconfig.json",
  "services/identity-policy-activator/tsconfig.json",
  "services/workspace-provider/tsconfig.json",
  "services/workspace-configurator/tsconfig.json",
];
const tsc = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));
const run = (...args) => execFileSync(process.execPath, [tsc, ...args], { stdio: "inherit" });

try {
  const mode = process.argv[2] ?? process.env.WASALX_SERVICE_BUILD_MODE;
  if (mode === "--force" || mode === "--build") {
    const flags = mode === "--force" ? ["--force"] : [];
    run("--build", "--incremental", "--stopBuildOnErrors", ...flags, ...projects);
  } else {
    // Project mode rechecks transitive inputs when reusing outputs from a different source tree.
    const flags = mode === "--incremental" ? ["--incremental"] : [];
    for (const project of projects) run("--project", project, ...flags);
  }
} catch (error) {
  if (typeof error.status !== "number") throw error;
  process.exitCode = error.status;
}
