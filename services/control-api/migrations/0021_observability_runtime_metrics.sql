-- Cross-tenant operational telemetry is aggregate-only. The application role
-- cannot read tenant rows through this function, and no tenant, connection,
-- message, participant, group, phone, or reference identifiers are returned.

-- The function owner receives only the aggregate inputs it reads. Keeping the
-- grants here makes a fresh installation self-contained; 0031 applies the same
-- grants to databases that already ran this migration.
GRANT SELECT (status,received_at,lease_expires_at)
  ON public.event_inbox TO wasalx_scheduler_reader;
GRANT SELECT (state,created_at,lease_expires_at)
  ON public.delivery_outbox TO wasalx_scheduler_reader;
GRANT SELECT (completed_at,created_at,lease_expires_at)
  ON public.zammad_status_outbox TO wasalx_scheduler_reader;
GRANT SELECT (state,created_at,lease_expires_at)
  ON public.connection_operations TO wasalx_scheduler_reader;
GRANT SELECT (state,created_at,lease_expires_at)
  ON public.privacy_jobs TO wasalx_scheduler_reader;
GRANT SELECT (state,created_at)
  ON public.quarantine_records TO wasalx_scheduler_reader;
GRANT SELECT (status,available_at,updated_at)
  ON public.provisioning_operations TO wasalx_scheduler_reader;

CREATE OR REPLACE FUNCTION app.observability_runtime_metrics()
RETURNS TABLE(metric text, dimension text, value double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
  WITH queue_names(queue) AS (
    VALUES
      ('inbound'::text),
      ('delivery'::text),
      ('zammad_status'::text),
      ('connection'::text),
      ('privacy'::text),
      ('provisioning'::text),
      ('quarantine'::text)
  ),
  pending(queue,created_at) AS (
    SELECT 'inbound'::text,received_at
      FROM event_inbox
     WHERE status IN ('ACCEPTED','FAILED_RETRYABLE')
        OR (status='PROCESSING' AND lease_expires_at<now())
    UNION ALL
    SELECT 'delivery',created_at
      FROM delivery_outbox
     WHERE state IN ('QUEUED','FAILED_RETRYABLE')
        OR (state='SENDING' AND lease_expires_at<now())
    UNION ALL
    SELECT 'zammad_status',created_at
      FROM zammad_status_outbox
     WHERE completed_at IS NULL
       AND (lease_expires_at IS NULL OR lease_expires_at<now())
    UNION ALL
    SELECT 'connection',created_at
      FROM connection_operations
     WHERE state IN ('QUEUED','FAILED_RETRYABLE')
        OR (state='RUNNING' AND lease_expires_at<now())
    UNION ALL
    SELECT 'privacy',created_at
      FROM privacy_jobs
     WHERE state IN ('QUEUED','FAILED_RETRYABLE')
        OR (state='RUNNING' AND lease_expires_at<now())
    UNION ALL
    SELECT 'provisioning',updated_at
      FROM provisioning_operations
     WHERE status IN ('PENDING','RUNNING','FAILED_RETRYABLE','SUSPEND_PENDING','SUSPENDING')
       AND available_at<=now()
    UNION ALL
    SELECT 'quarantine',created_at
      FROM quarantine_records
     WHERE state IN ('OPEN','REPROCESS_QUEUED')
  ),
  queue_rollup AS (
    SELECT names.queue,
           count(pending.created_at)::double precision AS depth,
           COALESCE(EXTRACT(epoch FROM now()-min(pending.created_at)),0)::double precision AS age
      FROM queue_names names
      LEFT JOIN pending ON pending.queue=names.queue
     GROUP BY names.queue
  ),
  connection_states(state) AS (
    VALUES
      ('PROVISIONING'::text),('AWAITING_AUTH'::text),('CONNECTING'::text),
      ('WORKING'::text),('DEGRADED'::text),('ACTION_REQUIRED'::text),
      ('FAILED'::text),('PAUSED'::text),('REVOKED'::text)
  ),
  connection_rollup AS (
    SELECT states.state,
           count(connections.id)::double precision AS count
      FROM connection_states states
      LEFT JOIN connections ON connections.state=states.state
     GROUP BY states.state
  )
  SELECT 'queue_depth',queue,depth FROM queue_rollup
  UNION ALL
  SELECT 'queue_age_seconds',queue,age FROM queue_rollup
  UNION ALL
  SELECT 'connection_state',lower(state),count FROM connection_rollup;
$$;

ALTER FUNCTION app.observability_runtime_metrics() OWNER TO wasalx_scheduler_reader;
REVOKE ALL ON FUNCTION app.observability_runtime_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.observability_runtime_metrics() TO wasalx_app;
