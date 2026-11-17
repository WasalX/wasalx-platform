CREATE OR REPLACE FUNCTION app.redact_expired_unmatched_events(retain_for interval DEFAULT interval '24 hours')
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE affected bigint;
BEGIN
  UPDATE event_inbox
     SET payload = jsonb_build_object('redacted', true, 'payload_sha256', payload_sha256),
         status = 'REDACTED'
   WHERE tenant_id = app.current_tenant_id()
     AND status = 'UNMATCHED'
     AND received_at < now() - retain_for;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

CREATE OR REPLACE FUNCTION app.claim_delivery_jobs(worker_lease uuid, claim_limit integer DEFAULT 25)
RETURNS SETOF delivery_outbox LANGUAGE sql AS $$
  UPDATE delivery_outbox
     SET lease_id = worker_lease,
         lease_expires_at = now() + interval '60 seconds',
         state = 'SENDING',
         attempts = attempts + 1,
         updated_at = now()
   WHERE id IN (
     SELECT id FROM delivery_outbox
      WHERE tenant_id = app.current_tenant_id()
        AND (
          (state IN ('QUEUED','FAILED_RETRYABLE') AND available_at <= now())
          OR (state = 'SENDING' AND lease_expires_at < now())
        )
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
        AND EXISTS (SELECT 1 FROM connections c WHERE c.id = delivery_outbox.connection_id AND c.tenant_id = delivery_outbox.tenant_id AND c.state = 'WORKING')
        AND EXISTS (SELECT 1 FROM group_bindings b WHERE b.id = delivery_outbox.group_binding_id AND b.tenant_id = delivery_outbox.tenant_id AND b.state = 'ACTIVE')
        AND EXISTS (SELECT 1 FROM provider_sessions ps WHERE ps.connection_id = delivery_outbox.connection_id AND ps.tenant_id = delivery_outbox.tenant_id AND ps.state = 'WORKING')
        AND EXISTS (SELECT 1 FROM zammad_instances z WHERE z.tenant_id = delivery_outbox.tenant_id AND z.state = 'WORKING')
      ORDER BY available_at
      FOR UPDATE SKIP LOCKED
      LIMIT claim_limit
   )
  RETURNING *;
$$;
