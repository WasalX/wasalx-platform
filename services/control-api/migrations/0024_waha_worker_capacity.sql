-- WAHA nodes are platform infrastructure, while provider sessions are tenant
-- data.  A session receives one durable node assignment and an independent
-- fencing token.  The short provider_sessions.worker_id lease continues to
-- fence an individual lifecycle operation; it is deliberately not the node
-- assignment.

CREATE TABLE public.waha_workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_key text NOT NULL UNIQUE
    CHECK (worker_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  engine text NOT NULL CHECK (engine IN ('GOWS','NOWEB')),
  base_url text NOT NULL
    CHECK (base_url ~ '^https?://[^/@[:space:]]+(?::[0-9]{1,5})?/?$'),
  secret_reference text NOT NULL
    CHECK (
      octet_length(secret_reference) BETWEEN 10 AND 512
      AND secret_reference ~ '^secret://[A-Za-z0-9][A-Za-z0-9._~:/-]*$'
    ),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 10000),
  lifecycle_state text NOT NULL DEFAULT 'ACTIVE'
    CHECK (lifecycle_state IN ('ACTIVE','DRAINING','DISABLED')),
  rollout_mode text NOT NULL DEFAULT 'STABLE'
    CHECK (rollout_mode IN ('STABLE','CANARY')),
  canary_session_limit integer,
  health_state text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (health_state IN ('UNKNOWN','HEALTHY','UNHEALTHY')),
  heartbeat_ttl_seconds integer NOT NULL DEFAULT 45
    CHECK (heartbeat_ttl_seconds BETWEEN 15 AND 300),
  last_heartbeat_at timestamptz,
  last_healthy_at timestamptz,
  last_started_at timestamptz,
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_.-]{1,100}$'
  ),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waha_workers_canary_limit_check CHECK (
    (rollout_mode = 'STABLE' AND canary_session_limit IS NULL)
    OR
    (rollout_mode = 'CANARY' AND canary_session_limit BETWEEN 1 AND capacity)
  )
);

CREATE INDEX waha_workers_assignment_idx
  ON public.waha_workers (engine, lifecycle_state, health_state, rollout_mode, worker_key);

CREATE TABLE public.waha_worker_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waha_worker_id uuid NOT NULL REFERENCES public.waha_workers(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action ~ '^[a-z0-9_.-]{1,100}$'),
  actor_type text NOT NULL CHECK (actor_type IN ('SYSTEM','PLATFORM_OPERATOR')),
  actor_id text NOT NULL CHECK (length(btrim(actor_id)) BETWEEN 1 AND 320),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 500),
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(safe_metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX waha_worker_events_worker_time_idx
  ON public.waha_worker_events (waha_worker_id, created_at DESC);

ALTER TABLE public.provider_sessions
  ADD COLUMN waha_worker_id uuid REFERENCES public.waha_workers(id),
  ADD COLUMN assignment_fencing_token bigint NOT NULL DEFAULT 0
    CHECK (assignment_fencing_token >= 0),
  ADD COLUMN assignment_lease_expires_at timestamptz,
  ADD COLUMN assigned_at timestamptz,
  ADD CONSTRAINT provider_sessions_waha_assignment_check CHECK (
    (waha_worker_id IS NULL AND assignment_fencing_token = 0
      AND assignment_lease_expires_at IS NULL AND assigned_at IS NULL)
    OR
    (waha_worker_id IS NOT NULL AND assignment_fencing_token > 0
      AND assignment_lease_expires_at IS NOT NULL AND assigned_at IS NOT NULL)
  );

CREATE INDEX provider_sessions_waha_worker_capacity_idx
  ON public.provider_sessions (waha_worker_id, ownership_state)
  WHERE waha_worker_id IS NOT NULL;

CREATE INDEX provider_sessions_waha_assignment_fence_idx
  ON public.provider_sessions
    (tenant_id, id, waha_worker_id, assignment_fencing_token, assignment_lease_expires_at)
  WHERE ownership_state = 'ACTIVE' AND waha_worker_id IS NOT NULL;

CREATE TYPE app.waha_session_assignment AS (
  provider_session_id uuid,
  waha_worker_id uuid,
  worker_key text,
  engine text,
  base_url text,
  secret_reference text,
  assignment_fencing_token bigint,
  assignment_lease_expires_at timestamptz
);

-- Tenant runtimes need the endpoint and secret reference of their own assigned
-- worker, but must never enumerate the global worker registry.  This composite
-- is returned only by a SECURITY DEFINER function that binds the lookup to the
-- transaction's tenant context and an active provider session.
CREATE TYPE app.waha_session_runtime AS (
  provider_session_id uuid,
  waha_worker_id uuid,
  worker_key text,
  engine text,
  base_url text,
  secret_reference text,
  lifecycle_state text,
  health_state text,
  heartbeat_ttl_seconds integer,
  last_heartbeat_at timestamptz,
  assignment_fencing_token bigint,
  assignment_lease_expires_at timestamptz
);

CREATE TYPE app.waha_worker_heartbeat_result AS (
  waha_worker_id uuid,
  worker_key text,
  engine text,
  health_state text,
  capacity integer,
  assigned_sessions bigint
);

CREATE TYPE app.waha_worker_summary AS (
  worker_key text,
  engine text,
  capacity integer,
  lifecycle_state text,
  rollout_mode text,
  canary_session_limit integer,
  health_state text,
  heartbeat_ttl_seconds integer,
  last_heartbeat_at timestamptz,
  last_healthy_at timestamptz,
  last_started_at timestamptz,
  last_error_code text,
  version bigint,
  assigned_sessions bigint
);

-- Registration is declarative: only nodes present in the connector worker's
-- validated configuration are heartbeated.  A failed probe is persisted as
-- UNHEALTHY; registration itself never implies health.
CREATE OR REPLACE FUNCTION app.report_waha_worker_heartbeat(
  configured_worker_key text,
  configured_engine text,
  configured_base_url text,
  configured_secret_reference text,
  configured_capacity integer,
  configured_rollout_mode text,
  configured_canary_session_limit integer,
  configured_heartbeat_ttl_seconds integer,
  probe_healthy boolean,
  probe_started_at timestamptz,
  probe_error_code text DEFAULT NULL
)
RETURNS SETOF app.waha_worker_heartbeat_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE worker public.waha_workers%ROWTYPE;
BEGIN
  IF configured_worker_key !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
     OR configured_engine NOT IN ('GOWS','NOWEB')
     OR configured_base_url !~ '^https?://[^/@[:space:]]+(?::[0-9]{1,5})?/?$'
     OR octet_length(configured_secret_reference) NOT BETWEEN 10 AND 512
     OR configured_secret_reference !~ '^secret://[A-Za-z0-9][A-Za-z0-9._~:/-]*$'
     OR configured_capacity NOT BETWEEN 1 AND 10000
     OR configured_rollout_mode NOT IN ('STABLE','CANARY')
     OR configured_heartbeat_ttl_seconds NOT BETWEEN 15 AND 300
     OR (configured_rollout_mode = 'STABLE' AND configured_canary_session_limit IS NOT NULL)
     OR (configured_rollout_mode = 'CANARY' AND configured_canary_session_limit NOT BETWEEN 1 AND configured_capacity)
     OR (probe_error_code IS NOT NULL AND probe_error_code !~ '^[A-Z0-9_.-]{1,100}$') THEN
    RAISE EXCEPTION 'invalid WAHA worker heartbeat';
  END IF;

  SELECT * INTO worker
    FROM public.waha_workers
   WHERE worker_key = configured_worker_key
   FOR UPDATE;
  IF FOUND AND (
    worker.engine <> configured_engine
    OR worker.base_url <> configured_base_url
    OR worker.secret_reference <> configured_secret_reference
  ) THEN
    -- A worker key is the durable identity of one WAHA node. Repointing it
    -- would move live sessions to another endpoint without incrementing their
    -- assignment fence. Replacements therefore register under a new key and
    -- the old node is drained through the platform API.
    RAISE EXCEPTION 'WAHA worker identity is immutable';
  END IF;

  INSERT INTO public.waha_workers (
    worker_key,engine,base_url,secret_reference,capacity,rollout_mode,
    canary_session_limit,health_state,heartbeat_ttl_seconds,last_heartbeat_at,
    last_healthy_at,last_started_at,last_error_code
  ) VALUES (
    configured_worker_key,configured_engine,configured_base_url,
    configured_secret_reference,configured_capacity,configured_rollout_mode,
    configured_canary_session_limit,
    CASE WHEN probe_healthy THEN 'HEALTHY' ELSE 'UNHEALTHY' END,
    configured_heartbeat_ttl_seconds,now(),
    CASE WHEN probe_healthy THEN now() ELSE NULL END,
    probe_started_at,CASE WHEN probe_healthy THEN NULL ELSE probe_error_code END
  )
  ON CONFLICT (worker_key) DO UPDATE SET
    capacity = GREATEST(
      EXCLUDED.capacity,
      COALESCE(public.waha_workers.canary_session_limit,0)
    ),
    -- Rollout and drain modes are operator-controlled after first
    -- registration. A heartbeat may refresh infrastructure facts but cannot
    -- silently undo an audited drain/canary decision.
    rollout_mode = public.waha_workers.rollout_mode,
    canary_session_limit = public.waha_workers.canary_session_limit,
    health_state = EXCLUDED.health_state,
    heartbeat_ttl_seconds = EXCLUDED.heartbeat_ttl_seconds,
    last_heartbeat_at = EXCLUDED.last_heartbeat_at,
    last_healthy_at = CASE
      WHEN EXCLUDED.health_state = 'HEALTHY' THEN now()
      ELSE public.waha_workers.last_healthy_at
    END,
    last_started_at = EXCLUDED.last_started_at,
    last_error_code = EXCLUDED.last_error_code,
    version = public.waha_workers.version + 1,
    updated_at = now()
  RETURNING * INTO worker;

  IF worker.health_state <> 'HEALTHY' THEN
    INSERT INTO public.waha_worker_events
      (waha_worker_id,action,actor_type,actor_id,reason,safe_metadata)
    VALUES (
      worker.id,'worker.health_failed','SYSTEM','waha-worker-monitor',
      'The WAHA health probe did not report a healthy node.',
      jsonb_build_object('error_code',COALESCE(worker.last_error_code,'WAHA_HEALTH_FAILED'))
    );
  END IF;
  RETURN QUERY SELECT worker.id,worker.worker_key,worker.engine,
    worker.health_state,worker.capacity,
    (SELECT count(*) FROM public.provider_sessions session
      WHERE session.waha_worker_id=worker.id
        AND session.ownership_state='ACTIVE');
END;
$$;

-- Acquire or renew a session-to-node assignment.  A healthy DRAINING node may
-- retain existing sessions, but is never selected for a new assignment.
-- Reassignment cannot happen before the previous assignment lease expires.
CREATE OR REPLACE FUNCTION app.acquire_waha_session_assignment(
  provider_session_id uuid,
  desired_engine text,
  lease_for interval DEFAULT interval '120 seconds'
)
RETURNS SETOF app.waha_session_assignment
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE session_row public.provider_sessions%ROWTYPE;
DECLARE current_worker public.waha_workers%ROWTYPE;
DECLARE selected_worker public.waha_workers%ROWTYPE;
DECLARE active_count integer;
BEGIN
  IF desired_engine NOT IN ('GOWS','NOWEB')
     OR lease_for < interval '30 seconds'
     OR lease_for > interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid WAHA session assignment request';
  END IF;

  SELECT * INTO session_row
    FROM public.provider_sessions
   WHERE tenant_id = app.current_tenant_id()
     AND id = provider_session_id
     AND ownership_state = 'ACTIVE'
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF session_row.waha_worker_id IS NOT NULL THEN
    SELECT * INTO current_worker
      FROM public.waha_workers
     WHERE id = session_row.waha_worker_id
     FOR UPDATE;

    IF current_worker.id IS NOT NULL
       AND current_worker.engine = desired_engine
       AND current_worker.lifecycle_state IN ('ACTIVE','DRAINING')
       AND current_worker.health_state = 'HEALTHY'
       AND current_worker.last_heartbeat_at >=
           now() - make_interval(secs => current_worker.heartbeat_ttl_seconds)
       AND session_row.assignment_lease_expires_at >= now() THEN
      UPDATE public.provider_sessions
         SET assignment_lease_expires_at = now() + lease_for,
             updated_at = now()
       WHERE id = session_row.id;
      RETURN QUERY SELECT session_row.id,current_worker.id,current_worker.worker_key,
        current_worker.engine,current_worker.base_url,current_worker.secret_reference,
        session_row.assignment_fencing_token,now() + lease_for;
      RETURN;
    END IF;

    -- A live assignment is an exclusive owner even when its node is unhealthy.
    IF session_row.assignment_lease_expires_at >= now() THEN RETURN; END IF;
  END IF;

  SELECT worker.* INTO selected_worker
    FROM public.waha_workers worker
   WHERE worker.engine = desired_engine
     AND worker.lifecycle_state = 'ACTIVE'
     AND worker.health_state = 'HEALTHY'
     AND worker.last_heartbeat_at >=
         now() - make_interval(secs => worker.heartbeat_ttl_seconds)
     AND (
       SELECT count(*)
         FROM public.provider_sessions assigned
        WHERE assigned.waha_worker_id = worker.id
          AND assigned.ownership_state = 'ACTIVE'
     ) < worker.capacity
     AND (
       worker.rollout_mode = 'STABLE'
       OR (
         worker.rollout_mode = 'CANARY'
         AND (
           SELECT count(*)
             FROM public.provider_sessions assigned
            WHERE assigned.waha_worker_id = worker.id
              AND assigned.ownership_state = 'ACTIVE'
         ) < worker.canary_session_limit
       )
     )
   ORDER BY
     CASE worker.rollout_mode WHEN 'CANARY' THEN 0 ELSE 1 END,
     (
       SELECT count(*)::numeric / worker.capacity
         FROM public.provider_sessions assigned
        WHERE assigned.waha_worker_id = worker.id
          AND assigned.ownership_state = 'ACTIVE'
     ),
     worker.worker_key
   FOR UPDATE OF worker SKIP LOCKED
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.provider_sessions
     SET waha_worker_id = selected_worker.id,
         assignment_fencing_token = assignment_fencing_token + 1,
         assignment_lease_expires_at = now() + lease_for,
         assigned_at = now(),
         updated_at = now()
   WHERE id = session_row.id
   RETURNING assignment_fencing_token INTO session_row.assignment_fencing_token;

  INSERT INTO public.waha_worker_events
    (waha_worker_id,action,actor_type,actor_id,reason,safe_metadata)
  VALUES (
    selected_worker.id,'session.assigned','SYSTEM','connection-worker',
    'A provider session acquired a fenced WAHA worker assignment.',
    jsonb_build_object('assignment_fence',session_row.assignment_fencing_token)
  );

  RETURN QUERY SELECT session_row.id,selected_worker.id,selected_worker.worker_key,
    selected_worker.engine,selected_worker.base_url,selected_worker.secret_reference,
    session_row.assignment_fencing_token,now() + lease_for;
END;
$$;

CREATE OR REPLACE FUNCTION app.current_waha_session_runtime(
  provider_session_id uuid
)
RETURNS SETOF app.waha_session_runtime
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
  SELECT session.id,worker.id,worker.worker_key,worker.engine,
         worker.base_url,worker.secret_reference,worker.lifecycle_state,
         worker.health_state,worker.heartbeat_ttl_seconds,
         worker.last_heartbeat_at,session.assignment_fencing_token,
         session.assignment_lease_expires_at
    FROM public.provider_sessions session
    JOIN public.waha_workers worker ON worker.id=session.waha_worker_id
   WHERE session.tenant_id=app.current_tenant_id()
     AND session.id=provider_session_id
     AND session.ownership_state='ACTIVE';
$$;

CREATE OR REPLACE FUNCTION app.renew_waha_session_assignment(
  provider_session_id uuid,
  expected_waha_worker_id uuid,
  expected_assignment_fencing_token bigint,
  lease_for interval DEFAULT interval '120 seconds'
)
RETURNS SETOF app.waha_session_assignment
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
  WITH renewed AS (
    UPDATE public.provider_sessions session
       SET assignment_lease_expires_at = now() + lease_for,
           updated_at = now()
      FROM public.waha_workers worker
     WHERE session.tenant_id = app.current_tenant_id()
       AND session.id = provider_session_id
       AND session.ownership_state = 'ACTIVE'
       AND session.waha_worker_id = expected_waha_worker_id
       AND session.assignment_fencing_token = expected_assignment_fencing_token
       AND session.assignment_lease_expires_at >= now()
       AND worker.id = session.waha_worker_id
       AND worker.lifecycle_state IN ('ACTIVE','DRAINING')
       AND worker.health_state = 'HEALTHY'
       AND worker.last_heartbeat_at >= now() - make_interval(secs => worker.heartbeat_ttl_seconds)
       AND lease_for >= interval '30 seconds'
       AND lease_for <= interval '5 minutes'
    RETURNING session.id,session.waha_worker_id,session.assignment_fencing_token,
              session.assignment_lease_expires_at
  )
  SELECT renewed.id,worker.id,worker.worker_key,worker.engine,worker.base_url,
         worker.secret_reference,renewed.assignment_fencing_token,
         renewed.assignment_lease_expires_at
    FROM renewed
    JOIN public.waha_workers worker ON worker.id = renewed.waha_worker_id;
$$;

-- Platform-only mutation function.  The guarded control-plane endpoint uses
-- optimistic versioning; tenant endpoints never call or expose it.
CREATE OR REPLACE FUNCTION app.set_waha_worker_mode(
  configured_worker_key text,
  expected_version bigint,
  requested_lifecycle_state text,
  requested_rollout_mode text,
  requested_canary_limit integer,
  operator_subject text,
  change_reason text
)
RETURNS SETOF app.waha_worker_summary
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE worker public.waha_workers%ROWTYPE;
BEGIN
  IF requested_lifecycle_state NOT IN ('ACTIVE','DRAINING','DISABLED')
     OR requested_rollout_mode NOT IN ('STABLE','CANARY')
     OR length(btrim(operator_subject)) NOT BETWEEN 1 AND 320
     OR length(btrim(change_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'invalid WAHA worker mode request';
  END IF;
  UPDATE public.waha_workers
     SET lifecycle_state = requested_lifecycle_state,
         rollout_mode = requested_rollout_mode,
         canary_session_limit = requested_canary_limit,
         version = version + 1,
         updated_at = now()
   WHERE worker_key = configured_worker_key
     AND version = expected_version
     AND (
       (requested_rollout_mode = 'STABLE' AND requested_canary_limit IS NULL)
       OR
       (requested_rollout_mode = 'CANARY'
        AND requested_canary_limit BETWEEN 1 AND capacity)
     )
  RETURNING * INTO worker;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO public.waha_worker_events
    (waha_worker_id,action,actor_type,actor_id,reason,safe_metadata)
  VALUES (
    worker.id,'worker.mode_changed','PLATFORM_OPERATOR',operator_subject,
    change_reason,
    jsonb_build_object(
      'lifecycle_state',worker.lifecycle_state,
      'rollout_mode',worker.rollout_mode,
      'canary_session_limit',worker.canary_session_limit,
      'version',worker.version
    )
  );
  RETURN QUERY SELECT worker.worker_key,worker.engine,worker.capacity,
    worker.lifecycle_state,worker.rollout_mode,worker.canary_session_limit,
    worker.health_state,worker.heartbeat_ttl_seconds,worker.last_heartbeat_at,
    worker.last_healthy_at,worker.last_started_at,worker.last_error_code,
    worker.version,
    (SELECT count(*) FROM public.provider_sessions session
      WHERE session.waha_worker_id=worker.id
        AND session.ownership_state='ACTIVE');
END;
$$;

CREATE OR REPLACE FUNCTION app.list_waha_workers()
RETURNS SETOF app.waha_worker_summary
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
  SELECT worker.worker_key,worker.engine,worker.capacity,
         worker.lifecycle_state,worker.rollout_mode,worker.canary_session_limit,
         worker.health_state,worker.heartbeat_ttl_seconds,
         worker.last_heartbeat_at,worker.last_healthy_at,worker.last_started_at,
         worker.last_error_code,worker.version,
         count(session.id) FILTER (WHERE session.ownership_state='ACTIVE')
    FROM public.waha_workers worker
    LEFT JOIN public.provider_sessions session ON session.waha_worker_id=worker.id
   GROUP BY worker.id
   ORDER BY worker.engine,worker.rollout_mode DESC,worker.worker_key;
$$;

REVOKE ALL ON public.waha_workers,public.waha_worker_events FROM PUBLIC,wasalx_app;
REVOKE ALL ON public.waha_worker_events FROM wasalx_app;
REVOKE ALL ON FUNCTION app.report_waha_worker_heartbeat(text,text,text,text,integer,text,integer,integer,boolean,timestamptz,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.acquire_waha_session_assignment(uuid,text,interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.renew_waha_session_assignment(uuid,uuid,bigint,interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.current_waha_session_runtime(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_waha_worker_mode(text,bigint,text,text,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_waha_workers() FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_waha_registry_client') THEN
    CREATE ROLE wasalx_waha_registry_client NOLOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE wasalx_waha_registry_client NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_waha_operator_client') THEN
    CREATE ROLE wasalx_waha_operator_client NOLOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE wasalx_waha_operator_client NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA app TO wasalx_waha_registry_client,wasalx_waha_operator_client;

GRANT EXECUTE ON FUNCTION app.acquire_waha_session_assignment(uuid,text,interval) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.renew_waha_session_assignment(uuid,uuid,bigint,interval) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.current_waha_session_runtime(uuid) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.report_waha_worker_heartbeat(text,text,text,text,integer,text,integer,integer,boolean,timestamptz,text) TO wasalx_waha_registry_client;
GRANT EXECUTE ON FUNCTION app.list_waha_workers(),
  app.set_waha_worker_mode(text,bigint,text,text,integer,text,text)
  TO wasalx_waha_operator_client;
