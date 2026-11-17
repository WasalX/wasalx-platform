-- Session-to-worker assignments are durable ownership records, not short-lived
-- work leases. Keep active assignments alive while their exact worker is
-- healthy. Recovery after an idle expiry is permitted only for the same worker
-- UUID and fencing token; no function here can silently move a session.

CREATE OR REPLACE FUNCTION app.renew_waha_session_assignment(
  provider_session_id uuid,
  expected_waha_worker_id uuid,
  expected_assignment_fencing_token bigint,
  lease_for interval DEFAULT interval '120 seconds'
)
RETURNS SETOF app.waha_session_assignment
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
  WITH renewed AS (
    UPDATE public.provider_sessions session
       SET assignment_lease_expires_at = now() + lease_for,
           updated_at = now()
      FROM public.waha_workers worker
     WHERE session.tenant_id = app.current_tenant_id()
       AND session.id = provider_session_id
       AND session.ownership_state = 'ACTIVE'
       AND session.waha_worker_id = expected_waha_worker_id
       AND session.assignment_fencing_token = expected_assignment_fencing_token
       AND worker.id = session.waha_worker_id
       AND worker.lifecycle_state IN ('ACTIVE','DRAINING')
       AND worker.health_state = 'HEALTHY'
       AND worker.last_heartbeat_at >= now() -
           make_interval(secs => worker.heartbeat_ttl_seconds)
       AND lease_for >= interval '30 seconds'
       AND lease_for <= interval '5 minutes'
    RETURNING session.id,session.waha_worker_id,session.assignment_fencing_token,
              session.assignment_lease_expires_at
  )
  SELECT renewed.id,worker.id,worker.worker_key,worker.engine,worker.base_url,
         worker.secret_reference,renewed.assignment_fencing_token,
         renewed.assignment_lease_expires_at
    FROM renewed
    JOIN public.waha_workers worker ON worker.id=renewed.waha_worker_id;
$$;

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

  -- Serialize with worker mode/identity changes. Only a healthy worker that is
  -- still ACTIVE or DRAINING can keep its own assignments alive.
  SELECT * INTO worker FROM public.waha_workers
   WHERE worker_key=configured_worker_key FOR UPDATE;
  IF NOT FOUND
     OR worker.lifecycle_state NOT IN ('ACTIVE','DRAINING')
     OR worker.health_state<>'HEALTHY'
     OR worker.last_heartbeat_at<now()-make_interval(secs=>worker.heartbeat_ttl_seconds) THEN
    RETURN 0;
  END IF;

  UPDATE public.provider_sessions session
     SET assignment_lease_expires_at=now()+lease_for,updated_at=now()
   WHERE session.waha_worker_id=worker.id
     AND session.ownership_state='ACTIVE';
  GET DIAGNOSTICS renewed_count=ROW_COUNT;
  RETURN renewed_count;
END;
$$;

REVOKE ALL ON FUNCTION app.renew_waha_session_assignment(uuid,uuid,bigint,interval)
  FROM PUBLIC,wasalx_provisioner,wasalx_waha_registry_client,
       wasalx_waha_operator_client,wasalx_waha_rollout_gate_client;
REVOKE ALL ON FUNCTION app.renew_waha_worker_assignments(text,interval)
  FROM PUBLIC,wasalx_app,wasalx_provisioner,wasalx_waha_operator_client,
       wasalx_waha_rollout_gate_client;

GRANT EXECUTE ON FUNCTION app.renew_waha_session_assignment(uuid,uuid,bigint,interval)
  TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.renew_waha_worker_assignments(text,interval)
  TO wasalx_waha_registry_client;
