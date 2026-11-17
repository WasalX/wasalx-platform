CREATE OR REPLACE FUNCTION app.queue_duplicate_waha_identity_cleanup(
  target_connection_id uuid,
  target_provider_session_id uuid,
  pinned_waha_worker_id uuid,
  claimed_phone_e164 text,
  request_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE
  cleanup_operation_id uuid;
  inserted_operation_id uuid;
BEGIN
  IF claimed_phone_e164 !~ '^\+[1-9][0-9]{5,19}$'
     OR request_id IS NULL OR length(btrim(request_id)) NOT BETWEEN 1 AND 320 THEN
    RAISE EXCEPTION 'invalid duplicate identity cleanup request' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(app.current_tenant_id()::text||':'||claimed_phone_e164,0)
  );

  PERFORM 1
    FROM public.connections AS connection
    JOIN public.provider_sessions AS session
      ON session.tenant_id=connection.tenant_id
     AND session.connection_id=connection.id
     AND session.ownership_state='ACTIVE'
   WHERE connection.tenant_id=app.current_tenant_id()
     AND connection.id=target_connection_id
     AND connection.provider='WAHA'
     AND session.id=target_provider_session_id
     AND session.waha_worker_id=pinned_waha_worker_id
   FOR UPDATE OF connection,session;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'duplicate identity target is unavailable' USING ERRCODE='P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.connections AS existing
     WHERE existing.tenant_id=app.current_tenant_id()
       AND existing.id<>target_connection_id
       AND existing.provider='WAHA'
       AND existing.phone_e164=claimed_phone_e164
       AND existing.state<>'REVOKED'
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE public.connections
     SET state='ACTION_REQUIRED',
         action_reason='This WhatsApp account is already connected in this workspace. Removing the duplicate linked session.',
         updated_at=now()
   WHERE tenant_id=app.current_tenant_id() AND id=target_connection_id;
  UPDATE public.provider_sessions
     SET state='ACTION_REQUIRED',updated_at=now()
   WHERE tenant_id=app.current_tenant_id() AND id=target_provider_session_id
     AND ownership_state='ACTIVE';
  UPDATE public.webhook_routes
     SET state='PAUSED',updated_at=now()
   WHERE tenant_id=app.current_tenant_id() AND connection_id=target_connection_id
     AND state<>'REVOKED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'duplicate identity webhook route is unavailable' USING ERRCODE='P0001';
  END IF;

  INSERT INTO public.connection_operations
    (tenant_id,connection_id,operation_type,idempotency_key,payload,
     requested_by_type,requested_by_id,request_id)
  VALUES (
    app.current_tenant_id(),target_connection_id,'DISCONNECT',
    'duplicate-identity:'||target_provider_session_id,
    jsonb_build_object('reason','DUPLICATE_IDENTITY','pinnedWahaWorkerId',pinned_waha_worker_id),
    'SYSTEM','connector-worker',request_id
  )
  ON CONFLICT (tenant_id,idempotency_key) DO NOTHING
  RETURNING id INTO inserted_operation_id;

  IF inserted_operation_id IS NULL THEN
    SELECT id INTO cleanup_operation_id
      FROM public.connection_operations
     WHERE tenant_id=app.current_tenant_id()
       AND idempotency_key='duplicate-identity:'||target_provider_session_id;
  ELSE
    cleanup_operation_id:=inserted_operation_id;
    INSERT INTO public.audit_events
      (tenant_id,actor_type,actor_id,action,target_type,target_id,request_id)
    VALUES (
      app.current_tenant_id(),'SYSTEM','connector-worker',
      'connection.duplicate_identity_rejected','connection',target_connection_id,request_id
    );
  END IF;
  RETURN cleanup_operation_id;
END;
$$;

REVOKE ALL ON FUNCTION app.queue_duplicate_waha_identity_cleanup(uuid,uuid,uuid,text,text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.queue_duplicate_waha_identity_cleanup(uuid,uuid,uuid,text,text)
  TO wasalx_app;

REVOKE ALL ON FUNCTION app.pin_waha_session_assignment_for_cleanup(uuid,uuid,interval)
  FROM wasalx_app;
DROP FUNCTION app.pin_waha_session_assignment_for_cleanup(uuid,uuid,interval);

CREATE OR REPLACE FUNCTION app.pin_waha_session_assignment_for_cleanup(
  requested_provider_session_id uuid,
  expected_waha_worker_id uuid,
  cleanup_operation_id uuid,
  expected_operation_fencing_token bigint,
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
   WHERE session.tenant_id=app.current_tenant_id()
     AND session.id=requested_provider_session_id
     AND session.ownership_state='ACTIVE'
     AND session.waha_worker_id=expected_waha_worker_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM 1
    FROM public.connection_operations AS operation
   WHERE operation.tenant_id=app.current_tenant_id()
     AND operation.id=cleanup_operation_id
     AND operation.connection_id=session_row.connection_id
     AND operation.operation_type='DISCONNECT'
     AND operation.state='RUNNING'
     AND operation.fencing_token=expected_operation_fencing_token
     AND operation.lease_expires_at>=now()
     AND operation.payload->>'reason'='DUPLICATE_IDENTITY'
     AND operation.payload->>'pinnedWahaWorkerId'=expected_waha_worker_id::text;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO worker_row
    FROM public.waha_workers AS worker
   WHERE worker.id=expected_waha_worker_id;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.provider_sessions AS session
     SET assignment_fencing_token=assignment_fencing_token+1,
         assignment_lease_expires_at=now()+lease_for,
         updated_at=now()
   WHERE session.id=session_row.id
   RETURNING session.assignment_fencing_token,session.assignment_lease_expires_at
        INTO session_row.assignment_fencing_token,session_row.assignment_lease_expires_at;

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

REVOKE ALL ON FUNCTION app.pin_waha_session_assignment_for_cleanup(uuid,uuid,uuid,bigint,interval)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pin_waha_session_assignment_for_cleanup(uuid,uuid,uuid,bigint,interval)
  TO wasalx_app;
