-- Reconnect retains the existing revision-fenced replacement protocol.
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
    IF NOT FOUND OR replaced.provider<>requested_provider OR replaced.state NOT IN ('CONNECTED','CONNECTING','REVOKED')
       OR expected_replaces_revision IS NULL OR replaced.revision<>expected_replaces_revision THEN
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
       AND integration.state IN ('CONNECTED','CONNECTING','REVOKED')
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

