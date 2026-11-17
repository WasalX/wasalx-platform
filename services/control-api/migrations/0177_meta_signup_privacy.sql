BEGIN;

-- Migration 0177 adds signup metadata to the complete preceding target-kind
-- allowlist. No account or credential is deleted.
ALTER TABLE public.privacy_job_targets DROP CONSTRAINT privacy_job_targets_target_type_check;
ALTER TABLE public.privacy_job_targets ADD CONSTRAINT privacy_job_targets_target_type_check CHECK(target_type IN(
 'ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT','NORMALIZED_MESSAGE','DELIVERY',
 'META_DIRECT_ALIAS','META_DIRECT_IDENTITY_EVENT',
 'META_COEXISTENCE_MESSAGE','META_COEXISTENCE_CONTACT','META_COEXISTENCE_EVENT','META_COEXISTENCE_SUBJECT_CUTOFF',
 'META_ROUTING_EVENT','META_ROUTING_ACTION','META_COST_SOURCE','FINANCE_SOURCE_REVIEW','META_COST_RECORD','META_SIGNUP_METADATA'));

CREATE FUNCTION app.discover_meta_signup_privacy(job_value uuid,lease_value uuid,fence_value bigint) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE j public.privacy_jobs%ROWTYPE; ids uuid[]; n integer;
BEGIN
 SELECT * INTO j FROM public.privacy_jobs WHERE tenant_id=app.current_tenant_id() AND id=job_value
  AND state='RUNNING' AND stage='DISCOVER' AND lease_id=lease_value AND fencing_token=fence_value
  AND lease_expires_at>=clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'signup privacy lease lost' USING ERRCODE='40001'; END IF;
 IF j.scope_type<>'TENANT' THEN RETURN 0; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('privacy:'||j.tenant_id::text,0));
 IF j.job_type<>'EXPORT' AND EXISTS(SELECT 1 FROM public.privacy_legal_holds WHERE tenant_id=j.tenant_id AND state='ACTIVE') THEN
  IF j.job_type='RETENTION_SWEEP' THEN RETURN 0; END IF;
  RAISE EXCEPTION 'signup privacy legal hold' USING ERRCODE='P0001';
 END IF;
 -- Known-terminal attempts only. A committed credential fingerprint without
 -- credential_stored_at retains the unknown secret-write reconciliation fence.
 IF j.job_type='DELETE' AND EXISTS(SELECT 1 FROM public.meta_signup_attempts a
  WHERE a.tenant_id=j.tenant_id AND a.created_at<=j.created_at AND (
   a.status NOT IN('COMPLETED','FAILED','CANCELLED','EXPIRED')
   OR (a.credential_fingerprint IS NOT NULL AND a.credential_stored_at IS NULL)
   OR (a.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.connection_operations o
       WHERE o.tenant_id=a.tenant_id AND o.id=a.operation_id AND o.state IN('SUCCEEDED','FAILED_TERMINAL','CANCELLED'))))) THEN
  RAISE EXCEPTION 'signup privacy outcome unresolved' USING ERRCODE='P0001';
 END IF;
 SELECT array_agg(candidate.id) INTO ids FROM (
  SELECT a.id FROM public.meta_signup_attempts a JOIN public.tenants t ON t.id=a.tenant_id
   JOIN public.retention_policies p ON p.tenant_id=a.tenant_id
  WHERE a.tenant_id=j.tenant_id AND a.created_at<=j.created_at AND (
   j.job_type IN('EXPORT','DELETE') OR (
    j.job_type='RETENTION_SWEEP' AND p.state='ACTIVE' AND a.expires_at<j.created_at
    AND (t.state='DELETING' OR a.created_at<j.created_at-make_interval(days=>t.retention_days))
    AND a.status IN('COMPLETED','FAILED','CANCELLED','EXPIRED')
    AND (a.credential_fingerprint IS NULL OR a.credential_stored_at IS NOT NULL)
    AND (a.operation_id IS NULL OR EXISTS(SELECT 1 FROM public.connection_operations o WHERE o.tenant_id=a.tenant_id
     AND o.id=a.operation_id AND o.state IN('SUCCEEDED','FAILED_TERMINAL','CANCELLED')))
    AND (a.name<>'[removed]' OR a.choices<>'[]'::jsonb OR a.credential_metadata IS NOT NULL)))
  ORDER BY a.created_at,a.id LIMIT CASE WHEN j.job_type='RETENTION_SWEEP' THEN 100 ELSE 5001 END
  FOR UPDATE OF a
 ) candidate;
 IF cardinality(ids)>5000 THEN RAISE EXCEPTION 'signup privacy scope too large' USING ERRCODE='54000'; END IF;
 INSERT INTO public.privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256)
  SELECT j.tenant_id,j.id,'META_SIGNUP_METADATA',id::text,encode(public.digest(id::text,'sha256'),'hex')
  FROM unnest(ids) id ON CONFLICT(tenant_id,job_id,target_type,target_sha256) DO NOTHING;
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n;
END $$;

CREATE FUNCTION app.export_meta_signup_privacy(job_value uuid,lease_value uuid,fence_value bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE j public.privacy_jobs%ROWTYPE; result jsonb;
BEGIN
 SELECT * INTO j FROM public.privacy_jobs WHERE tenant_id=app.current_tenant_id() AND id=job_value
  AND job_type='EXPORT' AND state='RUNNING' AND stage='EXPORT' AND lease_id=lease_value
  AND fencing_token=fence_value AND lease_expires_at>=clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'signup privacy lease lost' USING ERRCODE='40001'; END IF;
 IF j.scope_type<>'TENANT' THEN RETURN '[]'::jsonb; END IF;
 IF (SELECT count(*) FROM (SELECT 1 FROM public.privacy_job_targets WHERE tenant_id=j.tenant_id AND job_id=j.id
   AND target_type='META_SIGNUP_METADATA' LIMIT 5001) bounded)>5000 THEN
  RAISE EXCEPTION 'signup privacy scope too large' USING ERRCODE='54000';
 END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'status',a.status,
   'revision',a.revision,'selectionRevision',a.selection_revision,'reasonCode',a.reason_code,
   'createdAt',a.created_at,'expiresAt',a.expires_at,'connectionId',a.connection_id,'operationId',a.operation_id,
   'selectedAsset',CASE WHEN a.selected_choice IS NULL THEN NULL ELSE jsonb_build_object(
    'businessId',a.selected_choice->'businessId','wabaId',a.selected_choice->'wabaId','phoneId',a.selected_choice->'phoneId',
    'mode',a.selected_choice->'mode','numberState',a.selected_choice->'numberState','proofSha256',a.selected_choice->'proofSha256') END)
   ORDER BY a.created_at,a.id),'[]'::jsonb) INTO result
  FROM public.meta_signup_attempts a JOIN public.privacy_job_targets target
   ON target.tenant_id=a.tenant_id AND target.target_id=a.id::text AND target.job_id=j.id
   AND target.target_type='META_SIGNUP_METADATA'
  WHERE a.tenant_id=j.tenant_id AND a.created_at<=j.created_at;
 RETURN result;
END $$;

CREATE FUNCTION app.redact_meta_signup_privacy(job_value uuid,lease_value uuid,fence_value bigint) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE j public.privacy_jobs%ROWTYPE; n integer;
BEGIN
 SELECT * INTO j FROM public.privacy_jobs WHERE tenant_id=app.current_tenant_id() AND id=job_value
  AND job_type IN('DELETE','RETENTION_SWEEP') AND scope_type='TENANT' AND state='RUNNING' AND stage='LOCAL'
  AND lease_id=lease_value AND fencing_token=fence_value AND lease_expires_at>=clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'signup privacy lease lost' USING ERRCODE='40001'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('privacy:'||j.tenant_id::text,0));
 IF EXISTS(SELECT 1 FROM public.privacy_legal_holds WHERE tenant_id=j.tenant_id AND state='ACTIVE') THEN
  RAISE EXCEPTION 'signup privacy legal hold' USING ERRCODE='P0001';
 END IF;
 -- Lock the real attempts before checking and updating their terminal metadata.
 PERFORM 1 FROM public.meta_signup_attempts a JOIN public.privacy_job_targets target
   ON target.tenant_id=a.tenant_id AND target.target_id=a.id::text AND target.job_id=j.id AND target.target_type='META_SIGNUP_METADATA'
  WHERE a.tenant_id=j.tenant_id FOR UPDATE OF a;
 IF EXISTS(SELECT 1 FROM public.privacy_job_targets target WHERE target.tenant_id=j.tenant_id AND target.job_id=j.id
  AND target.target_type='META_SIGNUP_METADATA' AND NOT EXISTS(SELECT 1 FROM public.meta_signup_attempts a
    WHERE a.tenant_id=target.tenant_id AND a.id::text=target.target_id)) THEN
  RAISE EXCEPTION 'signup privacy outcome unresolved' USING ERRCODE='P0001';
 END IF;
 IF EXISTS(SELECT 1 FROM public.meta_signup_attempts a JOIN public.privacy_job_targets target
   ON target.tenant_id=a.tenant_id AND target.target_id=a.id::text AND target.job_id=j.id AND target.target_type='META_SIGNUP_METADATA'
  WHERE a.tenant_id=j.tenant_id AND (a.created_at>j.created_at OR a.status NOT IN('COMPLETED','FAILED','CANCELLED','EXPIRED')
   OR(a.credential_fingerprint IS NOT NULL AND a.credential_stored_at IS NULL)
   OR(a.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.connection_operations o WHERE o.tenant_id=a.tenant_id
     AND o.id=a.operation_id AND o.state IN('SUCCEEDED','FAILED_TERMINAL','CANCELLED'))))) THEN
  RAISE EXCEPTION 'signup privacy outcome unresolved' USING ERRCODE='P0001';
 END IF;
 UPDATE public.meta_signup_attempts a SET name='[removed]',choices='[]'::jsonb,credential_metadata=NULL,updated_at=clock_timestamp()
  FROM public.privacy_job_targets target WHERE a.tenant_id=j.tenant_id AND target.tenant_id=a.tenant_id AND target.job_id=j.id
   AND target.target_type='META_SIGNUP_METADATA' AND target.target_id=a.id::text AND target.state='PENDING';
 GET DIAGNOSTICS n=ROW_COUNT;
 UPDATE public.privacy_job_targets SET state='COMPLETE',completed_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE tenant_id=j.tenant_id AND job_id=j.id AND target_type='META_SIGNUP_METADATA' AND state='PENDING';
 RETURN n;
END $$;

REVOKE ALL ON FUNCTION app.discover_meta_signup_privacy(uuid,uuid,bigint),app.export_meta_signup_privacy(uuid,uuid,bigint),app.redact_meta_signup_privacy(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.discover_meta_signup_privacy(uuid,uuid,bigint),app.export_meta_signup_privacy(uuid,uuid,bigint),app.redact_meta_signup_privacy(uuid,uuid,bigint) TO wasalx_connector_worker;
COMMIT;
