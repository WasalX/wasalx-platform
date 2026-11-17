-- Permit acknowledgement serialization without granting binding configuration writes.
REVOKE UPDATE ON public.group_bindings FROM wasalx_connector_worker;
GRANT UPDATE (id) ON public.group_bindings TO wasalx_connector_worker;

CREATE OR REPLACE FUNCTION app.preserve_group_binding_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'group binding identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER group_binding_identity_immutable
BEFORE UPDATE OF id ON public.group_bindings
FOR EACH ROW EXECUTE FUNCTION app.preserve_group_binding_identity();
REVOKE ALL ON FUNCTION app.preserve_group_binding_identity() FROM PUBLIC;
