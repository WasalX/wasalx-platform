-- Ticketless group-workspace messages reuse the durable delivery outbox. They
-- never invent a Zammad ticket/article identity and remain tenant/group bound.
ALTER TABLE delivery_outbox
  DROP CONSTRAINT delivery_outbox_one_route,
  ALTER COLUMN zammad_ticket_id DROP NOT NULL,
  ALTER COLUMN zammad_article_id DROP NOT NULL,
  ADD COLUMN delivery_origin text NOT NULL DEFAULT 'TICKET'
    CHECK (delivery_origin IN ('TICKET','GROUP_WORKSPACE')),
  ADD COLUMN group_workspace_group_id uuid,
  ADD CONSTRAINT delivery_outbox_workspace_group_fk
    FOREIGN KEY (tenant_id,group_workspace_group_id)
    REFERENCES whatsapp_groups(tenant_id,id),
  ADD CONSTRAINT delivery_outbox_one_route CHECK (
    (group_binding_id IS NOT NULL)::integer+
    (bot_conversation_id IS NOT NULL)::integer+
    (group_workspace_group_id IS NOT NULL)::integer=1
  ),
  ADD CONSTRAINT delivery_outbox_origin_shape CHECK (
    (delivery_origin='TICKET' AND group_workspace_group_id IS NULL
      AND zammad_ticket_id IS NOT NULL AND zammad_article_id IS NOT NULL)
    OR
    (delivery_origin='GROUP_WORKSPACE' AND group_workspace_group_id IS NOT NULL
      AND group_binding_id IS NULL AND bot_conversation_id IS NULL
      AND external_chat_id IS NULL AND bot_content IS NULL
      AND zammad_ticket_id IS NULL AND zammad_article_id IS NULL)
  );

CREATE INDEX delivery_outbox_workspace_group_idx
  ON delivery_outbox (tenant_id,group_workspace_group_id,created_at,id)
  WHERE delivery_origin='GROUP_WORKSPACE';

CREATE OR REPLACE FUNCTION app.claim_delivery_jobs(worker_lease uuid, claim_limit integer DEFAULT 25)
RETURNS SETOF delivery_outbox
LANGUAGE plpgsql
AS $$
BEGIN
  IF worker_lease IS NULL OR claim_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid delivery claim' USING ERRCODE = '22023';
  END IF;

  UPDATE delivery_attempts AS attempt
     SET state = 'OUTCOME_UNKNOWN',
         safe_error = 'Provider outcome is unknown; verify the WhatsApp destination before retrying.',
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
           safe_error = 'Provider outcome is unknown; verify the WhatsApp destination before retrying.',
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
    FROM unknown WHERE zammad_ticket_id IS NOT NULL
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
       AND (
         delivery.direct_origin IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM delivery_outbox AS predecessor
            WHERE predecessor.tenant_id=delivery.tenant_id
              AND predecessor.connection_id=delivery.connection_id
              AND predecessor.external_chat_id=delivery.external_chat_id
              AND predecessor.direct_origin IN ('BOT','HUMAN')
              AND (predecessor.created_at,predecessor.id)<(delivery.created_at,delivery.id)
              AND predecessor.state NOT IN ('SENT','DELIVERED','READ','PRIVACY_CANCELLED')
              AND (predecessor.state<>'FAILED_TERMINAL' OR predecessor.manual_retry_allowed)
         )
       )
       AND EXISTS (
         SELECT 1 FROM connections AS connection
          WHERE connection.id = delivery.connection_id
            AND connection.tenant_id = delivery.tenant_id
            AND connection.state = 'WORKING'
       )
       AND (
         (delivery.group_binding_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM group_bindings AS binding
            WHERE binding.id=delivery.group_binding_id
              AND binding.tenant_id=delivery.tenant_id
              AND binding.state='ACTIVE'
         ))
         OR
         (delivery.bot_conversation_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM bot_conversations AS conversation
            WHERE conversation.id=delivery.bot_conversation_id
              AND conversation.tenant_id=delivery.tenant_id
              AND conversation.external_chat_id=delivery.external_chat_id
         ))
         OR
         (delivery.group_workspace_group_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM whatsapp_groups AS workspace_group
           JOIN tenant_settings AS tenant ON tenant.tenant_id=workspace_group.tenant_id
           JOIN group_workspace_settings AS workspace ON workspace.tenant_id=workspace_group.tenant_id
             AND workspace.whatsapp_group_id=workspace_group.id
            WHERE workspace_group.tenant_id=delivery.tenant_id
              AND workspace_group.id=delivery.group_workspace_group_id
              AND tenant.group_workspace_enabled AND workspace.capture_enabled
         ))
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
