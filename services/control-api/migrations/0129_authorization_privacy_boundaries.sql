-- Enforce authorization invariants at their shared database boundary.
CREATE OR REPLACE FUNCTION app.preserve_last_active_tenant_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
BEGIN
  IF OLD.role<>'tenant_owner' OR OLD.state<>'ACTIVE'
     OR (TG_OP='UPDATE' AND NEW.role='tenant_owner' AND NEW.state='ACTIVE') THEN
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;

  PERFORM 1 FROM tenants
   WHERE id=OLD.tenant_id AND state IN ('ACTIVE','PROVISIONING') FOR UPDATE;
  IF NOT FOUND THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_memberships
     WHERE tenant_id=OLD.tenant_id AND id<>OLD.id
       AND role='tenant_owner' AND state='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'WASALX_LAST_ACTIVE_OWNER' USING ERRCODE='P0001';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS tenant_memberships_preserve_owner ON tenant_memberships;
CREATE TRIGGER tenant_memberships_preserve_owner
BEFORE UPDATE OF role,state OR DELETE ON tenant_memberships
FOR EACH ROW EXECUTE FUNCTION app.preserve_last_active_tenant_owner();

CREATE OR REPLACE FUNCTION app.audit_support_access_expiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
BEGIN
  IF OLD.state IS DISTINCT FROM 'EXPIRED' AND NEW.state='EXPIRED' THEN
    INSERT INTO audit_events (
      tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id
    ) VALUES (
      NEW.tenant_id,'SYSTEM','system','support_access.expired',
      'platform_support_access',NEW.id::text,
      jsonb_build_object('state','EXPIRED','version',NEW.version),
      'support-expiry:'||NEW.id::text||':'||NEW.version::text
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS platform_support_access_audit_expiry ON platform_support_access_requests;
CREATE TRIGGER platform_support_access_audit_expiry
AFTER UPDATE OF state ON platform_support_access_requests
FOR EACH ROW EXECUTE FUNCTION app.audit_support_access_expiry();

INSERT INTO audit_events (
  tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id
)
SELECT request.tenant_id,'SYSTEM','system','support_access.expired',
  'platform_support_access',request.id::text,
  jsonb_build_object('state','EXPIRED','version',request.version),
  'support-expiry:'||request.id::text||':'||request.version::text
FROM platform_support_access_requests request
WHERE request.state='EXPIRED' AND NOT EXISTS (
  SELECT 1 FROM audit_events audit
   WHERE audit.tenant_id=request.tenant_id
     AND audit.action='support_access.expired'
     AND audit.target_type='platform_support_access'
     AND audit.target_id=request.id::text
);

CREATE OR REPLACE FUNCTION app.operator_support_overview(
  support_id uuid,actor_subject text,audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE
  request_value platform_support_access_requests%ROWTYPE;
  tenant_value tenants%ROWTYPE;
  result_value jsonb;
BEGIN
  SELECT * INTO request_value FROM platform_support_access_requests
   WHERE id=support_id AND operator_subject=actor_subject FOR UPDATE;
  IF request_value.id IS NULL THEN RETURN NULL; END IF;
  IF request_value.state='APPROVED' AND request_value.access_expires_at<=now() THEN
    UPDATE platform_support_access_requests
       SET state='EXPIRED',version=version+1,updated_at=now()
     WHERE id=request_value.id RETURNING * INTO request_value;
  END IF;
  IF request_value.state<>'APPROVED' OR request_value.access_expires_at<=now() THEN
    RETURN jsonb_build_object('active',false);
  END IF;
  SELECT * INTO tenant_value FROM tenants
   WHERE id=request_value.tenant_id AND state IN ('ACTIVE','PROVISIONING');
  IF tenant_value.id IS NULL THEN RETURN jsonb_build_object('active',false); END IF;

  SELECT jsonb_build_object(
    'support_access',jsonb_build_object('id',request_value.id,'scope',request_value.scope,
      'access_expires_at',request_value.access_expires_at),
    'tenant',jsonb_build_object('id',tenant_value.id,'name',tenant_value.name,'slug',tenant_value.slug,
      'state',tenant_value.state,'updated_at',tenant_value.updated_at),
    'zammad',COALESCE((SELECT jsonb_build_object('state',z.state,'version',z.version,
      'last_healthy_at',z.last_healthy_at) FROM zammad_instances z WHERE z.tenant_id=tenant_value.id),'null'::jsonb),
    'provisioning',COALESCE((SELECT jsonb_build_object('status',p.status,'action',p.action,
      'current_step',p.current_step,'completed_steps',p.completed_steps,'attempts',p.attempts,
      'max_attempts',p.max_attempts,'error_code',p.error_code,'updated_at',p.updated_at)
      FROM provisioning_operations p WHERE p.tenant_id=tenant_value.id),'null'::jsonb),
    'connections',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',c.id,'name',c.name,'provider',c.provider,'engine',c.engine,'phone_e164',c.phone_e164,
      'state',c.state,'last_heartbeat_at',c.last_heartbeat_at,'last_provider_event_at',c.last_provider_event_at,
      'action_reason',c.action_reason,'bound_group_count',(SELECT count(*) FROM whatsapp_groups g
        JOIN group_bindings b ON b.whatsapp_group_id=g.id WHERE g.tenant_id=c.tenant_id AND g.connection_id=c.id),
      'provider_session_state',(SELECT ps.state FROM provider_sessions ps WHERE ps.tenant_id=c.tenant_id
        AND ps.connection_id=c.id ORDER BY ps.created_at DESC LIMIT 1)) ORDER BY c.created_at,c.id)
      FROM connections c WHERE c.tenant_id=tenant_value.id),'[]'::jsonb),
    'delivery_summary',COALESCE((SELECT jsonb_object_agg(summary.state,summary.total)
      FROM (SELECT d.state,count(*) AS total FROM delivery_outbox d WHERE d.tenant_id=tenant_value.id GROUP BY d.state) summary),'{}'::jsonb),
    'oldest_actionable_delivery_at',(SELECT min(d.available_at) FROM delivery_outbox d
      WHERE d.tenant_id=tenant_value.id AND d.state IN ('QUEUED','FAILED_RETRYABLE','FAILED_TERMINAL','OUTCOME_UNKNOWN')),
    'inbound_summary',COALESCE((SELECT jsonb_object_agg(summary.status,summary.total)
      FROM (SELECT e.status,count(*) AS total FROM event_inbox e WHERE e.tenant_id=tenant_value.id GROUP BY e.status) summary),'{}'::jsonb),
    'recent_audit_metadata',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',recent.id,
      'actor_type',recent.actor_type,'action',recent.action,'target_type',recent.target_type,
      'target_id',recent.target_id,'created_at',recent.created_at) ORDER BY recent.created_at DESC)
      FROM (SELECT a.id,a.actor_type,a.action,a.target_type,a.target_id,a.created_at FROM audit_events a
        WHERE a.tenant_id=tenant_value.id ORDER BY a.created_at DESC LIMIT 25) recent),'[]'::jsonb)
  ) INTO result_value;

  INSERT INTO audit_events (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
  VALUES (tenant_value.id,'PLATFORM_OPERATOR',actor_subject,'support_access.metadata_inspected',
    'platform_support_access',support_id::text,
    jsonb_build_object('scope','OPERATIONAL_METADATA','access_expires_at',request_value.access_expires_at),audit_request_id);
  RETURN result_value;
END;
$$;

CREATE OR REPLACE FUNCTION app.operator_tenant_provisioning_status(
  tenant_value uuid,actor_subject text,audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE result_value jsonb;
BEGIN
  SELECT jsonb_build_object(
    'tenant_id',t.id,'tenant_name',t.name,'tenant_slug',t.slug,'tenant_state',t.state,
    'operation_id',p.operation_id,'zammad_instance_id',p.zammad_instance_id,
    'action',p.action,'status',p.status,'completed_steps',p.completed_steps,
    'current_step',p.current_step,'attempts',p.attempts,'max_attempts',p.max_attempts,
    'error_code',p.error_code,'available_at',p.available_at,'completed_at',p.completed_at,
    'updated_at',p.updated_at
  ) INTO result_value FROM tenants t JOIN provisioning_operations p ON p.tenant_id=t.id
   WHERE t.id=tenant_value;
  IF result_value IS NULL THEN RETURN NULL; END IF;
  INSERT INTO audit_events (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
  VALUES (tenant_value,'PLATFORM_OPERATOR',actor_subject,'tenant.provisioning_inspected',
    'tenant',tenant_value::text,jsonb_build_object('support_access',true),audit_request_id);
  RETURN result_value;
END;
$$;

ALTER FUNCTION app.preserve_last_active_tenant_owner() OWNER TO wasalx_tenant_admin_writer;
ALTER FUNCTION app.audit_support_access_expiry() OWNER TO wasalx_support_executor;
ALTER FUNCTION app.operator_support_overview(uuid,text,text) OWNER TO wasalx_support_executor;
ALTER FUNCTION app.operator_tenant_provisioning_status(uuid,text,text) OWNER TO wasalx_provisioning_executor;

REVOKE ALL ON FUNCTION app.preserve_last_active_tenant_owner() FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.audit_support_access_expiry() FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.operator_support_overview(uuid,text,text)
  FROM PUBLIC,wasalx_app,wasalx_provisioner,wasalx_provisioning_client;
REVOKE ALL ON FUNCTION app.operator_tenant_provisioning_status(uuid,text,text)
  FROM PUBLIC,wasalx_app,wasalx_provisioner,wasalx_support_client;
GRANT EXECUTE ON FUNCTION app.operator_support_overview(uuid,text,text) TO wasalx_support_client;
GRANT EXECUTE ON FUNCTION app.operator_tenant_provisioning_status(uuid,text,text) TO wasalx_provisioning_client;
