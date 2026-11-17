BEGIN;
-- These finite SQL validators mirror the signed core identity contract; no caller grants.
CREATE FUNCTION app.meta_direct_identifier_valid(kind_value text,id_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,app AS $$
 SELECT COALESCE(CASE kind_value
  WHEN 'PHONE' THEN id_value~'^[1-9][0-9]{2,14}$'
  WHEN 'BSUID' THEN id_value~'^[A-Z]{2}\.[A-Za-z0-9]{1,128}$' AND left(id_value,2)=ANY(string_to_array('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW',' '))
  WHEN 'PARENT_BSUID' THEN id_value~'^[A-Z]{2}\.ENT\.[A-Za-z0-9]{1,128}$' AND left(id_value,2)=ANY(string_to_array('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW',' '))
  ELSE false END,false)
$$;

CREATE FUNCTION app.meta_direct_source_identity(source_payload jsonb)
RETURNS TABLE(phone text,bsuid text,joint_contact boolean) LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE unit_value jsonb; message_value jsonb; contact jsonb; matched jsonb;
 message_phone text;message_bsuid text;message_parent text;contact_phone text;contact_bsuid text;contact_parent text;matching_count integer:=0;
BEGIN
 IF jsonb_typeof(source_payload->'entry') IS DISTINCT FROM 'array' OR jsonb_array_length(source_payload->'entry')<>1
  OR jsonb_typeof(source_payload#>'{entry,0,changes}') IS DISTINCT FROM 'array' OR jsonb_array_length(source_payload#>'{entry,0,changes}')<>1 THEN
  RAISE EXCEPTION 'Meta direct signed unit is unavailable' USING ERRCODE='23514';
 END IF;
 unit_value:=source_payload#>'{entry,0,changes,0,value}';
 IF jsonb_typeof(unit_value->'messages') IS DISTINCT FROM 'array' OR jsonb_array_length(unit_value->'messages')<>1 THEN
  RAISE EXCEPTION 'Meta direct signed message is unavailable' USING ERRCODE='23514';
 END IF;
 message_value:=unit_value#>'{messages,0}';
 IF jsonb_typeof(message_value) IS DISTINCT FROM 'object' OR message_value->>'type'='system' OR message_value ? 'group_id' THEN
  RAISE EXCEPTION 'Meta direct signed identity is unavailable' USING ERRCODE='23514';
 END IF;
 IF (message_value ? 'from' AND (jsonb_typeof(message_value->'from') IS DISTINCT FROM 'string' OR NOT app.meta_direct_identifier_valid('PHONE',message_value->>'from')))
  OR (message_value ? 'from_user_id' AND (jsonb_typeof(message_value->'from_user_id') IS DISTINCT FROM 'string' OR NOT app.meta_direct_identifier_valid('BSUID',message_value->>'from_user_id')))
  OR (message_value ? 'from_parent_user_id' AND (jsonb_typeof(message_value->'from_parent_user_id') IS DISTINCT FROM 'string' OR NOT app.meta_direct_identifier_valid('PARENT_BSUID',message_value->>'from_parent_user_id'))) THEN
  RAISE EXCEPTION 'Meta direct signed identifier is invalid' USING ERRCODE='23514';
 END IF;
 message_phone:=message_value->>'from';message_bsuid:=message_value->>'from_user_id';message_parent:=message_value->>'from_parent_user_id';
 IF message_phone IS NULL AND message_bsuid IS NULL THEN RAISE EXCEPTION 'Meta direct signed identity is missing' USING ERRCODE='23514'; END IF;
 IF unit_value ? 'contacts' THEN
  IF jsonb_typeof(unit_value->'contacts') IS DISTINCT FROM 'array' OR jsonb_array_length(unit_value->'contacts')>100 THEN
   RAISE EXCEPTION 'Meta direct signed contacts are invalid' USING ERRCODE='23514';
  END IF;
  FOR contact IN SELECT value FROM jsonb_array_elements(unit_value->'contacts') LOOP
   IF jsonb_typeof(contact) IS DISTINCT FROM 'object'
    OR (contact ? 'wa_id' AND (jsonb_typeof(contact->'wa_id') IS DISTINCT FROM 'string' OR NOT app.meta_direct_identifier_valid('PHONE',contact->>'wa_id')))
    OR (contact ? 'user_id' AND (jsonb_typeof(contact->'user_id') IS DISTINCT FROM 'string' OR NOT app.meta_direct_identifier_valid('BSUID',contact->>'user_id')))
    OR (contact ? 'parent_user_id' AND (jsonb_typeof(contact->'parent_user_id') IS DISTINCT FROM 'string' OR NOT app.meta_direct_identifier_valid('PARENT_BSUID',contact->>'parent_user_id'))) THEN
    RAISE EXCEPTION 'Meta direct signed contact is invalid' USING ERRCODE='23514';
   END IF;
   contact_phone:=contact->>'wa_id';contact_bsuid:=contact->>'user_id';contact_parent:=contact->>'parent_user_id';
   IF (message_phone IS NOT NULL AND contact_phone=message_phone) OR (message_bsuid IS NOT NULL AND contact_bsuid=message_bsuid) THEN
    IF (message_phone IS NOT NULL AND contact_phone IS NOT NULL AND message_phone<>contact_phone)
     OR (message_bsuid IS NOT NULL AND contact_bsuid IS NOT NULL AND message_bsuid<>contact_bsuid)
     OR (message_parent IS NOT NULL AND contact_parent IS NOT NULL AND message_parent<>contact_parent) THEN
     RAISE EXCEPTION 'Meta direct signed contact conflicts' USING ERRCODE='23514';
    END IF;
    matching_count:=matching_count+1;matched:=contact;
   END IF;
  END LOOP;
  IF matching_count>1 OR (jsonb_array_length(unit_value->'contacts')>0 AND matching_count<>1) THEN
   RAISE EXCEPTION 'Meta direct signed contact is ambiguous' USING ERRCODE='23514';
  END IF;
 END IF;
 phone:=COALESCE(message_phone,matched->>'wa_id');bsuid:=COALESCE(message_bsuid,matched->>'user_id');
 joint_contact:=matched->>'wa_id' IS NOT NULL AND matched->>'user_id' IS NOT NULL;
 RETURN NEXT;
END;
$$;

CREATE FUNCTION app.meta_direct_source_change_marker(source_payload jsonb,source_hash text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE message_value jsonb:=source_payload#>'{entry,0,changes,0,value,messages,0}';system_value jsonb;
 previous_value jsonb:='[]'::jsonb;field_value text;kind_value text;
BEGIN
 IF message_value->>'type' IS DISTINCT FROM 'system' OR message_value ? 'group_id' THEN RETURN NULL; END IF;
 system_value:=message_value->'system';
 BEGIN
  IF jsonb_typeof(system_value) IS DISTINCT FROM 'object' OR COALESCE(system_value->>'type','') NOT IN('user_changed_number','user_changed_user_id') THEN
   RAISE EXCEPTION 'Unsupported signed system identity';
  END IF;
  FOR field_value,kind_value IN SELECT * FROM (VALUES ('from','PHONE'),('from_user_id','BSUID'),('from_parent_user_id','PARENT_BSUID')) fields(field,kind) LOOP
   IF message_value ? field_value AND (jsonb_typeof(message_value->field_value) IS DISTINCT FROM 'string' OR NOT app.meta_direct_identifier_valid(kind_value,message_value->>field_value)) THEN
    RAISE EXCEPTION 'Invalid signed system identifier';
   END IF;
  END LOOP;
  FOR field_value,kind_value IN SELECT * FROM (VALUES ('wa_id','PHONE'),('user_id','BSUID'),('previous_user_id','BSUID'),('previous_parent_user_id','PARENT_BSUID'),('parent_user_id','PARENT_BSUID')) fields(field,kind) LOOP
   IF system_value ? field_value AND (jsonb_typeof(system_value->field_value) IS DISTINCT FROM 'string' OR NOT app.meta_direct_identifier_valid(kind_value,system_value->>field_value)) THEN
    RAISE EXCEPTION 'Invalid signed system identifier';
   END IF;
  END LOOP;
  IF system_value->>'wa_id' IS NULL AND system_value->>'user_id' IS NULL THEN RAISE EXCEPTION 'Missing signed new identity'; END IF;
  IF system_value->>'type'='user_changed_user_id' AND (system_value->>'previous_user_id' IS NULL OR system_value->>'user_id' IS NULL) THEN
   RAISE EXCEPTION 'Missing signed previous identity';
  END IF;
  IF message_value->>'from' IS NOT NULL THEN previous_value:=previous_value||jsonb_build_array(jsonb_build_object('kind','PHONE','value',message_value->>'from')); END IF;
  IF system_value->>'previous_user_id' IS NOT NULL THEN previous_value:=previous_value||jsonb_build_array(jsonb_build_object('kind','BSUID','value',system_value->>'previous_user_id')); END IF;
 EXCEPTION WHEN raise_exception THEN previous_value:='[]'::jsonb;
 END;
 RETURN jsonb_build_object('schemaVersion',1,'scope',CASE WHEN jsonb_array_length(previous_value)>0 THEN 'ALIASES' ELSE 'ASSET' END,'previous',previous_value,'payloadSha256',source_hash);
END;
$$;
REVOKE ALL ON FUNCTION app.meta_direct_identifier_valid(text,text),app.meta_direct_source_identity(jsonb),app.meta_direct_source_change_marker(jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_direct_identifier_valid(text,text),app.meta_direct_source_identity(jsonb),app.meta_direct_source_change_marker(jsonb,text) TO wasalx_app,wasalx_connector_worker;

-- P03a private proposal: no backfill, automatic identity transition or core patch.
ALTER TABLE participant_identities ADD CONSTRAINT participant_identities_tenant_connection_id_key UNIQUE(tenant_id,connection_id,id);
ALTER TABLE provider_sessions ADD CONSTRAINT provider_sessions_tenant_connection_id_key UNIQUE(tenant_id,connection_id,id);
ALTER TABLE event_inbox ADD COLUMN meta_direct_asset jsonb;
CREATE FUNCTION app.preserve_meta_direct_asset() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.meta_direct_asset IS DISTINCT FROM OLD.meta_direct_asset THEN
    RAISE EXCEPTION 'Meta direct admission asset is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.meta_direct_asset IS NOT NULL AND (NEW.provider<>'META'
    OR jsonb_typeof(NEW.meta_direct_asset)<>'object'
    OR NOT NEW.meta_direct_asset ?& ARRAY['providerSessionId','phoneNumberId','wabaId']
    OR jsonb_typeof(NEW.meta_direct_asset->'providerSessionId')<>'string'
    OR jsonb_typeof(NEW.meta_direct_asset->'phoneNumberId')<>'string'
    OR (NEW.meta_direct_asset->'wabaId'<>'null'::jsonb AND jsonb_typeof(NEW.meta_direct_asset->'wabaId')<>'string')
    OR NEW.meta_direct_asset->>'providerSessionId' !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    OR NEW.meta_direct_asset->>'phoneNumberId' !~ '^[0-9]{1,32}$'
    OR (NEW.meta_direct_asset->'wabaId'<>'null'::jsonb AND NEW.meta_direct_asset->>'wabaId' !~ '^[0-9]{1,32}$')
    OR NEW.meta_direct_asset - ARRAY['providerSessionId','phoneNumberId','wabaId'] <> '{}'::jsonb) THEN
    RAISE EXCEPTION 'Meta direct admission asset is invalid' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW.meta_direct_asset IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM provider_sessions session WHERE session.tenant_id=NEW.tenant_id AND session.connection_id=NEW.connection_id
    AND session.id::text=NEW.meta_direct_asset->>'providerSessionId' AND session.ownership_state='ACTIVE'
    AND session.opaque_session_id=NEW.meta_direct_asset->>'phoneNumberId'
    AND session.provider_state_data->>'wabaId' IS NOT DISTINCT FROM NEW.meta_direct_asset->>'wabaId'
    AND NEW.event_type='messages' AND jsonb_typeof(NEW.payload->'entry')='array' AND jsonb_array_length(NEW.payload->'entry')=1
    AND jsonb_typeof(NEW.payload#>'{entry,0,changes}')='array' AND jsonb_array_length(NEW.payload#>'{entry,0,changes}')=1
    AND NEW.payload#>>'{entry,0,changes,0,field}'='messages'
    AND NEW.payload#>>'{entry,0,changes,0,value,metadata,phone_number_id}'=session.opaque_session_id
    AND (session.provider_state_data->>'wabaId' IS NULL OR NEW.payload#>>'{entry,0,id}'=session.provider_state_data->>'wabaId')
    AND jsonb_typeof(NEW.payload#>'{entry,0,changes,0,value,messages}')='array' AND jsonb_array_length(NEW.payload#>'{entry,0,changes,0,value,messages}')=1
    ) THEN
   RAISE EXCEPTION 'Meta direct pin does not match signed source session' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meta_direct_asset_immutable BEFORE INSERT OR UPDATE OF meta_direct_asset ON event_inbox
  FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_direct_asset();

CREATE TABLE meta_direct_identity_aliases(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 participant_identity_id uuid NOT NULL,
 provider_session_id uuid NOT NULL,
 phone_number_id text NOT NULL CHECK(phone_number_id ~ '^[0-9]{1,32}$'),
 waba_id text NOT NULL CHECK(waba_id ~ '^[0-9]{1,32}$'),
 kind text NOT NULL CHECK(kind IN ('PHONE','BSUID')),
 value text NOT NULL CHECK(app.meta_direct_identifier_valid(kind,value)),
 state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','HELD')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
 source_event_id uuid NOT NULL,
 source_payload_sha256 text NOT NULL CHECK(source_payload_sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,connection_id,provider_session_id,phone_number_id,waba_id,kind,value),
 UNIQUE(tenant_id,connection_id,participant_identity_id,provider_session_id,phone_number_id,waba_id,kind),
 FOREIGN KEY(tenant_id,connection_id,participant_identity_id) REFERENCES participant_identities(tenant_id,connection_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,connection_id,provider_session_id) REFERENCES provider_sessions(tenant_id,connection_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,source_event_id) REFERENCES event_inbox(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE meta_direct_identity_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_direct_identity_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON meta_direct_identity_aliases USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON meta_direct_identity_aliases TO wasalx_app,wasalx_connector_worker;
CREATE INDEX meta_direct_alias_participant_idx ON meta_direct_identity_aliases(tenant_id,connection_id,participant_identity_id);
CREATE TRIGGER meta_direct_alias_privacy_statement_fence BEFORE INSERT OR UPDATE OR DELETE ON meta_direct_identity_aliases
  FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();

-- Read-only canonical/alias closure for DIRECT privacy callers. Group callers retain raw equality.
CREATE FUNCTION app.meta_direct_participant_matches(connection_value uuid,canonical_or_alias text,requested_scope text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT canonical_or_alias=requested_scope OR EXISTS(
  SELECT 1 FROM participant_identities participant
  JOIN connections connection ON connection.tenant_id=participant.tenant_id AND connection.id=participant.connection_id AND connection.provider='META'
  WHERE participant.tenant_id=app.current_tenant_id() AND participant.connection_id=connection_value
    AND (participant.external_participant_id=canonical_or_alias OR participant.id::text=canonical_or_alias OR EXISTS(
      SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=participant.tenant_id
      AND alias.connection_id=participant.connection_id AND alias.participant_identity_id=participant.id AND alias.value=canonical_or_alias))
    AND (participant.external_participant_id=requested_scope OR participant.id::text=requested_scope OR EXISTS(
      SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=participant.tenant_id
      AND alias.connection_id=participant.connection_id AND alias.participant_identity_id=participant.id AND alias.value=requested_scope))
 )
$$;
ALTER TABLE privacy_job_targets DROP CONSTRAINT privacy_job_targets_target_type_check;
ALTER TABLE privacy_job_targets ADD CONSTRAINT privacy_job_targets_target_type_check CHECK(target_type IN(
 'ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT','NORMALIZED_MESSAGE','DELIVERY','META_DIRECT_ALIAS','META_DIRECT_IDENTITY_EVENT'));

-- Authority is an actual held, active privacy job with its immutable discovered target; no caller GUC.
CREATE FUNCTION app.meta_direct_privacy_target_authorized(kind_value text,id_value text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM privacy_job_targets target JOIN privacy_jobs job ON job.tenant_id=target.tenant_id AND job.id=target.job_id
 WHERE target.tenant_id=app.current_tenant_id() AND target.target_type=kind_value AND target.target_id=id_value
 AND target.state IN('PENDING','EXTERNAL_COMPLETE') AND job.job_type IN('DELETE','RETENTION_SWEEP') AND job.stage='LOCAL'
 AND job.state='RUNNING' AND job.lease_id IS NOT NULL AND job.lease_expires_at>=clock_timestamp())
$$;

ALTER TABLE event_inbox ADD COLUMN meta_direct_identity_change jsonb;
CREATE FUNCTION app.preserve_meta_direct_identity_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.meta_direct_identity_change IS NOT DISTINCT FROM OLD.meta_direct_identity_change THEN RETURN NEW; END IF;
  IF OLD.meta_direct_identity_change IS NULL OR OLD.meta_direct_identity_change->'redacted'='true'::jsonb
    OR NEW.meta_direct_identity_change IS DISTINCT FROM jsonb_build_object('redacted',true,'scope','ASSET','payloadSha256',OLD.payload_sha256,
       'sha256',encode(digest(OLD.meta_direct_identity_change::text,'sha256'),'hex'))
    OR NEW.status<>'REDACTED' OR NEW.payload<>'{}'::jsonb
    OR NOT app.meta_direct_privacy_target_authorized('META_DIRECT_IDENTITY_EVENT',OLD.id::text) THEN
    RAISE EXCEPTION 'Meta identity change evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.meta_direct_asset IS NOT NULL AND NEW.meta_direct_identity_change IS DISTINCT FROM app.meta_direct_source_change_marker(NEW.payload,NEW.payload_sha256) THEN
  RAISE EXCEPTION 'Meta identity marker does not match signed source' USING ERRCODE='23514';
 END IF;
 IF NEW.meta_direct_identity_change IS NOT NULL THEN
  IF NEW.provider<>'META' OR NEW.meta_direct_asset IS NULL
   OR jsonb_typeof(NEW.meta_direct_identity_change) IS DISTINCT FROM 'object'
   OR NEW.meta_direct_identity_change->'schemaVersion' IS DISTINCT FROM '1'::jsonb
   OR NEW.meta_direct_identity_change->>'payloadSha256' IS DISTINCT FROM NEW.payload_sha256
   OR COALESCE(NEW.meta_direct_identity_change->>'scope','') NOT IN('ASSET','ALIASES')
   OR jsonb_typeof(NEW.meta_direct_identity_change->'previous') IS DISTINCT FROM 'array'
   OR NEW.meta_direct_identity_change-ARRAY['schemaVersion','scope','previous','payloadSha256']<>'{}'::jsonb THEN
    RAISE EXCEPTION 'Meta identity change evidence is invalid' USING ERRCODE='23514';
  END IF;
  IF jsonb_array_length(NEW.meta_direct_identity_change->'previous')>2
   OR (NEW.meta_direct_identity_change->>'scope'='ALIASES' AND jsonb_array_length(NEW.meta_direct_identity_change->'previous')=0)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.meta_direct_identity_change->'previous') previous
     WHERE jsonb_typeof(previous) IS DISTINCT FROM 'object' OR COALESCE(previous->>'kind','') NOT IN('PHONE','BSUID')
       OR jsonb_typeof(previous->'value') IS DISTINCT FROM 'string'
       OR COALESCE(previous->>'value','')='' OR length(previous->>'value')>131 OR previous->>'value'~'[[:cntrl:][:space:]]'
       OR NOT app.meta_direct_identifier_valid(previous->>'kind',previous->>'value')
       OR previous-ARRAY['kind','value']<>'{}'::jsonb) THEN
    RAISE EXCEPTION 'Meta identity change evidence is invalid' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER meta_direct_identity_change_immutable BEFORE INSERT OR UPDATE OF meta_direct_identity_change ON event_inbox
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_direct_identity_change();

-- CLEAR only. A marker is unresolved throughout P03a, independently of processing status.
CREATE FUNCTION app.meta_direct_identity_guard(connection_value uuid,session_value uuid,phone_value text,waba_value text,participant_value uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=app.current_tenant_id()
   AND alias.connection_id=connection_value AND alias.provider_session_id=session_value
   AND alias.phone_number_id=phone_value AND alias.waba_id IS NOT DISTINCT FROM waba_value AND alias.state='HELD'
   AND (participant_value IS NULL OR alias.participant_identity_id=participant_value))
 AND NOT EXISTS(SELECT 1 FROM event_inbox source WHERE source.tenant_id=app.current_tenant_id() AND source.connection_id=connection_value
   AND source.provider='META' AND source.meta_direct_asset=jsonb_build_object('providerSessionId',session_value::text,'phoneNumberId',phone_value,'wabaId',waba_value)
   AND source.meta_direct_identity_change IS NOT NULL
   AND (source.meta_direct_identity_change->>'payloadSha256' IS DISTINCT FROM source.payload_sha256
     OR source.meta_direct_identity_change->'redacted'='true'::jsonb OR source.meta_direct_identity_change->>'scope'='ASSET'
     OR participant_value IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(source.meta_direct_identity_change->'previous') previous
       JOIN participant_identities participant ON participant.tenant_id=source.tenant_id
        AND participant.connection_id=source.connection_id AND participant.id=participant_value
       WHERE (previous->>'kind'='PHONE' AND participant.external_participant_id=previous->>'value') OR EXISTS(
        SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=participant.tenant_id
         AND alias.connection_id=participant.connection_id AND alias.participant_identity_id=participant.id
         AND alias.provider_session_id=session_value AND alias.phone_number_id=phone_value AND alias.waba_id IS NOT DISTINCT FROM waba_value
         AND alias.kind=previous->>'kind' AND alias.value=previous->>'value'))))
$$;
REVOKE ALL ON FUNCTION app.preserve_meta_direct_identity_change(),app.meta_direct_identity_guard(uuid,uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_direct_identity_guard(uuid,uuid,text,text,uuid) TO wasalx_app,wasalx_connector_worker;

CREATE FUNCTION app.guard_meta_direct_alias() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE signed_phone text;signed_bsuid text;joint boolean;canonical text;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM event_inbox source JOIN provider_sessions session
    ON session.tenant_id=source.tenant_id AND session.connection_id=source.connection_id AND session.id=NEW.provider_session_id
    JOIN connections connection ON connection.tenant_id=session.tenant_id AND connection.id=session.connection_id
    WHERE source.tenant_id=NEW.tenant_id AND source.connection_id=NEW.connection_id AND source.id=NEW.source_event_id
    AND source.provider='META' AND source.payload_sha256=NEW.source_payload_sha256
    AND source.status='PROCESSING' AND source.lease_id IS NOT NULL AND source.lease_expires_at>=clock_timestamp() AND source.meta_direct_asset=jsonb_build_object(
     'providerSessionId',NEW.provider_session_id::text,'phoneNumberId',NEW.phone_number_id,'wabaId',NEW.waba_id)
    AND session.ownership_state='ACTIVE' AND session.opaque_session_id=NEW.phone_number_id
    AND session.provider_state_data->>'wabaId'=NEW.waba_id
    AND session.provider_state_data->'metaAccountProof'->'schemaVersion'='1'::jsonb
    AND session.provider_state_data->'metaAccountProof'->>'tenantId'=NEW.tenant_id::text
    AND session.provider_state_data->'metaAccountProof'->>'connectionId'=NEW.connection_id::text
    AND session.provider_state_data->'metaAccountProof'->>'secretReference'=connection.secret_reference
    AND session.provider_state_data->'metaAccountProof'->>'claim'='PHONE_ACCOUNT_RELATION_VERIFIED'
    AND session.provider_state_data->'metaAccountProof'->>'providerSessionId'=session.id::text
    AND session.provider_state_data->'metaAccountProof'->>'phoneNumberId'=NEW.phone_number_id
    AND session.provider_state_data->'metaAccountProof'->>'wabaId'=NEW.waba_id) THEN
    RAISE EXCEPTION 'Meta alias source asset is unavailable' USING ERRCODE='23514';
  END IF;
  SELECT identity.phone,identity.bsuid,identity.joint_contact INTO signed_phone,signed_bsuid,joint
    FROM event_inbox source CROSS JOIN LATERAL app.meta_direct_source_identity(source.payload) identity
    WHERE source.tenant_id=NEW.tenant_id AND source.connection_id=NEW.connection_id AND source.id=NEW.source_event_id;
  SELECT participant.external_participant_id INTO canonical FROM participant_identities participant
    WHERE participant.tenant_id=NEW.tenant_id AND participant.connection_id=NEW.connection_id AND participant.id=NEW.participant_identity_id;
  IF canonical IS NULL OR (CASE NEW.kind WHEN 'PHONE' THEN NEW.value IS DISTINCT FROM signed_phone ELSE NEW.value IS DISTINCT FROM signed_bsuid END)
   OR (signed_phone IS NOT NULL AND signed_bsuid IS NOT NULL AND NOT joint)
   OR (canonical IS DISTINCT FROM signed_phone AND canonical!~'^meta:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
     AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases prior WHERE prior.tenant_id=NEW.tenant_id AND prior.connection_id=NEW.connection_id
       AND prior.participant_identity_id=NEW.participant_identity_id AND prior.provider_session_id=NEW.provider_session_id
       AND prior.phone_number_id=NEW.phone_number_id AND prior.waba_id=NEW.waba_id AND prior.state='ACTIVE'
       AND ((prior.kind='PHONE' AND prior.value=signed_phone) OR (prior.kind='BSUID' AND prior.value=signed_bsuid))))
   OR EXISTS(SELECT 1 FROM meta_direct_identity_aliases prior WHERE prior.tenant_id=NEW.tenant_id AND prior.connection_id=NEW.connection_id
       AND prior.participant_identity_id=NEW.participant_identity_id
       AND (prior.provider_session_id<>NEW.provider_session_id OR prior.phone_number_id<>NEW.phone_number_id OR prior.waba_id<>NEW.waba_id OR prior.state<>'ACTIVE'))
   OR (EXISTS(SELECT 1 FROM meta_direct_identity_aliases prior WHERE prior.tenant_id=NEW.tenant_id AND prior.connection_id=NEW.connection_id
       AND prior.participant_identity_id=NEW.participant_identity_id)
      AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases prior WHERE prior.tenant_id=NEW.tenant_id AND prior.connection_id=NEW.connection_id
       AND prior.participant_identity_id=NEW.participant_identity_id
       AND ((prior.kind='PHONE' AND prior.value=signed_phone) OR (prior.kind='BSUID' AND prior.value=signed_bsuid)))) THEN
   RAISE EXCEPTION 'Meta alias is not authorized by signed canonical identity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 ELSIF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['state','revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision'])
    OR NOT ((NEW.state=OLD.state AND NEW.revision=OLD.revision)
      OR (OLD.state='ACTIVE' AND NEW.state='HELD' AND NEW.revision=OLD.revision+1)) THEN
    RAISE EXCEPTION 'Meta alias identity is immutable; transition requires P03b' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NOT app.meta_direct_privacy_target_authorized('META_DIRECT_ALIAS',OLD.id::text)
   OR app.has_applicable_privacy_hold('PARTICIPANT',OLD.value)
   OR EXISTS(SELECT 1 FROM delivery_outbox delivery WHERE delivery.tenant_id=OLD.tenant_id
    AND (delivery.meta_direct_recipient->>'aliasId'=OLD.id::text
      OR delivery.meta_direct_recipient->>'participantId'=OLD.participant_identity_id::text
      OR (delivery.direct_origin IS NOT NULL AND app.meta_direct_participant_matches(delivery.connection_id,delivery.external_chat_id,OLD.value)))
    AND delivery.content_redacted_at IS NULL)
   OR EXISTS(SELECT 1 FROM normalized_messages message WHERE message.tenant_id=OLD.tenant_id
    AND message.connection_id=OLD.connection_id AND message.provider_metadata->'direct'='true'::jsonb
    AND app.meta_direct_participant_matches(message.connection_id,message.external_participant_id,OLD.value)
    AND NOT EXISTS(SELECT 1 FROM privacy_job_targets target JOIN privacy_jobs job
      ON job.tenant_id=target.tenant_id AND job.id=target.job_id
      WHERE target.tenant_id=message.tenant_id AND target.target_type='NORMALIZED_MESSAGE' AND target.target_id=message.id::text
      AND job.state='RUNNING' AND job.stage='LOCAL' AND job.lease_expires_at>=clock_timestamp()
      AND target.state IN('PENDING','EXTERNAL_COMPLETE')))
   OR EXISTS(SELECT 1 FROM bot_conversations conversation JOIN participant_identities participant
      ON participant.tenant_id=conversation.tenant_id AND participant.connection_id=conversation.connection_id
      AND participant.external_participant_id=conversation.external_chat_id
    WHERE participant.tenant_id=OLD.tenant_id AND participant.id=OLD.participant_identity_id) THEN
   RAISE EXCEPTION 'Meta alias still has retained or unresolved references' USING ERRCODE='55000';
 END IF;
 RETURN OLD;
END;
$$;
-- Guard is created after the snapshot column below, so runtime references are defined.

ALTER TABLE delivery_outbox ADD COLUMN meta_direct_recipient jsonb;
CREATE FUNCTION app.snapshot_meta_direct_recipient() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE session_row provider_sessions%ROWTYPE; alias_row meta_direct_identity_aliases%ROWTYPE;
 participant_row participant_identities%ROWTYPE; canonical_key text; snapshot jsonb;
BEGIN
 IF NEW.direct_origin IS NULL OR NOT EXISTS(SELECT 1 FROM connections connection
  WHERE connection.tenant_id=NEW.tenant_id AND connection.id=NEW.connection_id AND connection.provider='META') THEN
  IF NEW.meta_direct_recipient IS NOT NULL THEN RAISE EXCEPTION 'Meta snapshot on non-Meta-direct route' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 -- A committed idempotent replay cannot rebind the existing row after identity changes.
 IF EXISTS(SELECT 1 FROM delivery_outbox prior WHERE prior.tenant_id=NEW.tenant_id AND prior.idempotency_key=NEW.idempotency_key) THEN
  IF NEW.meta_direct_recipient IS NOT NULL THEN RAISE EXCEPTION 'Caller cannot supply Meta snapshot on replay' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 SELECT conversation.external_chat_id INTO canonical_key FROM bot_conversations conversation
 WHERE conversation.tenant_id=NEW.tenant_id AND conversation.connection_id=NEW.connection_id AND conversation.id=NEW.bot_conversation_id;
 IF canonical_key IS NULL OR canonical_key IS DISTINCT FROM NEW.external_chat_id THEN
  RAISE EXCEPTION 'Meta direct conversation is unavailable' USING ERRCODE='23514';
 END IF;
 SELECT * INTO session_row FROM provider_sessions session WHERE session.tenant_id=NEW.tenant_id
  AND session.connection_id=NEW.connection_id AND session.ownership_state='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Meta direct session is unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO participant_row FROM participant_identities participant WHERE participant.tenant_id=NEW.tenant_id
  AND participant.connection_id=NEW.connection_id AND participant.external_participant_id=canonical_key;
 IF NOT app.meta_direct_identity_guard(NEW.connection_id,session_row.id,session_row.opaque_session_id,session_row.provider_state_data->>'wabaId',participant_row.id) THEN
  RAISE EXCEPTION 'Meta direct identity change requires reconciliation' USING ERRCODE='55000';
 END IF;
 IF participant_row.id IS NOT NULL AND EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias
  WHERE alias.tenant_id=NEW.tenant_id AND alias.connection_id=NEW.connection_id AND alias.participant_identity_id=participant_row.id
  AND alias.provider_session_id=session_row.id AND alias.state='HELD') THEN
  RAISE EXCEPTION 'Meta direct identity is held' USING ERRCODE='55000';
 END IF;
 SELECT * INTO alias_row FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=NEW.tenant_id
  AND alias.connection_id=NEW.connection_id AND alias.participant_identity_id=participant_row.id AND alias.provider_session_id=session_row.id
  AND alias.phone_number_id=session_row.opaque_session_id AND alias.waba_id=session_row.provider_state_data->>'wabaId' AND alias.state='ACTIVE'
 ORDER BY CASE alias.kind WHEN 'BSUID' THEN 0 ELSE 1 END,alias.created_at,alias.id LIMIT 1 FOR SHARE;
 IF FOUND THEN
  snapshot:=jsonb_build_object('schemaVersion',1,'claim','ALIAS_VERIFIED','recipient',jsonb_build_object('kind',alias_row.kind,'value',alias_row.value),
   'asset',jsonb_build_object('providerSessionId',session_row.id::text,'phoneNumberId',session_row.opaque_session_id,'wabaId',alias_row.waba_id),
   'participantId',participant_row.id::text,'aliasId',alias_row.id::text,'aliasRevision',alias_row.revision);
 ELSE
  IF canonical_key !~ '^[1-9][0-9]{2,14}$' OR EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias
    WHERE alias.tenant_id=NEW.tenant_id AND alias.connection_id=NEW.connection_id
    AND (alias.value=canonical_key OR alias.participant_identity_id=participant_row.id)) THEN
   RAISE EXCEPTION 'Meta direct recipient requires verified scoped alias' USING ERRCODE='23514';
  END IF;
  snapshot:=jsonb_build_object('schemaVersion',1,'claim','LEGACY_PHONE_CONTEXT','recipient',jsonb_build_object('kind','PHONE','value',canonical_key),
   'asset',jsonb_build_object('providerSessionId',session_row.id::text,'phoneNumberId',session_row.opaque_session_id,
    'wabaId',session_row.provider_state_data->>'wabaId'));
 END IF;
 IF NEW.meta_direct_recipient IS NOT NULL AND NEW.meta_direct_recipient IS DISTINCT FROM snapshot THEN
  RAISE EXCEPTION 'Meta direct snapshot does not match admitted alias' USING ERRCODE='23514';
 END IF;
 NEW.meta_direct_recipient:=snapshot;
 RETURN NEW;
END;
$$;
CREATE TRIGGER meta_direct_recipient_snapshot BEFORE INSERT ON delivery_outbox FOR EACH ROW EXECUTE FUNCTION app.snapshot_meta_direct_recipient();
CREATE FUNCTION app.preserve_meta_direct_recipient() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NEW.meta_direct_recipient IS NOT DISTINCT FROM OLD.meta_direct_recipient THEN RETURN NEW; END IF;
 IF OLD.meta_direct_recipient IS NULL OR OLD.content_redacted_at IS NOT NULL OR NEW.content_redacted_at IS NULL
   OR NEW.meta_direct_recipient IS DISTINCT FROM jsonb_build_object('redacted',true,'sha256',encode(digest(OLD.meta_direct_recipient::text,'sha256'),'hex'))
   OR OLD.state IN('SENDING','OUTCOME_UNKNOWN') OR (OLD.state='CLAIMED' AND OLD.lease_expires_at>=clock_timestamp())
   OR NOT app.meta_direct_privacy_target_authorized('DELIVERY',OLD.id::text) THEN
  RAISE EXCEPTION 'Meta direct snapshot is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER meta_direct_recipient_immutable BEFORE UPDATE OF meta_direct_recipient,content_redacted_at ON delivery_outbox
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_direct_recipient();
ALTER TABLE delivery_outbox ADD CONSTRAINT meta_direct_recipient_redaction_check CHECK(
 content_redacted_at IS NULL OR meta_direct_recipient IS NULL OR
 (meta_direct_recipient->'redacted'='true'::jsonb AND meta_direct_recipient->>'sha256' ~ '^[0-9a-f]{64}$'
  AND meta_direct_recipient-ARRAY['redacted','sha256']='{}'::jsonb));
CREATE TRIGGER meta_direct_alias_guard BEFORE INSERT OR UPDATE OR DELETE ON meta_direct_identity_aliases FOR EACH ROW EXECUTE FUNCTION app.guard_meta_direct_alias();

REVOKE ALL ON FUNCTION app.meta_direct_participant_matches(uuid,text,text),app.meta_direct_privacy_target_authorized(text,text),
 app.guard_meta_direct_alias(),app.snapshot_meta_direct_recipient(),app.preserve_meta_direct_recipient(),app.preserve_meta_direct_asset() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_direct_participant_matches(uuid,text,text),app.meta_direct_privacy_target_authorized(text,text) TO wasalx_app,wasalx_connector_worker;


CREATE OR REPLACE FUNCTION app.has_applicable_privacy_hold(
  requested_scope_type text,
  requested_scope_value text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF requested_scope_type NOT IN ('TENANT','ZAMMAD_TICKET','REFERENCE','PARTICIPANT','ZAMMAD_USER')
     OR requested_scope_value IS NULL OR length(requested_scope_value) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'invalid privacy hold scope' USING ERRCODE='22023';
  END IF;

  RETURN EXISTS (
    WITH impacted_tickets AS (
      SELECT DISTINCT correlation.zammad_ticket_id
        FROM case_correlations AS correlation
       WHERE correlation.tenant_id=app.current_tenant_id()
         AND (
           requested_scope_type='TENANT'
           OR (requested_scope_type='ZAMMAD_TICKET' AND correlation.zammad_ticket_id=requested_scope_value)
           OR (requested_scope_type='REFERENCE' AND correlation.normalized_reference=requested_scope_value)
           OR (
             requested_scope_type='PARTICIPANT'
             AND EXISTS (
               SELECT 1 FROM message_links AS link
               JOIN normalized_messages AS message
                 ON message.tenant_id=link.tenant_id
                AND message.connection_id=link.connection_id
                AND message.external_message_id=link.external_message_id
              WHERE link.tenant_id=correlation.tenant_id
                AND link.zammad_ticket_id=correlation.zammad_ticket_id
                AND (message.external_participant_id=requested_scope_value OR (message.provider_metadata->'direct'='true'::jsonb AND app.meta_direct_participant_matches(message.connection_id,message.external_participant_id,requested_scope_value)))
             )
           )
         )
      UNION
      SELECT DISTINCT conversation.zammad_ticket_id
        FROM bot_conversations AS conversation
       WHERE conversation.tenant_id=app.current_tenant_id()
         AND conversation.zammad_ticket_id IS NOT NULL
         AND (
           requested_scope_type='TENANT'
           OR (requested_scope_type='ZAMMAD_TICKET' AND conversation.zammad_ticket_id=requested_scope_value)
           OR (requested_scope_type='REFERENCE' AND conversation.normalized_reference=requested_scope_value)
           OR (requested_scope_type='PARTICIPANT' AND app.meta_direct_participant_matches(conversation.connection_id,conversation.external_chat_id,requested_scope_value))
         )
      UNION
      SELECT DISTINCT link.zammad_ticket_id
        FROM normalized_messages AS message
        JOIN message_links AS link
          ON link.tenant_id=message.tenant_id
         AND link.connection_id=message.connection_id
         AND link.external_message_id=message.external_message_id
       WHERE message.tenant_id=app.current_tenant_id()
         AND requested_scope_type='ZAMMAD_USER'
         AND message.provider_metadata->>'zammad_customer_id'=requested_scope_value
      UNION
      SELECT requested_scope_value
       WHERE requested_scope_type='ZAMMAD_TICKET'
    )
    SELECT 1
      FROM privacy_legal_holds AS hold
     WHERE hold.tenant_id=app.current_tenant_id()
       AND hold.state='ACTIVE'
       AND (hold.expires_at IS NULL OR hold.expires_at>now())
       AND (
         requested_scope_type='TENANT'
         OR hold.scope_type='TENANT'
         OR (hold.scope_type=requested_scope_type AND hold.scope_value=requested_scope_value)
         OR (requested_scope_type='PARTICIPANT' AND hold.scope_type='PARTICIPANT' AND EXISTS(
           SELECT 1 FROM participant_identities participant WHERE participant.tenant_id=hold.tenant_id
             AND app.meta_direct_participant_matches(participant.connection_id,participant.external_participant_id,requested_scope_value)
             AND app.meta_direct_participant_matches(participant.connection_id,participant.external_participant_id,hold.scope_value)))
         OR (hold.scope_type='ZAMMAD_TICKET' AND hold.scope_value IN (SELECT zammad_ticket_id FROM impacted_tickets))
         OR (
           hold.scope_type='REFERENCE'
           AND (
             EXISTS (
               SELECT 1 FROM case_correlations AS correlation
                WHERE correlation.tenant_id=hold.tenant_id
                  AND correlation.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                  AND correlation.normalized_reference=hold.scope_value
             )
             OR EXISTS (
               SELECT 1 FROM bot_conversations AS conversation
                WHERE conversation.tenant_id=hold.tenant_id
                  AND conversation.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                  AND conversation.normalized_reference=hold.scope_value
             )
           )
         )
         OR (
           hold.scope_type IN ('GROUP_BINDING','WHATSAPP_GROUP')
           AND (
             EXISTS (
               SELECT 1 FROM case_correlations AS correlation
               JOIN group_bindings AS binding
                 ON binding.tenant_id=correlation.tenant_id AND binding.id=correlation.group_binding_id
              WHERE correlation.tenant_id=hold.tenant_id
                AND correlation.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                AND (
                  (hold.scope_type='GROUP_BINDING' AND binding.id::text=lower(hold.scope_value))
                  OR (hold.scope_type='WHATSAPP_GROUP' AND binding.whatsapp_group_id::text=lower(hold.scope_value))
                )
             )
             OR EXISTS (
               SELECT 1 FROM normalized_messages AS message
               JOIN whatsapp_groups AS group_record
                 ON group_record.tenant_id=message.tenant_id
                AND group_record.connection_id=message.connection_id
                AND group_record.external_group_id=message.external_group_id
               LEFT JOIN group_bindings AS binding
                 ON binding.tenant_id=group_record.tenant_id
                AND binding.whatsapp_group_id=group_record.id
               LEFT JOIN message_links AS link
                 ON link.tenant_id=message.tenant_id
                AND link.connection_id=message.connection_id
                AND link.external_message_id=message.external_message_id
              WHERE message.tenant_id=hold.tenant_id
                AND (
                  (hold.scope_type='GROUP_BINDING' AND binding.id::text=lower(hold.scope_value))
                  OR (hold.scope_type='WHATSAPP_GROUP' AND group_record.id::text=lower(hold.scope_value))
                )
                AND (
                  (requested_scope_type='PARTICIPANT' AND (message.external_participant_id=requested_scope_value OR (message.provider_metadata->'direct'='true'::jsonb AND app.meta_direct_participant_matches(message.connection_id,message.external_participant_id,requested_scope_value))))
                  OR (requested_scope_type='ZAMMAD_USER' AND message.provider_metadata->>'zammad_customer_id'=requested_scope_value)
                  OR link.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                )
             )
           )
         )
         OR (
           hold.scope_type='ZAMMAD_USER'
           AND EXISTS (
             SELECT 1 FROM normalized_messages AS message
             LEFT JOIN message_links AS link
               ON link.tenant_id=message.tenant_id
              AND link.connection_id=message.connection_id
              AND link.external_message_id=message.external_message_id
              WHERE message.tenant_id=hold.tenant_id
                AND message.provider_metadata->>'zammad_customer_id'=hold.scope_value
                AND (
                  link.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                  OR (
                    requested_scope_type='PARTICIPANT'
                    AND (message.external_participant_id=requested_scope_value OR (message.provider_metadata->'direct'='true'::jsonb AND app.meta_direct_participant_matches(message.connection_id,message.external_participant_id,requested_scope_value)))
                  )
                )
           )
         )
         OR (
           hold.scope_type='PARTICIPANT'
           AND (
             EXISTS (
               SELECT 1 FROM message_links AS link
               JOIN normalized_messages AS message
                 ON message.tenant_id=link.tenant_id
                AND message.connection_id=link.connection_id
                AND message.external_message_id=link.external_message_id
              WHERE link.tenant_id=hold.tenant_id
                AND link.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                AND (message.external_participant_id=hold.scope_value OR (message.provider_metadata->'direct'='true'::jsonb AND app.meta_direct_participant_matches(message.connection_id,message.external_participant_id,hold.scope_value)))
             )
             OR EXISTS (
               SELECT 1 FROM bot_conversations AS conversation
                WHERE conversation.tenant_id=hold.tenant_id
                  AND conversation.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                  AND app.meta_direct_participant_matches(conversation.connection_id,conversation.external_chat_id,hold.scope_value)
             )
           )
         )
       )
  );
END;
$$;

CREATE OR REPLACE FUNCTION app.delivery_has_active_privacy_target(delivery_value uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path=pg_catalog,public,app
AS $$
  SELECT EXISTS (
    SELECT 1 FROM delivery_outbox delivery
    JOIN privacy_jobs job ON job.tenant_id=delivery.tenant_id
    LEFT JOIN group_bindings binding
      ON binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id
    WHERE delivery.tenant_id=app.current_tenant_id() AND delivery.id=delivery_value
      AND job.job_type IN ('DELETE','RETENTION_SWEEP')
      AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
      AND (
        -- ponytail: one tenant-wide delete fence is safer and cheaper for the
        -- first-client beta; narrow it only if measured delete latency demands it.
        job.job_type='DELETE'
        OR EXISTS (
          SELECT 1 FROM privacy_job_targets target
           WHERE target.tenant_id=job.tenant_id AND target.job_id=job.id
             AND target.target_type='DELIVERY' AND target.target_id=delivery.id::text
             AND target.state IN ('PENDING','EXTERNAL_COMPLETE')
        )
        OR (job.job_type='DELETE' AND job.scope_type='TENANT')
        OR EXISTS (
          SELECT 1 FROM privacy_job_targets target
           WHERE target.tenant_id=job.tenant_id AND target.job_id=job.id
             AND target.target_type='ZAMMAD_TICKET'
             AND target.state IN ('PENDING','EXTERNAL_COMPLETE')
             AND (target.target_id=delivery.zammad_ticket_id OR EXISTS (
               SELECT 1 FROM delivery_ticket_links link
                WHERE link.tenant_id=delivery.tenant_id AND link.delivery_id=delivery.id
                  AND link.zammad_ticket_id=target.target_id
             ))
        )
        OR (job.job_type='DELETE' AND job.scope_type='PARTICIPANT'
          AND ((job.scope_value=delivery.external_chat_id OR (delivery.direct_origin IS NOT NULL AND app.meta_direct_participant_matches(delivery.connection_id,delivery.external_chat_id,job.scope_value))) OR job.scope_value=ANY(delivery.mentions)))
        OR EXISTS (
          SELECT 1 FROM privacy_job_targets target
          JOIN normalized_messages message
            ON message.tenant_id=target.tenant_id AND message.id::text=target.target_id
          JOIN whatsapp_groups message_group
            ON message_group.tenant_id=message.tenant_id
           AND message_group.connection_id=message.connection_id
           AND message_group.external_group_id=message.external_group_id
          WHERE target.tenant_id=job.tenant_id AND target.job_id=job.id
            AND target.target_type='NORMALIZED_MESSAGE'
            AND target.state IN ('PENDING','EXTERNAL_COMPLETE')
            AND message.connection_id=delivery.connection_id
            AND message.external_message_id=delivery.reply_to_message_id
            AND message_group.id=COALESCE(delivery.group_workspace_group_id,binding.whatsapp_group_id)
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION app.purge_expired_unmatched_events(
  retain_for interval,
  cutoff_at timestamptz
)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on
AS $$
DECLARE affected bigint;
BEGIN
  IF retain_for<interval '1 hour' OR retain_for>interval '24 hours'
     OR cutoff_at IS NULL THEN
    RAISE EXCEPTION 'invalid unmatched diagnostic retention cutoff'
      USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM privacy_legal_holds
     WHERE tenant_id=app.current_tenant_id() AND state='ACTIVE'
       AND (expires_at IS NULL OR expires_at>clock_timestamp())
       AND scope_type='TENANT'
  ) THEN
    RETURN 0;
  END IF;
  DELETE FROM event_inbox inbox
   WHERE inbox.tenant_id=app.current_tenant_id()
     AND inbox.meta_direct_identity_change IS NULL
     AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=inbox.tenant_id AND alias.source_event_id=inbox.id)
     AND inbox.status IN ('UNMATCHED','IGNORED','DUPLICATE','REDACTED')
     AND COALESCE(inbox.processed_at,inbox.received_at)<=cutoff_at-retain_for
     AND NOT EXISTS (
       SELECT 1 FROM normalized_messages message
        WHERE message.tenant_id=inbox.tenant_id
          AND message.event_inbox_id=inbox.id
     );
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION app.purge_expired_unmatched_events(interval,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_unmatched_events(interval,timestamptz) TO wasalx_app,wasalx_connector_worker;
COMMIT;
