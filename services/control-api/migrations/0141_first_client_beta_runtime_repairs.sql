GRANT UPDATE (object_key,sha256,byte_size,expires_at,downloaded_at)
  ON public.privacy_export_artifacts
  TO wasalx_connector_worker;

ALTER TABLE public.tenant_invitations
  ADD CONSTRAINT tenant_invitations_email_canonical
  CHECK (email ~ '^[a-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&''*+/=?^_`{|}~-]+)*@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$')
  NOT VALID;
ALTER TABLE public.tenant_invitations
  VALIDATE CONSTRAINT tenant_invitations_email_canonical;

ALTER TABLE public.tenant_invitation_email_outbox
  ADD CONSTRAINT tenant_invitation_email_outbox_recipient_canonical
  CHECK (recipient_email ~ '^[a-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&''*+/=?^_`{|}~-]+)*@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$')
  NOT VALID;
ALTER TABLE public.tenant_invitation_email_outbox
  VALIDATE CONSTRAINT tenant_invitation_email_outbox_recipient_canonical;

CREATE OR REPLACE FUNCTION app.guard_privacy_target_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (TG_OP IN ('INSERT','UPDATE') AND EXISTS (
        SELECT 1 FROM privacy_jobs job
         WHERE job.tenant_id=NEW.tenant_id AND job.id=NEW.job_id
           AND job.stage<>'DISCOVER'
      ))
     OR (TG_OP IN ('DELETE','UPDATE') AND EXISTS (
        SELECT 1 FROM privacy_jobs job
         WHERE job.tenant_id=OLD.tenant_id AND job.id=OLD.job_id
           AND job.stage<>'DISCOVER'
      )) THEN
    RAISE EXCEPTION 'privacy target membership is frozen after discovery'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.guard_privacy_target_membership() FROM PUBLIC;
DROP TRIGGER privacy_target_membership_guard ON public.privacy_job_targets;
CREATE TRIGGER privacy_target_membership_guard
BEFORE INSERT OR DELETE OR UPDATE OF tenant_id,job_id,target_type,target_id,target_sha256
ON public.privacy_job_targets
FOR EACH ROW EXECUTE FUNCTION app.guard_privacy_target_membership();

CREATE OR REPLACE FUNCTION app.preserve_privacy_cutoff()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.unmatched_diagnostic_hours_snapshot IS DISTINCT FROM OLD.unmatched_diagnostic_hours_snapshot THEN
    RAISE EXCEPTION 'privacy cutoff is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.preserve_privacy_cutoff() FROM PUBLIC;

-- SMTP cannot prove that an interrupted DATA exchange was not accepted. Never
-- reclaim an expired send lease automatically; an operator may explicitly
-- resend after checking the mailbox/provider state.
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
  PERFORM 1 FROM tenants tenant
   WHERE tenant.id=app.current_tenant_id() AND tenant.state='ACTIVE'
   FOR SHARE OF tenant;
  IF NOT FOUND THEN RETURN; END IF;

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
