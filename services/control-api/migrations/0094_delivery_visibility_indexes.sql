-- Bounded delivery timelines and group history resolve every durable route
-- without scanning another tenant's outbox.
CREATE INDEX delivery_outbox_tenant_timeline_idx
  ON delivery_outbox (tenant_id,created_at DESC,id DESC);

CREATE INDEX delivery_outbox_binding_history_idx
  ON delivery_outbox (tenant_id,group_binding_id,created_at DESC,id DESC)
  WHERE group_binding_id IS NOT NULL;

CREATE INDEX delivery_outbox_workspace_history_idx
  ON delivery_outbox (tenant_id,group_workspace_group_id,created_at DESC,id DESC)
  WHERE group_workspace_group_id IS NOT NULL;

-- The broader route-neutral index covers the ticketless-only predecessor.
DROP INDEX delivery_outbox_workspace_group_idx;
