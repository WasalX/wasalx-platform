-- A provider mutation is not safely retryable after the request has crossed the
-- network boundary. Separate a reclaimable pre-send claim from SENDING, and
-- surface expired/ambiguous sends for explicit operator verification.

CREATE INDEX delivery_outbox_lease_recovery_idx
  ON delivery_outbox (tenant_id, lease_expires_at)
  WHERE state IN ('CLAIMED','SENDING');

CREATE OR REPLACE FUNCTION app.claim_delivery_jobs(worker_lease uuid, claim_limit integer DEFAULT 25)
RETURNS SETOF delivery_outbox
LANGUAGE plpgsql
AS $$
BEGIN
  IF worker_lease IS NULL OR claim_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid delivery claim' USING ERRCODE = '22023';
  END IF;

  -- Once a provider request may have started, a lease expiry can no longer
  -- prove that nothing was sent. Do not automatically issue the mutation again.
  UPDATE delivery_attempts AS attempt
     SET state = 'OUTCOME_UNKNOWN',
         safe_error = 'Provider outcome is unknown; verify the WhatsApp group before retrying.',
         finished_at = now()
    FROM delivery_outbox AS delivery
   WHERE delivery.tenant_id = app.current_tenant_id()
     AND delivery.state = 'SENDING'
     AND delivery.lease_expires_at < now()
     AND attempt.tenant_id = delivery.tenant_id
     AND attempt.delivery_id = delivery.id
     AND attempt.attempt_number = delivery.attempts;

  WITH unknown AS (
    UPDATE delivery_outbox
       SET state = 'OUTCOME_UNKNOWN',
           safe_error = 'Provider outcome is unknown; verify the WhatsApp group before retrying.',
           lease_id = NULL,
           lease_expires_at = NULL,
           updated_at = now()
     WHERE tenant_id = app.current_tenant_id()
       AND state = 'SENDING'
       AND lease_expires_at < now()
    RETURNING id, tenant_id, zammad_ticket_id, safe_error
  )
  INSERT INTO zammad_status_outbox (
    tenant_id, delivery_id, zammad_ticket_id, delivery_state, safe_error
  )
  SELECT tenant_id, id, zammad_ticket_id, 'OUTCOME_UNKNOWN', safe_error
    FROM unknown
  ON CONFLICT (tenant_id, delivery_id) DO UPDATE
    SET delivery_state = EXCLUDED.delivery_state,
        external_message_id = NULL,
        safe_error = EXCLUDED.safe_error,
        completed_at = NULL,
        available_at = now(),
        lease_id = NULL,
        lease_expires_at = NULL,
        updated_at = now();

  RETURN QUERY
  WITH candidates AS (
    SELECT delivery.id
      FROM delivery_outbox AS delivery
     WHERE delivery.tenant_id = app.current_tenant_id()
       AND (
         (delivery.state IN ('QUEUED','FAILED_RETRYABLE') AND delivery.available_at <= now())
         OR (delivery.state = 'CLAIMED' AND delivery.lease_expires_at < now())
       )
       AND (delivery.lease_expires_at IS NULL OR delivery.lease_expires_at < now())
       AND EXISTS (
         SELECT 1 FROM connections AS connection
          WHERE connection.id = delivery.connection_id
            AND connection.tenant_id = delivery.tenant_id
            AND connection.state = 'WORKING'
       )
       AND EXISTS (
         SELECT 1 FROM group_bindings AS binding
          WHERE binding.id = delivery.group_binding_id
            AND binding.tenant_id = delivery.tenant_id
            AND binding.state = 'ACTIVE'
       )
       AND EXISTS (
         SELECT 1 FROM provider_sessions AS session
          WHERE session.connection_id = delivery.connection_id
            AND session.tenant_id = delivery.tenant_id
            AND session.ownership_state = 'ACTIVE'
            AND session.state = 'WORKING'
       )
       AND EXISTS (
         SELECT 1 FROM zammad_instances AS zammad
          WHERE zammad.tenant_id = delivery.tenant_id
            AND zammad.state = 'WORKING'
       )
     ORDER BY delivery.available_at, delivery.created_at, delivery.id
     FOR UPDATE SKIP LOCKED
     LIMIT claim_limit
  )
  UPDATE delivery_outbox AS delivery
     SET lease_id = worker_lease,
         lease_expires_at = now() + interval '60 seconds',
         state = 'CLAIMED',
         attempts = delivery.attempts + 1,
         safe_error = NULL,
         updated_at = now()
    FROM candidates
   WHERE delivery.id = candidates.id
  RETURNING delivery.*;
END;
$$;

REVOKE ALL ON FUNCTION app.claim_delivery_jobs(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_delivery_jobs(uuid,integer) TO wasalx_app;

CREATE OR REPLACE FUNCTION app.list_due_worker_tenants(scan_limit integer DEFAULT 200)
RETURNS TABLE (tenant_id uuid, work_type text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
BEGIN
  IF scan_limit < 1 OR scan_limit > 1000 THEN
    RAISE EXCEPTION 'scan limit must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT candidate.tenant_id, candidate.work_type
    FROM (
      SELECT inbox.tenant_id, 'inbound'::text AS work_type,
             min(inbox.available_at) AS available_at
        FROM public.event_inbox AS inbox
        JOIN public.tenants AS tenant ON tenant.id = inbox.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE')
         AND (
           (inbox.status IN ('ACCEPTED','FAILED_RETRYABLE') AND inbox.available_at <= now())
           OR (inbox.status = 'PROCESSING' AND inbox.lease_expires_at < now())
         )
       GROUP BY inbox.tenant_id

      UNION ALL

      SELECT pending_delivery.tenant_id, 'delivery'::text AS work_type,
             min(pending_delivery.available_at) AS available_at
        FROM (
          SELECT delivery.tenant_id, delivery.available_at
            FROM public.delivery_outbox AS delivery
            JOIN public.tenants AS tenant ON tenant.id = delivery.tenant_id
           WHERE tenant.state IN ('PROVISIONING','ACTIVE')
             AND (
               (delivery.state IN ('QUEUED','FAILED_RETRYABLE') AND delivery.available_at <= now())
               OR (delivery.state IN ('CLAIMED','SENDING') AND delivery.lease_expires_at < now())
             )
          UNION ALL
          SELECT status.tenant_id, status.available_at
            FROM public.zammad_status_outbox AS status
            JOIN public.tenants AS tenant ON tenant.id = status.tenant_id
           WHERE tenant.state IN ('PROVISIONING','ACTIVE')
             AND status.completed_at IS NULL
             AND status.available_at <= now()
             AND (status.lease_expires_at IS NULL OR status.lease_expires_at < now())
        ) AS pending_delivery
       GROUP BY pending_delivery.tenant_id

      UNION ALL

      SELECT operation.tenant_id, 'connection'::text AS work_type,
             min(operation.available_at) AS available_at
        FROM public.connection_operations AS operation
        JOIN public.tenants AS tenant ON tenant.id = operation.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE')
         AND (
           (operation.state IN ('QUEUED','FAILED_RETRYABLE') AND operation.available_at <= now())
           OR (operation.state = 'RUNNING' AND operation.lease_expires_at < now())
         )
       GROUP BY operation.tenant_id
    ) AS candidate
   ORDER BY candidate.available_at, candidate.tenant_id, candidate.work_type
   LIMIT scan_limit;
END;
$$;

ALTER FUNCTION app.list_due_worker_tenants(integer) OWNER TO wasalx_scheduler_reader;
REVOKE ALL ON FUNCTION app.list_due_worker_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_due_worker_tenants(integer) TO wasalx_app;
