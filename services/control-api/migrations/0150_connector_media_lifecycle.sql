-- Reservation renews retention; promotion changes scan state. Media identity remains immutable.
GRANT UPDATE (expires_at,scan_state)
  ON public.media_objects TO wasalx_connector_worker;
