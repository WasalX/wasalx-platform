import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { recordMetric, type MetricName } from "@wasalx/observability";
import type { MeteringServicePrincipal } from "./metering-auth.service.js";
import {
  MeteringRepository,
  type MeteringObservation,
} from "./metering.repository.js";

@Injectable()
export class MeteringService {
  constructor(private readonly repository: MeteringRepository) {}

  async ingest(
    principal: MeteringServicePrincipal,
    observations: MeteringObservation[],
  ) {
    if (!this.repository.isConfigured()) {
      throw new ServiceUnavailableException(
        "The least-privilege metering ingestion database role is not configured",
      );
    }
    try {
      const results = await this.repository.ingest(principal, observations);
      for (const [index, result] of results.entries()) {
        if (result.duplicate === true) continue;
        const observation = observations[index];
        if (!observation) continue;
        safeMetric("wasalx_metered_quantity_total", Number(observation.quantity), {
          meter: observation.meter.toLowerCase(),
          source: principal.source,
        });
        const estimatedCost = Number(result.estimated_cost_micros);
        if (Number.isSafeInteger(estimatedCost) && estimatedCost >= 0) {
          safeMetric("wasalx_metered_estimated_cost_micros_total", estimatedCost, {
            meter: observation.meter.toLowerCase(),
            currency: String(result.currency ?? "unknown").toLowerCase(),
          });
        }
      }
      return { accepted: results.length, events: results };
    } catch (error) {
      const code = errorCode(error);
      if (code === "23505") {
        throw new ConflictException(
          "A metering event ID was reused with different content",
        );
      }
      if (code === "P0002") {
        throw new ConflictException("The metering tenant is unavailable");
      }
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException(
        "Metering ingestion is temporarily unavailable",
      );
    }
  }
}

function safeMetric(
  name: MetricName,
  value: number,
  attributes: Record<string, string>,
) {
  if (!Number.isFinite(value) || value < 0) return;
  try {
    recordMetric(name, value, attributes);
  } catch {
    // Durable metering is authoritative; exporter failure is non-fatal.
  }
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
}
