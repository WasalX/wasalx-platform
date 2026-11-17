CREATE SCHEMA IF NOT EXISTS workspace_provider;

CREATE TABLE IF NOT EXISTS workspace_provider.tenants (
  tenant_id uuid PRIMARY KEY,
  highest_fencing_token bigint NOT NULL CHECK (highest_fencing_token > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS workspace_provider.operations (
  tenant_id uuid NOT NULL REFERENCES workspace_provider.tenants(tenant_id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  operation_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('identity','database','search','storage','verify','suspend')),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  request_json jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','READY','FAILED','ROLLBACK_PENDING','ROLLED_BACK','SUPERSEDED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  response_json jsonb,
  error_code text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, idempotency_key),
  UNIQUE (tenant_id, operation_id, action)
);

CREATE INDEX IF NOT EXISTS workspace_provider_operations_replay_idx
  ON workspace_provider.operations (state, claim_expires_at, updated_at)
  WHERE state IN ('PENDING','ROLLBACK_PENDING');

CREATE TABLE IF NOT EXISTS workspace_provider.audit_events (
  event_id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES workspace_provider.tenants(tenant_id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  previous_event_sha256 char(64),
  event_sha256 char(64) NOT NULL UNIQUE CHECK (event_sha256 ~ '^[0-9a-f]{64}$'),
  safe_details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON SCHEMA workspace_provider FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA workspace_provider FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA workspace_provider FROM PUBLIC;
GRANT USAGE ON SCHEMA workspace_provider TO wasalx_workspace_provider_runtime;
GRANT SELECT, INSERT, UPDATE ON workspace_provider.tenants, workspace_provider.operations TO wasalx_workspace_provider_runtime;
GRANT SELECT, INSERT ON workspace_provider.audit_events TO wasalx_workspace_provider_runtime;
GRANT USAGE, SELECT ON SEQUENCE workspace_provider.audit_events_event_id_seq TO wasalx_workspace_provider_runtime;
