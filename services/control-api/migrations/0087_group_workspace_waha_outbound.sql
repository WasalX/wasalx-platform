-- Ticketless group-workspace deliveries use the same WAHA safety policy as
-- ticket-bound groups and direct conversations.
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
DECLARE destination_value text;
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
  SELECT d.id,d.connection_id,d.group_binding_id,d.bot_conversation_id,
         d.group_workspace_group_id,d.external_chat_id,d.zammad_ticket_id,d.idempotency_key,d.attempts,
         d.state,c.provider,c.phone_e164
    INTO delivery_row
    FROM public.delivery_outbox d
    JOIN public.connections c ON c.tenant_id=d.tenant_id AND c.id=d.connection_id
   WHERE d.tenant_id=tenant_value AND d.id=delivery_value
   FOR UPDATE OF d,c;

  IF NOT FOUND OR delivery_row.provider<>'WAHA' OR delivery_row.state<>'CLAIMED' THEN
    RETURN QUERY SELECT false,now_value+interval '5 minutes','INVALID_DELIVERY_STATE'::text;
    RETURN;
  END IF;

  IF delivery_row.group_binding_id IS NOT NULL THEN
    SELECT g.external_group_id INTO destination_value
      FROM public.group_bindings b
      JOIN public.whatsapp_groups g
        ON g.tenant_id=b.tenant_id AND g.id=b.whatsapp_group_id
     WHERE b.tenant_id=tenant_value AND b.id=delivery_row.group_binding_id
       AND b.state='ACTIVE'
     FOR UPDATE OF b,g;
  ELSIF delivery_row.bot_conversation_id IS NOT NULL THEN
    SELECT bot.external_chat_id INTO destination_value
      FROM public.bot_conversations bot
     WHERE bot.tenant_id=tenant_value AND bot.id=delivery_row.bot_conversation_id
       AND bot.external_chat_id=delivery_row.external_chat_id
     FOR UPDATE OF bot;
  ELSIF delivery_row.group_workspace_group_id IS NOT NULL THEN
    SELECT g.external_group_id INTO destination_value
      FROM public.whatsapp_groups g
      JOIN public.tenant_settings tenant ON tenant.tenant_id=g.tenant_id
      JOIN public.group_workspace_settings workspace
        ON workspace.tenant_id=g.tenant_id AND workspace.whatsapp_group_id=g.id
     WHERE g.tenant_id=tenant_value AND g.id=delivery_row.group_workspace_group_id
       AND tenant.group_workspace_enabled AND workspace.capture_enabled
     FOR UPDATE OF g,workspace;
  END IF;

  IF destination_value IS NULL THEN
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
     WHERE message.tenant_id=tenant_value
       AND message.connection_id=delivery_row.connection_id
       AND message.external_group_id=destination_value
       AND message.from_me=false
       AND message.provider_timestamp>=now_value-
           make_interval(secs=>policy_row.response_window_seconds)
       AND (
         delivery_row.group_workspace_group_id IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM public.message_links link
            WHERE link.tenant_id=message.tenant_id
              AND link.connection_id=message.connection_id
              AND link.external_message_id=message.external_message_id
              AND link.direction='INBOUND'
              AND link.zammad_ticket_id=delivery_row.zammad_ticket_id
         )
       )
  ) THEN
    RETURN QUERY SELECT false,now_value+interval '5 minutes','NO_RECENT_INBOUND_RESPONSE_WINDOW'::text;
    RETURN;
  END IF;

  IF delivery_row.phone_e164 IS NULL OR delivery_row.phone_e164='' THEN
    RETURN QUERY SELECT false,now_value+interval '5 minutes','NUMBER_IDENTITY_MISSING'::text;
    RETURN;
  END IF;
  number_key := delivery_row.phone_e164;

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

REVOKE ALL ON FUNCTION app.authorize_waha_outbound_send(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.authorize_waha_outbound_send(uuid) TO wasalx_app;
