-- Immutable rule snapshots, replay-safe governance operations, and genuine
-- match observations. A rule-set row is one immutable version; edits and
-- rollback always create a new row and new trigger-rule rows.

CREATE TABLE rule_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (
    length(btrim(name)) BETWEEN 1 AND 160
    AND name=btrim(name)
    AND name !~ '[[:cntrl:]]'
  ),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,name),
  UNIQUE (tenant_id,id)
);

INSERT INTO rule_families (tenant_id,name,created_by,created_at)
SELECT DISTINCT ON (tenant_id,name)
       tenant_id,name,created_by,created_at
  FROM rule_sets
 ORDER BY tenant_id,name,version,id;

ALTER TABLE rule_sets
  ADD COLUMN family_id uuid,
  ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN snapshot_sha256 text,
  ADD COLUMN supersedes_rule_set_id uuid,
  ADD COLUMN rollback_source_rule_set_id uuid,
  ADD COLUMN activated_by uuid REFERENCES users(id),
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN retired_by uuid REFERENCES users(id);

UPDATE rule_sets AS rule_set
   SET family_id=family.id
  FROM rule_families AS family
 WHERE family.tenant_id=rule_set.tenant_id
   AND family.name=rule_set.name;

UPDATE rule_sets AS rule_set
   SET snapshot_sha256=encode(digest(COALESCE((
     SELECT jsonb_agg(jsonb_build_object(
       'name',rule.name,
       'matcherType',rule.matcher_type,
       'pattern',rule.pattern,
       'matcherOptions',rule.matcher_options,
       'priority',rule.priority,
       'enabled',rule.enabled,
       'savedExamples',rule.saved_examples
     ) ORDER BY rule.priority,rule.id)::text
       FROM trigger_rules AS rule
      WHERE rule.tenant_id=rule_set.tenant_id
        AND rule.rule_set_id=rule_set.id
   ),'[]'),'sha256'),'hex');

ALTER TABLE rule_sets
  ALTER COLUMN family_id SET NOT NULL,
  ALTER COLUMN snapshot_sha256 SET NOT NULL,
  ADD CONSTRAINT rule_sets_snapshot_sha256_check
    CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT rule_sets_family_fk
    FOREIGN KEY (tenant_id,family_id) REFERENCES rule_families(tenant_id,id) ON DELETE CASCADE,
  ADD UNIQUE (tenant_id,id),
  ADD UNIQUE (tenant_id,family_id,version);

-- Add self-referencing lineage only after the composite tenant key exists.
-- This makes the FK valid on every supported PostgreSQL release and prevents
-- a lineage edge from pointing at another tenant's globally unique row.
ALTER TABLE rule_sets
  ADD CONSTRAINT rule_sets_supersedes_fk
    FOREIGN KEY (tenant_id,supersedes_rule_set_id)
      REFERENCES rule_sets(tenant_id,id),
  ADD CONSTRAINT rule_sets_rollback_source_fk
    FOREIGN KEY (tenant_id,rollback_source_rule_set_id)
      REFERENCES rule_sets(tenant_id,id);

-- Older retired rows did not capture transition time. Preserve their history
-- without inventing an actor identity.
UPDATE rule_sets
   SET retired_at=COALESCE(activated_at,created_at)
 WHERE state='RETIRED' AND retired_at IS NULL;

-- Older active rows may not have an activation timestamp. Their creation time
-- is the only truthful lower bound available during migration.
UPDATE rule_sets
   SET activated_at=created_at
 WHERE state IN ('ACTIVE','RETIRED') AND activated_at IS NULL;

ALTER TABLE rule_sets
  ADD CONSTRAINT rule_sets_retirement_shape CHECK (
    (state='RETIRED' AND retired_at IS NOT NULL)
    OR (state<>'RETIRED' AND retired_at IS NULL AND retired_by IS NULL)
  ),
  ADD CONSTRAINT rule_sets_activation_shape CHECK (
    (state='DRAFT' AND activated_at IS NULL AND activated_by IS NULL)
    OR (state IN ('ACTIVE','RETIRED') AND activated_at IS NOT NULL)
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM rule_sets
     WHERE state='ACTIVE'
     GROUP BY tenant_id,family_id
    HAVING count(*)>1
  ) THEN
    RAISE EXCEPTION 'rule governance migration found multiple active versions in one family';
  END IF;
END
$$;

CREATE UNIQUE INDEX rule_sets_one_active_family_version
  ON rule_sets (tenant_id,family_id)
  WHERE state='ACTIVE';
CREATE INDEX rule_sets_family_history_idx
  ON rule_sets (tenant_id,family_id,version DESC);

ALTER TABLE trigger_rules
  ADD CONSTRAINT trigger_rules_tenant_id_unique UNIQUE (tenant_id,id),
  ADD CONSTRAINT trigger_rules_snapshot_identity_unique
    UNIQUE (tenant_id,rule_set_id,id),
  ADD CONSTRAINT trigger_rules_name_shape CHECK (
    length(btrim(name)) BETWEEN 1 AND 160
    AND name=btrim(name)
    AND name !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT trigger_rules_pattern_shape CHECK (
    length(btrim(pattern)) BETWEEN 1 AND 240
    AND pattern=btrim(pattern)
    AND pattern !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT trigger_rules_priority_range CHECK (priority BETWEEN 1 AND 10000),
  ADD CONSTRAINT trigger_rules_options_shape CHECK (
    jsonb_typeof(matcher_options)='object'
    AND octet_length(matcher_options::text)<=4096
  ),
  ADD CONSTRAINT trigger_rules_examples_shape CHECK (
    jsonb_typeof(saved_examples)='array'
    AND jsonb_array_length(saved_examples)<=50
    AND octet_length(saved_examples::text)<=60000
  );
CREATE UNIQUE INDEX trigger_rules_snapshot_name_unique
  ON trigger_rules (tenant_id,rule_set_id,lower(name));
ALTER TABLE event_inbox
  ADD COLUMN governing_rule_set_id uuid;
ALTER TABLE event_inbox
  ADD CONSTRAINT event_inbox_tenant_id_unique UNIQUE (tenant_id,id),
  ADD CONSTRAINT event_inbox_rule_snapshot_identity_unique
    UNIQUE (tenant_id,id,governing_rule_set_id),
  ADD CONSTRAINT event_inbox_governing_rule_set_fk
    FOREIGN KEY (tenant_id,governing_rule_set_id)
      REFERENCES rule_sets(tenant_id,id);
ALTER TABLE group_bindings
  ADD CONSTRAINT group_bindings_tenant_id_unique UNIQUE (tenant_id,id);

CREATE TABLE rule_set_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('CREATE','CLONE','ACTIVATE','ROLLBACK')),
  idempotency_key text NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 255
    AND idempotency_key=btrim(idempotency_key)
    AND idempotency_key !~ '[[:cntrl:][:space:]]'
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  source_rule_set_id uuid,
  result_rule_set_id uuid,
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  requested_by uuid NOT NULL REFERENCES users(id),
  request_id text NOT NULL CHECK (
    length(request_id) BETWEEN 1 AND 255 AND request_id !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,source_rule_set_id)
    REFERENCES rule_sets(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,result_rule_set_id)
    REFERENCES rule_sets(tenant_id,id) ON DELETE CASCADE
);

-- One row per evaluated event and enabled rule. The unique key makes worker
-- retries idempotent and the table intentionally stores counts, never message
-- bodies or matched identifiers.
CREATE TABLE rule_match_observations (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_inbox_id uuid NOT NULL,
  group_binding_id uuid NOT NULL,
  rule_set_id uuid NOT NULL,
  trigger_rule_id uuid NOT NULL,
  matched_reference_count integer NOT NULL
    CHECK (matched_reference_count BETWEEN 0 AND 2000),
  evaluated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,event_inbox_id,trigger_rule_id),
  FOREIGN KEY (tenant_id,event_inbox_id,rule_set_id)
    REFERENCES event_inbox(tenant_id,id,governing_rule_set_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,group_binding_id)
    REFERENCES group_bindings(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,rule_set_id)
    REFERENCES rule_sets(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,rule_set_id,trigger_rule_id)
    REFERENCES trigger_rules(tenant_id,rule_set_id,id) ON DELETE CASCADE
);

CREATE INDEX rule_match_observations_set_time_idx
  ON rule_match_observations (tenant_id,rule_set_id,evaluated_at DESC);
CREATE INDEX rule_match_observations_rule_time_idx
  ON rule_match_observations (tenant_id,trigger_rule_id,evaluated_at DESC);

-- Snapshot creation is a sealed database operation.  The ordinary runtime
-- role cannot append another trigger after the function returns, even if the
-- snapshot remains a draft.  Both functions derive tenant_id from the forced
-- tenant context and verify that the actor currently has rule-write authority.
CREATE OR REPLACE FUNCTION app.create_rule_family(
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
  current_tenant := app.current_tenant_id();
  IF NOT EXISTS (
    SELECT 1
      FROM public.tenant_memberships
     WHERE tenant_id=current_tenant
       AND user_id=requested_by
       AND role IN ('tenant_owner','tenant_admin')
  ) THEN
    RAISE EXCEPTION 'rule family actor is not authorized'
      USING ERRCODE='42501';
  END IF;

  INSERT INTO public.rule_families (tenant_id,name,created_by)
  VALUES (current_tenant,requested_name,requested_by)
  RETURNING id INTO created_id;
  RETURN created_id;
END;
$$;

CREATE OR REPLACE FUNCTION app.create_rule_set_snapshot(
  requested_family_id uuid,
  requested_name text,
  requested_version integer,
  requested_supersedes_rule_set_id uuid,
  requested_rollback_source_rule_set_id uuid,
  requested_by uuid,
  requested_rules jsonb
)
RETURNS TABLE (
  id uuid,
  family_id uuid,
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
DECLARE created_set public.rule_sets%ROWTYPE;
DECLARE requested_rule jsonb;
BEGIN
  current_tenant := app.current_tenant_id();
  IF NOT EXISTS (
    SELECT 1
      FROM public.tenant_memberships
     WHERE tenant_id=current_tenant
       AND user_id=requested_by
       AND role IN ('tenant_owner','tenant_admin')
  ) THEN
    RAISE EXCEPTION 'rule snapshot actor is not authorized'
      USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.rule_families
     WHERE tenant_id=current_tenant
       AND id=requested_family_id
       AND name=requested_name
  ) THEN
    RAISE EXCEPTION 'rule family was not found in the tenant'
      USING ERRCODE='23503';
  END IF;
  IF jsonb_typeof(requested_rules)<>'array'
     OR jsonb_array_length(requested_rules) NOT BETWEEN 1 AND 100
     OR octet_length(requested_rules::text)>6000000 THEN
    RAISE EXCEPTION 'a rule snapshot must contain between 1 and 100 rules'
      USING ERRCODE='22023';
  END IF;

  INSERT INTO public.rule_sets (
    tenant_id,family_id,name,version,state,revision,snapshot_sha256,
    supersedes_rule_set_id,rollback_source_rule_set_id,created_by
  ) VALUES (
    current_tenant,requested_family_id,requested_name,requested_version,
    'DRAFT',1,encode(public.digest(requested_rules::text,'sha256'),'hex'),
    requested_supersedes_rule_set_id,requested_rollback_source_rule_set_id,
    requested_by
  ) RETURNING * INTO created_set;

  FOR requested_rule IN SELECT value FROM jsonb_array_elements(requested_rules)
  LOOP
    IF jsonb_typeof(requested_rule)<>'object' THEN
      RAISE EXCEPTION 'rule snapshot entries must be objects'
        USING ERRCODE='22023';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM jsonb_object_keys(requested_rule) AS entry(field_name)
       WHERE entry.field_name NOT IN (
         'name','matcherType','pattern','matcherOptions','priority','enabled',
         'savedExamples'
       )
    ) THEN
      RAISE EXCEPTION 'rule snapshot entry contains unsupported fields'
        USING ERRCODE='22023';
    END IF;
    INSERT INTO public.trigger_rules (
      tenant_id,rule_set_id,name,matcher_type,pattern,matcher_options,
      priority,enabled,saved_examples
    ) VALUES (
      current_tenant,created_set.id,requested_rule->>'name',
      requested_rule->>'matcherType',requested_rule->>'pattern',
      COALESCE(requested_rule->'matcherOptions','{}'::jsonb),
      (requested_rule->>'priority')::integer,
      COALESCE((requested_rule->>'enabled')::boolean,true),
      COALESCE(requested_rule->'savedExamples','[]'::jsonb)
    );
  END LOOP;

  RETURN QUERY SELECT created_set.id,created_set.family_id,
    created_set.version,created_set.state,created_set.revision,
    created_set.snapshot_sha256;
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_rule_set_snapshot_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id<>OLD.tenant_id
     OR NEW.family_id<>OLD.family_id
     OR NEW.name<>OLD.name
     OR NEW.version<>OLD.version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at<>OLD.created_at
     OR NEW.snapshot_sha256<>OLD.snapshot_sha256
     OR NEW.supersedes_rule_set_id IS DISTINCT FROM OLD.supersedes_rule_set_id
     OR NEW.rollback_source_rule_set_id IS DISTINCT FROM OLD.rollback_source_rule_set_id THEN
    RAISE EXCEPTION 'rule-set snapshots are immutable' USING ERRCODE='55000';
  END IF;
  IF NOT (
    (OLD.state='DRAFT' AND NEW.state='ACTIVE')
    OR (OLD.state='ACTIVE' AND NEW.state='RETIRED')
  ) THEN
    RAISE EXCEPTION 'invalid rule-set lifecycle transition' USING ERRCODE='55000';
  END IF;
  IF NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'rule-set revision must advance exactly once' USING ERRCODE='40001';
  END IF;
  IF OLD.state='DRAFT' AND (
    NEW.activated_at IS NULL
    OR NEW.activated_by IS NULL
    OR NEW.retired_at IS NOT NULL
    OR NEW.retired_by IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'invalid rule-set activation metadata' USING ERRCODE='55000';
  END IF;
  IF OLD.state='ACTIVE' AND (
    NEW.activated_at IS DISTINCT FROM OLD.activated_at
    OR NEW.activated_by IS DISTINCT FROM OLD.activated_by
    OR NEW.retired_at IS NULL
    OR NEW.retired_at<NEW.activated_at
    OR NEW.retired_by IS NULL
  ) THEN
    RAISE EXCEPTION 'invalid rule-set retirement metadata' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM tenant_memberships
     WHERE tenant_id=OLD.tenant_id
       AND user_id=CASE WHEN OLD.state='DRAFT' THEN NEW.activated_by ELSE NEW.retired_by END
       AND role IN ('tenant_owner','tenant_admin')
  ) THEN
    RAISE EXCEPTION 'rule-set lifecycle actor is not authorized' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rule_sets_immutable_snapshot
BEFORE UPDATE ON rule_sets
FOR EACH ROW EXECUTE FUNCTION app.enforce_rule_set_snapshot_immutability();

CREATE OR REPLACE FUNCTION app.reject_trigger_rule_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'trigger-rule snapshots are immutable; clone a new version'
    USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER trigger_rules_immutable_snapshot
BEFORE UPDATE ON trigger_rules
FOR EACH ROW EXECUTE FUNCTION app.reject_trigger_rule_update();

CREATE OR REPLACE FUNCTION app.enforce_event_rule_snapshot_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.governing_rule_set_id IS NOT NULL
     AND NEW.governing_rule_set_id IS DISTINCT FROM OLD.governing_rule_set_id THEN
    RAISE EXCEPTION 'an inbound event rule snapshot cannot be replaced'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER event_inbox_rule_snapshot_once
BEFORE UPDATE OF governing_rule_set_id ON event_inbox
FOR EACH ROW EXECUTE FUNCTION app.enforce_event_rule_snapshot_once();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'rule_families','rule_set_operations','rule_match_observations'
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

-- Undo the broad migration-era defaults for immutable history. Runtime may
-- create snapshots and lifecycle transitions, but it cannot edit rule content
-- in place or delete governance history.
REVOKE INSERT,UPDATE,DELETE ON trigger_rules FROM wasalx_app;
REVOKE INSERT,UPDATE,DELETE ON rule_families FROM wasalx_app;
REVOKE DELETE ON rule_sets FROM wasalx_app;
REVOKE INSERT,UPDATE ON rule_sets FROM wasalx_app;
GRANT SELECT ON rule_families,trigger_rules,rule_sets TO wasalx_app;
GRANT UPDATE (state,revision,activated_at,activated_by,retired_at,retired_by)
  ON rule_sets TO wasalx_app;
GRANT SELECT,INSERT ON rule_set_operations,rule_match_observations TO wasalx_app;

REVOKE ALL ON FUNCTION app.create_rule_family(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_rule_set_snapshot(uuid,text,integer,uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_rule_family(text,uuid) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.create_rule_set_snapshot(uuid,text,integer,uuid,uuid,uuid,jsonb) TO wasalx_app;
