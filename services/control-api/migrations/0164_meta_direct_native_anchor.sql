BEGIN;
ALTER TABLE event_inbox ADD COLUMN meta_direct_native_anchor jsonb;
ALTER TABLE event_inbox ADD COLUMN meta_direct_anchor_retention_job_id uuid;

CREATE FUNCTION app.meta_direct_anchor_needed(event_value uuid,job_value uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM event_inbox source JOIN participant_identities participant
  ON participant.tenant_id=source.tenant_id AND participant.connection_id=source.connection_id AND (participant.id::text=source.meta_direct_native_anchor->>'participantId'
   OR(source.meta_direct_native_anchor IS NULL AND EXISTS(SELECT 1 FROM normalized_messages message WHERE message.tenant_id=source.tenant_id AND message.event_inbox_id=source.id
    AND message.external_participant_id=participant.external_participant_id AND message.external_group_id=participant.external_participant_id AND message.provider_metadata->'direct'='true')))
  JOIN meta_direct_identity_aliases alias ON alias.tenant_id=participant.tenant_id AND alias.participant_identity_id=participant.id
  WHERE source.tenant_id=app.current_tenant_id() AND source.id=event_value AND alias.source_event_id=source.id AND alias.state IN('ACTIVE','HELD')
   AND NOT EXISTS(SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=source.tenant_id AND target.job_id=job_value AND target.target_type='META_DIRECT_ALIAS' AND target.target_id=alias.id::text)
   AND EXISTS(SELECT 1 FROM bot_conversations conversation WHERE conversation.tenant_id=participant.tenant_id AND conversation.connection_id=participant.connection_id
    AND conversation.external_chat_id=participant.external_participant_id AND NOT EXISTS(SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=source.tenant_id
     AND target.job_id=job_value AND target.target_type='ZAMMAD_TICKET' AND target.target_id=conversation.zammad_ticket_id)))
$$;

CREATE FUNCTION app.guard_meta_direct_native_anchor() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE anchor jsonb:=NEW.meta_direct_native_anchor;privacy_authorized boolean:=false;
BEGIN
 IF TG_OP='INSERT' THEN
  IF anchor IS NOT NULL OR NEW.meta_direct_anchor_retention_job_id IS NOT NULL THEN RAISE EXCEPTION 'Meta native anchor requires ordinary completion' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF anchor IS NOT DISTINCT FROM OLD.meta_direct_native_anchor AND NEW.meta_direct_anchor_retention_job_id IS NOT DISTINCT FROM OLD.meta_direct_anchor_retention_job_id THEN RETURN NEW; END IF;
 IF OLD.meta_direct_native_anchor IS NOT NULL AND anchor IS DISTINCT FROM OLD.meta_direct_native_anchor THEN
  IF (anchor=jsonb_build_object('redacted',true,'sha256',encode(digest(OLD.meta_direct_native_anchor::text,'sha256'),'hex'))
    AND NEW.status='REDACTED' AND NEW.payload='{}' AND NEW.meta_direct_anchor_retention_job_id IS NULL
    AND app.meta_direct_privacy_target_authorized('META_DIRECT_IDENTITY_EVENT',OLD.id::text)) IS NOT TRUE THEN
   RAISE EXCEPTION 'Meta native anchor is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.meta_direct_anchor_retention_job_id IS NOT NULL AND NEW.meta_direct_anchor_retention_job_id IS DISTINCT FROM OLD.meta_direct_anchor_retention_job_id THEN
  RAISE EXCEPTION 'Meta native anchor retention provenance is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.meta_direct_anchor_retention_job_id IS NOT NULL THEN
  privacy_authorized:=EXISTS(SELECT 1 FROM privacy_jobs job JOIN privacy_job_targets target ON target.tenant_id=job.tenant_id AND target.job_id=job.id
   JOIN normalized_messages message ON message.tenant_id=target.tenant_id AND message.id::text=target.target_id AND target.target_type='NORMALIZED_MESSAGE'
   WHERE job.tenant_id=OLD.tenant_id AND job.id=NEW.meta_direct_anchor_retention_job_id AND (job.job_type='RETENTION_SWEEP' OR(job.job_type='DELETE' AND job.scope_type='ZAMMAD_TICKET')) AND job.state='RUNNING'
    AND job.stage='LOCAL' AND job.lease_id IS NOT NULL AND job.lease_expires_at>clock_timestamp() AND target.state IN('PENDING','EXTERNAL_COMPLETE') AND message.event_inbox_id=OLD.id);
  IF NOT privacy_authorized OR NOT app.meta_direct_anchor_needed(OLD.id,NEW.meta_direct_anchor_retention_job_id) THEN RAISE EXCEPTION 'Meta anchor retention authority is unavailable' USING ERRCODE='55000'; END IF;
 END IF;
 IF OLD.meta_direct_native_anchor IS NOT NULL THEN RETURN NEW; END IF;
 IF OLD.status IN('REDACTED','QUARANTINED','UNMATCHED','IGNORED') OR OLD.event_type<>'messages'
  OR OLD.payload#>>'{entry,0,changes,0,field}' IS DISTINCT FROM 'messages' OR OLD.provider<>'META' OR OLD.meta_direct_asset IS NULL OR OLD.meta_direct_identity_change IS NOT NULL
  OR (NOT privacy_authorized AND (OLD.status<>'PROCESSING' OR OLD.lease_id IS NULL OR OLD.lease_expires_at<=clock_timestamp()))
  OR NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=OLD.tenant_id AND alias.connection_id=OLD.connection_id
    AND alias.source_event_id=OLD.id AND alias.source_payload_sha256=OLD.payload_sha256 AND alias.participant_identity_id::text=anchor->>'participantId'
    AND jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id)=OLD.meta_direct_asset)
  OR NOT EXISTS(SELECT 1 FROM app.meta_direct_source_identity(OLD.payload) identity WHERE identity.phone IS NOT NULL OR identity.bsuid IS NOT NULL)
  OR jsonb_typeof(anchor) IS DISTINCT FROM 'object' OR jsonb_typeof(anchor->'participantId') IS DISTINCT FROM 'string'
  OR COALESCE(anchor->>'participantId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR jsonb_typeof(anchor->'nativeCustomerId') IS DISTINCT FROM 'string' OR COALESCE(anchor->>'nativeCustomerId','')!~'^[1-9][0-9]{0,15}$'
  OR anchor->'schemaVersion' IS DISTINCT FROM '1' OR anchor->>'payloadSha256' IS DISTINCT FROM OLD.payload_sha256
  OR anchor-ARRAY['schemaVersion','participantId','nativeCustomerId','payloadSha256']<>'{}'
  OR NOT EXISTS(SELECT 1 FROM normalized_messages message JOIN participant_identities participant
    ON participant.tenant_id=message.tenant_id AND participant.connection_id=message.connection_id AND participant.external_participant_id=message.external_participant_id
    JOIN message_links link ON link.tenant_id=message.tenant_id AND link.connection_id=message.connection_id AND link.external_message_id=message.external_message_id
    JOIN bot_conversations conversation ON conversation.tenant_id=participant.tenant_id AND conversation.connection_id=participant.connection_id AND conversation.external_chat_id=participant.external_participant_id
     AND conversation.zammad_ticket_id=link.zammad_ticket_id AND conversation.zammad_customer_id::text=message.provider_metadata->>'zammad_customer_id'
    WHERE message.tenant_id=OLD.tenant_id AND message.connection_id=OLD.connection_id AND message.event_inbox_id=OLD.id AND message.external_group_id=participant.external_participant_id
     AND message.provider_metadata->'direct'='true' AND participant.id::text=anchor->>'participantId' AND message.provider_metadata->>'zammad_customer_id'=anchor->>'nativeCustomerId') THEN
  RAISE EXCEPTION 'Meta native anchor lacks ordinary completion evidence' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER meta_direct_native_anchor_guard BEFORE INSERT OR UPDATE OF meta_direct_native_anchor,meta_direct_anchor_retention_job_id ON event_inbox FOR EACH ROW EXECUTE FUNCTION app.guard_meta_direct_native_anchor();

CREATE FUNCTION app.seal_meta_direct_native_anchor(event_value uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE value jsonb;
BEGIN
 SELECT jsonb_build_object('schemaVersion',1,'participantId',participant.id::text,'nativeCustomerId',message.provider_metadata->>'zammad_customer_id','payloadSha256',source.payload_sha256) INTO value
  FROM event_inbox source JOIN normalized_messages message ON message.tenant_id=source.tenant_id AND message.event_inbox_id=source.id
  JOIN participant_identities participant ON participant.tenant_id=message.tenant_id AND participant.connection_id=message.connection_id AND participant.external_participant_id=message.external_participant_id
  WHERE source.tenant_id=app.current_tenant_id() AND source.id=event_value AND source.provider='META' AND source.event_type='messages' AND source.payload#>>'{entry,0,changes,0,field}'='messages'
   AND source.meta_direct_asset IS NOT NULL AND source.meta_direct_identity_change IS NULL AND source.status NOT IN('REDACTED','QUARANTINED','UNMATCHED','IGNORED')
   AND EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=participant.tenant_id AND alias.participant_identity_id=participant.id AND alias.source_event_id=source.id);
 IF value IS NULL THEN RETURN false; END IF;
 UPDATE event_inbox SET meta_direct_native_anchor=value WHERE tenant_id=app.current_tenant_id() AND id=event_value AND meta_direct_native_anchor IS NULL;
 RETURN true;
END;
$$;

CREATE FUNCTION app.meta_direct_native_anchor_valid(event_value uuid,participant_value uuid,customer_value text,current_effect boolean DEFAULT true) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM event_inbox source WHERE source.tenant_id=app.current_tenant_id() AND source.id=event_value
  AND source.provider='META' AND source.event_type='messages' AND source.meta_direct_identity_change IS NULL AND source.meta_direct_native_anchor->'schemaVersion'='1'
  AND source.meta_direct_native_anchor->>'participantId'=participant_value::text AND source.meta_direct_native_anchor->>'nativeCustomerId'=customer_value
  AND source.meta_direct_native_anchor->>'payloadSha256'=source.payload_sha256
  AND (source.status NOT IN('REDACTED','QUARANTINED','UNMATCHED','IGNORED') OR (source.status='REDACTED' AND source.payload='{}' AND source.meta_direct_anchor_retention_job_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM privacy_jobs job WHERE job.tenant_id=source.tenant_id AND job.id=source.meta_direct_anchor_retention_job_id AND (job.job_type='RETENTION_SWEEP' OR(job.job_type='DELETE' AND job.scope_type='ZAMMAD_TICKET')))
    AND (NOT current_effect OR app.meta_direct_anchor_needed(source.id,NULL)))))
$$;

-- Alias authority remains ordinary-source bound. A retention capsule is never
-- authorization for an explicit queued job source or a system identity change.
CREATE FUNCTION app.meta_direct_alias_source_valid(alias_value uuid,canonical_value text,customer_value text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias JOIN participant_identities participant
  ON participant.tenant_id=alias.tenant_id AND participant.connection_id=alias.connection_id AND participant.id=alias.participant_identity_id
  JOIN event_inbox source ON source.tenant_id=alias.tenant_id AND source.connection_id=alias.connection_id AND source.id=alias.source_event_id
  WHERE alias.tenant_id=app.current_tenant_id() AND alias.id=alias_value AND alias.state='ACTIVE' AND participant.external_participant_id=canonical_value
   AND source.provider='META' AND source.event_type='messages' AND source.meta_direct_identity_change IS NULL AND source.payload_sha256=alias.source_payload_sha256
   AND source.meta_direct_asset=jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id)
   AND (app.meta_direct_native_anchor_valid(source.id,alias.participant_identity_id,customer_value,true)
    OR(source.status NOT IN('REDACTED','QUARANTINED','UNMATCHED','IGNORED') AND source.payload#>>'{entry,0,changes,0,field}'='messages' AND EXISTS(SELECT 1 FROM normalized_messages message WHERE message.tenant_id=source.tenant_id
      AND message.connection_id=source.connection_id AND message.event_inbox_id=source.id AND message.external_group_id=canonical_value
      AND message.external_participant_id=canonical_value AND message.provider_metadata->'direct'='true'
      AND message.provider_metadata->>'zammad_customer_id'=customer_value AND message.processing_status<>'REDACTED'))))
$$;
CREATE FUNCTION app.meta_direct_event_matches_scope(event_value uuid,scope_value text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM event_inbox source WHERE source.tenant_id=app.current_tenant_id() AND source.id=event_value AND (
  EXISTS(SELECT 1 FROM participant_identities participant WHERE participant.tenant_id=source.tenant_id AND participant.connection_id=source.connection_id
   AND participant.id::text=source.meta_direct_native_anchor->>'participantId'
   AND app.meta_direct_participant_matches(participant.connection_id,participant.external_participant_id,scope_value))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(source.meta_direct_identity_change->'previous')='array' THEN source.meta_direct_identity_change->'previous' ELSE '[]'::jsonb END) previous
    WHERE app.meta_direct_participant_matches(source.connection_id,previous->>'value',scope_value))))
$$;
REVOKE ALL ON FUNCTION app.meta_direct_anchor_needed(uuid,uuid),app.seal_meta_direct_native_anchor(uuid),app.meta_direct_native_anchor_valid(uuid,uuid,text,boolean),app.meta_direct_alias_source_valid(uuid,text,text),app.meta_direct_event_matches_scope(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_direct_anchor_needed(uuid,uuid),app.seal_meta_direct_native_anchor(uuid),app.meta_direct_native_anchor_valid(uuid,uuid,text,boolean),app.meta_direct_alias_source_valid(uuid,text,text),app.meta_direct_event_matches_scope(uuid,text) TO wasalx_app,wasalx_connector_worker;
-- Invoker lookup integrity is required independently of signup definers.
ALTER FUNCTION app.meta_direct_participant_matches(uuid,text,text) SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.meta_direct_privacy_target_authorized(text,text) SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.preserve_meta_direct_asset() SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.meta_direct_identity_guard(uuid,uuid,text,text,uuid) SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.guard_meta_direct_alias() SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.snapshot_meta_direct_recipient() SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.has_applicable_privacy_hold(text,text) SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.delivery_has_active_privacy_target(uuid) SET search_path=pg_catalog,public,app,pg_temp;
COMMIT;
