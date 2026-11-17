import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { FileBearerAuthenticator } from "./auth.js";
import { loadWorkspaceProviderConfig } from "./config.js";
import { KubernetesProviderGateway } from "./kubernetes.js";
import { PostgresProviderStore } from "./repository.js";
import { createWorkspaceProviderHandler } from "./server.js";
import { WorkspaceProviderService } from "./service.js";

const config = loadWorkspaceProviderConfig();
const store = new PostgresProviderStore(config.databaseUrl);
const gateway = new KubernetesProviderGateway(config);
const service = new WorkspaceProviderService(store, gateway);
const [cert, key] = await Promise.all([readFile(config.tlsCertFile), readFile(config.tlsKeyFile)]);
const server = createServer({ cert, key, minVersion: "TLSv1.2" }, createWorkspaceProviderHandler(service, new FileBearerAuthenticator(config.tokenFile)));
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.listen(config.port, "0.0.0.0");

async function shutdown() {
  server.close();
  await store.close();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
