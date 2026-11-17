-- This release contains a non-overlap-compatible Zammad/API boundary. Admit it
-- only into a clean control plane; legacy or partially provisioned tenants
-- require the separately qualified adoption/upgrade lifecycle.
LOCK TABLE public.tenants IN SHARE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tenants) THEN
    RAISE EXCEPTION 'existing tenants require the WasalX adoption/upgrade lifecycle before this release'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

-- Once this boundary is installed, supported tenant creation takes the
-- migrator's session lock before invoking the historical implementation. A
-- tenant-table trigger keeps unsupported direct inserts fail-closed. The first
-- adoption of this boundary still requires the externally proved quiescence
-- window documented by the release runbook.
CREATE OR REPLACE FUNCTION app.enforce_tenant_schema_migration_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(8724591307);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.enforce_tenant_schema_migration_fence() FROM PUBLIC;

ALTER FUNCTION app.operator_create_tenant(text,text,text,text,integer,jsonb,text,text,text,text,text)
  RENAME TO operator_create_tenant_unfenced;
REVOKE ALL ON FUNCTION app.operator_create_tenant_unfenced(text,text,text,text,integer,jsonb,text,text,text,text,text)
  FROM PUBLIC,wasalx_app,wasalx_provisioner,wasalx_provisioning_client;
CREATE FUNCTION app.operator_create_tenant(
  request_key text,
  request_hash text,
  tenant_name text,
  tenant_slug text,
  retention_days_value integer,
  provisioning_spec jsonb,
  owner_subject text,
  owner_email text,
  owner_display_name text,
  actor_subject text,
  audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(8724591307);
  RETURN app.operator_create_tenant_unfenced(
    request_key,request_hash,tenant_name,tenant_slug,retention_days_value,
    provisioning_spec,owner_subject,owner_email,owner_display_name,actor_subject,audit_request_id
  );
END;
$$;
ALTER FUNCTION app.operator_create_tenant(text,text,text,text,integer,jsonb,text,text,text,text,text)
  OWNER TO wasalx_provisioning_executor;
REVOKE ALL ON FUNCTION app.operator_create_tenant(text,text,text,text,integer,jsonb,text,text,text,text,text)
  FROM PUBLIC,wasalx_app,wasalx_provisioner;
GRANT EXECUTE ON FUNCTION app.operator_create_tenant(text,text,text,text,integer,jsonb,text,text,text,text,text)
  TO wasalx_provisioning_client;

DROP TRIGGER IF EXISTS tenant_schema_migration_fence ON public.tenants;
CREATE TRIGGER tenant_schema_migration_fence
BEFORE INSERT ON public.tenants
FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_schema_migration_fence();

REVOKE ALL ON TABLE public.wasalx_schema_migrations FROM PUBLIC,wasalx_app;

-- Abort rather than guessing which identity owns a duplicated normalized email.
LOCK TABLE public.users IN SHARE MODE;

ALTER TABLE bot_flow_operations DROP CONSTRAINT bot_flow_operations_action_check;
ALTER TABLE bot_flow_operations ADD CONSTRAINT bot_flow_operations_action_check
  CHECK (action IN (
    'CREATE','CLONE','ACTIVATE','ASSIGN','ASSIGNMENT_STATE','ASSIGNMENT_ATTRIBUTION',
    'CONVERSATION_COMMAND','ROUTING_CREATE','ROUTING_ACTIVATE','ROUTING_SYNC','ACTION_SAVE',
    'GROUP_WORKSPACE_DEFAULTS','GROUP_WORKSPACE_CAPTURE','GROUP_WORKSPACE_GRANT','GROUP_WORKSPACE_REVOKE',
    'GROUP_BINDING_SAVE','GROUP_BINDING_TOGGLE','DELIVERY_RETRY',
    'WAHA_OUTBOUND_TENANT_CONTROL','WAHA_OUTBOUND_CONNECTION_POLICY','PRIVACY_REQUEST_RETRY'
  ));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.users GROUP BY lower(email) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate normalized user emails must be reconciled before migration' USING ERRCODE = '23505';
  END IF;
END;
$$;

CREATE UNIQUE INDEX users_email_normalized_unique_idx ON public.users (lower(email));

-- Tenant lifecycle is locked before the invitation so suspension/deletion and
-- acceptance cannot cross. Exact accepted-token replay remains idempotent.
CREATE OR REPLACE FUNCTION app.accept_tenant_invitation(
  token_hash_value text,
  oidc_subject_value text,
  email_value text,
  display_name_value text
)
RETURNS TABLE (tenant_id uuid,tenant_name text,tenant_slug text,user_id uuid,membership_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE invitation tenant_invitations%ROWTYPE;
DECLARE tenant_record tenants%ROWTYPE;
DECLARE user_value uuid;
DECLARE email_normalized text;
BEGIN
  email_normalized:=lower(email_value);
  SELECT tenant.* INTO tenant_record
    FROM tenants tenant
    JOIN tenant_invitations pending ON pending.tenant_id=tenant.id
   WHERE pending.token_hash=token_hash_value
   FOR SHARE OF tenant;
  IF NOT FOUND OR tenant_record.state<>'ACTIVE' THEN
    RAISE EXCEPTION 'invitation is invalid or expired' USING ERRCODE='P0002';
  END IF;

  SELECT candidate.* INTO invitation
    FROM tenant_invitations candidate
   WHERE candidate.tenant_id=tenant_record.id AND candidate.token_hash=token_hash_value
   FOR UPDATE OF candidate;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation is invalid or expired' USING ERRCODE='P0002'; END IF;
  IF invitation.email<>email_normalized THEN RAISE EXCEPTION 'invitation identity does not match' USING ERRCODE='42501'; END IF;
  IF invitation.state='ACCEPTED' THEN
    SELECT member.user_id INTO user_value FROM tenant_memberships member JOIN users existing ON existing.id=member.user_id
      WHERE member.tenant_id=invitation.tenant_id AND member.user_id=invitation.accepted_by AND member.role=invitation.role
        AND member.state='ACTIVE' AND existing.oidc_subject=oidc_subject_value AND lower(existing.email)=email_normalized;
    IF NOT FOUND THEN RAISE EXCEPTION 'invitation identity does not match' USING ERRCODE='42501'; END IF;
    RETURN QUERY SELECT tenant_record.id,tenant_record.name,tenant_record.slug,user_value,invitation.role;
    RETURN;
  END IF;
  IF invitation.expires_at<=now() THEN RAISE EXCEPTION 'invitation is invalid or expired' USING ERRCODE='P0002'; END IF;
  IF invitation.state<>'PENDING' THEN RAISE EXCEPTION 'invitation is invalid or expired' USING ERRCODE='P0002'; END IF;
  IF EXISTS (SELECT 1 FROM users WHERE lower(email)=email_normalized AND oidc_subject<>oidc_subject_value) THEN
    RAISE EXCEPTION 'email is linked to another identity' USING ERRCODE='23505';
  END IF;
  INSERT INTO users (oidc_subject,email,display_name) VALUES (oidc_subject_value,email_normalized,display_name_value)
    ON CONFLICT (oidc_subject) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name RETURNING id INTO user_value;
  IF EXISTS (SELECT 1 FROM tenant_memberships member WHERE member.tenant_id=invitation.tenant_id AND member.user_id=user_value) THEN
    RAISE EXCEPTION 'membership already exists' USING ERRCODE='23505';
  END IF;
  INSERT INTO tenant_memberships (tenant_id,user_id,role,state,updated_by)
    VALUES (invitation.tenant_id,user_value,invitation.role,'ACTIVE',user_value);
  UPDATE tenant_invitations SET state='ACCEPTED',accepted_by=user_value,accepted_at=now(),version=version+1,updated_at=now() WHERE id=invitation.id;
  UPDATE tenant_invitation_email_outbox SET state='CANCELLED',lease_id=NULL,lease_expires_at=NULL,updated_at=now()
    WHERE tenant_id=invitation.tenant_id AND invitation_id=invitation.id AND state IN ('PENDING','FAILED_RETRYABLE');
  INSERT INTO audit_events (tenant_id,actor_type,actor_id,action,target_type,target_id,previous_value,new_value,request_id)
    VALUES (invitation.tenant_id,'USER',user_value::text,'team.invitation_accepted','tenant_invitation',invitation.id::text,
      jsonb_build_object('state','PENDING'),jsonb_build_object('state','ACCEPTED','role',invitation.role),'invitation-accept-'||invitation.id::text);
  RETURN QUERY SELECT tenant_record.id,tenant_record.name,tenant_record.slug,user_value,invitation.role;
END;
$$;

ALTER FUNCTION app.accept_tenant_invitation(text,text,text,text) OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.accept_tenant_invitation(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_tenant_invitation(text,text,text,text) TO wasalx_app;

-- Suspended/deleting tenants cannot discover or claim new invitation email
-- sends. Claiming holds the tenant row so lifecycle changes serialize with the
-- provider handoff.
CREATE OR REPLACE FUNCTION app.pending_invitation_email_tenants(
  batch_size integer DEFAULT 25
)
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
BEGIN
  IF batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid invitation tenant discovery' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT job.tenant_id
    FROM tenant_invitation_email_outbox job
    JOIN tenant_invitations invitation
      ON invitation.tenant_id=job.tenant_id AND invitation.id=job.invitation_id
    JOIN tenants tenant ON tenant.id=job.tenant_id AND tenant.state='ACTIVE'
   WHERE invitation.state='PENDING'
     AND invitation.expires_at>now()
     AND (
       (job.state IN ('PENDING','FAILED_RETRYABLE') AND job.available_at<=now())
       OR (job.state='SENDING' AND job.lease_expires_at<now())
     )
   GROUP BY job.tenant_id
   ORDER BY min(job.available_at),job.tenant_id
   LIMIT batch_size;
END;
$$;
ALTER FUNCTION app.pending_invitation_email_tenants(integer) OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.pending_invitation_email_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pending_invitation_email_tenants(integer) TO wasalx_invitation_mailer;

CREATE OR REPLACE FUNCTION app.claim_invitation_email_jobs(
  worker_id uuid,batch_size integer DEFAULT 25
)
RETURNS SETOF tenant_invitation_email_outbox
LANGUAGE plpgsql
AS $$
BEGIN
  IF worker_id IS NULL OR batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid invitation email claim' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM tenants tenant
   WHERE tenant.id=app.current_tenant_id() AND tenant.state='ACTIVE'
   FOR SHARE OF tenant;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT job.id
      FROM tenant_invitation_email_outbox job
      JOIN tenant_invitations invitation
        ON invitation.tenant_id=job.tenant_id AND invitation.id=job.invitation_id
     WHERE job.tenant_id=app.current_tenant_id()
       AND invitation.state='PENDING' AND invitation.expires_at>now()
       AND (
         (job.state IN ('PENDING','FAILED_RETRYABLE') AND job.available_at<=now())
         OR (job.state='SENDING' AND job.lease_expires_at<now())
       )
     ORDER BY job.available_at,job.created_at
     LIMIT batch_size
     FOR UPDATE OF job SKIP LOCKED
  )
  UPDATE tenant_invitation_email_outbox job
     SET state='SENDING',attempts=job.attempts+1,lease_id=worker_id,
         lease_expires_at=now()+interval '60 seconds',fencing_token=job.fencing_token+1,
         error_code=NULL,safe_error=NULL,updated_at=now()
    FROM candidates
   WHERE job.id=candidates.id
   RETURNING job.*;
END;
$$;
GRANT SELECT (id,state) ON tenants TO wasalx_invitation_mailer;
REVOKE ALL ON FUNCTION app.claim_invitation_email_jobs(uuid,integer) FROM PUBLIC,wasalx_app;
GRANT EXECUTE ON FUNCTION app.claim_invitation_email_jobs(uuid,integer) TO wasalx_invitation_mailer;

-- A lifecycle operation and a provider send serialize on the connection row.
-- Once queued, PAUSE/DISCONNECT blocks new sends; the worker does not claim the
-- lifecycle operation until every already-started provider send has resolved.
CREATE OR REPLACE FUNCTION app.claim_connection_operations(
  worker_lease uuid,
  claim_limit integer DEFAULT 25
)
RETURNS SETOF connection_operations
LANGUAGE plpgsql
AS $$
BEGIN
  IF worker_lease IS NULL THEN
    RAISE EXCEPTION 'worker lease is required' USING ERRCODE = '22023';
  END IF;
  IF claim_limit < 1 OR claim_limit > 100 THEN
    RAISE EXCEPTION 'claim limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;

  UPDATE connection_operations
     SET state = 'FAILED_TERMINAL',
         lease_id = NULL,
         lease_expires_at = NULL,
         error_code = COALESCE(error_code, 'MAX_ATTEMPTS_EXHAUSTED'),
         safe_error = COALESCE(safe_error, 'Connection operation exhausted its retry limit.'),
         completed_at = now(),
         updated_at = now()
   WHERE tenant_id = app.current_tenant_id()
     AND attempts >= max_attempts
     AND (
       state IN ('QUEUED','FAILED_RETRYABLE')
       OR (state = 'RUNNING' AND lease_expires_at < now())
     );

  RETURN QUERY
  UPDATE connection_operations AS operation
     SET lease_id = worker_lease,
         lease_expires_at = now() + interval '60 seconds',
         fencing_token = operation.fencing_token + 1,
         state = 'RUNNING',
         attempts = operation.attempts + 1,
         started_at = COALESCE(operation.started_at, now()),
         error_code = NULL,
         safe_error = NULL,
         updated_at = now()
   WHERE operation.id IN (
     SELECT candidate.id
       FROM connection_operations AS candidate
      WHERE candidate.tenant_id = app.current_tenant_id()
        AND candidate.attempts < candidate.max_attempts
        AND (
          (candidate.state IN ('QUEUED','FAILED_RETRYABLE') AND candidate.available_at <= now())
          OR (candidate.state = 'RUNNING' AND candidate.lease_expires_at < now())
        )
        AND (candidate.lease_expires_at IS NULL OR candidate.lease_expires_at < now())
        AND NOT (
          candidate.operation_type IN ('PAUSE','DISCONNECT')
          AND EXISTS (
            SELECT 1 FROM delivery_outbox delivery
             WHERE delivery.tenant_id=candidate.tenant_id
               AND delivery.connection_id=candidate.connection_id
               AND delivery.state='SENDING'
          )
        )
      ORDER BY candidate.available_at, candidate.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT claim_limit
   )
  RETURNING operation.*;
END;
$$;

REVOKE ALL ON FUNCTION app.claim_connection_operations(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_connection_operations(uuid,integer) TO wasalx_app;

-- A delivery may project to more than one Zammad ticket. The ticket link table
-- is authoritative; the legacy singular ticket is only a fallback.
ALTER TABLE zammad_status_outbox
  DROP CONSTRAINT zammad_status_outbox_tenant_id_delivery_id_key;
ALTER TABLE zammad_status_outbox
  ADD CONSTRAINT zammad_status_outbox_delivery_ticket_key
  UNIQUE (tenant_id,delivery_id,zammad_ticket_id);

CREATE OR REPLACE FUNCTION app.project_delivery_status(
  delivery_id_value uuid,
  delivery_state_value text,
  external_message_id_value text DEFAULT NULL,
  safe_error_value text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE affected integer;
BEGIN
  WITH target AS (
    SELECT delivery.id,delivery.tenant_id,delivery.zammad_ticket_id
      FROM delivery_outbox delivery
     WHERE delivery.tenant_id=app.current_tenant_id()
       AND delivery.id=delivery_id_value
       AND delivery.state=delivery_state_value
  ), tickets AS (
    SELECT target.id,target.tenant_id,link.zammad_ticket_id
      FROM target
      JOIN delivery_ticket_links link
        ON link.tenant_id=target.tenant_id AND link.delivery_id=target.id
    UNION ALL
    SELECT target.id,target.tenant_id,target.zammad_ticket_id
      FROM target
     WHERE target.zammad_ticket_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM delivery_ticket_links link
          WHERE link.tenant_id=target.tenant_id AND link.delivery_id=target.id
       )
  )
  INSERT INTO zammad_status_outbox
    (tenant_id,delivery_id,zammad_ticket_id,delivery_state,external_message_id,safe_error)
  SELECT tenant_id,id,zammad_ticket_id,delivery_state_value,external_message_id_value,left(safe_error_value,500)
    FROM tickets
  ON CONFLICT (tenant_id,delivery_id,zammad_ticket_id) DO UPDATE SET
    delivery_state=EXCLUDED.delivery_state,
    external_message_id=EXCLUDED.external_message_id,
    safe_error=EXCLUDED.safe_error,
    completed_at=NULL,
    available_at=now(),
    lease_id=NULL,
    lease_expires_at=NULL,
    updated_at=now();
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION app.project_delivery_status(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.project_delivery_status(uuid,text,text,text) TO wasalx_app;

-- Claim only the oldest unfinished mutation for each provider destination.
-- Group bindings and the group workspace are two routes to the same WhatsApp
-- group, so resolve both to the canonical whatsapp_groups row before fencing.
CREATE OR REPLACE FUNCTION app.claim_delivery_jobs(worker_lease uuid, claim_limit integer DEFAULT 25)
RETURNS SETOF delivery_outbox
LANGUAGE plpgsql
AS $$
DECLARE unknown_delivery record;
BEGIN
  IF worker_lease IS NULL OR claim_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid delivery claim' USING ERRCODE = '22023';
  END IF;

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

  FOR unknown_delivery IN
    UPDATE delivery_outbox
       SET state = 'OUTCOME_UNKNOWN',
           safe_error = 'Provider outcome is unknown; verify the WhatsApp destination before retrying.',
           lease_id = NULL,
           lease_expires_at = NULL,
           updated_at = now()
     WHERE tenant_id = app.current_tenant_id()
       AND state = 'SENDING'
       AND lease_expires_at < now()
    RETURNING id
  LOOP
    PERFORM app.project_delivery_status(
      unknown_delivery.id,
      'OUTCOME_UNKNOWN',
      NULL,
      'Provider outcome is unknown; verify the WhatsApp destination before retrying.'
    );
  END LOOP;

  RETURN QUERY
  WITH candidates AS (
    SELECT delivery.id
      FROM delivery_outbox AS delivery
      LEFT JOIN group_bindings AS delivery_binding
        ON delivery_binding.tenant_id=delivery.tenant_id
       AND delivery_binding.id=delivery.group_binding_id
     WHERE delivery.tenant_id = app.current_tenant_id()
       AND (
         (delivery.state IN ('QUEUED','FAILED_RETRYABLE') AND delivery.available_at <= now())
         OR (delivery.state = 'CLAIMED' AND delivery.lease_expires_at < now())
       )
       AND (delivery.lease_expires_at IS NULL OR delivery.lease_expires_at < now())
       AND NOT EXISTS (
         SELECT 1
           FROM delivery_outbox AS predecessor
           LEFT JOIN group_bindings AS predecessor_binding
             ON predecessor_binding.tenant_id=predecessor.tenant_id
            AND predecessor_binding.id=predecessor.group_binding_id
          WHERE predecessor.tenant_id=delivery.tenant_id
            AND predecessor.connection_id=delivery.connection_id
            AND (
              (
                delivery.external_chat_id IS NOT NULL
                AND predecessor.external_chat_id=delivery.external_chat_id
                AND predecessor.direct_origin IN ('BOT','HUMAN')
              )
              OR
              (
                COALESCE(delivery.group_workspace_group_id,delivery_binding.whatsapp_group_id) IS NOT NULL
                AND COALESCE(predecessor.group_workspace_group_id,predecessor_binding.whatsapp_group_id)
                  = COALESCE(delivery.group_workspace_group_id,delivery_binding.whatsapp_group_id)
              )
            )
            AND (
              (
                delivery.batch_id IS NOT NULL
                AND predecessor.batch_id=delivery.batch_id
                AND predecessor.batch_sequence<delivery.batch_sequence
              )
              OR
              (
                (delivery.batch_id IS NULL OR predecessor.batch_id IS DISTINCT FROM delivery.batch_id)
                AND (
                  COALESCE((
                    SELECT min(predecessor_batch.created_at)
                      FROM delivery_outbox AS predecessor_batch
                     WHERE predecessor_batch.tenant_id=predecessor.tenant_id
                       AND predecessor_batch.batch_id=predecessor.batch_id
                  ),predecessor.created_at),
                  COALESCE(predecessor.batch_id,predecessor.id)
                ) < (
                  COALESCE((
                    SELECT min(delivery_batch.created_at)
                      FROM delivery_outbox AS delivery_batch
                     WHERE delivery_batch.tenant_id=delivery.tenant_id
                       AND delivery_batch.batch_id=delivery.batch_id
                  ),delivery.created_at),
                  COALESCE(delivery.batch_id,delivery.id)
                )
              )
            )
            AND predecessor.state NOT IN ('SENT','DELIVERED','READ','PRIVACY_CANCELLED')
            AND (predecessor.state<>'FAILED_TERMINAL' OR predecessor.manual_retry_allowed)
            AND NOT (
              predecessor.state='BLOCKED'
              AND EXISTS (
                SELECT 1
                  FROM delivery_outbox AS blocker
                 WHERE blocker.tenant_id=predecessor.tenant_id
                   AND blocker.id=predecessor.blocked_by_delivery_id
                   AND blocker.state='FAILED_TERMINAL'
                   AND NOT blocker.manual_retry_allowed
              )
            )
       )
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
         OR
         (delivery.group_workspace_group_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM whatsapp_groups AS workspace_group
           JOIN tenant_settings AS tenant ON tenant.tenant_id=workspace_group.tenant_id
           JOIN group_workspace_settings AS workspace ON workspace.tenant_id=workspace_group.tenant_id
             AND workspace.whatsapp_group_id=workspace_group.id
            WHERE workspace_group.tenant_id=delivery.tenant_id
              AND workspace_group.id=delivery.group_workspace_group_id
              AND tenant.group_workspace_enabled AND workspace.capture_enabled
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
     FOR UPDATE OF delivery SKIP LOCKED
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

REVOKE ALL ON FUNCTION app.claim_delivery_jobs(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_delivery_jobs(uuid,integer) TO wasalx_app;

-- Privacy effects are checkpointed before leaving PostgreSQL. Object cleanup
-- intent survives a lost worker lease, and a stale worker cannot overwrite the
-- current export artifact.
ALTER TABLE privacy_job_targets DROP CONSTRAINT privacy_job_targets_target_type_check;
ALTER TABLE privacy_job_targets ADD CONSTRAINT privacy_job_targets_target_type_check
  CHECK (target_type IN (
    'ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT','NORMALIZED_MESSAGE'
  ));
ALTER TABLE privacy_job_targets
  ADD COLUMN object_key_snapshot text,
  ADD COLUMN external_started_at timestamptz,
  ADD CONSTRAINT privacy_job_targets_object_key_snapshot_check CHECK (
    object_key_snapshot IS NULL OR
    (
      target_type='MEDIA_OBJECT'
      AND object_key_snapshot ~ ('^'||tenant_id::text||'/sha256/[0-9a-f]{2}/[0-9a-f]{64}$')
      AND split_part(object_key_snapshot,'/',3)=substr(right(object_key_snapshot,64),1,2)
    ) OR
    (
      target_type IN ('EXPORT_ARTIFACT','EXPORT_OBJECT')
      AND object_key_snapshot ~ ('^tenants/'||tenant_id::text||'/privacy-exports/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-[0-9]+)?\.json$')
    )
  );

ALTER TABLE privacy_export_artifacts DROP CONSTRAINT privacy_export_artifacts_object_key_check;
ALTER TABLE privacy_export_artifacts ADD CONSTRAINT privacy_export_artifacts_object_key_check CHECK (
  object_key ~ ('^tenants/'||tenant_id::text||'/privacy-exports/'||request_id::text||'(-[0-9]+)?\.json$')
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM privacy_export_artifacts artifact
     WHERE artifact.object_key !~ (
       '^tenants/'||artifact.tenant_id::text||'/privacy-exports/'||artifact.request_id::text||'(-[0-9]+)?\.json$'
     )
  ) THEN
    RAISE EXCEPTION 'cross-owner privacy export object keys must be reconciled before migration'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM media_objects media
     WHERE media.object_key<>(media.tenant_id::text||'/sha256/'||substr(media.sha256,1,2)||'/'||media.sha256)
  ) THEN
    RAISE EXCEPTION 'noncanonical media object keys must be reconciled before migration'
      USING ERRCODE='23514';
  END IF;
END;
$$;

ALTER TABLE media_objects ADD CONSTRAINT media_objects_canonical_object_key_check CHECK (
  object_key=tenant_id::text||'/sha256/'||substr(sha256,1,2)||'/'||sha256
);

CREATE TABLE privacy_object_cleanup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  object_key text NOT NULL CHECK (
    length(object_key) BETWEEN 1 AND 512 AND object_key !~ '[[:cntrl:]]'
    AND object_key ~ ('^tenants/'||tenant_id::text||'/privacy-exports/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-[0-9]+)?\.json$')
  ),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','COMPLETE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,job_id) REFERENCES privacy_jobs(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,object_key)
);
ALTER TABLE privacy_object_cleanup ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_object_cleanup FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON privacy_object_cleanup
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());
CREATE INDEX privacy_object_cleanup_due_idx
  ON privacy_object_cleanup (tenant_id,created_at,id) WHERE state='PENDING';

CREATE OR REPLACE FUNCTION app.guard_privacy_target_checkpoint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.job_id<>OLD.job_id
     OR NEW.target_type<>OLD.target_type OR NEW.target_id<>OLD.target_id
     OR NEW.target_sha256<>OLD.target_sha256
     OR (OLD.object_key_snapshot IS NOT NULL AND NEW.object_key_snapshot IS DISTINCT FROM OLD.object_key_snapshot)
     OR (OLD.external_operation_id IS NOT NULL AND NEW.external_operation_id IS DISTINCT FROM OLD.external_operation_id)
     OR (OLD.external_started_at IS NOT NULL AND NEW.external_started_at IS DISTINCT FROM OLD.external_started_at)
     OR NEW.attempts<OLD.attempts
     OR (OLD.state='EXTERNAL_COMPLETE' AND NEW.state NOT IN ('EXTERNAL_COMPLETE','COMPLETE'))
     OR (OLD.state='SKIPPED' AND NEW.state<>'SKIPPED')
     OR (OLD.state='COMPLETE' AND NEW.state<>'COMPLETE') THEN
    RAISE EXCEPTION 'privacy target checkpoint is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_privacy_target_checkpoint() FROM PUBLIC;
CREATE TRIGGER privacy_target_checkpoint_guard
BEFORE UPDATE ON privacy_job_targets
FOR EACH ROW EXECUTE FUNCTION app.guard_privacy_target_checkpoint();

CREATE OR REPLACE FUNCTION app.reject_late_privacy_hold()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||NEW.tenant_id::text,0));
  IF NEW.state='ACTIVE' AND EXISTS (
    SELECT 1 FROM privacy_jobs job
     WHERE job.tenant_id=NEW.tenant_id AND job.job_type IN ('RETENTION_SWEEP','DELETE')
       AND (
         job.state='RUNNING'
         OR (
           job.state IN ('QUEUED','FAILED_RETRYABLE')
           AND EXISTS (
             SELECT 1 FROM privacy_job_targets target
              WHERE target.tenant_id=job.tenant_id AND target.job_id=job.id
                AND target.external_started_at IS NOT NULL
                AND target.state IN ('PENDING','EXTERNAL_COMPLETE')
           )
         )
       )
  ) THEN
    RAISE EXCEPTION 'a privacy deletion is already running' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.reject_late_privacy_hold() FROM PUBLIC;
CREATE TRIGGER privacy_hold_late_insert_guard
BEFORE INSERT OR UPDATE OF state ON privacy_legal_holds
FOR EACH ROW EXECUTE FUNCTION app.reject_late_privacy_hold();

CREATE OR REPLACE FUNCTION app.claim_privacy_jobs(
  worker_lease uuid,
  claim_limit integer DEFAULT 10
)
RETURNS SETOF privacy_jobs
LANGUAGE plpgsql
AS $$
DECLARE exhausted record;
BEGIN
  IF worker_lease IS NULL OR claim_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'invalid privacy claim' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||app.current_tenant_id()::text,0));

  FOR exhausted IN
    UPDATE privacy_jobs job
       SET state='FAILED_TERMINAL',lease_id=NULL,lease_expires_at=NULL,
           error_code='PRIVACY_ATTEMPTS_EXHAUSTED',
           safe_error='Privacy processing exhausted its retry limit.',
           completed_at=now(),updated_at=now()
     WHERE job.tenant_id=app.current_tenant_id() AND job.attempts>=job.max_attempts
       AND (
         job.state IN ('QUEUED','FAILED_RETRYABLE')
         OR (job.state='RUNNING' AND job.lease_expires_at<now())
       )
    RETURNING job.id,job.request_id
  LOOP
    IF exhausted.request_id IS NOT NULL THEN
      UPDATE privacy_requests SET state='FAILED_TERMINAL',
             error_code='PRIVACY_ATTEMPTS_EXHAUSTED',
             safe_error='Privacy processing exhausted its retry limit.',
             completed_at=now(),updated_at=now()
       WHERE tenant_id=app.current_tenant_id() AND id=exhausted.request_id;
    END IF;
    INSERT INTO audit_events
      (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
    VALUES (app.current_tenant_id(),'SYSTEM','privacy-worker','privacy.job_failed',
      'privacy_job',exhausted.id::text,
      jsonb_build_object('code','PRIVACY_ATTEMPTS_EXHAUSTED','retryable',false),
      'privacy:'||exhausted.id::text||':exhausted');
  END LOOP;

  RETURN QUERY
  WITH candidates AS (
    SELECT job.id
      FROM privacy_jobs job
     WHERE job.tenant_id=app.current_tenant_id()
       AND job.attempts<job.max_attempts
       AND (
         (job.state IN ('QUEUED','FAILED_RETRYABLE') AND job.available_at<=now())
         OR (job.state='RUNNING' AND job.lease_expires_at<now())
       )
       AND NOT EXISTS (
         SELECT 1 FROM privacy_jobs active
          WHERE active.tenant_id=job.tenant_id AND active.id<>job.id
            AND active.state='RUNNING' AND active.lease_expires_at>=now()
       )
     ORDER BY job.available_at,job.created_at,job.id
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE privacy_jobs job
     SET state='RUNNING',attempts=job.attempts+1,lease_id=worker_lease,
         lease_expires_at=now()+interval '15 minutes',fencing_token=job.fencing_token+1,
         error_code=NULL,safe_error=NULL,updated_at=now()
    FROM candidates
   WHERE job.id=candidates.id
  RETURNING job.*;
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
     SET state='QUEUED',attempts=GREATEST(attempts-1,0),
         available_at=GREATEST(next_attempt_at,now()+interval '5 seconds'),
         lease_id=NULL,lease_expires_at=NULL,updated_at=now()
   WHERE tenant_id=app.current_tenant_id() AND id=job_value
     AND state='RUNNING' AND lease_id=worker_lease
     AND fencing_token=expected_fencing_token AND lease_expires_at>=now();
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END;
$$;

REVOKE ALL ON privacy_object_cleanup FROM PUBLIC,wasalx_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON privacy_object_cleanup TO wasalx_app;
REVOKE ALL ON FUNCTION app.claim_privacy_jobs(uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.defer_privacy_job(uuid,uuid,bigint,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_privacy_jobs(uuid,integer) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.defer_privacy_job(uuid,uuid,bigint,timestamptz) TO wasalx_app;

-- Secret references are capabilities. Bind persisted references to the exact
-- tenant-owned resource before any runtime resolver can fetch them.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM client_routing_source_state source
     WHERE source.secret_reference !~ (
       '^secret://tenants/'||source.tenant_id::text||'/routing/[A-Za-z0-9][A-Za-z0-9._~-]*(/[A-Za-z0-9][A-Za-z0-9._~-]*)*$'
     )
  ) THEN RAISE EXCEPTION 'routing source secret references must be reconciled before migration' USING ERRCODE='23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM client_routing_integrations integration
     WHERE integration.secret_reference !~ (
       '^secret://tenants/'||integration.tenant_id::text||'/routing/[A-Za-z0-9][A-Za-z0-9._~-]*(/[A-Za-z0-9][A-Za-z0-9._~-]*)*$'
     )
  ) THEN RAISE EXCEPTION 'routing integration secret references must be reconciled before migration' USING ERRCODE='23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM connections connection
     WHERE connection.provider='META'
       AND connection.secret_reference<>('secret://'||connection.tenant_id::text||'/connections/'||connection.id::text||'/meta')
       AND connection.secret_reference!~('^secret://'||connection.tenant_id::text||'/connections/'||connection.id::text||'/meta/rotations/[0-9a-f]{64}$')
  ) THEN RAISE EXCEPTION 'Meta credential references must be reconciled before migration' USING ERRCODE='23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM webhook_routes route
     WHERE route.provider='WAHA' AND route.hmac_secret_reference<>(
       'secret://'||route.tenant_id::text||'/connections/'||route.connection_id::text||'/webhook'
     )
  ) THEN RAISE EXCEPTION 'webhook secret references must be reconciled before migration' USING ERRCODE='23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM zammad_instances instance
     WHERE instance.service_secret_reference<>('secret://tenants/'||instance.tenant_id::text||'/zammad/service')
        OR instance.privacy_secret_reference<>('secret://tenants/'||instance.tenant_id::text||'/zammad/privacy')
  ) THEN RAISE EXCEPTION 'Zammad secret references must be reconciled before migration' USING ERRCODE='23514'; END IF;
END;
$$;

ALTER TABLE client_routing_source_state DROP CONSTRAINT client_routing_source_state_secret_reference_check;
ALTER TABLE client_routing_source_state ADD CONSTRAINT client_routing_source_state_secret_reference_check CHECK (
  secret_reference~(
    '^secret://tenants/'||tenant_id::text||'/routing/[A-Za-z0-9][A-Za-z0-9._~-]*(/[A-Za-z0-9][A-Za-z0-9._~-]*)*$'
  )
);
ALTER TABLE client_routing_integrations DROP CONSTRAINT client_routing_integrations_secret_reference_check;
ALTER TABLE client_routing_integrations ADD CONSTRAINT client_routing_integrations_secret_reference_check CHECK (
  secret_reference~(
    '^secret://tenants/'||tenant_id::text||'/routing/[A-Za-z0-9][A-Za-z0-9._~-]*(/[A-Za-z0-9][A-Za-z0-9._~-]*)*$'
  )
);
ALTER TABLE connections ADD CONSTRAINT connections_meta_secret_owner_check CHECK (
  provider<>'META' OR secret_reference=('secret://'||tenant_id::text||'/connections/'||id::text||'/meta')
  OR secret_reference~('^secret://'||tenant_id::text||'/connections/'||id::text||'/meta/rotations/[0-9a-f]{64}$')
);
ALTER TABLE webhook_routes ADD CONSTRAINT webhook_routes_secret_owner_check CHECK (
  provider<>'WAHA' OR hmac_secret_reference=('secret://'||tenant_id::text||'/connections/'||connection_id::text||'/webhook')
);
ALTER TABLE zammad_instances DROP CONSTRAINT zammad_instances_privacy_secret_reference_check;
ALTER TABLE zammad_instances ADD CONSTRAINT zammad_instances_secret_owner_check CHECK (
  service_secret_reference=('secret://tenants/'||tenant_id::text||'/zammad/service')
  AND privacy_secret_reference=('secret://tenants/'||tenant_id::text||'/zammad/privacy')
);

-- An email route is not complete until the exact native Zammad article that
-- requested it reports the applied or manually overridden ticket state.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM zammad_email_routes) THEN
    RAISE EXCEPTION 'legacy native-email routes must be reconciled before migration' USING ERRCODE='55000';
  END IF;
END;
$$;

ALTER TABLE zammad_email_routes
  ADD COLUMN zammad_instance_id uuid NOT NULL,
  ADD COLUMN source_article_id text NOT NULL,
  ADD COLUMN request_sha256 text NOT NULL,
  ADD CONSTRAINT zammad_email_routes_provenance_check CHECK (
    source_article_id ~ '^[1-9][0-9]{0,15}$'
    AND request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT zammad_email_routes_source_article_key
    UNIQUE (tenant_id,zammad_instance_id,source_article_id),
  ADD CONSTRAINT zammad_email_routes_tenant_id_id_instance_key
    UNIQUE (tenant_id,id,zammad_instance_id),
  ADD CONSTRAINT zammad_email_routes_instance_tenant_fk
    FOREIGN KEY (tenant_id,zammad_instance_id)
    REFERENCES zammad_instances(tenant_id,id);

CREATE TABLE zammad_email_route_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  route_id uuid NOT NULL,
  zammad_instance_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255 AND idempotency_key !~ '[[:cntrl:]]'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  application_status text NOT NULL CHECK (application_status IN ('APPLIED','MANUAL_OVERRIDE')),
  observed_group_id text NOT NULL CHECK (observed_group_id ~ '^[1-9][0-9]{0,15}$'),
  observed_owner_id text CHECK (observed_owner_id ~ '^[1-9][0-9]{0,15}$'),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 255 AND request_id !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,route_id),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,route_id,zammad_instance_id)
    REFERENCES zammad_email_routes(tenant_id,id,zammad_instance_id)
);

ALTER TABLE zammad_email_route_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE zammad_email_route_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON zammad_email_route_applications
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());
CREATE TRIGGER zammad_email_route_applications_append_only
  BEFORE UPDATE OR DELETE ON zammad_email_route_applications
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();
REVOKE ALL ON zammad_email_route_applications FROM PUBLIC;
GRANT SELECT,INSERT ON zammad_email_route_applications TO wasalx_app;

-- Connector execution has a separate least-privilege role. The API role is
-- deliberately not inherited by the worker login.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_connector_worker') THEN
    CREATE ROLE wasalx_connector_worker NOLOGIN NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO wasalx_connector_worker',current_database());
END;
$$;
GRANT USAGE ON SCHEMA public,app TO wasalx_connector_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM wasalx_connector_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM wasalx_connector_worker;

GRANT SELECT ON
  automation_action_revision_pins,bot_action_definitions,bot_action_jobs,bot_action_revisions,
  bot_assignments,bot_conversation_events,bot_conversations,bot_flow_media_asset_pins,
  bot_flow_versions,bot_handoff_jobs,bot_media_assets,case_correlations,
  client_routing_integrations,client_routing_source_state,client_routing_versions,
  connection_operations,connections,delivery_attempts,delivery_media,delivery_outbox,
  delivery_receipts,delivery_ticket_links,event_inbox,group_action_executions,group_bindings,
  group_disclosure_deliveries,group_workspace_participants,group_workspace_settings,
  media_objects,message_links,normalized_messages,participant_identities,
  privacy_export_artifacts,privacy_job_targets,privacy_jobs,privacy_legal_holds,
  privacy_object_cleanup,privacy_requests,provider_sessions,quarantine_records,
  retention_policies,rule_match_observations,rule_sets,tenant_settings,trigger_rules,
  waha_outbound_connection_policies,webhook_routes,whatsapp_groups,
  zammad_conversation_state_outbox,zammad_status_outbox
TO wasalx_connector_worker;
GRANT SELECT (id,tenant_id,base_url,state,service_secret_reference,privacy_secret_reference)
  ON zammad_instances TO wasalx_connector_worker;

GRANT INSERT ON
  audit_events,bot_action_jobs,bot_conversation_events,bot_conversations,bot_handoff_jobs,
  case_correlations,delivery_attempts,delivery_media,delivery_outbox,delivery_receipts,
  delivery_ticket_links,group_action_executions,group_disclosure_deliveries,
  group_workspace_participants,media_objects,message_links,normalized_messages,
  participant_identities,privacy_export_artifacts,privacy_job_targets,privacy_jobs,
  privacy_object_cleanup,quarantine_records,rule_match_observations,secret_cleanup_outbox,
  whatsapp_groups
TO wasalx_connector_worker;

GRANT UPDATE ON
  bot_action_jobs,bot_conversations,bot_handoff_jobs,bot_media_assets,case_correlations,
  connection_operations,connections,delivery_attempts,delivery_media,delivery_outbox,event_inbox,
  group_action_executions,group_disclosure_deliveries,normalized_messages,
  privacy_job_targets,privacy_jobs,privacy_legal_holds,privacy_object_cleanup,privacy_requests,
  provider_sessions,quarantine_records,retention_policies,webhook_routes,whatsapp_groups,
  zammad_conversation_state_outbox,zammad_status_outbox
TO wasalx_connector_worker;

GRANT DELETE ON
  bot_conversations,case_correlations,delivery_attempts,delivery_outbox,delivery_ticket_links,
  group_workspace_participants,media_objects,message_links,normalized_messages,
  participant_identities,privacy_export_artifacts,privacy_job_targets,privacy_object_cleanup
TO wasalx_connector_worker;

DO $$
DECLARE required_names text[] := ARRAY[
  'acquire_provider_session_lease','acquire_waha_session_assignment','authorize_waha_outbound_send',
  'claim_bot_action_jobs','claim_bot_handoff_jobs','claim_client_routing_sync_jobs',
  'claim_connection_operations','claim_delivery_jobs','claim_inbound_events','claim_privacy_jobs',
  'claim_zammad_conversation_state_jobs','claim_zammad_status_jobs',
  'complete_client_routing_source_qualification','complete_client_routing_sync_job',
  'complete_connection_operation','complete_privacy_job','current_tenant_id','current_waha_session_runtime',
  'defer_privacy_job','fail_client_routing_sync_job','fail_connection_operation','fail_privacy_job',
  'has_applicable_privacy_hold','list_due_worker_tenants','observability_runtime_metrics',
  'pin_waha_session_assignment_for_cleanup','project_delivery_status','purge_expired_unmatched_events',
  'queue_due_group_syncs','queue_duplicate_waha_identity_cleanup','renew_client_routing_sync_job',
  'renew_provider_session_lease','renew_waha_session_assignment',
  'revoke_client_routing_integration_for_sync'
];
DECLARE missing_names text[];
DECLARE routine record;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO missing_names
    FROM unnest(required_names) name
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc procedure
     JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
      WHERE namespace.nspname='app' AND procedure.proname=name
   );
  IF missing_names IS NOT NULL THEN
    RAISE EXCEPTION 'connector-worker functions are missing: %',missing_names USING ERRCODE='42883';
  END IF;
  FOR routine IN
    SELECT procedure.oid::regprocedure AS identity
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
     WHERE namespace.nspname='app' AND procedure.proname=ANY(required_names)
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO wasalx_connector_worker',routine.identity);
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_connector_worker_runtime') THEN
    REVOKE wasalx_app FROM wasalx_connector_worker_runtime;
    GRANT wasalx_connector_worker TO wasalx_connector_worker_runtime;
  END IF;
END;
$$;

-- User attribution on tenant rows must name an active member of that same
-- tenant. Keep the historical user FK global so removing a membership does not
-- erase or block immutable audit history.
CREATE OR REPLACE FUNCTION app.enforce_bot_action_actor_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE field_name text;
DECLARE actor_value uuid;
BEGIN
  FOREACH field_name IN ARRAY TG_ARGV LOOP
    actor_value:=NULLIF(to_jsonb(NEW)->>field_name,'')::uuid;
    IF actor_value IS NULL THEN CONTINUE; END IF;
    IF EXISTS (
      SELECT 1 FROM tenant_memberships membership
       WHERE membership.tenant_id=NEW.tenant_id
         AND membership.user_id=actor_value AND membership.state='ACTIVE'
    ) THEN CONTINUE; END IF;
    IF TG_TABLE_NAME='tenant_memberships' AND field_name='updated_by'
       AND NEW.state='ACTIVE' AND actor_value=NEW.user_id THEN
      CONTINUE;
    END IF;
    RAISE EXCEPTION 'tenant actor must be an active member of its tenant'
      USING ERRCODE='23503';
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.enforce_bot_action_actor_membership() FROM PUBLIC;

DO $$
DECLARE relation record;
DECLARE unsafe boolean;
BEGIN
  FOR relation IN
    SELECT columns.table_name,
           array_agg(columns.column_name ORDER BY columns.ordinal_position) AS actor_columns,
           string_agg(format('%I',columns.column_name),',' ORDER BY columns.ordinal_position) AS update_columns,
           string_agg(format('%L',columns.column_name),',' ORDER BY columns.ordinal_position) AS trigger_arguments
      FROM information_schema.columns columns
     WHERE columns.table_schema='public' AND columns.column_name~'(^actor_id$|_by$)'
       AND EXISTS (
         SELECT 1 FROM information_schema.columns tenant_column
          WHERE tenant_column.table_schema=columns.table_schema
            AND tenant_column.table_name=columns.table_name
            AND tenant_column.column_name='tenant_id'
       )
       AND EXISTS (
         SELECT 1
           FROM information_schema.key_column_usage key_column
           JOIN information_schema.constraint_column_usage referenced
             ON referenced.constraint_schema=key_column.constraint_schema
            AND referenced.constraint_name=key_column.constraint_name
          WHERE key_column.table_schema=columns.table_schema
            AND key_column.table_name=columns.table_name
            AND key_column.column_name=columns.column_name
            AND referenced.table_schema='public' AND referenced.table_name='users'
            AND referenced.column_name='id'
       )
     GROUP BY columns.table_name
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I row WHERE EXISTS ('||
      'SELECT 1 FROM unnest($1::text[]) field_name WHERE NULLIF(to_jsonb(row)->>field_name,'''') IS NOT NULL '||
      'AND NOT EXISTS (SELECT 1 FROM tenant_memberships membership WHERE membership.tenant_id=row.tenant_id '||
      'AND membership.user_id=(to_jsonb(row)->>field_name)::uuid)))',
      relation.table_name
    ) INTO unsafe USING relation.actor_columns;
    IF unsafe THEN
      RAISE EXCEPTION 'cross-tenant actor attribution exists in %',relation.table_name USING ERRCODE='23503';
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS tenant_actor_membership_guard ON %I',relation.table_name);
    EXECUTE format(
      'CREATE TRIGGER tenant_actor_membership_guard BEFORE INSERT OR UPDATE OF tenant_id,%s ON %I '||
      'FOR EACH ROW EXECUTE FUNCTION app.enforce_bot_action_actor_membership(%s)',
      relation.update_columns,relation.table_name,relation.trigger_arguments
    );
  END LOOP;
END;
$$;

DROP TRIGGER IF EXISTS bot_action_revision_actor_membership ON bot_action_revisions;
DROP TRIGGER IF EXISTS bot_action_credential_stage_actor_membership ON bot_action_credential_stages;
DROP TRIGGER IF EXISTS bot_action_job_actor_membership ON bot_action_jobs;
DROP TRIGGER IF EXISTS bot_media_asset_actor_membership ON bot_media_assets;

CREATE OR REPLACE FUNCTION app.enforce_consent_actor_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE actor_value uuid;
BEGIN
  actor_value:=NEW.actor_id::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_memberships membership
     WHERE membership.tenant_id=NEW.tenant_id
       AND membership.user_id=actor_value AND membership.state='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'consent actor must be an active member of its tenant' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'consent actor must be a user UUID' USING ERRCODE='23503';
END;
$$;
REVOKE ALL ON FUNCTION app.enforce_consent_actor_membership() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM consent_records consent
     WHERE consent.actor_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR NOT EXISTS (
          SELECT 1 FROM tenant_memberships membership
           WHERE membership.tenant_id=consent.tenant_id
             AND membership.user_id::text=consent.actor_id
        )
  ) THEN
    RAISE EXCEPTION 'consent actor attribution must be reconciled before migration' USING ERRCODE='23503';
  END IF;
END;
$$;
CREATE TRIGGER consent_actor_membership_guard
BEFORE INSERT OR UPDATE OF tenant_id,actor_id ON consent_records
FOR EACH ROW EXECUTE FUNCTION app.enforce_consent_actor_membership();

CREATE OR REPLACE FUNCTION app.enforce_audit_event_actor_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE actor_value uuid;
BEGIN
  IF NEW.actor_type<>'USER' THEN RETURN NEW; END IF;
  actor_value:=NEW.actor_id::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_memberships membership
     WHERE membership.tenant_id=NEW.tenant_id
       AND membership.user_id=actor_value AND membership.state='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'audit actor must be an active member of its tenant' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'audit user actor must be a UUID' USING ERRCODE='23503';
END;
$$;
REVOKE ALL ON FUNCTION app.enforce_audit_event_actor_membership() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM audit_events audit
     WHERE audit.actor_type='USER' AND (
       audit.actor_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT EXISTS (
         SELECT 1 FROM tenant_memberships membership
          WHERE membership.tenant_id=audit.tenant_id
            AND membership.user_id::text=audit.actor_id
       )
     )
  ) THEN
    RAISE EXCEPTION 'audit actor attribution must be reconciled before migration' USING ERRCODE='23503';
  END IF;
END;
$$;
CREATE TRIGGER audit_event_actor_membership_guard
BEFORE INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION app.enforce_audit_event_actor_membership();

-- A lost create response must replay the committed receipt even when the
-- current release catalog has since changed or is temporarily unavailable.
CREATE OR REPLACE FUNCTION app.replay_tenant_create_request(
  request_key text,
  request_hash text,
  actor_subject text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE existing_request provisioning_operator_requests%ROWTYPE;
BEGIN
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 OR request_key ~ '[[:cntrl:]]'
     OR request_hash !~ '^[0-9a-f]{64}$' OR actor_subject IS NULL OR actor_subject='' THEN
    RAISE EXCEPTION 'invalid tenant create replay request' USING ERRCODE='22023';
  END IF;
  SELECT * INTO existing_request
    FROM provisioning_operator_requests
   WHERE idempotency_key=request_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF existing_request.action<>'CREATE'
     OR existing_request.request_sha256<>request_hash
     OR existing_request.actor_subject<>actor_subject THEN
    RAISE EXCEPTION 'idempotency key was already used for a different request' USING ERRCODE='23505';
  END IF;
  IF jsonb_typeof(existing_request.response) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'tenant create receipt is incomplete' USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.jsonb_object_keys(existing_request.response))<>5
     OR NOT (existing_request.response ?& ARRAY['tenant_id','operation_id','tenant_state','status','duplicate'])
     OR existing_request.response->>'tenant_id' IS DISTINCT FROM existing_request.tenant_id::text
     OR existing_request.response->>'tenant_state'<>'PROVISIONING'
     OR existing_request.response->>'status'<>'PENDING'
     OR existing_request.response->'duplicate'<>'false'::jsonb THEN
    RAISE EXCEPTION 'tenant create receipt is incomplete' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_set(existing_request.response,'{duplicate}','true'::jsonb,true);
END;
$$;
ALTER FUNCTION app.replay_tenant_create_request(text,text,text)
  OWNER TO wasalx_provisioning_executor;
REVOKE ALL ON FUNCTION app.replay_tenant_create_request(text,text,text)
  FROM PUBLIC,wasalx_app,wasalx_provisioner;
GRANT EXECUTE ON FUNCTION app.replay_tenant_create_request(text,text,text)
  TO wasalx_provisioning_client;

-- A new operator lifecycle request gets a new durable operation identity;
-- retries keep that identity. Claims also retain margin beyond the 120-second
-- driver timeout so a second worker cannot overlap a live request.
CREATE OR REPLACE FUNCTION app.enforce_provisioning_operation_boundary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status='COMPLETE' AND NEW.action='SUSPEND' AND NEW.status='SUSPEND_PENDING' THEN
    NEW.operation_id:=gen_random_uuid();
  ELSIF OLD.status='SUSPENDED' AND NEW.action='RESUME' AND NEW.status='RESUME_PENDING' THEN
    NEW.operation_id:=gen_random_uuid();
  END IF;
  IF NEW.fencing_token>OLD.fencing_token
     AND NEW.status IN ('RUNNING','SUSPENDING','RESUMING')
     AND NEW.lease_id IS NOT NULL THEN
    NEW.lease_expires_at:=GREATEST(
      COALESCE(NEW.lease_expires_at,now()),
      now()+interval '180 seconds'
    );
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.enforce_provisioning_operation_boundary() FROM PUBLIC;
CREATE TRIGGER provisioning_operation_boundary
BEFORE UPDATE ON provisioning_operations
FOR EACH ROW EXECUTE FUNCTION app.enforce_provisioning_operation_boundary();

-- The control database accepts completion evidence only for the immutable
-- release tuple snapshotted into the create request.
CREATE OR REPLACE FUNCTION app.enforce_provisioning_release_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  release_value jsonb:=NEW.spec#>'{deployment,release}';
  images_value jsonb:=release_value->'images';
  zammad_result jsonb:=NEW.step_results->'zammad';
  package_result jsonb:=NEW.step_results->'package';
  image_name text;
BEGIN
  IF jsonb_typeof(release_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'tenant provisioning release target is invalid' USING ERRCODE='22023';
  END IF;
  images_value:=release_value->'images';
  IF (SELECT count(*) FROM pg_catalog.jsonb_object_keys(release_value))<>3
     OR COALESCE(release_value->>'packageVersion','') !~ '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$'
     OR COALESCE(release_value->>'packageSha256','') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'tenant provisioning release target is invalid' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(images_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'tenant provisioning release images are invalid' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.jsonb_object_keys(images_value))<>5 THEN
    RAISE EXCEPTION 'tenant provisioning release images are invalid' USING ERRCODE='22023';
  END IF;
  FOREACH image_name IN ARRAY ARRAY['zammad','configurator','nginx','redis','memcached'] LOOP
    IF COALESCE(images_value->>image_name,'') !~ '^[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'tenant provisioning release image is invalid' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF zammad_result IS NOT NULL AND (
    jsonb_typeof(zammad_result)<>'object'
    OR zammad_result->>'runtime_image' IS DISTINCT FROM images_value->>'zammad'
    OR zammad_result->>'package_version' IS DISTINCT FROM release_value->>'packageVersion'
    OR zammad_result->>'package_sha256' IS DISTINCT FROM release_value->>'packageSha256'
  ) THEN
    RAISE EXCEPTION 'Zammad provisioning evidence does not match the release target' USING ERRCODE='22023';
  END IF;
  IF package_result IS NOT NULL AND (
    jsonb_typeof(package_result)<>'object'
    OR package_result->>'package_version' IS DISTINCT FROM release_value->>'packageVersion'
    OR package_result->>'package_sha256' IS DISTINCT FROM release_value->>'packageSha256'
  ) THEN
    RAISE EXCEPTION 'package provisioning evidence does not match the release target' USING ERRCODE='22023';
  END IF;
  IF NEW.status='COMPLETE' AND (zammad_result IS NULL OR package_result IS NULL) THEN
    RAISE EXCEPTION 'complete provisioning requires exact release evidence' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.enforce_provisioning_release_evidence() FROM PUBLIC;
CREATE TRIGGER provisioning_release_evidence
BEFORE INSERT OR UPDATE OF spec,step_results,status ON provisioning_operations
FOR EACH ROW EXECUTE FUNCTION app.enforce_provisioning_release_evidence();
