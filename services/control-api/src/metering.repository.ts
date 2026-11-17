import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import type { MeteringServicePrincipal } from "./metering-auth.service.js";

export type MeteringObservation = {
  eventId: string;
  meter: string;
  quantity: string;
  periodStart: string;
  periodEnd: string;
  resourceId?: string;
};

@Injectable()
export class MeteringRepository implements OnModuleDestroy {
  private readonly pool?: Pool;

  constructor() {
    const connectionString = process.env.METERING_INGEST_DATABASE_URL;
    if (!connectionString) return;
    this.pool = new Pool({
      connectionString,
      options: "-c role=wasalx_metering_ingest_client",
      max: boundedInteger(process.env.METERING_DATABASE_POOL_SIZE, 4, 1, 10),
      statement_timeout: 15_000,
      application_name: "wasalx-metering-ingest",
    });
  }

  isConfigured() {
    return Boolean(this.pool);
  }

  async ingest(
    principal: MeteringServicePrincipal,
    observations: MeteringObservation[],
  ) {
    const client = await this.requiredPool().connect();
    try {
      await client.query("BEGIN");
      const results: Array<Record<string, unknown>> = [];
      for (const observation of observations) {
        const response = await client.query<{ result: unknown }>(
          "SELECT app.ingest_usage_meter_event($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
          [
            principal.tenantId,
            principal.source,
            principal.subject,
            observation.eventId,
            observation.meter,
            observation.quantity,
            observation.periodStart,
            observation.periodEnd,
            observation.resourceId ?? null,
          ],
        );
        const value = response.rows[0]?.result;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("Metering ingestion returned no result");
        }
        results.push(value as Record<string, unknown>);
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async captureNextPeriod() {
    const result = await this.requiredPool().query<{ result: unknown }>(
      "SELECT app.capture_next_usage_metering_period() AS result",
    );
    const value = result.rows[0]?.result;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Metering capture returned no result");
    }
    return value as Record<string, unknown>;
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  private requiredPool() {
    if (!this.pool) {
      throw new Error(
        "METERING_INGEST_DATABASE_URL for the execution-only metering role is required",
      );
    }
    return this.pool;
  }
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
      `Metering database pool size must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
