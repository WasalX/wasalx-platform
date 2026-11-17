import { createServer } from "node:http";
import { recordStructuredLog } from "@wasalx/observability";
import { loadConfig } from "./config.js";
import { KubernetesWorkspaceClient } from "./kubernetes.js";
import { createProvisionerHandler } from "./server.js";

const config = loadConfig();
const client = new KubernetesWorkspaceClient(config);
const server = createServer(createProvisionerHandler(config, client));

server.listen(config.port, "0.0.0.0", () => {
  recordStructuredLog("info", "tenant_provisioner.listening", {
    port: config.port,
    workspace_namespace: config.workspaceNamespace,
  });
});

function shutdown() {
  server.close((error) => {
    if (error) {
      recordStructuredLog("error", "tenant_provisioner.shutdown_failed");
      process.exitCode = 1;
    }
  });
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
