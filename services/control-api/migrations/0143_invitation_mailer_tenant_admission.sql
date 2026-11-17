-- Reuse the tenant lock boundary without granting the mailer tenant writes.
GRANT EXECUTE ON FUNCTION app.lock_current_active_tenant_for_event_admission()
  TO wasalx_invitation_mailer;

CREATE OR REPLACE FUNCTION app.claim_invitation_email_jobs(
  worker_id uuid,batch_size integer DEFAULT 25
)
RETURNS SETOF tenant_invitation_email_outbox
LANGUAGE plpgsql
AS $$
BEGIN
  IF worker_id IS NULL OR batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid invitation email claim' USING ERRCODE='22023';
  END IF;
  IF NOT app.lock_current_active_tenant_for_event_admission() THEN RETURN; END IF;

  UPDATE tenant_invitation_email_outbox job
     SET state='FAILED_TERMINAL',lease_id=NULL,lease_expires_at=NULL,
         error_code='EMAIL_PROVIDER_SMTP_OUTCOME_UNKNOWN',
         safe_error='Invitation delivery requires operator verification before any resend.',
         updated_at=now()
   WHERE job.tenant_id=app.current_tenant_id()
     AND job.state='SENDING' AND job.lease_expires_at<now();

  RETURN QUERY
  WITH candidates AS (
    SELECT job.id
      FROM tenant_invitation_email_outbox job
      JOIN tenant_invitations invitation
        ON invitation.tenant_id=job.tenant_id AND invitation.id=job.invitation_id
     WHERE job.tenant_id=app.current_tenant_id()
       AND invitation.state='PENDING' AND invitation.expires_at>now()
       AND job.state IN ('PENDING','FAILED_RETRYABLE') AND job.available_at<=now()
     ORDER BY job.available_at,job.created_at
     LIMIT batch_size
     FOR UPDATE OF job SKIP LOCKED
  )
  UPDATE tenant_invitation_email_outbox job
     SET state='SENDING',attempts=job.attempts+1,lease_id=worker_id,
         lease_expires_at=now()+interval '60 seconds',fencing_token=job.fencing_token+1,
         error_code=NULL,safe_error=NULL,updated_at=now()
    FROM candidates
   WHERE job.id=candidates.id
   RETURNING job.*;
END;
$$;

ALTER FUNCTION app.claim_invitation_email_jobs(uuid,integer)
  OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.claim_invitation_email_jobs(uuid,integer) FROM PUBLIC,wasalx_app;
GRANT EXECUTE ON FUNCTION app.claim_invitation_email_jobs(uuid,integer)
  TO wasalx_invitation_mailer;
REVOKE SELECT (id,state) ON public.tenants FROM wasalx_invitation_mailer;
