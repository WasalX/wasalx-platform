CREATE TABLE client_routing_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version>0),
  state text NOT NULL CHECK (state IN ('DRAFT','ACTIVE','RETIRED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  definition jsonb NOT NULL CHECK (
    jsonb_typeof(definition)='object'
    AND definition->>'schemaVersion'='1'
    AND jsonb_typeof(definition->'sources')='array'
    AND jsonb_typeof(definition->'clients')='array'
    AND octet_length(definition::text)<=5000000
  ),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  activated_by uuid REFERENCES users(id),
  retired_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retired_at timestamptz,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,version),
  CHECK (
    (state='DRAFT' AND activated_at IS NULL AND activated_by IS NULL AND retired_at IS NULL AND retired_by IS NULL)
    OR (state='ACTIVE' AND activated_at IS NOT NULL AND activated_by IS NOT NULL AND retired_at IS NULL AND retired_by IS NULL)
    OR (state='RETIRED' AND activated_at IS NOT NULL AND activated_by IS NOT NULL AND retired_at IS NOT NULL AND retired_by IS NOT NULL)
  )
);

ALTER TABLE bot_flow_operations DROP CONSTRAINT bot_flow_operations_action_check;
ALTER TABLE bot_flow_operations ADD CONSTRAINT bot_flow_operations_action_check
  CHECK (action IN ('CREATE','CLONE','ACTIVATE','ASSIGN','CONVERSATION_COMMAND','ROUTING_CREATE','ROUTING_ACTIVATE'));

CREATE UNIQUE INDEX client_routing_versions_one_active
  ON client_routing_versions (tenant_id)
  WHERE state='ACTIVE';

CREATE TABLE client_routing_matchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  routing_version_id uuid NOT NULL,
  source_id text NOT NULL CHECK (source_id ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  client_id text NOT NULL CHECK (client_id ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  client_name text NOT NULL CHECK (length(client_name) BETWEEN 1 AND 160 AND client_name !~ '[[:cntrl:]]'),
  zammad_group_id text NOT NULL CHECK (length(zammad_group_id) BETWEEN 1 AND 80 AND zammad_group_id !~ '[[:cntrl:][:space:]]'),
  owner_id text CHECK (owner_id IS NULL OR length(owner_id) BETWEEN 1 AND 80),
  escalation_group_id text CHECK (escalation_group_id IS NULL OR length(escalation_group_id) BETWEEN 1 AND 80),
  escalation_owner_id text CHECK (escalation_owner_id IS NULL OR length(escalation_owner_id) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('WHATSAPP_GROUP','CLIENT_IDENTIFIER','EMAIL','DOMAIN')),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 512 AND value !~ '[[:cntrl:]]'),
  namespace text CHECK (namespace IS NULL OR length(namespace) BETWEEN 1 AND 80),
  connection_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,routing_version_id)
    REFERENCES client_routing_versions(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,connection_id)
    REFERENCES connections(tenant_id,id),
  CHECK ((kind='WHATSAPP_GROUP' AND connection_id IS NOT NULL) OR (kind<>'WHATSAPP_GROUP' AND connection_id IS NULL)),
  CHECK ((kind='CLIENT_IDENTIFIER' AND namespace IS NOT NULL) OR (kind<>'CLIENT_IDENTIFIER' AND namespace IS NULL))
);

CREATE UNIQUE INDEX client_routing_matchers_one_owner
  ON client_routing_matchers (
    tenant_id,routing_version_id,kind,
    COALESCE(connection_id,'00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(namespace,''),value
  );

CREATE INDEX client_routing_matchers_lookup
  ON client_routing_matchers (tenant_id,routing_version_id,kind,value,namespace,connection_id);

CREATE OR REPLACE FUNCTION app.create_client_routing_version(
  requested_definition jsonb,
  requested_by uuid
)
RETURNS TABLE (id uuid,version integer,state text,revision bigint,snapshot_sha256 text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app
AS $$
DECLARE current_tenant uuid;
DECLARE created public.client_routing_versions%ROWTYPE;
DECLARE next_version integer;
BEGIN
  current_tenant:=app.current_tenant_id();
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships
     WHERE tenant_id=current_tenant AND user_id=requested_by
       AND role IN ('tenant_owner','tenant_admin')
  ) THEN
    RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('client-routing:'||current_tenant::text,0));
  SELECT COALESCE(max(routing.version),0)+1 INTO next_version
    FROM public.client_routing_versions routing
   WHERE routing.tenant_id=current_tenant;
  INSERT INTO public.client_routing_versions (
    tenant_id,version,state,definition,snapshot_sha256,created_by
  ) VALUES (
    current_tenant,next_version,'DRAFT',requested_definition,
    encode(public.digest(requested_definition::text,'sha256'),'hex'),requested_by
  ) RETURNING * INTO created;
  INSERT INTO public.client_routing_matchers (
    tenant_id,routing_version_id,source_id,client_id,client_name,zammad_group_id,
    owner_id,escalation_group_id,escalation_owner_id,kind,value,namespace,connection_id
  )
  SELECT current_tenant,created.id,matcher->>'sourceId',client->>'id',client->>'name',client->>'zammadGroupId',
         NULLIF(client->>'ownerId',''),NULLIF(client->>'escalationGroupId',''),NULLIF(client->>'escalationOwnerId',''),
         matcher->>'kind',matcher->>'value',NULLIF(matcher->>'namespace',''),NULLIF(matcher->>'connectionId','')::uuid
    FROM jsonb_array_elements(requested_definition->'clients') client
    CROSS JOIN LATERAL jsonb_array_elements(client->'matchers') matcher;
  RETURN QUERY SELECT created.id,created.version,created.state,created.revision,created.snapshot_sha256;
END
$$;

CREATE OR REPLACE FUNCTION app.activate_client_routing_version(
  requested_version_id uuid,
  expected_revision bigint,
  expected_active_version_id uuid,
  requested_by uuid
)
RETURNS TABLE (active_version_id uuid,retired_version_id uuid,revision bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app
AS $$
DECLARE current_tenant uuid;
DECLARE target public.client_routing_versions%ROWTYPE;
DECLARE active public.client_routing_versions%ROWTYPE;
BEGIN
  current_tenant:=app.current_tenant_id();
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships
     WHERE tenant_id=current_tenant AND user_id=requested_by
       AND role IN ('tenant_owner','tenant_admin')
  ) THEN
    RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('client-routing:'||current_tenant::text,0));
  SELECT routing.* INTO target FROM public.client_routing_versions routing
   WHERE routing.tenant_id=current_tenant AND routing.id=requested_version_id FOR UPDATE;
  IF NOT FOUND OR target.state<>'DRAFT' OR target.revision<>expected_revision THEN
    RAISE EXCEPTION 'client routing draft changed; refresh before activation' USING ERRCODE='40001';
  END IF;
  SELECT routing.* INTO active FROM public.client_routing_versions routing
   WHERE routing.tenant_id=current_tenant AND routing.state='ACTIVE' FOR UPDATE;
  IF active.id IS DISTINCT FROM expected_active_version_id THEN
    RAISE EXCEPTION 'active client routing changed; refresh before activation' USING ERRCODE='40001';
  END IF;
  IF active.id IS NOT NULL THEN
    UPDATE public.client_routing_versions routing
       SET state='RETIRED',revision=routing.revision+1,retired_at=now(),retired_by=requested_by
     WHERE routing.tenant_id=current_tenant AND routing.id=active.id;
  END IF;
  UPDATE public.client_routing_versions routing
     SET state='ACTIVE',revision=routing.revision+1,activated_at=now(),activated_by=requested_by
   WHERE routing.tenant_id=current_tenant AND routing.id=target.id
   RETURNING routing.revision INTO target.revision;
  RETURN QUERY SELECT target.id,active.id,target.revision;
END
$$;

CREATE OR REPLACE FUNCTION app.enforce_client_routing_version_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.version<>OLD.version OR NEW.definition<>OLD.definition
     OR NEW.snapshot_sha256<>OLD.snapshot_sha256 OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'client routing versions are immutable' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD.state='DRAFT' AND NEW.state='ACTIVE') OR (OLD.state='ACTIVE' AND NEW.state='RETIRED'))
     OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'invalid client routing lifecycle transition' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER client_routing_versions_immutable
BEFORE UPDATE ON client_routing_versions
FOR EACH ROW EXECUTE FUNCTION app.enforce_client_routing_version_immutability();

ALTER TABLE client_routing_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_routing_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_routing_versions
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());
ALTER TABLE client_routing_matchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_routing_matchers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_routing_matchers
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());

REVOKE INSERT,UPDATE,DELETE ON client_routing_versions,client_routing_matchers FROM wasalx_app;
GRANT SELECT ON client_routing_versions,client_routing_matchers TO wasalx_app;
REVOKE ALL ON FUNCTION app.create_client_routing_version(jsonb,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.activate_client_routing_version(uuid,bigint,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_client_routing_version(jsonb,uuid) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.activate_client_routing_version(uuid,bigint,uuid,uuid) TO wasalx_app;
