// Keep this projection aligned with app.claim_delivery_jobs destination ordering (0157).
export function deliveryOrderingPredecessorSql(alias:string){return`(
  SELECT predecessor.id FROM delivery_outbox predecessor
  LEFT JOIN group_bindings predecessor_binding ON predecessor_binding.tenant_id=predecessor.tenant_id
    AND predecessor_binding.id=predecessor.group_binding_id
  WHERE ${alias}.state='QUEUED' AND predecessor.tenant_id=${alias}.tenant_id
    AND predecessor.connection_id=${alias}.connection_id
    AND ((${alias}.external_chat_id IS NOT NULL AND predecessor.external_chat_id=${alias}.external_chat_id
      AND predecessor.direct_origin IN ('BOT','HUMAN'))
      OR COALESCE(predecessor.group_workspace_group_id,predecessor_binding.whatsapp_group_id)
        =COALESCE(${alias}.group_workspace_group_id,(SELECT destination.whatsapp_group_id FROM group_bindings destination
          WHERE destination.tenant_id=${alias}.tenant_id AND destination.id=${alias}.group_binding_id)))
    AND ((${alias}.batch_id IS NOT NULL AND predecessor.batch_id=${alias}.batch_id
      AND predecessor.batch_sequence<${alias}.batch_sequence)
      OR ((${alias}.batch_id IS NULL OR predecessor.batch_id IS DISTINCT FROM ${alias}.batch_id)
        AND (COALESCE((SELECT min(part.created_at) FROM delivery_outbox part
          WHERE part.tenant_id=predecessor.tenant_id AND part.batch_id=predecessor.batch_id),predecessor.created_at),
          COALESCE(predecessor.batch_id,predecessor.id))
        < (COALESCE((SELECT min(part.created_at) FROM delivery_outbox part
          WHERE part.tenant_id=${alias}.tenant_id AND part.batch_id=${alias}.batch_id),${alias}.created_at),
          COALESCE(${alias}.batch_id,${alias}.id))))
    AND predecessor.state NOT IN ('SENT','DELIVERED','READ','PRIVACY_CANCELLED')
    AND NOT (predecessor.state IN ('OUTCOME_UNKNOWN','BLOCKED') AND app.delivery_no_further_attempts(predecessor.tenant_id,predecessor.id))
    AND (predecessor.state<>'FAILED_TERMINAL' OR predecessor.manual_retry_allowed)
    AND NOT (predecessor.state='BLOCKED' AND EXISTS (SELECT 1 FROM delivery_outbox blocker
      WHERE blocker.tenant_id=predecessor.tenant_id AND blocker.id=predecessor.blocked_by_delivery_id
        AND blocker.state='FAILED_TERMINAL' AND NOT blocker.manual_retry_allowed))
  ORDER BY predecessor.created_at,predecessor.id LIMIT 1
)`}

export function deliveryHoldReasonSql(alias:string){return`CASE
  WHEN ${alias}.state<>'QUEUED' THEN NULL
  WHEN ${deliveryOrderingPredecessorSql(alias)} IS NOT NULL THEN 'WAITING_FOR_EARLIER_DELIVERY'
  WHEN ${alias}.safe_error LIKE '%(NO_RECENT_INBOUND_RESPONSE_WINDOW)%' THEN 'WAITING_FOR_INBOUND'
  WHEN ${alias}.safe_error LIKE '%(RATE_LIMITED)%' THEN 'RATE_LIMITED'
  WHEN ${alias}.safe_error LIKE '%(PLATFORM_KILL_SWITCH)%'
    OR ${alias}.safe_error LIKE '%(TENANT_KILL_SWITCH)%'
    OR ${alias}.safe_error LIKE '%(CONNECTION_POLICY_DISABLED)%' THEN 'POLICY_PAUSED'
  WHEN ${alias}.safe_error LIKE '%(NUMBER_IDENTITY_MISSING)%' THEN 'CONNECTION_NOT_READY'
  WHEN ${alias}.safe_error LIKE '%(INVALID_DELIVERY_STATE)%' THEN 'DESTINATION_UNAVAILABLE'
  WHEN ${alias}.safe_error IS NOT NULL THEN 'WAITING'
  ELSE NULL END`}

export function deliveryHoldExpiresAtSql(alias:string,policyAlias:string){return`CASE
  WHEN ${alias}.state='QUEUED' AND ${alias}.safe_error LIKE '%(NO_RECENT_INBOUND_RESPONSE_WINDOW)%'
    THEN ${alias}.created_at+make_interval(secs=>${policyAlias}.response_window_seconds)
  END`}
