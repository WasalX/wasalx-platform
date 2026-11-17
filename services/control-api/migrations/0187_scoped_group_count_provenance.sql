-- Metadata-only discovery cannot establish the current member count.
-- Preserve the existing normal/legacy count semantics until the next snapshot.
ALTER TABLE public.whatsapp_groups
  ADD COLUMN participant_count_known boolean NOT NULL DEFAULT true;
