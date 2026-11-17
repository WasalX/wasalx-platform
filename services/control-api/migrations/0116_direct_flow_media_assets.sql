-- Tenant-owned, scanned media can be pinned to immutable direct-flow revisions.
-- Flow definitions store only this stable asset identity; bytes remain in the
-- existing private media object store and deliveries copy immutable metadata.

-- Upload reservations are admitted against a tenant-scoped, row-driven
-- storage boundary. Terminal redacted tombstones do not consume this quota.
ALTER TABLE tenant_settings
  ADD COLUMN bot_media_asset_count_limit integer NOT NULL DEFAULT 200
    CHECK (bot_media_asset_count_limit BETWEEN 1 AND 5000),
  ADD COLUMN bot_media_asset_bytes_limit bigint NOT NULL DEFAULT 1000000000
    CHECK (bot_media_asset_bytes_limit BETWEEN 1000000 AND 100000000000);

CREATE TABLE bot_media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 120 AND filename !~ '[[:cntrl:]]'),
  mime_type text NOT NULL CHECK (
    length(mime_type) BETWEEN 3 AND 127
    AND mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
  ),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 100000000),
  media_object_id uuid,
  declared_sha256 text CHECK (declared_sha256 IS NULL OR declared_sha256 ~ '^[0-9a-f]{64}$'),
  content_sha256 text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'UPLOADING' CHECK (state IN ('UPLOADING','READY','FAILED','RETIRED','PURGE_PENDING','PURGED')),
  safe_error text CHECK (safe_error IS NULL OR length(safe_error) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  request_sha256 text CHECK (request_sha256 IS NULL OR request_sha256 ~ '^[0-9a-f]{64}$'),
  upload_expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,media_object_id) REFERENCES media_objects(tenant_id,id),
  CHECK (
    (state='UPLOADING' AND request_sha256 IS NOT NULL AND declared_sha256 IS NOT NULL AND media_object_id IS NULL AND content_sha256 IS NULL AND safe_error IS NULL)
    OR (state IN ('READY','RETIRED','PURGE_PENDING') AND request_sha256 IS NOT NULL AND declared_sha256 IS NOT NULL AND media_object_id IS NOT NULL AND content_sha256 IS NOT NULL AND safe_error IS NULL)
    OR (state='FAILED' AND filename='[removed]' AND request_sha256 IS NULL AND declared_sha256 IS NULL AND media_object_id IS NULL AND content_sha256 IS NULL AND safe_error IS NOT NULL)
    OR (state='PURGED' AND filename='[removed]' AND request_sha256 IS NULL AND declared_sha256 IS NULL AND media_object_id IS NULL AND content_sha256 IS NULL AND safe_error IS NULL)
  )
);

CREATE TABLE bot_flow_media_asset_pins (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bot_flow_version_id uuid NOT NULL,
  bot_media_asset_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,bot_flow_version_id,bot_media_asset_id),
  FOREIGN KEY (tenant_id,bot_flow_version_id)
    REFERENCES bot_flow_versions(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,bot_media_asset_id)
    REFERENCES bot_media_assets(tenant_id,id)
);

ALTER TABLE bot_media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_media_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bot_media_assets
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

ALTER TABLE bot_flow_media_asset_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_flow_media_asset_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bot_flow_media_asset_pins
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

ALTER TABLE delivery_media
  ADD COLUMN bot_media_asset_id uuid,
  DROP CONSTRAINT delivery_media_source_check,
  ADD CONSTRAINT delivery_media_bot_asset_fk
    FOREIGN KEY (tenant_id,bot_media_asset_id)
    REFERENCES bot_media_assets(tenant_id,id),
  ADD CONSTRAINT delivery_media_source_check CHECK (
    (zammad_attachment_id IS NOT NULL)::integer+
    (zammad_upload_id IS NOT NULL AND zammad_upload_store_id IS NOT NULL)::integer+
    (bot_media_asset_id IS NOT NULL)::integer=1
    AND (zammad_upload_id IS NULL)=(zammad_upload_store_id IS NULL)
  );

ALTER TABLE delivery_outbox
  DROP CONSTRAINT delivery_outbox_origin_shape,
  ADD CONSTRAINT delivery_outbox_origin_shape CHECK (
    (delivery_origin='TICKET'
      AND (
        (zammad_ticket_id IS NOT NULL AND zammad_article_id IS NOT NULL)
        OR
        (bot_conversation_id IS NOT NULL AND direct_origin='BOT'
          AND zammad_ticket_id IS NOT NULL AND zammad_article_id IS NULL
          AND bot_content IS NOT NULL AND bot_content->>'type'='media')
      ))
    OR
    (delivery_origin='GROUP_WORKSPACE' AND group_workspace_group_id IS NOT NULL
      AND group_binding_id IS NULL AND bot_conversation_id IS NULL
      AND external_chat_id IS NULL AND bot_content IS NULL
      AND zammad_ticket_id IS NULL AND zammad_article_id IS NULL)
  );

CREATE INDEX bot_media_assets_catalog_idx
  ON bot_media_assets (tenant_id,state,created_at DESC,id);
CREATE INDEX bot_flow_media_asset_pins_asset_idx
  ON bot_flow_media_asset_pins (tenant_id,bot_media_asset_id,bot_flow_version_id);

CREATE OR REPLACE FUNCTION app.guard_bot_media_asset_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state<>'UPLOADING' OR NEW.media_object_id IS NOT NULL OR NEW.content_sha256 IS NOT NULL OR NEW.safe_error IS NOT NULL THEN
    RAISE EXCEPTION 'bot media assets must begin in the upload state' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bot_media_assets_insert_state
  BEFORE INSERT ON bot_media_assets
  FOR EACH ROW EXECUTE FUNCTION app.guard_bot_media_asset_insert();

CREATE OR REPLACE FUNCTION app.guard_bot_media_asset_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id
     OR NEW.mime_type<>OLD.mime_type OR NEW.byte_size<>OLD.byte_size
     OR NEW.idempotency_key<>OLD.idempotency_key
     OR (NEW.state NOT IN ('FAILED','PURGED') AND NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256)
     OR (NEW.state NOT IN ('FAILED','PURGED') AND NEW.filename<>OLD.filename)
     OR (NEW.state NOT IN ('FAILED','PURGED') AND NEW.declared_sha256 IS DISTINCT FROM OLD.declared_sha256)
     OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at
     OR (OLD.state<>'UPLOADING' AND NEW.state<>'PURGED' AND NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256)
     OR (OLD.state IN ('READY','RETIRED','PURGE_PENDING') AND NEW.state<>'PURGED' AND NEW.media_object_id IS DISTINCT FROM OLD.media_object_id)
     OR (NEW.state='FAILED' AND (NEW.filename<>'[removed]' OR NEW.request_sha256 IS NOT NULL OR NEW.declared_sha256 IS NOT NULL OR NEW.content_sha256 IS NOT NULL OR NEW.media_object_id IS NOT NULL))
     OR (NEW.state='PURGED' AND (NEW.filename<>'[removed]' OR NEW.request_sha256 IS NOT NULL OR NEW.declared_sha256 IS NOT NULL OR NEW.content_sha256 IS NOT NULL OR NEW.media_object_id IS NOT NULL))
     OR NOT (
       (OLD.state='UPLOADING' AND NEW.state='UPLOADING' AND NEW.media_object_id IS NULL AND NEW.safe_error IS NULL)
       OR
       (OLD.state='UPLOADING' AND NEW.state IN ('READY','FAILED'))
       OR (OLD.state='READY' AND NEW.state IN ('RETIRED','PURGE_PENDING','PURGED'))
       OR (OLD.state='RETIRED' AND NEW.state IN ('PURGE_PENDING','PURGED'))
       OR (OLD.state='PURGE_PENDING' AND NEW.state='PURGED')
     ) THEN
    RAISE EXCEPTION 'bot media asset identity and completed content are immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.state='READY' AND NOT EXISTS (
    SELECT 1 FROM media_objects media WHERE media.tenant_id=NEW.tenant_id
      AND media.id=NEW.media_object_id AND media.sha256=NEW.content_sha256
      AND media.sha256=NEW.declared_sha256 AND media.scan_state='CLEAN'
      AND media.mime_type=NEW.mime_type AND media.byte_size=NEW.byte_size
  ) THEN
    RAISE EXCEPTION 'bot media asset content is not a clean durable object' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bot_media_assets_immutable
  BEFORE UPDATE ON bot_media_assets
  FOR EACH ROW EXECUTE FUNCTION app.guard_bot_media_asset_mutation();

CREATE TRIGGER bot_media_asset_actor_membership
  BEFORE INSERT OR UPDATE OF tenant_id,created_by ON bot_media_assets
  FOR EACH ROW EXECUTE FUNCTION app.enforce_bot_action_actor_membership('created_by');

GRANT SELECT,INSERT,UPDATE ON bot_media_assets TO wasalx_app;
GRANT SELECT,INSERT ON bot_flow_media_asset_pins TO wasalx_app;
