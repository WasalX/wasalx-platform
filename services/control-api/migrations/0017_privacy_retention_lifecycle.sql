-- Privacy work is intentionally separate from ordinary message delivery.  It
-- uses a separately provisioned Zammad credential whose only elevated grants
-- are the documented ticket-deletion and data-privacy permissions.
ALTER TABLE zammad_instances
  ADD COLUMN privacy_secret_reference text;

UPDATE zammad_instances
   SET privacy_secret_reference = 'secret://tenants/' || tenant_id::text || '/zammad/privacy'
 WHERE privacy_secret_reference IS NULL;

ALTER TABLE zammad_instances
  ALTER COLUMN privacy_secret_reference SET NOT NULL,
  ADD CONSTRAINT zammad_instances_privacy_secret_reference_check CHECK (
    privacy_secret_reference ~ '^secret://tenants/[0-9a-f-]{36}/zammad/privacy$'
    OR (
      length(privacy_secret_reference) BETWEEN 10 AND 2000
      AND privacy_secret_reference LIKE 'secret://%'
      AND privacy_secret_reference !~ '[[:cntrl:]]'
    )
  );

CREATE TABLE retention_policies (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','PAUSED')),
  resolved_case_days integer NOT NULL CHECK (resolved_case_days BETWEEN 1 AND 3650),
  include_open_cases boolean NOT NULL DEFAULT false,
  media_days integer NOT NULL CHECK (media_days BETWEEN 1 AND 3650),
  unmatched_diagnostic_hours integer NOT NULL DEFAULT 24 CHECK (
    unmatched_diagnostic_hours BETWEEN 1 AND 24
  ),
  export_ttl_hours integer NOT NULL DEFAULT 24 CHECK (export_ttl_hours BETWEEN 1 AND 168),
  next_sweep_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO retention_policies (
  tenant_id,resolved_case_days,media_days,unmatched_diagnostic_hours,export_ttl_hours
)
SELECT id,retention_days,retention_days,24,24 FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

CREATE OR REPLACE FUNCTION app.initialize_tenant_retention_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO retention_policies (
    tenant_id,resolved_case_days,media_days,unmatched_diagnostic_hours,export_ttl_hours
  ) VALUES (NEW.id,NEW.retention_days,NEW.retention_days,24,24)
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_retention_policy_initialize
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION app.initialize_tenant_retention_policy();

CREATE TABLE privacy_legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (
    scope_type IN ('TENANT','ZAMMAD_TICKET','REFERENCE','PARTICIPANT','GROUP_BINDING','ZAMMAD_USER')
  ),
  scope_value text NOT NULL CHECK (
    length(scope_value) BETWEEN 1 AND 512 AND scope_value !~ '[[:cntrl:]]'
  ),
  scope_sha256 text NOT NULL CHECK (scope_sha256 ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (
    length(reason) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'
  ),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','RELEASED','EXPIRED')),
  expires_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  released_by uuid REFERENCES users(id),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (state='ACTIVE' AND released_by IS NULL AND released_at IS NULL)
    OR (state='RELEASED' AND released_by IS NOT NULL AND released_at IS NOT NULL)
    OR (state='EXPIRED' AND expires_at IS NOT NULL AND released_by IS NULL AND released_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX privacy_legal_holds_active_scope_idx
  ON privacy_legal_holds (tenant_id,scope_type,scope_sha256)
  WHERE state='ACTIVE';

CREATE TABLE privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_type text NOT NULL CHECK (request_type IN ('EXPORT','DELETE')),
  scope_type text NOT NULL CHECK (
    scope_type IN ('TENANT','ZAMMAD_TICKET','REFERENCE','PARTICIPANT','ZAMMAD_USER')
  ),
  scope_value text NOT NULL CHECK (
    length(scope_value) BETWEEN 1 AND 512 AND scope_value !~ '[[:cntrl:]]'
  ),
  scope_sha256 text NOT NULL CHECK (scope_sha256 ~ '^[0-9a-f]{64}$'),
  disposition text NOT NULL CHECK (
    disposition IN ('EXPORT_ONLY','DELETE_TICKETS','ZAMMAD_USER_DATA_PRIVACY')
  ),
  idempotency_key text NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 255 AND idempotency_key !~ '[[:cntrl:]]'
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (
    state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED_RETRYABLE','FAILED_TERMINAL','BLOCKED_LEGAL_HOLD')
  ),
  requested_by uuid NOT NULL REFERENCES users(id),
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 100),
  safe_error text CHECK (safe_error IS NULL OR length(safe_error) BETWEEN 1 AND 500),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,idempotency_key),
  CHECK (
    (request_type='EXPORT' AND disposition='EXPORT_ONLY' AND scope_type<>'ZAMMAD_USER')
    OR (request_type='DELETE' AND disposition='DELETE_TICKETS' AND scope_type<>'ZAMMAD_USER')
    OR (request_type='DELETE' AND disposition='ZAMMAD_USER_DATA_PRIVACY' AND scope_type='ZAMMAD_USER')
  ),
  CHECK (
    (state='SUCCEEDED' AND completed_at IS NOT NULL AND error_code IS NULL AND safe_error IS NULL)
    OR (state IN ('FAILED_TERMINAL','BLOCKED_LEGAL_HOLD') AND completed_at IS NOT NULL AND error_code IS NOT NULL AND safe_error IS NOT NULL)
    OR (state IN ('QUEUED','RUNNING','FAILED_RETRYABLE') AND completed_at IS NULL)
  )
);

CREATE TABLE privacy_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id uuid REFERENCES privacy_requests(id) ON DELETE CASCADE,
  job_type text NOT NULL CHECK (job_type IN ('RETENTION_SWEEP','EXPORT','DELETE')),
  scope_type text NOT NULL CHECK (
    scope_type IN ('TENANT','ZAMMAD_TICKET','REFERENCE','PARTICIPANT','ZAMMAD_USER')
  ),
  scope_value text NOT NULL CHECK (
    length(scope_value) BETWEEN 1 AND 512 AND scope_value !~ '[[:cntrl:]]'
  ),
  disposition text NOT NULL CHECK (
    disposition IN ('RETENTION_DELETE','EXPORT_ONLY','DELETE_TICKETS','ZAMMAD_USER_DATA_PRIVACY')
  ),
  idempotency_key text NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 255 AND idempotency_key !~ '[[:cntrl:]]'
  ),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (
    state IN ('QUEUED','RUNNING','FAILED_RETRYABLE','SUCCEEDED','FAILED_TERMINAL','BLOCKED_LEGAL_HOLD')
  ),
  stage text NOT NULL DEFAULT 'DISCOVER' CHECK (
    stage IN ('DISCOVER','EXTERNAL','EXPORT','LOCAL','DONE')
  ),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 25 CHECK (max_attempts BETWEEN 1 AND 100),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 100),
  safe_error text CHECK (safe_error IS NULL OR length(safe_error) BETWEEN 1 AND 500),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary)='object'),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,idempotency_key),
  CHECK (
    (state='RUNNING' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state<>'RUNNING' AND lease_id IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (state IN ('SUCCEEDED','FAILED_TERMINAL','BLOCKED_LEGAL_HOLD') AND completed_at IS NOT NULL)
    OR (state IN ('QUEUED','RUNNING','FAILED_RETRYABLE') AND completed_at IS NULL)
  )
);

CREATE TABLE privacy_job_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES privacy_jobs(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (
    target_type IN ('ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','NORMALIZED_MESSAGE')
  ),
  target_id text NOT NULL CHECK (
    length(target_id) BETWEEN 1 AND 512 AND target_id !~ '[[:cntrl:]]'
  ),
  target_sha256 text NOT NULL CHECK (target_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'PENDING' CHECK (
    state IN ('PENDING','EXTERNAL_COMPLETE','COMPLETE','SKIPPED')
  ),
  external_operation_id text CHECK (
    external_operation_id IS NULL OR (
      length(external_operation_id) BETWEEN 1 AND 512 AND external_operation_id !~ '[[:cntrl:]]'
    )
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 100),
  safe_error text CHECK (safe_error IS NULL OR length(safe_error) BETWEEN 1 AND 500),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,job_id,target_type,target_sha256)
);

CREATE TABLE privacy_export_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES privacy_requests(id) ON DELETE CASCADE,
  object_key text NOT NULL CHECK (
    object_key ~ '^tenants/[0-9a-f-]{36}/privacy-exports/[0-9a-f-]{36}\.json$'
  ),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 2 AND 52428800),
  expires_at timestamptz NOT NULL,
  downloaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,request_id),
  UNIQUE (object_key)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'retention_policies','privacy_legal_holds','privacy_requests','privacy_jobs',
    'privacy_job_targets','privacy_export_artifacts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id())',
      table_name
    );
  END LOOP;
END
$$;

CREATE INDEX privacy_legal_holds_lookup_idx
  ON privacy_legal_holds (tenant_id,scope_type,scope_sha256)
  WHERE state='ACTIVE';
CREATE INDEX privacy_requests_time_idx
  ON privacy_requests (tenant_id,created_at DESC);
CREATE INDEX privacy_jobs_claim_idx
  ON privacy_jobs (tenant_id,available_at,created_at)
  WHERE state IN ('QUEUED','FAILED_RETRYABLE','RUNNING');
CREATE INDEX privacy_targets_pending_idx
  ON privacy_job_targets (tenant_id,job_id,state,target_type);
CREATE INDEX privacy_export_expiry_idx
  ON privacy_export_artifacts (tenant_id,expires_at);

-- A deletion is blocked not only by an exact hold, but also by any hold on
-- data contained by the requested scope.  Keeping this check in PostgreSQL
-- prevents the control API and privacy worker from drifting apart.
CREATE OR REPLACE FUNCTION app.has_applicable_privacy_hold(
  requested_scope_type text,
  requested_scope_value text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF requested_scope_type NOT IN ('TENANT','ZAMMAD_TICKET','REFERENCE','PARTICIPANT','ZAMMAD_USER')
     OR requested_scope_value IS NULL OR length(requested_scope_value) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'invalid privacy hold scope' USING ERRCODE='22023';
  END IF;

  RETURN EXISTS (
    WITH impacted_tickets AS (
      SELECT DISTINCT correlation.zammad_ticket_id
        FROM case_correlations AS correlation
       WHERE correlation.tenant_id=app.current_tenant_id()
         AND (
           requested_scope_type='TENANT'
           OR (requested_scope_type='ZAMMAD_TICKET' AND correlation.zammad_ticket_id=requested_scope_value)
           OR (requested_scope_type='REFERENCE' AND correlation.normalized_reference=requested_scope_value)
           OR (
             requested_scope_type='PARTICIPANT'
             AND EXISTS (
               SELECT 1
                 FROM message_links AS link
                 JOIN normalized_messages AS message
                   ON message.tenant_id=link.tenant_id
                  AND message.connection_id=link.connection_id
                  AND message.external_message_id=link.external_message_id
                WHERE link.tenant_id=correlation.tenant_id
                  AND link.zammad_ticket_id=correlation.zammad_ticket_id
                  AND message.external_participant_id=requested_scope_value
             )
           )
         )
      UNION
      SELECT requested_scope_value
       WHERE requested_scope_type='ZAMMAD_TICKET'
    )
    SELECT 1
      FROM privacy_legal_holds AS hold
     WHERE hold.tenant_id=app.current_tenant_id()
       AND hold.state='ACTIVE'
       AND (hold.expires_at IS NULL OR hold.expires_at>now())
       AND (
         requested_scope_type='TENANT'
         OR hold.scope_type='TENANT'
         OR (hold.scope_type=requested_scope_type AND hold.scope_value=requested_scope_value)
         OR (
           requested_scope_type<>'ZAMMAD_USER'
           AND (
             (hold.scope_type='ZAMMAD_TICKET' AND hold.scope_value IN (SELECT zammad_ticket_id FROM impacted_tickets))
             OR (
               hold.scope_type='REFERENCE'
               AND EXISTS (
                 SELECT 1 FROM case_correlations AS correlation
                  WHERE correlation.tenant_id=hold.tenant_id
                    AND correlation.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                    AND correlation.normalized_reference=hold.scope_value
               )
             )
             OR (
               hold.scope_type='GROUP_BINDING'
               AND EXISTS (
                 SELECT 1 FROM case_correlations AS correlation
                  WHERE correlation.tenant_id=hold.tenant_id
                    AND correlation.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                    AND correlation.group_binding_id::text=hold.scope_value
               )
             )
             OR (
               hold.scope_type='PARTICIPANT'
               AND EXISTS (
                 SELECT 1
                   FROM message_links AS link
                   JOIN normalized_messages AS message
                     ON message.tenant_id=link.tenant_id
                    AND message.connection_id=link.connection_id
                    AND message.external_message_id=link.external_message_id
                  WHERE link.tenant_id=hold.tenant_id
                    AND link.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                    AND message.external_participant_id=hold.scope_value
               )
             )
           )
         )
       )
  );
END;
$$;

-- The diagnostic window is capped at 24 hours.  Rows with a normalized
-- message are never treated as unmatched diagnostics.
CREATE OR REPLACE FUNCTION app.purge_expired_unmatched_events(
  retain_for interval DEFAULT interval '24 hours'
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE affected bigint;
BEGIN
  IF retain_for < interval '1 hour' OR retain_for > interval '24 hours' THEN
    RAISE EXCEPTION 'unmatched diagnostic retention must be between 1 and 24 hours'
      USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM privacy_legal_holds
     WHERE tenant_id=app.current_tenant_id()
       AND state='ACTIVE'
       AND (expires_at IS NULL OR expires_at>now())
       AND scope_type='TENANT'
  ) THEN
    RETURN 0;
  END IF;
  DELETE FROM event_inbox AS inbox
   WHERE inbox.tenant_id=app.current_tenant_id()
     AND inbox.status IN ('UNMATCHED','IGNORED','DUPLICATE','REDACTED')
     AND COALESCE(inbox.processed_at,inbox.received_at) < now()-retain_for
     AND NOT EXISTS (
       SELECT 1 FROM normalized_messages AS message
        WHERE message.tenant_id=inbox.tenant_id
          AND message.event_inbox_id=inbox.id
     );
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END;
$$;

CREATE OR REPLACE FUNCTION app.redact_expired_unmatched_events(
  retain_for interval DEFAULT interval '24 hours'
)
RETURNS bigint
LANGUAGE sql
AS $$ SELECT app.purge_expired_unmatched_events(retain_for) $$;

CREATE OR REPLACE FUNCTION app.claim_privacy_jobs(
  worker_lease uuid,
  claim_limit integer DEFAULT 10
)
RETURNS SETOF privacy_jobs
LANGUAGE plpgsql
AS $$
BEGIN
  IF worker_lease IS NULL OR claim_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'invalid privacy claim' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT job.id
      FROM privacy_jobs AS job
     WHERE job.tenant_id=app.current_tenant_id()
       AND (
         (job.state IN ('QUEUED','FAILED_RETRYABLE') AND job.available_at<=now())
         OR (job.state='RUNNING' AND job.lease_expires_at<now())
       )
       AND job.attempts<job.max_attempts
     ORDER BY job.available_at,job.created_at,job.id
     FOR UPDATE SKIP LOCKED
     LIMIT claim_limit
  )
  UPDATE privacy_jobs AS job
     SET state='RUNNING',
         attempts=job.attempts+1,
         lease_id=worker_lease,
         lease_expires_at=now()+interval '15 minutes',
         fencing_token=job.fencing_token+1,
         error_code=NULL,
         safe_error=NULL,
         updated_at=now()
    FROM candidates
   WHERE job.id=candidates.id
  RETURNING job.*;
END;
$$;

CREATE OR REPLACE FUNCTION app.complete_privacy_job(
  job_value uuid,
  worker_lease uuid,
  expected_fencing_token bigint,
  summary_value jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE request_value uuid; affected integer;
BEGIN
  IF jsonb_typeof(summary_value)<>'object' OR octet_length(summary_value::text)>32768 THEN
    RAISE EXCEPTION 'invalid privacy summary' USING ERRCODE='22023';
  END IF;
  UPDATE privacy_jobs
     SET state='SUCCEEDED',stage='DONE',summary=summary_value,
         lease_id=NULL,lease_expires_at=NULL,error_code=NULL,safe_error=NULL,
         completed_at=now(),updated_at=now()
   WHERE tenant_id=app.current_tenant_id() AND id=job_value
     AND state='RUNNING' AND lease_id=worker_lease
     AND fencing_token=expected_fencing_token AND lease_expires_at>=now()
  RETURNING request_id INTO request_value;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=1 AND request_value IS NOT NULL THEN
    UPDATE privacy_requests
       SET state='SUCCEEDED',error_code=NULL,safe_error=NULL,
           completed_at=now(),updated_at=now()
     WHERE tenant_id=app.current_tenant_id() AND id=request_value;
  END IF;
  RETURN affected=1;
END;
$$;

CREATE OR REPLACE FUNCTION app.defer_privacy_job(
  job_value uuid,
  worker_lease uuid,
  expected_fencing_token bigint,
  next_attempt_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE affected integer;
BEGIN
  UPDATE privacy_jobs
     SET state='QUEUED',available_at=GREATEST(next_attempt_at,now()+interval '5 seconds'),
         lease_id=NULL,lease_expires_at=NULL,updated_at=now()
   WHERE tenant_id=app.current_tenant_id() AND id=job_value
     AND state='RUNNING' AND lease_id=worker_lease
     AND fencing_token=expected_fencing_token AND lease_expires_at>=now();
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END;
$$;

CREATE OR REPLACE FUNCTION app.fail_privacy_job(
  job_value uuid,
  worker_lease uuid,
  expected_fencing_token bigint,
  retryable boolean,
  failure_code text,
  failure_detail text,
  retry_at timestamptz DEFAULT NULL,
  legal_hold boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE request_value uuid; resulting_state text; affected integer;
BEGIN
  IF failure_code IS NULL OR length(failure_code) NOT BETWEEN 1 AND 100
     OR failure_detail IS NULL OR length(failure_detail) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid privacy failure' USING ERRCODE='22023';
  END IF;
  SELECT CASE
           WHEN legal_hold THEN 'BLOCKED_LEGAL_HOLD'
           WHEN retryable AND attempts<max_attempts THEN 'FAILED_RETRYABLE'
           ELSE 'FAILED_TERMINAL'
         END
    INTO resulting_state
    FROM privacy_jobs
   WHERE tenant_id=app.current_tenant_id() AND id=job_value
     AND state='RUNNING' AND lease_id=worker_lease
     AND fencing_token=expected_fencing_token AND lease_expires_at>=now();
  IF resulting_state IS NULL THEN RETURN false; END IF;
  UPDATE privacy_jobs
     SET state=resulting_state,
         available_at=CASE WHEN resulting_state='FAILED_RETRYABLE'
           THEN COALESCE(retry_at,now()+interval '30 seconds') ELSE available_at END,
         lease_id=NULL,lease_expires_at=NULL,error_code=failure_code,safe_error=failure_detail,
         completed_at=CASE WHEN resulting_state IN ('FAILED_TERMINAL','BLOCKED_LEGAL_HOLD') THEN now() ELSE NULL END,
         updated_at=now()
   WHERE tenant_id=app.current_tenant_id() AND id=job_value
     AND state='RUNNING' AND lease_id=worker_lease
     AND fencing_token=expected_fencing_token
  RETURNING request_id INTO request_value;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=1 AND request_value IS NOT NULL THEN
    UPDATE privacy_requests
       SET state=resulting_state,error_code=failure_code,safe_error=failure_detail,
           completed_at=CASE WHEN resulting_state IN ('FAILED_TERMINAL','BLOCKED_LEGAL_HOLD') THEN now() ELSE NULL END,
           updated_at=now()
     WHERE tenant_id=app.current_tenant_id() AND id=request_value;
  END IF;
  RETURN affected=1;
END;
$$;

REVOKE ALL ON FUNCTION app.purge_expired_unmatched_events(interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.redact_expired_unmatched_events(interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.has_applicable_privacy_hold(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_privacy_jobs(uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_privacy_job(uuid,uuid,bigint,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.defer_privacy_job(uuid,uuid,bigint,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fail_privacy_job(uuid,uuid,bigint,boolean,text,text,timestamptz,boolean) FROM PUBLIC;

GRANT SELECT,INSERT,UPDATE ON retention_policies,privacy_legal_holds,privacy_requests,privacy_jobs TO wasalx_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON privacy_job_targets,privacy_export_artifacts TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.purge_expired_unmatched_events(interval) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.redact_expired_unmatched_events(interval) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.has_applicable_privacy_hold(text,text) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.claim_privacy_jobs(uuid,integer) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.complete_privacy_job(uuid,uuid,bigint,jsonb) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.defer_privacy_job(uuid,uuid,bigint,timestamptz) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.fail_privacy_job(uuid,uuid,bigint,boolean,text,text,timestamptz,boolean) TO wasalx_app;

-- Extend narrow durable discovery without granting the scheduler any message,
-- request-body, scope-value, object-key, or export-artifact reads.
GRANT SELECT (tenant_id,state,next_sweep_at) ON retention_policies TO wasalx_scheduler_reader;
GRANT SELECT (tenant_id,state,available_at,lease_expires_at) ON privacy_jobs TO wasalx_scheduler_reader;

CREATE OR REPLACE FUNCTION app.list_due_worker_tenants(scan_limit integer DEFAULT 200)
RETURNS TABLE (tenant_id uuid, work_type text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
BEGIN
  IF scan_limit < 1 OR scan_limit > 1000 THEN
    RAISE EXCEPTION 'scan limit must be between 1 and 1000' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT candidate.tenant_id,candidate.work_type
    FROM (
      SELECT inbox.tenant_id,'inbound'::text AS work_type,min(inbox.available_at) AS available_at
        FROM public.event_inbox AS inbox
        JOIN public.tenants AS tenant ON tenant.id=inbox.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE')
         AND ((inbox.status IN ('ACCEPTED','FAILED_RETRYABLE') AND inbox.available_at<=now())
           OR (inbox.status='PROCESSING' AND inbox.lease_expires_at<now()))
       GROUP BY inbox.tenant_id
      UNION ALL
      SELECT pending.tenant_id,'delivery'::text,min(pending.available_at)
        FROM (
          SELECT delivery.tenant_id,delivery.available_at
            FROM public.delivery_outbox AS delivery
            JOIN public.tenants AS tenant ON tenant.id=delivery.tenant_id
           WHERE tenant.state IN ('PROVISIONING','ACTIVE')
             AND (
               (delivery.state='SENDING' AND delivery.lease_expires_at<now())
               OR (
                 (
                   (delivery.state IN ('QUEUED','FAILED_RETRYABLE') AND delivery.available_at<=now())
                   OR (delivery.state='CLAIMED' AND delivery.lease_expires_at<now())
                 )
                 AND EXISTS (
                   SELECT 1 FROM public.connections AS connection
                    WHERE connection.id=delivery.connection_id
                      AND connection.tenant_id=delivery.tenant_id
                      AND connection.state='WORKING'
                 )
                 AND EXISTS (
                   SELECT 1 FROM public.group_bindings AS binding
                    WHERE binding.id=delivery.group_binding_id
                      AND binding.tenant_id=delivery.tenant_id
                      AND binding.state='ACTIVE'
                 )
                 AND EXISTS (
                   SELECT 1 FROM public.provider_sessions AS session
                    WHERE session.connection_id=delivery.connection_id
                      AND session.tenant_id=delivery.tenant_id
                      AND session.ownership_state='ACTIVE'
                      AND session.state='WORKING'
                 )
                 AND EXISTS (
                   SELECT 1 FROM public.zammad_instances AS zammad
                    WHERE zammad.tenant_id=delivery.tenant_id
                      AND zammad.state='WORKING'
                 )
                 AND EXISTS (
                   SELECT 1 FROM public.retention_policies AS policy
                    WHERE policy.tenant_id=delivery.tenant_id
                 )
               )
             )
          UNION ALL
          SELECT status.tenant_id,status.available_at
            FROM public.zammad_status_outbox AS status
            JOIN public.tenants AS tenant ON tenant.id=status.tenant_id
           WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND status.completed_at IS NULL
             AND status.available_at<=now()
             AND (status.lease_expires_at IS NULL OR status.lease_expires_at<now())
        ) AS pending
       GROUP BY pending.tenant_id
      UNION ALL
      SELECT operation.tenant_id,'connection'::text,min(operation.available_at)
        FROM public.connection_operations AS operation
        JOIN public.tenants AS tenant ON tenant.id=operation.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE')
         AND ((operation.state IN ('QUEUED','FAILED_RETRYABLE') AND operation.available_at<=now())
           OR (operation.state='RUNNING' AND operation.lease_expires_at<now()))
       GROUP BY operation.tenant_id
      UNION ALL
      SELECT due.tenant_id,'privacy'::text,min(due.available_at)
        FROM (
          SELECT policy.tenant_id,policy.next_sweep_at AS available_at
            FROM public.retention_policies AS policy
            JOIN public.tenants AS tenant ON tenant.id=policy.tenant_id
           WHERE tenant.state='ACTIVE' AND policy.next_sweep_at<=now()
          UNION ALL
          SELECT job.tenant_id,job.available_at
            FROM public.privacy_jobs AS job
            JOIN public.tenants AS tenant ON tenant.id=job.tenant_id
           WHERE tenant.state='ACTIVE'
             AND ((job.state IN ('QUEUED','FAILED_RETRYABLE') AND job.available_at<=now())
               OR (job.state='RUNNING' AND job.lease_expires_at<now()))
        ) AS due
       GROUP BY due.tenant_id
    ) AS candidate
   ORDER BY candidate.available_at,candidate.tenant_id,candidate.work_type
   LIMIT scan_limit;
END;
$$;

ALTER FUNCTION app.list_due_worker_tenants(integer) OWNER TO wasalx_scheduler_reader;
REVOKE ALL ON FUNCTION app.list_due_worker_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_due_worker_tenants(integer) TO wasalx_app;
