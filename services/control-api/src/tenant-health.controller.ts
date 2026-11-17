import { Controller, Get, Req } from "@nestjs/common";
import { DatabaseService } from "./database.service.js";
import { Requires } from "./permission.guard.js";
import type { AuthenticatedRequest } from "./types.js";

type HealthRow = {
  connections_total: number;
  connections_working: number;
  connections_action_required: number;
  groups_active: number;
  deliveries_total: number;
  deliveries_successful: number;
  deliveries_terminal: number;
  deliveries_unknown: number;
  inbox_queue_age_seconds: number;
  delivery_queue_age_seconds: number;
  zammad_state: string | null;
  zammad_last_healthy_at: string | null;
};

@Controller("v1/health")
export class TenantHealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  @Requires("connection:read")
  async health(@Req() request: AuthenticatedRequest) {
    const [row] = await this.database.rows<HealthRow>(
      request.principal.tenantId,
      `SELECT
      (SELECT count(*)::int FROM connections WHERE tenant_id=$1) AS connections_total,
      (SELECT count(*)::int FROM connections WHERE tenant_id=$1 AND state='WORKING') AS connections_working,
      (SELECT count(*)::int FROM connections WHERE tenant_id=$1 AND state IN ('ACTION_REQUIRED','FAILED','DEGRADED')) AS connections_action_required,
      (SELECT count(*)::int FROM group_bindings WHERE tenant_id=$1 AND state='ACTIVE') AS groups_active,
      (SELECT count(*)::int FROM delivery_outbox WHERE tenant_id=$1) AS deliveries_total,
      (SELECT count(*)::int FROM delivery_outbox WHERE tenant_id=$1 AND state IN ('SENT','DELIVERED','READ')) AS deliveries_successful,
      (SELECT count(*)::int FROM delivery_outbox WHERE tenant_id=$1 AND state='FAILED_TERMINAL') AS deliveries_terminal,
      (SELECT count(*)::int FROM delivery_outbox WHERE tenant_id=$1 AND state='OUTCOME_UNKNOWN') AS deliveries_unknown,
      COALESCE((SELECT extract(epoch FROM now()-min(received_at))::int FROM event_inbox WHERE tenant_id=$1 AND status IN ('ACCEPTED','PROCESSING')),0) AS inbox_queue_age_seconds,
      COALESCE((SELECT extract(epoch FROM now()-min(created_at))::int FROM delivery_outbox WHERE tenant_id=$1 AND state IN ('QUEUED','SENDING','FAILED_RETRYABLE')),0) AS delivery_queue_age_seconds,
      (SELECT state FROM zammad_instances WHERE tenant_id=$1 LIMIT 1) AS zammad_state,
      (SELECT last_healthy_at FROM zammad_instances WHERE tenant_id=$1 LIMIT 1) AS zammad_last_healthy_at`,
      [request.principal.tenantId],
    );
    const value = row!;
    const successRate = value.deliveries_total
      ? Math.round(
          (value.deliveries_successful / value.deliveries_total) * 1000,
        ) / 10
      : null;
    return {
      status:
        value.connections_action_required || value.deliveries_terminal || value.deliveries_unknown
          ? "degraded"
          : "operational",
      connections: {
        total: value.connections_total,
        working: value.connections_working,
        action_required: value.connections_action_required,
      },
      groups: { active: value.groups_active },
      deliveries: {
        total: value.deliveries_total,
        successful: value.deliveries_successful,
        terminal: value.deliveries_terminal,
        outcome_unknown: value.deliveries_unknown,
        success_rate: successRate,
        queue_age_seconds: value.delivery_queue_age_seconds,
      },
      inbox: { queue_age_seconds: value.inbox_queue_age_seconds },
      zammad: {
        state: value.zammad_state,
        last_healthy_at: value.zammad_last_healthy_at,
      },
      observed_at: new Date().toISOString(),
    };
  }
}
