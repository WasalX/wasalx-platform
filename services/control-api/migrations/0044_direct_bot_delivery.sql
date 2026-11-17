-- Direct bot replies reuse the existing delivery outbox so they inherit
-- provider fencing, WAHA response-only safety, rate limits, receipt projection,
-- Zammad status reporting, and operator retry behavior.

ALTER TABLE public.delivery_outbox
  ALTER COLUMN group_binding_id DROP NOT NULL,
  ADD COLUMN bot_conversation_id uuid,
  ADD COLUMN external_chat_id text,
  ADD COLUMN bot_content jsonb,
  ADD CONSTRAINT delivery_outbox_bot_conversation_fk
    FOREIGN KEY (tenant_id,bot_conversation_id)
    REFERENCES public.bot_conversations(tenant_id,id) ON DELETE CASCADE,
  ADD CONSTRAINT delivery_outbox_one_route CHECK (
    (group_binding_id IS NOT NULL)::integer+
    (bot_conversation_id IS NOT NULL)::integer=1
  ),
  ADD CONSTRAINT delivery_outbox_direct_target CHECK (
    (bot_conversation_id IS NULL AND external_chat_id IS NULL AND bot_content IS NULL)
    OR (
      bot_conversation_id IS NOT NULL
      AND external_chat_id IS NOT NULL
      AND length(external_chat_id) BETWEEN 3 AND 512
      AND external_chat_id !~ '[[:cntrl:][:space:]]'
      AND (bot_content IS NULL OR (
        jsonb_typeof(bot_content)='object'
        AND octet_length(bot_content::text)<=16384
      ))
    )
  );

CREATE INDEX delivery_outbox_bot_conversation_idx
  ON public.delivery_outbox (tenant_id,bot_conversation_id,created_at)
  WHERE bot_conversation_id IS NOT NULL;

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

CREATE OR REPLACE FUNCTION app.authorize_waha_outbound_send(delivery_value uuid)
RETURNS TABLE (authorized boolean,next_available_at timestamptz,reason_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE tenant_value uuid := app.current_tenant_id();
DECLARE now_value timestamptz := clock_timestamp();
DECLARE delivery_row record;
DECLARE policy_row public.waha_outbound_connection_policies%ROWTYPE;
DECLARE tenant_enabled boolean;
DECLARE platform_enabled boolean;
DECLARE number_key text;
DECLARE connection_bucket public.waha_outbound_buckets%ROWTYPE;
DECLARE number_bucket public.waha_outbound_buckets%ROWTYPE;
DECLARE connection_steps bigint;
DECLARE number_steps bigint;
DECLARE connection_next timestamptz;
DECLARE number_next timestamptz;
DECLARE spacing_next timestamptz;
DECLARE retry_at timestamptz;
BEGIN
  SELECT d.id,d.connection_id,d.group_binding_id,d.zammad_ticket_id,
         d.idempotency_key,d.attempts,d.state,c.provider,c.phone_e164,
         COALESCE(g.external_group_id,d.external_chat_id) AS external_group_id
    INTO delivery_row
    FROM public.delivery_outbox d
    JOIN public.connections c ON c.tenant_id=d.tenant_id AND c.id=d.connection_id
    LEFT JOIN public.group_bindings b ON b.tenant_id=d.tenant_id AND b.id=d.group_binding_id
    LEFT JOIN public.whatsapp_groups g ON g.tenant_id=b.tenant_id AND g.id=b.whatsapp_group_id
    LEFT JOIN public.bot_conversations bot ON bot.tenant_id=d.tenant_id AND bot.id=d.bot_conversation_id
   WHERE d.tenant_id=tenant_value AND d.id=delivery_value
     AND ((d.group_binding_id IS NOT NULL AND b.state='ACTIVE' AND g.id IS NOT NULL)
       OR (d.bot_conversation_id IS NOT NULL AND d.external_chat_id=bot.external_chat_id))
   FOR UPDATE OF d,c,b,g,bot;

  IF NOT FOUND OR delivery_row.provider<>'WAHA' OR delivery_row.state<>'CLAIMED' THEN
    RETURN QUERY SELECT false,now_value+interval '5 minutes','INVALID_DELIVERY_STATE'::text;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.waha_outbound_authorizations authz
     WHERE authz.tenant_id=tenant_value
       AND authz.delivery_id=delivery_row.id
       AND authz.attempt_number=delivery_row.attempts
  ) THEN
    RETURN QUERY SELECT true,NULL::timestamptz,'IDEMPOTENT_REPLAY'::text;
    RETURN;
  END IF;

  SELECT control.enabled INTO platform_enabled
    FROM app.waha_platform_outbound_control control
   WHERE control.singleton=true FOR UPDATE;
  SELECT control.enabled INTO tenant_enabled
    FROM public.waha_outbound_tenant_controls control
   WHERE control.tenant_id=tenant_value FOR UPDATE;
  SELECT * INTO policy_row
    FROM public.waha_outbound_connection_policies policy
   WHERE policy.tenant_id=tenant_value
     AND policy.connection_id=delivery_row.connection_id
   FOR UPDATE;

  IF platform_enabled IS DISTINCT FROM true THEN
    RETURN QUERY SELECT false,now_value+interval '5 minutes','PLATFORM_KILL_SWITCH'::text;
    RETURN;
  END IF;
  IF tenant_enabled IS DISTINCT FROM true THEN
    RETURN QUERY SELECT false,now_value+interval '5 minutes','TENANT_KILL_SWITCH'::text;
    RETURN;
  END IF;
  IF policy_row.connection_id IS NULL OR policy_row.enabled IS DISTINCT FROM true THEN
    RETURN QUERY SELECT false,now_value+interval '5 minutes','CONNECTION_POLICY_DISABLED'::text;
    RETURN;
  END IF;

  IF policy_row.inbound_response_only AND NOT EXISTS (
    SELECT 1
      FROM public.normalized_messages message
      JOIN public.message_links link
        ON link.tenant_id=message.tenant_id
       AND link.connection_id=message.connection_id
       AND link.external_message_id=message.external_message_id
       AND link.direction='INBOUND'
     WHERE message.tenant_id=tenant_value
       AND message.connection_id=delivery_row.connection_id
       AND message.external_group_id=delivery_row.external_group_id
       AND message.from_me=false
       AND message.provider_timestamp>=now_value-
           make_interval(secs=>policy_row.response_window_seconds)
       AND link.zammad_ticket_id=delivery_row.zammad_ticket_id
  ) THEN
    RETURN QUERY SELECT false,now_value+interval '5 minutes','NO_RECENT_INBOUND_RESPONSE_WINDOW'::text;
    RETURN;
  END IF;

  IF delivery_row.phone_e164 IS NULL OR delivery_row.phone_e164='' THEN
    RETURN QUERY SELECT false,now_value+interval '5 minutes','NUMBER_IDENTITY_MISSING'::text;
    RETURN;
  END IF;
  number_key := delivery_row.phone_e164;

  -- Deterministic advisory locks close the absent-row insertion race and also
  -- serialize multiple connection records that refer to the same phone number.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    tenant_value::text||':CONNECTION:'||delivery_row.connection_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    tenant_value::text||':NUMBER:'||number_key,0));

  INSERT INTO public.waha_outbound_buckets
    (tenant_id,scope,scope_key,capacity,refill_tokens,refill_seconds,
     available_tokens,last_refill_at)
  VALUES
    (tenant_value,'CONNECTION',delivery_row.connection_id::text,
     policy_row.connection_capacity,policy_row.connection_refill_tokens,
     policy_row.connection_refill_seconds,policy_row.connection_capacity,now_value),
    (tenant_value,'NUMBER',number_key,policy_row.number_capacity,
     policy_row.number_refill_tokens,policy_row.number_refill_seconds,
     policy_row.number_capacity,now_value)
  ON CONFLICT (tenant_id,scope,scope_key) DO NOTHING;

  SELECT * INTO connection_bucket FROM public.waha_outbound_buckets
   WHERE tenant_id=tenant_value AND scope='CONNECTION'
     AND scope_key=delivery_row.connection_id::text FOR UPDATE;
  SELECT * INTO number_bucket FROM public.waha_outbound_buckets
   WHERE tenant_id=tenant_value AND scope='NUMBER'
     AND scope_key=number_key FOR UPDATE;

  connection_steps := GREATEST(0,FLOOR(EXTRACT(EPOCH FROM
    (now_value-connection_bucket.last_refill_at))/policy_row.connection_refill_seconds));
  number_steps := GREATEST(0,FLOOR(EXTRACT(EPOCH FROM
    (now_value-number_bucket.last_refill_at))/policy_row.number_refill_seconds));

  UPDATE public.waha_outbound_buckets SET
    capacity=policy_row.connection_capacity,
    refill_tokens=policy_row.connection_refill_tokens,
    refill_seconds=policy_row.connection_refill_seconds,
    available_tokens=LEAST(policy_row.connection_capacity,
      available_tokens+connection_steps*policy_row.connection_refill_tokens),
    last_refill_at=CASE WHEN connection_steps>0 THEN
      last_refill_at+make_interval(secs=>(connection_steps*policy_row.connection_refill_seconds)::integer)
      ELSE last_refill_at END,
    updated_at=now_value
   WHERE tenant_id=tenant_value AND scope='CONNECTION'
     AND scope_key=delivery_row.connection_id::text
   RETURNING * INTO connection_bucket;

  UPDATE public.waha_outbound_buckets SET
    capacity=policy_row.number_capacity,
    refill_tokens=policy_row.number_refill_tokens,
    refill_seconds=policy_row.number_refill_seconds,
    available_tokens=LEAST(policy_row.number_capacity,
      available_tokens+number_steps*policy_row.number_refill_tokens),
    last_refill_at=CASE WHEN number_steps>0 THEN
      last_refill_at+make_interval(secs=>(number_steps*policy_row.number_refill_seconds)::integer)
      ELSE last_refill_at END,
    updated_at=now_value
   WHERE tenant_id=tenant_value AND scope='NUMBER' AND scope_key=number_key
   RETURNING * INTO number_bucket;

  connection_next := connection_bucket.last_refill_at+
    make_interval(secs=>policy_row.connection_refill_seconds);
  number_next := number_bucket.last_refill_at+
    make_interval(secs=>policy_row.number_refill_seconds);
  spacing_next := GREATEST(
    COALESCE(connection_bucket.last_authorized_at,'-infinity'::timestamptz),
    COALESCE(number_bucket.last_authorized_at,'-infinity'::timestamptz)
  )+make_interval(secs=>policy_row.minimum_spacing_seconds);

  IF connection_bucket.available_tokens<1 OR number_bucket.available_tokens<1
     OR spacing_next>now_value THEN
    retry_at := GREATEST(
      CASE WHEN connection_bucket.available_tokens<1 THEN connection_next ELSE now_value END,
      CASE WHEN number_bucket.available_tokens<1 THEN number_next ELSE now_value END,
      spacing_next
    );
    RETURN QUERY SELECT false,retry_at,'RATE_LIMITED'::text;
    RETURN;
  END IF;

  UPDATE public.waha_outbound_buckets
     SET available_tokens=available_tokens-1,last_authorized_at=now_value,
         updated_at=now_value
   WHERE tenant_id=tenant_value AND scope='CONNECTION'
     AND scope_key=delivery_row.connection_id::text;
  UPDATE public.waha_outbound_buckets
     SET available_tokens=available_tokens-1,last_authorized_at=now_value,
         updated_at=now_value
   WHERE tenant_id=tenant_value AND scope='NUMBER' AND scope_key=number_key;

  INSERT INTO public.waha_outbound_authorizations
    (tenant_id,delivery_id,connection_id,attempt_number,idempotency_key,
     policy_version,authorized_at)
  VALUES (tenant_value,delivery_row.id,delivery_row.connection_id,
    delivery_row.attempts,delivery_row.idempotency_key,policy_row.version,now_value)
  ON CONFLICT (tenant_id,delivery_id,attempt_number) DO NOTHING;

  RETURN QUERY SELECT true,NULL::timestamptz,'AUTHORIZED'::text;
END;
$$;

REVOKE ALL ON FUNCTION app.claim_delivery_jobs(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_delivery_jobs(uuid,integer) TO wasalx_app;
REVOKE ALL ON FUNCTION app.authorize_waha_outbound_send(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.authorize_waha_outbound_send(uuid) TO wasalx_app;
