-- A human may acknowledge a scan after WAHA has already reached WORKING.
-- Keep that durable acknowledgement separate from the timing-eligible scan
-- milestone, which workers promote only when provider ordering proves it.
ALTER TABLE public.provider_sessions
  ADD COLUMN onboarding_scan_acknowledged_at timestamptz,
  ADD COLUMN onboarding_authorization_method text;

UPDATE public.provider_sessions
   SET onboarding_scan_acknowledged_at=onboarding_scan_completed_at,
       onboarding_authorization_method='QR'
 WHERE onboarding_scan_completed_at IS NOT NULL;

UPDATE public.provider_sessions session
   SET onboarding_authorization_method=(
    SELECT CASE WHEN action.action_type='PAIRING_CODE' THEN 'PAIRING_CODE' ELSE 'PASSKEY' END AS method
      FROM public.connection_auth_actions action
     WHERE action.tenant_id=session.tenant_id
       AND action.connection_id=session.connection_id
       AND action.state='SUCCEEDED'
       AND action.action_type IN ('PAIRING_CODE','PASSKEY_ASSERTION','PASSKEY_CONFIRM')
     ORDER BY action.completed_at DESC NULLS LAST,action.created_at DESC,action.id DESC
     LIMIT 1
  )
 WHERE session.onboarding_scan_completed_at IS NULL
   AND EXISTS (
     SELECT 1 FROM public.connection_auth_actions action
      WHERE action.tenant_id=session.tenant_id
        AND action.connection_id=session.connection_id
        AND action.state='SUCCEEDED'
        AND action.action_type IN ('PAIRING_CODE','PASSKEY_ASSERTION','PASSKEY_CONFIRM')
   );

UPDATE public.provider_sessions session
   SET onboarding_authorization_method='QR'
 WHERE session.onboarding_authorization_method IS NULL
   AND session.onboarding_qr_ready_at IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM public.audit_events audit
      WHERE audit.tenant_id=session.tenant_id
        AND audit.target_type='connection'
        AND audit.target_id=session.connection_id::text
        AND audit.action='connection.auth_qr_viewed'
   );

ALTER TABLE public.provider_sessions
  ADD CONSTRAINT provider_sessions_onboarding_acknowledgement_check CHECK (
    onboarding_scan_acknowledged_at IS NULL
    OR (
      onboarding_qr_ready_at IS NOT NULL
      AND onboarding_scan_acknowledged_at >= onboarding_qr_ready_at
    )
  ),
  ADD CONSTRAINT provider_sessions_onboarding_authorization_method_check CHECK (
    onboarding_authorization_method IS NULL
    OR onboarding_authorization_method IN ('QR','PAIRING_CODE','PASSKEY')
  );
