-- A healthy WAHA node does not confirm that its pre-restart sessions resumed.
ALTER TYPE app.waha_session_runtime ADD ATTRIBUTE last_started_at timestamptz;

CREATE OR REPLACE FUNCTION app.current_waha_session_runtime(provider_session_id uuid)
RETURNS SETOF app.waha_session_runtime
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
  SELECT session.id,worker.id,worker.worker_key,worker.engine,
         worker.base_url,worker.secret_reference,worker.lifecycle_state,
         worker.health_state,worker.heartbeat_ttl_seconds,
         worker.last_heartbeat_at,session.assignment_fencing_token,
         session.assignment_lease_expires_at,worker.last_started_at
    FROM public.provider_sessions session
    JOIN public.waha_workers worker ON worker.id=session.waha_worker_id
   WHERE session.tenant_id=app.current_tenant_id()
     AND session.id=provider_session_id
     AND session.ownership_state='ACTIVE';
$$;

REVOKE ALL ON FUNCTION app.current_waha_session_runtime(uuid) FROM PUBLIC;
