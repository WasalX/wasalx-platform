-- Migration 0178. Existing applied migrations remain unchanged.
-- Immutable local V1 ceiling; increasing it requires explicit migration/replay review.
CREATE TABLE public.meta_deletion_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 app_id text NOT NULL CHECK(app_id~'^[0-9]{1,32}$'),
 subject_namespace text NOT NULL DEFAULT 'FACEBOOK_ASID' CHECK(subject_namespace='FACEBOOK_ASID'),
 subject_digest text CHECK(subject_digest~'^[0-9a-f]{64}$'),
 payload_sha256 text NOT NULL CHECK(payload_sha256~'^[0-9a-f]{64}$'),
 verification_key_fingerprint text NOT NULL CHECK(verification_key_fingerprint~'^[0-9a-f]{64}$'),
 source_contract_sha256 text NOT NULL DEFAULT '454eeedfa72e8f229c02afb78f11ea6579cebc0360906af171b7f282e8c2f539'
  CHECK(source_contract_sha256='454eeedfa72e8f229c02afb78f11ea6579cebc0360906af171b7f282e8c2f539'),
 admission_policy text NOT NULL DEFAULT 'META_DELETION_LOCAL_V1_MAX2592000_SKEW300'
  CHECK(admission_policy='META_DELETION_LOCAL_V1_MAX2592000_SKEW300'),
 issued_seconds bigint NOT NULL CHECK(issued_seconds>0),
 locator text NOT NULL UNIQUE CHECK(locator~'^[0-9a-f]{64}$'),
 state text NOT NULL DEFAULT 'SCOPE_REVIEW_REQUIRED' CHECK(state IN('SCOPE_REVIEW_REQUIRED','NEEDS_INFORMATION','HELD','REFUSED')),
 review_reason text CHECK(review_reason IN('SCOPE_EVIDENCE_REQUIRED','OUTCOME_UNRESOLVED','LAWFUL_RETENTION')),
 review_evidence_sha256 text CHECK(review_evidence_sha256~'^[0-9a-f]{64}$'),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,replay_until timestamptz NOT NULL,
 reviewed_at timestamptz,minimized_at timestamptz,refusal_policy_url text,
 UNIQUE(app_id,payload_sha256),CHECK(expires_at>received_at),
 CHECK(replay_until>=expires_at AND replay_until>=to_timestamp(issued_seconds+2592301)),
 CHECK((state='REFUSED' AND refusal_policy_url IS NOT NULL AND length(refusal_policy_url)<=2048 AND refusal_policy_url~'^https://[^/?#@[:space:]]+(/[^?#[:space:]]*)?$') OR (state<>'REFUSED' AND refusal_policy_url IS NULL)),
 CHECK((minimized_at IS NULL AND subject_digest IS NOT NULL) OR (minimized_at IS NOT NULL AND state='REFUSED' AND subject_digest IS NULL AND review_evidence_sha256 IS NULL)),
 CHECK((state='SCOPE_REVIEW_REQUIRED' AND review_reason IS NULL AND review_evidence_sha256 IS NULL AND reviewed_at IS NULL)
  OR(state='NEEDS_INFORMATION' AND review_reason='SCOPE_EVIDENCE_REQUIRED' AND review_evidence_sha256 IS NOT NULL AND reviewed_at IS NOT NULL)
  OR(state='HELD' AND review_reason='OUTCOME_UNRESOLVED' AND review_evidence_sha256 IS NOT NULL AND reviewed_at IS NOT NULL)
  OR(state='REFUSED' AND review_reason='LAWFUL_RETENTION' AND (review_evidence_sha256 IS NOT NULL OR minimized_at IS NOT NULL) AND reviewed_at IS NOT NULL))
);
CREATE INDEX meta_deletion_receipts_expiry ON public.meta_deletion_receipts(replay_until,id);
CREATE TABLE public.meta_deletion_review_operations (
 receipt_id uuid NOT NULL REFERENCES public.meta_deletion_receipts(id) ON DELETE CASCADE,
 operator_subject text NOT NULL CHECK(length(operator_subject) BETWEEN 1 AND 255 AND operator_subject!~'[[:cntrl:]]'),
 idempotency_key text NOT NULL CHECK(idempotency_key~'^[A-Za-z0-9._:-]{8,128}$'),
 request_sha256 text NOT NULL CHECK(request_sha256~'^[0-9a-f]{64}$'),result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 PRIMARY KEY(receipt_id,operator_subject,idempotency_key)
);
-- One fixed surface-wide budget, never a locator/IP/subject-keyed inventory.
CREATE TABLE public.meta_deletion_status_budget(singleton boolean PRIMARY KEY CHECK(singleton),minute bigint NOT NULL,used integer NOT NULL CHECK(used BETWEEN 0 AND 120));
INSERT INTO public.meta_deletion_status_budget VALUES(true,0,0);
REVOKE ALL ON public.meta_deletion_receipts,public.meta_deletion_review_operations,public.meta_deletion_status_budget FROM PUBLIC,wasalx_app,wasalx_connector_worker,wasalx_platform_operations_client;

CREATE FUNCTION app.minimize_meta_deletion_receipts() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 DELETE FROM public.meta_deletion_receipts WHERE id IN(SELECT id FROM public.meta_deletion_receipts WHERE state='REFUSED' AND replay_until<=clock_timestamp() ORDER BY replay_until,id LIMIT 100 FOR UPDATE SKIP LOCKED);
 UPDATE public.meta_deletion_receipts SET subject_digest=NULL,review_evidence_sha256=NULL,minimized_at=clock_timestamp()
 WHERE id IN(SELECT id FROM public.meta_deletion_receipts WHERE state='REFUSED' AND expires_at<=clock_timestamp() AND minimized_at IS NULL ORDER BY expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED);
END;$$;

CREATE FUNCTION app.accept_meta_deletion_receipt(app_value text,subject_hash text,payload_hash text,key_fingerprint text,locator_value text,issued_seconds bigint,expires_seconds bigint,max_age integer,retention_days integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE existing public.meta_deletion_receipts%ROWTYPE;cutoff timestamptz;status_expiry timestamptz;
BEGIN
 IF app_value IS NULL OR app_value!~'^[0-9]{1,32}$' OR subject_hash IS NULL OR subject_hash!~'^[0-9a-f]{64}$' OR payload_hash IS NULL OR payload_hash!~'^[0-9a-f]{64}$'
  OR key_fingerprint IS NULL OR key_fingerprint!~'^[0-9a-f]{64}$' OR locator_value IS NULL OR locator_value!~'^[0-9a-f]{64}$'
  OR max_age IS NULL OR max_age NOT BETWEEN 300 AND 2592000 OR retention_days IS NULL OR retention_days NOT BETWEEN 1 AND 365 OR retention_days::bigint*86400<max_age+301 THEN
  RAISE EXCEPTION 'Deletion receipt admission is invalid' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('meta-deletion:'||app_value||':'||payload_hash,0));
 PERFORM app.minimize_meta_deletion_receipts();
 SELECT * INTO existing FROM public.meta_deletion_receipts WHERE app_id=app_value AND payload_sha256=payload_hash;
 IF FOUND THEN RETURN jsonb_build_object('locator',existing.locator); END IF;
 -- Never authorize a new receipt using a clock sampled before a lock wait.
 cutoff:=clock_timestamp();
 IF issued_seconds IS NULL OR issued_seconds<=0 OR issued_seconds>extract(epoch FROM cutoff)::bigint+300 OR issued_seconds<extract(epoch FROM cutoff)::bigint-max_age
  OR expires_seconds IS NOT NULL AND (expires_seconds<0 OR expires_seconds<>0 AND expires_seconds<=extract(epoch FROM cutoff)::bigint) THEN
  RAISE EXCEPTION 'Deletion receipt is outside the local admission window' USING ERRCODE='22023'; END IF;
 status_expiry:=cutoff+retention_days*interval '1 day';
 INSERT INTO public.meta_deletion_receipts(app_id,subject_digest,payload_sha256,verification_key_fingerprint,locator,issued_seconds,received_at,expires_at,replay_until)
 VALUES(app_value,subject_hash,payload_hash,key_fingerprint,locator_value,issued_seconds,cutoff,status_expiry,greatest(status_expiry,to_timestamp(issued_seconds+2592301)));
 RETURN jsonb_build_object('locator',locator_value);
END;$$;

CREATE FUNCTION app.meta_deletion_receipt_status(locator_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE observed_minute bigint;budget public.meta_deletion_status_budget%ROWTYPE;
BEGIN
 IF locator_value IS NULL OR locator_value!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Status request is invalid' USING ERRCODE='22023';END IF;
 SELECT * INTO budget FROM public.meta_deletion_status_budget WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Status lookup limit reached' USING ERRCODE='54000';END IF;
 -- Sample after the lock; a backward clock cannot reopen a consumed window.
 observed_minute:=greatest(floor(extract(epoch FROM clock_timestamp())/60)::bigint,budget.minute);
 IF budget.minute=observed_minute AND budget.used>=120 THEN RAISE EXCEPTION 'Status lookup limit reached' USING ERRCODE='54000';END IF;
 UPDATE public.meta_deletion_status_budget SET used=CASE WHEN minute=observed_minute THEN used+1 ELSE 1 END,minute=observed_minute WHERE singleton;
 RETURN COALESCE((SELECT jsonb_build_object('state',state,'refusalPolicyUrl',CASE WHEN state='REFUSED' THEN refusal_policy_url END) FROM public.meta_deletion_receipts
  WHERE locator=locator_value AND expires_at>clock_timestamp()),jsonb_build_object('state','UNAVAILABLE'));
END;$$;

CREATE FUNCTION app.operator_meta_deletion_receipts(operator_value text,request_value text,cursor_value uuid,locator_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF operator_value IS NULL OR length(operator_value) NOT BETWEEN 1 AND 255 OR operator_value~'[[:cntrl:]]' OR request_value IS NULL OR length(request_value) NOT BETWEEN 1 AND 255 OR request_value~'[[:cntrl:]]'
  OR locator_value IS NOT NULL AND locator_value!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Deletion review identity is invalid' USING ERRCODE='22023'; END IF;
 PERFORM app.minimize_meta_deletion_receipts();
 WITH page AS(SELECT id,jsonb_build_object('id',id,'state',state,'reason',review_reason,'receivedAt',received_at,'expiresAt',expires_at,'version',version) value
  FROM public.meta_deletion_receipts WHERE (expires_at>clock_timestamp() OR state<>'REFUSED') AND (cursor_value IS NULL OR id>cursor_value) AND (locator_value IS NULL OR locator=locator_value) ORDER BY id LIMIT 101),
 visible AS(SELECT * FROM page ORDER BY id LIMIT 100)
 SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(value ORDER BY id) FROM visible),'[]'::jsonb),'limit',100,
  'nextCursor',CASE WHEN (SELECT count(*) FROM page)>100 THEN (SELECT id::text FROM visible ORDER BY id DESC LIMIT 1) END) INTO result;
 INSERT INTO public.platform_operations_audit_events(operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(operator_value,'meta.deletion.list','meta.deletion.receipts','global',jsonb_build_object('limit',100),request_value);RETURN result;
END;$$;

CREATE FUNCTION app.operator_review_meta_deletion_receipt(receipt_value uuid,expected_version bigint,state_value text,reason_value text,evidence_hash text,key_value text,operator_value text,request_value text,policy_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE receipt public.meta_deletion_receipts%ROWTYPE;operation public.meta_deletion_review_operations%ROWTYPE;request_hash text;result jsonb;
BEGIN
 IF receipt_value IS NULL OR expected_version IS NULL OR expected_version<1 OR evidence_hash IS NULL OR evidence_hash!~'^[0-9a-f]{64}$'
  OR key_value IS NULL OR key_value!~'^[A-Za-z0-9._:-]{8,128}$' OR operator_value IS NULL OR length(operator_value) NOT BETWEEN 1 AND 255 OR operator_value~'[[:cntrl:]]'
  OR request_value IS NULL OR length(request_value) NOT BETWEEN 1 AND 255 OR request_value~'[[:cntrl:]]'
  OR COALESCE((state_value='NEEDS_INFORMATION' AND reason_value='SCOPE_EVIDENCE_REQUIRED') OR(state_value='HELD' AND reason_value='OUTCOME_UNRESOLVED') OR(state_value='REFUSED' AND reason_value='LAWFUL_RETENTION'),false)=false THEN
  RAISE EXCEPTION 'Deletion review is invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO receipt FROM public.meta_deletion_receipts WHERE id=receipt_value FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Deletion receipt is unavailable' USING ERRCODE='40001'; END IF;
 request_hash:=encode(public.digest(jsonb_build_array(expected_version,state_value,reason_value,evidence_hash)::text,'sha256'),'hex');
 SELECT * INTO operation FROM public.meta_deletion_review_operations WHERE receipt_id=receipt_value AND operator_subject=operator_value AND idempotency_key=key_value;
 IF FOUND THEN IF operation.request_sha256 IS DISTINCT FROM request_hash THEN RAISE EXCEPTION 'Deletion review replay changed' USING ERRCODE='23514'; END IF;RETURN operation.result;END IF;
 IF receipt.version<>expected_version OR receipt.state='REFUSED' THEN RAISE EXCEPTION 'Deletion review changed' USING ERRCODE='40001'; END IF;
 IF state_value='REFUSED' AND (policy_value IS NULL OR length(policy_value)>2048 OR policy_value!~'^https://[^/?#@[:space:]]+(/[^?#[:space:]]*)?$') THEN RAISE EXCEPTION 'Refusal policy is unavailable' USING ERRCODE='22023'; END IF;
 UPDATE public.meta_deletion_receipts SET state=state_value,refusal_policy_url=CASE WHEN state_value='REFUSED' THEN policy_value END,review_reason=reason_value,review_evidence_sha256=evidence_hash,reviewed_at=clock_timestamp(),version=version+1 WHERE id=receipt_value;
 result:=jsonb_build_object('id',receipt_value,'state',state_value,'reason',reason_value,'version',expected_version+1,'refusalPolicyUrl',CASE WHEN state_value='REFUSED' THEN policy_value END);
 INSERT INTO public.meta_deletion_review_operations VALUES(receipt_value,operator_value,key_value,request_hash,result);
 INSERT INTO public.platform_operations_audit_events(operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(operator_value,'meta.deletion.review','meta.deletion.receipt',receipt_value::text,jsonb_build_object('state',state_value,'reason',reason_value,'version',expected_version+1),request_value);RETURN result;
END;$$;
REVOKE ALL ON FUNCTION app.minimize_meta_deletion_receipts(),app.accept_meta_deletion_receipt(text,text,text,text,text,bigint,bigint,integer,integer),app.meta_deletion_receipt_status(text),app.operator_meta_deletion_receipts(text,text,uuid,text),app.operator_review_meta_deletion_receipt(uuid,bigint,text,text,text,text,text,text,text) FROM PUBLIC,wasalx_app,wasalx_connector_worker,wasalx_platform_operations_client;
GRANT EXECUTE ON FUNCTION app.accept_meta_deletion_receipt(text,text,text,text,text,bigint,bigint,integer,integer),app.meta_deletion_receipt_status(text) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.operator_meta_deletion_receipts(text,text,uuid,text),app.operator_review_meta_deletion_receipt(uuid,bigint,text,text,text,text,text,text,text) TO wasalx_platform_operations_client;

CREATE OR REPLACE FUNCTION app.expire_meta_signup_attempts() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
BEGIN
  PERFORM app.minimize_meta_deletion_receipts();
  UPDATE meta_signup_attempts attempt SET status='EXPIRED',reason_code='META_SIGNUP_EXPIRED',revision=revision+1,updated_at=clock_timestamp()
    WHERE attempt.id IN (SELECT id FROM meta_signup_attempts WHERE expires_at<=clock_timestamp()
      AND connection_id IS NULL AND status IN ('AWAITING_AUTHORIZATION','SELECTION_REQUIRED','NUMBER_REQUIRED','ACTION_REQUIRED')
      ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED);
  -- Bounded metadata retention follows tenant policy and every legal hold. Unknown
  -- exchanges/registrations and active operations retain their reconciliation evidence.
  UPDATE meta_signup_attempts attempt SET name='[removed]',choices='[]'::jsonb,credential_metadata=NULL,updated_at=clock_timestamp()
    WHERE attempt.id IN (SELECT a.id FROM meta_signup_attempts a JOIN tenants tenant ON tenant.id=a.tenant_id
      JOIN retention_policies policy ON policy.tenant_id=a.tenant_id
      WHERE a.status IN ('COMPLETED','CANCELLED','EXPIRED','FAILED') AND a.expires_at<clock_timestamp() AND policy.state='ACTIVE'
        AND (tenant.state='DELETING' OR a.created_at<clock_timestamp()-make_interval(days=>tenant.retention_days))
        AND (a.name<>'[removed]' OR a.choices<>'[]'::jsonb OR a.credential_metadata IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM privacy_legal_holds hold WHERE hold.tenant_id=a.tenant_id AND hold.state='ACTIVE')
        AND (a.operation_id IS NULL OR EXISTS (SELECT 1 FROM connection_operations operation WHERE operation.tenant_id=a.tenant_id
          AND operation.id=a.operation_id AND operation.state IN ('SUCCEEDED','FAILED_TERMINAL','CANCELLED')))
      ORDER BY a.created_at LIMIT 100 FOR UPDATE OF a SKIP LOCKED);
END $$;
