-- Keep the administrator-facing WasalX alias separate from the provider name.
-- Provider group synchronization may refresh display_name, but must never erase
-- the tenant's operational context.
ALTER TABLE whatsapp_groups
  ADD COLUMN wasalx_name text CHECK (
    wasalx_name IS NULL OR (
      length(wasalx_name) BETWEEN 1 AND 160
      AND wasalx_name !~ '[[:cntrl:]]'
    )
  );
