CREATE TABLE client_routing_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider='NOTION'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  external_account_id text CHECK (external_account_id IS NULL OR length(external_account_id) BETWEEN 1 AND 200),
  secret_reference text NOT NULL CHECK (secret_reference ~ '^secret://tenants/[0-9a-f-]+/routing/integrations/[0-9a-f-]+$'),
  state text NOT NULL DEFAULT 'CONNECTING' CHECK (state IN ('CONNECTING','CONNECTED','REVOKED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>=1),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,secret_reference)
);

CREATE TABLE client_routing_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider='NOTION'),
  requested_by uuid NOT NULL REFERENCES users(id),
  state_sha256 text NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
  redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 8 AND 2048),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (state_sha256),
  FOREIGN KEY (tenant_id,integration_id) REFERENCES client_routing_integrations(tenant_id,id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX client_routing_integrations_one_workspace
  ON client_routing_integrations(tenant_id,provider,external_account_id) WHERE state='CONNECTED';

ALTER TABLE client_routing_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_routing_integrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_routing_integrations USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());
ALTER TABLE client_routing_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_routing_oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_routing_oauth_states USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());

REVOKE INSERT,UPDATE,DELETE ON client_routing_integrations,client_routing_oauth_states FROM wasalx_app;
GRANT SELECT ON client_routing_integrations TO wasalx_app;

CREATE OR REPLACE FUNCTION app.begin_client_routing_notion_oauth(requested_by uuid,state_hash text,requested_redirect_uri text)
RETURNS TABLE(integration_id uuid,secret_reference text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();DECLARE created_id uuid;DECLARE reference text;
BEGIN
  IF state_hash!~'^[0-9a-f]{64}$' OR length(requested_redirect_uri) NOT BETWEEN 8 AND 2048 THEN
    RAISE EXCEPTION 'routing OAuth request is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id=current_tenant AND user_id=requested_by AND role IN ('tenant_owner','tenant_admin')) THEN
    RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
  END IF;
  created_id:=gen_random_uuid();reference:='secret://tenants/'||current_tenant::text||'/routing/integrations/'||created_id::text;
  INSERT INTO client_routing_integrations(id,tenant_id,provider,display_name,secret_reference,created_by)
    VALUES(created_id,current_tenant,'NOTION','Notion workspace',reference,requested_by);
  INSERT INTO client_routing_oauth_states(tenant_id,integration_id,provider,requested_by,state_sha256,redirect_uri,expires_at)
    VALUES(current_tenant,created_id,'NOTION',requested_by,state_hash,requested_redirect_uri,now()+interval '10 minutes');
  RETURN QUERY SELECT created_id,reference;
END
$$;

CREATE OR REPLACE FUNCTION app.claim_client_routing_notion_oauth(state_hash text,requested_by uuid)
RETURNS TABLE(integration_id uuid,secret_reference text,redirect_uri text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();
BEGIN
  RETURN QUERY UPDATE client_routing_oauth_states oauth SET consumed_at=now()
   FROM client_routing_integrations integration
   WHERE oauth.tenant_id=current_tenant AND oauth.state_sha256=state_hash AND oauth.requested_by=claim_client_routing_notion_oauth.requested_by
     AND oauth.provider='NOTION' AND oauth.consumed_at IS NULL AND oauth.expires_at>now()
     AND integration.tenant_id=oauth.tenant_id AND integration.id=oauth.integration_id AND integration.state='CONNECTING'
   RETURNING integration.id,integration.secret_reference,oauth.redirect_uri;
END
$$;

CREATE OR REPLACE FUNCTION app.complete_client_routing_notion_oauth(requested_integration_id uuid,requested_by uuid,workspace_name text,workspace_id text)
RETURNS TABLE(integration_id uuid,display_name text,external_account_id text,revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();
BEGIN
  IF length(trim(workspace_name)) NOT BETWEEN 1 AND 160 OR length(workspace_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Notion workspace identity is invalid' USING ERRCODE='22023';
  END IF;
  RETURN QUERY UPDATE client_routing_integrations integration SET display_name=trim(workspace_name),external_account_id=workspace_id,
    state='CONNECTED',revision=integration.revision+1,updated_at=now()
   WHERE integration.tenant_id=current_tenant AND integration.id=requested_integration_id AND integration.created_by=requested_by
     AND integration.provider='NOTION' AND integration.state='CONNECTING'
   RETURNING integration.id,integration.display_name,integration.external_account_id,integration.revision;
END
$$;

CREATE OR REPLACE FUNCTION app.abort_client_routing_notion_oauth(state_hash text,requested_by uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();DECLARE aborted_id uuid;
BEGIN
  WITH abandoned AS (
    UPDATE client_routing_oauth_states oauth SET consumed_at=COALESCE(oauth.consumed_at,now())
     WHERE oauth.tenant_id=current_tenant AND oauth.state_sha256=state_hash AND oauth.requested_by=abort_client_routing_notion_oauth.requested_by
       AND oauth.provider='NOTION' RETURNING oauth.integration_id
  )
  UPDATE client_routing_integrations integration SET state='REVOKED',revision=integration.revision+1,updated_at=now()
   FROM abandoned WHERE integration.tenant_id=current_tenant AND integration.id=abandoned.integration_id AND integration.state='CONNECTING'
   RETURNING integration.id INTO aborted_id;
  RETURN aborted_id;
END
$$;

REVOKE ALL ON FUNCTION app.begin_client_routing_notion_oauth(uuid,text,text),app.claim_client_routing_notion_oauth(text,uuid),app.complete_client_routing_notion_oauth(uuid,uuid,text,text),app.abort_client_routing_notion_oauth(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.begin_client_routing_notion_oauth(uuid,text,text),app.claim_client_routing_notion_oauth(text,uuid),app.complete_client_routing_notion_oauth(uuid,uuid,text,text),app.abort_client_routing_notion_oauth(text,uuid) TO wasalx_app;
