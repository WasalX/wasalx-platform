import { createServer } from "node:http";
import { recordStructuredLog } from "@wasalx/observability";
import { IdentityPolicyAttestationVerifier } from "./attestation.js";
import { loadIdentityPolicyActivatorConfig } from "./config.js";
import { PostgresIdentityPolicyStore } from "./repository.js";
import { createIdentityPolicyHandler } from "./server.js";

const config = loadIdentityPolicyActivatorConfig();
const store = new PostgresIdentityPolicyStore(config.databaseUrl);
const verifier = new IdentityPolicyAttestationVerifier(
  config.issuer,
  config.audience,
  config.jwksUri,
);
const server = createServer(createIdentityPolicyHandler(store, verifier));

server.listen(config.port, "0.0.0.0", () => {
  recordStructuredLog("info", "identity_policy_activator.listening", { port: config.port });
});

async function shutdown(signal: string) {
  recordStructuredLog("info", "identity_policy_activator.stopping", { signal });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await store.close();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
