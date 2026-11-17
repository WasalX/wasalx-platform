import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { recordMetric, recordStructuredLog, safeErrorCode } from "@wasalx/observability";

type RuntimeMetricRow = { metric: string; dimension: string; value: number | string };

export class OperationalMetricsSampler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
    private readonly intervalMs = 15_000,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 5_000 || intervalMs > 60_000) {
      throw new Error("Operational metrics interval must be between 5000 and 60000 milliseconds");
    }
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.pool.query<RuntimeMetricRow>(
        "SELECT metric,dimension,value FROM app.observability_runtime_metrics()",
      );
      for (const row of result.rows) this.record(row);
      recordMetric("wasalx_database_pool_connections", this.pool.totalCount, { component: "connector_worker", state: "total" });
      recordMetric("wasalx_database_pool_connections", this.pool.idleCount, { component: "connector_worker", state: "idle" });
      recordMetric("wasalx_database_pool_connections", this.pool.waitingCount, { component: "connector_worker", state: "waiting" });
      recordMetric("wasalx_database_pool_connections", poolMaximum(this.pool), { component: "connector_worker", state: "maximum" });
      recordMetric("wasalx_dependency_ready", 1, { component: "connector_worker", dependency: "postgresql_metrics" });
      recordMetric("wasalx_dependency_ready", this.redis.status === "ready" ? 1 : 0, { component: "connector_worker", dependency: "redis" });
    } catch (error) {
      recordMetric("wasalx_dependency_ready", 0, { component: "connector_worker", dependency: "postgresql_metrics" });
      recordStructuredLog("error", "operational_metrics.sample_failed", { error_code: safeErrorCode(error) });
    } finally {
      this.running = false;
    }
  }

  private record(row: RuntimeMetricRow) {
    const value = Number(row.value);
    if (!Number.isFinite(value)) return;
    const dimension = boundedDimension(row.dimension);
    if (row.metric === "queue_depth") {
      recordMetric("wasalx_queue_depth", value, { queue: dimension });
      return;
    }
    if (row.metric === "queue_age_seconds") {
      const name = dimension === "inbound"
        ? "wasalx_inbox_queue_age_seconds"
        : dimension === "delivery"
          ? "wasalx_outbox_queue_age_seconds"
          : "wasalx_work_queue_age_seconds";
      recordMetric(name, value, { queue: dimension });
      return;
    }
    if (row.metric === "connection_state") {
      recordMetric("wasalx_connection_state", value, { state: dimension });
    }
  }
}

function poolMaximum(pool: Pool) {
  const value = (pool as Pool & { options?: { max?: number } }).options?.max;
  return typeof value === "number" && Number.isFinite(value) ? value : 10;
}

function boundedDimension(value: string) {
  const normalized = value.toLowerCase();
  return new Set([
    "inbound", "delivery", "zammad_status", "connection", "privacy", "provisioning", "quarantine",
    "provisioning", "awaiting_auth", "connecting", "working", "degraded", "action_required", "failed",
    "paused", "revoked",
  ]).has(normalized) ? normalized : "unknown";
}
