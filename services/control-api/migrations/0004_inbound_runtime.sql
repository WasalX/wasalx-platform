CREATE TABLE webhook_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('WAHA','META')),
  route_token_sha256 text,
  external_key text,
  hmac_secret_reference text NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','PAUSED','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((provider = 'WAHA' AND route_token_sha256 IS NOT NULL) OR (provider = 'META' AND external_key IS NOT NULL)),
  UNIQUE (provider, route_token_sha256),
  UNIQUE (provider, external_key),
  UNIQUE (tenant_id, connection_id)
);

ALTER TABLE webhook_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_routes
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE OR REPLACE FUNCTION app.resolve_waha_webhook_route(route_hash text)
RETURNS TABLE (tenant_id uuid, connection_id uuid, provider text, hmac_secret_reference text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT r.tenant_id, r.connection_id, r.provider, r.hmac_secret_reference
    FROM webhook_routes r
   WHERE r.provider = 'WAHA'
     AND r.route_token_sha256 = route_hash
     AND r.state = 'ACTIVE'
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION app.resolve_meta_webhook_route(route_external_key text)
RETURNS TABLE (tenant_id uuid, connection_id uuid, provider text, hmac_secret_reference text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT r.tenant_id, r.connection_id, r.provider, r.hmac_secret_reference
    FROM webhook_routes r
   WHERE r.provider = 'META'
     AND r.external_key = route_external_key
     AND r.state = 'ACTIVE'
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION app.resolve_waha_webhook_route(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_meta_webhook_route(text) FROM PUBLIC;

ALTER TABLE event_inbox
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lease_id uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN safe_error text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

DROP INDEX event_inbox_pending_idx;
CREATE INDEX event_inbox_pending_idx ON event_inbox (tenant_id, available_at)
  WHERE status IN ('ACCEPTED','FAILED_RETRYABLE','PROCESSING');

CREATE OR REPLACE FUNCTION app.claim_inbound_events(worker_lease uuid, claim_limit integer DEFAULT 25)
RETURNS SETOF event_inbox LANGUAGE sql AS $$
  UPDATE event_inbox
     SET lease_id = worker_lease,
         lease_expires_at = now() + interval '60 seconds',
         status = 'PROCESSING',
         attempts = attempts + 1,
         updated_at = now()
   WHERE id IN (
     SELECT id FROM event_inbox
      WHERE tenant_id = app.current_tenant_id()
        AND (
          (status IN ('ACCEPTED','FAILED_RETRYABLE') AND available_at <= now())
          OR (status = 'PROCESSING' AND lease_expires_at < now())
        )
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      ORDER BY available_at, received_at
      FOR UPDATE SKIP LOCKED
      LIMIT claim_limit
   )
  RETURNING *;
$$;

CREATE TABLE normalized_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_inbox_id uuid NOT NULL REFERENCES event_inbox(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  external_message_id text NOT NULL,
  external_group_id text NOT NULL,
  external_participant_id text NOT NULL,
  participant_name text,
  message_text text NOT NULL,
  quoted_external_message_id text,
  from_api boolean NOT NULL DEFAULT false,
  from_me boolean NOT NULL DEFAULT false,
  provider_timestamp timestamptz NOT NULL,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  processing_status text NOT NULL DEFAULT 'PROCESSING' CHECK (processing_status IN ('PROCESSING','COMPLETE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_message_id)
);

ALTER TABLE normalized_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE normalized_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON normalized_messages
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE message_links DROP CONSTRAINT message_links_connection_id_external_message_id_key;
ALTER TABLE message_links ADD CONSTRAINT message_links_connection_message_ticket_key
  UNIQUE (connection_id, external_message_id, zammad_ticket_id);

CREATE TABLE delivery_ticket_links (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delivery_id uuid NOT NULL REFERENCES delivery_outbox(id) ON DELETE CASCADE,
  zammad_ticket_id text NOT NULL,
  PRIMARY KEY (delivery_id, zammad_ticket_id)
);

ALTER TABLE delivery_ticket_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_ticket_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON delivery_ticket_links
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE INDEX normalized_messages_group_time_idx ON normalized_messages (tenant_id, external_group_id, provider_timestamp DESC);
CREATE INDEX message_links_lookup_idx ON message_links (tenant_id, connection_id, external_message_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_routes, normalized_messages, delivery_ticket_links TO wasalx_app;
    GRANT EXECUTE ON FUNCTION app.resolve_waha_webhook_route(text), app.resolve_meta_webhook_route(text), app.claim_inbound_events(uuid,integer) TO wasalx_app;
  END IF;
END;
$$;
