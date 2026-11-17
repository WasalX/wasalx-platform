ALTER TABLE client_routing_integrations
  DROP CONSTRAINT client_routing_integrations_provider_check;
ALTER TABLE client_routing_integrations
  ADD CONSTRAINT client_routing_integrations_provider_check
  CHECK (provider IN ('NOTION','ZOHO','HTTP_JSON'));

ALTER TABLE client_routing_integrations
  ADD COLUMN auth_scheme text NOT NULL DEFAULT 'BEARER'
    CHECK (auth_scheme IN ('BEARER','HMAC')),
  ADD COLUMN replaces_integration_id uuid,
  ADD COLUMN replaces_revision bigint CHECK (replaces_revision IS NULL OR replaces_revision>=1),
  ADD COLUMN request_key_sha256 text CHECK (request_key_sha256 IS NULL OR request_key_sha256~'^[0-9a-f]{64}$'),
  ADD COLUMN request_payload_sha256 text CHECK (request_payload_sha256 IS NULL OR request_payload_sha256~'^[0-9a-f]{64}$'),
  ADD CONSTRAINT client_routing_integrations_replaces_fk
    FOREIGN KEY (tenant_id,replaces_integration_id)
    REFERENCES client_routing_integrations(tenant_id,id);

ALTER TABLE client_routing_integrations
  ADD CONSTRAINT client_routing_integrations_auth_provider_check
  CHECK (provider='HTTP_JSON' OR auth_scheme='BEARER');

-- Sources created before connection records existed already resolved secrets from
-- this tenant-owned namespace. Preserve those bindings rather than making the
-- stricter worker join silently strand their queued sync jobs.
ALTER TABLE client_routing_integrations
  DROP CONSTRAINT client_routing_integrations_secret_reference_check,
  ADD CONSTRAINT client_routing_integrations_secret_reference_check
  CHECK (
    secret_reference ~ (
      '^secret://tenants/' || tenant_id::text || '/routing/[A-Za-z0-9][A-Za-z0-9._~/-]*$'
    )
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM client_routing_source_state source
    JOIN client_routing_integrations integration
      ON integration.tenant_id=source.tenant_id
     AND integration.secret_reference=source.secret_reference
    WHERE source.state<>'RETIRED'
      AND (integration.provider<>source.kind OR integration.state<>'CONNECTED')
  ) THEN
    RAISE EXCEPTION 'active routing source has an incompatible connection binding';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM client_routing_source_state source
    WHERE source.state<>'RETIRED'
    GROUP BY source.tenant_id,source.secret_reference
    HAVING count(DISTINCT source.kind)>1
  ) THEN
    RAISE EXCEPTION 'active routing sources share one credential across providers';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM client_routing_source_state source
    JOIN client_routing_versions version
      ON version.tenant_id=source.tenant_id AND version.id=source.routing_version_id
    WHERE source.state<>'RETIRED'
      AND NOT EXISTS (
        SELECT 1 FROM client_routing_integrations integration
        WHERE integration.tenant_id=source.tenant_id
          AND integration.secret_reference=source.secret_reference
      )
      AND version.created_by IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM tenant_memberships membership
        WHERE membership.tenant_id=source.tenant_id
          AND membership.role IN ('tenant_owner','tenant_admin')
      )
  ) THEN
    RAISE EXCEPTION 'active routing source has no authorized connection owner';
  END IF;
END
$$;

WITH candidates AS (
  SELECT DISTINCT ON (source.tenant_id,source.secret_reference)
    source.tenant_id,source.kind,source.source_id,source.secret_reference,
    COALESCE(version.created_by,(
      SELECT membership.user_id
      FROM tenant_memberships membership
      WHERE membership.tenant_id=source.tenant_id
        AND membership.role IN ('tenant_owner','tenant_admin')
      ORDER BY CASE membership.role WHEN 'tenant_owner' THEN 0 ELSE 1 END,membership.user_id
      LIMIT 1
    )) AS created_by
  FROM client_routing_source_state source
  JOIN client_routing_versions version
    ON version.tenant_id=source.tenant_id AND version.id=source.routing_version_id
  WHERE source.state<>'RETIRED'
    AND NOT EXISTS (
      SELECT 1 FROM client_routing_integrations integration
      WHERE integration.tenant_id=source.tenant_id
        AND integration.secret_reference=source.secret_reference
    )
  ORDER BY source.tenant_id,source.secret_reference,source.source_id
), inserted AS (
  INSERT INTO client_routing_integrations(
    tenant_id,provider,display_name,secret_reference,state,created_by
  )
  SELECT tenant_id,kind,left(source_id||' connection',160),secret_reference,'CONNECTED',created_by
  FROM candidates
  ON CONFLICT (tenant_id,secret_reference) DO NOTHING
  RETURNING id,tenant_id,provider,display_name,secret_reference,created_by
)
INSERT INTO audit_events(
  tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id
)
SELECT tenant_id,'SYSTEM','system:migration','client_routing.integration_imported',
  'client_routing_integration',id::text,
  jsonb_build_object('provider',provider,'display_name',display_name,'secret_reference',secret_reference,'state','CONNECTED'),
  'migration:0101:routing-connection:'||id::text
FROM inserted;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM client_routing_source_state source
    WHERE source.state<>'RETIRED'
      AND NOT EXISTS (
        SELECT 1 FROM client_routing_integrations integration
        WHERE integration.tenant_id=source.tenant_id
          AND integration.secret_reference=source.secret_reference
          AND integration.provider=source.kind
          AND integration.state='CONNECTED'
      )
  ) THEN
    RAISE EXCEPTION 'active routing source connection repair was incomplete';
  END IF;
END
$$;

CREATE UNIQUE INDEX client_routing_integrations_request_key
  ON client_routing_integrations(tenant_id,request_key_sha256)
  WHERE request_key_sha256 IS NOT NULL;

CREATE OR REPLACE FUNCTION app.begin_client_routing_credential(
  requested_by uuid,
  requested_provider text,
  requested_display_name text,
  requested_auth_scheme text,
  requested_replaces_id uuid,
  expected_replaces_revision bigint,
  requested_key_sha256 text,
  requested_payload_sha256 text
)
RETURNS TABLE(
  integration_id uuid,
  secret_reference text,
  provider text,
  display_name text,
  auth_scheme text,
  state text,
  revision bigint,
  duplicate boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();
DECLARE existing client_routing_integrations%ROWTYPE;
DECLARE replaced client_routing_integrations%ROWTYPE;
DECLARE created_id uuid;
DECLARE reference text;
BEGIN
  IF requested_provider IS NULL OR requested_provider NOT IN ('ZOHO','HTTP_JSON')
     OR requested_auth_scheme IS NULL OR requested_auth_scheme NOT IN ('BEARER','HMAC')
     OR (requested_provider='ZOHO' AND requested_auth_scheme<>'BEARER')
     OR requested_display_name IS NULL OR length(trim(requested_display_name)) NOT BETWEEN 1 AND 160
     OR requested_key_sha256 IS NULL OR requested_key_sha256!~'^[0-9a-f]{64}$'
     OR requested_payload_sha256 IS NULL OR requested_payload_sha256!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'routing credential request is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_memberships
    WHERE tenant_id=current_tenant AND user_id=requested_by
      AND role IN ('tenant_owner','tenant_admin')
  ) THEN
    RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'routing-credential:'||current_tenant::text||':'||requested_key_sha256,0
  ));
  SELECT * INTO existing FROM client_routing_integrations integration
   WHERE integration.tenant_id=current_tenant
     AND integration.request_key_sha256=requested_key_sha256
   FOR UPDATE;
  IF FOUND THEN
    IF existing.request_payload_sha256<>requested_payload_sha256 THEN
      RAISE EXCEPTION 'routing credential idempotency key was reused' USING ERRCODE='40001';
    END IF;
    RETURN QUERY SELECT existing.id,existing.secret_reference,existing.provider,
      existing.display_name,existing.auth_scheme,existing.state,existing.revision,true;
    RETURN;
  END IF;

  IF requested_replaces_id IS NULL THEN
    IF expected_replaces_revision IS NOT NULL THEN
      RAISE EXCEPTION 'new routing credential cannot include a previous revision' USING ERRCODE='22023';
    END IF;
  ELSE
    SELECT * INTO replaced FROM client_routing_integrations integration
     WHERE integration.tenant_id=current_tenant
       AND integration.id=requested_replaces_id
     FOR UPDATE;
    IF NOT FOUND OR replaced.provider<>requested_provider OR replaced.state<>'CONNECTED'
       OR replaced.revision<>expected_replaces_revision THEN
      RAISE EXCEPTION 'routing credential changed; refresh before updating' USING ERRCODE='40001';
    END IF;
  END IF;

  created_id:=gen_random_uuid();
  reference:='secret://tenants/'||current_tenant::text||'/routing/integrations/'||created_id::text;
  INSERT INTO client_routing_integrations(
    id,tenant_id,provider,display_name,secret_reference,auth_scheme,created_by,
    replaces_integration_id,replaces_revision,request_key_sha256,request_payload_sha256
  ) VALUES (
    created_id,current_tenant,requested_provider,trim(requested_display_name),reference,
    requested_auth_scheme,requested_by,requested_replaces_id,expected_replaces_revision,
    requested_key_sha256,requested_payload_sha256
  );
  RETURN QUERY SELECT created_id,reference,requested_provider,trim(requested_display_name),
    requested_auth_scheme,'CONNECTING'::text,1::bigint,false;
END
$$;

CREATE OR REPLACE FUNCTION app.complete_client_routing_credential(
  requested_integration_id uuid,
  requested_by uuid
)
RETURNS TABLE(
  integration_id uuid,
  provider text,
  display_name text,
  auth_scheme text,
  secret_reference text,
  revision bigint,
  changed boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();
DECLARE candidate client_routing_integrations%ROWTYPE;
DECLARE next_revision bigint;
BEGIN
  SELECT * INTO candidate FROM client_routing_integrations integration
   WHERE integration.tenant_id=current_tenant
     AND integration.id=requested_integration_id
     AND integration.created_by=requested_by
     AND integration.provider IN ('ZOHO','HTTP_JSON')
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF candidate.state='CONNECTED' THEN
    RETURN QUERY SELECT candidate.id,candidate.provider,candidate.display_name,
      candidate.auth_scheme,candidate.secret_reference,candidate.revision,false;
    RETURN;
  END IF;
  IF candidate.state<>'CONNECTING' THEN RETURN; END IF;

  IF candidate.replaces_integration_id IS NOT NULL THEN
    UPDATE client_routing_integrations integration
       SET state='REVOKED',revision=integration.revision+1,updated_at=now()
     WHERE integration.tenant_id=current_tenant
       AND integration.id=candidate.replaces_integration_id
       AND integration.provider=candidate.provider
       AND integration.state='CONNECTED'
       AND integration.revision=candidate.replaces_revision;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'routing credential changed; refresh before updating' USING ERRCODE='40001';
    END IF;
  END IF;

  UPDATE client_routing_integrations integration
     SET state='CONNECTED',revision=integration.revision+1,updated_at=now()
   WHERE integration.tenant_id=current_tenant AND integration.id=candidate.id
   RETURNING integration.revision INTO next_revision;
  RETURN QUERY SELECT candidate.id,candidate.provider,candidate.display_name,
    candidate.auth_scheme,candidate.secret_reference,next_revision,true;
END
$$;

CREATE OR REPLACE FUNCTION app.abort_client_routing_credential(
  requested_integration_id uuid,
  requested_by uuid
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();
BEGIN
  UPDATE client_routing_integrations integration
     SET state='REVOKED',revision=integration.revision+1,updated_at=now()
   WHERE integration.tenant_id=current_tenant
     AND integration.id=requested_integration_id
     AND integration.created_by=requested_by
     AND integration.provider IN ('ZOHO','HTTP_JSON')
     AND integration.state='CONNECTING';
  RETURN FOUND;
END
$$;

DROP FUNCTION app.list_client_routing_integrations();
CREATE FUNCTION app.list_client_routing_integrations()
RETURNS TABLE(
  id uuid,
  provider text,
  display_name text,
  secret_reference text,
  auth_scheme text,
  state text,
  revision bigint,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app SET row_security=off AS $$
  WITH effective AS (
    SELECT integration.id,integration.provider,integration.display_name,
      integration.secret_reference,integration.auth_scheme,
      CASE WHEN integration.state='CONNECTING' AND integration.provider='NOTION'
        AND EXISTS (
          SELECT 1 FROM client_routing_oauth_states oauth
          WHERE oauth.tenant_id=integration.tenant_id
            AND oauth.integration_id=integration.id
            AND oauth.provider=integration.provider
            AND oauth.requested_by=integration.created_by
            AND oauth.consumed_at IS NULL
            AND oauth.expires_at<=now()
        )
        AND NOT EXISTS (
          SELECT 1 FROM client_routing_oauth_states pending
          WHERE pending.tenant_id=integration.tenant_id
            AND pending.integration_id=integration.id
            AND pending.provider=integration.provider
            AND pending.requested_by=integration.created_by
            AND pending.consumed_at IS NULL
            AND pending.expires_at>now()
        )
      THEN 'REVOKED' ELSE integration.state END AS state,
      integration.revision,integration.created_at,integration.updated_at
    FROM client_routing_integrations integration
    WHERE integration.tenant_id=app.current_tenant_id()
  ), ranked AS (
    SELECT effective.*,
      row_number() OVER (
        PARTITION BY effective.provider,effective.state
        ORDER BY effective.updated_at DESC,effective.created_at DESC,effective.id DESC
      ) AS state_rank
    FROM effective
  )
  SELECT ranked.id,ranked.provider,ranked.display_name,ranked.secret_reference,
    ranked.auth_scheme,ranked.state,ranked.revision,ranked.created_at,ranked.updated_at
  FROM ranked
  WHERE ranked.state<>'REVOKED' OR ranked.state_rank=1
  ORDER BY CASE ranked.state WHEN 'CONNECTED' THEN 0 WHEN 'CONNECTING' THEN 1 ELSE 2 END,
    ranked.display_name,ranked.created_at,ranked.id
$$;

REVOKE ALL ON FUNCTION app.begin_client_routing_credential(uuid,text,text,text,uuid,bigint,text,text),
  app.complete_client_routing_credential(uuid,uuid),app.abort_client_routing_credential(uuid,uuid),
  app.list_client_routing_integrations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.begin_client_routing_credential(uuid,text,text,text,uuid,bigint,text,text),
  app.complete_client_routing_credential(uuid,uuid),app.abort_client_routing_credential(uuid,uuid),
  app.list_client_routing_integrations() TO wasalx_app;

CREATE OR REPLACE FUNCTION app.enforce_client_routing_source_binding()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
  IF NEW.state<>'RETIRED' THEN
    PERFORM 1 FROM client_routing_integrations integration
     WHERE integration.tenant_id=NEW.tenant_id
       AND integration.secret_reference=NEW.secret_reference
       AND integration.provider=NEW.kind
       AND integration.state='CONNECTED'
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'routing source connection is unavailable' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS client_routing_source_binding ON client_routing_source_state;
CREATE TRIGGER client_routing_source_binding
BEFORE INSERT OR UPDATE ON client_routing_source_state
FOR EACH ROW EXECUTE FUNCTION app.enforce_client_routing_source_binding();

CREATE OR REPLACE FUNCTION app.claim_client_routing_sync_jobs(worker_lease uuid,claim_limit integer DEFAULT 10)
RETURNS TABLE(job_id uuid,source_state_id uuid,source_id text,kind text,sync_mode text,secret_reference text,endpoint_url text,
  schedule_minutes integer,field_mapping jsonb,config_sha256 text,snapshot jsonb,snapshot_revision bigint,cursor_value text,attempts integer,fencing_token bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();
BEGIN
  IF worker_lease IS NULL OR claim_limit<1 OR claim_limit>50 THEN RAISE EXCEPTION 'invalid routing sync claim' USING ERRCODE='22023';END IF;
  UPDATE client_routing_sync_jobs job SET state='FAILED_TERMINAL',lease_id=NULL,lease_expires_at=NULL,
    safe_error=COALESCE(job.safe_error,'Routing connector exhausted its retry limit.'),completed_at=now(),updated_at=now()
   WHERE job.tenant_id=current_tenant AND job.attempts>=job.max_attempts AND
    (job.state IN ('QUEUED','FAILED_RETRYABLE') OR (job.state='RUNNING' AND job.lease_expires_at<now()));
  RETURN QUERY WITH claimed AS (
    UPDATE client_routing_sync_jobs job SET state='RUNNING',attempts=job.attempts+1,lease_id=worker_lease,
      lease_expires_at=now()+interval '2 minutes',fencing_token=job.fencing_token+1,safe_error=NULL,updated_at=now()
     WHERE job.id IN (SELECT candidate.id FROM client_routing_sync_jobs candidate
       JOIN client_routing_source_state state ON state.tenant_id=candidate.tenant_id AND state.id=candidate.source_state_id
       JOIN client_routing_integrations integration ON integration.tenant_id=state.tenant_id
        AND integration.secret_reference=state.secret_reference AND integration.provider=state.kind AND integration.state='CONNECTED'
      WHERE candidate.tenant_id=current_tenant AND state.state='ACTIVE' AND state.config_sha256=candidate.config_sha256
        AND candidate.attempts<candidate.max_attempts AND ((candidate.state IN ('QUEUED','FAILED_RETRYABLE') AND candidate.available_at<=now()) OR
          (candidate.state='RUNNING' AND candidate.lease_expires_at<now()))
      ORDER BY candidate.available_at,candidate.created_at FOR UPDATE OF candidate SKIP LOCKED LIMIT claim_limit)
    RETURNING job.*
  ) SELECT job.id,state.id,state.source_id,state.kind,state.sync_mode,state.secret_reference,state.endpoint_url,state.schedule_minutes,
      state.field_mapping,state.config_sha256,state.snapshot,state.snapshot_revision,state.cursor_value,job.attempts,job.fencing_token
    FROM claimed job JOIN client_routing_source_state state ON state.tenant_id=job.tenant_id AND state.id=job.source_state_id;
END
$$;

CREATE OR REPLACE FUNCTION app.resolve_client_routing_webhook_route(route_hash text)
RETURNS TABLE(tenant_id uuid,source_state_id uuid,source_id text,kind text,secret_reference text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
  SELECT source.tenant_id,source.id,source.source_id,source.kind,source.secret_reference
    FROM client_routing_source_state source
    JOIN client_routing_integrations integration ON integration.tenant_id=source.tenant_id
      AND integration.secret_reference=source.secret_reference AND integration.provider=source.kind AND integration.state='CONNECTED'
    JOIN tenants tenant ON tenant.id=source.tenant_id
   WHERE source.webhook_route_sha256=route_hash AND source.state='ACTIVE' AND source.sync_mode IN ('WEBHOOK','HYBRID') AND tenant.state='ACTIVE'
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION app.enforce_client_routing_source_binding(),app.claim_client_routing_sync_jobs(uuid,integer),
  app.resolve_client_routing_webhook_route(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_client_routing_sync_jobs(uuid,integer),app.resolve_client_routing_webhook_route(text) TO wasalx_app;
