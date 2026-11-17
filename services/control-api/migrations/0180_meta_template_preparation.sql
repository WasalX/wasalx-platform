-- Full B1 template preparation; root-reserved ordinal 0180 follows 0179.
BEGIN;

-- Accepted B1 fragment: META_TEMPLATE_SAFETY.sql
-- Private, unapplied companion. Root assigns an actual contiguous ordinal.
-- Account template safety is a generation and its immutable signed negatives;
-- transition lifecycle, copy effects and leases remain in their incumbent tables.
CREATE TABLE public.meta_template_account_safety (
 tenant_id uuid NOT NULL, account_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
 observed_revision bigint, observation_operation_id uuid, observed_at timestamptz,
 inventory_sha256 text CHECK(inventory_sha256 ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(tenant_id,account_id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES public.meta_messaging_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,observation_operation_id) REFERENCES public.connection_operations(tenant_id,id),
 CHECK((observation_operation_id IS NULL)=(observed_revision IS NULL)),
 CHECK((observation_operation_id IS NULL)=(observed_at IS NULL)),
 CHECK((observation_operation_id IS NULL)=(inventory_sha256 IS NULL)),
 CHECK(observed_revision IS NULL OR observed_revision<=revision)
);
CREATE TABLE public.meta_template_safety_markers (
 tenant_id uuid NOT NULL, account_id uuid NOT NULL,
 payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 field text NOT NULL CHECK(field ~ '^message_template_[A-Za-z0-9_]{1,96}$'),
 template_id text CHECK(template_id ~ '^[0-9]{1,32}$'),
 source_connection_id uuid NOT NULL, source_session_id uuid NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,account_id,payload_sha256),
 FOREIGN KEY(tenant_id,account_id) REFERENCES public.meta_messaging_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,source_connection_id) REFERENCES public.connections(tenant_id,id),
 FOREIGN KEY(tenant_id,source_connection_id,source_session_id) REFERENCES public.provider_sessions(tenant_id,connection_id,id)
);
ALTER TABLE public.meta_template_account_safety ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_template_account_safety FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.meta_template_account_safety
 USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
ALTER TABLE public.meta_template_safety_markers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_template_safety_markers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.meta_template_safety_markers
 USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
GRANT SELECT ON public.meta_template_account_safety,public.meta_template_safety_markers TO wasalx_app,wasalx_connector_worker;
GRANT SELECT,INSERT,UPDATE ON public.meta_template_account_safety TO wasalx_meta_transition_executor;
GRANT SELECT,INSERT ON public.meta_template_safety_markers TO wasalx_meta_transition_executor;
GRANT EXECUTE ON FUNCTION app.resolve_meta_lifecycle_routes(text,text) TO wasalx_meta_transition_executor;

CREATE FUNCTION app.preserve_meta_template_marker() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'Signed template invalidation history is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER meta_template_marker_immutable BEFORE UPDATE OR DELETE ON public.meta_template_safety_markers
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_template_marker();
REVOKE ALL ON FUNCTION app.preserve_meta_template_marker() FROM PUBLIC;

CREATE FUNCTION app.preserve_meta_template_safety() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF current_user<>'wasalx_meta_transition_executor' THEN
  RAISE EXCEPTION 'Template generation requires sealed admission' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Template generations are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND ((NEW.tenant_id,NEW.account_id) IS DISTINCT FROM (OLD.tenant_id,OLD.account_id)
  OR NEW.revision NOT IN(OLD.revision,OLD.revision+1)) THEN
  RAISE EXCEPTION 'Template generation is not current' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_template_safety_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.meta_template_account_safety
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_template_safety();
REVOKE ALL ON FUNCTION app.preserve_meta_template_safety() FROM PUBLIC;

/** Negative-only surface. The HTTP producer verifies the signature first and
 * preserves the exact signed account, field and payload hash. Missing template
 * identity is an account-wide negative, never a parser rejection that loses it.
 * An old/positive/equal-time callback invalidates again; none clears readiness. */
CREATE FUNCTION app.invalidate_meta_template_account(connection_value uuid,session_value uuid,provider_account text,
 app_value text,payload_sha text,field_value text,template_value text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE account_row public.meta_messaging_accounts; inserted integer; current_revision bigint;
BEGIN
 IF NOT app.lock_current_active_tenant_for_event_admission() OR app.current_tenant_id() IS NULL
  OR COALESCE(provider_account,'') !~ '^[0-9]{1,32}$' OR COALESCE(app_value,'') !~ '^[0-9]{1,32}$'
  OR COALESCE(payload_sha,'') !~ '^[a-f0-9]{64}$'
  OR COALESCE(field_value,'') !~ '^message_template_[A-Za-z0-9_]{1,96}$'
  OR (template_value IS NOT NULL AND template_value !~ '^[0-9]{1,32}$') THEN
  RAISE EXCEPTION 'Template invalidation scope is unavailable' USING ERRCODE='55000'; END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||app.current_tenant_id()::text,0)) THEN
  RAISE EXCEPTION 'Template invalidation is fenced by privacy processing' USING ERRCODE='40001'; END IF;
 -- Existing lifecycle resolver includes the exact retained authenticated
 -- account context needed for conservative safety; it grants no ordinary send.
 IF NOT EXISTS(SELECT 1 FROM app.resolve_meta_lifecycle_routes(provider_account,app_value) route
  WHERE route.tenant_id=app.current_tenant_id() AND route.connection_id=connection_value
   AND route.provider_session_id=session_value AND route.waba_id=provider_account AND route.app_id=app_value) THEN
  RAISE EXCEPTION 'Template invalidation scope is unavailable' USING ERRCODE='55000'; END IF;
 SELECT * INTO account_row FROM public.meta_messaging_accounts
  WHERE tenant_id=app.current_tenant_id() AND provider_account_id=provider_account FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('accepted',false,'duplicate',false); END IF;
 INSERT INTO public.meta_template_account_safety(tenant_id,account_id)
 VALUES(account_row.tenant_id,account_row.id) ON CONFLICT DO NOTHING;
 SELECT revision INTO current_revision FROM public.meta_template_account_safety
  WHERE tenant_id=account_row.tenant_id AND account_id=account_row.id FOR UPDATE;
 INSERT INTO public.meta_template_safety_markers(tenant_id,account_id,payload_sha256,field,template_id,source_connection_id,source_session_id)
 VALUES(account_row.tenant_id,account_row.id,payload_sha,field_value,template_value,connection_value,session_value) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted=1 THEN
  UPDATE public.meta_template_account_safety SET revision=revision+1
   WHERE tenant_id=account_row.tenant_id AND account_id=account_row.id RETURNING revision INTO current_revision;
 END IF;
 RETURN jsonb_build_object('accepted',true,'duplicate',inserted=0,'revision',current_revision);
END $$;
ALTER FUNCTION app.invalidate_meta_template_account(uuid,uuid,text,text,text,text,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.invalidate_meta_template_account(uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invalidate_meta_template_account(uuid,uuid,text,text,text,text,text) TO wasalx_app;

-- Both the pre-read context and final completion use this generation. Missing
-- rows mean revision zero, not a successful prior inventory observation.
CREATE FUNCTION app.meta_template_safety_revision(account_value uuid) RETURNS bigint
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT COALESCE((SELECT revision FROM public.meta_template_account_safety
  WHERE tenant_id=app.current_tenant_id() AND account_id=account_value),0)
$$;
REVOKE ALL ON FUNCTION app.meta_template_safety_revision(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_template_safety_revision(uuid) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;

-- Accepted B1 fragment: META_TEMPLATE_PREPARATION.sql
-- Private unapplied evolution of the incumbent account transition, not another
-- operation engine. Root assigns the delivery ordinal and composes all guards.
ALTER TABLE public.meta_account_transitions
 ADD COLUMN transition_kind text NOT NULL DEFAULT 'CURRENCY' CHECK(transition_kind IN('CURRENCY','TEMPLATE_PREPARATION')),
 ADD COLUMN template_target_connection_id uuid,
 ADD COLUMN template_target_binding_id uuid,
 ADD COLUMN template_operation_id uuid,
 ADD COLUMN template_observation jsonb,
 ADD COLUMN template_observation_sha256 text CHECK(template_observation_sha256 ~ '^[a-f0-9]{64}$'),
 ADD COLUMN template_state text CHECK(template_state IN('PENDING','REVIEW','COPYING','PARTIAL','OUTCOME_UNKNOWN','READY','HELD','CANCELLED')),
 ADD FOREIGN KEY(tenant_id,template_target_connection_id) REFERENCES public.connections(tenant_id,id),
 ADD FOREIGN KEY(tenant_id,template_target_binding_id) REFERENCES public.meta_connection_account_bindings(tenant_id,id),
 ADD FOREIGN KEY(tenant_id,template_operation_id) REFERENCES public.connection_operations(tenant_id,id),
 ADD CHECK(template_observation IS NULL OR (jsonb_typeof(template_observation)='object' AND octet_length(template_observation::text)<=8388608));
ALTER TABLE public.meta_account_transitions ALTER COLUMN target_currency DROP NOT NULL;
ALTER TABLE public.meta_account_transitions ADD CONSTRAINT meta_transition_kind_shape CHECK(
 (transition_kind='CURRENCY' AND target_currency IS NOT NULL AND template_target_connection_id IS NULL AND template_target_binding_id IS NULL
  AND template_operation_id IS NULL AND template_observation IS NULL AND template_state IS NULL)
 OR (transition_kind='TEMPLATE_PREPARATION' AND target_currency IS NULL AND template_target_connection_id IS NOT NULL
  AND template_target_binding_id IS NOT NULL AND template_operation_id IS NOT NULL AND template_state IS NOT NULL));
ALTER TABLE public.meta_provider_effect_checkpoints DROP CONSTRAINT meta_provider_effect_checkpoints_stage_check;
ALTER TABLE public.meta_provider_effect_checkpoints ADD CONSTRAINT meta_provider_effect_checkpoints_stage_check
 CHECK(stage IN('ATTACH','INITIATE','COMPLETE','REVOKE','TEMPLATE_COPY'));
ALTER TABLE public.meta_provider_effect_checkpoints DROP CONSTRAINT meta_transition_arrangement_scope;
ALTER TABLE public.meta_provider_effect_checkpoints ADD CONSTRAINT meta_transition_arrangement_scope CHECK(
 arrangement_version_id IS NOT NULL OR (owner_kind='ACCOUNT_TRANSITION' AND stage IN('INITIATE','COMPLETE','TEMPLATE_COPY')));
ALTER TABLE public.meta_account_transition_reservations DROP CONSTRAINT meta_account_transition_reservations_release_reason_check;
ALTER TABLE public.meta_account_transition_reservations ADD CONSTRAINT meta_account_transition_reservations_release_reason_check
 CHECK(release_reason IN('PRE_EFFECT_CANCEL','VERIFIED_SUCCESSOR','SETTLED_TEMPLATE_COPY'));

CREATE FUNCTION app.preserve_meta_template_preparation() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.transition_kind,NEW.template_target_connection_id,NEW.template_target_binding_id)
    IS DISTINCT FROM (OLD.transition_kind,OLD.template_target_connection_id,OLD.template_target_binding_id) THEN
   RAISE EXCEPTION 'Template preparation intent is immutable' USING ERRCODE='23514';END IF;
  IF OLD.transition_kind='TEMPLATE_PREPARATION' AND current_user<>'wasalx_meta_transition_executor' THEN
   -- The existing exact membership-deletion nullification stays available.
   IF NEW.requested_by IS NULL AND OLD.requested_by IS NOT NULL
    AND (to_jsonb(NEW)-'requested_by')=(to_jsonb(OLD)-'requested_by') THEN
     IF pg_has_role(session_user,'wasalx_connector_worker','MEMBER') THEN
       IF app.meta_managed_privacy_authorized(OLD.tenant_id) THEN RETURN NEW; END IF;
     ELSE
       IF NOT EXISTS(SELECT 1 FROM public.tenant_memberships WHERE tenant_id=OLD.tenant_id AND user_id=OLD.requested_by) THEN RETURN NEW; END IF;
       IF app.meta_managed_privacy_authorized(OLD.tenant_id) THEN RETURN NEW; END IF;
     END IF;
   END IF;
   RAISE EXCEPTION 'Template preparation needs its sealed coordinator' USING ERRCODE='42501';END IF;
 ELSIF NEW.transition_kind='TEMPLATE_PREPARATION' AND current_user<>'wasalx_meta_transition_executor' THEN
  RAISE EXCEPTION 'Template preparation needs its sealed coordinator' USING ERRCODE='42501';
 END IF;
 IF NEW.transition_kind='TEMPLATE_PREPARATION' AND (NEW.provider_migration_id IS NOT NULL OR NEW.provider_status IS NOT NULL
   OR NEW.identity_successor_receipt IS NOT NULL OR NEW.execution_authorization_id IS NOT NULL
   OR NEW.execution_state<>'UNPREPARED' OR NEW.execution_scope IS NOT NULL OR NEW.execution_scope_sha256 IS NOT NULL
   OR NEW.execution_operation_id IS NOT NULL OR NEW.execution_confirmation_sha256 IS NOT NULL OR NEW.target_account_id IS NOT NULL
   OR NEW.provider_observation_operation_id IS NOT NULL OR NEW.observer_operations<>'{}'::jsonb) THEN
  RAISE EXCEPTION 'Template preparation cannot grant phone or financial transition authority' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_template_preparation_guard BEFORE INSERT OR UPDATE ON public.meta_account_transitions
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_template_preparation();
REVOKE ALL ON FUNCTION app.preserve_meta_template_preparation() FROM PUBLIC;

CREATE FUNCTION app.meta_template_stage_kind() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE kind_value text;
BEGIN
 IF NEW.owner_kind='ACCOUNT_TRANSITION' THEN
  SELECT transition_kind INTO kind_value FROM public.meta_account_transitions WHERE tenant_id=NEW.tenant_id AND id=NEW.owner_id;
  IF kind_value IS NULL OR (NEW.stage='TEMPLATE_COPY') IS DISTINCT FROM (kind_value='TEMPLATE_PREPARATION') THEN
   RAISE EXCEPTION 'Provider stage belongs to another transition purpose' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER meta_template_effect_kind BEFORE INSERT ON public.meta_provider_effect_checkpoints
 FOR EACH ROW EXECUTE FUNCTION app.meta_template_stage_kind();
REVOKE ALL ON FUNCTION app.meta_template_stage_kind() FROM PUBLIC;

CREATE FUNCTION app.meta_template_account_frame(connection_value uuid,actor_value uuid,app_value text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE frame jsonb; account_row public.meta_messaging_accounts;
BEGIN
 frame:=app.meta_account_transition_context(connection_value,actor_value,app_value);
 IF frame IS NULL THEN RAISE EXCEPTION 'Current template account is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO account_row FROM public.meta_messaging_accounts WHERE tenant_id=app.current_tenant_id() AND id=(frame->>'accountId')::uuid;
 IF account_row.id IS NULL OR account_row.observed_owner_business_id IS NULL OR account_row.requested_policy_version_id IS NULL THEN
  RAISE EXCEPTION 'Current template account is unavailable' USING ERRCODE='55000';END IF;
 RETURN frame||jsonb_build_object('observedOwnerBusinessId',account_row.observed_owner_business_id,
  'safetyRevision',app.meta_template_safety_revision(account_row.id));
END $$;
ALTER FUNCTION app.meta_template_account_frame(uuid,uuid,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_template_account_frame(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_account_transition_context(uuid,uuid,text) TO wasalx_meta_transition_executor;

CREATE FUNCTION app.meta_template_action_result(plan_value uuid,operation_value uuid,duplicate_value boolean) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT jsonb_build_object('id',plan_value,'operationId',o.id,'duplicate',duplicate_value,
  'pendingAction',jsonb_build_object('operationId',o.id,'requestKey',o.idempotency_key,
   'action',o.payload#>>'{metaTemplatePreparation,stage}',
   'requestRevision',(o.payload#>>'{metaTemplatePreparation,requestRevision}')::bigint,
   'state',CASE WHEN o.state='FAILED_RETRYABLE' THEN 'FAILED_TERMINAL' ELSE o.state END))
 FROM public.connection_operations o WHERE o.tenant_id=app.current_tenant_id() AND o.id=operation_value
  AND o.payload#>>'{metaTemplatePreparation,id}'=plan_value::text
$$;
ALTER FUNCTION app.meta_template_action_result(uuid,uuid,boolean) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_template_action_result(uuid,uuid,boolean) FROM PUBLIC;

-- A COPY confirmation belongs to the exact completed observation, including
-- assigned and conversation-pinned dependencies and every account phone. The
-- existing immutable operation payload owns those frames; no fresh COPY frame
-- may silently replace them. An explicit OBSERVE can establish a new receipt.
CREATE FUNCTION app.meta_template_observation_scope_current(plan_value uuid,frames_value jsonb) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;o public.connection_operations;scope_value jsonb;
BEGIN
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value
  AND transition_kind='TEMPLATE_PREPARATION';
 IF p.id IS NULL OR p.template_observation IS NULL THEN RETURN false;END IF;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=p.tenant_id
  AND id=(p.template_observation->>'observationOperationId')::uuid AND state='SUCCEEDED'
  AND payload#>>'{metaTemplatePreparation,id}'=p.id::text;
 scope_value:=jsonb_build_object('source',o.payload#>'{metaTemplatePreparation,source}',
  'target',o.payload#>'{metaTemplatePreparation,target}');
 RETURN COALESCE(o.id IS NOT NULL AND scope_value=frames_value
  AND o.result#>'{metaTemplatePreparation,observation}'=p.template_observation
  AND o.result#>>'{metaTemplatePreparation,observationSha256}'=p.template_observation_sha256
  AND o.result#>>'{metaTemplatePreparation,scopeSha256}'=encode(public.digest(scope_value::text,'sha256'),'hex'),false);
END $$;
ALTER FUNCTION app.meta_template_observation_scope_current(uuid,jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_template_observation_scope_current(uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION app.meta_template_operation_context(operation_value uuid,lease_value uuid,fence_value bigint,app_value text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE o public.connection_operations;p public.meta_account_transitions;source_frame jsonb;target_frame jsonb;frame jsonb;frames jsonb;
BEGIN
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 IF o.id IS NULL OR o.state<>'RUNNING' OR o.lease_id IS DISTINCT FROM lease_value OR o.fencing_token IS DISTINCT FROM fence_value
  OR o.lease_expires_at<clock_timestamp() OR o.requested_by_type<>'USER'
  OR COALESCE(o.payload#>>'{metaTemplatePreparation,stage}','') NOT IN('OBSERVE','COPY','RECONCILE') THEN
  RAISE EXCEPTION 'Template operation lease is unavailable' USING ERRCODE='55000';END IF;
 PERFORM app.meta_transition_actor_current(o.requested_by_id::uuid);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id AND id=(o.payload#>>'{metaTemplatePreparation,id}')::uuid;
 IF p.id IS NULL OR p.transition_kind<>'TEMPLATE_PREPARATION' OR p.state='CANCELLED'
  OR p.initiating_connection_id<>o.connection_id OR p.template_operation_id<>o.id
  OR p.revision<>(o.payload#>>'{metaTemplatePreparation,revision}')::bigint THEN
  RAISE EXCEPTION 'Template operation has lost its current intent' USING ERRCODE='55000';END IF;
 frames:=app.meta_template_frames(p.initiating_connection_id,p.template_target_connection_id,o.requested_by_id::uuid,app_value);
 IF o.payload#>>'{metaTemplatePreparation,stage}'='COPY' AND NOT app.meta_template_observation_scope_current(p.id,frames) THEN
  RAISE EXCEPTION 'Observed template scope changed; observe again' USING ERRCODE='55000';END IF;
 source_frame:=frames->'source';target_frame:=frames->'target';
 IF source_frame IS DISTINCT FROM o.payload#>'{metaTemplatePreparation,source}'
  OR target_frame IS DISTINCT FROM o.payload#>'{metaTemplatePreparation,target}'
  OR source_frame->>'accountId'<>p.source_account_id::text
  OR source_frame->>'bindingId'<>p.initiating_binding_id::text
  OR target_frame->>'bindingId'<>p.template_target_binding_id::text
  OR source_frame->>'observedOwnerBusinessId' IS DISTINCT FROM target_frame->>'observedOwnerBusinessId' THEN
  RAISE EXCEPTION 'Template source, target or signed generation has changed' USING ERRCODE='55000';END IF;
 PERFORM app.lock_meta_transition_accounts(ARRAY[(source_frame->>'accountId')::uuid,(target_frame->>'accountId')::uuid]);
 PERFORM 1 FROM public.connection_operations WHERE tenant_id=o.tenant_id AND id=o.id AND state='RUNNING'
  AND lease_id=lease_value AND fencing_token=fence_value AND lease_expires_at>=clock_timestamp() FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Template operation lease is unavailable' USING ERRCODE='55000';END IF;
 frame:=jsonb_build_object('transitionId',p.id,'revision',p.revision,'stage',o.payload#>>'{metaTemplatePreparation,stage}',
  'actorId',o.requested_by_id,'source',source_frame,'target',target_frame,'appId',app_value,'graphVersion','v24.0',
  'selectedSourceIds',COALESCE(o.payload#>'{metaTemplatePreparation,selectedSourceIds}','[]'::jsonb),
  'selectedInventory',o.payload#>'{metaTemplatePreparation,selectedInventory}',
  'selectedTargetInventory',o.payload#>'{metaTemplatePreparation,selectedTargetInventory}');
 RETURN frame||jsonb_build_object('contextSha256',encode(public.digest(frame::text,'sha256'),'hex'));
END $$;
ALTER FUNCTION app.meta_template_operation_context(uuid,uuid,bigint,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_template_operation_context(uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_template_operation_context(uuid,uuid,bigint,text) TO wasalx_connector_worker;

-- Callers lock the complete two-account scope before invoking the incumbent
-- frame producer, preserving its connection -> account lock order.
CREATE FUNCTION app.meta_template_frames(source_connection uuid,target_connection uuid,actor_value uuid,app_value text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE ids uuid[];source_frame jsonb;target_frame jsonb;
BEGIN
 PERFORM app.meta_transition_actor_current(actor_value);
 SELECT array_agg(DISTINCT account_id ORDER BY account_id) INTO ids FROM public.meta_connection_account_bindings
  WHERE tenant_id=app.current_tenant_id() AND connection_id IN(source_connection,target_connection) AND state='ACTIVE';
 IF source_connection=target_connection OR cardinality(ids) IS DISTINCT FROM 2 THEN
  RAISE EXCEPTION 'Two current account bindings are required' USING ERRCODE='55000';END IF;
 PERFORM app.lock_meta_transition_accounts(ids);
 source_frame:=app.meta_template_account_frame(source_connection,actor_value,app_value);
 target_frame:=app.meta_template_account_frame(target_connection,actor_value,app_value);
 IF source_frame->>'accountId'=target_frame->>'accountId'
  OR source_frame->>'observedOwnerBusinessId' IS DISTINCT FROM target_frame->>'observedOwnerBusinessId' THEN
  RAISE EXCEPTION 'Template account selection is not current' USING ERRCODE='55000';END IF;
 RETURN jsonb_build_object('source',source_frame,'target',target_frame);
END $$;
ALTER FUNCTION app.meta_template_frames(uuid,uuid,uuid,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_template_frames(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assert_meta_account_unreserved(uuid) TO wasalx_meta_transition_executor;
GRANT EXECUTE ON FUNCTION app.meta_runtime_message_admission_current(jsonb,jsonb) TO wasalx_meta_transition_executor;

CREATE FUNCTION app.meta_template_create_result(operation_value uuid,duplicate_value boolean) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT jsonb_build_object('operationId',o.id,'duplicate',duplicate_value,'requestKey',o.idempotency_key,
  'request',o.payload#>'{metaTemplatePreparation,createRequest}',
  'state',CASE WHEN o.payload#>>'{metaTemplatePreparation,localResolution}'='NO_ADMISSION' THEN 'NO_EFFECT' ELSE 'ADMITTED' END,
  'id',o.payload#>>'{metaTemplatePreparation,id}',
  'pendingAction',CASE WHEN o.payload#>>'{metaTemplatePreparation,localResolution}'='NO_ADMISSION' THEN NULL
   ELSE app.meta_template_action_result((o.payload#>>'{metaTemplatePreparation,id}')::uuid,o.id,duplicate_value)->'pendingAction' END)
 FROM public.connection_operations o WHERE o.tenant_id=app.current_tenant_id() AND o.id=operation_value
  AND o.payload#>>'{metaTemplatePreparation,requestKind}'='CREATE'
$$;
ALTER FUNCTION app.meta_template_create_result(uuid,boolean) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_template_create_result(uuid,boolean) FROM PUBLIC;

-- Collection resolve and create use the SAME key lock and original operation
-- ledger. A no-admission tombstone can never acquire a plan or dispatch slot.
CREATE FUNCTION app.request_meta_template_preparation(connection_value uuid,actor_value uuid,app_value text,
 key_value text,body_value jsonb,request_value text,resolve_value boolean) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE frames jsonb;source_frame jsonb;target_frame jsonb;o public.connection_operations;
 plan_id uuid:=gen_random_uuid();operation_id uuid:=gen_random_uuid();target_connection uuid;request_sha text;mode_value text;
BEGIN
 PERFORM app.meta_transition_actor_current(actor_value);PERFORM app.lock_meta_transition_request(key_value);
 IF jsonb_typeof(body_value) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(body_value))<>3
  OR COALESCE(body_value->>'targetConnectionId','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR jsonb_typeof(body_value->'expectedAccountRevision') IS DISTINCT FROM 'number'
  OR jsonb_typeof(body_value->'expectedBindingRevision') IS DISTINCT FROM 'number'
  OR COALESCE(body_value->>'expectedAccountRevision','') !~ '^[1-9][0-9]{0,15}$'
  OR COALESCE(body_value->>'expectedBindingRevision','') !~ '^[1-9][0-9]{0,15}$'
  OR (body_value->>'expectedAccountRevision')::numeric>9007199254740991
  OR (body_value->>'expectedBindingRevision')::numeric>9007199254740991 THEN
  RAISE EXCEPTION 'Invalid template preparation request' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM public.connections WHERE tenant_id=app.current_tenant_id() AND id=connection_value AND provider='META';
 IF NOT FOUND THEN RAISE EXCEPTION 'Connection is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND idempotency_key=key_value;
 IF FOUND THEN
  IF o.connection_id<>connection_value OR o.requested_by_type<>'USER' OR o.requested_by_id<>actor_value::text
   OR o.payload#>>'{metaTemplatePreparation,requestKind}' IS DISTINCT FROM 'CREATE'
   OR o.payload#>'{metaTemplatePreparation,createRequest}' IS DISTINCT FROM body_value THEN
   RAISE EXCEPTION 'Request key belongs to another intent' USING ERRCODE='23514';END IF;
  RETURN app.meta_template_create_result(o.id,true);
 END IF;
 IF resolve_value THEN
  INSERT INTO public.connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,
   requested_by_id,request_id,max_attempts,state,completed_at,result)
  VALUES(operation_id,app.current_tenant_id(),connection_value,'EXECUTE_META_ACCOUNT_TRANSITION',key_value,
   jsonb_build_object('metaTemplatePreparation',jsonb_build_object('requestKind','CREATE','createRequest',body_value,'localResolution','NO_ADMISSION')),
   'USER',actor_value::text,request_value,1,'CANCELLED',clock_timestamp(),jsonb_build_object('metaTemplateResolution','NOT_ADMITTED'));
  RETURN app.meta_template_create_result(operation_id,false);
 END IF;
 target_connection:=(body_value->>'targetConnectionId')::uuid;
 frames:=app.meta_template_frames(connection_value,target_connection,actor_value,app_value);
 source_frame:=frames->'source';target_frame:=frames->'target';
 IF (source_frame->>'accountRevision')::bigint<>(body_value->>'expectedAccountRevision')::bigint
  OR (source_frame->>'bindingRevision')::bigint<>(body_value->>'expectedBindingRevision')::bigint THEN
  RAISE EXCEPTION 'Template account selection is not current' USING ERRCODE='55000';END IF;
 PERFORM app.assert_meta_account_unreserved((source_frame->>'accountId')::uuid);
 PERFORM app.assert_meta_account_unreserved((target_frame->>'accountId')::uuid);
 IF EXISTS(SELECT 1 FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id()
  AND source_account_id=(source_frame->>'accountId')::uuid AND state<>'CANCELLED' AND execution_state<>'RECONCILED_PAUSED') THEN
  RAISE EXCEPTION 'Close the current account review before preparing another' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value
  AND state IN('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE')) THEN RAISE EXCEPTION 'Account work is still active' USING ERRCODE='55000';END IF;
 request_sha:=encode(public.digest(jsonb_build_object('connectionId',connection_value,'request',body_value)::text,'sha256'),'hex');
 mode_value:=CASE WHEN source_frame->>'declaredMode'='MANAGED' THEN 'WASALX_MANAGED' ELSE 'CUSTOMER' END;
 INSERT INTO public.connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,requested_by_id,request_id,max_attempts)
 VALUES(operation_id,app.current_tenant_id(),connection_value,'PREVIEW_META_ACCOUNT_TRANSITION',key_value,
  jsonb_build_object('metaAccountTransition',jsonb_build_object('id',plan_id,'accountId',source_frame->>'accountId'),
   'metaTemplatePreparation',jsonb_build_object('id',plan_id,'stage','OBSERVE','requestKind','CREATE','createRequest',body_value,
    'revision',1,'requestRevision',1,'requestObservationSha256',NULL,'requestChoices',NULL,'source',source_frame,'target',target_frame)),
  'USER',actor_value::text,request_value,1);
 INSERT INTO public.meta_account_transitions(id,tenant_id,source_account_id,initiating_connection_id,initiating_binding_id,requested_by,
  requested_mode,target_currency,request_sha256,idempotency_key,initial_account_revision,initial_binding_revision,current_observation_operation_id,
  transition_kind,template_target_connection_id,template_target_binding_id,template_operation_id,template_state)
 VALUES(plan_id,app.current_tenant_id(),(source_frame->>'accountId')::uuid,connection_value,(source_frame->>'bindingId')::uuid,actor_value,
  mode_value,NULL,request_sha,key_value,(body_value->>'expectedAccountRevision')::bigint,(body_value->>'expectedBindingRevision')::bigint,operation_id,
  'TEMPLATE_PREPARATION',target_connection,(target_frame->>'bindingId')::uuid,operation_id,'PENDING');
 RETURN app.meta_template_create_result(operation_id,false);
END $$;
ALTER FUNCTION app.request_meta_template_preparation(uuid,uuid,text,text,jsonb,text,boolean) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.request_meta_template_preparation(uuid,uuid,text,text,jsonb,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_meta_template_preparation(uuid,uuid,text,text,jsonb,text,boolean) TO wasalx_app;

CREATE FUNCTION app.request_meta_template_action(plan_value uuid,connection_value uuid,actor_value uuid,app_value text,
 key_value text,action_value text,body_value jsonb,request_value text,resolve_value boolean) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;o public.connection_operations;frames jsonb;source_frame jsonb;target_frame jsonb;
 selected_ids jsonb;selected_count integer;operation_id uuid:=gen_random_uuid();next_revision bigint;prior_slot public.meta_provider_effect_checkpoints;
BEGIN
 PERFORM app.meta_transition_actor_current(actor_value);PERFORM app.lock_meta_transition_request(key_value);
 IF COALESCE(action_value,'') NOT IN('OBSERVE','COPY','RECONCILE') OR jsonb_typeof(body_value) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(body_value))<>(CASE WHEN action_value='COPY' THEN 3 ELSE 2 END)
  OR jsonb_typeof(body_value->'expectedRevision') IS DISTINCT FROM 'number'
  OR COALESCE(body_value->>'expectedRevision','') !~ '^[1-9][0-9]{0,15}$'
  OR (body_value->>'expectedRevision')::numeric>9007199254740991 OR NOT(body_value ? 'expectedObservationSha256')
  OR (body_value->>'expectedObservationSha256' IS NOT NULL AND body_value->>'expectedObservationSha256' !~ '^[a-f0-9]{64}$') THEN
  RAISE EXCEPTION 'Invalid template action' USING ERRCODE='23514';END IF;
 IF action_value='COPY' THEN
  IF body_value->>'expectedObservationSha256' IS NULL OR jsonb_typeof(body_value->'choices') IS DISTINCT FROM 'array'
   OR jsonb_array_length(body_value->'choices') NOT BETWEEN 1 AND 500
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(body_value->'choices') c WHERE jsonb_typeof(c)<>'string'
     OR c#>>'{}' !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') THEN
   RAISE EXCEPTION 'Invalid template choices' USING ERRCODE='23514';END IF;
  IF (SELECT count(DISTINCT lower(c#>>'{}')) FROM jsonb_array_elements(body_value->'choices') c)<>jsonb_array_length(body_value->'choices') THEN
   RAISE EXCEPTION 'Template choices are duplicated' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value
  AND initiating_connection_id=connection_value AND transition_kind='TEMPLATE_PREPARATION';
 IF p.id IS NULL THEN RAISE EXCEPTION 'Template preparation is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=p.tenant_id AND idempotency_key=key_value;
 IF FOUND THEN
  IF o.connection_id<>connection_value OR o.requested_by_type<>'USER' OR o.requested_by_id<>actor_value::text
   OR o.payload#>>'{metaTemplatePreparation,id}' IS DISTINCT FROM p.id::text
   OR o.payload#>>'{metaTemplatePreparation,stage}' IS DISTINCT FROM action_value
   OR o.payload#>'{metaTemplatePreparation,actionRequest}' IS DISTINCT FROM body_value THEN
   RAISE EXCEPTION 'Request key belongs to another intent' USING ERRCODE='23514';END IF;
  RETURN app.meta_template_action_result(p.id,o.id,true);
 END IF;
 IF resolve_value THEN
  INSERT INTO public.connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,
   requested_by_id,request_id,max_attempts,state,completed_at,result)
  VALUES(operation_id,p.tenant_id,connection_value,'EXECUTE_META_ACCOUNT_TRANSITION',key_value,
   jsonb_build_object('metaTemplatePreparation',jsonb_build_object('id',p.id,'stage',action_value,'actionRequest',body_value,
    'requestRevision',(body_value->>'expectedRevision')::bigint,'localResolution','NO_ADMISSION')),
   'USER',actor_value::text,request_value,1,'CANCELLED',clock_timestamp(),jsonb_build_object('metaTemplateResolution','NOT_ADMITTED'));
  RETURN app.meta_template_action_result(p.id,operation_id,false);
 END IF;
 frames:=app.meta_template_frames(connection_value,p.template_target_connection_id,actor_value,app_value);
 source_frame:=frames->'source';target_frame:=frames->'target';
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=p.tenant_id AND id=p.id FOR UPDATE;
 IF p.state='CANCELLED' OR p.revision<>(body_value->>'expectedRevision')::bigint
  OR p.template_observation_sha256 IS DISTINCT FROM body_value->>'expectedObservationSha256'
  OR source_frame->>'accountId'<>p.source_account_id::text OR source_frame->>'bindingId'<>p.initiating_binding_id::text
  OR target_frame->>'bindingId'<>p.template_target_binding_id::text
  OR EXISTS(SELECT 1 FROM public.connection_operations WHERE tenant_id=p.tenant_id AND connection_id=connection_value
   AND state IN('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
  RAISE EXCEPTION 'Template action is no longer current' USING ERRCODE='55000';END IF;
 SELECT * INTO prior_slot FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id
  AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=p.id AND stage='TEMPLATE_COPY';
 IF EXISTS(SELECT 1 FROM public.meta_account_transition_reservations WHERE tenant_id=p.tenant_id
  AND account_id IN((source_frame->>'accountId')::uuid,(target_frame->>'accountId')::uuid) AND released_at IS NULL AND transition_id<>p.id) THEN
  RAISE EXCEPTION 'Account authority is reserved' USING ERRCODE='55000';END IF;
 IF action_value='COPY' THEN
  IF NOT app.meta_template_observation_scope_current(p.id,frames) THEN
   RAISE EXCEPTION 'Observed template scope changed; observe again' USING ERRCODE='55000';END IF;
  IF prior_slot.id IS NOT NULL OR p.template_state NOT IN('REVIEW','PARTIAL','READY') OR p.expires_at<=clock_timestamp()
   OR p.template_observation#>>'{source,complete}' IS DISTINCT FROM 'true'
   OR p.template_observation#>>'{target,complete}' IS DISTINCT FROM 'true'
   OR p.template_observation->>'sourceSafetyRevision' IS DISTINCT FROM source_frame->>'safetyRevision'
   OR p.template_observation->>'targetSafetyRevision' IS DISTINCT FROM target_frame->>'safetyRevision' THEN
   RAISE EXCEPTION 'Template copy requires a fresh unchanged selection' USING ERRCODE='55000';END IF;
  SELECT jsonb_agg(c->>'sourceTemplateId' ORDER BY c->>'sourceTemplateId'),count(*) INTO selected_ids,selected_count
   FROM jsonb_array_elements(p.template_observation->'choices') c
   WHERE c->>'selectable'='true' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(body_value->'choices') wanted WHERE lower(wanted)=c->>'id');
  IF selected_count<>jsonb_array_length(body_value->'choices') THEN RAISE EXCEPTION 'Template selection is unavailable' USING ERRCODE='55000';END IF;
 END IF;
 next_revision:=p.revision+1;
 INSERT INTO public.connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,requested_by_id,request_id,max_attempts)
 VALUES(operation_id,p.tenant_id,connection_value,'EXECUTE_META_ACCOUNT_TRANSITION',key_value,
  jsonb_build_object('metaTemplatePreparation',jsonb_build_object('id',p.id,'stage',action_value,'actionRequest',body_value,
   'revision',next_revision,'requestRevision',p.revision,'requestObservationSha256',p.template_observation_sha256,
   'source',source_frame,'target',target_frame,'selectedSourceIds',COALESCE(selected_ids,'[]'::jsonb),
   'selectedInventory',CASE WHEN action_value='COPY' THEN p.template_observation->'source' ELSE NULL END,
   'selectedTargetInventory',CASE WHEN action_value='COPY' THEN p.template_observation->'target' ELSE NULL END)),
  'USER',actor_value::text,request_value,1);
 UPDATE public.meta_account_transitions SET template_operation_id=operation_id,revision=next_revision,
  template_state=CASE WHEN action_value='COPY' THEN 'COPYING' ELSE 'PENDING' END,updated_at=now() WHERE tenant_id=p.tenant_id AND id=p.id;
 RETURN app.meta_template_action_result(p.id,operation_id,false);
END $$;
ALTER FUNCTION app.request_meta_template_action(uuid,uuid,uuid,text,text,text,jsonb,text,boolean) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.request_meta_template_action(uuid,uuid,uuid,text,text,text,jsonb,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_meta_template_action(uuid,uuid,uuid,text,text,text,jsonb,text,boolean) TO wasalx_app;

CREATE FUNCTION app.reserve_meta_template_copy(operation_value uuid,lease_value uuid,fence_value bigint,app_value text,
 request_sha text,execution_value jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE o public.connection_operations;p public.meta_account_transitions;c public.meta_provider_effect_checkpoints;ctx jsonb;
 source_frame jsonb;target_frame jsonb;target_account public.meta_messaging_accounts;existing_reservation public.meta_account_transition_reservations;
 account_value uuid;frame jsonb;
BEGIN
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id AND id=(o.payload#>>'{metaTemplatePreparation,id}')::uuid
  AND transition_kind='TEMPLATE_PREPARATION';
 IF p.id IS NULL OR o.payload#>>'{metaTemplatePreparation,stage}' IS DISTINCT FROM 'COPY'
  OR COALESCE(request_sha,'') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Template copy is unavailable' USING ERRCODE='55000';END IF;
 -- Return the historical slot before any new authorization can be created.
 PERFORM app.lock_meta_transition_accounts(ARRAY[p.source_account_id,(o.payload#>>'{metaTemplatePreparation,target,accountId}')::uuid]);
 SELECT * INTO c FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION'
  AND owner_id=p.id AND stage='TEMPLATE_COPY';
 IF FOUND THEN RETURN jsonb_build_object('disposition','HISTORICAL_NO_POST','id',c.id,'outcome',c.outcome);END IF;
 ctx:=app.meta_template_operation_context(o.id,lease_value,fence_value,app_value);
 source_frame:=ctx->'source';target_frame:=ctx->'target';
 SELECT * INTO target_account FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=(target_frame->>'accountId')::uuid;
 IF ctx->>'stage'<>'COPY' OR p.expires_at<=clock_timestamp()
  OR p.template_observation_sha256 IS DISTINCT FROM o.payload#>>'{metaTemplatePreparation,requestObservationSha256}'
  OR jsonb_array_length(ctx->'selectedSourceIds') NOT BETWEEN 1 AND 500
  OR COALESCE(execution_value->>'mode','') NOT IN('LIVE','SIMULATED')
  OR NOT app.meta_runtime_message_admission_current(jsonb_build_object('schemaVersion',2,'claim','ACCOUNT_POLICY_BOUND',
   'tenantId',p.tenant_id,'accountId',target_account.id,'payment',jsonb_build_object('mode',CASE WHEN target_frame->>'declaredMode'='MANAGED' THEN 'MANAGED' ELSE 'CUSTOMER' END)),execution_value)
  OR target_account.active_policy_version_id IS NULL THEN
  RAISE EXCEPTION 'Template copy authority is not current' USING ERRCODE='55000';END IF;
 -- This is only a bounded template-copy reservation. It never changes phone,
 -- account ownership, payment policy, source routing or external subscriptions.
 FOR frame IN SELECT value FROM jsonb_array_elements(jsonb_build_array(source_frame,target_frame)) LOOP
  account_value:=(frame->>'accountId')::uuid;
  SELECT * INTO existing_reservation FROM public.meta_account_transition_reservations WHERE tenant_id=p.tenant_id
   AND account_id=account_value AND released_at IS NULL;
  IF FOUND AND existing_reservation.transition_id<>p.id THEN RAISE EXCEPTION 'Account authority is reserved' USING ERRCODE='55000';END IF;
  IF NOT FOUND THEN
   INSERT INTO public.meta_account_transition_reservations(tenant_id,account_id,transition_id,account_role,scope_sha256,authority_revision)
    VALUES(p.tenant_id,account_value,p.id,CASE WHEN account_value=p.source_account_id THEN 'SOURCE' ELSE 'TARGET' END,
     encode(public.digest(frame::text,'sha256'),'hex'),(frame->>'accountRevision')::bigint);
  END IF;
 END LOOP;
 INSERT INTO public.meta_provider_effect_checkpoints(tenant_id,account_id,owner_kind,owner_id,stage,original_operation_id,
  original_fencing_token,authority_revision,policy_version_id,arrangement_version_id,runtime_execution,request_sha256)
 VALUES(p.tenant_id,target_account.id,'ACCOUNT_TRANSITION',p.id,'TEMPLATE_COPY',o.id,o.fencing_token,
  target_account.authority_revision,target_account.active_policy_version_id,NULL,execution_value,request_sha) RETURNING * INTO c;
 RETURN jsonb_build_object('disposition','NEW_ATTEMPT','id',c.id,'reservationToken',c.reservation_token);
END $$;
ALTER FUNCTION app.reserve_meta_template_copy(uuid,uuid,bigint,text,text,jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.reserve_meta_template_copy(uuid,uuid,bigint,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reserve_meta_template_copy(uuid,uuid,bigint,text,text,jsonb) TO wasalx_connector_worker;

CREATE FUNCTION app.record_meta_template_copy_response(checkpoint_value uuid,reservation_value uuid,outcome_value text,result_value jsonb)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE c public.meta_provider_effect_checkpoints;result_sha text;
BEGIN
 SELECT * INTO c FROM public.meta_provider_effect_checkpoints WHERE tenant_id=app.current_tenant_id() AND id=checkpoint_value FOR UPDATE;
 IF c.id IS NULL OR c.owner_kind<>'ACCOUNT_TRANSITION' OR c.stage<>'TEMPLATE_COPY'
  OR c.reservation_token IS DISTINCT FROM reservation_value OR COALESCE(outcome_value,'') NOT IN('SUCCEEDED','REJECTED','UNKNOWN')
  OR jsonb_typeof(result_value) IS DISTINCT FROM 'object' OR octet_length(result_value::text)>262144
  OR NOT EXISTS(SELECT 1 FROM public.meta_account_transitions WHERE tenant_id=c.tenant_id AND id=c.owner_id AND transition_kind='TEMPLATE_PREPARATION') THEN
  RAISE EXCEPTION 'Original copy response is unavailable' USING ERRCODE='55000';END IF;
 result_sha:=encode(public.digest(result_value::text,'sha256'),'hex');
 IF c.outcome<>'ATTEMPTED' THEN RETURN c.outcome=outcome_value AND c.result_sha256=result_sha;END IF;
 IF outcome_value='SUCCEEDED' AND (jsonb_typeof(result_value->'migratedTemplateIds') IS DISTINCT FROM 'array'
   OR jsonb_typeof(result_value->'failedSourceTemplateIds') IS DISTINCT FROM 'array'
   OR result_value->>'completeResponse' IS DISTINCT FROM 'true') THEN
  RAISE EXCEPTION 'Copy response is incomplete' USING ERRCODE='23514';END IF;
 UPDATE public.meta_provider_effect_checkpoints SET outcome=outcome_value,result=result_value,result_sha256=result_sha,settled_at=clock_timestamp()
  WHERE tenant_id=c.tenant_id AND id=c.id;
 -- Lease loss cannot lose an original response or create another POST slot.
 -- It also cannot publish readiness; that is a separate current GET operation.
 RETURN true;
END $$;
ALTER FUNCTION app.record_meta_template_copy_response(uuid,uuid,text,jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.record_meta_template_copy_response(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_meta_template_copy_response(uuid,uuid,text,jsonb) TO wasalx_connector_worker;

CREATE FUNCTION app.complete_meta_template_observation(operation_value uuid,lease_value uuid,fence_value bigint,app_value text,
 context_sha text,observation_value jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE ctx jsonb;p public.meta_account_transitions;o public.connection_operations;account_value uuid;expected_revision bigint;
 safety public.meta_template_account_safety;slot public.meta_provider_effect_checkpoints;obs jsonb;complete_value boolean;ready_value boolean;
 choice_values jsonb;new_state text;source_account uuid;target_account uuid;
BEGIN
 ctx:=app.meta_template_operation_context(operation_value,lease_value,fence_value,app_value);
 IF ctx->>'contextSha256' IS DISTINCT FROM context_sha OR jsonb_typeof(observation_value) IS DISTINCT FROM 'object'
  OR observation_value->>'schemaVersion' IS DISTINCT FROM '1' OR octet_length(observation_value::text)>8388608
  OR jsonb_typeof(observation_value->'choices') IS DISTINCT FROM 'array' OR jsonb_array_length(observation_value->'choices')>2000
  OR jsonb_typeof(observation_value->'dependencies') IS DISTINCT FROM 'array' OR jsonb_array_length(observation_value->'dependencies')>40000
  OR jsonb_typeof(observation_value->'metaFlowDependencyCount') IS DISTINCT FROM 'number'
  OR COALESCE(observation_value->>'metaFlowDependencyCount','') !~ '^[0-9]{1,8}$'
  OR observation_value#>>'{source,accountId}' IS DISTINCT FROM ctx#>>'{source,providerAccountId}'
  OR observation_value#>>'{target,accountId}' IS DISTINCT FROM ctx#>>'{target,providerAccountId}'
  OR observation_value->>'sourceSafetyRevision' IS DISTINCT FROM ctx#>>'{source,safetyRevision}'
  OR observation_value->>'targetSafetyRevision' IS DISTINCT FROM ctx#>>'{target,safetyRevision}' THEN RETURN false;END IF;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id AND id=(ctx->>'transitionId')::uuid FOR UPDATE;
 source_account:=(ctx#>>'{source,accountId}')::uuid;target_account:=(ctx#>>'{target,accountId}')::uuid;
 -- Ingress takes account SHARE then the generation row UPDATE. The account
 -- locks already held here plus both row locks make the final CAS atomic.
 FOR account_value IN SELECT value FROM unnest(ARRAY[source_account,target_account]) value ORDER BY value LOOP
  INSERT INTO public.meta_template_account_safety(tenant_id,account_id) VALUES(p.tenant_id,account_value) ON CONFLICT DO NOTHING;
  SELECT * INTO safety FROM public.meta_template_account_safety WHERE tenant_id=p.tenant_id AND account_id=account_value FOR UPDATE;
  expected_revision:=CASE WHEN account_value=source_account THEN (ctx#>>'{source,safetyRevision}')::bigint ELSE (ctx#>>'{target,safetyRevision}')::bigint END;
  IF safety.revision<>expected_revision THEN RAISE EXCEPTION 'Signed template change supersedes observation' USING ERRCODE='55000';END IF;
 END LOOP;
 SELECT COALESCE(jsonb_agg(c||jsonb_build_object('id',gen_random_uuid()) ORDER BY c->>'sourceTemplateId'),'[]'::jsonb)
  INTO choice_values FROM jsonb_array_elements(observation_value->'choices') c;
 obs:=observation_value||jsonb_build_object('choices',choice_values,'observationOperationId',o.id);
 complete_value:=observation_value#>>'{source,complete}'='true' AND observation_value#>>'{target,complete}'='true';
 ready_value:=complete_value AND (observation_value->>'metaFlowDependencyCount')::integer=0
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(observation_value->'dependencies') d WHERE d->>'ready' IS DISTINCT FROM 'true');
 SELECT * INTO slot FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=p.id AND stage='TEMPLATE_COPY';
 new_state:=CASE WHEN slot.outcome IN('ATTEMPTED','UNKNOWN') THEN 'OUTCOME_UNKNOWN'
  WHEN NOT COALESCE(complete_value,false) THEN 'HELD'
  WHEN slot.outcome='SUCCEEDED' AND jsonb_array_length(slot.result->'failedSourceTemplateIds')>0 THEN 'PARTIAL'
  WHEN ready_value THEN 'READY' ELSE 'REVIEW' END;
 -- Full inventory is a separate observation. It cannot settle an original
 -- ATTEMPTED/UNKNOWN copy, clear its reservation or confer cutover authority.
 IF complete_value THEN
  UPDATE public.meta_template_account_safety SET observed_revision=revision,observation_operation_id=o.id,observed_at=clock_timestamp(),
   inventory_sha256=encode(public.digest((CASE WHEN account_id=source_account THEN observation_value->'source' ELSE observation_value->'target' END)::text,'sha256'),'hex')
   WHERE tenant_id=p.tenant_id AND account_id IN(source_account,target_account);
 END IF;
 UPDATE public.meta_account_transitions SET template_observation=obs,
  template_observation_sha256=encode(public.digest(obs::text,'sha256'),'hex'),template_state=new_state,
  observed_at=clock_timestamp(),expires_at=clock_timestamp()+interval '10 minutes',revision=revision+1,updated_at=now()
  WHERE tenant_id=p.tenant_id AND id=p.id;
 UPDATE public.connection_operations SET state='SUCCEEDED',result=jsonb_build_object('metaTemplatePreparation',jsonb_build_object(
  'planId',p.id,'observationSha256',encode(public.digest(obs::text,'sha256'),'hex'),'observation',obs,
  'scopeSha256',encode(public.digest(jsonb_build_object('source',ctx->'source','target',ctx->'target')::text,'sha256'),'hex'),
  'complete',complete_value,'state',new_state)),
  lease_id=NULL,lease_expires_at=NULL,completed_at=clock_timestamp(),updated_at=now() WHERE tenant_id=o.tenant_id AND id=o.id;
 IF slot.outcome IN('SUCCEEDED','REJECTED') THEN
  UPDATE public.meta_account_transition_reservations SET released_at=clock_timestamp(),release_reason='SETTLED_TEMPLATE_COPY',revision=revision+1
   WHERE tenant_id=p.tenant_id AND transition_id=p.id AND released_at IS NULL;
 END IF;
 RETURN true;
END $$;
ALTER FUNCTION app.complete_meta_template_observation(uuid,uuid,bigint,text,text,jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.complete_meta_template_observation(uuid,uuid,bigint,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_meta_template_observation(uuid,uuid,bigint,text,text,jsonb) TO wasalx_connector_worker;

CREATE FUNCTION app.cancel_meta_template_preparation(plan_value uuid,connection_value uuid,actor_value uuid,revision_value bigint) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;slot public.meta_provider_effect_checkpoints;target_account uuid;
BEGIN
 PERFORM app.meta_transition_actor_current(actor_value);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value
  AND initiating_connection_id=connection_value AND transition_kind='TEMPLATE_PREPARATION';
 IF p.id IS NULL THEN RAISE EXCEPTION 'Template preparation is unavailable' USING ERRCODE='55000';END IF;
 SELECT account_id INTO target_account FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=p.template_target_binding_id;
 PERFORM app.lock_meta_transition_accounts(ARRAY[p.source_account_id,target_account]);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=p.tenant_id AND id=p.id FOR UPDATE;
 IF p.state='CANCELLED' AND p.revision=revision_value+1 THEN RETURN jsonb_build_object('id',p.id,'duplicate',true);END IF;
 SELECT * INTO slot FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=p.id AND stage='TEMPLATE_COPY';
 IF p.state='CANCELLED' OR p.revision<>revision_value OR slot.outcome IN('ATTEMPTED','UNKNOWN') THEN
  RAISE EXCEPTION 'Original template work cannot be cancelled' USING ERRCODE='55000';END IF;
 -- Account lock serializes with the committed pre-POST slot. Only an operation
 -- with no external checkpoint can lose its lease here.
 UPDATE public.connection_operations SET state='CANCELLED',completed_at=clock_timestamp(),updated_at=now(),lease_id=NULL,lease_expires_at=NULL
  WHERE tenant_id=p.tenant_id AND id=p.template_operation_id AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE');
 UPDATE public.meta_account_transitions SET state='CANCELLED',template_state='CANCELLED',cancelled_at=clock_timestamp(),
  revision=revision+1,updated_at=now() WHERE tenant_id=p.tenant_id AND id=p.id;
 UPDATE public.meta_account_transition_reservations SET released_at=clock_timestamp(),release_reason=CASE WHEN slot.id IS NULL THEN 'PRE_EFFECT_CANCEL' ELSE 'SETTLED_TEMPLATE_COPY' END,
  revision=revision+1 WHERE tenant_id=p.tenant_id AND transition_id=p.id AND released_at IS NULL;
 RETURN jsonb_build_object('id',p.id,'duplicate',false);
END $$;
ALTER FUNCTION app.cancel_meta_template_preparation(uuid,uuid,uuid,bigint) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.cancel_meta_template_preparation(uuid,uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cancel_meta_template_preparation(uuid,uuid,uuid,bigint) TO wasalx_app;

CREATE FUNCTION app.fail_meta_template_operation(operation_value uuid,lease_value uuid,fence_value bigint) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE o public.connection_operations;p public.meta_account_transitions;outcome_value text;
BEGIN
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 IF o.state IS DISTINCT FROM 'RUNNING' OR o.lease_id IS DISTINCT FROM lease_value OR o.fencing_token IS DISTINCT FROM fence_value
  OR o.lease_expires_at<clock_timestamp() OR NOT(o.payload ? 'metaTemplatePreparation') THEN RETURN false;END IF;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id AND id=(o.payload#>>'{metaTemplatePreparation,id}')::uuid
  AND transition_kind='TEMPLATE_PREPARATION';
 IF p.id IS NULL THEN RETURN false;END IF;
 PERFORM app.lock_meta_transition_accounts(ARRAY[p.source_account_id,(o.payload#>>'{metaTemplatePreparation,target,accountId}')::uuid]);
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=o.tenant_id AND id=o.id FOR UPDATE;
 IF o.state<>'RUNNING' OR o.lease_id IS DISTINCT FROM lease_value OR o.fencing_token IS DISTINCT FROM fence_value OR o.lease_expires_at<clock_timestamp() THEN RETURN false;END IF;
 SELECT outcome INTO outcome_value FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id
  AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=p.id AND stage='TEMPLATE_COPY';
 UPDATE public.connection_operations SET state='FAILED_TERMINAL',completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL,
  error_code='META_TEMPLATE_HELD',safe_error='Review the original preparation and current account access.',
  result=COALESCE(result,jsonb_build_object('metaTemplatePreparation',jsonb_build_object('planId',p.id,'state','HELD'))),updated_at=now()
  WHERE tenant_id=o.tenant_id AND id=o.id;
 -- A lost/stale operation may retain its original result but cannot update a
 -- newer/cancelled view. No auto retry, source lifecycle change or slot release.
 IF p.template_operation_id=o.id AND p.revision=(o.payload#>>'{metaTemplatePreparation,revision}')::bigint AND p.state<>'CANCELLED' THEN
  UPDATE public.meta_account_transitions SET template_state=CASE WHEN outcome_value IN('ATTEMPTED','UNKNOWN') THEN 'OUTCOME_UNKNOWN' ELSE 'HELD' END,
   revision=revision+1,updated_at=now() WHERE tenant_id=p.tenant_id AND id=p.id;
 END IF;
 RETURN true;
END $$;
ALTER FUNCTION app.fail_meta_template_operation(uuid,uuid,bigint) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.fail_meta_template_operation(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.fail_meta_template_operation(uuid,uuid,bigint) TO wasalx_connector_worker;

CREATE FUNCTION app.meta_template_preparation_status(plan_value uuid,actor_value uuid,app_value text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;frames jsonb;permitted boolean:=false;current_value boolean:=false;safety_value boolean:=false;scope_value boolean:=false;
BEGIN
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value AND transition_kind='TEMPLATE_PREPARATION';
 IF p.id IS NULL THEN RETURN jsonb_build_object('permitted',false,'current',false,'safetyCurrent',false);END IF;
 BEGIN
  PERFORM app.meta_transition_actor_current(actor_value);permitted:=true;
  frames:=app.meta_template_frames(p.initiating_connection_id,p.template_target_connection_id,actor_value,app_value);
  current_value:=frames#>>'{source,accountId}'=p.source_account_id::text
   AND frames#>>'{source,bindingId}'=p.initiating_binding_id::text AND frames#>>'{target,bindingId}'=p.template_target_binding_id::text
   AND NOT EXISTS(SELECT 1 FROM public.meta_account_transition_reservations WHERE tenant_id=p.tenant_id
     AND account_id IN(p.source_account_id,(frames#>>'{target,accountId}')::uuid) AND released_at IS NULL AND transition_id<>p.id);
  scope_value:=app.meta_template_observation_scope_current(p.id,frames);
  safety_value:=p.template_observation->>'sourceSafetyRevision'=frames#>>'{source,safetyRevision}'
   AND p.template_observation->>'targetSafetyRevision'=frames#>>'{target,safetyRevision}';
 EXCEPTION WHEN SQLSTATE '55000' OR SQLSTATE '42501' OR SQLSTATE '55P03' THEN current_value:=false;safety_value:=false;scope_value:=false;
 END;
 RETURN jsonb_build_object('permitted',permitted,'current',COALESCE(current_value,false),'safetyCurrent',COALESCE(safety_value,false),'scopeCurrent',COALESCE(scope_value,false));
END $$;
ALTER FUNCTION app.meta_template_preparation_status(uuid,uuid,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_template_preparation_status(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_template_preparation_status(uuid,uuid,text) TO wasalx_app;

CREATE FUNCTION app.meta_template_preparation_targets(connection_value uuid,actor_value uuid,app_value text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE source_frame jsonb;targets jsonb;
BEGIN
 BEGIN
  PERFORM app.meta_transition_actor_current(actor_value);
  source_frame:=app.meta_template_account_frame(connection_value,actor_value,app_value);
  PERFORM app.assert_meta_account_unreserved((source_frame->>'accountId')::uuid);
 EXCEPTION WHEN SQLSTATE '55000' OR SQLSTATE '42501' OR SQLSTATE '55P03' THEN RETURN NULL;
 END;
 IF EXISTS(SELECT 1 FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id()
  AND source_account_id=(source_frame->>'accountId')::uuid AND state<>'CANCELLED' AND execution_state<>'RECONCILED_PAUSED') THEN RETURN NULL;END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) ORDER BY t.id),'[]'::jsonb) INTO targets FROM (
  SELECT DISTINCT c.id,c.name FROM public.meta_connection_account_bindings b
  JOIN public.meta_messaging_accounts a ON a.tenant_id=b.tenant_id AND a.id=b.account_id
  JOIN public.connections c ON c.tenant_id=b.tenant_id AND c.id=b.connection_id
  WHERE b.tenant_id=app.current_tenant_id() AND b.state='ACTIVE' AND b.app_id=app_value AND a.state<>'RETIRED'
   AND a.id<>(source_frame->>'accountId')::uuid AND a.observed_owner_business_id=source_frame->>'observedOwnerBusinessId'
   AND c.provider='META' AND c.state IN('PAUSED','WORKING') AND c.secret_reference=b.secret_reference
   AND NOT EXISTS(SELECT 1 FROM public.meta_account_transition_reservations r WHERE r.tenant_id=a.tenant_id AND r.account_id=a.id AND r.released_at IS NULL)
  ORDER BY c.id LIMIT 200) t;
 RETURN jsonb_build_object('accountRevision',(source_frame->>'accountRevision')::bigint,
  'bindingRevision',(source_frame->>'bindingRevision')::bigint,'targets',targets);
END $$;
ALTER FUNCTION app.meta_template_preparation_targets(uuid,uuid,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_template_preparation_targets(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_template_preparation_targets(uuid,uuid,text) TO wasalx_app;

-- Accepted B1 fragment: META_TEMPLATE_COMPANION_GUARDS.sql
-- Exact inherited guard bodies with finite template-purpose extensions.
CREATE OR REPLACE FUNCTION app.preserve_meta_transition_observation() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE privacy_current boolean;
BEGIN
 IF TG_OP='UPDATE' AND current_user='wasalx_meta_transition_executor' AND OLD.payload ? 'metaTemplatePreparation'
  AND NEW.payload=jsonb_build_object('redacted',true,'sha256',encode(public.digest(OLD.payload::text,'sha256'),'hex'))
  AND NEW.result IS NOT DISTINCT FROM (CASE WHEN OLD.result IS NULL OR OLD.result ? 'redacted' THEN OLD.result
    ELSE jsonb_build_object('redacted',true,'sha256',encode(public.digest(OLD.result::text,'sha256'),'hex')) END)
  AND (to_jsonb(NEW)-ARRAY['payload','result','updated_at'])=(to_jsonb(OLD)-ARRAY['payload','result','updated_at'])
  AND OLD.state IN('SUCCEEDED','FAILED_TERMINAL','CANCELLED') THEN
  IF app.meta_managed_privacy_authorized(OLD.tenant_id) THEN RETURN NEW;END IF;
 END IF;
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
     OR NOT(pg_has_role(current_user,'wasalx_connector_worker','member') OR (current_user='wasalx_meta_transition_executor'
      AND OLD.payload ? 'metaTemplatePreparation' AND EXISTS(SELECT 1 FROM public.meta_account_transitions p
       WHERE p.tenant_id=OLD.tenant_id AND p.id=(OLD.payload#>>'{metaTemplatePreparation,id}')::uuid
        AND p.transition_kind='TEMPLATE_PREPARATION' AND p.template_operation_id=OLD.id))) THEN
     RAISE EXCEPTION 'Preview result requires its current worker lease' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION app.preserve_meta_transition_execution_operation() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND current_user='wasalx_meta_transition_executor' AND OLD.payload ? 'metaTemplatePreparation'
  AND NEW.payload=jsonb_build_object('redacted',true,'sha256',encode(public.digest(OLD.payload::text,'sha256'),'hex'))
  AND NEW.result IS NOT DISTINCT FROM (CASE WHEN OLD.result IS NULL OR OLD.result ? 'redacted' THEN OLD.result
    ELSE jsonb_build_object('redacted',true,'sha256',encode(public.digest(OLD.result::text,'sha256'),'hex')) END)
  AND (to_jsonb(NEW)-ARRAY['payload','result','updated_at'])=(to_jsonb(OLD)-ARRAY['payload','result','updated_at'])
  AND OLD.state IN('SUCCEEDED','FAILED_TERMINAL','CANCELLED') THEN
  IF app.meta_managed_privacy_authorized(OLD.tenant_id) THEN RETURN NEW;END IF;
 END IF;
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
CREATE OR REPLACE FUNCTION app.preserve_meta_transition() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE operation_row public.connection_operations;
BEGIN
 IF TG_OP='UPDATE' AND OLD.transition_kind='TEMPLATE_PREPARATION' AND current_user='wasalx_meta_transition_executor'
  AND NEW.template_observation=jsonb_build_object('redacted',true,'sha256',encode(public.digest(OLD.template_observation::text,'sha256'),'hex'))
  AND (to_jsonb(NEW)-ARRAY['template_observation','updated_at'])=(to_jsonb(OLD)-ARRAY['template_observation','updated_at']) THEN
  IF app.meta_managed_privacy_authorized(OLD.tenant_id) THEN RETURN NEW;END IF;
 END IF;
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
CREATE OR REPLACE FUNCTION app.preserve_meta_financial_checkpoint() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Financial effect history must be retained' USING ERRCODE='55000';END IF;
 IF OLD.outcome NOT IN('ATTEMPTED','UNKNOWN') AND NOT(OLD.result ? 'redacted')
  AND NEW.result=jsonb_build_object('redacted',true,'sha256',encode(digest(OLD.result::text,'sha256'),'hex'))
  AND pg_has_role(current_user,'wasalx_connector_worker','MEMBER') AND app.meta_managed_privacy_authorized(OLD.tenant_id)
  AND (to_jsonb(NEW)-'result') IS NOT DISTINCT FROM (to_jsonb(OLD)-'result') THEN RETURN NEW;END IF;
 IF NEW.result IS DISTINCT FROM OLD.result AND current_user<>pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid=TG_RELID))
  AND NOT(current_user='wasalx_meta_transition_executor' AND OLD.owner_kind='ACCOUNT_TRANSITION' AND (OLD.stage IN('INITIATE','COMPLETE') OR (OLD.stage='TEMPLATE_COPY' AND EXISTS(
   SELECT 1 FROM public.meta_account_transitions p WHERE p.tenant_id=OLD.tenant_id AND p.id=OLD.owner_id AND p.transition_kind='TEMPLATE_PREPARATION')))) THEN
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
 ELSIF NEW.release_reason='SETTLED_TEMPLATE_COPY' THEN
  IF NOT EXISTS(SELECT 1 FROM public.meta_account_transitions p JOIN public.meta_provider_effect_checkpoints c
    ON c.tenant_id=p.tenant_id AND c.owner_kind='ACCOUNT_TRANSITION' AND c.owner_id=p.id AND c.stage='TEMPLATE_COPY'
    WHERE p.tenant_id=OLD.tenant_id AND p.id=OLD.transition_id AND p.transition_kind='TEMPLATE_PREPARATION' AND c.outcome IN('SUCCEEDED','REJECTED')) THEN
   RAISE EXCEPTION 'Unknown copy retains its original reservation' USING ERRCODE='55000';END IF;
 ELSE RAISE EXCEPTION 'Unknown reservation release' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

-- Accepted B1 fragment: META_TEMPLATE_CURRENCY_VIEWS.sql
-- Private unapplied P09 console companion. No provider request is dispatched.
CREATE OR REPLACE FUNCTION app.operator_meta_transition_list(tenant_value uuid) RETURNS jsonb
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
  WHERE p.tenant_id=tenant_value AND p.transition_kind='CURRENCY' ORDER BY p.created_at DESC,p.id LIMIT 50) item;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.operator_meta_transition_list(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_meta_transition_list(uuid) TO wasalx_platform_operations_client;

CREATE OR REPLACE FUNCTION app.operator_meta_transition_review(tenant_value uuid,plan_value uuid,operator_value text,key_value uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;c public.connections;preview public.connection_operations;observed public.connection_operations;
 original public.platform_operations_audit_events;scope_value jsonb;auth jsonb;target_review jsonb;renewed jsonb;arrangements jsonb;names jsonb;
 steps jsonb;pending jsonb;result jsonb;private_value jsonb;source_currency text;target_access text:='NONE';payment text:='UNAVAILABLE';
 observer_state text:='ABSENT';closed boolean;busy boolean;initial_known boolean;complete_exists boolean;source_current boolean;reasons text[]:='{}';
BEGIN
 IF operator_value IS NULL OR length(operator_value) NOT BETWEEN 1 AND 255 OR operator_value~'[[:cntrl:]]' THEN RAISE EXCEPTION 'Operator is unavailable' USING ERRCODE='55000';END IF;
 PERFORM set_config('app.tenant_id',tenant_value::text,true);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=tenant_value AND id=plan_value AND transition_kind='CURRENCY';
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
CREATE OR REPLACE FUNCTION app.operator_meta_transition_command(tenant_value uuid,plan_value uuid,action_value text,key_value uuid,
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
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=tenant_value AND id=plan_value AND transition_kind='CURRENCY';
 IF p.id IS NULL THEN RAISE EXCEPTION 'Transition is unavailable' USING ERRCODE='P0002';END IF;
 IF NOT resolve_only THEN
  PERFORM app.lock_meta_transition_accounts(array_remove(ARRAY[p.source_account_id,p.target_account_id],NULL));
  SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=tenant_value AND id=plan_value AND transition_kind='CURRENCY' FOR UPDATE NOWAIT;
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

-- Accepted B1 fragment: META_TEMPLATE_PRIVACY.sql
-- Tenant erasure closes local observation work; it never resolves an external
-- UNKNOWN copy or erases the immutable no-replay/checkpoint barriers.
-- Row locking requires UPDATE on at least one column. This existing private
-- NOLOGIN owner can lock the current job without gaining lease/state writes;
-- neither application nor worker receives this grant or executor membership.
GRANT UPDATE(id) ON public.privacy_jobs TO wasalx_meta_transition_executor;

CREATE FUNCTION app.redact_meta_template_preparations(job_value uuid,lease_value uuid,fence_value bigint) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE j public.privacy_jobs;p public.meta_account_transitions;count_value integer:=0;account_value uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||app.current_tenant_id()::text,0));
 SELECT * INTO j FROM public.privacy_jobs WHERE tenant_id=app.current_tenant_id() AND id=job_value FOR UPDATE;
 IF j.id IS NULL OR j.job_type<>'DELETE' OR j.scope_type<>'TENANT' OR j.scope_value<>j.tenant_id::text
  OR j.state<>'RUNNING' OR j.stage<>'LOCAL' OR j.lease_id IS DISTINCT FROM lease_value OR j.fencing_token IS DISTINCT FROM fence_value
  OR j.lease_expires_at<clock_timestamp() OR NOT app.meta_managed_privacy_authorized(j.tenant_id) THEN
  RAISE EXCEPTION 'Template privacy processing is not current' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints c JOIN public.meta_account_transitions transition_row
   ON transition_row.tenant_id=c.tenant_id AND transition_row.id=c.owner_id AND transition_row.transition_kind='TEMPLATE_PREPARATION'
   WHERE c.tenant_id=j.tenant_id AND c.owner_kind='ACCOUNT_TRANSITION' AND c.stage='TEMPLATE_COPY' AND c.outcome IN('ATTEMPTED','UNKNOWN'))
  OR EXISTS(SELECT 1 FROM public.connection_operations WHERE tenant_id=j.tenant_id AND payload ? 'metaTemplatePreparation'
   AND state='RUNNING' AND lease_expires_at>=clock_timestamp()) THEN
  RAISE EXCEPTION 'Original template effects are unresolved' USING ERRCODE='55000';END IF;
 FOR p IN SELECT * FROM public.meta_account_transitions WHERE tenant_id=j.tenant_id AND transition_kind='TEMPLATE_PREPARATION' ORDER BY id LOOP
  SELECT account_id INTO account_value FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=p.template_target_binding_id;
  PERFORM app.lock_meta_transition_accounts(ARRAY[p.source_account_id,account_value]);
  UPDATE public.connection_operations SET state='CANCELLED',lease_id=NULL,lease_expires_at=NULL,completed_at=clock_timestamp(),updated_at=now()
   WHERE tenant_id=p.tenant_id AND id=p.template_operation_id AND state IN('STAGED','QUEUED','FAILED_RETRYABLE','RUNNING');
  IF p.state<>'CANCELLED' THEN
   UPDATE public.meta_account_transitions SET state='CANCELLED',template_state='CANCELLED',cancelled_at=clock_timestamp(),revision=revision+1,updated_at=now()
    WHERE tenant_id=p.tenant_id AND id=p.id;
  END IF;
  IF p.template_observation IS NOT NULL AND NOT(p.template_observation ? 'redacted') THEN
   UPDATE public.meta_account_transitions SET template_observation=jsonb_build_object('redacted',true,
    'sha256',encode(public.digest(template_observation::text,'sha256'),'hex')),updated_at=now() WHERE tenant_id=p.tenant_id AND id=p.id;
   count_value:=count_value+1;
  END IF;
  UPDATE public.meta_account_transition_reservations SET released_at=clock_timestamp(),release_reason=CASE WHEN EXISTS(
    SELECT 1 FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=p.id AND stage='TEMPLATE_COPY')
    THEN 'SETTLED_TEMPLATE_COPY' ELSE 'PRE_EFFECT_CANCEL' END,revision=revision+1
   WHERE tenant_id=p.tenant_id AND transition_id=p.id AND released_at IS NULL;
 END LOOP;
 UPDATE public.connection_operations SET payload=jsonb_build_object('redacted',true,'sha256',encode(public.digest(payload::text,'sha256'),'hex')),
  result=CASE WHEN result IS NULL OR result ? 'redacted' THEN result ELSE jsonb_build_object('redacted',true,'sha256',encode(public.digest(result::text,'sha256'),'hex')) END,
  updated_at=now() WHERE tenant_id=j.tenant_id AND payload ? 'metaTemplatePreparation' AND state IN('SUCCEEDED','FAILED_TERMINAL','CANCELLED');
 -- requested_by_id, original UUID keys, checkpoint request/result hashes and
 -- provider template IDs are retained under the existing operation audit
 -- policy; content, credential references and flow definitions are removed.
 RETURN count_value;
END $$;
ALTER FUNCTION app.redact_meta_template_preparations(uuid,uuid,bigint) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.redact_meta_template_preparations(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.redact_meta_template_preparations(uuid,uuid,bigint) TO wasalx_connector_worker;

COMMIT;
