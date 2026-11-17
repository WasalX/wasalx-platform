-- P10b consumes the P08 historical contract. No compatibility shim or invented
-- authority is permitted when this dependency has not been integrated.
DO $$ BEGIN
  IF to_regprocedure('app.resolve_meta_message_effect(uuid,uuid,text)') IS NULL
     OR to_regprocedure('app.meta_accepted_terms_projection(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Meta historical account and accepted terms contracts are required';
  END IF;
END $$;

-- Preserve the historical receipt trigger body/owner/ACL while closing its
-- relation lookup path. The shared no-further-attempts trigger is pinned by P08.
ALTER FUNCTION app.preserve_delivery_receipt_evidence()
  SET search_path = pg_catalog, public, app, pg_temp;

-- P10 owns the one tenant-bound attempt reference key; P08 owns its evidence.
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempts_tenant_id_id_key UNIQUE (tenant_id,id);

CREATE TABLE meta_cost_tariff_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('UPSTREAM_REFERENCE','CUSTOMER_TARIFF')),
  evidence_mode text NOT NULL CHECK (evidence_mode IN ('LIVE','SIMULATED')),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
  definition_sha256 text NOT NULL CHECK (definition_sha256~'^[0-9a-f]{64}$'),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz NOT NULL CHECK (effective_to>effective_from),
  commercial_terms_version_id uuid,
  supersedes_id uuid,
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','ACTIVE')),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_by text,
  activated_at timestamptz,
  accepted_policy_version_id uuid,
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,account_id) REFERENCES meta_messaging_accounts(tenant_id,id),
  FOREIGN KEY (tenant_id,supersedes_id) REFERENCES meta_cost_tariff_versions(tenant_id,id),
  CHECK ((purpose='CUSTOMER_TARIFF')=(commercial_terms_version_id IS NOT NULL)),
  CHECK ((state='ACTIVE')=(activated_at IS NOT NULL AND activated_by IS NOT NULL)),
  CHECK (state<>'ACTIVE' OR purpose<>'CUSTOMER_TARIFF' OR accepted_policy_version_id IS NOT NULL)
);

CREATE TABLE meta_cost_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  delivery_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  account_id uuid,
  attempt_id uuid,
  external_message_sha256 text CHECK (external_message_sha256 IS NULL OR external_message_sha256~'^[0-9a-f]{64}$'),
  admission_sha256 text CHECK (admission_sha256 IS NULL OR admission_sha256~'^[0-9a-f]{64}$'),
  admission_digest_format text CHECK (admission_digest_format IS NULL OR admission_digest_format='pg-jsonb-text-v1'),
  payment_mode text NOT NULL CHECK (payment_mode IN ('CUSTOMER','MANAGED','UNKNOWN')),
  payer_state text NOT NULL CHECK (payer_state IN ('UNVERIFIED','APPROVED_SOLUTION_PARTNER','UNKNOWN')),
  purpose text NOT NULL CHECK (purpose IN ('UPSTREAM_REFERENCE','CUSTOMER_TARIFF')),
  evidence_mode text NOT NULL CHECK (evidence_mode IN ('LIVE','SIMULATED','UNKNOWN')),
  state text NOT NULL CHECK (state IN ('UNATTRIBUTED','UNPRICED','ESTIMATED','CONFLICTED')),
  reason text NOT NULL CHECK (reason~'^[A-Z_]{1,64}$'),
  delivered boolean NOT NULL,
  reported_free boolean NOT NULL,
  delivered_at timestamptz,
  pricing_basis jsonb NOT NULL,
  receipt_set_sha256 text NOT NULL CHECK (receipt_set_sha256~'^[0-9a-f]{64}$'),
  selector_evidence jsonb,
  tariff_version_id uuid,
  currency text CHECK (currency IS NULL OR currency~'^[A-Z]{3}$'),
  minor_units smallint CHECK (minor_units BETWEEN 0 AND 3),
  rounding text CHECK (rounding IN ('LINE','PERIOD')),
  unrounded_amount numeric(36,12),
  amount numeric(36,12),
  predecessor_id uuid,
  input_sha256 text NOT NULL CHECK (input_sha256~'^[0-9a-f]{64}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  evidence_redacted_at timestamptz,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,predecessor_id),
  FOREIGN KEY (tenant_id,delivery_id) REFERENCES delivery_outbox(tenant_id,id),
  FOREIGN KEY (tenant_id,connection_id) REFERENCES connections(tenant_id,id),
  FOREIGN KEY (tenant_id,account_id) REFERENCES meta_messaging_accounts(tenant_id,id),
  FOREIGN KEY (tenant_id,attempt_id) REFERENCES delivery_attempts(tenant_id,id),
  FOREIGN KEY (tenant_id,tariff_version_id) REFERENCES meta_cost_tariff_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,predecessor_id) REFERENCES meta_cost_assessments(tenant_id,id),
  CHECK ((state='ESTIMATED')=(amount IS NOT NULL AND unrounded_amount IS NOT NULL AND currency IS NOT NULL
    AND minor_units IS NOT NULL AND rounding IS NOT NULL AND tariff_version_id IS NOT NULL)),
  CHECK (state='ESTIMATED' OR (amount IS NULL AND unrounded_amount IS NULL)),
  CHECK (state<>'ESTIMATED' OR (account_id IS NOT NULL AND attempt_id IS NOT NULL AND admission_sha256 IS NOT NULL
    AND evidence_mode<>'UNKNOWN' AND delivered AND delivered_at IS NOT NULL)),
  CHECK ((admission_sha256 IS NULL)=(admission_digest_format IS NULL))
);
CREATE INDEX meta_cost_assessments_scope ON meta_cost_assessments(tenant_id,account_id,created_at,id);
CREATE INDEX meta_cost_assessments_delivery ON meta_cost_assessments(tenant_id,delivery_id,purpose,created_at,id);

ALTER TABLE meta_cost_tariff_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_cost_tariff_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY meta_cost_tariff_tenant ON meta_cost_tariff_versions
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());
ALTER TABLE meta_cost_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_cost_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY meta_cost_assessment_tenant ON meta_cost_assessments
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());

CREATE FUNCTION app.lock_meta_cost_scope(tenant_value uuid,account_value uuid,purpose_value text,mode_value text)
RETURNS void LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,app AS $$
  -- Also used by later statement publication. Period/currency are deliberately
  -- absent: overlapping periods and replacement currencies must serialize.
  SELECT pg_advisory_xact_lock(hashtextextended('meta-cost:'||tenant_value::text||':'||account_value::text||':'||purpose_value||':'||mode_value,0))
$$;

CREATE FUNCTION app.preserve_meta_cost_tariff() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.state='DRAFT' AND NEW.state='ACTIVE'
     AND (to_jsonb(NEW)-ARRAY['state','activated_at','activated_by','accepted_policy_version_id'])
       =(to_jsonb(OLD)-ARRAY['state','activated_at','activated_by','accepted_policy_version_id']) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Meta tariff content is immutable' USING ERRCODE='42501';
END $$;
CREATE TRIGGER meta_cost_tariff_immutable BEFORE UPDATE OR DELETE ON meta_cost_tariff_versions
  FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_cost_tariff();

CREATE FUNCTION app.preserve_meta_cost_assessment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.evidence_redacted_at IS NULL AND NEW.evidence_redacted_at IS NOT NULL
    AND (to_jsonb(NEW)-'evidence_redacted_at')=(to_jsonb(OLD)-'evidence_redacted_at')
    AND EXISTS(SELECT 1 FROM delivery_outbox d WHERE d.tenant_id=OLD.tenant_id AND d.id=OLD.delivery_id AND d.content_redacted_at IS NOT NULL)
    THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Meta cost assessment is append-only' USING ERRCODE='42501';
END $$;
CREATE TRIGGER meta_cost_assessment_immutable BEFORE UPDATE OR DELETE ON meta_cost_assessments
  FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_cost_assessment();
CREATE TRIGGER meta_cost_privacy_fence BEFORE INSERT OR UPDATE ON meta_cost_assessments
  FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();

CREATE FUNCTION app.redact_meta_cost_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
  IF OLD.content_redacted_at IS NULL AND NEW.content_redacted_at IS NOT NULL THEN
    UPDATE meta_cost_assessments SET evidence_redacted_at=NEW.content_redacted_at
      WHERE tenant_id=NEW.tenant_id AND delivery_id=NEW.id AND evidence_redacted_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meta_cost_delivery_redaction AFTER UPDATE OF content_redacted_at ON delivery_outbox
  FOR EACH ROW EXECUTE FUNCTION app.redact_meta_cost_evidence();

-- One classification authority. Neither API nor worker can supply a billable
-- classification, quantity or amount. READ confirms delivery but not its time.
CREATE FUNCTION app.meta_cost_pricing_basis(tenant_value uuid,delivery_value uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
  WITH receipts AS MATERIALIZED (
    SELECT r.* FROM delivery_receipts r
    WHERE r.tenant_id=tenant_value AND tenant_value=app.current_tenant_id()
      AND r.delivery_id=delivery_value AND r.provider='META' AND r.receipt_scope='MESSAGE'
    ORDER BY r.id LIMIT 1001
  ), facts AS (
    SELECT count(*) receipt_count,COALESCE(bool_or(receipt_status IN ('DELIVERED','READ')),false) delivered,
      min(provider_timestamp) FILTER(WHERE receipt_status='DELIVERED') delivered_at,
      count(DISTINCT provider_timestamp) FILTER(WHERE receipt_status='DELIVERED') delivery_times,
      count(DISTINCT jsonb_build_array(meta_pricing_model,meta_pricing_category,meta_pricing_type,meta_pricing_billable))
        FILTER(WHERE meta_pricing_state='VALID') fact_count,
      COALESCE(bool_or(meta_pricing_state='UNAVAILABLE'),false) unavailable,
      min(meta_observed_phone_number_id) phone_min,max(meta_observed_phone_number_id) phone_max,
      min(meta_observed_envelope_account_id) envelope_min,max(meta_observed_envelope_account_id) envelope_max,
      COALESCE(bool_or(meta_observed_phone_number_id IS NULL OR meta_observed_envelope_account_id IS NULL),true) context_missing,
      min(meta_pricing_model) FILTER(WHERE meta_pricing_state='VALID') model,
      min(meta_pricing_category) FILTER(WHERE meta_pricing_state='VALID') category,
      min(meta_pricing_type) FILTER(WHERE meta_pricing_state='VALID') pricing_type,
      bool_or(meta_pricing_billable) FILTER(WHERE meta_pricing_state='VALID') billable,
      encode(digest(COALESCE(jsonb_agg(jsonb_build_array(id,receipt_key_sha256,meta_pricing_revision_sha256)
        ORDER BY id)::text,'[]'),'sha256'),'hex') receipt_sha256
    FROM receipts
  ), classified AS (
    SELECT *, COALESCE(model='PMP' AND category IN ('marketing','utility','authentication','service')
      AND NOT billable AND (pricing_type='free_entry_point'
        OR (pricing_type='free_customer_service' AND category IN ('service','utility'))),false) free,
      COALESCE(model='PMP' AND category IN ('marketing','utility','authentication','service')
        AND billable AND pricing_type='regular',false) paid FROM facts
  ) SELECT jsonb_build_object('delivered',delivered,'deliveredAt',delivered_at,'reportedFree',
      receipt_count<=1000 AND delivered AND fact_count=1 AND NOT unavailable AND free,
    'category',category,'type',pricing_type,'billable',billable,'model',model,'receiptSetSha256',receipt_sha256,
    'complete',receipt_count<=1000,
    'sourceContext',jsonb_build_object('phoneNumberId',phone_min,'envelopeAccountId',envelope_min,'missing',context_missing,
      'conflicting',phone_min IS DISTINCT FROM phone_max OR envelope_min IS DISTINCT FROM envelope_max),
    'state',CASE WHEN receipt_count>1000 THEN 'UNPRICED' WHEN delivered AND (fact_count>1 OR delivery_times>1) THEN 'CONFLICTED'
      WHEN NOT delivered OR fact_count=0 OR unavailable OR NOT(free OR paid) OR delivered_at IS NULL THEN 'UNPRICED' ELSE 'COHERENT' END,
    'reason',CASE WHEN receipt_count>1000 THEN 'PRICING_EVIDENCE_LIMIT' WHEN NOT delivered THEN 'NOT_DELIVERED' WHEN fact_count>1 THEN 'CONFLICTING_PRICING'
      WHEN delivery_times>1 THEN 'CONFLICTING_DELIVERY_TIME'
      WHEN unavailable THEN 'UNAVAILABLE_PRICING' WHEN fact_count=0 THEN 'MISSING_PRICING'
      WHEN NOT(free OR paid) THEN 'UNSUPPORTED_PRICING' WHEN delivered_at IS NULL THEN 'MISSING_DELIVERY_TIME'
      WHEN free THEN 'REPORTED_FREE' ELSE 'SUPPORTED_PAID' END)
  FROM classified
$$;

CREATE FUNCTION app.assess_meta_cost_internal(delivery_value uuid,purpose_value text,selector_value jsonb,
  replace_selector boolean,expected_head uuid,actor_value text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE tenant_value uuid:=app.current_tenant_id();
DECLARE delivery_row delivery_outbox%ROWTYPE;
DECLARE previous_row meta_cost_assessments%ROWTYPE;
DECLARE tariff_row meta_cost_tariff_versions%ROWTYPE;
DECLARE historical jsonb; admission jsonb; snapshot jsonb; pricing jsonb; basis jsonb;
DECLARE account_value uuid; attempt_value uuid; admission_hash text; mode_value text:='UNKNOWN';
DECLARE state_value text; reason_value text; delivered_time timestamptz; hash_value text; result_id uuid;
DECLARE rate_value numeric(24,12); amount_value numeric(36,12); rounded_value numeric(36,12);
DECLARE accepted_tariff uuid; accepted_account uuid; accepted_mode text;
DECLARE provider_context jsonb;currency_observation jsonb;context_reason text;context_conflict boolean:=false;
BEGIN
  IF tenant_value IS NULL OR purpose_value NOT IN ('UPSTREAM_REFERENCE','CUSTOMER_TARIFF') THEN
    RAISE EXCEPTION 'invalid cost scope' USING ERRCODE='22023'; END IF;
  -- Lock order: existing privacy fence -> delivery -> account/purpose/mode.
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||tenant_value::text,0)) THEN
    RAISE EXCEPTION 'cost write is fenced by privacy' USING ERRCODE='40001'; END IF;
  SELECT d.* INTO delivery_row FROM delivery_outbox d JOIN connections c ON c.tenant_id=d.tenant_id AND c.id=d.connection_id
    WHERE d.tenant_id=tenant_value AND d.id=delivery_value AND c.provider='META' FOR UPDATE OF d;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT a.* INTO previous_row FROM meta_cost_assessments a WHERE a.tenant_id=tenant_value AND a.delivery_id=delivery_value
    AND a.purpose=purpose_value AND NOT EXISTS(SELECT 1 FROM meta_cost_assessments n WHERE n.tenant_id=a.tenant_id AND n.predecessor_id=a.id);
  IF replace_selector AND previous_row.id IS DISTINCT FROM expected_head THEN
    RAISE EXCEPTION 'cost assessment changed' USING ERRCODE='40001'; END IF;
  IF delivery_row.content_redacted_at IS NOT NULL OR app.delivery_has_active_privacy_target(delivery_value) THEN RETURN previous_row.id; END IF;
  historical:=app.resolve_meta_message_effect(tenant_value,delivery_value,delivery_row.external_message_id);
  pricing:=app.meta_cost_pricing_basis(tenant_value,delivery_value);
  delivered_time:=(pricing->>'deliveredAt')::timestamptz;
  state_value:='UNATTRIBUTED'; reason_value:=COALESCE(historical->>'reason','MISSING_ADMISSION');
  IF historical->>'state'='ATTRIBUTED' THEN
    admission:=historical->'admission'; snapshot:=admission->'snapshot';
    IF snapshot->>'claim'='ACCOUNT_POLICY_BOUND' AND snapshot->>'tenantId'=tenant_value::text
       AND snapshot->>'connectionId'=delivery_row.connection_id::text
       AND snapshot->>'identifierKind'='MESSAGING_ACCOUNT_ID'
       AND historical#>>'{effect,admissionDigest,format}'='pg-jsonb-text-v1' THEN
      account_value:=(snapshot->>'accountId')::uuid; attempt_value:=(historical#>>'{effect,attemptId}')::uuid;
      admission_hash:=historical#>>'{effect,admissionDigest,sha256}';
      mode_value:=COALESCE(admission#>>'{execution,mode}','UNKNOWN');
      IF mode_value NOT IN ('LIVE','SIMULATED') THEN mode_value:='UNKNOWN'; END IF;
      state_value:='UNPRICED'; reason_value:='UNKNOWN_EXECUTION_MODE';
    END IF;
  END IF;
  -- Compare only the retained actual-request namespace mapping. Never consult
  -- today's binding, policy, requested attachment currency or account state.
  IF account_value IS NOT NULL THEN
    provider_context:=admission->'providerContext';
    IF COALESCE((pricing#>>'{sourceContext,conflicting}')::boolean,false) THEN
      context_reason:='CONFLICTING_SOURCE_CONTEXT';context_conflict:=true;
    ELSIF provider_context->>'mapping' IS DISTINCT FROM 'PHASE1_WABA_ALIAS_VERIFIED_BINDING'
      OR snapshot->>'accountModel' IS DISTINCT FROM 'PHASE1_WABA_ALIAS'
      OR provider_context#>>'{envelopeAccount,identifierKind}' IS DISTINCT FROM 'WABA_ID'
      OR provider_context#>>'{messagingAccount,identifierKind}' IS DISTINCT FROM 'MESSAGING_ACCOUNT_ID'
      OR provider_context#>>'{messagingAccount,id}' IS DISTINCT FROM snapshot->>'providerAccountId' THEN
      context_reason:='MISSING_HISTORICAL_SOURCE_CONTEXT';
    ELSIF COALESCE((pricing#>>'{sourceContext,missing}')::boolean,true) THEN context_reason:='MISSING_RECEIPT_SOURCE_CONTEXT';
    ELSIF pricing#>>'{sourceContext,phoneNumberId}' IS DISTINCT FROM provider_context->>'phoneNumberId'
      OR pricing#>>'{sourceContext,envelopeAccountId}' IS DISTINCT FROM provider_context#>>'{envelopeAccount,id}' THEN
      context_reason:='CONFLICTING_SOURCE_CONTEXT';context_conflict:=true;
    END IF;
    currency_observation:=provider_context#>'{currencyEvidence,observation}';
  END IF;
  IF account_value IS NOT NULL THEN
    PERFORM app.lock_meta_cost_scope(tenant_value,account_value,purpose_value,mode_value);
  END IF;
  IF NOT replace_selector THEN
    selector_value:=CASE WHEN previous_row.admission_sha256=admission_hash THEN previous_row.selector_evidence ELSE NULL END;
  END IF;
  IF account_value IS NOT NULL AND mode_value<>'UNKNOWN' THEN
    state_value:=CASE WHEN pricing->>'state'='CONFLICTED' THEN 'CONFLICTED' ELSE 'UNPRICED' END;
    reason_value:=pricing->>'reason';
    IF context_reason IS NOT NULL AND (pricing->>'delivered')::boolean THEN
      state_value:=CASE WHEN context_conflict THEN 'CONFLICTED' ELSE 'UNPRICED' END;reason_value:=context_reason;
      IF context_conflict THEN pricing:=jsonb_set(pricing,'{reportedFree}','false'::jsonb); END IF;
    ELSIF pricing->>'state'='COHERENT' THEN
      -- A customer effect selects the tariff accepted by its historical policy,
      -- including after a successor is activated. Upstream reference corrections
      -- remain independently versioned and may select an approved successor.
      IF purpose_value='CUSTOMER_TARIFF' AND snapshot#>>'{payment,mode}'='MANAGED'
        AND snapshot#>>'{payment,managed,evidenceMode}'=mode_value THEN
        SELECT accepted_tariff_version_id,account_id,evidence_mode INTO accepted_tariff,accepted_account,accepted_mode
          FROM app.meta_accepted_terms_projection(tenant_value,(snapshot->>'policyVersionId')::uuid,
            (snapshot#>>'{payment,managed,commercialTermsVersionId}')::uuid);
      END IF;
      SELECT t.* INTO tariff_row FROM meta_cost_tariff_versions t
        WHERE t.tenant_id=tenant_value AND t.account_id=account_value AND t.purpose=purpose_value
          AND t.evidence_mode=mode_value AND t.state='ACTIVE'
          AND delivered_time>=t.effective_from AND delivered_time<t.effective_to
          AND ((purpose_value='CUSTOMER_TARIFF' AND t.id=accepted_tariff AND accepted_account=account_value AND accepted_mode=mode_value
            AND t.commercial_terms_version_id::text=snapshot#>>'{payment,managed,commercialTermsVersionId}')
            OR (purpose_value='UPSTREAM_REFERENCE' AND NOT EXISTS(SELECT 1 FROM meta_cost_tariff_versions newer
              WHERE newer.tenant_id=t.tenant_id AND newer.supersedes_id=t.id AND newer.state='ACTIVE')));
      reason_value:=CASE WHEN purpose_value='CUSTOMER_TARIFF' AND accepted_tariff IS NULL THEN 'MISSING_ACCEPTED_TERMS' ELSE 'MISSING_TARIFF' END;
      IF tariff_row.id IS NOT NULL THEN
        reason_value:='MISSING_UPSTREAM_CURRENCY';
        IF purpose_value='UPSTREAM_REFERENCE' AND currency_observation->>'state'='OBSERVED'
          AND currency_observation->>'currency' IS DISTINCT FROM tariff_row.definition->>'currency' THEN reason_value:='UPSTREAM_CURRENCY_MISMATCH'; END IF;
        IF purpose_value='CUSTOMER_TARIFF' OR (currency_observation->>'state'='OBSERVED'
          AND currency_observation->>'source'='META_WABA_NODE' AND currency_observation->>'graphVersion'='v24.0'
          AND currency_observation->>'identifierKind'='WABA_ID'
          AND currency_observation->>'accountId'=provider_context#>>'{envelopeAccount,id}'
          AND currency_observation->>'currency'=tariff_row.definition->>'currency') THEN
          reason_value:='MISSING_SELECTOR_EVIDENCE';
          IF purpose_value='UPSTREAM_REFERENCE' AND (pricing->>'reportedFree')::boolean THEN rate_value:=0;
          ELSIF selector_value IS NOT NULL AND selector_value->>'evidenceMode'=mode_value
            AND selector_value->>'product'='CLOUD_API' AND selector_value->>'unit'='DELIVERED_MESSAGE'
            AND selector_value->>'policyFamily'='ORDINARY_BUSINESS_MESSAGING'
            AND selector_value->>'timeBasis'='PROVIDER_DELIVERED_TIMESTAMP'
            AND delivered_time>=(selector_value->>'applicabilityFrom')::timestamptz
            AND delivered_time<(selector_value->>'applicabilityTo')::timestamptz THEN
            SELECT (rate->>'unitPrice')::numeric INTO rate_value FROM jsonb_array_elements(tariff_row.definition->'rates') rate
              WHERE rate->>'category'=pricing->>'category' AND rate->>'schedule'=selector_value->>'schedule'
                AND rate->>'pricingType'=pricing->>'type' AND rate->'billable'=pricing->'billable'
                AND rate->>'market'=selector_value->>'market' AND rate->>'tier'=selector_value->>'tier';
            IF rate_value IS NULL THEN reason_value:='MISSING_RATE'; END IF;
          END IF;
          IF rate_value IS NOT NULL THEN
            amount_value:=rate_value;
            rounded_value:=CASE WHEN tariff_row.definition->>'rounding'='LINE'
              THEN round(amount_value,(tariff_row.definition->>'minorUnits')::integer) ELSE amount_value END;
            state_value:='ESTIMATED'; reason_value:=CASE WHEN purpose_value='CUSTOMER_TARIFF' THEN 'CUSTOMER_TARIFF_RATE'
              WHEN (pricing->>'reportedFree')::boolean THEN 'REPORTED_FREE' ELSE 'PROVISIONAL_RATE' END;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  basis:=jsonb_build_object('admissionSha256',admission_hash,'mode',mode_value,'pricing',pricing,
    'selector',selector_value,'tariffVersionId',tariff_row.id,'state',state_value,'reason',reason_value);
  hash_value:=encode(digest(basis::text,'sha256'),'hex');
  IF previous_row.input_sha256=hash_value THEN RETURN previous_row.id; END IF;
  INSERT INTO meta_cost_assessments(tenant_id,delivery_id,connection_id,account_id,attempt_id,external_message_sha256,
    admission_sha256,admission_digest_format,payment_mode,payer_state,purpose,evidence_mode,state,reason,delivered,reported_free,delivered_at,
    pricing_basis,receipt_set_sha256,selector_evidence,tariff_version_id,currency,minor_units,rounding,
    unrounded_amount,amount,predecessor_id,input_sha256,created_by)
  VALUES(tenant_value,delivery_value,delivery_row.connection_id,account_value,attempt_value,delivery_row.external_message_id_sha256,
    admission_hash,CASE WHEN admission_hash IS NOT NULL THEN 'pg-jsonb-text-v1' END,
    CASE WHEN account_value IS NOT NULL THEN COALESCE(snapshot#>>'{payment,mode}','UNKNOWN') ELSE 'UNKNOWN' END,
    CASE WHEN account_value IS NOT NULL THEN COALESCE(snapshot#>>'{payment,actualPayer}','UNKNOWN') ELSE 'UNKNOWN' END,
    purpose_value,mode_value,state_value,reason_value,
    (pricing->>'delivered')::boolean,(pricing->>'reportedFree')::boolean,delivered_time,pricing,pricing->>'receiptSetSha256',selector_value,
    tariff_row.id,CASE WHEN state_value='ESTIMATED' THEN tariff_row.definition->>'currency' END,
    CASE WHEN state_value='ESTIMATED' THEN (tariff_row.definition->>'minorUnits')::smallint END,
    CASE WHEN state_value='ESTIMATED' THEN tariff_row.definition->>'rounding' END,
    amount_value,rounded_value,previous_row.id,hash_value,actor_value) RETURNING id INTO result_id;
  RETURN result_id;
END $$;

CREATE FUNCTION app.assess_meta_delivery_cost(delivery_value uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  PERFORM app.assess_meta_cost_internal(delivery_value,'UPSTREAM_REFERENCE',NULL,false,NULL,'worker');
  PERFORM app.assess_meta_cost_internal(delivery_value,'CUSTOMER_TARIFF',NULL,false,NULL,'worker');
END $$;

-- Run at transaction completion so either statement order in P08's atomic
-- attempt/outbox success write has the same historical evidence. Receipt-only
-- UNKNOWN still resolves to UNATTRIBUTED. No provider call or retry lives here.
CREATE FUNCTION app.assess_meta_cost_after_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF TG_TABLE_NAME='delivery_receipts' THEN
    IF NEW.provider='META' THEN PERFORM app.assess_meta_delivery_cost(NEW.delivery_id); END IF;
  ELSE
    IF NEW.external_message_id IS NOT NULL AND NEW.external_message_id IS DISTINCT FROM OLD.external_message_id THEN
      PERFORM app.assess_meta_delivery_cost(NEW.delivery_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER meta_cost_receipt_fact AFTER INSERT ON delivery_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assess_meta_cost_after_fact();
CREATE CONSTRAINT TRIGGER meta_cost_success_fact AFTER UPDATE ON delivery_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assess_meta_cost_after_fact();

CREATE FUNCTION app.validate_meta_cost_tariff(definition_value jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE rate jsonb; selectors integer; distinct_selectors integer;
BEGIN
  IF jsonb_typeof(definition_value) IS DISTINCT FROM 'object' OR octet_length(definition_value::text)>131072
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(definition_value) k) IS DISTINCT FROM ARRAY[
      'accountId','commercialTermsVersionId','currency','effectiveFrom','effectiveTo','evidenceMode','minorUnits','policyFamily',
      'pricingModel','product','purpose','rates','rounding','sourceSha256','tenantId','timezone','unit']::text[]
    OR definition_value->>'product' IS DISTINCT FROM 'CLOUD_API' OR definition_value->>'unit' IS DISTINCT FROM 'DELIVERED_MESSAGE'
    OR definition_value->>'pricingModel' IS DISTINCT FROM 'PMP' OR definition_value->>'policyFamily' IS DISTINCT FROM 'ORDINARY_BUSINESS_MESSAGING'
    OR COALESCE(definition_value->>'purpose','') NOT IN ('UPSTREAM_REFERENCE','CUSTOMER_TARIFF')
    OR COALESCE(definition_value->>'evidenceMode','') NOT IN ('LIVE','SIMULATED')
    OR COALESCE(definition_value->>'rounding','') NOT IN ('LINE','PERIOD')
    OR COALESCE(definition_value->>'currency','')!~'^[A-Z]{3}$'
    OR jsonb_typeof(definition_value->'minorUnits') IS DISTINCT FROM 'number' OR COALESCE(definition_value->>'minorUnits','')!~'^[0-3]$'
    OR COALESCE(definition_value->>'sourceSha256','')!~'^[0-9a-f]{64}$'
    OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=definition_value->>'timezone')
    OR jsonb_typeof(definition_value->'rates') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid Meta tariff definition' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(definition_value->'rates') NOT BETWEEN 1 AND 128
    OR COALESCE(definition_value->>'tenantId','')!~'^[0-9a-f-]{36}$'
    OR COALESCE(definition_value->>'accountId','')!~'^[0-9a-f-]{36}$'
    OR COALESCE(definition_value->>'effectiveFrom','')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    OR COALESCE(definition_value->>'effectiveTo','')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    OR (definition_value->>'effectiveFrom')::timestamptz >= (definition_value->>'effectiveTo')::timestamptz
    OR ((definition_value->>'purpose'='CUSTOMER_TARIFF') IS DISTINCT FROM (definition_value->>'commercialTermsVersionId' IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid Meta tariff scope' USING ERRCODE='22023'; END IF;
  FOR rate IN SELECT * FROM jsonb_array_elements(definition_value->'rates') LOOP
    IF jsonb_typeof(rate) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(rate) k) IS DISTINCT FROM ARRAY['billable','category','market','pricingType','schedule','tier','unitPrice']::text[]
      OR COALESCE(rate->>'category','') NOT IN ('marketing','utility','authentication','service')
      OR COALESCE(rate->>'pricingType','') NOT IN ('regular','free_customer_service','free_entry_point')
      OR jsonb_typeof(rate->'billable') IS DISTINCT FROM 'boolean'
      OR ((rate->>'pricingType'='regular') IS DISTINCT FROM (rate->>'billable'='true'))
      OR (rate->>'pricingType'='free_customer_service' AND rate->>'category' NOT IN ('utility','service'))
      OR COALESCE(rate->>'schedule','') NOT IN ('ORDINARY','AUTHENTICATION_INTERNATIONAL')
      OR (rate->>'schedule'='AUTHENTICATION_INTERNATIONAL' AND rate->>'category'<>'authentication')
      OR COALESCE(rate->>'market','')!~'^[A-Z0-9][A-Z0-9_.-]{0,63}$'
      OR COALESCE(rate->>'tier','')!~'^[A-Z0-9][A-Z0-9_.-]{0,63}$'
      OR jsonb_typeof(rate->'unitPrice') IS DISTINCT FROM 'string'
      OR COALESCE(rate->>'unitPrice','')!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$' THEN
      RAISE EXCEPTION 'invalid Meta tariff rate' USING ERRCODE='22023'; END IF;
  END LOOP;
  SELECT count(*),count(DISTINCT jsonb_build_array(r->>'category',r->>'pricingType',r->'billable',r->>'schedule',r->>'market',r->>'tier'))
    INTO selectors,distinct_selectors FROM jsonb_array_elements(definition_value->'rates') r;
  IF selectors<>distinct_selectors THEN RAISE EXCEPTION 'duplicate tariff selector' USING ERRCODE='22023'; END IF;
  IF definition_value->>'rounding'='PERIOD' AND (
    (definition_value->>'effectiveFrom')::timestamptz AT TIME ZONE (definition_value->>'timezone')
      IS DISTINCT FROM date_trunc('month',(definition_value->>'effectiveFrom')::timestamptz AT TIME ZONE (definition_value->>'timezone'))
    OR (definition_value->>'effectiveTo')::timestamptz AT TIME ZONE (definition_value->>'timezone')
      IS DISTINCT FROM ((definition_value->>'effectiveFrom')::timestamptz AT TIME ZONE (definition_value->>'timezone') + interval '1 month')) THEN
    RAISE EXCEPTION 'period rounding requires one complete account calendar month' USING ERRCODE='22023'; END IF;
END $$;

CREATE FUNCTION app.validate_meta_cost_selector(evidence_value jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF evidence_value IS NULL THEN RETURN; END IF;
  IF jsonb_typeof(evidence_value) IS DISTINCT FROM 'object' OR octet_length(evidence_value::text)>4096
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(evidence_value) k) IS DISTINCT FROM ARRAY[
      'applicabilityFrom','applicabilityTo','evidenceMode','market','marketBasis','policyFamily','product','schedule',
      'sourceSha256','tier','tierBasis','timeBasis','unit']::text[]
    OR evidence_value->>'product' IS DISTINCT FROM 'CLOUD_API' OR evidence_value->>'unit' IS DISTINCT FROM 'DELIVERED_MESSAGE'
    OR evidence_value->>'policyFamily' IS DISTINCT FROM 'ORDINARY_BUSINESS_MESSAGING'
    OR evidence_value->>'timeBasis' IS DISTINCT FROM 'PROVIDER_DELIVERED_TIMESTAMP'
    OR COALESCE(evidence_value->>'evidenceMode','') NOT IN ('LIVE','SIMULATED')
    OR COALESCE(evidence_value->>'marketBasis','') NOT IN ('AUTHORITATIVE_EFFECT_MARKET','APPROVED_MARKET_INDEPENDENT_RATE')
    OR COALESCE(evidence_value->>'tierBasis','') NOT IN ('AUTHORITATIVE_PORTFOLIO_TIER','APPROVED_PROVISIONAL_REFERENCE')
    OR COALESCE(evidence_value->>'schedule','') NOT IN ('ORDINARY','AUTHENTICATION_INTERNATIONAL')
    OR COALESCE(evidence_value->>'sourceSha256','')!~'^[0-9a-f]{64}$'
    OR COALESCE(evidence_value->>'market','')!~'^[A-Z0-9][A-Z0-9_.-]{0,63}$'
    OR COALESCE(evidence_value->>'tier','')!~'^[A-Z0-9][A-Z0-9_.-]{0,63}$'
    OR COALESCE(evidence_value->>'applicabilityFrom','')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    OR COALESCE(evidence_value->>'applicabilityTo','')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    OR (evidence_value->>'applicabilityFrom')::timestamptz >= (evidence_value->>'applicabilityTo')::timestamptz THEN
    RAISE EXCEPTION 'invalid Meta selector evidence' USING ERRCODE='22023'; END IF;
END $$;

-- Reuse the existing execution-only platform request/audit mechanism. This is
-- an explicit finite extension, not a new generic financial action registry.
ALTER TABLE platform_metering_operator_requests DROP CONSTRAINT platform_metering_operator_requests_action_check;
ALTER TABLE platform_metering_operator_requests ADD CONSTRAINT platform_metering_operator_requests_action_check
  CHECK(action IN ('SET_QUOTA','CREATE_RATE','META_COST_DRAFT','META_COST_ACTIVATE','META_COST_REASSESS'));

CREATE FUNCTION app.operator_meta_cost(action_value text,tenant_value uuid,object_value uuid,body_value jsonb,
  key_value text,actor_value text,audit_request_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE request_key text; request_hash text; request_row platform_metering_operator_requests%ROWTYPE;
DECLARE request_id uuid; tariff_row meta_cost_tariff_versions%ROWTYPE; predecessor meta_cost_tariff_versions%ROWTYPE;
DECLARE definition_value jsonb; item jsonb; response_value jsonb; ids jsonb:='[]'::jsonb; result_id uuid;
DECLARE accepted_tariff uuid; accepted_account uuid; accepted_mode text; previous_tenant text;
BEGIN
  IF COALESCE(action_value,'') NOT IN ('META_COST_DRAFT','META_COST_ACTIVATE','META_COST_REASSESS')
    OR tenant_value IS NULL OR jsonb_typeof(body_value) IS DISTINCT FROM 'object' OR octet_length(body_value::text)>131072
    OR COALESCE(length(key_value),0) NOT BETWEEN 1 AND 255 OR key_value~'[[:cntrl:]]'
    OR COALESCE(length(actor_value),0) NOT BETWEEN 1 AND 255 OR actor_value~'[[:cntrl:]]'
    OR COALESCE(length(audit_request_value),0) NOT BETWEEN 1 AND 255 OR audit_request_value~'[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid Meta cost action' USING ERRCODE='22023'; END IF;
  -- Include actor and tenant in the existing global key without exposing either.
  request_key:='meta-cost:'||encode(digest(jsonb_build_array(actor_value,tenant_value,key_value)::text,'sha256'),'hex');
  request_hash:=encode(digest(jsonb_build_array(action_value,tenant_value,object_value,body_value)::text,'sha256'),'hex');
  INSERT INTO platform_metering_operator_requests(idempotency_key,request_sha256,action,tenant_id,operator_subject)
    VALUES(request_key,request_hash,action_value,tenant_value,actor_value) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id INTO request_id;
  IF request_id IS NULL THEN
    SELECT * INTO request_row FROM platform_metering_operator_requests WHERE idempotency_key=request_key;
    IF request_row.request_sha256 IS DISTINCT FROM request_hash OR request_row.operator_subject IS DISTINCT FROM actor_value
      OR request_row.tenant_id IS DISTINCT FROM tenant_value OR request_row.action IS DISTINCT FROM action_value THEN
      RAISE EXCEPTION 'idempotency key reused' USING ERRCODE='23505'; END IF;
    RETURN request_row.response||jsonb_build_object('duplicate',true);
  END IF;
  PERFORM 1 FROM tenants WHERE id=tenant_value AND state IN ('ACTIVE','SUSPENDED') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant not found' USING ERRCODE='P0002'; END IF;
  previous_tenant:=current_setting('app.tenant_id',true);
  PERFORM set_config('app.tenant_id',tenant_value::text,true);
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||tenant_value::text,0)) THEN
    RAISE EXCEPTION 'cost action is fenced by privacy' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM privacy_jobs WHERE tenant_id=tenant_value AND job_type='DELETE' AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
    RAISE EXCEPTION 'cost action is fenced by privacy' USING ERRCODE='40001'; END IF;
  IF action_value='META_COST_DRAFT' THEN
    IF object_value IS NOT NULL OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(body_value) k)
      IS DISTINCT FROM ARRAY['definition','supersedesId']::text[] THEN RAISE EXCEPTION 'invalid tariff draft' USING ERRCODE='22023'; END IF;
    definition_value:=body_value->'definition'; PERFORM app.validate_meta_cost_tariff(definition_value);
    IF (definition_value->>'tenantId')::uuid<>tenant_value THEN RAISE EXCEPTION 'tariff tenant mismatch' USING ERRCODE='22023'; END IF;
    PERFORM 1 FROM meta_messaging_accounts WHERE tenant_id=tenant_value AND id=(definition_value->>'accountId')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'account not found' USING ERRCODE='P0002'; END IF;
    INSERT INTO meta_cost_tariff_versions(tenant_id,account_id,purpose,evidence_mode,definition,definition_sha256,effective_from,effective_to,
      commercial_terms_version_id,supersedes_id,created_by)
    VALUES(tenant_value,(definition_value->>'accountId')::uuid,definition_value->>'purpose',definition_value->>'evidenceMode',definition_value,
      encode(digest(definition_value::text,'sha256'),'hex'),(definition_value->>'effectiveFrom')::timestamptz,(definition_value->>'effectiveTo')::timestamptz,
      (definition_value->>'commercialTermsVersionId')::uuid,(body_value->>'supersedesId')::uuid,actor_value) RETURNING * INTO tariff_row;
    response_value:=jsonb_build_object('id',tariff_row.id,'state',tariff_row.state,'definitionSha256',tariff_row.definition_sha256);
  ELSIF action_value='META_COST_ACTIVATE' THEN
    IF object_value IS NULL OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(body_value) k)
      IS DISTINCT FROM ARRAY['expectedDefinitionSha256','policyVersionId']::text[] THEN RAISE EXCEPTION 'invalid tariff approval' USING ERRCODE='22023'; END IF;
    SELECT * INTO tariff_row FROM meta_cost_tariff_versions WHERE tenant_id=tenant_value AND id=object_value;
    IF NOT FOUND THEN RAISE EXCEPTION 'tariff not found' USING ERRCODE='P0002'; END IF;
    PERFORM app.lock_meta_cost_scope(tenant_value,tariff_row.account_id,tariff_row.purpose,tariff_row.evidence_mode);
    SELECT * INTO tariff_row FROM meta_cost_tariff_versions WHERE tenant_id=tenant_value AND id=object_value FOR UPDATE;
    IF tariff_row.state<>'DRAFT' OR tariff_row.definition_sha256 IS DISTINCT FROM body_value->>'expectedDefinitionSha256' THEN
      RAISE EXCEPTION 'tariff changed' USING ERRCODE='40001'; END IF;
    IF tariff_row.purpose='CUSTOMER_TARIFF' THEN
      SELECT accepted_tariff_version_id,account_id,evidence_mode INTO accepted_tariff,accepted_account,accepted_mode
        FROM app.meta_accepted_terms_projection(tenant_value,(body_value->>'policyVersionId')::uuid,tariff_row.commercial_terms_version_id);
      IF accepted_tariff IS DISTINCT FROM tariff_row.id OR accepted_account IS DISTINCT FROM tariff_row.account_id
        OR accepted_mode IS DISTINCT FROM tariff_row.evidence_mode THEN RAISE EXCEPTION 'accepted tariff terms unavailable' USING ERRCODE='55000'; END IF;
    ELSIF body_value->>'policyVersionId' IS NOT NULL THEN RAISE EXCEPTION 'unexpected tariff policy' USING ERRCODE='22023'; END IF;
    IF tariff_row.supersedes_id IS NOT NULL THEN
      SELECT * INTO predecessor FROM meta_cost_tariff_versions WHERE tenant_id=tenant_value AND id=tariff_row.supersedes_id;
      IF predecessor.state IS DISTINCT FROM 'ACTIVE' OR predecessor.account_id IS DISTINCT FROM tariff_row.account_id
        OR predecessor.purpose IS DISTINCT FROM tariff_row.purpose OR predecessor.evidence_mode IS DISTINCT FROM tariff_row.evidence_mode
        OR predecessor.effective_from IS DISTINCT FROM tariff_row.effective_from OR predecessor.effective_to IS DISTINCT FROM tariff_row.effective_to
        OR EXISTS(SELECT 1 FROM meta_cost_tariff_versions t WHERE t.tenant_id=tenant_value AND t.supersedes_id=predecessor.id AND t.state='ACTIVE') THEN
        RAISE EXCEPTION 'tariff replacement changed' USING ERRCODE='40001'; END IF;
    END IF;
    IF EXISTS(SELECT 1 FROM meta_cost_tariff_versions t WHERE t.tenant_id=tenant_value AND t.account_id=tariff_row.account_id
      AND t.purpose=tariff_row.purpose AND t.evidence_mode=tariff_row.evidence_mode AND t.state='ACTIVE'
      AND t.effective_from<tariff_row.effective_to AND t.effective_to>tariff_row.effective_from
      AND t.id IS DISTINCT FROM tariff_row.supersedes_id
      AND NOT EXISTS(SELECT 1 FROM meta_cost_tariff_versions n WHERE n.tenant_id=t.tenant_id AND n.supersedes_id=t.id AND n.state='ACTIVE')) THEN
      RAISE EXCEPTION 'tariff periods overlap' USING ERRCODE='40001'; END IF;
    UPDATE meta_cost_tariff_versions SET state='ACTIVE',activated_at=clock_timestamp(),activated_by=actor_value,
      accepted_policy_version_id=(body_value->>'policyVersionId')::uuid WHERE id=tariff_row.id;
    response_value:=jsonb_build_object('id',tariff_row.id,'state','ACTIVE','definitionSha256',tariff_row.definition_sha256);
  ELSE
    IF object_value IS NULL OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(body_value) k) IS DISTINCT FROM ARRAY['items','purpose']::text[]
      OR COALESCE(body_value->>'purpose','') NOT IN ('UPSTREAM_REFERENCE','CUSTOMER_TARIFF')
      OR jsonb_typeof(body_value->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid cost reassessment' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(body_value->'items') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'reassessment limit exceeded' USING ERRCODE='22023'; END IF;
    IF (SELECT count(DISTINCT e->>'deliveryId') FROM jsonb_array_elements(body_value->'items') e)<>jsonb_array_length(body_value->'items') THEN
      RAISE EXCEPTION 'duplicate reassessment effect' USING ERRCODE='22023'; END IF;
    -- Lock every selected delivery first, consistently ordered, before the assessor
    -- takes account locks. No external work occurs while these locks are held.
    PERFORM d.id FROM delivery_outbox d WHERE d.tenant_id=tenant_value
      AND d.id IN(SELECT (e->>'deliveryId')::uuid FROM jsonb_array_elements(body_value->'items') e) ORDER BY d.id FOR UPDATE;
    FOR item IN SELECT e FROM jsonb_array_elements(body_value->'items') e ORDER BY e->>'deliveryId' LOOP
      IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(item) k)
        IS DISTINCT FROM (CASE WHEN item ? 'selectorEvidence' THEN ARRAY['deliveryId','expectedHeadId','selectorEvidence']::text[]
          ELSE ARRAY['deliveryId','expectedHeadId']::text[] END) THEN RAISE EXCEPTION 'invalid reassessment item' USING ERRCODE='22023'; END IF;
      PERFORM app.validate_meta_cost_selector(NULLIF(item->'selectorEvidence','null'::jsonb));
      IF NOT EXISTS(SELECT 1 FROM meta_cost_assessments a WHERE a.tenant_id=tenant_value AND a.delivery_id=(item->>'deliveryId')::uuid
        AND a.account_id=object_value AND a.purpose=body_value->>'purpose' AND a.id=(item->>'expectedHeadId')::uuid
        AND NOT EXISTS(SELECT 1 FROM meta_cost_assessments n WHERE n.tenant_id=a.tenant_id AND n.predecessor_id=a.id)) THEN
        RAISE EXCEPTION 'assessment scope changed' USING ERRCODE='40001'; END IF;
      -- Omitted evidence retains this exact head's reviewed facts; explicit null
      -- withdraws them. These operations must never be confused by a blank file input.
      result_id:=app.assess_meta_cost_internal((item->>'deliveryId')::uuid,body_value->>'purpose',
        CASE WHEN item ? 'selectorEvidence' THEN NULLIF(item->'selectorEvidence','null'::jsonb)
          ELSE (SELECT a.selector_evidence FROM meta_cost_assessments a WHERE a.tenant_id=tenant_value AND a.id=(item->>'expectedHeadId')::uuid) END,
        true,(item->>'expectedHeadId')::uuid,actor_value);
      ids:=ids||jsonb_build_array(result_id);
    END LOOP;
    response_value:=jsonb_build_object('assessmentIds',ids,'count',jsonb_array_length(ids));
  END IF;
  response_value:=response_value||jsonb_build_object('duplicate',false);
  UPDATE platform_metering_operator_requests SET response=response_value WHERE id=request_id;
  INSERT INTO platform_operations_audit_events(operator_subject,action,target_type,target_id,safe_metadata,request_id)
    VALUES(actor_value,lower(action_value),'meta_cost',COALESCE(tariff_row.id,object_value,tenant_value)::text,
      jsonb_build_object('tenantId',tenant_value,'requestSha256',request_hash,'resultSha256',encode(digest(response_value::text,'sha256'),'hex')),audit_request_value);
  PERFORM set_config('app.tenant_id',COALESCE(previous_tenant,''),true);
  RETURN response_value;
END $$;

-- A single statement supplies the complete bounded set, totals and digest.
-- NULL account means the unattributed view, never a guess from current policy.
CREATE FUNCTION app.meta_cost_usage_snapshot(tenant_value uuid,account_value uuid,from_value timestamptz,to_value timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
  WITH selected AS MATERIALIZED (
    SELECT a.id,a.delivery_id,a.account_id,a.purpose,a.evidence_mode,
      CASE WHEN a.evidence_redacted_at IS NULL THEN a.state ELSE 'UNATTRIBUTED' END state,
      CASE WHEN a.evidence_redacted_at IS NULL THEN a.reason ELSE 'EVIDENCE_REDACTED' END reason,a.delivered,a.reported_free,
      a.delivered_at,a.created_at,a.tariff_version_id,a.currency,a.minor_units,a.rounding,
      CASE WHEN a.evidence_redacted_at IS NULL THEN a.unrounded_amount END unrounded_amount,
      CASE WHEN a.evidence_redacted_at IS NULL THEN a.amount END amount,
      a.receipt_set_sha256,a.evidence_redacted_at,t.effective_from,t.effective_to,
      a.input_sha256,a.admission_sha256,a.admission_digest_format,a.payment_mode,a.payer_state
    FROM meta_cost_assessments a JOIN delivery_outbox d ON d.tenant_id=a.tenant_id AND d.id=a.delivery_id
    LEFT JOIN meta_cost_tariff_versions t ON t.tenant_id=a.tenant_id AND t.id=a.tariff_version_id
    WHERE a.tenant_id=tenant_value AND tenant_value=app.current_tenant_id()
      AND a.account_id IS NOT DISTINCT FROM account_value
      AND COALESCE(a.delivered_at,d.created_at)>=from_value AND COALESCE(a.delivered_at,d.created_at)<to_value
      AND NOT EXISTS(SELECT 1 FROM meta_cost_assessments n WHERE n.tenant_id=a.tenant_id AND n.predecessor_id=a.id)
    UNION ALL
    SELECT NULL::uuid,d.id,NULL::uuid,p.purpose,'UNKNOWN','UNATTRIBUTED','NO_HISTORICAL_ASSESSMENT',
      d.state IN ('DELIVERED','READ'),false,NULL::timestamptz,d.created_at,NULL::uuid,NULL::text,NULL::smallint,NULL::text,
      NULL::numeric,NULL::numeric,NULL::text,d.content_redacted_at,NULL::timestamptz,NULL::timestamptz,
      NULL::text,NULL::text,NULL::text,'UNKNOWN','UNKNOWN'
    FROM delivery_outbox d JOIN connections c ON c.tenant_id=d.tenant_id AND c.id=d.connection_id
    CROSS JOIN (VALUES('UPSTREAM_REFERENCE'),('CUSTOMER_TARIFF')) p(purpose)
    WHERE d.tenant_id=tenant_value AND tenant_value=app.current_tenant_id() AND account_value IS NULL AND c.provider='META'
      AND d.created_at>=from_value AND d.created_at<to_value
      AND NOT EXISTS(SELECT 1 FROM meta_cost_assessments a WHERE a.tenant_id=d.tenant_id AND a.delivery_id=d.id AND a.purpose=p.purpose)
    ORDER BY delivery_id,purpose LIMIT 10001
  ), summary AS (
    SELECT count(*) selected_count,encode(digest(COALESCE(jsonb_agg(jsonb_build_array(id,delivery_id,purpose,receipt_set_sha256,evidence_redacted_at)
      ORDER BY delivery_id,purpose)::text,'[]'),'sha256'),'hex') selected_sha256 FROM selected
  ), totals AS (
    SELECT purpose,evidence_mode,currency,minor_units,rounding,tariff_version_id,effective_from,effective_to,
      count(*) quantity,sum(unrounded_amount) unrounded,
      CASE WHEN rounding='LINE' THEN sum(amount)
        WHEN from_value<=effective_from AND to_value>=effective_to THEN round(sum(unrounded_amount),minor_units)
        ELSE NULL END total,
      rounding='PERIOD' AND (from_value>effective_from OR to_value<effective_to) partial_period
    FROM selected WHERE state='ESTIMATED' GROUP BY purpose,evidence_mode,currency,minor_units,rounding,tariff_version_id,effective_from,effective_to
  ), coverage AS (
    SELECT purpose,evidence_mode,count(*) effects,count(*) FILTER(WHERE delivered) delivered,
      count(*) FILTER(WHERE reported_free) reported_free,count(*) FILTER(WHERE state='ESTIMATED') estimated,
      count(*) FILTER(WHERE state<>'ESTIMATED' OR evidence_redacted_at IS NOT NULL) unresolved
    FROM selected GROUP BY purpose,evidence_mode
  ) SELECT jsonb_build_object('complete',selected_count<=10000,'selectedCount',selected_count,'selectedSha256',selected_sha256,
    'from',from_value,'to',to_value,'accountId',account_value,
    'rows',CASE WHEN selected_count>10000 THEN '[]'::jsonb ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',id,'deliveryId',delivery_id,'accountId',account_id,'purpose',purpose,'evidenceMode',evidence_mode,'state',state,'reason',reason,
      'delivered',delivered,'reportedFree',reported_free,'deliveredAt',delivered_at,'observedAt',created_at,
      'tariffVersionId',tariff_version_id,'currency',currency,'minorUnits',minor_units,'rounding',rounding,
      'inputSha256',input_sha256,'receiptSetSha256',receipt_set_sha256,'admissionSha256',admission_sha256,
      'admissionDigestFormat',admission_digest_format,'paymentMode',payment_mode,'payerState',payer_state,
      'timeBasis',CASE WHEN delivered_at IS NOT NULL THEN 'PROVIDER_DELIVERED_TIMESTAMP' ELSE 'UNKNOWN' END,
      'unroundedAmount',unrounded_amount::text,'amount',amount::text,'evidenceRedacted',evidence_redacted_at IS NOT NULL)
      ORDER BY delivery_id,purpose) FROM selected),'[]'::jsonb) END,
    'totals',CASE WHEN selected_count>10000 THEN '[]'::jsonb ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'purpose',purpose,'evidenceMode',evidence_mode,'currency',currency,'minorUnits',minor_units,'rounding',rounding,
      'tariffVersionId',tariff_version_id,'periodFrom',effective_from,'periodTo',effective_to,
      'quantity',quantity,'unroundedAmount',unrounded::text,'amount',total::text,'partialPeriod',partial_period)
      ORDER BY purpose,evidence_mode,currency,tariff_version_id) FROM totals),'[]'::jsonb) END,
    'coverage',CASE WHEN selected_count>10000 THEN '[]'::jsonb ELSE COALESCE((SELECT jsonb_agg(to_jsonb(coverage) ORDER BY purpose,evidence_mode) FROM coverage),'[]'::jsonb) END)
  FROM summary
$$;

CREATE FUNCTION app.meta_cost_accounts(tenant_value uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(account) ORDER BY account.id),'[]'::jsonb) FROM (
    SELECT a.id,COALESCE(array_agg(DISTINCT c.name ORDER BY c.name) FILTER(WHERE c.name IS NOT NULL),'{}') AS names
    FROM meta_messaging_accounts a LEFT JOIN meta_connection_account_bindings b ON b.tenant_id=a.tenant_id AND b.account_id=a.id
    LEFT JOIN connections c ON c.tenant_id=b.tenant_id AND c.id=b.connection_id
    WHERE a.tenant_id=tenant_value AND tenant_value=app.current_tenant_id() GROUP BY a.id ORDER BY a.id LIMIT 101
  ) account
$$;

CREATE FUNCTION app.operator_meta_cost_read(tenant_value uuid,account_value uuid,from_value timestamptz,to_value timestamptz,
  actor_value text,audit_request_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE previous_tenant text; response_value jsonb; tariffs jsonb; accounts jsonb;
BEGIN
  IF tenant_value IS NULL OR from_value IS NULL OR to_value IS NULL OR from_value>=to_value OR to_value-from_value>interval '366 days'
    OR COALESCE(length(actor_value),0) NOT BETWEEN 1 AND 255 OR actor_value~'[[:cntrl:]]'
    OR COALESCE(length(audit_request_value),0) NOT BETWEEN 1 AND 255 OR audit_request_value~'[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid Meta cost read' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM tenants WHERE id=tenant_value) THEN RAISE EXCEPTION 'tenant not found' USING ERRCODE='P0002'; END IF;
  previous_tenant:=current_setting('app.tenant_id',true); PERFORM set_config('app.tenant_id',tenant_value::text,true);
  response_value:=app.meta_cost_usage_snapshot(tenant_value,account_value,from_value,to_value);
  accounts:=app.meta_cost_accounts(tenant_value);
  IF jsonb_array_length(accounts)>100 THEN RAISE EXCEPTION 'account selection limit exceeded' USING ERRCODE='54000'; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at,t.id),'[]'::jsonb) INTO tariffs FROM (
    SELECT tariff.id,tariff.state,tariff.definition,tariff.definition_sha256,tariff.supersedes_id,
      tariff.accepted_policy_version_id,tariff.created_at,tariff.activated_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',policy.id,'createdAt',policy.created_at) ORDER BY policy.created_at,policy.id)
        FROM meta_billing_policy_versions policy CROSS JOIN LATERAL app.meta_accepted_terms_projection(tenant_value,policy.id,tariff.commercial_terms_version_id) accepted
        WHERE policy.tenant_id=tenant_value AND policy.account_id=account_value AND accepted.account_id=account_value
          AND accepted.accepted_tariff_version_id=tariff.id AND accepted.evidence_mode=tariff.evidence_mode),'[]'::jsonb) AS accepted_policies
    FROM meta_cost_tariff_versions tariff WHERE tariff.tenant_id=tenant_value AND tariff.account_id=account_value ORDER BY tariff.created_at DESC,tariff.id LIMIT 101
  ) t;
  IF jsonb_array_length(tariffs)>100 THEN RAISE EXCEPTION 'tariff history limit exceeded' USING ERRCODE='54000'; END IF;
  INSERT INTO platform_operations_audit_events(operator_subject,action,target_type,target_id,safe_metadata,request_id)
    VALUES(actor_value,'meta.cost.read','meta_cost',COALESCE(account_value,tenant_value)::text,
      jsonb_build_object('tenantId',tenant_value,'selectedSha256',response_value->>'selectedSha256','selectedCount',response_value->'selectedCount'),audit_request_value);
  PERFORM set_config('app.tenant_id',COALESCE(previous_tenant,''),true);
  RETURN response_value||jsonb_build_object('tariffs',tariffs,'accounts',accounts);
END $$;

REVOKE ALL ON meta_cost_tariff_versions,meta_cost_assessments FROM PUBLIC,wasalx_app,wasalx_connector_worker;
GRANT SELECT ON meta_cost_tariff_versions,meta_cost_assessments TO wasalx_app,wasalx_connector_worker;
REVOKE ALL ON FUNCTION app.lock_meta_cost_scope(uuid,uuid,text,text),app.preserve_meta_cost_tariff(),
  app.preserve_meta_cost_assessment(),app.redact_meta_cost_evidence(),app.meta_cost_pricing_basis(uuid,uuid),
  app.assess_meta_cost_internal(uuid,text,jsonb,boolean,uuid,text),app.assess_meta_delivery_cost(uuid),app.assess_meta_cost_after_fact(),
  app.validate_meta_cost_tariff(jsonb),app.validate_meta_cost_selector(jsonb),
  app.operator_meta_cost(text,uuid,uuid,jsonb,text,text,text),app.meta_cost_usage_snapshot(uuid,uuid,timestamptz,timestamptz),
  app.operator_meta_cost_read(uuid,uuid,timestamptz,timestamptz,text,text),app.meta_cost_accounts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assess_meta_delivery_cost(uuid) TO wasalx_connector_worker;
GRANT EXECUTE ON FUNCTION app.operator_meta_cost(text,uuid,uuid,jsonb,text,text,text) TO wasalx_platform_operations_client;
GRANT EXECUTE ON FUNCTION app.operator_meta_cost_read(uuid,uuid,timestamptz,timestamptz,text,text) TO wasalx_platform_operations_client;
GRANT EXECUTE ON FUNCTION app.meta_cost_usage_snapshot(uuid,uuid,timestamptz,timestamptz) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.meta_cost_accounts(uuid) TO wasalx_app;

-- Reuse the incumbent privacy delivery relationships for cost evidence, including
-- group mentions and quoted participants without a ticket. This is a read-only
-- scoped predicate; it does not create subject, send, account or payer authority.
CREATE FUNCTION app.meta_cost_subject_delivery_matches(delivery public.delivery_outbox,participant_value text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT delivery.tenant_id=app.current_tenant_id() AND(
  delivery.external_chat_id=participant_value
  OR(delivery.direct_origin IS NOT NULL AND app.meta_direct_participant_matches(delivery.connection_id,delivery.external_chat_id,participant_value))
  OR participant_value=ANY(delivery.mentions)
  OR EXISTS(SELECT 1 FROM public.normalized_messages quoted
    JOIN public.whatsapp_groups message_group ON message_group.tenant_id=quoted.tenant_id
     AND message_group.connection_id=quoted.connection_id AND message_group.external_group_id=quoted.external_group_id
    LEFT JOIN public.group_bindings binding ON binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id
    WHERE quoted.tenant_id=delivery.tenant_id AND quoted.connection_id=delivery.connection_id
     AND quoted.external_message_id=delivery.reply_to_message_id AND quoted.external_participant_id=participant_value
     AND message_group.id=COALESCE(delivery.group_workspace_group_id,binding.whatsapp_group_id)))
$$;
REVOKE ALL ON FUNCTION app.meta_cost_subject_delivery_matches(public.delivery_outbox,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_cost_subject_delivery_matches(public.delivery_outbox,text) TO wasalx_connector_worker;
