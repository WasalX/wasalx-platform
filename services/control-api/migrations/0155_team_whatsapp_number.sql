CREATE FUNCTION app.valid_team_whatsapp_numbers(numbers text[])
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT COALESCE(array_ndims(numbers),1)=1
    AND NOT EXISTS (SELECT 1 FROM unnest(numbers) number WHERE number IS NULL OR number !~ '^\+[1-9][0-9]{1,14}$')
    AND cardinality(numbers)=(SELECT count(DISTINCT number) FROM unnest(numbers) number);
$$;
ALTER TABLE tenant_memberships
  ADD COLUMN whatsapp_numbers text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT tenant_membership_whatsapp_numbers_format
    CHECK (app.valid_team_whatsapp_numbers(whatsapp_numbers));

GRANT SELECT (tenant_id,whatsapp_numbers) ON tenant_memberships TO wasalx_connector_worker;
GRANT UPDATE (whatsapp_numbers) ON tenant_memberships TO wasalx_app;

CREATE FUNCTION app.group_rule_sender(p_tenant uuid,p_connection uuid,p_group text,p_participant text)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
  WITH identity AS (
    SELECT CASE WHEN p_participant ~ '^[1-9][0-9]{1,14}@(c\.us|s\.whatsapp\.net)$'
                THEN '+' || split_part(p_participant,'@',1)
                ELSE participant.normalized_phone END AS phone
      FROM public.whatsapp_groups group_record
      LEFT JOIN public.group_workspace_participants participant
        ON participant.tenant_id=group_record.tenant_id
       AND participant.whatsapp_group_id=group_record.id
       AND participant.external_participant_id=p_participant
     WHERE group_record.tenant_id=p_tenant AND group_record.connection_id=p_connection
       AND group_record.external_group_id=p_group
  )
  SELECT COALESCE((SELECT CASE WHEN phone IS NULL THEN 'unknown'
    WHEN EXISTS (SELECT 1 FROM public.tenant_memberships member
                 WHERE member.tenant_id=p_tenant AND identity.phone=ANY(member.whatsapp_numbers))
    THEN 'team' ELSE 'customer' END FROM identity),'unknown');
$$;
REVOKE ALL ON FUNCTION app.group_rule_sender(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.group_rule_sender(uuid,uuid,text,text) TO wasalx_app,wasalx_connector_worker;
