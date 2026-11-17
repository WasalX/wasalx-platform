import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { recordMetric, recordStructuredLog } from "@wasalx/observability";
import { MeteringRepository } from "./metering.repository.js";

@Injectable()
export class MeteringReconcilerService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly periodsPerTick = boundedInteger(
    process.env.METERING_CATCHUP_PERIODS_PER_TICK,
    4,
    1,
    12,
  );
  private readonly intervalMs = boundedInteger(
    process.env.METERING_RECONCILE_INTERVAL_MS,
    60_000,
    10_000,
    300_000,
  );

  constructor(private readonly repository: MeteringRepository) {}

  onModuleInit() {
    if (!this.repository.isConfigured()) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  async tick() {
    if (this.running || !this.repository.isConfigured()) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      let captured = 0;
      let caughtUp = false;
      for (let index = 0; index < this.periodsPerTick; index += 1) {
        const result = await this.repository.captureNextPeriod();
        caughtUp = result.caught_up === true;
        const periodStart = timestamp(result.period_start);
        if (periodStart) captured += 1;
        if (caughtUp) break;
      }
      recordMetric("wasalx_metering_capture_periods_total", captured, {
        outcome: caughtUp ? "caught_up" : "catching_up",
      });
      recordMetric(
        "wasalx_metering_capture_duration_seconds",
        (Date.now() - startedAt) / 1_000,
        { outcome: "succeeded" },
      );
    } catch (error) {
      recordMetric("wasalx_metering_capture_periods_total", 1, {
        outcome: "failed",
      });
      recordMetric(
        "wasalx_metering_capture_duration_seconds",
        (Date.now() - startedAt) / 1_000,
        { outcome: "failed" },
      );
      recordStructuredLog("error", "metering.capture_failed", {
        error_code:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "METERING_CAPTURE_FAILED",
      });
    } finally {
      this.running = false;
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}

function timestamp(value: unknown) {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Metering reconciler value must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
