BEGIN;

-- Refuse to install over contaminated state. RLS can hide a foreign tenant's
-- parent row, but a legacy single-column FK still allowed the reference.
DO $$
DECLARE
  foreign_key record;
  join_sql text;
  mismatch boolean;
BEGIN
  FOR foreign_key IN
    SELECT constraint_record.oid,constraint_record.conname,
           constraint_record.conrelid,constraint_record.confrelid
      FROM pg_constraint AS constraint_record
      JOIN pg_attribute AS source_tenant
        ON source_tenant.attrelid=constraint_record.conrelid
       AND source_tenant.attname='tenant_id' AND NOT source_tenant.attisdropped
      JOIN pg_attribute AS target_tenant
        ON target_tenant.attrelid=constraint_record.confrelid
       AND target_tenant.attname='tenant_id' AND NOT target_tenant.attisdropped
     WHERE constraint_record.contype='f'
       AND NOT (source_tenant.attnum=ANY(constraint_record.conkey))
  LOOP
    SELECT string_agg(
             format('child.%I = parent.%I',source_attribute.attname,target_attribute.attname),
             ' AND ' ORDER BY pair.ordinality
           )
      INTO join_sql
      FROM pg_constraint AS constraint_record
      CROSS JOIN LATERAL unnest(constraint_record.conkey,constraint_record.confkey)
        WITH ORDINALITY AS pair(source_attnum,target_attnum,ordinality)
      JOIN pg_attribute AS source_attribute
        ON source_attribute.attrelid=constraint_record.conrelid
       AND source_attribute.attnum=pair.source_attnum
      JOIN pg_attribute AS target_attribute
        ON target_attribute.attrelid=constraint_record.confrelid
       AND target_attribute.attnum=pair.target_attnum
     WHERE constraint_record.oid=foreign_key.oid;
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %s child JOIN %s parent ON %s WHERE child.tenant_id IS DISTINCT FROM parent.tenant_id)',
      foreign_key.conrelid::regclass,foreign_key.confrelid::regclass,join_sql
    ) INTO mismatch;
    IF mismatch THEN
      RAISE EXCEPTION 'cross-tenant rows violate %',foreign_key.conname USING ERRCODE='23514';
    END IF;
  END LOOP;
END
$$;

ALTER TABLE case_correlations
  ADD CONSTRAINT case_correlations_tenant_id_id_key UNIQUE (tenant_id,id);
ALTER TABLE platform_support_access_requests
  ADD CONSTRAINT platform_support_access_requests_tenant_id_id_key UNIQUE (tenant_id,id);
ALTER TABLE privacy_jobs
  ADD CONSTRAINT privacy_jobs_tenant_id_id_key UNIQUE (tenant_id,id);
ALTER TABLE privacy_requests
  ADD CONSTRAINT privacy_requests_tenant_id_id_key UNIQUE (tenant_id,id);
ALTER TABLE tenant_invitations
  ADD CONSTRAINT tenant_invitations_tenant_id_id_key UNIQUE (tenant_id,id);
ALTER TABLE zammad_instances
  ADD CONSTRAINT zammad_instances_tenant_id_id_key UNIQUE (tenant_id,id);

ALTER TABLE case_correlations
  ADD CONSTRAINT case_correlations_group_binding_tenant_fk
    FOREIGN KEY (tenant_id,group_binding_id) REFERENCES group_bindings(tenant_id,id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT case_corr_predecessor_tenant_fk
    FOREIGN KEY (tenant_id,predecessor_correlation_id) REFERENCES case_correlations(tenant_id,id)
    ON DELETE SET NULL (predecessor_correlation_id) NOT VALID,
  ADD CONSTRAINT case_corr_replacement_tenant_fk
    FOREIGN KEY (tenant_id,replaced_by_correlation_id) REFERENCES case_correlations(tenant_id,id)
    ON DELETE SET NULL (replaced_by_correlation_id) NOT VALID;
ALTER TABLE case_detach_operations
  ADD CONSTRAINT case_detach_correlation_tenant_fk
    FOREIGN KEY (tenant_id,correlation_id) REFERENCES case_correlations(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE delivery_attempts
  ADD CONSTRAINT delivery_attempts_delivery_tenant_fk
    FOREIGN KEY (tenant_id,delivery_id) REFERENCES delivery_outbox(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE delivery_outbox
  ADD CONSTRAINT delivery_outbox_connection_tenant_fk
    FOREIGN KEY (tenant_id,connection_id) REFERENCES connections(tenant_id,id) NOT VALID,
  ADD CONSTRAINT delivery_outbox_group_binding_tenant_fk
    FOREIGN KEY (tenant_id,group_binding_id) REFERENCES group_bindings(tenant_id,id) NOT VALID;
ALTER TABLE delivery_ticket_links
  ADD CONSTRAINT delivery_ticket_links_delivery_tenant_fk
    FOREIGN KEY (tenant_id,delivery_id) REFERENCES delivery_outbox(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE event_inbox
  ADD CONSTRAINT event_inbox_connection_tenant_fk
    FOREIGN KEY (tenant_id,connection_id) REFERENCES connections(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE group_bindings
  ADD CONSTRAINT group_bindings_rule_set_tenant_fk
    FOREIGN KEY (tenant_id,rule_set_id) REFERENCES rule_sets(tenant_id,id) NOT VALID,
  ADD CONSTRAINT group_bindings_whatsapp_group_tenant_fk
    FOREIGN KEY (tenant_id,whatsapp_group_id) REFERENCES whatsapp_groups(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE message_links
  ADD CONSTRAINT message_links_connection_tenant_fk
    FOREIGN KEY (tenant_id,connection_id) REFERENCES connections(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE normalized_messages
  ADD CONSTRAINT normalized_messages_connection_tenant_fk
    FOREIGN KEY (tenant_id,connection_id) REFERENCES connections(tenant_id,id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT normalized_messages_event_tenant_fk
    FOREIGN KEY (tenant_id,event_inbox_id) REFERENCES event_inbox(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE participant_identities
  ADD CONSTRAINT participant_identities_connection_tenant_fk
    FOREIGN KEY (tenant_id,connection_id) REFERENCES connections(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE platform_support_operator_requests
  ADD CONSTRAINT platform_support_request_tenant_fk
    FOREIGN KEY (tenant_id,support_request_id) REFERENCES platform_support_access_requests(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE privacy_export_artifacts
  ADD CONSTRAINT privacy_export_request_tenant_fk
    FOREIGN KEY (tenant_id,request_id) REFERENCES privacy_requests(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE privacy_job_targets
  ADD CONSTRAINT privacy_job_targets_job_tenant_fk
    FOREIGN KEY (tenant_id,job_id) REFERENCES privacy_jobs(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE privacy_jobs
  ADD CONSTRAINT privacy_jobs_request_tenant_fk
    FOREIGN KEY (tenant_id,request_id) REFERENCES privacy_requests(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE provider_sessions
  ADD CONSTRAINT provider_sessions_connection_tenant_fk
    FOREIGN KEY (tenant_id,connection_id) REFERENCES connections(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE tenant_invitation_email_outbox
  ADD CONSTRAINT tenant_invitation_email_invitation_tenant_fk
    FOREIGN KEY (tenant_id,invitation_id) REFERENCES tenant_invitations(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE trigger_rules
  ADD CONSTRAINT trigger_rules_rule_set_tenant_fk
    FOREIGN KEY (tenant_id,rule_set_id) REFERENCES rule_sets(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE webhook_routes
  ADD CONSTRAINT webhook_routes_connection_tenant_fk
    FOREIGN KEY (tenant_id,connection_id) REFERENCES connections(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE whatsapp_groups
  ADD CONSTRAINT whatsapp_groups_connection_tenant_fk
    FOREIGN KEY (tenant_id,connection_id) REFERENCES connections(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE zammad_status_outbox
  ADD CONSTRAINT zammad_status_delivery_tenant_fk
    FOREIGN KEY (tenant_id,delivery_id) REFERENCES delivery_outbox(tenant_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE zammad_ticket_state_events
  ADD CONSTRAINT zammad_ticket_state_instance_tenant_fk
    FOREIGN KEY (tenant_id,zammad_instance_id) REFERENCES zammad_instances(tenant_id,id) ON DELETE CASCADE NOT VALID;

ALTER TABLE case_correlations
  VALIDATE CONSTRAINT case_correlations_group_binding_tenant_fk,
  VALIDATE CONSTRAINT case_corr_predecessor_tenant_fk,
  VALIDATE CONSTRAINT case_corr_replacement_tenant_fk;
ALTER TABLE case_detach_operations VALIDATE CONSTRAINT case_detach_correlation_tenant_fk;
ALTER TABLE delivery_attempts VALIDATE CONSTRAINT delivery_attempts_delivery_tenant_fk;
ALTER TABLE delivery_outbox
  VALIDATE CONSTRAINT delivery_outbox_connection_tenant_fk,
  VALIDATE CONSTRAINT delivery_outbox_group_binding_tenant_fk;
ALTER TABLE delivery_ticket_links VALIDATE CONSTRAINT delivery_ticket_links_delivery_tenant_fk;
ALTER TABLE event_inbox VALIDATE CONSTRAINT event_inbox_connection_tenant_fk;
ALTER TABLE group_bindings
  VALIDATE CONSTRAINT group_bindings_rule_set_tenant_fk,
  VALIDATE CONSTRAINT group_bindings_whatsapp_group_tenant_fk;
ALTER TABLE message_links VALIDATE CONSTRAINT message_links_connection_tenant_fk;
ALTER TABLE normalized_messages
  VALIDATE CONSTRAINT normalized_messages_connection_tenant_fk,
  VALIDATE CONSTRAINT normalized_messages_event_tenant_fk;
ALTER TABLE participant_identities VALIDATE CONSTRAINT participant_identities_connection_tenant_fk;
ALTER TABLE platform_support_operator_requests VALIDATE CONSTRAINT platform_support_request_tenant_fk;
ALTER TABLE privacy_export_artifacts VALIDATE CONSTRAINT privacy_export_request_tenant_fk;
ALTER TABLE privacy_job_targets VALIDATE CONSTRAINT privacy_job_targets_job_tenant_fk;
ALTER TABLE privacy_jobs VALIDATE CONSTRAINT privacy_jobs_request_tenant_fk;
ALTER TABLE provider_sessions VALIDATE CONSTRAINT provider_sessions_connection_tenant_fk;
ALTER TABLE tenant_invitation_email_outbox VALIDATE CONSTRAINT tenant_invitation_email_invitation_tenant_fk;
ALTER TABLE trigger_rules VALIDATE CONSTRAINT trigger_rules_rule_set_tenant_fk;
ALTER TABLE webhook_routes VALIDATE CONSTRAINT webhook_routes_connection_tenant_fk;
ALTER TABLE whatsapp_groups VALIDATE CONSTRAINT whatsapp_groups_connection_tenant_fk;
ALTER TABLE zammad_status_outbox VALIDATE CONSTRAINT zammad_status_delivery_tenant_fk;
ALTER TABLE zammad_ticket_state_events VALIDATE CONSTRAINT zammad_ticket_state_instance_tenant_fk;

ALTER TABLE case_correlations
  DROP CONSTRAINT case_correlations_group_binding_id_fkey,
  DROP CONSTRAINT case_correlations_predecessor_fk,
  DROP CONSTRAINT case_correlations_replacement_fk;
ALTER TABLE case_detach_operations DROP CONSTRAINT case_detach_operations_correlation_id_fkey;
ALTER TABLE delivery_attempts DROP CONSTRAINT delivery_attempts_delivery_id_fkey;
ALTER TABLE delivery_outbox
  DROP CONSTRAINT delivery_outbox_connection_id_fkey,
  DROP CONSTRAINT delivery_outbox_group_binding_id_fkey;
ALTER TABLE delivery_ticket_links DROP CONSTRAINT delivery_ticket_links_delivery_id_fkey;
ALTER TABLE event_inbox DROP CONSTRAINT event_inbox_connection_id_fkey;
ALTER TABLE group_bindings
  DROP CONSTRAINT group_bindings_rule_set_id_fkey,
  DROP CONSTRAINT group_bindings_whatsapp_group_id_fkey;
ALTER TABLE message_links DROP CONSTRAINT message_links_connection_id_fkey;
ALTER TABLE normalized_messages
  DROP CONSTRAINT normalized_messages_connection_id_fkey,
  DROP CONSTRAINT normalized_messages_event_inbox_id_fkey;
ALTER TABLE participant_identities DROP CONSTRAINT participant_identities_connection_id_fkey;
ALTER TABLE platform_support_operator_requests DROP CONSTRAINT platform_support_operator_requests_support_request_id_fkey;
ALTER TABLE privacy_export_artifacts DROP CONSTRAINT privacy_export_artifacts_request_id_fkey;
ALTER TABLE privacy_job_targets DROP CONSTRAINT privacy_job_targets_job_id_fkey;
ALTER TABLE privacy_jobs DROP CONSTRAINT privacy_jobs_request_id_fkey;
ALTER TABLE provider_sessions DROP CONSTRAINT provider_sessions_connection_id_fkey;
ALTER TABLE tenant_invitation_email_outbox DROP CONSTRAINT tenant_invitation_email_outbox_invitation_id_fkey;
ALTER TABLE trigger_rules DROP CONSTRAINT trigger_rules_rule_set_id_fkey;
ALTER TABLE webhook_routes DROP CONSTRAINT webhook_routes_connection_id_fkey;
ALTER TABLE whatsapp_groups DROP CONSTRAINT whatsapp_groups_connection_id_fkey;
ALTER TABLE zammad_status_outbox DROP CONSTRAINT zammad_status_outbox_delivery_id_fkey;
ALTER TABLE zammad_ticket_state_events DROP CONSTRAINT zammad_ticket_state_events_zammad_instance_id_fkey;

ALTER TABLE delivery_outbox
  DROP CONSTRAINT delivery_outbox_idempotency_key_key,
  ADD CONSTRAINT delivery_outbox_tenant_id_idempotency_key_key UNIQUE (tenant_id,idempotency_key);

COMMIT;
