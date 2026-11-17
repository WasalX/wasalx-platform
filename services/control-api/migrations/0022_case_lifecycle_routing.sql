-- Durable Zammad case lifecycle projection, generation-preserving manual
-- detachment, and routing metadata applied by the connector at ticket create.

ALTER TABLE group_bindings
  ADD COLUMN business_hours_mode text NOT NULL DEFAULT 'ALWAYS'
    CHECK (business_hours_mode IN ('ALWAYS','ZAMMAD_CALENDAR')),
  ADD COLUMN business_hours_calendar_id text CHECK (
    business_hours_calendar_id IS NULL OR (
      length(business_hours_calendar_id) BETWEEN 1 AND 128
      AND business_hours_calendar_id !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT group_bindings_business_hours_configuration CHECK (
    (business_hours_mode='ALWAYS' AND business_hours_calendar_id IS NULL)
    OR (business_hours_mode='ZAMMAD_CALENDAR' AND business_hours_calendar_id IS NOT NULL)
  );

-- The original uniqueness constraint prevented preserving a detached case and
-- starting a new generation for the same group/reference pair. Replace it with
-- one active-generation invariant and a complete immutable generation history.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT constraint_record.conname
    INTO constraint_name
    FROM pg_constraint AS constraint_record
    JOIN pg_class AS table_record ON table_record.oid=constraint_record.conrelid
   WHERE table_record.oid='case_correlations'::regclass
     AND constraint_record.contype='u'
     AND ARRAY(
       SELECT attribute_record.attname::text
         FROM unnest(constraint_record.conkey) WITH ORDINALITY AS key_record(attnum,ordinality)
         JOIN pg_attribute AS attribute_record
           ON attribute_record.attrelid=constraint_record.conrelid
          AND attribute_record.attnum=key_record.attnum
        ORDER BY key_record.ordinality
     )=ARRAY['tenant_id','group_binding_id','normalized_reference']::text[]
   LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE case_correlations DROP CONSTRAINT %I',constraint_name);
  END IF;
END
$$;

ALTER TABLE case_correlations
  ADD COLUMN generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN detached_at timestamptz,
  ADD COLUMN detached_by uuid REFERENCES users(id),
  ADD COLUMN predecessor_correlation_id uuid,
  ADD COLUMN replaced_by_correlation_id uuid,
  ADD COLUMN zammad_state_observed_at timestamptz,
  ADD COLUMN zammad_state_id integer CHECK (zammad_state_id IS NULL OR zammad_state_id > 0),
  ADD CONSTRAINT case_correlations_predecessor_fk
    FOREIGN KEY (predecessor_correlation_id) REFERENCES case_correlations(id) ON DELETE SET NULL,
  ADD CONSTRAINT case_correlations_replacement_fk
    FOREIGN KEY (replaced_by_correlation_id) REFERENCES case_correlations(id) ON DELETE SET NULL,
  ADD CONSTRAINT case_correlations_distinct_links CHECK (
    predecessor_correlation_id IS NULL OR predecessor_correlation_id<>id
  ),
  ADD CONSTRAINT case_correlations_distinct_replacement CHECK (
    replaced_by_correlation_id IS NULL OR replaced_by_correlation_id<>id
  );

-- Legacy DETACHED rows pre-date actor/timestamp capture. Preserve them without
-- inventing a user identity; all new detach operations record detached_by.
UPDATE case_correlations
   SET detached_at=updated_at
 WHERE state='DETACHED'
   AND detached_at IS NULL;

ALTER TABLE case_correlations
  ADD CONSTRAINT case_correlations_detachment_shape CHECK (
    (state='DETACHED' AND detached_at IS NOT NULL)
    OR (state<>'DETACHED' AND detached_at IS NULL AND detached_by IS NULL)
  );

CREATE UNIQUE INDEX case_correlations_generation_unique
  ON case_correlations (tenant_id,group_binding_id,normalized_reference,generation);
CREATE UNIQUE INDEX case_correlations_one_active_generation
  ON case_correlations (tenant_id,group_binding_id,normalized_reference)
  WHERE state<>'DETACHED';
CREATE INDEX case_correlations_ticket_lifecycle_idx
  ON case_correlations (tenant_id,zammad_ticket_id,state,zammad_state_observed_at DESC);

CREATE TABLE zammad_ticket_state_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zammad_instance_id uuid NOT NULL REFERENCES zammad_instances(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 255
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  zammad_ticket_id text NOT NULL CHECK (
    length(zammad_ticket_id) BETWEEN 1 AND 64
    AND zammad_ticket_id ~ '^[1-9][0-9]*$'
  ),
  zammad_ticket_number text CHECK (
    zammad_ticket_number IS NULL OR (
      length(zammad_ticket_number) BETWEEN 1 AND 64
      AND zammad_ticket_number !~ '[[:cntrl:][:space:]]'
    )
  ),
  zammad_state_id integer NOT NULL CHECK (zammad_state_id > 0),
  zammad_state_name text NOT NULL CHECK (
    length(zammad_state_name) BETWEEN 1 AND 100
    AND zammad_state_name !~ '[[:cntrl:]]'
  ),
  zammad_state_type_name text NOT NULL CHECK (
    length(zammad_state_type_name) BETWEEN 1 AND 100
    AND zammad_state_type_name !~ '[[:cntrl:]]'
  ),
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('OPEN','RESOLVED')),
  transitioned_at timestamptz NOT NULL,
  processing_state text NOT NULL DEFAULT 'ACCEPTED'
    CHECK (processing_state IN ('ACCEPTED','APPLIED','IGNORED_STALE','NO_CORRELATION')),
  correlations_updated integer NOT NULL DEFAULT 0 CHECK (correlations_updated >= 0),
  request_id text NOT NULL CHECK (
    length(request_id) BETWEEN 1 AND 255
    AND request_id !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (tenant_id,idempotency_key)
);

CREATE INDEX zammad_ticket_state_events_ticket_time_idx
  ON zammad_ticket_state_events (tenant_id,zammad_ticket_id,transitioned_at DESC);

CREATE TABLE case_detach_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  correlation_id uuid NOT NULL REFERENCES case_correlations(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 255
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  expected_version bigint NOT NULL CHECK (expected_version > 0),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,idempotency_key)
);

CREATE INDEX case_detach_operations_correlation_idx
  ON case_detach_operations (tenant_id,correlation_id,created_at DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'zammad_ticket_state_events','case_detach_operations'
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

GRANT SELECT,INSERT,UPDATE ON zammad_ticket_state_events TO wasalx_app;
GRANT SELECT,INSERT ON case_detach_operations TO wasalx_app;
GRANT SELECT,UPDATE ON case_correlations TO wasalx_app;
GRANT SELECT,UPDATE ON group_bindings TO wasalx_app;
