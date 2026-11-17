-- Platform support access is deliberately explicit, short lived, and
-- metadata-only. Platform operators never receive a general tenant database
-- role and no support function returns message bodies, media, secrets, or raw
-- provider payloads.

CREATE TABLE platform_support_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operator_subject text NOT NULL CHECK (
    length(operator_subject) BETWEEN 1 AND 255
    AND operator_subject !~ '[[:cntrl:]]'
  ),
  operator_email text NOT NULL CHECK (
    operator_email=lower(operator_email)
    AND length(operator_email) BETWEEN 3 AND 320
    AND operator_email !~ '[[:cntrl:][:space:]]'
  ),
  operator_display_name text NOT NULL CHECK (
    length(operator_display_name) BETWEEN 1 AND 160
    AND operator_display_name !~ '[[:cntrl:]]'
  ),
  reason text NOT NULL CHECK (
    length(reason) BETWEEN 10 AND 500
    AND reason !~ '[[:cntrl:]]'
  ),
  scope text NOT NULL DEFAULT 'OPERATIONAL_METADATA'
    CHECK (scope='OPERATIONAL_METADATA'),
  requested_duration_seconds integer NOT NULL
    CHECK (requested_duration_seconds BETWEEN 300 AND 3600),
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','APPROVED','DENIED','REVOKED','EXPIRED','CANCELLED')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  request_expires_at timestamptz NOT NULL DEFAULT (now()+interval '24 hours'),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  access_expires_at timestamptz,
  denied_by uuid REFERENCES users(id),
  denied_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  cancelled_at timestamptz,
  decision_reason text CHECK (
    decision_reason IS NULL OR (
      length(decision_reason) BETWEEN 3 AND 500
      AND decision_reason !~ '[[:cntrl:]]'
    )
  ),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (request_expires_at>requested_at AND request_expires_at<=requested_at+interval '24 hours'),
  CHECK (
    (state='PENDING'
      AND approved_by IS NULL AND approved_at IS NULL AND access_expires_at IS NULL
      AND denied_by IS NULL AND denied_at IS NULL
      AND revoked_by IS NULL AND revoked_at IS NULL AND cancelled_at IS NULL)
    OR (state='APPROVED'
      AND approved_by IS NOT NULL AND approved_at IS NOT NULL
      AND access_expires_at>approved_at
      AND access_expires_at<=approved_at+make_interval(secs=>requested_duration_seconds)
      AND denied_by IS NULL AND denied_at IS NULL
      AND revoked_by IS NULL AND revoked_at IS NULL AND cancelled_at IS NULL)
    OR (state='DENIED'
      AND approved_by IS NULL AND approved_at IS NULL AND access_expires_at IS NULL
      AND denied_by IS NOT NULL AND denied_at IS NOT NULL
      AND revoked_by IS NULL AND revoked_at IS NULL AND cancelled_at IS NULL)
    OR (state='REVOKED'
      AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND access_expires_at IS NOT NULL
      AND denied_by IS NULL AND denied_at IS NULL
      AND revoked_at IS NOT NULL AND cancelled_at IS NULL)
    OR (state='EXPIRED'
      AND denied_by IS NULL AND denied_at IS NULL
      AND revoked_by IS NULL AND revoked_at IS NULL AND cancelled_at IS NULL)
    OR (state='CANCELLED'
      AND approved_by IS NULL AND approved_at IS NULL AND access_expires_at IS NULL
      AND denied_by IS NULL AND denied_at IS NULL
      AND revoked_by IS NULL AND revoked_at IS NULL AND cancelled_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX platform_support_one_live_request_idx
  ON platform_support_access_requests (tenant_id,operator_subject)
  WHERE state IN ('PENDING','APPROVED');
CREATE INDEX platform_support_access_tenant_time_idx
  ON platform_support_access_requests (tenant_id,created_at DESC);
CREATE INDEX platform_support_access_expiry_idx
  ON platform_support_access_requests (state,request_expires_at,access_expires_at)
  WHERE state IN ('PENDING','APPROVED');

ALTER TABLE platform_support_access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_support_access_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_support_access_requests
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

-- This global table contains only hashes and replay results. It has no RLS and
-- is available only through the support SECURITY DEFINER functions.
CREATE TABLE platform_support_operator_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE CHECK (
    length(idempotency_key) BETWEEN 1 AND 255
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('REQUEST','CANCEL')),
  support_request_id uuid REFERENCES platform_support_access_requests(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operator_subject text NOT NULL CHECK (
    length(operator_subject) BETWEEN 1 AND 255
    AND operator_subject !~ '[[:cntrl:]]'
  ),
  response jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON platform_support_operator_requests FROM PUBLIC,wasalx_app,wasalx_provisioner;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_support_executor') THEN
    CREATE ROLE wasalx_support_executor NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE wasalx_support_executor NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_support_client') THEN
    CREATE ROLE wasalx_support_client NOLOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE wasalx_support_client NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public,app TO wasalx_support_executor;
GRANT SELECT ON tenants,tenant_settings,zammad_instances,connections,
  provider_sessions,whatsapp_groups,group_bindings,delivery_outbox,event_inbox,
  provisioning_operations,audit_events,platform_support_access_requests
  TO wasalx_support_executor;
GRANT INSERT,UPDATE ON platform_support_access_requests TO wasalx_support_executor;
GRANT SELECT,INSERT,UPDATE ON platform_support_operator_requests TO wasalx_support_executor;
GRANT INSERT ON audit_events TO wasalx_support_executor;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO wasalx_support_executor;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_support_tenant_writer') THEN
    CREATE ROLE wasalx_support_tenant_writer NOLOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE wasalx_support_tenant_writer NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public,app TO wasalx_support_tenant_writer;
GRANT SELECT,UPDATE ON platform_support_access_requests TO wasalx_support_tenant_writer;
GRANT SELECT ON tenant_memberships TO wasalx_support_tenant_writer;

CREATE OR REPLACE FUNCTION app.operator_request_support_access(
  tenant_value uuid,
  request_key text,
  request_hash text,
  actor_subject text,
  actor_email text,
  actor_display_name text,
  reason_value text,
  duration_seconds_value integer,
  audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE
  inserted_id uuid;
  support_id uuid;
  existing_request platform_support_operator_requests%ROWTYPE;
  response_value jsonb;
  tenant_state text;
BEGIN
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255
     OR request_key ~ '[[:cntrl:]]'
     OR request_hash !~ '^[0-9a-f]{64}$'
     OR duration_seconds_value NOT BETWEEN 300 AND 3600 THEN
    RAISE EXCEPTION 'invalid support access request' USING ERRCODE='22023';
  END IF;

  SELECT state INTO tenant_state FROM tenants WHERE id=tenant_value;
  IF tenant_state IS NULL THEN
    RAISE EXCEPTION 'tenant not found' USING ERRCODE='P0002';
  END IF;
  IF tenant_state NOT IN ('ACTIVE','PROVISIONING') THEN
    RAISE EXCEPTION 'tenant cannot authorize support access in its current state' USING ERRCODE='55000';
  END IF;

  INSERT INTO platform_support_operator_requests (
    idempotency_key,request_sha256,action,tenant_id,operator_subject
  ) VALUES (request_key,request_hash,'REQUEST',tenant_value,actor_subject)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO inserted_id;

  IF inserted_id IS NULL THEN
    SELECT * INTO existing_request
      FROM platform_support_operator_requests
     WHERE idempotency_key=request_key;
    IF existing_request.action<>'REQUEST'
       OR existing_request.request_sha256<>request_hash
       OR existing_request.operator_subject<>actor_subject
       OR existing_request.tenant_id<>tenant_value THEN
      RAISE EXCEPTION 'idempotency key was already used for a different request' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_set(existing_request.response,'{duplicate}','true'::jsonb,true);
  END IF;

  UPDATE platform_support_access_requests
     SET state='EXPIRED',version=version+1,updated_at=now()
   WHERE tenant_id=tenant_value AND operator_subject=actor_subject
     AND state='PENDING' AND request_expires_at<=now();

  INSERT INTO platform_support_access_requests (
    tenant_id,operator_subject,operator_email,operator_display_name,
    reason,requested_duration_seconds
  ) VALUES (
    tenant_value,actor_subject,lower(actor_email),actor_display_name,
    reason_value,duration_seconds_value
  ) RETURNING id INTO support_id;

  response_value := jsonb_build_object(
    'id',support_id,'tenant_id',tenant_value,'state','PENDING',
    'scope','OPERATIONAL_METADATA','requested_duration_seconds',duration_seconds_value,
    'request_expires_at',now()+interval '24 hours','duplicate',false
  );
  UPDATE platform_support_operator_requests
     SET support_request_id=support_id,response=response_value
   WHERE id=inserted_id;

  INSERT INTO audit_events (
    tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id
  ) VALUES (
    tenant_value,'PLATFORM_OPERATOR',actor_subject,'support_access.requested',
    'platform_support_access',support_id::text,
    jsonb_build_object(
      'scope','OPERATIONAL_METADATA','requested_duration_seconds',duration_seconds_value,
      'reason',reason_value,'state','PENDING'
    ),audit_request_id
  );
  RETURN response_value;
END;
$$;

CREATE OR REPLACE FUNCTION app.operator_get_support_access(
  support_id uuid,actor_subject text,audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE
  request_value platform_support_access_requests%ROWTYPE;
BEGIN
  UPDATE platform_support_access_requests
     SET state='EXPIRED',version=version+1,updated_at=now()
   WHERE id=support_id AND operator_subject=actor_subject
     AND ((state='PENDING' AND request_expires_at<=now())
       OR (state='APPROVED' AND access_expires_at<=now()));
  SELECT * INTO request_value FROM platform_support_access_requests
   WHERE id=support_id AND operator_subject=actor_subject;
  IF request_value.id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO audit_events (
    tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id
  ) VALUES (
    request_value.tenant_id,'PLATFORM_OPERATOR',actor_subject,
    'support_access.status_inspected','platform_support_access',support_id::text,
    jsonb_build_object('state',request_value.state),audit_request_id
  );
  RETURN jsonb_build_object(
    'id',request_value.id,'tenant_id',request_value.tenant_id,
    'state',request_value.state,'scope',request_value.scope,
    'reason',request_value.reason,
    'requested_duration_seconds',request_value.requested_duration_seconds,
    'requested_at',request_value.requested_at,
    'request_expires_at',request_value.request_expires_at,
    'approved_at',request_value.approved_at,
    'access_expires_at',request_value.access_expires_at,
    'revoked_at',request_value.revoked_at,
    'version',request_value.version
  );
END;
$$;

CREATE OR REPLACE FUNCTION app.operator_support_overview(
  support_id uuid,actor_subject text,audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE
  request_value platform_support_access_requests%ROWTYPE;
  tenant_value tenants%ROWTYPE;
  result_value jsonb;
BEGIN
  UPDATE platform_support_access_requests
     SET state='EXPIRED',version=version+1,updated_at=now()
   WHERE id=support_id AND operator_subject=actor_subject
     AND state='APPROVED' AND access_expires_at<=now();
  SELECT * INTO request_value FROM platform_support_access_requests
   WHERE id=support_id AND operator_subject=actor_subject;
  IF request_value.id IS NULL THEN RETURN NULL; END IF;
  IF request_value.state<>'APPROVED' OR request_value.access_expires_at<=now() THEN
    RAISE EXCEPTION 'support access is not active' USING ERRCODE='42501';
  END IF;
  SELECT * INTO tenant_value FROM tenants
   WHERE id=request_value.tenant_id AND state IN ('ACTIVE','PROVISIONING');
  IF tenant_value.id IS NULL THEN
    RAISE EXCEPTION 'tenant is unavailable for support access' USING ERRCODE='42501';
  END IF;

  SELECT jsonb_build_object(
    'support_access',jsonb_build_object(
      'id',request_value.id,'scope',request_value.scope,
      'access_expires_at',request_value.access_expires_at
    ),
    'tenant',jsonb_build_object(
      'id',tenant_value.id,'name',tenant_value.name,'slug',tenant_value.slug,
      'state',tenant_value.state,'updated_at',tenant_value.updated_at
    ),
    'zammad',COALESCE((
      SELECT jsonb_build_object(
        'state',z.state,'version',z.version,'last_healthy_at',z.last_healthy_at
      ) FROM zammad_instances z WHERE z.tenant_id=tenant_value.id
    ),'null'::jsonb),
    'provisioning',COALESCE((
      SELECT jsonb_build_object(
        'status',p.status,'action',p.action,'current_step',p.current_step,
        'completed_steps',p.completed_steps,'attempts',p.attempts,
        'max_attempts',p.max_attempts,'error_code',p.error_code,
        'error_detail',p.error_detail,'updated_at',p.updated_at
      ) FROM provisioning_operations p WHERE p.tenant_id=tenant_value.id
    ),'null'::jsonb),
    'connections',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',c.id,'name',c.name,'provider',c.provider,'engine',c.engine,
        'phone_e164',c.phone_e164,'state',c.state,
        'last_heartbeat_at',c.last_heartbeat_at,
        'last_provider_event_at',c.last_provider_event_at,
        'action_reason',c.action_reason,
        'bound_group_count',(SELECT count(*) FROM whatsapp_groups g
          JOIN group_bindings b ON b.whatsapp_group_id=g.id
         WHERE g.tenant_id=c.tenant_id AND g.connection_id=c.id),
        'provider_session_state',(SELECT ps.state FROM provider_sessions ps
         WHERE ps.tenant_id=c.tenant_id AND ps.connection_id=c.id
         ORDER BY ps.created_at DESC LIMIT 1)
      ) ORDER BY c.created_at,c.id)
      FROM connections c WHERE c.tenant_id=tenant_value.id
    ),'[]'::jsonb),
    'delivery_summary',COALESCE((
      SELECT jsonb_object_agg(summary.state,summary.total)
      FROM (SELECT d.state,count(*) AS total FROM delivery_outbox d
        WHERE d.tenant_id=tenant_value.id GROUP BY d.state) summary
    ),'{}'::jsonb),
    'oldest_actionable_delivery_at',(
      SELECT min(d.available_at) FROM delivery_outbox d
       WHERE d.tenant_id=tenant_value.id
         AND d.state IN ('QUEUED','FAILED_RETRYABLE','FAILED_TERMINAL','OUTCOME_UNKNOWN')
    ),
    'inbound_summary',COALESCE((
      SELECT jsonb_object_agg(summary.status,summary.total)
      FROM (SELECT e.status,count(*) AS total FROM event_inbox e
        WHERE e.tenant_id=tenant_value.id GROUP BY e.status) summary
    ),'{}'::jsonb),
    'recent_audit_metadata',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',recent.id,'actor_type',recent.actor_type,'action',recent.action,
        'target_type',recent.target_type,'target_id',recent.target_id,
        'created_at',recent.created_at
      ) ORDER BY recent.created_at DESC)
      FROM (SELECT a.id,a.actor_type,a.action,a.target_type,a.target_id,a.created_at
        FROM audit_events a WHERE a.tenant_id=tenant_value.id
        ORDER BY a.created_at DESC LIMIT 25) recent
    ),'[]'::jsonb)
  ) INTO result_value;

  INSERT INTO audit_events (
    tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id
  ) VALUES (
    tenant_value.id,'PLATFORM_OPERATOR',actor_subject,'support_access.metadata_inspected',
    'platform_support_access',support_id::text,
    jsonb_build_object('scope','OPERATIONAL_METADATA','access_expires_at',request_value.access_expires_at),
    audit_request_id
  );
  RETURN result_value;
END;
$$;

-- Ordinary application clients cannot update support state directly. This
-- transition function preserves tenant RLS, verifies an active owner in the
-- database, applies optimistic concurrency, and only permits a smaller grant
-- duration than the operator requested.
CREATE OR REPLACE FUNCTION app.tenant_decide_support_access(
  support_id uuid,
  expected_version_value bigint,
  decision text,
  actor_user_id uuid,
  duration_seconds_value integer DEFAULT NULL,
  decision_reason_value text DEFAULT NULL
)
RETURNS SETOF platform_support_access_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
AS $$
DECLARE
  request_value platform_support_access_requests%ROWTYPE;
  granted_duration_value integer;
BEGIN
  IF decision NOT IN ('APPROVE','DENY','REVOKE') THEN
    RAISE EXCEPTION 'invalid support access decision' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_memberships membership
     WHERE membership.tenant_id=app.current_tenant_id()
       AND membership.user_id=actor_user_id
       AND membership.role='tenant_owner'
       AND membership.state='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'an active tenant owner is required' USING ERRCODE='42501';
  END IF;

  SELECT * INTO request_value FROM platform_support_access_requests
   WHERE tenant_id=app.current_tenant_id() AND id=support_id FOR UPDATE;
  IF request_value.id IS NULL THEN
    RAISE EXCEPTION 'support access request not found' USING ERRCODE='P0002';
  END IF;
  IF request_value.version<>expected_version_value THEN
    RAISE EXCEPTION 'support access version conflict' USING ERRCODE='40001';
  END IF;

  IF decision='APPROVE' THEN
    IF request_value.state<>'PENDING' OR request_value.request_expires_at<=now() THEN
      RAISE EXCEPTION 'support access request is not pending' USING ERRCODE='55000';
    END IF;
    granted_duration_value:=COALESCE(duration_seconds_value,request_value.requested_duration_seconds);
    IF granted_duration_value NOT BETWEEN 300 AND request_value.requested_duration_seconds THEN
      RAISE EXCEPTION 'invalid support access duration' USING ERRCODE='22023';
    END IF;
    RETURN QUERY
    UPDATE platform_support_access_requests AS support
       SET state='APPROVED',approved_by=actor_user_id,approved_at=now(),
           access_expires_at=now()+make_interval(secs=>granted_duration_value),
           version=support.version+1,updated_at=now()
     WHERE support.tenant_id=app.current_tenant_id() AND support.id=support_id
     RETURNING support.*;
  ELSIF decision='DENY' THEN
    IF request_value.state<>'PENDING' OR request_value.request_expires_at<=now() THEN
      RAISE EXCEPTION 'support access request is not pending' USING ERRCODE='55000';
    END IF;
    IF decision_reason_value IS NULL OR length(decision_reason_value) NOT BETWEEN 3 AND 500
       OR decision_reason_value ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'invalid support access decision reason' USING ERRCODE='22023';
    END IF;
    RETURN QUERY
    UPDATE platform_support_access_requests AS support
       SET state='DENIED',denied_by=actor_user_id,denied_at=now(),
           decision_reason=decision_reason_value,
           version=support.version+1,updated_at=now()
     WHERE support.tenant_id=app.current_tenant_id() AND support.id=support_id
     RETURNING support.*;
  ELSE
    IF request_value.state<>'APPROVED' OR request_value.access_expires_at<=now() THEN
      RAISE EXCEPTION 'support access is not active' USING ERRCODE='55000';
    END IF;
    IF decision_reason_value IS NULL OR length(decision_reason_value) NOT BETWEEN 3 AND 500
       OR decision_reason_value ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'invalid support access revocation reason' USING ERRCODE='22023';
    END IF;
    RETURN QUERY
    UPDATE platform_support_access_requests AS support
       SET state='REVOKED',revoked_by=actor_user_id,revoked_at=now(),
           decision_reason=decision_reason_value,
           version=support.version+1,updated_at=now()
     WHERE support.tenant_id=app.current_tenant_id() AND support.id=support_id
     RETURNING support.*;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app.expire_tenant_support_access()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
AS $$
DECLARE affected integer;
BEGIN
  UPDATE platform_support_access_requests
     SET state='EXPIRED',version=version+1,updated_at=now()
   WHERE tenant_id=app.current_tenant_id()
     AND ((state='PENDING' AND request_expires_at<=now())
       OR (state='APPROVED' AND access_expires_at<=now()));
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END;
$$;

CREATE OR REPLACE FUNCTION app.operator_cancel_support_access(
  support_id uuid,request_key text,request_hash text,
  actor_subject text,audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE
  inserted_id uuid;
  existing_request platform_support_operator_requests%ROWTYPE;
  support_value platform_support_access_requests%ROWTYPE;
  response_value jsonb;
BEGIN
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255
     OR request_key ~ '[[:cntrl:]]' OR request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid support cancellation' USING ERRCODE='22023';
  END IF;
  SELECT * INTO support_value FROM platform_support_access_requests
   WHERE id=support_id AND operator_subject=actor_subject FOR UPDATE;
  IF support_value.id IS NULL THEN
    RAISE EXCEPTION 'support access request not found' USING ERRCODE='P0002';
  END IF;

  INSERT INTO platform_support_operator_requests (
    idempotency_key,request_sha256,action,support_request_id,tenant_id,operator_subject
  ) VALUES (request_key,request_hash,'CANCEL',support_id,support_value.tenant_id,actor_subject)
  ON CONFLICT (idempotency_key) DO NOTHING RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN
    SELECT * INTO existing_request FROM platform_support_operator_requests
     WHERE idempotency_key=request_key;
    IF existing_request.action<>'CANCEL'
       OR existing_request.request_sha256<>request_hash
       OR existing_request.operator_subject<>actor_subject
       OR existing_request.support_request_id<>support_id THEN
      RAISE EXCEPTION 'idempotency key was already used for a different request' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_set(existing_request.response,'{duplicate}','true'::jsonb,true);
  END IF;

  IF support_value.state='PENDING' THEN
    UPDATE platform_support_access_requests
       SET state='CANCELLED',cancelled_at=now(),version=version+1,updated_at=now()
     WHERE id=support_id;
  ELSIF support_value.state='APPROVED' THEN
    UPDATE platform_support_access_requests
       SET state='REVOKED',revoked_at=now(),version=version+1,updated_at=now()
     WHERE id=support_id;
  ELSIF support_value.state NOT IN ('CANCELLED','REVOKED','EXPIRED','DENIED') THEN
    RAISE EXCEPTION 'support access cannot be cancelled' USING ERRCODE='55000';
  END IF;

  SELECT * INTO support_value FROM platform_support_access_requests WHERE id=support_id;
  response_value:=jsonb_build_object(
    'id',support_value.id,'tenant_id',support_value.tenant_id,
    'state',support_value.state,'version',support_value.version,'duplicate',false
  );
  UPDATE platform_support_operator_requests SET response=response_value WHERE id=inserted_id;
  INSERT INTO audit_events (
    tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id
  ) VALUES (
    support_value.tenant_id,'PLATFORM_OPERATOR',actor_subject,'support_access.cancelled',
    'platform_support_access',support_id::text,
    jsonb_build_object('state',support_value.state),audit_request_id
  );
  RETURN response_value;
END;
$$;

GRANT CREATE ON SCHEMA app TO wasalx_support_executor;
ALTER FUNCTION app.operator_request_support_access(uuid,text,text,text,text,text,text,integer,text)
  OWNER TO wasalx_support_executor;
ALTER FUNCTION app.operator_get_support_access(uuid,text,text)
  OWNER TO wasalx_support_executor;
ALTER FUNCTION app.operator_support_overview(uuid,text,text)
  OWNER TO wasalx_support_executor;
ALTER FUNCTION app.operator_cancel_support_access(uuid,text,text,text,text)
  OWNER TO wasalx_support_executor;
REVOKE CREATE ON SCHEMA app FROM wasalx_support_executor;

GRANT CREATE ON SCHEMA app TO wasalx_support_tenant_writer;
ALTER FUNCTION app.tenant_decide_support_access(uuid,bigint,text,uuid,integer,text)
  OWNER TO wasalx_support_tenant_writer;
ALTER FUNCTION app.expire_tenant_support_access()
  OWNER TO wasalx_support_tenant_writer;
REVOKE CREATE ON SCHEMA app FROM wasalx_support_tenant_writer;

REVOKE ALL ON FUNCTION app.operator_request_support_access(uuid,text,text,text,text,text,text,integer,text)
  FROM PUBLIC,wasalx_app,wasalx_provisioner,wasalx_provisioning_client;
REVOKE ALL ON FUNCTION app.operator_get_support_access(uuid,text,text)
  FROM PUBLIC,wasalx_app,wasalx_provisioner,wasalx_provisioning_client;
REVOKE ALL ON FUNCTION app.operator_support_overview(uuid,text,text)
  FROM PUBLIC,wasalx_app,wasalx_provisioner,wasalx_provisioning_client;
REVOKE ALL ON FUNCTION app.operator_cancel_support_access(uuid,text,text,text,text)
  FROM PUBLIC,wasalx_app,wasalx_provisioner,wasalx_provisioning_client;

GRANT USAGE ON SCHEMA app TO wasalx_support_client;
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO wasalx_support_client',current_database());
END $$;
GRANT EXECUTE ON FUNCTION app.operator_request_support_access(uuid,text,text,text,text,text,text,integer,text)
  TO wasalx_support_client;
GRANT EXECUTE ON FUNCTION app.operator_get_support_access(uuid,text,text)
  TO wasalx_support_client;
GRANT EXECUTE ON FUNCTION app.operator_support_overview(uuid,text,text)
  TO wasalx_support_client;
GRANT EXECUTE ON FUNCTION app.operator_cancel_support_access(uuid,text,text,text,text)
  TO wasalx_support_client;

REVOKE ALL ON FUNCTION app.tenant_decide_support_access(uuid,bigint,text,uuid,integer,text)
  FROM PUBLIC,wasalx_provisioner,wasalx_provisioning_client,wasalx_support_client;
REVOKE ALL ON FUNCTION app.expire_tenant_support_access()
  FROM PUBLIC,wasalx_provisioner,wasalx_provisioning_client,wasalx_support_client;
GRANT EXECUTE ON FUNCTION app.tenant_decide_support_access(uuid,bigint,text,uuid,integer,text)
  TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.expire_tenant_support_access() TO wasalx_app;
-- Migration 0005 granted DML on future public tables by default.  Tenant
-- clients must only observe support requests and invoke the owner-authorized
-- transition functions above; direct writes would bypass optimistic locking,
-- owner verification, duration limits, and the state machine.
REVOKE INSERT,UPDATE,DELETE ON platform_support_access_requests FROM wasalx_app;
GRANT SELECT ON platform_support_access_requests TO wasalx_app;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_support_runtime') THEN
    GRANT wasalx_support_client TO wasalx_support_runtime;
  END IF;
END
$$;
