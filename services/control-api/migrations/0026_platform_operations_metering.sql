-- Platform operations and billing-ready metering remain administrative
-- control-plane concerns. Tenant users do not receive either database role.
-- Metering records contain numeric counters and resource identifiers only;
-- message bodies, media object keys, provider payloads, and secrets are not
-- accepted or returned by this schema.

CREATE TABLE public.usage_meter_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN (
    'control-api','connector-worker','media-service','tenant-provisioner',
    'waha-registry','zammad-monitor'
  )),
  source_subject text NOT NULL CHECK (
    length(source_subject) BETWEEN 1 AND 255
    AND source_subject !~ '[[:cntrl:]]'
  ),
  source_event_id text NOT NULL CHECK (
    length(source_event_id) BETWEEN 1 AND 255
    AND source_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  meter_key text NOT NULL CHECK (meter_key IN (
    'CONNECTED_NUMBER_HOURS','ACTIVE_GROUP_HOURS',
    'INBOUND_MESSAGES','OUTBOUND_MESSAGES','MEDIA_BYTES',
    'ZAMMAD_CPU_CORE_HOURS','ZAMMAD_MEMORY_GIB_HOURS',
    'ZAMMAD_STORAGE_GIB_HOURS','WAHA_SESSION_HOURS',
    'WAHA_CAPACITY_UNIT_HOURS'
  )),
  quantity numeric(24,6) NOT NULL CHECK (quantity >= 0),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  resource_id text CHECK (
    resource_id IS NULL OR (
      length(resource_id) BETWEEN 1 AND 255
      AND resource_id !~ '[[:cntrl:]]'
    )
  ),
  event_sha256 text NOT NULL CHECK (event_sha256 ~ '^[0-9a-f]{64}$'),
  meter_rate_id uuid,
  currency text CHECK (currency IS NULL OR currency IN ('SAR','USD')),
  estimated_cost_micros numeric(36,0) CHECK (estimated_cost_micros >= 0),
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  CHECK (period_end <= period_start + interval '24 hours'),
  UNIQUE (tenant_id, source, source_event_id)
);

CREATE TABLE public.usage_daily_rollups (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  usage_day date NOT NULL,
  meter_key text NOT NULL CHECK (meter_key IN (
    'CONNECTED_NUMBER_HOURS','ACTIVE_GROUP_HOURS',
    'INBOUND_MESSAGES','OUTBOUND_MESSAGES','MEDIA_BYTES',
    'ZAMMAD_CPU_CORE_HOURS','ZAMMAD_MEMORY_GIB_HOURS',
    'ZAMMAD_STORAGE_GIB_HOURS','WAHA_SESSION_HOURS',
    'WAHA_CAPACITY_UNIT_HOURS'
  )),
  currency text NOT NULL CHECK (currency IN ('SAR','USD','UNPRICED')),
  quantity numeric(30,6) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  estimated_cost_micros numeric(40,0) NOT NULL DEFAULT 0
    CHECK (estimated_cost_micros >= 0),
  unpriced_quantity numeric(30,6) NOT NULL DEFAULT 0
    CHECK (unpriced_quantity >= 0),
  event_count bigint NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, usage_day, meter_key, currency)
);

CREATE TABLE public.tenant_meter_quotas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  meter_key text NOT NULL CHECK (meter_key IN (
    'CONNECTED_NUMBER_HOURS','ACTIVE_GROUP_HOURS',
    'INBOUND_MESSAGES','OUTBOUND_MESSAGES','MEDIA_BYTES',
    'ZAMMAD_CPU_CORE_HOURS','ZAMMAD_MEMORY_GIB_HOURS',
    'ZAMMAD_STORAGE_GIB_HOURS','WAHA_SESSION_HOURS',
    'WAHA_CAPACITY_UNIT_HOURS'
  )),
  quota_period text NOT NULL CHECK (quota_period IN ('DAY','MONTH')),
  soft_limit numeric(24,6) NOT NULL CHECK (soft_limit > 0),
  hard_limit numeric(24,6) CHECK (hard_limit IS NULL OR hard_limit >= soft_limit),
  enforcement_mode text NOT NULL DEFAULT 'OBSERVE'
    CHECK (enforcement_mode = 'OBSERVE'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL CHECK (
    length(created_by) BETWEEN 1 AND 255
    AND created_by !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, meter_key, quota_period)
);

CREATE TABLE public.platform_meter_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meter_key text NOT NULL CHECK (meter_key IN (
    'CONNECTED_NUMBER_HOURS','ACTIVE_GROUP_HOURS',
    'INBOUND_MESSAGES','OUTBOUND_MESSAGES','MEDIA_BYTES',
    'ZAMMAD_CPU_CORE_HOURS','ZAMMAD_MEMORY_GIB_HOURS',
    'ZAMMAD_STORAGE_GIB_HOURS','WAHA_SESSION_HOURS',
    'WAHA_CAPACITY_UNIT_HOURS'
  )),
  unit_price_micros bigint NOT NULL
    CHECK (unit_price_micros BETWEEN 0 AND 1000000000000),
  currency text NOT NULL CHECK (currency IN ('SAR','USD')),
  effective_from date NOT NULL,
  created_by text NOT NULL CHECK (
    length(created_by) BETWEEN 1 AND 255
    AND created_by !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meter_key, effective_from)
);

ALTER TABLE public.usage_meter_events
  ADD CONSTRAINT usage_meter_events_rate_fk
  FOREIGN KEY (meter_rate_id) REFERENCES public.platform_meter_rates(id);

CREATE TABLE public.platform_metering_operator_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE CHECK (
    length(idempotency_key) BETWEEN 1 AND 255
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('SET_QUOTA','CREATE_RATE')),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
  operator_subject text NOT NULL CHECK (
    length(operator_subject) BETWEEN 1 AND 255
    AND operator_subject !~ '[[:cntrl:]]'
  ),
  response jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.platform_operations_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_subject text NOT NULL CHECK (
    length(operator_subject) BETWEEN 1 AND 255
    AND operator_subject !~ '[[:cntrl:]]'
  ),
  action text NOT NULL CHECK (action ~ '^[a-z0-9_.-]{1,100}$'),
  target_type text NOT NULL CHECK (target_type ~ '^[a-z0-9_.-]{1,100}$'),
  target_id text NOT NULL CHECK (
    length(target_id) BETWEEN 1 AND 255
    AND target_id !~ '[[:cntrl:]]'
  ),
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(safe_metadata) = 'object'),
  request_id text NOT NULL CHECK (
    length(request_id) BETWEEN 1 AND 255
    AND request_id !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.metering_capture_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  next_period_start timestamptz NOT NULL CHECK (
    next_period_start=(
      date_trunc('hour',next_period_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    )
  ),
  last_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.metering_capture_state (singleton,next_period_start)
VALUES (true,
  (date_trunc('hour',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-
    interval '1 hour'
);

CREATE INDEX usage_meter_events_tenant_period_idx
  ON public.usage_meter_events (tenant_id,period_start,meter_key);
CREATE INDEX usage_daily_rollups_period_idx
  ON public.usage_daily_rollups (usage_day,tenant_id,meter_key);
CREATE INDEX tenant_meter_quotas_tenant_idx
  ON public.tenant_meter_quotas (tenant_id,meter_key);
CREATE INDEX platform_operations_audit_actor_time_idx
  ON public.platform_operations_audit_events (operator_subject,created_at DESC);

ALTER TABLE public.usage_meter_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_meter_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.usage_meter_events
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE public.usage_daily_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_daily_rollups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.usage_daily_rollups
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE public.tenant_meter_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_meter_quotas FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.tenant_meter_quotas
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE OR REPLACE FUNCTION app.reject_usage_meter_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'usage meter events and rates are append-only'
    USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER usage_meter_events_append_only
  BEFORE UPDATE OR DELETE ON public.usage_meter_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_usage_meter_mutation();
CREATE TRIGGER platform_meter_rates_append_only
  BEFORE UPDATE OR DELETE ON public.platform_meter_rates
  FOR EACH ROW EXECUTE FUNCTION app.reject_usage_meter_mutation();
CREATE TRIGGER platform_operations_audit_append_only
  BEFORE UPDATE OR DELETE ON public.platform_operations_audit_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();

CREATE OR REPLACE FUNCTION app.ingest_usage_meter_event(
  tenant_value uuid,
  source_value text,
  subject_value text,
  source_event_value text,
  meter_value text,
  quantity_value numeric,
  period_start_value timestamptz,
  period_end_value timestamptz,
  resource_value text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE
  fingerprint text;
  existing_event public.usage_meter_events%ROWTYPE;
  selected_rate public.platform_meter_rates%ROWTYPE;
  event_id uuid;
  cost_value numeric(36,0);
  tenant_state text;
BEGIN
  IF source_value NOT IN (
       'control-api','connector-worker','media-service','tenant-provisioner',
       'waha-registry','zammad-monitor'
     )
     OR length(subject_value) NOT BETWEEN 1 AND 255
     OR subject_value ~ '[[:cntrl:]]'
     OR length(source_event_value) NOT BETWEEN 1 AND 255
     OR source_event_value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
     OR meter_value NOT IN (
       'CONNECTED_NUMBER_HOURS','ACTIVE_GROUP_HOURS',
       'INBOUND_MESSAGES','OUTBOUND_MESSAGES','MEDIA_BYTES',
       'ZAMMAD_CPU_CORE_HOURS','ZAMMAD_MEMORY_GIB_HOURS',
       'ZAMMAD_STORAGE_GIB_HOURS','WAHA_SESSION_HOURS',
       'WAHA_CAPACITY_UNIT_HOURS'
     )
     OR quantity_value < 0 OR quantity_value >= 1000000000000000000
     OR period_end_value <= period_start_value
     OR period_end_value > period_start_value + interval '24 hours'
     OR period_end_value > now() + interval '5 minutes'
     OR period_start_value < now() - interval '366 days'
     OR (resource_value IS NOT NULL AND (
       length(resource_value) NOT BETWEEN 1 AND 255
       OR resource_value ~ '[[:cntrl:]]'
     )) THEN
    RAISE EXCEPTION 'invalid metering observation' USING ERRCODE = '22023';
  END IF;

  SELECT state INTO tenant_state FROM public.tenants WHERE id=tenant_value;
  IF tenant_state IS NULL OR tenant_state='DELETING' THEN
    RAISE EXCEPTION 'metering tenant is unavailable' USING ERRCODE = 'P0002';
  END IF;

  fingerprint := encode(digest(
    concat_ws(E'\x1f',tenant_value::text,source_value,source_event_value,
      meter_value,quantity_value::text,
      to_char(period_start_value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),
      to_char(period_end_value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),
      COALESCE(resource_value,'')),
    'sha256'
  ),'hex');

  SELECT * INTO selected_rate
    FROM public.platform_meter_rates
   WHERE meter_key=meter_value
     AND effective_from<=(period_start_value AT TIME ZONE 'UTC')::date
   ORDER BY effective_from DESC
   LIMIT 1;
  IF selected_rate.id IS NOT NULL THEN
    cost_value := round(quantity_value * selected_rate.unit_price_micros);
  END IF;

  INSERT INTO public.usage_meter_events (
    tenant_id,source,source_subject,source_event_id,meter_key,quantity,
    period_start,period_end,resource_id,event_sha256,meter_rate_id,currency,
    estimated_cost_micros
  ) VALUES (
    tenant_value,source_value,subject_value,source_event_value,meter_value,
    quantity_value,period_start_value,period_end_value,resource_value,
    fingerprint,selected_rate.id,selected_rate.currency,cost_value
  )
  ON CONFLICT (tenant_id,source,source_event_id) DO NOTHING
  RETURNING id INTO event_id;

  IF event_id IS NULL THEN
    SELECT * INTO existing_event
      FROM public.usage_meter_events
     WHERE tenant_id=tenant_value AND source=source_value
       AND source_event_id=source_event_value;
    IF existing_event.event_sha256<>fingerprint THEN
      RAISE EXCEPTION 'metering event id was reused with different content'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'id',existing_event.id,'duplicate',true,
      'meter',existing_event.meter_key,
      'quantity',existing_event.quantity::text,
      'currency',existing_event.currency,
      'estimated_cost_micros',existing_event.estimated_cost_micros::text
    );
  END IF;

  INSERT INTO public.usage_daily_rollups (
    tenant_id,usage_day,meter_key,currency,quantity,estimated_cost_micros,
    unpriced_quantity,event_count
  ) VALUES (
    tenant_value,(period_start_value AT TIME ZONE 'UTC')::date,meter_value,
    COALESCE(selected_rate.currency,'UNPRICED'),quantity_value,
    COALESCE(cost_value,0),
    CASE WHEN selected_rate.id IS NULL THEN quantity_value ELSE 0 END,1
  )
  ON CONFLICT (tenant_id,usage_day,meter_key,currency) DO UPDATE SET
    quantity=public.usage_daily_rollups.quantity+EXCLUDED.quantity,
    estimated_cost_micros=
      public.usage_daily_rollups.estimated_cost_micros+
      EXCLUDED.estimated_cost_micros,
    unpriced_quantity=
      public.usage_daily_rollups.unpriced_quantity+EXCLUDED.unpriced_quantity,
    event_count=public.usage_daily_rollups.event_count+1,
    updated_at=now();

  RETURN jsonb_build_object(
    'id',event_id,'duplicate',false,'meter',meter_value,
    'quantity',quantity_value::text,'currency',selected_rate.currency,
    'estimated_cost_micros',cost_value::text,
    'priced',selected_rate.id IS NOT NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION app.operator_platform_operations_overview(
  actor_subject text,
  audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE result_value jsonb;
BEGIN
  INSERT INTO public.platform_operations_audit_events
    (operator_subject,action,target_type,target_id,safe_metadata,request_id)
  VALUES (
    actor_subject,'platform.overview_inspected','platform','all',
    jsonb_build_object('scope','OPERATIONAL_METADATA'),audit_request_id
  );

  SELECT jsonb_build_object(
    'generated_at',now(),
    'tenant_summary',jsonb_build_object(
      'total',(SELECT count(*) FROM public.tenants),
      'provisioning',(SELECT count(*) FROM public.tenants WHERE state='PROVISIONING'),
      'active',(SELECT count(*) FROM public.tenants WHERE state='ACTIVE'),
      'suspended',(SELECT count(*) FROM public.tenants WHERE state='SUSPENDED'),
      'failed',(SELECT count(*) FROM public.provisioning_operations
        WHERE status IN ('FAILED','FAILED_RETRYABLE'))
    ),
    'provisioning_summary',COALESCE((
      SELECT jsonb_object_agg(status,total)
        FROM (SELECT status,count(*) AS total
          FROM public.provisioning_operations GROUP BY status) statuses
    ),'{}'::jsonb),
    'worker_summary',jsonb_build_object(
      'workers',(SELECT count(*) FROM public.waha_workers),
      'healthy',(SELECT count(*) FROM public.waha_workers w
        WHERE w.health_state='HEALTHY'
          AND w.last_heartbeat_at>=now()-make_interval(secs=>w.heartbeat_ttl_seconds)),
      'capacity',COALESCE((SELECT sum(capacity) FROM public.waha_workers),0),
      'assigned_sessions',(SELECT count(*) FROM public.provider_sessions
        WHERE ownership_state='ACTIVE' AND waha_worker_id IS NOT NULL)
    ),
    'support_summary',jsonb_build_object(
      'pending',(SELECT count(*) FROM public.platform_support_access_requests
        WHERE operator_subject=actor_subject AND state='PENDING'),
      'active',(SELECT count(*) FROM public.platform_support_access_requests
        WHERE operator_subject=actor_subject AND state='APPROVED'
          AND access_expires_at>now())
    ),
    'metering_capture',(
      SELECT jsonb_build_object(
        'next_period_start',next_period_start,
        'last_completed_at',last_completed_at,
        'lag_seconds',GREATEST(0,extract(epoch FROM
          ((date_trunc('hour',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-
            next_period_start)))::bigint
      ) FROM public.metering_capture_state WHERE singleton
    ),
    'month_cost_summary',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'currency',currency,
        'estimated_cost_micros',estimated_cost_micros::text,
        'unpriced_quantity',unpriced_quantity::text
      ) ORDER BY currency)
      FROM (
        SELECT currency,sum(estimated_cost_micros) AS estimated_cost_micros,
               sum(unpriced_quantity) AS unpriced_quantity
          FROM public.usage_daily_rollups
         WHERE usage_day>=date_trunc('month',current_date)::date
         GROUP BY currency
      ) totals
    ),'[]'::jsonb),
    'workers',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'worker_key',w.worker_key,'engine',w.engine,'capacity',w.capacity,
        'assigned_sessions',(SELECT count(*) FROM public.provider_sessions s
          WHERE s.waha_worker_id=w.id AND s.ownership_state='ACTIVE'),
        'lifecycle_state',w.lifecycle_state,'rollout_mode',w.rollout_mode,
        'canary_session_limit',w.canary_session_limit,'version',w.version,
        'health_state',CASE
          WHEN w.health_state='HEALTHY' AND (
            w.last_heartbeat_at IS NULL
            OR w.last_heartbeat_at<now()-make_interval(secs=>w.heartbeat_ttl_seconds)
          )
          THEN 'STALE' ELSE w.health_state END,
        'last_heartbeat_at',w.last_heartbeat_at,
        'last_error_code',w.last_error_code
      ) ORDER BY w.engine,w.worker_key) FROM public.waha_workers w
    ),'[]'::jsonb),
    'support_requests',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',s.id,'tenant_id',s.tenant_id,'tenant_name',t.name,
        'state',s.state,'scope',s.scope,'reason',s.reason,
        'requested_at',s.requested_at,'request_expires_at',s.request_expires_at,
        'access_expires_at',s.access_expires_at,'version',s.version
      ) ORDER BY s.created_at DESC)
      FROM (
        SELECT * FROM public.platform_support_access_requests
         WHERE operator_subject=actor_subject
         ORDER BY created_at DESC LIMIT 20
      ) s JOIN public.tenants t ON t.id=s.tenant_id
    ),'[]'::jsonb)
  ) INTO result_value;
  RETURN result_value;
END;
$$;

-- One transaction captures one completed UTC hour and advances the durable
-- checkpoint. SELECT FOR UPDATE serializes multiple control API replicas, and
-- the event identity makes a retry safe even if a caller loses the response.
-- Zammad footprint is the declared reservation from the provisioning spec,
-- and is emitted only after the tenant is ACTIVE with a registered instance.
CREATE OR REPLACE FUNCTION app.capture_next_usage_metering_period()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE period_value timestamptz;
DECLARE period_end_value timestamptz;
DECLARE tenant_value record;
DECLARE meter_value record;
DECLARE result_value jsonb;
DECLARE accepted_count integer:=0;
DECLARE duplicate_count integer:=0;
DECLARE profile_cpu numeric;
DECLARE profile_memory numeric;
DECLARE profile_storage numeric;
BEGIN
  SELECT next_period_start INTO period_value
    FROM public.metering_capture_state WHERE singleton FOR UPDATE;
  IF period_value IS NULL THEN
    RAISE EXCEPTION 'metering capture checkpoint is missing' USING ERRCODE='55000';
  END IF;
  period_end_value:=period_value+interval '1 hour';
  IF period_end_value>
    (date_trunc('hour',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') THEN
    RETURN jsonb_build_object(
      'caught_up',true,'next_period_start',period_value,
      'accepted',0,'duplicates',0
    );
  END IF;

  FOR tenant_value IN
    SELECT t.id,t.state,
           p.spec #>> '{deployment,resourceProfile}' AS resource_profile,
           EXISTS (SELECT 1 FROM public.zammad_instances z
             WHERE z.tenant_id=t.id) AS has_zammad
      FROM public.tenants t
      LEFT JOIN public.provisioning_operations p ON p.tenant_id=t.id
     WHERE t.state<>'DELETING'
     ORDER BY t.id
  LOOP
    SELECT cpu,memory,storage INTO profile_cpu,profile_memory,profile_storage
      FROM (VALUES
        ('small',1::numeric,2::numeric,20::numeric),
        ('medium',2::numeric,4::numeric,50::numeric),
        ('large',4::numeric,8::numeric,100::numeric)
      ) profile(name,cpu,memory,storage)
     WHERE name=tenant_value.resource_profile;
    profile_cpu:=COALESCE(profile_cpu,0);
    profile_memory:=COALESCE(profile_memory,0);
    profile_storage:=COALESCE(profile_storage,0);

    FOR meter_value IN
      SELECT * FROM (VALUES
        ('CONNECTED_NUMBER_HOURS',(
          SELECT count(*)::numeric FROM public.connections c
           WHERE c.tenant_id=tenant_value.id AND c.phone_e164 IS NOT NULL
             AND c.state<>'REVOKED'
        )),
        ('ACTIVE_GROUP_HOURS',(
          SELECT count(*)::numeric FROM public.group_bindings b
           WHERE b.tenant_id=tenant_value.id AND b.state='ACTIVE'
        )),
        ('INBOUND_MESSAGES',(
          SELECT count(*)::numeric FROM public.normalized_messages m
           WHERE m.tenant_id=tenant_value.id AND NOT m.from_api AND NOT m.from_me
             AND m.created_at>=period_value AND m.created_at<period_end_value
        )),
        ('OUTBOUND_MESSAGES',(
          SELECT count(*)::numeric FROM public.delivery_outbox d
           WHERE d.tenant_id=tenant_value.id
             AND d.created_at>=period_value AND d.created_at<period_end_value
        )),
        ('MEDIA_BYTES',(
          SELECT COALESCE(sum(byte_size),0)::numeric FROM public.media_objects m
           WHERE m.tenant_id=tenant_value.id
             AND m.created_at>=period_value AND m.created_at<period_end_value
        )),
        ('ZAMMAD_CPU_CORE_HOURS',CASE
          WHEN tenant_value.state='ACTIVE' AND tenant_value.has_zammad
          THEN profile_cpu ELSE 0 END),
        ('ZAMMAD_MEMORY_GIB_HOURS',CASE
          WHEN tenant_value.state='ACTIVE' AND tenant_value.has_zammad
          THEN profile_memory ELSE 0 END),
        ('ZAMMAD_STORAGE_GIB_HOURS',CASE
          WHEN tenant_value.state='ACTIVE' AND tenant_value.has_zammad
          THEN profile_storage ELSE 0 END),
        ('WAHA_SESSION_HOURS',(
          SELECT count(*)::numeric FROM public.provider_sessions s
           JOIN public.connections c ON c.id=s.connection_id
            AND c.tenant_id=s.tenant_id
           WHERE s.tenant_id=tenant_value.id AND c.provider='WAHA'
             AND s.ownership_state='ACTIVE' AND s.waha_worker_id IS NOT NULL
        )),
        ('WAHA_CAPACITY_UNIT_HOURS',(
          SELECT count(*)::numeric FROM public.provider_sessions s
           WHERE s.tenant_id=tenant_value.id AND s.ownership_state='ACTIVE'
             AND s.waha_worker_id IS NOT NULL
        ))
      ) observed(meter_key,quantity)
    LOOP
      -- Zero events add no billable quantity and are omitted to keep the event
      -- ledger compact. The durable checkpoint proves the period was captured.
      IF meter_value.quantity>0 THEN
        result_value:=app.ingest_usage_meter_event(
          tenant_value.id,'control-api','metering-reconciler',
          'control-api:'||to_char(period_value AT TIME ZONE 'UTC','YYYYMMDDHH24')||
            ':'||lower(meter_value.meter_key),
          meter_value.meter_key,meter_value.quantity,period_value,
          period_end_value,NULL
        );
        IF (result_value->>'duplicate')::boolean THEN
          duplicate_count:=duplicate_count+1;
        ELSE
          accepted_count:=accepted_count+1;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  UPDATE public.metering_capture_state
     SET next_period_start=period_end_value,last_completed_at=now(),updated_at=now()
   WHERE singleton;
  RETURN jsonb_build_object(
    'caught_up',period_end_value>=
      (date_trunc('hour',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
    'period_start',period_value,'period_end',period_end_value,
    'next_period_start',period_end_value,
    'accepted',accepted_count,'duplicates',duplicate_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION app.operator_list_tenant_operations(
  actor_subject text,
  audit_request_id text,
  state_filter text DEFAULT NULL,
  query_filter text DEFAULT NULL,
  result_limit integer DEFAULT 50,
  cursor_value text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE result_value jsonb;
BEGIN
  IF result_limit NOT BETWEEN 1 AND 100
     OR (state_filter IS NOT NULL AND state_filter NOT IN (
       'PROVISIONING','ACTIVE','SUSPENDED','DELETING','PENDING','RUNNING',
       'FAILED_RETRYABLE','FAILED','COMPLETE','SUSPEND_PENDING','SUSPENDING'
     ))
     OR (query_filter IS NOT NULL AND (
       length(query_filter) NOT BETWEEN 1 AND 160
       OR query_filter ~ '[[:cntrl:]]'
     ))
     OR (cursor_value IS NOT NULL AND cursor_value !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'invalid tenant operations filter' USING ERRCODE='22023';
  END IF;

  WITH selected AS (
    SELECT t.id,t.name,t.slug,t.state,t.created_at,t.updated_at,
           p.operation_id,p.action,p.status,p.current_step,p.completed_steps,
           p.attempts,p.max_attempts,p.error_code,p.error_detail,
           p.available_at,p.lease_expires_at,p.completed_at,
           z.state AS zammad_state,z.version AS zammad_version,
           count(*) OVER () AS result_count
      FROM public.tenants t
      LEFT JOIN public.provisioning_operations p ON p.tenant_id=t.id
      LEFT JOIN public.zammad_instances z ON z.tenant_id=t.id
     WHERE (state_filter IS NULL OR t.state=state_filter OR p.status=state_filter)
       AND (query_filter IS NULL OR lower(t.name) LIKE '%'||lower(query_filter)||'%'
         OR lower(t.slug) LIKE '%'||lower(query_filter)||'%')
       AND (cursor_value IS NULL OR t.id::text>cursor_value)
     ORDER BY t.id
     LIMIT result_limit+1
  ), visible AS (
    SELECT * FROM selected ORDER BY id LIMIT result_limit
  )
  SELECT jsonb_build_object(
    'items',COALESCE(jsonb_agg(jsonb_build_object(
      'tenant_id',id,'name',name,'slug',slug,'tenant_state',state,
      'operation_id',operation_id,'action',action,'status',status,
      'current_step',current_step,'completed_steps',completed_steps,
      'progress_percent',LEAST(100,jsonb_array_length(COALESCE(completed_steps,'[]'::jsonb))*10),
      'attempts',attempts,'max_attempts',max_attempts,'error_code',error_code,
      'safe_error',error_detail,'available_at',available_at,
      'lease_expires_at',lease_expires_at,'completed_at',completed_at,
      'zammad_state',zammad_state,'zammad_version',zammad_version,
      'created_at',created_at,'updated_at',updated_at
    ) ORDER BY id),'[]'::jsonb),
    'next_cursor',CASE WHEN (SELECT count(*) FROM selected)>result_limit
      THEN (SELECT id::text FROM visible ORDER BY id DESC LIMIT 1) ELSE NULL END,
    'limit',result_limit
  ) INTO result_value FROM visible;

  INSERT INTO public.platform_operations_audit_events
    (operator_subject,action,target_type,target_id,safe_metadata,request_id)
  VALUES (
    actor_subject,'platform.tenants_inspected','tenant_collection','all',
    jsonb_build_object('state_filter',state_filter,'has_query',query_filter IS NOT NULL,
      'limit',result_limit),audit_request_id
  );
  RETURN result_value;
END;
$$;

CREATE OR REPLACE FUNCTION app.operator_tenant_metering_summary(
  tenant_value uuid,
  from_value timestamptz,
  to_value timestamptz,
  actor_subject text,
  audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE tenant_name text;
DECLARE result_value jsonb;
BEGIN
  IF from_value>=to_value OR to_value>now()+interval '5 minutes'
     OR to_value>from_value+interval '366 days' THEN
    RAISE EXCEPTION 'invalid metering summary window' USING ERRCODE='22023';
  END IF;
  SELECT name INTO tenant_name FROM public.tenants WHERE id=tenant_value;
  IF tenant_name IS NULL THEN
    RAISE EXCEPTION 'tenant not found' USING ERRCODE='P0002';
  END IF;

  SELECT jsonb_build_object(
    'tenant',jsonb_build_object('id',tenant_value,'name',tenant_name),
    'from',from_value,'to',to_value,
    'usage',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'meter',meter_key,'quantity',quantity::text,
        'currency',currency,'estimated_cost_micros',estimated_cost_micros::text,
        'unpriced_quantity',unpriced_quantity::text,'event_count',event_count
      ) ORDER BY meter_key,currency)
      FROM (
        SELECT meter_key,COALESCE(currency,'UNPRICED') AS currency,
               sum(quantity) AS quantity,
               sum(COALESCE(estimated_cost_micros,0)) AS estimated_cost_micros,
               sum(CASE WHEN meter_rate_id IS NULL THEN quantity ELSE 0 END)
                 AS unpriced_quantity,
               count(*) AS event_count
          FROM public.usage_meter_events
         WHERE tenant_id=tenant_value AND period_start>=from_value
           AND period_start<to_value
         GROUP BY meter_key,COALESCE(currency,'UNPRICED')
      ) aggregate_usage
    ),'[]'::jsonb),
    'quotas',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',id,'meter',meter_key,'period',quota_period,
        'soft_limit',soft_limit::text,'hard_limit',hard_limit::text,
        'enforcement_mode',enforcement_mode,'version',version,
        'updated_at',updated_at
      ) ORDER BY meter_key,quota_period)
      FROM public.tenant_meter_quotas WHERE tenant_id=tenant_value
    ),'[]'::jsonb)
  ) INTO result_value;

  INSERT INTO public.platform_operations_audit_events
    (operator_subject,action,target_type,target_id,safe_metadata,request_id)
  VALUES (
    actor_subject,'platform.metering_inspected','tenant',tenant_value::text,
    jsonb_build_object('from',from_value,'to',to_value),audit_request_id
  );
  RETURN result_value;
END;
$$;

CREATE OR REPLACE FUNCTION app.operator_list_meter_rates(
  actor_subject text,
  audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE result_value jsonb;
BEGIN
  SELECT jsonb_build_object('rates',COALESCE(jsonb_agg(jsonb_build_object(
    'id',id,'meter',meter_key,'unit_price_micros',unit_price_micros,
    'currency',currency,'effective_from',effective_from,
    'created_at',created_at
  ) ORDER BY meter_key,effective_from DESC),'[]'::jsonb))
  INTO result_value FROM public.platform_meter_rates;
  INSERT INTO public.platform_operations_audit_events
    (operator_subject,action,target_type,target_id,safe_metadata,request_id)
  VALUES (actor_subject,'platform.meter_rates_inspected','meter_rates','all',
    '{}'::jsonb,audit_request_id);
  RETURN result_value;
END;
$$;

CREATE OR REPLACE FUNCTION app.operator_set_tenant_meter_quota(
  tenant_value uuid,
  meter_value text,
  period_value text,
  soft_value numeric,
  hard_value numeric,
  expected_version bigint,
  request_key text,
  request_hash text,
  actor_subject text,
  audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE request_id uuid;
DECLARE existing_request public.platform_metering_operator_requests%ROWTYPE;
DECLARE quota_value public.tenant_meter_quotas%ROWTYPE;
DECLARE response_value jsonb;
BEGIN
  IF meter_value NOT IN (
       'CONNECTED_NUMBER_HOURS','ACTIVE_GROUP_HOURS',
       'INBOUND_MESSAGES','OUTBOUND_MESSAGES','MEDIA_BYTES',
       'ZAMMAD_CPU_CORE_HOURS','ZAMMAD_MEMORY_GIB_HOURS',
       'ZAMMAD_STORAGE_GIB_HOURS','WAHA_SESSION_HOURS',
       'WAHA_CAPACITY_UNIT_HOURS'
     ) OR period_value NOT IN ('DAY','MONTH')
     OR soft_value<=0 OR (hard_value IS NOT NULL AND hard_value<soft_value)
     OR request_hash !~ '^[0-9a-f]{64}$'
     OR length(request_key) NOT BETWEEN 1 AND 255
     OR request_key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid tenant meter quota' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id=tenant_value) THEN
    RAISE EXCEPTION 'tenant not found' USING ERRCODE='P0002';
  END IF;

  INSERT INTO public.platform_metering_operator_requests
    (idempotency_key,request_sha256,action,tenant_id,operator_subject)
  VALUES (request_key,request_hash,'SET_QUOTA',tenant_value,actor_subject)
  ON CONFLICT (idempotency_key) DO NOTHING RETURNING id INTO request_id;
  IF request_id IS NULL THEN
    SELECT * INTO existing_request FROM public.platform_metering_operator_requests
     WHERE idempotency_key=request_key;
    IF existing_request.action<>'SET_QUOTA'
       OR existing_request.request_sha256<>request_hash
       OR existing_request.operator_subject<>actor_subject
       OR existing_request.tenant_id<>tenant_value THEN
      RAISE EXCEPTION 'idempotency key reused' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_set(existing_request.response,'{duplicate}','true'::jsonb,true);
  END IF;

  SELECT * INTO quota_value FROM public.tenant_meter_quotas
   WHERE tenant_id=tenant_value AND meter_key=meter_value
     AND quota_period=period_value FOR UPDATE;
  IF quota_value.id IS NULL THEN
    IF expected_version IS NOT NULL THEN
      RAISE EXCEPTION 'quota version conflict' USING ERRCODE='40001';
    END IF;
    INSERT INTO public.tenant_meter_quotas
      (tenant_id,meter_key,quota_period,soft_limit,hard_limit,created_by)
    VALUES (tenant_value,meter_value,period_value,soft_value,hard_value,actor_subject)
    RETURNING * INTO quota_value;
  ELSE
    IF expected_version IS NULL OR quota_value.version<>expected_version THEN
      RAISE EXCEPTION 'quota version conflict' USING ERRCODE='40001';
    END IF;
    UPDATE public.tenant_meter_quotas
       SET soft_limit=soft_value,hard_limit=hard_value,
           version=version+1,updated_at=now()
     WHERE id=quota_value.id RETURNING * INTO quota_value;
  END IF;

  response_value:=jsonb_build_object(
    'id',quota_value.id,'tenant_id',tenant_value,'meter',meter_value,
    'period',period_value,'soft_limit',quota_value.soft_limit::text,
    'hard_limit',quota_value.hard_limit::text,
    'enforcement_mode',quota_value.enforcement_mode,
    'version',quota_value.version,'duplicate',false
  );
  UPDATE public.platform_metering_operator_requests SET response=response_value
   WHERE id=request_id;
  INSERT INTO public.platform_operations_audit_events
    (operator_subject,action,target_type,target_id,safe_metadata,request_id)
  VALUES (actor_subject,'platform.quota_changed','tenant',tenant_value::text,
    jsonb_build_object('meter',meter_value,'period',period_value,
      'version',quota_value.version,'enforcement_mode','OBSERVE'),audit_request_id);
  INSERT INTO public.audit_events
    (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
  VALUES (tenant_value,'PLATFORM_OPERATOR',actor_subject,'metering.quota_changed',
    'tenant_meter_quota',quota_value.id::text,
    jsonb_build_object('meter',meter_value,'period',period_value,
      'soft_limit',soft_value::text,'hard_limit',hard_value::text,
      'enforcement_mode','OBSERVE','version',quota_value.version),audit_request_id);
  RETURN response_value;
END;
$$;

CREATE OR REPLACE FUNCTION app.operator_create_meter_rate(
  meter_value text,
  price_value bigint,
  currency_value text,
  effective_value date,
  request_key text,
  request_hash text,
  actor_subject text,
  audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE request_id uuid;
DECLARE existing_request public.platform_metering_operator_requests%ROWTYPE;
DECLARE rate_value public.platform_meter_rates%ROWTYPE;
DECLARE response_value jsonb;
BEGIN
  IF meter_value NOT IN (
       'CONNECTED_NUMBER_HOURS','ACTIVE_GROUP_HOURS',
       'INBOUND_MESSAGES','OUTBOUND_MESSAGES','MEDIA_BYTES',
       'ZAMMAD_CPU_CORE_HOURS','ZAMMAD_MEMORY_GIB_HOURS',
       'ZAMMAD_STORAGE_GIB_HOURS','WAHA_SESSION_HOURS',
       'WAHA_CAPACITY_UNIT_HOURS'
     ) OR price_value NOT BETWEEN 0 AND 1000000000000
     OR currency_value NOT IN ('SAR','USD')
     OR effective_value<current_date OR effective_value>current_date+366
     OR request_hash !~ '^[0-9a-f]{64}$'
     OR length(request_key) NOT BETWEEN 1 AND 255
     OR request_key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid meter rate' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.platform_metering_operator_requests
    (idempotency_key,request_sha256,action,operator_subject)
  VALUES (request_key,request_hash,'CREATE_RATE',actor_subject)
  ON CONFLICT (idempotency_key) DO NOTHING RETURNING id INTO request_id;
  IF request_id IS NULL THEN
    SELECT * INTO existing_request FROM public.platform_metering_operator_requests
     WHERE idempotency_key=request_key;
    IF existing_request.action<>'CREATE_RATE'
       OR existing_request.request_sha256<>request_hash
       OR existing_request.operator_subject<>actor_subject THEN
      RAISE EXCEPTION 'idempotency key reused' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_set(existing_request.response,'{duplicate}','true'::jsonb,true);
  END IF;

  INSERT INTO public.platform_meter_rates
    (meter_key,unit_price_micros,currency,effective_from,created_by)
  VALUES (meter_value,price_value,currency_value,effective_value,actor_subject)
  RETURNING * INTO rate_value;
  response_value:=jsonb_build_object(
    'id',rate_value.id,'meter',meter_value,'unit_price_micros',price_value,
    'currency',currency_value,'effective_from',effective_value,'duplicate',false
  );
  UPDATE public.platform_metering_operator_requests SET response=response_value
   WHERE id=request_id;
  INSERT INTO public.platform_operations_audit_events
    (operator_subject,action,target_type,target_id,safe_metadata,request_id)
  VALUES (actor_subject,'platform.meter_rate_created','meter_rate',rate_value.id::text,
    jsonb_build_object('meter',meter_value,'currency',currency_value,
      'effective_from',effective_value),audit_request_id);
  RETURN response_value;
END;
$$;

REVOKE ALL ON public.usage_meter_events,public.usage_daily_rollups,
  public.tenant_meter_quotas,public.platform_meter_rates,
  public.platform_metering_operator_requests,
  public.platform_operations_audit_events,public.metering_capture_state
  FROM PUBLIC,wasalx_app,wasalx_provisioner;

REVOKE ALL ON FUNCTION app.ingest_usage_meter_event(
  uuid,text,text,text,text,numeric,timestamptz,timestamptz,text
),app.capture_next_usage_metering_period()
  FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.operator_platform_operations_overview(text,text),
  app.operator_list_tenant_operations(text,text,text,text,integer,text),
  app.operator_tenant_metering_summary(uuid,timestamptz,timestamptz,text,text),
  app.operator_list_meter_rates(text,text),
  app.operator_set_tenant_meter_quota(
    uuid,text,text,numeric,numeric,bigint,text,text,text,text
  ),
  app.operator_create_meter_rate(text,bigint,text,date,text,text,text,text)
  FROM PUBLIC,wasalx_app,wasalx_provisioner;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_metering_ingest_client') THEN
    CREATE ROLE wasalx_metering_ingest_client NOLOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE wasalx_metering_ingest_client NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_platform_operations_client') THEN
    CREATE ROLE wasalx_platform_operations_client NOLOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE wasalx_platform_operations_client NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA app
  TO wasalx_metering_ingest_client,wasalx_platform_operations_client;
GRANT EXECUTE ON FUNCTION app.ingest_usage_meter_event(
  uuid,text,text,text,text,numeric,timestamptz,timestamptz,text
),app.capture_next_usage_metering_period()
  TO wasalx_metering_ingest_client;
GRANT EXECUTE ON FUNCTION app.operator_platform_operations_overview(text,text),
  app.operator_list_tenant_operations(text,text,text,text,integer,text),
  app.operator_tenant_metering_summary(uuid,timestamptz,timestamptz,text,text),
  app.operator_list_meter_rates(text,text),
  app.operator_set_tenant_meter_quota(
    uuid,text,text,numeric,numeric,bigint,text,text,text,text
  ),
  app.operator_create_meter_rate(text,bigint,text,date,text,text,text,text)
  TO wasalx_platform_operations_client;
