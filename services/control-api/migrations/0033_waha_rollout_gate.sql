-- A renderer cannot infer whether a WAHA worker omitted from the desired
-- registry still owns a linked-device session. The pre-sync gate stages the
-- complete immutable desired identity set. A trigger then keeps registration
-- and lifecycle changes inside that set after the gate transaction releases
-- its locks, closing the Helm/GitOps TOCTOU window.

CREATE TABLE app.waha_registry_rollout_guard (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  desired_workers jsonb NOT NULL CHECK (jsonb_typeof(desired_workers)='array'),
  staged_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION app.enforce_waha_registry_rollout_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE guard_present boolean := false;
DECLARE desired_identity jsonb;
BEGIN
  IF NEW.worker_key !~ '^managed-(gows|noweb)-[0-9]{1,2}$' THEN
    RETURN NEW;
  END IF;

  -- The gate and every managed-worker registration/lifecycle transition use
  -- the same transaction advisory lock. A new row cannot slip between the
  -- gate's safety check and durable desired-set staging.
  PERFORM pg_advisory_xact_lock(hashtextextended('wasalx.waha.registry.rollout',0));

  SELECT true,desired.worker
    INTO guard_present,desired_identity
    FROM app.waha_registry_rollout_guard guard
    LEFT JOIN LATERAL (
      SELECT candidate.worker
        FROM jsonb_array_elements(guard.desired_workers) candidate(worker)
       WHERE candidate.worker->>'workerKey'=NEW.worker_key
       LIMIT 1
    ) desired ON true
   WHERE guard.singleton=true;

  IF guard_present IS NOT TRUE THEN RETURN NEW; END IF;

  -- report_waha_worker_heartbeat uses INSERT ... ON CONFLICT UPDATE. Permit
  -- the INSERT phase for an already-registered, disabled omitted worker so an
  -- old connector can continue durable health reconciliation during rollout;
  -- its UPDATE phase still cannot reactivate it. A genuinely new omitted key
  -- remains blocked.
  IF TG_OP='INSERT' AND desired_identity IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.waha_workers existing
     WHERE existing.worker_key=NEW.worker_key
  ) THEN
    RAISE EXCEPTION 'managed WAHA worker is outside the staged registry';
  END IF;

  IF desired_identity IS NOT NULL AND (
    desired_identity->>'engine' IS DISTINCT FROM NEW.engine
    OR desired_identity->>'baseUrl' IS DISTINCT FROM NEW.base_url
    OR desired_identity->>'secretReference' IS DISTINCT FROM NEW.secret_reference
  ) THEN
    RAISE EXCEPTION 'managed WAHA worker identity differs from the staged registry';
  END IF;

  IF TG_OP='UPDATE' AND NEW.lifecycle_state <> OLD.lifecycle_state
     AND NEW.lifecycle_state <> 'DISABLED'
     AND desired_identity IS NULL THEN
    RAISE EXCEPTION 'managed WAHA worker cannot reactivate outside the staged registry';
  END IF;

  IF TG_OP='UPDATE' AND (
    NEW.worker_key <> OLD.worker_key
    OR NEW.engine <> OLD.engine
    OR NEW.base_url <> OLD.base_url
    OR NEW.secret_reference <> OLD.secret_reference
  ) THEN
    RAISE EXCEPTION 'managed WAHA worker identity is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER waha_workers_rollout_guard
BEFORE INSERT OR UPDATE ON public.waha_workers
FOR EACH ROW EXECUTE FUNCTION app.enforce_waha_registry_rollout_guard();

CREATE OR REPLACE FUNCTION app.assert_waha_worker_registry_transition(
  desired_managed_workers jsonb
)
RETURNS TABLE(checked_workers integer, omitted_workers integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE unsafe_worker record;
DECLARE identity_mismatch record;
DECLARE checked_count integer;
DECLARE omitted_count integer;
BEGIN
  IF desired_managed_workers IS NULL
     OR jsonb_typeof(desired_managed_workers) <> 'array'
     OR jsonb_array_length(desired_managed_workers) > 100
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(desired_managed_workers) desired(worker)
        WHERE jsonb_typeof(desired.worker) <> 'object'
           OR NOT (desired.worker ?& ARRAY['workerKey','engine','baseUrl','secretReference'])
           OR jsonb_typeof(desired.worker->'workerKey') <> 'string'
           OR jsonb_typeof(desired.worker->'engine') <> 'string'
           OR jsonb_typeof(desired.worker->'baseUrl') <> 'string'
           OR jsonb_typeof(desired.worker->'secretReference') <> 'string'
           OR EXISTS (
             SELECT 1 FROM jsonb_object_keys(desired.worker) field(key)
              WHERE field.key <> ALL(ARRAY['workerKey','engine','baseUrl','secretReference'])
           )
           OR desired.worker->>'workerKey' !~ '^managed-(gows|noweb)-[0-9]{1,2}$'
           OR desired.worker->>'engine' NOT IN ('GOWS','NOWEB')
           OR desired.worker->>'baseUrl' !~ '^http://[^/@[:space:]]+\.svc\.(cluster\.local|[a-z0-9.-]+\.(internal|local))(?::[0-9]{1,5})?/$'
           OR octet_length(desired.worker->>'secretReference') NOT BETWEEN 10 AND 512
           OR desired.worker->>'secretReference' !~ '^secret://[A-Za-z0-9][A-Za-z0-9._~:/-]*$'
     )
     OR jsonb_array_length(desired_managed_workers) <> (
       SELECT count(DISTINCT desired.worker->>'workerKey')
         FROM jsonb_array_elements(desired_managed_workers) desired(worker)
     ) THEN
    RAISE EXCEPTION 'invalid managed WAHA rollout gate request';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('wasalx.waha.registry.rollout',0));

  -- Mode changes and assignment acquire/renew paths lock the same worker rows.
  -- FOR UPDATE also serializes the trigger-enforced desired-set transition.
  PERFORM 1
    FROM public.waha_workers worker
   WHERE worker.worker_key ~ '^managed-(gows|noweb)-[0-9]{1,2}$'
   ORDER BY worker.worker_key
   FOR UPDATE;

  SELECT worker.worker_key
    INTO identity_mismatch
    FROM public.waha_workers worker
    JOIN jsonb_array_elements(desired_managed_workers) desired(worker)
      ON desired.worker->>'workerKey'=worker.worker_key
   WHERE worker.engine IS DISTINCT FROM desired.worker->>'engine'
      OR worker.base_url IS DISTINCT FROM desired.worker->>'baseUrl'
      OR worker.secret_reference IS DISTINCT FROM desired.worker->>'secretReference'
   ORDER BY worker.worker_key
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'managed WAHA worker % has an immutable identity mismatch',
      identity_mismatch.worker_key;
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(desired_managed_workers) desired(worker)
              WHERE desired.worker->>'workerKey'=worker.worker_key
           )
         )::integer
    INTO checked_count,omitted_count
    FROM public.waha_workers worker
   WHERE worker.worker_key ~ '^managed-(gows|noweb)-[0-9]{1,2}$';

  SELECT worker.worker_key,
         worker.lifecycle_state,
         count(session.id) FILTER (
           WHERE session.ownership_state='ACTIVE'
              OR session.assignment_lease_expires_at >= now()
         )::integer AS protected_assignments
    INTO unsafe_worker
    FROM public.waha_workers worker
    LEFT JOIN public.provider_sessions session
      ON session.waha_worker_id=worker.id
   WHERE worker.worker_key ~ '^managed-(gows|noweb)-[0-9]{1,2}$'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(desired_managed_workers) desired(worker)
        WHERE desired.worker->>'workerKey'=worker.worker_key
     )
   GROUP BY worker.id
  HAVING worker.lifecycle_state <> 'DISABLED'
      OR count(session.id) FILTER (
           WHERE session.ownership_state='ACTIVE'
              OR session.assignment_lease_expires_at >= now()
         ) > 0
   ORDER BY worker.worker_key
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'managed WAHA worker % cannot leave the registry: state %, protected assignments %',
      unsafe_worker.worker_key,
      unsafe_worker.lifecycle_state,
      unsafe_worker.protected_assignments;
  END IF;

  INSERT INTO app.waha_registry_rollout_guard(singleton,desired_workers,staged_at)
  VALUES (true,desired_managed_workers,now())
  ON CONFLICT (singleton) DO UPDATE SET
    desired_workers=EXCLUDED.desired_workers,
    staged_at=EXCLUDED.staged_at;

  RETURN QUERY SELECT checked_count,omitted_count;
END;
$$;

REVOKE ALL ON app.waha_registry_rollout_guard
  FROM PUBLIC,wasalx_app,wasalx_waha_registry_client,wasalx_waha_operator_client;
REVOKE ALL ON FUNCTION app.enforce_waha_registry_rollout_guard()
  FROM PUBLIC,wasalx_app,wasalx_waha_registry_client,wasalx_waha_operator_client;
REVOKE ALL ON FUNCTION app.assert_waha_worker_registry_transition(jsonb)
  FROM PUBLIC,wasalx_app,wasalx_waha_registry_client,wasalx_waha_operator_client;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname='wasalx_waha_rollout_gate_client'
  ) THEN
    CREATE ROLE wasalx_waha_rollout_gate_client NOLOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE wasalx_waha_rollout_gate_client NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA app TO wasalx_waha_rollout_gate_client;
GRANT EXECUTE ON FUNCTION app.assert_waha_worker_registry_transition(jsonb)
  TO wasalx_waha_rollout_gate_client;

REVOKE ALL ON app.waha_registry_rollout_guard,
  public.waha_workers,public.waha_worker_events,public.provider_sessions
  FROM wasalx_waha_rollout_gate_client;
