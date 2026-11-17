-- Keep only the three durable milestones needed to measure onboarding without
-- confusing human scan time with provider connection time. QR images and phone
-- identifiers remain outside the database.
ALTER TABLE public.provider_sessions
  ADD COLUMN onboarding_qr_ready_at timestamptz,
  ADD COLUMN onboarding_scan_completed_at timestamptz,
  ADD COLUMN onboarding_working_at timestamptz,
  ADD CONSTRAINT provider_sessions_onboarding_order_check CHECK (
    (onboarding_scan_completed_at IS NULL OR onboarding_scan_completed_at >= onboarding_qr_ready_at)
    AND (onboarding_working_at IS NULL OR onboarding_working_at >= onboarding_qr_ready_at)
    AND (onboarding_scan_completed_at IS NULL OR onboarding_working_at IS NULL OR onboarding_working_at >= onboarding_scan_completed_at)
  );

CREATE INDEX provider_sessions_onboarding_evidence_idx
  ON public.provider_sessions (tenant_id, onboarding_working_at DESC)
  WHERE onboarding_working_at IS NOT NULL;
