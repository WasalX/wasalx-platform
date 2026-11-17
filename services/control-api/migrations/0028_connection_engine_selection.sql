-- Provider engines are durable connection identity. WAHA sessions may use the
-- recommended GOWS runtime or the explicit NOWEB compatibility runtime, while
-- official Meta connections always use the Cloud API. Invalid legacy rows
-- abort this migration instead of being silently rewritten.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.connections
     WHERE engine IS NULL
        OR NOT (
          (provider = 'WAHA' AND engine IN ('GOWS','NOWEB'))
          OR (provider = 'META' AND engine = 'CLOUD_API')
        )
  ) THEN
    RAISE EXCEPTION 'invalid provider engine state requires operator review';
  END IF;
END;
$$;

ALTER TABLE public.connections
  ALTER COLUMN engine SET NOT NULL;

ALTER TABLE public.connections
  ADD CONSTRAINT connections_provider_engine_check
  CHECK (
    (provider = 'WAHA' AND engine IN ('GOWS','NOWEB'))
    OR (provider = 'META' AND engine = 'CLOUD_API')
  );

CREATE OR REPLACE FUNCTION app.reject_connection_provider_engine_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.engine IS DISTINCT FROM OLD.engine THEN
    RAISE EXCEPTION 'connection provider and engine are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER connections_provider_engine_immutable
BEFORE UPDATE OF provider, engine ON public.connections
FOR EACH ROW EXECUTE FUNCTION app.reject_connection_provider_engine_change();

COMMENT ON COLUMN public.connections.engine IS
  'Immutable provider runtime selected at connection creation; WAHA engine changes require a new connection.';
