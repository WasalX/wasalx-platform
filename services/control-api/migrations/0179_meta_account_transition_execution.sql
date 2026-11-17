-- Root assigns the next real contiguous ordinal after predecessor178.
-- No provider eligibility or LIVE approval is established by this migration.
BEGIN;

-- P09 logical fragment: META_ACCOUNT_TRANSITION_RESERVATIONS.sql
-- Bound source SHA256: 53997d7cd735c7b2582c50a622d5f36c3a8c3e3f3d87c0889808bc1c9c5a98ab
-- PRIVATE DRAFT, UNAPPLIED. Root assigns the final ordinal only after the
-- complete P08/P09 mutation-reader union and execution functions are composed.
CREATE TABLE public.meta_account_transition_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  transition_id uuid NOT NULL,
  account_role text NOT NULL CHECK(account_role IN ('SOURCE','TARGET')),
  scope_sha256 text NOT NULL CHECK(scope_sha256 ~ '^[a-f0-9]{64}$'),
  authority_revision bigint NOT NULL CHECK(authority_revision BETWEEN 1 AND 9007199254740991),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  release_reason text CHECK(release_reason IN ('PRE_EFFECT_CANCEL','VERIFIED_SUCCESSOR')),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,transition_id,account_id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES public.meta_messaging_accounts(tenant_id,id),
  FOREIGN KEY(tenant_id,transition_id) REFERENCES public.meta_account_transitions(tenant_id,id),
  CHECK((released_at IS NULL)=(release_reason IS NULL))
);
CREATE UNIQUE INDEX meta_transition_one_account_reservation
  ON public.meta_account_transition_reservations(tenant_id,account_id) WHERE released_at IS NULL;
ALTER TABLE public.meta_account_transition_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_account_transition_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.meta_account_transition_reservations
  USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
GRANT SELECT ON public.meta_account_transition_reservations TO wasalx_app,wasalx_connector_worker;
-- No direct INSERT/UPDATE/DELETE. The complete execution migration adds only
-- the reviewed narrow reserve/cancel/successor functions, not a generic writer.
CREATE TRIGGER meta_transition_reservation_privacy_fence BEFORE INSERT OR UPDATE
  ON public.meta_account_transition_reservations FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();

CREATE FUNCTION app.preserve_meta_transition_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Account transition reservation history is retained' USING ERRCODE='55000';
  END IF;
  IF (NEW.id,NEW.tenant_id,NEW.account_id,NEW.transition_id,NEW.account_role,NEW.scope_sha256,
      NEW.authority_revision,NEW.reserved_at) IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.account_id,OLD.transition_id,OLD.account_role,OLD.scope_sha256,
      OLD.authority_revision,OLD.reserved_at)
     OR OLD.released_at IS NOT NULL OR NEW.revision<>OLD.revision+1 OR NEW.released_at IS NULL THEN
    RAISE EXCEPTION 'Account transition reservation is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.release_reason='PRE_EFFECT_CANCEL' AND EXISTS(
    SELECT 1 FROM public.meta_provider_effect_checkpoints e
    WHERE e.tenant_id=OLD.tenant_id AND e.owner_kind='ACCOUNT_TRANSITION' AND e.owner_id=OLD.transition_id
      AND e.outcome IN ('ATTEMPTED','SUCCEEDED','UNKNOWN')) THEN
    RAISE EXCEPTION 'External transition effects prevent local cancellation' USING ERRCODE='55000';
  END IF;
  -- VERIFIED_SUCCESSOR release requires the complete successor function and
  -- its corresponding immutable provider/currentness receipt; not granted here.
  RETURN NEW;
END $$;
CREATE TRIGGER meta_transition_reservation_immutable BEFORE UPDATE OR DELETE
  ON public.meta_account_transition_reservations FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_transition_reservation();
REVOKE ALL ON FUNCTION app.preserve_meta_transition_reservation() FROM PUBLIC;

/** Ordinary mutation callers use this shared check after their connection lock
 * and before account/binding/operation authority changes. NOWAIT avoids adding
 * a waited inverse-order cycle to the older funding/account consumers. */
CREATE FUNCTION app.assert_meta_account_unreserved(account_value uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET row_security=off SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE account_row public.meta_messaging_accounts;
BEGIN
  IF app.current_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'Account mutation has no tenant' USING ERRCODE='42501';
  END IF;
  SELECT * INTO account_row FROM public.meta_messaging_accounts
    WHERE tenant_id=app.current_tenant_id() AND id=account_value FOR UPDATE NOWAIT;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM public.meta_account_transition_reservations r
      WHERE r.tenant_id=account_row.tenant_id AND r.account_id=account_row.id AND r.released_at IS NULL) THEN
    RAISE EXCEPTION 'Account transition reserves this authority' USING ERRCODE='55000';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.assert_meta_account_unreserved(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assert_meta_account_unreserved(uuid) TO wasalx_app,wasalx_connector_worker;

/** Read diagnostics must not invoke this as a general access gate. The effect
 * guard checks both binding and provider-account fallback for newly enrolled
 * connections; no current binding cannot silently mean unreserved. */
CREATE FUNCTION app.assert_meta_connection_account_unreserved(connection_value uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET row_security=off SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE account_value uuid; connection_row public.connections;
BEGIN
  SELECT * INTO connection_row FROM public.connections WHERE tenant_id=app.current_tenant_id()
    AND id=connection_value AND provider='META';
  IF NOT FOUND THEN RAISE EXCEPTION 'Current Meta connection is unavailable' USING ERRCODE='55000'; END IF;
  FOR account_value IN
    SELECT DISTINCT a.id FROM public.meta_messaging_accounts a
    WHERE a.tenant_id=connection_row.tenant_id AND (
      EXISTS(SELECT 1 FROM public.meta_connection_account_bindings b WHERE b.tenant_id=a.tenant_id
        AND b.account_id=a.id AND b.connection_id=connection_row.id AND b.state<>'RETIRED')
      OR EXISTS(SELECT 1 FROM public.provider_sessions s WHERE s.tenant_id=a.tenant_id
        AND s.connection_id=connection_row.id AND s.ownership_state='ACTIVE'
        AND s.provider_state_data->>'wabaId'=a.provider_account_id)) ORDER BY a.id
  LOOP
    PERFORM app.assert_meta_account_unreserved(account_value);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.assert_meta_connection_account_unreserved(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assert_meta_connection_account_unreserved(uuid) TO wasalx_app,wasalx_connector_worker;

-- P09 logical fragment: META_ACCOUNT_TRANSITION_EXECUTION.sql
-- Bound source SHA256: 48f50eea9be92c6b52ea438c2b0634de67c2cc77de4d9eeb585446472cffc513
-- Unapplied P09 companion. Root assigns the contiguous ordinal after P08b/P09a.
-- This execution role has no login and is never granted to an application role.
-- Only finite functions below own it; no caller flag can impersonate a coordinator.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='wasalx_meta_transition_executor') THEN
  CREATE ROLE wasalx_meta_transition_executor NOLOGIN NOINHERIT;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public,app TO wasalx_meta_transition_executor;
GRANT SELECT ON public.tenants,public.tenant_memberships,public.connections,public.provider_sessions,
 public.webhook_routes,public.connection_operations,public.privacy_jobs,public.delivery_outbox,
 public.meta_messaging_accounts,public.meta_connection_account_bindings,public.meta_billing_policy_versions,
 public.meta_funding_arrangement_versions,public.platform_operations_audit_events,
 public.meta_account_transitions,public.meta_provider_effect_checkpoints,
 public.bot_assignments,public.bot_conversations,public.bot_flow_versions,public.participant_identities
 TO wasalx_meta_transition_executor;
GRANT INSERT,UPDATE ON public.connection_operations,public.meta_account_transitions,
 public.meta_messaging_accounts,public.meta_connection_account_bindings,public.meta_provider_effect_checkpoints
 TO wasalx_meta_transition_executor;
GRANT UPDATE ON public.connections,public.provider_sessions,public.webhook_routes TO wasalx_meta_transition_executor;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(),app.lock_privacy_scoped_write(),
 app.lock_current_active_tenant_for_event_admission(),app.meta_direct_transition_effects_clear(uuid,uuid)
 TO wasalx_meta_transition_executor;

ALTER TABLE public.meta_account_transitions
 ADD COLUMN execution_state text NOT NULL DEFAULT 'UNPREPARED' CHECK(execution_state IN
  ('UNPREPARED','RESERVED','INITIATED','READY_TO_COMPLETE','PROVIDER_COMPLETED','RECONCILED_PAUSED','HELD')),
 ADD COLUMN execution_scope jsonb,
 ADD COLUMN execution_scope_sha256 text CHECK(execution_scope_sha256 ~ '^[a-f0-9]{64}$'),
 ADD COLUMN execution_authorization_id uuid REFERENCES public.platform_operations_audit_events(id),
 ADD COLUMN execution_operation_id uuid,
 ADD COLUMN execution_confirmation_sha256 text CHECK(execution_confirmation_sha256 ~ '^[a-f0-9]{64}$'),
 ADD COLUMN provider_migration_id text CHECK(char_length(provider_migration_id)<=256 AND provider_migration_id ~ '^[A-Za-z0-9_-]+$'),
 ADD COLUMN target_account_id uuid,
 ADD COLUMN provider_status text CHECK(provider_status IN('INITIATED','ACCEPTED','IN_PROGRESS','READY_TO_COMPLETE','COMPLETED','FAILED','FAILED_TO_COMPLETE','REJECTED')),
 ADD COLUMN provider_observation_operation_id uuid,
 ADD COLUMN observer_operations jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK(jsonb_typeof(observer_operations)='object' AND octet_length(observer_operations::text)<=262144),
 ADD COLUMN identity_successor_receipt jsonb,
 ADD COLUMN reconciled_at timestamptz,
 ADD FOREIGN KEY(tenant_id,execution_operation_id) REFERENCES public.connection_operations(tenant_id,id),
 ADD FOREIGN KEY(tenant_id,provider_observation_operation_id) REFERENCES public.connection_operations(tenant_id,id),
 ADD FOREIGN KEY(tenant_id,target_account_id) REFERENCES public.meta_messaging_accounts(tenant_id,id),
 ADD CHECK(execution_scope IS NULL OR (jsonb_typeof(execution_scope)='object' AND octet_length(execution_scope::text)<=4194304)),
 ADD CHECK((identity_successor_receipt IS NULL)=(reconciled_at IS NULL));
DROP INDEX public.meta_account_transitions_current;
CREATE UNIQUE INDEX meta_account_transitions_current ON public.meta_account_transitions(tenant_id,source_account_id)
 WHERE state<>'CANCELLED' AND execution_state<>'RECONCILED_PAUSED';

-- Bindings are append-only across a transition; old account IDs never change.
ALTER TABLE public.meta_connection_account_bindings
 DROP CONSTRAINT meta_connection_account_bindings_tenant_id_connection_id_key,
 ADD COLUMN predecessor_binding_id uuid,
 ADD COLUMN account_transition_id uuid,
 ADD FOREIGN KEY(tenant_id,predecessor_binding_id) REFERENCES public.meta_connection_account_bindings(tenant_id,id),
 ADD FOREIGN KEY(tenant_id,account_transition_id) REFERENCES public.meta_account_transitions(tenant_id,id),
 ADD CHECK((predecessor_binding_id IS NULL)=(account_transition_id IS NULL));
CREATE UNIQUE INDEX meta_account_binding_current ON public.meta_connection_account_bindings(tenant_id,connection_id) WHERE state<>'RETIRED';
CREATE UNIQUE INDEX meta_account_binding_successor ON public.meta_connection_account_bindings(tenant_id,predecessor_binding_id) WHERE predecessor_binding_id IS NOT NULL;

-- The existing globally stable owner+stage key remains the one-shot key.
-- ATTACH and managed transitions retain their approved arrangement requirement.
ALTER TABLE public.meta_provider_effect_checkpoints ALTER COLUMN arrangement_version_id DROP NOT NULL;
ALTER TABLE public.meta_provider_effect_checkpoints ADD CONSTRAINT meta_transition_arrangement_scope CHECK(
 arrangement_version_id IS NOT NULL OR (owner_kind='ACCOUNT_TRANSITION' AND stage IN('INITIATE','COMPLETE')));

CREATE FUNCTION app.meta_transition_scope(account_value uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 RETURN (SELECT jsonb_build_object('accountId',a.id,'providerAccountId',a.provider_account_id,'authorityRevision',a.authority_revision,
  'policyId',a.requested_policy_version_id,'activePolicyId',a.active_policy_version_id,
  'bindings',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',b.id,'revision',b.revision,'connectionId',b.connection_id,
   'sessionId',b.provider_session_id,'phoneId',b.phone_number_id,'appId',b.app_id,'secretReference',b.secret_reference,
   'fingerprint',b.credential_fingerprint,'proofSha256',b.proof_sha256,'state',b.state,
   'connectionState',c.state,'connectionSecretReference',c.secret_reference,'sessionState',s.state,
   'ownershipState',s.ownership_state,'providerState',s.provider_state_data,
   'identitySha256',encode(public.digest(app.meta_account_identity_scope(b.connection_id,b.provider_session_id,b.phone_number_id,a.provider_account_id)::text,'sha256'),'hex')) ORDER BY b.connection_id,b.id)
   FROM public.meta_connection_account_bindings b JOIN public.connections c ON c.tenant_id=b.tenant_id AND c.id=b.connection_id
   JOIN public.provider_sessions s ON s.tenant_id=b.tenant_id AND s.id=b.provider_session_id
   WHERE b.tenant_id=a.tenant_id AND b.account_id=a.id AND b.state<>'RETIRED'),'[]'::jsonb),
  'flows',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.id,'sha256',f.snapshot_sha256) ORDER BY f.id)
   FROM public.bot_flow_versions f WHERE f.tenant_id=a.tenant_id AND f.id IN(
    SELECT x.flow_version_id FROM public.bot_assignments x JOIN public.meta_connection_account_bindings b
     ON b.tenant_id=x.tenant_id AND b.connection_id=x.connection_id WHERE b.tenant_id=a.tenant_id AND b.account_id=a.id AND b.state<>'RETIRED'
    UNION SELECT x.flow_version_id FROM public.bot_conversations x JOIN public.meta_connection_account_bindings b
     ON b.tenant_id=x.tenant_id AND b.connection_id=x.connection_id WHERE b.tenant_id=a.tenant_id AND b.account_id=a.id AND b.state<>'RETIRED')),'[]'::jsonb))
 FROM public.meta_messaging_accounts a WHERE a.tenant_id=app.current_tenant_id() AND a.id=account_value);
END $$;
REVOKE ALL ON FUNCTION app.meta_transition_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_scope(uuid) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;

-- Same full scope and NOWAIT discipline for the coordinator and all ordinary
-- callers. Any later conflicting inverse lock aborts before a provider slot.
CREATE FUNCTION app.lock_meta_transition_accounts(accounts_value uuid[]) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE item uuid; tenant_value uuid:=app.current_tenant_id();
BEGIN
 IF tenant_value IS NULL OR cardinality(accounts_value) NOT BETWEEN 1 AND 2
  OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||tenant_value::text,0)) THEN
  RAISE EXCEPTION 'Account scope is unavailable' USING ERRCODE='55000'; END IF;
 FOR item IN SELECT DISTINCT b.connection_id FROM public.meta_connection_account_bindings b
  WHERE b.tenant_id=tenant_value AND b.account_id=ANY(accounts_value) AND b.state<>'RETIRED' ORDER BY b.connection_id
 LOOP
  PERFORM 1 FROM public.connections WHERE tenant_id=tenant_value AND id=item FOR UPDATE NOWAIT;
 END LOOP;
 FOR item IN SELECT DISTINCT unnest(accounts_value) ORDER BY 1 LOOP
  PERFORM 1 FROM public.meta_messaging_accounts WHERE tenant_id=tenant_value AND id=item FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account scope is unavailable' USING ERRCODE='55000'; END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.lock_meta_transition_accounts(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_meta_transition_accounts(uuid[]) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;

CREATE FUNCTION app.meta_transition_drained(account_value uuid,excluded_operation uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.meta_connection_account_bindings b
  WHERE b.tenant_id=app.current_tenant_id() AND b.account_id=account_value AND b.state<>'RETIRED' AND (
   EXISTS(SELECT 1 FROM public.connection_operations o WHERE o.tenant_id=b.tenant_id AND o.connection_id=b.connection_id
    AND o.id IS DISTINCT FROM excluded_operation AND o.state IN('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE'))
   OR EXISTS(SELECT 1 FROM public.delivery_outbox d WHERE d.tenant_id=b.tenant_id AND d.connection_id=b.connection_id
    AND (d.state IN('SENDING','OUTCOME_UNKNOWN') OR (d.state='CLAIMED' AND d.lease_expires_at>=clock_timestamp())))
   OR EXISTS(SELECT 1 FROM public.participant_identities p WHERE p.tenant_id=b.tenant_id AND p.connection_id=b.connection_id
    AND NOT app.meta_direct_transition_effects_clear(b.connection_id,p.id))))
$$;
REVOKE ALL ON FUNCTION app.meta_transition_drained(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_drained(uuid,uuid) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;

CREATE FUNCTION app.meta_transition_actor_current(actor_value uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF NOT app.lock_current_active_tenant_for_event_admission() THEN RAISE EXCEPTION 'Workspace unavailable' USING ERRCODE='55000';END IF;
 PERFORM 1 FROM public.tenant_memberships WHERE tenant_id=app.current_tenant_id() AND user_id=actor_value
  AND state='ACTIVE' AND role IN('tenant_owner','tenant_admin') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Current account administration is required' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=app.current_tenant_id() AND job_type='DELETE'
  AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN RAISE EXCEPTION 'Privacy fences this transition' USING ERRCODE='55000';END IF;
END $$;
REVOKE ALL ON FUNCTION app.meta_transition_actor_current(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_actor_current(uuid) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;

-- No tenant-supplied claim becomes provider eligibility. This finite platform
-- review binds independently captured prerequisites to one exact preview.
-- A registered SIMULATED receipt is not permission for real Graph traffic.
CREATE FUNCTION app.operator_authorize_meta_transition(transition_value uuid,expected_revision bigint,candidate jsonb,operator_value text,request_value text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions; a public.meta_messaging_accounts; r uuid:=gen_random_uuid();scope_value jsonb;arrangement public.meta_funding_arrangement_versions;original jsonb;
BEGIN
 SELECT * INTO p FROM public.meta_account_transitions WHERE id=transition_value;
 IF NOT FOUND OR p.state='CANCELLED' OR p.revision<>expected_revision OR p.execution_state='RECONCILED_PAUSED'
  OR jsonb_typeof(candidate) IS DISTINCT FROM 'object' OR octet_length(candidate::text)>65536
  OR COALESCE(candidate->>'appId','') !~ '^[0-9]{1,32}$'
  OR candidate->>'tenantId' IS DISTINCT FROM p.tenant_id::text OR candidate->>'sourceAccountId' IS DISTINCT FROM p.source_account_id::text
  OR candidate->>'transitionId' IS DISTINCT FROM p.id::text OR candidate->>'requestedMode' IS DISTINCT FROM p.requested_mode
  OR candidate->>'targetCurrency' IS DISTINCT FROM p.target_currency
  OR candidate->>'mode' IS DISTINCT FROM 'SIMULATED'
  OR candidate->>'graphVersion' IS DISTINCT FROM 'v24.0'
  OR candidate->>'variant' IS DISTINCT FROM 'STANDARD_SAME_HIERARCHY'
  OR candidate->>'adminAuthority' IS DISTINCT FROM 'VERIFIED'
  OR candidate->>'phoneScope' IS DISTINCT FROM 'COMPLETE_LOCAL_ONLY'
  OR candidate->>'templateScope' IS DISTINCT FROM 'VERIFIED'
  OR candidate->>'sourceCurrency' IS NULL OR candidate->>'sourceCurrency'=p.target_currency
  OR COALESCE(candidate->>'evidenceSha256','') !~ '^[a-f0-9]{64}$'
  OR COALESCE(candidate->>'scopeSha256','') !~ '^[a-f0-9]{64}$'
  OR candidate->>'expiresAt' IS NULL OR (candidate->>'expiresAt')::timestamptz<=clock_timestamp()
  OR (candidate->>'expiresAt')::timestamptz>clock_timestamp()+interval '15 minutes'
  OR operator_value IS NULL OR length(operator_value) NOT BETWEEN 1 AND 255 OR operator_value~'[[:cntrl:]]'
  OR request_value IS NULL OR length(request_value) NOT BETWEEN 1 AND 255 OR request_value~'[[:cntrl:]]' THEN
  RAISE EXCEPTION 'Transition prerequisite evidence is unavailable' USING ERRCODE='55000';END IF;
 -- The platform role is cross-tenant; never trust a caller tenant GUC as scope.
 SELECT * INTO a FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=p.source_account_id;
 IF a.state='RETIRED' OR a.authority_revision::text IS DISTINCT FROM candidate->>'authorityRevision' THEN
  RAISE EXCEPTION 'Source account changed' USING ERRCODE='55000';END IF;
 IF p.requested_mode='CUSTOMER' THEN
  IF candidate->>'sourcePayment' IS DISTINCT FROM 'CARD' OR candidate->>'paymentAction' IS DISTINCT FROM 'RETAIN_CARD'
   OR candidate ? 'arrangementVersionId' OR candidate ? 'creditLineId' THEN RAISE EXCEPTION 'Customer currency change must retain its verified card' USING ERRCODE='55000';END IF;
 ELSE
  SELECT * INTO arrangement FROM public.meta_funding_arrangement_versions WHERE tenant_id=p.tenant_id
   AND account_id=p.source_account_id AND id=(candidate->>'arrangementVersionId')::uuid;
  IF NOT FOUND OR arrangement.state<>'APPROVED' OR arrangement.expires_at<=clock_timestamp() OR arrangement.evidence_mode<>'SIMULATED'
   OR candidate->>'paymentAction' IS DISTINCT FROM 'APPROVED_LINE'
   OR COALESCE(candidate->>'sourcePayment','') NOT IN('CARD','LINE')
   OR candidate->>'creditLineId' IS DISTINCT FROM arrangement.credit_line_id
   OR candidate->>'delegatedHolderBusinessId' IS DISTINCT FROM arrangement.holder_business_id
   OR COALESCE(candidate->>'targetReceivingBusinessId','') !~ '^[0-9]{1,32}$'
   OR COALESCE(candidate->>'targetTermsDocumentSha256','') !~ '^[a-f0-9]{64}$'
   OR COALESCE(candidate->>'targetTermsVersion','') !~ '^[A-Za-z0-9._-]{1,128}$'
   OR jsonb_typeof(candidate->'targetTermsDocumentText') IS DISTINCT FROM 'string'
   OR octet_length(candidate->>'targetTermsDocumentText') NOT BETWEEN 1 AND 32768
   OR encode(public.digest(convert_to(candidate->>'targetTermsDocumentText','UTF8'),'sha256'),'hex') IS DISTINCT FROM candidate->>'targetTermsDocumentSha256'
   OR arrangement.app_id IS DISTINCT FROM candidate->>'appId'
   OR candidate->>'cloneFundingGrant' IS DISTINCT FROM 'EXACT_TRANSITION_DERIVED_TARGET' THEN
   RAISE EXCEPTION 'A separately approved clone funding grant is required' USING ERRCODE='55000';END IF;
 END IF;
 IF p.execution_authorization_id IS NOT NULL THEN
  SELECT safe_metadata INTO original FROM public.platform_operations_audit_events WHERE id=p.execution_authorization_id;
  IF (candidate-ARRAY['expiresAt','evidenceSha256','scopeSha256','authorityRevision']) IS DISTINCT FROM
   (original-ARRAY['expiresAt','evidenceSha256','scopeSha256','authorityRevision','previewRevision','sourcePolicyVersionId']) THEN
   RAISE EXCEPTION 'Original accepted transition grant is immutable' USING ERRCODE='55000';END IF;
 END IF;
 INSERT INTO public.platform_operations_audit_events(id,operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(r,operator_value,'meta.transition.prerequisites.simulated.approved','meta.account_transition',p.id::text,
  candidate||jsonb_build_object('previewRevision',p.revision,'sourcePolicyVersionId',a.active_policy_version_id),request_value);
 RETURN jsonb_build_object('receiptId',r,'transitionId',p.id,'mode','SIMULATED');
END $$;
REVOKE ALL ON FUNCTION app.operator_authorize_meta_transition(uuid,bigint,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_authorize_meta_transition(uuid,bigint,jsonb,text,text) TO wasalx_platform_operations_client;

CREATE FUNCTION app.meta_transition_authorization(transition_value uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT e.safe_metadata||jsonb_build_object('receiptId',e.id) FROM public.meta_account_transitions p
 JOIN public.platform_operations_audit_events e ON e.target_id=p.id::text AND e.action='meta.transition.prerequisites.simulated.approved'
 WHERE p.tenant_id=app.current_tenant_id() AND p.id=transition_value
  AND e.safe_metadata->>'tenantId'=p.tenant_id::text AND e.safe_metadata->>'sourceAccountId'=p.source_account_id::text
  AND (p.execution_authorization_id IS NULL OR
   (e.safe_metadata-ARRAY['expiresAt','evidenceSha256','scopeSha256','authorityRevision','previewRevision','sourcePolicyVersionId'])=
   (SELECT original.safe_metadata-ARRAY['expiresAt','evidenceSha256','scopeSha256','authorityRevision','previewRevision','sourcePolicyVersionId']
    FROM public.platform_operations_audit_events original WHERE original.id=p.execution_authorization_id))
  AND (e.safe_metadata->>'expiresAt')::timestamptz>clock_timestamp()
  AND NOT EXISTS(SELECT 1 FROM public.platform_operations_audit_events x WHERE x.action='meta.transition.authorization.withdrawn' AND x.target_id=e.id::text)
 ORDER BY e.created_at DESC,e.id DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.meta_transition_authorization(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_authorization(uuid) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;

-- More functions follow in this same migration; no partial migration is applied.
CREATE FUNCTION app.meta_transition_confirmation(transition_value uuid) RETURNS text
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 BEGIN RETURN (SELECT encode(public.digest(jsonb_build_object('transitionId',p.id,'revision',p.revision,
  'scope',app.meta_transition_scope(p.source_account_id),'authorization',app.meta_transition_authorization(p.id),
  'observers',p.observer_operations,'completionAuthority',app.meta_transition_completion_authorization(p.id),
  'migrationId',p.provider_migration_id,'targetAccountId',p.target_account_id,'status',p.provider_status,
  'observationOperationId',p.provider_observation_operation_id,'mode',p.requested_mode,'currency',p.target_currency)::text,'sha256'),'hex')
 FROM public.meta_account_transitions p WHERE p.tenant_id=app.current_tenant_id() AND p.id=transition_value); END
$$;
REVOKE ALL ON FUNCTION app.meta_transition_confirmation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_confirmation(uuid) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;

CREATE FUNCTION app.queue_meta_transition_action(plan_value uuid,connection_value uuid,actor_value uuid,revision_value bigint,
 preview_sha text,key_value text,action_value text,request_value text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions; a public.meta_messaging_accounts; existing public.connection_operations;
 operation_value uuid:=gen_random_uuid(); authorization_value jsonb; scope_value jsonb; scope_sha text;
BEGIN
 PERFORM app.meta_transition_actor_current(actor_value);
 PERFORM app.lock_meta_transition_request(key_value);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value;
 IF NOT FOUND OR connection_value<>p.initiating_connection_id OR p.state='CANCELLED'
  OR COALESCE(action_value,'') NOT IN('INITIATE','COMPLETE','OBSERVE','RECONCILE')
  OR revision_value IS NULL OR revision_value NOT BETWEEN 1 AND 9007199254740991
  OR key_value IS NULL OR length(key_value) NOT BETWEEN 1 AND 200 OR key_value~'[[:cntrl:]]'
  OR COALESCE(preview_sha,'') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Account transition is unavailable' USING ERRCODE='55000';END IF;
 PERFORM app.lock_meta_transition_accounts(array_remove(ARRAY[p.source_account_id,p.target_account_id],NULL));
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value FOR UPDATE NOWAIT;
 SELECT * INTO existing FROM public.connection_operations WHERE tenant_id=p.tenant_id AND idempotency_key=key_value;
 IF FOUND THEN
  IF existing.operation_type<>'EXECUTE_META_ACCOUNT_TRANSITION' OR existing.connection_id<>connection_value
   OR existing.requested_by_id<>actor_value::text OR existing.payload#>>'{metaAccountTransitionExecution,id}'<>p.id::text
   OR existing.payload#>>'{metaAccountTransitionExecution,action}'<>action_value
   OR existing.payload#>>'{metaAccountTransitionExecution,requestRevision}'<>revision_value::text
   OR existing.payload#>>'{metaAccountTransitionExecution,requestPreviewSha256}'<>preview_sha THEN
   RAISE EXCEPTION 'Request key belongs to another action' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('id',p.id,'operationId',existing.id,'duplicate',true);
 END IF;
 IF p.revision<>revision_value OR app.meta_transition_confirmation(p.id) IS DISTINCT FROM preview_sha
  OR p.execution_state='RECONCILED_PAUSED' OR EXISTS(SELECT 1 FROM public.connection_operations o WHERE o.tenant_id=p.tenant_id
   AND o.id=p.execution_operation_id AND o.state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
  RAISE EXCEPTION 'Transition confirmation changed' USING ERRCODE='55000';END IF;
 IF action_value IN('INITIATE','COMPLETE') AND EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints e
  WHERE e.tenant_id=p.tenant_id AND e.owner_kind='ACCOUNT_TRANSITION' AND e.owner_id=p.id AND e.stage=action_value) THEN
  RAISE EXCEPTION 'Original provider stage cannot be replayed' USING ERRCODE='55000';END IF;
 IF action_value IN('OBSERVE','COMPLETE','RECONCILE') AND p.provider_migration_id IS NULL THEN
  RAISE EXCEPTION 'No captured provider migration is available' USING ERRCODE='55000';END IF;
 authorization_value:=app.meta_transition_authorization(p.id);
 IF action_value IN('INITIATE','COMPLETE') AND authorization_value IS NULL THEN
  RAISE EXCEPTION 'Current prerequisite review is required' USING ERRCODE='55000';END IF;
 IF action_value='INITIATE' THEN
  IF p.execution_state<>'UNPREPARED' OR p.expires_at<=clock_timestamp()
   OR NOT app.meta_transition_drained(p.source_account_id,NULL) THEN
   RAISE EXCEPTION 'Account effects must be drained before initiation' USING ERRCODE='55000';END IF;
  scope_value:=app.meta_transition_scope(p.source_account_id);
  scope_sha:=encode(public.digest(scope_value::text,'sha256'),'hex');
  IF scope_sha IS DISTINCT FROM authorization_value->>'scopeSha256'
   OR jsonb_array_length(scope_value->'bindings') NOT BETWEEN 1 AND 2000
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(scope_value->'bindings') b WHERE b->>'state'<>'ACTIVE'
    OR b->>'ownershipState'<>'ACTIVE' OR b->>'secretReference' IS DISTINCT FROM b->>'connectionSecretReference') THEN
   RAISE EXCEPTION 'Reviewed account scope changed' USING ERRCODE='55000';END IF;
  -- Quiesce every affected connection. The generation change permanently
  -- invalidates pre-reservation queued births, even after local cancellation.
  UPDATE public.connections c SET state='PAUSED',updated_at=now() WHERE c.tenant_id=p.tenant_id
   AND c.id IN(SELECT b.connection_id FROM public.meta_connection_account_bindings b WHERE b.tenant_id=p.tenant_id AND b.account_id=p.source_account_id AND b.state<>'RETIRED');
  UPDATE public.provider_sessions s SET state='PAUSED',updated_at=now() WHERE s.tenant_id=p.tenant_id
   AND s.id IN(SELECT b.provider_session_id FROM public.meta_connection_account_bindings b WHERE b.tenant_id=p.tenant_id AND b.account_id=p.source_account_id AND b.state<>'RETIRED');
  UPDATE public.webhook_routes r SET state='PAUSED',updated_at=now() WHERE r.tenant_id=p.tenant_id AND r.provider='META'
   AND r.connection_id IN(SELECT b.connection_id FROM public.meta_connection_account_bindings b WHERE b.tenant_id=p.tenant_id AND b.account_id=p.source_account_id AND b.state<>'RETIRED');
  UPDATE public.meta_messaging_accounts SET state='HELD',authority_revision=authority_revision+1,updated_at=now()
   WHERE tenant_id=p.tenant_id AND id=p.source_account_id RETURNING * INTO a;
  scope_value:=app.meta_transition_scope(p.source_account_id);
  scope_sha:=encode(public.digest(scope_value::text,'sha256'),'hex');
  -- The original reservation and execution plan share the exact post-quiesce
  -- scope and authority under the already-held account/connection locks.
  INSERT INTO public.meta_account_transition_reservations(tenant_id,account_id,transition_id,account_role,scope_sha256,authority_revision)
   VALUES(p.tenant_id,p.source_account_id,p.id,'SOURCE',scope_sha,a.authority_revision);
 ELSE
  scope_value:=p.execution_scope;scope_sha:=p.execution_scope_sha256;
  IF NOT EXISTS(SELECT 1 FROM public.meta_account_transition_reservations r WHERE r.tenant_id=p.tenant_id
   AND r.transition_id=p.id AND r.account_id=p.source_account_id AND r.released_at IS NULL) THEN
   RAISE EXCEPTION 'Original reservation is unavailable' USING ERRCODE='55000';END IF;
 END IF;
 IF action_value='COMPLETE' AND p.observer_operations ? p.initiating_binding_id::text
  AND app.meta_transition_completion_authorization(p.id) IS NULL THEN RAISE EXCEPTION 'Renewed access has no completion authority' USING ERRCODE='55000';END IF;
 IF action_value='COMPLETE' AND p.provider_status<>'READY_TO_COMPLETE' THEN RAISE EXCEPTION 'Provider is not ready to complete' USING ERRCODE='55000';END IF;
 IF action_value='RECONCILE' AND (p.provider_status IS DISTINCT FROM 'COMPLETED'
  OR app.meta_transition_nonidentity_scope(app.meta_transition_scope(p.source_account_id)) IS DISTINCT FROM app.meta_transition_nonidentity_scope(p.execution_scope))
  THEN RAISE EXCEPTION 'Provider completion or original nonidentity scope is not established' USING ERRCODE='55000';END IF;
 INSERT INTO public.connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,requested_by_id,request_id,max_attempts)
 VALUES(operation_value,p.tenant_id,connection_value,'EXECUTE_META_ACCOUNT_TRANSITION',key_value,
  jsonb_build_object('metaAccountTransitionExecution',jsonb_build_object('id',p.id,'action',action_value,'revision',p.revision+1,
   'requestRevision',revision_value,'requestPreviewSha256',preview_sha,'scopeSha256',scope_sha,
   'observerOperationIds',p.observer_operations,
   'completionAuthorizationId',CASE WHEN action_value='COMPLETE' THEN app.meta_transition_completion_authorization(p.id)->>'receiptId' ELSE NULL END,
   'localIdentityScope',CASE WHEN action_value='RECONCILE' THEN app.meta_transition_identity_snapshot(app.meta_transition_scope(p.source_account_id)) ELSE NULL END)),
  'USER',actor_value::text,request_value,1);
 UPDATE public.meta_account_transitions SET execution_state=CASE WHEN action_value='INITIATE' THEN 'RESERVED' ELSE execution_state END,
  execution_scope=scope_value,execution_scope_sha256=scope_sha,execution_authorization_id=COALESCE(execution_authorization_id,(authorization_value->>'receiptId')::uuid),
  execution_operation_id=operation_value,execution_confirmation_sha256=preview_sha,revision=revision+1,updated_at=now()
  WHERE tenant_id=p.tenant_id AND id=p.id;
 RETURN jsonb_build_object('id',p.id,'operationId',operation_value,'duplicate',false);
END $$;
ALTER FUNCTION app.queue_meta_transition_action(uuid,uuid,uuid,bigint,text,text,text,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.queue_meta_transition_action(uuid,uuid,uuid,bigint,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.queue_meta_transition_action(uuid,uuid,uuid,bigint,text,text,text,text) TO wasalx_app;

-- Only identity digests may differ for explicit local reconciliation after
-- provider COMPLETED. Original effect scope and every other authority remain.
CREATE FUNCTION app.meta_transition_nonidentity_scope(value jsonb) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT jsonb_set(value,'{bindings}',COALESCE((SELECT jsonb_agg(b-'identitySha256' ORDER BY b->>'connectionId',b->>'id')
  FROM jsonb_array_elements(value->'bindings') b),'[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION app.meta_transition_nonidentity_scope(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_nonidentity_scope(jsonb) TO wasalx_meta_transition_executor,wasalx_app,wasalx_connector_worker;
CREATE FUNCTION app.meta_transition_identity_snapshot(value jsonb) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('bindingId',b->>'id','identitySha256',b->>'identitySha256') ORDER BY b->>'connectionId',b->>'id'),'[]'::jsonb)
 FROM jsonb_array_elements(value->'bindings') b
$$;
REVOKE ALL ON FUNCTION app.meta_transition_identity_snapshot(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_identity_snapshot(jsonb) TO wasalx_meta_transition_executor,wasalx_app,wasalx_connector_worker;

CREATE FUNCTION app.meta_transition_operation_context(operation_value uuid,lease_value uuid,fence_value bigint,app_value text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE o public.connection_operations;p public.meta_account_transitions;a public.meta_messaging_accounts;
 b public.meta_connection_account_bindings;s public.provider_sessions;auth jsonb;scope_value jsonb;stage_value text;
 prior public.meta_provider_effect_checkpoints;target public.meta_messaging_accounts;obs jsonb;facts jsonb;result jsonb;historical_auth jsonb;arrangement public.meta_funding_arrangement_versions;scope_current boolean;observers jsonb;effective jsonb;completion_authority jsonb;
BEGIN
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 IF NOT FOUND OR o.operation_type<>'EXECUTE_META_ACCOUNT_TRANSITION' OR o.requested_by_type<>'USER' THEN
  RAISE EXCEPTION 'Original transition operation is unavailable' USING ERRCODE='55000';END IF;
 PERFORM app.meta_transition_actor_current(o.requested_by_id::uuid);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id AND id=(o.payload#>>'{metaAccountTransitionExecution,id}')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original transition is unavailable' USING ERRCODE='55000';END IF;
 PERFORM app.lock_meta_transition_accounts(array_remove(ARRAY[p.source_account_id,p.target_account_id],NULL));
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id AND id=p.id FOR UPDATE NOWAIT;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=o.tenant_id AND id=o.id FOR UPDATE NOWAIT;
 stage_value:=o.payload#>>'{metaAccountTransitionExecution,action}';
 IF o.state<>'RUNNING' OR o.lease_id IS DISTINCT FROM lease_value OR o.fencing_token<>fence_value
  OR o.lease_expires_at<=clock_timestamp() OR p.execution_operation_id<>o.id OR p.revision::text<>o.payload#>>'{metaAccountTransitionExecution,revision}'
  OR p.state='CANCELLED' OR p.execution_state='RECONCILED_PAUSED'
  OR NOT EXISTS(SELECT 1 FROM public.meta_account_transition_reservations r WHERE r.tenant_id=p.tenant_id AND r.transition_id=p.id
   AND r.account_id=p.source_account_id AND r.released_at IS NULL) THEN
  RAISE EXCEPTION 'Transition lease or reservation changed' USING ERRCODE='55000';END IF;
 SELECT * INTO a FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=p.source_account_id;
 SELECT * INTO b FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=p.initiating_binding_id AND state<>'RETIRED' FOR SHARE NOWAIT;
 SELECT * INTO s FROM public.provider_sessions WHERE tenant_id=p.tenant_id AND id=b.provider_session_id AND ownership_state='ACTIVE' FOR SHARE NOWAIT;
 IF b.id IS NULL OR s.id IS NULL OR b.app_id<>app_value OR b.phone_number_id<>s.opaque_session_id
  OR s.provider_state_data->>'wabaId' IS DISTINCT FROM a.provider_account_id
  OR b.secret_reference IS DISTINCT FROM s.provider_state_data#>>'{metaAccountProof,secretReference}'
  OR b.credential_fingerprint IS DISTINCT FROM s.provider_state_data#>>'{metaAccountProof,credentialFingerprint}'
  OR s.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}' IS DISTINCT FROM app_value THEN
  RAISE EXCEPTION 'Current source credential binding changed' USING ERRCODE='55000';END IF;
 scope_value:=app.meta_transition_scope(a.id);auth:=app.meta_transition_authorization(p.id);
 observers:=app.meta_transition_pinned_observers(p.id,o.payload#>'{metaAccountTransitionExecution,observerOperationIds}');
 effective:=observers->b.id::text;
 IF effective='null'::jsonb THEN effective:=NULL;END IF;
 IF stage_value='INITIATE' AND effective IS NOT NULL THEN RAISE EXCEPTION 'Renewal cannot initiate a migration' USING ERRCODE='55000';END IF;
 completion_authority:=app.meta_transition_completion_authorization(p.id);
 IF stage_value='COMPLETE' AND effective IS NOT NULL AND (completion_authority IS NULL
  OR completion_authority->>'receiptId' IS DISTINCT FROM o.payload#>>'{metaAccountTransitionExecution,completionAuthorizationId}') THEN
  RAISE EXCEPTION 'Exact renewed completion authority changed' USING ERRCODE='55000';END IF;
 SELECT safe_metadata INTO historical_auth FROM public.platform_operations_audit_events WHERE id=p.execution_authorization_id
  AND safe_metadata->>'tenantId'=p.tenant_id::text AND safe_metadata->>'transitionId'=p.id::text;
 IF p.requested_mode='WASALX_MANAGED' THEN
  SELECT * INTO arrangement FROM public.meta_funding_arrangement_versions WHERE tenant_id=p.tenant_id
   AND id=(historical_auth->>'arrangementVersionId')::uuid AND account_id=p.source_account_id;
 END IF;
 SELECT * INTO prior FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=p.id AND stage=stage_value;
 SELECT observed.result->'metaTransitionObservation' INTO obs FROM public.connection_operations observed WHERE observed.tenant_id=p.tenant_id AND observed.id=p.provider_observation_operation_id;
 SELECT * INTO target FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=p.target_account_id;
 scope_current:=scope_value=p.execution_scope OR (stage_value='RECONCILE' AND p.provider_status='COMPLETED'
  AND app.meta_transition_nonidentity_scope(scope_value)=app.meta_transition_nonidentity_scope(p.execution_scope)
  AND app.meta_transition_identity_snapshot(scope_value)=o.payload#>'{metaAccountTransitionExecution,localIdentityScope}');
 facts:=jsonb_build_object('eligibility',jsonb_build_object('graphVersionQualified',auth IS NOT NULL,
  'adminAuthorityCurrent',auth->>'adminAuthority'='VERIFIED','variant',CASE WHEN auth->>'variant'='STANDARD_SAME_HIERARCHY' THEN 'STANDARD' ELSE 'UNKNOWN' END,
  'sourceCurrency',auth->>'sourceCurrency','targetCurrency',p.target_currency,'endpointCurrencyQualified',auth IS NOT NULL,
  'requestedMode',p.requested_mode,'sourcePayment',COALESCE(auth->>'sourcePayment','UNKNOWN'),'replaceCustomerCard',false,
  'managedAuthorityCurrent',p.requested_mode='CUSTOMER' OR auth->>'cloneFundingGrant'='EXACT_TRANSITION_DERIVED_TARGET'),
  'reservationCurrent',true,'scopeCurrent',scope_current,'externalImpactSettled',auth->>'phoneScope'='COMPLETE_LOCAL_ONLY',
  'drainClear',app.meta_transition_drained(a.id,o.id),'sourceAuthorityCurrent',scope_current,
  'runtimeCurrent',auth->>'mode'='SIMULATED','confirmationCurrent',p.execution_confirmation_sha256=o.payload#>>'{metaAccountTransitionExecution,requestPreviewSha256}',
  'existingStage',COALESCE(prior.outcome,'NONE'),'initiationSettlement',CASE WHEN p.provider_migration_id IS NOT NULL AND p.provider_status IN('READY_TO_COMPLETE','COMPLETED') THEN 'EXACT_MIGRATION_ID_ACCEPTED' ELSE 'UNRESOLVED' END,
  'observedStatus',p.provider_status,'targetVerified',COALESCE(obs#>>'{targetReadiness,assets}'='CLONE_ACCESS_VERIFIED',false),
  'targetPaymentReady',COALESCE(obs#>>'{targetReadiness,payment}'='VERIFIED',false),
  'continuityVerified',COALESCE(obs#>>'{targetReadiness,continuity}'='ORIGINAL_PHONE_SCOPE_RESERVED',false));
 result:=jsonb_build_object('transitionId',p.id,'revision',p.revision,'stage',stage_value,'sourceAccountId',a.id,
  'providerSourceAccountId',a.provider_account_id,'targetCurrency',p.target_currency,'destinationAccountId',target.id,
  'providerDestinationAccountId',target.provider_account_id,'migrationId',p.provider_migration_id,
  'secretReference',COALESCE(effective->>'secretReference',b.secret_reference),'accountProof',COALESCE(effective->'accountProof',s.provider_state_data->'metaAccountProof'),'appId',app_value,
  'observers',observers,
  'graphVersion',s.provider_state_data#>>'{metaAccountProof,graphVersion}','phoneNumberId',b.phone_number_id,
  'scopeSha256',p.execution_scope_sha256,'evidenceMode',COALESCE(historical_auth->>'mode',auth->>'mode','UNKNOWN'),
  'requestedMode',p.requested_mode,'approvedCreditLineId',CASE WHEN p.requested_mode='CUSTOMER' THEN NULL ELSE historical_auth->>'creditLineId' END,
  'scope',p.execution_scope,'facts',facts,
  'targetDependenciesCurrent',app.meta_transition_target_review(p.id) IS NOT NULL,
  'financial',CASE WHEN arrangement.id IS NOT NULL AND arrangement.state='APPROVED' AND arrangement.expires_at>clock_timestamp() THEN
   jsonb_build_object('secretReference',arrangement.financial_secret_reference,'credentialFingerprint',arrangement.financial_credential_fingerprint,
    'credentialMetadata',arrangement.financial_credential_metadata,'holderBusinessId',arrangement.holder_business_id,
    'creditLineId',arrangement.credit_line_id,'receivingBusinessId',historical_auth->>'targetReceivingBusinessId','solutionId',arrangement.solution_id) ELSE NULL END);
 RETURN result||jsonb_build_object('admissionSha256',encode(public.digest(result::text,'sha256'),'hex'));
END $$;
REVOKE ALL ON FUNCTION app.meta_transition_operation_context(uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_operation_context(uuid,uuid,bigint,text) TO wasalx_connector_worker,wasalx_meta_transition_executor;

CREATE FUNCTION app.reserve_meta_account_transition_stage(operation_value uuid,lease_value uuid,fence_value bigint,request_sha text,execution_value jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE o public.connection_operations;p public.meta_account_transitions;c public.meta_provider_effect_checkpoints;ctx jsonb;auth jsonb;stage_value text;arrangement_value uuid;
BEGIN
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id AND id=(o.payload#>>'{metaAccountTransitionExecution,id}')::uuid;
 stage_value:=o.payload#>>'{metaAccountTransitionExecution,action}';
 IF p.id IS NULL OR stage_value NOT IN('INITIATE','COMPLETE') OR COALESCE(request_sha,'') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Provider stage is unavailable' USING ERRCODE='55000';END IF;
 PERFORM app.lock_meta_transition_accounts(array_remove(ARRAY[p.source_account_id,p.target_account_id],NULL));
 SELECT * INTO c FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=p.id AND stage=stage_value;
 IF FOUND THEN RETURN jsonb_build_object('disposition','HISTORICAL_NO_POST','checkpointId',c.id,'outcome',c.outcome);END IF;
 auth:=app.meta_transition_authorization(p.id);
 ctx:=app.meta_transition_operation_context(o.id,lease_value,fence_value,auth->>'appId');
 IF auth IS NULL OR ctx#>>'{facts,scopeCurrent}' IS DISTINCT FROM 'true' OR ctx#>>'{facts,drainClear}' IS DISTINCT FROM 'true'
  OR ctx#>>'{facts,confirmationCurrent}' IS DISTINCT FROM 'true'
  OR execution_value->>'mode' IS DISTINCT FROM auth->>'mode'
  OR NOT app.meta_runtime_message_admission_current(jsonb_build_object('schemaVersion',2,'claim','ACCOUNT_POLICY_BOUND',
   'tenantId',p.tenant_id,'accountId',p.source_account_id,'payment',jsonb_build_object('mode',CASE WHEN p.requested_mode='CUSTOMER' THEN 'CUSTOMER' ELSE 'MANAGED' END)),execution_value)
  OR (stage_value='COMPLETE' AND (ctx#>>'{facts,observedStatus}' IS DISTINCT FROM 'READY_TO_COMPLETE'
   OR ctx#>>'{facts,targetVerified}' IS DISTINCT FROM 'true' OR ctx#>>'{facts,targetPaymentReady}' IS DISTINCT FROM 'true'
   OR ctx#>>'{facts,continuityVerified}' IS DISTINCT FROM 'true'
   OR app.meta_transition_target_review(p.id) IS NULL
   OR NOT EXISTS(SELECT 1 FROM public.connection_operations observation WHERE observation.tenant_id=p.tenant_id
    AND observation.id=p.provider_observation_operation_id AND (observation.result#>>'{metaTransitionObservation,observedAt}')::timestamptz>clock_timestamp()-interval '5 minutes'))) THEN
  RAISE EXCEPTION 'Current provider stage prerequisites are held' USING ERRCODE='55000';END IF;
 arrangement_value:=CASE WHEN p.requested_mode='CUSTOMER' THEN NULL ELSE (auth->>'arrangementVersionId')::uuid END;
 IF p.requested_mode='WASALX_MANAGED' AND (arrangement_value IS NULL OR auth->>'cloneFundingGrant'<>'EXACT_TRANSITION_DERIVED_TARGET') THEN
  RAISE EXCEPTION 'Exact transition funding grant is unavailable' USING ERRCODE='55000';END IF;
 INSERT INTO public.meta_provider_effect_checkpoints(tenant_id,account_id,owner_kind,owner_id,stage,original_operation_id,original_fencing_token,
  authority_revision,policy_version_id,arrangement_version_id,runtime_execution,request_sha256)
 SELECT p.tenant_id,p.source_account_id,'ACCOUNT_TRANSITION',p.id,stage_value,o.id,o.fencing_token,a.authority_revision,
  a.active_policy_version_id,arrangement_value,execution_value,request_sha FROM public.meta_messaging_accounts a WHERE a.tenant_id=p.tenant_id AND a.id=p.source_account_id
 RETURNING * INTO c;
 RETURN jsonb_build_object('disposition','NEW_ATTEMPT','checkpointId',c.id,'reservationToken',c.reservation_token);
END $$;
REVOKE ALL ON FUNCTION app.reserve_meta_account_transition_stage(uuid,uuid,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reserve_meta_account_transition_stage(uuid,uuid,bigint,text,jsonb) TO wasalx_connector_worker;

CREATE FUNCTION app.record_meta_transition_response(checkpoint_value uuid,reservation_value uuid,outcome_value text,result_value jsonb,result_sha text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE c public.meta_provider_effect_checkpoints;p public.meta_account_transitions;mid text;
BEGIN
 SELECT * INTO c FROM public.meta_provider_effect_checkpoints WHERE tenant_id=app.current_tenant_id() AND id=checkpoint_value FOR UPDATE;
 IF NOT FOUND OR c.owner_kind<>'ACCOUNT_TRANSITION' OR c.stage NOT IN('INITIATE','COMPLETE')
  OR c.reservation_token IS DISTINCT FROM reservation_value OR outcome_value NOT IN('SUCCEEDED','REJECTED','UNKNOWN')
  OR jsonb_typeof(result_value) IS DISTINCT FROM 'object' OR octet_length(result_value::text)>8192
  OR COALESCE(result_sha,'') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Original stage response is unavailable' USING ERRCODE='55000';END IF;
 IF c.outcome<>'ATTEMPTED' THEN RETURN c.outcome=outcome_value AND c.result=result_value AND c.result_sha256=result_sha;END IF;
 mid:=result_value->>'migrationId';
 IF mid IS NOT NULL AND (char_length(mid)>256 OR mid !~ '^[A-Za-z0-9_-]+$') THEN RAISE EXCEPTION 'Migration correlation is invalid' USING ERRCODE='23514';END IF;
 IF outcome_value='SUCCEEDED' THEN
  IF mid IS NULL OR COALESCE(result_value->>'migrationStatus','') NOT IN('INITIATED','ACCEPTED','IN_PROGRESS','READY_TO_COMPLETE','COMPLETED','FAILED','FAILED_TO_COMPLETE','REJECTED')
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(result_value) k WHERE k NOT IN('migrationId','migrationStatus','destination')) THEN
   RAISE EXCEPTION 'Successful stage response is incomplete' USING ERRCODE='23514';END IF;
 ELSE
  IF result_value->>'reason' IS DISTINCT FROM (CASE WHEN outcome_value='REJECTED' THEN 'KNOWN_PROVIDER_REJECTION' ELSE 'PROVIDER_OUTCOME_UNRESOLVED' END)
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(result_value) k WHERE k NOT IN('reason','migrationId'))
   OR (outcome_value='REJECTED' AND mid IS NOT NULL) THEN RAISE EXCEPTION 'Failure evidence must be redacted' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=c.tenant_id AND id=c.owner_id FOR UPDATE NOWAIT;
 IF c.stage='COMPLETE' AND mid IS NOT NULL AND mid IS DISTINCT FROM p.provider_migration_id THEN RAISE EXCEPTION 'Original migration correlation changed' USING ERRCODE='23514';END IF;
 IF p.provider_migration_id IS NOT NULL AND mid IS NOT NULL AND p.provider_migration_id<>mid THEN RAISE EXCEPTION 'Migration correlation changed' USING ERRCODE='23514';END IF;
 UPDATE public.meta_provider_effect_checkpoints SET outcome=outcome_value,result=result_value,result_sha256=result_sha,settled_at=clock_timestamp() WHERE id=c.id;
 UPDATE public.meta_account_transitions SET provider_migration_id=COALESCE(provider_migration_id,mid),
  execution_state=CASE WHEN outcome_value='SUCCEEDED' THEN 'INITIATED' ELSE 'HELD' END,revision=revision+1,updated_at=now()
  WHERE tenant_id=p.tenant_id AND id=p.id AND execution_state<>'RECONCILED_PAUSED';
 RETURN true;
END $$;
ALTER FUNCTION app.record_meta_transition_response(uuid,uuid,text,jsonb,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.record_meta_transition_response(uuid,uuid,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_meta_transition_response(uuid,uuid,text,jsonb,text) TO wasalx_connector_worker;

CREATE FUNCTION app.record_meta_transition_observation(operation_value uuid,lease_value uuid,fence_value bigint,observation jsonb,context_sha text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE o public.connection_operations;p public.meta_account_transitions;ctx jsonb;target public.meta_messaging_accounts;
 original public.meta_provider_effect_checkpoints;destination text;current_scope boolean;
BEGIN
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id AND id=(o.payload#>>'{metaAccountTransitionExecution,id}')::uuid;
 IF p.id IS NULL THEN RETURN false;END IF;
 ctx:=app.meta_transition_operation_context(o.id,lease_value,fence_value,p.execution_scope#>>'{bindings,0,appId}');
 IF ctx->>'admissionSha256' IS DISTINCT FROM context_sha OR jsonb_typeof(observation) IS DISTINCT FROM 'object'
  OR octet_length(observation::text)>4194304 OR observation->>'migrationId' IS DISTINCT FROM p.provider_migration_id
  OR COALESCE(observation->>'status','') NOT IN('INITIATED','ACCEPTED','IN_PROGRESS','READY_TO_COMPLETE','COMPLETED','FAILED','FAILED_TO_COMPLETE','REJECTED') THEN RETURN false;END IF;
 SELECT * INTO original FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION'
  AND owner_id=p.id AND stage='INITIATE';
 IF original.id IS NULL OR original.result->>'migrationId' IS DISTINCT FROM p.provider_migration_id
  OR original.outcome='REJECTED' THEN RETURN false;END IF;
 destination:=observation#>>'{destination,id}';
 IF destination IS NOT NULL THEN
  IF destination !~ '^[0-9]{1,32}$' OR destination=ctx->>'providerSourceAccountId'
   OR observation#>>'{destination,currency}' IS DISTINCT FROM p.target_currency THEN RETURN false;END IF;
  -- A conflicting global account remains a conflict, never reassigned.
  SELECT * INTO target FROM public.meta_messaging_accounts WHERE provider_account_id=destination;
  IF target.id IS NOT NULL AND (target.tenant_id<>p.tenant_id OR p.target_account_id IS DISTINCT FROM target.id) THEN
   RAISE EXCEPTION 'The derived target account is already reserved or enrolled' USING ERRCODE='55000';END IF;
 END IF;
 IF observation->>'status' IN('READY_TO_COMPLETE','COMPLETED') AND destination IS NULL THEN RETURN false;END IF;
 IF p.target_account_id IS NOT NULL THEN
  IF destination IS NULL THEN
   SELECT * INTO target FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=p.target_account_id;
  ELSIF p.target_account_id IS DISTINCT FROM target.id THEN RETURN false;END IF;
 END IF;
 current_scope:=ctx#>>'{facts,scopeCurrent}'='true';
 -- Source/target asset proof is persisted only on the exact leased GET, never
 -- supplied by a tenant request or inferred from display-phone equality.
 IF NOT(observation ?& ARRAY['targetAssets','cloneAccess','targetReadiness','fundingProof','allocationProof'])
  OR jsonb_typeof(observation->'targetAssets') IS DISTINCT FROM 'array'
  OR jsonb_typeof(observation->'targetReadiness') IS DISTINCT FROM 'object'
  OR COALESCE(observation#>>'{targetReadiness,assets}','') NOT IN('VERIFIED','CLONE_ACCESS_VERIFIED','UNAVAILABLE')
  OR COALESCE(observation#>>'{targetReadiness,payment}','') NOT IN('VERIFIED','UNAVAILABLE')
  OR COALESCE(observation#>>'{targetReadiness,templates}','') NOT IN('VERIFIED','UNAVAILABLE')
  OR COALESCE(observation#>>'{targetReadiness,continuity}','') NOT IN('SAME_GRAPH_PHONE_IDS','ORIGINAL_PHONE_SCOPE_RESERVED','UNAVAILABLE')
  THEN RETURN false;END IF;
 IF observation#>>'{targetReadiness,assets}'='VERIFIED' THEN
  IF observation->>'status' IS DISTINCT FROM 'COMPLETED' OR observation->'cloneAccess'<>'null'::jsonb
   OR destination IS NULL OR observation#>>'{targetReadiness,continuity}' IS DISTINCT FROM 'SAME_GRAPH_PHONE_IDS'
   OR jsonb_array_length(observation->'targetAssets')<>jsonb_array_length(p.execution_scope->'bindings')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.execution_scope->'bindings') source WHERE
    (SELECT count(*) FROM jsonb_array_elements(observation->'targetAssets') asset WHERE
      asset->>'sourceBindingId'=source->>'id' AND asset->>'sourceBindingRevision'=source->>'revision'
      AND asset->>'connectionId'=source->>'connectionId' AND asset->>'providerSessionId'=source->>'sessionId'
      AND asset->>'phoneNumberId'=source->>'phoneId' AND asset ? 'observerOperationId'
      AND asset->>'observerOperationId' IS NOT DISTINCT FROM ctx#>>ARRAY['observers',source->>'id','operationId']
      AND asset->>'secretReference'=COALESCE(ctx#>>ARRAY['observers',source->>'id','secretReference'],source->>'secretReference')
      AND asset->>'appId'=source->>'appId' AND asset->>'credentialFingerprint'=COALESCE(ctx#>>ARRAY['observers',source->>'id','credentialFingerprint'],source->>'fingerprint')
      AND asset#>>'{accountProof,wabaId}'=destination AND asset#>>'{accountProof,phoneNumberId}'=source->>'phoneId'
      AND asset#>>'{accountProof,claim}'='PHONE_ACCOUNT_RELATION_VERIFIED'
      AND asset#>>'{accountProof,schemaVersion}'='1' AND asset#>>'{accountProof,tenantId}'=p.tenant_id::text
      AND asset#>>'{accountProof,connectionId}'=source->>'connectionId'
      AND asset#>>'{accountProof,providerSessionId}'=source->>'sessionId'
      AND asset#>>'{accountProof,secretReference}'=asset->>'secretReference'
      AND asset#>>'{accountProof,credentialFingerprint}'=asset->>'credentialFingerprint'
      AND asset#>>'{accountProof,operationId}'=o.id::text AND asset#>>'{accountProof,fencingToken}'=o.fencing_token::text
      AND asset#>>'{accountProof,graphVersion}'=ctx->>'graphVersion'
      AND asset#>'{accountProof,credentialMetadata}'=COALESCE(ctx#>ARRAY['observers',source->>'id','accountProof','credentialMetadata'],source#>'{providerState,metaAccountProof,credentialMetadata}')
      AND asset#>>'{accountProof,credentialMetadata,appId}'=source->>'appId'
      AND (asset#>>'{accountProof,verifiedAt}')::timestamptz BETWEEN clock_timestamp()-interval '5 minutes' AND clock_timestamp()+interval '1 minute')<>1) THEN RETURN false;END IF;
 ELSIF observation#>>'{targetReadiness,assets}'='CLONE_ACCESS_VERIFIED' THEN
  IF observation->>'status'='COMPLETED' OR destination IS NULL OR observation->'targetAssets'<>'[]'::jsonb
   OR observation#>>'{targetReadiness,continuity}' IS DISTINCT FROM 'ORIGINAL_PHONE_SCOPE_RESERVED'
   OR observation#>>'{cloneAccess,claim}' IS DISTINCT FROM 'CLONE_ACCOUNT_ACCESS_VERIFIED'
   OR observation#>>'{cloneAccess,accountId}' IS DISTINCT FROM destination OR observation#>>'{cloneAccess,currency}' IS DISTINCT FROM p.target_currency
   OR observation#>>'{cloneAccess,appId}' IS DISTINCT FROM ctx->>'appId'
   OR observation#>>'{cloneAccess,credentialFingerprint}' IS DISTINCT FROM ctx#>>'{accountProof,credentialFingerprint}'
   OR NOT(observation->'cloneAccess' ? 'observerOperationId')
   OR observation#>>'{cloneAccess,observerOperationId}' IS DISTINCT FROM ctx#>>ARRAY['observers',p.initiating_binding_id::text,'operationId']
   OR COALESCE(observation#>>'{cloneAccess,responseSha256}','') !~ '^[a-f0-9]{64}$'
   OR observation#>>'{cloneAccess,verifiedAt}' IS NULL
   OR (observation#>>'{cloneAccess,verifiedAt}')::timestamptz NOT BETWEEN clock_timestamp()-interval '5 minutes' AND clock_timestamp()+interval '1 minute'
   THEN RETURN false;END IF;
 ELSE
  IF observation->'cloneAccess'<>'null'::jsonb OR observation->'targetAssets'<>'[]'::jsonb OR observation->'fundingProof'<>'null'::jsonb
   OR observation->'allocationProof'<>'null'::jsonb OR observation->'targetReadiness' IS DISTINCT FROM
    '{"assets":"UNAVAILABLE","payment":"UNAVAILABLE","templates":"UNAVAILABLE","continuity":"UNAVAILABLE"}'::jsonb THEN RETURN false;END IF;
 END IF;
 IF observation#>>'{targetReadiness,templates}'='VERIFIED' AND ctx->>'targetDependenciesCurrent' IS DISTINCT FROM 'true' THEN RETURN false;END IF;
 IF observation#>>'{targetReadiness,payment}'='VERIFIED' AND
  (observation#>>'{fundingProof,status}' IS DISTINCT FROM 'PRESENT'
   OR (ctx->>'requestedMode'='WASALX_MANAGED' AND
    (observation#>>'{allocationProof,receivingCredential}' IS DISTINCT FROM observation#>>'{fundingProof,primaryFundingId}'
     OR observation#>>'{allocationProof,creditLineId}' IS DISTINCT FROM ctx#>>'{financial,creditLineId}'
     OR observation#>>'{allocationProof,receivingBusinessId}' IS DISTINCT FROM ctx#>>'{financial,receivingBusinessId}')))
  THEN RETURN false;END IF;
 IF o.result IS NOT NULL THEN RETURN o.result->'metaTransitionObservation'=observation;END IF;
 IF destination IS NOT NULL AND target.id IS NULL THEN
  INSERT INTO public.meta_messaging_accounts(tenant_id,provider_account_id) VALUES(p.tenant_id,destination) RETURNING * INTO target;
  INSERT INTO public.meta_account_transition_reservations(tenant_id,account_id,transition_id,account_role,scope_sha256,authority_revision)
   VALUES(p.tenant_id,target.id,p.id,'TARGET',p.execution_scope_sha256,target.authority_revision);
 END IF;
 UPDATE public.connection_operations SET result=jsonb_build_object('metaTransitionObservation',observation),updated_at=now()
  WHERE tenant_id=o.tenant_id AND id=o.id;
 UPDATE public.meta_account_transitions SET target_account_id=COALESCE(target_account_id,target.id),provider_status=observation->>'status',
  provider_observation_operation_id=o.id,execution_state=CASE WHEN NOT current_scope THEN 'HELD'
   WHEN observation->>'status'='COMPLETED' THEN 'PROVIDER_COMPLETED' WHEN observation->>'status'='READY_TO_COMPLETE' THEN 'READY_TO_COMPLETE'
   WHEN observation->>'status' IN('FAILED','FAILED_TO_COMPLETE','REJECTED') THEN 'HELD' ELSE 'INITIATED' END,
  revision=revision+1,updated_at=now() WHERE tenant_id=p.tenant_id AND id=p.id;
 -- Original ATTEMPTED/UNKNOWN is never rewritten by a successful GET. The
 -- original captured migration ID is the explicit distinct-stage correlation.
 RETURN true;
END $$;
ALTER FUNCTION app.record_meta_transition_observation(uuid,uuid,bigint,jsonb,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.record_meta_transition_observation(uuid,uuid,bigint,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_meta_transition_observation(uuid,uuid,bigint,jsonb,text) TO wasalx_connector_worker;

CREATE FUNCTION app.cancel_meta_transition_execution(plan_value uuid,connection_value uuid,actor_value uuid,revision_value bigint)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;
BEGIN
 PERFORM app.meta_transition_actor_current(actor_value);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value AND initiating_connection_id=connection_value;
 IF NOT FOUND THEN RAISE EXCEPTION 'Transition unavailable' USING ERRCODE='55000';END IF;
 PERFORM app.lock_meta_transition_accounts(array_remove(ARRAY[p.source_account_id,p.target_account_id],NULL));
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=p.tenant_id AND id=p.id FOR UPDATE NOWAIT;
 IF p.state='CANCELLED' AND p.revision=revision_value+1 THEN RETURN jsonb_build_object('id',p.id,'duplicate',true);END IF;
 IF p.revision<>revision_value OR p.execution_state='RECONCILED_PAUSED'
  OR EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints c WHERE c.tenant_id=p.tenant_id AND c.owner_kind='ACCOUNT_TRANSITION'
   AND c.owner_id=p.id AND c.outcome IN('ATTEMPTED','UNKNOWN','SUCCEEDED'))
  OR EXISTS(SELECT 1 FROM public.connection_operations o WHERE o.tenant_id=p.tenant_id AND o.id=p.execution_operation_id
   AND o.state='RUNNING' AND o.lease_expires_at>=clock_timestamp()) THEN RAISE EXCEPTION 'Original external outcome prevents cancellation' USING ERRCODE='55000';END IF;
 UPDATE public.connection_operations SET state='CANCELLED',completed_at=now(),updated_at=now(),lease_id=NULL,lease_expires_at=NULL
  WHERE tenant_id=p.tenant_id AND id=p.execution_operation_id AND state IN('QUEUED','FAILED_RETRYABLE');
 UPDATE public.meta_account_transition_reservations SET released_at=clock_timestamp(),release_reason='PRE_EFFECT_CANCEL',revision=revision+1
  WHERE tenant_id=p.tenant_id AND transition_id=p.id AND released_at IS NULL;
 UPDATE public.meta_account_transitions SET state='CANCELLED',cancelled_at=now(),revision=revision+1,updated_at=now()
  WHERE tenant_id=p.tenant_id AND id=p.id;
 -- PAUSED/HELD and the bumped generation remain. No old birth is revived.
 RETURN jsonb_build_object('id',p.id,'duplicate',false);
END $$;
ALTER FUNCTION app.cancel_meta_transition_execution(uuid,uuid,uuid,bigint) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.cancel_meta_transition_execution(uuid,uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cancel_meta_transition_execution(uuid,uuid,uuid,bigint) TO wasalx_app;

CREATE FUNCTION app.meta_transition_execution_view(plan_value uuid,actor_value uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;o public.connection_operations;auth jsonb;history jsonb;permission boolean;busy boolean;
 reason text[]:='{}';initiate boolean:=false;complete_value boolean:=false;observe_value boolean:=false;reconcile_value boolean:=false;cancel_value boolean:=false;
 observation jsonb;scope_value jsonb;current_scope boolean;has_effect boolean;
BEGIN
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT EXISTS(SELECT 1 FROM public.tenant_memberships WHERE tenant_id=p.tenant_id AND user_id=actor_value AND state='ACTIVE'
  AND role IN('tenant_owner','tenant_admin')) INTO permission;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=p.execution_operation_id;
 busy:=o.state IN('QUEUED','RUNNING','FAILED_RETRYABLE');
 auth:=app.meta_transition_authorization(p.id);scope_value:=app.meta_transition_scope(p.source_account_id);
 current_scope:=p.execution_scope IS NULL OR p.execution_scope=scope_value;
 SELECT result->'metaTransitionObservation' INTO observation FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=p.provider_observation_operation_id;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('stage',c.stage,'outcome',c.outcome,'attemptedAt',c.attempted_at) ORDER BY c.attempted_at),'[]'::jsonb)
  INTO history FROM public.meta_provider_effect_checkpoints c WHERE c.tenant_id=p.tenant_id AND c.owner_kind='ACCOUNT_TRANSITION' AND c.owner_id=p.id;
 has_effect:=EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints c WHERE c.tenant_id=p.tenant_id AND c.owner_kind='ACCOUNT_TRANSITION'
  AND c.owner_id=p.id AND c.outcome IN('ATTEMPTED','UNKNOWN','SUCCEEDED'));
 IF NOT permission THEN reason:=array_append(reason,'CURRENT_PERMISSION_REQUIRED');END IF;
 IF auth IS NULL THEN reason:=array_append(reason,'PREREQUISITES_UNVERIFIED');END IF;
 IF NOT current_scope THEN reason:=array_append(reason,'SCOPE_CHANGED');END IF;
 IF EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=p.tenant_id AND job_type='DELETE' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
  reason:=array_append(reason,'PRIVACY_HOLD');permission:=false;END IF;
 IF permission AND NOT COALESCE(busy,false) AND p.state<>'CANCELLED' AND p.execution_state<>'RECONCILED_PAUSED' THEN
  observe_value:=p.provider_migration_id IS NOT NULL;
  cancel_value:=NOT has_effect;
  initiate:=p.execution_state='UNPREPARED' AND auth IS NOT NULL AND current_scope AND p.expires_at>clock_timestamp()
   AND encode(public.digest(scope_value::text,'sha256'),'hex')=auth->>'scopeSha256'
   AND app.meta_transition_drained(p.source_account_id,NULL);
  complete_value:=auth IS NOT NULL AND current_scope AND app.meta_transition_target_review(p.id) IS NOT NULL
   AND (observation->>'observedAt')::timestamptz>clock_timestamp()-interval '5 minutes' AND p.provider_status='READY_TO_COMPLETE'
   AND observation#>>'{targetReadiness,assets}'='CLONE_ACCESS_VERIFIED' AND observation#>>'{targetReadiness,payment}'='VERIFIED'
   AND (NOT(p.observer_operations ? p.initiating_binding_id::text) OR app.meta_transition_completion_authorization(p.id) IS NOT NULL)
   AND observation#>>'{targetReadiness,templates}'='VERIFIED'
   AND NOT EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints c WHERE c.tenant_id=p.tenant_id AND c.owner_kind='ACCOUNT_TRANSITION' AND c.owner_id=p.id AND c.stage='COMPLETE');
  reconcile_value:=(current_scope OR app.meta_transition_nonidentity_scope(scope_value)=app.meta_transition_nonidentity_scope(p.execution_scope))
   AND app.meta_transition_target_review(p.id) IS NOT NULL
   AND (observation->>'observedAt')::timestamptz>clock_timestamp()-interval '5 minutes' AND p.provider_status='COMPLETED'
   AND observation#>>'{targetReadiness,assets}'='VERIFIED' AND observation#>>'{targetReadiness,payment}'='VERIFIED'
   AND observation#>>'{targetReadiness,templates}'='VERIFIED';
 END IF;
 IF p.target_account_id IS NOT NULL AND COALESCE(observation#>>'{targetReadiness,assets}','') NOT IN('VERIFIED','CLONE_ACCESS_VERIFIED') THEN reason:=array_append(reason,'TARGET_PROOF_REQUIRED');END IF;
 IF p.target_account_id IS NOT NULL AND observation#>>'{targetReadiness,payment}' IS DISTINCT FROM 'VERIFIED' THEN reason:=array_append(reason,'PAYMENT_ACTION_REQUIRED');END IF;
 IF p.target_account_id IS NOT NULL AND observation#>>'{targetReadiness,templates}' IS DISTINCT FROM 'VERIFIED' THEN reason:=array_append(reason,'TEMPLATE_ACTION_REQUIRED');END IF;
 IF has_effect AND p.provider_migration_id IS NULL THEN reason:=array_append(reason,'PROVIDER_OUTCOME_UNRESOLVED');END IF;
 RETURN jsonb_build_object('revision',p.revision,'state',p.execution_state,'previewSha256',app.meta_transition_confirmation(p.id),
  'requestedMode',p.requested_mode,'sourceCurrency',auth->>'sourceCurrency','targetCurrency',p.target_currency,
  'impactConnectionCount',COALESCE(jsonb_array_length(scope_value->'bindings'),0),
  'actions',jsonb_build_object('initiate',COALESCE(initiate,false),'complete',COALESCE(complete_value,false),'observe',COALESCE(observe_value,false),
   'reconcile',COALESCE(reconcile_value,false),'cancel',COALESCE(cancel_value,false)),
  'reasons',to_jsonb(reason),'providerStatus',p.provider_status,'history',history,'observedAt',observation->'observedAt',
  'renewals',CASE WHEN p.provider_migration_id IS NOT NULL AND p.execution_state<>'RECONCILED_PAUSED' AND p.state<>'CANCELLED' THEN
   COALESCE((SELECT jsonb_agg(jsonb_build_object('connectionId',c.id,'name',c.name,
    'canPrepare',permission AND NOT COALESCE(busy,false) AND c.state='PAUSED'
      AND EXISTS(SELECT 1 FROM public.meta_account_transition_reservations r WHERE r.tenant_id=p.tenant_id AND r.transition_id=p.id AND r.released_at IS NULL),
    'access',CASE WHEN p.observer_operations ? (b->>'id') THEN 'RENEWED' ELSE 'ORIGINAL' END) ORDER BY c.name,c.id)
    FROM jsonb_array_elements(p.execution_scope->'bindings') b JOIN public.connections c ON c.tenant_id=p.tenant_id AND c.id=(b->>'connectionId')::uuid),'[]'::jsonb)
   ELSE '[]'::jsonb END,
  'completionApprovalRequired',COALESCE(p.provider_status='READY_TO_COMPLETE' AND p.observer_operations ? p.initiating_binding_id::text
   AND app.meta_transition_completion_authorization(p.id) IS NULL AND NOT EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints checkpoint
    WHERE checkpoint.tenant_id=p.tenant_id AND checkpoint.owner_kind='ACCOUNT_TRANSITION' AND checkpoint.owner_id=p.id AND checkpoint.stage='COMPLETE'),false),
  'terms',CASE WHEN p.requested_mode='WASALX_MANAGED' AND auth IS NOT NULL THEN jsonb_build_object(
   'documentText',auth->>'targetTermsDocumentText','documentSha256',auth->>'targetTermsDocumentSha256','version',auth->>'targetTermsVersion') ELSE NULL END,
  'pendingAction',CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object('operationId',o.id,'requestKey',o.idempotency_key,'action',o.payload#>>'{metaAccountTransitionExecution,action}',
   'state',CASE WHEN o.state='FAILED_RETRYABLE' THEN 'FAILED_TERMINAL' ELSE o.state END,'requestRevision',(o.payload#>>'{metaAccountTransitionExecution,requestRevision}')::bigint) END);
END $$;
REVOKE ALL ON FUNCTION app.meta_transition_execution_view(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_execution_view(uuid,uuid) TO wasalx_app;

-- P09 logical fragment: META_ACCOUNT_TRANSITION_CONSUMERS.sql
-- Bound source SHA256: 8060bf4bfa5142882985ba87157b6aa739ca7f09c18a9ecc1e207defe710b35e
-- Unapplied companion, after reservations/execution and before lineage apply.
CREATE OR REPLACE FUNCTION app.assert_meta_account_unreserved(account_value uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET row_security=off SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 PERFORM app.lock_meta_transition_accounts(ARRAY[account_value]);
 IF EXISTS(SELECT 1 FROM public.meta_account_transition_reservations r WHERE r.tenant_id=app.current_tenant_id()
  AND r.account_id=account_value AND r.released_at IS NULL) THEN
  RAISE EXCEPTION 'Account transition reserves this authority' USING ERRCODE='55000';END IF;
END $$;

CREATE FUNCTION app.guard_meta_transition_reserved_write() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE value jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 prior jsonb:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END; connection_value uuid;account_value uuid;
BEGIN
 -- This is a NOLOGIN, ungranted function owner, never a caller-provided flag.
 IF current_user='wasalx_meta_transition_executor' THEN RETURN COALESCE(NEW,OLD);END IF;
 -- The existing NOLOGIN scheduler owner only enqueues this finite WAHA maintenance operation.
 IF current_user='wasalx_scheduler_reader' AND TG_TABLE_NAME='connection_operations' AND TG_OP='INSERT'
  AND value->>'operation_type'='SYNC_GROUPS' AND value->>'requested_by_type'='SYSTEM'
  AND value->>'requested_by_id'='connector-scheduler' THEN RETURN NEW;END IF;
 -- Incumbent exact LOCAL tenant erasure keeps historical reservation/checkpoint
 -- barriers. It can only retire current authority, never activate or release it.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN('meta_messaging_accounts','meta_connection_account_bindings')
  AND value->>'state'='RETIRED' AND EXISTS(SELECT 1 FROM public.privacy_jobs
   WHERE tenant_id=app.current_tenant_id() AND job_type='DELETE' AND scope_type='TENANT'
    AND scope_value=app.current_tenant_id()::text AND state='RUNNING' AND stage='LOCAL'
    AND lease_id IS NOT NULL AND lease_expires_at>clock_timestamp()) THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME IN('meta_messaging_accounts','meta_funding_arrangement_versions','meta_billing_policy_versions','meta_connection_account_bindings') THEN
  IF TG_TABLE_NAME='meta_messaging_accounts' AND TG_OP='INSERT' THEN RETURN NEW;END IF;
  account_value:=CASE WHEN TG_TABLE_NAME='meta_messaging_accounts' THEN (value->>'id')::uuid ELSE (value->>'account_id')::uuid END;
  -- Retain authentic negative/failed funding observations. They invalidate the
  -- reserved scope and can never turn on payment or a current policy.
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='meta_messaging_accounts' AND value->>'state'='HELD'
   AND value->>'funding_status'='UNAVAILABLE' AND value->'primary_funding_id'='null'::jsonb
   AND value->'requested_policy_version_id' IS NOT DISTINCT FROM prior->'requested_policy_version_id'
   AND value->'active_policy_version_id' IS NOT DISTINCT FROM prior->'active_policy_version_id' THEN RETURN NEW;END IF;
  IF account_value IS NOT NULL THEN PERFORM app.assert_meta_account_unreserved(account_value);END IF;
 ELSIF TG_TABLE_NAME IN('connections','provider_sessions','webhook_routes','connection_operations','bot_assignments','bot_conversations','delivery_attempts') THEN
  connection_value:=CASE WHEN TG_TABLE_NAME='connections' THEN (value->>'id')::uuid ELSE (value->>'connection_id')::uuid END;
  IF TG_TABLE_NAME='delivery_attempts' THEN
   -- Only the actual final admission is an authority effect. Provider receipt
   -- settlement and historical evidence remain writable by incumbent guards.
   IF TG_OP<>'UPDATE' OR value->'meta_billing_admission' IS NOT DISTINCT FROM prior->'meta_billing_admission'
    OR prior->'meta_billing_admission' IS DISTINCT FROM 'null'::jsonb THEN RETURN COALESCE(NEW,OLD);END IF;
   SELECT d.connection_id INTO connection_value FROM public.delivery_outbox d
    WHERE d.tenant_id=(value->>'tenant_id')::uuid AND d.id=(value->>'delivery_id')::uuid;
  END IF;
  IF TG_TABLE_NAME='connection_operations' THEN
   -- Dedicated execution uses its own sealed functions; ordinary preview and
   -- status/lease/result writes have no new authority or provider POST.
   IF TG_OP='UPDATE' AND (value-ARRAY['state','result','lease_id','lease_expires_at','fencing_token','attempts','error_code','safe_error','updated_at','started_at','completed_at','available_at'])
    =(prior-ARRAY['state','result','lease_id','lease_expires_at','fencing_token','attempts','error_code','safe_error','updated_at','started_at','completed_at','available_at']) THEN RETURN NEW;END IF;
   IF value->>'operation_type' IN('PREVIEW_META_ACCOUNT_TRANSITION','PAUSE') THEN RETURN COALESCE(NEW,OLD);END IF;
  END IF;
  IF TG_TABLE_NAME='provider_sessions' AND TG_OP='UPDATE' THEN
   -- Signed lifecycle/routing/identity negatives keep their real asset. They
   -- change the frozen scope, never become an effect admission or secret copy.
   IF (value-ARRAY['provider_state_data','updated_at'])=(prior-ARRAY['provider_state_data','updated_at'])
    AND ((value->'provider_state_data') - ARRAY['metaLifecycle','metaRouting'])
      =((prior->'provider_state_data') - ARRAY['metaLifecycle','metaRouting']) THEN RETURN NEW;END IF;
  END IF;
  IF TG_TABLE_NAME='connections' AND TG_OP='UPDATE'
   AND (value-ARRAY['last_provider_event_at','updated_at'])=(prior-ARRAY['last_provider_event_at','updated_at']) THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='connections' AND TG_OP='UPDATE' AND value->>'state'='PAUSED'
   AND (value-ARRAY['state','updated_at'])=(prior-ARRAY['state','updated_at']) THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='webhook_routes' AND TG_OP='UPDATE' AND value->>'state' IN('PAUSED','REVOKED')
   AND (value-ARRAY['state','updated_at'])=(prior-ARRAY['state','updated_at']) THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='provider_sessions' THEN
   -- A BEFORE INSERT cannot discover NEW through the current-session SELECT.
   -- Lock the explicit new/old account relation as well, so an unenrolled phone
   -- cannot enter a reserved account before its later binding/worker stage.
   FOR account_value IN SELECT a.id FROM public.meta_messaging_accounts a
    WHERE a.tenant_id=app.current_tenant_id() AND a.provider_account_id IN
     (value#>>'{provider_state_data,wabaId}',prior#>>'{provider_state_data,wabaId}') ORDER BY a.id
   LOOP PERFORM app.assert_meta_account_unreserved(account_value);END LOOP;
  END IF;
  IF connection_value IS NOT NULL AND EXISTS(SELECT 1 FROM public.connections WHERE tenant_id=app.current_tenant_id() AND id=connection_value AND provider='META') THEN
   PERFORM app.assert_meta_connection_account_unreserved(connection_value);
  END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
REVOKE ALL ON FUNCTION app.guard_meta_transition_reserved_write() FROM PUBLIC;
CREATE TRIGGER meta_transition_account_write BEFORE INSERT OR UPDATE OR DELETE ON public.meta_messaging_accounts FOR EACH ROW EXECUTE FUNCTION app.guard_meta_transition_reserved_write();
CREATE TRIGGER meta_transition_binding_write BEFORE INSERT OR UPDATE OR DELETE ON public.meta_connection_account_bindings FOR EACH ROW EXECUTE FUNCTION app.guard_meta_transition_reserved_write();
CREATE TRIGGER meta_transition_policy_write BEFORE INSERT ON public.meta_billing_policy_versions FOR EACH ROW EXECUTE FUNCTION app.guard_meta_transition_reserved_write();
CREATE TRIGGER meta_transition_arrangement_write BEFORE INSERT OR UPDATE ON public.meta_funding_arrangement_versions FOR EACH ROW EXECUTE FUNCTION app.guard_meta_transition_reserved_write();
CREATE TRIGGER meta_transition_connection_write BEFORE UPDATE ON public.connections FOR EACH ROW EXECUTE FUNCTION app.guard_meta_transition_reserved_write();
CREATE TRIGGER meta_transition_session_write BEFORE INSERT OR UPDATE ON public.provider_sessions FOR EACH ROW EXECUTE FUNCTION app.guard_meta_transition_reserved_write();
CREATE TRIGGER meta_transition_route_write BEFORE INSERT OR UPDATE ON public.webhook_routes FOR EACH ROW EXECUTE FUNCTION app.guard_meta_transition_reserved_write();
CREATE TRIGGER meta_transition_operation_write BEFORE INSERT OR UPDATE ON public.connection_operations FOR EACH ROW EXECUTE FUNCTION app.guard_meta_transition_reserved_write();
CREATE TRIGGER meta_transition_assignment_write BEFORE INSERT OR UPDATE OR DELETE ON public.bot_assignments FOR EACH ROW EXECUTE FUNCTION app.guard_meta_transition_reserved_write();
CREATE TRIGGER meta_transition_conversation_write BEFORE INSERT OR UPDATE OF flow_version_id ON public.bot_conversations FOR EACH ROW EXECUTE FUNCTION app.guard_meta_transition_reserved_write();
CREATE TRIGGER meta_transition_final_send BEFORE UPDATE OF meta_billing_admission ON public.delivery_attempts FOR EACH ROW EXECUTE FUNCTION app.guard_meta_transition_reserved_write();

-- The named P08 functions below are concrete dependencies, not optional dynamic
-- probes. Their implementation remains intact behind the shared reservation.
ALTER FUNCTION app.reserve_meta_funding_attachment(uuid,uuid,text,jsonb) RENAME TO reserve_meta_funding_attachment_before_transition;
CREATE FUNCTION app.reserve_meta_funding_attachment(operation_value uuid,lease_value uuid,request_sha text,execution_value jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET row_security=off SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE o public.connection_operations;prior public.meta_provider_effect_checkpoints;
BEGIN
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 SELECT * INTO prior FROM public.meta_provider_effect_checkpoints WHERE tenant_id=o.tenant_id AND owner_kind='FUNDING_ATTACHMENT' AND owner_id=o.id AND stage='ATTACH';
 IF FOUND THEN RETURN jsonb_build_object('disposition','HISTORICAL_NO_POST','checkpointId',prior.id,'outcome',prior.outcome);END IF;
 PERFORM app.assert_meta_connection_account_unreserved(o.connection_id);
 RETURN app.reserve_meta_funding_attachment_before_transition(operation_value,lease_value,request_sha,execution_value);
END $$;
REVOKE ALL ON FUNCTION app.reserve_meta_funding_attachment_before_transition(uuid,uuid,text,jsonb),app.reserve_meta_funding_attachment(uuid,uuid,text,jsonb) FROM PUBLIC,wasalx_app,wasalx_connector_worker;
GRANT EXECUTE ON FUNCTION app.reserve_meta_funding_attachment(uuid,uuid,text,jsonb) TO wasalx_connector_worker;

-- The worker obtains this before its GET/attachment callback. A known original
-- success readback remains diagnostic; new ATTACH cannot wait account->connection.
ALTER FUNCTION app.meta_funding_operation_context(uuid,uuid,bigint,text) RENAME TO meta_funding_operation_context_before_transition;
CREATE FUNCTION app.meta_funding_operation_context(operation_value uuid,lease_value uuid,fence_value bigint,app_value text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET row_security=off SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE o public.connection_operations;
BEGIN
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 IF o.payload#>>'{metaManagedFunding,stage}'='ATTACH' THEN PERFORM app.assert_meta_connection_account_unreserved(o.connection_id);END IF;
 RETURN app.meta_funding_operation_context_before_transition(operation_value,lease_value,fence_value,app_value);
END $$;
REVOKE ALL ON FUNCTION app.meta_funding_operation_context_before_transition(uuid,uuid,bigint,text),app.meta_funding_operation_context(uuid,uuid,bigint,text) FROM PUBLIC,wasalx_app,wasalx_connector_worker;
GRANT EXECUTE ON FUNCTION app.meta_funding_operation_context(uuid,uuid,bigint,text) TO wasalx_connector_worker;

-- A reservation blocks birth as well as the final attempt. Captured historical
-- births stay unchanged. No current binding after retirement means HELD,
-- never a return to the pre-enrollment LEGACY branch.
ALTER FUNCTION app.meta_billing_birth_snapshot(uuid) RENAME TO meta_billing_birth_snapshot_before_transition;
CREATE FUNCTION app.meta_billing_birth_snapshot(connection_value uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET row_security=off SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 PERFORM app.assert_meta_connection_account_unreserved(connection_value);
 IF EXISTS(SELECT 1 FROM public.meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value)
  AND NOT EXISTS(SELECT 1 FROM public.meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value AND state='ACTIVE') THEN
  RAISE EXCEPTION 'Previously enrolled payment authority is held' USING ERRCODE='55000';END IF;
 RETURN app.meta_billing_birth_snapshot_before_transition(connection_value);
END $$;
REVOKE ALL ON FUNCTION app.meta_billing_birth_snapshot_before_transition(uuid),app.meta_billing_birth_snapshot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_billing_birth_snapshot(uuid) TO wasalx_app,wasalx_connector_worker;

CREATE OR REPLACE FUNCTION app.meta_billing_birth_snapshot_before_transition(connection_value uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE binding public.meta_connection_account_bindings;account public.meta_messaging_accounts;
 policy public.meta_billing_policy_versions;arrangement public.meta_funding_arrangement_versions;payment jsonb;
BEGIN
 SELECT * INTO binding FROM public.meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value AND state<>'RETIRED' FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('schemaVersion',1,'claim','LEGACY_UNATTRIBUTED');END IF;
 SELECT * INTO account FROM public.meta_messaging_accounts WHERE tenant_id=binding.tenant_id AND id=binding.account_id FOR SHARE;
 IF NOT FOUND OR account.requested_policy_version_id IS NULL THEN RAISE EXCEPTION 'Meta account policy is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO policy FROM public.meta_billing_policy_versions WHERE tenant_id=account.tenant_id AND account_id=account.id AND id=account.requested_policy_version_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Meta account policy is unavailable' USING ERRCODE='55000';END IF;
 IF policy.mode='CUSTOMER' THEN
  payment:=jsonb_build_object('mode','CUSTOMER','actualPayer','UNVERIFIED','managed',NULL);
 ELSIF policy.mode='MANAGED' THEN
  SELECT * INTO arrangement FROM public.meta_funding_arrangement_versions WHERE tenant_id=account.tenant_id AND account_id=account.id AND id=policy.arrangement_version_id FOR SHARE;
  IF NOT FOUND OR arrangement.state<>'APPROVED' OR arrangement.expires_at<=clock_timestamp()
   OR arrangement.allocation_line_version_id IS NULL OR arrangement.commercial_terms_version_id IS DISTINCT FROM policy.commercial_terms_version_id THEN
   RAISE EXCEPTION 'Managed authority is unavailable' USING ERRCODE='55000';END IF;
  payment:=jsonb_build_object('mode','MANAGED','actualPayer','APPROVED_SOLUTION_PARTNER','managed',jsonb_build_object(
   'arrangementVersionId',arrangement.id::text,'arrangementKind',arrangement.kind,
   'payerAuthorityVersionId',arrangement.payer_authority_version_id::text,'effectiveScopeSha256',arrangement.effective_scope_sha256,
   'allocationLineVersionId',arrangement.allocation_line_version_id::text,'commercialTermsVersionId',arrangement.commercial_terms_version_id::text,'evidenceMode',arrangement.evidence_mode));
 ELSE RAISE EXCEPTION 'Meta payment mode is unsupported' USING ERRCODE='55000';END IF;
 RETURN jsonb_build_object('schemaVersion',2,'claim','ACCOUNT_POLICY_BOUND','tenantId',binding.tenant_id::text,'connectionId',connection_value::text,
  'accountId',account.id::text,'providerAccountId',account.provider_account_id,'identifierKind','MESSAGING_ACCOUNT_ID','accountModel','PHASE1_WABA_ALIAS',
  'bindingId',binding.id::text,'bindingRevision',binding.revision,'accountAuthorityRevision',account.authority_revision,
  'policyVersionId',policy.id::text,'payment',payment,'funding',jsonb_build_object('responseSha256',account.funding_response_sha256,'observedAt',account.funding_observed_at));
END;$$;

CREATE OR REPLACE FUNCTION app.meta_billing_send_guard(connection_value uuid,session_value uuid,phone_value text,account_value text,
 expected_authority bigint,expected_binding bigint)
RETURNS TABLE(allowed boolean,enrolled boolean,provider_account_id text,account_id uuid,policy_version_id uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT
  binding.state='ACTIVE' AND account.state='READY' AND account.funding_status='PRESENT'
  AND account.primary_funding_id IS NOT NULL AND account.funding_expires_at>clock_timestamp()
  AND account.authority_revision=expected_authority AND binding.revision=expected_binding
  AND account.active_policy_version_id=account.requested_policy_version_id
  AND policy.mode IN('CUSTOMER','MANAGED') AND app.meta_account_payment_ready(account.id,account.primary_funding_id)
  AND binding.provider_session_id=session_value AND binding.phone_number_id=phone_value
  AND account.provider_account_id=account_value AND connection.secret_reference=binding.secret_reference
  AND session.ownership_state='ACTIVE' AND session.opaque_session_id=binding.phone_number_id
  AND session.provider_state_data->>'wabaId'=account.provider_account_id
  AND session.provider_state_data#>>'{metaAccountProof,credentialFingerprint}'=binding.credential_fingerprint
  AND session.provider_state_data#>>'{metaAccountProof,secretReference}'=binding.secret_reference
  AND session.provider_state_data#>>'{metaAccountProof,tenantId}'=binding.tenant_id::text
  AND session.provider_state_data#>>'{metaAccountProof,connectionId}'=binding.connection_id::text
  AND session.provider_state_data#>>'{metaAccountProof,providerSessionId}'=binding.provider_session_id::text
  AND session.provider_state_data#>>'{metaAccountProof,phoneNumberId}'=binding.phone_number_id
  AND session.provider_state_data#>>'{metaAccountProof,wabaId}'=account.provider_account_id
  AND session.provider_state_data#>>'{metaAccountProof,claim}'='PHONE_ACCOUNT_RELATION_VERIFIED'
  AND session.provider_state_data#>>'{metaAccountProof,schemaVersion}'='1'
  AND session.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=binding.app_id,
  true,account.provider_account_id,account.id,account.active_policy_version_id
 FROM meta_connection_account_bindings binding JOIN meta_messaging_accounts account ON account.tenant_id=binding.tenant_id AND account.id=binding.account_id
 JOIN connections connection ON connection.tenant_id=binding.tenant_id AND connection.id=binding.connection_id
 JOIN provider_sessions session ON session.tenant_id=binding.tenant_id AND session.id=binding.provider_session_id
 LEFT JOIN meta_billing_policy_versions policy ON policy.tenant_id=account.tenant_id AND policy.id=account.active_policy_version_id
 WHERE binding.tenant_id=app.current_tenant_id() AND binding.connection_id=connection_value AND binding.state<>'RETIRED'
 UNION ALL SELECT true,false,NULL::text,NULL::uuid,NULL::uuid
 WHERE NOT EXISTS(SELECT 1 FROM meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value)
$$;

CREATE OR REPLACE FUNCTION app.accept_meta_managed_policy(connection_value uuid,arrangement_value uuid,terms_value uuid,tariff_value uuid,
 expected_authority bigint,actor_value uuid,key_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE binding public.meta_connection_account_bindings;account public.meta_messaging_accounts;
 arrangement public.meta_funding_arrangement_versions;policy public.meta_billing_policy_versions;prior public.meta_billing_policy_versions;request_sha text;
BEGIN
 IF app.current_tenant_id() IS NULL OR expected_authority IS NULL OR expected_authority NOT BETWEEN 1 AND 9007199254740991
  OR COALESCE(key_value,'') !~ '^[A-Za-z0-9._:-]{1,128}$' THEN RAISE EXCEPTION 'Managed policy admission is invalid' USING ERRCODE='23514';END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||app.current_tenant_id()::text,0)) THEN
  RAISE EXCEPTION 'Managed policy admission is fenced by privacy' USING ERRCODE='40001';END IF;
 PERFORM app.assert_meta_connection_account_unreserved(connection_value);
 request_sha:=encode(digest(jsonb_build_object('connectionId',connection_value,'arrangementVersionId',arrangement_value,'termsVersionId',terms_value,
  'acceptedTariffVersionId',tariff_value,'expectedRevision',expected_authority,'requestedBy',actor_value)::text,'sha256'),'hex');
 SELECT * INTO binding FROM public.meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value AND state<>'RETIRED';
 IF NOT FOUND THEN RAISE EXCEPTION 'Verified account binding is required' USING ERRCODE='55000';END IF;
 SELECT * INTO account FROM public.meta_messaging_accounts WHERE tenant_id=binding.tenant_id AND id=binding.account_id FOR UPDATE;
 SELECT * INTO binding FROM public.meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value AND state<>'RETIRED' FOR UPDATE NOWAIT;
 SELECT * INTO prior FROM public.meta_billing_policy_versions WHERE tenant_id=account.tenant_id AND idempotency_key='meta-managed:'||key_value;
 IF FOUND THEN
  IF prior.account_id IS DISTINCT FROM account.id OR prior.request_sha256 IS DISTINCT FROM request_sha THEN
   RAISE EXCEPTION 'Managed policy key belongs to another admission' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('policyVersionId',prior.id,'requestedMode','MANAGED','replay',true);END IF;
 -- Exact active owner/admin membership and same-account binding, never global
 -- financial IDs chosen through arbitrary tenant payloads.
 IF account.id IS NULL OR account.state='RETIRED' OR account.authority_revision IS DISTINCT FROM expected_authority OR binding.state<>'ACTIVE'
  OR NOT EXISTS(SELECT 1 FROM public.tenant_memberships m WHERE m.tenant_id=account.tenant_id AND m.user_id=actor_value AND m.state='ACTIVE' AND m.role IN('tenant_owner','tenant_admin'))
  OR EXISTS(SELECT 1 FROM public.privacy_jobs j WHERE j.tenant_id=account.tenant_id AND j.job_type='DELETE' AND j.scope_type='TENANT' AND j.state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
  RAISE EXCEPTION 'Managed policy authority changed' USING ERRCODE='55000';END IF;
 SELECT * INTO arrangement FROM public.meta_funding_arrangement_versions WHERE tenant_id=account.tenant_id AND account_id=account.id AND id=arrangement_value FOR SHARE;
 IF NOT FOUND OR arrangement.state<>'APPROVED' OR arrangement.expires_at<=clock_timestamp() OR arrangement.app_id IS DISTINCT FROM binding.app_id
  OR arrangement.commercial_terms_version_id IS DISTINCT FROM terms_value OR app.meta_terms_receipt_scope(account.tenant_id,account.id,terms_value,tariff_value) IS NULL THEN
  RAISE EXCEPTION 'Exact approved managed arrangement is required' USING ERRCODE='55000';END IF;
 INSERT INTO public.meta_billing_policy_versions(tenant_id,account_id,version,mode,terms_version,requested_by,idempotency_key,request_sha256,
  commercial_terms_version_id,accepted_tariff_version_id,arrangement_version_id)
 SELECT account.tenant_id,account.id,COALESCE(max(version),0)+1,'MANAGED','META_MANAGED_PAYMENT_V1',actor_value,'meta-managed:'||key_value,request_sha,
  terms_value,tariff_value,arrangement_value FROM public.meta_billing_policy_versions WHERE tenant_id=account.tenant_id AND account_id=account.id RETURNING * INTO policy;
 UPDATE public.meta_messaging_accounts SET requested_policy_version_id=policy.id,active_policy_version_id=NULL,state='HELD',authority_revision=authority_revision+1,updated_at=now() WHERE id=account.id AND tenant_id=account.tenant_id;
 RETURN jsonb_build_object('policyVersionId',policy.id,'requestedMode','MANAGED','replay',false);
 -- Intent is held until exact allocation readback and fresh funding receipt.
END;$$;
-- Current-binding lookup is explicit after append-only predecessor retirement.
-- The common reservation lock precedes account/binding policy mutation.
CREATE OR REPLACE FUNCTION app.accept_meta_customer_terms(connection_value uuid,terms_value uuid,tariff_value uuid,
 expected_authority bigint,actor_value uuid,key_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE binding public.meta_connection_account_bindings;account public.meta_messaging_accounts;
 policy public.meta_billing_policy_versions;prior public.meta_billing_policy_versions;request_sha text;
BEGIN
 IF app.current_tenant_id() IS NULL OR expected_authority IS NULL OR expected_authority NOT BETWEEN 1 AND 9007199254740991
  OR terms_value IS NULL OR COALESCE(key_value,'') !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
  RAISE EXCEPTION 'Customer terms admission is invalid' USING ERRCODE='23514';END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||app.current_tenant_id()::text,0)) THEN
  RAISE EXCEPTION 'Customer terms admission is fenced by privacy' USING ERRCODE='40001';END IF;
 request_sha:=encode(digest(jsonb_build_object('connectionId',connection_value,'termsVersionId',terms_value,
  'acceptedTariffVersionId',tariff_value,'expectedRevision',expected_authority,'requestedBy',actor_value)::text,'sha256'),'hex');
 SELECT * INTO binding FROM public.meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value AND state<>'RETIRED';
 IF NOT FOUND THEN RAISE EXCEPTION 'Verified account binding is required' USING ERRCODE='55000';END IF;
 PERFORM app.assert_meta_connection_account_unreserved(connection_value);
 SELECT * INTO account FROM public.meta_messaging_accounts WHERE tenant_id=binding.tenant_id AND id=binding.account_id FOR UPDATE NOWAIT;
 SELECT * INTO binding FROM public.meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value AND state<>'RETIRED' FOR UPDATE NOWAIT;
 SELECT * INTO prior FROM public.meta_billing_policy_versions WHERE tenant_id=account.tenant_id AND idempotency_key='meta-customer-terms:'||key_value;
 IF FOUND THEN
  IF prior.account_id IS DISTINCT FROM account.id OR prior.request_sha256 IS DISTINCT FROM request_sha THEN
   RAISE EXCEPTION 'Customer terms key belongs to another admission' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('policyVersionId',prior.id,'requestedMode','CUSTOMER','replay',true);END IF;
 IF account.id IS NULL OR account.state='RETIRED' OR account.authority_revision IS DISTINCT FROM expected_authority OR binding.state<>'ACTIVE'
  OR NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=account.tenant_id AND state='ACTIVE')
  OR NOT EXISTS(SELECT 1 FROM public.tenant_memberships WHERE tenant_id=account.tenant_id AND user_id=actor_value AND state='ACTIVE' AND role IN('tenant_owner','tenant_admin'))
  OR EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=account.tenant_id AND job_type='DELETE' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE'))
  OR app.meta_terms_receipt_scope(account.tenant_id,account.id,terms_value,tariff_value) IS NULL THEN
  RAISE EXCEPTION 'Customer terms authority changed' USING ERRCODE='55000';END IF;
 INSERT INTO public.meta_billing_policy_versions(tenant_id,account_id,version,mode,terms_version,requested_by,idempotency_key,request_sha256,
  commercial_terms_version_id,accepted_tariff_version_id)
 SELECT account.tenant_id,account.id,COALESCE(max(version),0)+1,'CUSTOMER','META_CUSTOMER_PAYMENT_V1',actor_value,'meta-customer-terms:'||key_value,request_sha,
  terms_value,tariff_value FROM public.meta_billing_policy_versions WHERE tenant_id=account.tenant_id AND account_id=account.id RETURNING * INTO policy;
 UPDATE public.meta_messaging_accounts SET requested_policy_version_id=policy.id,active_policy_version_id=NULL,state='HELD',authority_revision=authority_revision+1,updated_at=now()
  WHERE id=account.id AND tenant_id=account.tenant_id;
 RETURN jsonb_build_object('policyVersionId',policy.id,'requestedMode','CUSTOMER','replay',false);
END;$$;

-- Current request authority selects the exact ACTIVE successor; immutable historical
-- receipt/birth references remain unchanged and are never retargeted.
CREATE OR REPLACE FUNCTION app.preserve_meta_billing_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE old_value jsonb;new_value jsonb;delivery_value uuid;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.meta_billing_admission IS NOT NULL THEN RAISE EXCEPTION 'Caller cannot insert Meta request admission' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='delivery_outbox' THEN old_value:=OLD.meta_billing_snapshot;new_value:=NEW.meta_billing_snapshot;delivery_value:=OLD.id;
 ELSE old_value:=OLD.meta_billing_admission;new_value:=NEW.meta_billing_admission;delivery_value:=OLD.delivery_id; END IF;
 IF new_value IS NOT DISTINCT FROM old_value THEN RETURN NEW; END IF;
 IF old_value IS NULL AND TG_TABLE_NAME='delivery_attempts' THEN
  IF NOT pg_has_role(current_user,'wasalx_connector_worker','MEMBER') THEN
   RAISE EXCEPTION 'Only the connector worker may admit a Messages request' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM delivery_outbox delivery WHERE delivery.tenant_id=NEW.tenant_id AND delivery.id=delivery_value
    AND delivery.state='SENDING' AND delivery.lease_id IS NOT NULL AND delivery.lease_expires_at>clock_timestamp()
    AND NEW.state='SENDING' AND NEW.attempt_number=delivery.attempts AND NEW.finished_at IS NULL
    AND jsonb_typeof(new_value)='object' AND new_value->>'claim'='MESSAGES_REQUEST_ADMITTED'
    AND ((new_value->>'schemaVersion'='1' AND delivery.meta_billing_snapshot->>'schemaVersion' IS DISTINCT FROM '2' AND (SELECT count(*) FROM jsonb_object_keys(new_value))=10)
     OR (new_value->>'schemaVersion'='2' AND (SELECT count(*) FROM jsonb_object_keys(new_value))=13
      AND new_value ? 'providerContext'
      AND new_value->'providerContext' IS NOT DISTINCT FROM CASE WHEN delivery.meta_billing_snapshot->>'claim'='ACCOUNT_POLICY_BOUND'
       THEN app.meta_message_provider_context(delivery.connection_id) ELSE 'null'::jsonb END
      AND (delivery.meta_billing_snapshot->>'claim' IS DISTINCT FROM 'ACCOUNT_POLICY_BOUND' OR new_value->'providerContext'<>'null'::jsonb)
      AND new_value->'birthDigest' IS NOT DISTINCT FROM CASE WHEN delivery.meta_billing_snapshot IS NULL THEN 'null'::jsonb ELSE
       jsonb_build_object('format','pg-jsonb-text-v1','sha256',encode(digest(delivery.meta_billing_snapshot::text,'sha256'),'hex')) END
      AND app.meta_runtime_message_admission_current(delivery.meta_billing_snapshot,new_value->'execution')))
    AND jsonb_typeof(new_value->'requestPhoneNumberId')='string'
    AND new_value->>'requestPhoneNumberId' ~ '^[0-9]{1,32}$'
    AND EXISTS(SELECT 1 FROM public.provider_sessions session WHERE session.tenant_id=delivery.tenant_id
      AND session.connection_id=delivery.connection_id AND session.ownership_state='ACTIVE' AND session.state='WORKING'
      AND session.opaque_session_id=new_value->>'requestPhoneNumberId')
    AND (new_value->'providerContext' IS NULL OR new_value->'providerContext'='null'::jsonb
      OR new_value#>>'{providerContext,phoneNumberId}'=new_value->>'requestPhoneNumberId')
    AND new_value->'snapshot' IS NOT DISTINCT FROM COALESCE(delivery.meta_billing_snapshot,'null'::jsonb) AND new_value->>'attemptId'=NEW.id::text
    AND new_value->>'attemptNumber'=NEW.attempt_number::text AND new_value->>'deliveryId'=delivery.id::text
    AND new_value->>'admittedAt' IS NOT NULL
    AND new_value->>'requestSha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(new_value->'funding')='object'
    AND new_value->'funding' ?& ARRAY['responseSha256','observedAt','expiresAt']
    AND (SELECT count(*) FROM jsonb_object_keys(new_value->'funding'))=3
    AND EXISTS(SELECT 1 FROM connections connection
      LEFT JOIN meta_connection_account_bindings binding ON binding.tenant_id=connection.tenant_id AND binding.connection_id=connection.id AND binding.state='ACTIVE'
        AND (delivery.meta_billing_snapshot IS NULL OR delivery.meta_billing_snapshot->>'claim'='LEGACY_UNATTRIBUTED' OR binding.id::text=delivery.meta_billing_snapshot->>'bindingId')
      LEFT JOIN meta_messaging_accounts account ON account.tenant_id=binding.tenant_id AND account.id=binding.account_id
      WHERE connection.tenant_id=delivery.tenant_id AND connection.id=delivery.connection_id AND connection.provider='META'
        AND (new_value#>>'{funding,responseSha256}') IS NOT DISTINCT FROM account.funding_response_sha256
        AND (new_value#>>'{funding,observedAt}')::timestamptz IS NOT DISTINCT FROM account.funding_observed_at
        AND (new_value#>>'{funding,expiresAt}')::timestamptz IS NOT DISTINCT FROM account.funding_expires_at)
    AND app.meta_billing_delivery_current(delivery.id)) THEN RAISE EXCEPTION 'Meta request admission is unavailable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
 END IF;
 IF old_value IS NOT NULL AND new_value=jsonb_build_object('redacted',true,'sha256',encode(digest(old_value::text,'sha256'),'hex'))
  AND app.meta_direct_privacy_target_authorized('DELIVERY',delivery_value::text)
  AND EXISTS(SELECT 1 FROM delivery_outbox delivery WHERE delivery.tenant_id=OLD.tenant_id AND delivery.id=delivery_value
    AND delivery.state NOT IN('SENDING','OUTCOME_UNKNOWN')
    AND NOT(delivery.state='CLAIMED' AND delivery.lease_expires_at>=clock_timestamp())) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Meta billing evidence is immutable' USING ERRCODE='23514';
END; $$;

CREATE OR REPLACE FUNCTION app.select_meta_managed_policy(connection_value uuid,choice_value uuid,document_sha text,
 expected_authority bigint,actor_value uuid,key_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE arrangement public.meta_funding_arrangement_versions;
BEGIN
 SELECT a.* INTO arrangement FROM public.meta_funding_arrangement_versions a
  JOIN public.meta_connection_account_bindings binding ON binding.tenant_id=a.tenant_id AND binding.account_id=a.account_id
  WHERE binding.tenant_id=app.current_tenant_id() AND binding.connection_id=connection_value AND binding.state='ACTIVE' AND a.id=choice_value;
 IF NOT FOUND THEN RAISE EXCEPTION 'Managed option is unavailable' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(app.meta_managed_policy_choices(connection_value)) choice
  WHERE choice->>'choiceId'=choice_value::text AND choice->>'documentSha256'=document_sha) THEN
  RAISE EXCEPTION 'Managed terms changed; refresh the available option' USING ERRCODE='55000';END IF;
 RETURN app.accept_meta_managed_policy(connection_value,choice_value,arrangement.commercial_terms_version_id,NULL,expected_authority,actor_value,key_value);
 -- No attachment operation, payer refresh, connection state or send grant here.
END;$$;

-- P09 logical fragment: META_ACCOUNT_TRANSITION_GUARDS.sql
-- Bound source SHA256: 92b77806829b905d325ffe906e8997f57150b529dc0dd629003e37758ce6b66e
-- Exact source-composed guard evolution; no broad relation/string rewrite at deployment.
DO $$ DECLARE expression text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_catalog.pg_constraint
  WHERE conrelid='public.connection_operations'::regclass AND conname='connection_operations_operation_type_check';
 IF expression IS NULL OR position('PREVIEW_META_ACCOUNT_TRANSITION' IN expression)=0 THEN
  RAISE EXCEPTION 'Expected transition operation contract is missing';END IF;
 ALTER TABLE public.connection_operations DROP CONSTRAINT connection_operations_operation_type_check;
 EXECUTE 'ALTER TABLE public.connection_operations ADD CONSTRAINT connection_operations_operation_type_check CHECK (('||expression||') OR operation_type=''EXECUTE_META_ACCOUNT_TRANSITION'')';
END $$;
CREATE OR REPLACE FUNCTION app.preserve_meta_transition() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE operation_row public.connection_operations;
BEGIN
 IF TG_OP='UPDATE' AND current_user='wasalx_meta_transition_executor'
  AND NEW.execution_scope=jsonb_build_object('redacted',true,'sha256',encode(public.digest(OLD.execution_scope::text,'sha256'),'hex'))
  AND (to_jsonb(NEW)-ARRAY['execution_scope','updated_at'])=(to_jsonb(OLD)-ARRAY['execution_scope','updated_at'])
  AND EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=OLD.tenant_id AND job_type='DELETE' AND scope_type='TENANT'
   AND scope_value=OLD.tenant_id::text AND stage='LOCAL' AND state='RUNNING' AND lease_id IS NOT NULL AND lease_expires_at>clock_timestamp()) THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' THEN
   IF (OLD.execution_scope IS NOT NULL OR OLD.execution_scope_sha256 IS NOT NULL)
    AND (NEW.execution_scope,NEW.execution_scope_sha256) IS DISTINCT FROM (OLD.execution_scope,OLD.execution_scope_sha256) THEN
    RAISE EXCEPTION 'Original transition execution scope is immutable' USING ERRCODE='23514';END IF;
   IF (NEW.tenant_id,NEW.id,NEW.source_account_id,NEW.initiating_connection_id,NEW.initiating_binding_id,
     NEW.requested_mode,NEW.target_currency,NEW.request_sha256,NEW.idempotency_key,NEW.initial_account_revision,NEW.initial_binding_revision,NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.source_account_id,OLD.initiating_connection_id,OLD.initiating_binding_id,
     OLD.requested_mode,OLD.target_currency,OLD.request_sha256,OLD.idempotency_key,OLD.initial_account_revision,OLD.initial_binding_revision,OLD.created_at)
     THEN RAISE EXCEPTION 'Transition intent is immutable' USING ERRCODE='23514'; END IF;
   IF OLD.requested_by IS NOT NULL AND NEW.requested_by IS NULL AND
     (to_jsonb(NEW)-'requested_by')=(to_jsonb(OLD)-'requested_by') THEN
     IF pg_has_role(session_user,'wasalx_connector_worker','MEMBER') THEN
       IF app.meta_managed_privacy_authorized(OLD.tenant_id) THEN RETURN NEW; END IF;
     ELSE
       IF (NOT EXISTS(SELECT 1 FROM public.tenant_memberships WHERE tenant_id=OLD.tenant_id AND user_id=OLD.requested_by)
       OR EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=OLD.tenant_id AND job_type='DELETE'
         AND scope_type='TENANT' AND scope_value=OLD.tenant_id::text AND state='RUNNING' AND stage='LOCAL'
         AND lease_id IS NOT NULL AND lease_expires_at>=clock_timestamp())) THEN RETURN NEW; END IF;
     END IF;
   END IF;
   IF NEW.requested_by IS DISTINCT FROM OLD.requested_by OR OLD.state='CANCELLED' OR NEW.revision<>OLD.revision+1
     THEN RAISE EXCEPTION 'Transition revision is not current' USING ERRCODE='23514'; END IF;
 ELSE
   IF NEW.requested_by IS NULL OR NEW.revision<>1 OR NEW.state<>'PENDING' THEN
     RAISE EXCEPTION 'Transition creation is invalid' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT * INTO operation_row FROM public.connection_operations WHERE tenant_id=NEW.tenant_id AND id=NEW.current_observation_operation_id;
 IF NOT FOUND OR operation_row.operation_type<>'PREVIEW_META_ACCOUNT_TRANSITION'
   OR operation_row.payload#>>'{metaAccountTransition,id}' IS DISTINCT FROM NEW.id::text
   OR operation_row.payload#>>'{metaAccountTransition,accountId}' IS DISTINCT FROM NEW.source_account_id::text THEN
   RAISE EXCEPTION 'Transition observation binding is invalid' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND current_user<>'wasalx_meta_transition_executor' AND
  (NEW.execution_state,NEW.execution_scope,NEW.execution_scope_sha256,NEW.execution_authorization_id,NEW.execution_operation_id,
   NEW.execution_confirmation_sha256,NEW.provider_migration_id,NEW.target_account_id,NEW.provider_status,
   NEW.provider_observation_operation_id,NEW.identity_successor_receipt,NEW.reconciled_at)
  IS DISTINCT FROM (OLD.execution_state,OLD.execution_scope,OLD.execution_scope_sha256,OLD.execution_authorization_id,OLD.execution_operation_id,
   OLD.execution_confirmation_sha256,OLD.provider_migration_id,OLD.target_account_id,OLD.provider_status,
   OLD.provider_observation_operation_id,OLD.identity_successor_receipt,OLD.reconciled_at) THEN
  RAISE EXCEPTION 'Execution state requires its sealed coordinator' USING ERRCODE='42501';END IF;
 IF TG_OP='INSERT' AND (NEW.execution_state<>'UNPREPARED' OR NEW.execution_scope IS NOT NULL OR NEW.execution_authorization_id IS NOT NULL
  OR NEW.execution_operation_id IS NOT NULL OR NEW.provider_migration_id IS NOT NULL OR NEW.target_account_id IS NOT NULL
  OR NEW.identity_successor_receipt IS NOT NULL) THEN RAISE EXCEPTION 'Caller cannot insert execution evidence' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND OLD.execution_state<>'UNPREPARED' AND current_user<>'wasalx_meta_transition_executor' THEN
  RAISE EXCEPTION 'Reserved transition cannot be refreshed or relabelled' USING ERRCODE='55000';END IF;
 IF TG_OP='UPDATE' AND OLD.identity_successor_receipt IS NOT NULL AND NEW.identity_successor_receipt IS DISTINCT FROM OLD.identity_successor_receipt THEN
  RAISE EXCEPTION 'Identity successor receipt is immutable' USING ERRCODE='23514';END IF;
 IF NEW.state IN ('PREVIEW','BLOCKED') AND current_user<>'wasalx_meta_transition_executor' AND NOT pg_has_role(current_user,'wasalx_connector_worker','member') THEN
   RAISE EXCEPTION 'Only a qualified observation can update the preview' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION app.guard_meta_account_policy_state() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='meta_connection_account_bindings' THEN
  IF TG_OP='UPDATE' AND (NEW.predecessor_binding_id,NEW.account_transition_id) IS DISTINCT FROM (OLD.predecessor_binding_id,OLD.account_transition_id) THEN
   RAISE EXCEPTION 'Account lineage is immutable' USING ERRCODE='23514';END IF;
  IF TG_OP='INSERT' AND NEW.predecessor_binding_id IS NOT NULL AND NOT(current_user='wasalx_meta_transition_executor' AND EXISTS(
   SELECT 1 FROM public.meta_account_transitions p JOIN public.connection_operations o ON o.tenant_id=p.tenant_id AND o.id=p.execution_operation_id
   JOIN public.meta_connection_account_bindings predecessor ON predecessor.tenant_id=p.tenant_id AND predecessor.id=NEW.predecessor_binding_id
   WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.account_transition_id AND p.target_account_id=NEW.account_id
    AND p.source_account_id=predecessor.account_id AND predecessor.state='RETIRED' AND predecessor.connection_id=NEW.connection_id
    AND predecessor.phone_number_id=NEW.phone_number_id AND predecessor.app_id=NEW.app_id AND NEW.state='HELD'
    AND p.provider_status='COMPLETED' AND o.state='RUNNING' AND o.lease_expires_at>=clock_timestamp()
    AND o.payload#>>'{metaAccountTransitionExecution,action}'='RECONCILE')) THEN
   RAISE EXCEPTION 'Successor account requires the sealed same-phone transition' USING ERRCODE='42501';END IF;
 END IF;
 IF TG_TABLE_NAME='meta_connection_account_bindings' THEN
 IF current_user='wasalx_meta_transition_executor' AND TG_OP='UPDATE'
  AND OLD.state='ACTIVE' AND NEW.state='RETIRED' AND NEW.revision=OLD.revision+1
  AND (to_jsonb(NEW)-ARRAY['state','revision','updated_at'])=(to_jsonb(OLD)-ARRAY['state','revision','updated_at'])
  AND EXISTS(SELECT 1 FROM public.meta_account_transitions p JOIN public.connection_operations o ON o.tenant_id=p.tenant_id AND o.id=p.execution_operation_id
   JOIN public.meta_account_transition_reservations r ON r.tenant_id=p.tenant_id AND r.transition_id=p.id AND r.account_id=OLD.account_id AND r.released_at IS NULL
   WHERE p.tenant_id=OLD.tenant_id AND p.source_account_id=OLD.account_id AND p.provider_status='COMPLETED'
    AND o.state='RUNNING' AND o.lease_expires_at>=clock_timestamp() AND o.payload#>>'{metaAccountTransitionExecution,action}'='RECONCILE'
    AND p.revision::text=o.payload#>>'{metaAccountTransitionExecution,revision}') THEN RETURN NEW;END IF;
 END IF;
 IF NEW.state='RETIRED' AND (TG_OP='INSERT' OR OLD.state<>'RETIRED') AND NOT EXISTS(
  SELECT 1 FROM privacy_jobs job WHERE job.tenant_id=NEW.tenant_id AND job.job_type='DELETE' AND job.scope_type='TENANT'
    AND job.scope_value=NEW.tenant_id::text AND job.stage='LOCAL' AND job.state='RUNNING'
    AND job.lease_id IS NOT NULL AND job.lease_expires_at>=clock_timestamp()) THEN
  RAISE EXCEPTION 'Meta account retirement requires current tenant privacy authority' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='meta_connection_account_bindings' THEN
 IF NEW.state<>'RETIRED' AND NOT EXISTS(
  SELECT 1 FROM connections connection JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
    JOIN meta_messaging_accounts account ON account.tenant_id=NEW.tenant_id AND account.id=NEW.account_id
  WHERE connection.tenant_id=NEW.tenant_id AND connection.id=NEW.connection_id AND connection.provider='META'
    AND session.id=NEW.provider_session_id AND session.ownership_state='ACTIVE' AND session.opaque_session_id=NEW.phone_number_id
    AND session.provider_state_data->>'wabaId'=account.provider_account_id AND connection.secret_reference=NEW.secret_reference
    AND session.provider_state_data#>>'{metaAccountProof,schemaVersion}'='1'
    AND session.provider_state_data#>>'{metaAccountProof,claim}'='PHONE_ACCOUNT_RELATION_VERIFIED'
    AND session.provider_state_data#>>'{metaAccountProof,tenantId}'=NEW.tenant_id::text
    AND session.provider_state_data#>>'{metaAccountProof,connectionId}'=NEW.connection_id::text
    AND session.provider_state_data#>>'{metaAccountProof,providerSessionId}'=NEW.provider_session_id::text
    AND session.provider_state_data#>>'{metaAccountProof,phoneNumberId}'=NEW.phone_number_id
    AND session.provider_state_data#>>'{metaAccountProof,wabaId}'=account.provider_account_id
    AND session.provider_state_data#>>'{metaAccountProof,secretReference}'=NEW.secret_reference
    AND session.provider_state_data#>>'{metaAccountProof,credentialFingerprint}'=NEW.credential_fingerprint
    AND session.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=NEW.app_id) THEN
  RAISE EXCEPTION 'Meta account binding requires the current exact credential proof' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='INSERT' AND TG_TABLE_NAME='meta_messaging_accounts' THEN
  IF NEW.state<>'HELD' OR NEW.authority_revision<>1 OR NEW.active_policy_version_id IS NOT NULL
    OR NEW.requested_policy_version_id IS NOT NULL OR NEW.funding_status<>'UNAVAILABLE'
    OR NEW.primary_funding_id IS NOT NULL OR NEW.funding_response_sha256 IS NOT NULL
    OR NEW.funding_observed_at IS NOT NULL OR NEW.funding_expires_at IS NOT NULL
    OR NEW.observed_owner_business_id IS NOT NULL OR NEW.last_observation_operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'A Meta account starts without payment authority' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='meta_messaging_accounts' THEN
  IF (NEW.tenant_id,NEW.id,NEW.provider_account_id,NEW.created_at) IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.provider_account_id,OLD.created_at)
   OR NEW.authority_revision<OLD.authority_revision OR (OLD.state='RETIRED' AND NEW.state<>'RETIRED') THEN
   RAISE EXCEPTION 'Meta account authority is immutable' USING ERRCODE='23514'; END IF;
  IF (NEW.state,NEW.active_policy_version_id,NEW.requested_policy_version_id,NEW.funding_status,NEW.primary_funding_id,NEW.observed_owner_business_id)
     IS DISTINCT FROM (OLD.state,OLD.active_policy_version_id,OLD.requested_policy_version_id,OLD.funding_status,OLD.primary_funding_id,OLD.observed_owner_business_id)
     AND NEW.authority_revision<>OLD.authority_revision+1 THEN RAISE EXCEPTION 'Meta account semantic generation must advance' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM meta_billing_policy_versions p WHERE p.tenant_id=NEW.tenant_id AND p.id IN(NEW.active_policy_version_id,NEW.requested_policy_version_id) AND p.account_id<>NEW.id)
    THEN RAISE EXCEPTION 'Meta policy belongs to another account' USING ERRCODE='23514'; END IF;
  IF NEW.state<>'RETIRED' AND ((NEW.funding_status,NEW.primary_funding_id,NEW.funding_response_sha256,NEW.funding_observed_at,NEW.funding_expires_at,NEW.observed_owner_business_id)
     IS DISTINCT FROM (OLD.funding_status,OLD.primary_funding_id,OLD.funding_response_sha256,OLD.funding_observed_at,OLD.funding_expires_at,OLD.observed_owner_business_id)
     OR NEW.last_observation_operation_id IS DISTINCT FROM OLD.last_observation_operation_id
     OR (NEW.state='READY' AND OLD.state<>'READY')) AND NOT EXISTS(
    SELECT 1 FROM connection_operations operation JOIN meta_connection_account_bindings binding
      ON binding.tenant_id=operation.tenant_id AND binding.connection_id=operation.connection_id AND binding.account_id=NEW.id
    WHERE operation.tenant_id=NEW.tenant_id AND operation.id=NEW.last_observation_operation_id
      AND operation.operation_type='VERIFY_META_BILLING'
      AND (operation.state='SUCCEEDED' OR (operation.state='FAILED_TERMINAL' AND NEW.funding_status='UNAVAILABLE'))
      AND operation.payload#>>'{metaAccountPolicy,accountId}'=NEW.id::text
      AND operation.payload#>>'{metaAccountPolicy,authorityRevision}'=OLD.authority_revision::text
      AND (operation.payload#>>'{metaAccountPolicy,observationOperationId}') IS NOT DISTINCT FROM OLD.last_observation_operation_id::text
      AND operation.payload#>>'{metaAccountPolicy,policyVersionId}'=NEW.requested_policy_version_id::text
      AND operation.payload#>>'{metaAccountPolicy,bindingId}'=binding.id::text
      AND operation.payload#>>'{metaAccountPolicy,bindingRevision}'=binding.revision::text
      AND operation.result#>>'{metaAccountFundingProof,schemaVersion}'='1'
      AND operation.result#>>'{metaAccountFundingProof,accountId}'=NEW.provider_account_id
      AND operation.result#>>'{metaAccountFundingProof,actualPayer}'='UNVERIFIED'
      AND operation.result#>>'{metaAccountFundingProof,status}'=NEW.funding_status
      AND (operation.result#>>'{metaAccountFundingProof,primaryFundingId}') IS NOT DISTINCT FROM NEW.primary_funding_id
      AND (operation.result#>>'{metaAccountFundingProof,observedOwnerBusinessId}') IS NOT DISTINCT FROM NEW.observed_owner_business_id
      AND operation.result#>>'{metaAccountFundingProof,responseSha256}'=NEW.funding_response_sha256
      AND (operation.result#>>'{metaAccountFundingProof,observedAt}')::timestamptz=NEW.funding_observed_at
      AND (operation.result#>>'{metaAccountFundingProof,expiresAt}')::timestamptz=NEW.funding_expires_at)
    AND NOT(current_user='wasalx_meta_transition_executor' AND EXISTS(
     SELECT 1 FROM public.meta_account_transitions p JOIN public.connection_operations operation ON operation.tenant_id=p.tenant_id
      AND operation.id=p.provider_observation_operation_id
     JOIN public.connection_operations coordinator ON coordinator.tenant_id=p.tenant_id AND coordinator.id=p.execution_operation_id
     WHERE p.tenant_id=NEW.tenant_id AND p.target_account_id=NEW.id AND p.provider_status='COMPLETED'
      AND coordinator.state='RUNNING' AND coordinator.lease_expires_at>=clock_timestamp()
      AND coordinator.payload#>>'{metaAccountTransitionExecution,action}'='RECONCILE'
      AND operation.id=NEW.last_observation_operation_id AND operation.operation_type='EXECUTE_META_ACCOUNT_TRANSITION'
      AND operation.result#>>'{metaTransitionObservation,migrationId}'=p.provider_migration_id
      AND operation.result#>>'{metaTransitionObservation,status}'='COMPLETED'
      AND operation.result#>>'{metaTransitionObservation,fundingProof,accountId}'=NEW.provider_account_id
      AND operation.result#>>'{metaTransitionObservation,fundingProof,actualPayer}'='UNVERIFIED'
      AND operation.result#>>'{metaTransitionObservation,fundingProof,status}'=NEW.funding_status
      AND operation.result#>>'{metaTransitionObservation,fundingProof,primaryFundingId}'=NEW.primary_funding_id
      AND operation.result#>>'{metaTransitionObservation,fundingProof,responseSha256}'=NEW.funding_response_sha256
      AND (operation.result#>>'{metaTransitionObservation,fundingProof,observedAt}')::timestamptz=NEW.funding_observed_at
      AND (operation.result#>>'{metaTransitionObservation,fundingProof,expiresAt}')::timestamptz=NEW.funding_expires_at
      AND NEW.funding_expires_at>clock_timestamp() AND app.meta_transition_target_review(p.id) IS NOT NULL))
    THEN RAISE EXCEPTION 'Meta funding requires its exact private read receipt' USING ERRCODE='23514'; END IF;
 ELSE
  IF (NEW.tenant_id,NEW.id,NEW.account_id,NEW.connection_id,NEW.created_at) IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.account_id,OLD.connection_id,OLD.created_at)
    OR NEW.revision<OLD.revision OR (OLD.state='RETIRED' AND NEW.state<>'RETIRED') THEN RAISE EXCEPTION 'Meta binding identity is immutable' USING ERRCODE='23514'; END IF;
  IF (NEW.provider_session_id,NEW.phone_number_id,NEW.app_id,NEW.secret_reference,NEW.credential_fingerprint,NEW.proof_sha256,NEW.state)
    IS DISTINCT FROM (OLD.provider_session_id,OLD.phone_number_id,OLD.app_id,OLD.secret_reference,OLD.credential_fingerprint,OLD.proof_sha256,OLD.state)
    AND NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Meta binding generation must advance' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION app.preserve_meta_financial_checkpoint() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Financial effect history must be retained' USING ERRCODE='55000';END IF;
 IF OLD.outcome NOT IN('ATTEMPTED','UNKNOWN') AND NOT(OLD.result ? 'redacted')
  AND NEW.result=jsonb_build_object('redacted',true,'sha256',encode(digest(OLD.result::text,'sha256'),'hex'))
  AND pg_has_role(current_user,'wasalx_connector_worker','MEMBER') AND app.meta_managed_privacy_authorized(OLD.tenant_id)
  AND (to_jsonb(NEW)-'result') IS NOT DISTINCT FROM (to_jsonb(OLD)-'result') THEN RETURN NEW;END IF;
 IF NEW.result IS DISTINCT FROM OLD.result AND current_user<>pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid=TG_RELID))
  AND NOT(current_user='wasalx_meta_transition_executor' AND OLD.owner_kind='ACCOUNT_TRANSITION' AND OLD.stage IN('INITIATE','COMPLETE')) THEN
  RAISE EXCEPTION 'Financial evidence may change only through the original receipt or leased privacy authority' USING ERRCODE='23514';END IF;
 IF (to_jsonb(NEW)-ARRAY['outcome','result','result_sha256','settled_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['outcome','result','result_sha256','settled_at'])
  OR (OLD.outcome<>'ATTEMPTED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
  RAISE EXCEPTION 'Financial checkpoint is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END;$$;

CREATE OR REPLACE FUNCTION app.preserve_meta_transition_reservation() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reservation history is retained' USING ERRCODE='55000';END IF;
 IF current_user<>'wasalx_meta_transition_executor' OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
  OR NEW.revision<>OLD.revision+1 OR (to_jsonb(NEW)-ARRAY['released_at','release_reason','revision']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['released_at','release_reason','revision']) THEN
  RAISE EXCEPTION 'Reservation requires its sealed current release' USING ERRCODE='23514';END IF;
 IF NEW.release_reason='PRE_EFFECT_CANCEL' THEN
  IF EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints c WHERE c.tenant_id=OLD.tenant_id AND c.owner_kind='ACCOUNT_TRANSITION'
   AND c.owner_id=OLD.transition_id AND c.outcome IN('ATTEMPTED','SUCCEEDED','UNKNOWN')) THEN
   RAISE EXCEPTION 'Original effects prevent local cancellation' USING ERRCODE='55000';END IF;
 ELSIF NEW.release_reason='VERIFIED_SUCCESSOR' THEN
  IF NOT EXISTS(SELECT 1 FROM public.meta_account_transitions p WHERE p.tenant_id=OLD.tenant_id AND p.id=OLD.transition_id
   AND p.execution_state='RECONCILED_PAUSED' AND p.identity_successor_receipt->>'claim'='SAME_GRAPH_PHONE_ACCOUNT_SUCCESSOR'
   AND p.identity_successor_receipt->>'transitionId'=p.id::text AND p.reconciled_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Verified successor receipt is required' USING ERRCODE='55000';END IF;
 ELSE RAISE EXCEPTION 'Unknown reservation release' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

-- P09 logical fragment: META_ACCOUNT_TRANSITION_OBSERVER.sql
-- Bound source SHA256: 8cd3f7302ab2c60f859d45d742bbce5fe4eaf2d800a3c957068fa6b078ed954f
-- Unapplied P09/P05 companion. Original provider effect authority is not renewed.
ALTER TABLE public.meta_signup_attempts ADD COLUMN target_transition_id uuid,
 ADD FOREIGN KEY(tenant_id,target_transition_id) REFERENCES public.meta_account_transitions(tenant_id,id),
 ADD CHECK((purpose='TRANSITION_READBACK')=(target_transition_id IS NOT NULL));
DO $$ DECLARE expression text; item text; suffix text;
BEGIN
 FOR item,suffix IN SELECT * FROM (VALUES
  ('meta_signup_attempts_purpose_check','purpose=''TRANSITION_READBACK'''),
  ('meta_signup_reconnect_target_check','purpose=''TRANSITION_READBACK'' AND target_connection_id IS NOT NULL AND target_binding IS NOT NULL AND jsonb_typeof(target_binding)=''object'' AND target_binding->>''state''=''PAUSED'' AND target_binding->>''contextSha256'' ~ ''^[a-f0-9]{64}$'' AND target_transition_id IS NOT NULL AND (connection_id IS NULL OR connection_id=target_connection_id)'),
  ('meta_signup_connection_write_purpose_check','purpose=''TRANSITION_READBACK'' AND target_transition_id IS NOT NULL AND connection_id IS NOT NULL')) AS x(name,extra)
 LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_catalog.pg_constraint
   WHERE conrelid='public.meta_signup_attempts'::regclass AND conname=item;
  IF expression IS NULL THEN RAISE EXCEPTION 'Expected signup boundary is absent';END IF;
  EXECUTE format('ALTER TABLE public.meta_signup_attempts DROP CONSTRAINT %I',item);
  EXECUTE format('ALTER TABLE public.meta_signup_attempts ADD CONSTRAINT %I CHECK ((%s) OR ((%s) IS TRUE))',item,expression,suffix);
 END LOOP;
END $$;
GRANT SELECT ON public.meta_signup_attempts,public.secret_cleanup_outbox TO wasalx_meta_transition_executor;
GRANT UPDATE(status,revision,selected_choice,credential_metadata,choices,connection_id,operation_id,readiness,reason_code,connection_credential_write_claimed_at,updated_at)
 ON public.meta_signup_attempts TO wasalx_meta_transition_executor;
GRANT INSERT ON public.secret_cleanup_outbox TO wasalx_meta_transition_executor;

-- Used by existing P05 before SDK launch and at every guarded continuation. The
-- source token may be expired; it supplies identity, never fresh provider proof.
CREATE FUNCTION app.meta_transition_observer_target(plan_value uuid,connection_value uuid,actor_value uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;b public.meta_connection_account_bindings;s public.provider_sessions;c public.connections;
 a public.meta_messaging_accounts;scope_binding jsonb;v jsonb;account_value text;
BEGIN
 PERFORM app.meta_transition_actor_current(actor_value);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value;
 IF p.id IS NULL OR p.state='CANCELLED' OR p.execution_state IN('UNPREPARED','RECONCILED_PAUSED')
  OR p.provider_migration_id IS NULL THEN RAISE EXCEPTION 'Captured transition is unavailable' USING ERRCODE='55000';END IF;
 PERFORM app.lock_meta_transition_accounts(array_remove(ARRAY[p.source_account_id,p.target_account_id],NULL));
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value FOR UPDATE NOWAIT;
 SELECT value INTO scope_binding FROM jsonb_array_elements(p.execution_scope->'bindings') WHERE value->>'connectionId'=connection_value::text;
 SELECT * INTO b FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=(scope_binding->>'id')::uuid;
 SELECT * INTO c FROM public.connections WHERE tenant_id=p.tenant_id AND id=connection_value;
 SELECT * INTO s FROM public.provider_sessions WHERE tenant_id=p.tenant_id AND id=b.provider_session_id;
 SELECT * INTO a FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=p.source_account_id;
 IF b.id IS NULL OR b.account_id<>p.source_account_id OR b.connection_id<>connection_value OR b.state<>'ACTIVE'
  OR b.revision::text IS DISTINCT FROM scope_binding->>'revision' OR b.secret_reference IS DISTINCT FROM scope_binding->>'secretReference'
  OR b.provider_session_id::text IS DISTINCT FROM scope_binding->>'sessionId' OR b.phone_number_id IS DISTINCT FROM scope_binding->>'phoneId'
  OR b.app_id IS DISTINCT FROM scope_binding->>'appId' OR c.state<>'PAUSED' OR c.secret_reference<>b.secret_reference
  OR s.id IS NULL OR s.ownership_state<>'ACTIVE' OR s.state<>'PAUSED' OR s.opaque_session_id<>b.phone_number_id
  OR s.provider_state_data->>'wabaId' IS DISTINCT FROM a.provider_account_id
  OR NOT EXISTS(SELECT 1 FROM public.meta_account_transition_reservations r WHERE r.tenant_id=p.tenant_id AND r.transition_id=p.id
   AND r.account_id=p.source_account_id AND r.released_at IS NULL)
  OR EXISTS(SELECT 1 FROM public.connection_operations o WHERE o.tenant_id=p.tenant_id AND o.id=p.execution_operation_id
   AND o.state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN RAISE EXCEPTION 'Original observer binding changed' USING ERRCODE='55000';END IF;
 account_value:=a.provider_account_id;
 IF p.provider_status='COMPLETED' AND p.target_account_id IS NOT NULL THEN
  SELECT target.provider_account_id INTO account_value FROM public.meta_messaging_accounts target
   JOIN public.connection_operations observation ON observation.tenant_id=target.tenant_id AND observation.id=p.provider_observation_operation_id
   WHERE target.tenant_id=p.tenant_id AND target.id=p.target_account_id
    AND observation.result#>>'{metaTransitionObservation,migrationId}'=p.provider_migration_id
    AND observation.result#>>'{metaTransitionObservation,status}'='COMPLETED'
    AND observation.result#>>'{metaTransitionObservation,destination,id}'=target.provider_account_id;
  IF account_value IS NULL THEN RAISE EXCEPTION 'Captured successor is unavailable' USING ERRCODE='55000';END IF;
 END IF;
 v:=jsonb_build_object('state','PAUSED','transitionId',p.id,'scopeSha256',p.execution_scope_sha256,'sourceBindingId',b.id,
  'sourceBindingRevision',b.revision,'connectionId',c.id,'providerSessionId',s.id,'phoneNumberId',b.phone_number_id,
  'wabaId',account_value,'sourceWabaId',a.provider_account_id,'appId',b.app_id,'secretReference',b.secret_reference,
  'migrationId',p.provider_migration_id);
 RETURN v||jsonb_build_object('contextSha256',encode(public.digest(v::text,'sha256'),'hex'));
END $$;
REVOKE ALL ON FUNCTION app.meta_transition_observer_target(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_observer_target(uuid,uuid,uuid) TO wasalx_app,wasalx_meta_transition_executor;

-- Single private provenance projection consumed by worker/recording/successor and
-- identity companion. It never issues effect authority or broadens a secret path.
CREATE FUNCTION app.meta_transition_observer_credential(plan_value uuid,binding_value uuid,operation_value uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;o public.connection_operations;attempt public.meta_signup_attempts;v jsonb;
BEGIN
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Transition is unavailable' USING ERRCODE='55000';END IF;
 IF operation_value IS NULL AND NOT(p.observer_operations ? binding_value::text) THEN RETURN NULL;END IF;
 IF operation_value IS NULL OR p.observer_operations->>binding_value::text IS DISTINCT FROM operation_value::text THEN
  RAISE EXCEPTION 'Selected observer changed' USING ERRCODE='55000';END IF;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=operation_value;
 SELECT * INTO attempt FROM public.meta_signup_attempts WHERE tenant_id=p.tenant_id AND id=(o.payload->>'metaSignupAttemptId')::uuid;
 v:=o.result->'metaTransitionObserverProof';
 IF o.id IS NULL OR attempt.id IS NULL OR jsonb_typeof(v) IS DISTINCT FROM 'object'
  OR o.state<>'SUCCEEDED' OR o.operation_type<>'ROTATE_META_CREDENTIAL' OR o.result->>'metaTransitionObserverReady' IS DISTINCT FROM 'true'
  OR o.payload#>>'{metaTransitionReadback,transitionId}' IS DISTINCT FROM p.id::text
  OR o.payload#>>'{metaTransitionReadback,sourceBindingId}' IS DISTINCT FROM binding_value::text
  OR o.payload#>>'{metaTransitionReadback,scopeSha256}' IS DISTINCT FROM p.execution_scope_sha256
  OR attempt.purpose<>'TRANSITION_READBACK' OR attempt.status<>'COMPLETED' OR attempt.operation_id<>o.id
  OR attempt.target_transition_id<>p.id OR attempt.connection_id<>o.connection_id
  OR NOT EXISTS(SELECT 1 FROM public.tenant_memberships membership JOIN public.tenants tenant ON tenant.id=membership.tenant_id
   WHERE membership.tenant_id=p.tenant_id AND membership.user_id=attempt.requested_by AND membership.state='ACTIVE'
    AND membership.role IN('tenant_owner','tenant_admin') AND tenant.state='ACTIVE')
  OR v->>'secretReference' IS DISTINCT FROM o.payload->>'newSecretReference'
  OR v->>'credentialFingerprint' IS DISTINCT FROM attempt.credential_fingerprint
  OR v->>'operationId' IS DISTINCT FROM o.id::text OR v->>'tenantId' IS DISTINCT FROM p.tenant_id::text
  OR v->>'connectionId' IS DISTINCT FROM o.connection_id::text
  OR v->>'phoneNumberId' IS DISTINCT FROM attempt.target_binding->>'phoneNumberId'
  OR v->>'wabaId' IS DISTINCT FROM attempt.target_binding->>'wabaId'
  OR v#>>'{credentialMetadata,appId}' IS DISTINCT FROM attempt.config->>'appId'
  OR v#>>'{credentialMetadata,claim}' IS DISTINCT FROM 'CREDENTIAL_METADATA_VERIFIED'
  OR v#>>'{credentialMetadata,expiresAt}' IS NULL
  OR ((v#>>'{credentialMetadata,expiresAt}')::numeric<>0 AND (v#>>'{credentialMetadata,expiresAt}')::numeric<=extract(epoch FROM clock_timestamp()))
  OR ((v#>>'{credentialMetadata,dataAccessExpiresAt}')::numeric<>0 AND (v#>>'{credentialMetadata,dataAccessExpiresAt}')::numeric<=extract(epoch FROM clock_timestamp())) THEN
  RAISE EXCEPTION 'Observer provenance is unavailable' USING ERRCODE='55000';END IF;
 RETURN jsonb_build_object('operationId',o.id,'attemptId',attempt.id,'sourceBindingId',binding_value,'scopeSha256',p.execution_scope_sha256,
  'secretReference',v->>'secretReference','credentialFingerprint',v->>'credentialFingerprint','accountProof',v,
  'observerAccountId',v->>'wabaId','phoneNumberId',v->>'phoneNumberId','appId',attempt.config->>'appId');
END $$;
REVOKE ALL ON FUNCTION app.meta_transition_observer_credential(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_observer_credential(uuid,uuid,uuid) TO wasalx_connector_worker,wasalx_meta_transition_executor;

CREATE FUNCTION app.meta_transition_pinned_observers(plan_value uuid,pinned jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;b jsonb;result jsonb:='{}'::jsonb;
BEGIN
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value;
 IF p.id IS NULL OR pinned IS DISTINCT FROM p.observer_operations OR jsonb_typeof(pinned) IS DISTINCT FROM 'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(pinned) k WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.execution_scope->'bindings') x WHERE x->>'id'=k)) THEN
  RAISE EXCEPTION 'Queued observer selection changed' USING ERRCODE='55000';END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(p.execution_scope->'bindings') LOOP
  result:=result||jsonb_build_object(b->>'id',app.meta_transition_observer_credential(p.id,(b->>'id')::uuid,(pinned->>(b->>'id'))::uuid));
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.meta_transition_pinned_observers(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_pinned_observers(uuid,jsonb) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;

CREATE FUNCTION app.stage_meta_transition_observer(attempt_value uuid,actor_value uuid,revision_value integer,choice_value uuid,selection jsonb,metadata jsonb,request_value text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE attempt public.meta_signup_attempts;o public.connection_operations;t jsonb;choice jsonb;key_value text;reference_value text;id_value uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO attempt FROM public.meta_signup_attempts WHERE tenant_id=app.current_tenant_id() AND id=attempt_value AND requested_by=actor_value;
 IF attempt.id IS NULL OR attempt.purpose<>'TRANSITION_READBACK' THEN RAISE EXCEPTION 'Authorization is unavailable' USING ERRCODE='55000';END IF;
 t:=app.meta_transition_observer_target(attempt.target_transition_id,attempt.target_connection_id,actor_value);
 SELECT * INTO attempt FROM public.meta_signup_attempts WHERE tenant_id=app.current_tenant_id() AND id=attempt_value FOR UPDATE NOWAIT;
 IF attempt.target_binding IS DISTINCT FROM t OR attempt.revision IS DISTINCT FROM revision_value THEN
  RAISE EXCEPTION 'Observer authorization changed' USING ERRCODE='55000';END IF;
 IF attempt.connection_id IS NOT NULL THEN
  SELECT * INTO o FROM public.connection_operations WHERE tenant_id=attempt.tenant_id AND id=attempt.operation_id FOR UPDATE NOWAIT;
  IF o.id IS NULL OR o.state NOT IN('STAGED','SUCCEEDED') OR o.payload#>>'{metaTransitionReadback,attemptId}' IS DISTINCT FROM attempt.id::text
   OR attempt.selected_choice->>'choiceId' IS DISTINCT FROM choice_value::text THEN
   RAISE EXCEPTION 'Original observer stage changed' USING ERRCODE='55000';END IF;
  RETURN jsonb_build_object('operation',to_jsonb(o),'attemptRevision',attempt.revision,'claimed',attempt.connection_credential_write_claimed_at IS NOT NULL);
 END IF;
 SELECT value INTO choice FROM jsonb_array_elements(attempt.choices) WHERE value->>'choiceId'=choice_value::text;
 IF attempt.status<>'SELECTION_REQUIRED' OR attempt.expires_at<=clock_timestamp() OR attempt.credential_fingerprint IS NULL
  OR choice IS NULL OR choice->>'selectable' IS DISTINCT FROM 'true' OR choice->>'mode' IS DISTINCT FROM 'STANDARD'
  OR choice->>'phoneId' IS DISTINCT FROM t->>'phoneNumberId'
  OR choice->>'wabaId' IS DISTINCT FROM t->>'wabaId' OR attempt.config->>'appId' IS DISTINCT FROM t->>'appId'
  OR selection->>'phoneId' IS DISTINCT FROM choice->>'phoneId' OR selection->>'wabaId' IS DISTINCT FROM choice->>'wabaId'
  OR selection->>'businessId' IS DISTINCT FROM choice->>'businessId' OR selection->>'mode' IS DISTINCT FROM 'STANDARD'
  OR COALESCE(selection->>'proofSha256','') !~ '^[a-f0-9]{64}$'
  OR metadata->>'claim' IS DISTINCT FROM 'CREDENTIAL_METADATA_VERIFIED' OR metadata->>'appId' IS DISTINCT FROM t->>'appId'
  OR attempt.registration_pin_fingerprint IS NOT NULL OR attempt.registration_claimed_at IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.connection_operations other WHERE other.tenant_id=attempt.tenant_id AND other.connection_id=attempt.target_connection_id
   AND other.state IN('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE')) THEN RAISE EXCEPTION 'Verified observer selection is unavailable' USING ERRCODE='55000';END IF;
 key_value:='meta-transition-readback-'||attempt.id::text;
 reference_value:='secret://'||attempt.tenant_id::text||'/connections/'||attempt.target_connection_id::text||'/meta/rotations/'||encode(public.digest(key_value,'sha256'),'hex');
 INSERT INTO public.connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,max_attempts,requested_by_type,requested_by_id,request_id)
 VALUES(id_value,attempt.tenant_id,attempt.target_connection_id,'ROTATE_META_CREDENTIAL',key_value,
  jsonb_build_object('metaSignupAttemptId',attempt.id,'metaSignupPurpose','TRANSITION_READBACK','oldSecretReference',t->>'secretReference',
   'newSecretReference',reference_value,'request',jsonb_build_object('credentialFingerprint',attempt.credential_fingerprint),
   'metaTransitionReadback',jsonb_build_object('transitionId',attempt.target_transition_id,'sourceBindingId',t->>'sourceBindingId',
    'scopeSha256',t->>'scopeSha256','attemptId',attempt.id,'observerAccountId',t->>'wabaId')),
  'STAGED',1,'USER',actor_value::text,request_value) RETURNING * INTO o;
 UPDATE public.meta_signup_attempts SET connection_id=target_connection_id,operation_id=o.id,status='PROVISIONING',
  selected_choice=jsonb_build_object('choiceId',choice_value,'businessId',selection->>'businessId','wabaId',selection->>'wabaId',
   'phoneId',selection->>'phoneId','mode','STANDARD','numberState',selection->>'numberState','proofSha256',selection->>'proofSha256'),credential_metadata=metadata,
  revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=attempt.tenant_id AND id=attempt.id RETURNING * INTO attempt;
 INSERT INTO public.secret_cleanup_outbox(tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference)
 VALUES(attempt.tenant_id,attempt.connection_id,o.id,'CONNECTION_CREDENTIAL',reference_value);
 RETURN jsonb_build_object('operation',to_jsonb(o),'attemptRevision',attempt.revision,'claimed',false);
END $$;
ALTER FUNCTION app.stage_meta_transition_observer(uuid,uuid,integer,uuid,jsonb,jsonb,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.stage_meta_transition_observer(uuid,uuid,integer,uuid,jsonb,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.stage_meta_transition_observer(uuid,uuid,integer,uuid,jsonb,jsonb,text) TO wasalx_app;

CREATE FUNCTION app.claim_meta_transition_observer_write(attempt_value uuid,actor_value uuid,revision_value integer)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE attempt public.meta_signup_attempts;t jsonb;
BEGIN
 SELECT * INTO attempt FROM public.meta_signup_attempts WHERE tenant_id=app.current_tenant_id() AND id=attempt_value AND requested_by=actor_value;
 IF attempt.id IS NULL OR attempt.purpose<>'TRANSITION_READBACK' THEN RAISE EXCEPTION 'Observer attempt is unavailable' USING ERRCODE='55000';END IF;
 t:=app.meta_transition_observer_target(attempt.target_transition_id,attempt.target_connection_id,actor_value);
 IF t IS DISTINCT FROM attempt.target_binding THEN RAISE EXCEPTION 'Observer target changed' USING ERRCODE='55000';END IF;
 UPDATE public.meta_signup_attempts SET connection_credential_write_claimed_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()
 WHERE tenant_id=attempt.tenant_id AND id=attempt.id AND revision=revision_value AND status='PROVISIONING'
  AND connection_credential_write_claimed_at IS NULL AND EXISTS(SELECT 1 FROM public.connection_operations o
   WHERE o.tenant_id=attempt.tenant_id AND o.id=attempt.operation_id AND o.state='STAGED'
    AND o.payload#>>'{metaTransitionReadback,attemptId}'=attempt.id::text) RETURNING * INTO attempt;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original credential write may already have run' USING ERRCODE='55000';END IF;
 RETURN attempt.revision;
END $$;
ALTER FUNCTION app.claim_meta_transition_observer_write(uuid,uuid,integer) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.claim_meta_transition_observer_write(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_meta_transition_observer_write(uuid,uuid,integer) TO wasalx_app;

CREATE FUNCTION app.complete_meta_transition_observer(attempt_value uuid,actor_value uuid,revision_value integer,proof jsonb)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE attempt public.meta_signup_attempts;o public.connection_operations;t jsonb;
BEGIN
 SELECT * INTO attempt FROM public.meta_signup_attempts WHERE tenant_id=app.current_tenant_id() AND id=attempt_value AND requested_by=actor_value;
 IF attempt.id IS NULL OR attempt.purpose<>'TRANSITION_READBACK' THEN RAISE EXCEPTION 'Observer attempt is unavailable' USING ERRCODE='55000';END IF;
 t:=app.meta_transition_observer_target(attempt.target_transition_id,attempt.target_connection_id,actor_value);
 SELECT * INTO attempt FROM public.meta_signup_attempts WHERE tenant_id=app.current_tenant_id() AND id=attempt_value FOR UPDATE NOWAIT;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=attempt.tenant_id AND id=attempt.operation_id FOR UPDATE NOWAIT;
 IF attempt.target_binding IS DISTINCT FROM t OR attempt.revision IS DISTINCT FROM revision_value
  OR attempt.connection_credential_write_claimed_at IS NULL OR attempt.status<>'PROVISIONING' OR o.id IS NULL OR o.state<>'STAGED'
  OR jsonb_typeof(proof) IS DISTINCT FROM 'object' OR proof->>'schemaVersion' IS DISTINCT FROM '1'
  OR proof->>'claim' IS DISTINCT FROM 'PHONE_ACCOUNT_RELATION_VERIFIED'
  OR proof->>'tenantId' IS DISTINCT FROM attempt.tenant_id::text OR proof->>'connectionId' IS DISTINCT FROM attempt.connection_id::text
  OR proof->>'providerSessionId' IS DISTINCT FROM t->>'providerSessionId' OR proof->>'phoneNumberId' IS DISTINCT FROM t->>'phoneNumberId'
  OR proof->>'wabaId' IS DISTINCT FROM t->>'wabaId' OR proof->>'operationId' IS DISTINCT FROM o.id::text OR proof->>'fencingToken' IS DISTINCT FROM '0'
  OR proof->>'secretReference' IS DISTINCT FROM o.payload->>'newSecretReference' OR proof->>'credentialFingerprint' IS DISTINCT FROM attempt.credential_fingerprint
  OR proof->>'graphVersion' IS DISTINCT FROM attempt.config->>'graphVersion'
  OR COALESCE(proof->>'responseSha256','') !~ '^[a-f0-9]{64}$'
  OR proof#>>'{credentialMetadata,appId}' IS DISTINCT FROM t->>'appId'
  OR proof#>>'{credentialMetadata,claim}' IS DISTINCT FROM 'CREDENTIAL_METADATA_VERIFIED'
  OR proof#>>'{credentialMetadata,schemaVersion}' IS DISTINCT FROM '1'
  OR jsonb_typeof(proof#>'{credentialMetadata,scopes}') IS DISTINCT FROM 'array'
  OR NOT COALESCE((proof#>'{credentialMetadata,scopes}') @> '["whatsapp_business_management","whatsapp_business_messaging"]'::jsonb,false)
  OR COALESCE(proof#>>'{credentialMetadata,responseSha256}','') !~ '^[a-f0-9]{64}$'
  OR proof#>>'{credentialMetadata,expiresAt}' IS NULL
  OR ((proof#>>'{credentialMetadata,expiresAt}')::numeric<>0 AND (proof#>>'{credentialMetadata,expiresAt}')::numeric<=extract(epoch FROM clock_timestamp()))
  OR ((proof#>>'{credentialMetadata,dataAccessExpiresAt}')::numeric<>0 AND (proof#>>'{credentialMetadata,dataAccessExpiresAt}')::numeric<=extract(epoch FROM clock_timestamp()))
  OR proof#>>'{credentialMetadata,verifiedAt}' IS NULL
  OR (proof#>>'{credentialMetadata,verifiedAt}')::timestamptz<clock_timestamp()-interval '2 minutes'
  OR (proof#>>'{credentialMetadata,verifiedAt}')::timestamptz>clock_timestamp()
  OR proof->>'verifiedAt' IS NULL OR (proof->>'verifiedAt')::timestamptz<clock_timestamp()-interval '2 minutes'
  OR (proof->>'verifiedAt')::timestamptz>clock_timestamp() THEN RAISE EXCEPTION 'Verified observer completion changed' USING ERRCODE='55000';END IF;
 UPDATE public.connection_operations SET state='SUCCEEDED',completed_at=clock_timestamp(),updated_at=clock_timestamp(),
  result=jsonb_build_object('metaTransitionObserverReady',true,'metaTransitionObserverProof',proof)
  WHERE tenant_id=o.tenant_id AND id=o.id AND state='STAGED' AND result IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original observer outcome is occupied' USING ERRCODE='55000';END IF;
 UPDATE public.meta_signup_attempts SET status='COMPLETED',reason_code=NULL,revision=revision+1,updated_at=clock_timestamp()
  WHERE tenant_id=attempt.tenant_id AND id=attempt.id;
 UPDATE public.meta_account_transitions SET observer_operations=observer_operations||jsonb_build_object(t->>'sourceBindingId',o.id),
  revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=attempt.tenant_id AND id=attempt.target_transition_id;
 RETURN true;
END $$;
ALTER FUNCTION app.complete_meta_transition_observer(uuid,uuid,integer,jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.complete_meta_transition_observer(uuid,uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_meta_transition_observer(uuid,uuid,integer,jsonb) TO wasalx_app;

CREATE FUNCTION app.cancel_meta_transition_observer(attempt_value uuid,actor_value uuid,revision_value integer,stored_fingerprint text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE attempt public.meta_signup_attempts;o public.connection_operations;p public.meta_account_transitions;
BEGIN
 PERFORM app.meta_transition_actor_current(actor_value);
 SELECT * INTO attempt FROM public.meta_signup_attempts WHERE tenant_id=app.current_tenant_id() AND id=attempt_value AND requested_by=actor_value;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=attempt.tenant_id AND id=attempt.target_transition_id;
 IF attempt.id IS NULL OR attempt.purpose<>'TRANSITION_READBACK' OR p.id IS NULL THEN RETURN false;END IF;
 PERFORM app.lock_meta_transition_accounts(array_remove(ARRAY[p.source_account_id,p.target_account_id],NULL));
 SELECT * INTO attempt FROM public.meta_signup_attempts WHERE tenant_id=p.tenant_id AND id=attempt.id FOR UPDATE NOWAIT;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=attempt.operation_id FOR UPDATE NOWAIT;
 IF attempt.revision<>revision_value OR attempt.status<>'PROVISIONING' OR o.state<>'STAGED'
  OR o.payload#>>'{metaTransitionReadback,attemptId}' IS DISTINCT FROM attempt.id::text
  OR (stored_fingerprint IS NOT NULL AND stored_fingerprint IS DISTINCT FROM attempt.credential_fingerprint)
  OR (attempt.connection_credential_write_claimed_at IS NOT NULL AND stored_fingerprint IS NULL)
  OR EXISTS(SELECT 1 FROM jsonb_each_text(p.observer_operations) selected WHERE selected.value=o.id::text) THEN RETURN false;END IF;
 UPDATE public.connection_operations SET state='CANCELLED',result=jsonb_build_object('stageReconciled',true,'promoted',false),
  error_code='META_SIGNUP_CANCELLED',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=o.tenant_id AND id=o.id;
 UPDATE public.meta_signup_attempts SET status='CANCELLED',reason_code='META_SIGNUP_CANCELLED',choices='[]',revision=revision+1,updated_at=clock_timestamp()
  WHERE tenant_id=attempt.tenant_id AND id=attempt.id;
 RETURN true;
END $$;
ALTER FUNCTION app.cancel_meta_transition_observer(uuid,uuid,integer,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.cancel_meta_transition_observer(uuid,uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cancel_meta_transition_observer(uuid,uuid,integer,text) TO wasalx_app;

-- Readback renewal never carries an effect grant. A separate platform review
-- may authorize only the original never-attempted COMPLETE with fresh access.
CREATE FUNCTION app.operator_authorize_meta_transition_completion(plan_value uuid,revision_value bigint,observer_value uuid,candidate jsonb,operator_value text,request_value text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;initial public.meta_provider_effect_checkpoints;o public.connection_operations;
 a public.meta_signup_attempts;base public.platform_operations_audit_events;original public.platform_operations_audit_events;
 target_review public.platform_operations_audit_events;observed public.connection_operations;receipt uuid:=gen_random_uuid();proof jsonb;
BEGIN
 SELECT * INTO p FROM public.meta_account_transitions WHERE id=plan_value FOR UPDATE NOWAIT;
 SELECT * INTO initial FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=p.id AND stage='INITIATE';
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=observer_value;
 SELECT * INTO a FROM public.meta_signup_attempts WHERE tenant_id=p.tenant_id AND operation_id=o.id AND purpose='TRANSITION_READBACK';
 SELECT * INTO base FROM public.platform_operations_audit_events WHERE id=(candidate->>'prerequisiteReceiptId')::uuid;
 SELECT * INTO original FROM public.platform_operations_audit_events WHERE id=p.execution_authorization_id;
 SELECT * INTO target_review FROM public.platform_operations_audit_events WHERE id=(candidate->>'targetReviewReceiptId')::uuid;
 SELECT * INTO observed FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=p.provider_observation_operation_id;
 proof:=o.result->'metaTransitionObserverProof';
 IF p.id IS NULL OR p.revision IS DISTINCT FROM revision_value OR p.state='CANCELLED' OR p.execution_state='RECONCILED_PAUSED'
  OR initial.outcome IS DISTINCT FROM 'SUCCEEDED' OR initial.result->>'migrationId' IS DISTINCT FROM p.provider_migration_id
  OR p.provider_status IS DISTINCT FROM 'READY_TO_COMPLETE' OR p.target_account_id IS NULL
  OR EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints c WHERE c.tenant_id=p.tenant_id AND c.owner_kind='ACCOUNT_TRANSITION' AND c.owner_id=p.id AND c.stage='COMPLETE')
  OR (SELECT count(*) FROM public.meta_account_transition_reservations r WHERE r.tenant_id=p.tenant_id AND r.transition_id=p.id AND r.released_at IS NULL)<>2
  OR p.observer_operations->>p.initiating_binding_id::text IS DISTINCT FROM observer_value::text
  OR o.state IS DISTINCT FROM 'SUCCEEDED' OR o.result->>'metaTransitionObserverReady' IS DISTINCT FROM 'true'
  OR a.status IS DISTINCT FROM 'COMPLETED' OR a.target_transition_id IS DISTINCT FROM p.id
  OR o.payload#>>'{metaTransitionReadback,sourceBindingId}' IS DISTINCT FROM p.initiating_binding_id::text
  OR o.payload#>>'{metaTransitionReadback,scopeSha256}' IS DISTINCT FROM p.execution_scope_sha256
  OR base.action IS DISTINCT FROM 'meta.transition.prerequisites.simulated.approved'
  OR base.target_id IS DISTINCT FROM p.id::text OR base.safe_metadata->>'tenantId' IS DISTINCT FROM p.tenant_id::text
  OR (base.safe_metadata-ARRAY['expiresAt','evidenceSha256','scopeSha256','authorityRevision','previewRevision','sourcePolicyVersionId']) IS DISTINCT FROM
    (original.safe_metadata-ARRAY['expiresAt','evidenceSha256','scopeSha256','authorityRevision','previewRevision','sourcePolicyVersionId'])
  OR (base.safe_metadata->>'expiresAt')::timestamptz<=clock_timestamp()
  OR EXISTS(SELECT 1 FROM public.platform_operations_audit_events revoked WHERE revoked.action='meta.transition.authorization.withdrawn' AND revoked.target_id=base.id::text)
  OR target_review.action IS DISTINCT FROM 'meta.transition.target.simulated.reviewed' OR target_review.target_id IS DISTINCT FROM p.id::text
  OR target_review.safe_metadata->>'tenantId' IS DISTINCT FROM p.tenant_id::text
  OR target_review.safe_metadata->>'targetAccountId' IS DISTINCT FROM p.target_account_id::text
  OR target_review.safe_metadata->>'migrationId' IS DISTINCT FROM p.provider_migration_id
  OR (target_review.safe_metadata#>>'{review,expiresAt}')::timestamptz<=clock_timestamp()
  OR observed.result#>>'{metaTransitionObservation,status}' IS DISTINCT FROM 'READY_TO_COMPLETE'
  OR observed.result#>>'{metaTransitionObservation,targetReadiness,assets}' IS DISTINCT FROM 'CLONE_ACCESS_VERIFIED'
  OR observed.result#>>'{metaTransitionObservation,targetReadiness,payment}' IS DISTINCT FROM 'VERIFIED'
  OR observed.result#>>'{metaTransitionObservation,cloneAccess,observerOperationId}' IS DISTINCT FROM observer_value::text
  OR proof#>>'{credentialMetadata,appId}' IS DISTINCT FROM base.safe_metadata->>'appId'
  OR proof#>>'{credentialMetadata,claim}' IS DISTINCT FROM 'CREDENTIAL_METADATA_VERIFIED'
  OR proof#>>'{credentialMetadata,expiresAt}' IS NULL
  OR ((proof#>>'{credentialMetadata,expiresAt}')::numeric<>0 AND (proof#>>'{credentialMetadata,expiresAt}')::numeric<=extract(epoch FROM clock_timestamp()))
  OR candidate->>'mode' IS DISTINCT FROM 'SIMULATED' OR COALESCE(candidate->>'evidenceSha256','') !~ '^[a-f0-9]{64}$'
  OR candidate->>'expiresAt' IS NULL OR (candidate->>'expiresAt')::timestamptz<=clock_timestamp()
  OR (candidate->>'expiresAt')::timestamptz>clock_timestamp()+interval '15 minutes'
  OR operator_value IS NULL OR length(operator_value) NOT BETWEEN 1 AND 255 OR operator_value~'[[:cntrl:]]'
  OR request_value IS NULL OR length(request_value) NOT BETWEEN 1 AND 255 OR request_value~'[[:cntrl:]]' THEN
  RAISE EXCEPTION 'Exact renewed completion authority is unavailable' USING ERRCODE='55000';END IF;
 INSERT INTO public.platform_operations_audit_events(id,operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(receipt,operator_value,'meta.transition.completion.simulated.approved','meta.account_transition',p.id::text,
  jsonb_build_object('tenantId',p.tenant_id,'transitionId',p.id,'sourceAccountId',p.source_account_id,'targetAccountId',p.target_account_id,
   'scopeSha256',p.execution_scope_sha256,'initiationCheckpointId',initial.id,'migrationId',p.provider_migration_id,
   'observerOperationId',o.id,'observerProofSha256',encode(public.digest(proof::text,'sha256'),'hex'),'prerequisiteReceiptId',base.id,
   'targetReviewReceiptId',target_review.id,'observationOperationId',observed.id,'requestedMode',p.requested_mode,'targetCurrency',p.target_currency,
   'evidenceSha256',candidate->>'evidenceSha256','expiresAt',candidate->>'expiresAt','mode','SIMULATED'),request_value);
 RETURN jsonb_build_object('receiptId',receipt,'transitionId',p.id,'mode','SIMULATED');
END $$;
REVOKE ALL ON FUNCTION app.operator_authorize_meta_transition_completion(uuid,bigint,uuid,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_authorize_meta_transition_completion(uuid,bigint,uuid,jsonb,text,text) TO wasalx_platform_operations_client;

CREATE FUNCTION app.meta_transition_completion_authorization(plan_value uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;authority jsonb;renewed jsonb;review jsonb;result jsonb;
BEGIN
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value;
 IF p.id IS NULL OR NOT(p.observer_operations ? p.initiating_binding_id::text) THEN RETURN NULL;END IF;
 authority:=app.meta_transition_authorization(p.id);review:=app.meta_transition_target_review(p.id);
 renewed:=app.meta_transition_observer_credential(p.id,p.initiating_binding_id,(p.observer_operations->>p.initiating_binding_id::text)::uuid);
 SELECT e.safe_metadata||jsonb_build_object('receiptId',e.id) INTO result FROM public.platform_operations_audit_events e
 WHERE e.action='meta.transition.completion.simulated.approved' AND e.target_id=p.id::text
  AND e.safe_metadata->>'tenantId'=p.tenant_id::text AND e.safe_metadata->>'scopeSha256'=p.execution_scope_sha256
  AND e.safe_metadata->>'sourceAccountId'=p.source_account_id::text AND e.safe_metadata->>'targetAccountId'=p.target_account_id::text
  AND e.safe_metadata->>'migrationId'=p.provider_migration_id AND e.safe_metadata->>'observerOperationId'=renewed->>'operationId'
  AND e.safe_metadata->>'observerProofSha256'=encode(public.digest((renewed->'accountProof')::text,'sha256'),'hex')
  AND e.safe_metadata->>'prerequisiteReceiptId'=authority->>'receiptId' AND e.safe_metadata->>'targetReviewReceiptId'=review->>'receiptId'
  AND e.safe_metadata->>'observationOperationId'=p.provider_observation_operation_id::text
  AND e.safe_metadata->>'requestedMode'=p.requested_mode AND e.safe_metadata->>'targetCurrency'=p.target_currency
  AND (e.safe_metadata->>'expiresAt')::timestamptz>clock_timestamp()
  AND NOT EXISTS(SELECT 1 FROM public.platform_operations_audit_events withdrawn WHERE withdrawn.action='meta.transition.authorization.withdrawn' AND withdrawn.target_id=e.id::text)
 ORDER BY e.created_at DESC,e.id DESC LIMIT 1;
 RETURN result;
EXCEPTION WHEN SQLSTATE '55000' THEN
 -- Public capability may say unavailable; execution still resolves the exact
 -- queued observer independently and never falls back to original authority.
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.meta_transition_completion_authorization(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_completion_authorization(uuid) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;

CREATE FUNCTION app.guard_meta_transition_observer_state() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='meta_signup_attempts' THEN
  IF TG_OP='UPDATE' AND NEW.target_transition_id IS DISTINCT FROM OLD.target_transition_id THEN
   RAISE EXCEPTION 'Observer transition binding is immutable' USING ERRCODE='23514';END IF;
  IF NEW.purpose='TRANSITION_READBACK' AND TG_OP='UPDATE' AND current_user<>'wasalx_meta_transition_executor'
   AND (NEW.connection_id,NEW.operation_id,NEW.selected_choice,NEW.connection_credential_write_claimed_at) IS DISTINCT FROM
    (OLD.connection_id,OLD.operation_id,OLD.selected_choice,OLD.connection_credential_write_claimed_at) THEN
   RAISE EXCEPTION 'Observer stage requires sealed admission' USING ERRCODE='42501';END IF;
 ELSIF TG_TABLE_NAME='meta_account_transitions' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.observer_operations IS DISTINCT FROM '{}'::jsonb THEN RAISE EXCEPTION 'New transition has no renewed authority' USING ERRCODE='42501';END IF;
  ELSIF NEW.observer_operations IS DISTINCT FROM OLD.observer_operations AND current_user<>'wasalx_meta_transition_executor' THEN
   RAISE EXCEPTION 'Observer provenance requires sealed completion' USING ERRCODE='42501';END IF;
 ELSE
  IF TG_OP='INSERT' THEN
   IF NEW.payload ? 'metaTransitionReadback' AND (current_user<>'wasalx_meta_transition_executor' OR NEW.state<>'STAGED'
    OR NEW.operation_type<>'ROTATE_META_CREDENTIAL') THEN RAISE EXCEPTION 'Observer stage is not ordinary rotation' USING ERRCODE='42501';END IF;
  ELSIF OLD.payload ? 'metaTransitionReadback' THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Observer history is retained' USING ERRCODE='55000';END IF;
   -- Only the existing leased tenant-privacy executor may replace the private
   -- proof with its exact digest; all operation and effect identities remain.
   IF current_user='wasalx_meta_transition_executor' AND OLD.state='SUCCEEDED'
    AND OLD.result ? 'metaTransitionObserverProof' AND NOT(OLD.result->'metaTransitionObserverProof' ? 'redacted')
    AND NEW.result=jsonb_set(OLD.result,'{metaTransitionObserverProof}',jsonb_build_object('redacted',true,'sha256',
      encode(public.digest((OLD.result->'metaTransitionObserverProof')::text,'sha256'),'hex')))
    AND (to_jsonb(NEW)-'result') IS NOT DISTINCT FROM (to_jsonb(OLD)-'result') THEN
    IF app.meta_managed_privacy_authorized(OLD.tenant_id) THEN RETURN NEW;END IF;
   END IF;
   IF (NEW.payload,NEW.connection_id,NEW.tenant_id,NEW.operation_type,NEW.idempotency_key,NEW.requested_by_id)
    IS DISTINCT FROM (OLD.payload,OLD.connection_id,OLD.tenant_id,OLD.operation_type,OLD.idempotency_key,OLD.requested_by_id)
    OR NEW.state NOT IN('STAGED','SUCCEEDED','CANCELLED') OR (OLD.state<>'STAGED' AND NEW.state<>OLD.state)
    OR (NEW.state IS DISTINCT FROM OLD.state AND current_user<>'wasalx_meta_transition_executor')
    OR (NEW.result IS DISTINCT FROM OLD.result AND (current_user<>'wasalx_meta_transition_executor' OR OLD.result IS NOT NULL)) THEN
    RAISE EXCEPTION 'Observer result cannot dispatch or change authority' USING ERRCODE='23514';END IF;
  ELSIF TG_OP='UPDATE' AND NEW.payload ? 'metaTransitionReadback' THEN RAISE EXCEPTION 'Observer purpose is immutable' USING ERRCODE='23514';END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
REVOKE ALL ON FUNCTION app.guard_meta_transition_observer_state() FROM PUBLIC;
CREATE TRIGGER meta_observer_attempt BEFORE UPDATE ON public.meta_signup_attempts FOR EACH ROW EXECUTE FUNCTION app.guard_meta_transition_observer_state();
CREATE TRIGGER meta_observer_plan BEFORE INSERT OR UPDATE ON public.meta_account_transitions FOR EACH ROW EXECUTE FUNCTION app.guard_meta_transition_observer_state();
CREATE TRIGGER meta_observer_operation BEFORE INSERT OR UPDATE OR DELETE ON public.connection_operations FOR EACH ROW EXECUTE FUNCTION app.guard_meta_transition_observer_state();

-- P09 logical fragment: META_ACCOUNT_IDENTITY_SUCCESSOR.sql
-- Bound source SHA256: 103623fb1501dd42fac16487e9d56b8c4d5af753fe09bf298fc164bc4845ef90
-- Private unapplied P09 companion. Root assigns migration ordinals.
-- Shared P09 account/binding/transition columns and execution definitions
-- precede this file. Its mandatory scope helper and apply/guards must exist
-- before the final reconciliation wrapper or any execution admission runs.
ALTER TABLE public.meta_direct_identity_aliases
 ADD COLUMN account_transition_id uuid,
 ADD COLUMN predecessor_alias_id uuid,
 ADD CONSTRAINT meta_direct_account_lineage_pair CHECK
   ((account_transition_id IS NULL)=(predecessor_alias_id IS NULL)),
 ADD CONSTRAINT meta_direct_account_lineage_transition FOREIGN KEY(tenant_id,account_transition_id)
   REFERENCES public.meta_account_transitions(tenant_id,id),
 ADD CONSTRAINT meta_direct_account_lineage_predecessor FOREIGN KEY(tenant_id,predecessor_alias_id)
   REFERENCES public.meta_direct_identity_aliases(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX meta_direct_account_alias_successor ON public.meta_direct_identity_aliases
 (tenant_id,account_transition_id,predecessor_alias_id) WHERE account_transition_id IS NOT NULL;

-- Historical evidence only. Fresh authorization is checked independently by
-- the current-account, lifecycle, routing, billing and identity effect guards.
CREATE FUNCTION app.meta_account_identity_receipt_valid(transition_value uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE plan public.meta_account_transitions; receipt jsonb; observation jsonb;
 initiate public.meta_provider_effect_checkpoints; complete public.meta_provider_effect_checkpoints;
 pair jsonb; predecessor public.meta_connection_account_bindings; successor public.meta_connection_account_bindings;
 source_account text;target_account text;
BEGIN
 SELECT * INTO plan FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=transition_value;
 receipt:=plan.identity_successor_receipt;
 IF plan.id IS NULL OR plan.execution_state<>'RECONCILED_PAUSED' OR plan.reconciled_at IS NULL
  OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR octet_length(receipt::text)>4194304
  OR receipt->'schemaVersion' IS DISTINCT FROM '1' OR receipt->>'claim' IS DISTINCT FROM 'SAME_GRAPH_PHONE_ACCOUNT_SUCCESSOR'
  OR receipt->>'transitionId' IS DISTINCT FROM plan.id::text
  OR receipt->>'sourceAccountId' IS DISTINCT FROM plan.source_account_id::text
  OR receipt->>'targetAccountId' IS DISTINCT FROM plan.target_account_id::text
  OR receipt->>'migrationId' IS DISTINCT FROM plan.provider_migration_id
  OR receipt->>'sourceScopeSha256' IS DISTINCT FROM plan.execution_scope_sha256
  OR receipt->>'completionObservationOperationId' IS DISTINCT FROM plan.provider_observation_operation_id::text
  OR receipt->>'operationId' IS DISTINCT FROM plan.execution_operation_id::text
  OR jsonb_typeof(receipt->'assets') IS DISTINCT FROM 'array'
  OR jsonb_array_length(receipt->'assets') NOT BETWEEN 1 AND 2000
  OR receipt-ARRAY['schemaVersion','claim','transitionId','operationId','sourceAccountId','targetAccountId','migrationId',
     'initiateCheckpointId','completeCheckpointId','completionObservationOperationId','sourceScopeSha256','targetProofSha256','assets','appliedAt']<>'{}'
 THEN RETURN false; END IF;
 SELECT * INTO initiate FROM public.meta_provider_effect_checkpoints WHERE tenant_id=plan.tenant_id
  AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=plan.id AND stage='INITIATE';
 SELECT * INTO complete FROM public.meta_provider_effect_checkpoints WHERE tenant_id=plan.tenant_id
  AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=plan.id AND stage='COMPLETE';
 SELECT result->'metaTransitionObservation' INTO observation FROM public.connection_operations
  WHERE tenant_id=plan.tenant_id AND id=plan.provider_observation_operation_id;
 SELECT provider_account_id INTO source_account FROM public.meta_messaging_accounts WHERE tenant_id=plan.tenant_id AND id=plan.source_account_id;
 SELECT provider_account_id INTO target_account FROM public.meta_messaging_accounts WHERE tenant_id=plan.tenant_id AND id=plan.target_account_id;
 IF plan.provider_migration_id IS NULL OR source_account IS NULL OR target_account IS NULL
  OR initiate.id IS NULL OR complete.id IS NULL OR initiate.outcome='REJECTED' OR complete.outcome='REJECTED'
  OR initiate.account_id IS DISTINCT FROM plan.source_account_id OR complete.account_id IS DISTINCT FROM plan.source_account_id
  OR initiate.result->>'migrationId' IS DISTINCT FROM plan.provider_migration_id
  OR receipt->>'initiateCheckpointId' IS DISTINCT FROM initiate.id::text
  OR receipt->>'completeCheckpointId' IS DISTINCT FROM complete.id::text
  OR observation->>'migrationId' IS DISTINCT FROM plan.provider_migration_id OR observation->>'status' IS DISTINCT FROM 'COMPLETED'
  OR observation#>>'{destination,id}' IS DISTINCT FROM target_account
  OR observation#>>'{destination,currency}' IS DISTINCT FROM plan.target_currency
  OR receipt->>'targetProofSha256' IS DISTINCT FROM encode(digest((observation->'targetAssets')::text,'sha256'),'hex')
  OR jsonb_array_length(receipt->'assets')<>jsonb_array_length(plan.execution_scope->'bindings')
  OR (SELECT count(DISTINCT item->>'connectionId') FROM jsonb_array_elements(receipt->'assets') item)<>jsonb_array_length(receipt->'assets')
  OR NOT EXISTS(SELECT 1 FROM public.connection_operations operation WHERE operation.tenant_id=plan.tenant_id AND operation.id=plan.execution_operation_id
   AND operation.payload#>>'{metaAccountTransitionExecution,id}'=plan.id::text
   AND operation.payload#>>'{metaAccountTransitionExecution,action}'='RECONCILE'
   AND operation.payload#>>'{metaAccountTransitionExecution,scopeSha256}'=plan.execution_scope_sha256)
 THEN RETURN false; END IF;
 FOR pair IN SELECT value FROM jsonb_array_elements(receipt->'assets') LOOP
  SELECT * INTO predecessor FROM public.meta_connection_account_bindings
   WHERE tenant_id=plan.tenant_id AND id::text=pair->>'sourceBindingId';
  SELECT * INTO successor FROM public.meta_connection_account_bindings
   WHERE tenant_id=plan.tenant_id AND id::text=pair->>'targetBindingId';
  IF predecessor.id IS NULL OR successor.id IS NULL OR predecessor.state<>'RETIRED'
   OR predecessor.account_id IS DISTINCT FROM plan.source_account_id OR successor.account_id IS DISTINCT FROM plan.target_account_id
   OR successor.predecessor_binding_id IS DISTINCT FROM predecessor.id OR successor.account_transition_id IS DISTINCT FROM plan.id
   OR successor.connection_id IS DISTINCT FROM predecessor.connection_id OR pair->>'connectionId' IS DISTINCT FROM predecessor.connection_id::text
   OR successor.phone_number_id IS DISTINCT FROM predecessor.phone_number_id OR successor.app_id IS DISTINCT FROM predecessor.app_id
   OR pair->>'appId' IS DISTINCT FROM predecessor.app_id
   OR pair->'sourceAsset' IS DISTINCT FROM jsonb_build_object('providerSessionId',predecessor.provider_session_id::text,'phoneNumberId',predecessor.phone_number_id,'wabaId',source_account)
   OR pair->'targetAsset' IS DISTINCT FROM jsonb_build_object('providerSessionId',successor.provider_session_id::text,'phoneNumberId',successor.phone_number_id,'wabaId',target_account)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan.execution_scope->'bindings') original
    WHERE original->>'id'=predecessor.id::text AND original->>'revision'=pair->>'sourceRevision'
     AND original->>'connectionId'=predecessor.connection_id::text AND original->>'sessionId'=predecessor.provider_session_id::text
     AND original->>'phoneId'=predecessor.phone_number_id AND original->>'appId'=predecessor.app_id)
   OR COALESCE(pair->>'targetRevision','')!~'^[1-9][0-9]{0,15}$'
   OR successor.revision<(pair->>'targetRevision')::bigint
   OR pair-ARRAY['connectionId','sourceBindingId','sourceRevision','targetBindingId','targetRevision','appId','sourceAsset','targetAsset']<>'{}'
  THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
ALTER FUNCTION app.meta_account_identity_receipt_valid(uuid) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_account_identity_receipt_valid(uuid) FROM PUBLIC;

-- A bounded traversal of existing immutable bindings, never phone/display or
-- portfolio matching. Missing, branched or cyclic history supplies no authority.
CREATE FUNCTION app.meta_account_identity_asset_ancestor(connection_value uuid,source_asset jsonb,target_asset jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE cursor_asset jsonb:=target_asset; row_value public.meta_connection_account_bindings;
 predecessor public.meta_connection_account_bindings; receipt jsonb; step integer;seen uuid[]:=ARRAY[]::uuid[]; matches integer;
BEGIN
 IF jsonb_typeof(source_asset) IS DISTINCT FROM 'object' OR jsonb_typeof(target_asset) IS DISTINCT FROM 'object'
  OR source_asset-ARRAY['providerSessionId','phoneNumberId','wabaId']<>'{}'
  OR target_asset-ARRAY['providerSessionId','phoneNumberId','wabaId']<>'{}'
  OR jsonb_typeof(source_asset->'providerSessionId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(target_asset->'providerSessionId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(source_asset->'phoneNumberId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(target_asset->'phoneNumberId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(source_asset->'wabaId') NOT IN('string','null')
  OR jsonb_typeof(target_asset->'wabaId') NOT IN('string','null')
  OR COALESCE(source_asset->>'providerSessionId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR COALESCE(target_asset->>'providerSessionId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR COALESCE(source_asset->>'phoneNumberId','')!~'^[0-9]{1,32}$'
  OR COALESCE(target_asset->>'phoneNumberId','')!~'^[0-9]{1,32}$'
  OR NOT(source_asset ? 'wabaId') OR NOT(target_asset ? 'wabaId') THEN RETURN false; END IF;
 IF source_asset=target_asset THEN RETURN true; END IF;
 IF COALESCE(source_asset->>'wabaId','')!~'^[0-9]{1,32}$'
  OR COALESCE(target_asset->>'wabaId','')!~'^[0-9]{1,32}$' THEN RETURN false; END IF;
 FOR step IN 1..32 LOOP
  SELECT count(*) INTO matches FROM public.meta_connection_account_bindings b JOIN public.meta_messaging_accounts a
   ON a.tenant_id=b.tenant_id AND a.id=b.account_id WHERE b.tenant_id=app.current_tenant_id() AND b.connection_id=connection_value
    AND jsonb_build_object('providerSessionId',b.provider_session_id::text,'phoneNumberId',b.phone_number_id,'wabaId',a.provider_account_id)=cursor_asset;
  IF matches<>1 THEN RETURN false; END IF;
  SELECT b.* INTO row_value FROM public.meta_connection_account_bindings b JOIN public.meta_messaging_accounts a
   ON a.tenant_id=b.tenant_id AND a.id=b.account_id WHERE b.tenant_id=app.current_tenant_id() AND b.connection_id=connection_value
    AND jsonb_build_object('providerSessionId',b.provider_session_id::text,'phoneNumberId',b.phone_number_id,'wabaId',a.provider_account_id)=cursor_asset;
  IF row_value.id=ANY(seen) OR row_value.predecessor_binding_id IS NULL
   OR NOT app.meta_account_identity_receipt_valid(row_value.account_transition_id) THEN RETURN false; END IF;
  seen:=array_append(seen,row_value.id);
  SELECT * INTO predecessor FROM public.meta_connection_account_bindings WHERE tenant_id=row_value.tenant_id AND id=row_value.predecessor_binding_id;
  IF predecessor.id IS NULL OR predecessor.connection_id<>connection_value OR predecessor.state<>'RETIRED'
   OR predecessor.phone_number_id<>row_value.phone_number_id OR predecessor.app_id<>row_value.app_id THEN RETURN false; END IF;
  SELECT identity_successor_receipt INTO receipt FROM public.meta_account_transitions
   WHERE tenant_id=row_value.tenant_id AND id=row_value.account_transition_id;
  SELECT pair->'sourceAsset' INTO cursor_asset FROM jsonb_array_elements(receipt->'assets') pair
   WHERE pair->>'sourceBindingId'=predecessor.id::text AND pair->>'targetBindingId'=row_value.id::text AND pair->'targetAsset'=cursor_asset;
  IF cursor_asset IS NULL THEN RETURN false; END IF;
  IF cursor_asset=source_asset THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END $$;
ALTER FUNCTION app.meta_account_identity_asset_ancestor(uuid,jsonb,jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_account_identity_asset_ancestor(uuid,jsonb,jsonb) FROM PUBLIC;

-- Private scope data is consumed only as a digest in the original reservation.
-- It cannot certify customer ownership or confer a current native/send grant.
CREATE FUNCTION app.meta_account_identity_scope(connection_value uuid,session_value uuid,phone_value text,account_value text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 WITH asset AS(SELECT jsonb_build_object('providerSessionId',session_value::text,'phoneNumberId',phone_value,'wabaId',account_value) value),
 participants AS(SELECT p.* FROM public.participant_identities p WHERE p.tenant_id=app.current_tenant_id() AND p.connection_id=connection_value),
 aliases AS(SELECT a.* FROM public.meta_direct_identity_aliases a WHERE a.tenant_id=app.current_tenant_id() AND a.connection_id=connection_value)
 SELECT jsonb_build_object('schemaVersion',1,'asset',(SELECT value FROM asset),
  'aliases',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'participantId',a.participant_identity_id,'kind',a.kind,
   'valueSha256',encode(digest(a.value,'sha256'),'hex'),'state',a.state,'revision',a.revision,'sourceEventId',a.source_event_id,
   'sourcePayloadSha256',a.source_payload_sha256,'sessionId',a.provider_session_id,'phoneId',a.phone_number_id,'accountId',a.waba_id,
   'transitionId',a.account_transition_id,'predecessorId',a.predecessor_alias_id) ORDER BY a.id) FROM aliases a),'[]'),
  'participants',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'canonicalSha256',encode(digest(p.external_participant_id,'sha256'),'hex'),
   'phoneSha256',encode(digest(p.normalized_phone,'sha256'),'hex')) ORDER BY p.id) FROM participants p),'[]'),
  'native',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'canonicalSha256',encode(digest(c.external_chat_id,'sha256'),'hex'),
   'customerId',c.zammad_customer_id,'ticketId',c.zammad_ticket_id,'state',c.state,'fence',c.fencing_token) ORDER BY c.id)
   FROM public.bot_conversations c WHERE c.tenant_id=app.current_tenant_id() AND c.connection_id=connection_value),'[]'),
  'sources',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'hash',e.payload_sha256,'state',e.status,
   'asset',e.meta_direct_asset,'anchor',e.meta_direct_native_anchor,'retentionJobId',e.meta_direct_anchor_retention_job_id,
   'transition',e.meta_direct_identity_transition,'resolution',e.meta_direct_identity_resolution,
   'normalized',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'state',m.processing_status,
     'canonicalSha256',encode(digest(m.external_participant_id,'sha256'),'hex'),'chatSha256',encode(digest(m.external_group_id,'sha256'),'hex'),
     'customerId',m.provider_metadata->>'zammad_customer_id','direct',m.provider_metadata->'direct',
     'ticketId',l.zammad_ticket_id) ORDER BY m.id,l.zammad_ticket_id)
    FROM public.normalized_messages m LEFT JOIN public.message_links l ON l.tenant_id=m.tenant_id AND l.connection_id=m.connection_id AND l.external_message_id=m.external_message_id
    WHERE m.tenant_id=e.tenant_id AND m.event_inbox_id=e.id),'[]')) ORDER BY e.id)
   FROM public.event_inbox e WHERE e.tenant_id=app.current_tenant_id() AND e.connection_id=connection_value
    AND (EXISTS(SELECT 1 FROM aliases a WHERE a.source_event_id=e.id)
      OR e.meta_direct_native_anchor->>'participantId' IN(SELECT p.id::text FROM participants p))),'[]'),
  'markers',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'hash',e.payload_sha256,'asset',e.meta_direct_asset,
   'marker',e.meta_direct_identity_change,'transition',e.meta_direct_identity_transition,'resolution',e.meta_direct_identity_resolution) ORDER BY e.id)
   FROM public.event_inbox e WHERE e.tenant_id=app.current_tenant_id() AND e.connection_id=connection_value AND e.provider='META'
    AND e.meta_direct_identity_change IS NOT NULL AND NOT app.meta_direct_transition_receipt_valid(e.id)
    AND app.meta_account_identity_asset_ancestor(connection_value,e.meta_direct_asset,(SELECT value FROM asset))),'[]'))
$$;
REVOKE ALL ON FUNCTION app.meta_account_identity_scope(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_account_identity_scope(uuid,uuid,text,text),app.meta_account_identity_receipt_valid(uuid),
 app.meta_account_identity_asset_ancestor(uuid,jsonb,jsonb) TO wasalx_meta_transition_executor,wasalx_app,wasalx_connector_worker;

-- This predicate is also checked by the alias trigger. It is not a caller
-- capability: runtime roles cannot SET ROLE to the finite executor owner.
CREATE FUNCTION app.meta_account_identity_apply_pending(transition_value uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 -- Runtime callers lack tenant SELECT. Reject them procedurally before the
 -- protected statement is prepared, preserving invoker/RLS semantics.
 IF current_user<>pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc
  WHERE oid='app.apply_meta_account_identity_successor(uuid,uuid,uuid,bigint)'::regprocedure))
  OR NOT pg_has_role(session_user,'wasalx_connector_worker','MEMBER') THEN RETURN false; END IF;
 RETURN (SELECT EXISTS(SELECT 1 FROM public.meta_account_transitions p JOIN public.connection_operations o
  ON o.tenant_id=p.tenant_id AND o.id=p.execution_operation_id JOIN public.tenants t ON t.id=p.tenant_id
  JOIN public.tenant_memberships member ON member.tenant_id=p.tenant_id AND member.user_id::text=o.requested_by_id
  WHERE p.tenant_id=app.current_tenant_id() AND p.id=transition_value AND p.identity_successor_receipt IS NULL
   AND p.provider_status='COMPLETED' AND p.state<>'CANCELLED' AND p.execution_state='PROVIDER_COMPLETED'
   AND o.state='RUNNING' AND o.lease_id IS NOT NULL AND o.lease_expires_at>clock_timestamp()
   AND o.payload#>>'{metaAccountTransitionExecution,id}'=p.id::text
   AND o.payload#>>'{metaAccountTransitionExecution,action}'='RECONCILE'
   AND o.payload#>>'{metaAccountTransitionExecution,revision}'=p.revision::text
   AND o.payload#>>'{metaAccountTransitionExecution,scopeSha256}'=p.execution_scope_sha256
   AND o.payload#>'{metaAccountTransitionExecution,observerOperationIds}'=p.observer_operations
   AND t.state='ACTIVE' AND member.state='ACTIVE' AND member.role IN('tenant_owner','tenant_admin')
   AND 2=(SELECT count(*) FROM public.meta_account_transition_reservations r WHERE r.tenant_id=p.tenant_id
    AND r.transition_id=p.id AND r.released_at IS NULL AND r.scope_sha256=p.execution_scope_sha256
    AND ((r.account_role='SOURCE' AND r.account_id=p.source_account_id) OR(r.account_role='TARGET' AND r.account_id=p.target_account_id)))));
END;
$$;
REVOKE ALL ON FUNCTION app.meta_account_identity_apply_pending(uuid) FROM PUBLIC;

CREATE FUNCTION app.apply_meta_account_identity_successor(transition_value uuid,operation_value uuid,lease_value uuid,fence_value bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE plan public.meta_account_transitions; operation_row public.connection_operations;
 initiate public.meta_provider_effect_checkpoints; complete public.meta_provider_effect_checkpoints;
 predecessor public.meta_connection_account_bindings; successor public.meta_connection_account_bindings;
 session_row public.provider_sessions; connection_row public.connections; alias_row public.meta_direct_identity_aliases;
 source_account text;target_account text;observation jsonb;original jsonb;verified jsonb;proof jsonb;receipt jsonb;pairs jsonb:='[]';
 source_asset jsonb;target_asset jsonb;subject record;customer text;customers integer;scope_value jsonb;values_value text[];local_scope jsonb;local_digest text;
 observer jsonb;observer_operation uuid;expected_reference text;expected_fingerprint text;credential_metadata jsonb;
BEGIN
 -- A repeated sealed call is historical and cannot append aliases to a later
 -- account/session. It does not acquire a new lease or restore authority.
 IF NOT pg_has_role(session_user,'wasalx_connector_worker','MEMBER') THEN
  RAISE EXCEPTION 'Account identity succession is worker-only' USING ERRCODE='42501'; END IF;
 SELECT * INTO plan FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=transition_value;
 IF plan.identity_successor_receipt IS NOT NULL THEN
  IF app.meta_account_identity_receipt_valid(plan.id) AND plan.identity_successor_receipt->>'operationId'=operation_value::text THEN
   RETURN plan.identity_successor_receipt;
  END IF;
  RAISE EXCEPTION 'Account identity successor is already sealed' USING ERRCODE='55000';
 END IF;
 IF NOT app.lock_current_active_tenant_for_event_admission()
  OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||app.current_tenant_id()::text,0)) THEN
  RAISE EXCEPTION 'Account identity privacy or tenant is unavailable' USING ERRCODE='55000'; END IF;
 IF plan.id IS NULL THEN RAISE EXCEPTION 'Account identity transition is unavailable' USING ERRCODE='55000'; END IF;
 PERFORM app.lock_meta_transition_accounts(ARRAY[plan.source_account_id,plan.target_account_id]);
 SELECT * INTO plan FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=transition_value FOR UPDATE NOWAIT;
 SELECT * INTO operation_row FROM public.connection_operations WHERE tenant_id=plan.tenant_id AND id=operation_value FOR UPDATE NOWAIT;
 IF operation_row.id IS NULL OR operation_row.id IS DISTINCT FROM plan.execution_operation_id
  OR operation_row.lease_id IS DISTINCT FROM lease_value OR operation_row.fencing_token IS DISTINCT FROM fence_value
  OR operation_row.payload#>'{metaAccountTransitionExecution,observerOperationIds}' IS DISTINCT FROM plan.observer_operations
  OR NOT app.meta_account_identity_apply_pending(plan.id) THEN
  RAISE EXCEPTION 'Account identity lease or original reservation changed' USING ERRCODE='55000'; END IF;
 PERFORM app.meta_transition_actor_current(operation_row.requested_by_id::uuid);
 local_scope:=operation_row.payload#>'{metaAccountTransitionExecution,localIdentityScope}';
 IF jsonb_typeof(local_scope) IS DISTINCT FROM 'array' OR jsonb_array_length(local_scope)<>jsonb_array_length(plan.execution_scope->'bindings')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(local_scope) item WHERE item-ARRAY['bindingId','identitySha256']<>'{}'
   OR COALESCE(item->>'identitySha256','')!~'^[0-9a-f]{64}$'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan.execution_scope->'bindings') original_binding WHERE original_binding->>'id'=item->>'bindingId'))
  OR (SELECT count(DISTINCT item->>'bindingId') FROM jsonb_array_elements(local_scope) item)<>jsonb_array_length(local_scope) THEN
  RAISE EXCEPTION 'Explicit local identity reconciliation scope is unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO initiate FROM public.meta_provider_effect_checkpoints WHERE tenant_id=plan.tenant_id
  AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=plan.id AND stage='INITIATE' FOR SHARE NOWAIT;
 SELECT * INTO complete FROM public.meta_provider_effect_checkpoints WHERE tenant_id=plan.tenant_id
  AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=plan.id AND stage='COMPLETE' FOR SHARE NOWAIT;
 SELECT result->'metaTransitionObservation' INTO observation FROM public.connection_operations
  WHERE tenant_id=plan.tenant_id AND id=plan.provider_observation_operation_id FOR SHARE NOWAIT;
 SELECT provider_account_id INTO source_account FROM public.meta_messaging_accounts WHERE tenant_id=plan.tenant_id AND id=plan.source_account_id;
 SELECT provider_account_id INTO target_account FROM public.meta_messaging_accounts WHERE tenant_id=plan.tenant_id AND id=plan.target_account_id;
 IF plan.provider_migration_id IS NULL OR source_account IS NULL OR target_account IS NULL
  OR initiate.id IS NULL OR complete.id IS NULL OR initiate.outcome='REJECTED' OR complete.outcome='REJECTED'
  OR initiate.account_id IS DISTINCT FROM plan.source_account_id OR complete.account_id IS DISTINCT FROM plan.source_account_id
  OR initiate.result->>'migrationId' IS DISTINCT FROM plan.provider_migration_id
  OR observation->>'migrationId' IS DISTINCT FROM plan.provider_migration_id OR observation->>'status' IS DISTINCT FROM 'COMPLETED'
  OR observation#>>'{destination,id}' IS DISTINCT FROM target_account OR source_account IS NOT DISTINCT FROM target_account
  OR observation#>>'{destination,currency}' IS DISTINCT FROM plan.target_currency
  OR observation#>>'{targetReadiness,assets}' IS DISTINCT FROM 'VERIFIED'
  OR observation#>>'{targetReadiness,continuity}' IS DISTINCT FROM 'SAME_GRAPH_PHONE_IDS'
  OR jsonb_typeof(observation->'targetAssets') IS DISTINCT FROM 'array'
  OR jsonb_array_length(plan.execution_scope->'bindings') NOT BETWEEN 1 AND 2000
  OR jsonb_array_length(observation->'targetAssets')<>jsonb_array_length(plan.execution_scope->'bindings')
  OR encode(digest(plan.execution_scope::text,'sha256'),'hex') IS DISTINCT FROM plan.execution_scope_sha256 THEN
  RAISE EXCEPTION 'Original provider completion and scope are unavailable' USING ERRCODE='23514'; END IF;
 FOR original IN SELECT value FROM jsonb_array_elements(plan.execution_scope->'bindings') ORDER BY value->>'connectionId',value->>'id' LOOP
  SELECT * INTO predecessor FROM public.meta_connection_account_bindings WHERE tenant_id=plan.tenant_id AND id::text=original->>'id' FOR UPDATE NOWAIT;
  SELECT * INTO successor FROM public.meta_connection_account_bindings WHERE tenant_id=plan.tenant_id
   AND predecessor_binding_id=predecessor.id AND account_transition_id=plan.id FOR UPDATE NOWAIT;
  SELECT * INTO connection_row FROM public.connections WHERE tenant_id=plan.tenant_id AND id=predecessor.connection_id FOR UPDATE NOWAIT;
  SELECT * INTO session_row FROM public.provider_sessions WHERE tenant_id=plan.tenant_id AND id=successor.provider_session_id FOR UPDATE NOWAIT;
  IF predecessor.id IS NULL OR successor.id IS NULL OR predecessor.state<>'RETIRED' OR successor.state<>'HELD'
   OR predecessor.account_id IS DISTINCT FROM plan.source_account_id OR successor.account_id IS DISTINCT FROM plan.target_account_id
   OR successor.connection_id IS DISTINCT FROM predecessor.connection_id OR original->>'connectionId' IS DISTINCT FROM predecessor.connection_id::text
   OR predecessor.provider_session_id::text IS DISTINCT FROM original->>'sessionId'
   OR predecessor.secret_reference IS DISTINCT FROM original->>'secretReference'
   OR predecessor.credential_fingerprint IS DISTINCT FROM original->>'fingerprint'
   OR predecessor.phone_number_id IS DISTINCT FROM original->>'phoneId' OR successor.phone_number_id IS DISTINCT FROM predecessor.phone_number_id
   OR predecessor.app_id IS DISTINCT FROM original->>'appId' OR successor.app_id IS DISTINCT FROM predecessor.app_id
   OR predecessor.revision IS DISTINCT FROM (original->>'revision')::bigint+1
   OR connection_row.state<>'PAUSED' OR session_row.state<>'PAUSED' OR session_row.ownership_state<>'ACTIVE'
   OR session_row.connection_id IS DISTINCT FROM predecessor.connection_id OR session_row.opaque_session_id IS DISTINCT FROM predecessor.phone_number_id
   OR session_row.provider_state_data->>'wabaId' IS DISTINCT FROM target_account
   OR successor.secret_reference IS DISTINCT FROM connection_row.secret_reference
   OR NOT EXISTS(SELECT 1 FROM public.provider_sessions old WHERE old.tenant_id=plan.tenant_id
    AND old.connection_id=predecessor.connection_id AND old.id=predecessor.provider_session_id AND old.ownership_state='RETIRED'
    AND old.opaque_session_id=predecessor.phone_number_id AND old.provider_state_data->>'wabaId'=source_account)
  THEN RAISE EXCEPTION 'Account identity predecessor or exact target changed' USING ERRCODE='55000'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(observation->'targetAssets') item WHERE item->>'sourceBindingId'=predecessor.id::text)<>1 THEN
   RAISE EXCEPTION 'Account identity target proof is ambiguous' USING ERRCODE='23514'; END IF;
  SELECT value INTO verified FROM jsonb_array_elements(observation->'targetAssets') WHERE value->>'sourceBindingId'=predecessor.id::text;
  IF NOT(verified ? 'observerOperationId') OR jsonb_typeof(verified->'observerOperationId') NOT IN('string','null')
   OR (verified->'observerOperationId'<>'null'::jsonb AND COALESCE(verified->>'observerOperationId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') THEN
   RAISE EXCEPTION 'Account identity observer selection is unavailable' USING ERRCODE='23514'; END IF;
  observer_operation:=(verified->>'observerOperationId')::uuid;
  -- Resolve the exact observer recorded by the immutable target read. A
  -- selected-but-invalid observer raises; it never falls back to the old token.
  observer:=app.meta_transition_observer_credential(plan.id,predecessor.id,observer_operation);
  IF observer IS NULL THEN
   expected_reference:=original->>'secretReference';expected_fingerprint:=original->>'fingerprint';
   credential_metadata:=original#>'{providerState,metaAccountProof,credentialMetadata}';
  ELSE
   IF observer->>'operationId' IS DISTINCT FROM observer_operation::text
    OR observer->>'sourceBindingId' IS DISTINCT FROM predecessor.id::text
    OR observer->>'scopeSha256' IS DISTINCT FROM plan.execution_scope_sha256
    OR observer->>'phoneNumberId' IS DISTINCT FROM predecessor.phone_number_id
    OR observer->>'appId' IS DISTINCT FROM predecessor.app_id THEN
    RAISE EXCEPTION 'Account identity observer scope changed' USING ERRCODE='23514'; END IF;
   expected_reference:=observer->>'secretReference';expected_fingerprint:=observer->>'credentialFingerprint';
   credential_metadata:=observer#>'{accountProof,credentialMetadata}';
  END IF;
  proof:=session_row.provider_state_data->'metaAccountProof';
  IF verified->>'sourceBindingRevision' IS DISTINCT FROM original->>'revision'
   OR verified->>'connectionId' IS DISTINCT FROM predecessor.connection_id::text OR verified->>'providerSessionId' IS DISTINCT FROM predecessor.provider_session_id::text
   OR verified->>'phoneNumberId' IS DISTINCT FROM predecessor.phone_number_id OR verified->>'appId' IS DISTINCT FROM predecessor.app_id
   OR verified->>'secretReference' IS DISTINCT FROM connection_row.secret_reference
   OR verified->>'credentialFingerprint' IS DISTINCT FROM successor.credential_fingerprint
   OR successor.secret_reference IS DISTINCT FROM expected_reference
   OR successor.credential_fingerprint IS DISTINCT FROM expected_fingerprint
   OR proof->'credentialMetadata' IS DISTINCT FROM credential_metadata
   OR proof IS DISTINCT FROM (verified->'accountProof')||jsonb_build_object('providerSessionId',session_row.id::text)
   OR proof->>'claim' IS DISTINCT FROM 'PHONE_ACCOUNT_RELATION_VERIFIED' OR proof->'schemaVersion' IS DISTINCT FROM '1'
   OR proof->>'tenantId' IS DISTINCT FROM plan.tenant_id::text OR proof->>'connectionId' IS DISTINCT FROM predecessor.connection_id::text
   OR proof->>'secretReference' IS DISTINCT FROM connection_row.secret_reference OR proof->>'phoneNumberId' IS DISTINCT FROM predecessor.phone_number_id
   OR proof->>'wabaId' IS DISTINCT FROM target_account OR proof#>>'{credentialMetadata,claim}' IS DISTINCT FROM 'CREDENTIAL_METADATA_VERIFIED'
   OR proof#>>'{credentialMetadata,appId}' IS DISTINCT FROM predecessor.app_id
   OR proof->>'verifiedAt' IS NULL
   OR (proof->>'verifiedAt')::timestamptz<=clock_timestamp()-interval '5 minutes' OR (proof->>'verifiedAt')::timestamptz>clock_timestamp()
   OR NOT (CASE WHEN proof#>>'{credentialMetadata,expiresAt}'~'^[0-9]{1,16}$' THEN
      (proof#>>'{credentialMetadata,expiresAt}')::numeric=0 OR (proof#>>'{credentialMetadata,expiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END)
   OR NOT (CASE WHEN NOT(proof->'credentialMetadata' ? 'dataAccessExpiresAt') THEN true
    WHEN proof#>>'{credentialMetadata,dataAccessExpiresAt}'~'^[0-9]{1,16}$' THEN
      (proof#>>'{credentialMetadata,dataAccessExpiresAt}')::numeric=0 OR (proof#>>'{credentialMetadata,dataAccessExpiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END)
  THEN RAISE EXCEPTION 'Account identity target credential proof changed' USING ERRCODE='23514'; END IF;
  source_asset:=jsonb_build_object('providerSessionId',predecessor.provider_session_id::text,'phoneNumberId',predecessor.phone_number_id,'wabaId',source_account);
  target_asset:=jsonb_build_object('providerSessionId',successor.provider_session_id::text,'phoneNumberId',successor.phone_number_id,'wabaId',target_account);
  IF NOT EXISTS(SELECT 1 FROM app.meta_lifecycle_guard(predecessor.connection_id,successor.provider_session_id,successor.phone_number_id,target_account,successor.app_id,
    CASE WHEN NOT(session_row.provider_state_data ? 'metaLifecycle') THEN 0 ELSE (session_row.provider_state_data#>>'{metaLifecycle,revision}')::bigint END) life
    WHERE life.revision_matches AND NOT life.blocked AND NOT life.unresolved_hold) THEN
   RAISE EXCEPTION 'Account identity target lifecycle is held' USING ERRCODE='55000'; END IF;
  PERFORM id FROM public.participant_identities WHERE tenant_id=plan.tenant_id AND connection_id=predecessor.connection_id ORDER BY id FOR UPDATE NOWAIT;
  PERFORM id FROM public.meta_direct_identity_aliases WHERE tenant_id=plan.tenant_id AND connection_id=predecessor.connection_id ORDER BY id FOR UPDATE NOWAIT;
  PERFORM id FROM public.bot_conversations WHERE tenant_id=plan.tenant_id AND connection_id=predecessor.connection_id ORDER BY id FOR UPDATE NOWAIT;
  scope_value:=app.meta_account_identity_scope(predecessor.connection_id,predecessor.provider_session_id,predecessor.phone_number_id,source_account);
  SELECT item->>'identitySha256' INTO local_digest FROM jsonb_array_elements(local_scope) item WHERE item->>'bindingId'=predecessor.id::text;
  IF encode(digest(scope_value::text,'sha256'),'hex') IS DISTINCT FROM local_digest THEN
   RAISE EXCEPTION 'Explicit local identity reconciliation scope changed' USING ERRCODE='55000'; END IF;
  FOR subject IN SELECT * FROM public.participant_identities WHERE tenant_id=plan.tenant_id AND connection_id=predecessor.connection_id ORDER BY id LOOP
   SELECT array_agg(value) INTO values_value FROM public.meta_direct_identity_aliases WHERE tenant_id=plan.tenant_id AND participant_identity_id=subject.id;
   values_value:=array_append(COALESCE(values_value,ARRAY[]::text[]),subject.external_participant_id);
   IF NOT app.meta_direct_transition_effects_clear(predecessor.connection_id,subject.id)
    OR NOT app.meta_direct_transition_privacy_clear(predecessor.connection_id,subject.id,values_value,NULL)
    OR EXISTS(SELECT 1 FROM unnest(values_value) value WHERE app.has_applicable_privacy_hold('PARTICIPANT',value)) THEN
    RAISE EXCEPTION 'Account identity subject has unresolved effects or privacy' USING ERRCODE='55000'; END IF;
   SELECT count(DISTINCT zammad_customer_id),min(zammad_customer_id)::text INTO customers,customer
    FROM public.bot_conversations WHERE tenant_id=plan.tenant_id AND connection_id=predecessor.connection_id AND external_chat_id=subject.external_participant_id;
   IF customers>1 THEN RAISE EXCEPTION 'Account identity native customer is ambiguous' USING ERRCODE='23514'; END IF;
   IF customer IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.event_inbox anchor WHERE anchor.tenant_id=plan.tenant_id
    AND anchor.connection_id=predecessor.connection_id AND anchor.meta_direct_identity_change IS NULL
    AND app.meta_account_identity_asset_ancestor(predecessor.connection_id,anchor.meta_direct_asset,source_asset)
    AND app.meta_direct_transition_anchor_valid(anchor.id,subject.id,customer,true)) THEN
    RAISE EXCEPTION 'Account identity ordinary native anchor is unavailable' USING ERRCODE='23514'; END IF;
   FOR alias_row IN SELECT * FROM public.meta_direct_identity_aliases WHERE tenant_id=plan.tenant_id AND connection_id=predecessor.connection_id
    AND participant_identity_id=subject.id AND state<>'RETIRED' ORDER BY kind,id LOOP
    IF alias_row.state NOT IN('ACTIVE','HELD') OR alias_row.provider_session_id<>predecessor.provider_session_id
     OR alias_row.phone_number_id<>predecessor.phone_number_id OR alias_row.waba_id<>source_account OR customer IS NULL
     OR NOT app.meta_account_alias_retained_source_valid(alias_row.id,subject.external_participant_id,customer)
     OR EXISTS(SELECT 1 FROM public.meta_direct_identity_aliases collision WHERE collision.tenant_id=plan.tenant_id
      AND collision.connection_id=predecessor.connection_id AND collision.provider_session_id=successor.provider_session_id
      AND collision.phone_number_id=successor.phone_number_id AND collision.waba_id=target_account
      AND ((collision.participant_identity_id=subject.id AND collision.kind=alias_row.kind) OR(collision.kind=alias_row.kind AND collision.value=alias_row.value))) THEN
     RAISE EXCEPTION 'Account identity source or target alias is unavailable' USING ERRCODE='23514'; END IF;
    INSERT INTO public.meta_direct_identity_aliases(tenant_id,connection_id,participant_identity_id,provider_session_id,phone_number_id,waba_id,
     kind,value,state,source_event_id,source_payload_sha256,account_transition_id,predecessor_alias_id)
    VALUES(plan.tenant_id,predecessor.connection_id,subject.id,successor.provider_session_id,successor.phone_number_id,target_account,
     alias_row.kind,alias_row.value,alias_row.state,alias_row.source_event_id,alias_row.source_payload_sha256,plan.id,alias_row.id);
   END LOOP;
  END LOOP;
  UPDATE public.meta_direct_identity_aliases SET state='RETIRED',revision=revision+1 WHERE tenant_id=plan.tenant_id
   AND connection_id=predecessor.connection_id AND provider_session_id=predecessor.provider_session_id
   AND phone_number_id=predecessor.phone_number_id AND waba_id=source_account AND state IN('ACTIVE','HELD');
  pairs:=pairs||jsonb_build_array(jsonb_build_object('connectionId',predecessor.connection_id::text,'sourceBindingId',predecessor.id::text,
   'sourceRevision',(original->>'revision')::bigint,'targetBindingId',successor.id::text,'targetRevision',successor.revision,
   'appId',successor.app_id,'sourceAsset',source_asset,'targetAsset',target_asset));
 END LOOP;
 receipt:=jsonb_build_object('schemaVersion',1,'claim','SAME_GRAPH_PHONE_ACCOUNT_SUCCESSOR','transitionId',plan.id::text,'operationId',operation_row.id::text,
  'sourceAccountId',plan.source_account_id::text,'targetAccountId',plan.target_account_id::text,'migrationId',plan.provider_migration_id,
  'initiateCheckpointId',initiate.id::text,'completeCheckpointId',complete.id::text,'completionObservationOperationId',plan.provider_observation_operation_id::text,
  'sourceScopeSha256',plan.execution_scope_sha256,'targetProofSha256',encode(digest((observation->'targetAssets')::text,'sha256'),'hex'),
  'assets',pairs,'appliedAt',clock_timestamp());
 IF octet_length(receipt::text)>4194304 THEN RAISE EXCEPTION 'Account identity receipt exceeds scope bound' USING ERRCODE='54000'; END IF;
 RETURN receipt;
END $$;
ALTER FUNCTION app.apply_meta_account_identity_successor(uuid,uuid,uuid,bigint) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.apply_meta_account_identity_successor(uuid,uuid,uuid,bigint) FROM PUBLIC,wasalx_app,wasalx_connector_worker;

CREATE FUNCTION app.meta_account_alias_lineage_valid(alias_value uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE current_alias public.meta_direct_identity_aliases;prior public.meta_direct_identity_aliases;receipt jsonb;
 seen uuid[]:=ARRAY[]::uuid[];step integer;
BEGIN
 SELECT * INTO current_alias FROM public.meta_direct_identity_aliases WHERE tenant_id=app.current_tenant_id() AND id=alias_value;
 IF current_alias.id IS NULL OR current_alias.account_transition_id IS NULL THEN RETURN false; END IF;
 FOR step IN 1..32 LOOP
  IF current_alias.id=ANY(seen) THEN RETURN false; END IF;
  seen:=array_append(seen,current_alias.id);
  IF current_alias.account_transition_id IS NULL THEN RETURN current_alias.predecessor_alias_id IS NULL; END IF;
  IF NOT app.meta_account_identity_receipt_valid(current_alias.account_transition_id) THEN RETURN false; END IF;
  SELECT * INTO prior FROM public.meta_direct_identity_aliases WHERE tenant_id=current_alias.tenant_id AND id=current_alias.predecessor_alias_id;
  IF prior.id IS NULL OR prior.state<>'RETIRED' OR prior.connection_id<>current_alias.connection_id
   OR prior.participant_identity_id<>current_alias.participant_identity_id OR prior.kind<>current_alias.kind OR prior.value<>current_alias.value
   OR prior.source_event_id<>current_alias.source_event_id OR prior.source_payload_sha256<>current_alias.source_payload_sha256 THEN RETURN false; END IF;
  SELECT identity_successor_receipt INTO receipt FROM public.meta_account_transitions
   WHERE tenant_id=current_alias.tenant_id AND id=current_alias.account_transition_id;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(receipt->'assets') pair WHERE pair->>'connectionId'=current_alias.connection_id::text
    AND pair->'sourceAsset'=jsonb_build_object('providerSessionId',prior.provider_session_id::text,'phoneNumberId',prior.phone_number_id,'wabaId',prior.waba_id)
    AND pair->'targetAsset'=jsonb_build_object('providerSessionId',current_alias.provider_session_id::text,'phoneNumberId',current_alias.phone_number_id,'wabaId',current_alias.waba_id)) THEN RETURN false; END IF;
  current_alias:=prior;
  IF current_alias.account_transition_id IS NULL THEN RETURN current_alias.predecessor_alias_id IS NULL; END IF;
 END LOOP;
 RETURN false;
END $$;
ALTER FUNCTION app.meta_account_alias_lineage_valid(uuid) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_account_alias_lineage_valid(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_account_alias_lineage_valid(uuid) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;

-- Extend the incumbent row trigger; its ordinary/P03b and LOCAL privacy
-- branches are preserved byte-for-byte by this exact prefix amendment.
DO $$ DECLARE original text;replacement text;prefix text; BEGIN
 original:=pg_get_functiondef('app.guard_meta_direct_alias()'::regprocedure);
 prefix:=$prefix$BEGIN
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM public.meta_direct_identity_aliases successor
  WHERE successor.tenant_id=OLD.tenant_id AND successor.predecessor_alias_id=OLD.id
   AND NOT app.meta_direct_privacy_target_authorized('META_DIRECT_ALIAS',successor.id::text)) THEN
  RAISE EXCEPTION 'Meta alias lineage still has an untargeted descendant' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' AND (NEW.account_transition_id IS NOT NULL OR NEW.predecessor_alias_id IS NOT NULL) THEN
  IF NEW.account_transition_id IS NULL OR NEW.predecessor_alias_id IS NULL OR NEW.revision<>1 OR NEW.state NOT IN('ACTIVE','HELD')
   OR NOT app.meta_account_identity_apply_pending(NEW.account_transition_id)
   OR NOT EXISTS(SELECT 1 FROM public.meta_direct_identity_aliases predecessor
     JOIN public.meta_connection_account_bindings source_binding ON source_binding.tenant_id=predecessor.tenant_id
      AND source_binding.connection_id=predecessor.connection_id AND source_binding.provider_session_id=predecessor.provider_session_id
     JOIN public.meta_connection_account_bindings target_binding ON target_binding.tenant_id=source_binding.tenant_id
      AND target_binding.predecessor_binding_id=source_binding.id AND target_binding.account_transition_id=NEW.account_transition_id
     JOIN public.meta_messaging_accounts source_account ON source_account.tenant_id=source_binding.tenant_id AND source_account.id=source_binding.account_id
     JOIN public.meta_messaging_accounts target_account ON target_account.tenant_id=target_binding.tenant_id AND target_account.id=target_binding.account_id
     JOIN public.participant_identities participant ON participant.tenant_id=predecessor.tenant_id AND participant.id=predecessor.participant_identity_id
     WHERE predecessor.tenant_id=NEW.tenant_id AND predecessor.id=NEW.predecessor_alias_id AND predecessor.state=NEW.state
      AND predecessor.connection_id=NEW.connection_id AND predecessor.participant_identity_id=NEW.participant_identity_id
      AND predecessor.kind=NEW.kind AND predecessor.value=NEW.value AND predecessor.source_event_id=NEW.source_event_id
      AND predecessor.source_payload_sha256=NEW.source_payload_sha256
      AND source_binding.state='RETIRED' AND source_binding.phone_number_id=predecessor.phone_number_id AND source_account.provider_account_id=predecessor.waba_id
      AND target_binding.state='HELD' AND target_binding.connection_id=NEW.connection_id AND target_binding.provider_session_id=NEW.provider_session_id
      AND target_binding.phone_number_id=NEW.phone_number_id AND target_binding.phone_number_id=predecessor.phone_number_id
      AND target_binding.app_id=source_binding.app_id AND target_account.provider_account_id=NEW.waba_id
      AND EXISTS(SELECT 1 FROM public.bot_conversations conversation WHERE conversation.tenant_id=NEW.tenant_id
       AND conversation.connection_id=NEW.connection_id AND conversation.external_chat_id=participant.external_participant_id
       AND app.meta_account_alias_retained_source_valid(predecessor.id,participant.external_participant_id,conversation.zammad_customer_id::text))) THEN
   RAISE EXCEPTION 'Meta account alias requires exact sealed predecessor admission' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND OLD.state IN('ACTIVE','HELD') AND NEW.state='RETIRED' AND NEW.revision=OLD.revision+1
  AND (to_jsonb(OLD)-ARRAY['state','revision'])=(to_jsonb(NEW)-ARRAY['state','revision'])
  AND EXISTS(SELECT 1 FROM public.meta_direct_identity_aliases successor WHERE successor.tenant_id=OLD.tenant_id
   AND successor.connection_id=OLD.connection_id AND successor.participant_identity_id=OLD.participant_identity_id
   AND successor.predecessor_alias_id=OLD.id AND successor.kind=OLD.kind AND successor.value=OLD.value
   AND successor.source_event_id=OLD.source_event_id AND successor.source_payload_sha256=OLD.source_payload_sha256
   AND successor.state=OLD.state AND app.meta_account_identity_apply_pending(successor.account_transition_id)) THEN RETURN NEW; END IF;
$prefix$;
 IF strpos(original,E'BEGIN\n')=0 OR strpos(original,'NEW.account_transition_id')>0 THEN
  RAISE EXCEPTION 'Meta alias guard prerequisite differs from reviewed P03b'; END IF;
 replacement:=overlay(original PLACING prefix FROM strpos(original,E'BEGIN\n') FOR length(E'BEGIN\n'));
 EXECUTE replacement;
END $$;
GRANT SELECT ON public.event_inbox,public.meta_direct_identity_aliases,public.participant_identities,
 public.bot_conversations,public.normalized_messages,public.message_links,public.privacy_jobs,public.privacy_job_targets,
 public.meta_account_transition_reservations,public.privacy_legal_holds TO wasalx_meta_transition_executor;
GRANT INSERT,UPDATE ON public.meta_direct_identity_aliases TO wasalx_meta_transition_executor;
GRANT EXECUTE ON FUNCTION app.meta_account_identity_apply_pending(uuid) TO wasalx_app,wasalx_connector_worker;
GRANT EXECUTE ON FUNCTION app.meta_account_identity_apply_pending(uuid),app.meta_direct_alias_source_valid(uuid,text,text),
 app.meta_direct_transition_receipt_valid(uuid),app.meta_direct_transition_anchor_valid(uuid,uuid,text,boolean),
 app.meta_direct_transition_privacy_clear(uuid,uuid,text[],uuid),app.meta_direct_identity_guard(uuid,uuid,text,text,uuid),
 app.meta_direct_transition_effects_clear(uuid,uuid),app.meta_direct_native_anchor_valid(uuid,uuid,text,boolean),
 app.meta_direct_anchor_needed(uuid,uuid),app.meta_direct_privacy_target_authorized(text,text),
 app.lock_current_active_tenant_for_event_admission(),
 app.has_applicable_privacy_hold(text,text),app.meta_lifecycle_guard(uuid,uuid,text,text,text,bigint)
 TO wasalx_meta_transition_executor;
GRANT SELECT(id,tenant_id,connection_id,bot_conversation_id,direct_origin,external_chat_id,zammad_ticket_id,state,attempts,lease_id,manual_retry_allowed)
 ON public.delivery_outbox TO wasalx_meta_transition_executor;
GRANT SELECT(tenant_id,delivery_id) ON public.delivery_attempts TO wasalx_meta_transition_executor;
GRANT SELECT(tenant_id,conversation_id,lease_id,state) ON public.bot_action_jobs,public.bot_handoff_jobs TO wasalx_meta_transition_executor;
GRANT SELECT(tenant_id,conversation_id,state) ON public.direct_native_reply_intents TO wasalx_meta_transition_executor;
GRANT SELECT(tenant_id,conversation_id,state,conversation_fencing_token) ON public.direct_customer_close_commands TO wasalx_meta_transition_executor;
GRANT SELECT(tenant_id,conversation_id,completed_at,lease_id) ON public.zammad_conversation_state_outbox TO wasalx_meta_transition_executor;

GRANT EXECUTE ON FUNCTION app.meta_account_identity_receipt_valid(uuid),app.meta_account_identity_asset_ancestor(uuid,jsonb,jsonb),
 app.meta_account_alias_lineage_valid(uuid) TO wasalx_scheduler_reader;

-- A current target is a relation lookup, never a grant to process or send.
-- Callers still check the current app, proof, lifecycle, privacy and live lease.
CREATE FUNCTION app.meta_account_identity_target_asset(connection_value uuid,source_asset jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE target jsonb;
BEGIN
 SELECT jsonb_build_object('providerSessionId',s.id::text,'phoneNumberId',s.opaque_session_id,'wabaId',s.provider_state_data->>'wabaId')
 INTO target FROM public.provider_sessions s JOIN public.connections c ON c.tenant_id=s.tenant_id AND c.id=s.connection_id
 WHERE s.tenant_id=app.current_tenant_id() AND s.connection_id=connection_value AND s.ownership_state='ACTIVE' AND c.provider='META';
 IF target IS NULL OR NOT app.meta_account_identity_asset_ancestor(connection_value,source_asset,target) THEN RETURN NULL; END IF;
 RETURN target;
END $$;
ALTER FUNCTION app.meta_account_identity_target_asset(uuid,jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_account_identity_target_asset(uuid,jsonb) FROM PUBLIC;

-- Historical transition receipts pin their actual target; a later account
-- successor must never silently rewrite an earlier edge's alias namespace.
CREATE FUNCTION app.meta_account_identity_bridge(connection_value uuid,source_asset jsonb,target_asset jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE transition_value uuid;
BEGIN
 IF source_asset=target_asset THEN RETURN '{}'::jsonb; END IF;
 IF NOT app.meta_account_identity_asset_ancestor(connection_value,source_asset,target_asset) THEN RETURN NULL; END IF;
 SELECT b.account_transition_id INTO transition_value FROM public.meta_connection_account_bindings b
 JOIN public.meta_messaging_accounts a ON a.tenant_id=b.tenant_id AND a.id=b.account_id
 WHERE b.tenant_id=app.current_tenant_id() AND b.connection_id=connection_value
  AND jsonb_build_object('providerSessionId',b.provider_session_id::text,'phoneNumberId',b.phone_number_id,'wabaId',a.provider_account_id)=target_asset;
 IF transition_value IS NULL OR NOT app.meta_account_identity_receipt_valid(transition_value) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('accountTransitionId',transition_value::text,'targetAsset',target_asset);
END $$;
ALTER FUNCTION app.meta_account_identity_bridge(uuid,jsonb,jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_account_identity_bridge(uuid,jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION app.meta_direct_transition_asset(event_value uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE source public.event_inbox;target jsonb;bridge jsonb;
BEGIN
 SELECT * INTO source FROM public.event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value;
 IF source.id IS NULL OR source.provider<>'META' OR source.meta_direct_identity_change IS NULL THEN RETURN NULL; END IF;
 IF source.meta_direct_identity_resolution IS NULL THEN
  RETURN app.meta_account_identity_target_asset(source.connection_id,source.meta_direct_asset);
 END IF;
 IF source.meta_direct_identity_resolution->'redacted'='true' THEN RETURN NULL; END IF;
 IF source.meta_direct_identity_resolution ?| ARRAY['accountTransitionId','targetAsset'] THEN
  target:=source.meta_direct_identity_resolution->'targetAsset';
  bridge:=app.meta_account_identity_bridge(source.connection_id,source.meta_direct_asset,target);
  IF bridge IS NULL OR bridge='{}' OR bridge IS DISTINCT FROM jsonb_build_object(
    'accountTransitionId',source.meta_direct_identity_resolution->'accountTransitionId','targetAsset',target) THEN RETURN NULL; END IF;
  RETURN target;
 END IF;
 RETURN source.meta_direct_asset;
END $$;
ALTER FUNCTION app.meta_direct_transition_asset(uuid) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_direct_transition_asset(uuid) FROM PUBLIC;

CREATE FUNCTION app.meta_account_alias_origin(alias_value uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE current_alias public.meta_direct_identity_aliases;step integer;
BEGIN
 SELECT * INTO current_alias FROM public.meta_direct_identity_aliases WHERE tenant_id=app.current_tenant_id() AND id=alias_value;
 IF current_alias.id IS NULL THEN RETURN NULL; END IF;
 IF current_alias.account_transition_id IS NULL THEN
  RETURN CASE WHEN current_alias.predecessor_alias_id IS NULL THEN current_alias.id ELSE NULL END;
 END IF;
 IF NOT app.meta_account_alias_lineage_valid(alias_value) THEN RETURN NULL; END IF;
 FOR step IN 1..32 LOOP
  IF current_alias.account_transition_id IS NULL THEN RETURN current_alias.id; END IF;
  SELECT * INTO current_alias FROM public.meta_direct_identity_aliases WHERE tenant_id=app.current_tenant_id() AND id=current_alias.predecessor_alias_id;
  IF current_alias.account_transition_id IS NULL THEN RETURN current_alias.id; END IF;
 END LOOP;
 RETURN NULL;
END $$;
ALTER FUNCTION app.meta_account_alias_origin(uuid) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_account_alias_origin(uuid) FROM PUBLIC;

-- Current alias authority may retain an ordinary native root through sealed
-- account ancestry. Explicit queued source-event admission is not widened.
CREATE FUNCTION app.meta_account_alias_retained_source_valid(alias_value uuid,canonical_value text,customer_value text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.meta_direct_identity_aliases alias
 JOIN public.meta_direct_identity_aliases origin ON origin.tenant_id=alias.tenant_id AND origin.id=app.meta_account_alias_origin(alias.id)
 JOIN public.participant_identities participant ON participant.tenant_id=alias.tenant_id AND participant.connection_id=alias.connection_id AND participant.id=alias.participant_identity_id
 JOIN public.event_inbox source ON source.tenant_id=origin.tenant_id AND source.connection_id=origin.connection_id AND source.id=origin.source_event_id
 WHERE alias.tenant_id=app.current_tenant_id() AND alias.id=alias_value AND alias.state IN('ACTIVE','HELD')
  AND participant.external_participant_id=canonical_value AND origin.participant_identity_id=participant.id
  AND source.payload_sha256=origin.source_payload_sha256
  AND ((source.meta_direct_identity_change IS NULL
   AND source.meta_direct_asset=jsonb_build_object('providerSessionId',origin.provider_session_id::text,'phoneNumberId',origin.phone_number_id,'wabaId',origin.waba_id)
   AND (app.meta_direct_native_anchor_valid(source.id,origin.participant_identity_id,customer_value,true)
    OR(source.status NOT IN('REDACTED','QUARANTINED','UNMATCHED','IGNORED') AND source.event_type='messages'
     AND source.payload#>>'{entry,0,changes,0,field}'='messages' AND EXISTS(SELECT 1 FROM public.normalized_messages message
      WHERE message.tenant_id=source.tenant_id AND message.connection_id=source.connection_id AND message.event_inbox_id=source.id
       AND message.external_group_id=canonical_value AND message.external_participant_id=canonical_value
       AND message.provider_metadata->'direct'='true' AND message.provider_metadata->>'zammad_customer_id'=customer_value
       AND message.processing_status<>'REDACTED'))))
  OR(app.meta_direct_transition_receipt_valid(source.id)
   AND app.meta_direct_transition_asset(source.id)=jsonb_build_object('providerSessionId',origin.provider_session_id::text,'phoneNumberId',origin.phone_number_id,'wabaId',origin.waba_id)
   AND source.meta_direct_identity_resolution->>'canonical'=canonical_value
   AND source.meta_direct_identity_resolution->>'nativeCustomerId'=customer_value
   AND source.meta_direct_identity_resolution->>'participantId'=origin.participant_identity_id::text
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(source.meta_direct_identity_resolution->'successorAliases') slot
    WHERE slot->>'id'=origin.id::text AND (slot->>'revision')::bigint<=origin.revision))))
$$;
REVOKE ALL ON FUNCTION app.meta_account_alias_retained_source_valid(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_account_alias_retained_source_valid(uuid,text,text) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;
CREATE OR REPLACE FUNCTION app.meta_direct_alias_source_valid(alias_value uuid,canonical_value text,customer_value text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.meta_direct_identity_aliases a WHERE a.tenant_id=app.current_tenant_id()
  AND a.id=alias_value AND a.state='ACTIVE' AND app.meta_account_alias_retained_source_valid(a.id,canonical_value,customer_value))
$$;

-- Every unresolved predecessor marker blocks the same current subject before
-- worker processing. Unknown attribution and privacy tombstones hold the asset.
CREATE OR REPLACE FUNCTION app.meta_direct_identity_guard(connection_value uuid,session_value uuid,phone_value text,waba_value text,participant_value uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.meta_direct_identity_aliases alias WHERE alias.tenant_id=app.current_tenant_id()
  AND alias.connection_id=connection_value AND alias.provider_session_id=session_value AND alias.phone_number_id=phone_value
  AND alias.waba_id IS NOT DISTINCT FROM waba_value AND alias.state='HELD'
  AND (participant_value IS NULL OR alias.participant_identity_id=participant_value))
 AND NOT EXISTS(SELECT 1 FROM public.event_inbox source WHERE source.tenant_id=app.current_tenant_id()
  AND source.connection_id=connection_value AND source.provider='META'
  AND app.meta_account_identity_asset_ancestor(connection_value,source.meta_direct_asset,
   jsonb_build_object('providerSessionId',session_value::text,'phoneNumberId',phone_value,'wabaId',waba_value))
  AND source.meta_direct_identity_change IS NOT NULL AND NOT app.meta_direct_transition_receipt_valid(source.id)
  AND (source.meta_direct_identity_change->>'payloadSha256' IS DISTINCT FROM source.payload_sha256
   OR source.meta_direct_identity_change->'redacted'='true' OR source.meta_direct_identity_change->>'scope'='ASSET' OR participant_value IS NULL
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(source.meta_direct_identity_change->'previous')='array'
    THEN source.meta_direct_identity_change->'previous' ELSE '[]'::jsonb END) previous JOIN public.meta_direct_identity_aliases alias
    ON alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id AND alias.kind=previous->>'kind' AND alias.value=previous->>'value'
     AND app.meta_account_identity_asset_ancestor(connection_value,
      jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id),
      jsonb_build_object('providerSessionId',session_value::text,'phoneNumberId',phone_value,'wabaId',waba_value)))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(source.meta_direct_identity_change->'previous')='array'
    THEN source.meta_direct_identity_change->'previous' ELSE '[]'::jsonb END) previous JOIN public.meta_direct_identity_aliases alias
    ON alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id AND alias.participant_identity_id=participant_value
     AND alias.kind=previous->>'kind' AND alias.value=previous->>'value'
     AND app.meta_account_identity_asset_ancestor(connection_value,
      jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id),
      jsonb_build_object('providerSessionId',session_value::text,'phoneNumberId',phone_value,'wabaId',waba_value)))))
$$;
GRANT EXECUTE ON FUNCTION app.meta_account_identity_target_asset(uuid,jsonb),app.meta_account_identity_bridge(uuid,jsonb,jsonb),
 app.meta_direct_transition_asset(uuid),app.meta_account_alias_origin(uuid) TO wasalx_app,wasalx_connector_worker,wasalx_scheduler_reader;

-- Export only this subject's asset pair and its immutable checkpoint references;
-- never project another bound connection from the account-wide receipt.
CREATE FUNCTION app.meta_account_alias_export_receipt(alias_value uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
 SELECT jsonb_build_object('schemaVersion',1,'claim',p.identity_successor_receipt->'claim',
  'transitionId',p.id,'operationId',p.identity_successor_receipt->'operationId',
  'sourceAccountId',p.source_account_id,'targetAccountId',p.target_account_id,
  'migrationId',p.provider_migration_id,'initiateCheckpointId',p.identity_successor_receipt->'initiateCheckpointId',
  'completeCheckpointId',p.identity_successor_receipt->'completeCheckpointId',
  'completionObservationOperationId',p.identity_successor_receipt->'completionObservationOperationId',
  'sourceScopeSha256',p.execution_scope_sha256,'targetProofSha256',p.identity_successor_receipt->'targetProofSha256',
  'asset',pair,'appliedAt',p.identity_successor_receipt->'appliedAt')
 FROM public.meta_direct_identity_aliases a JOIN public.meta_account_transitions p ON p.tenant_id=a.tenant_id AND p.id=a.account_transition_id
 CROSS JOIN LATERAL jsonb_array_elements(p.identity_successor_receipt->'assets') pair
 WHERE a.tenant_id=app.current_tenant_id() AND a.id=alias_value AND app.meta_account_alias_lineage_valid(a.id)
  AND pair->>'connectionId'=a.connection_id::text
  AND pair->'targetAsset'=jsonb_build_object('providerSessionId',a.provider_session_id::text,'phoneNumberId',a.phone_number_id,'wabaId',a.waba_id)
$$;
ALTER FUNCTION app.meta_account_alias_export_receipt(uuid) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_account_alias_export_receipt(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_account_alias_export_receipt(uuid) TO wasalx_connector_worker;

-- The sealed P03b consumer amendments follow its independently reviewed repair.
-- No partial integration of this private file is admitted.
-- BEGIN PRIVATE RECOVERY AND INGRESS COMPOSITION
-- Private P09 recovery companion, composed after lineage readers and before
-- the reviewed P03 consumer definitions. No runtime-role PAUSED capability.
-- Preserve P03's ACTIVE/PROVISIONING and NOWAIT semantics without granting
-- tenant UPDATE to the finite metadata executor merely for its row lock.
CREATE FUNCTION app.lock_current_meta_identity_tenant() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
BEGIN
 PERFORM id FROM public.tenants WHERE id=app.current_tenant_id() AND state IN('ACTIVE','PROVISIONING') FOR SHARE NOWAIT;
 RETURN FOUND;
END $$;
ALTER FUNCTION app.lock_current_meta_identity_tenant() OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.lock_current_meta_identity_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_current_meta_identity_tenant() TO wasalx_meta_transition_executor;

CREATE FUNCTION app.meta_account_identity_metadata_current(connection_value uuid,asset_value jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
BEGIN
 -- This invoker predicate is callable by runtime roles without tenant SELECT.
 -- Return before the protected query is prepared; SQL AND is not an ACL gate.
 IF current_user<>'wasalx_meta_transition_executor'
  OR NOT pg_has_role(session_user,'wasalx_connector_worker','MEMBER') THEN RETURN false; END IF;
 RETURN EXISTS(
  SELECT 1 FROM public.meta_connection_account_bindings binding
  JOIN public.meta_account_transitions plan ON plan.tenant_id=binding.tenant_id AND plan.id=binding.account_transition_id
  JOIN public.connection_operations operation ON operation.tenant_id=plan.tenant_id AND operation.id=plan.execution_operation_id
  JOIN public.connections connection ON connection.tenant_id=binding.tenant_id AND connection.id=binding.connection_id
  JOIN public.provider_sessions session ON session.tenant_id=binding.tenant_id AND session.connection_id=binding.connection_id AND session.id=binding.provider_session_id
  JOIN public.tenants tenant ON tenant.id=plan.tenant_id
  JOIN public.tenant_memberships member ON member.tenant_id=plan.tenant_id AND member.user_id::text=operation.requested_by_id
  WHERE binding.tenant_id=app.current_tenant_id() AND binding.connection_id=connection_value AND binding.state='HELD'
   AND connection.provider='META' AND connection.state='PAUSED' AND session.state='PAUSED' AND session.ownership_state='ACTIVE'
   AND jsonb_build_object('providerSessionId',session.id::text,'phoneNumberId',session.opaque_session_id,'wabaId',session.provider_state_data->>'wabaId')=asset_value
   AND binding.secret_reference=connection.secret_reference
   AND binding.proof_sha256=encode(digest((session.provider_state_data->'metaAccountProof')::text,'sha256'),'hex')
   AND session.provider_state_data#>>'{metaAccountProof,tenantId}'=binding.tenant_id::text
   AND session.provider_state_data#>>'{metaAccountProof,connectionId}'=binding.connection_id::text
   AND session.provider_state_data#>>'{metaAccountProof,providerSessionId}'=binding.provider_session_id::text
   AND session.provider_state_data#>>'{metaAccountProof,secretReference}'=connection.secret_reference
   AND session.provider_state_data#>>'{metaAccountProof,phoneNumberId}'=binding.phone_number_id
   AND session.provider_state_data#>>'{metaAccountProof,wabaId}'=asset_value->>'wabaId'
   AND session.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=binding.app_id
   AND CASE WHEN session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}'~'^[0-9]{1,16}$'
    THEN (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric=0
     OR (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END
   AND CASE WHEN NOT(session.provider_state_data#>'{metaAccountProof,credentialMetadata}' ? 'dataAccessExpiresAt') THEN true
    WHEN session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}'~'^[0-9]{1,16}$'
    THEN (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric=0
     OR (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END
   AND EXISTS(SELECT 1 FROM app.meta_lifecycle_guard(binding.connection_id,session.id,binding.phone_number_id,asset_value->>'wabaId',binding.app_id,
    CASE WHEN NOT(session.provider_state_data ? 'metaLifecycle') THEN 0
     WHEN session.provider_state_data#>>'{metaLifecycle,revision}'~'^[0-9]{1,15}$' THEN (session.provider_state_data#>>'{metaLifecycle,revision}')::bigint ELSE -1 END) life
    WHERE life.revision_matches AND NOT life.blocked AND NOT life.unresolved_hold)
   AND plan.execution_state='RECONCILED_PAUSED' AND plan.provider_status='COMPLETED' AND plan.state<>'CANCELLED'
   AND app.meta_account_identity_receipt_valid(plan.id)
   AND plan.identity_successor_receipt->>'operationId'=operation.id::text
   AND operation.state='RUNNING' AND operation.result IS NULL AND operation.lease_id IS NOT NULL AND operation.lease_expires_at>clock_timestamp()
   AND operation.payload#>>'{metaAccountTransitionExecution,id}'=plan.id::text
   AND operation.payload#>>'{metaAccountTransitionExecution,action}'='RECONCILE'
   AND operation.payload#>>'{metaAccountTransitionExecution,revision}'=(plan.revision-1)::text
   AND operation.payload#>>'{metaAccountTransitionExecution,scopeSha256}'=plan.execution_scope_sha256
   AND operation.payload#>'{metaAccountTransitionExecution,observerOperationIds}'=plan.observer_operations
   AND jsonb_typeof(operation.payload#>'{metaAccountTransitionExecution,localIdentityScope}')='array'
   AND tenant.state='ACTIVE' AND member.state='ACTIVE' AND member.role IN('tenant_owner','tenant_admin')
   AND 2=(SELECT count(*) FROM public.meta_account_transition_reservations reservation
    WHERE reservation.tenant_id=plan.tenant_id AND reservation.transition_id=plan.id AND reservation.released_at IS NULL
     AND reservation.scope_sha256=plan.execution_scope_sha256
     AND ((reservation.account_role='SOURCE' AND reservation.account_id=plan.source_account_id)
       OR(reservation.account_role='TARGET' AND reservation.account_id=plan.target_account_id))));
END;
$$;
REVOKE ALL ON FUNCTION app.meta_account_identity_metadata_current(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_account_identity_metadata_current(uuid,jsonb)
 TO wasalx_app,wasalx_connector_worker,wasalx_scheduler_reader,wasalx_meta_transition_executor;

-- One local call inside the original RECONCILE transaction. It cannot activate
-- connections, mutate source evidence, create native effects or repeat a POST.
CREATE FUNCTION app.meta_account_transition_identity_reconciliation(transition_value uuid,operation_value uuid,lease_value uuid,fence_value bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE plan public.meta_account_transitions;operation_row public.connection_operations;pair jsonb;source public.event_inbox;
 target_asset jsonb;result jsonb;owned_lease uuid;pending_ids uuid[];event_value uuid;receipt jsonb;
 assets jsonb:='[]';sources jsonb:='[]';original_digest text;queued_digest text;result_scope jsonb;connection_value uuid;
BEGIN
 IF NOT pg_has_role(session_user,'wasalx_connector_worker','MEMBER') THEN
  RAISE EXCEPTION 'Account identity reconciliation is worker-only' USING ERRCODE='42501'; END IF;
 IF NOT app.lock_current_active_tenant_for_event_admission()
  OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||app.current_tenant_id()::text,0)) THEN
  RAISE EXCEPTION 'Account identity reconciliation is busy or unavailable' USING ERRCODE='55000'; END IF;
 SELECT * INTO plan FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=transition_value FOR UPDATE NOWAIT;
 SELECT * INTO operation_row FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value FOR UPDATE NOWAIT;
 IF plan.id IS NULL OR operation_row.id IS NULL OR plan.execution_operation_id IS DISTINCT FROM operation_row.id
  OR operation_row.lease_id IS DISTINCT FROM lease_value OR operation_row.fencing_token IS DISTINCT FROM fence_value
  OR operation_row.state<>'RUNNING' OR operation_row.result IS NOT NULL OR operation_row.lease_expires_at<=clock_timestamp()
  OR NOT app.meta_account_identity_receipt_valid(plan.id) THEN
  RAISE EXCEPTION 'Original account identity reconciliation lease changed' USING ERRCODE='55000'; END IF;
 PERFORM app.meta_transition_actor_current(operation_row.requested_by_id::uuid);
 FOR pair IN SELECT value FROM jsonb_array_elements(plan.identity_successor_receipt->'assets') ORDER BY value->>'connectionId' LOOP
  connection_value:=(pair->>'connectionId')::uuid;target_asset:=pair->'targetAsset';
  PERFORM id FROM public.connections WHERE tenant_id=plan.tenant_id AND id=connection_value FOR UPDATE NOWAIT;
  PERFORM id FROM public.provider_sessions WHERE tenant_id=plan.tenant_id AND connection_id=connection_value AND ownership_state='ACTIVE' FOR UPDATE NOWAIT;
  IF NOT app.meta_account_identity_metadata_current(connection_value,target_asset) THEN
   RAISE EXCEPTION 'Exact paused metadata reconciliation context changed' USING ERRCODE='55000'; END IF;
  SELECT array_agg(id ORDER BY id) INTO pending_ids FROM public.event_inbox
   WHERE tenant_id=plan.tenant_id AND connection_id=connection_value AND provider='META'
    AND meta_direct_identity_change IS NOT NULL AND NOT app.meta_direct_transition_receipt_valid(id)
    AND app.meta_account_identity_asset_ancestor(connection_value,meta_direct_asset,target_asset);
  IF COALESCE(cardinality(pending_ids),0)>32 THEN
   RAISE EXCEPTION 'Account identity reconciliation exceeds its bounded marker scope' USING ERRCODE='54000'; END IF;
  -- Complete signed evidence is required for every marker. Sorting by provider
  -- order lets A->B precede B->C; conflicts remain the incumbent P03 decision.
  FOR event_value IN SELECT id FROM public.event_inbox WHERE tenant_id=plan.tenant_id AND id=ANY(COALESCE(pending_ids,ARRAY[]::uuid[]))
    ORDER BY meta_direct_identity_transition->>'providerTimestamp',id LOOP
   SELECT * INTO source FROM public.event_inbox WHERE tenant_id=plan.tenant_id AND id=event_value FOR NO KEY UPDATE NOWAIT;
   IF app.meta_direct_transition_receipt_valid(source.id) THEN CONTINUE; END IF;
   IF source.meta_direct_identity_transition IS NULL OR source.meta_direct_identity_transition->'redacted'='true'
    OR source.meta_direct_identity_transition->>'payloadSha256' IS DISTINCT FROM source.payload_sha256
    OR source.meta_direct_identity_transition->'asset' IS DISTINCT FROM source.meta_direct_asset
    OR source.meta_direct_identity_change->>'scope'='ASSET'
    OR source.meta_direct_identity_change->'redacted'='true' THEN
    RAISE EXCEPTION 'Account identity source requires review' USING ERRCODE='55000'; END IF;
   owned_lease:=NULL;
   IF source.status='QUARANTINED' AND source.safe_error IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PENDING_CURRENT') THEN
    NULL; -- Existing metadata reconsideration, never raw event replay.
   ELSIF source.status IN('ACCEPTED','FAILED_RETRYABLE','PROCESSING')
    AND (source.lease_id IS NULL OR source.lease_expires_at<=clock_timestamp()) THEN
    owned_lease:=gen_random_uuid();
    UPDATE public.event_inbox SET status='PROCESSING',lease_id=owned_lease,lease_expires_at=operation_row.lease_expires_at,
     attempts=attempts+1,updated_at=now() WHERE tenant_id=plan.tenant_id AND id=source.id
      AND status=source.status AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp());
    IF NOT FOUND THEN RAISE EXCEPTION 'Account identity source claim changed' USING ERRCODE='55000'; END IF;
   ELSE
    RAISE EXCEPTION 'Account identity source is held or owned by another worker' USING ERRCODE='55000';
   END IF;
   result:=app.drain_meta_direct_transitions(source.id,owned_lease,false);
   IF result->>'state' NOT IN('APPLIED','DUPLICATE') OR result->'remainingHeld'='true' THEN
    RAISE EXCEPTION 'Account identity metadata cannot settle completely' USING ERRCODE='55000'; END IF;
  END LOOP;
  IF NOT app.meta_account_identity_metadata_current(connection_value,target_asset)
   OR NOT app.meta_direct_identity_guard(connection_value,(target_asset->>'providerSessionId')::uuid,target_asset->>'phoneNumberId',target_asset->>'wabaId',NULL) THEN
   RAISE EXCEPTION 'Account identity markers or aliases remain held' USING ERRCODE='55000'; END IF;
  FOR source IN SELECT * FROM public.event_inbox WHERE tenant_id=plan.tenant_id AND id=ANY(COALESCE(pending_ids,ARRAY[]::uuid[])) ORDER BY id LOOP
   IF NOT app.meta_direct_transition_receipt_valid(source.id) THEN
    RAISE EXCEPTION 'Account identity settlement receipt is unavailable' USING ERRCODE='55000'; END IF;
   sources:=sources||jsonb_build_array(jsonb_build_object('eventId',source.id,'payloadSha256',source.payload_sha256,
    'evidenceSha256',encode(digest(source.meta_direct_identity_transition::text,'sha256'),'hex'),
    'resolutionSha256',encode(digest(source.meta_direct_identity_resolution::text,'sha256'),'hex'),
    'appliedEventId',source.meta_direct_identity_resolution->>'appliedEventId'));
  END LOOP;
  SELECT item->>'identitySha256' INTO original_digest FROM jsonb_array_elements(plan.execution_scope->'bindings') item WHERE item->>'id'=pair->>'sourceBindingId';
  SELECT item->>'identitySha256' INTO queued_digest FROM jsonb_array_elements(operation_row.payload#>'{metaAccountTransitionExecution,localIdentityScope}') item WHERE item->>'bindingId'=pair->>'sourceBindingId';
  result_scope:=app.meta_account_identity_scope(connection_value,(target_asset->>'providerSessionId')::uuid,target_asset->>'phoneNumberId',target_asset->>'wabaId');
  IF original_digest IS NULL OR queued_digest IS NULL THEN RAISE EXCEPTION 'Original identity scope is unavailable' USING ERRCODE='23514'; END IF;
  assets:=assets||jsonb_build_array(jsonb_build_object('sourceBindingId',pair->>'sourceBindingId','targetBindingId',pair->>'targetBindingId',
   'originalIdentitySha256',original_digest,'queuedIdentitySha256',queued_digest,'resultIdentitySha256',encode(digest(result_scope::text,'sha256'),'hex')));
 END LOOP;
 receipt:=jsonb_build_object('schemaVersion',1,'status','SETTLED','transitionId',plan.id,'operationId',operation_row.id,
  'sourceScopeSha256',plan.execution_scope_sha256,'localIdentityScopeSha256',encode(digest((operation_row.payload#>'{metaAccountTransitionExecution,localIdentityScope}')::text,'sha256'),'hex'),
  'assets',assets,'sources',sources,'settledAt',clock_timestamp());
 IF octet_length(receipt::text)>4194304 THEN RAISE EXCEPTION 'Account identity reconciliation receipt exceeds scope bound' USING ERRCODE='54000'; END IF;
 RETURN receipt;
END $$;
ALTER FUNCTION app.meta_account_transition_identity_reconciliation(uuid,uuid,uuid,bigint) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_account_transition_identity_reconciliation(uuid,uuid,uuid,bigint) FROM PUBLIC,wasalx_app,wasalx_connector_worker;
GRANT UPDATE(status,lease_id,lease_expires_at,attempts,updated_at,meta_direct_identity_resolution,processed_at,payload,provider_event_id,safe_error)
 ON public.event_inbox TO wasalx_meta_transition_executor;
GRANT UPDATE(id) ON public.participant_identities,public.bot_conversations TO wasalx_meta_transition_executor;
-- Existing legal-hold and queued batch-cancellation consumers execute as the
-- sealed owner too. These are their exact tenant-RLS reads/writes, not a role
-- membership grant or an alternate delivery path.
GRANT SELECT(tenant_id,zammad_ticket_id,normalized_reference,group_binding_id) ON public.case_correlations TO wasalx_meta_transition_executor;
GRANT SELECT(id,tenant_id,whatsapp_group_id) ON public.group_bindings TO wasalx_meta_transition_executor;
GRANT SELECT(id,tenant_id,connection_id,external_group_id) ON public.whatsapp_groups TO wasalx_meta_transition_executor;
GRANT SELECT(batch_id,batch_sequence) ON public.delivery_outbox TO wasalx_meta_transition_executor;
GRANT UPDATE(available_at,blocked_by_delivery_id,lease_id,lease_expires_at) ON public.delivery_outbox TO wasalx_meta_transition_executor;
GRANT SELECT(tenant_id,delivery_id,zammad_ticket_id),
 INSERT(tenant_id,delivery_id,zammad_ticket_id,delivery_state,safe_error),
 UPDATE(delivery_state,external_message_id,safe_error,completed_at,available_at,lease_id,lease_expires_at,updated_at)
 ON public.zammad_status_outbox TO wasalx_meta_transition_executor;
GRANT EXECUTE ON FUNCTION app.drain_meta_direct_transitions(uuid,uuid,boolean),app.apply_meta_direct_transition_edge(uuid,uuid,boolean),
 app.meta_direct_transition_admission(uuid,uuid,boolean),app.meta_direct_identity_guard(uuid,uuid,text,text,uuid),
 app.meta_direct_source_change_marker(jsonb,text),app.meta_direct_transition_edge(jsonb),
 app.meta_direct_identifier_valid(text,text),app.meta_direct_source_identity(jsonb),app.meta_direct_participant_matches(uuid,text,text)
 TO wasalx_meta_transition_executor;

-- Private section to compose into the new P09 migration after its ancestry
-- helpers. No historical ingress row or existing migration is rewritten.
CREATE FUNCTION app.resolve_meta_identity_source_asset(connection_value uuid,phone_value text,account_value text,app_value text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE current_asset jsonb;original_asset jsonb;matches integer;
BEGIN
 IF app_value IS NULL OR app_value !~ '^[0-9]{5,32}$' THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('providerSessionId',s.id::text,'phoneNumberId',s.opaque_session_id,'wabaId',s.provider_state_data->>'wabaId')
 INTO current_asset FROM public.provider_sessions s JOIN public.connections c ON c.tenant_id=s.tenant_id AND c.id=s.connection_id
 WHERE s.tenant_id=app.current_tenant_id() AND s.connection_id=connection_value AND c.provider='META' AND c.engine='CLOUD_API'
  AND c.state IN('WORKING','PAUSED') AND s.state IN('WORKING','PAUSED') AND s.ownership_state='ACTIVE' AND s.opaque_session_id=phone_value
  AND s.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=app_value
  AND s.provider_state_data#>>'{metaAccountProof,providerSessionId}'=s.id::text
  AND s.provider_state_data#>>'{metaAccountProof,phoneNumberId}'=s.opaque_session_id
  AND s.provider_state_data#>>'{metaAccountProof,wabaId}'=s.provider_state_data->>'wabaId'
  AND s.provider_state_data#>>'{metaAccountProof,claim}'='PHONE_ACCOUNT_RELATION_VERIFIED';
 IF current_asset IS NULL THEN RETURN NULL; END IF;
 IF account_value=current_asset->>'wabaId' THEN RETURN jsonb_build_object('asset',current_asset,'attributed',true); END IF;
 SELECT count(*),min(asset::text)::jsonb INTO matches,original_asset FROM(
  SELECT jsonb_build_object('providerSessionId',s.id::text,'phoneNumberId',s.opaque_session_id,'wabaId',s.provider_state_data->>'wabaId') asset
  FROM public.provider_sessions s WHERE s.tenant_id=app.current_tenant_id() AND s.connection_id=connection_value
   AND s.opaque_session_id=phone_value AND s.ownership_state='RETIRED' AND s.provider_state_data->>'wabaId'=account_value
   AND s.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=app_value) candidates
 WHERE app.meta_account_identity_asset_ancestor(connection_value,asset,current_asset);
 IF matches=1 THEN RETURN jsonb_build_object('asset',original_asset,'attributed',true); END IF;
 -- This pins a safety hold to the uniquely trusted phone, not an attribution of
 -- the unexpected account. The signed entry.id remains in the original bytes.
 RETURN jsonb_build_object('asset',current_asset,'attributed',false);
END $$;
ALTER FUNCTION app.resolve_meta_identity_source_asset(uuid,text,text,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.resolve_meta_identity_source_asset(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_meta_identity_source_asset(uuid,text,text,text) TO wasalx_app,wasalx_connector_worker;

CREATE FUNCTION app.meta_direct_source_safety_marker(payload_value jsonb,hash_value text,asset_value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT CASE WHEN app.meta_direct_source_change_marker(payload_value,hash_value) IS NULL THEN NULL
  WHEN payload_value#>>'{entry,0,id}' IS DISTINCT FROM asset_value->>'wabaId' THEN
   jsonb_build_object('schemaVersion',1,'scope','ASSET','previous','[]'::jsonb,'payloadSha256',hash_value)
  ELSE app.meta_direct_source_change_marker(payload_value,hash_value) END
$$;
REVOKE ALL ON FUNCTION app.meta_direct_source_safety_marker(jsonb,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_direct_source_safety_marker(jsonb,text,jsonb) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;

DO $$ DECLARE original text;replacement text;prefix text; BEGIN
 original:=pg_get_functiondef('app.preserve_meta_direct_asset()'::regprocedure);
 prefix:=$prefix$
  IF TG_OP='INSERT' AND NEW.meta_direct_asset IS NOT NULL AND NEW.event_type='messages'
   AND app.meta_direct_source_change_marker(NEW.payload,NEW.payload_sha256) IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.provider_sessions current_session
    WHERE current_session.tenant_id=NEW.tenant_id AND current_session.connection_id=NEW.connection_id AND current_session.ownership_state='ACTIVE'
     AND (app.resolve_meta_identity_source_asset(NEW.connection_id,
       NEW.payload#>>'{entry,0,changes,0,value,metadata,phone_number_id}',NEW.payload#>>'{entry,0,id}',
       current_session.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}')->'asset')=NEW.meta_direct_asset) THEN
   RETURN NEW;
  END IF;
$prefix$;
 IF strpos(original,'  IF TG_OP=''INSERT'' AND NEW.meta_direct_asset IS NOT NULL AND NOT EXISTS(')=0 THEN
  RAISE EXCEPTION 'Meta source asset prerequisite differs'; END IF;
 replacement:=replace(original,'  IF TG_OP=''INSERT'' AND NEW.meta_direct_asset IS NOT NULL AND NOT EXISTS(',
  prefix||'  IF TG_OP=''INSERT'' AND NEW.meta_direct_asset IS NOT NULL AND NOT EXISTS(');
 EXECUTE replacement;
 original:=pg_get_functiondef('app.preserve_meta_direct_identity_change()'::regprocedure);
 replacement:=replace(original,'app.meta_direct_source_change_marker(NEW.payload,NEW.payload_sha256)',
  'app.meta_direct_source_safety_marker(NEW.payload,NEW.payload_sha256,NEW.meta_direct_asset)');
 IF original=replacement THEN RAISE EXCEPTION 'Meta source marker prerequisite differs'; END IF;
 EXECUTE replacement;
END $$;

-- Only the sealed P03 insert uses the effective successor asset. Ordinary
-- signed source insertion remains tied to its exact current source asset.
DO $$ DECLARE original text;replacement text; BEGIN
 original:=pg_get_functiondef('app.guard_meta_direct_alias()'::regprocedure);
 replacement:=replace(original,$old$AND source.meta_direct_asset=jsonb_build_object('providerSessionId',NEW.provider_session_id::text,'phoneNumberId',NEW.phone_number_id,'wabaId',NEW.waba_id)$old$,
  $new$AND app.meta_direct_transition_asset(source.id)=jsonb_build_object('providerSessionId',NEW.provider_session_id::text,'phoneNumberId',NEW.phone_number_id,'wabaId',NEW.waba_id)$new$);
 IF original=replacement THEN RAISE EXCEPTION 'Sealed Meta transition alias prerequisite differs'; END IF;
 EXECUTE replacement;
END $$;
DROP INDEX public.meta_direct_transition_held_scan;
CREATE INDEX meta_direct_transition_held_scan ON public.event_inbox(id,tenant_id)
 WHERE provider='META' AND status='QUARANTINED' AND meta_direct_identity_resolution IS NULL
  AND safe_error IN('META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_CURRENT');
GRANT UPDATE(state,manual_retry_allowed,safe_error,updated_at) ON public.delivery_outbox TO wasalx_meta_transition_executor;

-- END PRIVATE RECOVERY AND INGRESS COMPOSITION
-- BEGIN REVIEWED P03B CONSUMER COMPOSITION
-- Derived from optimized P03b 59ba1733 plus deferred privacy d86f9072.
-- Preserve its streamed 33-edge bound, ordered validators and 5s qualification.
-- The deferred-current-row completion function is not replaced here.
CREATE OR REPLACE FUNCTION app.meta_direct_transition_receipt_valid(event_value uuid) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE source event_inbox%ROWTYPE;receipt jsonb;applied event_inbox%ROWTYPE;item jsonb;anchor_id uuid;participant_id uuid;asset jsonb;
BEGIN
 SELECT id,tenant_id,connection_id,provider,status,payload_sha256,meta_direct_asset,meta_direct_identity_change,meta_direct_identity_transition,meta_direct_identity_resolution,lease_id,lease_expires_at,safe_error INTO source.id,source.tenant_id,source.connection_id,source.provider,source.status,source.payload_sha256,source.meta_direct_asset,source.meta_direct_identity_change,source.meta_direct_identity_transition,source.meta_direct_identity_resolution,source.lease_id,source.lease_expires_at,source.safe_error FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value;
 receipt:=source.meta_direct_identity_resolution;
 IF NOT FOUND OR source.provider<>'META' OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR source.meta_direct_identity_transition IS NULL
  OR source.meta_direct_identity_transition->'redacted'='true' OR source.meta_direct_identity_change->'redacted'='true'
  OR receipt->'schemaVersion' IS DISTINCT FROM '1' OR COALESCE(receipt->>'state','') NOT IN('APPLIED','DUPLICATE')
  OR receipt->>'evidenceSha256' IS DISTINCT FROM encode(digest(source.meta_direct_identity_transition::text,'sha256'),'hex')
  OR source.meta_direct_identity_transition->>'payloadSha256' IS DISTINCT FROM source.payload_sha256
  OR COALESCE(receipt->>'participantId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR COALESCE(receipt->>'anchorEventId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR COALESCE(receipt->>'appliedEventId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR COALESCE(receipt->>'nativeCustomerId','')!~'^[1-9][0-9]{0,15}$'
  OR jsonb_typeof(receipt->'predecessorAliases') IS DISTINCT FROM 'array' OR jsonb_typeof(receipt->'successorAliases') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 asset:=app.meta_direct_transition_asset(source.id);
 IF asset IS NULL THEN RETURN false; END IF;
 participant_id:=(receipt->>'participantId')::uuid;anchor_id:=(receipt->>'anchorEventId')::uuid;
 IF NOT EXISTS(SELECT 1 FROM participant_identities p WHERE p.tenant_id=source.tenant_id AND p.connection_id=source.connection_id
  AND p.id=participant_id AND p.external_participant_id=receipt->>'canonical') THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM event_inbox anchor LEFT JOIN normalized_messages message ON message.tenant_id=anchor.tenant_id AND message.event_inbox_id=anchor.id
  WHERE anchor.tenant_id=source.tenant_id AND anchor.connection_id=source.connection_id AND anchor.id=anchor_id
   AND app.meta_account_identity_asset_ancestor(source.connection_id,anchor.meta_direct_asset,asset) AND anchor.meta_direct_identity_change IS NULL AND anchor.status IN('PROCESSED','REDACTED')
   AND app.meta_direct_transition_anchor_valid(anchor.id,participant_id,receipt->>'nativeCustomerId',false)) THEN RETURN false; END IF;
 IF source.status<>'PROCESSED' OR receipt-ARRAY['schemaVersion','state','evidenceSha256','participantId','canonical','nativeCustomerId','anchorEventId','predecessorAliases','successorAliases','appliedEventId','accountTransitionId','targetAsset']<>'{}' THEN RETURN false; END IF;
 IF receipt->>'state'='DUPLICATE' THEN
  SELECT id,tenant_id,connection_id,meta_direct_identity_transition,meta_direct_identity_resolution INTO applied.id,applied.tenant_id,applied.connection_id,applied.meta_direct_identity_transition,applied.meta_direct_identity_resolution FROM event_inbox WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND id=(receipt->>'appliedEventId')::uuid;
  IF NOT FOUND OR applied.id=source.id OR applied.meta_direct_identity_resolution->>'state'<>'APPLIED'
   OR app.meta_direct_transition_edge(applied.meta_direct_identity_transition) IS DISTINCT FROM app.meta_direct_transition_edge(source.meta_direct_identity_transition)
   OR (receipt-ARRAY['state','evidenceSha256']) IS DISTINCT FROM (applied.meta_direct_identity_resolution-ARRAY['state','evidenceSha256'])
   OR NOT app.meta_direct_transition_receipt_valid(applied.id) THEN RETURN false; END IF;
  RETURN true;
 END IF;
 IF receipt->>'appliedEventId'<>source.id::text OR jsonb_array_length(receipt->'successorAliases') NOT BETWEEN 1 AND 2
  OR jsonb_array_length(receipt->'predecessorAliases')>2 THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements((receipt->'predecessorAliases')||(receipt->'successorAliases')) LOOP
  IF COALESCE(item->>'id','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' OR jsonb_typeof(item->'revision') IS DISTINCT FROM 'number'
   OR (item->>'revision')!~'^[1-9][0-9]{0,15}$' OR NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias
    WHERE alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id AND alias.participant_identity_id=participant_id
     AND alias.id=(item->>'id')::uuid AND alias.revision>=(item->>'revision')::bigint
     AND jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id)=asset) THEN RETURN false; END IF;
 END LOOP;
 -- Successor slots bind the actual signed current identifiers. A later HELD
 -- marker or sealed consuming edge can advance its revision, but arbitrary
 -- older-revision equality is never accepted as current alias authority.
 FOR item IN SELECT value FROM jsonb_array_elements(receipt->'successorAliases') LOOP
  IF NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=source.tenant_id
   AND alias.connection_id=source.connection_id AND alias.id::text=item->>'id' AND alias.participant_identity_id=participant_id
   AND alias.value=CASE alias.kind WHEN 'PHONE' THEN source.meta_direct_identity_transition#>>'{change,current,phone}'
      ELSE source.meta_direct_identity_transition#>>'{change,current,bsuid}' END
   AND (alias.revision=(item->>'revision')::bigint
    OR(alias.state='HELD' AND alias.revision=(item->>'revision')::bigint+1)
    OR(alias.state='RETIRED' AND alias.revision>(item->>'revision')::bigint AND EXISTS(SELECT 1 FROM meta_direct_identity_aliases successor
      WHERE successor.tenant_id=alias.tenant_id AND successor.predecessor_alias_id=alias.id AND app.meta_account_alias_lineage_valid(successor.id)))
    OR EXISTS(SELECT 1 FROM event_inbox consuming WHERE consuming.tenant_id=source.tenant_id
     AND consuming.connection_id=source.connection_id AND app.meta_direct_transition_asset(consuming.id)=asset
     AND consuming.status='PROCESSED' AND consuming.meta_direct_identity_resolution->>'state'='APPLIED'
     AND consuming.meta_direct_identity_resolution->>'participantId'=participant_id::text
     AND consuming.meta_direct_identity_resolution->>'anchorEventId'=anchor_id::text
     AND consuming.meta_direct_identity_resolution->>'evidenceSha256'=encode(digest(consuming.meta_direct_identity_transition::text,'sha256'),'hex')
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(consuming.meta_direct_identity_resolution->'predecessorAliases') slot
      WHERE slot->>'id'=alias.id::text AND (slot->>'revision')::bigint IN((item->>'revision')::bigint,(item->>'revision')::bigint+1)
       AND alias.revision>=(slot->>'revision')::bigint+1)))) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION app.guard_meta_direct_resolution() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE receipt jsonb:=NEW.meta_direct_identity_resolution;item jsonb;owner uuid;prior event_inbox%ROWTYPE;anchor event_inbox%ROWTYPE;kind_value text;value_text text;asset jsonb;bridge jsonb;
BEGIN
 IF receipt IS NOT DISTINCT FROM OLD.meta_direct_identity_resolution THEN RETURN NEW; END IF;
 IF OLD.meta_direct_identity_resolution IS NOT NULL THEN
  IF NEW.status='REDACTED' AND NEW.payload='{}' AND receipt=jsonb_build_object('redacted',true,'sha256',encode(digest(OLD.meta_direct_identity_resolution::text,'sha256'),'hex'))
   AND app.meta_direct_privacy_target_authorized('META_DIRECT_IDENTITY_EVENT',OLD.id::text) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Meta transition resolution is immutable' USING ERRCODE='23514';
 END IF;
 IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid='app.apply_meta_direct_transition_edge(uuid,uuid,boolean)'::regprocedure)) THEN
  RAISE EXCEPTION 'Meta resolution requires sealed transition admission' USING ERRCODE='42501'; END IF;
 IF ((OLD.status='PROCESSING' AND OLD.lease_id IS NOT NULL AND OLD.lease_expires_at>clock_timestamp())
  OR(OLD.status='QUARANTINED' AND OLD.safe_error IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PENDING_CURRENT'))) IS NOT TRUE THEN
  RAISE EXCEPTION 'Meta transition source lease is no longer current' USING ERRCODE='55000'; END IF;
 IF NEW.meta_direct_identity_transition IS NULL OR OLD.status NOT IN('PROCESSING','QUARANTINED') OR NEW.status<>'PROCESSED'
  OR receipt->'schemaVersion' IS DISTINCT FROM '1' OR COALESCE(receipt->>'state','') NOT IN('APPLIED','DUPLICATE')
  OR receipt->>'evidenceSha256' IS DISTINCT FROM encode(digest(OLD.meta_direct_identity_transition::text,'sha256'),'hex')
  OR COALESCE(receipt->>'participantId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR COALESCE(receipt->>'anchorEventId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR COALESCE(receipt->>'appliedEventId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR jsonb_typeof(receipt->'predecessorAliases') IS DISTINCT FROM 'array' OR jsonb_typeof(receipt->'successorAliases') IS DISTINCT FROM 'array'
  OR receipt-ARRAY['schemaVersion','state','evidenceSha256','participantId','canonical','nativeCustomerId','anchorEventId','predecessorAliases','successorAliases','appliedEventId','accountTransitionId','targetAsset']<>'{}' THEN
  RAISE EXCEPTION 'Meta transition resolution does not match source' USING ERRCODE='23514'; END IF;
 asset:=COALESCE(receipt->'targetAsset',OLD.meta_direct_asset);
 bridge:=app.meta_account_identity_bridge(OLD.connection_id,OLD.meta_direct_asset,asset);
 IF bridge IS NULL OR bridge IS DISTINCT FROM (receipt-ARRAY['schemaVersion','state','evidenceSha256','participantId','canonical','nativeCustomerId','anchorEventId','predecessorAliases','successorAliases','appliedEventId']) THEN
  RAISE EXCEPTION 'Meta transition account lineage is unavailable' USING ERRCODE='23514'; END IF;
 owner:=(receipt->>'participantId')::uuid;
 IF receipt->>'state'='DUPLICATE' THEN
  SELECT id,tenant_id,connection_id,received_at,meta_direct_identity_transition,meta_direct_identity_resolution INTO prior.id,prior.tenant_id,prior.connection_id,prior.received_at,prior.meta_direct_identity_transition,prior.meta_direct_identity_resolution FROM event_inbox WHERE tenant_id=OLD.tenant_id AND connection_id=OLD.connection_id AND id=(receipt->>'appliedEventId')::uuid;
  IF NOT FOUND OR NOT app.meta_direct_transition_receipt_valid(prior.id) OR prior.meta_direct_identity_resolution->>'state'<>'APPLIED'
   OR app.meta_direct_transition_edge(prior.meta_direct_identity_transition) IS DISTINCT FROM app.meta_direct_transition_edge(OLD.meta_direct_identity_transition)
   OR receipt-ARRAY['state','evidenceSha256'] IS DISTINCT FROM prior.meta_direct_identity_resolution-ARRAY['state','evidenceSha256'] THEN
   RAISE EXCEPTION 'Meta duplicate transition lacks original receipt' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF receipt->>'appliedEventId'<>OLD.id::text OR NOT EXISTS(SELECT 1 FROM participant_identities participant WHERE participant.tenant_id=OLD.tenant_id
  AND participant.connection_id=OLD.connection_id AND participant.id=owner AND participant.external_participant_id=receipt->>'canonical')
  OR NOT app.meta_direct_transition_effects_clear(OLD.connection_id,owner)
  OR NOT app.meta_direct_transition_privacy_clear(OLD.connection_id,owner,ARRAY[OLD.meta_direct_identity_transition#>>'{change,previous,phone}',OLD.meta_direct_identity_transition#>>'{change,previous,bsuid}',OLD.meta_direct_identity_transition#>>'{change,current,phone}',OLD.meta_direct_identity_transition#>>'{change,current,bsuid}'],OLD.id) THEN
  RAISE EXCEPTION 'Meta transition owner or effects changed' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM provider_sessions session JOIN connections connection ON connection.tenant_id=session.tenant_id AND connection.id=session.connection_id
  WHERE session.tenant_id=OLD.tenant_id AND session.connection_id=OLD.connection_id AND session.ownership_state='ACTIVE'
   AND ((session.state='WORKING' AND connection.state='WORKING') OR app.meta_account_identity_metadata_current(OLD.connection_id,asset)) AND connection.provider='META'
   AND jsonb_build_object('providerSessionId',session.id::text,'phoneNumberId',session.opaque_session_id,'wabaId',session.provider_state_data->>'wabaId')=asset
   AND session.provider_state_data#>>'{metaAccountProof,tenantId}'=OLD.tenant_id::text AND session.provider_state_data#>>'{metaAccountProof,connectionId}'=OLD.connection_id::text
   AND session.provider_state_data#>>'{metaAccountProof,secretReference}'=connection.secret_reference AND session.provider_state_data#>>'{metaAccountProof,providerSessionId}'=session.id::text
   AND session.provider_state_data#>>'{metaAccountProof,phoneNumberId}'=session.opaque_session_id AND session.provider_state_data#>>'{metaAccountProof,wabaId}'=session.provider_state_data->>'wabaId'
   AND session.provider_state_data#>>'{metaAccountProof,claim}'='PHONE_ACCOUNT_RELATION_VERIFIED'
   AND session.provider_state_data#>>'{metaAccountProof,credentialMetadata,claim}'='CREDENTIAL_METADATA_VERIFIED'
   AND CASE WHEN session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}'~'^[0-9]{1,16}$'
     THEN (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric=0 OR (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END
   AND CASE WHEN NOT(session.provider_state_data#>'{metaAccountProof,credentialMetadata}' ? 'dataAccessExpiresAt') THEN true
    WHEN session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}'~'^[0-9]{1,16}$'
     THEN (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric=0 OR (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END) THEN
  RAISE EXCEPTION 'Meta transition current account proof is unavailable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM provider_sessions session CROSS JOIN LATERAL app.meta_lifecycle_guard(
    OLD.connection_id,session.id,session.opaque_session_id,session.provider_state_data->>'wabaId',
    session.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}',
    CASE WHEN NOT(session.provider_state_data ? 'metaLifecycle') THEN 0
      WHEN session.provider_state_data#>>'{metaLifecycle,revision}'~'^[0-9]{1,15}$' THEN (session.provider_state_data#>>'{metaLifecycle,revision}')::bigint ELSE -1 END) readiness
   WHERE session.tenant_id=OLD.tenant_id AND session.connection_id=OLD.connection_id AND session.ownership_state='ACTIVE'
    AND jsonb_build_object('providerSessionId',session.id::text,'phoneNumberId',session.opaque_session_id,'wabaId',session.provider_state_data->>'wabaId')=asset
    AND readiness.revision_matches AND NOT readiness.blocked AND NOT readiness.unresolved_hold) THEN
  RAISE EXCEPTION 'Meta transition lifecycle authority changed' USING ERRCODE='55000'; END IF;
 SELECT * INTO anchor FROM event_inbox WHERE tenant_id=OLD.tenant_id AND connection_id=OLD.connection_id AND id=(receipt->>'anchorEventId')::uuid;
 IF NOT FOUND OR anchor.status NOT IN('PROCESSED','REDACTED') OR NOT app.meta_account_identity_asset_ancestor(OLD.connection_id,anchor.meta_direct_asset,asset)
  OR NOT app.meta_direct_transition_anchor_valid(anchor.id,owner,receipt->>'nativeCustomerId',true) THEN
  RAISE EXCEPTION 'Meta transition ordinary customer anchor is unavailable' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(receipt->'predecessorAliases') LOOP
  IF jsonb_typeof(item->'revision') IS DISTINCT FROM 'number' OR COALESCE(item->>'revision','')!~'^[1-9][0-9]{0,15}$'
   OR NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=OLD.tenant_id AND alias.connection_id=OLD.connection_id
    AND alias.id::text=item->>'id' AND alias.participant_identity_id=owner AND alias.state IN('ACTIVE','HELD') AND alias.revision=(item->>'revision')::bigint
    AND jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id)=asset) THEN
   RAISE EXCEPTION 'Meta transition predecessor changed' USING ERRCODE='55000'; END IF;
 END LOOP;
 FOR kind_value,value_text IN SELECT * FROM(VALUES('PHONE',OLD.meta_direct_identity_transition#>>'{change,previous,phone}'),('BSUID',OLD.meta_direct_identity_transition#>>'{change,previous,bsuid}')) pairs(kind,value) LOOP
  IF value_text IS NOT NULL AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=OLD.tenant_id AND alias.connection_id=OLD.connection_id
   AND alias.participant_identity_id=owner AND alias.kind=kind_value AND alias.value=value_text AND alias.state IN('ACTIVE','HELD')
   AND jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id)=asset)
   AND NOT(kind_value='PHONE' AND receipt->>'canonical'=value_text AND OLD.meta_direct_identity_transition#>>'{change,previous,bsuid}' IS NULL
     AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=OLD.tenant_id AND alias.participant_identity_id=owner)) THEN
   RAISE EXCEPTION 'Meta transition supplied predecessor is not uniquely current' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=OLD.tenant_id AND alias.connection_id=OLD.connection_id AND alias.participant_identity_id=owner
  AND alias.state IN('ACTIVE','HELD') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(receipt->'predecessorAliases') slot WHERE slot->>'id'=alias.id::text AND slot->>'revision'=alias.revision::text)) THEN
  RAISE EXCEPTION 'Meta transition omits a current predecessor' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.meta_direct_transition_admission(event_value uuid,worker_lease uuid,lock_rows boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE source event_inbox%ROWTYPE;session_row provider_sessions%ROWTYPE;participant participant_identities%ROWTYPE;prior event_inbox%ROWTYPE;
 evidence jsonb;receipt jsonb;asset jsonb;previous_value jsonb;current_value jsonb;predecessors jsonb:='[]';successors jsonb:='[]';
 owned_values text[];owner_ids uuid[];owner uuid;anchor_id uuid;customer text;alias_row meta_direct_identity_aliases%ROWTYPE;
 kind_value text;target text;new_id uuid;contenders integer;edge_time timestamptz;last_time timestamptz;blocked boolean;connection_state text;predecessor record;pending_current boolean:=false;candidate record;edge_key text;unresolved_edges jsonb:='[]';
BEGIN
 IF lock_rows THEN SELECT id,tenant_id,connection_id,provider,status,payload_sha256,meta_direct_asset,meta_direct_identity_change,meta_direct_identity_transition,meta_direct_identity_resolution,lease_id,lease_expires_at,safe_error INTO source.id,source.tenant_id,source.connection_id,source.provider,source.status,source.payload_sha256,source.meta_direct_asset,source.meta_direct_identity_change,source.meta_direct_identity_transition,source.meta_direct_identity_resolution,source.lease_id,source.lease_expires_at,source.safe_error FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value FOR NO KEY UPDATE NOWAIT;
 ELSE SELECT id,tenant_id,connection_id,provider,status,payload_sha256,meta_direct_asset,meta_direct_identity_change,meta_direct_identity_transition,meta_direct_identity_resolution,lease_id,lease_expires_at,safe_error INTO source.id,source.tenant_id,source.connection_id,source.provider,source.status,source.payload_sha256,source.meta_direct_asset,source.meta_direct_identity_change,source.meta_direct_identity_transition,source.meta_direct_identity_resolution,source.lease_id,source.lease_expires_at,source.safe_error FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value; END IF;
 IF NOT FOUND OR source.provider<>'META' OR source.meta_direct_identity_transition IS NULL THEN RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 -- Source-bound replay is historical, before live lease/current credentials.
 IF app.meta_direct_transition_receipt_valid(source.id) THEN RETURN jsonb_build_object('state','DUPLICATE','receipt',source.meta_direct_identity_resolution); END IF;
 IF source.meta_direct_identity_resolution IS NOT NULL OR source.status NOT IN('PROCESSING','QUARANTINED')
  OR(source.status='QUARANTINED' AND COALESCE(source.safe_error,'') NOT IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PENDING_CURRENT'))
  OR (source.status='PROCESSING' AND (worker_lease IS NOT NULL AND source.lease_id=worker_lease AND source.lease_expires_at>clock_timestamp()) IS NOT TRUE) THEN
  RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 evidence:=source.meta_direct_identity_transition;asset:=source.meta_direct_asset;
 IF evidence->'redacted'='true' OR evidence->>'payloadSha256' IS DISTINCT FROM source.payload_sha256 OR evidence->'asset' IS DISTINCT FROM asset THEN
  RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 asset:=app.meta_account_identity_target_asset(source.connection_id,source.meta_direct_asset);
 IF asset IS NULL THEN RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 previous_value:=evidence#>'{change,previous}';current_value:=evidence#>'{change,current}';
 IF previous_value ? 'parentBsuid' OR current_value ? 'parentBsuid' THEN RETURN jsonb_build_object('state','HELD','reason','UNSUPPORTED_PARENT'); END IF;
 edge_time:=(evidence->>'providerTimestamp')::timestamptz;
 IF lock_rows THEN
  PERFORM id FROM connections WHERE tenant_id=source.tenant_id AND id=source.connection_id FOR NO KEY UPDATE NOWAIT;
  PERFORM id FROM provider_sessions WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND ownership_state='ACTIVE' FOR NO KEY UPDATE NOWAIT;
 END IF;
 SELECT state INTO connection_state FROM connections WHERE tenant_id=source.tenant_id AND id=source.connection_id AND provider='META';
 SELECT id,tenant_id,connection_id,ownership_state,state,opaque_session_id,provider_state_data INTO session_row.id,session_row.tenant_id,session_row.connection_id,session_row.ownership_state,session_row.state,session_row.opaque_session_id,session_row.provider_state_data FROM provider_sessions WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND ownership_state='ACTIVE';
 pending_current:=connection_state='PAUSED' AND session_row.state='PAUSED' AND EXISTS(
  SELECT 1 FROM meta_connection_account_bindings binding WHERE binding.tenant_id=source.tenant_id
   AND binding.connection_id=source.connection_id AND binding.provider_session_id=session_row.id AND binding.state='HELD'
   AND app.meta_account_identity_receipt_valid(binding.account_transition_id));
 IF session_row.id IS NULL OR (NOT(connection_state='WORKING' AND session_row.state='WORKING') AND NOT pending_current)
  OR jsonb_build_object('providerSessionId',session_row.id::text,'phoneNumberId',session_row.opaque_session_id,'wabaId',session_row.provider_state_data->>'wabaId') IS DISTINCT FROM asset THEN
  RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 IF NOT EXISTS(SELECT 1 FROM provider_sessions session JOIN connections connection ON connection.tenant_id=session.tenant_id AND connection.id=session.connection_id
  WHERE session.tenant_id=source.tenant_id AND session.connection_id=source.connection_id AND session.ownership_state='ACTIVE'
   AND ((session.state='WORKING' AND connection.state='WORKING') OR pending_current) AND connection.provider='META'
   AND jsonb_build_object('providerSessionId',session.id::text,'phoneNumberId',session.opaque_session_id,'wabaId',session.provider_state_data->>'wabaId')=asset
   AND session.provider_state_data#>>'{metaAccountProof,tenantId}'=source.tenant_id::text AND session.provider_state_data#>>'{metaAccountProof,connectionId}'=source.connection_id::text
   AND session.provider_state_data#>>'{metaAccountProof,secretReference}'=connection.secret_reference AND session.provider_state_data#>>'{metaAccountProof,providerSessionId}'=session.id::text
   AND session.provider_state_data#>>'{metaAccountProof,phoneNumberId}'=session.opaque_session_id AND session.provider_state_data#>>'{metaAccountProof,wabaId}'=session.provider_state_data->>'wabaId'
   AND session.provider_state_data#>>'{metaAccountProof,claim}'='PHONE_ACCOUNT_RELATION_VERIFIED'
   AND session.provider_state_data#>>'{metaAccountProof,credentialMetadata,claim}'='CREDENTIAL_METADATA_VERIFIED'
   AND CASE WHEN session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}'~'^[0-9]{1,16}$'
     THEN (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric=0 OR (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END
   AND CASE WHEN NOT(session.provider_state_data#>'{metaAccountProof,credentialMetadata}' ? 'dataAccessExpiresAt') THEN true
    WHEN session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}'~'^[0-9]{1,16}$'
     THEN (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric=0 OR (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END) THEN
  RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 IF NOT EXISTS(SELECT 1 FROM provider_sessions session CROSS JOIN LATERAL app.meta_lifecycle_guard(
    source.connection_id,session.id,session.opaque_session_id,session.provider_state_data->>'wabaId',
    session.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}',
    CASE WHEN NOT(session.provider_state_data ? 'metaLifecycle') THEN 0
      WHEN session.provider_state_data#>>'{metaLifecycle,revision}'~'^[0-9]{1,15}$' THEN (session.provider_state_data#>>'{metaLifecycle,revision}')::bigint ELSE -1 END) readiness
   WHERE session.tenant_id=source.tenant_id AND session.connection_id=source.connection_id AND session.ownership_state='ACTIVE'
    AND jsonb_build_object('providerSessionId',session.id::text,'phoneNumberId',session.opaque_session_id,'wabaId',session.provider_state_data->>'wabaId')=asset
    AND readiness.revision_matches AND NOT readiness.blocked AND NOT readiness.unresolved_hold) THEN
  RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 IF pending_current AND NOT app.meta_account_identity_metadata_current(source.connection_id,asset) THEN
  RETURN jsonb_build_object('state','HELD','reason','PENDING_CURRENT'); END IF;
 -- Qualify the exact semantic edge before invoking the full historical validator.
 -- A SQL AND predicate does not establish evaluation order.
 FOR candidate IN SELECT id,meta_direct_identity_resolution FROM event_inbox
  WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND meta_direct_asset=source.meta_direct_asset
   AND meta_direct_identity_resolution->>'state'='APPLIED'
   AND app.meta_direct_transition_edge(meta_direct_identity_transition)=app.meta_direct_transition_edge(evidence)
  ORDER BY received_at,id LOOP
  IF app.meta_direct_transition_receipt_valid(candidate.id) THEN
   receipt:=(candidate.meta_direct_identity_resolution-ARRAY['state','evidenceSha256'])||jsonb_build_object('state','DUPLICATE','evidenceSha256',encode(digest(evidence::text,'sha256'),'hex'));
   RETURN jsonb_build_object('state','DUPLICATE','receipt',receipt);
  END IF;
 END LOOP;
 SELECT array_agg(DISTINCT alias.participant_identity_id) INTO owner_ids FROM meta_direct_identity_aliases alias
  WHERE alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id AND alias.provider_session_id=session_row.id
   AND alias.phone_number_id=session_row.opaque_session_id AND alias.waba_id=asset->>'wabaId'
   AND ((alias.kind='PHONE' AND alias.value=previous_value->>'phone') OR(alias.kind='BSUID' AND alias.value=previous_value->>'bsuid'));
 IF COALESCE(cardinality(owner_ids),0)=0 AND previous_value->>'phone' IS NOT NULL AND previous_value->>'bsuid' IS NULL THEN
  SELECT array_agg(p.id) INTO owner_ids FROM participant_identities p WHERE p.tenant_id=source.tenant_id AND p.connection_id=source.connection_id
   AND p.external_participant_id=previous_value->>'phone' AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases a WHERE a.tenant_id=p.tenant_id AND a.participant_identity_id=p.id);
 END IF;
 IF COALESCE(cardinality(owner_ids),0)<>1 THEN RETURN jsonb_build_object('state','HELD','reason','PREDECESSOR_MISSING'); END IF;
 owner:=owner_ids[1];
 IF lock_rows THEN PERFORM id FROM participant_identities WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND id=owner FOR NO KEY UPDATE NOWAIT; END IF;
 SELECT id,tenant_id,connection_id,external_participant_id INTO participant.id,participant.tenant_id,participant.connection_id,participant.external_participant_id FROM participant_identities WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND id=owner;
 IF lock_rows THEN PERFORM id FROM meta_direct_identity_aliases WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND participant_identity_id=owner ORDER BY id FOR UPDATE NOWAIT; END IF;
 IF EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=source.tenant_id AND alias.participant_identity_id=owner AND
  (alias.provider_session_id<>session_row.id OR alias.phone_number_id<>session_row.opaque_session_id OR alias.waba_id<>asset->>'wabaId')
  AND NOT(alias.state='RETIRED' AND app.meta_account_identity_asset_ancestor(source.connection_id,jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id),asset))) THEN RETURN jsonb_build_object('state','HELD','reason','CONFLICT'); END IF;
 FOR kind_value,target IN SELECT * FROM(VALUES('PHONE',previous_value->>'phone'),('BSUID',previous_value->>'bsuid')) pairs(kind,value) LOOP
  IF target IS NOT NULL AND NOT (kind_value='PHONE' AND target=participant.external_participant_id AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases a WHERE a.tenant_id=source.tenant_id AND a.participant_identity_id=owner)) AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id
   AND alias.participant_identity_id=owner AND alias.kind=kind_value AND alias.value=target AND alias.state IN('ACTIVE','HELD')
   AND alias.provider_session_id=session_row.id AND alias.phone_number_id=session_row.opaque_session_id AND alias.waba_id=asset->>'wabaId') THEN
   IF NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases known WHERE known.tenant_id=source.tenant_id AND known.connection_id=source.connection_id
     AND known.provider_session_id=session_row.id AND known.phone_number_id=session_row.opaque_session_id AND known.waba_id=asset->>'wabaId'
     AND known.kind=kind_value AND known.value=target) THEN
    RETURN jsonb_build_object('state','HELD','reason','PREDECESSOR_MISSING'); END IF;
   RETURN jsonb_build_object('state','HELD','reason','CONFLICT'); END IF;
 END LOOP;
 SELECT array_agg(alias.value) INTO owned_values FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id AND alias.participant_identity_id=owner;
 owned_values:=COALESCE(owned_values,ARRAY[]::text[])||ARRAY[participant.external_participant_id,current_value->>'phone',current_value->>'bsuid'];
 -- One bounded unresolved edge set serves both the cardinality and fork tests.
 -- Iterate only cheap relevant candidates; stop at the original 33rd distinct
 -- semantic edge. Never materialize unbounded history or retain validity across
 -- an alias mutation. NULL resolution cannot satisfy the unchanged validator.
 FOR candidate IN SELECT id,meta_direct_asset,meta_direct_identity_transition,meta_direct_identity_resolution FROM event_inbox
  WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id
   AND meta_direct_identity_transition->'schemaVersion'='1'
   AND (meta_direct_identity_transition#>>'{change,previous,phone}'=ANY(owned_values)
    OR meta_direct_identity_transition#>>'{change,previous,bsuid}'=ANY(owned_values)
    OR meta_direct_identity_transition#>>'{change,current,phone}'=ANY(owned_values)
    OR meta_direct_identity_transition#>>'{change,current,bsuid}'=ANY(owned_values)) LOOP
  IF NOT app.meta_account_identity_asset_ancestor(source.connection_id,candidate.meta_direct_asset,asset) THEN CONTINUE; END IF;
  IF (CASE WHEN candidate.meta_direct_identity_resolution IS NULL THEN true
    ELSE NOT app.meta_direct_transition_receipt_valid(candidate.id) END) THEN
   edge_key:=app.meta_direct_transition_edge(candidate.meta_direct_identity_transition);
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(unresolved_edges) edge WHERE edge->>'edge'=edge_key) THEN
    unresolved_edges:=unresolved_edges||jsonb_build_array(jsonb_build_object('edge',edge_key,
     'previousPhone',candidate.meta_direct_identity_transition#>>'{change,previous,phone}',
     'previousBsuid',candidate.meta_direct_identity_transition#>>'{change,previous,bsuid}',
     'currentPhone',candidate.meta_direct_identity_transition#>>'{change,current,phone}',
     'currentBsuid',candidate.meta_direct_identity_transition#>>'{change,current,bsuid}'));
    IF jsonb_array_length(unresolved_edges)>32 THEN RETURN jsonb_build_object('state','HELD','reason','CONTENDER_LIMIT'); END IF;
   END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(unresolved_edges) left_edge
   JOIN jsonb_array_elements(unresolved_edges) right_edge ON right_edge->>'edge'>left_edge->>'edge'
   WHERE (left_edge->>'previousPhone'=right_edge->>'previousPhone' AND left_edge->>'previousPhone'=ANY(owned_values)
      AND (left_edge->>'previousBsuid' IS NULL OR right_edge->>'previousBsuid' IS NULL OR left_edge->>'previousBsuid'=right_edge->>'previousBsuid'))
    OR(left_edge->>'previousBsuid'=right_edge->>'previousBsuid' AND left_edge->>'previousBsuid'=ANY(owned_values))
    OR(left_edge->>'currentPhone'=right_edge->>'currentPhone' AND left_edge->>'currentPhone'=ANY(owned_values)
      AND (left_edge->>'currentBsuid' IS NULL OR right_edge->>'currentBsuid' IS NULL OR left_edge->>'currentBsuid'=right_edge->>'currentBsuid'))
    OR(left_edge->>'currentBsuid'=right_edge->>'currentBsuid' AND left_edge->>'currentBsuid'=ANY(owned_values))) THEN
  RETURN jsonb_build_object('state','HELD','reason','CONFLICT'); END IF;
 -- The immutable source parser emits fixed-width UTC ISO timestamps (or a
 -- redaction tombstone without one). C-order matches chronology without casting
 -- invalid history before receipt validation. Preserve MAX's NULL exclusion and
 -- fall back past invalid newer receipts; no asset predicate narrows the owner.
 FOR candidate IN SELECT old.id,old.meta_direct_identity_transition->>'providerTimestamp' provider_time FROM event_inbox old
  WHERE old.tenant_id=source.tenant_id AND old.connection_id=source.connection_id
   AND old.meta_direct_identity_resolution->>'participantId'=owner::text
   AND old.meta_direct_identity_resolution->>'state'='APPLIED'
  ORDER BY (old.meta_direct_identity_transition->>'providerTimestamp') COLLATE "C" DESC NULLS LAST,old.id LOOP
  IF candidate.provider_time IS NOT NULL THEN
   IF app.meta_direct_transition_receipt_valid(candidate.id) THEN
    last_time:=candidate.provider_time::timestamptz;EXIT;
   END IF;
  END IF;
 END LOOP;
 IF last_time IS NOT NULL AND edge_time<=last_time THEN RETURN jsonb_build_object('state','HELD','reason','CONFLICT'); END IF;
 -- Cheap ordinary source/address candidates precede either bridge or root
 -- validation. The loops retain the original earliest-valid-root semantics.
 FOR candidate IN SELECT anchor.id,anchor.meta_direct_asset,COALESCE(message.provider_metadata->>'zammad_customer_id',anchor.meta_direct_native_anchor->>'nativeCustomerId') native_customer
  FROM event_inbox anchor LEFT JOIN normalized_messages message ON message.tenant_id=anchor.tenant_id AND message.event_inbox_id=anchor.id
  WHERE anchor.tenant_id=source.tenant_id AND anchor.connection_id=source.connection_id
   AND anchor.meta_direct_identity_change IS NULL AND anchor.status IN('PROCESSED','REDACTED')
  ORDER BY anchor.received_at,anchor.id LOOP
  IF NOT app.meta_account_identity_asset_ancestor(source.connection_id,candidate.meta_direct_asset,asset) THEN CONTINUE; END IF;
  blocked:=NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases existing WHERE existing.tenant_id=source.tenant_id AND existing.participant_identity_id=owner)
   OR EXISTS(SELECT 1 FROM meta_direct_identity_aliases origin WHERE origin.tenant_id=source.tenant_id AND origin.connection_id=source.connection_id
    AND origin.participant_identity_id=owner AND origin.source_event_id=candidate.id);
  IF NOT blocked THEN
   -- Each bridge candidate is already linked to this owner's alias and root.
   FOR predecessor IN SELECT DISTINCT bridge.id FROM meta_direct_identity_aliases origin JOIN event_inbox bridge
     ON bridge.tenant_id=origin.tenant_id AND bridge.connection_id=origin.connection_id AND bridge.id=origin.source_event_id
    WHERE origin.tenant_id=source.tenant_id AND origin.connection_id=source.connection_id AND origin.participant_identity_id=owner
     AND bridge.meta_direct_identity_resolution->>'anchorEventId'=candidate.id::text LOOP
    IF app.meta_direct_transition_receipt_valid(predecessor.id) THEN blocked:=true;EXIT; END IF;
   END LOOP;
  END IF;
  IF blocked THEN
   IF app.meta_direct_transition_anchor_valid(candidate.id,owner,candidate.native_customer,true) THEN
    anchor_id:=candidate.id;customer:=candidate.native_customer;EXIT;
   END IF;
  END IF;
 END LOOP;
 IF anchor_id IS NULL OR EXISTS(SELECT 1 FROM normalized_messages message WHERE message.tenant_id=source.tenant_id AND message.connection_id=source.connection_id
  AND message.external_group_id=participant.external_participant_id AND message.provider_metadata->'direct'='true' AND message.provider_metadata->>'zammad_customer_id'<>customer) THEN
  RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 IF lock_rows THEN PERFORM id FROM bot_conversations WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND external_chat_id=participant.external_participant_id ORDER BY id FOR NO KEY UPDATE NOWAIT; END IF;
 IF NOT app.meta_direct_transition_privacy_clear(source.connection_id,owner,owned_values,source.id) THEN RETURN jsonb_build_object('state','HELD','reason','PRIVACY'); END IF;
 FOR predecessor IN SELECT id,revision FROM meta_direct_identity_aliases WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND participant_identity_id=owner AND state IN('ACTIVE','HELD') ORDER BY kind LOOP
  predecessors:=predecessors||jsonb_build_array(jsonb_build_object('id',predecessor.id::text,'revision',predecessor.revision));
 END LOOP;
 FOR kind_value,target IN SELECT * FROM(VALUES('PHONE',current_value->>'phone'),('BSUID',current_value->>'bsuid')) pairs(kind,value) LOOP
  IF target IS NULL THEN CONTINUE; END IF;
  SELECT id,tenant_id,connection_id,participant_identity_id,provider_session_id,phone_number_id,waba_id,kind,value,state,revision INTO alias_row.id,alias_row.tenant_id,alias_row.connection_id,alias_row.participant_identity_id,alias_row.provider_session_id,alias_row.phone_number_id,alias_row.waba_id,alias_row.kind,alias_row.value,alias_row.state,alias_row.revision FROM meta_direct_identity_aliases WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id
   AND provider_session_id=session_row.id AND phone_number_id=session_row.opaque_session_id AND waba_id=asset->>'wabaId' AND kind=kind_value AND value=target;
  IF FOUND AND (alias_row.participant_identity_id<>owner OR alias_row.state='RETIRED') THEN RETURN jsonb_build_object('state','HELD','reason','CONFLICT'); END IF;
  IF FOUND THEN successors:=successors||jsonb_build_array(jsonb_build_object('id',alias_row.id::text,'revision',alias_row.revision+CASE WHEN alias_row.state='HELD' THEN 1 ELSE 0 END));
  ELSE successors:=successors||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'revision',1)); END IF;
 END LOOP;
 IF NOT app.meta_direct_transition_effects_clear(source.connection_id,owner) THEN RETURN jsonb_build_object('state','HELD','reason','PENDING_EFFECT'); END IF;
 RETURN jsonb_build_object('state','READY','participantId',owner::text,'canonical',participant.external_participant_id,'anchorEventId',anchor_id::text,'nativeCustomerId',customer,'predecessorAliases',predecessors,'successorAliases',successors);
END;
$$;

CREATE OR REPLACE FUNCTION app.apply_meta_direct_transition_edge(event_value uuid,worker_lease uuid,hold_only boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE source event_inbox%ROWTYPE;session_row provider_sessions%ROWTYPE;participant participant_identities%ROWTYPE;prior event_inbox%ROWTYPE;
 evidence jsonb;receipt jsonb;asset jsonb;previous_value jsonb;current_value jsonb;predecessors jsonb:='[]';successors jsonb:='[]';
 owned_values text[];owner_ids uuid[];owner uuid;anchor_id uuid;customer text;alias_row meta_direct_identity_aliases%ROWTYPE;
 kind_value text;target text;new_id uuid;contenders integer;edge_time timestamptz;last_time timestamptz;blocked boolean;connection_state text;predecessor record;
BEGIN
 IF NOT pg_has_role(session_user,'wasalx_connector_worker','member') THEN RAISE EXCEPTION 'Meta transition mutation is worker-only' USING ERRCODE='42501'; END IF;
 -- Exact historical receipt is read-only even while privacy/current effects
 -- are held. Any new sealing, including a new duplicate source, shares privacy.
 IF app.meta_direct_transition_receipt_valid(event_value) THEN
  SELECT meta_direct_identity_resolution INTO receipt FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value;
  RETURN jsonb_build_object('state','DUPLICATE','receipt',receipt);
 END IF;
 IF hold_only IS NULL THEN RAISE EXCEPTION 'Meta transition mode is required' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value
  AND provider='META' AND event_type='messages') THEN RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 -- Scheduling is a hint. Lock current worker-eligible tenant authority before
 -- privacy/source locks; the existing definer owns this lock, not the caller.
 IF NOT app.lock_current_meta_identity_tenant() THEN RETURN jsonb_build_object('state','HELD','reason','TENANT_UNAVAILABLE'); END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||app.current_tenant_id()::text,0)) THEN RETURN jsonb_build_object('state','HELD','reason','BUSY'); END IF;
 -- Local runtime-proof denial or legacy evidence can only fence its original
 -- live source. It cannot enter positive admission, mint a receipt or follow edges.
 IF hold_only THEN
  SELECT * INTO source FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value FOR NO KEY UPDATE NOWAIT;
  IF source.status IS DISTINCT FROM 'PROCESSING' OR source.meta_direct_identity_resolution IS NOT NULL
   OR (worker_lease IS NOT NULL AND source.lease_id=worker_lease AND source.lease_expires_at>clock_timestamp()) IS NOT TRUE
   OR app.meta_direct_source_change_marker(source.payload,source.payload_sha256) IS NULL THEN
   RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
  PERFORM id FROM connections WHERE tenant_id=source.tenant_id AND id=source.connection_id AND provider='META' FOR NO KEY UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
  SELECT * INTO session_row FROM provider_sessions WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND ownership_state='ACTIVE' FOR NO KEY UPDATE NOWAIT;
  IF NOT FOUND OR(source.meta_direct_asset IS NOT NULL AND NOT app.meta_account_identity_asset_ancestor(source.connection_id,source.meta_direct_asset,
   jsonb_build_object('providerSessionId',session_row.id::text,'phoneNumberId',session_row.opaque_session_id,'wabaId',session_row.provider_state_data->>'wabaId'))) THEN
   RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
  RETURN jsonb_build_object('state','HELD','reason','REQUIRES_REVIEW');
 END IF;
 receipt:=app.meta_direct_transition_admission(event_value,worker_lease,true);
 IF receipt->>'state'='HELD' THEN RETURN receipt; END IF;
 SELECT * INTO source FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value;
 IF receipt->>'state'='DUPLICATE' THEN
  IF source.meta_direct_identity_resolution IS NULL THEN
   UPDATE event_inbox SET meta_direct_identity_resolution=receipt->'receipt',status='PROCESSED',processed_at=now(),lease_id=NULL,lease_expires_at=NULL,
    payload=jsonb_build_object('redacted',true,'payload_sha256',payload_sha256),provider_event_id='redacted:'||provider_event_id_sha256,safe_error=NULL WHERE id=source.id AND tenant_id=source.tenant_id
     AND ((status='PROCESSING' AND worker_lease IS NOT NULL AND lease_id=worker_lease AND lease_expires_at>clock_timestamp())
       OR(status='QUARANTINED' AND safe_error IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PENDING_CURRENT')));
   IF NOT FOUND THEN RAISE EXCEPTION 'Meta transition source lease is no longer current' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN receipt;
 END IF;
 owner:=(receipt->>'participantId')::uuid;anchor_id:=(receipt->>'anchorEventId')::uuid;customer:=receipt->>'nativeCustomerId';
 predecessors:=receipt->'predecessorAliases';successors:=receipt->'successorAliases';
 SELECT * INTO participant FROM participant_identities WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND id=owner;
 SELECT * INTO session_row FROM provider_sessions WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND ownership_state='ACTIVE';
 evidence:=source.meta_direct_identity_transition;asset:=app.meta_account_identity_target_asset(source.connection_id,source.meta_direct_asset);current_value:=evidence#>'{change,current}';
 -- Cancel only never-attempted, never-leased QUEUED work. Immutable recipient,
 -- content and idempotency remain history; no replacement reply is enqueued.
 UPDATE delivery_outbox delivery SET state='FAILED_TERMINAL',manual_retry_allowed=false,safe_error='Recipient changed before any dispatch.',updated_at=now()
  FROM bot_conversations conversation WHERE delivery.tenant_id=source.tenant_id AND conversation.tenant_id=delivery.tenant_id AND delivery.connection_id=conversation.connection_id AND (conversation.id=delivery.bot_conversation_id OR(delivery.direct_origin IS NOT NULL AND delivery.external_chat_id=conversation.external_chat_id AND delivery.zammad_ticket_id=conversation.zammad_ticket_id))
   AND conversation.connection_id=source.connection_id AND conversation.external_chat_id=participant.external_participant_id
   AND delivery.state='QUEUED' AND delivery.attempts=0 AND delivery.lease_id IS NULL AND NOT EXISTS(SELECT 1 FROM delivery_attempts attempt WHERE attempt.tenant_id=delivery.tenant_id AND attempt.delivery_id=delivery.id);
 receipt:=jsonb_build_object('schemaVersion',1,'state','APPLIED','evidenceSha256',encode(digest(evidence::text,'sha256'),'hex'),'participantId',owner::text,
  'canonical',participant.external_participant_id,'nativeCustomerId',customer,'anchorEventId',anchor_id::text,'predecessorAliases',predecessors,'successorAliases',successors,'appliedEventId',source.id::text)||app.meta_account_identity_bridge(source.connection_id,source.meta_direct_asset,asset);
 UPDATE event_inbox SET meta_direct_identity_resolution=receipt,status='PROCESSED',processed_at=now(),lease_id=NULL,lease_expires_at=NULL,
  payload=jsonb_build_object('redacted',true,'payload_sha256',payload_sha256),provider_event_id='redacted:'||provider_event_id_sha256,safe_error=NULL WHERE id=source.id AND tenant_id=source.tenant_id
     AND ((status='PROCESSING' AND worker_lease IS NOT NULL AND lease_id=worker_lease AND lease_expires_at>clock_timestamp())
       OR(status='QUARANTINED' AND safe_error IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PENDING_CURRENT')));
   IF NOT FOUND THEN RAISE EXCEPTION 'Meta transition source lease is no longer current' USING ERRCODE='55000'; END IF;
 UPDATE meta_direct_identity_aliases SET state='RETIRED',revision=revision+1 WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND participant_identity_id=owner
  AND state IN('ACTIVE','HELD') AND ((kind='PHONE' AND value IS DISTINCT FROM current_value->>'phone') OR(kind='BSUID' AND value IS DISTINCT FROM current_value->>'bsuid'));
 UPDATE meta_direct_identity_aliases SET state='ACTIVE',revision=revision+1 WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND participant_identity_id=owner AND state='HELD'
  AND ((kind='PHONE' AND value=current_value->>'phone') OR(kind='BSUID' AND value=current_value->>'bsuid'));
 FOR kind_value,target IN SELECT * FROM(VALUES('PHONE',current_value->>'phone'),('BSUID',current_value->>'bsuid')) pairs(kind,value) LOOP
  IF target IS NULL OR EXISTS(SELECT 1 FROM meta_direct_identity_aliases WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND participant_identity_id=owner AND kind=kind_value AND value=target AND state='ACTIVE') THEN CONTINUE; END IF;
  SELECT (item->>'id')::uuid INTO new_id FROM jsonb_array_elements(successors) item WHERE NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases WHERE id=(item->>'id')::uuid) LIMIT 1;
  INSERT INTO meta_direct_identity_aliases(id,tenant_id,connection_id,participant_identity_id,provider_session_id,phone_number_id,waba_id,kind,value,source_event_id,source_payload_sha256)
   VALUES(new_id,source.tenant_id,source.connection_id,owner,session_row.id,session_row.opaque_session_id,asset->>'wabaId',kind_value,target,source.id,source.payload_sha256);
 END LOOP;
 -- Canonical participant/native profile is unchanged; active aliases own transport identity.
 RETURN jsonb_build_object('state','APPLIED','receipt',receipt);
-- Every reversed caller lock acquisition is finite: NOWAIT cannot wait on a
-- tenant/source/connection lock cycle, and the exception subtransaction rolls back.
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('state','HELD','reason','BUSY');
END;
$$;

CREATE OR REPLACE FUNCTION app.drain_meta_direct_transitions(event_value uuid,worker_lease uuid,hold_only boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE first_result jsonb;result jsonb;source event_inbox%ROWTYPE;owner uuid;next_id uuid;step integer;applied_ids jsonb:='[]';known_values text[];
BEGIN
 first_result:=app.apply_meta_direct_transition_edge(event_value,worker_lease,hold_only);
 SELECT * INTO source FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value;
 IF first_result->>'state'='DUPLICATE' THEN RETURN first_result; END IF;
 IF first_result->>'state'='HELD' THEN
  -- Failure to obtain authority is read-only, including quarantine relabeling.
  IF first_result->>'reason' IN('BUSY','TENANT_UNAVAILABLE') OR source.provider IS DISTINCT FROM 'META'
    OR(hold_only AND first_result->>'reason' IS DISTINCT FROM 'REQUIRES_REVIEW')
    OR(NOT hold_only AND source.meta_direct_identity_transition IS NULL) THEN RETURN first_result; END IF;
  IF source.status='PROCESSING' AND (worker_lease IS NOT NULL AND source.lease_id=worker_lease AND source.lease_expires_at>clock_timestamp()) IS TRUE THEN
   UPDATE meta_direct_identity_aliases alias SET state='HELD',revision=revision+1 WHERE alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id
    AND alias.state='ACTIVE' AND jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id)=app.meta_account_identity_target_asset(source.connection_id,source.meta_direct_asset)
    AND alias.participant_identity_id IN(SELECT prior.participant_identity_id FROM meta_direct_identity_aliases prior WHERE prior.tenant_id=source.tenant_id
      AND prior.connection_id=source.connection_id AND app.meta_account_identity_asset_ancestor(source.connection_id,
       jsonb_build_object('providerSessionId',prior.provider_session_id::text,'phoneNumberId',prior.phone_number_id,'wabaId',prior.waba_id),
       app.meta_account_identity_target_asset(source.connection_id,source.meta_direct_asset))
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(source.meta_direct_identity_change,app.meta_direct_source_change_marker(source.payload,source.payload_sha256))->'previous') previous
        WHERE previous->>'kind'=prior.kind AND previous->>'value'=prior.value));
   UPDATE event_inbox SET status='QUARANTINED',payload=jsonb_build_object('redacted',true,'payload_sha256',payload_sha256),provider_event_id='redacted:'||provider_event_id_sha256,
    processed_at=now(),lease_id=NULL,lease_expires_at=NULL,safe_error=CASE WHEN hold_only THEN 'META_IDENTITY_CHANGE_REQUIRES_REVIEW' ELSE 'META_IDENTITY_TRANSITION_'||(first_result->>'reason') END,updated_at=now() WHERE tenant_id=source.tenant_id AND id=source.id
      AND status='PROCESSING' AND worker_lease IS NOT NULL AND lease_id=worker_lease AND lease_expires_at>clock_timestamp();
    -- An expiry while fencing aliases must roll back the whole statement.
    IF NOT FOUND THEN RAISE EXCEPTION 'Meta transition source lease is no longer current' USING ERRCODE='55000'; END IF;
  END IF;
  IF source.status='QUARANTINED' AND source.safe_error IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PENDING_CURRENT')
    AND first_result->>'reason' NOT IN('BUSY','PENDING_EFFECT','PREDECESSOR_MISSING','PENDING_CURRENT') THEN
   UPDATE event_inbox SET safe_error='META_IDENTITY_TRANSITION_'||(first_result->>'reason'),updated_at=now() WHERE tenant_id=source.tenant_id AND id=source.id;
  END IF;
  RETURN first_result;
 END IF;
 owner:=(first_result#>>'{receipt,participantId}')::uuid;applied_ids:=jsonb_build_array(event_value::text);
 -- B->C held before A->B becomes reachable only after B is actually owned.
 -- No native/provider work or raw event replay occurs in this bounded drain.
 FOR step IN 2..32 LOOP
  SELECT array_agg(value) INTO known_values FROM meta_direct_identity_aliases WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id
   AND participant_identity_id=owner AND state IN('ACTIVE','HELD');
  SELECT candidate.id INTO next_id FROM event_inbox candidate WHERE candidate.tenant_id=source.tenant_id AND candidate.connection_id=source.connection_id
   AND app.meta_account_identity_asset_ancestor(source.connection_id,candidate.meta_direct_asset,app.meta_account_identity_target_asset(source.connection_id,source.meta_direct_asset)) AND candidate.status='QUARANTINED' AND candidate.meta_direct_identity_resolution IS NULL
   AND candidate.meta_direct_identity_transition->'schemaVersion'='1'
   AND candidate.safe_error IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PENDING_CURRENT')
   AND (candidate.meta_direct_identity_transition#>>'{change,previous,phone}'=ANY(known_values) OR candidate.meta_direct_identity_transition#>>'{change,previous,bsuid}'=ANY(known_values))
   ORDER BY (candidate.meta_direct_identity_transition->>'providerTimestamp')::timestamptz,candidate.id LIMIT 1;
  EXIT WHEN next_id IS NULL;
  result:=app.apply_meta_direct_transition_edge(next_id,NULL);
  IF result->>'state'='HELD' THEN
   IF result->>'reason' NOT IN('BUSY','TENANT_UNAVAILABLE','PENDING_EFFECT','PREDECESSOR_MISSING','PENDING_CURRENT') THEN UPDATE event_inbox SET safe_error='META_IDENTITY_TRANSITION_'||(result->>'reason'),updated_at=now() WHERE tenant_id=source.tenant_id AND id=next_id; END IF;
   EXIT;
  END IF;
  applied_ids:=applied_ids||jsonb_build_array(next_id::text);
 END LOOP;
 IF jsonb_array_length(applied_ids)=32 AND EXISTS(SELECT 1 FROM event_inbox pending JOIN meta_direct_identity_aliases alias
   ON alias.tenant_id=pending.tenant_id AND alias.connection_id=pending.connection_id AND alias.participant_identity_id=owner
    AND alias.state IN('ACTIVE','HELD') AND ((alias.kind='PHONE' AND alias.value=pending.meta_direct_identity_transition#>>'{change,previous,phone}')
     OR(alias.kind='BSUID' AND alias.value=pending.meta_direct_identity_transition#>>'{change,previous,bsuid}'))
   WHERE pending.tenant_id=source.tenant_id AND pending.connection_id=source.connection_id AND app.meta_account_identity_asset_ancestor(source.connection_id,pending.meta_direct_asset,app.meta_account_identity_target_asset(source.connection_id,source.meta_direct_asset))
    AND pending.status='QUARANTINED' AND pending.meta_direct_identity_resolution IS NULL
    AND pending.safe_error IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PENDING_CURRENT')) THEN
  RETURN first_result||jsonb_build_object('appliedEventIds',applied_ids,'remainingHeld',true,'reason','DRAIN_LIMIT');
 END IF;
 RETURN first_result||jsonb_build_object('appliedEventIds',applied_ids);
END;
$$;

CREATE OR REPLACE FUNCTION app.scan_meta_direct_transition_work(scan_limit integer DEFAULT 32,after_event uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE candidate record;saved_tenant text:=current_setting('app.tenant_id',true);
 examined integer:=0;last_examined uuid;ready jsonb:='[]';page_start uuid:=after_event;
BEGIN
 IF scan_limit IS NULL OR scan_limit NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'Meta transition scan must be between 1 and 32' USING ERRCODE='22023'; END IF;
 -- At most one empty end-of-list probe, then one bounded wrapped page.
 IF page_start IS NOT NULL AND NOT EXISTS(SELECT 1 FROM event_inbox source JOIN tenants tenant ON tenant.id=source.tenant_id
  WHERE tenant.state IN('ACTIVE','PROVISIONING') AND source.provider='META' AND source.status='QUARANTINED'
   AND source.meta_direct_identity_resolution IS NULL AND source.safe_error IN('META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_CURRENT')
   AND (source.safe_error<>'META_IDENTITY_TRANSITION_PENDING_CURRENT' OR EXISTS(
    SELECT 1 FROM connections connection JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
    WHERE connection.tenant_id=source.tenant_id AND connection.id=source.connection_id AND connection.state='WORKING'
     AND session.ownership_state='ACTIVE' AND session.state='WORKING'))
   AND source.id>page_start) THEN page_start:=NULL; END IF;
 FOR candidate IN SELECT source.id,source.tenant_id FROM event_inbox source JOIN tenants tenant ON tenant.id=source.tenant_id
  WHERE tenant.state IN('ACTIVE','PROVISIONING') AND source.provider='META' AND source.status='QUARANTINED'
   AND source.meta_direct_identity_resolution IS NULL AND source.safe_error IN('META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_CURRENT')
   AND (source.safe_error<>'META_IDENTITY_TRANSITION_PENDING_CURRENT' OR EXISTS(
    SELECT 1 FROM connections connection JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
    WHERE connection.tenant_id=source.tenant_id AND connection.id=source.connection_id AND connection.state='WORKING'
     AND session.ownership_state='ACTIVE' AND session.state='WORKING'))
   AND (page_start IS NULL OR source.id>page_start) ORDER BY source.id LIMIT scan_limit LOOP
  examined:=examined+1;last_examined:=candidate.id;
  PERFORM set_config('app.tenant_id',candidate.tenant_id::text,true);
  IF app.meta_direct_transition_admission(candidate.id,NULL,false)->>'state'='READY' THEN
   ready:=ready||jsonb_build_array(jsonb_build_object('tenantId',candidate.tenant_id::text,'eventId',candidate.id::text));
  END IF;
 END LOOP;
 PERFORM set_config('app.tenant_id',COALESCE(saved_tenant,''),true);
 RETURN jsonb_build_object('nextCursor',last_examined,'examined',examined,'ready',ready);
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('app.tenant_id',COALESCE(saved_tenant,''),true);RAISE;
END;
$$;
ALTER FUNCTION app.apply_meta_direct_transition_edge(uuid,uuid,boolean) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.apply_meta_direct_transition_edge(uuid,uuid,boolean) FROM PUBLIC,wasalx_app;
GRANT EXECUTE ON FUNCTION app.apply_meta_direct_transition_edge(uuid,uuid,boolean) TO wasalx_connector_worker;
-- END REVIEWED P03B CONSUMER COMPOSITION

-- P09 logical fragment: META_ACCOUNT_TRANSITION_SUCCESSOR.sql
-- Bound source SHA256: 138473613cf84bd208fc1c40ca128646278bb8281373e65c9609d5e036e556ce
-- Unapplied companion after execution and reviewed P03 lineage functions.
GRANT INSERT ON public.provider_sessions,public.meta_billing_policy_versions,public.meta_funding_arrangement_versions,
 public.platform_operations_audit_events TO wasalx_meta_transition_executor;
GRANT SELECT,INSERT,UPDATE ON public.meta_account_transition_reservations TO wasalx_meta_transition_executor;
-- The existing policy INSERT trigger is SECURITY INVOKER. The ungranted
-- coordinator needs only this existing tenant/account-scoped receipt reader.
GRANT EXECUTE ON FUNCTION app.meta_terms_receipt_scope(uuid,uuid,uuid,uuid) TO wasalx_meta_transition_executor;
ALTER TABLE public.provider_sessions DROP CONSTRAINT provider_sessions_connection_id_opaque_session_id_key;
CREATE UNIQUE INDEX provider_session_current_opaque ON public.provider_sessions(connection_id,opaque_session_id) WHERE ownership_state='ACTIVE';

-- A local reviewed target checkpoint is separate from the immutable original
-- financial authorization. It cannot choose a target or clear an unknown POST.
CREATE FUNCTION app.operator_review_meta_transition_target(plan_value uuid,observation_value uuid,candidate jsonb,operator_value text,request_value text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;o public.connection_operations;approval public.platform_operations_audit_events;
 receipt uuid:=gen_random_uuid();target public.meta_messaging_accounts;
BEGIN
 SELECT * INTO p FROM public.meta_account_transitions WHERE id=plan_value;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=observation_value AND id=p.provider_observation_operation_id;
 SELECT * INTO approval FROM public.platform_operations_audit_events WHERE id=p.execution_authorization_id;
 SELECT * INTO target FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=p.target_account_id;
 IF p.id IS NULL OR target.id IS NULL OR p.state='CANCELLED' OR p.execution_state='RECONCILED_PAUSED'
  OR o.result#>>'{metaTransitionObservation,migrationId}' IS DISTINCT FROM p.provider_migration_id
  OR o.result#>>'{metaTransitionObservation,destination,id}' IS DISTINCT FROM target.provider_account_id
  OR COALESCE(o.result#>>'{metaTransitionObservation,targetReadiness,assets}','') NOT IN('VERIFIED','CLONE_ACCESS_VERIFIED')
  OR approval.action IS DISTINCT FROM 'meta.transition.prerequisites.simulated.approved'
  OR candidate->>'mode' IS DISTINCT FROM 'SIMULATED' OR candidate->>'templates' IS DISTINCT FROM 'VERIFIED'
  OR candidate->>'flows' IS DISTINCT FROM 'VERIFIED'
  OR candidate->>'scopeSha256' IS DISTINCT FROM p.execution_scope_sha256
  OR COALESCE(candidate->>'templateEvidenceSha256','') !~ '^[a-f0-9]{64}$'
  OR COALESCE(candidate->>'flowEvidenceSha256','') !~ '^[a-f0-9]{64}$'
  OR candidate->>'expiresAt' IS NULL OR (candidate->>'expiresAt')::timestamptz<=clock_timestamp()
  OR (candidate->>'expiresAt')::timestamptz>clock_timestamp()+interval '15 minutes' THEN
  RAISE EXCEPTION 'Exact derived target review is unavailable' USING ERRCODE='55000';END IF;
 IF p.requested_mode='WASALX_MANAGED' AND (candidate->>'termsDocumentSha256' IS DISTINCT FROM approval.safe_metadata->>'targetTermsDocumentSha256'
  OR candidate->>'termsDocumentText' IS DISTINCT FROM approval.safe_metadata->>'targetTermsDocumentText'
  OR encode(public.digest(convert_to(candidate->>'termsDocumentText','UTF8'),'sha256'),'hex') IS DISTINCT FROM candidate->>'termsDocumentSha256') THEN
  RAISE EXCEPTION 'Target terms differ from the explicit transition grant' USING ERRCODE='23514';END IF;
 INSERT INTO public.platform_operations_audit_events(id,operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(receipt,operator_value,'meta.transition.target.simulated.reviewed','meta.account_transition',p.id::text,
  jsonb_build_object('tenantId',p.tenant_id,'transitionId',p.id,'targetAccountId',target.id,'migrationId',p.provider_migration_id,
   'scopeSha256',p.execution_scope_sha256,'originalAuthorizationId',approval.id,'observationOperationId',o.id,
   'review',candidate),request_value);
 RETURN jsonb_build_object('receiptId',receipt,'mode','SIMULATED');
END $$;
REVOKE ALL ON FUNCTION app.operator_review_meta_transition_target(uuid,uuid,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_review_meta_transition_target(uuid,uuid,jsonb,text,text) TO wasalx_platform_operations_client;

CREATE FUNCTION app.meta_transition_target_review(plan_value uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT e.safe_metadata||jsonb_build_object('receiptId',e.id) FROM public.meta_account_transitions p
 JOIN public.platform_operations_audit_events e ON e.action='meta.transition.target.simulated.reviewed' AND e.target_id=p.id::text
 WHERE p.tenant_id=app.current_tenant_id() AND p.id=plan_value AND e.safe_metadata->>'tenantId'=p.tenant_id::text
  AND e.safe_metadata->>'targetAccountId'=p.target_account_id::text AND e.safe_metadata->>'migrationId'=p.provider_migration_id
  AND e.safe_metadata->>'scopeSha256'=p.execution_scope_sha256
  AND e.safe_metadata->>'originalAuthorizationId'=p.execution_authorization_id::text
  AND (e.safe_metadata#>>'{review,expiresAt}')::timestamptz>clock_timestamp()
 ORDER BY e.created_at DESC,e.id DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.meta_transition_target_review(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_target_review(uuid) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;

CREATE FUNCTION app.establish_meta_transition_target_policy(plan_value uuid,operation_value uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;o public.connection_operations;initial public.connection_operations;
 original public.meta_provider_effect_checkpoints;target public.meta_messaging_accounts;approval public.platform_operations_audit_events;
 source_arrangement public.meta_funding_arrangement_versions;review jsonb;observed jsonb;funding jsonb;allocation jsonb;
 policy_value uuid:=gen_random_uuid();terms_value uuid;arrangement_value uuid;allocation_value uuid;authority_value uuid;scope_value jsonb;
BEGIN
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=operation_value;
 SELECT * INTO original FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=p.id AND stage='INITIATE';
 SELECT * INTO initial FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=original.original_operation_id;
 SELECT * INTO target FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=p.target_account_id FOR UPDATE NOWAIT;
 SELECT * INTO approval FROM public.platform_operations_audit_events WHERE id=p.execution_authorization_id;
 SELECT result->'metaTransitionObservation' INTO observed FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=p.provider_observation_operation_id;
 review:=app.meta_transition_target_review(p.id);funding:=observed->'fundingProof';allocation:=observed->'allocationProof';
 IF target.id IS NULL OR review IS NULL OR original.result->>'migrationId' IS DISTINCT FROM p.provider_migration_id
  OR original.outcome='REJECTED' OR initial.requested_by_type<>'USER' OR initial.requested_by_id IS DISTINCT FROM p.requested_by::text
  OR o.id IS DISTINCT FROM p.execution_operation_id OR o.payload#>>'{metaAccountTransitionExecution,action}'<>'RECONCILE'
  OR observed->>'status'<>'COMPLETED' OR observed#>>'{targetReadiness,payment}'<>'VERIFIED'
  OR funding->>'accountId' IS DISTINCT FROM target.provider_account_id OR funding->>'status'<>'PRESENT'
  OR (funding->>'expiresAt')::timestamptz<=clock_timestamp()
  OR (funding->>'observedAt')::timestamptz<clock_timestamp()-interval '5 minutes' THEN
  RAISE EXCEPTION 'Fresh derived target funding is required' USING ERRCODE='55000';END IF;
 IF target.requested_policy_version_id IS NOT NULL THEN
  RAISE EXCEPTION 'Derived target policy was already bound' USING ERRCODE='55000';END IF;
 IF p.requested_mode='WASALX_MANAGED' THEN
  SELECT * INTO source_arrangement FROM public.meta_funding_arrangement_versions WHERE tenant_id=p.tenant_id
   AND id=(approval.safe_metadata->>'arrangementVersionId')::uuid;
  IF source_arrangement.id IS NULL OR source_arrangement.state<>'APPROVED' OR source_arrangement.expires_at<=clock_timestamp()
   OR approval.safe_metadata->>'cloneFundingGrant'<>'EXACT_TRANSITION_DERIVED_TARGET'
   OR allocation->>'creditLineId' IS DISTINCT FROM approval.safe_metadata->>'creditLineId'
   OR allocation->>'receivingBusinessId' IS DISTINCT FROM approval.safe_metadata->>'targetReceivingBusinessId'
   OR allocation->>'receivingCredential' IS DISTINCT FROM funding->>'primaryFundingId'
   OR COALESCE(allocation->>'allocationConfigId','') !~ '^[0-9]{1,32}$'
   OR review#>>'{review,termsDocumentSha256}' IS DISTINCT FROM approval.safe_metadata->>'targetTermsDocumentSha256' THEN
   RAISE EXCEPTION 'Independent target funding grant and readback are required' USING ERRCODE='55000';END IF;
  terms_value:=gen_random_uuid();arrangement_value:=gen_random_uuid();allocation_value:=gen_random_uuid();authority_value:=gen_random_uuid();
  INSERT INTO public.platform_operations_audit_events(id,operator_subject,action,target_type,target_id,safe_metadata,request_id)
   VALUES(terms_value,approval.operator_subject,'meta.commercial_terms.simulated.versioned','meta.messaging_account',target.id::text,
    jsonb_build_object('schemaVersion',1,'tenantId',p.tenant_id,'accountId',target.id,'evidenceMode','SIMULATED',
     'documentSha256',approval.safe_metadata->>'targetTermsDocumentSha256','documentText',approval.safe_metadata->>'targetTermsDocumentText',
     'termsVersion',approval.safe_metadata->>'targetTermsVersion','derivedFromTransition',p.id,'originalAcceptanceOperationId',initial.id),o.request_id);
  scope_value:=jsonb_build_object('transitionId',p.id,'originalCheckpointId',original.id,'migrationId',p.provider_migration_id,
   'sourceAccountId',p.source_account_id,'targetAccountId',target.id,'providerTargetAccountId',target.provider_account_id,
   'approvalId',approval.id,'targetCurrency',p.target_currency,'creditLineId',allocation->>'creditLineId',
   'receivingBusinessId',allocation->>'receivingBusinessId','mode','SIMULATED');
  INSERT INTO public.platform_operations_audit_events(id,operator_subject,action,target_type,target_id,safe_metadata,request_id)
   VALUES(authority_value,approval.operator_subject,'meta.transition.target.funding.derived','meta.messaging_account',target.id::text,scope_value,o.request_id);
  INSERT INTO public.platform_operations_audit_events(id,operator_subject,action,target_type,target_id,safe_metadata,request_id)
   VALUES(allocation_value,approval.operator_subject,'meta.managed.allocation.verified','meta.messaging_account',target.id::text,
    jsonb_build_object('tenantId',p.tenant_id,'accountId',target.id,'arrangementVersionId',arrangement_value,'receivingCredential',allocation->>'receivingCredential',
     'allocationConfigId',allocation->>'allocationConfigId','evidenceMode','SIMULATED','transitionId',p.id,'observationOperationId',p.provider_observation_operation_id),o.request_id);  INSERT INTO public.meta_funding_arrangement_versions(id,tenant_id,account_id,family_id,version,kind,app_id,holder_business_id,credit_line_id,solution_id,
   receiving_business_id,financial_secret_reference,financial_credential_fingerprint,financial_credential_metadata,graph_version,requested_currency,evidence_mode,
   payer_authority_version_id,effective_scope_sha256,commercial_terms_version_id,allocation_line_version_id,allocation_observed_at,allocation_expires_at,approval_sha256,expires_at)
   VALUES(arrangement_value,p.tenant_id,target.id,arrangement_value,1,source_arrangement.kind,source_arrangement.app_id,
    source_arrangement.holder_business_id,allocation->>'creditLineId',source_arrangement.solution_id,allocation->>'receivingBusinessId',
    source_arrangement.financial_secret_reference,source_arrangement.financial_credential_fingerprint,source_arrangement.financial_credential_metadata,
    source_arrangement.graph_version,p.target_currency,'SIMULATED',authority_value,encode(public.digest(scope_value::text,'sha256'),'hex'),terms_value,
    allocation_value,(funding->>'observedAt')::timestamptz,(funding->>'expiresAt')::timestamptz,
    encode(public.digest(scope_value::text,'sha256'),'hex'),source_arrangement.expires_at);

 END IF;
 INSERT INTO public.meta_billing_policy_versions(id,tenant_id,account_id,version,mode,requested_by,idempotency_key,request_sha256,terms_version,
  commercial_terms_version_id,arrangement_version_id)
 VALUES(policy_value,p.tenant_id,target.id,1,CASE WHEN p.requested_mode='CUSTOMER' THEN 'CUSTOMER' ELSE 'MANAGED' END,
  p.requested_by,'meta-transition:'||p.id::text,encode(public.digest(jsonb_build_object('transitionId',p.id,'originalAcceptanceOperationId',initial.id,
   'targetAccountId',target.id,'mode',p.requested_mode,'currency',p.target_currency,'authorizationId',approval.id)::text,'sha256'),'hex'),
  CASE WHEN p.requested_mode='CUSTOMER' THEN 'META_CUSTOMER_PAYMENT_V1' ELSE 'META_MANAGED_PAYMENT_V1' END,terms_value,arrangement_value);
 UPDATE public.meta_messaging_accounts SET requested_policy_version_id=policy_value,active_policy_version_id=policy_value,
  funding_status='PRESENT',primary_funding_id=funding->>'primaryFundingId',observed_owner_business_id=funding->>'observedOwnerBusinessId',
  funding_response_sha256=funding->>'responseSha256',funding_observed_at=(funding->>'observedAt')::timestamptz,
  funding_expires_at=(funding->>'expiresAt')::timestamptz,last_observation_operation_id=p.provider_observation_operation_id,
  state='READY',authority_revision=authority_revision+1,updated_at=now() WHERE tenant_id=p.tenant_id AND id=target.id;
 RETURN policy_value;
END $$;
ALTER FUNCTION app.establish_meta_transition_target_policy(uuid,uuid) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.establish_meta_transition_target_policy(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION app.reconcile_meta_account_transition(operation_value uuid,lease_value uuid,fence_value bigint,app_value text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE o public.connection_operations;p public.meta_account_transitions;ctx jsonb;observed jsonb;asset jsonb;
 old_binding public.meta_connection_account_bindings;old_session public.provider_sessions;target public.meta_messaging_accounts;
 new_session uuid;new_binding uuid;proof jsonb;receipt jsonb;policy_value uuid;retained_scope jsonb;identity_reconciliation jsonb;observer jsonb;
BEGIN
 ctx:=app.meta_transition_operation_context(operation_value,lease_value,fence_value,app_value);
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id AND id=(ctx->>'transitionId')::uuid FOR UPDATE NOWAIT;
 IF o.payload#>>'{metaAccountTransitionExecution,action}'<>'RECONCILE' OR p.provider_status<>'COMPLETED'
  OR ctx#>>'{facts,scopeCurrent}' IS DISTINCT FROM 'true' OR ctx#>>'{facts,drainClear}' IS DISTINCT FROM 'true'
  OR p.identity_successor_receipt IS NOT NULL OR app.meta_transition_target_review(p.id) IS NULL THEN RETURN false;END IF;
 SELECT result->'metaTransitionObservation' INTO observed FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=p.provider_observation_operation_id;
 IF observed->>'status'<>'COMPLETED' OR observed->>'migrationId' IS DISTINCT FROM p.provider_migration_id
  OR (observed->>'observedAt')::timestamptz<clock_timestamp()-interval '5 minutes'
  OR observed#>>'{targetReadiness,assets}'<>'VERIFIED' OR observed#>>'{targetReadiness,payment}'<>'VERIFIED'
  OR observed#>>'{targetReadiness,templates}'<>'VERIFIED' OR observed#>>'{targetReadiness,continuity}'<>'SAME_GRAPH_PHONE_IDS'
  OR NOT EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints c WHERE c.tenant_id=p.tenant_id AND c.owner_kind='ACCOUNT_TRANSITION'
   AND c.owner_id=p.id AND c.stage='COMPLETE' AND c.outcome IN('ATTEMPTED','UNKNOWN','SUCCEEDED')) THEN RETURN false;END IF;
 SELECT * INTO target FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=p.target_account_id;
 IF target.provider_account_id IS DISTINCT FROM observed#>>'{destination,id}' OR target.state<>'HELD' THEN RETURN false;END IF;
 retained_scope:=p.execution_scope;
 policy_value:=app.establish_meta_transition_target_policy(p.id,o.id);
 FOR asset IN SELECT value FROM jsonb_array_elements(observed->'targetAssets') ORDER BY value->>'connectionId' LOOP
  SELECT * INTO old_binding FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=(asset->>'sourceBindingId')::uuid
   AND account_id=p.source_account_id AND state='ACTIVE' AND revision=(asset->>'sourceBindingRevision')::bigint FOR UPDATE NOWAIT;
  SELECT * INTO old_session FROM public.provider_sessions WHERE tenant_id=p.tenant_id AND id=old_binding.provider_session_id AND ownership_state='ACTIVE' FOR UPDATE NOWAIT;
  observer:=app.meta_transition_observer_credential(p.id,old_binding.id,(asset->>'observerOperationId')::uuid);
  IF NOT(asset ? 'observerOperationId') OR old_binding.id IS NULL OR old_session.id IS NULL OR old_binding.phone_number_id IS DISTINCT FROM asset->>'phoneNumberId'
   OR COALESCE(observer->>'secretReference',old_binding.secret_reference) IS DISTINCT FROM asset->>'secretReference'
   OR COALESCE(observer->>'credentialFingerprint',old_binding.credential_fingerprint) IS DISTINCT FROM asset->>'credentialFingerprint' THEN RAISE EXCEPTION 'Successor binding changed' USING ERRCODE='55000';END IF;
  new_session:=gen_random_uuid();new_binding:=gen_random_uuid();
  proof:=asset->'accountProof'||jsonb_build_object('providerSessionId',new_session);
  UPDATE public.meta_connection_account_bindings SET state='RETIRED',revision=revision+1,updated_at=now() WHERE tenant_id=p.tenant_id AND id=old_binding.id;
  UPDATE public.provider_sessions SET ownership_state='RETIRED',retired_at=now(),worker_id=NULL,lease_expires_at=NULL,updated_at=now()
   WHERE tenant_id=p.tenant_id AND id=old_session.id;
  INSERT INTO public.provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state,provider_state_data)
   VALUES(new_session,p.tenant_id,old_binding.connection_id,old_binding.phone_number_id,'PAUSED',old_session.session_storage_reference,'ACTIVE','PAUSED',
    jsonb_build_object('wabaId',target.provider_account_id,'metaAccountProof',proof,
     'metaAccountTransition',jsonb_build_object('id',p.id,'predecessorSessionId',old_session.id,'purpose','ACCOUNT_SUCCESSOR')));
  -- The binding guard checks the current connection reference in this transaction.
  UPDATE public.connections SET secret_reference=asset->>'secretReference',updated_at=now() WHERE tenant_id=p.tenant_id AND id=old_binding.connection_id;
  INSERT INTO public.meta_connection_account_bindings(id,tenant_id,account_id,connection_id,provider_session_id,phone_number_id,app_id,
   secret_reference,credential_fingerprint,proof_sha256,state,predecessor_binding_id,account_transition_id)
   VALUES(new_binding,p.tenant_id,target.id,old_binding.connection_id,new_session,old_binding.phone_number_id,old_binding.app_id,
    asset->>'secretReference',asset->>'credentialFingerprint',encode(public.digest(proof::text,'sha256'),'hex'),'HELD',old_binding.id,p.id);
 END LOOP;
 -- Companion appends validated aliases and lineage under the same transaction;
 -- failure rolls back target policy, all bindings and every session together.
 receipt:=app.apply_meta_account_identity_successor(p.id,o.id,lease_value,fence_value);
 IF receipt->>'claim' IS DISTINCT FROM 'SAME_GRAPH_PHONE_ACCOUNT_SUCCESSOR' THEN RAISE EXCEPTION 'Identity succession is not verified' USING ERRCODE='55000';END IF;
 UPDATE public.meta_account_transitions SET identity_successor_receipt=receipt,reconciled_at=clock_timestamp(),
  execution_state='RECONCILED_PAUSED',revision=revision+1,updated_at=now() WHERE tenant_id=p.tenant_id AND id=p.id;
 -- The sealed receipt is visible only within this still-open transaction. The
 -- companion may now settle complete signed metadata edges on the PAUSED target;
 -- failure rolls back receipt, aliases, funding policy and all bindings together.
 identity_reconciliation:=app.meta_account_transition_identity_reconciliation(p.id,o.id,lease_value,fence_value);
 IF identity_reconciliation->>'status' IS DISTINCT FROM 'SETTLED' THEN
  RAISE EXCEPTION 'Signed identity reconciliation is incomplete' USING ERRCODE='55000';END IF;
 UPDATE public.connection_operations SET result=jsonb_build_object('metaTransitionIdentityReconciliation',identity_reconciliation),updated_at=now()
  WHERE tenant_id=o.tenant_id AND id=o.id AND result IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original reconciliation result is already occupied' USING ERRCODE='55000';END IF;
 UPDATE public.meta_account_transition_reservations SET released_at=clock_timestamp(),release_reason='VERIFIED_SUCCESSOR',revision=revision+1
  WHERE tenant_id=p.tenant_id AND transition_id=p.id AND released_at IS NULL;
 -- Source account remains HELD; new session has no copied OWN/lifecycle grants.
 -- Target connections remain PAUSED. Current P07/P08 activation is separate.
 RETURN true;
END $$;
ALTER FUNCTION app.reconcile_meta_account_transition(uuid,uuid,bigint,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.reconcile_meta_account_transition(uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reconcile_meta_account_transition(uuid,uuid,bigint,text) TO wasalx_connector_worker;

-- P09 logical fragment: META_ADD_ACCESS_ACTIVATION.sql
-- Bound source SHA256: 18c9524ea0529f85cc7ffab4aef516889951936c35b3be5204bf3a45e88b673a
-- PRIVATE UNASSIGNED MIGRATION. Requires the delivered P05a2, P07 and P08
-- schemas; the integration owner assigns its contiguous unapplied ordinal.
-- No registration, subscription, credential or payer mutation is admitted here.

CREATE FUNCTION app.meta_add_access_activation_actor(actor_value uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
BEGIN
 IF app.lock_current_active_tenant_for_event_admission() IS NOT TRUE THEN RETURN false; END IF;
 PERFORM 1 FROM public.tenant_memberships member WHERE member.tenant_id=app.current_tenant_id()
  AND member.user_id=actor_value AND member.state='ACTIVE' AND member.role IN('tenant_owner','tenant_admin') FOR SHARE;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app.meta_add_access_activation_actor(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_add_access_activation_actor(uuid) TO wasalx_app,wasalx_connector_worker;

CREATE FUNCTION app.meta_add_access_activation_context(connection_value uuid,app_value text,runtime_value jsonb,operation_value uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE tenant_value uuid:=app.current_tenant_id();connection_row public.connections%ROWTYPE;
 session_row public.provider_sessions%ROWTYPE;binding_row public.meta_connection_account_bindings%ROWTYPE;
 account_row public.meta_messaging_accounts%ROWTYPE;review_row public.meta_routing_reviews%ROWTYPE;
 route_row public.webhook_routes%ROWTYPE;attempt_row public.meta_signup_attempts%ROWTYPE;
 lifecycle_row record;routing_row record;funding_row record;admission jsonb;proof jsonb;metadata jsonb;
BEGIN
 IF tenant_value IS NULL OR app.lock_current_active_tenant_for_event_admission() IS NOT TRUE
  OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||tenant_value::text,0))
  OR EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=tenant_value AND job_type='DELETE' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE'))
  THEN RETURN jsonb_build_object('applicable',true,'reason','PRIVACY_HOLD'); END IF;
 SELECT * INTO connection_row FROM public.connections WHERE tenant_id=tenant_value AND id=connection_value FOR UPDATE;
 IF NOT FOUND OR connection_row.provider<>'META' OR NOT app.meta_add_access_enrolled(tenant_value,connection_value)
  THEN RETURN jsonb_build_object('applicable',false,'reason','NOT_APPLICABLE'); END IF;
 IF connection_row.state<>'PAUSED' AND NOT(operation_value IS NOT NULL AND connection_row.state='WORKING')
  THEN RETURN jsonb_build_object('applicable',true,'reason','PAUSE_REQUIRED'); END IF;
 IF COALESCE(app_value,'')!~'^[0-9]{5,32}$' OR jsonb_typeof(runtime_value) IS DISTINCT FROM 'object'
  THEN RETURN jsonb_build_object('applicable',true,'reason','CREDENTIAL_REQUIRED'); END IF;
 -- Account before binding/session matches the existing P08 policy transaction.
 SELECT * INTO binding_row FROM public.meta_connection_account_bindings WHERE tenant_id=tenant_value AND connection_id=connection_value;
 IF NOT FOUND THEN RETURN jsonb_build_object('applicable',true,'reason','FUNDING_REQUIRED'); END IF;
 SELECT * INTO account_row FROM public.meta_messaging_accounts WHERE tenant_id=tenant_value AND id=binding_row.account_id FOR UPDATE;
 SELECT * INTO binding_row FROM public.meta_connection_account_bindings WHERE tenant_id=tenant_value AND connection_id=connection_value FOR SHARE;
 SELECT * INTO session_row FROM public.provider_sessions WHERE tenant_id=tenant_value AND connection_id=connection_value AND ownership_state='ACTIVE' FOR UPDATE;
 IF NOT FOUND OR session_row.provider_state_data#>>'{metaSignup,purpose}' IS DISTINCT FROM 'ADD_ACCESS'
  OR session_row.provider_state_data#>>'{metaSignup,attemptId}' !~ '^[0-9a-f-]{36}$'
  OR (session_row.state<>'PAUSED' AND NOT(operation_value IS NOT NULL AND session_row.state='WORKING'))
  OR session_row.id IS DISTINCT FROM binding_row.provider_session_id OR binding_row.state<>'ACTIVE'
  OR session_row.opaque_session_id IS DISTINCT FROM binding_row.phone_number_id
  OR session_row.provider_state_data->>'wabaId' IS DISTINCT FROM account_row.provider_account_id
  OR connection_row.secret_reference IS DISTINCT FROM binding_row.secret_reference OR binding_row.app_id IS DISTINCT FROM app_value
  THEN RETURN jsonb_build_object('applicable',true,'reason','SETUP_INCOMPLETE'); END IF;
 SELECT * INTO attempt_row FROM public.meta_signup_attempts WHERE tenant_id=tenant_value AND connection_id=connection_value
  AND id::text=session_row.provider_state_data#>>'{metaSignup,attemptId}' AND purpose='ADD_ACCESS' AND status='COMPLETED' FOR SHARE;
 IF NOT FOUND OR attempt_row.selected_choice->>'phoneId' IS DISTINCT FROM session_row.opaque_session_id
  OR attempt_row.selected_choice->>'wabaId' IS DISTINCT FROM account_row.provider_account_id
  OR attempt_row.selected_choice->>'mode' IS DISTINCT FROM 'STANDARD'
  OR attempt_row.selected_choice->>'numberState' IS DISTINCT FROM 'REGISTERED'
  THEN RETURN jsonb_build_object('applicable',true,'reason','SETUP_INCOMPLETE'); END IF;
 SELECT * INTO route_row FROM public.webhook_routes WHERE tenant_id=tenant_value AND connection_id=connection_value
  AND provider='META' AND external_key=session_row.opaque_session_id FOR UPDATE;
 IF NOT FOUND OR (route_row.state<>'PAUSED' AND NOT(operation_value IS NOT NULL AND route_row.state='ACTIVE'))
  THEN RETURN jsonb_build_object('applicable',true,'reason','SETUP_INCOMPLETE'); END IF;
 IF EXISTS(SELECT 1 FROM public.connection_operations operation WHERE operation.tenant_id=tenant_value AND operation.connection_id=connection_value
    AND operation.state IN('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE') AND operation.id IS DISTINCT FROM operation_value)
  OR EXISTS(SELECT 1 FROM public.delivery_outbox delivery WHERE delivery.tenant_id=tenant_value AND delivery.connection_id=connection_value
    AND (delivery.state IN('SENDING','OUTCOME_UNKNOWN') OR(delivery.state='CLAIMED' AND delivery.lease_expires_at>clock_timestamp())))
  THEN RETURN jsonb_build_object('applicable',true,'reason','CONNECTION_BUSY'); END IF;
 proof:=session_row.provider_state_data->'metaAccountProof';metadata:=proof->'credentialMetadata';
 IF proof->>'claim' IS DISTINCT FROM 'PHONE_ACCOUNT_RELATION_VERIFIED' OR proof->>'schemaVersion' IS DISTINCT FROM '1'
  OR proof->>'tenantId' IS DISTINCT FROM tenant_value::text OR proof->>'connectionId' IS DISTINCT FROM connection_value::text
  OR proof->>'providerSessionId' IS DISTINCT FROM session_row.id::text OR proof->>'phoneNumberId' IS DISTINCT FROM session_row.opaque_session_id
  OR proof->>'wabaId' IS DISTINCT FROM account_row.provider_account_id OR proof->>'secretReference' IS DISTINCT FROM connection_row.secret_reference
  OR proof->>'credentialFingerprint' IS DISTINCT FROM binding_row.credential_fingerprint
  OR proof->>'graphVersion' IS DISTINCT FROM runtime_value->>'graphVersion'
  OR metadata->>'claim' IS DISTINCT FROM 'CREDENTIAL_METADATA_VERIFIED' OR metadata->>'appId' IS DISTINCT FROM app_value
  OR metadata->'scopes' ?& ARRAY['whatsapp_business_management','whatsapp_business_messaging'] IS NOT TRUE
  OR (CASE WHEN jsonb_typeof(metadata->'expiresAt')='number' AND metadata->>'expiresAt'~'^[0-9]{1,15}$'
    THEN (metadata->>'expiresAt')::bigint<>0 AND (metadata->>'expiresAt')::bigint<=extract(epoch FROM clock_timestamp()) ELSE true END)
  OR (CASE WHEN NOT metadata ? 'dataAccessExpiresAt' THEN false
    WHEN jsonb_typeof(metadata->'dataAccessExpiresAt')='number' AND metadata->>'dataAccessExpiresAt'~'^[0-9]{1,15}$'
    THEN (metadata->>'dataAccessExpiresAt')::bigint<>0 AND (metadata->>'dataAccessExpiresAt')::bigint<=extract(epoch FROM clock_timestamp()) ELSE true END)
  THEN RETURN jsonb_build_object('applicable',true,'reason','CREDENTIAL_REQUIRED'); END IF;
 SELECT * INTO lifecycle_row FROM app.meta_lifecycle_guard(connection_value,session_row.id,session_row.opaque_session_id,account_row.provider_account_id,app_value,
  CASE WHEN session_row.provider_state_data#>>'{metaLifecycle,revision}'~'^[0-9]{1,15}$' THEN (session_row.provider_state_data#>>'{metaLifecycle,revision}')::bigint ELSE 0 END);
 IF lifecycle_row.revision_matches IS DISTINCT FROM true OR lifecycle_row.unresolved_hold IS DISTINCT FROM false OR lifecycle_row.blocked IS DISTINCT FROM false
  THEN RETURN jsonb_build_object('applicable',true,'reason','LIFECYCLE_HOLD'); END IF;
 SELECT * INTO review_row FROM public.meta_routing_reviews WHERE tenant_id=tenant_value AND connection_id=connection_value ORDER BY review_version DESC LIMIT 1 FOR SHARE;
 IF NOT FOUND OR review_row.disposition<>'REVIEWED' OR review_row.provider_session_id<>session_row.id
  OR review_row.phone_number_id<>session_row.opaque_session_id OR review_row.account_id<>account_row.provider_account_id
  OR review_row.app_id<>app_value OR review_row.runtime_binding IS DISTINCT FROM runtime_value
  OR review_row.configuration_version::text IS DISTINCT FROM session_row.provider_state_data#>>'{metaRouting,version}'
  THEN RETURN jsonb_build_object('applicable',true,'reason','ROUTING_REVIEW_REQUIRED'); END IF;
 -- NULL-participant routing admission alone misses other participants' effects.
 IF EXISTS(SELECT 1 FROM public.meta_thread_control_actions action WHERE action.tenant_id=tenant_value AND action.connection_id=connection_value
  AND action.provider_session_id=session_row.id AND action.phone_number_id=session_row.opaque_session_id
  AND action.account_id=account_row.provider_account_id AND action.app_id=app_value AND action.state IN('RUNNING','OUTCOME_UNKNOWN'))
  THEN RETURN jsonb_build_object('applicable',true,'reason','CONTROL_UNRESOLVED'); END IF;
 SELECT * INTO routing_row FROM app.meta_direct_routing_guard(connection_value,session_row.id,session_row.opaque_session_id,
  account_row.provider_account_id,NULL,app_value,runtime_value,NULL,NULL,NULL,false);
 IF routing_row.allowed IS DISTINCT FROM true OR routing_row.claim='LEGACY_COMPATIBILITY'
  OR routing_row.review_version IS DISTINCT FROM review_row.review_version
  THEN RETURN jsonb_build_object('applicable',true,'reason','ROUTING_REVIEW_REQUIRED'); END IF;
 SELECT * INTO funding_row FROM app.meta_billing_send_guard(connection_value,session_row.id,session_row.opaque_session_id,
  account_row.provider_account_id,account_row.authority_revision,binding_row.revision);
 IF funding_row.allowed IS DISTINCT FROM true OR funding_row.enrolled IS DISTINCT FROM true
  THEN RETURN jsonb_build_object('applicable',true,'reason','FUNDING_REQUIRED'); END IF;
 admission:=jsonb_build_object('schemaVersion',1,'providerSessionId',session_row.id,'phoneNumberId',session_row.opaque_session_id,
  'wabaId',account_row.provider_account_id,'secretReference',connection_row.secret_reference,'appId',app_value,'runtime',runtime_value,
  'proofSha256',encode(public.digest(proof::text,'sha256'),'hex'),'signupAttemptId',attempt_row.id,'accountId',account_row.id,'accountAuthorityRevision',account_row.authority_revision,
  'bindingId',binding_row.id,'bindingRevision',binding_row.revision,'policyVersionId',funding_row.policy_version_id,
  'configurationVersion',review_row.configuration_version,'reviewVersion',review_row.review_version,
  'lifecycleRevision',COALESCE(session_row.provider_state_data#>'{metaLifecycle,revision}','0'::jsonb));
 RETURN jsonb_build_object('applicable',true,'reason','READY_TO_CHECK','admission',admission,'credentialProof',proof,
  'contextVersion',encode(public.digest(admission::text,'sha256'),'hex'));
END $$;
REVOKE ALL ON FUNCTION app.meta_add_access_activation_context(uuid,text,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_add_access_activation_context(uuid,text,jsonb,uuid) TO wasalx_app,wasalx_connector_worker;

CREATE FUNCTION app.meta_add_access_activation_current(operation_value uuid,app_value text,runtime_value jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE operation_row public.connection_operations%ROWTYPE;context_value jsonb;
BEGIN
 SELECT * INTO operation_row FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 IF NOT FOUND OR operation_row.operation_type<>'START' OR operation_row.state NOT IN('QUEUED','RUNNING')
  OR operation_row.requested_by_type<>'USER' OR COALESCE(operation_row.requested_by_id,'')!~'^[0-9a-f-]{36}$'
  OR operation_row.payload#>>'{metaAddAccessActivation,appId}' IS DISTINCT FROM app_value
  OR operation_row.payload#>'{metaAddAccessActivation,runtime}' IS DISTINCT FROM runtime_value
  OR NOT app.meta_add_access_activation_actor(operation_row.requested_by_id::uuid) THEN RETURN false; END IF;
 context_value:=app.meta_add_access_activation_context(operation_row.connection_id,app_value,runtime_value,operation_value);
 RETURN context_value->>'reason'='READY_TO_CHECK' AND context_value->'admission'=operation_row.payload->'metaAddAccessActivation';
END $$;
REVOKE ALL ON FUNCTION app.meta_add_access_activation_current(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_add_access_activation_current(uuid,text,jsonb) TO wasalx_app,wasalx_connector_worker;

CREATE FUNCTION app.meta_add_access_activating(connection_value uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE operation_row public.connection_operations%ROWTYPE;
BEGIN
 FOR operation_row IN SELECT * FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value
  AND operation_type='START' AND state='RUNNING' AND lease_id IS NOT NULL AND lease_expires_at>clock_timestamp()
  AND payload ? 'metaAddAccessActivation' LOOP
  IF operation_row.result->'metaAddAccessActivated'='true'::jsonb
   AND operation_row.result#>'{providerReadback,registered}'='true'::jsonb AND operation_row.result#>'{providerReadback,subscribed}'='true'::jsonb
   AND operation_row.result#>>'{providerReadback,messaging}' IN('AVAILABLE','LIMITED')
   AND app.meta_add_access_activation_current(operation_row.id,operation_row.payload#>>'{metaAddAccessActivation,appId}',operation_row.payload#>'{metaAddAccessActivation,runtime}')
   THEN RETURN true; END IF;
 END LOOP;RETURN false;
END $$;
REVOKE ALL ON FUNCTION app.meta_add_access_activating(uuid) FROM PUBLIC;

CREATE FUNCTION app.preserve_meta_add_access_activation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE context_value jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT NEW.payload ? 'metaAddAccessActivation' THEN RETURN NEW; END IF;
  IF NEW.operation_type<>'START' OR NEW.state<>'QUEUED' OR NEW.requested_by_type<>'USER' OR NEW.result IS NOT NULL
   OR NEW.max_attempts<>1 OR NEW.requested_by_id!~'^[0-9a-f-]{36}$'
   OR NOT app.meta_add_access_activation_actor(NEW.requested_by_id::uuid)
   THEN RAISE EXCEPTION 'Activation requires its original local authority' USING ERRCODE='23514'; END IF;
  context_value:=app.meta_add_access_activation_context(NEW.connection_id,NEW.payload#>>'{metaAddAccessActivation,appId}',NEW.payload#>'{metaAddAccessActivation,runtime}');
  IF context_value->>'reason' IS DISTINCT FROM 'READY_TO_CHECK'
   OR context_value->'admission' IS DISTINCT FROM NEW.payload->'metaAddAccessActivation'
   OR context_value->>'contextVersion' IS DISTINCT FROM NEW.payload->>'metaAddAccessExpectedContextVersion'
   THEN RAISE EXCEPTION 'Activation context changed' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.payload ? 'metaAddAccessActivation' THEN RAISE EXCEPTION 'Activation history is retained' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF NOT OLD.payload ? 'metaAddAccessActivation' AND NOT NEW.payload ? 'metaAddAccessActivation' THEN RETURN NEW; END IF;
 IF (NEW.id,NEW.tenant_id,NEW.connection_id,NEW.operation_type,NEW.payload,NEW.requested_by_type,NEW.requested_by_id,NEW.idempotency_key,NEW.max_attempts)
  IS DISTINCT FROM(OLD.id,OLD.tenant_id,OLD.connection_id,OLD.operation_type,OLD.payload,OLD.requested_by_type,OLD.requested_by_id,OLD.idempotency_key,OLD.max_attempts)
  THEN RAISE EXCEPTION 'Activation admission is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.result IS DISTINCT FROM OLD.result AND NEW.result->'metaAddAccessActivated'='true'::jsonb THEN
  IF OLD.result IS NOT NULL OR OLD.state<>'RUNNING' OR OLD.lease_id IS NULL OR OLD.lease_expires_at<=clock_timestamp()
    OR NOT pg_has_role(current_user,'wasalx_connector_worker','MEMBER')
    OR NOT app.meta_add_access_activation_current(OLD.id,OLD.payload#>>'{metaAddAccessActivation,appId}',OLD.payload#>'{metaAddAccessActivation,runtime}')
    THEN RAISE EXCEPTION 'Activation readback requires the original current worker lease' USING ERRCODE='23514'; END IF;
 END IF;
 IF OLD.result->'metaAddAccessActivated'='true'::jsonb AND NEW.result IS DISTINCT FROM OLD.result
  THEN RAISE EXCEPTION 'Activation observation is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.preserve_meta_add_access_activation() FROM PUBLIC;
CREATE TRIGGER meta_saved_activation_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.connection_operations
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_add_access_activation();

-- Boundary and claim replacements are assembled from the exact P05a2 source.
-- They preserve enrollment/credential-write immutability and the existing drain.
-- No claim is allowed to turn provider reads into registration/subscription POSTs.
CREATE OR REPLACE FUNCTION app.meta_add_access_boundary() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE connection_value uuid; held boolean;
BEGIN
  IF TG_TABLE_NAME='connections' THEN connection_value:=NEW.id;
  ELSE connection_value:=NEW.connection_id; END IF;
  held:=app.meta_add_access_enrolled(NEW.tenant_id,connection_value);
  IF TG_TABLE_NAME='connection_operations' THEN
    IF TG_OP='UPDATE' AND OLD.payload->>'metaSignupPurpose'='ADD_ACCESS'
      AND (NEW.tenant_id,NEW.connection_id,NEW.operation_type,NEW.payload->>'metaSignupPurpose',NEW.payload->>'metaSignupAttemptId',NEW.payload->>'credentialReference')
        IS DISTINCT FROM (OLD.tenant_id,OLD.connection_id,OLD.operation_type,OLD.payload->>'metaSignupPurpose',OLD.payload->>'metaSignupAttemptId',OLD.payload->>'credentialReference') THEN
      RAISE EXCEPTION 'saved access operation binding is immutable' USING ERRCODE='23514';
    END IF;
    IF held AND NEW.operation_type IN ('PROVISION','START','RESTART','SYNC_GROUPS') AND NEW.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
      AND NOT(NEW.operation_type='START' AND NEW.payload ? 'metaAddAccessActivation') THEN
      RAISE EXCEPTION 'saved access requires separate activation' USING ERRCODE='23514';
    END IF;
    IF held AND NEW.operation_type IN ('DISCONNECT','ROTATE_META_CREDENTIAL') AND NEW.state IN ('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE')
      AND EXISTS (SELECT 1 FROM meta_signup_attempts WHERE tenant_id=NEW.tenant_id AND connection_id=connection_value AND purpose='ADD_ACCESS' AND status='PROVISIONING') THEN
      RAISE EXCEPTION 'saved access credential stage requires reconciliation or cancellation' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='provider_sessions' THEN
    IF TG_OP='UPDATE' AND OLD.provider_state_data->'metaSignup'->>'purpose'='ADD_ACCESS'
      AND NEW.provider_state_data->'metaSignup' IS DISTINCT FROM OLD.provider_state_data->'metaSignup' THEN
      RAISE EXCEPTION 'saved access enrollment is immutable' USING ERRCODE='23514';
    END IF;
    IF held AND NEW.state IN ('CONNECTING','WORKING','DEGRADED') AND (TG_OP='INSERT' OR OLD.state NOT IN('CONNECTING','WORKING','DEGRADED'))
      AND NOT app.meta_add_access_activating(connection_value) THEN
      RAISE EXCEPTION 'saved access session requires separate activation' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='connections' AND held AND NEW.state IN ('CONNECTING','WORKING','DEGRADED')
    AND OLD.state NOT IN('CONNECTING','WORKING','DEGRADED') AND NOT app.meta_add_access_activating(connection_value) THEN
    RAISE EXCEPTION 'saved access connection requires separate activation' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='webhook_routes' AND held AND NEW.state='ACTIVE' AND (TG_OP='INSERT' OR OLD.state<>'ACTIVE')
    AND NOT app.meta_add_access_activating(connection_value) THEN
    RAISE EXCEPTION 'saved access route requires separate activation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.claim_connection_operations(
  worker_lease uuid,
  claim_limit integer DEFAULT 25
)
RETURNS SETOF connection_operations
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp
AS $$
BEGIN
  IF worker_lease IS NULL THEN
    RAISE EXCEPTION 'worker lease is required' USING ERRCODE = '22023';
  END IF;
  IF claim_limit < 1 OR claim_limit > 100 THEN
    RAISE EXCEPTION 'claim limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;

  UPDATE connection_operations
     SET state = 'FAILED_TERMINAL',
         lease_id = NULL,
         lease_expires_at = NULL,
         error_code = COALESCE(error_code, 'MAX_ATTEMPTS_EXHAUSTED'),
         safe_error = COALESCE(safe_error, 'Connection operation exhausted its retry limit.'),
         completed_at = now(),
         updated_at = now()
   WHERE tenant_id = app.current_tenant_id()
     AND attempts >= max_attempts
     AND (
       state IN ('QUEUED','FAILED_RETRYABLE')
       OR (state = 'RUNNING' AND lease_expires_at < now())
     );

  RETURN QUERY
  UPDATE connection_operations AS operation
     SET lease_id = worker_lease,
         lease_expires_at = now() + interval '60 seconds',
         fencing_token = operation.fencing_token + 1,
         state = 'RUNNING',
         attempts = operation.attempts + 1,
         started_at = COALESCE(operation.started_at, now()),
         error_code = NULL,
         safe_error = NULL,
         updated_at = now()
   WHERE operation.id IN (
     SELECT candidate.id
       FROM connection_operations AS candidate
      WHERE candidate.tenant_id = app.current_tenant_id()
        AND candidate.attempts < candidate.max_attempts
        AND NOT (candidate.operation_type IN ('PROVISION','START','RESTART','SYNC_GROUPS')
          AND app.meta_add_access_activation_held(candidate.tenant_id,candidate.connection_id)
          AND NOT(candidate.operation_type='START' AND candidate.payload ? 'metaAddAccessActivation'))
        AND (
          (candidate.state IN ('QUEUED','FAILED_RETRYABLE') AND candidate.available_at <= now())
          OR (candidate.state = 'RUNNING' AND candidate.lease_expires_at < now())
        )
        AND (candidate.lease_expires_at IS NULL OR candidate.lease_expires_at < now())
        AND NOT EXISTS (
          SELECT 1 FROM connection_operations predecessor
           WHERE predecessor.tenant_id=candidate.tenant_id
             AND predecessor.connection_id=candidate.connection_id
             AND predecessor.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
             AND (predecessor.created_at,predecessor.id)<(candidate.created_at,candidate.id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM connection_operations sibling
           WHERE sibling.tenant_id=candidate.tenant_id
             AND sibling.connection_id=candidate.connection_id
             AND sibling.id<>candidate.id
             AND sibling.state='RUNNING'
             AND sibling.lease_expires_at>=now()
        )
        AND NOT (
          candidate.operation_type IN ('START','RESTART','PAUSE','DISCONNECT')
          AND (
            EXISTS (
              SELECT 1 FROM delivery_outbox delivery
               WHERE delivery.tenant_id=candidate.tenant_id
                 AND delivery.connection_id=candidate.connection_id
                 AND delivery.state='SENDING'
            )
            OR EXISTS (
              SELECT 1 FROM event_inbox event
               WHERE event.tenant_id=candidate.tenant_id
                 AND event.connection_id=candidate.connection_id
                 AND event.event_type<>'quarantine.reprocess'
                 AND event.status IN ('ACCEPTED','PROCESSING','FAILED_RETRYABLE')
                 AND event.received_at<=candidate.created_at
            )
          )
        )
      ORDER BY candidate.available_at,candidate.created_at,candidate.id
      FOR UPDATE SKIP LOCKED
      LIMIT claim_limit
   )
  RETURNING operation.*;
END;
$$;

-- P09 logical fragment: META_ACCOUNT_SUCCESSOR_ACTIVATION.sql
-- Bound source SHA256: 6abff2f4da85c2e0996fc3cd8cb04f0e012e7aaa75c9f4a41c348c9749fbd148
-- Extends the existing explicit saved-access activation path. No second UI,
-- registration, provider mutation, identity grant or routing ownership setter.
CREATE FUNCTION app.meta_account_successor_activation(connection_value uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT jsonb_build_object('transitionId',p.id,'sessionId',b.provider_session_id,
  'identityReceiptSha256',encode(public.digest(p.identity_successor_receipt::text,'sha256'),'hex'))
 FROM public.meta_connection_account_bindings b
 JOIN public.meta_account_transitions p ON p.tenant_id=b.tenant_id AND p.id=b.account_transition_id AND p.target_account_id=b.account_id
 JOIN public.meta_connection_account_bindings predecessor ON predecessor.tenant_id=b.tenant_id AND predecessor.id=b.predecessor_binding_id
 JOIN public.provider_sessions s ON s.tenant_id=b.tenant_id AND s.id=b.provider_session_id AND s.connection_id=b.connection_id
 WHERE b.tenant_id=app.current_tenant_id() AND b.connection_id=connection_value AND b.state<>'RETIRED'
  AND p.execution_state='RECONCILED_PAUSED' AND p.reconciled_at IS NOT NULL
  AND p.identity_successor_receipt->>'claim'='SAME_GRAPH_PHONE_ACCOUNT_SUCCESSOR'
  AND predecessor.state='RETIRED' AND predecessor.account_id=p.source_account_id
  AND predecessor.connection_id=b.connection_id AND predecessor.phone_number_id=b.phone_number_id
  AND predecessor.app_id=b.app_id AND s.ownership_state='ACTIVE' AND s.opaque_session_id=b.phone_number_id
  AND s.provider_state_data#>>'{metaAccountTransition,purpose}'='ACCOUNT_SUCCESSOR'
  AND s.provider_state_data#>>'{metaAccountTransition,id}'=p.id::text
$$;
REVOKE ALL ON FUNCTION app.meta_account_successor_activation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_account_successor_activation(uuid) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;
GRANT EXECUTE ON FUNCTION app.meta_add_access_activating(uuid),app.meta_add_access_activation_current(uuid,text,jsonb),
 app.meta_add_access_activation_actor(uuid),app.meta_account_payment_ready(uuid,text) TO wasalx_meta_transition_executor;
CREATE OR REPLACE FUNCTION app.meta_add_access_activation_context(connection_value uuid,app_value text,runtime_value jsonb,operation_value uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE tenant_value uuid:=app.current_tenant_id();connection_row public.connections%ROWTYPE;
 session_row public.provider_sessions%ROWTYPE;binding_row public.meta_connection_account_bindings%ROWTYPE;
 account_row public.meta_messaging_accounts%ROWTYPE;review_row public.meta_routing_reviews%ROWTYPE;
 route_row public.webhook_routes%ROWTYPE;attempt_row public.meta_signup_attempts%ROWTYPE;
 lifecycle_row record;routing_row record;funding_row record;admission jsonb;proof jsonb;metadata jsonb;successor jsonb;
BEGIN
 IF tenant_value IS NULL OR app.lock_current_active_tenant_for_event_admission() IS NOT TRUE
  OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||tenant_value::text,0))
  OR EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=tenant_value AND job_type='DELETE' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE'))
  THEN RETURN jsonb_build_object('applicable',true,'reason','PRIVACY_HOLD'); END IF;
 SELECT * INTO connection_row FROM public.connections WHERE tenant_id=tenant_value AND id=connection_value FOR UPDATE;
 successor:=app.meta_account_successor_activation(connection_value);
 IF NOT FOUND OR connection_row.provider<>'META' OR (NOT app.meta_add_access_enrolled(tenant_value,connection_value) AND successor IS NULL)
  THEN RETURN jsonb_build_object('applicable',false,'reason','NOT_APPLICABLE'); END IF;
 IF connection_row.state<>'PAUSED' AND NOT(operation_value IS NOT NULL AND connection_row.state='WORKING')
  THEN RETURN jsonb_build_object('applicable',true,'reason','PAUSE_REQUIRED'); END IF;
 IF COALESCE(app_value,'')!~'^[0-9]{5,32}$' OR jsonb_typeof(runtime_value) IS DISTINCT FROM 'object'
  THEN RETURN jsonb_build_object('applicable',true,'reason','CREDENTIAL_REQUIRED'); END IF;
 PERFORM app.assert_meta_connection_account_unreserved(connection_value);
 -- Shared reservation and exact current binding precede provider reads.
 SELECT * INTO binding_row FROM public.meta_connection_account_bindings WHERE tenant_id=tenant_value AND connection_id=connection_value AND state<>'RETIRED';
 IF NOT FOUND THEN RETURN jsonb_build_object('applicable',true,'reason','FUNDING_REQUIRED'); END IF;
 SELECT * INTO account_row FROM public.meta_messaging_accounts WHERE tenant_id=tenant_value AND id=binding_row.account_id FOR UPDATE;
 SELECT * INTO binding_row FROM public.meta_connection_account_bindings WHERE tenant_id=tenant_value AND connection_id=connection_value AND state<>'RETIRED' FOR SHARE;
 SELECT * INTO session_row FROM public.provider_sessions WHERE tenant_id=tenant_value AND connection_id=connection_value AND ownership_state='ACTIVE' FOR UPDATE;
 IF NOT FOUND OR (successor IS NULL AND (session_row.provider_state_data#>>'{metaSignup,purpose}' IS DISTINCT FROM 'ADD_ACCESS'
  OR session_row.provider_state_data#>>'{metaSignup,attemptId}' !~ '^[0-9a-f-]{36}$'))
  OR (successor IS NOT NULL AND successor->>'sessionId' IS DISTINCT FROM session_row.id::text)
  OR (session_row.state<>'PAUSED' AND NOT(operation_value IS NOT NULL AND session_row.state='WORKING'))
  OR session_row.id IS DISTINCT FROM binding_row.provider_session_id OR (binding_row.state<>'ACTIVE' AND NOT(successor IS NOT NULL AND binding_row.state='HELD'))
  OR session_row.opaque_session_id IS DISTINCT FROM binding_row.phone_number_id
  OR session_row.provider_state_data->>'wabaId' IS DISTINCT FROM account_row.provider_account_id
  OR connection_row.secret_reference IS DISTINCT FROM binding_row.secret_reference OR binding_row.app_id IS DISTINCT FROM app_value
  THEN RETURN jsonb_build_object('applicable',true,'reason','SETUP_INCOMPLETE'); END IF;
 IF successor IS NULL THEN
 SELECT * INTO attempt_row FROM public.meta_signup_attempts WHERE tenant_id=tenant_value AND connection_id=connection_value
  AND id::text=session_row.provider_state_data#>>'{metaSignup,attemptId}' AND purpose='ADD_ACCESS' AND status='COMPLETED' FOR SHARE;
 IF NOT FOUND OR attempt_row.selected_choice->>'phoneId' IS DISTINCT FROM session_row.opaque_session_id
  OR attempt_row.selected_choice->>'wabaId' IS DISTINCT FROM account_row.provider_account_id
  OR attempt_row.selected_choice->>'mode' IS DISTINCT FROM 'STANDARD'
  OR attempt_row.selected_choice->>'numberState' IS DISTINCT FROM 'REGISTERED'
  THEN RETURN jsonb_build_object('applicable',true,'reason','SETUP_INCOMPLETE'); END IF;
 END IF;
 SELECT * INTO route_row FROM public.webhook_routes WHERE tenant_id=tenant_value AND connection_id=connection_value
  AND provider='META' AND external_key=session_row.opaque_session_id FOR UPDATE;
 IF NOT FOUND OR (route_row.state<>'PAUSED' AND NOT(operation_value IS NOT NULL AND route_row.state='ACTIVE'))
  THEN RETURN jsonb_build_object('applicable',true,'reason','SETUP_INCOMPLETE'); END IF;
 IF EXISTS(SELECT 1 FROM public.connection_operations operation WHERE operation.tenant_id=tenant_value AND operation.connection_id=connection_value
    AND operation.state IN('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE') AND operation.id IS DISTINCT FROM operation_value)
  OR EXISTS(SELECT 1 FROM public.delivery_outbox delivery WHERE delivery.tenant_id=tenant_value AND delivery.connection_id=connection_value
    AND (delivery.state IN('SENDING','OUTCOME_UNKNOWN') OR(delivery.state='CLAIMED' AND delivery.lease_expires_at>clock_timestamp())))
  THEN RETURN jsonb_build_object('applicable',true,'reason','CONNECTION_BUSY'); END IF;
 proof:=session_row.provider_state_data->'metaAccountProof';metadata:=proof->'credentialMetadata';
 IF proof->>'claim' IS DISTINCT FROM 'PHONE_ACCOUNT_RELATION_VERIFIED' OR proof->>'schemaVersion' IS DISTINCT FROM '1'
  OR proof->>'tenantId' IS DISTINCT FROM tenant_value::text OR proof->>'connectionId' IS DISTINCT FROM connection_value::text
  OR proof->>'providerSessionId' IS DISTINCT FROM session_row.id::text OR proof->>'phoneNumberId' IS DISTINCT FROM session_row.opaque_session_id
  OR proof->>'wabaId' IS DISTINCT FROM account_row.provider_account_id OR proof->>'secretReference' IS DISTINCT FROM connection_row.secret_reference
  OR proof->>'credentialFingerprint' IS DISTINCT FROM binding_row.credential_fingerprint
  OR proof->>'graphVersion' IS DISTINCT FROM runtime_value->>'graphVersion'
  OR metadata->>'claim' IS DISTINCT FROM 'CREDENTIAL_METADATA_VERIFIED' OR metadata->>'appId' IS DISTINCT FROM app_value
  OR metadata->'scopes' ?& ARRAY['whatsapp_business_management','whatsapp_business_messaging'] IS NOT TRUE
  OR (CASE WHEN jsonb_typeof(metadata->'expiresAt')='number' AND metadata->>'expiresAt'~'^[0-9]{1,15}$'
    THEN (metadata->>'expiresAt')::bigint<>0 AND (metadata->>'expiresAt')::bigint<=extract(epoch FROM clock_timestamp()) ELSE true END)
  OR (CASE WHEN NOT metadata ? 'dataAccessExpiresAt' THEN false
    WHEN jsonb_typeof(metadata->'dataAccessExpiresAt')='number' AND metadata->>'dataAccessExpiresAt'~'^[0-9]{1,15}$'
    THEN (metadata->>'dataAccessExpiresAt')::bigint<>0 AND (metadata->>'dataAccessExpiresAt')::bigint<=extract(epoch FROM clock_timestamp()) ELSE true END)
  THEN RETURN jsonb_build_object('applicable',true,'reason','CREDENTIAL_REQUIRED'); END IF;
 SELECT * INTO lifecycle_row FROM app.meta_lifecycle_guard(connection_value,session_row.id,session_row.opaque_session_id,account_row.provider_account_id,app_value,
  CASE WHEN session_row.provider_state_data#>>'{metaLifecycle,revision}'~'^[0-9]{1,15}$' THEN (session_row.provider_state_data#>>'{metaLifecycle,revision}')::bigint ELSE 0 END);
 IF lifecycle_row.revision_matches IS DISTINCT FROM true OR lifecycle_row.unresolved_hold IS DISTINCT FROM false OR lifecycle_row.blocked IS DISTINCT FROM false
  THEN RETURN jsonb_build_object('applicable',true,'reason','LIFECYCLE_HOLD'); END IF;
 SELECT * INTO review_row FROM public.meta_routing_reviews WHERE tenant_id=tenant_value AND connection_id=connection_value ORDER BY review_version DESC LIMIT 1 FOR SHARE;
 IF NOT FOUND OR review_row.disposition<>'REVIEWED' OR review_row.provider_session_id<>session_row.id
  OR review_row.phone_number_id<>session_row.opaque_session_id OR review_row.account_id<>account_row.provider_account_id
  OR review_row.app_id<>app_value OR review_row.runtime_binding IS DISTINCT FROM runtime_value
  OR review_row.configuration_version::text IS DISTINCT FROM session_row.provider_state_data#>>'{metaRouting,version}'
  THEN RETURN jsonb_build_object('applicable',true,'reason','ROUTING_REVIEW_REQUIRED'); END IF;
 -- NULL-participant routing admission alone misses other participants' effects.
 IF EXISTS(SELECT 1 FROM public.meta_thread_control_actions action WHERE action.tenant_id=tenant_value AND action.connection_id=connection_value
  AND action.provider_session_id=session_row.id AND action.phone_number_id=session_row.opaque_session_id
  AND action.account_id=account_row.provider_account_id AND action.app_id=app_value AND action.state IN('RUNNING','OUTCOME_UNKNOWN'))
  THEN RETURN jsonb_build_object('applicable',true,'reason','CONTROL_UNRESOLVED'); END IF;
 SELECT * INTO routing_row FROM app.meta_direct_routing_guard(connection_value,session_row.id,session_row.opaque_session_id,
  account_row.provider_account_id,NULL,app_value,runtime_value,NULL,NULL,NULL,false);
 IF routing_row.allowed IS DISTINCT FROM true OR routing_row.claim='LEGACY_COMPATIBILITY'
  OR routing_row.review_version IS DISTINCT FROM review_row.review_version
  THEN RETURN jsonb_build_object('applicable',true,'reason','ROUTING_REVIEW_REQUIRED'); END IF;
 IF successor IS NOT NULL AND binding_row.state='HELD' THEN
  SELECT (account_row.state='READY' AND account_row.funding_status='PRESENT'
   AND account_row.funding_expires_at>clock_timestamp()
   AND account_row.requested_policy_version_id=account_row.active_policy_version_id
   AND app.meta_account_payment_ready(account_row.id,account_row.primary_funding_id)) AS allowed,
   true AS enrolled,account_row.active_policy_version_id AS policy_version_id INTO funding_row;
 ELSE
 SELECT * INTO funding_row FROM app.meta_billing_send_guard(connection_value,session_row.id,session_row.opaque_session_id,
  account_row.provider_account_id,account_row.authority_revision,binding_row.revision);
 END IF;
 IF funding_row.allowed IS DISTINCT FROM true OR funding_row.enrolled IS DISTINCT FROM true
  THEN RETURN jsonb_build_object('applicable',true,'reason','FUNDING_REQUIRED'); END IF;
 admission:=jsonb_build_object('schemaVersion',1,'providerSessionId',session_row.id,'phoneNumberId',session_row.opaque_session_id,
  'wabaId',account_row.provider_account_id,'secretReference',connection_row.secret_reference,'appId',app_value,'runtime',runtime_value,
  'proofSha256',encode(public.digest(proof::text,'sha256'),'hex'),'signupAttemptId',attempt_row.id,'setupPurpose',CASE WHEN successor IS NULL THEN 'ADD_ACCESS' ELSE 'ACCOUNT_SUCCESSOR' END,
  'accountTransitionId',successor->>'transitionId','identityReceiptSha256',successor->>'identityReceiptSha256','accountId',account_row.id,'accountAuthorityRevision',account_row.authority_revision,
  'bindingId',binding_row.id,'bindingRevision',binding_row.revision,'policyVersionId',funding_row.policy_version_id,
  'configurationVersion',review_row.configuration_version,'reviewVersion',review_row.review_version,
  'lifecycleRevision',COALESCE(session_row.provider_state_data#>'{metaLifecycle,revision}','0'::jsonb));
 RETURN jsonb_build_object('applicable',true,'reason','READY_TO_CHECK','admission',admission,'credentialProof',proof,
  'contextVersion',encode(public.digest(admission::text,'sha256'),'hex'));
END $$;
REVOKE ALL ON FUNCTION app.meta_add_access_activation_context(uuid,text,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_add_access_activation_context(uuid,text,jsonb,uuid) TO wasalx_app,wasalx_connector_worker;


CREATE FUNCTION app.complete_meta_successor_activation(operation_value uuid,lease_value uuid,fence_value bigint) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE o public.connection_operations;b public.meta_connection_account_bindings;
BEGIN
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 IF o.id IS NULL OR o.payload#>>'{metaAddAccessActivation,setupPurpose}' IS DISTINCT FROM 'ACCOUNT_SUCCESSOR'
  OR o.state<>'RUNNING' OR o.lease_id IS DISTINCT FROM lease_value OR o.fencing_token IS DISTINCT FROM fence_value
  OR o.lease_expires_at<=clock_timestamp() OR o.result->'metaAddAccessActivated' IS DISTINCT FROM 'true'::jsonb
  OR NOT app.meta_add_access_activating(o.connection_id)
  OR NOT EXISTS(SELECT 1 FROM public.connections WHERE tenant_id=o.tenant_id AND id=o.connection_id AND state='WORKING')
  THEN RETURN false;END IF;
 SELECT * INTO b FROM public.meta_connection_account_bindings WHERE tenant_id=o.tenant_id AND connection_id=o.connection_id AND state<>'RETIRED' FOR UPDATE NOWAIT;
 IF b.id::text IS DISTINCT FROM o.payload#>>'{metaAddAccessActivation,bindingId}' OR b.state<>'HELD'
  OR b.revision::text IS DISTINCT FROM o.payload#>>'{metaAddAccessActivation,bindingRevision}' THEN RETURN false;END IF;
 UPDATE public.meta_connection_account_bindings SET state='ACTIVE',revision=revision+1,updated_at=now() WHERE tenant_id=b.tenant_id AND id=b.id;
 RETURN true;
END $$;
ALTER FUNCTION app.complete_meta_successor_activation(uuid,uuid,bigint) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.complete_meta_successor_activation(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_meta_successor_activation(uuid,uuid,bigint) TO wasalx_connector_worker;

CREATE FUNCTION app.guard_meta_successor_activation() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE connection_value uuid;
BEGIN
 IF TG_TABLE_NAME='connections' THEN connection_value:=NEW.id;
 ELSIF TG_TABLE_NAME IN('provider_sessions','connection_operations') THEN connection_value:=NEW.connection_id;
 ELSE RAISE EXCEPTION 'Unexpected successor activation relation' USING ERRCODE='23514';END IF;
 IF connection_value IS NULL THEN RAISE EXCEPTION 'Successor connection is required' USING ERRCODE='23514';END IF;
 -- Unrelated operation inserts and non-activation updates need no successor authority.
 IF TG_TABLE_NAME='connection_operations' THEN
  IF NEW.operation_type NOT IN('START','RESTART') THEN RETURN NEW;END IF;
 ELSIF NEW.state IS DISTINCT FROM 'WORKING' OR OLD.state IS NOT DISTINCT FROM NEW.state THEN RETURN NEW;
 END IF;
 IF app.meta_account_successor_activation(connection_value) IS NULL THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='connection_operations' THEN
  IF TG_OP='INSERT' AND NEW.operation_type IN('START','RESTART') AND NOT NEW.payload ? 'metaAddAccessActivation'
   THEN RAISE EXCEPTION 'Successor requires explicit activation' USING ERRCODE='55000';END IF;
 ELSIF NEW.state='WORKING' AND OLD.state IS DISTINCT FROM NEW.state
  AND EXISTS(SELECT 1 FROM public.meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value AND state='HELD')
  AND NOT app.meta_add_access_activating(connection_value) THEN RAISE EXCEPTION 'Successor activation is not current' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_meta_successor_activation() FROM PUBLIC;
CREATE TRIGGER meta_successor_connection_activation BEFORE UPDATE ON public.connections FOR EACH ROW EXECUTE FUNCTION app.guard_meta_successor_activation();
CREATE TRIGGER meta_successor_session_activation BEFORE UPDATE ON public.provider_sessions FOR EACH ROW EXECUTE FUNCTION app.guard_meta_successor_activation();
CREATE TRIGGER meta_successor_operation_activation BEFORE INSERT ON public.connection_operations FOR EACH ROW EXECUTE FUNCTION app.guard_meta_successor_activation();

-- P09 logical fragment: META_ACCOUNT_TRANSITION_REQUESTS.sql
-- Bound source SHA256: 690c339314762e9ad6f7baf16a1bc828599da379242a8f4682ccb6111178362a
-- Unapplied; append after execution columns and before effect functions are used.
CREATE FUNCTION app.lock_meta_transition_request(key_value text) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR COALESCE(key_value,'') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' THEN
  RAISE EXCEPTION 'Invalid transition request key' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('meta-transition-request:'||app.current_tenant_id()::text||':'||key_value,0));
END $$;
REVOKE ALL ON FUNCTION app.lock_meta_transition_request(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_meta_transition_request(text) TO wasalx_meta_transition_executor;

CREATE FUNCTION app.resolve_meta_transition_request(plan_value uuid,connection_value uuid,actor_value uuid,revision_value bigint,
 preview_sha text,key_value text,action_value text,request_value text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;o public.connection_operations;duplicate_value boolean;
BEGIN
 PERFORM app.meta_transition_actor_current(actor_value);
 PERFORM app.lock_meta_transition_request(key_value);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value
  AND initiating_connection_id=connection_value;
 IF p.id IS NULL OR COALESCE(action_value,'') NOT IN('INITIATE','COMPLETE','OBSERVE','RECONCILE')
  OR revision_value IS NULL OR revision_value NOT BETWEEN 1 AND 9007199254740991 OR COALESCE(preview_sha,'') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Transition request is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=p.tenant_id AND idempotency_key=key_value FOR SHARE;
 duplicate_value:=FOUND;
 IF duplicate_value THEN
  IF o.operation_type IS DISTINCT FROM 'EXECUTE_META_ACCOUNT_TRANSITION' OR o.connection_id IS DISTINCT FROM connection_value
   OR o.requested_by_type IS DISTINCT FROM 'USER' OR o.requested_by_id IS DISTINCT FROM actor_value::text
   OR o.payload#>>'{metaAccountTransitionExecution,id}' IS DISTINCT FROM p.id::text
   OR o.payload#>>'{metaAccountTransitionExecution,action}' IS DISTINCT FROM action_value
   OR o.payload#>>'{metaAccountTransitionExecution,requestRevision}' IS DISTINCT FROM revision_value::text
   OR o.payload#>>'{metaAccountTransitionExecution,requestPreviewSha256}' IS DISTINCT FROM preview_sha THEN
   RAISE EXCEPTION 'Request key belongs to another intent' USING ERRCODE='23514';END IF;
 ELSE
  -- This is local terminal evidence, not cancellation of an admitted operation.
  -- It has no plan-current pointer, reservation, provider slot or wake event.
  INSERT INTO public.connection_operations(tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,
   requested_by_id,request_id,max_attempts,state,completed_at,result)
  VALUES(p.tenant_id,connection_value,'EXECUTE_META_ACCOUNT_TRANSITION',key_value,
   jsonb_build_object('metaAccountTransitionExecution',jsonb_build_object('id',p.id,'action',action_value,
    'requestRevision',revision_value,'requestPreviewSha256',preview_sha,'localResolution','NO_ADMISSION')),
   'USER',actor_value::text,request_value,1,'CANCELLED',clock_timestamp(),jsonb_build_object('metaTransitionResolution','NOT_ADMITTED')) RETURNING * INTO o;
 END IF;
 -- Never alter an admitted operation, including a terminal UNKNOWN outcome.
 RETURN jsonb_build_object('id',p.id,'operationId',o.id,'duplicate',duplicate_value,
  'pendingAction',jsonb_build_object('operationId',o.id,'requestKey',o.idempotency_key,'action',action_value,'requestRevision',revision_value,
   'state',CASE WHEN o.state='FAILED_RETRYABLE' THEN 'FAILED_TERMINAL' ELSE o.state END));
END $$;
ALTER FUNCTION app.resolve_meta_transition_request(uuid,uuid,uuid,bigint,text,text,text,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.resolve_meta_transition_request(uuid,uuid,uuid,bigint,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_meta_transition_request(uuid,uuid,uuid,bigint,text,text,text,text) TO wasalx_app;

CREATE FUNCTION app.finish_meta_transition_operation(operation_value uuid,lease_value uuid,fence_value bigint,succeeded boolean)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 UPDATE public.connection_operations SET state=CASE WHEN succeeded THEN 'SUCCEEDED' ELSE 'FAILED_TERMINAL' END,
  result=COALESCE(result,jsonb_build_object('metaTransitionExecution',CASE WHEN succeeded THEN 'RECORDED' ELSE 'HELD' END)),
  error_code=CASE WHEN succeeded THEN NULL ELSE 'META_TRANSITION_HELD' END,
  safe_error=CASE WHEN succeeded THEN NULL ELSE 'Review the original transition and its current prerequisites.' END,
  lease_id=NULL,lease_expires_at=NULL,completed_at=clock_timestamp(),updated_at=now()
 WHERE tenant_id=app.current_tenant_id() AND id=operation_value AND operation_type='EXECUTE_META_ACCOUNT_TRANSITION'
  AND state='RUNNING' AND lease_id=lease_value AND fencing_token=fence_value AND lease_expires_at>=clock_timestamp();
 RETURN FOUND;
END $$;
ALTER FUNCTION app.finish_meta_transition_operation(uuid,uuid,bigint,boolean) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.finish_meta_transition_operation(uuid,uuid,bigint,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.finish_meta_transition_operation(uuid,uuid,bigint,boolean) TO wasalx_connector_worker;

CREATE FUNCTION app.preserve_meta_transition_execution_operation() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.operation_type='EXECUTE_META_ACCOUNT_TRANSITION' AND current_user<>'wasalx_meta_transition_executor' THEN
   RAISE EXCEPTION 'Execution requires sealed transition admission' USING ERRCODE='42501';END IF;RETURN NEW;
 END IF;
 IF OLD.operation_type<>'EXECUTE_META_ACCOUNT_TRANSITION' THEN
  IF TG_OP='UPDATE' AND NEW.operation_type='EXECUTE_META_ACCOUNT_TRANSITION' THEN RAISE EXCEPTION 'Operation kind is immutable' USING ERRCODE='23514';END IF;
  RETURN COALESCE(NEW,OLD);
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Original transition operation is retained' USING ERRCODE='55000';END IF;
 IF (NEW.id,NEW.tenant_id,NEW.connection_id,NEW.operation_type,NEW.idempotency_key,NEW.payload,NEW.requested_by_id,NEW.requested_by_type,NEW.max_attempts)
  IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.connection_id,OLD.operation_type,OLD.idempotency_key,OLD.payload,OLD.requested_by_id,OLD.requested_by_type,OLD.max_attempts) THEN
  RAISE EXCEPTION 'Original transition operation is immutable' USING ERRCODE='23514';END IF;
 IF OLD.state IN('SUCCEEDED','FAILED_TERMINAL','CANCELLED') AND NEW.state<>OLD.state THEN
  RAISE EXCEPTION 'Terminal transition operation cannot dispatch again' USING ERRCODE='23514';END IF;
 IF NEW.result IS DISTINCT FROM OLD.result THEN
  IF OLD.result IS NOT NULL AND NEW.result=jsonb_build_object('redacted',true,'sha256',encode(public.digest(OLD.result::text,'sha256'),'hex'))
   AND EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=OLD.tenant_id AND scope_type='TENANT' AND scope_value=OLD.tenant_id::text
    AND job_type='DELETE' AND stage='LOCAL' AND state='RUNNING' AND lease_id IS NOT NULL AND lease_expires_at>=clock_timestamp()) THEN RETURN NEW;END IF;
  IF current_user<>'wasalx_meta_transition_executor' OR OLD.result IS NOT NULL THEN
   RAISE EXCEPTION 'Transition observation requires its exact sealed lease' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.preserve_meta_transition_execution_operation() FROM PUBLIC;
CREATE TRIGGER meta_transition_execution_operation_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.connection_operations
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_transition_execution_operation();

-- P09 logical fragment: META_ACCOUNT_TRANSITION_PRIVACY.sql
-- Bound source SHA256: e7ef962df69004329ce4620ecd844dad2c699c3a4305a77f1d65f159e868a3d1
CREATE FUNCTION app.redact_meta_transition_private_scope(job_value uuid,lease_value uuid,fence_value bigint) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE count_value integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=app.current_tenant_id() AND id=job_value
  AND job_type='DELETE' AND scope_type='TENANT' AND scope_value=app.current_tenant_id()::text
  AND stage='LOCAL' AND state='RUNNING' AND lease_id=lease_value AND fencing_token=fence_value AND lease_expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'Current local privacy authority is required' USING ERRCODE='42501';END IF;
 UPDATE public.meta_account_transitions SET execution_scope=jsonb_build_object('redacted',true,'sha256',encode(public.digest(execution_scope::text,'sha256'),'hex')),updated_at=now()
  WHERE tenant_id=app.current_tenant_id() AND execution_scope IS NOT NULL AND NOT(execution_scope ? 'redacted');
 GET DIAGNOSTICS count_value=ROW_COUNT;
 -- Scope/checkpoint IDs and unresolved outcomes remain immutable replay barriers.
 -- No reservation is released and no provider effect is described as cancelled.
 RETURN count_value;
END $$;
ALTER FUNCTION app.redact_meta_transition_private_scope(uuid,uuid,bigint) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.redact_meta_transition_private_scope(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.redact_meta_transition_private_scope(uuid,uuid,bigint) TO wasalx_connector_worker;

-- Extend the existing LOCAL tenant-delete surface. The executor is ungranted;
-- application/worker direct updates cannot impersonate this finite function.
-- Identity companion supplies the already-reviewed finite tenant-RLS hold
-- reader grants. Only this existing privacy predicate needs another caller;
-- do not widen table access or give either runtime role executor membership.
GRANT EXECUTE ON FUNCTION app.meta_managed_privacy_authorized(uuid) TO wasalx_meta_transition_executor;
CREATE FUNCTION app.redact_meta_transition_observer_proofs(job_value uuid,lease_value uuid,fence_value bigint) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE count_value integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||app.current_tenant_id()::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=app.current_tenant_id() AND id=job_value
  AND job_type='DELETE' AND scope_type='TENANT' AND scope_value=app.current_tenant_id()::text
  AND stage='LOCAL' AND state='RUNNING' AND lease_id=lease_value AND fencing_token=fence_value AND lease_expires_at>clock_timestamp())
  OR NOT app.meta_managed_privacy_authorized(app.current_tenant_id()) THEN
  RAISE EXCEPTION 'Current settled local privacy authority is required' USING ERRCODE='42501';END IF;
 -- Selected unresolved observers and every uncertain checkpoint remain intact.
 -- A tenant erase cannot silently settle or release an account transition.
 IF EXISTS(SELECT 1 FROM public.connection_operations observer
  JOIN public.meta_signup_attempts attempt ON attempt.tenant_id=observer.tenant_id AND attempt.operation_id=observer.id
  JOIN public.meta_account_transitions transition ON transition.tenant_id=attempt.tenant_id AND transition.id=attempt.target_transition_id
  WHERE observer.tenant_id=app.current_tenant_id() AND attempt.purpose='TRANSITION_READBACK'
   AND observer.result ? 'metaTransitionObserverProof' AND NOT(observer.result->'metaTransitionObserverProof' ? 'redacted')
   AND EXISTS(SELECT 1 FROM public.meta_account_transition_reservations reservation
    WHERE reservation.tenant_id=transition.tenant_id AND reservation.transition_id=transition.id AND reservation.released_at IS NULL)) THEN
  RAISE EXCEPTION 'Unresolved transition retains observer evidence' USING ERRCODE='55000';END IF;
 UPDATE public.connection_operations SET result=jsonb_set(result,'{metaTransitionObserverProof}',
  jsonb_build_object('redacted',true,'sha256',encode(public.digest((result->'metaTransitionObserverProof')::text,'sha256'),'hex')))
 WHERE tenant_id=app.current_tenant_id() AND operation_type='ROTATE_META_CREDENTIAL' AND state='SUCCEEDED'
  AND payload ? 'metaTransitionReadback' AND result ? 'metaTransitionObserverProof'
  AND NOT(result->'metaTransitionObserverProof' ? 'redacted');
 GET DIAGNOSTICS count_value=ROW_COUNT;
 RETURN count_value;
END $$;
ALTER FUNCTION app.redact_meta_transition_observer_proofs(uuid,uuid,bigint) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.redact_meta_transition_observer_proofs(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.redact_meta_transition_observer_proofs(uuid,uuid,bigint) TO wasalx_connector_worker;

-- P09 logical fragment: META_ACCOUNT_TRANSITION_SECRET_RETENTION.sql
-- Bound source SHA256: 5537e71729edf4364fe73a63bdce11f33ec5c430d38dc828b0a67e8f050879f6
-- Unapplied P09 observer extension to the reviewed P05 cleanup SSOT.
-- Preserve role ownership and ACLs; apply after P05/observer tables.
-- No broad operation-payload or transition-table grant to the cleanup login.
-- Only its existing ungranted executor can read this exact-owner hold predicate.
CREATE FUNCTION app.meta_transition_observer_secret_retained(tenant_value uuid,connection_value uuid,operation_value uuid,reference_value text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM public.connection_operations observer
          JOIN public.meta_signup_attempts attempt ON attempt.tenant_id=observer.tenant_id AND attempt.operation_id=observer.id
          JOIN public.meta_account_transitions transition ON transition.tenant_id=attempt.tenant_id AND transition.id=attempt.target_transition_id
          WHERE observer.tenant_id=tenant_value
            AND observer.id=operation_value AND observer.connection_id=connection_value
            AND observer.payload->>'newSecretReference'=reference_value
            AND attempt.purpose='TRANSITION_READBACK' AND (
              (EXISTS(SELECT 1 FROM jsonb_each_text(transition.observer_operations) selected WHERE selected.value=observer.id::text)
               AND EXISTS(SELECT 1 FROM public.meta_account_transition_reservations reservation
                WHERE reservation.tenant_id=transition.tenant_id AND reservation.transition_id=transition.id AND reservation.released_at IS NULL))
              OR EXISTS(SELECT 1 FROM public.connection_operations original
               JOIN public.meta_provider_effect_checkpoints checkpoint ON checkpoint.tenant_id=original.tenant_id AND checkpoint.original_operation_id=original.id
               WHERE original.tenant_id=observer.tenant_id AND checkpoint.owner_kind='ACCOUNT_TRANSITION' AND checkpoint.owner_id=transition.id
                AND checkpoint.outcome IN('ATTEMPTED','UNKNOWN') AND EXISTS(
                 SELECT 1 FROM jsonb_each_text(original.payload#>'{metaAccountTransitionExecution,observerOperationIds}') selected
                  WHERE selected.value=observer.id::text))
            ));
$$;
REVOKE ALL ON FUNCTION app.meta_transition_observer_secret_retained(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_observer_secret_retained(uuid,uuid,uuid,text) TO wasalx_secret_cleanup_executor;

CREATE OR REPLACE FUNCTION app.expire_secret_provisioning_stages()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE candidate record;prior_tenant text:=current_setting('app.tenant_id',true);
BEGIN
  -- A removed actor or stale target may need operator review. This finite status
  -- is evidence of a retained stage, not evidence of absence or permission to delete.
  UPDATE connection_operations SET error_code='META_SIGNUP_STAGE_REVIEW_REQUIRED',
    safe_error='Review or cancel this retained account access stage after confirming its exact credential state.',updated_at=clock_timestamp()
    WHERE id IN (SELECT id FROM connection_operations WHERE state='STAGED'
      AND payload->>'metaSignupPurpose' IN ('RECONNECT','ADD_ACCESS','TRANSITION_READBACK') AND updated_at<=clock_timestamp()-interval '1 hour'
      AND error_code IS DISTINCT FROM 'META_SIGNUP_STAGE_REVIEW_REQUIRED'
      ORDER BY updated_at,id LIMIT 100 FOR UPDATE SKIP LOCKED);
  FOR candidate IN
    SELECT operation.id,operation.tenant_id,operation.connection_id,
           operation.operation_type,operation.requested_by_id,operation.request_id
      FROM connection_operations operation
     WHERE operation.state='STAGED'
       AND COALESCE(operation.payload->>'metaSignupPurpose','') NOT IN ('RECONNECT','ADD_ACCESS','TRANSITION_READBACK')
       AND operation.updated_at<=clock_timestamp()-interval '1 hour'
     ORDER BY operation.updated_at,operation.id
     FOR UPDATE SKIP LOCKED
     LIMIT 100
  LOOP
    -- Bind only the selected maintenance row; restore the caller context before the next candidate.
    PERFORM set_config('app.tenant_id',candidate.tenant_id::text,true);
    UPDATE connection_operations
       SET state='FAILED_TERMINAL',error_code='CREDENTIAL_STAGE_EXPIRED',
           safe_error='Credential provisioning expired before it completed.',
           completed_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE tenant_id=candidate.tenant_id AND id=candidate.id AND state='STAGED';
    IF FOUND THEN
      IF candidate.operation_type='PROVISION' THEN
        UPDATE connections
           SET state='REVOKED',action_reason='Credential provisioning expired.',
               updated_at=clock_timestamp()
         WHERE tenant_id=candidate.tenant_id AND id=candidate.connection_id
           AND state='PROVISIONING';
        UPDATE webhook_routes
           SET state='REVOKED',updated_at=clock_timestamp()
         WHERE tenant_id=candidate.tenant_id AND connection_id=candidate.connection_id
           AND state<>'REVOKED';
      END IF;
      INSERT INTO audit_events(
        tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id
      ) VALUES (
        candidate.tenant_id,'SYSTEM','secret-cleanup','connection.credential_stage_expired',
        'connection',candidate.connection_id::text,
        jsonb_build_object('operation_id',candidate.id,'operation_type',candidate.operation_type),
        candidate.request_id
      );
    END IF;
    PERFORM set_config('app.tenant_id',COALESCE(prior_tenant,''),true);
  END LOOP;

  FOR candidate IN
    SELECT integration.id,integration.tenant_id
      FROM client_routing_integrations integration
     WHERE integration.state='CONNECTING'
       AND integration.updated_at<=clock_timestamp()-interval '1 hour'
     ORDER BY integration.updated_at,integration.id
     FOR UPDATE SKIP LOCKED
     LIMIT 100
  LOOP
    -- Bind only the selected maintenance row; restore the caller context before the next candidate.
    PERFORM set_config('app.tenant_id',candidate.tenant_id::text,true);
    UPDATE client_routing_integrations
       SET state='REVOKED',revision=revision+1,updated_at=clock_timestamp()
     WHERE tenant_id=candidate.tenant_id AND id=candidate.id AND state='CONNECTING';
    IF FOUND THEN
      INSERT INTO audit_events(
        tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id
      ) VALUES (
        candidate.tenant_id,'SYSTEM','secret-cleanup','client_routing.integration_expired',
        'client_routing_integration',candidate.id::text,
        jsonb_build_object('reason','CREDENTIAL_STAGE_EXPIRED'),
        'secret-cleanup:'||candidate.id::text
      );
    END IF;
    PERFORM set_config('app.tenant_id',COALESCE(prior_tenant,''),true);
  END LOOP;
END
$$;

-- Preserve legal holds for all rotation-owned references before claim selection.
CREATE OR REPLACE FUNCTION app.claim_secret_cleanup_tasks(
  worker_lease uuid,
  claim_limit integer DEFAULT 25
)
RETURNS TABLE (
  task_id uuid,
  tenant_id uuid,
  secret_reference text,
  attempts integer,
  max_attempts integer,
  fencing_token bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp
SET row_security=off
AS $$
BEGIN
  IF worker_lease IS NULL THEN
    RAISE EXCEPTION 'worker lease is required' USING ERRCODE='22023';
  END IF;
  IF claim_limit<1 OR claim_limit>100 THEN
    RAISE EXCEPTION 'claim limit must be between 1 and 100' USING ERRCODE='22023';
  END IF;

  PERFORM app.expire_secret_provisioning_stages();
  PERFORM app.expire_meta_signup_attempts();

  UPDATE public.secret_cleanup_outbox AS exhausted
     SET state='FAILED_TERMINAL',lease_id=NULL,lease_expires_at=NULL,
         error_code=COALESCE(exhausted.error_code,'MAX_ATTEMPTS_EXHAUSTED'),
         safe_error=COALESCE(exhausted.safe_error,'Secret cleanup exhausted its retry limit.'),
         completed_at=now(),updated_at=now()
   WHERE exhausted.attempts>=exhausted.max_attempts
     AND (exhausted.state IN ('QUEUED','FAILED_RETRYABLE')
       OR (exhausted.state='RUNNING' AND exhausted.lease_expires_at<now()));

  RETURN QUERY
  UPDATE public.secret_cleanup_outbox AS cleanup
     SET lease_id=worker_lease,lease_expires_at=now()+interval '60 seconds',
         fencing_token=cleanup.fencing_token+1,state='RUNNING',
         attempts=cleanup.attempts+1,error_code=NULL,safe_error=NULL,updated_at=now()
   WHERE cleanup.id IN (
     SELECT candidate.id
       FROM public.secret_cleanup_outbox AS candidate
      WHERE candidate.attempts<candidate.max_attempts
        AND ((candidate.state IN ('QUEUED','FAILED_RETRYABLE') AND candidate.available_at<=now())
          OR (candidate.state='RUNNING' AND candidate.lease_expires_at<now()))
        AND app.secret_cleanup_reference_is_owned(
          candidate.cleanup_kind,
          candidate.tenant_id,
          candidate.connection_id,
          candidate.connection_operation_id,
          candidate.routing_integration_id,
          candidate.bot_action_credential_stage_id,
          candidate.secret_reference
        )
        AND NOT EXISTS (
          SELECT 1 FROM meta_signup_attempts attempt
          JOIN privacy_legal_holds hold ON hold.tenant_id=attempt.tenant_id AND hold.released_at IS NULL
          WHERE attempt.tenant_id=candidate.tenant_id AND attempt.operation_id=candidate.connection_operation_id
            AND attempt.purpose IN ('RECONNECT','ADD_ACCESS','TRANSITION_READBACK')
        )
        AND (candidate.cleanup_kind<>'CONNECTION_CREDENTIAL' OR NOT app.meta_transition_observer_secret_retained(
          candidate.tenant_id,candidate.connection_id,candidate.connection_operation_id,candidate.secret_reference))
        AND (candidate.cleanup_kind NOT IN ('WEBHOOK_SECRET','CONNECTION_CREDENTIAL') OR EXISTS (
          SELECT 1
            FROM connection_operations operation
            JOIN tenants tenant ON tenant.id=operation.tenant_id
           WHERE operation.tenant_id=candidate.tenant_id
             AND operation.id=candidate.connection_operation_id
             AND operation.state<>'STAGED'
             AND (
               tenant.state='DELETING'
               OR (candidate.cleanup_kind='WEBHOOK_SECRET' AND NOT EXISTS (
                 SELECT 1 FROM webhook_routes route
                  WHERE route.tenant_id=candidate.tenant_id
                    AND route.hmac_secret_reference=candidate.secret_reference
                    AND route.state<>'REVOKED'
               ))
               OR (candidate.cleanup_kind='CONNECTION_CREDENTIAL' AND NOT EXISTS (
                 SELECT 1 FROM connections connection
                  WHERE connection.tenant_id=candidate.tenant_id
                    AND connection.secret_reference=candidate.secret_reference
                    AND connection.state<>'REVOKED'
               ))
             )
        ))
        AND (candidate.cleanup_kind<>'ROUTING_INTEGRATION_SECRET' OR EXISTS (
          SELECT 1 FROM client_routing_integrations integration
          JOIN tenants tenant ON tenant.id=integration.tenant_id
          WHERE integration.tenant_id=candidate.tenant_id
            AND integration.id=candidate.routing_integration_id
            AND (integration.state='REVOKED' OR tenant.state='DELETING')
        ) AND NOT EXISTS (
          SELECT 1 FROM client_routing_source_state source
           WHERE source.tenant_id=candidate.tenant_id
             AND source.secret_reference=candidate.secret_reference
             AND source.state<>'RETIRED'
        ) AND NOT EXISTS (
          SELECT 1 FROM bot_action_definitions action
           WHERE action.tenant_id=candidate.tenant_id
             AND action.secret_reference=candidate.secret_reference
             AND action.state='ACTIVE'
        ) AND NOT EXISTS (
          SELECT 1 FROM bot_action_jobs job
          JOIN bot_action_revisions revision
            ON revision.tenant_id=job.tenant_id AND revision.id=job.action_revision_id
           WHERE job.tenant_id=candidate.tenant_id
             AND revision.secret_reference=candidate.secret_reference
             AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
        ) AND NOT EXISTS (
          SELECT 1 FROM group_action_executions execution
           WHERE execution.tenant_id=candidate.tenant_id
             AND execution.action_snapshot->>'secretReference'=candidate.secret_reference
             AND execution.state IN ('PREPARED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
        ) AND NOT EXISTS (
          SELECT 1 FROM client_routing_sync_jobs job
          JOIN client_routing_source_state source
            ON source.tenant_id=job.tenant_id AND source.id=job.source_state_id
           WHERE job.tenant_id=candidate.tenant_id
             AND source.secret_reference=candidate.secret_reference
             AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
        ))
        AND (candidate.cleanup_kind<>'BOT_ACTION_CREDENTIAL_STAGE' OR EXISTS (
          SELECT 1 FROM bot_action_credential_stages stage
          JOIN tenants tenant ON tenant.id=stage.tenant_id
          WHERE stage.tenant_id=candidate.tenant_id
            AND stage.id=candidate.bot_action_credential_stage_id
            AND (
              (stage.state='STAGED' AND stage.expires_at<=clock_timestamp())
              OR (stage.state='BOUND' AND (tenant.state='DELETING' OR (
                NOT EXISTS (
                  SELECT 1 FROM bot_action_definitions action
                  JOIN bot_action_revisions revision
                    ON revision.tenant_id=action.tenant_id AND revision.id=action.active_revision_id
                  WHERE action.tenant_id=stage.tenant_id
                    AND revision.secret_reference=stage.secret_reference
                ) AND NOT EXISTS (
                  SELECT 1 FROM automation_action_revision_pins pin
                  JOIN bot_action_revisions revision
                    ON revision.tenant_id=pin.tenant_id AND revision.id=pin.action_revision_id
                  LEFT JOIN bot_flow_versions flow
                    ON flow.tenant_id=pin.tenant_id AND flow.id=pin.bot_flow_version_id
                  LEFT JOIN rule_sets rule_set
                    ON rule_set.tenant_id=pin.tenant_id AND rule_set.id=pin.rule_set_id
                  WHERE pin.tenant_id=stage.tenant_id
                    AND revision.secret_reference=stage.secret_reference
                    AND ((pin.bot_flow_version_id IS NOT NULL AND (
                      flow.state='ACTIVE' OR EXISTS (
                        SELECT 1 FROM bot_conversations conversation
                        WHERE conversation.tenant_id=flow.tenant_id
                          AND conversation.flow_version_id=flow.id
                          AND conversation.state<>'RESOLVED'
                      )
                    )) OR (pin.rule_set_id IS NOT NULL AND (
                      rule_set.state='ACTIVE' OR EXISTS (
                        SELECT 1 FROM event_inbox inbox
                        WHERE inbox.tenant_id=rule_set.tenant_id
                          AND inbox.governing_rule_set_id=rule_set.id
                          AND inbox.status IN ('ACCEPTED','PROCESSING','FAILED_RETRYABLE')
                      )
                    )))
                ) AND NOT EXISTS (
                  SELECT 1 FROM bot_action_jobs job
                  JOIN bot_action_revisions revision
                    ON revision.tenant_id=job.tenant_id AND revision.id=job.action_revision_id
                  WHERE job.tenant_id=stage.tenant_id
                    AND revision.secret_reference=stage.secret_reference
                    AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
                ) AND NOT EXISTS (
                  SELECT 1 FROM group_action_executions execution
                  WHERE execution.tenant_id=stage.tenant_id
                    AND execution.action_snapshot->>'secretReference'=stage.secret_reference
                    AND execution.state IN ('PREPARED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
                )
              )))
            )
          FOR UPDATE OF stage SKIP LOCKED
        ))
        AND (candidate.cleanup_kind<>'META_SIGNUP_CREDENTIAL' OR EXISTS (
          SELECT 1 FROM meta_signup_attempts attempt JOIN tenants tenant ON tenant.id=attempt.tenant_id
          WHERE attempt.tenant_id=candidate.tenant_id AND attempt.id=candidate.meta_signup_attempt_id
            AND attempt.secret_reference=candidate.secret_reference
            AND attempt.status NOT IN ('EXCHANGING','OUTCOME_UNKNOWN','PROVISIONING')
            AND (attempt.status IN ('CANCELLED','EXPIRED','FAILED') OR attempt.expires_at<clock_timestamp() OR tenant.state='DELETING')
            AND NOT EXISTS (SELECT 1 FROM privacy_legal_holds hold WHERE hold.tenant_id=attempt.tenant_id AND hold.released_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM connections connection WHERE connection.tenant_id=attempt.tenant_id
              AND connection.secret_reference=attempt.secret_reference AND connection.state<>'REVOKED')
            AND (attempt.connection_id IS NULL OR EXISTS (
              SELECT 1 FROM connection_operations operation WHERE operation.tenant_id=attempt.tenant_id AND operation.id=attempt.operation_id
                AND operation.state IN ('SUCCEEDED','FAILED_TERMINAL','CANCELLED')
            ))
          FOR UPDATE OF attempt SKIP LOCKED
        ))
      ORDER BY candidate.available_at,candidate.created_at,candidate.id
      FOR UPDATE SKIP LOCKED
      LIMIT claim_limit
   )
  RETURNING cleanup.id,cleanup.tenant_id,cleanup.secret_reference,
            cleanup.attempts,cleanup.max_attempts,cleanup.fencing_token;
END
$$;

-- P09 logical fragment: META_ACCOUNT_TRANSITION_OPERATOR_REVIEW.sql
-- Bound source SHA256: 76326db2f2864da15a694411b828b8437299b51ce7b18f553baa6b858499d0c5
-- Private unapplied P09 console companion. No provider request is dispatched.
CREATE FUNCTION app.operator_meta_transition_list(tenant_value uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=tenant_value) THEN RAISE EXCEPTION 'Workspace is unavailable' USING ERRCODE='P0002';END IF;
 PERFORM set_config('app.tenant_id',tenant_value::text,true);
 SELECT jsonb_build_object('tenantId',tenant_value,'plans',COALESCE(jsonb_agg(item.value ORDER BY item.created_at DESC,item.id),'[]'::jsonb)) INTO result
 FROM(SELECT p.id,p.created_at,jsonb_build_object('id',p.id,'name',c.name,'revision',p.revision,'requestedMode',p.requested_mode,
  'sourceCurrency',preview.result#>>'{metaTransitionPreview,current,currency}','targetCurrency',p.target_currency,
  'phase',CASE WHEN p.state='CANCELLED' THEN 'CANCELLED' WHEN p.execution_state='UNPREPARED' THEN 'PREVIEW'
   WHEN p.execution_state='INITIATED' THEN 'IN_PROGRESS' ELSE p.execution_state END) AS value
  FROM public.meta_account_transitions p JOIN public.connections c ON c.tenant_id=p.tenant_id AND c.id=p.initiating_connection_id
  JOIN public.connection_operations preview ON preview.tenant_id=p.tenant_id AND preview.id=p.current_observation_operation_id
  WHERE p.tenant_id=tenant_value ORDER BY p.created_at DESC,p.id LIMIT 50) item;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.operator_meta_transition_list(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_meta_transition_list(uuid) TO wasalx_platform_operations_client;

CREATE FUNCTION app.operator_meta_transition_review(tenant_value uuid,plan_value uuid,operator_value text,key_value uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;c public.connections;preview public.connection_operations;observed public.connection_operations;
 original public.platform_operations_audit_events;scope_value jsonb;auth jsonb;target_review jsonb;renewed jsonb;arrangements jsonb;names jsonb;
 steps jsonb;pending jsonb;result jsonb;private_value jsonb;source_currency text;target_access text:='NONE';payment text:='UNAVAILABLE';
 observer_state text:='ABSENT';closed boolean;busy boolean;initial_known boolean;complete_exists boolean;source_current boolean;reasons text[]:='{}';
BEGIN
 IF operator_value IS NULL OR length(operator_value) NOT BETWEEN 1 AND 255 OR operator_value~'[[:cntrl:]]' THEN RAISE EXCEPTION 'Operator is unavailable' USING ERRCODE='55000';END IF;
 PERFORM set_config('app.tenant_id',tenant_value::text,true);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=tenant_value AND id=plan_value;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Transition is unavailable' USING ERRCODE='P0002';END IF;
 SELECT * INTO c FROM public.connections WHERE tenant_id=p.tenant_id AND id=p.initiating_connection_id;
 SELECT * INTO preview FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=p.current_observation_operation_id;
 SELECT * INTO observed FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=p.provider_observation_operation_id;
 SELECT * INTO original FROM public.platform_operations_audit_events WHERE id=p.execution_authorization_id;
 scope_value:=app.meta_transition_scope(p.source_account_id);auth:=app.meta_transition_authorization(p.id);target_review:=app.meta_transition_target_review(p.id);
 source_currency:=COALESCE(original.safe_metadata->>'sourceCurrency',preview.result#>>'{metaTransitionPreview,current,currency}');
 source_current:=scope_value IS NOT NULL AND jsonb_array_length(scope_value->'bindings') BETWEEN 1 AND 2000
  AND source_currency ~ '^[A-Z]{3}$' AND EXISTS(SELECT 1 FROM public.tenants WHERE id=p.tenant_id AND state='ACTIVE')
  AND NOT EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=p.tenant_id AND job_type='DELETE' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE'));
 closed:=p.state='CANCELLED' OR p.execution_state='RECONCILED_PAUSED';
 SELECT EXISTS(SELECT 1 FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=p.execution_operation_id AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) INTO busy;
 SELECT EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints checkpoint WHERE checkpoint.tenant_id=p.tenant_id AND checkpoint.owner_kind='ACCOUNT_TRANSITION'
  AND checkpoint.owner_id=p.id AND checkpoint.stage='INITIATE' AND checkpoint.outcome='SUCCEEDED' AND checkpoint.result->>'migrationId'=p.provider_migration_id) INTO initial_known;
 SELECT EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION'
  AND owner_id=p.id AND stage='COMPLETE') INTO complete_exists;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('stage',stage,'outcome',outcome) ORDER BY stage),'[]'::jsonb) INTO steps
  FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=p.id;
 IF p.target_account_id IS NOT NULL AND observed.result#>>'{metaTransitionObservation,migrationId}'=p.provider_migration_id
  AND (observed.result#>>'{metaTransitionObservation,observedAt}')::timestamptz BETWEEN clock_timestamp()-interval '5 minutes' AND clock_timestamp() THEN
  target_access:=CASE observed.result#>>'{metaTransitionObservation,targetReadiness,assets}' WHEN 'CLONE_ACCESS_VERIFIED' THEN 'CLONE' WHEN 'VERIFIED' THEN 'FINAL' ELSE 'NONE' END;
  payment:=CASE WHEN observed.result#>>'{metaTransitionObservation,targetReadiness,payment}'='VERIFIED' THEN 'VERIFIED' ELSE 'UNAVAILABLE' END;
 END IF;
 IF p.observer_operations ? p.initiating_binding_id::text THEN
  observer_state:='UNAVAILABLE';
  BEGIN
   renewed:=app.meta_transition_observer_credential(p.id,p.initiating_binding_id,(p.observer_operations->>p.initiating_binding_id::text)::uuid);
   IF renewed IS NOT NULL THEN observer_state:='CURRENT';END IF;
  EXCEPTION WHEN SQLSTATE '55000' THEN renewed:=NULL;END;
 END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',item.id,'label','Approved arrangement '||item.version::text,'expiresAt',item.expires_at) ORDER BY item.created_at,item.id),'[]'::jsonb)
 INTO arrangements FROM(SELECT id,version,expires_at,created_at FROM public.meta_funding_arrangement_versions
  WHERE tenant_id=p.tenant_id AND account_id=p.source_account_id AND state='APPROVED' AND evidence_mode='SIMULATED'
   AND expires_at>clock_timestamp() ORDER BY created_at,id LIMIT 100) item;
 SELECT COALESCE(jsonb_agg(connection.name ORDER BY connection.id),'[]'::jsonb) INTO names
 FROM public.connections connection WHERE connection.tenant_id=p.tenant_id AND connection.id IN(
  SELECT (value->>'connectionId')::uuid FROM jsonb_array_elements(COALESCE(p.execution_scope,scope_value)->'bindings'));
 IF closed THEN reasons:=array_append(reasons,'PLAN_CLOSED');END IF;
 IF NOT COALESCE(source_current,false) THEN reasons:=array_append(reasons,'SOURCE_SCOPE_UNAVAILABLE');END IF;
 IF target_access='NONE' THEN reasons:=array_append(reasons,'TARGET_READ_REQUIRED');END IF;
 IF payment<>'VERIFIED' THEN reasons:=array_append(reasons,'PAYMENT_READ_REQUIRED');END IF;
 IF observer_state<>'CURRENT' THEN reasons:=array_append(reasons,'OBSERVER_RENEWAL_REQUIRED');END IF;
 IF NOT initial_known THEN reasons:=array_append(reasons,'ORIGINAL_INITIATION_UNRESOLVED');END IF;
 IF complete_exists THEN reasons:=array_append(reasons,'COMPLETE_ALREADY_ATTEMPTED');END IF;
 IF auth IS NULL OR target_review IS NULL THEN reasons:=array_append(reasons,'APPROVAL_REQUIRED');END IF;
 IF busy THEN reasons:=array_append(reasons,'TRANSITION_BUSY');END IF;
 result:=jsonb_build_object('id',p.id,'tenantId',p.tenant_id,'name',c.name,'revision',p.revision,'requestedMode',p.requested_mode,
  'sourceCurrency',source_currency,'targetCurrency',p.target_currency,'evidenceMode','SIMULATED',
  'phase',CASE WHEN p.state='CANCELLED' THEN 'CANCELLED' WHEN p.execution_state='UNPREPARED' THEN 'PREVIEW'
   WHEN p.execution_state='INITIATED' THEN 'IN_PROGRESS' ELSE p.execution_state END,
  'connectionNames',names,'connectionCount',jsonb_array_length(names),'providerStatus',p.provider_status,'checkpoints',steps,
  'proof',jsonb_build_object('sourceScope',CASE WHEN source_current THEN 'CURRENT' ELSE 'UNAVAILABLE' END,
   'targetAccess',target_access,'payment',payment,'renewedObserver',observer_state,
   'prerequisiteApproval',CASE WHEN auth IS NULL THEN 'MISSING' ELSE 'CURRENT' END,'targetReview',CASE WHEN target_review IS NULL THEN 'MISSING' ELSE 'CURRENT' END),
  'actions',jsonb_build_object('PREREQUISITES',COALESCE(NOT closed AND NOT busy AND source_current,false),
   'TARGET',COALESCE(NOT closed AND NOT busy AND source_current AND target_access<>'NONE' AND p.execution_authorization_id IS NOT NULL,false),
   'COMPLETION',COALESCE(NOT closed AND NOT busy AND source_current AND observer_state='CURRENT' AND initial_known AND NOT complete_exists
    AND p.provider_status='READY_TO_COMPLETE' AND target_access='CLONE' AND payment='VERIFIED' AND auth IS NOT NULL AND target_review IS NOT NULL,false)),
  'reasons',to_jsonb(reasons),'arrangements',arrangements,
  'originalGrant',CASE WHEN original.id IS NULL THEN NULL ELSE jsonb_build_object('sourcePayment',original.safe_metadata->>'sourcePayment',
   'managed',CASE WHEN p.requested_mode='CUSTOMER' THEN NULL ELSE jsonb_build_object('arrangementVersionId',original.safe_metadata->>'arrangementVersionId',
    'targetReceivingBusinessId',original.safe_metadata->>'targetReceivingBusinessId','targetTermsDocumentText',original.safe_metadata->>'targetTermsDocumentText',
    'targetTermsVersion',original.safe_metadata->>'targetTermsVersion') END) END);
 private_value:=jsonb_build_object('projection',result,'scope',scope_value,'authorization',auth,'targetReview',target_review,
  'observer',renewed,'observationOperationId',p.provider_observation_operation_id,'observation',observed.result,'originalGrant',original.safe_metadata);
 IF key_value IS NOT NULL THEN
  SELECT safe_metadata->'result' INTO pending FROM public.platform_operations_audit_events
   WHERE operator_subject=operator_value AND action='meta.transition.operator_command.settled' AND target_id=p.id::text
    AND safe_metadata->>'tenantId'=p.tenant_id::text AND safe_metadata->>'requestKey'=key_value::text;
 END IF;
 RETURN result||jsonb_build_object('reviewSha256',encode(public.digest(private_value::text,'sha256'),'hex'),'pendingCommand',pending);
END $$;
REVOKE ALL ON FUNCTION app.operator_meta_transition_review(uuid,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_meta_transition_review(uuid,uuid,text,uuid) TO wasalx_platform_operations_client;

-- Same local command lock and immutable audit record in both arrival orders.
-- An absent original command can be closed without approving or revoking anything.
CREATE FUNCTION app.operator_meta_transition_command(tenant_value uuid,plan_value uuid,action_value text,key_value uuid,
 request_body jsonb,operator_value text,request_value text,resolve_only boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;a public.meta_messaging_accounts;arrangement public.meta_funding_arrangement_versions;
 original public.platform_operations_audit_events;existing public.platform_operations_audit_events;projection jsonb;scope_value jsonb;candidate jsonb;
 approval jsonb;auth jsonb;target_review jsonb;result jsonb;receipt uuid:=gen_random_uuid();expires_value timestamptz:=clock_timestamp()+interval '10 minutes';
BEGIN
 IF action_value NOT IN('PREREQUISITES','TARGET','COMPLETION') OR key_value IS NULL OR resolve_only IS NULL
  OR jsonb_typeof(request_body) IS DISTINCT FROM 'object' OR octet_length(request_body::text)>65536
  OR request_body->'confirmed' IS DISTINCT FROM 'true'::jsonb OR COALESCE(request_body->>'expectedReviewSha256','') !~ '^[a-f0-9]{64}$'
  OR COALESCE(request_body->>'evidenceSha256','') !~ '^[a-f0-9]{64}$'
  OR jsonb_typeof(request_body->'expectedRevision') IS DISTINCT FROM 'number' OR (request_body->>'expectedRevision')::numeric NOT BETWEEN 1 AND 9007199254740991
  OR trunc((request_body->>'expectedRevision')::numeric)<>(request_body->>'expectedRevision')::numeric
  OR operator_value IS NULL OR length(operator_value) NOT BETWEEN 1 AND 255 OR operator_value~'[[:cntrl:]]'
  OR request_value IS NULL OR length(request_value) NOT BETWEEN 1 AND 255 OR request_value~'[[:cntrl:]]' THEN
  RAISE EXCEPTION 'Review command is invalid' USING ERRCODE='55000';END IF;
 IF request_body-(ARRAY['expectedRevision','expectedReviewSha256','evidenceSha256','confirmed']||
   CASE action_value WHEN 'PREREQUISITES' THEN ARRAY['sourcePayment','managed'] WHEN 'TARGET' THEN ARRAY['templateEvidenceSha256','flowEvidenceSha256'] ELSE '{}'::text[] END)<>'{}'::jsonb
  OR (action_value='PREREQUISITES' AND COALESCE(request_body->>'sourcePayment','') NOT IN('CARD','LINE'))
 OR (action_value='TARGET' AND (COALESCE(request_body->>'templateEvidenceSha256','') !~ '^[a-f0-9]{64}$' OR COALESCE(request_body->>'flowEvidenceSha256','') !~ '^[a-f0-9]{64}$')) THEN
  RAISE EXCEPTION 'Review command fields are invalid' USING ERRCODE='55000';END IF;
 IF request_body ? 'managed' THEN
  IF jsonb_typeof(request_body->'managed') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Managed target review is invalid' USING ERRCODE='55000';END IF;
  IF (request_body->'managed')-ARRAY['arrangementVersionId','targetReceivingBusinessId','targetTermsDocumentText','targetTermsVersion']<>'{}'::jsonb
   OR COALESCE(request_body#>>'{managed,arrangementVersionId}','') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   OR COALESCE(request_body#>>'{managed,targetReceivingBusinessId}','') !~ '^[0-9]{1,32}$'
   OR jsonb_typeof(request_body#>'{managed,targetTermsDocumentText}') IS DISTINCT FROM 'string'
   OR octet_length(request_body#>>'{managed,targetTermsDocumentText}') NOT BETWEEN 1 AND 32768
   OR COALESCE(request_body#>>'{managed,targetTermsVersion}','') !~ '^[A-Za-z0-9._-]{1,128}$' THEN
   RAISE EXCEPTION 'Managed target review is invalid' USING ERRCODE='55000';END IF;
 END IF;
 PERFORM set_config('app.tenant_id',tenant_value::text,true);
 PERFORM pg_advisory_xact_lock(hashtextextended('meta-transition-review:'||tenant_value::text||':'||operator_value||':'||key_value::text,0));
 SELECT * INTO existing FROM public.platform_operations_audit_events WHERE operator_subject=operator_value
  AND action='meta.transition.operator_command.settled' AND safe_metadata->>'tenantId'=tenant_value::text AND safe_metadata->>'requestKey'=key_value::text;
 IF existing.id IS NOT NULL THEN
  IF existing.target_id IS DISTINCT FROM plan_value::text OR existing.safe_metadata->>'commandAction' IS DISTINCT FROM action_value
   OR existing.safe_metadata->'request' IS DISTINCT FROM request_body THEN RAISE EXCEPTION 'Original command key was reused' USING ERRCODE='55000';END IF;
  RETURN (existing.safe_metadata->'result')||jsonb_build_object('duplicate',true);
 END IF;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=tenant_value AND id=plan_value;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Transition is unavailable' USING ERRCODE='P0002';END IF;
 IF NOT resolve_only THEN
  PERFORM app.lock_meta_transition_accounts(array_remove(ARRAY[p.source_account_id,p.target_account_id],NULL));
  SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=tenant_value AND id=plan_value FOR UPDATE NOWAIT;
  projection:=app.operator_meta_transition_review(tenant_value,plan_value,operator_value,NULL);
  IF p.revision IS DISTINCT FROM (request_body->>'expectedRevision')::bigint
   OR projection->>'reviewSha256' IS DISTINCT FROM request_body->>'expectedReviewSha256'
   OR projection->'actions'->>action_value IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Current review changed' USING ERRCODE='55000';END IF;
  SELECT * INTO a FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=p.source_account_id;
  SELECT * INTO original FROM public.platform_operations_audit_events WHERE id=p.execution_authorization_id;
  scope_value:=app.meta_transition_scope(p.source_account_id);
  IF action_value='PREREQUISITES' THEN
   IF request_body->>'sourcePayment' NOT IN('CARD','LINE') OR (p.requested_mode='CUSTOMER' AND (request_body->>'sourcePayment'<>'CARD' OR request_body ? 'managed')) THEN
    RAISE EXCEPTION 'Explicit payment review is required' USING ERRCODE='55000';END IF;
   candidate:=jsonb_build_object('tenantId',p.tenant_id,'sourceAccountId',p.source_account_id,'transitionId',p.id,'requestedMode',p.requested_mode,
    'targetCurrency',p.target_currency,'sourceCurrency',projection->>'sourceCurrency','mode','SIMULATED','graphVersion','v24.0',
    'appId',scope_value#>>'{bindings,0,appId}','variant','STANDARD_SAME_HIERARCHY','adminAuthority','VERIFIED','phoneScope','COMPLETE_LOCAL_ONLY',
    'templateScope','VERIFIED','evidenceSha256',request_body->>'evidenceSha256','scopeSha256',encode(public.digest(scope_value::text,'sha256'),'hex'),
    'authorityRevision',a.authority_revision,'sourcePayment',request_body->>'sourcePayment','paymentAction',CASE WHEN p.requested_mode='CUSTOMER' THEN 'RETAIN_CARD' ELSE 'APPROVED_LINE' END,
    'expiresAt',expires_value);
   IF p.requested_mode='WASALX_MANAGED' THEN
    SELECT * INTO arrangement FROM public.meta_funding_arrangement_versions WHERE tenant_id=p.tenant_id AND account_id=p.source_account_id
     AND id=(request_body#>>'{managed,arrangementVersionId}')::uuid AND state='APPROVED' AND evidence_mode='SIMULATED' AND expires_at>clock_timestamp();
    IF arrangement.id IS NULL THEN RAISE EXCEPTION 'Approved arrangement is unavailable' USING ERRCODE='55000';END IF;
    candidate:=candidate||jsonb_build_object('arrangementVersionId',arrangement.id,'creditLineId',arrangement.credit_line_id,'delegatedHolderBusinessId',arrangement.holder_business_id,
     'targetReceivingBusinessId',request_body#>>'{managed,targetReceivingBusinessId}','targetTermsDocumentText',request_body#>>'{managed,targetTermsDocumentText}',
     'targetTermsVersion',request_body#>>'{managed,targetTermsVersion}','targetTermsDocumentSha256',encode(public.digest(convert_to(request_body#>>'{managed,targetTermsDocumentText}','UTF8'),'sha256'),'hex'),
     'cloneFundingGrant','EXACT_TRANSITION_DERIVED_TARGET');
   END IF;
   approval:=app.operator_authorize_meta_transition(p.id,p.revision,candidate,operator_value,request_value);
  ELSIF action_value='TARGET' THEN
   candidate:=jsonb_build_object('mode','SIMULATED','templates','VERIFIED','flows','VERIFIED','scopeSha256',p.execution_scope_sha256,
    'templateEvidenceSha256',request_body->>'templateEvidenceSha256','flowEvidenceSha256',request_body->>'flowEvidenceSha256','expiresAt',expires_value);
   IF p.requested_mode='WASALX_MANAGED' THEN candidate:=candidate||jsonb_build_object('termsDocumentSha256',original.safe_metadata->>'targetTermsDocumentSha256','termsDocumentText',original.safe_metadata->>'targetTermsDocumentText');END IF;
   approval:=app.operator_review_meta_transition_target(p.id,p.provider_observation_operation_id,candidate,operator_value,request_value);
  ELSE
   auth:=app.meta_transition_authorization(p.id);target_review:=app.meta_transition_target_review(p.id);
   approval:=app.operator_authorize_meta_transition_completion(p.id,p.revision,(p.observer_operations->>p.initiating_binding_id::text)::uuid,
    jsonb_build_object('mode','SIMULATED','prerequisiteReceiptId',auth->>'receiptId','targetReviewReceiptId',target_review->>'receiptId',
     'evidenceSha256',request_body->>'evidenceSha256','expiresAt',expires_value),operator_value,request_value);
  END IF;
 END IF;
 result:=jsonb_build_object('tenantId',tenant_value,'planId',plan_value,'requestKey',key_value,'action',action_value,'request',request_body,
  'state',CASE WHEN resolve_only THEN 'NO_EFFECT' ELSE 'APPLIED' END,'commandReceiptId',receipt,'approvalReceiptId',approval->>'receiptId','duplicate',false);
 INSERT INTO public.platform_operations_audit_events(id,operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(receipt,operator_value,'meta.transition.operator_command.settled','meta.account_transition',plan_value::text,
  jsonb_build_object('tenantId',tenant_value,'requestKey',key_value,'commandAction',action_value,'request',request_body,'result',result),request_value);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.operator_meta_transition_command(uuid,uuid,text,uuid,jsonb,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_meta_transition_command(uuid,uuid,text,uuid,jsonb,text,text,boolean) TO wasalx_platform_operations_client;

COMMIT;
