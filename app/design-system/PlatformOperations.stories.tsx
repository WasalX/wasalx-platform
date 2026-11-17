import type { Meta, StoryObj } from "@storybook/react-vite";
import { getMessages } from "../../lib/i18n/messages/index.ts";
import { I18nProvider } from "../I18nProvider";
import { PlatformConsole } from "../platform/PlatformConsole";
import type {
  PlatformOverview,
  TenantOperationsPage,
} from "../platform/platform-types";

const now = Date.now();
const overview: PlatformOverview = {
  generated_at: new Date(now).toISOString(),
  tenant_summary: { total: 12, provisioning: 2, active: 9, suspended: 1, failed: 1 },
  provisioning_summary: { COMPLETE: 9, RUNNING: 1, FAILED: 1, SUSPENDED: 1 },
  worker_summary: { workers: 3, healthy: 2, capacity: 100, assigned_sessions: 64 },
  support_summary: { pending: 1, active: 1 },
  month_cost_summary: [
    { currency: "SAR", estimated_cost_micros: "184250000", unpriced_quantity: "0" },
    { currency: "UNPRICED", estimated_cost_micros: "0", unpriced_quantity: "4812" },
  ],
  workers: [
    { worker_key: "gows-riyadh-a", engine: "GOWS", capacity: 50, assigned_sessions: 38, lifecycle_state: "ACTIVE", rollout_mode: "STABLE", health_state: "HEALTHY", version: 8, last_heartbeat_at: new Date(now - 12_000).toISOString() },
    { worker_key: "gows-riyadh-canary", engine: "GOWS", capacity: 10, assigned_sessions: 3, lifecycle_state: "ACTIVE", rollout_mode: "CANARY", canary_session_limit: 5, health_state: "HEALTHY", version: 3, last_heartbeat_at: new Date(now - 18_000).toISOString() },
    { worker_key: "noweb-compat-a", engine: "NOWEB", capacity: 40, assigned_sessions: 23, lifecycle_state: "DRAINING", rollout_mode: "STABLE", health_state: "STALE", version: 12, last_heartbeat_at: new Date(now - 90_000).toISOString(), last_error_code: "HEARTBEAT_STALE" },
  ],
  support_requests: [
    { id: "30000000-0000-4000-8000-000000000001", tenant_id: "10000000-0000-4000-8000-000000000001", tenant_name: "Northstar Logistics", state: "APPROVED", scope: "OPERATIONAL_METADATA", reason: "Investigating repeated WAHA heartbeat loss.", requested_at: new Date(now - 600_000).toISOString(), request_expires_at: new Date(now + 86_400_000).toISOString(), access_expires_at: new Date(now + 420_000).toISOString(), version: 2 },
    { id: "30000000-0000-4000-8000-000000000002", tenant_id: "10000000-0000-4000-8000-000000000002", tenant_name: "Apex Field Services", state: "PENDING", scope: "OPERATIONAL_METADATA", reason: "Validating a delayed provisioning health step.", requested_at: new Date(now - 1_800_000).toISOString(), request_expires_at: new Date(now + 82_800_000).toISOString(), version: 1 },
  ],
};

const tenants: TenantOperationsPage = {
  limit: 50,
  items: [
    { tenant_id: "10000000-0000-4000-8000-000000000001", name: "Northstar Logistics", slug: "northstar", tenant_state: "ACTIVE", operation_id: "20000000-0000-4000-8000-000000000001", action: "PROVISION", status: "COMPLETE", current_step: undefined, completed_steps: ["identity","database","search","storage","secrets","zammad","package","oidc","defaults","health"], progress_percent: 100, attempts: 1, max_attempts: 25, zammad_state: "WORKING", zammad_version: "7.0.1", created_at: new Date(now - 30 * 86_400_000).toISOString(), updated_at: new Date(now - 80_000).toISOString() },
    { tenant_id: "10000000-0000-4000-8000-000000000002", name: "Apex Field Services", slug: "apex-field", tenant_state: "PROVISIONING", operation_id: "20000000-0000-4000-8000-000000000002", action: "PROVISION", status: "RUNNING", current_step: "package", completed_steps: ["identity","database","search","storage","secrets","zammad"], progress_percent: 60, attempts: 2, max_attempts: 25, zammad_state: "STARTING", zammad_version: "7.0.1", created_at: new Date(now - 9_000_000).toISOString(), updated_at: new Date(now - 24_000).toISOString() },
    { tenant_id: "10000000-0000-4000-8000-000000000003", name: "Rimal Distribution", slug: "rimal", tenant_state: "PROVISIONING", operation_id: "20000000-0000-4000-8000-000000000003", action: "PROVISION", status: "FAILED", current_step: "health", completed_steps: ["identity","database","search","storage","secrets","zammad","package","oidc","defaults"], progress_percent: 90, attempts: 5, max_attempts: 25, error_code: "ZAMMAD_HEALTH_TIMEOUT", safe_error: "The tenant health check did not complete in time.", zammad_state: "DEGRADED", zammad_version: "7.0.1", created_at: new Date(now - 12_000_000).toISOString(), updated_at: new Date(now - 220_000).toISOString() },
    { tenant_id: "10000000-0000-4000-8000-000000000004", name: "Safwa Maintenance", slug: "safwa", tenant_state: "SUSPENDED", operation_id: "20000000-0000-4000-8000-000000000004", action: "SUSPEND", status: "SUSPENDED", completed_steps: [], progress_percent: 100, attempts: 1, max_attempts: 25, zammad_state: "SUSPENDED", zammad_version: "7.0.0", created_at: new Date(now - 60 * 86_400_000).toISOString(), updated_at: new Date(now - 4 * 86_400_000).toISOString() },
  ],
};

const operator = {
  displayName: "Lina Al-Faraj",
  email: "lina.ops@wasalx.example",
  authenticatedAt: Math.floor((now - 60_000) / 1_000),
  expiresAt: Math.floor((now + 14 * 60_000) / 1_000),
  csrfToken: "storybook-platform-csrf",
  recoveryScope: "a".repeat(64),
};

const meta = {
  title: "Product/Platform operations",
  component: PlatformConsole,
  tags: ["autodocs", "visual"],
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "Dedicated platform-operator console with no tenant-session reuse. Story data is static and mutations are not mocked as successful.",
      },
    },
  },
  decorators: [
    (Story) => <I18nProvider locale="en" messages={getMessages("en")} renderedAt={now}><Story /></I18nProvider>,
  ],
  args: { initialOverview: overview, initialTenants: tenants, operator },
} satisfies Meta<typeof PlatformConsole>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Dark: Story = { args: { initialTheme: "dark" } };
export const Light: Story = { args: { initialTheme: "light" } };
export const Arabic: Story = { render: args => <I18nProvider locale="ar" messages={getMessages("ar")} renderedAt={now}><PlatformConsole {...args} /></I18nProvider> };
