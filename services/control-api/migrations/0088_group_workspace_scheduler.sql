-- Ticketless group-workspace deliveries are ordinary durable delivery work.
-- Include their captured group route in the scheduler's canonical discovery.
GRANT SELECT (group_workspace_group_id) ON delivery_outbox TO wasalx_scheduler_reader;
GRANT SELECT (tenant_id,whatsapp_group_id,capture_enabled)
  ON group_workspace_settings TO wasalx_scheduler_reader;

CREATE OR REPLACE FUNCTION app.list_due_worker_tenants(scan_limit integer DEFAULT 200)
RETURNS TABLE (tenant_id uuid,work_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
  IF scan_limit<1 OR scan_limit>1000 THEN RAISE EXCEPTION 'scan limit must be between 1 and 1000' USING ERRCODE='22023';END IF;
  RETURN QUERY SELECT candidate.tenant_id,candidate.work_type FROM (
    SELECT inbox.tenant_id,'inbound'::text AS work_type,min(inbox.available_at) AS available_at
      FROM event_inbox inbox JOIN tenants tenant ON tenant.id=inbox.tenant_id
     WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND
       ((inbox.status IN ('ACCEPTED','FAILED_RETRYABLE') AND inbox.available_at<=now()) OR (inbox.status='PROCESSING' AND inbox.lease_expires_at<now())) GROUP BY inbox.tenant_id
    UNION ALL
    SELECT pending.tenant_id,'delivery'::text,min(pending.available_at) FROM (
      SELECT delivery.tenant_id,delivery.available_at FROM delivery_outbox delivery JOIN tenants tenant ON tenant.id=delivery.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND
         ((delivery.state='SENDING' AND delivery.lease_expires_at<now()) OR
          (((delivery.state IN ('QUEUED','FAILED_RETRYABLE') AND delivery.available_at<=now()) OR (delivery.state='CLAIMED' AND delivery.lease_expires_at<now()))
           AND EXISTS (SELECT 1 FROM connections connection WHERE connection.tenant_id=delivery.tenant_id AND connection.id=delivery.connection_id AND connection.state='WORKING')
           AND (EXISTS (SELECT 1 FROM group_bindings binding WHERE binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id AND binding.state='ACTIVE')
             OR EXISTS (SELECT 1 FROM bot_conversations conversation WHERE conversation.tenant_id=delivery.tenant_id AND conversation.id=delivery.bot_conversation_id)
             OR EXISTS (SELECT 1 FROM group_workspace_settings workspace WHERE workspace.tenant_id=delivery.tenant_id AND workspace.whatsapp_group_id=delivery.group_workspace_group_id AND workspace.capture_enabled))
           AND EXISTS (SELECT 1 FROM provider_sessions session WHERE session.tenant_id=delivery.tenant_id AND session.connection_id=delivery.connection_id AND session.ownership_state='ACTIVE' AND session.state='WORKING')
           AND EXISTS (SELECT 1 FROM zammad_instances zammad WHERE zammad.tenant_id=delivery.tenant_id AND zammad.state='WORKING')
           AND EXISTS (SELECT 1 FROM retention_policies policy WHERE policy.tenant_id=delivery.tenant_id)))
      UNION ALL
      SELECT status.tenant_id,status.available_at FROM zammad_status_outbox status JOIN tenants tenant ON tenant.id=status.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND status.completed_at IS NULL AND status.available_at<=now()
         AND (status.lease_expires_at IS NULL OR status.lease_expires_at<now())
      UNION ALL
      SELECT action.tenant_id,action.available_at FROM bot_action_jobs action JOIN tenants tenant ON tenant.id=action.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND ((action.state IN ('QUEUED','FAILED_RETRYABLE') AND action.available_at<=now()) OR (action.state='RUNNING' AND action.lease_expires_at<now()))
      UNION ALL
      SELECT handoff.tenant_id,handoff.available_at FROM bot_handoff_jobs handoff JOIN tenants tenant ON tenant.id=handoff.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND ((handoff.state IN ('QUEUED','FAILED_RETRYABLE') AND handoff.available_at<=now()) OR (handoff.state='RUNNING' AND handoff.lease_expires_at<now()))
    ) pending GROUP BY pending.tenant_id
    UNION ALL
    SELECT operation.tenant_id,'connection'::text,min(operation.available_at) FROM connection_operations operation JOIN tenants tenant ON tenant.id=operation.tenant_id
     WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND ((operation.state IN ('QUEUED','FAILED_RETRYABLE') AND operation.available_at<=now()) OR (operation.state='RUNNING' AND operation.lease_expires_at<now())) GROUP BY operation.tenant_id
    UNION ALL
    SELECT due.tenant_id,'privacy'::text,min(due.available_at) FROM (
      SELECT policy.tenant_id,policy.next_sweep_at AS available_at FROM retention_policies policy JOIN tenants tenant ON tenant.id=policy.tenant_id
       WHERE tenant.state='ACTIVE' AND policy.next_sweep_at<=now()
      UNION ALL
      SELECT job.tenant_id,job.available_at FROM privacy_jobs job JOIN tenants tenant ON tenant.id=job.tenant_id
       WHERE tenant.state='ACTIVE' AND ((job.state IN ('QUEUED','FAILED_RETRYABLE') AND job.available_at<=now()) OR (job.state='RUNNING' AND job.lease_expires_at<now()))
    ) due GROUP BY due.tenant_id
    UNION ALL
    SELECT routing.tenant_id,'routing'::text,min(routing.available_at) FROM client_routing_sync_jobs routing JOIN tenants tenant ON tenant.id=routing.tenant_id
     WHERE tenant.state='ACTIVE' AND ((routing.state IN ('QUEUED','FAILED_RETRYABLE') AND routing.available_at<=now()) OR (routing.state='RUNNING' AND routing.lease_expires_at<now())) GROUP BY routing.tenant_id
  ) candidate ORDER BY candidate.available_at,candidate.tenant_id,candidate.work_type LIMIT scan_limit;
END
$$;

ALTER FUNCTION app.list_due_worker_tenants(integer) OWNER TO wasalx_scheduler_reader;
REVOKE ALL ON FUNCTION app.list_due_worker_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_due_worker_tenants(integer) TO wasalx_app;
