GRANT SELECT (bot_conversation_id)
  ON public.delivery_outbox TO wasalx_scheduler_reader;
GRANT SELECT (id,tenant_id,state)
  ON public.bot_conversations TO wasalx_scheduler_reader;
