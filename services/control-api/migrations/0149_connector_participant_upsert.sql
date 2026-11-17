-- Group sync upserts roster attributes; tenant/group/participant identity stays immutable to the worker.
GRANT UPDATE (normalized_phone,display_name,synchronized_at)
  ON public.group_workspace_participants TO wasalx_connector_worker;
