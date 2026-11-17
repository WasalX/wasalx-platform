DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_scheduler_reader') THEN
    CREATE ROLE wasalx_scheduler_reader NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE wasalx_scheduler_reader NOLOGIN BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public, app TO wasalx_scheduler_reader;
GRANT SELECT (id, state) ON public.tenants TO wasalx_scheduler_reader;
GRANT SELECT (tenant_id, status, available_at, lease_expires_at)
  ON public.event_inbox TO wasalx_scheduler_reader;
GRANT SELECT (tenant_id, state, available_at, lease_expires_at)
  ON public.delivery_outbox TO wasalx_scheduler_reader;
GRANT SELECT (tenant_id, available_at, lease_expires_at, completed_at)
  ON public.zammad_status_outbox TO wasalx_scheduler_reader;
GRANT SELECT (tenant_id, state, available_at, lease_expires_at)
  ON public.connection_operations TO wasalx_scheduler_reader;

CREATE OR REPLACE FUNCTION app.list_due_worker_tenants(scan_limit integer DEFAULT 200)
RETURNS TABLE (tenant_id uuid, work_type text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
BEGIN
  IF scan_limit < 1 OR scan_limit > 1000 THEN
    RAISE EXCEPTION 'scan limit must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT candidate.tenant_id, candidate.work_type
    FROM (
      SELECT inbox.tenant_id, 'inbound'::text AS work_type,
             min(inbox.available_at) AS available_at
        FROM public.event_inbox AS inbox
        JOIN public.tenants AS tenant ON tenant.id = inbox.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE')
         AND (
           (inbox.status IN ('ACCEPTED','FAILED_RETRYABLE') AND inbox.available_at <= now())
           OR (inbox.status = 'PROCESSING' AND inbox.lease_expires_at < now())
         )
       GROUP BY inbox.tenant_id

      UNION ALL

      SELECT pending_delivery.tenant_id, 'delivery'::text AS work_type,
             min(pending_delivery.available_at) AS available_at
        FROM (
          SELECT delivery.tenant_id, delivery.available_at
            FROM public.delivery_outbox AS delivery
            JOIN public.tenants AS tenant ON tenant.id = delivery.tenant_id
           WHERE tenant.state IN ('PROVISIONING','ACTIVE')
             AND (
               (delivery.state IN ('QUEUED','FAILED_RETRYABLE') AND delivery.available_at <= now())
               OR (delivery.state = 'SENDING' AND delivery.lease_expires_at < now())
             )
          UNION ALL
          SELECT status.tenant_id, status.available_at
            FROM public.zammad_status_outbox AS status
            JOIN public.tenants AS tenant ON tenant.id = status.tenant_id
           WHERE tenant.state IN ('PROVISIONING','ACTIVE')
             AND status.completed_at IS NULL
             AND status.available_at <= now()
             AND (status.lease_expires_at IS NULL OR status.lease_expires_at < now())
        ) AS pending_delivery
       GROUP BY pending_delivery.tenant_id

      UNION ALL

      SELECT operation.tenant_id, 'connection'::text AS work_type,
             min(operation.available_at) AS available_at
        FROM public.connection_operations AS operation
        JOIN public.tenants AS tenant ON tenant.id = operation.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE')
         AND (
           (operation.state IN ('QUEUED','FAILED_RETRYABLE') AND operation.available_at <= now())
           OR (operation.state = 'RUNNING' AND operation.lease_expires_at < now())
         )
       GROUP BY operation.tenant_id
    ) AS candidate
   ORDER BY candidate.available_at, candidate.tenant_id, candidate.work_type
   LIMIT scan_limit;
END;
$$;

GRANT CREATE ON SCHEMA app TO wasalx_scheduler_reader;
ALTER FUNCTION app.list_due_worker_tenants(integer) OWNER TO wasalx_scheduler_reader;
REVOKE CREATE ON SCHEMA app FROM wasalx_scheduler_reader;
REVOKE ALL ON FUNCTION app.list_due_worker_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_due_worker_tenants(integer) TO wasalx_app;
