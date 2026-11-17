CREATE UNIQUE INDEX connections_active_waha_identity_unique
  ON public.connections (tenant_id, phone_e164)
  WHERE provider = 'WAHA'
    AND phone_e164 IS NOT NULL
    AND state <> 'REVOKED';

ALTER TABLE public.connections
  ADD CONSTRAINT connections_phone_e164_format_check
  CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{5,19}$');

CREATE OR REPLACE FUNCTION app.pin_waha_session_assignment_for_cleanup(
  requested_provider_session_id uuid,
  expected_waha_worker_id uuid,
  lease_for interval DEFAULT interval '120 seconds'
)
RETURNS SETOF app.waha_session_assignment
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE
  session_row public.provider_sessions%ROWTYPE;
  worker_row public.waha_workers%ROWTYPE;
BEGIN
  IF lease_for < interval '30 seconds' OR lease_for > interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid pinned WAHA cleanup lease';
  END IF;

  SELECT * INTO session_row
    FROM public.provider_sessions AS session
   WHERE session.tenant_id = app.current_tenant_id()
     AND session.id = requested_provider_session_id
     AND session.ownership_state = 'ACTIVE'
     AND session.waha_worker_id = expected_waha_worker_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO worker_row
    FROM public.waha_workers AS worker
   WHERE worker.id = expected_waha_worker_id;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.provider_sessions AS session
     SET assignment_fencing_token = assignment_fencing_token + 1,
         assignment_lease_expires_at = now() + lease_for,
         updated_at = now()
   WHERE session.id = session_row.id
   RETURNING session.assignment_fencing_token,
             session.assignment_lease_expires_at
        INTO session_row.assignment_fencing_token,
             session_row.assignment_lease_expires_at;

  INSERT INTO public.waha_worker_events
    (waha_worker_id,action,actor_type,actor_id,reason,safe_metadata)
  VALUES (
    worker_row.id,'session.cleanup_pinned','SYSTEM','connection-worker',
    'A duplicate identity cleanup remained pinned to its original WAHA worker.',
    jsonb_build_object('assignment_fence',session_row.assignment_fencing_token)
  );

  RETURN QUERY SELECT session_row.id,worker_row.id,worker_row.worker_key,
    worker_row.engine,worker_row.base_url,worker_row.secret_reference,
    session_row.assignment_fencing_token,session_row.assignment_lease_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION app.pin_waha_session_assignment_for_cleanup(uuid,uuid,interval)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pin_waha_session_assignment_for_cleanup(uuid,uuid,interval)
  TO wasalx_app;
