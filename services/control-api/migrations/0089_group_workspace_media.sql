-- Group-workspace uploads are staged inside the tenant's Zammad instance,
-- then copied through the existing scan/private-object pipeline. Exactly one
-- immutable Zammad source identifies every outbound media part.

ALTER TABLE delivery_media
  ALTER COLUMN zammad_attachment_id DROP NOT NULL,
  ADD COLUMN zammad_upload_id uuid,
  ADD COLUMN zammad_upload_store_id bigint CHECK (zammad_upload_store_id > 0),
  DROP CONSTRAINT delivery_media_tenant_id_delivery_id_zammad_attachment_id_key,
  ADD CONSTRAINT delivery_media_source_check CHECK (
    (zammad_attachment_id IS NOT NULL AND zammad_upload_id IS NULL AND zammad_upload_store_id IS NULL)
    OR
    (zammad_attachment_id IS NULL AND zammad_upload_id IS NOT NULL AND zammad_upload_store_id IS NOT NULL)
  );

CREATE UNIQUE INDEX delivery_media_workspace_upload_unique
  ON delivery_media (tenant_id,zammad_upload_id,zammad_upload_store_id)
  WHERE zammad_upload_id IS NOT NULL;
