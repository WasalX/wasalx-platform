GRANT SELECT (tenant_id,state,available_at,lease_expires_at) ON client_routing_sync_jobs TO wasalx_scheduler_reader;

CREATE OR REPLACE FUNCTION app.enqueue_scheduled_client_routing_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
  IF NEW.state='ACTIVE' AND NEW.next_due_at IS NOT NULL AND (NEW.snapshot_revision<>OLD.snapshot_revision OR NEW.next_due_at IS DISTINCT FROM OLD.next_due_at) THEN
    INSERT INTO client_routing_sync_jobs(tenant_id,source_state_id,config_sha256,trigger_key,trigger_kind,expected_snapshot_revision,available_at)
    VALUES(NEW.tenant_id,NEW.id,NEW.config_sha256,'scheduled:'||floor(extract(epoch FROM NEW.next_due_at))::bigint::text,'SCHEDULED',NEW.snapshot_revision,NEW.next_due_at)
    ON CONFLICT DO NOTHING;
  END IF;RETURN NEW;
END
$$;
CREATE TRIGGER client_routing_source_schedule AFTER UPDATE OF snapshot_revision,next_due_at ON client_routing_source_state
FOR EACH ROW EXECUTE FUNCTION app.enqueue_scheduled_client_routing_sync();

CREATE OR REPLACE FUNCTION app.fail_client_routing_sync_job(requested_job_id uuid,worker_lease uuid,expected_fence bigint,retryable boolean,failure text,retry_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE affected integer;DECLARE current_tenant uuid:=app.current_tenant_id();DECLARE terminal boolean;
BEGIN
  UPDATE client_routing_sync_jobs SET state=CASE WHEN retryable AND attempts<max_attempts THEN 'FAILED_RETRYABLE' ELSE 'FAILED_TERMINAL' END,
    lease_id=NULL,lease_expires_at=NULL,available_at=CASE WHEN retryable AND attempts<max_attempts THEN COALESCE(retry_at,now()+interval '1 minute') ELSE available_at END,
    safe_error=left(failure,500),completed_at=CASE WHEN retryable AND attempts<max_attempts THEN NULL ELSE now() END,updated_at=now()
   WHERE tenant_id=current_tenant AND id=requested_job_id AND state='RUNNING' AND lease_id=worker_lease
     AND fencing_token=expected_fence AND lease_expires_at>=now()
   RETURNING state='FAILED_TERMINAL' INTO terminal;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=1 THEN UPDATE client_routing_source_state source SET safe_error=left(failure,500),state=CASE WHEN terminal THEN 'CONFLICT' ELSE source.state END,updated_at=now()
    FROM client_routing_sync_jobs job WHERE job.tenant_id=current_tenant AND job.id=requested_job_id AND source.tenant_id=job.tenant_id AND source.id=job.source_state_id;END IF;
  RETURN affected=1;
END
$$;

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
             OR EXISTS (SELECT 1 FROM bot_conversations conversation WHERE conversation.tenant_id=delivery.tenant_id AND conversation.id=delivery.bot_conversation_id))
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
