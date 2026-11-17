CREATE TABLE secret_cleanup_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant deletion must fail closed until the provisioning workflow has
  -- observed successful cleanup and explicitly removed the tombstone.
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  connection_operation_id uuid NOT NULL,
  cleanup_kind text NOT NULL CHECK (cleanup_kind IN ('WEBHOOK_SECRET')),
  secret_reference text NOT NULL CHECK (
    octet_length(secret_reference) <= 512
    AND secret_reference ~ '^secret://[A-Za-z0-9][A-Za-z0-9._~:/-]*$'
  ),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (
    state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED_RETRYABLE','FAILED_TERMINAL')
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 12 CHECK (max_attempts BETWEEN 1 AND 100),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 100),
  safe_error text CHECK (safe_error IS NULL OR length(safe_error) BETWEEN 1 AND 500),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT secret_cleanup_outbox_attempt_limit_check CHECK (attempts <= max_attempts),
  CONSTRAINT secret_cleanup_outbox_lease_state_check CHECK (
    (state = 'RUNNING' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'RUNNING' AND lease_id IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT secret_cleanup_outbox_terminal_time_check CHECK (
    (state IN ('SUCCEEDED','FAILED_TERMINAL') AND completed_at IS NOT NULL)
    OR (state NOT IN ('SUCCEEDED','FAILED_TERMINAL') AND completed_at IS NULL)
  ),
  UNIQUE (tenant_id, secret_reference, cleanup_kind),
  UNIQUE (tenant_id, connection_operation_id, cleanup_kind)
);

ALTER TABLE secret_cleanup_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_cleanup_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON secret_cleanup_outbox
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE INDEX secret_cleanup_outbox_claim_idx
  ON secret_cleanup_outbox (available_at, created_at)
  WHERE state IN ('QUEUED','FAILED_RETRYABLE','RUNNING');

-- The connector worker can enqueue a reference under its forced tenant RLS
-- context, but cannot read, claim, update, or delete cleanup work. In
-- particular it never receives the secret-manager write credential.
REVOKE ALL ON public.secret_cleanup_outbox FROM wasalx_app;
GRANT INSERT ON public.secret_cleanup_outbox TO wasalx_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM wasalx_app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_secret_cleanup_executor') THEN
    CREATE ROLE wasalx_secret_cleanup_executor NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE wasalx_secret_cleanup_executor NOLOGIN BYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_secret_cleanup_client') THEN
    CREATE ROLE wasalx_secret_cleanup_client NOLOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE wasalx_secret_cleanup_client NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public, app TO wasalx_secret_cleanup_executor;
GRANT SELECT, UPDATE ON public.secret_cleanup_outbox TO wasalx_secret_cleanup_executor;

CREATE OR REPLACE FUNCTION app.claim_secret_cleanup_tasks(
  worker_lease uuid,
  claim_limit integer DEFAULT 25
)
RETURNS TABLE (
  task_id uuid,
  tenant_id uuid,
  secret_reference text,
  attempts integer,
  max_attempts integer,
  fencing_token bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
BEGIN
  IF worker_lease IS NULL THEN
    RAISE EXCEPTION 'worker lease is required' USING ERRCODE = '22023';
  END IF;
  IF claim_limit < 1 OR claim_limit > 100 THEN
    RAISE EXCEPTION 'claim limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;

  UPDATE public.secret_cleanup_outbox AS exhausted
     SET state = 'FAILED_TERMINAL',
         lease_id = NULL,
         lease_expires_at = NULL,
         error_code = COALESCE(exhausted.error_code, 'MAX_ATTEMPTS_EXHAUSTED'),
         safe_error = COALESCE(exhausted.safe_error, 'Secret cleanup exhausted its retry limit.'),
         completed_at = now(),
         updated_at = now()
   WHERE exhausted.attempts >= exhausted.max_attempts
     AND (
       exhausted.state IN ('QUEUED','FAILED_RETRYABLE')
       OR (exhausted.state = 'RUNNING' AND exhausted.lease_expires_at < now())
     );

  RETURN QUERY
  UPDATE public.secret_cleanup_outbox AS cleanup
     SET lease_id = worker_lease,
         lease_expires_at = now() + interval '60 seconds',
         fencing_token = cleanup.fencing_token + 1,
         state = 'RUNNING',
         attempts = cleanup.attempts + 1,
         error_code = NULL,
         safe_error = NULL,
         updated_at = now()
   WHERE cleanup.id IN (
     SELECT candidate.id
       FROM public.secret_cleanup_outbox AS candidate
      WHERE candidate.attempts < candidate.max_attempts
        AND (
          (candidate.state IN ('QUEUED','FAILED_RETRYABLE') AND candidate.available_at <= now())
          OR (candidate.state = 'RUNNING' AND candidate.lease_expires_at < now())
        )
      ORDER BY candidate.available_at, candidate.created_at, candidate.id
      FOR UPDATE SKIP LOCKED
      LIMIT claim_limit
   )
  RETURNING cleanup.id,
            cleanup.tenant_id,
            cleanup.secret_reference,
            cleanup.attempts,
            cleanup.max_attempts,
            cleanup.fencing_token;
END;
$$;

CREATE OR REPLACE FUNCTION app.complete_secret_cleanup_task(
  task_id_value uuid,
  worker_lease uuid,
  expected_fencing_token bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE public.secret_cleanup_outbox
     SET state = 'SUCCEEDED',
         lease_id = NULL,
         lease_expires_at = NULL,
         error_code = NULL,
         safe_error = NULL,
         completed_at = now(),
         updated_at = now()
   WHERE id = task_id_value
     AND state = 'RUNNING'
     AND lease_id = worker_lease
     AND fencing_token = expected_fencing_token
     AND lease_expires_at >= now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

CREATE OR REPLACE FUNCTION app.fail_secret_cleanup_task(
  task_id_value uuid,
  worker_lease uuid,
  expected_fencing_token bigint,
  retryable boolean,
  failure_code text,
  failure_message text,
  retry_at timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE
  affected integer;
BEGIN
  IF failure_code IS NULL OR length(failure_code) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'failure code is invalid' USING ERRCODE = '22023';
  END IF;
  IF failure_message IS NULL OR length(failure_message) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'failure message is invalid' USING ERRCODE = '22023';
  END IF;

  UPDATE public.secret_cleanup_outbox
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
   WHERE id = task_id_value
     AND state = 'RUNNING'
     AND lease_id = worker_lease
     AND fencing_token = expected_fencing_token
     AND lease_expires_at >= now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

GRANT CREATE ON SCHEMA app TO wasalx_secret_cleanup_executor;
ALTER FUNCTION app.claim_secret_cleanup_tasks(uuid, integer) OWNER TO wasalx_secret_cleanup_executor;
ALTER FUNCTION app.complete_secret_cleanup_task(uuid, uuid, bigint) OWNER TO wasalx_secret_cleanup_executor;
ALTER FUNCTION app.fail_secret_cleanup_task(uuid, uuid, bigint, boolean, text, text, timestamptz)
  OWNER TO wasalx_secret_cleanup_executor;
REVOKE CREATE ON SCHEMA app FROM wasalx_secret_cleanup_executor;

REVOKE ALL ON FUNCTION app.claim_secret_cleanup_tasks(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_secret_cleanup_task(uuid, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fail_secret_cleanup_task(uuid, uuid, bigint, boolean, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_secret_cleanup_tasks(uuid, integer) FROM wasalx_app;
REVOKE ALL ON FUNCTION app.complete_secret_cleanup_task(uuid, uuid, bigint) FROM wasalx_app;
REVOKE ALL ON FUNCTION app.fail_secret_cleanup_task(uuid, uuid, bigint, boolean, text, text, timestamptz) FROM wasalx_app;
GRANT USAGE ON SCHEMA app TO wasalx_secret_cleanup_client;
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO wasalx_secret_cleanup_client', current_database());
END
$$;
GRANT EXECUTE ON FUNCTION app.claim_secret_cleanup_tasks(uuid, integer) TO wasalx_secret_cleanup_client;
GRANT EXECUTE ON FUNCTION app.complete_secret_cleanup_task(uuid, uuid, bigint) TO wasalx_secret_cleanup_client;
GRANT EXECUTE ON FUNCTION app.fail_secret_cleanup_task(uuid, uuid, bigint, boolean, text, text, timestamptz)
  TO wasalx_secret_cleanup_client;

-- Local/container deployments create this LOGIN before migrations run. Hosted
-- environments may grant wasalx_secret_cleanup_client to a differently named
-- login out of band; the application still requires its own database URL.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_secret_cleanup_runtime') THEN
    GRANT wasalx_secret_cleanup_client TO wasalx_secret_cleanup_runtime;
  END IF;
END
$$;
