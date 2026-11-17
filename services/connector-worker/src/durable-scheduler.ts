import { signServiceJwt } from "../../../packages/core/src/service-auth.js";
import type { DrainJob } from "./types.js";
import { currentTraceCarrier } from "@wasalx/observability";

export type DurableWorkType = "delivery" | "inbound" | "connection" | "privacy" | "routing";
export type DueTenantWork = { tenantId: string; workType: DurableWorkType; metaTransitionEventIds?: string[] };

export interface DurableSchedulerStore {
  dueWork(limit?: number): Promise<DueTenantWork[]>;
}

export interface DurableSchedulerQueue {
  add(
    name: string,
    data: DrainJob,
    options: {
      jobId: string;
      removeOnComplete: boolean;
      removeOnFail: boolean;
      attempts: number;
      backoff: { type: "exponential"; delay: number };
    },
  ): Promise<unknown>;
}

type DurableSchedulerOptions = {
  intervalMs?: number;
  scanLimit?: number;
  onError?: (error: Error) => void;
};

const jobScopes: Record<DurableWorkType, string> = {
  delivery: "delivery:drain",
  inbound: "inbox:drain",
  connection: "connection:drain",
  privacy: "privacy:drain",
  routing: "routing:drain",
};

/**
 * Polls the database's narrow SECURITY DEFINER discovery function and wakes the
 * matching BullMQ tenant queues. The database remains authoritative: duplicate
 * wakeups are harmless because each processor uses row leases and fencing.
 */
export class DurableWorkScheduler {
  private readonly intervalMs: number;
  private readonly scanLimit: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private lastSuccessAt = 0;

  constructor(
    private readonly store: DurableSchedulerStore,
    private readonly queues: Record<DurableWorkType, DurableSchedulerQueue>,
    private readonly jwtSecret: string,
    private readonly options: DurableSchedulerOptions = {},
  ) {
    if (jwtSecret.length < 32) throw new Error("WORKER_JOB_JWT_SECRET must contain at least 32 characters");
    this.intervalMs = boundedInteger(options.intervalMs ?? 15_000, 1_000, 60_000, "scheduler interval");
    this.scanLimit = boundedInteger(options.scanLimit ?? 200, 1, 1_000, "scheduler scan limit");
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
    if (this.running) return { skipped: true, queued: 0 };
    this.running = true;
    try {
      const work = await this.store.dueWork(this.scanLimit);
      // A rejected Redis write must not release the overlap guard while other
      // writes from this scan are still running.
      const results = await Promise.allSettled(work.map((item) => this.enqueue(item)));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      this.lastSuccessAt = Date.now();
      return { skipped: false, queued: work.length };
    } catch (error) {
      this.options.onError?.(asError(error));
      return { skipped: false, queued: 0, error: true };
    } finally {
      this.running = false;
    }
  }

  ready() {
    return this.lastSuccessAt > 0 && Date.now() - this.lastSuccessAt <= this.intervalMs * 3;
  }

  private async enqueue(item: DueTenantWork) {
    const now = Math.floor(Date.now() / 1_000);
    const token = await signServiceJwt(
      {
        iss: "wasalx-control",
        aud: "wasalx-connector-worker",
        sub: "durable-work-scheduler",
        tenant_id: item.tenantId,
        instance_id: "connector-worker",
        scope: jobScopes[item.workType],
        iat: now,
        exp: now + 240,
        jti: crypto.randomUUID(),
      },
      this.jwtSecret,
    );
    await this.queues[item.workType].add(
      "drain",
      { tenantId: item.tenantId, token, telemetry: currentTraceCarrier(), ...(item.metaTransitionEventIds?.length?{metaTransitionEventIds:item.metaTransitionEventIds}:{}) },
      {
        jobId: `durable-${item.workType}-${item.tenantId}`,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 5,
        backoff: { type: "exponential", delay: 1_000 },
      },
    );
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error("Unknown durable scheduler failure");
}
