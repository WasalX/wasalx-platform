CREATE TABLE group_disclosure_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_binding_id uuid NOT NULL,
  disclosure_sha256 text NOT NULL
    CHECK (disclosure_sha256 ~ '^[0-9a-f]{64}$'),
  delivery_id uuid NOT NULL UNIQUE,
  state text NOT NULL
    CHECK (state IN ('QUEUED','SENT','FAILED','OUTCOME_UNKNOWN')),
  external_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_disclosure_binding_tenant_fk
    FOREIGN KEY (tenant_id,group_binding_id)
    REFERENCES group_bindings(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT group_disclosure_delivery_tenant_fk
    FOREIGN KEY (tenant_id,delivery_id)
    REFERENCES delivery_outbox(tenant_id,id) ON DELETE CASCADE
);

-- A changed disclosure receives a new digest and may be shown once again. A
-- known terminal failure releases the digest for the next acknowledgement.
-- Unknown outcomes remain suppressing until an operator verifies and retries.
CREATE UNIQUE INDEX group_disclosure_active_version_idx
  ON group_disclosure_deliveries (tenant_id, group_binding_id, disclosure_sha256)
  WHERE state IN ('QUEUED','SENT','OUTCOME_UNKNOWN');

CREATE INDEX group_disclosure_delivery_lookup_idx
  ON group_disclosure_deliveries (tenant_id, delivery_id);

ALTER TABLE group_disclosure_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_disclosure_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON group_disclosure_deliveries
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_app') THEN
    REVOKE ALL ON group_disclosure_deliveries FROM PUBLIC, wasalx_app;
    GRANT SELECT ON group_disclosure_deliveries TO wasalx_app;
    GRANT INSERT (tenant_id,group_binding_id,disclosure_sha256,delivery_id,state)
      ON group_disclosure_deliveries TO wasalx_app;
    GRANT UPDATE (state,external_message_id,updated_at)
      ON group_disclosure_deliveries TO wasalx_app;
  END IF;
END;
$$;
