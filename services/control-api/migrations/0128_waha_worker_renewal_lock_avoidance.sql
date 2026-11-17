-- Keep registry heartbeats from deadlocking with per-session assignment work.
CREATE OR REPLACE FUNCTION app.renew_waha_worker_assignments(
  configured_worker_key text,
  lease_for interval DEFAULT interval '120 seconds'
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE worker public.waha_workers%ROWTYPE;
DECLARE renewed_count bigint;
BEGIN
  IF configured_worker_key !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
     OR lease_for < interval '30 seconds'
     OR lease_for > interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid WAHA assignment renewal request' USING ERRCODE='22023';
  END IF;

  SELECT * INTO worker FROM public.waha_workers
   WHERE worker_key=configured_worker_key FOR UPDATE;
  IF NOT FOUND
     OR worker.lifecycle_state NOT IN ('ACTIVE','DRAINING')
     OR worker.health_state<>'HEALTHY'
     OR worker.last_heartbeat_at<now()-make_interval(secs=>worker.heartbeat_ttl_seconds) THEN
    RETURN 0;
  END IF;

  WITH renewable AS MATERIALIZED (
    SELECT session.id
      FROM public.provider_sessions session
     WHERE session.waha_worker_id=worker.id
       AND session.ownership_state='ACTIVE'
     ORDER BY session.id
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.provider_sessions session
     SET assignment_lease_expires_at=now()+lease_for,updated_at=now()
    FROM renewable
   WHERE session.id=renewable.id;
  GET DIAGNOSTICS renewed_count=ROW_COUNT;
  RETURN renewed_count;
END;
$$;

REVOKE ALL ON FUNCTION app.renew_waha_worker_assignments(text,interval)
  FROM PUBLIC,wasalx_app,wasalx_provisioner,wasalx_waha_operator_client,
       wasalx_waha_rollout_gate_client;
GRANT EXECUTE ON FUNCTION app.renew_waha_worker_assignments(text,interval)
  TO wasalx_waha_registry_client;
