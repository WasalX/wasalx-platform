-- Provider receipts and operator review are deliberately separate concerns:
-- receipts are immutable evidence, while a delivery_outbox row is the current
-- projection.  Review records retain bounded operational metadata only; the
-- rejected body, provider payload, unsafe media bytes, URLs, and credentials
-- are never copied into this surface.

ALTER TABLE event_inbox
  ADD CONSTRAINT event_inbox_tenant_id_id_unique UNIQUE (tenant_id,id);
ALTER TABLE group_bindings
  ADD CONSTRAINT group_bindings_tenant_id_id_unique UNIQUE (tenant_id,id);

CREATE TABLE delivery_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delivery_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  event_inbox_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('WAHA','META')),
  external_message_id text NOT NULL CHECK (
    length(external_message_id) BETWEEN 1 AND 512
    AND external_message_id !~ '[[:cntrl:]]'
  ),
  receipt_key_sha256 text NOT NULL CHECK (receipt_key_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_scope text NOT NULL CHECK (
    receipt_scope IN ('MESSAGE','PARTICIPANT_OBSERVED')
  ),
  receipt_status text NOT NULL CHECK (receipt_status IN ('SENT','DELIVERED','READ','FAILED')),
  provider_status text NOT NULL CHECK (
    length(provider_status) BETWEEN 1 AND 64
    AND provider_status ~ '^[A-Z0-9_.-]+$'
  ),
  provider_timestamp timestamptz NOT NULL,
  error_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(error_codes)='array'
    AND pg_column_size(error_codes)<=2048
  ),
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(safe_metadata)='object'
    AND pg_column_size(safe_metadata)<=4096
    AND safe_metadata::text !~* '"(body|payload|text|url|token|secret|authorization|participant|recipient|phone|filename|object_key)"[[:space:]]*:'
  ),
  applied_state text NOT NULL CHECK (
    applied_state IN ('SENT','DELIVERED','READ','FAILED_TERMINAL','OBSERVED','IGNORED')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_receipts_delivery_fk
    FOREIGN KEY (tenant_id,delivery_id)
    REFERENCES delivery_outbox(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT delivery_receipts_connection_fk
    FOREIGN KEY (tenant_id,connection_id)
    REFERENCES connections(tenant_id,id),
  CONSTRAINT delivery_receipts_event_fk
    FOREIGN KEY (tenant_id,event_inbox_id)
    REFERENCES event_inbox(tenant_id,id),
  UNIQUE (tenant_id,connection_id,receipt_key_sha256)
);

ALTER TABLE delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON delivery_receipts
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

CREATE INDEX delivery_receipts_timeline_idx
  ON delivery_receipts (tenant_id,delivery_id,provider_timestamp,created_at);
CREATE INDEX delivery_receipts_external_lookup_idx
  ON delivery_receipts (tenant_id,connection_id,external_message_id);
CREATE UNIQUE INDEX delivery_outbox_external_message_once_idx
  ON delivery_outbox (tenant_id,connection_id,external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE TRIGGER delivery_receipts_append_only
BEFORE UPDATE OR DELETE ON delivery_receipts
FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();

CREATE TABLE quarantine_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN ('INBOUND','OUTBOUND')),
  reason_code text NOT NULL CHECK (reason_code IN (
    'IDENTIFIER_LIMIT_EXCEEDED',
    'MEDIA_MALWARE_DETECTED',
    'MEDIA_TOO_LARGE',
    'MEDIA_TYPE_UNSAFE',
    'MEDIA_DOWNLOAD_REJECTED',
    'OUTBOUND_MEDIA_REJECTED',
    'PROVIDER_DELIVERY_FAILED',
    'NON_RETRYABLE_REVIEW'
  )),
  state text NOT NULL DEFAULT 'OPEN' CHECK (
    state IN ('OPEN','REPROCESS_QUEUED','RESOLVED','DISCARDED')
  ),
  connection_id uuid,
  group_binding_id uuid,
  source_event_inbox_id uuid,
  delivery_id uuid,
  media_object_id uuid,
  safe_summary text NOT NULL CHECK (
    length(safe_summary) BETWEEN 1 AND 240
    AND safe_summary !~ '[[:cntrl:]]'
    AND safe_summary !~* 'https?://'
  ),
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(safe_metadata)='object'
    AND pg_column_size(safe_metadata)<=4096
    AND safe_metadata::text !~* '"(body|payload|text|url|token|secret|authorization|participant|recipient|phone|filename|object_key)"[[:space:]]*:'
  ),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  reprocess_event_id uuid,
  resolution_code text CHECK (
    resolution_code IS NULL OR (
      length(resolution_code) BETWEEN 1 AND 64
      AND resolution_code ~ '^[A-Z0-9_.-]+$'
    )
  ),
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quarantine_connection_fk
    FOREIGN KEY (tenant_id,connection_id)
    REFERENCES connections(tenant_id,id),
  CONSTRAINT quarantine_binding_fk
    FOREIGN KEY (tenant_id,group_binding_id)
    REFERENCES group_bindings(tenant_id,id),
  CONSTRAINT quarantine_event_fk
    FOREIGN KEY (tenant_id,source_event_inbox_id)
    REFERENCES event_inbox(tenant_id,id),
  CONSTRAINT quarantine_delivery_fk
    FOREIGN KEY (tenant_id,delivery_id)
    REFERENCES delivery_outbox(tenant_id,id),
  CONSTRAINT quarantine_media_fk
    FOREIGN KEY (tenant_id,media_object_id)
    REFERENCES media_objects(tenant_id,id),
  CONSTRAINT quarantine_source_check CHECK (
    (source_kind='INBOUND' AND source_event_inbox_id IS NOT NULL AND delivery_id IS NULL)
    OR (source_kind='OUTBOUND' AND delivery_id IS NOT NULL AND source_event_inbox_id IS NULL)
  ),
  CONSTRAINT quarantine_resolution_check CHECK (
    (state IN ('OPEN','REPROCESS_QUEUED') AND resolved_at IS NULL AND resolved_by IS NULL AND resolution_code IS NULL)
    OR (state IN ('RESOLVED','DISCARDED') AND resolved_at IS NOT NULL AND resolution_code IS NOT NULL)
  ),
  CONSTRAINT quarantine_reprocess_check CHECK (
    (state='REPROCESS_QUEUED' AND reprocess_event_id IS NOT NULL)
    OR (state<>'REPROCESS_QUEUED')
  ),
  UNIQUE (tenant_id,id)
);

ALTER TABLE quarantine_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE quarantine_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON quarantine_records
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

CREATE UNIQUE INDEX quarantine_event_once_idx
  ON quarantine_records (tenant_id,source_event_inbox_id)
  WHERE source_event_inbox_id IS NOT NULL;
CREATE UNIQUE INDEX quarantine_delivery_reason_once_idx
  ON quarantine_records (tenant_id,delivery_id,reason_code)
  WHERE delivery_id IS NOT NULL;
CREATE INDEX quarantine_open_queue_idx
  ON quarantine_records (tenant_id,created_at DESC)
  WHERE state IN ('OPEN','REPROCESS_QUEUED');

CREATE OR REPLACE FUNCTION app.require_clean_quarantine_media()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.media_object_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM media_objects
     WHERE tenant_id=NEW.tenant_id
       AND id=NEW.media_object_id
       AND scan_state='CLEAN'
  ) THEN
    RAISE EXCEPTION 'quarantine may reference clean media only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quarantine_clean_media
BEFORE INSERT OR UPDATE OF media_object_id ON quarantine_records
FOR EACH ROW EXECUTE FUNCTION app.require_clean_quarantine_media();

CREATE TABLE quarantine_action_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quarantine_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL CHECK (
    length(idempotency_key) BETWEEN 16 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('RESOLVE','DISCARD','REPROCESS')),
  result_state text NOT NULL CHECK (result_state IN ('RESOLVED','DISCARDED','REPROCESS_QUEUED')),
  result_version integer NOT NULL CHECK (result_version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quarantine_action_requests_review_fk
    FOREIGN KEY (tenant_id,quarantine_id)
    REFERENCES quarantine_records(tenant_id,id) ON DELETE CASCADE,
  UNIQUE (tenant_id,idempotency_key)
);

ALTER TABLE quarantine_action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE quarantine_action_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON quarantine_action_requests
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

CREATE TRIGGER quarantine_action_requests_append_only
BEFORE UPDATE OR DELETE ON quarantine_action_requests
FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();

REVOKE ALL ON delivery_receipts,quarantine_records,quarantine_action_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION app.require_clean_quarantine_media() FROM PUBLIC;
GRANT SELECT,INSERT ON delivery_receipts TO wasalx_app;
GRANT SELECT,INSERT,UPDATE ON quarantine_records TO wasalx_app;
GRANT SELECT,INSERT ON quarantine_action_requests TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.require_clean_quarantine_media() TO wasalx_app;
