ALTER TABLE event_inbox
  ADD COLUMN governing_client_routing_version_id uuid,
  ADD CONSTRAINT event_inbox_client_routing_version_fk
    FOREIGN KEY (tenant_id,governing_client_routing_version_id)
    REFERENCES client_routing_versions(tenant_id,id);

CREATE OR REPLACE FUNCTION app.pin_event_client_routing_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.governing_client_routing_version_id IS NULL THEN
    SELECT routing.id INTO NEW.governing_client_routing_version_id
      FROM client_routing_versions routing
     WHERE routing.tenant_id=NEW.tenant_id AND routing.state='ACTIVE';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER event_inbox_client_routing_pin
BEFORE INSERT ON event_inbox
FOR EACH ROW EXECUTE FUNCTION app.pin_event_client_routing_version();

CREATE OR REPLACE FUNCTION app.enforce_event_client_routing_pin()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.governing_client_routing_version_id IS DISTINCT FROM OLD.governing_client_routing_version_id THEN
    RAISE EXCEPTION 'event client routing version is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER event_inbox_client_routing_pin_once
BEFORE UPDATE OF governing_client_routing_version_id ON event_inbox
FOR EACH ROW EXECUTE FUNCTION app.enforce_event_client_routing_pin();

ALTER TABLE case_correlations
  ADD COLUMN client_routing_version_id uuid,
  ADD COLUMN client_route_status text,
  ADD COLUMN client_id text,
  ADD COLUMN client_route_matched_by text,
  ADD CONSTRAINT case_correlations_client_routing_version_fk
    FOREIGN KEY (tenant_id,client_routing_version_id)
    REFERENCES client_routing_versions(tenant_id,id),
  ADD CONSTRAINT case_correlations_client_route_check CHECK (
    (client_routing_version_id IS NULL AND client_route_status IS NULL
      AND client_id IS NULL AND client_route_matched_by IS NULL)
    OR (client_routing_version_id IS NOT NULL AND (
      (client_route_status='FALLBACK' AND client_id IS NULL AND client_route_matched_by='FALLBACK')
      OR (client_route_status='MATCHED' AND client_id IS NOT NULL
        AND client_route_matched_by IN ('WHATSAPP_GROUP','CLIENT_IDENTIFIER','EMAIL','DOMAIN'))
    ))
  );

ALTER TABLE bot_conversations
  ADD COLUMN client_routing_version_id uuid,
  ADD COLUMN client_route_status text,
  ADD COLUMN client_id text,
  ADD COLUMN client_route_matched_by text,
  ADD CONSTRAINT bot_conversations_client_routing_version_fk
    FOREIGN KEY (tenant_id,client_routing_version_id)
    REFERENCES client_routing_versions(tenant_id,id),
  ADD CONSTRAINT bot_conversations_client_route_check CHECK (
    (client_routing_version_id IS NULL AND client_route_status IS NULL
      AND client_id IS NULL AND client_route_matched_by IS NULL)
    OR (client_routing_version_id IS NOT NULL AND (
      (client_route_status='FALLBACK' AND client_id IS NULL AND client_route_matched_by='FALLBACK')
      OR (client_route_status='MATCHED' AND client_id IS NOT NULL
        AND client_route_matched_by IN ('WHATSAPP_GROUP','CLIENT_IDENTIFIER','EMAIL','DOMAIN'))
    ))
  );

CREATE TABLE zammad_email_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zammad_ticket_id text NOT NULL CHECK (zammad_ticket_id ~ '^[1-9][0-9]{0,15}$'),
  client_routing_version_id uuid,
  client_route_status text,
  client_id text,
  client_route_matched_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,zammad_ticket_id),
  FOREIGN KEY (tenant_id,client_routing_version_id)
    REFERENCES client_routing_versions(tenant_id,id),
  CHECK (
    (client_routing_version_id IS NULL AND client_route_status='UNCONFIGURED'
      AND client_id IS NULL AND client_route_matched_by IS NULL)
    OR (client_routing_version_id IS NOT NULL AND (
      (client_route_status='FALLBACK' AND client_id IS NULL AND client_route_matched_by='FALLBACK')
      OR (client_route_status='MATCHED' AND client_id IS NOT NULL
        AND client_route_matched_by IN ('EMAIL','DOMAIN','CLIENT_IDENTIFIER'))
    ))
  )
);

ALTER TABLE zammad_email_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE zammad_email_routes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON zammad_email_routes
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());

GRANT SELECT,INSERT ON zammad_email_routes TO wasalx_app;
