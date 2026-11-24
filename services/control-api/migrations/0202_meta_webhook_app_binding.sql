ALTER TABLE public.event_inbox ADD COLUMN meta_webhook_app_id text,
  ADD CONSTRAINT event_inbox_meta_webhook_app CHECK (
    meta_webhook_app_id IS NULL OR (provider = 'META' AND meta_webhook_app_id ~ '^[0-9]{5,32}$')
  ) NOT VALID;

GRANT INSERT (meta_webhook_app_id) ON public.event_inbox TO wasalx_app;
GRANT SELECT (meta_webhook_app_id) ON public.event_inbox TO wasalx_connector_worker;
