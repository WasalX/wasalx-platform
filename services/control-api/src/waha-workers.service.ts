import {
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from "@nestjs/common";
import { Pool } from "pg";
import { recordMetric } from "@wasalx/observability";

export type WahaWorkerModeChange = {
  version: number;
  lifecycleState: "ACTIVE" | "DRAINING" | "DISABLED";
  rolloutMode: "STABLE" | "CANARY";
  canarySessionLimit?: number;
  reason: string;
};

type WorkerRow = {
  worker_key: string;
  engine: "GOWS" | "NOWEB";
  capacity: number;
  lifecycle_state: "ACTIVE" | "DRAINING" | "DISABLED";
  rollout_mode: "STABLE" | "CANARY";
  canary_session_limit: number | null;
  health_state: "UNKNOWN" | "HEALTHY" | "UNHEALTHY";
  heartbeat_ttl_seconds: number;
  last_heartbeat_at: Date | string | null;
  last_healthy_at: Date | string | null;
  last_started_at: Date | string | null;
  last_error_code: string | null;
  version: string | number;
  assigned_sessions: string | number;
};

@Injectable()
export class WahaWorkersService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    const connectionString = process.env.WAHA_OPERATOR_DATABASE_URL;
    if (!connectionString) throw new Error("WAHA_OPERATOR_DATABASE_URL is required");
    this.pool = new Pool({
      connectionString,
      max: Math.min(Number(process.env.DATABASE_POOL_SIZE ?? 20), 5),
      statement_timeout: 10_000,
      application_name: "wasalx-waha-worker-registry-api",
    });
  }

  async list() {
    const rows = await this.rows();
    return rows.map(safeWorker);
  }

  async changeMode(workerKey: string, change: WahaWorkerModeChange, operatorSubject: string) {
    const result = await this.pool.query<WorkerRow>(
      `SELECT *
         FROM app.set_waha_worker_mode($1,$2,$3,$4,$5,$6,$7)`,
      [
        workerKey,
        change.version,
        change.lifecycleState,
        change.rolloutMode,
        change.canarySessionLimit ?? null,
        operatorSubject,
        change.reason,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      const exists = (await this.rows()).some((worker) => worker.worker_key === workerKey);
      if (!exists) throw new NotFoundException("WAHA worker not found");
      throw new ConflictException("The WAHA worker changed. Refresh and try again.");
    }
    const worker = safeWorker(row);
    try {
      recordMetric("wasalx_waha_worker_mode_changes_total", 1, {
        engine: worker.engine.toLowerCase(),
        lifecycle_state: worker.lifecycleState.toLowerCase(),
        rollout_mode: worker.rolloutMode.toLowerCase(),
      });
    } catch {
      // The mode mutation is already durable and audited. Telemetry failure
      // must not make an operator retry the same state change.
    }
    return worker;
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  private async rows() {
    return (
      await this.pool.query<WorkerRow>(
        "SELECT * FROM app.list_waha_workers()",
      )
    ).rows;
  }
}

function safeWorker(row: WorkerRow) {
  const assignedSessions = Number(row.assigned_sessions);
  const version = Number(row.version);
  if (!Number.isSafeInteger(assignedSessions) || assignedSessions < 0 ||
      !Number.isSafeInteger(version) || version < 1) {
    throw new Error("Database returned invalid WAHA worker counters");
  }
  const lastHeartbeatAt = timestamp(row.last_heartbeat_at);
  const heartbeatFresh = lastHeartbeatAt !== undefined &&
    Date.now() - new Date(lastHeartbeatAt).getTime() <= row.heartbeat_ttl_seconds * 1_000;
  const effectiveHealth = row.health_state === "HEALTHY" && !heartbeatFresh
    ? "STALE"
    : row.health_state;
  return {
    workerKey: row.worker_key,
    engine: row.engine,
    capacity: row.capacity,
    assignedSessions,
    availableCapacity: Math.max(0, row.capacity - assignedSessions),
    utilization: row.capacity > 0 ? assignedSessions / row.capacity : 1,
    lifecycleState: row.lifecycle_state,
    rolloutMode: row.rollout_mode,
    canarySessionLimit: row.canary_session_limit ?? undefined,
    healthState: effectiveHealth,
    lastHeartbeatAt,
    lastHealthyAt: timestamp(row.last_healthy_at),
    lastStartedAt: timestamp(row.last_started_at),
    lastErrorCode: row.last_error_code ?? undefined,
    version,
  };
}

function timestamp(value: Date | string | null) {
  if (value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Database returned an invalid WAHA worker timestamp");
  return date.toISOString();
}
