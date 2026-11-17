-- Official Meta Groups mutations cross an external network boundary. A durable
-- reservation prevents browser retries, proxy retries, or expired requests from
-- creating a second group or resetting an invite link twice. Raw access tokens,
-- group invite links, request bodies, and provider error bodies are never stored.
ALTER TABLE whatsapp_groups
  ADD CONSTRAINT whatsapp_groups_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE secret_cleanup_outbox
  DROP CONSTRAINT secret_cleanup_outbox_cleanup_kind_check,
  ADD CONSTRAINT secret_cleanup_outbox_cleanup_kind_check CHECK (
    cleanup_kind IN ('WEBHOOK_SECRET','CONNECTION_CREDENTIAL')
  );

CREATE TABLE meta_group_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  whatsapp_group_id uuid,
  external_group_id text,
  action_type text NOT NULL CHECK (
    action_type IN ('CREATE_GROUP','RESET_INVITE_LINK','UPDATE_GROUP')
  ),
  idempotency_key text NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 255
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'RUNNING' CHECK (
    state IN ('RUNNING','SUCCEEDED','FAILED','OUTCOME_UNKNOWN')
  ),
  provider_request_id text CHECK (
    provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 512
  ),
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 100),
  safe_error text CHECK (safe_error IS NULL OR length(safe_error) BETWEEN 1 AND 500),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meta_group_actions_connection_fk
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT meta_group_actions_group_fk
    FOREIGN KEY (tenant_id, whatsapp_group_id)
    REFERENCES whatsapp_groups(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT meta_group_actions_group_target_check CHECK (
    (action_type = 'CREATE_GROUP' AND whatsapp_group_id IS NULL AND external_group_id IS NULL)
    OR
    (action_type IN ('RESET_INVITE_LINK','UPDATE_GROUP') AND whatsapp_group_id IS NOT NULL AND external_group_id IS NOT NULL)
  ),
  CONSTRAINT meta_group_actions_completion_check CHECK (
    (state = 'RUNNING' AND completed_at IS NULL AND error_code IS NULL AND safe_error IS NULL)
    OR
    (state = 'SUCCEEDED' AND completed_at IS NOT NULL AND error_code IS NULL AND safe_error IS NULL)
    OR
    (state IN ('FAILED','OUTCOME_UNKNOWN') AND completed_at IS NOT NULL AND error_code IS NOT NULL AND safe_error IS NOT NULL)
  ),
  UNIQUE (tenant_id, idempotency_key)
);

ALTER TABLE meta_group_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_group_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON meta_group_actions
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE INDEX meta_group_actions_connection_time_idx
  ON meta_group_actions (tenant_id, connection_id, created_at DESC);
CREATE INDEX meta_group_actions_expiry_idx
  ON meta_group_actions (tenant_id, expires_at)
  WHERE state = 'RUNNING';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.meta_group_actions TO wasalx_app;
