CREATE TABLE bot_flow_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (
    length(btrim(name)) BETWEEN 1 AND 160
    AND name=btrim(name)
    AND name !~ '[[:cntrl:]]'
  ),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,name),
  UNIQUE (tenant_id,id)
);

CREATE TABLE bot_flow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  version integer NOT NULL CHECK (version>0),
  state text NOT NULL CHECK (state IN ('DRAFT','ACTIVE','RETIRED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  definition jsonb NOT NULL CHECK (
    jsonb_typeof(definition)='object'
    AND definition->>'schemaVersion'='1'
    AND jsonb_typeof(definition->'nodes')='array'
    AND jsonb_array_length(definition->'nodes') BETWEEN 1 AND 100
    AND octet_length(definition::text)<=1000000
  ),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  supersedes_flow_version_id uuid,
  created_by uuid NOT NULL REFERENCES users(id),
  activated_by uuid REFERENCES users(id),
  retired_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retired_at timestamptz,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,family_id,version),
  FOREIGN KEY (tenant_id,family_id)
    REFERENCES bot_flow_families(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,supersedes_flow_version_id)
    REFERENCES bot_flow_versions(tenant_id,id),
  CHECK (
    (state='DRAFT' AND activated_at IS NULL AND activated_by IS NULL AND retired_at IS NULL AND retired_by IS NULL)
    OR (state='ACTIVE' AND activated_at IS NOT NULL AND activated_by IS NOT NULL AND retired_at IS NULL AND retired_by IS NULL)
    OR (state='RETIRED' AND activated_at IS NOT NULL AND activated_by IS NOT NULL AND retired_at IS NOT NULL AND retired_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX bot_flow_versions_one_active
  ON bot_flow_versions (tenant_id,family_id)
  WHERE state='ACTIVE';

CREATE TABLE bot_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  flow_family_id uuid NOT NULL,
  flow_version_id uuid NOT NULL,
  zammad_group_id text NOT NULL CHECK (
    length(btrim(zammad_group_id)) BETWEEN 1 AND 80
    AND zammad_group_id=btrim(zammad_group_id)
    AND zammad_group_id !~ '[[:cntrl:]]'
  ),
  state text NOT NULL CHECK (state IN ('ACTIVE','PAUSED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,connection_id),
  FOREIGN KEY (tenant_id,connection_id)
    REFERENCES connections(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,flow_family_id)
    REFERENCES bot_flow_families(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,flow_version_id)
    REFERENCES bot_flow_versions(tenant_id,id)
);

CREATE TABLE bot_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  flow_version_id uuid NOT NULL,
  external_chat_id text NOT NULL CHECK (
    length(external_chat_id) BETWEEN 3 AND 512
    AND external_chat_id !~ '[[:cntrl:][:space:]]'
  ),
  state text NOT NULL CHECK (state IN ('BOT','HANDOFF_PENDING','HUMAN','RESOLVED')),
  current_node_id text NOT NULL CHECK (current_node_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  variables jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(variables)='object' AND octet_length(variables::text)<=65536
  ),
  step_count integer NOT NULL DEFAULT 0 CHECK (step_count BETWEEN 0 AND 100),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token>=0),
  zammad_ticket_id text,
  zammad_ticket_number text,
  last_external_message_id text,
  last_activity_at timestamptz NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,assignment_id,external_chat_id),
  FOREIGN KEY (tenant_id,assignment_id)
    REFERENCES bot_assignments(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,connection_id)
    REFERENCES connections(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,flow_version_id)
    REFERENCES bot_flow_versions(tenant_id,id),
  CHECK (
    (state='RESOLVED' AND resolved_at IS NOT NULL)
    OR (state<>'RESOLVED' AND resolved_at IS NULL)
  )
);

CREATE INDEX bot_conversations_active_lookup
  ON bot_conversations (tenant_id,connection_id,external_chat_id,last_activity_at DESC)
  WHERE state<>'RESOLVED';

CREATE TABLE bot_conversation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  event_inbox_id uuid,
  event_kind text NOT NULL CHECK (event_kind IN (
    'STARTED','MESSAGE','CHOICE','LOCATION','ACTION_SUCCEEDED','ACTION_FAILED',
    'HANDOFF_REQUESTED','HANDOFF_COMPLETED','RESUMED','RESOLVED'
  )),
  from_node_id text,
  to_node_id text,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(safe_metadata)='object' AND octet_length(safe_metadata::text)<=8192
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,event_inbox_id),
  FOREIGN KEY (tenant_id,conversation_id)
    REFERENCES bot_conversations(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,event_inbox_id)
    REFERENCES event_inbox(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE bot_flow_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('CREATE','CLONE','ACTIVATE','ASSIGN')),
  idempotency_key text NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 255
    AND idempotency_key=btrim(idempotency_key)
    AND idempotency_key !~ '[[:cntrl:][:space:]]'
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  requested_by uuid NOT NULL REFERENCES users(id),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 255 AND request_id !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,idempotency_key)
);

CREATE OR REPLACE FUNCTION app.create_bot_flow_family(
  requested_name text,
  requested_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app
AS $$
DECLARE current_tenant uuid;
DECLARE created_id uuid;
BEGIN
  current_tenant:=app.current_tenant_id();
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships
     WHERE tenant_id=current_tenant AND user_id=requested_by
       AND role IN ('tenant_owner','tenant_admin')
  ) THEN
    RAISE EXCEPTION 'bot flow actor is not authorized' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.bot_flow_families (tenant_id,name,created_by)
  VALUES (current_tenant,requested_name,requested_by)
  RETURNING id INTO created_id;
  RETURN created_id;
END
$$;

CREATE OR REPLACE FUNCTION app.create_bot_flow_version(
  requested_family_id uuid,
  requested_definition jsonb,
  requested_supersedes_id uuid,
  requested_by uuid
)
RETURNS TABLE (
  id uuid,
  version integer,
  state text,
  revision bigint,
  snapshot_sha256 text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app
AS $$
DECLARE current_tenant uuid;
DECLARE created public.bot_flow_versions%ROWTYPE;
DECLARE next_version integer;
BEGIN
  current_tenant:=app.current_tenant_id();
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships
     WHERE tenant_id=current_tenant AND user_id=requested_by
       AND role IN ('tenant_owner','tenant_admin')
  ) THEN
    RAISE EXCEPTION 'bot flow actor is not authorized' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.bot_flow_families AS family
   WHERE family.tenant_id=current_tenant AND family.id=requested_family_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bot flow family was not found' USING ERRCODE='23503';
  END IF;
  IF requested_supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.bot_flow_versions AS source
     WHERE source.tenant_id=current_tenant AND source.family_id=requested_family_id
       AND source.id=requested_supersedes_id
  ) THEN
    RAISE EXCEPTION 'bot flow source version was not found' USING ERRCODE='23503';
  END IF;
  SELECT COALESCE(max(flow.version),0)+1 INTO next_version
    FROM public.bot_flow_versions flow
   WHERE flow.tenant_id=current_tenant AND flow.family_id=requested_family_id;
  INSERT INTO public.bot_flow_versions (
    tenant_id,family_id,version,state,definition,snapshot_sha256,
    supersedes_flow_version_id,created_by
  ) VALUES (
    current_tenant,requested_family_id,next_version,'DRAFT',requested_definition,
    encode(public.digest(requested_definition::text,'sha256'),'hex'),
    requested_supersedes_id,requested_by
  ) RETURNING * INTO created;
  RETURN QUERY SELECT created.id,created.version,created.state,created.revision,created.snapshot_sha256;
END
$$;

CREATE OR REPLACE FUNCTION app.activate_bot_flow_version(
  requested_flow_version_id uuid,
  expected_revision bigint,
  expected_active_flow_version_id uuid,
  requested_by uuid
)
RETURNS TABLE (
  active_flow_version_id uuid,
  retired_flow_version_id uuid,
  revision bigint,
  assignments_migrated integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app
AS $$
DECLARE current_tenant uuid;
DECLARE target public.bot_flow_versions%ROWTYPE;
DECLARE active public.bot_flow_versions%ROWTYPE;
DECLARE migrated integer;
BEGIN
  current_tenant:=app.current_tenant_id();
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships
     WHERE tenant_id=current_tenant AND user_id=requested_by
       AND role IN ('tenant_owner','tenant_admin')
  ) THEN
    RAISE EXCEPTION 'bot flow actor is not authorized' USING ERRCODE='42501';
  END IF;
  SELECT flow.* INTO target FROM public.bot_flow_versions AS flow
   WHERE flow.tenant_id=current_tenant AND flow.id=requested_flow_version_id
   FOR UPDATE;
  IF NOT FOUND OR target.state<>'DRAFT' OR target.revision<>expected_revision THEN
    RAISE EXCEPTION 'bot flow draft changed; refresh before activation' USING ERRCODE='40001';
  END IF;
  PERFORM 1 FROM public.bot_flow_families AS family
   WHERE family.tenant_id=current_tenant AND family.id=target.family_id FOR UPDATE;
  SELECT flow.* INTO active FROM public.bot_flow_versions AS flow
   WHERE flow.tenant_id=current_tenant AND flow.family_id=target.family_id AND flow.state='ACTIVE'
   FOR UPDATE;
  IF active.id IS DISTINCT FROM expected_active_flow_version_id THEN
    RAISE EXCEPTION 'active bot flow changed; refresh before activation' USING ERRCODE='40001';
  END IF;
  IF active.id IS NOT NULL THEN
    UPDATE public.bot_flow_versions AS flow
       SET state='RETIRED',revision=flow.revision+1,retired_at=now(),retired_by=requested_by
     WHERE flow.tenant_id=current_tenant AND flow.id=active.id;
  END IF;
  UPDATE public.bot_flow_versions AS flow
     SET state='ACTIVE',revision=flow.revision+1,activated_at=now(),activated_by=requested_by
   WHERE flow.tenant_id=current_tenant AND flow.id=target.id
   RETURNING flow.revision INTO target.revision;
  UPDATE public.bot_assignments AS assignment
     SET flow_version_id=target.id,revision=assignment.revision+1,updated_at=now(),updated_by=requested_by
   WHERE assignment.tenant_id=current_tenant AND assignment.flow_family_id=target.family_id;
  GET DIAGNOSTICS migrated=ROW_COUNT;
  RETURN QUERY SELECT target.id,active.id,target.revision,migrated;
END
$$;

CREATE OR REPLACE FUNCTION app.assign_bot_flow(
  requested_connection_id uuid,
  requested_family_id uuid,
  requested_zammad_group_id text,
  requested_by uuid
)
RETURNS TABLE (assignment_id uuid,flow_version_id uuid,revision bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app
AS $$
DECLARE current_tenant uuid;
DECLARE active_id uuid;
DECLARE assigned public.bot_assignments%ROWTYPE;
BEGIN
  current_tenant:=app.current_tenant_id();
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships
     WHERE tenant_id=current_tenant AND user_id=requested_by
       AND role IN ('tenant_owner','tenant_admin')
  ) THEN
    RAISE EXCEPTION 'bot assignment actor is not authorized' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.connections AS connection
     WHERE connection.tenant_id=current_tenant AND connection.id=requested_connection_id
       AND connection.state NOT IN ('REVOKED','PAUSED')
  ) THEN
    RAISE EXCEPTION 'bot connection is unavailable' USING ERRCODE='23503';
  END IF;
  SELECT flow.id INTO active_id FROM public.bot_flow_versions AS flow
   WHERE flow.tenant_id=current_tenant AND flow.family_id=requested_family_id AND flow.state='ACTIVE';
  IF active_id IS NULL THEN
    RAISE EXCEPTION 'bot flow has no active version' USING ERRCODE='23503';
  END IF;
  INSERT INTO public.bot_assignments (
    tenant_id,connection_id,flow_family_id,flow_version_id,zammad_group_id,
    state,created_by,updated_by
  ) VALUES (
    current_tenant,requested_connection_id,requested_family_id,active_id,
    requested_zammad_group_id,'ACTIVE',requested_by,requested_by
  ) ON CONFLICT (tenant_id,connection_id) DO UPDATE
    SET flow_family_id=EXCLUDED.flow_family_id,
        flow_version_id=EXCLUDED.flow_version_id,
        zammad_group_id=EXCLUDED.zammad_group_id,
        state='ACTIVE',revision=bot_assignments.revision+1,
        updated_by=EXCLUDED.updated_by,updated_at=now()
  RETURNING * INTO assigned;
  RETURN QUERY SELECT assigned.id,assigned.flow_version_id,assigned.revision;
END
$$;

CREATE OR REPLACE FUNCTION app.enforce_bot_flow_version_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.family_id<>OLD.family_id
     OR NEW.version<>OLD.version OR NEW.definition<>OLD.definition
     OR NEW.snapshot_sha256<>OLD.snapshot_sha256
     OR NEW.supersedes_flow_version_id IS DISTINCT FROM OLD.supersedes_flow_version_id
     OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'bot flow versions are immutable' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD.state='DRAFT' AND NEW.state='ACTIVE') OR (OLD.state='ACTIVE' AND NEW.state='RETIRED'))
     OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'invalid bot flow lifecycle transition' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER bot_flow_versions_immutable
BEFORE UPDATE ON bot_flow_versions
FOR EACH ROW EXECUTE FUNCTION app.enforce_bot_flow_version_immutability();

CREATE OR REPLACE FUNCTION app.reject_bot_conversation_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'bot conversation events are append-only' USING ERRCODE='42501';
END
$$;

CREATE TRIGGER bot_conversation_events_append_only
BEFORE UPDATE OR DELETE ON bot_conversation_events
FOR EACH ROW EXECUTE FUNCTION app.reject_bot_conversation_event_mutation();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'bot_flow_families','bot_flow_versions','bot_assignments',
    'bot_conversations','bot_conversation_events','bot_flow_operations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id())',
      table_name
    );
  END LOOP;
END
$$;

REVOKE INSERT,UPDATE,DELETE ON bot_flow_families,bot_flow_versions FROM wasalx_app;
GRANT SELECT ON bot_flow_families,bot_flow_versions TO wasalx_app;
GRANT SELECT,INSERT ON bot_flow_operations,bot_conversation_events TO wasalx_app;
GRANT SELECT,INSERT,UPDATE ON bot_assignments,bot_conversations TO wasalx_app;

REVOKE ALL ON FUNCTION app.create_bot_flow_family(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_bot_flow_version(uuid,jsonb,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.activate_bot_flow_version(uuid,bigint,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assign_bot_flow(uuid,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_bot_flow_family(text,uuid) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.create_bot_flow_version(uuid,jsonb,uuid,uuid) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.activate_bot_flow_version(uuid,bigint,uuid,uuid) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.assign_bot_flow(uuid,uuid,text,uuid) TO wasalx_app;
