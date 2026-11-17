ALTER TABLE bot_handoff_jobs
  ADD COLUMN zammad_owner_id text CHECK (zammad_owner_id IS NULL OR zammad_owner_id ~ '^[1-9][0-9]{0,15}$');
