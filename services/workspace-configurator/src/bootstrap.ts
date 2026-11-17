import { loadConfiguratorConfig } from "./config.js";
import { runConfigurator } from "./runtime.js";
import { safeError } from "./safe-output.js";

try {
  const result = await runConfigurator(loadConfiguratorConfig());
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
  process.exitCode = 1;
}
