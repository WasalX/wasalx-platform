ALTER TABLE public.client_routing_oauth_states
  ADD COLUMN outcome text CHECK (outcome IN ('CONNECTED','ABORTED'));

-- Older starts inserted the outbox row before updating the integration's reference.
UPDATE public.secret_cleanup_outbox AS cleanup
SET secret_reference=integration.secret_reference
FROM public.client_routing_integrations AS integration
WHERE cleanup.tenant_id=integration.tenant_id AND cleanup.routing_integration_id=integration.id
  AND cleanup.cleanup_kind='ROUTING_INTEGRATION_SECRET' AND cleanup.state='QUEUED' AND cleanup.attempts=0
  AND integration.provider='NOTION' AND cleanup.secret_reference<>integration.secret_reference;

CREATE OR REPLACE FUNCTION app.begin_client_routing_notion_oauth(
  requested_by uuid, state_hash text, requested_redirect_uri text, requested_integration_id uuid
)
RETURNS TABLE(integration_id uuid, secret_reference text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();
DECLARE selected public.client_routing_integrations%ROWTYPE;
DECLARE created_id uuid;
BEGIN
  IF state_hash IS NULL OR state_hash!~'^[0-9a-f]{64}$' OR requested_redirect_uri IS NULL
     OR length(requested_redirect_uri) NOT BETWEEN 8 AND 2048 THEN
    RAISE EXCEPTION 'routing OAuth request is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships AS membership
    WHERE membership.tenant_id=current_tenant AND membership.user_id=requested_by
      AND membership.role IN ('tenant_owner','tenant_admin') AND membership.state='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
  END IF;

  IF requested_integration_id IS NOT NULL THEN
    SELECT * INTO selected FROM public.client_routing_integrations AS integration
      WHERE integration.tenant_id=current_tenant AND integration.id=requested_integration_id
        AND integration.provider='NOTION' FOR NO KEY UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Notion connection was not found' USING ERRCODE='23503'; END IF;
  END IF;

  -- A revoked reference can already have a cleanup lease and cannot be reused.
  IF selected.id IS NULL OR selected.state='REVOKED' OR (
    selected.state='CONNECTING' AND EXISTS (
      SELECT 1 FROM public.secret_cleanup_outbox AS cleanup
      WHERE cleanup.tenant_id=current_tenant AND cleanup.routing_integration_id=selected.id
        AND cleanup.cleanup_kind='ROUTING_INTEGRATION_SECRET' AND cleanup.attempts>0
    )
  ) THEN
    created_id:=gen_random_uuid();
    INSERT INTO public.client_routing_integrations(id,tenant_id,provider,display_name,secret_reference,created_by)
      VALUES(created_id,current_tenant,'NOTION','Notion workspace',
        'secret://tenants/'||current_tenant::text||'/routing/integrations/'||created_id::text,requested_by)
      RETURNING * INTO selected;
  ELSE
    IF selected.created_by IS DISTINCT FROM requested_by THEN
      RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
    END IF;
    DELETE FROM public.client_routing_oauth_states AS oauth
      WHERE oauth.tenant_id=current_tenant AND oauth.integration_id=selected.id;
    UPDATE public.client_routing_integrations AS integration SET updated_at=now()
      WHERE integration.tenant_id=current_tenant AND integration.id=selected.id;
  END IF;

  INSERT INTO public.client_routing_oauth_states(tenant_id,integration_id,provider,requested_by,state_sha256,redirect_uri,expires_at)
    VALUES(current_tenant,selected.id,'NOTION',requested_by,state_hash,requested_redirect_uri,now()+interval '10 minutes');
  RETURN QUERY SELECT selected.id,selected.secret_reference;
END
$$;

CREATE FUNCTION app.read_client_routing_notion_oauth(state_hash text, requested_by uuid)
RETURNS TABLE(integration_id uuid, status text, display_name text, external_account_id text, revision bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();
DECLARE selected public.client_routing_integrations%ROWTYPE;
BEGIN
  SELECT integration.* INTO selected
  FROM public.client_routing_integrations AS integration
  JOIN public.client_routing_oauth_states AS oauth
    ON oauth.tenant_id=integration.tenant_id AND oauth.integration_id=integration.id
  WHERE integration.tenant_id=current_tenant AND integration.provider='NOTION'
    AND oauth.provider='NOTION' AND oauth.state_sha256=state_hash
    AND oauth.requested_by=read_client_routing_notion_oauth.requested_by
  FOR NO KEY UPDATE OF integration;
  IF NOT FOUND THEN RETURN; END IF;

  -- Recheck the latest binding after taking the lock, including pre-upgrade attempts.
  RETURN QUERY
    SELECT selected.id,CASE
      WHEN oauth.outcome='CONNECTED' AND selected.state='CONNECTED' THEN 'COMMITTED'
      WHEN oauth.outcome='ABORTED' OR (selected.state='REVOKED' AND selected.external_account_id IS NULL) THEN 'ABORTED'
      WHEN oauth.outcome IS NOT NULL OR selected.state='REVOKED' THEN 'UNRESOLVED'
      WHEN selected.created_by IS DISTINCT FROM oauth.requested_by THEN 'UNRESOLVED'
      WHEN selected.state='CONNECTING' AND EXISTS (
        SELECT 1 FROM public.secret_cleanup_outbox AS cleanup
        WHERE cleanup.tenant_id=current_tenant AND cleanup.routing_integration_id=selected.id
          AND cleanup.cleanup_kind='ROUTING_INTEGRATION_SECRET' AND cleanup.attempts>0
      ) THEN 'UNRESOLVED'
      WHEN oauth.consumed_at IS NOT NULL THEN 'CLAIMED'
      WHEN oauth.expires_at>now() THEN 'PENDING'
      ELSE 'EXPIRED'
    END,selected.display_name,selected.external_account_id,selected.revision
    FROM (
      SELECT * FROM public.client_routing_oauth_states AS latest
      WHERE latest.tenant_id=current_tenant AND latest.integration_id=selected.id AND latest.provider='NOTION'
      ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1
    ) AS oauth
    WHERE oauth.state_sha256=state_hash AND oauth.requested_by=read_client_routing_notion_oauth.requested_by;
END
$$;

CREATE FUNCTION app.claim_current_client_routing_notion_oauth(state_hash text, requested_by uuid)
RETURNS TABLE(integration_id uuid, secret_reference text, redirect_uri text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();
DECLARE attempt record;
BEGIN
  SELECT * INTO attempt FROM app.read_client_routing_notion_oauth(state_hash,requested_by);
  IF NOT FOUND OR attempt.status<>'PENDING' THEN RETURN; END IF;

  RETURN QUERY UPDATE public.client_routing_oauth_states AS oauth SET consumed_at=now()
    FROM public.client_routing_integrations AS integration
    WHERE oauth.tenant_id=current_tenant AND oauth.state_sha256=state_hash
      AND integration.tenant_id=current_tenant AND integration.id=attempt.integration_id
    RETURNING integration.id,integration.secret_reference,oauth.redirect_uri;
END
$$;

CREATE FUNCTION app.complete_claimed_client_routing_notion_oauth(
  state_hash text, requested_by uuid, workspace_name text, workspace_id text
)
RETURNS TABLE(integration_id uuid, display_name text, revision bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();
DECLARE attempt record;
BEGIN
  IF length(trim(workspace_name)) NOT BETWEEN 1 AND 160 OR length(workspace_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Notion workspace identity is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO attempt FROM app.read_client_routing_notion_oauth(state_hash,requested_by);
  IF NOT FOUND OR attempt.status<>'CLAIMED'
     OR (attempt.external_account_id IS NOT NULL AND attempt.external_account_id IS DISTINCT FROM workspace_id)
  THEN RETURN; END IF;

  UPDATE public.client_routing_oauth_states AS oauth SET outcome='CONNECTED'
    WHERE oauth.tenant_id=current_tenant AND oauth.state_sha256=state_hash;
  RETURN QUERY UPDATE public.client_routing_integrations AS integration
    SET display_name=trim(workspace_name),external_account_id=workspace_id,
        state='CONNECTED',revision=integration.revision+1,updated_at=now()
    WHERE integration.tenant_id=current_tenant AND integration.id=attempt.integration_id
    RETURNING integration.id,integration.display_name,integration.revision;
END
$$;

CREATE OR REPLACE FUNCTION app.abort_client_routing_notion_oauth(state_hash text, requested_by uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();
DECLARE attempt record;
BEGIN
  SELECT * INTO attempt FROM app.read_client_routing_notion_oauth(state_hash,requested_by);
  IF NOT FOUND OR attempt.status NOT IN ('CLAIMED','PENDING','EXPIRED') THEN RETURN NULL; END IF;

  UPDATE public.client_routing_oauth_states AS oauth
    SET outcome='ABORTED',consumed_at=COALESCE(oauth.consumed_at,now())
    WHERE oauth.tenant_id=current_tenant AND oauth.state_sha256=state_hash;
  IF attempt.external_account_id IS NULL THEN
    UPDATE public.client_routing_integrations AS integration
      SET state='REVOKED',revision=integration.revision+1,updated_at=now()
      WHERE integration.tenant_id=current_tenant AND integration.id=attempt.integration_id
        AND integration.state='CONNECTING';
  END IF;
  RETURN attempt.integration_id;
END
$$;

-- A legacy reconnect could have moved an already activated credential to CONNECTING.
-- Expiring that attempt must never make the old reference eligible for deletion.
CREATE FUNCTION app.retain_committed_notion_oauth_reference()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
  RETURN NULL;
END
$$;
CREATE TRIGGER retain_committed_notion_oauth_reference
BEFORE UPDATE OF state ON public.client_routing_integrations FOR EACH ROW
WHEN (OLD.provider='NOTION' AND OLD.state='CONNECTING' AND OLD.external_account_id IS NOT NULL AND NEW.state='REVOKED')
EXECUTE FUNCTION app.retain_committed_notion_oauth_reference();

REVOKE ALL ON FUNCTION app.read_client_routing_notion_oauth(text,uuid),
  app.claim_current_client_routing_notion_oauth(text,uuid),
  app.complete_claimed_client_routing_notion_oauth(text,uuid,text,text),
  app.retain_committed_notion_oauth_reference() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_client_routing_notion_oauth(text,uuid),
  app.claim_current_client_routing_notion_oauth(text,uuid),
  app.complete_claimed_client_routing_notion_oauth(text,uuid,text,text) TO wasalx_app;
