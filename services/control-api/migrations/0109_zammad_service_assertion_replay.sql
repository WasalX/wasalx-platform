BEGIN;

-- Mutating service assertions are one-time bearer credentials. Receipts remain
-- tenant-scoped for their bounded JWT lifetime and are pruned on later writes.
CREATE TABLE zammad_service_assertion_jtis (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zammad_instance_id uuid NOT NULL,
  jti uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,jti),
  CONSTRAINT zammad_service_assertion_jti_instance_fk
    FOREIGN KEY (tenant_id,zammad_instance_id)
    REFERENCES zammad_instances(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT zammad_service_assertion_jti_lifetime_check CHECK (
    expires_at > created_at - interval '5 seconds'
    AND expires_at <= created_at + interval '5 minutes 5 seconds'
  )
);

CREATE INDEX zammad_service_assertion_jtis_expiry_idx
  ON zammad_service_assertion_jtis (tenant_id,expires_at);

ALTER TABLE zammad_service_assertion_jtis ENABLE ROW LEVEL SECURITY;
ALTER TABLE zammad_service_assertion_jtis FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON zammad_service_assertion_jtis
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

REVOKE ALL ON zammad_service_assertion_jtis FROM PUBLIC;
GRANT SELECT,INSERT,DELETE ON zammad_service_assertion_jtis TO wasalx_app;
REVOKE UPDATE,TRUNCATE ON zammad_service_assertion_jtis FROM wasalx_app;

COMMIT;
