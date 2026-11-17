CREATE OR REPLACE FUNCTION app.group_rule_sender(p_tenant uuid,p_connection uuid,p_group text,p_participant text)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
  WITH identity AS (
    SELECT CASE WHEN p_participant ~ '^[1-9][0-9]{1,14}@(c\.us|s\.whatsapp\.net)$'
                THEN '+' || split_part(p_participant,'@',1) END AS canonical_phone,
           participant.normalized_phone AS roster_phone
      FROM public.whatsapp_groups group_record
      LEFT JOIN public.group_workspace_participants participant
        ON participant.tenant_id=group_record.tenant_id
       AND participant.whatsapp_group_id=group_record.id
       AND participant.external_participant_id=p_participant
     WHERE group_record.tenant_id=p_tenant AND group_record.connection_id=p_connection
       AND group_record.external_group_id=p_group
  ), resolved AS (
    SELECT CASE WHEN canonical_phone IS NOT NULL AND roster_phone IS NOT NULL AND canonical_phone<>roster_phone THEN NULL
                ELSE COALESCE(canonical_phone,roster_phone) END AS phone,
           canonical_phone IS NOT NULL AND roster_phone IS NOT NULL AND canonical_phone<>roster_phone AS conflict
      FROM identity
  )
  SELECT COALESCE((SELECT CASE WHEN conflict OR phone IS NULL THEN 'unknown'
    WHEN EXISTS (SELECT 1 FROM public.tenant_memberships member
                 WHERE member.tenant_id=p_tenant AND resolved.phone=ANY(member.whatsapp_numbers))
    THEN 'team' ELSE 'customer' END FROM resolved),'unknown');
$$;
REVOKE ALL ON FUNCTION app.group_rule_sender(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.group_rule_sender(uuid,uuid,text,text) TO wasalx_app,wasalx_connector_worker;
