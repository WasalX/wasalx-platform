export type PlatformOverview = {
  generated_at: string;
  tenant_summary: {
    total: number | string;
    provisioning: number | string;
    active: number | string;
    suspended: number | string;
    failed: number | string;
  };
  provisioning_summary: Record<string, number | string>;
  worker_summary: {
    workers: number | string;
    healthy: number | string;
    capacity: number | string;
    assigned_sessions: number | string;
  };
  support_summary: { pending: number | string; active: number | string };
  metering_capture?: {
    next_period_start: string;
    last_completed_at?: string;
    lag_seconds: number | string;
  };
  month_cost_summary: Array<{
    currency: string;
    estimated_cost_micros: string;
    unpriced_quantity: string;
  }>;
  workers: Array<{
    worker_key: string;
    engine: "GOWS" | "NOWEB";
    capacity: number;
    assigned_sessions: number | string;
    lifecycle_state: string;
    rollout_mode: string;
    canary_session_limit?: number;
    health_state: string;
    last_heartbeat_at?: string;
    last_error_code?: string;
    version: number | string;
  }>;
  support_requests: Array<PlatformSupportAccessRequest & {
    tenant_name: string;
  }>;
};

export type PlatformSupportAccessRequest = {
  id: string;
  tenant_id: string;
  tenant_name?: string;
  state: string;
  scope: string;
  reason: string;
  requested_duration_seconds?: number | string;
  requested_at: string;
  request_expires_at: string;
  approved_at?: string;
  access_expires_at?: string;
  revoked_at?: string;
  version: number | string;
};

export type PlatformSupportOverview = {
  support_access: { id: string; scope: string; access_expires_at: string };
  tenant: { id: string; name: string; slug: string; state: string; updated_at: string };
  zammad?: { state: string; version?: string; last_healthy_at?: string };
  provisioning?: { status: string; action: string; current_step?: string; attempts?: number | string; max_attempts?: number | string; updated_at?: string };
  connections: Array<{ state: string; provider: string; engine?: string }>;
  delivery_summary: Record<string, number | string>;
  oldest_actionable_delivery_at?: string;
  inbound_summary: Record<string, number | string>;
  recent_audit_metadata: Array<{ id: string; actor_type: string; action: string; target_type: string; target_id: string; created_at: string }>;
};

export type TenantOperation = {
  tenant_id: string;
  name: string;
  slug: string;
  tenant_state: string;
  operation_id?: string;
  action?: string;
  status?: string;
  current_step?: string;
  completed_steps?: string[];
  progress_percent?: number;
  attempts?: number;
  max_attempts?: number;
  error_code?: string;
  safe_error?: string;
  allowed_actions?: Array<"RETRY" | "SUSPEND" | "RESUME">;
  available_at?: string;
  lease_expires_at?: string;
  completed_at?: string;
  zammad_state?: string;
  zammad_version?: string;
  created_at: string;
  updated_at: string;
};

export type TenantOperationsPage = {
  items: TenantOperation[];
  next_cursor?: string;
  limit: number;
};

export type TenantUsage = {
  tenant: { id: string; name: string };
  from: string;
  to: string;
  usage: Array<{
    meter: string;
    quantity: string;
    currency: string;
    estimated_cost_micros: string;
    unpriced_quantity: string;
    event_count: number | string;
  }>;
  quotas: Array<{
    id: string;
    meter: string;
    period: string;
    soft_limit: string;
    hard_limit?: string;
    enforcement_mode: "OBSERVE";
    version: number | string;
    updated_at: string;
  }>;
};
