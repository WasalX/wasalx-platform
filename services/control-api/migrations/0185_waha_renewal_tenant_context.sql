-- Registry renewal crosses tenants; each session must retain its tenant guards.
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
DECLARE
  worker public.waha_workers%ROWTYPE;
  renewable record;
  prior_tenant_context text := current_setting('app.tenant_id',true);
  renewed_count bigint := 0;
  changed_count bigint;
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

  FOR renewable IN
    SELECT session.id,session.tenant_id
      FROM public.provider_sessions session
     WHERE session.waha_worker_id=worker.id
       AND session.ownership_state='ACTIVE'
     ORDER BY session.id
     FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM set_config('app.tenant_id',renewable.tenant_id::text,true);
    UPDATE public.provider_sessions session
       SET assignment_lease_expires_at=now()+lease_for,updated_at=now()
     WHERE session.id=renewable.id
       AND session.tenant_id=renewable.tenant_id
       AND session.waha_worker_id=worker.id
       AND session.ownership_state='ACTIVE';
    GET DIAGNOSTICS changed_count=ROW_COUNT;
    renewed_count := renewed_count+changed_count;
  END LOOP;
  PERFORM set_config('app.tenant_id',COALESCE(prior_tenant_context,''),true);
  RETURN renewed_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.tenant_id',COALESCE(prior_tenant_context,''),true);
  RAISE;
END;
$$;
