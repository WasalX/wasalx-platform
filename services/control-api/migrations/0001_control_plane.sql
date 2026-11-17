CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE value text;
BEGIN
  value := current_setting('app.tenant_id', true);
  IF value IS NULL OR value = '' THEN
    RAISE EXCEPTION 'tenant context is required' USING ERRCODE = '42501';
  END IF;
  RETURN value::uuid;
END;
$$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('PROVISIONING','ACTIVE','SUSPENDED','DELETING')),
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_subject text NOT NULL UNIQUE,
  email text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('tenant_owner','tenant_admin','supervisor','agent','auditor')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE zammad_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  base_url text NOT NULL, version text NOT NULL, state text NOT NULL,
  database_reference text NOT NULL, search_namespace text NOT NULL, storage_prefix text NOT NULL,
  service_secret_reference text NOT NULL, last_healthy_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL, provider text NOT NULL CHECK (provider IN ('WAHA','META')), engine text,
  phone_e164 text, state text NOT NULL CHECK (state IN ('PROVISIONING','AWAITING_AUTH','CONNECTING','WORKING','DEGRADED','ACTION_REQUIRED','FAILED','PAUSED','REVOKED')),
  secret_reference text NOT NULL, disclosure_version text, last_heartbeat_at timestamptz,
  last_provider_event_at timestamptz, action_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  opaque_session_id text NOT NULL, worker_id text, fencing_token bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz, state text NOT NULL, session_storage_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (connection_id, opaque_session_id)
);

CREATE TABLE whatsapp_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  external_group_id text NOT NULL, display_name text NOT NULL, participant_count integer NOT NULL DEFAULT 0,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb, last_synced_at timestamptz,
  UNIQUE (connection_id, external_group_id)
);

CREATE TABLE rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL, version integer NOT NULL, state text NOT NULL CHECK (state IN ('DRAFT','ACTIVE','RETIRED')),
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), activated_at timestamptz,
  UNIQUE (tenant_id, name, version)
);

CREATE TABLE trigger_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_set_id uuid NOT NULL REFERENCES rule_sets(id) ON DELETE CASCADE, name text NOT NULL,
  matcher_type text NOT NULL CHECK (matcher_type IN ('exact_length','prefix_length','starts_with','contains','advanced')),
  pattern text NOT NULL, matcher_options jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority integer NOT NULL, enabled boolean NOT NULL DEFAULT true, saved_examples jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (rule_set_id, priority)
);

CREATE TABLE group_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  whatsapp_group_id uuid NOT NULL REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
  rule_set_id uuid NOT NULL REFERENCES rule_sets(id), zammad_group_id text NOT NULL,
  default_priority text NOT NULL, assignment_mode text NOT NULL, fixed_owner_id text,
  sla_policy_id text, acknowledgement_template text NOT NULL, agent_prefix text NOT NULL,
  max_identifiers integer NOT NULL DEFAULT 20 CHECK (max_identifiers BETWEEN 1 AND 100),
  media_enabled boolean NOT NULL DEFAULT true, retention_days integer NOT NULL,
  state text NOT NULL CHECK (state IN ('DRAFT','ACTIVE','PAUSED')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, whatsapp_group_id)
);

CREATE TABLE event_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  provider text NOT NULL, provider_event_id text NOT NULL, event_type text NOT NULL,
  payload jsonb NOT NULL, payload_sha256 text NOT NULL, status text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  UNIQUE (provider, connection_id, provider_event_id)
);

CREATE TABLE participant_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  external_participant_id text NOT NULL, display_name text, normalized_phone text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (connection_id, external_participant_id)
);

CREATE TABLE case_correlations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_binding_id uuid NOT NULL REFERENCES group_bindings(id) ON DELETE CASCADE,
  normalized_reference text NOT NULL, zammad_ticket_id text NOT NULL, zammad_ticket_number text NOT NULL,
  state text NOT NULL CHECK (state IN ('OPEN','RESOLVED','DETACHED')),
  latest_external_message_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, group_binding_id, normalized_reference)
);

CREATE TABLE message_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  external_message_id text NOT NULL, zammad_ticket_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND','MANUAL_DEVICE')),
  quoted_external_message_id text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_message_id)
);

CREATE TABLE delivery_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id), group_binding_id uuid NOT NULL REFERENCES group_bindings(id),
  zammad_ticket_id text NOT NULL, zammad_article_id text NOT NULL, message_body text NOT NULL,
  content_type text NOT NULL, reply_to_message_id text, idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL, attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid, lease_expires_at timestamptz, external_message_id text, safe_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delivery_id uuid NOT NULL REFERENCES delivery_outbox(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL, state text NOT NULL, provider_code text, safe_error text,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE (delivery_id, attempt_number)
);

CREATE TABLE media_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sha256 text NOT NULL, object_key text NOT NULL, mime_type text NOT NULL, byte_size bigint NOT NULL,
  scan_state text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sha256), UNIQUE (object_key)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_type text NOT NULL, actor_id text NOT NULL, action text NOT NULL, target_type text NOT NULL, target_id text NOT NULL,
  previous_value jsonb, new_value jsonb, request_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id text NOT NULL, policy_type text NOT NULL, policy_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, actor_id, policy_type, policy_version)
);

CREATE TABLE provisioning_operations (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE, status text NOT NULL,
  current_step text, completed_steps jsonb NOT NULL DEFAULT '[]'::jsonb, fencing_token bigint NOT NULL DEFAULT 0,
  error_code text, error_detail text, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE secret_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purpose text NOT NULL, manager_path text NOT NULL, version text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, purpose)
);

CREATE OR REPLACE FUNCTION app.reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit events are append-only' USING ERRCODE = '42501'; END;
$$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenant_memberships','zammad_instances','connections','provider_sessions','whatsapp_groups','rule_sets','trigger_rules',
    'group_bindings','event_inbox','participant_identities','case_correlations','message_links','delivery_outbox',
    'delivery_attempts','media_objects','audit_events','consent_records','provisioning_operations','secret_references'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', table_name);
  END LOOP;
END;
$$;

CREATE INDEX event_inbox_pending_idx ON event_inbox (tenant_id, received_at) WHERE status = 'ACCEPTED';
CREATE INDEX delivery_outbox_claim_idx ON delivery_outbox (tenant_id, available_at) WHERE state IN ('QUEUED','FAILED_RETRYABLE');
CREATE INDEX audit_events_tenant_time_idx ON audit_events (tenant_id, created_at DESC);
CREATE INDEX media_objects_expiry_idx ON media_objects (tenant_id, expires_at);
