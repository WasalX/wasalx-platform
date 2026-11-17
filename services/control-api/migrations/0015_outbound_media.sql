-- Outbound Zammad articles are split into an ordered text part followed by one
-- independently fenced provider mutation per attachment.  No attachment bytes,
-- provider URLs, or credentials are stored in PostgreSQL.

ALTER TABLE delivery_outbox
  ADD COLUMN request_sha256 text,
  ADD COLUMN agent_display_name text,
  ADD COLUMN agent_prefix_snapshot text,
  ADD COLUMN batch_id uuid,
  ADD COLUMN batch_sequence integer NOT NULL DEFAULT 0,
  ADD COLUMN batch_part_count integer NOT NULL DEFAULT 1,
  ADD COLUMN manual_retry_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN blocked_by_delivery_id uuid,
  ADD CONSTRAINT delivery_outbox_request_sha256_check CHECK (
    request_sha256 IS NULL OR request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT delivery_outbox_agent_display_name_check CHECK (
    agent_display_name IS NULL OR (
      length(agent_display_name) BETWEEN 1 AND 120
      AND agent_display_name !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT delivery_outbox_agent_prefix_snapshot_check CHECK (
    agent_prefix_snapshot IS NULL OR (
      length(agent_prefix_snapshot) BETWEEN 1 AND 80
      AND agent_prefix_snapshot !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT delivery_outbox_batch_check CHECK (
    (batch_id IS NULL AND batch_sequence = 0 AND batch_part_count = 1)
    OR
    (batch_id IS NOT NULL AND batch_part_count BETWEEN 2 AND 11
      AND batch_sequence BETWEEN 0 AND batch_part_count - 1)
  ),
  ADD CONSTRAINT delivery_outbox_manual_retry_check CHECK (
    NOT manual_retry_allowed OR state = 'FAILED_TERMINAL'
  );

ALTER TABLE delivery_outbox
  ADD CONSTRAINT delivery_outbox_tenant_id_id_unique UNIQUE (tenant_id, id);

ALTER TABLE delivery_outbox
  ADD CONSTRAINT delivery_outbox_blocked_by_fk
    FOREIGN KEY (tenant_id, blocked_by_delivery_id)
    REFERENCES delivery_outbox(tenant_id, id),
  ADD CONSTRAINT delivery_outbox_blocked_state_check CHECK (
    (state = 'BLOCKED' AND batch_id IS NOT NULL AND blocked_by_delivery_id IS NOT NULL)
    OR (state <> 'BLOCKED' AND blocked_by_delivery_id IS NULL)
  );

ALTER TABLE media_objects
  ADD CONSTRAINT media_objects_tenant_id_id_unique UNIQUE (tenant_id, id);

CREATE TABLE delivery_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delivery_id uuid NOT NULL,
  zammad_attachment_id bigint NOT NULL CHECK (zammad_attachment_id > 0),
  filename text NOT NULL CHECK (
    length(filename) BETWEEN 1 AND 120
    AND filename !~ '[[:cntrl:]]'
  ),
  mime_type text NOT NULL CHECK (
    length(mime_type) BETWEEN 3 AND 127
    AND mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
  ),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 100000000),
  state text NOT NULL DEFAULT 'PENDING'
    CONSTRAINT delivery_media_state_enum_check
    CHECK (state IN ('PENDING','READY','FAILED')),
  media_object_id uuid,
  provider_media_id text CHECK (
    provider_media_id IS NULL OR (
      length(provider_media_id) BETWEEN 1 AND 512
      AND provider_media_id !~ '[[:cntrl:]]'
    )
  ),
  safe_error text CHECK (safe_error IS NULL OR length(safe_error) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_media_delivery_fk
    FOREIGN KEY (tenant_id, delivery_id)
    REFERENCES delivery_outbox(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT delivery_media_object_fk
    FOREIGN KEY (tenant_id, media_object_id)
    REFERENCES media_objects(tenant_id, id),
  CONSTRAINT delivery_media_state_check CHECK (
    (state = 'PENDING' AND media_object_id IS NULL)
    OR (state = 'READY' AND media_object_id IS NOT NULL AND safe_error IS NULL)
    OR (state = 'FAILED' AND safe_error IS NOT NULL)
  ),
  UNIQUE (tenant_id, delivery_id),
  UNIQUE (tenant_id, delivery_id, zammad_attachment_id)
);

ALTER TABLE delivery_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_media FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON delivery_media
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE INDEX delivery_outbox_batch_idx
  ON delivery_outbox (tenant_id, batch_id, batch_sequence)
  WHERE batch_id IS NOT NULL;
CREATE INDEX delivery_media_object_idx
  ON delivery_media (tenant_id, media_object_id)
  WHERE media_object_id IS NOT NULL;

REVOKE ALL ON delivery_media FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON delivery_media TO wasalx_app;

-- A terminal or ambiguous part must make every later provider mutation
-- explicitly visible as BLOCKED.  Conversely, a successfully recovered part
-- resumes exactly one successor.  Keeping this invariant in PostgreSQL also
-- covers the SENDING lease-expiry transition performed by claim_delivery_jobs.
CREATE OR REPLACE FUNCTION app.apply_delivery_batch_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.batch_id IS NULL OR NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  IF NEW.state IN ('FAILED_TERMINAL','OUTCOME_UNKNOWN') THEN
    WITH blocked AS (
      UPDATE delivery_outbox AS successor
         SET state = 'BLOCKED',
             available_at = 'infinity'::timestamptz,
             safe_error = 'Blocked because an earlier article part requires recovery.',
             manual_retry_allowed = false,
             blocked_by_delivery_id = NEW.id,
             lease_id = NULL,
             lease_expires_at = NULL,
             updated_at = now()
       WHERE successor.tenant_id = NEW.tenant_id
         AND successor.batch_id = NEW.batch_id
         AND successor.batch_sequence > NEW.batch_sequence
         AND successor.state IN ('QUEUED','BLOCKED')
      RETURNING successor.tenant_id, successor.id, successor.zammad_ticket_id,
                successor.safe_error
    )
    INSERT INTO zammad_status_outbox (
      tenant_id, delivery_id, zammad_ticket_id, delivery_state, safe_error
    )
    SELECT tenant_id, id, zammad_ticket_id, 'BLOCKED', safe_error
      FROM blocked
    ON CONFLICT (tenant_id, delivery_id) DO UPDATE
      SET delivery_state = EXCLUDED.delivery_state,
          external_message_id = NULL,
          safe_error = EXCLUDED.safe_error,
          completed_at = NULL,
          available_at = now(),
          lease_id = NULL,
          lease_expires_at = NULL,
          updated_at = now();
  ELSIF NEW.state IN ('SENT','DELIVERED','READ') THEN
    WITH resumed AS (
      UPDATE delivery_outbox AS successor
         SET state = 'QUEUED',
             available_at = now(),
             safe_error = NULL,
             manual_retry_allowed = false,
             blocked_by_delivery_id = NULL,
             lease_id = NULL,
             lease_expires_at = NULL,
             updated_at = now()
       WHERE successor.tenant_id = NEW.tenant_id
         AND successor.batch_id = NEW.batch_id
         AND successor.batch_sequence = NEW.batch_sequence + 1
         AND successor.state IN ('QUEUED','BLOCKED')
      RETURNING successor.tenant_id, successor.id, successor.zammad_ticket_id
    )
    INSERT INTO zammad_status_outbox (
      tenant_id, delivery_id, zammad_ticket_id, delivery_state
    )
    SELECT tenant_id, id, zammad_ticket_id, 'QUEUED'
      FROM resumed
    ON CONFLICT (tenant_id, delivery_id) DO UPDATE
      SET delivery_state = EXCLUDED.delivery_state,
          external_message_id = NULL,
          safe_error = NULL,
          completed_at = NULL,
          available_at = now(),
          lease_id = NULL,
          lease_expires_at = NULL,
          updated_at = now();
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.apply_delivery_batch_transition() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_delivery_batch_transition() TO wasalx_app;

CREATE TRIGGER delivery_outbox_batch_transition
AFTER UPDATE OF state ON delivery_outbox
FOR EACH ROW
EXECUTE FUNCTION app.apply_delivery_batch_transition();

-- Scheduler discovery must not repeatedly wake tenants whose provider path is
-- paused, disconnected, unowned, or whose Zammad workspace is unavailable.
-- An expired SENDING lease remains discoverable regardless of provider health
-- because it must be fenced to OUTCOME_UNKNOWN.  Recovery naturally makes the
-- queued rows due again, and lifecycle operations also issue an immediate wake.
GRANT SELECT (id, tenant_id, state) ON public.connections TO wasalx_scheduler_reader;
GRANT SELECT (id, tenant_id, state) ON public.group_bindings TO wasalx_scheduler_reader;
GRANT SELECT (tenant_id, connection_id, state, ownership_state)
  ON public.provider_sessions TO wasalx_scheduler_reader;
GRANT SELECT (tenant_id, state) ON public.zammad_instances TO wasalx_scheduler_reader;
GRANT SELECT (connection_id, group_binding_id)
  ON public.delivery_outbox TO wasalx_scheduler_reader;

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
               (delivery.state = 'SENDING' AND delivery.lease_expires_at < now())
               OR (
                 (
                   (delivery.state IN ('QUEUED','FAILED_RETRYABLE') AND delivery.available_at <= now())
                   OR (delivery.state = 'CLAIMED' AND delivery.lease_expires_at < now())
                 )
                 AND EXISTS (
                   SELECT 1 FROM public.connections AS connection
                    WHERE connection.id = delivery.connection_id
                      AND connection.tenant_id = delivery.tenant_id
                      AND connection.state = 'WORKING'
                 )
                 AND EXISTS (
                   SELECT 1 FROM public.group_bindings AS binding
                    WHERE binding.id = delivery.group_binding_id
                      AND binding.tenant_id = delivery.tenant_id
                      AND binding.state = 'ACTIVE'
                 )
                 AND EXISTS (
                   SELECT 1 FROM public.provider_sessions AS session
                    WHERE session.connection_id = delivery.connection_id
                      AND session.tenant_id = delivery.tenant_id
                      AND session.ownership_state = 'ACTIVE'
                      AND session.state = 'WORKING'
                 )
                 AND EXISTS (
                   SELECT 1 FROM public.zammad_instances AS zammad
                    WHERE zammad.tenant_id = delivery.tenant_id
                      AND zammad.state = 'WORKING'
                 )
               )
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

ALTER FUNCTION app.list_due_worker_tenants(integer) OWNER TO wasalx_scheduler_reader;
REVOKE ALL ON FUNCTION app.list_due_worker_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_due_worker_tenants(integer) TO wasalx_app;
