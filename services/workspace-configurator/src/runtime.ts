import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConfiguratorConfig } from "./config.js";
import { createVerifiedBackup } from "./backup-runtime.js";
import { assertSecretFree } from "./safe-output.js";
import { ZammadAdminClient } from "./zammad-client.js";

export async function runConfigurator(config: ConfiguratorConfig, request: typeof fetch = fetch) {
  let result: Record<string, unknown>;
  if (config.action === "backup" || config.action === "control-backup") {
    result = await createVerifiedBackup(config);
  } else {
    const client = new ZammadAdminClient(config.zammadBaseUrl, config.zammadToken, config.requestTimeoutMs, request);
    if (config.action === "package") result = await client.configurePackage(config);
    else if (config.action === "oidc") result = await client.configureOidc(config);
    else result = await client.configureDefaults(config);
  }
  assertSecretFree(result);
  if (config.action !== "backup" && config.action !== "control-backup") {
    await writeConfigurationReceipt(config.outputDirectory, config.action, result);
  }
  return result;
}

async function writeConfigurationReceipt(outputDirectory: string, action: string, result: Record<string, unknown>) {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const destination = path.join(outputDirectory, `${action}.receipt.json`);
  const temporary = `${destination}.${process.pid}.partial`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
}
