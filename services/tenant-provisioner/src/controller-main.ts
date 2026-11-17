import { createServer } from "node:http";
import {
  observeDuration,
  recordMetric,
  recordStructuredLog,
  safeErrorCode,
  withSpan,
} from "@wasalx/observability";
import { loadControllerConfig } from "./controller/config.js";
import { KubernetesControllerClient } from "./controller/kubernetes.js";
import { LeaseLeaderElector } from "./controller/leader.js";
import { HttpWorkspaceProvider } from "./controller/provider.js";
import { WorkspaceControllerReconciler } from "./controller/reconciler.js";

const config = loadControllerConfig();
const kubernetes = new KubernetesControllerClient(config);
const provider = new HttpWorkspaceProvider(config);
const leader = new LeaseLeaderElector(config, kubernetes);
const reconciler = new WorkspaceControllerReconciler(config, kubernetes, provider, () => leader.isLeader());

let stopped = false;
let lastCompletedPoll = 0;
let lastSuccessfulDependencyCheck = 0;
let polling = false;

const server = createServer(async (request, response) => {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  if (request.method !== "GET") {
    response.statusCode = 405;
    response.end(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }));
    return;
  }
  if (request.url === "/livez") {
    response.statusCode = stopped ? 503 : 200;
    response.end(JSON.stringify({ status: stopped ? "stopping" : "live" }));
    return;
  }
  if (request.url === "/readyz") {
    const now = Date.now();
    const recentPoll = lastCompletedPoll > 0 && now - lastCompletedPoll < Math.max(60_000, config.pollIntervalMs * 5);
    const recentDependencies = lastSuccessfulDependencyCheck > 0 && now - lastSuccessfulDependencyCheck < 60_000;
    const ready = !stopped && recentPoll && recentDependencies;
    response.statusCode = ready ? 200 : 503;
    response.end(JSON.stringify({ status: ready ? "ready" : "not_ready", leader: leader.isLeader() }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "NOT_FOUND" }));
});

server.listen(config.port, "0.0.0.0", () => {
  recordStructuredLog("info", "tenant_workspace_controller.listening", { port: config.port });
});

async function poll() {
  if (stopped || polling) return;
  polling = true;
  const pollStartedAt = Date.now();
  try {
    const dependenciesReady = await Promise.all([kubernetes.ready(), provider.ready()]);
    recordMetric("wasalx_dependency_ready", dependenciesReady[0] ? 1 : 0, {
      component: "tenant_workspace_controller",
      dependency: "kubernetes_api",
    });
    recordMetric("wasalx_dependency_ready", dependenciesReady[1] ? 1 : 0, {
      component: "tenant_workspace_controller",
      dependency: "workspace_provider",
    });
    if (dependenciesReady.every(Boolean)) lastSuccessfulDependencyCheck = Date.now();
    recordMetric("wasalx_worker_heartbeat", dependenciesReady.every(Boolean) ? 1 : 0, {
      component: "tenant_workspace_controller",
    });
    const acquired = await leader.acquireOrRenew();
    if (!acquired) {
      recordProvisioning("controller_poll", "standby", pollStartedAt);
      return;
    }
    const workspaces = await kubernetes.listWorkspaces();
    for (const workspace of workspaces) {
      if (stopped || !leader.isLeader()) break;
      const reconcileStartedAt = Date.now();
      try {
        await withSpan("tenant workspace reconcile", {
          attributes: {
            "wasalx.component": "tenant_workspace_controller",
            "wasalx.operation": "workspace_reconcile",
          },
        }, async () => reconciler.reconcile(workspace));
        recordProvisioning("workspace_reconcile", "succeeded", reconcileStartedAt);
      } catch (error) {
        recordProvisioning("workspace_reconcile", "failed", reconcileStartedAt, safeErrorCode(error));
        recordStructuredLog("error", "tenant_workspace_controller.reconcile_failed", {
          error_code: safeErrorCode(error),
        });
      }
    }
    recordProvisioning("controller_poll", "succeeded", pollStartedAt);
  } catch (error) {
    leader.relinquish();
    recordProvisioning("controller_poll", "failed", pollStartedAt, safeErrorCode(error));
    recordStructuredLog("error", "tenant_workspace_controller.poll_failed", { error_code: safeErrorCode(error) });
  } finally {
    lastCompletedPoll = Date.now();
    polling = false;
  }
}

const interval = setInterval(() => void poll(), config.pollIntervalMs);
interval.unref();
const leadershipInterval = setInterval(
  () => void maintainLeadership(),
  Math.max(1_000, Math.floor(config.leaseDurationSeconds * 1_000 / 3)),
);
leadershipInterval.unref();
void poll();

async function maintainLeadership() {
  if (stopped) return;
  try {
    await leader.acquireOrRenew();
  } catch (error) {
    leader.relinquish();
    recordStructuredLog("error", "tenant_workspace_controller.lease_renewal_failed", {
      error_code: safeErrorCode(error),
    });
  }
}

async function shutdown(signal: string) {
  if (stopped) return;
  stopped = true;
  clearInterval(interval);
  clearInterval(leadershipInterval);
  leader.relinquish();
  recordStructuredLog("info", "tenant_workspace_controller.stopping", { signal });
  const timeout = setTimeout(() => process.exit(1), 25_000);
  timeout.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(timeout);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

function recordProvisioning(operation: string, result: string, startedAt: number, reason = "none") {
  const attributes = { operation, component: "tenant_workspace_controller", result, reason };
  recordMetric("wasalx_provisioning_operations_total", 1, attributes);
  observeDuration("wasalx_provisioning_duration_seconds", startedAt, attributes);
}
