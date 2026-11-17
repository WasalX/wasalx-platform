-- Upgrade parity for databases that applied 0023/0024 before the inherited
-- runtime grants were tightened.  Fresh databases receive the same controls in
-- the owning migrations; these statements are intentionally idempotent.

-- Tenant support decisions are writable only through the owner-authorized,
-- optimistic-concurrency functions in 0023.
REVOKE INSERT,UPDATE,DELETE ON public.platform_support_access_requests
  FROM wasalx_app;
GRANT SELECT ON public.platform_support_access_requests TO wasalx_app;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_type type_record
      JOIN pg_namespace namespace_record
        ON namespace_record.oid=type_record.typnamespace
     WHERE namespace_record.nspname='app'
       AND type_record.typname='waha_session_runtime'
  ) THEN
    CREATE TYPE app.waha_session_runtime AS (
      provider_session_id uuid,
      waha_worker_id uuid,
      worker_key text,
      engine text,
      base_url text,
      secret_reference text,
      lifecycle_state text,
      health_state text,
      heartbeat_ttl_seconds integer,
      last_heartbeat_at timestamptz,
      assignment_fencing_token bigint,
      assignment_lease_expires_at timestamptz
    );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION app.current_waha_session_runtime(
  provider_session_id uuid
)
RETURNS SETOF app.waha_session_runtime
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
  SELECT session.id,worker.id,worker.worker_key,worker.engine,
         worker.base_url,worker.secret_reference,worker.lifecycle_state,
         worker.health_state,worker.heartbeat_ttl_seconds,
         worker.last_heartbeat_at,session.assignment_fencing_token,
         session.assignment_lease_expires_at
    FROM public.provider_sessions session
    JOIN public.waha_workers worker ON worker.id=session.waha_worker_id
   WHERE session.tenant_id=app.current_tenant_id()
     AND session.id=provider_session_id
     AND session.ownership_state='ACTIVE';
$$;

-- This existing function still performs a tenant predicate, session fencing,
-- and lease validation.  SECURITY DEFINER lets it read the now-private worker
-- registry without restoring table privileges to ordinary application code.
ALTER FUNCTION app.renew_waha_session_assignment(uuid,uuid,bigint,interval)
  SECURITY DEFINER;
ALTER FUNCTION app.renew_waha_session_assignment(uuid,uuid,bigint,interval)
  SET search_path = pg_catalog, public, app;
ALTER FUNCTION app.renew_waha_session_assignment(uuid,uuid,bigint,interval)
  SET row_security = off;

REVOKE ALL ON public.waha_workers,public.waha_worker_events
  FROM PUBLIC,wasalx_app;
REVOKE ALL ON FUNCTION app.current_waha_session_runtime(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_waha_session_runtime(uuid) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.acquire_waha_session_assignment(uuid,text,interval)
  TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.renew_waha_session_assignment(uuid,uuid,bigint,interval)
  TO wasalx_app;
