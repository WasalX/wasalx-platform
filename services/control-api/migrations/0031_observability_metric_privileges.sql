-- Upgrade parity for installations that applied 0021 before its aggregate
-- function owner received every timestamp column used by the function. These
-- column-scoped grants do not expose tenant rows to wasalx_app; that role can
-- execute only the identifier-free SECURITY DEFINER aggregate.

GRANT SELECT (status,received_at,lease_expires_at)
  ON public.event_inbox TO wasalx_scheduler_reader;
GRANT SELECT (state,created_at,lease_expires_at)
  ON public.delivery_outbox TO wasalx_scheduler_reader;
GRANT SELECT (completed_at,created_at,lease_expires_at)
  ON public.zammad_status_outbox TO wasalx_scheduler_reader;
GRANT SELECT (state,created_at,lease_expires_at)
  ON public.connection_operations TO wasalx_scheduler_reader;
GRANT SELECT (state,created_at,lease_expires_at)
  ON public.privacy_jobs TO wasalx_scheduler_reader;
GRANT SELECT (state,created_at)
  ON public.quarantine_records TO wasalx_scheduler_reader;
GRANT SELECT (status,available_at,updated_at)
  ON public.provisioning_operations TO wasalx_scheduler_reader;
