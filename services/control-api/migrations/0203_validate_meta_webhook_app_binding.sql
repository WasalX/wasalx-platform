-- Run after the migration that adds the constraint has committed.
ALTER TABLE public.event_inbox VALIDATE CONSTRAINT event_inbox_meta_webhook_app;
