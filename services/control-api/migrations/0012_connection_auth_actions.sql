-- Tenant-facing WAHA authorization mutations are synchronous provider calls,
-- but browser retries must never issue a second pairing-code/passkey command.
-- This ledger stores only a request digest and audit-safe outcome metadata. QR
-- images, pairing codes, passkey challenges, and assertions are never persisted.
CREATE TABLE connection_auth_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  action_type text NOT NULL CHECK (
    action_type IN ('PAIRING_CODE','PASSKEY_ASSERTION','PASSKEY_CONFIRM')
  ),
  idempotency_key text NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 255
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'RUNNING' CHECK (
    state IN ('RUNNING','SUCCEEDED','FAILED','OUTCOME_UNKNOWN')
  ),
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 100),
  safe_error text CHECK (safe_error IS NULL OR length(safe_error) BETWEEN 1 AND 500),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connection_auth_actions_connection_fk
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT connection_auth_actions_completion_check CHECK (
    (state = 'RUNNING' AND completed_at IS NULL AND error_code IS NULL AND safe_error IS NULL)
    OR (state = 'SUCCEEDED' AND completed_at IS NOT NULL AND error_code IS NULL AND safe_error IS NULL)
    OR (state IN ('FAILED','OUTCOME_UNKNOWN') AND completed_at IS NOT NULL AND error_code IS NOT NULL AND safe_error IS NOT NULL)
  ),
  UNIQUE (tenant_id, idempotency_key)
);

ALTER TABLE connection_auth_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_auth_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connection_auth_actions
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE INDEX connection_auth_actions_expiry_idx
  ON connection_auth_actions (tenant_id, expires_at);

-- Migration 0008 deliberately removed broad default write grants. The control
-- API needs this one table and forced RLS remains the tenant boundary.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.connection_auth_actions TO wasalx_app;
