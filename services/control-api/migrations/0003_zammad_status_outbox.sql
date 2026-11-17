CREATE TABLE zammad_status_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delivery_id uuid NOT NULL REFERENCES delivery_outbox(id) ON DELETE CASCADE,
  zammad_ticket_id text NOT NULL,
  delivery_state text NOT NULL,
  external_message_id text,
  safe_error text,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, delivery_id)
);

ALTER TABLE zammad_status_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE zammad_status_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON zammad_status_outbox
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE INDEX zammad_status_outbox_claim_idx ON zammad_status_outbox (tenant_id, available_at)
  WHERE completed_at IS NULL;

CREATE OR REPLACE FUNCTION app.claim_zammad_status_jobs(worker_lease uuid, claim_limit integer DEFAULT 25)
RETURNS SETOF zammad_status_outbox LANGUAGE sql AS $$
  UPDATE zammad_status_outbox
     SET lease_id = worker_lease,
         lease_expires_at = now() + interval '60 seconds',
         attempts = attempts + 1,
         updated_at = now()
   WHERE id IN (
     SELECT id FROM zammad_status_outbox
      WHERE tenant_id = app.current_tenant_id()
        AND completed_at IS NULL
        AND available_at <= now()
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      ORDER BY available_at
      FOR UPDATE SKIP LOCKED
      LIMIT claim_limit
   )
  RETURNING *;
$$;
