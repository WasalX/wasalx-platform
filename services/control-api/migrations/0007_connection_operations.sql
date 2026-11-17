-- A composite key keeps every tenant-scoped child relationship fail closed even
-- though connection IDs are already globally unique.
ALTER TABLE connections
  ADD CONSTRAINT connections_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE connection_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  operation_type text NOT NULL CHECK (
    operation_type IN ('PROVISION','START','RESTART','PAUSE','DISCONNECT','SYNC_GROUPS')
  ),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (
    state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED_RETRYABLE','FAILED_TERMINAL','CANCELLED')
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 100),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('USER','SERVICE','SYSTEM')),
  requested_by_id text NOT NULL CHECK (length(btrim(requested_by_id)) > 0),
  request_id text NOT NULL CHECK (length(btrim(request_id)) > 0),
  error_code text,
  safe_error text,
  result jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connection_operations_tenant_connection_fk
    FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT connection_operations_attempt_limit_check CHECK (attempts <= max_attempts),
  CONSTRAINT connection_operations_lease_state_check CHECK (
    (state = 'RUNNING' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'RUNNING' AND lease_id IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT connection_operations_terminal_time_check CHECK (
    (state IN ('SUCCEEDED','FAILED_TERMINAL','CANCELLED') AND completed_at IS NOT NULL)
    OR (state NOT IN ('SUCCEEDED','FAILED_TERMINAL','CANCELLED') AND completed_at IS NULL)
  ),
  UNIQUE (tenant_id, idempotency_key)
);

ALTER TABLE connection_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connection_operations
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE INDEX connection_operations_claim_idx
  ON connection_operations (tenant_id, available_at, created_at)
  WHERE state IN ('QUEUED','FAILED_RETRYABLE','RUNNING');

CREATE INDEX connection_operations_request_idx
  ON connection_operations (tenant_id, request_id, created_at DESC);

CREATE OR REPLACE FUNCTION app.claim_connection_operations(
  worker_lease uuid,
  claim_limit integer DEFAULT 25
)
RETURNS SETOF connection_operations
LANGUAGE plpgsql
AS $$
BEGIN
  IF worker_lease IS NULL THEN
    RAISE EXCEPTION 'worker lease is required' USING ERRCODE = '22023';
  END IF;
  IF claim_limit < 1 OR claim_limit > 100 THEN
    RAISE EXCEPTION 'claim limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;

  -- A crashed final attempt cannot remain RUNNING forever. This transition is
  -- deliberately part of every claim pass so no separate reaper is required.
  UPDATE connection_operations
     SET state = 'FAILED_TERMINAL',
         lease_id = NULL,
         lease_expires_at = NULL,
         error_code = COALESCE(error_code, 'MAX_ATTEMPTS_EXHAUSTED'),
         safe_error = COALESCE(safe_error, 'Connection operation exhausted its retry limit.'),
         completed_at = now(),
         updated_at = now()
   WHERE tenant_id = app.current_tenant_id()
     AND attempts >= max_attempts
     AND (
       state IN ('QUEUED','FAILED_RETRYABLE')
       OR (state = 'RUNNING' AND lease_expires_at < now())
     );

  RETURN QUERY
  UPDATE connection_operations AS operation
     SET lease_id = worker_lease,
         lease_expires_at = now() + interval '60 seconds',
         fencing_token = operation.fencing_token + 1,
         state = 'RUNNING',
         attempts = operation.attempts + 1,
         started_at = COALESCE(operation.started_at, now()),
         error_code = NULL,
         safe_error = NULL,
         updated_at = now()
   WHERE operation.id IN (
     SELECT candidate.id
       FROM connection_operations AS candidate
      WHERE candidate.tenant_id = app.current_tenant_id()
        AND candidate.attempts < candidate.max_attempts
        AND (
          (candidate.state IN ('QUEUED','FAILED_RETRYABLE') AND candidate.available_at <= now())
          OR (candidate.state = 'RUNNING' AND candidate.lease_expires_at < now())
        )
        AND (candidate.lease_expires_at IS NULL OR candidate.lease_expires_at < now())
      ORDER BY candidate.available_at, candidate.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT claim_limit
   )
  RETURNING operation.*;
END;
$$;

CREATE OR REPLACE FUNCTION app.complete_connection_operation(
  operation_id_value uuid,
  worker_lease uuid,
  expected_fencing_token bigint,
  operation_result jsonb DEFAULT '{}'::jsonb
)
RETURNS SETOF connection_operations
LANGUAGE sql
AS $$
  UPDATE connection_operations
     SET state = 'SUCCEEDED',
         lease_id = NULL,
         lease_expires_at = NULL,
         result = operation_result,
         completed_at = now(),
         updated_at = now()
   WHERE tenant_id = app.current_tenant_id()
     AND id = operation_id_value
     AND state = 'RUNNING'
     AND lease_id = worker_lease
     AND fencing_token = expected_fencing_token
     AND lease_expires_at >= now()
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION app.fail_connection_operation(
  operation_id_value uuid,
  worker_lease uuid,
  expected_fencing_token bigint,
  retryable boolean,
  failure_code text,
  failure_message text,
  retry_at timestamptz DEFAULT NULL
)
RETURNS SETOF connection_operations
LANGUAGE sql
AS $$
  UPDATE connection_operations
     SET state = CASE
           WHEN retryable AND attempts < max_attempts THEN 'FAILED_RETRYABLE'
           ELSE 'FAILED_TERMINAL'
         END,
         available_at = CASE
           WHEN retryable AND attempts < max_attempts
             THEN COALESCE(retry_at, now() + interval '30 seconds')
           ELSE available_at
         END,
         lease_id = NULL,
         lease_expires_at = NULL,
         error_code = failure_code,
         safe_error = failure_message,
         completed_at = CASE
           WHEN retryable AND attempts < max_attempts THEN NULL
           ELSE now()
         END,
         updated_at = now()
   WHERE tenant_id = app.current_tenant_id()
     AND id = operation_id_value
     AND state = 'RUNNING'
     AND lease_id = worker_lease
     AND fencing_token = expected_fencing_token
     AND lease_expires_at >= now()
  RETURNING *;
$$;

-- Provider sessions have an independent ownership fence. Historical sessions
-- are retained, but exactly one may be the active owner for a connection.
ALTER TABLE provider_sessions
  ADD COLUMN ownership_state text NOT NULL DEFAULT 'ACTIVE'
    CHECK (ownership_state IN ('ACTIVE','RETIRED')),
  ADD COLUMN provider_state text,
  ADD COLUMN provider_state_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_state_data) = 'object'),
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

WITH ranked_sessions AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY tenant_id, connection_id
           ORDER BY created_at DESC, id DESC
         ) AS ownership_rank
    FROM provider_sessions
)
UPDATE provider_sessions AS session
   SET ownership_state = 'RETIRED',
       retired_at = now(),
       worker_id = NULL,
       lease_expires_at = NULL,
       updated_at = now()
  FROM ranked_sessions AS ranked
 WHERE session.id = ranked.id
   AND ranked.ownership_rank > 1;

ALTER TABLE provider_sessions
  ADD CONSTRAINT provider_sessions_tenant_connection_fk
    FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT provider_sessions_retired_state_check CHECK (
    (ownership_state = 'ACTIVE' AND retired_at IS NULL)
    OR (ownership_state = 'RETIRED' AND retired_at IS NOT NULL)
  );

CREATE UNIQUE INDEX provider_sessions_one_active_per_connection_idx
  ON provider_sessions (tenant_id, connection_id)
  WHERE ownership_state = 'ACTIVE';

ALTER TABLE whatsapp_groups
  ADD COLUMN sync_state text NOT NULL DEFAULT 'ACTIVE' CHECK (sync_state IN ('ACTIVE','STALE')),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION app.acquire_provider_session_lease(
  provider_session_id uuid,
  worker_identity text,
  lease_for interval DEFAULT interval '60 seconds'
)
RETURNS SETOF provider_sessions
LANGUAGE sql
AS $$
  UPDATE provider_sessions
     SET worker_id = worker_identity,
         fencing_token = fencing_token + 1,
         lease_expires_at = now() + lease_for,
         updated_at = now()
   WHERE tenant_id = app.current_tenant_id()
     AND id = provider_session_id
     AND ownership_state = 'ACTIVE'
     AND length(btrim(worker_identity)) > 0
     AND lease_for > interval '0 seconds'
     AND lease_for <= interval '5 minutes'
     AND (
       lease_expires_at IS NULL
       OR lease_expires_at < now()
       OR worker_id = worker_identity
     )
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION app.renew_provider_session_lease(
  provider_session_id uuid,
  worker_identity text,
  expected_fencing_token bigint,
  lease_for interval DEFAULT interval '60 seconds'
)
RETURNS SETOF provider_sessions
LANGUAGE sql
AS $$
  UPDATE provider_sessions
     SET lease_expires_at = now() + lease_for,
         updated_at = now()
   WHERE tenant_id = app.current_tenant_id()
     AND id = provider_session_id
     AND ownership_state = 'ACTIVE'
     AND worker_id = worker_identity
     AND fencing_token = expected_fencing_token
     AND lease_expires_at >= now()
     AND lease_for > interval '0 seconds'
     AND lease_for <= interval '5 minutes'
  RETURNING *;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON connection_operations TO wasalx_app;
    GRANT EXECUTE ON FUNCTION app.claim_connection_operations(uuid, integer) TO wasalx_app;
    GRANT EXECUTE ON FUNCTION app.complete_connection_operation(uuid, uuid, bigint, jsonb) TO wasalx_app;
    GRANT EXECUTE ON FUNCTION app.fail_connection_operation(uuid, uuid, bigint, boolean, text, text, timestamptz) TO wasalx_app;
    GRANT EXECUTE ON FUNCTION app.acquire_provider_session_lease(uuid, text, interval) TO wasalx_app;
    GRANT EXECUTE ON FUNCTION app.renew_provider_session_lease(uuid, text, bigint, interval) TO wasalx_app;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app.claim_connection_operations(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_connection_operation(uuid, uuid, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fail_connection_operation(uuid, uuid, bigint, boolean, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.acquire_provider_session_lease(uuid, text, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.renew_provider_session_lease(uuid, text, bigint, interval) FROM PUBLIC;
