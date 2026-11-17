-- Shared group/direct identity and ticket-link upserts must not gain key updates.
GRANT UPDATE (display_name,display_name_quality,normalized_phone)
  ON public.participant_identities TO wasalx_connector_worker;
GRANT UPDATE (zammad_article_id)
  ON public.message_links TO wasalx_connector_worker;
