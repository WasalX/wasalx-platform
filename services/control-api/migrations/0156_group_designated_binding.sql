-- Derived routing identity lets PostgreSQL enforce designation across snapshots.
ALTER TABLE group_bindings ADD COLUMN routing_provider text, ADD COLUMN routing_group_id text;
UPDATE group_bindings binding SET routing_provider=connection.provider,routing_group_id=group_record.external_group_id
FROM whatsapp_groups group_record JOIN connections connection
  ON connection.tenant_id=group_record.tenant_id AND connection.id=group_record.connection_id
WHERE group_record.tenant_id=binding.tenant_id AND group_record.id=binding.whatsapp_group_id;
ALTER TABLE group_bindings ALTER COLUMN routing_provider SET NOT NULL, ALTER COLUMN routing_group_id SET NOT NULL;
-- Existing ambiguity fails migration; the operator must explicitly select a bot.
CREATE UNIQUE INDEX group_designated_binding_unique
ON group_bindings(tenant_id,routing_provider,routing_group_id) WHERE state='ACTIVE';

CREATE FUNCTION app.derive_group_binding_route() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  SELECT connection.provider,group_record.external_group_id INTO NEW.routing_provider,NEW.routing_group_id
  FROM public.whatsapp_groups group_record JOIN public.connections connection
    ON connection.tenant_id=group_record.tenant_id AND connection.id=group_record.connection_id
  WHERE group_record.tenant_id=NEW.tenant_id AND group_record.id=NEW.whatsapp_group_id;
  IF NEW.routing_group_id IS NULL THEN RAISE EXCEPTION 'Group routing identity unavailable'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.derive_group_binding_route() FROM PUBLIC;
CREATE TRIGGER group_binding_route_derived BEFORE INSERT OR UPDATE ON group_bindings
FOR EACH ROW EXECUTE FUNCTION app.derive_group_binding_route();

CREATE FUNCTION app.preserve_group_routing_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_TABLE_NAME='whatsapp_groups' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
      OR NEW.external_group_id IS DISTINCT FROM OLD.external_group_id THEN
      RAISE EXCEPTION 'Group routing identity is immutable';
    END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.provider IS DISTINCT FROM OLD.provider THEN
      RAISE EXCEPTION 'Connection routing identity is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.preserve_group_routing_identity() FROM PUBLIC;
CREATE TRIGGER group_routing_identity_immutable BEFORE UPDATE OF tenant_id,connection_id,external_group_id ON whatsapp_groups
FOR EACH ROW EXECUTE FUNCTION app.preserve_group_routing_identity();
CREATE TRIGGER connection_routing_identity_immutable BEFORE UPDATE OF tenant_id,provider ON connections
FOR EACH ROW EXECUTE FUNCTION app.preserve_group_routing_identity();
