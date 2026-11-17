-- Public acceptance of the exact immutable customer tariff. Existing policy,
-- account-transition, funding and operator activation authority remains SSOT.
CREATE FUNCTION app.meta_billing_tariff_offers(connection_value uuid,mode_value text,choice_value uuid,after_value uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE result jsonb;
BEGIN
 IF app.current_tenant_id() IS NULL OR COALESCE(mode_value,'') NOT IN('CUSTOMER','MANAGED')
  OR (mode_value='MANAGED') IS DISTINCT FROM (choice_value IS NOT NULL) THEN
  RAISE EXCEPTION 'Invalid tariff selection scope' USING ERRCODE='22023';END IF;
 WITH eligible AS (
  SELECT tariff.id,tariff.definition_sha256,tariff.definition,terms.receipt
  FROM public.meta_connection_account_bindings binding
  JOIN public.meta_messaging_accounts account ON account.tenant_id=binding.tenant_id AND account.id=binding.account_id
  JOIN public.meta_cost_tariff_versions tariff ON tariff.tenant_id=account.tenant_id AND tariff.account_id=account.id
  CROSS JOIN LATERAL app.meta_terms_receipt_scope(tariff.tenant_id,tariff.account_id,tariff.commercial_terms_version_id,tariff.id) AS terms(receipt)
  WHERE binding.tenant_id=app.current_tenant_id() AND binding.connection_id=connection_value AND binding.state='ACTIVE'
   AND account.state<>'RETIRED' AND tariff.state='DRAFT' AND tariff.purpose='CUSTOMER_TARIFF'
   AND (after_value IS NULL OR tariff.id>after_value)
   AND terms.receipt->>'evidenceMode'=tariff.evidence_mode
   AND jsonb_typeof(terms.receipt->'documentText')='string'
   AND octet_length(terms.receipt->>'documentText') BETWEEN 1 AND 32768
   AND encode(digest(convert_to(terms.receipt->>'documentText','UTF8'),'sha256'),'hex')=terms.receipt->>'documentSha256'
   AND EXISTS(SELECT 1 FROM public.tenants WHERE id=account.tenant_id AND state='ACTIVE')
   AND NOT EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=account.tenant_id AND job_type='DELETE' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE'))
   AND (mode_value='CUSTOMER' OR EXISTS(SELECT 1 FROM public.meta_funding_arrangement_versions arrangement
    WHERE arrangement.tenant_id=account.tenant_id AND arrangement.account_id=account.id AND arrangement.id=choice_value
     AND arrangement.app_id=binding.app_id AND arrangement.state='APPROVED' AND arrangement.expires_at>clock_timestamp()
     AND arrangement.commercial_terms_version_id=tariff.commercial_terms_version_id AND arrangement.evidence_mode=tariff.evidence_mode))
  ORDER BY tariff.id LIMIT 11
 ), page AS (SELECT * FROM eligible ORDER BY id LIMIT 10)
 SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(
  (definition-ARRAY['tenantId','accountId','purpose','commercialTermsVersionId','sourceSha256'])
   ||jsonb_build_object('id',id,'definitionSha256',definition_sha256,
      'documentSha256',receipt->>'documentSha256','documentText',receipt->>'documentText') ORDER BY id) FROM page),'[]'::jsonb),
  'nextAfter',CASE WHEN (SELECT count(*) FROM eligible)>10 THEN (SELECT id::text FROM page ORDER BY id DESC LIMIT 1) ELSE NULL END) INTO result;
 RETURN result;
END;$$;

CREATE FUNCTION app.select_meta_tariff_policy(connection_value uuid,mode_value text,choice_value uuid,tariff_value uuid,
 definition_sha text,document_sha text,expected_authority bigint,actor_value uuid,key_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE binding public.meta_connection_account_bindings;tariff public.meta_cost_tariff_versions;
DECLARE terms jsonb;selected jsonb;
BEGIN
 IF app.current_tenant_id() IS NULL OR COALESCE(mode_value,'') NOT IN('CUSTOMER','MANAGED')
  OR (mode_value='MANAGED') IS DISTINCT FROM (choice_value IS NOT NULL) OR tariff_value IS NULL
  OR COALESCE(definition_sha,'')!~'^[a-f0-9]{64}$' OR COALESCE(document_sha,'')!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Invalid tariff acceptance' USING ERRCODE='22023';END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||app.current_tenant_id()::text,0))
  OR EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=app.current_tenant_id() AND job_type='DELETE' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE'))
  OR NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=app.current_tenant_id() AND state='ACTIVE')
  OR NOT EXISTS(SELECT 1 FROM public.tenant_memberships WHERE tenant_id=app.current_tenant_id() AND user_id=actor_value
   AND state='ACTIVE' AND role IN('tenant_owner','tenant_admin')) THEN
  RAISE EXCEPTION 'Tariff acceptance authority is unavailable' USING ERRCODE='55000';END IF;
 -- Existing admission primitives own privacy/reservation/account locking and CAS.
 -- The tariff share lock prevents activation racing the first acceptance.
 SELECT * INTO binding FROM public.meta_connection_account_bindings
  WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value AND state='ACTIVE';
 IF NOT FOUND THEN RAISE EXCEPTION 'Current account binding is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO tariff FROM public.meta_cost_tariff_versions
  WHERE tenant_id=binding.tenant_id AND account_id=binding.account_id AND id=tariff_value FOR SHARE;
 IF NOT FOUND OR tariff.purpose<>'CUSTOMER_TARIFF' OR tariff.definition_sha256 IS DISTINCT FROM definition_sha THEN
  RAISE EXCEPTION 'Exact draft rates are unavailable' USING ERRCODE='55000';END IF;
 terms:=app.meta_terms_receipt_scope(tariff.tenant_id,tariff.account_id,tariff.commercial_terms_version_id,tariff.id);
 IF terms IS NULL OR terms->>'evidenceMode' IS DISTINCT FROM tariff.evidence_mode
  OR terms->>'documentSha256' IS DISTINCT FROM document_sha OR jsonb_typeof(terms->'documentText') IS DISTINCT FROM 'string'
  OR octet_length(terms->>'documentText') NOT BETWEEN 1 AND 32768
  OR encode(digest(convert_to(terms->>'documentText','UTF8'),'sha256'),'hex') IS DISTINCT FROM document_sha THEN
  RAISE EXCEPTION 'Exact readable terms are unavailable' USING ERRCODE='55000';END IF;
 IF mode_value='MANAGED' THEN
  IF NOT EXISTS(SELECT 1 FROM public.meta_funding_arrangement_versions arrangement
   WHERE arrangement.tenant_id=binding.tenant_id AND arrangement.account_id=binding.account_id AND arrangement.id=choice_value
    AND arrangement.app_id=binding.app_id AND arrangement.commercial_terms_version_id=tariff.commercial_terms_version_id
    AND arrangement.evidence_mode=tariff.evidence_mode) THEN
   RAISE EXCEPTION 'Exact managed terms are unavailable' USING ERRCODE='55000';END IF;
  selected:=app.accept_meta_managed_policy(connection_value,choice_value,tariff.commercial_terms_version_id,tariff.id,expected_authority,actor_value,key_value);
 ELSE
  selected:=app.accept_meta_customer_terms(connection_value,tariff.commercial_terms_version_id,tariff.id,expected_authority,actor_value,key_value);
 END IF;
 -- Replays retain their original immutable tariff after operator activation.
 -- Any new acceptance of an activated version rolls back the complete admission.
 IF tariff.state<>'DRAFT' AND (selected->>'replay')::boolean IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'The draft changed; refresh the available rates' USING ERRCODE='40001';END IF;
 RETURN selected;
END;$$;
REVOKE ALL ON FUNCTION app.meta_billing_tariff_offers(uuid,text,uuid,uuid),app.select_meta_tariff_policy(uuid,text,uuid,uuid,text,text,bigint,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_billing_tariff_offers(uuid,text,uuid,uuid),app.select_meta_tariff_policy(uuid,text,uuid,uuid,text,text,bigint,uuid,text) TO wasalx_app;
