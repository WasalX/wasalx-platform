-- WAHA linked-device sending is an operationally sensitive capability. Keep
-- eligibility, kill switches, and pacing in PostgreSQL so every connector
-- replica observes one serialized decision. These controls reduce accidental
-- and abusive sending; they do not imply or promise provider "anti-ban"
-- behavior.

CREATE TABLE public.waha_outbound_tenant_controls (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  reason text NOT NULL DEFAULT 'Initial safety policy' CHECK (
    length(reason) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'
  ),
  updated_by text NOT NULL DEFAULT 'system:migration' CHECK (
    length(updated_by) BETWEEN 1 AND 255 AND updated_by !~ '[[:cntrl:]]'
  ),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.waha_outbound_connection_policies (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  inbound_response_only boolean NOT NULL DEFAULT true CHECK (inbound_response_only),
  response_window_seconds integer NOT NULL DEFAULT 86400
    CHECK (response_window_seconds BETWEEN 300 AND 604800),
  connection_capacity integer NOT NULL DEFAULT 3
    CHECK (connection_capacity BETWEEN 1 AND 1000),
  connection_refill_tokens integer NOT NULL DEFAULT 1
    CHECK (connection_refill_tokens BETWEEN 1 AND 1000),
  connection_refill_seconds integer NOT NULL DEFAULT 30
    CHECK (connection_refill_seconds BETWEEN 1 AND 86400),
  number_capacity integer NOT NULL DEFAULT 5
    CHECK (number_capacity BETWEEN 1 AND 1000),
  number_refill_tokens integer NOT NULL DEFAULT 1
    CHECK (number_refill_tokens BETWEEN 1 AND 1000),
  number_refill_seconds integer NOT NULL DEFAULT 30
    CHECK (number_refill_seconds BETWEEN 1 AND 86400),
  minimum_spacing_seconds integer NOT NULL DEFAULT 5
    CHECK (minimum_spacing_seconds BETWEEN 1 AND 3600),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  reason text NOT NULL DEFAULT 'Default inbound-response safety policy' CHECK (
    length(reason) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'
  ),
  updated_by text NOT NULL DEFAULT 'system:migration' CHECK (
    length(updated_by) BETWEEN 1 AND 255 AND updated_by !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,connection_id),
  CONSTRAINT waha_outbound_policy_connection_fk
    FOREIGN KEY (tenant_id,connection_id)
    REFERENCES public.connections(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE public.waha_outbound_buckets (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('CONNECTION','NUMBER')),
  scope_key text NOT NULL CHECK (
    length(scope_key) BETWEEN 1 AND 255 AND scope_key !~ '[[:cntrl:]]'
  ),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 1000),
  refill_tokens integer NOT NULL CHECK (refill_tokens BETWEEN 1 AND 1000),
  refill_seconds integer NOT NULL CHECK (refill_seconds BETWEEN 1 AND 86400),
  available_tokens integer NOT NULL CHECK (available_tokens BETWEEN 0 AND 1000),
  last_refill_at timestamptz NOT NULL,
  last_authorized_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,scope,scope_key),
  CHECK (available_tokens <= capacity)
);

CREATE TABLE public.waha_outbound_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  delivery_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  idempotency_key text NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 255 AND idempotency_key !~ '[[:cntrl:]]'
  ),
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  authorized_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waha_outbound_authorization_delivery_fk
    FOREIGN KEY (tenant_id,delivery_id)
    REFERENCES public.delivery_outbox(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT waha_outbound_authorization_connection_fk
    FOREIGN KEY (tenant_id,connection_id)
    REFERENCES public.connections(tenant_id,id) ON DELETE CASCADE,
  UNIQUE (tenant_id,delivery_id,attempt_number),
  UNIQUE (tenant_id,idempotency_key,attempt_number)
);

CREATE TABLE app.waha_platform_outbound_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  reason text NOT NULL CHECK (
    length(reason) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'
  ),
  updated_by text NOT NULL CHECK (
    length(updated_by) BETWEEN 1 AND 255 AND updated_by !~ '[[:cntrl:]]'
  ),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app.waha_platform_outbound_control
  (singleton,enabled,reason,updated_by)
VALUES (true,true,'Initial platform safety policy','system:migration');

INSERT INTO public.waha_outbound_tenant_controls (tenant_id)
SELECT id FROM public.tenants
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO public.waha_outbound_connection_policies (tenant_id,connection_id)
SELECT tenant_id,id FROM public.connections WHERE provider='WAHA'
ON CONFLICT (tenant_id,connection_id) DO NOTHING;

CREATE OR REPLACE FUNCTION app.seed_waha_outbound_safety()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
BEGIN
  IF TG_TABLE_NAME='tenants' THEN
    INSERT INTO public.waha_outbound_tenant_controls (tenant_id)
    VALUES (NEW.id) ON CONFLICT (tenant_id) DO NOTHING;
  ELSIF NEW.provider='WAHA' THEN
    INSERT INTO public.waha_outbound_tenant_controls (tenant_id)
    VALUES (NEW.tenant_id) ON CONFLICT (tenant_id) DO NOTHING;
    INSERT INTO public.waha_outbound_connection_policies (tenant_id,connection_id)
    VALUES (NEW.tenant_id,NEW.id)
    ON CONFLICT (tenant_id,connection_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_seed_waha_outbound_safety
AFTER INSERT ON public.tenants
FOR EACH ROW EXECUTE FUNCTION app.seed_waha_outbound_safety();

CREATE TRIGGER connections_seed_waha_outbound_safety
AFTER INSERT OR UPDATE OF provider ON public.connections
FOR EACH ROW EXECUTE FUNCTION app.seed_waha_outbound_safety();

ALTER TABLE public.waha_outbound_tenant_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waha_outbound_tenant_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.waha_outbound_tenant_controls
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

ALTER TABLE public.waha_outbound_connection_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waha_outbound_connection_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.waha_outbound_connection_policies
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

ALTER TABLE public.waha_outbound_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waha_outbound_buckets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.waha_outbound_buckets
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

ALTER TABLE public.waha_outbound_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waha_outbound_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.waha_outbound_authorizations
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

CREATE INDEX waha_outbound_authorizations_connection_time_idx
  ON public.waha_outbound_authorizations
  (tenant_id,connection_id,authorized_at DESC);

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
         g.external_group_id
    INTO delivery_row
    FROM public.delivery_outbox d
    JOIN public.connections c ON c.tenant_id=d.tenant_id AND c.id=d.connection_id
    JOIN public.group_bindings b ON b.tenant_id=d.tenant_id AND b.id=d.group_binding_id
    JOIN public.whatsapp_groups g ON g.tenant_id=b.tenant_id AND g.id=b.whatsapp_group_id
   WHERE d.tenant_id=tenant_value AND d.id=delivery_value
   FOR UPDATE OF d,c,b,g;

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

CREATE OR REPLACE FUNCTION app.set_waha_platform_outbound_control(
  expected_version bigint,enabled_value boolean,operator_subject text,
  reason_value text,request_value text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE current_row app.waha_platform_outbound_control%ROWTYPE;
BEGIN
  IF expected_version<1 OR length(operator_subject) NOT BETWEEN 1 AND 255
     OR operator_subject ~ '[[:cntrl:]]'
     OR length(reason_value) NOT BETWEEN 3 AND 500 OR reason_value ~ '[[:cntrl:]]'
     OR length(request_value) NOT BETWEEN 1 AND 255 OR request_value ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid platform outbound safety change' USING ERRCODE='22023';
  END IF;
  SELECT * INTO current_row FROM app.waha_platform_outbound_control
   WHERE singleton=true FOR UPDATE;
  IF current_row.version<>expected_version THEN
    RAISE EXCEPTION 'platform outbound safety version conflict' USING ERRCODE='40001';
  END IF;
  UPDATE app.waha_platform_outbound_control SET enabled=enabled_value,
    version=version+1,reason=reason_value,updated_by=operator_subject,updated_at=now()
   WHERE singleton=true RETURNING * INTO current_row;
  INSERT INTO public.platform_operations_audit_events
    (operator_subject,action,target_type,target_id,safe_metadata,request_id)
  VALUES (operator_subject,'waha.outbound.platform_control_changed',
    'waha_outbound_control','platform',jsonb_build_object(
      'enabled',current_row.enabled,'version',current_row.version,
      'reason',current_row.reason),request_value);
  RETURN jsonb_build_object('enabled',current_row.enabled,'version',current_row.version,
    'reason',current_row.reason,'updatedAt',current_row.updated_at);
END;
$$;

CREATE OR REPLACE FUNCTION app.get_waha_platform_outbound_control()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
  SELECT jsonb_build_object('enabled',enabled,'version',version,'reason',reason,
    'updatedAt',updated_at) FROM app.waha_platform_outbound_control
   WHERE singleton=true;
$$;

REVOKE ALL ON public.waha_outbound_tenant_controls,
  public.waha_outbound_connection_policies,public.waha_outbound_buckets,
  public.waha_outbound_authorizations FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON app.waha_platform_outbound_control FROM PUBLIC,wasalx_app,
  wasalx_waha_registry_client,wasalx_waha_operator_client;
REVOKE ALL ON FUNCTION app.authorize_waha_outbound_send(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.seed_waha_outbound_safety() FROM PUBLIC,wasalx_app,
  wasalx_provisioner,wasalx_waha_registry_client,wasalx_waha_operator_client;
REVOKE ALL ON FUNCTION app.set_waha_platform_outbound_control(bigint,boolean,text,text,text)
  FROM PUBLIC,wasalx_app,wasalx_waha_registry_client;
REVOKE ALL ON FUNCTION app.get_waha_platform_outbound_control()
  FROM PUBLIC,wasalx_app,wasalx_waha_registry_client;

GRANT SELECT ON public.waha_outbound_tenant_controls,
  public.waha_outbound_connection_policies TO wasalx_app;
GRANT UPDATE (enabled,version,reason,updated_by,updated_at)
  ON public.waha_outbound_tenant_controls TO wasalx_app;
GRANT UPDATE (enabled,inbound_response_only,response_window_seconds,
  connection_capacity,connection_refill_tokens,connection_refill_seconds,
  number_capacity,number_refill_tokens,number_refill_seconds,
  minimum_spacing_seconds,version,reason,updated_by,updated_at)
  ON public.waha_outbound_connection_policies TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.authorize_waha_outbound_send(uuid) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.set_waha_platform_outbound_control(bigint,boolean,text,text,text),
  app.get_waha_platform_outbound_control() TO wasalx_waha_operator_client;
