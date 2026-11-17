import { createServer } from "node:http";
import {
  recordMetric,
  recordStructuredLog,
  safeErrorCode,
} from "@wasalx/observability";
import { loadInvitationMailerConfig } from "./config.js";
import {
  HttpsTransactionalEmailProvider,
  SmtpTransactionalEmailProvider,
  invitationDeliverySecretsReady,
} from "./provider.js";
import { InvitationMailerProcessor } from "./processor.js";
import { PostgresInvitationMailerStore } from "./repository.js";
import { SidecarMailerSecretResolver } from "./secrets.js";

const config = loadInvitationMailerConfig();
const store = new PostgresInvitationMailerStore(config.databaseUrl, config.tenantId);
const secrets = new SidecarMailerSecretResolver(config.secretSidecarUrl, config.secretSidecarToken);
const provider = ["smtp:", "smtps:"].includes(config.providerUrl.protocol)
  ? new SmtpTransactionalEmailProvider(config.providerUrl, config.providerSecretReference, secrets, config.sender)
  : new HttpsTransactionalEmailProvider(config.providerUrl, config.providerSecretReference, secrets);
const processor = new InvitationMailerProcessor(config, store, secrets, provider);

let stopping = false;
let pollInFlight = false;
let lastSuccessfulPollAt = 0;
let timer: NodeJS.Timeout | undefined;

const server = createServer(async (request, response) => {
  setHeaders(response);
  if (request.method === "GET" && request.url === "/livez") {
    response.writeHead(stopping ? 503 : 200).end(stopping ? "stopping" : "ok");
    return;
  }
  if (request.method === "GET" && request.url === "/readyz") {
    const [database, secretSidecar, deliverySecrets, providerConnection] = await Promise.all([
      store.ready(),
      secrets.ready(),
      invitationDeliverySecretsReady({
        providerSecretReference: config.providerSecretReference,
        privateKeyReferences: config.privateKeyReferences,
        secrets,
      }),
      provider.ready(),
    ]);
    const pollHealthy = lastSuccessfulPollAt > 0 &&
      Date.now() - lastSuccessfulPollAt <= Math.max(30_000, config.pollIntervalMs * 5);
    const ready = !stopping && database && secretSidecar && deliverySecrets && providerConnection && pollHealthy;
    recordMetric("wasalx_dependency_ready", database ? 1 : 0, {
      component: "invitation_mailer", dependency: "postgresql",
    });
    recordMetric("wasalx_dependency_ready", secretSidecar ? 1 : 0, {
      component: "invitation_mailer", dependency: "secret_sidecar",
    });
    recordMetric("wasalx_dependency_ready", deliverySecrets ? 1 : 0, {
      component: "invitation_mailer", dependency: "delivery_secrets",
    });
    recordMetric("wasalx_worker_heartbeat", ready ? 1 : 0, { component: "invitation_mailer" });
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({
      status: ready ? "ready" : "not_ready",
      database,
      secretSidecar,
      deliverySecrets,
      providerConnection,
      polling: pollHealthy,
    }));
    return;
  }
  response.writeHead(404).end("not found");
});

server.listen(config.port, "0.0.0.0", () => {
  recordStructuredLog("info", "invitation_mailer.listening", { port: config.port });
});
schedule(0);

function schedule(delay: number) {
  if (stopping) return;
  timer = setTimeout(async () => {
    if (pollInFlight) return schedule(config.pollIntervalMs);
    pollInFlight = true;
    try {
      const result = await processor.drainOnce();
      lastSuccessfulPollAt = Date.now();
      recordMetric("wasalx_worker_heartbeat", 1, { component: "invitation_mailer" });
      if (result.claimed > 0) {
        recordStructuredLog("info", "invitation_mailer.batch_finished", result);
      }
    } catch (error) {
      recordMetric("wasalx_worker_heartbeat", 0, { component: "invitation_mailer" });
      recordStructuredLog("error", "invitation_mailer.poll_failed", {
        error_code: safeErrorCode(error),
      });
    } finally {
      pollInFlight = false;
      schedule(config.pollIntervalMs);
    }
  }, delay);
  timer.unref();
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  recordStructuredLog("info", "invitation_mailer.stopping", { signal });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  while (pollInFlight) await new Promise((resolve) => setTimeout(resolve, 25));
  await store.close();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

function setHeaders(response: import("node:http").ServerResponse) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
}
