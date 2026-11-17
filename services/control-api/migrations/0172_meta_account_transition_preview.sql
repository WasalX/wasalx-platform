-- Account-change preview only. Provider commands remain outside this migration.
BEGIN;
ALTER TABLE public.connection_operations DROP CONSTRAINT connection_operations_operation_type_check;
ALTER TABLE public.connection_operations ADD CONSTRAINT connection_operations_operation_type_check CHECK (
 operation_type IN ('PROVISION','START','RESTART','PAUSE','DISCONNECT','SYNC_GROUPS','SYNC_META_APP','ROTATE_META_CREDENTIAL','VERIFY_META_BILLING','PREVIEW_META_ACCOUNT_TRANSITION')
);
CREATE TABLE public.meta_account_transitions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenants(id),
 source_account_id uuid NOT NULL, initiating_connection_id uuid NOT NULL, initiating_binding_id uuid NOT NULL,
 requested_by uuid, requested_mode text NOT NULL CHECK(requested_mode IN ('CUSTOMER','WASALX_MANAGED')),
 target_currency text NOT NULL CHECK(target_currency ~ '^[A-Z]{3}$'),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 initial_account_revision bigint NOT NULL CHECK(initial_account_revision BETWEEN 1 AND 9007199254740991),
 initial_binding_revision bigint NOT NULL CHECK(initial_binding_revision BETWEEN 1 AND 9007199254740991),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','PREVIEW','BLOCKED','CANCELLED')),
 current_observation_operation_id uuid NOT NULL, observed_at timestamptz, expires_at timestamptz,
 cancelled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,idempotency_key),
 FOREIGN KEY(tenant_id,source_account_id) REFERENCES public.meta_messaging_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,initiating_connection_id) REFERENCES public.connections(tenant_id,id),
 FOREIGN KEY(tenant_id,initiating_binding_id) REFERENCES public.meta_connection_account_bindings(tenant_id,id),
 FOREIGN KEY(tenant_id,requested_by) REFERENCES public.tenant_memberships(tenant_id,user_id) ON DELETE SET NULL(requested_by),
 FOREIGN KEY(tenant_id,current_observation_operation_id) REFERENCES public.connection_operations(tenant_id,id),
 CHECK((observed_at IS NULL)=(expires_at IS NULL)),
 CHECK(expires_at IS NULL OR expires_at>observed_at),
 CHECK((state='CANCELLED')=(cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX meta_account_transitions_current ON public.meta_account_transitions(tenant_id,source_account_id)
 WHERE state<>'CANCELLED';
ALTER TABLE public.meta_account_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_account_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.meta_account_transitions
 USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
GRANT SELECT,INSERT,UPDATE ON public.meta_account_transitions TO wasalx_app;
GRANT SELECT,UPDATE ON public.meta_account_transitions TO wasalx_connector_worker;
CREATE TRIGGER meta_transition_privacy_statement_fence BEFORE INSERT OR UPDATE ON public.meta_account_transitions
 FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();

-- A single tenant-scoped private context serves API and worker. No provider ID
-- or credential reference supplied by a request can select its authority.
CREATE FUNCTION app.meta_account_transition_context(connection_value uuid, actor_value uuid, app_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET row_security=off
SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE tenant_value uuid:=app.current_tenant_id(); connection_row public.connections;
 binding_row public.meta_connection_account_bindings; account_row public.meta_messaging_accounts;
 session_row public.provider_sessions; scope_value jsonb; flow_value jsonb; mode_value text; flow_ids uuid[];
BEGIN
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||tenant_value::text,0)) THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.tenants WHERE id=tenant_value AND state='ACTIVE' FOR SHARE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=tenant_value AND job_type='DELETE'
   AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.tenant_memberships WHERE tenant_id=tenant_value AND user_id=actor_value
   AND state='ACTIVE' AND role IN ('tenant_owner','tenant_admin') FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO connection_row FROM public.connections WHERE tenant_id=tenant_value AND id=connection_value
   AND provider='META' AND state IN ('WORKING','PAUSED') FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO binding_row FROM public.meta_connection_account_bindings WHERE tenant_id=tenant_value
   AND connection_id=connection_value AND state='ACTIVE';
 IF NOT FOUND OR binding_row.app_id<>app_value OR binding_row.secret_reference<>connection_row.secret_reference THEN RETURN NULL; END IF;
 SELECT * INTO account_row FROM public.meta_messaging_accounts WHERE tenant_id=tenant_value
   AND id=binding_row.account_id AND state<>'RETIRED' FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- Match P08's connection -> account -> binding order; do not upgrade an
 -- account SHARE lock after taking a binding lock.
 SELECT * INTO binding_row FROM public.meta_connection_account_bindings WHERE tenant_id=tenant_value
   AND connection_id=connection_value AND account_id=account_row.id AND state='ACTIVE' FOR SHARE;
 IF NOT FOUND OR binding_row.app_id<>app_value OR binding_row.secret_reference<>connection_row.secret_reference THEN RETURN NULL; END IF;
 SELECT * INTO session_row FROM public.provider_sessions WHERE tenant_id=tenant_value AND connection_id=connection_value
   AND id=binding_row.provider_session_id AND ownership_state='ACTIVE' AND state IN ('WORKING','PAUSED') FOR SHARE;
 IF NOT FOUND OR session_row.opaque_session_id<>binding_row.phone_number_id
   OR session_row.provider_state_data->>'wabaId' IS DISTINCT FROM account_row.provider_account_id
   OR NOT EXISTS(SELECT 1 FROM public.webhook_routes WHERE tenant_id=tenant_value AND connection_id=connection_value
     AND provider='META' AND state IN ('ACTIVE','PAUSED')) THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.meta_lifecycle_guard(connection_value,session_row.id,session_row.opaque_session_id,
   account_row.provider_account_id,app_value,CASE WHEN NOT(session_row.provider_state_data ? 'metaLifecycle') THEN 0
     WHEN session_row.provider_state_data#>>'{metaLifecycle,revision}' ~ '^[1-9][0-9]{0,15}$'
       THEN (session_row.provider_state_data#>>'{metaLifecycle,revision}')::bigint ELSE NULL END) guard
   WHERE guard.revision_matches AND NOT guard.blocked AND NOT guard.unresolved_hold) THEN RETURN NULL; END IF;
 IF (SELECT count(*) FROM (SELECT id FROM public.meta_connection_account_bindings WHERE tenant_id=tenant_value
   AND account_id=account_row.id AND state<>'RETIRED' LIMIT 2001) bounded)>2000 THEN RETURN NULL; END IF;
 IF (SELECT COALESCE(sum(octet_length(s.provider_state_data::text)),0) FROM public.meta_connection_account_bindings b
   JOIN public.provider_sessions s ON s.tenant_id=b.tenant_id AND s.id=b.provider_session_id
   WHERE b.tenant_id=tenant_value AND b.account_id=account_row.id AND b.state<>'RETIRED')>4194304 THEN RETURN NULL; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('bindingId',b.id,'bindingRevision',b.revision,'connectionId',b.connection_id,
   'providerSessionId',b.provider_session_id,'phoneNumberId',b.phone_number_id,'appId',b.app_id,
   'secretReference',b.secret_reference,'credentialFingerprint',b.credential_fingerprint,'proofSha256',b.proof_sha256,
   'bindingState',b.state,'connectionState',c.state,'currentSecretReference',c.secret_reference,
   'ownershipState',s.ownership_state,'sessionState',s.state,'providerStateData',s.provider_state_data)
   ORDER BY b.id),'[]'::jsonb) INTO scope_value
   FROM (SELECT * FROM public.meta_connection_account_bindings WHERE tenant_id=tenant_value
     AND account_id=account_row.id AND state<>'RETIRED' ORDER BY id LIMIT 2001) b
   JOIN public.connections c ON c.tenant_id=b.tenant_id AND c.id=b.connection_id
   JOIN public.provider_sessions s ON s.tenant_id=b.tenant_id AND s.id=b.provider_session_id
   WHERE b.tenant_id=tenant_value AND b.account_id=account_row.id AND b.state<>'RETIRED';
 -- Both selected assignments and older conversation-pinned immutable versions
 -- affect a future transition. The preview merely observes them.
 SELECT COALESCE(array_agg(f.id),'{}'::uuid[]) INTO flow_ids FROM (SELECT f.id FROM public.bot_flow_versions f WHERE f.tenant_id=tenant_value AND f.id IN (
   SELECT a.flow_version_id FROM public.bot_assignments a JOIN public.meta_connection_account_bindings b
     ON b.tenant_id=a.tenant_id AND b.connection_id=a.connection_id WHERE b.tenant_id=tenant_value AND b.account_id=account_row.id AND b.state<>'RETIRED'
   UNION SELECT c.flow_version_id FROM public.bot_conversations c JOIN public.meta_connection_account_bindings b
     ON b.tenant_id=c.tenant_id AND b.connection_id=c.connection_id WHERE b.tenant_id=tenant_value AND b.account_id=account_row.id AND b.state<>'RETIRED')
   ORDER BY f.id LIMIT 2001) f;
 IF cardinality(flow_ids)>2000 THEN RETURN NULL; END IF;
 IF (SELECT COALESCE(sum(octet_length(definition::text)),0) FROM public.bot_flow_versions
   WHERE tenant_id=tenant_value AND id=ANY(flow_ids))>4194304 THEN RETURN NULL; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',f.id,'snapshotSha256',f.snapshot_sha256,'definition',f.definition)
   ORDER BY f.id),'[]'::jsonb) INTO flow_value FROM public.bot_flow_versions f WHERE f.tenant_id=tenant_value AND f.id=ANY(flow_ids);
 SELECT mode INTO mode_value FROM public.meta_billing_policy_versions WHERE tenant_id=tenant_value AND id=account_row.active_policy_version_id;
 RETURN jsonb_build_object('tenantId',tenant_value,'connectionId',connection_value,'actorId',actor_value,
   'accountId',account_row.id,'providerAccountId',account_row.provider_account_id,'accountRevision',account_row.authority_revision,
   'bindingId',binding_row.id,'bindingRevision',binding_row.revision,'declaredMode',COALESCE(mode_value,'UNSELECTED'),
   'secretReference',connection_row.secret_reference,'session',jsonb_build_object('id',session_row.id,
     'opaqueSessionId',session_row.opaque_session_id,'providerStateData',session_row.provider_state_data),
   'bindingProofSha256',binding_row.proof_sha256,'credentialFingerprint',binding_row.credential_fingerprint,
   'scope',scope_value,'flows',flow_value);
END $$;
REVOKE ALL ON FUNCTION app.meta_account_transition_context(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_account_transition_context(uuid,uuid,text) TO wasalx_app,wasalx_connector_worker;

CREATE FUNCTION app.preserve_meta_transition() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE operation_row public.connection_operations;
BEGIN
 IF TG_OP='UPDATE' THEN
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
 IF NEW.state IN ('PREVIEW','BLOCKED') AND NOT pg_has_role(current_user,'wasalx_connector_worker','member') THEN
   RAISE EXCEPTION 'Only a qualified observation can update the preview' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_transition_immutable BEFORE INSERT OR UPDATE ON public.meta_account_transitions
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_transition();
REVOKE ALL ON FUNCTION app.preserve_meta_transition() FROM PUBLIC;

CREATE FUNCTION app.preserve_meta_transition_observation() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE privacy_current boolean;
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.operation_type='PREVIEW_META_ACCOUNT_TRANSITION' AND NEW.result IS NOT NULL THEN
     RAISE EXCEPTION 'Preview observations require a claimed read operation' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF OLD.operation_type<>'PREVIEW_META_ACCOUNT_TRANSITION' AND (TG_OP='DELETE' OR NEW.operation_type<>'PREVIEW_META_ACCOUNT_TRANSITION') THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
 END IF;
 SELECT EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=OLD.tenant_id AND job_type='DELETE' AND scope_type='TENANT'
   AND scope_value=OLD.tenant_id::text AND state='RUNNING' AND stage='LOCAL' AND lease_id IS NOT NULL AND lease_expires_at>=clock_timestamp())
   INTO privacy_current;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Preview observation history is retained' USING ERRCODE='23514'; END IF;
 IF (NEW.id,NEW.tenant_id,NEW.connection_id,NEW.operation_type,NEW.payload,NEW.requested_by_type,NEW.requested_by_id,NEW.idempotency_key)
   IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.connection_id,OLD.operation_type,OLD.payload,OLD.requested_by_type,OLD.requested_by_id,OLD.idempotency_key)
   THEN RAISE EXCEPTION 'Preview operation identity is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.result IS DISTINCT FROM OLD.result THEN
   IF privacy_current AND OLD.result IS NOT NULL AND NEW.result=jsonb_build_object('redacted',true,
     'sha256',encode(public.digest(OLD.result::text,'sha256'),'hex')) THEN RETURN NEW; END IF;
   IF OLD.result IS NOT NULL OR OLD.state<>'RUNNING' OR OLD.lease_id IS NULL OR OLD.lease_expires_at<clock_timestamp()
     OR NOT pg_has_role(current_user,'wasalx_connector_worker','member') THEN
     RAISE EXCEPTION 'Preview result requires its current worker lease' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_transition_observation_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.connection_operations
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_transition_observation();
REVOKE ALL ON FUNCTION app.preserve_meta_transition_observation() FROM PUBLIC;

-- P09 adds no provider-effect checkpoint, reservation, account mutation or grant
-- to another role. Root must preserve later sibling operation variants when
-- integrating this preview enum extension into the delivered variant union.
COMMIT;
